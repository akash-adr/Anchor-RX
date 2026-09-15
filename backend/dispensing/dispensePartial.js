'use strict';

/**
 * Anchor Rx — Module 14: partial dispensing, per medicine.
 *
 * dispensePartial(prescriptionVersionId, medicineId, quantity, pharmacyId) records that a pharmacy handed over `quantity`
 * units of ONE medicine. Every rule is enforced HERE, server-side — the Pharmacy Portal's disabled inputs are
 * convenience only:
 *
 *   1. the medicine row must belong to that prescription version (quantity_prescribed comes from it)
 *   2. alreadyGiven = SUM(dispensing_record.quantity_dispensed) for this medicine_id
 *   3. remaining    = quantity_prescribed − alreadyGiven
 *   4. reject quantity ≤ 0, non-integer, or > remaining
 *   5. a FRESH Module 2 verifyIntegrity over the version's full stored data; any tamperedFields entry starting with
 *      "medicine_{this medicine's sequence_number}." rejects THIS medicine only. Other medicines of the same prescription
 *      stay dispensable. This check is deliberately narrow and independent: it never reads Module 9's
 *      trust_decision_log or the scan result — it is layered on top of whatever the scan/trust decision said.
 *   6. insert one dispensing_record row
 *
 * Also rejected (beyond the rules above): unknown pharmacy; a version that is not the current active version
 * (superseded or revoked — dispensing is always against the current version); integrity data too corrupted to check.
 *
 * Concurrency: steps 1–6 run in ONE transaction that locks the medicine row (SELECT … FOR UPDATE), so two simultaneous
 * dispenses of the same medicine are serialized and can never together exceed quantity_prescribed.
 *
 * Known scope limit: prescription-level tampered fields (patient_id, provider_id, height_cm, weight_kg) do not block
 * dispensing here — only medicine-tagged fields do, as specified. Those are caught by the scan result (tampered).
 */

const hashEngine = require('../integrity/hashEngine');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');

const DISPENSING_REJECTIONS = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  UNKNOWN_PHARMACY: 'UNKNOWN_PHARMACY',
  MEDICINE_NOT_FOUND: 'MEDICINE_NOT_FOUND',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  VERSION_NOT_DISPENSABLE: 'VERSION_NOT_DISPENSABLE',
  EXCEEDS_REMAINING: 'EXCEEDS_REMAINING',
  MEDICINE_TAMPERED: 'MEDICINE_TAMPERED',
  INTEGRITY_UNVERIFIABLE: 'INTEGRITY_UNVERIFIABLE',
});

const DISPENSABLE_STATUS = 'active';

class DispensingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DispensingError';
    this.code = code;
    if (details) this.details = details;
  }
}

// Lock the medicine row for the whole transaction: every dispense of this medicine queues behind it.
const LOCK_MEDICINE_SQL = `
  SELECT pm.medicine_id, pm.sequence_number, pm.drug_name, pm.quantity_prescribed,
         pv.id AS prescription_version_id, pv.prescription_id, pv.version_number, pv.status
    FROM prescription_medicine pm
    JOIN prescription_version pv ON pv.id = pm.prescription_version_id
   WHERE pm.medicine_id = ? AND pm.prescription_version_id = ?
     FOR UPDATE`;

// A LOCKING read on purpose. Under InnoDB REPEATABLE READ a plain SELECT reads the transaction's snapshot, which was fixed
// by the first plain read (the pharmacy lookup) — BEFORE this transaction waited on the medicine lock. A concurrent
// dispense that committed meanwhile would be invisible and both could pass the remaining check. FOR UPDATE reads the
// latest committed rows (and locks them), so every waiting dispense sums what was actually given.
const ALREADY_GIVEN_SQL = 'SELECT COALESCE(SUM(quantity_dispensed), 0) AS given FROM dispensing_record WHERE medicine_id = ? FOR UPDATE';

