-- Reverse of 004_versioning_governance.up.sql
DROP TABLE IF EXISTS amendment_attempts;
DROP TABLE IF EXISTS delegated_amendments;

ALTER TABLE prescription_version
  DROP CHECK chk_rx_v1_not_amended,
  DROP FOREIGN KEY fk_rx_amended_by;

ALTER TABLE prescription_version
  DROP KEY idx_rx_amended_by,
  DROP COLUMN reason,
  DROP COLUMN amended_by_provider_id;
