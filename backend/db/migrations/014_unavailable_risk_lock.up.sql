-- Anchor Rx — end-to-end risk wiring: a medicine whose AI risk assessment was UNAVAILABLE can still be confirmed, and
-- that fact is locked permanently instead of being indistinguishable from "never assessed":
--   locked_risk_band = 'unavailable', locked_risk_score = NULL, locked_risk_reasons = the system reason.
-- Still write-once: the trigger now keys on locked_risk_band, because an 'unavailable' lock has no score.

ALTER TABLE prescription_medicine DROP CHECK chk_medicine_locked_risk_complete;
ALTER TABLE prescription_medicine DROP CHECK chk_medicine_locked_risk_band;

ALTER TABLE prescription_medicine
  ADD CONSTRAINT chk_medicine_locked_risk_complete CHECK (
        (locked_risk_score IS NULL AND locked_risk_band IS NULL AND locked_risk_reasons IS NULL)
     OR (locked_risk_band IN ('low', 'review', 'high') AND locked_risk_score IS NOT NULL AND locked_risk_reasons IS NOT NULL)
     OR (locked_risk_band = 'unavailable' AND locked_risk_score IS NULL AND locked_risk_reasons IS NOT NULL)),
  ADD CONSTRAINT chk_medicine_locked_risk_band CHECK (locked_risk_band IS NULL OR locked_risk_band IN ('low', 'review', 'high', 'unavailable'));

DROP TRIGGER IF EXISTS trg_medicine_locked_risk_write_once;

DELIMITER //
CREATE TRIGGER trg_medicine_locked_risk_write_once
BEFORE UPDATE ON prescription_medicine
FOR EACH ROW
BEGIN
  IF OLD.locked_risk_band IS NOT NULL
     AND NOT (NEW.locked_risk_score <=> OLD.locked_risk_score
              AND NEW.locked_risk_band <=> OLD.locked_risk_band
              AND NEW.locked_risk_reasons <=> OLD.locked_risk_reasons) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'locked_risk_* is write-once: it cannot be changed after it has been set';
  END IF;
END//
DELIMITER ;
