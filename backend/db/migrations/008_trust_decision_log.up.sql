-- Anchor Rx — Module 9: one row per Dispense / Review / Block decision computed for a pharmacy scan.
-- verification_event_id links the decision to the exact Module 6 scan it was computed from (Module 10 audit trail).
-- prescription_id / version_number are NULL only when the scanned QR was malformed.
-- CHECK constraints mirror decideTrust: risk fields are set together or not at all, and a Block never carries a risk score.
CREATE TABLE trust_decision_log (
  decision_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_id       varchar(32) NULL,
  version_number        int unsigned NULL,
  pharmacy_id           VARCHAR(32) NOT NULL,
  verification_event_id BIGINT UNSIGNED NULL,
  trust_decision        ENUM('Dispense', 'Review', 'Block') NOT NULL,
  primary_reason        VARCHAR(40) NOT NULL,
  risk_score            TINYINT UNSIGNED NULL,
  risk_band             ENUM('low', 'review', 'high') NULL,
  decided_at            TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (decision_id),
  KEY idx_tdl_prescription_time (prescription_id, version_number, decided_at),
  KEY idx_tdl_pharmacy_time (pharmacy_id, decided_at),
  KEY idx_tdl_event (verification_event_id),
  CONSTRAINT fk_tdl_event FOREIGN KEY (verification_event_id) REFERENCES verification_event (event_id),
  CONSTRAINT fk_tdl_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES pharmacy (pharmacy_id),
  CONSTRAINT chk_tdl_risk_score_range CHECK (risk_score IS NULL OR risk_score <= 100),
  CONSTRAINT chk_tdl_risk_fields_together CHECK ((risk_score IS NULL) = (risk_band IS NULL)),
  CONSTRAINT chk_tdl_block_has_no_risk CHECK (trust_decision <> 'Block' OR risk_score IS NULL)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
