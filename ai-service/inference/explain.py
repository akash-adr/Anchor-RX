"""
Anchor Rx — Module 8 explainability: fired rules + ML contributions → at most 3 ranked plain-language reasons.

    reasons = [{ "source": "rule_engine" | "ml_model", "feature": str, "explanation": str }]
      1. rule-engine hits first, in the rule engine's order (highest points first), with its explanation text as-is;
      2. then ML contributions, largest first, skipping any feature group a fired rule already explains;
      3. capped at 3 — rules take the slots first.

HOW DO WE KNOW WHICH FEATURE THE ISOLATION FOREST REACTED TO? (it has no built-in per-prediction attribution)
  Occlusion against typical values. For each feature group we copy the prescription's features with that group reset
  to its TYPICAL value — the training-corpus median for the prescription's drug class (patient/provider features:
  corpus-wide median; route: most common route for the class; see features/baselines.py) — and re-score every copy
  through the SAME saved pipeline in one batch. A group's contribution is
        ML sub-score as scored − ML sub-score with that group reset to typical
  i.e. "had this been typical, the anomaly score would have been N points lower". The largest contributions become
  reasons; whether the value was above or below typical picks the wording.
  - Correlated inputs are reset TOGETHER so one signal isn't split and hidden: resetting the dose also recomputes
    dose_per_kg and dose_frequency_product; frequency recomputes dose_frequency_product; weight recomputes dose_per_kg.
  - Contributions use the uncapped calibrated scale, so prescriptions already at 100 can still be explained.
  - ML reasons are produced only when the ML sub-score is above the low band (> 30: more unusual than 99% of normal
    training prescriptions) and only for groups contributing ≥ 5 points — ordinary prescriptions get no invented reasons.
  Limits we state openly: this is one-group-at-a-time sensitivity analysis, not SHAP. Interactions between groups are
  not attributed, contributions need not sum to the score, and "typical" is a synthetic-corpus median. It shows which
  inputs moved the model's score; it does not make the Isolation Forest itself interpretable, and it is not clinical
  reasoning. drug_class itself is never reset (there is no neutral "typical class").
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from features.baselines import FeatureBaselines
from features.encoding import features_to_frame
from train.artifacts import AnomalySubScore, ModelArtifacts
from train.calibration import LOW_BAND_TOP, normalize_anomaly_score, raw_anomaly_scores

MAX_REASONS = 3
MAX_ML_CONTRIBUTIONS = 3
ML_REASON_MIN_SUBSCORE = LOW_BAND_TOP  # ML reasons only when the ML sub-score is strictly above this
ML_REASON_MIN_CONTRIBUTION = 5.0  # calibrated points

# Rule-engine features → the ML feature group they already explain (used to avoid saying the same thing twice).
RULE_FEATURE_GROUP = {"dose_value": "dose", "frequency": "frequency", "duration_days": "duration", "drug_combination_flag": "duplication"}

ML_EXPLANATIONS: dict[tuple[str, str], str] = {
    ("dose", "high"): "Dose is unusually high for this type of medication compared with typical prescriptions.",
    ("dose", "low"): "Dose is unusually low for this type of medication compared with typical prescriptions.",
    ("frequency", "high"): "Number of doses per day is unusually high for this type of medication.",
    ("frequency", "low"): "Number of doses per day is unusually low for this type of medication.",
    ("duration", "high"): "Treatment duration is unusually long for this type of medication.",
    ("duration", "low"): "Treatment duration is unusually short for this type of medication.",
    ("age", "high"): "Patient is older than is typical for this type of medication.",
    ("age", "low"): "Patient is younger than is typical for this type of medication.",
    ("weight", "high"): "Patient body weight is unusually high compared with typical prescriptions.",
    ("weight", "low"): "Patient body weight is unusually low compared with typical prescriptions.",
    ("route", "different"): "Route of administration is unusual for this type of medication.",
    ("duplication", "high"): "An overlapping same-class prescription is uncommon in typical prescribing.",
    ("rarity", "high"): "This medication is rarely prescribed in the reference data.",
    ("provider_pattern", "high"): "This drug class is unusual for this prescriber compared with their own history.",
    ("velocity", "high"): "Patient has received an unusually high number of prescriptions in the last 30 days.",
}


@dataclass(frozen=True)
class MlContribution:
    group: str
    feature: str  # representative feature reported in the reason
    direction: str  # "high" | "low" | "different"
    points: float  # ML sub-score drop when this group is reset to typical

    @property
    def explanation(self) -> str:
        return ML_EXPLANATIONS[(self.group, self.direction)]


@dataclass(frozen=True)
class Occlusion:
    group: str
    feature: str
    direction: str
    features: dict[str, Any]  # full feature dict with this group reset to typical


def build_occlusions(features: Mapping[str, Any], baselines: FeatureBaselines) -> list[Occlusion]:
    typical = baselines.for_drug_class(str(features["drug_class"]))
    dose, frequency, weight = features["dose_value"], features["frequency"], features["weight"]
    occlusions: list[Occlusion] = []

    def numeric(group: str, feature: str, typical_value: Any, changes: Mapping[str, Any], *, high_only: bool = False) -> None:
        value = features[feature]
        if value is None or typical_value is None:
            return
        if math.isclose(float(value), float(typical_value), rel_tol=1e-9, abs_tol=1e-9):
            return
        direction = "high" if float(value) > float(typical_value) else "low"
        if high_only and direction == "low":
            return
        occlusions.append(Occlusion(group, feature, direction, {**features, **changes}))

    if typical.get("dose_value") is not None:
        d = float(typical["dose_value"])
        numeric("dose", "dose_value", d, {
            "dose_value": d,
            "dose_per_kg": d / weight,
            "dose_frequency_product": d * frequency if frequency is not None else None,
        })
    if typical.get("frequency") is not None:
        f = float(typical["frequency"])
        numeric("frequency", "frequency", f, {"frequency": f, "dose_frequency_product": dose * f})
    numeric("duration", "duration_days", typical.get("duration_days"), {"duration_days": typical.get("duration_days")})
    numeric("age", "age", typical.get("age"), {"age": typical.get("age")})
    if typical.get("weight") is not None:
        w = float(typical["weight"])
        numeric("weight", "weight", w, {"weight": w, "dose_per_kg": dose / w})
    if typical.get("route") is not None and features["route"] != typical["route"]:
        occlusions.append(Occlusion("route", "route", "different", {**features, "route": typical["route"]}))
    numeric("duplication", "drug_combination_flag", 0, {"drug_combination_flag": 0}, high_only=True)
    for group, feature in (("rarity", "drug_rarity_score"), ("provider_pattern", "provider_pattern_score"), ("velocity", "patient_velocity")):
        numeric(group, feature, typical.get(feature), {feature: typical.get(feature)}, high_only=True)
    return occlusions


def ml_top_features(features: Mapping[str, Any], artifacts: ModelArtifacts, ml_score: AnomalySubScore, *, limit: int = MAX_ML_CONTRIBUTIONS) -> list[MlContribution]:
    """Feature groups that contributed most to THIS prescription's ML sub-score (see module docstring)."""
    if ml_score.normalized_score <= ML_REASON_MIN_SUBSCORE:
        return []
    occlusions = build_occlusions(features, artifacts.feature_baselines)
    if not occlusions:
        return []
    as_scored = normalize_anomaly_score(ml_score.raw_score, artifacts.calibration, capped=False)
    raw_reset = raw_anomaly_scores(artifacts.pipeline, features_to_frame([occlusion.features for occlusion in occlusions]))
    contributions = []
    for occlusion, raw in zip(occlusions, raw_reset):
        points = round(as_scored - normalize_anomaly_score(float(raw), artifacts.calibration, capped=False), 2)
        if points >= ML_REASON_MIN_CONTRIBUTION:
            contributions.append(MlContribution(occlusion.group, occlusion.feature, occlusion.direction, points))
    contributions.sort(key=lambda contribution: -contribution.points)
    return contributions[:limit]


def build_reasons(fired_rules: Iterable[Mapping[str, Any]], ml_top_features: Iterable[MlContribution]) -> list[dict[str, str]]:
    reasons: list[dict[str, str]] = []
    covered_groups: set[str] = set()
    for rule in fired_rules:
        reasons.append({"source": "rule_engine", "feature": str(rule["feature"]), "explanation": str(rule["explanation"])})
        covered_groups.add(RULE_FEATURE_GROUP.get(rule["feature"], str(rule["feature"])))
    for contribution in ml_top_features:
        if contribution.group in covered_groups:
            continue
        reasons.append({"source": "ml_model", "feature": contribution.feature, "explanation": contribution.explanation})
        covered_groups.add(contribution.group)
    return reasons[:MAX_REASONS]
