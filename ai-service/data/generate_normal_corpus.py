"""
Synthetic NORMAL prescription corpus for training the Isolation Forest (Module 8, Step 2).

⚠ SYNTHETIC DATA — deliberately basic. Every prescription is synthetic; drugs, doses, frequencies and durations are
sampled inside data/dosage_reference.py's simplified demo ranges (in each drug's own unit — ml for liquids). The realism of this corpus is planned to be revisited in detail later.

Contract (the part that must NOT change when the generation logic becomes more sophisticated):
    generate_normal_corpus(size, seed) -> list[dict]      # ScoringPayload v1 dicts — the exact shape Node sends
Training (train/train_model.py), corpus statistics and serialization depend only on that output, and every row
goes through the same features/extract.py used at inference. To improve the dataset, change the sampling logic
in this file only.

No anomalous or labelled rows are produced: Isolation Forest is unsupervised and only learns what normal looks like.

Run:  .venv/bin/python -m data.generate_normal_corpus [--size 4000] [--seed 20260915] [--out data/generated/normal_corpus.jsonl]
"""

from __future__ import annotations

import sys

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import numpy as np

if __package__ in (None, ""):  # run as a file (python3 <dir>/<script>.py): make ai-service/ importable, like `python -m`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data.dosage_reference import DOSAGE_REFERENCE, DrugReference
from features.extract import DEFAULT_PATIENT_WEIGHT_KG
from features.payload import ScoringPayload

GENERATOR_VERSION = "reference-v2"  # v2: corrected 17-drug DRUG_REFERENCE
DEFAULT_CORPUS_SIZE = 4000
DEFAULT_SEED = 20260915
DEFAULT_CORPUS_PATH = Path(__file__).resolve().parent / "generated" / "normal_corpus.jsonl"

# ── Providers ────────────────────────────────────────────────────────────────────────────────────────────────
# Relative prescribing weights per specialty (keys = lowercase reference drug names). PLACEHOLDER guesses.
SPECIALTY_DRUG_MIX: dict[str, dict[str, float]] = {
    "general_practice": {
        "amoxicillin": 3.0, "azithromycin": 1.5, "ciprofloxacin": 1.0, "roxithromycin": 1.0, "ibuprofen": 2.0,
        "diclofenac": 1.5, "omeprazole": 1.5, "pantoprazole": 1.0, "metformin": 1.5, "glimepiride": 0.7,
        "atorvastatin": 1.5, "lisinopril": 1.0, "losartan": 1.0, "warfarin": 0.4, "sertraline": 0.7,
        "escitalopram": 0.7, "diphenhydramine": 1.5,
    },
    "cardiology": {"atorvastatin": 4.0, "lisinopril": 3.0, "losartan": 3.0, "warfarin": 2.5, "pantoprazole": 0.5},
    "endocrinology": {"metformin": 5.0, "glimepiride": 3.0, "atorvastatin": 2.0, "lisinopril": 1.0, "losartan": 1.0},
    "infectious_disease_ent": {"amoxicillin": 4.0, "azithromycin": 3.0, "ciprofloxacin": 2.5, "roxithromycin": 2.5, "diphenhydramine": 2.0, "ibuprofen": 1.0},
    "psychiatry": {"sertraline": 4.0, "escitalopram": 4.0, "omeprazole": 0.5},
    "orthopaedics_pain": {"ibuprofen": 4.0, "diclofenac": 4.0, "omeprazole": 2.0, "pantoprazole": 1.5},
}
# specialty → (provider id code, number of synthetic providers)
SPECIALTY_PROVIDERS: dict[str, tuple[str, int]] = {
    "general_practice": ("GP", 16),
    "cardiology": ("CARD", 5),
    "endocrinology": ("ENDO", 4),
    "infectious_disease_ent": ("ID", 5),
    "psychiatry": ("PSY", 4),
    "orthopaedics_pain": ("ORTH", 6),
}
PROVIDER_ACTIVITY_SIGMA = 0.5  # lognormal spread of how busy each provider is

# ── Patients ─────────────────────────────────────────────────────────────────────────────────────────────────
AGE_PROFILE_BY_CLASS: dict[str, tuple[float, float]] = {  # (mean, sd) years
    "statin": (62.0, 10.0),
    "antidiabetic": (56.0, 11.0),
    "ace_inhibitor": (60.0, 11.0),
    "arb": (60.0, 11.0),
    "anticoagulant": (68.0, 10.0),
    "ssri": (38.0, 13.0),
}
DEFAULT_AGE_PROFILE = (42.0, 17.0)  # acute drugs
MIN_AGE, MAX_AGE = 18, 90
MISSING_WEIGHT_RATE = 0.15  # mirrors Node: missing weight → 70 kg placeholder + patientWeightIsDefault
MIN_WEIGHT_KG, MAX_WEIGHT_KG = 40.0, 140.0

