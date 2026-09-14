-- Anchor Rx — Module 4: mock ledger (append-only, globally hash-chained).
-- Only references go on the ledger: prescription_id, version_number, integrity_root, timestamps, hashes.
-- No clinical data. Designed to be swapped for a real chain later behind ledgerService's interface.

CREATE TABLE ledger_entry (
  ledger_entry_id      CHAR(36)        NOT NULL,                  -- uuid
  sequence_number      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,   -- creation order; walk the chain by this
  prescription_id      VARCHAR(32)     NOT NULL,
  version_number       INT UNSIGNED    NOT NULL,
  integrity_root       CHAR(64)        NOT NULL,
  previous_entry_hash  CHAR(64)        NULL,                      -- NULL only for the first entry of the whole ledger
  entry_hash           CHAR(64)        NOT NULL,
  anchored_at          TIMESTAMP(3)    NOT NULL,
  anchor_type          VARCHAR(16)     NOT NULL DEFAULT 'mock',
  PRIMARY KEY (ledger_entry_id),
  UNIQUE KEY uq_ledger_sequence (sequence_number),
  UNIQUE KEY uq_ledger_rx_version (prescription_id, version_number),  -- a version is anchored at most once
  UNIQUE KEY uq_ledger_entry_hash (entry_hash),
  UNIQUE KEY uq_ledger_previous_hash (previous_entry_hash),           -- no two entries may extend the same link (no forks)
  CONSTRAINT chk_ledger_version_positive CHECK (version_number >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;         -- exact, case-sensitive matching

-- Single-row mutex: anchorEntry locks this row FOR UPDATE so concurrent writers extend the chain
-- one at a time. The lock is held until the writer's transaction commits or rolls back.
-- Never updated, never truncated by test resets.
CREATE TABLE ledger_lock (
  id TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_ledger_lock_singleton CHECK (id = 1)
) ENGINE=InnoDB;

INSERT INTO ledger_lock (id) VALUES (1);
