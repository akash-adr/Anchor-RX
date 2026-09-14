'use strict';

/**
 * Module 3 — amendment authorization and attempt logging.
 *
 * canAmend decides; logAmendmentAttempt records. Neither modifies prescription_version.
 * Logging uses its own autocommit insert, so an attempt stays recorded even if a later
 * amendment transaction rolls back.
 */

const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');

const AUTHORIZATION_REASONS = Object.freeze({
  PRESCRIPTION_NOT_FOUND: 'PRESCRIPTION_NOT_FOUND',
  NOT_AMENDABLE_STATUS: 'NOT_AMENDABLE_STATUS',
  ORIGINAL_PROVIDER: 'ORIGINAL_PROVIDER',
  DELEGATED_PROVIDER: 'DELEGATED_PROVIDER',
  NOT_AUTHORIZED_PROVIDER: 'NOT_AUTHORIZED_PROVIDER',
});

const ID_COLUMN_LENGTH = 32; // amendment_attempts.prescription_id / requesting_provider_id

// Deliberately no WHERE on delegated_provider_id: the column collation is case-insensitive,
// so provider IDs are matched exactly in JavaScript instead.
const SELECT_DELEGATIONS_SQL = `
  SELECT delegated_provider_id, granted_by_provider_id
    FROM delegated_amendments
   WHERE prescription_id = ?`;

const INSERT_ATTEMPT_SQL = `
  INSERT INTO amendment_attempts (prescription_id, requesting_provider_id, allowed, reason)
  VALUES (?, ?, ?, ?)`;

const decision = (allowed, reason) => ({ allowed, reason });

// Log columns are VARCHAR(32); a longer (possibly forged) ID is truncated rather than
// letting the insert fail, so the attempt is still recorded.
function toLogId(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return (text === '' ? '(missing)' : text).slice(0, ID_COLUMN_LENGTH);
}

/**
 * @param pool mysql2 promise pool
 * @param {object} [options]
 * @param [options.repository] prescription_version repository (defaults to one on the same pool)
 */
function createAuthorization(pool, { repository = createPrescriptionVersionRepository(pool) } = {}) {
  /**
   * @returns {Promise<{ allowed: boolean, reason: string }>}
   */
  async function canAmend(prescriptionId, requestingProviderId) {
    let latest;
    try {
      latest = await repository.getLatestVersion(prescriptionId);
    } catch (err) {
      if (err && err.code === 'INVALID_PRESCRIPTION_ID') {
        return decision(false, AUTHORIZATION_REASONS.PRESCRIPTION_NOT_FOUND);
      }
      throw err;
    }
    if (!latest) {
      return decision(false, AUTHORIZATION_REASONS.PRESCRIPTION_NOT_FOUND);
    }

    // 'dispensed' and 'revoked' per spec; any other non-active latest status is refused too.
    if (latest.status !== 'active') {
      return decision(false, AUTHORIZATION_REASONS.NOT_AMENDABLE_STATUS);
    }

    if (typeof requestingProviderId !== 'string' || requestingProviderId === '') {
      return decision(false, AUTHORIZATION_REASONS.NOT_AUTHORIZED_PROVIDER);
    }

    if (requestingProviderId === latest.provider_id) {
      return decision(true, AUTHORIZATION_REASONS.ORIGINAL_PROVIDER);
    }

    const [delegations] = await pool.execute(SELECT_DELEGATIONS_SQL, [prescriptionId]);
    const isDelegated = delegations.some(
      (d) =>
        d.delegated_provider_id === requestingProviderId &&
        // Only a delegation granted by the original prescriber confers amend rights.
        d.granted_by_provider_id === latest.provider_id,
    );
    if (isDelegated) {
      return decision(true, AUTHORIZATION_REASONS.DELEGATED_PROVIDER);
    }

    return decision(false, AUTHORIZATION_REASONS.NOT_AUTHORIZED_PROVIDER);
  }

  /**
   * Append-only insert into amendment_attempts (attempted_at = DB current timestamp).
   * @returns {Promise<{ id: number }>}
   */
  async function logAmendmentAttempt(prescriptionId, requestingProviderId, allowed, reason) {
    if (typeof allowed !== 'boolean') {
      throw new TypeError('allowed must be a boolean');
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError('reason must be a non-empty string');
    }
    const [result] = await pool.execute(INSERT_ATTEMPT_SQL, [
      toLogId(prescriptionId),
      toLogId(requestingProviderId),
      allowed,
      reason,
    ]);
    return { id: result.insertId };
  }

  return Object.freeze({ canAmend, logAmendmentAttempt });
}

module.exports = { createAuthorization, AUTHORIZATION_REASONS };
