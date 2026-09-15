import pytest

from features.extract import extract_features
from inference.explain import (
    MAX_REASONS,
    ML_EXPLANATIONS,
    MlContribution,
    build_occlusions,
    build_reasons,
    ml_top_features,
)
from inference.score import get_artifacts
from rules.rule_engine import EXPLANATIONS
from train.artifacts import AnomalySubScore, score_features

from tests.payloads import extreme_payload, make_payload, ml_only_unusual_payload

DOSE = {"rule": "dose_limit", "feature": "dose_value", "points": 45, "explanation": EXPLANATIONS["dose_limit"]}
FREQUENCY = {"rule": "frequency_range", "feature": "frequency", "points": 35, "explanation": EXPLANATIONS["frequency_above"]}
DUPLICATION = {"rule": "drug_duplication", "feature": "drug_combination_flag", "points": 25, "explanation": EXPLANATIONS["drug_duplication"]}
DURATION = {"rule": "duration_range", "feature": "duration_days", "points": 20, "explanation": EXPLANATIONS["duration_above"]}


def ml(group, feature, direction, points):
    return MlContribution(group, feature, direction, points)


# ── build_reasons (pure) ─────────────────────────────────────────────────────────────────────────────────────

def test_rule_hits_come_first_with_their_own_explanations():
    reasons = build_reasons([DOSE, DUPLICATION], [ml("velocity", "patient_velocity", "high", 12.0)])
    assert reasons == [
        {"source": "rule_engine", "feature": "dose_value", "explanation": EXPLANATIONS["dose_limit"]},
        {"source": "rule_engine", "feature": "drug_combination_flag", "explanation": EXPLANATIONS["drug_duplication"]},
        {"source": "ml_model", "feature": "patient_velocity", "explanation": ML_EXPLANATIONS[("velocity", "high")]},
    ]


def test_ml_reasons_skip_feature_groups_a_rule_already_explains():
    reasons = build_reasons(
        [DOSE],
        [ml("dose", "dose_value", "high", 40.0), ml("velocity", "patient_velocity", "high", 12.0), ml("age", "age", "high", 8.0)],
    )
    assert [(r["source"], r["feature"]) for r in reasons] == [("rule_engine", "dose_value"), ("ml_model", "patient_velocity"), ("ml_model", "age")]


def test_capped_at_three_with_rules_taking_priority():
    only_rules = build_reasons([DOSE, FREQUENCY, DUPLICATION, DURATION], [ml("route", "route", "different", 90.0)])
    assert len(only_rules) == MAX_REASONS == 3
    assert [r["feature"] for r in only_rules] == ["dose_value", "frequency", "drug_combination_flag"]
    assert all(r["source"] == "rule_engine" for r in only_rules)

    mixed = build_reasons([DOSE, DUPLICATION], [ml("route", "route", "different", 90.0), ml("age", "age", "low", 50.0)])
    assert [r["source"] for r in mixed] == ["rule_engine", "rule_engine", "ml_model"]
    assert mixed[2]["feature"] == "route"


def test_no_signals_no_reasons():
    assert build_reasons([], []) == []


# ── ML contributions against the saved model ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def artifacts():
    return get_artifacts()


def test_every_possible_occlusion_has_plain_language_text(artifacts):
    for payload in (make_payload(), extreme_payload(), ml_only_unusual_payload(), make_payload(patientAge=19, patientWeight=41.0)):
        features = extract_features(payload, artifacts.corpus_stats)
        for occlusion in build_occlusions(features, artifacts.feature_baselines):
            assert (occlusion.group, occlusion.direction) in ML_EXPLANATIONS


def test_ordinary_prescription_gets_no_ml_reasons(artifacts):
    features = extract_features(make_payload(), artifacts.corpus_stats)
    ml_score = score_features(artifacts, features)
    assert ml_score.normalized_score <= 30
    assert ml_top_features(features, artifacts, ml_score) == []


def test_ml_reasons_are_gated_on_the_ml_sub_score(artifacts):
    features = extract_features(extreme_payload(), artifacts.corpus_stats)
    assert ml_top_features(features, artifacts, AnomalySubScore(raw_score=0.9, normalized_score=30.0)) == []


def test_contributions_point_at_the_inputs_that_were_made_unusual(artifacts):
    features = extract_features(ml_only_unusual_payload(), artifacts.corpus_stats)
    ml_score = score_features(artifacts, features)
    assert ml_score.normalized_score > 30
    contributions = ml_top_features(features, artifacts, ml_score)
    print("\n", contributions)
    assert 1 <= len(contributions) <= 3
    assert [c.points for c in contributions] == sorted((c.points for c in contributions), reverse=True)
    assert all(c.points >= 5 for c in contributions)
    assert {c.group for c in contributions} <= {"provider_pattern", "velocity", "age", "weight"}


def test_correlated_features_are_reset_together(artifacts):
    features = extract_features(extreme_payload(), artifacts.corpus_stats)  # 50000 mg, 96/day, 45 kg, iv
    typical = artifacts.feature_baselines.for_drug_class("antibiotic")
    occlusions = {o.group: o for o in build_occlusions(features, artifacts.feature_baselines)}

    dose = occlusions["dose"]
    assert dose.direction == "high"
    assert dose.features["dose_value"] == typical["dose_value"]
    assert dose.features["dose_per_kg"] == pytest.approx(typical["dose_value"] / 45.0)
    assert dose.features["dose_frequency_product"] == pytest.approx(typical["dose_value"] * 96.0)
    assert dose.features["age"] == features["age"]  # everything else untouched

    assert occlusions["frequency"].features["dose_frequency_product"] == pytest.approx(50000.0 * typical["frequency"])
    assert occlusions["weight"].features["dose_per_kg"] == pytest.approx(50000.0 / typical["weight"])
    assert occlusions["route"].features["route"] == "oral"


def test_below_typical_values_of_risk_only_features_are_never_reasons(artifacts):
    features = extract_features(make_payload(patientVelocity=0, providerDrugClassHistory={"antibiotic": 100}), artifacts.corpus_stats)
    groups = {o.group for o in build_occlusions(features, artifacts.feature_baselines)}
    assert not groups & {"velocity", "provider_pattern", "duplication"}
