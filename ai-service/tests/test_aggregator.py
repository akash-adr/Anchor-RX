import math

import pytest

from inference.aggregator import aggregate_risk, risk_band


@pytest.mark.parametrize(
    ("ml", "rule", "expected"),
    [
        (0, 0, 0),
        (100, 0, 60),  # ML alone tops out at 60
        (0, 45, 45),  # rule floor is not diluted by a normal ML score
        (20, 45, 45),
        (80, 45, 66),  # ML escalates above the floor: 0.6·80 + 0.4·45
        (50, 50, 50),
        (30, 25, 28),
        (100, 100, 100),
        (64.19, 0, 39),
        (17.22, 45, 45),
    ],
)
def test_documented_formula(ml, rule, expected):
    assert aggregate_risk(ml, rule) == expected


def test_rule_subscore_is_a_floor_and_ml_escalates_only_when_higher():
    for rule in range(0, 101, 5):
        for ml in range(0, 101, 5):
            score = aggregate_risk(ml, rule)
            assert score >= rule
            assert (score > rule) == (ml > rule)


def test_ml_alone_can_never_reach_high():
    for tenth in range(0, 1001):
        score = aggregate_risk(tenth / 10, 0)
        assert score <= 60 and risk_band(score) != "high"


def test_half_up_rounding_keeps_scores_on_band_integers():
    assert aggregate_risk(0, 30.4) == 30
    assert aggregate_risk(0, 30.5) == 31
    assert risk_band(aggregate_risk(0, 30.5)) == "review"


@pytest.mark.parametrize(("score", "band"), [(0, "low"), (30, "low"), (31, "review"), (70, "review"), (71, "high"), (100, "high")])
def test_band_boundaries(score, band):
    assert risk_band(score) == band


@pytest.mark.parametrize(("ml", "rule"), [(-1, 0), (0, 101), (math.nan, 0), (None, 0), ("abc", 0), (True, 0), (0, math.inf)])
def test_invalid_subscores_are_rejected(ml, rule):
    with pytest.raises(ValueError):
        aggregate_risk(ml, rule)


@pytest.mark.parametrize("score", [30.0, -1, 101, True, None])
def test_invalid_risk_scores_are_rejected(score):
    with pytest.raises(ValueError):
        risk_band(score)
