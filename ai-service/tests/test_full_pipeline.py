"""
Module 8 completion gate — the full risk-engine pipeline, end to end, against the saved model.

Hand-constructed payloads here come from neither the training generator nor the evaluation generator.
"""

import ast
import json
import statistics
import time
from pathlib import Path

import pytest

from data.dosage_reference import DOSAGE_REFERENCE
from data.generate_normal_corpus import DEFAULT_CORPUS_PATH, DEFAULT_SEED as TRAINING_SEED, corpus_sha256, read_corpus_jsonl
from evaluation.disjointness import feature_fingerprint
from evaluation.evaluate import NORMAL_HOLDOUT_SEED, REPORT_JSON, binary_metrics, build_eval_set, pct
from evaluation.generate_anomalous_set import ANOMALOUS_SEED, CATEGORIES, generate_anomalous_set
from features.extract import dose_in_mg, parse_doses_per_day
from inference.score import get_artifacts, score_prescription
from rules.rule_engine import EXPLANATIONS

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]

# Hand-constructed: Cefalexin 500 mg twice daily for 7 days, 45-year-old, 72.5 kg, broad GP history, no recent Rx.
CLEAN_PAYLOAD = {
    "payloadVersion": 1, "prescriptionId": "RX-HAND-0001", "versionNumber": 1, "patientId": "PAT-HAND-01",
    "providerId": "PRV-HAND-01", "referenceTime": "2026-09-15T09:30:00.000Z",
    "drugName": "Cefalexin", "drugClass": "cephalosporin", "doseValue": "500.000", "doseUnit": "mg",
    "frequency": "twice daily", "durationDays": 7, "route": "oral",
    "patientAge": 45, "patientWeight": 72.5, "patientWeightIsDefault": False,
    "drugCombinationFlag": False, "overlappingPrescriptionIds": [],
    "providerDrugClassHistory": {"analgesic": 22, "penicillin antibiotic": 18, "cephalosporin": 9, "nsaid": 11, "statin": 14, "biguanide": 8},
    "patientVelocity": 0,
}

# Same prescription with 4 000 mg per dose (4× the synthetic typical max of 1 000 mg) AND another active cephalosporin.
DOSE_AND_DUPLICATION_PAYLOAD = {
    **CLEAN_PAYLOAD, "prescriptionId": "RX-HAND-0002",
    "doseValue": "4000.000", "drugCombinationFlag": True, "overlappingPrescriptionIds": ["RX-HAND-0003"],
}


@pytest.fixture(scope="module")
def artifacts():
    return get_artifacts()


# ── behaviour ───────────────────────────────────────────────────────────────────────────────────────────────

def test_clean_hand_constructed_prescription_scores_low_with_no_reasons(artifacts):
    result = score_prescription(CLEAN_PAYLOAD, artifacts)
    print("\nclean:", json.dumps(result))
    assert result["risk_band"] == "low"
    assert result["reasons"] == []


def test_dose_violation_plus_duplication_is_flagged_with_both_rule_explanations(artifacts):
    result = score_prescription(DOSE_AND_DUPLICATION_PAYLOAD, artifacts)
    print("\ndose+duplication:", json.dumps(result))
    assert result["risk_band"] in {"review", "high"}
    assert len(result["reasons"]) <= 3
    assert {"source": "rule_engine", "feature": "dose_value", "explanation": EXPLANATIONS["dose_limit"]} in result["reasons"]
    assert {"source": "rule_engine", "feature": "drug_combination_flag", "explanation": EXPLANATIONS["drug_duplication"]} in result["reasons"]
    assert [r["source"] for r in result["reasons"][:2]] == ["rule_engine", "rule_engine"]  # rules ranked first


@pytest.mark.parametrize("payload", [CLEAN_PAYLOAD, DOSE_AND_DUPLICATION_PAYLOAD], ids=["clean", "dose+duplication"])
def test_score_prescription_completes_under_500ms_measured(artifacts, payload):
    timings_ms = []
    for _ in range(50):
        started = time.perf_counter()
        score_prescription(payload, artifacts)
        timings_ms.append((time.perf_counter() - started) * 1000)
    print(f"\n{payload['prescriptionId']}: first={timings_ms[0]:.2f} ms median={statistics.median(timings_ms):.2f} ms max={max(timings_ms):.2f} ms")
    assert max(timings_ms) < 500


