-- Anchor Rx — Module 2: every saved version must carry its integrity data.
-- The repository always writes these on INSERT; this makes the DB reject an unhashed row too.
ALTER TABLE prescription_version
  MODIFY COLUMN field_hashes   JSON     NOT NULL,
  MODIFY COLUMN integrity_root CHAR(64) NOT NULL;
