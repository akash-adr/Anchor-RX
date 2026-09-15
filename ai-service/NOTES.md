# Anchor Rx — AI risk engine: notes for judge Q&A

**What it answers:** "does this prescription deserve a second look?" → `{risk_score 0–100, risk_band, reasons ≤ 3}`.
**What it does not do:** detect tampering (Module 2 hashes and the ledger do that), decide Dispense/Review/Block
(Module 9), or prove a prescription is clinically safe. All data and reference ranges are **synthetic**.

## Why Isolation Forest + rules, not one supervised classifier

- **No real labelled risk data exists for us.** A supervised classifier would learn whatever labels we invented,
  then report accuracy on those same invented labels — confidence we can't justify.
- **Isolation Forest is unsupervised.** It only learns what normal prescribing looks like, from a synthetic
  normal corpus, and flags what is hard to fit in. No anomaly labels are used in training.
- **Explicit rules give genuine explainability.** Each rule is hand-written, deterministic and says in plain language
  why it fired ("Dose exceeds the typical maximum for this medication"). An Isolation Forest alone is **not**
  explainable, and we don't claim it is.
- **Together:** rules catch known patterns reliably and explainably; the forest can surface unusual combinations no
  rule describes (e.g. a drug class a prescriber never writes, for an unusual patient).

## Pipeline

`payload (Node) → 13 features → [Isolation Forest → ML sub-score 0–100] + [rule engine → rule sub-score 0–100]
→ aggregator → risk_score + band → reasons`

- **ML sub-score:** −`score_samples` (the Liu et al. anomaly score), mapped through quantiles of the normal training
  scores: median → 0, 99th percentile → 30, 99.9th → 70, capped at 100.
- **Rules (points):** dose above typical max **45** · frequency out of range **35** · same-class duplication **25** ·
  duration out of range **20**. Summed, capped at 100.
- **Bands:** low 0–30 · review 31–70 · high 71–100.

## Aggregation formula (Step 4)

```
risk_score = round_half_up( max( rule_subscore, 0.6 · ml_subscore + 0.4 · rule_subscore ) )
```

- **Rule hits are a floor.** A fired rule is a high-confidence finding and must not be diluted by an unremarkable ML
  score. A plain average would turn a 45-point dose violation with ML 0 into 18 ("low").
- **ML can escalate on top.** If the prescription is also statistically unusual, the blend can exceed the floor
  (rule 45 + ML 80 → 66).
- **Consequences, stated openly:**
  - ML raises the score only when ML > rules.
  - With no rule hit, the maximum is 60, so the ML alone can send a prescription to review but never to high.

## "How do you know which feature the ML reacted to?"

- **Occlusion.** Reset one feature group to its typical value for that drug class (training median) and re-score it
  through the same saved model. The drop in ML score is that group's contribution.
- **Correlated features move together.** Dose, dose/kg and dose × frequency are reset together.
- **When ML reasons appear:** only when the ML sub-score is above 30, for groups worth at least 5 points, and never
  repeating something a rule already said.
- **It is not SHAP.** Interactions aren't attributed, so it's a sensitivity analysis, not an interpretable model.

## Held-out evaluation — real numbers (`evaluation/report.md`)

Retrained on the corrected 17-drug `DRUG_REFERENCE` (`data/dosage_reference.py`; corpus generator `reference-v2`,
seed 20260915). Held-out set: 1,000 deliberately anomalous cases (200 each of: dose 3–5× max, extreme frequency,
extreme duration, forced class duplication, two anomalies combined) plus 997 normal cases never used in training.
**Positive = review or high**, fixed before running; nothing was tuned on these results.

| Precision | Recall | F1 | False-negative rate | False-positive rate |
|---|---|---|---|---|
| **99.5%** | **65.5%** | **79.0%** | **34.5%** | **0.3%** |

TP 655 · FN 345 · FP 3 · TN 994. Latency: median 7.04 ms, p95 14.1 ms, max 15.53 ms over 1,997 cases (target < 500 ms).

Before the corrected reference (previous placeholder table; kept as `evaluation/report.json.backup`): precision 99.7%,
recall 61.8%, F1 76.3%, FNR 38.2%, FPR 0.2% (TP 618 · FN 382 · FP 2 · TN 993).

| Category | Recall |
|---|---|
| Dose 3–5× typical max | 100.0% (199 review, 1 high) |
| Extreme frequency | 100.0% |
| Two anomalies combined | 100.0% (55 of 200 high) |
| Forced class duplication only | 19.5% |
| Extreme duration only | 8.0% |

