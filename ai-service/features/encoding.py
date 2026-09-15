"""
THE single encoding step for the risk engine's features.

build_preprocessor() returns one scikit-learn ColumnTransformer. It is fit ONCE during training (Step 2) and
serialized together with the model; inference loads that same fitted object. Never re-implement one-hot
encoding or imputation anywhere else — train/serve encoding drift is exactly the bug this prevents.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import OneHotEncoder

from features.extract import FEATURE_NAMES

CATEGORICAL_FEATURES: tuple[str, ...] = ("route", "drug_class")
NUMERIC_FEATURES: tuple[str, ...] = tuple(name for name in FEATURE_NAMES if name not in CATEGORICAL_FEATURES)


def features_to_frame(rows: Iterable[Mapping[str, Any]]) -> pd.DataFrame:
    """Feature dicts → DataFrame with the canonical column order. Rejects missing/extra keys."""
    records = list(rows)
    for index, row in enumerate(records):
        if set(row) != set(FEATURE_NAMES):
            missing = sorted(set(FEATURE_NAMES) - set(row))
            extra = sorted(set(row) - set(FEATURE_NAMES))
            raise ValueError(f"row {index}: feature keys mismatch (missing={missing}, extra={extra})")
    frame = pd.DataFrame.from_records(records, columns=list(FEATURE_NAMES))
    for column in NUMERIC_FEATURES:
        frame[column] = pd.to_numeric(frame[column], errors="coerce").astype("float64")
    for column in CATEGORICAL_FEATURES:
        frame[column] = frame[column].astype("string").fillna("unknown")
    return frame


def build_preprocessor() -> ColumnTransformer:
    """Unfitted preprocessor: median-impute numerics (e.g. unparseable frequency), one-hot route and drug_class."""
    return ColumnTransformer(
        transformers=[
            ("numeric", SimpleImputer(strategy="median"), list(NUMERIC_FEATURES)),
            (
                "categorical",
                OneHotEncoder(handle_unknown="ignore", sparse_output=False, dtype="float64"),
                list(CATEGORICAL_FEATURES),
            ),
        ],
        remainder="drop",
        verbose_feature_names_out=True,
    )
