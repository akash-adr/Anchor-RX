"""
Typical ("baseline") feature values from the NORMAL training corpus, used to explain ML anomaly scores.

inference/explain.py resets one feature group at a time to these typical values and re-scores the prescription;
the drop in the ML sub-score is that group's contribution. Drug-dependent features use the median for the
prescription's drug_class (a typical statin dose is not a typical antibiotic dose); patient- and provider-level
features use corpus-wide medians; route uses the most common route. Built once at training time and saved in
train/model_metadata.json next to the model — never re-derived at inference.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, ClassVar, Mapping

import pandas as pd

PER_CLASS_NUMERIC = ("dose_value", "frequency", "duration_days", "age")
GLOBAL_NUMERIC = (
    "dose_value", "frequency", "duration_days", "age", "weight",
    "patient_velocity", "drug_rarity_score", "provider_pattern_score",
)


def _median(series: pd.Series) -> float | None:
    value = float(pd.to_numeric(series, errors="coerce").median(skipna=True))
    return None if math.isnan(value) else round(value, 6)


def _mode(series: pd.Series) -> str | None:
    modes = series.dropna().astype(str).mode()
    return None if modes.empty else str(modes.iloc[0])


@dataclass(frozen=True)
class FeatureBaselines:
    global_values: Mapping[str, Any]
    by_drug_class: Mapping[str, Mapping[str, Any]]

    METHOD: ClassVar[str] = "median_v1"

    @classmethod
    def build(cls, frame: pd.DataFrame) -> "FeatureBaselines":
        """frame = features_to_frame(...) of the training corpus (pre-encoding feature columns)."""
        global_values: dict[str, Any] = {name: _median(frame[name]) for name in GLOBAL_NUMERIC}
        global_values["route"] = _mode(frame["route"])
        by_class: dict[str, dict[str, Any]] = {}
        for drug_class, group in frame.groupby("drug_class", sort=True):
            values: dict[str, Any] = {name: _median(group[name]) for name in PER_CLASS_NUMERIC}
            values["route"] = _mode(group["route"])
            by_class[str(drug_class)] = values
        return cls(global_values=global_values, by_drug_class=by_class)

    def for_drug_class(self, drug_class: str) -> dict[str, Any]:
        """Typical values for this class, falling back to corpus-wide values (e.g. a class never seen in training)."""
        return {**self.global_values, **self.by_drug_class.get(drug_class.strip().lower(), {})}

    def to_dict(self) -> dict[str, Any]:
        return {"method": self.METHOD, "global": dict(self.global_values), "by_drug_class": {k: dict(v) for k, v in self.by_drug_class.items()}}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "FeatureBaselines":
        if data.get("method") != cls.METHOD:
            raise ValueError(f"Unsupported feature baseline method {data.get('method')!r}")
        return cls(global_values=dict(data["global"]), by_drug_class={k: dict(v) for k, v in data["by_drug_class"].items()})
