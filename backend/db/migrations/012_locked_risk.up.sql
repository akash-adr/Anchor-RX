-- Anchor Rx — Module 15: locked, per-medicine AI risk.
--
-- locked_risk_* hold the risk result shown to the prescriber when they confirmed the prescription. They start NULL and
-- are written exactly ONCE, at confirmation (Step 3) — never recalculated or overwritten afterwards, for any reason,
-- including a future retrained model. That is enforced here, not just by convention:
--   * CHECKs: the three columns are set together or not at all; score 0–100; band is low/review/high.
--   * trg_medicine_locked_risk_write_once: once locked_risk_score is non-NULL, any UPDATE that changes a locked_risk_*
--     column is rejected (SQLSTATE 45000). Other columns are untouched by the trigger.
-- These columns are NOT part of Module 2's hashed field set (the hash engine uses an explicit field list).

ALTER TABLE prescription_medicine
  ADD COLUMN locked_risk_score   DECIMAL(5,2) NULL AFTER quantity_prescribed,
  ADD COLUMN locked_risk_band    VARCHAR(16)  NULL AFTER locked_risk_score,
  ADD COLUMN locked_risk_reasons JSON         NULL AFTER locked_risk_band,
  ADD CONSTRAINT chk_medicine_locked_risk_complete CHECK (
        (locked_risk_score IS NULL AND locked_risk_band IS NULL AND locked_risk_reasons IS NULL)
     OR (locked_risk_score IS NOT NULL AND locked_risk_band IS NOT NULL AND locked_risk_reasons IS NOT NULL)),
  ADD CONSTRAINT chk_medicine_locked_risk_score_range CHECK (locked_risk_score IS NULL OR (locked_risk_score >= 0 AND locked_risk_score <= 100)),
  ADD CONSTRAINT chk_medicine_locked_risk_band CHECK (locked_risk_band IS NULL OR locked_risk_band IN ('low', 'review', 'high'));

DELIMITER //
CREATE TRIGGER trg_medicine_locked_risk_write_once
BEFORE UPDATE ON prescription_medicine
FOR EACH ROW
BEGIN
  IF OLD.locked_risk_score IS NOT NULL
     AND NOT (NEW.locked_risk_score <=> OLD.locked_risk_score
              AND NEW.locked_risk_band <=> OLD.locked_risk_band
              AND NEW.locked_risk_reasons <=> OLD.locked_risk_reasons) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'locked_risk_* is write-once: it cannot be changed after it has been set';
  END IF;
END//
DELIMITER ;
