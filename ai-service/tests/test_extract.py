import copy
import json
import math

import numpy as np
import pytest

from data.dosage_reference import DOSAGE_REFERENCE, DRUG_REFERENCE, get_reference
from features.encoding import CATEGORICAL_FEATURES, NUMERIC_FEATURES, build_preprocessor, features_to_frame
from features.extract import (
    DEFAULT_PATIENT_WEIGHT_KG,
    FEATURE_NAMES,
    UNIT_MISMATCH_DOSE_RATIO,
    PROVIDER_PRIOR_STRENGTH,
    CorpusStats,
    FeatureExtractionError,
    drug_rarity_score,
    extract_features,
    parse_doses_per_day,
    provider_pattern_score,
)

EXPECTED_KEYS = {
    "dose_value", "dose_per_kg", "dose_ratio", "unit_mismatch", "frequency", "duration_days", "route", "age", "weight", "drug_class",
    "drug_combination_flag", "drug_rarity_score", "provider_pattern_score", "patient_velocity", "dose_frequency_product",
}


# --- required by the spec -------------------------------------------------------------------------------

def test_extract_features_produces_exactly_the_15_expected_keys(payload, corpus_stats):
    features = extract_features(payload, corpus_stats)
    assert set(features) == EXPECTED_KEYS
    assert len(features) == len(FEATURE_NAMES) == 15
    assert tuple(features) == FEATURE_NAMES


def test_null_patient_weight_uses_documented_default_for_dose_per_kg(payload, corpus_stats):
    payload = {**payload, "patientWeight": None, "patientWeightIsDefault": True}
    features = extract_features(payload, corpus_stats)
    assert DEFAULT_PATIENT_WEIGHT_KG == 70.0
    assert features["weight"] == 70.0
    assert math.isclose(features["dose_per_kg"], 10.0 / 70.0, rel_tol=1e-6)
    assert math.isfinite(features["dose_per_kg"])


def test_categorical_encoding_is_deterministic_across_calls(payload, corpus_stats):
    fit_rows = [extract_features(payload, corpus_stats), extract_features({**payload, "drugClass": "biguanide", "drugName": "Metformin", "route": "iv"}, corpus_stats)]
    preprocessor = build_preprocessor().fit(features_to_frame(fit_rows))

    first = preprocessor.transform(features_to_frame([extract_features(payload, corpus_stats)]))
    second = preprocessor.transform(features_to_frame([extract_features(copy.deepcopy(payload), corpus_stats)]))

    assert first.shape == second.shape == (1, len(NUMERIC_FEATURES) + 4)  # 11 numeric + route{iv,oral} + class{biguanide,statin}
    np.testing.assert_array_equal(first, second)


# --- extra coverage ---------------------------------------------------------------------------------------

def test_extract_features_is_deterministic(payload, corpus_stats):
    assert extract_features(payload, corpus_stats) == extract_features(copy.deepcopy(payload), corpus_stats)


def test_feature_values_for_the_seeded_statin_duplication_case(payload, corpus_stats):
    features = extract_features(payload, corpus_stats)
    assert features["dose_value"] == 10.0
    assert features["frequency"] == 1.0
    assert features["dose_frequency_product"] == 10.0
    assert features["drug_class"] == "statin"
    assert features["route"] == "oral"
    assert features["drug_combination_flag"] == 1
    assert features["patient_velocity"] == 1.0
    # Provider has 4 other prescriptions, none statins; with k=5 smoothing the score is 4 / (4 + 5).
    assert features["provider_pattern_score"] == round(4 / 9, 6)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("once daily", 1), ("twice daily", 2), ("three times daily", 3), ("four times daily", 4),
        ("once daily at night", 1), ("twice daily with meals", 2), ("every 6 hours", 4), ("every 8 hours", 3),
        ("every 4 hours as needed", 6), ("every 15 minutes", 96), ("q12h", 2), ("hourly", 24),
        ("once weekly", 1 / 7), ("as needed", 4), ("2 times a day", 2), ("daily", 1),
        ("OD", 1), ("BID", 2), ("1 tab bd after food", 2), ("tds", 3), ("TID", 3), ("qid", 4),
    ],
)
def test_frequency_mapping(text, expected):
    assert math.isclose(parse_doses_per_day(text), expected, rel_tol=1e-9)


def test_unparseable_frequency_becomes_none_and_is_imputed_by_the_shared_encoder(payload, corpus_stats):
    odd = extract_features({**payload, "frequency": "take as the moon waxes"}, corpus_stats)
    assert odd["frequency"] is None and odd["dose_frequency_product"] is None
    preprocessor = build_preprocessor().fit(features_to_frame([extract_features(payload, corpus_stats)] * 3))
    encoded = preprocessor.transform(features_to_frame([odd]))
    assert not np.isnan(encoded).any()


@pytest.mark.parametrize(("unit", "expected_mg"), [("mg", 500.0), ("g", 500_000.0), ("mcg", 0.5), ("ml", 500.0)])
def test_mass_units_are_converted_to_mg(payload, corpus_stats, unit, expected_mg):
    features = extract_features({**payload, "doseValue": "500.000", "doseUnit": unit}, corpus_stats)
    assert math.isclose(features["dose_value"], expected_mg)


