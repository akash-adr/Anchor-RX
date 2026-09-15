'use strict';

/**
 * Anchor Rx — Module 10: merged audit timeline for one prescription. READ + ASSEMBLY ONLY: every fact comes from the
 * module that established it; nothing here re-derives integrity, ledger or trust decisions.
 *
 *   version_created / version_amended / version_revoked   Module 3 getFullProvenance → chain (+ diffs for detail)
 *   ledger_anchored                                       Module 4 ledger_entry rows (chainPosition = global sequence_number)
 *   pharmacy_scan                                         Module 6 verification_event, joined through prescription_version_id
 *     └─ trustDecision (nested)                           Module 9 trust_decision_log, matched ONLY by verification_event_id FK
 *   medicine_dispensed                                    Module 14 dispensing_record, joined to its prescription_medicine row
 *                                                         (medicine name as stored) and prescription_version
 *
 * Every timestamp goes through normalizeTimestamp (epoch ms) before sorting; the timeline is sorted ascending by it.
 * Events sharing a millisecond (a version and its ledger anchor are written in one transaction) are ordered
 * deterministically: version event → ledger anchor → pharmacy scan → medicine dispensed, then version number, then
 * source id.
 *
 * Returns { prescriptionId, currentStatus, timeline, unlinkedTrustDecisions }:
 *   timeline item: { eventType, versionNumber, timestamp, detail, trustDecision? }  (trustDecision only on scans that have one)
 *   unlinkedTrustDecisions: decisions for this prescription whose scan is not on this timeline (normally empty) —
 *     surfaced rather than silently dropped.
 * Not on the timeline: scans with no prescription_version_id (malformed_qr / unknown_prescription) — they cannot be
 * joined to a version of this prescription.
 */

const { createAmendmentService } = require('../versioning/amendmentService');
const { normalizeTimestamp } = require('./normalizeTimestamp');

const EVENT_TYPES = Object.freeze({
  VERSION_CREATED: 'version_created',
  VERSION_AMENDED: 'version_amended',
  VERSION_REVOKED: 'version_revoked',
  LEDGER_ANCHORED: 'ledger_anchored',
  PHARMACY_SCAN: 'pharmacy_scan',
  MEDICINE_DISPENSED: 'medicine_dispensed',
});

const SAME_INSTANT_ORDER = Object.freeze({
  [EVENT_TYPES.VERSION_CREATED]: 0,
  [EVENT_TYPES.VERSION_AMENDED]: 0,
  [EVENT_TYPES.VERSION_REVOKED]: 0,
  [EVENT_TYPES.LEDGER_ANCHORED]: 1,
  [EVENT_TYPES.PHARMACY_SCAN]: 2,
  [EVENT_TYPES.MEDICINE_DISPENSED]: 3,
});

const LEDGER_SQL = `
  SELECT ledger_entry_id, sequence_number, version_number, integrity_root, previous_entry_hash, entry_hash,
         anchored_at, anchor_type
    FROM ledger_entry
   WHERE prescription_id = ?
   ORDER BY sequence_number`;

// verification_event has no prescription_id: join through the internal version row id.
const SCANS_SQL = `
  SELECT ve.event_id, ve.pharmacy_id, ve.result, ve.\`timestamp\`, pv.version_number
    FROM verification_event ve
    JOIN prescription_version pv ON pv.id = ve.prescription_version_id
   WHERE pv.prescription_id = ?
   ORDER BY ve.event_id`;

// Every decision tied to one of this prescription's scans (by FK) or recorded against this prescription.
const DECISIONS_SQL = `
  SELECT d.decision_id, d.prescription_id, d.version_number, d.pharmacy_id, d.verification_event_id,
         d.trust_decision, d.primary_reason, d.risk_score, d.risk_band, d.decided_at
    FROM trust_decision_log d
   WHERE d.prescription_id = ?
      OR d.verification_event_id IN (
           SELECT ve.event_id
             FROM verification_event ve
             JOIN prescription_version pv ON pv.id = ve.prescription_version_id
            WHERE pv.prescription_id = ?)
   ORDER BY d.decision_id`;

