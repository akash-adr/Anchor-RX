"""
Saving and loading the trained risk sub-model as ONE unit (Module 8).

    train/isolation_forest_pipeline.pkl   joblib — sklearn Pipeline[ColumnTransformer → IsolationForest], fitted together
    train/corpus_stats.json               population statistics used by extract_features (loaded, never re-derived)
    train/model_metadata.json             calibration anchors, feature names, library versions, corpus provenance

The pickle holds only scikit-learn objects (no Anchor Rx classes), so refactoring our own code can't break loading.
Pickles are tied to the scikit-learn version that wrote them: a mismatch warns loudly — retrain instead of
trusting it. Only load artifacts this project produced (joblib/pickle can execute code).
"""

from __future__ import annotations

import json
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import joblib
import sklearn
from sklearn.pipeline import Pipeline

from features.baselines import FeatureBaselines
from features.encoding import features_to_frame
from features.extract import CorpusStats
from train.calibration import ScoreCalibration, normalize_anomaly_score, raw_anomaly_scores

DEFAULT_ARTIFACT_DIR = Path(__file__).resolve().parent
PIPELINE_FILENAME = "isolation_forest_pipeline.pkl"
CORPUS_STATS_FILENAME = "corpus_stats.json"
METADATA_FILENAME = "model_metadata.json"
PIPELINE_STEPS = ("preprocess", "isolation_forest")
RETRAIN_HINT = "run from ai-service/:  .venv/bin/python -m train.train_model"


class ArtifactsNotFoundError(FileNotFoundError):
    pass


@dataclass(frozen=True)
class ModelArtifacts:
    pipeline: Pipeline
    corpus_stats: CorpusStats
    calibration: ScoreCalibration
    feature_baselines: FeatureBaselines  # typical values for explanation (inference/explain.py)
    metadata: Mapping[str, Any]


@dataclass(frozen=True)
class AnomalySubScore:
    raw_score: float  # −score_samples, higher = more anomalous
    normalized_score: float  # 0–100, see train/calibration.py


def save_artifacts(artifacts: ModelArtifacts, directory: str | Path = DEFAULT_ARTIFACT_DIR) -> dict[str, Path]:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    paths = {
        "pipeline": directory / PIPELINE_FILENAME,
        "corpus_stats": directory / CORPUS_STATS_FILENAME,
        "metadata": directory / METADATA_FILENAME,
    }
    joblib.dump(artifacts.pipeline, paths["pipeline"], compress=3)
    artifacts.corpus_stats.save_json(paths["corpus_stats"])
    metadata = {
        **artifacts.metadata,
        "calibration": artifacts.calibration.to_dict(),
        "feature_baselines": artifacts.feature_baselines.to_dict(),
    }
    paths["metadata"].write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return paths


def load_artifacts(directory: str | Path = DEFAULT_ARTIFACT_DIR) -> ModelArtifacts:
    directory = Path(directory)
    missing = [name for name in (PIPELINE_FILENAME, CORPUS_STATS_FILENAME, METADATA_FILENAME) if not (directory / name).exists()]
    if missing:
        raise ArtifactsNotFoundError(f"missing model artifacts in {directory}: {missing} — {RETRAIN_HINT}")

    metadata = json.loads((directory / METADATA_FILENAME).read_text(encoding="utf-8"))
    trained_with = metadata.get("versions", {}).get("scikit_learn")
    if trained_with != sklearn.__version__:
        warnings.warn(
            f"model was trained with scikit-learn {trained_with}, running {sklearn.__version__} — {RETRAIN_HINT}",
            RuntimeWarning,
            stacklevel=2,
        )
    pipeline = joblib.load(directory / PIPELINE_FILENAME)
    if not isinstance(pipeline, Pipeline) or tuple(pipeline.named_steps) != PIPELINE_STEPS:
        raise ValueError(f"unexpected pipeline structure in {directory / PIPELINE_FILENAME}")

    if "feature_baselines" not in metadata:
        raise ArtifactsNotFoundError(f"{directory / METADATA_FILENAME} predates feature baselines — {RETRAIN_HINT}")

    return ModelArtifacts(
        pipeline=pipeline,
        corpus_stats=CorpusStats.load_json(directory / CORPUS_STATS_FILENAME),
        calibration=ScoreCalibration.from_dict(metadata["calibration"]),
        feature_baselines=FeatureBaselines.from_dict(metadata["feature_baselines"]),
        metadata=metadata,
    )


def score_features(artifacts: ModelArtifacts, features: Mapping[str, Any]) -> AnomalySubScore:
    """Score ONE extract_features() dict through the saved pipeline (encoding + forest) and normalize it."""
    raw = float(raw_anomaly_scores(artifacts.pipeline, features_to_frame([features]))[0])
    return AnomalySubScore(raw_score=round(raw, 6), normalized_score=normalize_anomaly_score(raw, artifacts.calibration))
