"""
How the Isolation Forest output becomes a 0–100 ML sub-score.

1) RAW SCORE
   IsolationForest.score_samples(x) returns the NEGATED anomaly score from the original paper (Liu, Ting & Zhou,
   2008):  s(x) = 2^(−E[h(x)] / c(n)),  where E[h(x)] is the average number of random splits needed to isolate x
   across the trees and c(n) is the expected path length for n samples. We use raw = −score_samples(x) = s(x),
   which lies in (0, 1]: ordinary points need many splits (s around or below 0.5); points isolated in very few
   splits push s towards 1. Higher raw = more anomalous. decision_function is the same number shifted by a
   contamination-based offset, so it adds no information here.

2) WHY NOT MIN–MAX OR A FIXED SIGMOID
   Min–max against the training corpus places a typical prescription mid-scale (not "low") and lets the single
   most extreme training row define the top; a fixed sigmoid needs a centre and slope that would be arbitrary.
   Neither gives the number a meaning.

3) WHAT WE DO — quantile-anchored, piecewise-linear
   Anchors come from the raw scores of the NORMAL training corpus, so every sub-score reads relative to "normal":
        raw ≤ p50(normal)    →   0   at least as ordinary as the typical training prescription
        raw = p99(normal)    →  30   top of the "low" band: 99% of normal training rows score ≤ 30
        raw = p99.9(normal)  →  70   top of the "review" band: 99.9% of normal training rows score ≤ 70
        raw > p99.9          →  continues at the p99→p99.9 slope, capped at 100
   Consequences we accept and state openly:
   - by construction ≈1% of normal training rows exceed 30 and ≈0.1% exceed 70 on this sub-score alone; the
     final risk band is decided by the aggregator (Step 4), not by this number alone;
   - p99.9 of a ~4,000-row corpus rests on a handful of rows, so the upper anchor is noisy;
   - quantiles are in-sample (the forest scores rows it was trained on), which slightly understates how unusual
     unseen-but-normal prescriptions look.
   No anomalous examples are used — calibration stays unsupervised, and the Step 5 held-out set is never seen here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, ClassVar, Iterable, Mapping

import numpy as np

LOW_BAND_TOP = 30.0
REVIEW_BAND_TOP = 70.0
MAX_SCORE = 100.0
MIN_CALIBRATION_ROWS = 100


@dataclass(frozen=True)
class ScoreCalibration:
    p50: float
    p99: float
    p999: float

    METHOD: ClassVar[str] = "quantile_piecewise_linear_v1"

    @classmethod
    def fit(cls, raw_scores: Iterable[float]) -> "ScoreCalibration":
        scores = np.asarray(list(raw_scores), dtype="float64")
        if scores.size < MIN_CALIBRATION_ROWS:
            raise ValueError(f"need at least {MIN_CALIBRATION_ROWS} training scores, got {scores.size}")
        if not np.isfinite(scores).all():
            raise ValueError("training scores must be finite")
        p50, p99, p999 = (float(q) for q in np.quantile(scores, [0.5, 0.99, 0.999]))
        # Guard a degenerate (near-constant) distribution so the interpolation never divides by zero.
        p99 = max(p99, p50 + 1e-9)
        p999 = max(p999, p99 + 1e-9)
        return cls(p50=p50, p99=p99, p999=p999)

    def to_dict(self) -> dict[str, Any]:
        return {
            "method": self.METHOD,
            "raw_score": "-IsolationForest.score_samples(x); higher = more anomalous",
            "anchors": [
                {"training_quantile": 0.5, "raw": self.p50, "normalized": 0.0},
                {"training_quantile": 0.99, "raw": self.p99, "normalized": LOW_BAND_TOP},
                {"training_quantile": 0.999, "raw": self.p999, "normalized": REVIEW_BAND_TOP},
            ],
            "beyond_last_anchor": "same slope as p99→p99.9, capped at 100",
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ScoreCalibration":
        if data.get("method") != cls.METHOD:
            raise ValueError(f"Unsupported calibration method {data.get('method')!r}")
        raw = {anchor["training_quantile"]: float(anchor["raw"]) for anchor in data["anchors"]}
        return cls(p50=raw[0.5], p99=raw[0.99], p999=raw[0.999])


def raw_anomaly_scores(pipeline: Any, frame: Any) -> np.ndarray:
    """raw = −score_samples: the paper's anomaly score s(x) in (0, 1]; higher = more anomalous."""
    return -np.asarray(pipeline.score_samples(frame), dtype="float64")


def normalize_anomaly_score(raw_score: float, calibration: ScoreCalibration, *, capped: bool = True) -> float:
    """
    Map one raw anomaly score to 0–100 using the quantile anchors documented at the top of this module.
    capped=False keeps extending the last slope past 100 — used ONLY to measure explanation contributions for
    prescriptions already beyond the cap (inference/explain.py); risk scores always use the capped value.
    """
    raw = float(raw_score)
    if not math.isfinite(raw):
        raise ValueError(f"raw anomaly score must be finite, got {raw_score!r}")
    c = calibration
    if raw <= c.p50:
        score = 0.0
    elif raw <= c.p99:
        score = LOW_BAND_TOP * (raw - c.p50) / (c.p99 - c.p50)
    else:  # between p99 and p99.9, and — at the same slope — beyond it
        score = LOW_BAND_TOP + (REVIEW_BAND_TOP - LOW_BAND_TOP) * (raw - c.p99) / (c.p999 - c.p99)
    return round(min(MAX_SCORE, score) if capped else score, 2)


def normalize_anomaly_scores(raw_scores: Iterable[float], calibration: ScoreCalibration) -> np.ndarray:
    return np.array([normalize_anomaly_score(s, calibration) for s in np.asarray(list(raw_scores), dtype="float64")])