// dispensing_record has no prescription_id: join through its version row; the medicine join is the composite FK.
const DISPENSED_SQL = `
  SELECT dr.dispensing_id, dr.medicine_id, dr.quantity_dispensed, dr.dispensed_at, dr.dispensed_by,
         pm.sequence_number, pm.drug_name, pv.version_number
    FROM dispensing_record dr
    JOIN prescription_medicine pm ON pm.medicine_id = dr.medicine_id AND pm.prescription_version_id = dr.prescription_version_id
    JOIN prescription_version pv ON pv.id = dr.prescription_version_id
   WHERE pv.prescription_id = ?
   ORDER BY dr.dispensing_id`;

class AuditTimelineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditTimelineError';
    this.code = code;
  }
}

function versionSnapshot(row) {
  return {
    status: row.status,
    providerId: row.provider_id,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    route: row.route,
    // Module 14: every medicine of this version, in sequence (submission) order — as stored, not verified.
    medicines: (row.medicines || []).map((medicine) => ({
      sequenceNumber: medicine.sequence_number,
      drugName: medicine.drug_name,
      drugClass: medicine.drug_class,
      dosageValue: medicine.dosage_value, // exact DECIMAL string
      dosageUnit: medicine.dosage_unit,
      frequency: medicine.frequency,
      durationDays: medicine.duration_days,
      quantityPrescribed: medicine.quantity_prescribed,
    })),
    integrityRoot: row.integrity_root,
    ledgerAnchorRef: row.ledger_anchor_ref,
  };
}

function toVersionEvents({ prescriptionId, chain, diffs }) {
  if (chain[0].version_number !== 1) {
    throw new AuditTimelineError('PROVENANCE_INCOMPLETE', `${prescriptionId} chain does not start at version 1`);
  }
  const diffByToVersion = new Map(diffs.map((diff) => [diff.toVersion, diff]));

  return chain.map((row) => {
    const base = { versionNumber: row.version_number, timestamp: normalizeTimestamp(row.created_at), sortId: row.version_number };

    if (row.version_number === 1) {
      return { ...base, eventType: EVENT_TYPES.VERSION_CREATED, detail: versionSnapshot(row) };
    }

    const diff = diffByToVersion.get(row.version_number);
    if (!diff) {
      throw new AuditTimelineError('PROVENANCE_INCOMPLETE', `${prescriptionId} v${row.version_number} has no diff in Module 3 provenance`);
    }

    if (row.status === 'revoked') {
      return {
        ...base,
        eventType: EVENT_TYPES.VERSION_REVOKED,
        detail: { fromVersion: diff.fromVersion, revoked: diff.revoked, revokedBy: diff.revokedBy, revokedReason: diff.revokedReason },
      };
    }

    return {
      ...base,
      eventType: EVENT_TYPES.VERSION_AMENDED,
      detail: {
        fromVersion: diff.fromVersion,
        changedFields: diff.changedFields,
        amendedBy: diff.amendedBy,
        reason: row.reason, // Module 3's diff omits the reason; it lives on the chain row
        ...versionSnapshot(row),
      },
    };
  });
}

function toLedgerEvent(row) {
  const chainPosition = Number(row.sequence_number);
  return {
    eventType: EVENT_TYPES.LEDGER_ANCHORED,
    versionNumber: row.version_number,
    timestamp: normalizeTimestamp(row.anchored_at),
    detail: {
      ledgerEntryId: row.ledger_entry_id,
      entryHash: row.entry_hash,
      previousEntryHash: row.previous_entry_hash,
      integrityRoot: row.integrity_root,
      anchorType: row.anchor_type,
      chainPosition, // position in the GLOBAL ledger (Module 4 sequence_number), not among this prescription's entries
    },
    sortId: chainPosition,
  };
}

function toTrustDecision(row) {
  return {
    decisionId: Number(row.decision_id),
    trustDecision: row.trust_decision,
    primaryReason: row.primary_reason,
    riskScore: row.risk_score,
    riskBand: row.risk_band,
    evaluatedVersionNumber: row.version_number, // for a stale scan, the current version that was evaluated
    pharmacyId: row.pharmacy_id,
    decidedAt: normalizeTimestamp(row.decided_at),
  };
}

