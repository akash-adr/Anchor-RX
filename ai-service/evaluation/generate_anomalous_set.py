"""
Held-out ANOMALOUS evaluation cases (Module 8, Step 5) — the ground-truth positives.

Deliberately separate from data/generate_normal_corpus.py: this module does NOT import it, uses its own seed and its
own sampling logic, and every case is checked against the training corpus by feature fingerprint
(evaluation/disjointness.py, enforced in evaluation/evaluate.py and tests/test_full_pipeline.py). The only thing it
shares with training is data/dosage_reference.py, which defines what "typical" means.

Each case = an independently sampled, otherwise plausible prescription + one (or, for "combined", two) injected anomalies:
    dose_3x_to_5x       per-dose amount 3–5× the drug's typical maximum
    extreme_frequency   doses per day ≥ 2× the drug's maximum (every 4 h … every 30 min)
    extreme_duration    course length 3–6× the drug's longest typical course
    class_duplication   another active prescription in the same drug class (flag forced on)
    combined            two different anomalies from the list above

⚠ Synthetic and illustrative. Because anomalies are defined against the same reference table the rule engine uses,
high rule-engine recall on dose/frequency/duration categories is partly by construction — see evaluation/report.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np

from data.dosage_reference import DOSAGE_REFERENCE, DrugReference
from features.payload import ScoringPayload

ANOMALOUS_SEED = 90210001  # training corpus uses 20260915; normal hold-out uses evaluation.evaluate.NORMAL_HOLDOUT_SEED
DEFAULT_CASES_PER_CATEGORY = 200

SINGLE_ANOMALIES = ("dose_3x_to_5x", "extreme_frequency", "extreme_duration", "class_duplication")
CATEGORIES = SINGLE_ANOMALIES + ("combined",)

DOSE_FACTOR_RANGE = (3.0, 5.0)
FREQUENCY_MIN_FACTOR = 2.0
EXTREME_FREQUENCIES = ((6.0, "every 4 hours"), (8.0, "every 3 hours"), (12.0, "every 2 hours"), (24.0, "hourly"), (48.0, "every 30 minutes"))
DURATION_FACTOR_RANGE = (3.0, 6.0)

PLAIN_FREQUENCY = {1.0: "once daily", 2.0: "twice daily", 3.0: "three times daily", 4.0: "four times daily"}
DRUG_KEYS = tuple(sorted(DOSAGE_REFERENCE))
DRUG_CLASSES = tuple(sorted({ref.drug_class for ref in DOSAGE_REFERENCE.values()}))
EVAL_START = datetime(2026, 10, 1, tzinfo=timezone.utc)


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    category: str  # an anomaly category, or "normal_holdout"
    is_anomalous: bool  # ground truth
    anomalies: tuple[str, ...]
    payload: dict[str, Any]  # ScoringPayload v1 — labels are kept OUT of the payload


def _choice(rng: np.random.Generator, options: tuple | list) -> Any:
    return options[int(rng.integers(len(options)))]


def _plausible_base(rng: np.random.Generator, case_id: str, index: int) -> tuple[dict[str, Any], DrugReference]:
    """An ordinary-looking prescription sampled independently of the training generator's logic."""
    ref = DOSAGE_REFERENCE[_choice(rng, DRUG_KEYS)]
    history = {drug_class: int(rng.integers(0, 25)) for drug_class in DRUG_CLASSES}
    payload = {
        "payloadVersion": 1,
        "prescriptionId": case_id,
        "versionNumber": 1,
        "patientId": f"PAT-EVAL-{index + 1:05d}",
        "providerId": f"PRV-EVAL-{int(rng.integers(1, 61)):02d}",
        "referenceTime": (EVAL_START + timedelta(minutes=index)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "drugName": ref.drug_name,
        "drugClass": ref.drug_class,
        "doseValue": f"{float(_choice(rng, ref.common_strengths)):.3f}",
        "doseUnit": "mg",
        "frequency": PLAIN_FREQUENCY[float(_choice(rng, ref.typical_doses_per_day))],
        "durationDays": int(rng.integers(ref.typical_duration_min_days, ref.typical_duration_max_days + 1)),
        "route": "oral",
        "patientAge": int(rng.integers(18, 86)),
        "patientWeight": round(float(np.clip(rng.normal(72.0, 13.0), 42.0, 130.0)) * 2) / 2,
        "patientWeightIsDefault": False,
        "drugCombinationFlag": False,
        "overlappingPrescriptionIds": [],
        "providerDrugClassHistory": {k: v for k, v in history.items() if v > 0},
        "patientVelocity": int(min(rng.poisson(0.8), 5)),
    }
    return payload, ref


def _inject(anomaly: str, payload: dict[str, Any], ref: DrugReference, rng: np.random.Generator) -> None:
    if anomaly == "dose_3x_to_5x":
        payload["doseValue"] = f"{round(ref.typical_dose_max * float(rng.uniform(*DOSE_FACTOR_RANGE)), 1):.3f}"
        payload["doseUnit"] = "mg"
    elif anomaly == "extreme_frequency":
        eligible = [phrase for per_day, phrase in EXTREME_FREQUENCIES if per_day >= FREQUENCY_MIN_FACTOR * ref.max_doses_per_day]
        payload["frequency"] = _choice(rng, eligible)
    elif anomaly == "extreme_duration":
        payload["durationDays"] = int(math.ceil(ref.typical_duration_max_days * float(rng.uniform(*DURATION_FACTOR_RANGE))))
    elif anomaly == "class_duplication":
        payload["drugCombinationFlag"] = True
        payload["overlappingPrescriptionIds"] = [f"{payload['prescriptionId']}-OVERLAP"]
    else:
        raise ValueError(f"unknown anomaly {anomaly!r}")


def generate_anomalous_set(cases_per_category: int = DEFAULT_CASES_PER_CATEGORY, seed: int = ANOMALOUS_SEED) -> list[EvalCase]:
    if cases_per_category < 1:
        raise ValueError("cases_per_category must be positive")
    rng = np.random.default_rng(seed)
    cases: list[EvalCase] = []
    index = 0
    for category in CATEGORIES:
        for n in range(cases_per_category):
            case_id = f"RX-EVAL-{category.upper().replace('_', '-')}-{n + 1:04d}"
            payload, ref = _plausible_base(rng, case_id, index)
            if category == "combined":
                picks = rng.choice(len(SINGLE_ANOMALIES), size=2, replace=False)
                anomalies = tuple(SINGLE_ANOMALIES[i] for i in sorted(int(p) for p in picks))
            else:
                anomalies = (category,)
            for anomaly in anomalies:
                _inject(anomaly, payload, ref, rng)
            validated = ScoringPayload.model_validate(payload).model_dump()
            cases.append(EvalCase(case_id=case_id, category=category, is_anomalous=True, anomalies=anomalies, payload=validated))
            index += 1
    return cases
