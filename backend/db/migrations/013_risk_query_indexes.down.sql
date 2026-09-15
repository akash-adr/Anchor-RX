-- Anchor Rx — Module 16: revert the live data bridge's indexes.

ALTER TABLE prescription_medicine
  DROP INDEX idx_medicine_drug_name,
  DROP INDEX idx_medicine_drug_class;

ALTER TABLE prescription_version
  DROP INDEX idx_rx_created_at,
  DROP INDEX idx_rx_status;
