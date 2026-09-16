"""
Demo verification — the three demo scenarios, scored end to end through score_prescription with the saved model.

Drugs are real entries of data/dosage_reference.py. The clean case matches the backend seed's Amoxicillin prescription
(RX-DEMO-0001: 500 mg three times daily for 5 days). For the duplication case the flag is set exactly as Node's live
data bridge sets it when two medicines of the same class are on ONE prescription for the same patient (both get it).
Each result is printed before its assertions so a failure shows the real score.
"""

import json

import pytest

from inference.score import get_artifacts, score_prescription
from rules.rule_engine import EXPLANATIONS

from tests.payloads import make_payload

DUPLICATION_REASON = {"source": "rule_engine", "feature": "drug_combination_flag", "explanation": EXPLANATIONS["drug_duplication"]}
OVERDOSE_REASON = {"source": "rule_engine", "feature": "dose_value", "explanation": EXPLANATIONS["dose_limit"]}


@pytest.fixture(scope="module")
def artifacts():
    return get_artifacts()


def amoxicillin(**overrides):
    defaults = {"drugName": "Amoxicillin", "drugClass": "antibiotic", "doseValue": "500.000", "doseUnit": "mg", "frequency": "three times daily", "durationDays": 5}
    return make_payload(**{**defaults, **overrides})


def test_demo_clean_amoxicillin_scores_low(artifacts):
    payload = amoxicillin()
    result = score_prescription(payload, artifacts)
    print(f"\nCLEAN {payload['drugName']} {payload['doseValue']} {payload['doseUnit']}:", json.dumps(result))
    assert result["risk_band"] == "low"
    assert result["reasons"] == []


@pytest.mark.parametrize("medicine", ["Amoxicillin", "Roxithromycin"])
def test_demo_duplication_amoxicillin_plus_roxithromycin_on_one_prescription(artifacts, medicine):
    # One prescription, same patient: Amoxicillin 500 mg + Roxithromycin 150 mg — both "antibiotic", so both are flagged.
    payloads = {
        "Amoxicillin": amoxicillin(prescriptionId="RX-DEMO-DUP", drugCombinationFlag=True),
        "Roxithromycin": make_payload(prescriptionId="RX-DEMO-DUP", drugName="Roxithromycin", drugClass="antibiotic", doseValue="150.000",
                                      doseUnit="mg", frequency="twice daily", durationDays=5, drugCombinationFlag=True),
    }
    payload = payloads[medicine]
    result = score_prescription(payload, artifacts)
    print(f"\nDUPLICATION {medicine}:", json.dumps(result))
    assert DUPLICATION_REASON in result["reasons"], f"{medicine}: duplication reason missing"
    assert result["risk_band"] in {"review", "high"}, f"{medicine}: risk {result['risk_score']} ({result['risk_band']})"


def test_demo_dangerous_dose_amoxicillin_scores_high_with_the_overdose_named(artifacts):
    payload = amoxicillin(doseValue="2500.000")  # 5× the 500 mg typical maximum
    result = score_prescription(payload, artifacts)
    print(f"\nDANGEROUS DOSE {payload['drugName']} {payload['doseValue']} {payload['doseUnit']}:", json.dumps(result))
    assert result["reasons"][0] == OVERDOSE_REASON, "overdose reason not first"
    assert result["risk_band"] == "high", f"{payload['drugName']}: risk {result['risk_score']} ({result['risk_band']})"
