"""
Anchor Rx — Module 8 held-out evaluation.

Runs every held-out case through score_prescription (the real serving function, saved model and all) and reports
Precision, Recall, F1, false-negative rate and false-positive rate.

    ground truth positive  = a deliberately anomalous case (evaluation/generate_anomalous_set.py)
    ground truth negative  = a held-out NORMAL case (data/generate_normal_corpus.py with a seed never used in training,
                             minus any case whose feature fingerprint matches a training row)
    predicted positive     = risk_band "review" or "high"          ← fixed BEFORE running; never tuned on these results

Also reported, without changing the headline: each component alone (rule sub-score > 30; ML sub-score > 30),
recall per anomaly category, latency, the disjointness proof and examples of misses.

Run from ai-service/:   .venv/bin/python -m evaluation.evaluate
Writes evaluation/report.md (human) and evaluation/report.json (machine).
"""

from __future__ import annotations

import sys

import argparse
import json
import statistics
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # run as a file (python3 <dir>/<script>.py): make ai-service/ importable, like `python -m`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data.generate_normal_corpus import DEFAULT_CORPUS_PATH, corpus_sha256, generate_normal_corpus, read_corpus_jsonl
from evaluation.disjointness import feature_fingerprint
from evaluation.generate_anomalous_set import ANOMALOUS_SEED, CATEGORIES, DEFAULT_CASES_PER_CATEGORY, EvalCase, generate_anomalous_set
from inference.score import get_artifacts, score_prescription
from train.artifacts import ModelArtifacts

EVALUATION_DIR = Path(__file__).resolve().parent
REPORT_MD = EVALUATION_DIR / "report.md"
REPORT_JSON = EVALUATION_DIR / "report.json"

NORMAL_HOLDOUT_SEED = 55501234
DEFAULT_NORMAL_HOLDOUT_SIZE = 1000
POSITIVE_BANDS = frozenset({"review", "high"})
COMPONENT_POSITIVE_ABOVE = 30  # a component's own sub-score above the low band


class DisjointnessError(AssertionError):
    pass


@dataclass(frozen=True)
class ScoredCase:
    case: EvalCase
    result: dict[str, Any]
    elapsed_ms: float


def generate_normal_holdout(size: int = DEFAULT_NORMAL_HOLDOUT_SIZE, seed: int = NORMAL_HOLDOUT_SEED) -> list[EvalCase]:
    cases = []
    for i, payload in enumerate(generate_normal_corpus(size, seed)):
        payload = {**payload, "prescriptionId": f"RX-HOLDOUT-{i + 1:05d}", "patientId": f"PAT-HOLDOUT-{i + 1:05d}"}
        cases.append(EvalCase(case_id=payload["prescriptionId"], category="normal_holdout", is_anomalous=False, anomalies=(), payload=payload))
    return cases


