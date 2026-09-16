import pytest
from fastapi.testclient import TestClient

import main
from inference.score import score_prescription

from tests.payloads import extreme_payload, make_payload


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as test_client:  # runs the startup lifespan (loads the model)
        yield test_client


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["model_version"] == "isolation-forest-placeholder-v1"


def test_score_returns_score_prescription_output(client):
    response = client.post("/score", json=extreme_payload())
    assert response.status_code == 200
    assert response.json() == score_prescription(extreme_payload())
    assert float(response.headers["x-scoring-time-ms"]) < 500


@pytest.mark.parametrize(
    "payload",
    [
        {**make_payload(), "patientName": "should not be here"},  # contract forbids extra fields
        {k: v for k, v in make_payload().items() if k != "drugName"},
        {**make_payload(), "doseValue": "abc"},
    ],
    ids=["extra-field", "missing-drug-name", "non-numeric-dose"],
)
def test_invalid_payloads_are_422(client, payload):
    assert client.post("/score", json=payload).status_code == 422


def test_drug_reference_returns_drug_reference_unchanged(client):
    from data.dosage_reference import DRUG_REFERENCE

    response = client.get("/drug-reference")
    assert response.status_code == 200
    body = response.json()
    assert body == DRUG_REFERENCE
    assert len(body) == 17
    assert body["Amoxicillin"] == {"dose_min": 250, "dose_max": 500, "dosage_unit": "mg", "dose_per_kg_max": 25, "freq_min": 2, "freq_max": 3,
                                   "dur_min": 5, "dur_max": 14, "drug_class": "antibiotic"}
    assert "Zytee" not in body