const GIVEN_BY_MEDICINE_SQL = `
  SELECT medicine_id, COALESCE(SUM(quantity_dispensed), 0) AS given
    FROM dispensing_record
   WHERE prescription_version_id = ?
   GROUP BY medicine_id`;

const INSERT_DISPENSING_SQL =
  'INSERT INTO dispensing_record (prescription_version_id, medicine_id, quantity_dispensed, dispensed_by) VALUES (?, ?, ?, ?)';

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

/** medicine hash-key prefix for one medicine, e.g. "medicine_2." */
const medicinePrefix = (sequenceNumber) => `${hashEngine.medicineHashKey(sequenceNumber, '')}`;

/**
 * The same Module 2 call Module 6 uses (verifyIntegrity with the row's stored hashes and salt) — no new hashing logic.
 * Integrity data so corrupted it cannot even be recomputed is reported as unverifiable, never thrown.
 */
function checkIntegrity(versionRow) {
  try {
    const { tamperedFields } = hashEngine.verifyIntegrity(versionRow, versionRow.field_hashes, versionRow.salt);
    return { unverifiable: false, tamperedFields };
  } catch (err) {
    return { unverifiable: true, tamperedFields: [], error: err.message };
  }
}

/** The tamperedFields entries that belong to one medicine (by its sequence_number). */
function tamperedFieldsForMedicine(tamperedFields, sequenceNumber) {
  const prefix = medicinePrefix(sequenceNumber);
  return tamperedFields.filter((field) => field.startsWith(prefix));
}