def build_eval_set(
    artifacts: ModelArtifacts,
    *,
    anomalous_per_category: int = DEFAULT_CASES_PER_CATEGORY,
    normal_size: int = DEFAULT_NORMAL_HOLDOUT_SIZE,
    training_path: Path = DEFAULT_CORPUS_PATH,
) -> tuple[list[EvalCase], dict[str, Any]]:
    """Held-out cases + a disjointness record. Raises DisjointnessError on any train/eval overlap."""
    training = read_corpus_jsonl(training_path)
    if corpus_sha256(training) != artifacts.metadata["corpus"]["sha256"]:
        raise DisjointnessError(f"{training_path} is not the corpus the saved model was trained on (sha256 mismatch)")
    training_seed = artifacts.metadata["corpus"].get("seed")
    if len({training_seed, ANOMALOUS_SEED, NORMAL_HOLDOUT_SEED}) != 3:
        raise DisjointnessError(f"seeds must differ: training={training_seed} anomalous={ANOMALOUS_SEED} normal={NORMAL_HOLDOUT_SEED}")

    stats = artifacts.corpus_stats
    training_fingerprints = {feature_fingerprint(payload, stats) for payload in training}

    anomalous = generate_anomalous_set(anomalous_per_category)
    leaked = [case.case_id for case in anomalous if feature_fingerprint(case.payload, stats) in training_fingerprints]
    if leaked:
        raise DisjointnessError(f"anomalous cases identical to training rows: {leaked[:5]}")

    generated_normals = generate_normal_holdout(normal_size)
    normals = [case for case in generated_normals if feature_fingerprint(case.payload, stats) not in training_fingerprints]

    cases = anomalous + normals
    overlap = sum(feature_fingerprint(case.payload, stats) in training_fingerprints for case in cases)
    if overlap:
        raise DisjointnessError(f"{overlap} held-out cases still overlap the training corpus")

    return cases, {
        "method": "SHA-256 of the 13 model-visible features (IDs/timestamps/wording excluded), training corpus stats",
        "training_corpus_rows": len(training),
        "training_corpus_sha256": artifacts.metadata["corpus"]["sha256"],
        "training_unique_fingerprints": len(training_fingerprints),
        "seeds": {"training": training_seed, "anomalous": ANOMALOUS_SEED, "normal_holdout": NORMAL_HOLDOUT_SEED},
        "normal_holdout_generated": len(generated_normals),
        "normal_holdout_removed_as_training_duplicates": len(generated_normals) - len(normals),
        "anomalous_cases_matching_training": 0,
        "final_overlap_with_training": overlap,
    }


def score_cases(cases: list[EvalCase], artifacts: ModelArtifacts) -> list[ScoredCase]:
    if cases:
        score_prescription(cases[0].payload, artifacts)  # warm-up, not measured
    scored = []
    for case in cases:
        started = time.perf_counter()
        result = score_prescription(case.payload, artifacts)
        scored.append(ScoredCase(case, result, (time.perf_counter() - started) * 1000))
    return scored


def binary_metrics(labels: list[bool], predictions: list[bool]) -> dict[str, Any]:
    tp = sum(1 for y, p in zip(labels, predictions) if y and p)
    fp = sum(1 for y, p in zip(labels, predictions) if not y and p)
    fn = sum(1 for y, p in zip(labels, predictions) if y and not p)
    tn = sum(1 for y, p in zip(labels, predictions) if not y and not p)
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    if precision is None or recall is None:
        f1 = None
    else:
        f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": precision, "recall": recall, "f1": f1,
        "false_negative_rate": fn / (tp + fn) if tp + fn else None,
        "false_positive_rate": fp / (fp + tn) if fp + tn else None,
    }


def _case_summary(item: ScoredCase) -> dict[str, Any]:
    p, r = item.case.payload, item.result
    return {
        "case_id": item.case.case_id, "anomalies": list(item.case.anomalies),
        "drug": p["drugName"], "dose": f"{p['doseValue']} {p['doseUnit']}", "frequency": p["frequency"], "duration_days": p["durationDays"],
        "risk_score": r["risk_score"], "risk_band": r["risk_band"],
        "ml_subscore": r["details"]["ml_subscore"], "rule_subscore": r["details"]["rule_subscore"],
        "reasons": [reason["explanation"] for reason in r["reasons"]],
    }


