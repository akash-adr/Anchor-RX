import pytest

from data.dosage_reference import DOSAGE_REFERENCE
from features.extract import CorpusStats, extract_features
from rules.rule_engine import (
    DOSE_LIMIT_POINTS,
    DRUG_DUPLICATION_POINTS,
    DURATION_RANGE_POINTS,
    EXPLANATIONS,
    FREQUENCY_RANGE_POINTS,
    RuleContext,
    RuleInputError,
    dose_limit_check,
    drug_duplication_check,
    duration_range_check,
    frequency_duration_range_check,
    frequency_range_check,
    run_rule_engine,
)

AMOXICILLIN = RuleContext(drug_name="Amoxicillin", dose_unit="mg")  # reference: 250–500 mg, 2–3/day (max 3), 5–14 days


def clean_features(**overrides):
    """Amoxicillin 500 mg three times daily for 7 days — inside every synthetic range, no duplication."""
    base = {
        "dose_value": 500.0, "dose_per_kg": 500.0 / 70, "frequency": 3.0, "duration_days": 7.0, "route": "oral",
        "age": 40.0, "weight": 70.0, "drug_class": "antibiotic", "drug_combination_flag": 0,
        "drug_rarity_score": 0.3, "provider_pattern_score": 0.0, "patient_velocity": 0.0, "dose_frequency_product": 1500.0,
    }
    return {**base, **overrides}


# ── clean input ──────────────────────────────────────────────────────────────────────────────────────────────

def test_no_rule_fires_on_a_clean_feature_set():
    features = clean_features()
    assert dose_limit_check(features, DOSAGE_REFERENCE, AMOXICILLIN) == (False, 0, "")
    assert frequency_range_check(features, DOSAGE_REFERENCE, AMOXICILLIN).fired is False
    assert duration_range_check(features, DOSAGE_REFERENCE, AMOXICILLIN).fired is False
    assert frequency_duration_range_check(features, DOSAGE_REFERENCE, AMOXICILLIN).fired is False
    assert drug_duplication_check(features).fired is False
    assert run_rule_engine(features, DOSAGE_REFERENCE, AMOXICILLIN) == {"subScore": 0, "firedRules": [], "notEvaluated": []}


# ── 1. dose limit ────────────────────────────────────────────────────────────────────────────────────────────

def test_dose_limit_fires_above_typical_max():
    fired, points, explanation = dose_limit_check(clean_features(dose_value=1500.0), DOSAGE_REFERENCE, AMOXICILLIN)
    assert (fired, points, explanation) == (True, DOSE_LIMIT_POINTS, "Dose exceeds the typical maximum for this medication.")


def test_dose_exactly_at_typical_max_does_not_fire():
    assert dose_limit_check(clean_features(dose_value=500.0), DOSAGE_REFERENCE, AMOXICILLIN).fired is False


def test_dose_in_grams_is_checked_after_conversion_to_mg():
    payload = {
        "drugName": "Amoxicillin", "drugClass": "antibiotic", "doseValue": "1.500", "doseUnit": "g",
        "frequency": "TDS", "durationDays": 7, "route": "oral", "patientAge": 40, "patientWeight": 70.0,
    }
    features = extract_features(payload, CorpusStats())
    context = RuleContext.from_payload(payload)
    assert dose_limit_check(features, DOSAGE_REFERENCE, context).fired is True
    at_limit = extract_features({**payload, "doseValue": "0.500"}, CorpusStats())  # 0.5 g = the 500 mg maximum
    assert dose_limit_check(at_limit, DOSAGE_REFERENCE, context).fired is False


def test_dose_in_a_non_mass_unit_is_not_evaluated():
    context = RuleContext(drug_name="Amoxicillin", dose_unit="ml")
    assert dose_limit_check(clean_features(dose_value=5000.0), DOSAGE_REFERENCE, context).fired is False
    result = run_rule_engine(clean_features(dose_value=5000.0), DOSAGE_REFERENCE, context)
    assert result["firedRules"] == []
    assert result["notEvaluated"] == [{"rule": "dose_limit", "reason": "dose unit 'ml' cannot be compared with a mg limit"}]


# ── 2. frequency / duration ranges ───────────────────────────────────────────────────────────────────────────

def test_frequency_above_max_fires_with_a_frequency_specific_explanation():
    result = frequency_range_check(clean_features(frequency=4.0), DOSAGE_REFERENCE, AMOXICILLIN)
    assert result == (True, FREQUENCY_RANGE_POINTS, EXPLANATIONS["frequency_above"])
    assert "frequency" in result.explanation.lower()


