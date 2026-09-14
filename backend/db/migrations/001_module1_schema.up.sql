-- Anchor Rx — Module 1: Prescription Data Model & Schema
-- Target: MySQL 8.0.16+ (CHECK constraints enforced). InnoDB, utf8mb4.
--
-- Core rule: prescription_version rows are IMMUTABLE snapshots.
--   * Clinical columns are written exactly once, at INSERT.
--   * Amendments INSERT a new row linked via parent_version_id.
--   * Only lifecycle metadata (status, amended_at) on an old row may change,
--     and only through the repository layer (Module 1, Step 2).
--   * No updated_at column — nothing here models in-place mutation.
--
-- Intentionally NO database trigger blocking UPDATEs on clinical columns:
-- the tamper demo (scenario B) needs a raw out-of-band SQL edit to succeed
-- so the hash layer (Module 2) can detect it.

-- ---------------------------------------------------------------------------
-- provider (mock registry — no real NMC/ABDM integration)
-- ---------------------------------------------------------------------------
CREATE TABLE provider (
  provider_id     VARCHAR(32)  NOT NULL,
  name            VARCHAR(120) NOT NULL,
  license_number  VARCHAR(64)  NOT NULL,
  credentials     VARCHAR(255) NOT NULL,
  status          ENUM('active','inactive','flagged') NOT NULL DEFAULT 'active',
  PRIMARY KEY (provider_id),
  UNIQUE KEY uq_provider_license (license_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- pharmacy
-- ---------------------------------------------------------------------------
CREATE TABLE pharmacy (
  pharmacy_id     VARCHAR(32)  NOT NULL,
  name            VARCHAR(120) NOT NULL,
  license_number  VARCHAR(64)  NOT NULL,
  PRIMARY KEY (pharmacy_id),
  UNIQUE KEY uq_pharmacy_license (license_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- patient (synthetic demo data only — deliberately minimal, no extra PII)
-- ---------------------------------------------------------------------------
CREATE TABLE patient (
  patient_id      VARCHAR(32)  NOT NULL,
  name            VARCHAR(120) NOT NULL,
  dob             DATE         NOT NULL,
  PRIMARY KEY (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- prescription_version (immutable version snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE prescription_version (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,  -- row id (target of parent_version_id)
  prescription_id     VARCHAR(32)     NOT NULL,                 -- stable across versions, e.g. RX-DEMO-0001
  version_number      INT UNSIGNED    NOT NULL,
  parent_version_id   BIGINT UNSIGNED NULL,

  patient_id          VARCHAR(32)     NOT NULL,
  provider_id         VARCHAR(32)     NOT NULL,

  -- clinical fields (write-once)
  drug_name           VARCHAR(120)    NOT NULL,
  dosage_value        DECIMAL(12,3)   NOT NULL,                 -- numeric only
  dosage_unit         VARCHAR(16)     NOT NULL,                 -- 'mg', 'mcg', 'ml', 'IU', ...
  frequency           VARCHAR(64)     NOT NULL,                 -- 'twice daily'
  duration_days       INT UNSIGNED    NOT NULL,
  drug_class          VARCHAR(80)     NOT NULL,

  -- lifecycle metadata
  status              ENUM('active','amended','dispensed','revoked') NOT NULL DEFAULT 'active',
  created_at          TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  amended_at          TIMESTAMP(3)    NULL,                     -- set when a later version supersedes this row

  -- placeholders (unused until Module 2 / Module 4)
  field_hashes        JSON            NULL,
  integrity_root      CHAR(64)        NULL,
  ledger_anchor_ref   VARCHAR(128)    NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_rx_version (prescription_id, version_number),  -- composite chain+order index; blocks duplicate v2s
  KEY idx_rx_patient_status (patient_id, status),               -- duplicate-drug-class lookups (Module 8)
  KEY idx_rx_provider (provider_id),
  KEY idx_rx_parent (parent_version_id),

  CONSTRAINT fk_rx_patient  FOREIGN KEY (patient_id)        REFERENCES patient (patient_id),
  CONSTRAINT fk_rx_provider FOREIGN KEY (provider_id)       REFERENCES provider (provider_id),
  CONSTRAINT fk_rx_parent   FOREIGN KEY (parent_version_id) REFERENCES prescription_version (id),

  CONSTRAINT chk_rx_version_positive CHECK (version_number >= 1),
  CONSTRAINT chk_rx_dosage_positive  CHECK (dosage_value > 0),
  CONSTRAINT chk_rx_duration_positive CHECK (duration_days > 0),
  CONSTRAINT chk_rx_parent_rule CHECK (
    (version_number = 1 AND parent_version_id IS NULL) OR
    (version_number > 1 AND parent_version_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- verification_event (append-only log of pharmacy checks)
-- ---------------------------------------------------------------------------
CREATE TABLE verification_event (
  event_id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_version_id   BIGINT UNSIGNED NOT NULL,
  pharmacy_id               VARCHAR(32)     NOT NULL,
  result                    ENUM('verified','tampered','forged','flagged') NOT NULL,
  `timestamp`               TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id),
  KEY idx_ve_version_time (prescription_version_id, `timestamp`),
  KEY idx_ve_pharmacy (pharmacy_id),
  CONSTRAINT fk_ve_version  FOREIGN KEY (prescription_version_id) REFERENCES prescription_version (id),
  CONSTRAINT fk_ve_pharmacy FOREIGN KEY (pharmacy_id)             REFERENCES pharmacy (pharmacy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