# ── Prescription details ─────────────────────────────────────────────────────────────────────────────────────
NON_STANDARD_DOSE_RATE = 0.10  # in-range doses that are not a common strength
GRAM_UNIT_RATE = 0.05  # mg doses ≥ 500 mg written in g (exercises unit conversion)
NON_ORAL_ROUTE_RATE = 0.06  # for drugs whose reference lists a non-oral route (none in the v2 table — all oral)
PRN_CLASSES = frozenset({"nsaid"})
PRN_RATE = 0.15
COMBINATION_RATE_CHRONIC = 0.10  # benign same-class overlap (e.g. switching statins) — keeps the flag from being "rare"
COMBINATION_RATE_ACUTE = 0.03
ACUTE_FREE_DURATION_RATE = 0.15

FREQUENCY_PHRASES: dict[float, tuple[str, ...]] = {
    1.0: ("once daily", "once a day", "OD", "daily", "once daily at night", "once daily in the morning"),
    2.0: ("twice daily", "twice a day", "BD", "BID", "every 12 hours", "twice daily with meals"),
    3.0: ("three times daily", "TDS", "TID", "every 8 hours", "three times a day with meals"),
    4.0: ("four times daily", "QID", "every 6 hours"),
}
CHRONIC_DURATIONS = (28, 30, 30, 30, 60, 90, 90, 180, 365)
ACUTE_DURATIONS = (3, 5, 5, 7, 7, 7, 10, 14)

CORPUS_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
CORPUS_SPAN_DAYS = 240


@dataclass(frozen=True)
class SyntheticProvider:
    provider_id: str
    specialty: str
    activity: float


def _check_configuration() -> None:
    if set(SPECIALTY_DRUG_MIX) != set(SPECIALTY_PROVIDERS):
        raise ValueError("SPECIALTY_DRUG_MIX and SPECIALTY_PROVIDERS must list the same specialties")
    used = set()
    for specialty, mix in SPECIALTY_DRUG_MIX.items():
        unknown = set(mix) - set(DOSAGE_REFERENCE)
        if unknown:
            raise ValueError(f"{specialty}: drugs not in the dosage reference: {sorted(unknown)}")
        used |= set(mix)
    if used != set(DOSAGE_REFERENCE):
        raise ValueError(f"reference drugs never prescribed: {sorted(set(DOSAGE_REFERENCE) - used)}")
    for ref in DOSAGE_REFERENCE.values():
        if not set(ref.typical_doses_per_day) <= set(FREQUENCY_PHRASES):
            raise ValueError(f"{ref.drug_name}: no phrasing for doses/day {ref.typical_doses_per_day}")


_check_configuration()


# ── Sampling helpers (the part to replace when the dataset gets more realistic) ────────────────────────────────

def _pick(rng: np.random.Generator, options: tuple | list) -> Any:
    return options[int(rng.integers(len(options)))]


def _build_providers(rng: np.random.Generator) -> list[SyntheticProvider]:
    return [
        SyntheticProvider(f"PRV-SYN-{code}-{n:02d}", specialty, float(rng.lognormal(0.0, PROVIDER_ACTIVITY_SIGMA)))
        for specialty, (code, count) in SPECIALTY_PROVIDERS.items()
        for n in range(1, count + 1)
    ]


def _sample_drug(rng: np.random.Generator, provider: SyntheticProvider) -> DrugReference:
    mix = SPECIALTY_DRUG_MIX[provider.specialty]
    names = list(mix)
    weights = np.array([mix[name] for name in names])
    return DOSAGE_REFERENCE[names[int(rng.choice(len(names), p=weights / weights.sum()))]]


def _sample_age(rng: np.random.Generator, ref: DrugReference) -> int:
    mean, sd = AGE_PROFILE_BY_CLASS.get(ref.drug_class, DEFAULT_AGE_PROFILE)
    return int(np.clip(round(rng.normal(mean, sd)), MIN_AGE, MAX_AGE))