def test_frequency_well_below_typical_fires():
    # lowest typical 2/day × 0.5 = 1/day threshold; every 48 h (0.5/day) is below it, once daily (1/day) is not
    assert frequency_range_check(clean_features(frequency=0.5), DOSAGE_REFERENCE, AMOXICILLIN) == (True, FREQUENCY_RANGE_POINTS, EXPLANATIONS["frequency_below"])
    assert frequency_range_check(clean_features(frequency=1.0), DOSAGE_REFERENCE, AMOXICILLIN).fired is False
    assert frequency_range_check(clean_features(frequency=3.0), DOSAGE_REFERENCE, AMOXICILLIN).fired is False


def test_duration_well_beyond_typical_fires_with_a_duration_specific_explanation():
    # longest typical 14 days × 1.5 = 21 days
    result = duration_range_check(clean_features(duration_days=22.0), DOSAGE_REFERENCE, AMOXICILLIN)
    assert result == (True, DURATION_RANGE_POINTS, EXPLANATIONS["duration_above"])
    assert "duration" in result.explanation.lower()
    assert duration_range_check(clean_features(duration_days=21.0), DOSAGE_REFERENCE, AMOXICILLIN).fired is False


def test_duration_well_below_typical_fires():
    # shortest typical 5 days × 0.5 = 2.5 days
    assert duration_range_check(clean_features(duration_days=2.0), DOSAGE_REFERENCE, AMOXICILLIN) == (True, DURATION_RANGE_POINTS, EXPLANATIONS["duration_below"])
    assert duration_range_check(clean_features(duration_days=3.0), DOSAGE_REFERENCE, AMOXICILLIN).fired is False


def test_combined_range_check_keeps_frequency_and_duration_messages_distinct():
    only_frequency = frequency_duration_range_check(clean_features(frequency=4.0), DOSAGE_REFERENCE, AMOXICILLIN)
    only_duration = frequency_duration_range_check(clean_features(duration_days=30.0), DOSAGE_REFERENCE, AMOXICILLIN)
    both = frequency_duration_range_check(clean_features(frequency=4.0, duration_days=30.0), DOSAGE_REFERENCE, AMOXICILLIN)
    assert only_frequency == (True, FREQUENCY_RANGE_POINTS, EXPLANATIONS["frequency_above"])
    assert only_duration == (True, DURATION_RANGE_POINTS, EXPLANATIONS["duration_above"])
    assert only_frequency.explanation != only_duration.explanation
    assert both == (True, FREQUENCY_RANGE_POINTS + DURATION_RANGE_POINTS, f"{EXPLANATIONS['frequency_above']} {EXPLANATIONS['duration_above']}")


def test_unparseable_frequency_is_reported_as_not_evaluated():
    result = run_rule_engine(clean_features(frequency=None, dose_frequency_product=None), DOSAGE_REFERENCE, AMOXICILLIN)
    assert result["subScore"] == 0
    assert result["notEvaluated"] == [{"rule": "frequency_range", "reason": "frequency text could not be parsed into doses per day"}]


# ── 3. duplication ───────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("flag", [1, True])
def test_drug_duplication_fires_when_flag_is_set(flag):
    assert drug_duplication_check(clean_features(drug_combination_flag=flag)) == (
        True, DRUG_DUPLICATION_POINTS, "Another active prescription or another medicine on this prescription is in the same drug class.",
    )


@pytest.mark.parametrize("flag", [0, False])
def test_drug_duplication_does_not_fire_without_flag(flag):
    assert drug_duplication_check(clean_features(drug_combination_flag=flag)).fired is False


# ── engine aggregation ───────────────────────────────────────────────────────────────────────────────────────

def test_engine_sums_simultaneous_rules_and_lists_only_fired_ones_highest_first():
    result = run_rule_engine(clean_features(dose_value=1500.0, drug_combination_flag=1), DOSAGE_REFERENCE, AMOXICILLIN)
    assert result["subScore"] == DOSE_LIMIT_POINTS + DRUG_DUPLICATION_POINTS == 70
    assert result["firedRules"] == [
        {"rule": "dose_limit", "feature": "dose_value", "points": 45, "explanation": EXPLANATIONS["dose_limit"]},
        {"rule": "drug_duplication", "feature": "drug_combination_flag", "points": 25, "explanation": EXPLANATIONS["drug_duplication"]},
    ]
    assert result["notEvaluated"] == []