# ── train / eval disjointness (concrete proof) ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def training_fingerprints(artifacts):
    training = read_corpus_jsonl(DEFAULT_CORPUS_PATH)
    assert corpus_sha256(training) == artifacts.metadata["corpus"]["sha256"], "training file is not what the model was trained on"
    return {feature_fingerprint(payload, artifacts.corpus_stats) for payload in training}


def test_training_file_is_the_corpus_the_saved_model_was_trained_on(artifacts, training_fingerprints):
    assert artifacts.metadata["corpus"]["rows"] == 4000
    assert len(training_fingerprints) > 3900


def test_every_anomalous_eval_case_has_zero_fingerprint_overlap_with_training(artifacts, training_fingerprints):
    anomalous = {feature_fingerprint(case.payload, artifacts.corpus_stats) for case in generate_anomalous_set()}
    assert len(anomalous) > 0
    assert anomalous & training_fingerprints == set()


def test_full_held_out_eval_set_has_zero_fingerprint_overlap_with_training(artifacts, training_fingerprints):
    cases, record = build_eval_set(artifacts)
    held_out = [feature_fingerprint(case.payload, artifacts.corpus_stats) for case in cases]
    overlapping = [fp for fp in held_out if fp in training_fingerprints]  # recomputed here, not trusting build_eval_set
    assert overlapping == []
    assert record["final_overlap_with_training"] == 0
    assert sum(case.is_anomalous for case in cases) == 1000 and sum(not case.is_anomalous for case in cases) > 950


def test_train_anomalous_and_normal_holdout_seeds_are_all_different(artifacts):
    assert artifacts.metadata["corpus"]["seed"] == TRAINING_SEED
    assert len({TRAINING_SEED, ANOMALOUS_SEED, NORMAL_HOLDOUT_SEED}) == 3


def test_anomalous_generator_does_not_import_the_training_generator():
    source = (AI_SERVICE_ROOT / "evaluation" / "generate_anomalous_set.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    assert not any("generate_normal_corpus" in module for module in imported), imported


def test_anomalous_labels_are_truthful():
    cases = generate_anomalous_set()
    assert {case.category for case in cases} == set(CATEGORIES)
    for case in cases:
        p = case.payload
        ref = DOSAGE_REFERENCE[p["drugName"].lower()]
        assert case.is_anomalous and case.anomalies
        for anomaly in case.anomalies:
            if anomaly == "dose_3x_to_5x":
                assert dose_in_mg(float(p["doseValue"]), p["doseUnit"]) >= 3 * ref.typical_dose_max - 0.05
            elif anomaly == "extreme_frequency":
                assert parse_doses_per_day(p["frequency"]) >= 2 * ref.max_doses_per_day
            elif anomaly == "extreme_duration":
                assert p["durationDays"] >= 3 * ref.typical_duration_max_days
            elif anomaly == "class_duplication":
                assert p["drugCombinationFlag"] is True


# ── evaluation bookkeeping ────────────────────────────────────────────────────────────────────────────────

def test_binary_metrics_arithmetic():
    labels = [True, True, True, True, False, False, False, False]
    predicted = [True, True, True, False, True, False, False, False]  # TP 3, FN 1, FP 1, TN 3
    m = binary_metrics(labels, predicted)
    assert (m["tp"], m["fn"], m["fp"], m["tn"]) == (3, 1, 1, 3)
    assert m["precision"] == 0.75 and m["recall"] == 0.75 and m["f1"] == pytest.approx(0.75)
    assert m["false_negative_rate"] == 0.25 and m["false_positive_rate"] == 0.25


def test_notes_quote_the_real_evaluation_numbers():
    report = json.loads(REPORT_JSON.read_text(encoding="utf-8"))
    notes = (AI_SERVICE_ROOT / "NOTES.md").read_text(encoding="utf-8")
    for key in ("precision", "recall", "f1", "false_negative_rate", "false_positive_rate"):
        assert pct(report["pipeline"][key]) in notes, f"NOTES.md does not quote {key} = {pct(report['pipeline'][key])}"
