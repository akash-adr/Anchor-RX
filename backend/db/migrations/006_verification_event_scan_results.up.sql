-- Anchor Rx — Module 6: pharmacy scan results.
-- * result gains every scan outcome produced by verifyScan (precedence order):
--     malformed_qr → unknown_prescription → provider_identity_issue → tampered → forged → revoked → stale_version → verified
--   ('flagged' from Module 1 is kept for compatibility; verifyScan never writes it.)
-- * prescription_version_id becomes nullable: malformed_qr and unknown_prescription scans have no row to reference.
-- MySQL 8.4 refuses to change nullability of a column used by a foreign key, so the FK is dropped and
-- recreated identically around the change. It still applies whenever a value is present.
ALTER TABLE verification_event DROP FOREIGN KEY fk_ve_version;

ALTER TABLE verification_event
  MODIFY COLUMN prescription_version_id BIGINT UNSIGNED NULL,
  MODIFY COLUMN result ENUM(
    'verified', 'tampered', 'forged', 'flagged',
    'malformed_qr', 'unknown_prescription', 'provider_identity_issue', 'revoked', 'stale_version'
  ) NOT NULL;

ALTER TABLE verification_event
  ADD CONSTRAINT fk_ve_version FOREIGN KEY (prescription_version_id) REFERENCES prescription_version (id);
