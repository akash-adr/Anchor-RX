"""
Concrete train/eval disjointness proof for the Anchor Rx risk engine (Module 8, Step 5).

A sample's fingerprint is the SHA-256 of its model-visible content: every extract_features() value (FEATURE_NAMES) (floats rounded
to 6 dp), computed with the TRAINING corpus statistics. IDs, timestamps and free-text wording are not part of it, so
two prescriptions the model would see identically ("BD" vs "twice daily") get the same fingerprint — a stricter test
than hashing the raw JSON. Train and eval are disjoint when their fingerprint sets do not intersect.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable, Mapping

from features.extract import CorpusStats, extract_features


def feature_fingerprint(payload: Mapping[str, Any], corpus_stats: CorpusStats) -> str:
    features = extract_features(payload, corpus_stats)
    canonical = {key: round(value, 6) if isinstance(value, float) else value for key, value in features.items()}
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode("utf-8")).hexdigest()


def fingerprints(payloads: Iterable[Mapping[str, Any]], corpus_stats: CorpusStats) -> set[str]:
    return {feature_fingerprint(payload, corpus_stats) for payload in payloads}
