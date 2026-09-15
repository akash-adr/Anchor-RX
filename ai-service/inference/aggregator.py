"""
Anchor Rx — Module 8 risk aggregator: ML sub-score + rule-engine sub-score → final 0–100 risk_score and band.

    blended    = 0.6 · ml_subscore + 0.4 · rule_subscore          (weighted average; the weights sum to 1)
    risk_score = round_half_up( max(rule_subscore, blended) )

WHY this strategy
- A fired rule is a high-confidence, explainable finding ("dose exceeds the typical maximum"). A plain average would
  let an unremarkable ML score dilute it — a 45-point dose violation with ml = 0 would fall to 18 ("low"). Taking the
  max makes the rule sub-score a FLOOR: the final score is never lower than what the rules alone found.
- The ML anomaly signal can still ESCALATE on top of a rule hit: when the prescription is also statistically unusual,
  the blend can exceed the rule floor and push the score higher (rule 45 + ml 80 → 66).

Properties that follow directly from the formula (stated so nobody is surprised by them):
- ML raises the score only when ml_subscore > rule_subscore, because blended − rule = 0.6 · (ml − rule).
- With no rule hits the final score is at most 60: an ML-only anomaly reaches "review" but never "high". The
  unsupervised model on a synthetic corpus can ask for a second look; it cannot by itself mark something high risk.
- The score means "deserves a second look", not "unsafe". Tamper/ledger checks and the Dispense/Review/Block decision
  are outside this module.

Bands: low 0–30, review 31–70, high 71–100. risk_score is an integer (half-up rounding) so no score falls between bands.
"""

from __future__ import annotations

import math

ML_WEIGHT = 0.6
RULE_WEIGHT = 0.4
LOW_BAND_MAX = 30
REVIEW_BAND_MAX = 70
MAX_RISK_SCORE = 100


def _subscore(name: str, value: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number within 0–100, got {value!r}") from exc
    if isinstance(value, bool) or not math.isfinite(number) or not 0 <= number <= 100:
        raise ValueError(f"{name} must be a number within 0–100, got {value!r}")
    return number


def aggregate_risk(ml_subscore: float, rule_subscore: float) -> int:
    ml = _subscore("ml_subscore", ml_subscore)
    rule = _subscore("rule_subscore", rule_subscore)
    blended = ML_WEIGHT * ml + RULE_WEIGHT * rule
    return min(MAX_RISK_SCORE, math.floor(max(rule, blended) + 0.5))


def risk_band(risk_score: int) -> str:
    if isinstance(risk_score, bool) or not isinstance(risk_score, int) or not 0 <= risk_score <= MAX_RISK_SCORE:
        raise ValueError(f"risk_score must be an integer within 0–100, got {risk_score!r}")
    if risk_score <= LOW_BAND_MAX:
        return "low"
    if risk_score <= REVIEW_BAND_MAX:
        return "review"
    return "high"
