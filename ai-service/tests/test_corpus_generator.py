from collections import Counter

import pytest

from data.dosage_reference import DOSAGE_REFERENCE
from data.generate_normal_corpus import (
    corpus_sha256,
    generate_normal_corpus,
    read_corpus_jsonl,
    summarize_corpus,
    write_corpus_jsonl,
)
from features.extract import FEATURE_NAMES, CorpusStats, dose_in_mg, extract_features, parse_doses_per_day


@pytest.fixture(scope="module")
def corpus():
    return generate_normal_corpus(size=2000, seed=123)


def test_generation_is_deterministic_for_a_seed():
    assert generate_normal_corpus(300, seed=5) == generate_normal_corpus(300, seed=5)
    assert corpus_sha256(generate_normal_corpus(300, seed=5)) != corpus_sha256(generate_normal_corpus(300, seed=6))


def test_every_row_extracts_every_feature_and_never_a_unit_mismatch(corpus):
    stats = CorpusStats.from_payloads(corpus)
    for payload in corpus:
        features = extract_features(payload, stats)  # also validates the ScoringPayload contract
        assert tuple(features) == FEATURE_NAMES
        assert features["frequency"] is not None, payload["frequency"]  # every generated phrasing must parse
        assert features["unit_mismatch"] == 0, payload  # normal corpus rows always use the reference's unit
        assert 0 < features["dose_ratio"] <= 1.0, payload  # inside the reference range


def test_rows_stay_inside_the_synthetic_reference_ranges(corpus):
    """The 'normal only' guarantee: no generated row breaks its drug's reference ranges."""
    for payload in corpus:
        ref = DOSAGE_REFERENCE[payload["drugName"].lower()]
        assert payload["drugClass"] == ref.drug_class
        assert ref.typical_dose_min <= dose_in_mg(float(payload["doseValue"]), payload["doseUnit"]) <= ref.typical_dose_max
        assert parse_doses_per_day(payload["frequency"]) <= ref.max_doses_per_day
        assert ref.typical_duration_min_days <= payload["durationDays"] <= ref.typical_duration_max_days
        assert payload["route"] in ref.routes
        assert 18 <= payload["patientAge"] <= 90


def test_corpus_has_variety_and_occasional_benign_duplication(corpus):
    summary = summarize_corpus(corpus)
    assert {p["drugName"].lower() for p in corpus} == set(DOSAGE_REFERENCE)
    assert summary["providers"] >= 30
    assert 0.02 <= summary["drug_combination_rate"] <= 0.12
    assert 0.10 <= summary["default_weight_rate"] <= 0.20
    assert summary["non_oral_route_rate"] == 0  # the corrected reference lists oral only
    assert summary["gram_unit_rate"] > 0 and summary["prn_rate"] > 0
    # The liquid is generated in ml, never relabelled as mg.
    assert {p["doseUnit"] for p in corpus if p["drugName"] == "Diphenhydramine"} == {"ml"}
    ages = [p["patientAge"] for p in corpus]
    assert min(ages) < 30 and max(ages) > 75


def test_provider_history_excludes_the_row_itself_like_node(corpus):
    rows_per_provider = Counter(p["providerId"] for p in corpus)
    for payload in corpus[:300]:
        assert sum(payload["providerDrugClassHistory"].values()) == rows_per_provider[payload["providerId"]] - 1


def test_jsonl_round_trip(tmp_path, corpus):
    path = write_corpus_jsonl(corpus[:50], tmp_path / "corpus.jsonl", seed=123)
    assert read_corpus_jsonl(path) == corpus[:50]
    assert (tmp_path / "corpus.meta.json").exists()
