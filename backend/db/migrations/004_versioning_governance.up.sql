-- Anchor Rx — Module 3: versioning governance.
--   * provider_id = ORIGINAL prescriber (constant across a chain, enforced in the repository).
--   * amended_by_provider_id = who performed this amendment/revocation (NULL on version 1).
--   * reason = why this version exists (always set for revocations).
-- Neither new column is part of the hashed field set.

ALTER TABLE prescription_version
  ADD COLUMN amended_by_provider_id VARCHAR(32)  NULL AFTER amended_at,
  ADD COLUMN reason                 VARCHAR(255) NULL AFTER amended_by_provider_id,
  ADD KEY idx_rx_amended_by (amended_by_provider_id),
  ADD CONSTRAINT fk_rx_amended_by FOREIGN KEY (amended_by_provider_id) REFERENCES provider (provider_id),
  ADD CONSTRAINT chk_rx_v1_not_amended CHECK (version_number > 1 OR amended_by_provider_id IS NULL);

-- "A covering physician may amend this specific prescription."
-- No FK on prescription_id: it is not unique in prescription_version (one row per version).
CREATE TABLE delegated_amendments (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_id         VARCHAR(32)     NOT NULL,
  delegated_provider_id   VARCHAR(32)     NOT NULL,
  granted_by_provider_id  VARCHAR(32)     NOT NULL,
  granted_at              TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_delegation (prescription_id, delegated_provider_id),
  KEY idx_delegation_delegate (delegated_provider_id),
  KEY idx_delegation_granted_by (granted_by_provider_id),
  CONSTRAINT fk_delegation_delegate   FOREIGN KEY (delegated_provider_id)  REFERENCES provider (provider_id),
  CONSTRAINT fk_delegation_granted_by FOREIGN KEY (granted_by_provider_id) REFERENCES provider (provider_id),
  CONSTRAINT chk_delegation_not_self CHECK (delegated_provider_id <> granted_by_provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only log of every amendment attempt, allowed or rejected.
-- Intentionally no FKs: rejected attempts with unknown/forged IDs must still be recorded.
CREATE TABLE amendment_attempts (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_id         VARCHAR(32)     NOT NULL,
  requesting_provider_id  VARCHAR(32)     NOT NULL,
  attempted_at            TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  allowed                 BOOLEAN         NOT NULL,
  reason                  TEXT            NOT NULL,
  PRIMARY KEY (id),
  KEY idx_attempts_rx_time (prescription_id, attempted_at),
  KEY idx_attempts_provider (requesting_provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
