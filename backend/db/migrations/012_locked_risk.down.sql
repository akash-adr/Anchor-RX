-- Anchor Rx — Module 15: revert locked per-medicine AI risk.

DROP TRIGGER IF EXISTS trg_medicine_locked_risk_write_once;

ALTER TABLE prescription_medicine
  DROP CHECK chk_medicine_locked_risk_band,
  DROP CHECK chk_medicine_locked_risk_score_range,
  DROP CHECK chk_medicine_locked_risk_complete;

ALTER TABLE prescription_medicine
  DROP COLUMN locked_risk_reasons,
  DROP COLUMN locked_risk_band,
  DROP COLUMN locked_risk_score;
