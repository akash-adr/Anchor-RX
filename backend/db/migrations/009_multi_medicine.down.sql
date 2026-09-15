-- Reverse of 009_multi_medicine.up.sql (schema only — no data is restored).
-- Only works on an EMPTY prescription_version: the six clinical columns come back NOT NULL without defaults.
DROP TABLE IF EXISTS dispensing_record;
DROP TABLE IF EXISTS prescription_medicine;

ALTER TABLE prescription_version
  DROP CHECK chk_rx_height_positive,
  DROP CHECK chk_rx_weight_positive;

ALTER TABLE prescription_version
  DROP COLUMN height_cm,
  DROP COLUMN weight_kg,
  ADD COLUMN drug_name VARCHAR(120) NOT NULL AFTER provider_id,
  ADD COLUMN dosage_value DECIMAL(12,3) NOT NULL AFTER drug_name,
  ADD COLUMN dosage_unit VARCHAR(16) NOT NULL AFTER dosage_value,
  ADD COLUMN frequency VARCHAR(64) NOT NULL AFTER dosage_unit,
  ADD COLUMN duration_days INT UNSIGNED NOT NULL AFTER frequency,
  ADD COLUMN drug_class VARCHAR(80) NOT NULL AFTER route,
  ADD CONSTRAINT chk_rx_dosage_positive CHECK (dosage_value > 0),
  ADD CONSTRAINT chk_rx_duration_positive CHECK (duration_days > 0);
