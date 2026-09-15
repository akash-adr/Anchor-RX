import statistics
import time

import pytest

from features.extract import FeatureExtractionError
from features.payload import ScoringPayload
from inference.aggregator import aggregate_risk
from inference.score import get_artifacts, score_prescription
from rules.rule_engine import EXPLANATIONS

from tests.payloads import extreme_payload, make_payload, ml_only_unusual_payload, tenfold_roxithromycin_payload


@pytest.fixture(scope="module")
def artifacts():
    return get_artifacts()


def test_output_contract(artifacts):
    result = score_prescription(make_payload(), artifacts)
    assert set(result) == {"risk_score", "risk_band", "reasons", "details"}
    assert isinstance(result["risk_score"], int)
    assert set(result["details"]) == {"ml_subscore", "rule_subscore", "rules_not_evaluated", "patient_weight_is_default", "model_version"}
    assert result["risk_score"] == aggregate_risk(result["details"]["ml_subscore"], result["details"]["rule_subscore"])


def test_ordinary_prescription_is_low_with_no_reasons(artifacts):
    result = score_prescription(make_payload(), artifacts)
    assert result["risk_band"] == "low"
    assert result["reasons"] == []


def test_duplication_alone_stays_low_but_is_explained(artifacts):
    result = score_prescription(make_payload(drugCombinationFlag=True, overlappingPrescriptionIds=["RX-2"]), artifacts)
    assert (result["risk_score"], result["risk_band"]) == (25, "low")
    assert result["reasons"] == [{"source": "rule_engine", "feature": "drug_combination_flag", "explanation": EXPLANATIONS["drug_duplication"]}]


def test_grossly_implausible_prescription_is_high_and_rules_fill_the_reason_slots(artifacts):
    result = score_prescription(extreme_payload(), artifacts)
    assert (result["risk_score"], result["risk_band"]) == (100, "high")
    assert [r["source"] for r in result["reasons"]] == ["rule_engine"] * 3
    assert [r["feature"] for r in result["reasons"]] == ["dose_value", "frequency", "drug_combination_flag"]


def test_ml_only_anomaly_is_explained_by_the_ml_and_can_never_reach_high(artifacts):
    """No rule fires; the ML flags the case (> 30) and explains it. With no rule hits the final score is 0.6 · ml (<= 60),
    so an ML-only case reaches review only when ml >= 52. After the corrected-reference retrain this case scores
    ml 48.27 → risk 29 (LOW); before the retrain it reached review. Documented as a real behaviour change, not re-tuned."""
    result = score_prescription(ml_only_unusual_payload(), artifacts)
    ml = result["details"]["ml_subscore"]
    assert result["details"]["rule_subscore"] == 0
    assert ml > 30
    assert result["risk_score"] == aggregate_risk(ml, 0) <= 60
    assert result["risk_band"] == ("review" if result["risk_score"] > 30 else "low")
    assert 1 <= len(result["reasons"]) <= 3
    assert all(r["source"] == "ml_model" for r in result["reasons"])


def test_tenfold_dose_is_review_not_high__known_limitation(artifacts):
    """Documents CURRENT behaviour: one dose-limit hit (45) plus a low ML score gives 45 → review.
    A tiered dose rule was proposed but not adopted; change this test deliberately if that decision changes."""
    result = score_prescription(tenfold_roxithromycin_payload(), artifacts)
    assert result["risk_band"] == "review"
    assert result["reasons"][0] == {"source": "rule_engine", "feature": "dose_value", "explanation": EXPLANATIONS["dose_limit"]}


def test_dict_and_validated_payloads_score_identically(artifacts):
    payload = ml_only_unusual_payload()
    assert score_prescription(payload, artifacts) == score_prescription(ScoringPayload.model_validate(payload), artifacts)
    assert score_prescription(payload, artifacts) == score_prescription(payload, artifacts)


@pytest.mark.parametrize("bad", [{"doseValue": "abc"}, {"unexpectedField": 1}, {"patientAge": -5}])
def test_invalid_payloads_raise(artifacts, bad):
    with pytest.raises(FeatureExtractionError):
        score_prescription({**make_payload(), **bad}, artifacts)


@pytest.mark.parametrize("factory", [make_payload, extreme_payload, ml_only_unusual_payload], ids=["ordinary", "extreme", "ml-only-with-explanations"])
def test_scoring_is_well_under_500ms(artifacts, factory):
    payload = factory()
    score_prescription(payload, artifacts)  # warm-up
    timings_ms = []
    for _ in range(30):
        started = time.perf_counter()
        score_prescription(payload, artifacts)
        timings_ms.append((time.perf_counter() - started) * 1000)
    print(f"\n{factory.__name__}: median={statistics.median(timings_ms):.2f} ms max={max(timings_ms):.2f} ms")
    assert max(timings_ms) < 500
    assert statistics.median(timings_ms) < 100