function toScanEvent(row, decisionsByEventId) {
  const eventId = Number(row.event_id);
  const event = {
    eventType: EVENT_TYPES.PHARMACY_SCAN,
    versionNumber: row.version_number, // the version the QR pointed at
    timestamp: normalizeTimestamp(row.timestamp),
    detail: { eventId, pharmacyId: row.pharmacy_id, scanResult: row.result },
    sortId: eventId,
  };
  const decision = decisionsByEventId.get(eventId);
  if (decision) event.trustDecision = toTrustDecision(decision);
  return event;
}

function toDispensedEvent(row) {
  const dispensingId = Number(row.dispensing_id);
  return {
    eventType: EVENT_TYPES.MEDICINE_DISPENSED,
    versionNumber: row.version_number,
    timestamp: normalizeTimestamp(row.dispensed_at),
    detail: {
      dispensingId,
      medicineId: Number(row.medicine_id),
      sequenceNumber: row.sequence_number,
      drugName: row.drug_name, // as stored on the medicine row
      quantityDispensed: Number(row.quantity_dispensed),
      pharmacyId: row.dispensed_by,
    },
    sortId: dispensingId,
  };
}

function compareEvents(a, b) {
  return (
    a.timestamp - b.timestamp ||
    SAME_INSTANT_ORDER[a.eventType] - SAME_INSTANT_ORDER[b.eventType] ||
    a.versionNumber - b.versionNumber ||
    a.sortId - b.sortId
  );
}

function createAuditTimeline(pool, { amendmentService = createAmendmentService(pool) } = {}) {
  /**
   * @param {string} prescriptionId
   * @returns {Promise<{prescriptionId: string, currentStatus: string, timeline: object[], unlinkedTrustDecisions: object[]}>}
   * @throws {AmendmentError} PRESCRIPTION_NOT_FOUND (from Module 3)
   * @throws {AuditTimelineError} INVALID_PRESCRIPTION_ID | PROVENANCE_INCOMPLETE | DUPLICATE_TRUST_DECISION
   */
  async function getMergedTimeline(prescriptionId) {
    if (typeof prescriptionId !== 'string' || prescriptionId.trim() === '') {
      throw new AuditTimelineError('INVALID_PRESCRIPTION_ID', 'prescriptionId must be a non-empty string');
    }

    const provenance = await amendmentService.getFullProvenance(prescriptionId);
    const [[ledgerRows], [scanRows], [decisionRows], [dispensedRows]] = await Promise.all([
      pool.query(LEDGER_SQL, [prescriptionId]),
      pool.query(SCANS_SQL, [prescriptionId]),
      pool.query(DECISIONS_SQL, [prescriptionId, prescriptionId]),
      pool.query(DISPENSED_SQL, [prescriptionId]),
    ]);

    // Nest decisions under scans strictly by the verification_event_id foreign key.
    const scanEventIds = new Set(scanRows.map((row) => Number(row.event_id)));
    const decisionsByEventId = new Map();
    const unlinkedTrustDecisions = [];
    for (const row of decisionRows) {
      const eventId = row.verification_event_id === null ? null : Number(row.verification_event_id);
      if (eventId === null || !scanEventIds.has(eventId)) {
        unlinkedTrustDecisions.push({ ...toTrustDecision(row), verificationEventId: eventId });
        continue;
      }
      if (decisionsByEventId.has(eventId)) {
        throw new AuditTimelineError('DUPLICATE_TRUST_DECISION', `verification_event ${eventId} has more than one trust decision`);
      }
      decisionsByEventId.set(eventId, row);
    }

    const events = [
      ...toVersionEvents(provenance),
      ...ledgerRows.map(toLedgerEvent),
      ...scanRows.map((row) => toScanEvent(row, decisionsByEventId)),
      ...dispensedRows.map(toDispensedEvent),
    ].sort(compareEvents);

    const timeline = events.map(({ sortId, ...event }) => event);
    const latest = provenance.chain[provenance.chain.length - 1];

    return { prescriptionId: provenance.prescriptionId, currentStatus: latest.status, timeline, unlinkedTrustDecisions };
  }

  return Object.freeze({ getMergedTimeline });
}

module.exports = { createAuditTimeline, AuditTimelineError, EVENT_TYPES };
