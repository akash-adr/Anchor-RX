-- Anchor Rx — Module 14 (multi-medicine prescriptions, patient vitals, dispensing tracker) — schema only.
--
-- 1. prescription_version keeps the prescription-level record (patient, provider, status, versioning, hashes, anchor)
--    and gains patient vitals captured with the prescription. The six clinical columns move to prescription_medicine.
-- 2. prescription_medicine: one row per medicine in a version. sequence_number is the 1-based position in SUBMISSION
--    order and is the stable identity used for "medicine_N" tagging in hashing / tamper reports — never medicine_id or
--    insertion order.
-- 3. dispensing_record: quantities dispensed per medicine, per pharmacy. A composite FK guarantees the medicine belongs
--    to the same prescription_version the record points at.
--
-- No data backfill: existing rows are reproducible seed/test data and are truncated after this migration.

-- The two CHECK constraints reference columns that are moving; MySQL refuses to drop a column a CHECK uses.
ALTER TABLE prescription_version
  DROP CHECK chk_rx_dosage_positive,
  DROP CHECK chk_rx_duration_positive;

ALTER TABLE prescription_version
  DROP COLUMN drug_name,
  DROP COLUMN drug_class,
  DROP COLUMN dosage_value,
  DROP COLUMN dosage_unit,
  DROP COLUMN frequency,
  DROP COLUMN duration_days,
  ADD COLUMN height_cm DECIMAL(5,1) NULL AFTER provider_id,
  ADD COLUMN weight_kg DECIMAL(5,2) NULL AFTER height_cm,
  ADD CONSTRAINT chk_rx_height_positive CHECK (height_cm IS NULL OR height_cm > 0),
  ADD CONSTRAINT chk_rx_weight_positive CHECK (weight_kg IS NULL OR weight_kg > 0);

CREATE TABLE prescription_medicine (
  medicine_id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_version_id  BIGINT UNSIGNED NOT NULL,
  sequence_number          INT UNSIGNED    NOT NULL,     -- 1-based submission order: medicine_1, medicine_2, …
  drug_name                VARCHAR(120)    NOT NULL,
  drug_class               VARCHAR(80)     NOT NULL,
  dosage_value             DECIMAL(12,3)   NOT NULL,     -- same precision as the former prescription_version column
  dosage_unit              VARCHAR(16)     NOT NULL,
  frequency                VARCHAR(64)     NOT NULL,
  duration_days            INT UNSIGNED    NOT NULL,
  quantity_prescribed      INT UNSIGNED    NOT NULL,
  PRIMARY KEY (medicine_id),
  UNIQUE KEY uq_medicine_sequence (prescription_version_id, sequence_number),
  UNIQUE KEY uq_medicine_version (medicine_id, prescription_version_id),   -- target of dispensing_record's composite FK
  CONSTRAINT fk_medicine_version FOREIGN KEY (prescription_version_id) REFERENCES prescription_version (id),
  CONSTRAINT chk_medicine_sequence_positive CHECK (sequence_number >= 1),
  CONSTRAINT chk_medicine_dosage_positive CHECK (dosage_value > 0),
  CONSTRAINT chk_medicine_duration_positive CHECK (duration_days > 0),
  CONSTRAINT chk_medicine_quantity_positive CHECK (quantity_prescribed > 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE dispensing_record (
  dispensing_id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_version_id  BIGINT UNSIGNED NOT NULL,
  medicine_id              BIGINT UNSIGNED NOT NULL,
  quantity_dispensed       INT UNSIGNED    NOT NULL,
  dispensed_at             TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  dispensed_by             VARCHAR(32)     NOT NULL,     -- pharmacy_id
  PRIMARY KEY (dispensing_id),
  KEY idx_dispensing_version (prescription_version_id, dispensed_at),
  KEY idx_dispensing_pharmacy (dispensed_by, dispensed_at),
  CONSTRAINT fk_dispensing_version FOREIGN KEY (prescription_version_id) REFERENCES prescription_version (id),
  -- The medicine must belong to the SAME prescription version this record points at.
  CONSTRAINT fk_dispensing_medicine FOREIGN KEY (medicine_id, prescription_version_id)
    REFERENCES prescription_medicine (medicine_id, prescription_version_id),
  CONSTRAINT fk_dispensing_pharmacy FOREIGN KEY (dispensed_by) REFERENCES pharmacy (pharmacy_id),
  CONSTRAINT chk_dispensing_quantity_positive CHECK (quantity_dispensed > 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
