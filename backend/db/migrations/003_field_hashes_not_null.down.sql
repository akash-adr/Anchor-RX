-- Reverse of 003_field_hashes_not_null.up.sql
ALTER TABLE prescription_version
  MODIFY COLUMN field_hashes   JSON     NULL,
  MODIFY COLUMN integrity_root CHAR(64) NULL;
