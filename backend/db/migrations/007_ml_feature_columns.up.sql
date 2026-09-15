-- Anchor Rx — Module 8: columns the AI risk engine's feature extraction needs.
-- * patient.weight (kg) is nullable: payload assembly substitutes a documented 70 kg placeholder when absent.
-- * prescription_version.route defaults to 'oral', which backfills every existing row.
--   NOTE: route is not (yet) part of Module 2's hashed field set.
ALTER TABLE patient
  ADD COLUMN weight DECIMAL(5,2) NULL AFTER dob;

ALTER TABLE prescription_version
  ADD COLUMN route VARCHAR(20) NOT NULL DEFAULT 'oral' AFTER duration_days;