def test_dose_plus_frequency_reaches_high_band():
    result = run_rule_engine(clean_features(dose_value=1500.0, frequency=4.0), DOSAGE_REFERENCE, AMOXICILLIN)
    assert result["subScore"] == 80
    assert [fired["rule"] for fired in result["firedRules"]] == ["dose_limit", "frequency_range"]


def test_engine_caps_at_100_when_all_rules_fire():
    features = clean_features(dose_value=5000.0, frequency=96.0, duration_days=365.0, drug_combination_flag=1)
    result = run_rule_engine(features, DOSAGE_REFERENCE, AMOXICILLIN)
    assert DOSE_LIMIT_POINTS + FREQUENCY_RANGE_POINTS + DURATION_RANGE_POINTS + DRUG_DUPLICATION_POINTS == 125
    assert result["subScore"] == 100
    assert [fired["rule"] for fired in result["firedRules"]] == ["dose_limit", "frequency_range", "drug_duplication", "duration_range"]


def test_point_values_follow_the_documented_band_reasoning():
    assert 31 <= DOSE_LIMIT_POINTS <= 70 and 31 <= FREQUENCY_RANGE_POINTS <= 70  # same-prescription violation alone → review
    assert DURATION_RANGE_POINTS <= 30 and DRUG_DUPLICATION_POINTS <= 30  # alone → low
    assert DOSE_LIMIT_POINTS + FREQUENCY_RANGE_POINTS > 70  # two same-prescription violations → high
    assert DOSE_LIMIT_POINTS > DRUG_DUPLICATION_POINTS


def test_unknown_drug_only_runs_the_duplication_rule_and_says_so():
    context = RuleContext(drug_name="Unobtainium", dose_unit="mg")
    result = run_rule_engine(clean_features(dose_value=99999.0, drug_combination_flag=1), DOSAGE_REFERENCE, context)
    assert result["subScore"] == DRUG_DUPLICATION_POINTS
    assert [item["rule"] for item in result["notEvaluated"]] == ["dose_limit", "frequency_range", "duration_range"]
    assert all("not in the dosage reference" in item["reason"] for item in result["notEvaluated"])


def test_liquid_reference_is_compared_in_ml_and_never_against_a_mg_dose():
    ml = RuleContext(drug_name="Diphenhydramine", dose_unit="ml")  # reference: 10–20 ml, 3–4/day, 3–7 days
    assert dose_limit_check(clean_features(dose_value=20.0), DOSAGE_REFERENCE, ml).fired is False
    assert dose_limit_check(clean_features(dose_value=25.0), DOSAGE_REFERENCE, ml) == (True, DOSE_LIMIT_POINTS, EXPLANATIONS["dose_limit"])
    # A mg dose is NOT compared with the ml limit (25 mg is not "25 ml") — reported as not evaluated instead.
    mg = RuleContext(drug_name="Diphenhydramine", dose_unit="mg")
    result = run_rule_engine(clean_features(dose_value=25.0), DOSAGE_REFERENCE, mg)
    assert result["firedRules"] == []
    assert result["notEvaluated"] == [{"rule": "dose_limit", "reason": "dose unit 'mg' cannot be compared with a ml limit"}]


def test_zytee_is_not_in_the_reference_so_dose_frequency_and_duration_rules_are_skipped_not_guessed():
    context = RuleContext(drug_name="Zytee", dose_unit="g")
    result = run_rule_engine(clean_features(dose_value=1000.0), DOSAGE_REFERENCE, context)
    assert result["subScore"] == 0 and result["firedRules"] == []
    assert result["notEvaluated"] == [{"rule": rule, "reason": "'Zytee' is not in the dosage reference"} for rule in ("dose_limit", "frequency_range", "duration_range")]


def test_drug_name_lookup_is_case_and_whitespace_insensitive():
    context = RuleContext(drug_name="  AMOXICILLIN ", dose_unit="MG")
    assert dose_limit_check(clean_features(dose_value=1500.0), DOSAGE_REFERENCE, context).fired is True


def test_engine_is_deterministic_and_does_not_mutate_input():
    features = clean_features(dose_value=1500.0, duration_days=2.0)
    snapshot = dict(features)
    assert run_rule_engine(features, DOSAGE_REFERENCE, AMOXICILLIN) == run_rule_engine(features, DOSAGE_REFERENCE, AMOXICILLIN)
    assert features == snapshot


def test_missing_required_features_raise():
    features = clean_features()
    del features["drug_combination_flag"]
    with pytest.raises(RuleInputError):
        run_rule_engine(features, DOSAGE_REFERENCE, AMOXICILLIN)
    with pytest.raises(RuleInputError):
        drug_duplication_check(features)