| View | Precision | Recall | F1 | FPR |
|---|---|---|---|---|
| Full pipeline | 99.5% | 65.5% | 79.0% | 0.3% |
| Rules alone | 100.0% | 60.0% | 75.0% | 0.0% |
| ML alone (sub-score > 30) | 97.0% | 29.3% | 45.0% | 0.9% |

**Train/eval disjointness is proven, not assumed:**
- Every case is fingerprinted by the SHA-256 of its 13 model-visible features.
- The training file's hash matches the saved model's metadata, so it is the data the model was trained on.
- Overlap between training and the held-out set is **0**. Three generated normal hold-out cases matched training rows
  and were removed.
- The three seeds all differ, and a test fails if the anomalous generator imports the training generator.

### What these numbers honestly say

1. **Recall is 65.5% because two whole categories are mostly missed, by design, not by accident.** Duplication-only
   (25 points) and duration-only (20 points) sit in the low band on purpose (Step 3: often intentional, rarely acute).
   The ML lifts only some of them above 30 (19.5% and 8.0%). Revisit that weighting **on a fresh held-out seed**,
   not by tuning against this report.
2. **Rules do most of the work.** The ML adds 55 true positives over rules alone, at the cost of 3 false positives. All
   three are prescriptions at the TOP of their reference range (Metformin 1000 mg twice daily; Escitalopram 20 mg for
   365 days) that the ML finds unusual for their class.
3. **ML alone is weak on this set (29.3% recall).** Its value is unusual combinations the rules don't describe, not
   replacing the rules. An ML-only case reaches review only when its ML sub-score is at least 52 (no rule hits → 0.6 × ML).
4. **A 3–5× overdose reaches review; only 1 of 200 reached high**, where the ML escalated above the 45-point rule floor.
5. **Some of the result is circular.** The dose, frequency and duration anomalies are defined against the same
   reference table the rules check, so 100% recall there shows the rules work as written, not that they generalise.
6. **The false-positive rate is optimistic.** Held-out normals come from the same generator family as training.
7. **Precision is inflated by the 50/50 mix.** Real anomaly prevalence is far lower, so precision would drop at the
   same 0.3% FPR. Recall and FPR are the numbers to quote.
8. **Names and classes must match the table.** The reference uses classes like `antibiotic`/`antidiabetic`; the backend
   seed data uses `penicillin antibiotic`/`biguanide`. A class the model never saw raises the ML sub-score (Amoxicillin
   500 mg TDS: 5.8 → 20.9). A drug outside the table (e.g. **Zytee**, excluded on purpose, or "Benadryl syrup", which the
   table lists as Diphenhydramine) skips the dose/frequency/duration rules (reported as not evaluated) but is **not
   neutral for the ML**: Zytee 1 g TDS scores ML 56.94 → risk 34 (review).

## Reproduce

```bash
cd ai-service
.venv/bin/python -m train.train_model          # corpus (seed 20260915) → pipeline + stats + calibration
.venv/bin/python -m evaluation.evaluate        # held-out evaluation → evaluation/report.md, report.json
.venv/bin/python -m pytest                     # full test suite
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000   # POST /score, GET /health
```

## Live data bridge: what is and isn't live yet (Module 16)

Every scoring input the Node side sends is computed from real prescription data, except two that are deliberately held:

| Feature | Source today |
|---|---|
| `drug_combination_flag` | Live — `backend/ml/liveDataBridge.js` (active same-class prescription, or another medicine on the same form) |
| `patient_velocity` | Live — prescriptions issued to the patient in the last 30 days |
| `drug_rarity_score` | **Held** — still derived here from the synthetic training corpus (`train/corpus_stats.json`) |
| `provider_pattern_score` | **Held** — still derived here from the corpus population rate plus Node's `providerDrugClassHistory` |

Why held: Node computes live versions of both rarity scores, but with a different definition (share of *all*
prescriptions, not relative to the most common drug / the population rate). Fed into the Isolation Forest as it was then (before the corrected-reference retrain),
600 normal training-corpus prescriptions went from 1 to 20 in the Review band (median ML sub-score 0.00 → 14.92), and
renaming `provider_pattern_score` to `provider_rarity_score` makes the saved pipeline fail (`columns are missing`).
Switching needs one of: retraining the model on the live definitions, or aligning Node's formulas to the trained
ones. Until then, the model, `extract.py`, and these two features are unchanged.
