"""
Feature extraction for the Anchor Rx AI risk engine (Module 8).

extract_features(payload, corpus_stats) turns ONE ScoringPayload (see features/payload.py, produced by
backend/ml/buildScoringPayload.js) into exactly the 13 features below. It is pure: no I/O, no model, no DB.

  numeric      dose_value, dose_per_kg, frequency, duration_days, age, weight, drug_combination_flag,
               drug_rarity_score, provider_pattern_score, patient_velocity, dose_frequency_product
  categorical  route, drug_class      (encoded ONLY by features/encoding.py's shared ColumnTransformer)

Design notes:
- frequency is numeric DOSES PER DAY, not a one-hot category: "every 15 minutes" (96/day) must read as far
  beyond "twice daily" (2/day), which a one-hot of free text cannot express. Unparseable text → None (imputed
  by the preprocessing pipeline; the rule engine can flag it).
- dose_value is converted to mg for mass units (g, mg, mcg/µg) so "500 mcg" is not 1000× off; other units
  (ml, tablet, puff, IU, …) are kept as the raw number.
- drug_rarity_score and provider_pattern_score depend on corpus statistics, passed in explicitly (built from
  the training corpus in Step 2), so this function never hard-codes a corpus.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Iterable, Mapping

from features.payload import ScoringPayload

# PLACEHOLDER: synthetic population-average adult weight (kg) until real weights are captured consistently.
# Must match DEFAULT_PATIENT_WEIGHT_KG in backend/ml/buildScoringPayload.js.
DEFAULT_PATIENT_WEIGHT_KG = 70.0

# provider_pattern_score smoothing: this many pseudo-prescriptions at the POPULATION class rate are blended into
# every provider's own history, so a provider with no history scores exactly like the population (0.0) and their
# own pattern only dominates once they have real evidence.
PROVIDER_PRIOR_STRENGTH = 5.0

FEATURE_NAMES: tuple[str, ...] = (
    "dose_value",
    "dose_per_kg",
    "frequency",
    "duration_days",
    "route",
    "age",
    "weight",
    "drug_class",
    "drug_combination_flag",
    "drug_rarity_score",
    "provider_pattern_score",
    "patient_velocity",
    "dose_frequency_product",
)

_MASS_UNIT_TO_MG = {"mg": 1.0, "g": 1000.0, "gm": 1000.0, "mcg": 0.001, "µg": 0.001, "ug": 0.001}
# Units whose dose_value is converted to mg by extract_features (anything else stays a raw number).
MASS_UNITS = frozenset(_MASS_UNIT_TO_MG)

_WORD_COUNTS = {"once": 1, "one": 1, "twice": 2, "two": 2, "thrice": 3, "three": 3, "four": 4, "five": 5, "six": 6}

# Common prescription abbreviations (OD = once daily in Indian/UK usage).
_ABBREVIATION_DOSES_PER_DAY = {"od": 1, "qd": 1, "bd": 2, "bid": 2, "tds": 3, "tid": 3, "qds": 4, "qid": 4}

# Upper bound used for "as needed" (PRN) instructions without an explicit interval.
PRN_ASSUMED_DOSES_PER_DAY = 4.0


class FeatureExtractionError(ValueError):
    """Raised when a payload cannot produce features at all (invalid contract)."""


# ---------------------------------------------------------------------------------------------------------
# Frequency parsing
# ---------------------------------------------------------------------------------------------------------

def parse_doses_per_day(frequency: str) -> float | None:
    """
    Map a free-text frequency to doses per day. Documented mapping:
      "once/twice/three times/four times daily|a day|per day"  → 1 / 2 / 3 / 4
      "OD/QD", "BD/BID", "TDS/TID", "QDS/QID"                  → 1 / 2 / 3 / 4
      "every N hours" / "qNh"                                   → 24 / N
      "every N minutes"                                         → 1440 / N
      "hourly" / "every hour"                                   → 24
      "once weekly" / "weekly"                                  → 1/7
      "as needed" / "prn" (no interval)                         → PRN_ASSUMED_DOSES_PER_DAY (4)
      "at night", "with meals", "in the morning" …              → modifiers, ignored
      anything else                                             → None
    An explicit interval always wins over "as needed" ("every 4 hours as needed" → 6).
    """
    text = frequency.strip().lower()
    if not text:
        return None

    match = re.search(r"every\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b", text) or re.search(r"\bq\s*(\d+(?:\.\d+)?)\s*h\b", text)
    if match:
        hours = float(match.group(1))
        return 24.0 / hours if hours > 0 else None

    match = re.search(r"every\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b", text)
    if match:
        minutes = float(match.group(1))
        return 1440.0 / minutes if minutes > 0 else None

    if re.search(r"\b(hourly|every hour)\b", text):
        return 24.0

    if re.search(r"\bweekly\b|once a week|per week", text):
        return 1.0 / 7.0

    match = re.search(r"\b(once|one|twice|two|thrice|three|four|five|six)\b(?:\s+times?)?\s*(?:daily|a day|per day|each day|/day)", text)
    if match:
        return float(_WORD_COUNTS[match.group(1)])

    match = re.search(r"\b(\d+)\s*(?:x|times)\s*(?:daily|a day|per day|/day)", text)
    if match:
        return float(match.group(1))

    match = re.search(r"\b(od|qd|bd|bid|tds|tid|qds|qid)\b", text)
    if match:
        return float(_ABBREVIATION_DOSES_PER_DAY[match.group(1)])

    if text in {"daily", "every day"} or re.search(r"\bdaily\b", text):
        return 1.0

    if re.search(r"\b(as needed|prn|when required|sos)\b", text):
        return PRN_ASSUMED_DOSES_PER_DAY

    return None


def dose_in_mg(dose_value: float, dose_unit: str) -> float:
    """Convert mass doses to mg; non-mass units (ml, tablet, puff, IU, …) are returned unchanged."""
    factor = _MASS_UNIT_TO_MG.get(dose_unit.strip().lower())
    return dose_value * factor if factor is not None else dose_value


# ---------------------------------------------------------------------------------------------------------
# Corpus statistics (supplied by training — Step 2)
# ---------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class CorpusStats:
    """
    Population statistics of the (synthetic, normal) training corpus.

    Built once by train/train_model.py, saved next to the model as train/corpus_stats.json, and loaded as-is at
    inference — never re-derived per request. Only counts are persisted; shares and rarity are derived from them.
      drug_counts        lowercase drug_name  → prescriptions   (drives drug_rarity_score)
      drug_class_counts  lowercase drug_class → prescriptions   (population baseline for provider_pattern_score)
    """

    drug_counts: Mapping[str, int] = field(default_factory=dict)
    drug_class_counts: Mapping[str, int] = field(default_factory=dict)

    SCHEMA_VERSION: ClassVar[int] = 1

    @property
    def total(self) -> int:
        return sum(self.drug_class_counts.values())

    def drug_class_share(self, drug_class: str) -> float:
        total = self.total
        return self.drug_class_counts.get(drug_class.strip().lower(), 0) / total if total else 0.0

    @staticmethod
    def from_records(records: Iterable[Mapping[str, Any]]) -> "CorpusStats":
        """Records with snake_case drug_name / drug_class keys."""
        drugs: dict[str, int] = {}
        classes: dict[str, int] = {}
        for record in records:
            drug = str(record["drug_name"]).strip().lower()
            klass = str(record["drug_class"]).strip().lower()
            drugs[drug] = drugs.get(drug, 0) + 1
            classes[klass] = classes.get(klass, 0) + 1
        return CorpusStats(drug_counts=drugs, drug_class_counts=classes)

    @staticmethod
    def from_payloads(payloads: Iterable["ScoringPayload | Mapping[str, Any]"]) -> "CorpusStats":
        """Statistics from ScoringPayload objects or camelCase payload dicts (e.g. a generated corpus)."""

        def names(payload: ScoringPayload | Mapping[str, Any]) -> dict[str, str]:
            if isinstance(payload, ScoringPayload):
                return {"drug_name": payload.drugName, "drug_class": payload.drugClass}
            return {"drug_name": payload["drugName"], "drug_class": payload["drugClass"]}

        return CorpusStats.from_records(names(p) for p in payloads)

    def to_dict(self) -> dict[str, Any]:
        total = self.total
        return {
            "schema_version": self.SCHEMA_VERSION,
            "total_prescriptions": total,
            "drug_counts": dict(sorted(self.drug_counts.items())),
            "drug_class_counts": dict(sorted(self.drug_class_counts.items())),
            # Derived, for human inspection only — from_dict ignores these and recomputes from the counts.
            "drug_rarity_score": {drug: drug_rarity_score(drug, self) for drug in sorted(self.drug_counts)},
            "drug_class_distribution": {k: round(n / total, 6) for k, n in sorted(self.drug_class_counts.items())}
            if total
            else {},
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CorpusStats":
        if data.get("schema_version") != cls.SCHEMA_VERSION:
            raise ValueError(f"Unsupported corpus stats schema_version {data.get('schema_version')!r}")
        return cls(
            drug_counts={str(k): int(v) for k, v in data["drug_counts"].items()},
            drug_class_counts={str(k): int(v) for k, v in data["drug_class_counts"].items()},
        )

    def save_json(self, path: str | Path) -> Path:
        path = Path(path)
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return path

    @classmethod
    def load_json(cls, path: str | Path) -> "CorpusStats":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def _relative_rarity(key: str, counts: Mapping[str, int]) -> float:
    """1 − count/max_count, in [0, 1]: the most common entry → 0.0, never seen → 1.0."""
    if not counts:
        return 1.0
    max_count = max(counts.values())
    return 1.0 - (counts.get(key, 0) / max_count) if max_count > 0 else 1.0


def drug_rarity_score(drug_name: str, corpus_stats: CorpusStats) -> float:
    """
    Inverse-frequency of this drug in the training corpus, relative to the most common drug:
    1 − count(drug) / count(most common drug). 0 = the most common drug, 1 = never seen in training.
    """
    return round(_relative_rarity(drug_name.strip().lower(), corpus_stats.drug_counts), 6)


def provider_pattern_score(drug_class: str, provider_history: Mapping[str, int], corpus_stats: CorpusStats) -> float:
    """
    How much LESS often this provider prescribes this drug class than the population does.
    The population baseline comes from training (corpus_stats); the provider's own history arrives per request
    from Node (providerDrugClassHistory) — nothing provider-specific is baked into the model.

      population_share = corpus count(class) / corpus total
      smoothed_share   = (provider count(class) + k · population_share) / (provider total + k),  k = PROVIDER_PRIOR_STRENGTH
      score            = clip(1 − smoothed_share / population_share, 0, 1)

    0 → at or above the population rate (including brand-new providers, who have no evidence yet);
    → 1 as a provider with long history has (almost) never written this class; e.g. 0 of 100 → 100/105 ≈ 0.95.
    A class never seen in the training corpus scores 1.0.
    """
    klass = drug_class.strip().lower()
    population_share = corpus_stats.drug_class_share(klass)
    if population_share <= 0.0:
        return 1.0
    history = {str(k).strip().lower(): max(int(v), 0) for k, v in provider_history.items()}
    total = sum(history.values())
    smoothed_share = (history.get(klass, 0) + PROVIDER_PRIOR_STRENGTH * population_share) / (total + PROVIDER_PRIOR_STRENGTH)
    return round(min(1.0, max(0.0, 1.0 - smoothed_share / population_share)), 6)


# ---------------------------------------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------------------------------------

def _to_payload(payload: ScoringPayload | Mapping[str, Any]) -> ScoringPayload:
    if isinstance(payload, ScoringPayload):
        return payload
    try:
        return ScoringPayload.model_validate(payload)
    except Exception as exc:  # pydantic.ValidationError — keep the public error type simple
        raise FeatureExtractionError(f"Invalid scoring payload: {exc}") from exc


def extract_features(payload: ScoringPayload | Mapping[str, Any], corpus_stats: CorpusStats) -> dict[str, Any]:
    """
    Returns exactly FEATURE_NAMES as keys. Deterministic: the same payload + stats always give the same dict.
    """
    p = _to_payload(payload)

    try:
        raw_dose = float(p.doseValue)
    except (TypeError, ValueError) as exc:
        raise FeatureExtractionError(f"doseValue is not numeric: {p.doseValue!r}") from exc
    if not math.isfinite(raw_dose) or raw_dose <= 0:
        raise FeatureExtractionError(f"doseValue must be a positive number, got {p.doseValue!r}")

    dose_value = dose_in_mg(raw_dose, p.doseUnit)
    weight = float(p.patientWeight) if p.patientWeight is not None else DEFAULT_PATIENT_WEIGHT_KG
    doses_per_day = parse_doses_per_day(p.frequency)

    features: dict[str, Any] = {
        "dose_value": round(dose_value, 6),
        "dose_per_kg": round(dose_value / weight, 6),
        "frequency": doses_per_day,
        "duration_days": float(p.durationDays),
        "route": p.route.strip().lower() or "oral",
        "age": float(p.patientAge),
        "weight": weight,
        "drug_class": p.drugClass.strip().lower(),
        "drug_combination_flag": 1 if p.drugCombinationFlag else 0,
        "drug_rarity_score": drug_rarity_score(p.drugName, corpus_stats),
        "provider_pattern_score": provider_pattern_score(p.drugClass, p.providerDrugClassHistory, corpus_stats),
        "patient_velocity": float(p.patientVelocity),
        "dose_frequency_product": round(dose_value * doses_per_day, 6) if doses_per_day is not None else None,
    }
    assert tuple(features) == FEATURE_NAMES  # guard against silent drift of the feature contract
    return features
