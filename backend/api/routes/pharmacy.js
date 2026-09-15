'use strict';

const express = require('express');
const { PharmacyVerificationError } = require('../../qr/pharmacyVerification');

/**
 * Pharmacy endpoints. Thin wrappers only — verifyScan (Module 6) does all verification and logging.
 * NOTE: no authentication yet (Module 11); pharmacyId comes from the request body.
 * No Dispense/Review/Block decision is returned here — that is Module 9.
 */
function createPharmacyRouter({ pool, pharmacyVerification }) {
  const router = express.Router();

  router.get('/pharmacies', async (req, res) => {
    const [rows] = await pool.query('SELECT pharmacy_id, name FROM pharmacy ORDER BY pharmacy_id');
    res.json(rows.map((row) => ({ pharmacyId: row.pharmacy_id, name: row.name })));
  });

  /**
   * Every scan outcome verifyScan handles (malformed_qr, unknown_prescription, …, verified) is a normal
   * 200 response. An unknown pharmacy is a 400 (not a scan result). Anything else unexpected falls through
   * to the error middleware → 500 { error: true, reason: "INTERNAL_ERROR" }.
   */
  router.post('/scan', async (req, res, next) => {
    const { qrPayloadRaw, pharmacyId } = req.body ?? {};
    try {
      res.json(await pharmacyVerification.verifyScan(qrPayloadRaw, pharmacyId));
    } catch (err) {
      if (err instanceof PharmacyVerificationError) {
        return res.status(400).json({ error: true, reason: err.code, message: err.message });
      }
      return next(err);
    }
  });

  return router;
}

module.exports = { createPharmacyRouter };
