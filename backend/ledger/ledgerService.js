'use strict';

/**
 * Anchor Rx — Module 4: MOCK ledger (append-only, single global hash chain).
 *
 * Interface (kept stable so a real chain implementation can replace this later):
 *   anchorEntry(prescriptionId, versionNumber, integrityRoot, connection?) → ledger_entry_id
 *   verifyChainIntegrity(upToEntryId?)                                    → { intact, brokenAtEntryId }
 *   getEntry(prescriptionId, versionNumber)                               → row | null
 *   verifyAnchor(prescriptionId, versionNumber)                           → { anchored, integrityRootMatch, chainIntact, anchoredAt }
 *
 * Append-only: this file contains no UPDATE or DELETE of ledger_entry, by design.
 * Only references are recorded (ids, version, integrity root, hashes, time) — never clinical data.
 */

const crypto = require('crypto');
const hashEngine = require('../integrity/hashEngine');

const ANCHOR_TYPE = 'mock';
const HEX_64 = /^[0-9a-f]{64}$/;

// Mutex: serializes writers so two anchors can never read the same "latest entry" and fork the chain.
// FOR UPDATE on this always-present row blocks other writers until the holder's transaction ends.
const LOCK_LEDGER_SQL = 'SELECT id FROM ledger_lock WHERE id = 1 FOR UPDATE';

// Locking read (after the mutex): sees the latest COMMITTED entry even inside a caller's older
// REPEATABLE READ snapshot, which a plain SELECT would not.
const SELECT_HEAD_SQL = `
  SELECT entry_hash FROM ledger_entry
   ORDER BY sequence_number DESC
   LIMIT 1
   FOR SHARE`;