def _sample_weight(rng: np.random.Generator, age: int) -> tuple[float, bool]:
    if rng.random() < MISSING_WEIGHT_RATE:
        return DEFAULT_PATIENT_WEIGHT_KG, True
    mean = 62.0 + 0.25 * (min(age, 60) - MIN_AGE)
    weight = float(np.clip(rng.normal(mean, 12.0), MIN_WEIGHT_KG, MAX_WEIGHT_KG))
    return round(weight * 2) / 2, False


def _sample_dose(rng: np.random.Generator, ref: DrugReference) -> float:
    """A per-dose amount in the reference's OWN unit (mg, or ml for liquids)."""
    strengths = ref.common_strengths
    if len(strengths) > 1 and rng.random() < NON_STANDARD_DOSE_RATE:
        step = 2.5 if ref.typical_dose_max <= 20 else 5.0 if ref.typical_dose_max <= 100 else 25.0
        low = np.ceil(ref.typical_dose_min / step) * step
        high = np.floor(ref.typical_dose_max / step) * step
        return float(_pick(rng, list(np.arange(low, high + step / 2, step))))
    # Middle strengths are favoured slightly over the extremes.
    weights = np.array([1.0 + min(i, len(strengths) - 1 - i) for i in range(len(strengths))])
    return float(strengths[int(rng.choice(len(strengths), p=weights / weights.sum()))])


def _format_dose(rng: np.random.Generator, dose: float, ref: DrugReference) -> tuple[str, str]:
    if ref.unit != "mg":
        return f"{dose:.3f}", ref.unit  # liquids stay in ml — never converted or relabelled as mg
    if dose >= 500 and rng.random() < GRAM_UNIT_RATE:
        return f"{dose / 1000:.3f}", "g"
    return f"{dose:.3f}", "mg"  # DECIMAL(10,3)-style string, like MySQL/Node


def _sample_frequency_text(rng: np.random.Generator, ref: DrugReference) -> str:
    doses_per_day = float(_pick(rng, ref.typical_doses_per_day))
    if ref.drug_class in PRN_CLASSES and rng.random() < PRN_RATE:
        return f"every {int(round(24 / doses_per_day))} hours as needed"
    return str(_pick(rng, FREQUENCY_PHRASES[doses_per_day]))


def _sample_duration(rng: np.random.Generator, ref: DrugReference) -> int:
    low, high = ref.typical_duration_min_days, ref.typical_duration_max_days
    candidates = [d for d in (CHRONIC_DURATIONS if ref.chronic else ACUTE_DURATIONS) if low <= d <= high]
    if not candidates or (not ref.chronic and rng.random() < ACUTE_FREE_DURATION_RATE):
        return int(rng.integers(low, high + 1))
    return int(_pick(rng, candidates))


def _sample_route(rng: np.random.Generator, ref: DrugReference) -> str:
    non_oral = [route for route in ref.routes if route != "oral"]
    if non_oral and rng.random() < NON_ORAL_ROUTE_RATE:
        return str(_pick(rng, non_oral))
    return "oral"


def _sample_velocity(rng: np.random.Generator, ref: DrugReference, age: int) -> int:
    lam = 0.5 + (0.5 if ref.chronic else 0.0) + (0.3 if age >= 65 else 0.0)
    return int(min(rng.poisson(lam), 6))


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _draft_payload(rng: np.random.Generator, index: int, provider: SyntheticProvider, ref: DrugReference) -> dict[str, Any]:
    age = _sample_age(rng, ref)
    weight, weight_is_default = _sample_weight(rng, age)
    dose_value, dose_unit = _format_dose(rng, _sample_dose(rng, ref), ref)
    frequency = _sample_frequency_text(rng, ref)
    duration = _sample_duration(rng, ref)
    route = _sample_route(rng, ref)
    combination = bool(rng.random() < (COMBINATION_RATE_CHRONIC if ref.chronic else COMBINATION_RATE_ACUTE))
    velocity = _sample_velocity(rng, ref, age)
    issued = CORPUS_START + timedelta(seconds=float(rng.uniform(0, CORPUS_SPAN_DAYS * 86400)))
    return {
        "payloadVersion": 1,
        "prescriptionId": f"RX-SYN-{index + 1:06d}",
        "versionNumber": 1,
        "patientId": f"PAT-SYN-{index + 1:06d}",
        "providerId": provider.provider_id,
        "referenceTime": _iso(issued),
        "drugName": ref.drug_name,
        "drugClass": ref.drug_class,
        "doseValue": dose_value,
        "doseUnit": dose_unit,
        "frequency": frequency,
        "durationDays": duration,
        "route": route,
        "patientAge": age,
        "patientWeight": weight,
        "patientWeightIsDefault": weight_is_default,
        "drugCombinationFlag": combination,
        "overlappingPrescriptionIds": [f"RX-SYN-OVL-{index + 1:06d}"] if combination else [],
        "providerDrugClassHistory": {},  # filled in once the whole corpus exists
        "patientVelocity": velocity,
    }


