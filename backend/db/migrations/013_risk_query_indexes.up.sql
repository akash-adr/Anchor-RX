-- Anchor Rx — Module 16: indexes for the live data bridge's risk-feature queries (backend/ml/liveDataBridge.js).
--
-- Checked against migrations 001–012 before adding:
--   prescription_version(patient_id)   ALREADY COVERED by idx_rx_patient_status (patient_id, status) — leftmost column
--   prescription_version(provider_id)  ALREADY EXISTS as idx_rx_provider
-- Added here (none existed):
ALTER TABLE prescription_version
  ADD INDEX idx_rx_status (status),
  ADD INDEX idx_rx_created_at (created_at);

ALTER TABLE prescription_medicine
  ADD INDEX idx_medicine_drug_class (drug_class),
  ADD INDEX idx_medicine_drug_name (drug_name);
