"""
REGRESSION LOCK — the duplication reason must appear ONLY when drugCombinationFlag is true.

Investigated after a false-positive report ("the duplication rule fires on every medicine, including single-medicine
prescriptions"). These tests pin the reported scenario (Amoxicillin 2500 mg, single medicine, no duplication) and the
genuine duplication case side by side, so the rule cannot start firing on a false flag, or stop firing on a true one.

Nothing here adjusts weights, thresholds, bands or the aggregation formula — the numbers asserted are the CURRENT ones.
"""

import pytest

from inference.score import get_artifacts, score_prescription
from rules.rule_engine import DOSE_LIMIT_POINTS, DRUG_DUPLICATION_POINTS, EXPLANATIONS, drug_duplication_check

from tests.payloads import make_payload

DUPLICATION_EXPLANATION = EXPLANATIONS["drug_duplication"]
DOSE_EXPLANATION = EXPLANATIONS["dose_limit"]


@pytest.fixture(scope="module")
def artifacts():
    return get_artifacts()


def reported_case(**overrides):
    """The reported scenario: a single 2500 mg Amoxicillin (5x the 500 mg reference maximum), no duplication."""
    base = {"doseValue": "2500.000", "frequency": "three times daily", "durationDays": 5, "drugCombinationFlag": False}
    return make_payload(**{**base, **overrides})


def explanations(result):
    return [reason["explanation"] for reason in result["reasons"]]


# The rule engine validates its whole input, so these carry the other required features at ordinary values.
def features(flag):
    return {"dose_value": 500.0, "frequency": 3.0, "duration_days": 5.0, "drug_combination_flag": flag}


def test_rule_is_driven_only_by_the_flag():
    assert drug_duplication_check(features(0)).fired is False
    assert drug_duplication_check(features(False)).fired is False
    fired = drug_duplication_check(features(1))
    assert fired.fired is True
    assert fired.points == DRUG_DUPLICATION_POINTS
    assert fired.explanation == DUPLICATION_EXPLANATION


def test_reported_scenario_has_the_dose_reason_and_NOT_the_duplication_reason(artifacts):
    result = score_prescription(reported_case(), artifacts)
    assert DOSE_EXPLANATION in explanations(result)
    assert DUPLICATION_EXPLANATION not in explanations(result), "duplication reason on a prescription with no duplication"
    assert all(reason["feature"] != "drug_combination_flag" for reason in result["reasons"])
    assert result["details"]["rule_subscore"] == DOSE_LIMIT_POINTS  # the dose rule alone — no duplication points added


def test_a_clean_single_medicine_prescription_has_no_reasons_at_all(artifacts):
    result = score_prescription(make_payload(drugCombinationFlag=False), artifacts)
    assert result["reasons"] == []
    assert result["risk_band"] == "low"


def test_a_GENUINE_duplication_still_fires_exactly_as_before(artifacts):
    result = score_prescription(make_payload(drugCombinationFlag=True), artifacts)
    assert DUPLICATION_EXPLANATION in explanations(result)
    assert result["details"]["rule_subscore"] == DRUG_DUPLICATION_POINTS


def test_the_flag_changes_duplication_only_on_the_RULE_side(artifacts):
    """The dose-limit rule is untouched by the flag. NOTE: drug_combination_flag is ALSO an Isolation Forest feature, so
    the ML subscore legitimately moves with it — which is exactly why a false positive would have inflated a score twice
    (once as rule points, once as an unusual-looking feature value)."""
    without = score_prescription(reported_case(), artifacts)
    with_duplication = score_prescription(reported_case(drugCombinationFlag=True), artifacts)

    assert DOSE_EXPLANATION in explanations(without) and DOSE_EXPLANATION in explanations(with_duplication)
    assert DUPLICATION_EXPLANATION not in explanations(without)
    assert DUPLICATION_EXPLANATION in explanations(with_duplication)
    # Rule side: fired rules ADD UP, so the dose rule's own 45 is unchanged and duplication adds its 25 on top.
    # This is precisely what the false-positive report would have cost: +25 rule points on every clean medicine.
    assert without["details"]["rule_subscore"] == DOSE_LIMIT_POINTS
    assert with_duplication["details"]["rule_subscore"] == DOSE_LIMIT_POINTS + DRUG_DUPLICATION_POINTS
    # ML side: the flag is a model feature, so the subscore differs — recorded here, not asserted equal.
    assert with_duplication["details"]["ml_subscore"] != without["details"]["ml_subscore"]
    assert with_duplication["risk_score"] >= without["risk_score"]