const INSERT_ENTRY_SQL = `
  INSERT INTO ledger_entry
    (ledger_entry_id, prescription_id, version_number, integrity_root,
     previous_entry_hash, entry_hash, anchored_at, anchor_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const ENTRY_COLUMNS = `
  ledger_entry_id, sequence_number, prescription_id, version_number, integrity_root,
  previous_entry_hash, entry_hash, anchored_at, anchor_type`;

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/**
 * SHA256 over "|"-joined fields. The delimiter prevents boundary ambiguity
 * (e.g. RX-DEMO-000 + v11 vs RX-DEMO-0001 + v1). anchoredAt is hashed as an ISO-8601 UTC string
 * with milliseconds, which round-trips exactly through TIMESTAMP(3).
 */
function computeEntryHash({ prescriptionId, versionNumber, integrityRoot, previousEntryHash, anchoredAt }) {
  const payload = [
    prescriptionId,
    String(versionNumber),
    integrityRoot,
    previousEntryHash ?? '',
    anchoredAt.toISOString(),
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function assertAnchorInput(prescriptionId, versionNumber, integrityRoot) {
  if (typeof prescriptionId !== 'string' || prescriptionId === '' || prescriptionId.length > 32) {
    throw new LedgerError('INVALID_INPUT', 'prescriptionId must be a non-empty string of at most 32 characters');
  }
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new LedgerError('INVALID_INPUT', `versionNumber must be a positive integer, got ${versionNumber}`);
  }
  if (typeof integrityRoot !== 'string' || !HEX_64.test(integrityRoot)) {
    throw new LedgerError('INVALID_INPUT', 'integrityRoot must be a 64-character lowercase hex string');
  }
}

function mapDbError(err) {
  if (err && err.code === 'ER_DUP_ENTRY') {
    return new LedgerError('ALREADY_ANCHORED', 'This prescription version is already anchored (or the chain head changed)');
  }
  return err;
}

const NOT_ANCHORED = Object.freeze({ anchored: false, integrityRootMatch: false, chainIntact: false, anchoredAt: null });

/**
 * @param pool mysql2 promise pool
 * @param {object} [options]
 * @param [options.repository] prescription_version repository (read access only); defaults to one on the same pool
 */
function createLedgerService(pool, { repository = null } = {}) {
  let versionRepository = repository;
  function getVersionRepository() {
    if (!versionRepository) {
      // Required lazily: the repository imports this module to anchor inside its own transaction,
      // so a top-level require here would create a require cycle.
      const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
      versionRepository = createPrescriptionVersionRepository(pool);
    }
    return versionRepository;
  }

  // All queries for one anchor, on one connection. Caller decides who owns the transaction.
  async function appendEntry(conn, prescriptionId, versionNumber, integrityRoot) {
    await acquireWriteLock(conn); // re-entrant within one transaction: a no-op if already held

    const [headRows] = await conn.execute(SELECT_HEAD_SQL);
    const previousEntryHash = headRows.length > 0 ? headRows[0].entry_hash : null;

    const ledgerEntryId = crypto.randomUUID();
    const anchoredAt = new Date(); // millisecond precision, matches TIMESTAMP(3)
    const entryHash = computeEntryHash({ prescriptionId, versionNumber, integrityRoot, previousEntryHash, anchoredAt });

    await conn.execute(INSERT_ENTRY_SQL, [
      ledgerEntryId,
      prescriptionId,
      versionNumber,
      integrityRoot,
      previousEntryHash,
      entryHash,
      anchoredAt,
      ANCHOR_TYPE,
    ]);
    return ledgerEntryId;
  }

  /**
   * MOCK-specific: takes the ledger mutex on a connection that is ALREADY inside the caller's
   * transaction (held until that transaction commits or rolls back). Version writers call this as
   * their FIRST statement so every writer acquires locks in one order — ledger, then prescription
   * rows — which rules out deadlocks between InnoDB row/gap locks and the ledger mutex.
   * A real chain implementation can make this a no-op.
   */
  async function acquireWriteLock(connection) {
    const [lockRows] = await connection.execute(LOCK_LEDGER_SQL);
    if (lockRows.length !== 1) {
      throw new LedgerError('LEDGER_NOT_INITIALIZED', 'ledger_lock row is missing — re-run migration 005');
    }
  }

  /**
   * Appends one entry to the global chain.
   *
   * @param connection OPTIONAL connection that is ALREADY inside a transaction owned by the caller.
   *        When given, this function never begins/commits/rolls back (a nested BEGIN in MySQL would
   *        silently commit the caller's transaction). The ledger lock is then held until the caller
   *        commits or rolls back, and a rollback removes the entry with everything else.
   *        When omitted, a pooled connection and a private transaction are used.
   * @returns {Promise<string>} ledger_entry_id
   */
  async function anchorEntry(prescriptionId, versionNumber, integrityRoot, connection = null) {
    assertAnchorInput(prescriptionId, versionNumber, integrityRoot);

    if (connection) {
      try {
        return await appendEntry(connection, prescriptionId, versionNumber, integrityRoot);
      } catch (err) {
        throw mapDbError(err);
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const ledgerEntryId = await appendEntry(conn, prescriptionId, versionNumber, integrityRoot);
      await conn.commit();
      return ledgerEntryId;
    } catch (err) {
      await conn.rollback();
      throw mapDbError(err);
    } finally {
      conn.release();
    }
  }

  /**
   * Walks entries in creation order (sequence_number), recomputing each entry_hash from the entry's
   * own stored fields and checking each link to its predecessor. Stops at the first break: every
   * entry from there on is considered compromised.
   *
   * Detects: edited entry contents, broken/rewired links, deleted entries in the middle or at the start.
   * Cannot detect (by itself): truncation of the newest entries — a real chain's external head covers that.
   *
   * @returns {Promise<{ intact: boolean, brokenAtEntryId: string | null }>}
   */
  async function verifyChainIntegrity(upToEntryId = null) {
    let sql = `SELECT ${ENTRY_COLUMNS} FROM ledger_entry`;
    const params = [];
    if (upToEntryId !== null) {
      const [target] = await pool.execute('SELECT sequence_number FROM ledger_entry WHERE ledger_entry_id = ?', [upToEntryId]);
      if (target.length === 0) {
        throw new LedgerError('ENTRY_NOT_FOUND', `No ledger entry with id ${upToEntryId}`);
      }
      sql += ' WHERE sequence_number <= ?';
      params.push(target[0].sequence_number);
    }
    sql += ' ORDER BY sequence_number ASC';

    const [entries] = await pool.execute(sql, params);

    let expectedPrevious = null; // the first entry of the whole ledger has no predecessor
    for (const entry of entries) {
      if (entry.previous_entry_hash !== expectedPrevious) {
        return { intact: false, brokenAtEntryId: entry.ledger_entry_id };
      }
      const recomputed = computeEntryHash({
        prescriptionId: entry.prescription_id,
        versionNumber: entry.version_number,
        integrityRoot: entry.integrity_root,
        previousEntryHash: entry.previous_entry_hash,
        anchoredAt: entry.anchored_at,
      });
      if (recomputed !== entry.entry_hash) {
        return { intact: false, brokenAtEntryId: entry.ledger_entry_id };
      }
      expectedPrevious = entry.entry_hash;
    }

    return { intact: true, brokenAtEntryId: null };
  }

  /**
   * @returns {Promise<object|null>} the ledger entry anchoring that prescription version
   */
  async function getEntry(prescriptionId, versionNumber) {
    const [rows] = await pool.execute(
      `SELECT ${ENTRY_COLUMNS} FROM ledger_entry WHERE prescription_id = ? AND version_number = ?`,
      [prescriptionId, versionNumber],
    );
    return rows[0] || null;
  }

  // Recomputes the root from the row's CURRENT data and stored salt. Anything that makes the row
  // unverifiable (row deleted, salt or field values no longer hashable) counts as a mismatch.
  function liveRootMatches(row, anchoredRoot) {
    if (!row) return false;
    try {
      return hashEngine.computeIntegrityRoot(hashEngine.computeFieldHashes(row, row.salt)) === anchoredRoot;
    } catch {
      return false;
    }
  }

  /**
   * Checks a prescription version against its ledger anchor.
   *
   * integrityRootMatch compares the root recomputed LIVE from the prescription row against the root
   * stored in the LEDGER ENTRY — never against the row's own integrity_root column. A DB-only attacker
   * can rewrite a row's data, field_hashes and integrity_root consistently; the external anchor is what
   * exposes that.
   *
   * chainIntact walks the ledger up to and including this entry, so a tampered ledger entry is not
   * trusted as the reference. (In this MOCK the ledger shares the database: an attacker who rewrites
   * the entry AND every later entry's hashes is not detectable here — a real external chain closes that.)
   *
   * @returns {Promise<{ anchored: boolean, integrityRootMatch: boolean, chainIntact: boolean, anchoredAt: Date|null }>}
   */
  async function verifyAnchor(prescriptionId, versionNumber) {
    const entry = await getEntry(prescriptionId, versionNumber);
    if (!entry) return { ...NOT_ANCHORED };

    const row = await getVersionRepository().getVersion(prescriptionId, versionNumber);
    const { intact } = await verifyChainIntegrity(entry.ledger_entry_id);

    return {
      anchored: true,
      integrityRootMatch: liveRootMatches(row, entry.integrity_root),
      chainIntact: intact,
      anchoredAt: entry.anchored_at,
    };
  }

  return Object.freeze({ anchorEntry, verifyChainIntegrity, getEntry, verifyAnchor, acquireWriteLock });
}

module.exports = { createLedgerService, computeEntryHash, LedgerError, ANCHOR_TYPE };
