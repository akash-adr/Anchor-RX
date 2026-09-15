"""
Sanity checks on the SERIALIZED model artifacts in train/ (pipeline .pkl + corpus_stats.json + model_metadata.json).
These are smoke tests, not an evaluation — performance on a genuinely held-out anomalous set is Step 5.
If the artifacts are missing:  .venv/bin/python -m train.train_model
"""

import statistics
import time

import pytest
from sklearn.ensemble import IsolationForest
from sklearn.pipeline import Pipeline

from data.dosage_reference import DOSAGE_REFERENCE
from data.generate_normal_corpus import generate_normal_corpus
from features.extract import FEATURE_NAMES, extract_features
from train.artifacts import ArtifactsNotFoundError, load_artifacts, save_artifacts, score_features
from train.train_model import train

from tests.payloads import make_payload


def score(artifacts, payload):
    return score_features(artifacts, extract_features(payload, artifacts.corpus_stats))


@pytest.fixture(scope="module")
def artifacts():
    try:
        return load_artifacts()
    except ArtifactsNotFoundError as exc:
        pytest.fail(str(exc))


def test_serialized_artifacts_load_as_one_fitted_pipeline(artifacts):
    assert isinstance(artifacts.pipeline, Pipeline)
    assert list(artifacts.pipeline.named_steps) == ["preprocess", "isolation_forest"]
    assert isinstance(artifacts.pipeline.named_steps["isolation_forest"], IsolationForest)
    assert artifacts.metadata["feature_names"] == list(FEATURE_NAMES)
    encoded = list(artifacts.pipeline.named_steps["preprocess"].get_feature_names_out())
    assert encoded == artifacts.metadata["encoded_feature_names"]
    assert set(artifacts.corpus_stats.drug_counts) == set(DOSAGE_REFERENCE)
    assert artifacts.calibration.p50 < artifacts.calibration.p99 < artifacts.calibration.p999


@pytest.mark.parametrize(
    "payload",
    [
        make_payload(),
        make_payload(drugName="Atorvastatin", drugClass="statin", doseValue="20.000",
                     frequency="once daily", durationDays=30, patientAge=62, patientWeight=78.0, patientVelocity=1),
    ],
    ids=["amoxicillin-500mg-tds-7d", "atorvastatin-20mg-daily-30d"],
)
def test_known_normal_prescription_gets_a_low_sub_score(artifacts, payload):
    result = score(artifacts, payload)
    print(f"\n{payload['drugName']}: {result}")
    assert result.normalized_score <= 30, result


def test_grossly_implausible_prescription_scores_far_above_normal(artifacts):
    """Smoke test only (not evaluation): 50 g IV amoxicillin every 15 minutes for a year, from a cardiologist."""
    extreme = make_payload(
        drugName="Amoxicillin", drugClass="antibiotic", doseValue="50000.000", frequency="every 15 minutes",
        durationDays=365, route="iv", patientAge=19, patientWeight=45.0, drugCombinationFlag=True,
        overlappingPrescriptionIds=["RX-X"], providerDrugClassHistory={"statin": 60, "arb": 40},
        patientVelocity=6,
    )
    normal, weird = score(artifacts, make_payload()), score(artifacts, extreme)
    print(f"\nnormal={normal} extreme={weird}")
    assert weird.raw_score > normal.raw_score
    assert weird.normalized_score >= 70, weird


def test_single_prescription_inference_is_well_under_100ms(artifacts):
    payload = make_payload()
    score(artifacts, payload)  # warm-up (first call pays one-off import/allocation costs)
    timings_ms = []
    for _ in range(50):
        started = time.perf_counter()
        score(artifacts, payload)  # extract_features → encode → forest → normalize
        timings_ms.append((time.perf_counter() - started) * 1000)
    print(f"\ninference ms: median={statistics.median(timings_ms):.2f} max={max(timings_ms):.2f}")
    assert max(timings_ms) < 100


def test_training_is_reproducible_and_survives_save_load(tmp_path):
    corpus = generate_normal_corpus(size=600, seed=11)
    first, second = train(corpus), train(corpus)
    probe = make_payload()
    expected = score(first, probe)
    assert score(second, probe) == expected
    save_artifacts(first, tmp_path)
    reloaded = load_artifacts(tmp_path)
    assert reloaded.corpus_stats == first.corpus_stats
    assert reloaded.calibration == first.calibration
    assert reloaded.feature_baselines == first.feature_baselines
    assert score(reloaded, probe) == expected
