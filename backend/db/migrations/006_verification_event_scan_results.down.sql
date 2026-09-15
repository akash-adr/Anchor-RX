-- Reverse of 006_verification_event_scan_results.up.sql.
-- DESTRUCTIVE: events that cannot be represented in the Module 1 schema are removed first.
DELETE FROM verification_event
 WHERE prescription_version_id IS NULL
    OR result IN ('malformed_qr', 'unknown_prescription', 'provider_identity_issue', 'revoked', 'stale_version');

ALTER TABLE verification_event DROP FOREIGN KEY fk_ve_version;

ALTER TABLE verification_event
  MODIFY COLUMN prescription_version_id BIGINT UNSIGNED NOT NULL,
  MODIFY COLUMN result ENUM('verified', 'tampered', 'forged', 'flagged') NOT NULL;

ALTER TABLE verification_event
  ADD CONSTRAINT fk_ve_version FOREIGN KEY (prescription_version_id) REFERENCES prescription_version (id);
