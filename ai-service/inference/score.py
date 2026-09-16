"""
Anchor Rx — Module 8 serving function.

    score_prescription(payload) → { risk_score, risk_band, reasons, details }

    payload (ScoringPayload v1 from backend/ml/buildScoringPayload.js)
      → extract_features                              15 features
      → saved Isolation Forest pipeline               ML sub-score 0–100      (train/artifacts.py)
      → run_rule_engine                               rule sub-score 0–100    (rules/rule_engine.py)
      → aggregate_risk / risk_band                    final score + band      (inference/aggregator.py)
      → ml_top_features + build_reasons               ≤ 3 ranked reasons      (inference/explain.py)

Stateless and deterministic for a given model: no database, no network. It does NOT check tampering or the ledger
and does NOT decide Dispense/Review/Block.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Mapping

from pydantic import ValidationError

from data.dosage_reference import DOSAGE_REFERENCE
from features.extract import FeatureExtractionError, extract_features
from features.payload import ScoringPayload
from inference.aggregator import aggregate_risk, risk_band
from inference.explain import build_reasons, ml_top_features
from rules.rule_engine import RuleContext, run_rule_engine
from train.artifacts import ModelArtifacts, load_artifacts, score_features


@lru_cache(maxsize=1)
def get_artifacts() -> ModelArtifacts:
    """Load the saved model once per process."""
    return load_artifacts()


def score_prescription(payload: ScoringPayload | Mapping[str, Any], artifacts: ModelArtifacts | None = None) -> dict[str, Any]:
    artifacts = artifacts if artifacts is not None else get_artifacts()
    if not isinstance(payload, ScoringPayload):
        try:
            payload = ScoringPayload.model_validate(payload)
        except ValidationError as exc:
            raise FeatureExtractionError(f"Invalid scoring payload: {exc}") from exc

    features = extract_features(payload, artifacts.corpus_stats)
    ml = score_features(artifacts, features)
    rules = run_rule_engine(features, DOSAGE_REFERENCE, RuleContext.from_payload(payload))
    risk_score = aggregate_risk(ml.normalized_score, rules["subScore"])
    reasons = build_reasons(rules["firedRules"], ml_top_features(features, artifacts, ml))

    return {
        "risk_score": risk_score,
        "risk_band": risk_band(risk_score),
        "reasons": reasons,
        "details": {
            "ml_subscore": ml.normalized_score,
            "rule_subscore": rules["subScore"],
            "rules_not_evaluated": rules["notEvaluated"],
            "patient_weight_is_default": payload.patientWeightIsDefault,
            "model_version": artifacts.metadata.get("model_version"),
        },
    }