function createDispensing(pool, { repository = createPrescriptionVersionRepository(pool) } = {}) {
  /**
   * @param {number} prescriptionVersionId prescription_version.id (internal row id)
   * @param {number} medicineId prescription_medicine.medicine_id of that version
   * @param {number} quantity units to dispense now (positive integer)
   * @param {string} pharmacyId e.g. "PHM-001"
   * @returns {Promise<{ medicineId: number, prescribed: number, alreadyGiven: number, remaining: number }>}
   *          alreadyGiven INCLUDES this dispense
   * @throws {DispensingError} see DISPENSING_REJECTIONS
   */
  async function dispensePartial(prescriptionVersionId, medicineId, quantity, pharmacyId) {
    if (!isPositiveSafeInteger(prescriptionVersionId) || !isPositiveSafeInteger(medicineId)) {
      throw new DispensingError(DISPENSING_REJECTIONS.INVALID_INPUT, 'prescriptionVersionId and medicineId must be positive integers');
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new DispensingError(DISPENSING_REJECTIONS.INVALID_QUANTITY, `quantity must be a whole number greater than 0, got ${JSON.stringify(quantity)}`);
    }
    if (typeof pharmacyId !== 'string' || pharmacyId === '') {
      throw new DispensingError(DISPENSING_REJECTIONS.UNKNOWN_PHARMACY, `Unknown pharmacyId: ${JSON.stringify(pharmacyId)}`);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [pharmacies] = await conn.execute('SELECT pharmacy_id FROM pharmacy WHERE pharmacy_id = ?', [pharmacyId]);
      if (!pharmacies.some((row) => row.pharmacy_id === pharmacyId)) {
        throw new DispensingError(DISPENSING_REJECTIONS.UNKNOWN_PHARMACY, `Unknown pharmacyId: ${JSON.stringify(pharmacyId)}`);
      }

      // 1. The medicine row (locked) — and it must belong to this exact version.
      const [medicineRows] = await conn.execute(LOCK_MEDICINE_SQL, [medicineId, prescriptionVersionId]);
      const medicine = medicineRows[0];
      if (!medicine) {
        throw new DispensingError(
          DISPENSING_REJECTIONS.MEDICINE_NOT_FOUND,
          `Medicine ${medicineId} is not a medicine of prescription version ${prescriptionVersionId}`,
        );
      }
      if (medicine.status !== DISPENSABLE_STATUS) {
        throw new DispensingError(
          DISPENSING_REJECTIONS.VERSION_NOT_DISPENSABLE,
          `${medicine.prescription_id} v${medicine.version_number} is '${medicine.status}'; only the current active version can be dispensed`,
        );
      }

      // 2–3. Quantities, computed from the records — never from the client.
      const [[{ given }]] = await conn.execute(ALREADY_GIVEN_SQL, [medicineId]);
      const prescribed = Number(medicine.quantity_prescribed);
      const alreadyGiven = Number(given);
      const remaining = prescribed - alreadyGiven;

      // 4.
      if (quantity > remaining) {
        throw new DispensingError(
          DISPENSING_REJECTIONS.EXCEEDS_REMAINING,
          `Cannot dispense ${quantity} of ${medicine.drug_name}: only ${remaining} of ${prescribed} remaining (${alreadyGiven} already given)`,
          { prescribed, alreadyGiven, remaining },
        );
      }

      // 5. Fresh, medicine-scoped integrity check at the moment of dispensing.
      const versionRow = await repository.getVersionById(prescriptionVersionId);
      const integrity = checkIntegrity(versionRow);
      if (integrity.unverifiable) {
        throw new DispensingError(
          DISPENSING_REJECTIONS.INTEGRITY_UNVERIFIABLE,
          "This prescription's integrity data could not be checked, so none of its medicines can be dispensed.",
        );
      }
      const tampered = tamperedFieldsForMedicine(integrity.tamperedFields, medicine.sequence_number);
      if (tampered.length > 0) {
        throw new DispensingError(DISPENSING_REJECTIONS.MEDICINE_TAMPERED, "This medicine's data does not match its recorded hash.", {
          tamperedFields: tampered,
        });
      }

      // 6.
      await conn.execute(INSERT_DISPENSING_SQL, [prescriptionVersionId, medicineId, quantity, pharmacyId]);
      await conn.commit();

      // 7.
      return { medicineId, prescribed, alreadyGiven: alreadyGiven + quantity, remaining: remaining - quantity };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Display data for the Pharmacy Portal's dispensing table: every medicine of one version with its quantities and
   * the SAME fresh medicine-scoped integrity check dispensePartial runs. Advisory only — dispensePartial re-checks
   * everything at the moment of dispensing.
   * @returns {Promise<object|null>} null when that version does not exist
   */
  async function getDispensingStatus(prescriptionId, versionNumber) {
    const version = await repository.getVersion(prescriptionId, versionNumber);
    if (!version) return null;

    const [givenRows] = await pool.execute(GIVEN_BY_MEDICINE_SQL, [version.id]);
    const givenByMedicine = new Map(givenRows.map((row) => [Number(row.medicine_id), Number(row.given)]));
    const integrity = checkIntegrity(version);
    const dispensableVersion = version.status === DISPENSABLE_STATUS;

    return {
      prescriptionId: version.prescription_id,
      versionNumber: version.version_number,
      prescriptionVersionId: version.id,
      status: version.status,
      dispensableVersion,
      integrityUnverifiable: integrity.unverifiable,
      medicines: version.medicines.map((medicine) => {
        const prescribed = Number(medicine.quantity_prescribed);
        const alreadyGiven = givenByMedicine.get(medicine.medicine_id) ?? 0;
        const tamperedFields = tamperedFieldsForMedicine(integrity.tamperedFields, medicine.sequence_number);
        return {
          medicineId: medicine.medicine_id,
          sequenceNumber: medicine.sequence_number,
          drugName: medicine.drug_name, // as stored — may itself be the tampered value (see tamperedFields)
          dosageValue: medicine.dosage_value,
          dosageUnit: medicine.dosage_unit,
          frequency: medicine.frequency,
          prescribed,
          alreadyGiven,
          remaining: prescribed - alreadyGiven,
          tampered: tamperedFields.length > 0 || integrity.unverifiable,
          tamperedFields,
        };
      }),
    };
  }

  return Object.freeze({ dispensePartial, getDispensingStatus });
}

module.exports = { createDispensing, DispensingError, DISPENSING_REJECTIONS, tamperedFieldsForMedicine };
