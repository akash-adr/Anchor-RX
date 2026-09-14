-- Reverse of 002_add_salt_column.up.sql
ALTER TABLE prescription_version
  DROP COLUMN salt;