def compute_report(scored: list[ScoredCase], disjointness: dict[str, Any], artifacts: ModelArtifacts) -> dict[str, Any]:
    labels = [item.case.is_anomalous for item in scored]
    pipeline = [item.result["risk_band"] in POSITIVE_BANDS for item in scored]
    rules_only = [item.result["details"]["rule_subscore"] > COMPONENT_POSITIVE_ABOVE for item in scored]
    ml_only = [item.result["details"]["ml_subscore"] > COMPONENT_POSITIVE_ABOVE for item in scored]

    by_category = {}
    for category in CATEGORIES + ("normal_holdout",):
        group = [(item, flag) for item, flag in zip(scored, pipeline) if item.case.category == category]
        if not group:
            continue
        items = [item for item, _ in group]
        by_category[category] = {
            "cases": len(group),
            "flagged": sum(flag for _, flag in group),
            "flagged_rate": sum(flag for _, flag in group) / len(group),
            "bands": {band: Counter(i.result["risk_band"] for i in items).get(band, 0) for band in ("low", "review", "high")},
            "median_risk_score": round(statistics.median(i.result["risk_score"] for i in items), 2),
            "median_ml_subscore": round(statistics.median(i.result["details"]["ml_subscore"] for i in items), 2),
            "median_rule_subscore": round(statistics.median(i.result["details"]["rule_subscore"] for i in items), 2),
        }

    timings = sorted(item.elapsed_ms for item in scored)
    false_negatives = [item for item, flag in zip(scored, pipeline) if item.case.is_anomalous and not flag]
    false_positives = [item for item, flag in zip(scored, pipeline) if not item.case.is_anomalous and flag]
    fn_examples = []
    for category in CATEGORIES:
        fn_examples += [_case_summary(item) for item in false_negatives if item.case.category == category][:2]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_version": artifacts.metadata.get("model_version"),
        "positive_prediction": "risk_band in {review, high} (risk_score >= 31) — fixed before evaluation",
        "set_sizes": {"anomalous": sum(labels), "normal_holdout": len(labels) - sum(labels)},
        "pipeline": binary_metrics(labels, pipeline),
        "components": {
            "rules_only (rule_subscore > 30)": binary_metrics(labels, rules_only),
            "ml_only (ml_subscore > 30)": binary_metrics(labels, ml_only),
        },
        "by_category": by_category,
        "latency_ms": {
            "cases": len(timings),
            "median": round(statistics.median(timings), 2),
            "p95": round(timings[int(0.95 * (len(timings) - 1))], 2),
            "max": round(timings[-1], 2),
        },
        "disjointness": disjointness,
        "false_negative_examples": fn_examples,
        "false_positive_examples": [_case_summary(item) for item in false_positives[:5]],
    }


def pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def render_markdown(report: dict[str, Any]) -> str:
    m = report["pipeline"]
    lines = [
        "# Anchor Rx — AI risk engine: held-out evaluation",
        "",
        f"Generated by `evaluation/evaluate.py` at {report['generated_at']} · model `{report['model_version']}` · "
        f"{report['set_sizes']['anomalous']} anomalous + {report['set_sizes']['normal_holdout']} held-out normal cases.",
        "",
        f"**Positive prediction:** {report['positive_prediction']}. **Ground-truth positive:** a deliberately anomalous synthetic case.",
        "",
        "## Headline — full pipeline (`score_prescription`)",
        "",
        "| Precision | Recall | F1 | False-negative rate | False-positive rate |",
        "|---|---|---|---|---|",
        f"| {pct(m['precision'])} | {pct(m['recall'])} | {pct(m['f1'])} | {pct(m['false_negative_rate'])} | {pct(m['false_positive_rate'])} |",
        "",
        f"Confusion matrix: TP {m['tp']} · FN {m['fn']} · FP {m['fp']} · TN {m['tn']}",
        "",
        "## By category",
        "",
        "| Category | Cases | Flagged (review/high) | low / review / high | Median risk | Median ML | Median rules |",
        "|---|---|---|---|---|---|---|",
    ]
    for category, row in report["by_category"].items():
        label = "false-positive rate" if category == "normal_holdout" else "recall"
        bands = row["bands"]
        lines.append(
            f"| `{category}` | {row['cases']} | {row['flagged']} ({pct(row['flagged_rate'])} {label}) | "
            f"{bands['low']} / {bands['review']} / {bands['high']} | {row['median_risk_score']} | {row['median_ml_subscore']} | {row['median_rule_subscore']} |"
        )
    lines += [
        "",
        "## Each component alone (same cases; does not change the headline)",
        "",
        "| View | Precision | Recall | F1 | FNR | FPR |",
        "|---|---|---|---|---|---|",
        f"| Full pipeline | {pct(m['precision'])} | {pct(m['recall'])} | {pct(m['f1'])} | {pct(m['false_negative_rate'])} | {pct(m['false_positive_rate'])} |",
    ]
    for name, c in report["components"].items():
        lines.append(f"| {name} | {pct(c['precision'])} | {pct(c['recall'])} | {pct(c['f1'])} | {pct(c['false_negative_rate'])} | {pct(c['false_positive_rate'])} |")
    lat, d = report["latency_ms"], report["disjointness"]
    lines += [
        "",
        f"## Latency\n\n`score_prescription` over {lat['cases']} cases: median {lat['median']} ms · p95 {lat['p95']} ms · max {lat['max']} ms (target < 500 ms).",
        "",
        "## Train / eval disjointness",
        "",
        f"- Method: {d['method']}.",
        f"- Training corpus: {d['training_corpus_rows']} rows, sha256 `{d['training_corpus_sha256'][:16]}…` (verified equal to the saved model's metadata); {d['training_unique_fingerprints']} unique fingerprints.",
        f"- Seeds: training {d['seeds']['training']} · anomalous {d['seeds']['anomalous']} · normal hold-out {d['seeds']['normal_holdout']}.",
        f"- Normal hold-out: {d['normal_holdout_generated']} generated, {d['normal_holdout_removed_as_training_duplicates']} removed as fingerprint duplicates of training rows.",
        f"- Anomalous cases matching a training row: {d['anomalous_cases_matching_training']}. **Final overlap with training: {d['final_overlap_with_training']}.**",
        "",
        "## Caveats (read before quoting these numbers)",
        "",
        "- **Everything is synthetic.** Normal and anomalous cases are generated; no real prescriptions or patients.",
        "- **Partly circular for rule categories.** Dose/frequency/duration anomalies are defined against the same synthetic reference table the rule engine checks, so rule-engine recall on those categories is high largely by construction. It shows the rules work as written, not that they generalise.",
        "- **Optimistic false-positive rate.** Held-out normals come from the same generator family as training (different seed), so they look like the training data; real prescribing is messier.",
        "- **Precision depends on the 50/50 mix.** Real anomaly prevalence is far lower, which would lower precision at the same FPR; FPR and recall are the prevalence-independent numbers.",
        "- **Thresholds were not tuned on this set.** Bands (31/71), rule points, the aggregation formula and ML calibration were all fixed in Steps 2–4.",
        "",
        "## Examples the pipeline missed (false negatives)",
        "",
    ]
    if report["false_negative_examples"]:
        for ex in report["false_negative_examples"]:
            reasons = "; ".join(ex["reasons"]) or "no reasons"
            lines.append(f"- `{ex['case_id']}` {'+'.join(ex['anomalies'])}: {ex['drug']} {ex['dose']}, {ex['frequency']}, {ex['duration_days']} d → {ex['risk_score']} ({ex['risk_band']}; ML {ex['ml_subscore']}, rules {ex['rule_subscore']}) — {reasons}")
    else:
        lines.append("- none")
    lines += ["", "## Examples of false positives", ""]
    if report["false_positive_examples"]:
        for ex in report["false_positive_examples"]:
            reasons = "; ".join(ex["reasons"]) or "no reasons"
            lines.append(f"- `{ex['case_id']}`: {ex['drug']} {ex['dose']}, {ex['frequency']}, {ex['duration_days']} d → {ex['risk_score']} ({ex['risk_band']}; ML {ex['ml_subscore']}, rules {ex['rule_subscore']}) — {reasons}")
    else:
        lines.append("- none")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the Anchor Rx risk engine on a held-out synthetic set.")
    parser.add_argument("--anomalous-per-category", type=int, default=DEFAULT_CASES_PER_CATEGORY)
    parser.add_argument("--normal-size", type=int, default=DEFAULT_NORMAL_HOLDOUT_SIZE)
    args = parser.parse_args(argv)

    artifacts = get_artifacts()
    cases, disjointness = build_eval_set(artifacts, anomalous_per_category=args.anomalous_per_category, normal_size=args.normal_size)
    report = compute_report(score_cases(cases, artifacts), disjointness, artifacts)
    markdown = render_markdown(report)
    REPORT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    REPORT_MD.write_text(markdown, encoding="utf-8")
    print(markdown)
    print(f"wrote {REPORT_MD.relative_to(EVALUATION_DIR.parent)} and {REPORT_JSON.relative_to(EVALUATION_DIR.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
