import math

import numpy as np
import pytest

from train.calibration import ScoreCalibration, normalize_anomaly_score, normalize_anomaly_scores
from train.train_model import normalize_anomaly_score as exported_from_train_model


@pytest.fixture
def calibration():
    return ScoreCalibration(p50=0.40, p99=0.50, p999=0.60)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(0.30, 0.0), (0.40, 0.0), (0.45, 15.0), (0.50, 30.0), (0.55, 50.0), (0.60, 70.0), (0.65, 90.0), (0.70, 100.0), (1.0, 100.0)],
)
def test_anchor_points_map_to_documented_values(calibration, raw, expected):
    assert normalize_anomaly_score(raw, calibration) == expected


def test_normalization_is_monotonic_and_bounded(calibration):
    scores = normalize_anomaly_scores(np.linspace(0.0, 1.0, 501), calibration)
    assert np.all(np.diff(scores) >= 0)
    assert scores.min() == 0.0 and scores.max() == 100.0


def test_fit_anchors_on_the_normal_score_distribution():
    raw = np.random.default_rng(0).normal(0.45, 0.03, 5000)
    calibration = ScoreCalibration.fit(raw)
    scores = normalize_anomaly_scores(raw, calibration)
    assert abs(np.mean(scores > 30) - 0.01) < 0.003
    assert np.mean(scores > 70) <= 0.002
    assert ScoreCalibration.from_dict(calibration.to_dict()) == calibration


def test_invalid_inputs_are_rejected(calibration):
    with pytest.raises(ValueError):
        normalize_anomaly_score(math.nan, calibration)
    with pytest.raises(ValueError):
        ScoreCalibration.fit([0.5] * 10)
    with pytest.raises(ValueError):
        ScoreCalibration.from_dict({"method": "min_max"})


def test_train_model_exposes_the_same_function():
    assert exported_from_train_model is normalize_anomaly_score
