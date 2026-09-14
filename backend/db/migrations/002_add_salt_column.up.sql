-- Anchor Rx — Module 2: per-version salt for field-level hashing.
-- Every version gets its own salt at INSERT (never regenerated). NOT NULL, no default:
-- the repository always supplies it. No legacy data to backfill — re-run the seed after applying.
ALTER TABLE prescription_version
  ADD COLUMN salt VARCHAR(32) NOT NULL AFTER amended_at;
