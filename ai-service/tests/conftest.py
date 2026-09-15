import pytest

from features.extract import CorpusStats


@pytest.fixture
def corpus_stats() -> CorpusStats:
    # Tiny hand-made statistics — the real ones come from the Step 2 training corpus.
    return CorpusStats(
        drug_counts={"amoxicillin": 40, "atorvastatin": 30, "rosuvastatin": 10, "metformin": 25},
        drug_class_counts={"penicillin antibiotic": 40, "statin": 40, "biguanide": 25},
    )


@pytest.fixture
def payload() -> dict:
    # Shape produced by backend/ml/buildScoringPayload.js, modelled on RX-DEMO-0003 (history/velocity values are test-chosen).
    return {
        "payloadVersion": 1,
        "prescriptionId": "RX-DEMO-0003",
        "versionNumber": 1,
        "patientId": "PAT-002",
        "providerId": "PRV-001",
        "referenceTime": "2026-09-14T16:27:53.690Z",
        "drugName": "Rosuvastatin",
        "drugClass": "statin",
        "doseValue": "10.000",
        "doseUnit": "mg",
        "frequency": "once daily",
        "durationDays": 30,
        "route": "oral",
        "patientAge": 63,
        "patientWeight": 82.0,
        "patientWeightIsDefault": False,
        "drugCombinationFlag": True,
        "overlappingPrescriptionIds": ["RX-DEMO-0002"],
        "providerDrugClassHistory": {"penicillin antibiotic": 2, "biguanide": 1, "analgesic": 1},
        "patientVelocity": 1,
    }