def test_rarity_and_provider_pattern_scores(corpus_stats):
    assert drug_rarity_score("Amoxicillin", corpus_stats) == 0.0  # most common in corpus
    assert drug_rarity_score("Unobtainium", corpus_stats) == 1.0  # never seen
    assert 0.0 < drug_rarity_score("Rosuvastatin", corpus_stats) < 1.0
    k = PROVIDER_PRIOR_STRENGTH
    # No history yet → exactly the population rate → not unusual.
    assert provider_pattern_score("statin", {}, corpus_stats) == 0.0
    # Writes this class at or above the population rate (40/105) → 0.
    assert provider_pattern_score("statin", {"statin": 50, "biguanide": 50}, corpus_stats) == 0.0
    # Never wrote this class across 100 prescriptions → 100 / (100 + k).
    assert provider_pattern_score("statin", {"biguanide": 100}, corpus_stats) == round(100 / (100 + k), 6)
    # Class never seen in the training corpus → maximally unusual.
    assert provider_pattern_score("novel class", {"statin": 3}, corpus_stats) == 1.0
    # Case/whitespace-insensitive, like the Node side.
    assert provider_pattern_score(" Statin ", {"STATIN": 50, "biguanide": 50}, corpus_stats) == 0.0


def test_corpus_stats_json_round_trip(tmp_path, corpus_stats):
    path = corpus_stats.save_json(tmp_path / "stats.json")
    assert CorpusStats.load_json(path) == corpus_stats
    assert json.loads(path.read_text())["drug_class_distribution"]["statin"] == round(40 / 105, 6)
    from_payloads = CorpusStats.from_payloads([{"drugName": "X", "drugClass": "Y"}, {"drugName": " x", "drugClass": "y"}])
    assert from_payloads.drug_counts == {"x": 2} and from_payloads.total == 2


def test_unknown_category_at_inference_does_not_break_encoding(payload, corpus_stats):
    # Fit on rows that include a drug from the reference: dose_ratio is None for a drug outside it (neutral fallback),
    # and a column with NO observed value at fit time would be dropped by the imputer. The trained model always sees values.
    listed = {**payload, "drugName": "Atorvastatin", "doseValue": "20.000"}
    preprocessor = build_preprocessor().fit(features_to_frame([extract_features(payload, corpus_stats), extract_features(listed, corpus_stats)]))
    unseen = extract_features({**payload, "route": "intrathecal", "drugClass": "novel class"}, corpus_stats)
    encoded = preprocessor.transform(features_to_frame([unseen]))
    assert encoded.shape[1] == len(NUMERIC_FEATURES) + 2
    assert encoded[0, -2:].tolist() == [0.0, 0.0]  # handle_unknown="ignore"


@pytest.mark.parametrize(
    "bad",
    [
        {"doseValue": "abc"},
        {"doseValue": "-5"},
        {"patientAge": -1},
        {"unexpectedField": 1},
        {"drugName": ""},
    ],
)
def test_invalid_payloads_are_rejected(payload, corpus_stats, bad):
    with pytest.raises(FeatureExtractionError):
        extract_features({**payload, **bad}, corpus_stats)


def test_features_to_frame_rejects_drifted_feature_keys(payload, corpus_stats):
    row = extract_features(payload, corpus_stats)
    with pytest.raises(ValueError):
        features_to_frame([{**row, "surprise": 1}])
    assert list(features_to_frame([row]).columns) == list(FEATURE_NAMES)
    assert set(CATEGORICAL_FEATURES) | set(NUMERIC_FEATURES) == set(FEATURE_NAMES)


@pytest.mark.parametrize(
    ("drug", "dose", "unit", "expected"),
    [
        ("Amoxicillin", "500.000", "mg", (1.0, 0)),  # at the 500 mg maximum
        ("Amoxicillin", "0.250", "g", (0.5, 0)),  # mass unit → converted to mg, still comparable
        ("Amoxicillin", "5.000", "ml", (UNIT_MISMATCH_DOSE_RATIO, 1)),  # ml for an mg drug → mismatch, no cross-unit ratio
        ("Diphenhydramine", "10.000", "ml", (0.5, 0)),  # liquid compared in ml
        ("Diphenhydramine", "10.000", "mg", (UNIT_MISMATCH_DOSE_RATIO, 1)),  # mg for the ml drug → mismatch
        ("Zytee", "1.000", "g", (None, 0)),  # not in the reference → neutral (imputed), no expected unit
    ],
)
def test_dose_ratio_and_unit_mismatch(payload, corpus_stats, drug, dose, unit, expected):
    features = extract_features({**payload, "drugName": drug, "doseValue": dose, "doseUnit": unit}, corpus_stats)
    assert (features["dose_ratio"], features["unit_mismatch"]) == expected


def test_dosage_reference_is_exactly_the_corrected_table_and_derives_only_from_it():
    assert len(DRUG_REFERENCE) == 17
    assert set(DOSAGE_REFERENCE) == {name.lower() for name in DRUG_REFERENCE}
    for name, row in DRUG_REFERENCE.items():
        ref = get_reference(name)
        assert (ref.drug_class, ref.unit, ref.typical_dose_min, ref.typical_dose_max, ref.max_single_dose) == (
            row["drug_class"], row["dosage_unit"], row["dose_min"], row["dose_max"], row["dose_max"])
        assert ref.typical_dose_per_kg_max == row["dose_per_kg_max"]
        assert ref.typical_doses_per_day == tuple(float(n) for n in range(row["freq_min"], row["freq_max"] + 1))
        assert ref.max_doses_per_day == row["freq_max"]
        assert (ref.typical_duration_min_days, ref.typical_duration_max_days) == (row["dur_min"], row["dur_max"])
        assert ref.common_strengths[0] == row["dose_min"] and ref.common_strengths[-1] == row["dose_max"]
        assert all(row["dose_min"] <= s <= row["dose_max"] for s in ref.common_strengths)
        assert ref.routes == ("oral",)
    # The one liquid is in ml; everything else is mg.
    assert get_reference("Diphenhydramine").unit == "ml"
    assert {key for key, ref in DOSAGE_REFERENCE.items() if ref.unit != "mg"} == {"diphenhydramine"}
    # Deliberately excluded: a topical gel has no comparable systemic range.
    assert get_reference("Zytee") is None