# ── Public API ───────────────────────────────────────────────────────────────────────────────────────────────

def generate_normal_corpus(size: int = DEFAULT_CORPUS_SIZE, seed: int = DEFAULT_SEED) -> list[dict[str, Any]]:
    """Deterministic for a given (size, seed). Returns validated ScoringPayload v1 dicts."""
    if size < 1:
        raise ValueError("size must be positive")
    rng = np.random.default_rng(seed)
    providers = _build_providers(rng)
    activity = np.array([provider.activity for provider in providers])
    activity /= activity.sum()

    drafts = []
    for index in range(size):
        provider = providers[int(rng.choice(len(providers), p=activity))]
        drafts.append(_draft_payload(rng, index, provider, _sample_drug(rng, provider)))

    # providerDrugClassHistory = the provider's OTHER prescriptions per class (leave-one-out), matching
    # backend/ml/buildScoringPayload.js, which excludes the prescription being scored.
    class_counts: dict[str, Counter] = defaultdict(Counter)
    for draft in drafts:
        class_counts[draft["providerId"]][draft["drugClass"].strip().lower()] += 1
    corpus = []
    for draft in drafts:
        history = Counter(class_counts[draft["providerId"]])
        history[draft["drugClass"].strip().lower()] -= 1
        draft["providerDrugClassHistory"] = {k: v for k, v in sorted(history.items()) if v > 0}
        corpus.append(ScoringPayload.model_validate(draft).model_dump())
    return corpus


def corpus_sha256(payloads: Iterable[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    for payload in payloads:
        digest.update(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n")
    return digest.hexdigest()


def corpus_metadata_path(corpus_path: str | Path) -> Path:
    corpus_path = Path(corpus_path)
    return corpus_path.with_name(corpus_path.stem + ".meta.json")


def write_corpus_jsonl(payloads: list[Mapping[str, Any]], path: str | Path = DEFAULT_CORPUS_PATH, *, seed: int | None = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(p, sort_keys=True, separators=(",", ":")) + "\n" for p in payloads), encoding="utf-8")
    metadata = {
        "generator": "data/generate_normal_corpus.py",
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "rows": len(payloads),
        "sha256": corpus_sha256(payloads),
        "generated_at": _iso(datetime.now(timezone.utc)),
        "summary": summarize_corpus(payloads),
    }
    corpus_metadata_path(path).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return path


def read_corpus_jsonl(path: str | Path = DEFAULT_CORPUS_PATH) -> list[dict[str, Any]]:
    with Path(path).open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def summarize_corpus(payloads: list[Mapping[str, Any]]) -> dict[str, Any]:
    rows = len(payloads)
    ages = [p["patientAge"] for p in payloads]
    return {
        "rows": rows,
        "providers": len({p["providerId"] for p in payloads}),
        "drug_counts": dict(sorted(Counter(p["drugName"] for p in payloads).items())),
        "drug_combination_rate": round(sum(p["drugCombinationFlag"] for p in payloads) / rows, 4),
        "default_weight_rate": round(sum(p["patientWeightIsDefault"] for p in payloads) / rows, 4),
        "non_oral_route_rate": round(sum(p["route"] != "oral" for p in payloads) / rows, 4),
        "gram_unit_rate": round(sum(p["doseUnit"] == "g" for p in payloads) / rows, 4),
        "prn_rate": round(sum("as needed" in p["frequency"] for p in payloads) / rows, 4),
        "age_min_median_max": [min(ages), float(np.median(ages)), max(ages)],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate the synthetic normal prescription corpus (placeholder).")
    parser.add_argument("--size", type=int, default=DEFAULT_CORPUS_SIZE)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=DEFAULT_CORPUS_PATH)
    args = parser.parse_args(argv)
    payloads = generate_normal_corpus(args.size, args.seed)
    path = write_corpus_jsonl(payloads, args.out, seed=args.seed)
    print(f"wrote {len(payloads)} rows → {path}")
    print(json.dumps(summarize_corpus(payloads), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
