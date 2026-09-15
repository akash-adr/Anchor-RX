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

Held-out set: 1,000 deliberately anomalous cases (200 each of: dose 3–5× max, extreme frequency, extreme duration,
forced class duplication, two anomalies combined) plus 995 normal cases never used in training.
**Positive = review or high**, fixed before running; nothing was tuned on these results.

| Precision | Recall | F1 | False-negative rate | False-positive rate |
|---|---|---|---|---|
| **99.7%** | **61.8%** | **76.3%** | **38.2%** | **0.2%** |

TP 618 · FN 382 · FP 2 · TN 993. Latency: median 6.95 ms, p95 13.51 ms, max 22.2 ms over 1,995 cases (target < 500 ms).

| Category | Recall |
|---|---|
| Dose 3–5× typical max | 100.0% (all review, none high) |
| Extreme frequency | 100.0% |
| Two anomalies combined | 100.0% (44 of 200 high) |
| Forced class duplication only | 7.5% |
| Extreme duration only | 1.5% |

| View | Precision | Recall | F1 | FPR |
|---|---|---|---|---|
| Full pipeline | 99.7% | 61.8% | 76.3% | 0.2% |
| Rules alone | 100.0% | 60.0% | 75.0% | 0.0% |
| ML alone (sub-score > 30) | 95.4% | 10.4% | 18.8% | 0.5% |

**Train/eval disjointness is proven, not assumed:**
- Every case is fingerprinted by the SHA-256 of its 13 model-visible features.
- The training file's hash matches the saved model's metadata, so it is the data the model was trained on.
- Overlap between training and the held-out set is **0**. Five generated normal hold-out cases matched training rows
  and were removed.
- The three seeds all differ, and a test fails if the anomalous generator imports the training generator.

### What these numbers honestly say

1. **Recall is 61.8% because two whole categories are mostly missed, by design, not by accident.** Duplication-only (25
   points) and duration-only (20 points) sit in the low band on purpose (Step 3: often intentional, rarely acute).
   The ML almost never lifts them above 30. This is a weighting decision to revisit, **on a fresh held-out seed**,
   not by tuning against this report.
2. **Rules do most of the work.** The ML adds 18 true positives over rules alone, at the cost of 2 false positives.
   Both false positives came from the ML reacting to IV amoxicillin, which is rare in the synthetic corpus.
3. **ML alone is weak on this set (10.4% recall).** It barely reacts to dose, because dose ranges differ hugely
   across drug classes. Its value is unusual combinations the rules don't describe, not replacing the rules.
4. **A 3–5× overdose reaches review, never high.** One rule hit is capped at 45 points.
5. **Some of the result is circular.** The dose, frequency and duration anomalies are defined against the same
   synthetic table the rules check, so 100% recall there shows the rules work as written, not that they generalise.
6. **The false-positive rate is optimistic.** Held-out normals come from the same generator family as training.
7. **Precision is inflated by the 50/50 mix.** Real anomaly prevalence is far lower, so precision would drop at the
   same 0.2% FPR. Recall and FPR are the numbers to quote.

## Reproduce

```bash
cd ai-service
.venv/bin/python -m train.train_model          # corpus (seed 20260915) → pipeline + stats + calibration
.venv/bin/python -m evaluation.evaluate        # held-out evaluation → evaluation/report.md, report.json
.venv/bin/python -m pytest                     # full test suite
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000   # POST /score, GET /health
```
