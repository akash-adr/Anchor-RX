"""
Module 8, Step 2 — train the Isolation Forest risk sub-model on the synthetic normal corpus.

    corpus (ScoringPayload dicts, data/generate_normal_corpus.py)
      ├─► CorpusStats.from_payloads ─────────────────────────────► train/corpus_stats.json
      └─► extract_features(payload, stats) ─► features_to_frame
            └─► Pipeline[ ColumnTransformer (features/encoding.py) → IsolationForest ]   fit ONCE, saved as ONE object
                  └─► raw anomaly scores on the corpus ─► ScoreCalibration ─► train/model_metadata.json

Fitting and serializing the encoder together with the forest is what guarantees train/serve encoding consistency.
Only the corpus generator should change when the dataset gets more realistic; this file stays the same.

Run from ai-service/:
    .venv/bin/python -m train.train_model                      # reuse data/generated/normal_corpus.jsonl (generate if absent)
    .venv/bin/python -m train.train_model --regenerate --size 5000 --seed 7
"""

from __future__ import annotations

import sys

import argparse
import json
import platform
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.pipeline import Pipeline

if __package__ in (None, ""):  # run as a file (python3 <dir>/<script>.py): make ai-service/ importable, like `python -m`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data.generate_normal_corpus import (
    DEFAULT_CORPUS_PATH,
    DEFAULT_CORPUS_SIZE,
    DEFAULT_SEED,
    corpus_metadata_path,
    corpus_sha256,
    generate_normal_corpus,
    read_corpus_jsonl,
    summarize_corpus,
    write_corpus_jsonl,
)
from features.baselines import FeatureBaselines
from features.encoding import build_preprocessor, features_to_frame
from features.extract import FEATURE_NAMES, CorpusStats, extract_features
from train.artifacts import DEFAULT_ARTIFACT_DIR, PIPELINE_STEPS, ModelArtifacts, save_artifacts
from train.calibration import ScoreCalibration, normalize_anomaly_score, normalize_anomaly_scores, raw_anomaly_scores

__all__ = ["ISOLATION_FOREST_PARAMS", "build_pipeline", "build_feature_frame", "train", "normalize_anomaly_score", "main"]

MODEL_VERSION = "isolation-forest-placeholder-v1"
AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
MIN_TRAINING_ROWS = 500

ISOLATION_FOREST_PARAMS: dict[str, Any] = {
    "n_estimators": 300,  # more trees → more stable path-length averages; inference stays in the low ms
    "max_samples": "auto",  # min(256, n) per tree, as recommended in the original paper
    "max_features": 1.0,
    "bootstrap": False,
    "contamination": "auto",  # only affects predict(); we use score_samples + our own calibration
    "random_state": 42,  # reproducible forest
    "n_jobs": 1,  # single-prescription inference is faster without process/thread fan-out
}


def build_pipeline(params: Mapping[str, Any] | None = None) -> Pipeline:
    forest = IsolationForest(**{**ISOLATION_FOREST_PARAMS, **(params or {})})
    return Pipeline([(PIPELINE_STEPS[0], build_preprocessor()), (PIPELINE_STEPS[1], forest)])


def build_feature_frame(payloads: Iterable[Mapping[str, Any]], corpus_stats: CorpusStats) -> pd.DataFrame:
    return features_to_frame(extract_features(payload, corpus_stats) for payload in payloads)


def _quantiles(values: np.ndarray) -> dict[str, float]:
    points = {"min": 0.0, "p50": 0.5, "p90": 0.9, "p99": 0.99, "p99.9": 0.999, "max": 1.0}
    return {name: round(float(np.quantile(values, q)), 6) for name, q in points.items()}


def train(
    payloads: Iterable[Mapping[str, Any]],
    *,
    corpus_info: Mapping[str, Any] | None = None,
    params: Mapping[str, Any] | None = None,
) -> ModelArtifacts:
    payloads = list(payloads)
    if len(payloads) < MIN_TRAINING_ROWS:
        raise ValueError(f"need at least {MIN_TRAINING_ROWS} corpus rows, got {len(payloads)}")

    started = time.perf_counter()
    corpus_stats = CorpusStats.from_payloads(payloads)
    frame = build_feature_frame(payloads, corpus_stats)
    pipeline = build_pipeline(params).fit(frame)

    raw = raw_anomaly_scores(pipeline, frame)
    calibration = ScoreCalibration.fit(raw)
    normalized = normalize_anomaly_scores(raw, calibration)
    feature_baselines = FeatureBaselines.build(frame)

    metadata = {
        "model_version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "training_seconds": round(time.perf_counter() - started, 3),
        "versions": {
            "python": platform.python_version(),
            "scikit_learn": sklearn.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
        "corpus": {**(corpus_info or {}), "rows": len(payloads), "sha256": corpus_sha256(payloads)},
        "feature_names": list(FEATURE_NAMES),
        "encoded_feature_names": [str(name) for name in pipeline.named_steps[PIPELINE_STEPS[0]].get_feature_names_out()],
        "isolation_forest_params": {**ISOLATION_FOREST_PARAMS, **(params or {})},
        "training_scores": {
            "raw": _quantiles(raw),
            "normalized": _quantiles(normalized),
            "share_normalized_above_30": round(float(np.mean(normalized > 30)), 4),
            "share_normalized_above_70": round(float(np.mean(normalized > 70)), 4),
        },
        "calibration": calibration.to_dict(),
    }
    return ModelArtifacts(
        pipeline=pipeline,
        corpus_stats=corpus_stats,
        calibration=calibration,
        feature_baselines=feature_baselines,
        metadata=metadata,
    )


def _relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(AI_SERVICE_ROOT))
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train the Anchor Rx Isolation Forest risk sub-model.")
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS_PATH)
    parser.add_argument("--regenerate", action="store_true", help="regenerate the corpus even if it exists")
    parser.add_argument("--size", type=int, default=DEFAULT_CORPUS_SIZE, help="rows, only used when generating")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="only used when generating")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    args = parser.parse_args(argv)

    if args.regenerate or not args.corpus.exists():
        payloads = generate_normal_corpus(args.size, args.seed)
        write_corpus_jsonl(payloads, args.corpus, seed=args.seed)
        print(f"generated corpus: {len(payloads)} rows (seed {args.seed}) → {_relative(args.corpus)}")
    else:
        payloads = read_corpus_jsonl(args.corpus)
        print(f"reusing corpus: {len(payloads)} rows ← {_relative(args.corpus)}")

    sidecar = corpus_metadata_path(args.corpus)
    corpus_info: dict[str, Any] = {"path": _relative(args.corpus)}
    if sidecar.exists():
        side = json.loads(sidecar.read_text(encoding="utf-8"))
        corpus_info.update({key: side.get(key) for key in ("generator", "generator_version", "seed")})

    artifacts = train(payloads, corpus_info=corpus_info)
    paths = save_artifacts(artifacts, args.out_dir)

    scores = artifacts.metadata["training_scores"]
    print("corpus summary:", json.dumps(summarize_corpus(payloads)))
    print(f"trained in {artifacts.metadata['training_seconds']}s — {len(artifacts.metadata['encoded_feature_names'])} encoded columns")
    print("raw anomaly score quantiles (training):", scores["raw"])
    print("normalized sub-score quantiles (training):", scores["normalized"])
    print(f"share of normal training rows above 30: {scores['share_normalized_above_30']:.2%}, above 70: {scores['share_normalized_above_70']:.2%}")
    for name, path in paths.items():
        print(f"saved {name}: {_relative(path)} ({path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
