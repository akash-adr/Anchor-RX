"""
Anchor Rx — Module 8 rule engine.

Hand-written, deterministic checks against data/dosage_reference.py. That table holds simplified, commonly-cited adult
typical ranges for demonstration only, so these rules demonstrate an explainable review layer — they are not
individualized clinical dosing limits. The rule engine does
not use the corpus or the Isolation Forest, and it never decides Dispense/Review/Block.

Each rule function returns RuleResult(fired, points, explanation). run_rule_engine runs every rule and returns:
    {
      "subScore":     0–100 (sum of fired rule points, capped at 100),
      "firedRules":   [{"rule", "feature", "points", "explanation"}]   # ONLY rules that fired, highest points first
      "notEvaluated": [{"rule", "reason"}]                             # rules that could not run on this input
    }
notEvaluated exists so that "no rule fired" is never mistaken for "every check passed".

Inputs: `features` is extract_features() output (13 keys; dose_value already in mg for mass units, frequency in
doses/day). Rules that need the reference table also take a RuleContext (drug_name, dose_unit) from the payload,
because drug_name and dose_unit are not model features.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, NamedTuple

from data.dosage_reference import DrugReference
from features.extract import MASS_UNITS
from features.payload import ScoringPayload

# ── Points (why these numbers) ─────────────────────────────────────────────────────────────────────────────
# Bands used later: low 0–30, review 31–70, high 71–100. Points are chosen so that:
#   - one violation of the SAME prescription's core amount lands in "review" on its own, never "high";
#   - a cross-prescription pattern alone stays "low" (it is often deliberate, e.g. switching statins);
#   - two violations of the same prescription reach "high".
DOSE_LIMIT_POINTS = 45  # Most direct sign that the prescription itself is wrong: the per-dose amount. Alone → review (45).
FREQUENCY_RANGE_POINTS = 35  # Multiplies daily exposure almost as directly as dose; slightly less because divided dosing varies.
#                              Alone → review (35); with dose → 80 (high).
DURATION_RANGE_POINTS = 20  # Changes cumulative exposure / course adequacy, rarely acute harm. Alone → low (20).
DRUG_DUPLICATION_POINTS = 25  # Cross-prescription pattern that is often intentional. Alone → low (25);
#                               with any same-prescription violation → review or high.
MAX_SUB_SCORE = 100

# ── "Well outside the typical range" thresholds ───────────────────────────────────────────────────────────────
# Frequency ABOVE: anything above max_doses_per_day fires (the max already covers the typical spread, and doses/day
# is discrete — one extra dose is already a large relative jump). BELOW: under half the lowest typical frequency.
FREQUENCY_BELOW_FACTOR = 0.5
# Duration: above 1.5× the longest typical course, or below half the shortest.
DURATION_ABOVE_FACTOR = 1.5
DURATION_BELOW_FACTOR = 0.5
FLOAT_TOLERANCE = 1e-9  # g → mg conversion must not make an exactly-at-limit dose "exceed" it

EXPLANATIONS = {
    "dose_limit": "Dose exceeds the typical maximum for this medication.",
    "frequency_above": "Dosing frequency is higher than the typical maximum for this medication.",
    "frequency_below": "Dosing frequency is well below the typical range for this medication.",
    "duration_above": "Treatment duration is well beyond the typical course length for this medication.",
    "duration_below": "Treatment duration is well below the typical course length for this medication.",
    # drug_combination_flag has two sources (Module 15): another active prescription, or another medicine on this one.
    "drug_duplication": "Another active prescription or another medicine on this prescription is in the same drug class.",
}

REQUIRED_FEATURES = ("dose_value", "frequency", "duration_days", "drug_combination_flag")


class RuleInputError(ValueError):
    pass


class RuleResult(NamedTuple):
    fired: bool
    points: int
    explanation: str  # empty when the rule did not fire


NOT_FIRED = RuleResult(False, 0, "")


@dataclass(frozen=True)
class RuleContext:
    """Prescription details the rules need that are not model features."""

    drug_name: str
    dose_unit: str

    @classmethod
    def from_payload(cls, payload: ScoringPayload | Mapping[str, Any]) -> "RuleContext":
        if isinstance(payload, ScoringPayload):
            return cls(drug_name=payload.drugName, dose_unit=payload.doseUnit)
        return cls(drug_name=str(payload["drugName"]), dose_unit=str(payload["doseUnit"]))


class _Evaluation(NamedTuple):
    result: RuleResult
    not_evaluated_reason: str | None = None


def _require(features: Mapping[str, Any]) -> None:
    missing = [key for key in REQUIRED_FEATURES if key not in features]
    if missing:
        raise RuleInputError(f"features missing keys required by the rule engine: {missing}")


def _lookup(dosage_reference: Mapping[str, DrugReference], drug_name: str) -> DrugReference | None:
    return dosage_reference.get(drug_name.strip().lower())


def _not_in_reference(context: RuleContext) -> str:
    return f"'{context.drug_name}' is not in the dosage reference"


# ── Rule evaluations ─────────────────────────────────────────────────────────────────────────────────────────

def _evaluate_dose_limit(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> _Evaluation:
    ref = _lookup(dosage_reference, context.drug_name)
    if ref is None:
        return _Evaluation(NOT_FIRED, _not_in_reference(context))
    # Compare in the REFERENCE's unit: an mg reference accepts any mass unit (features already converted it to mg);
    # any other reference unit (e.g. ml for a liquid) accepts only that same unit. Never assume mg for every drug.
    prescribed_unit = context.dose_unit.strip().lower()
    reference_unit = ref.unit.strip().lower()
    comparable = (reference_unit == "mg" and prescribed_unit in MASS_UNITS) or prescribed_unit == reference_unit
    if not comparable:
        return _Evaluation(NOT_FIRED, f"dose unit '{context.dose_unit}' cannot be compared with a {ref.unit} limit")
    dose = features["dose_value"]
    if dose is None:
        return _Evaluation(NOT_FIRED, "dose value is missing")
    if float(dose) > ref.typical_dose_max + FLOAT_TOLERANCE:
        return _Evaluation(RuleResult(True, DOSE_LIMIT_POINTS, EXPLANATIONS["dose_limit"]))
    return _Evaluation(NOT_FIRED)


def _evaluate_frequency(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> _Evaluation:
    ref = _lookup(dosage_reference, context.drug_name)
    if ref is None:
        return _Evaluation(NOT_FIRED, _not_in_reference(context))
    doses_per_day = features["frequency"]
    if doses_per_day is None:
        return _Evaluation(NOT_FIRED, "frequency text could not be parsed into doses per day")
    doses_per_day = float(doses_per_day)
    if doses_per_day > ref.max_doses_per_day + FLOAT_TOLERANCE:
        return _Evaluation(RuleResult(True, FREQUENCY_RANGE_POINTS, EXPLANATIONS["frequency_above"]))
    if doses_per_day < min(ref.typical_doses_per_day) * FREQUENCY_BELOW_FACTOR - FLOAT_TOLERANCE:
        return _Evaluation(RuleResult(True, FREQUENCY_RANGE_POINTS, EXPLANATIONS["frequency_below"]))
    return _Evaluation(NOT_FIRED)


def _evaluate_duration(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> _Evaluation:
    ref = _lookup(dosage_reference, context.drug_name)
    if ref is None:
        return _Evaluation(NOT_FIRED, _not_in_reference(context))
    duration = features["duration_days"]
    if duration is None:
        return _Evaluation(NOT_FIRED, "duration is missing")
    duration = float(duration)
    if duration > ref.typical_duration_max_days * DURATION_ABOVE_FACTOR + FLOAT_TOLERANCE:
        return _Evaluation(RuleResult(True, DURATION_RANGE_POINTS, EXPLANATIONS["duration_above"]))
    if duration < ref.typical_duration_min_days * DURATION_BELOW_FACTOR - FLOAT_TOLERANCE:
        return _Evaluation(RuleResult(True, DURATION_RANGE_POINTS, EXPLANATIONS["duration_below"]))
    return _Evaluation(NOT_FIRED)


def _evaluate_duplication(features: Mapping[str, Any]) -> _Evaluation:
    if bool(features["drug_combination_flag"]):
        return _Evaluation(RuleResult(True, DRUG_DUPLICATION_POINTS, EXPLANATIONS["drug_duplication"]))
    return _Evaluation(NOT_FIRED)


# ── Public, individually testable rules ─────────────────────────────────────────────────────────────────────

def dose_limit_check(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> RuleResult:
    """Fires if the per-dose amount (mg) exceeds typical_dose_max for this drug."""
    _require(features)
    return _evaluate_dose_limit(features, dosage_reference, context).result


def frequency_range_check(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> RuleResult:
    """Fires if doses/day is above max_doses_per_day or below half the lowest typical frequency."""
    _require(features)
    return _evaluate_frequency(features, dosage_reference, context).result


def duration_range_check(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> RuleResult:
    """Fires if duration_days is above 1.5× the longest or below 0.5× the shortest typical course."""
    _require(features)
    return _evaluate_duration(features, dosage_reference, context).result


def frequency_duration_range_check(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> RuleResult:
    """
    Combined view of the two range rules. Explanations stay specific: a frequency violation and a duration violation
    each contribute their own sentence and points. run_rule_engine reports the two rules separately.
    """
    parts = [r for r in (frequency_range_check(features, dosage_reference, context), duration_range_check(features, dosage_reference, context)) if r.fired]
    if not parts:
        return NOT_FIRED
    return RuleResult(True, sum(r.points for r in parts), " ".join(r.explanation for r in parts))


def drug_duplication_check(features: Mapping[str, Any]) -> RuleResult:
    """Fires on drug_combination_flag: another ACTIVE prescription, or another medicine on this prescription, shares the class."""
    _require(features)
    return _evaluate_duplication(features).result


# ── Engine ──────────────────────────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Rule:
    rule_id: str
    feature: str
    evaluate: Callable[[Mapping[str, Any], Mapping[str, DrugReference], RuleContext], _Evaluation]


RULES: tuple[_Rule, ...] = (
    _Rule("dose_limit", "dose_value", _evaluate_dose_limit),
    _Rule("frequency_range", "frequency", _evaluate_frequency),
    _Rule("duration_range", "duration_days", _evaluate_duration),
    _Rule("drug_duplication", "drug_combination_flag", lambda features, _reference, _context: _evaluate_duplication(features)),
)


def run_rule_engine(features: Mapping[str, Any], dosage_reference: Mapping[str, DrugReference], context: RuleContext) -> dict[str, Any]:
    _require(features)
    fired_rules: list[dict[str, Any]] = []
    not_evaluated: list[dict[str, str]] = []
    for rule in RULES:
        evaluation = rule.evaluate(features, dosage_reference, context)
        if evaluation.not_evaluated_reason:
            not_evaluated.append({"rule": rule.rule_id, "reason": evaluation.not_evaluated_reason})
        if evaluation.result.fired:
            fired_rules.append(
                {"rule": rule.rule_id, "feature": rule.feature, "points": evaluation.result.points, "explanation": evaluation.result.explanation}
            )
    fired_rules.sort(key=lambda fired: -fired["points"])  # stable: ties keep rule order
    return {
        "subScore": min(MAX_SUB_SCORE, sum(fired["points"] for fired in fired_rules)),
        "firedRules": fired_rules,
        "notEvaluated": not_evaluated,
    }
