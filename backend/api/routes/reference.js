'use strict';

const express = require('express');
const { ApiError, handleReadError } = require('../errors');
const { wholeYearsBetween } = require('../../ml/buildScoringPayload');

/** Read-only reference data for form dropdowns. Errors fall through to the error middleware (500). */
function createReferenceRouter({ pool, repository }) {
  const router = express.Router();

  router.get('/providers', async (req, res) => {
    const [rows] = await pool.query("SELECT provider_id, name FROM provider WHERE status = 'active' ORDER BY provider_id");
    res.json(rows.map((row) => ({ providerId: row.provider_id, name: row.name })));
  });

  /**
   * Every prescription this provider ORIGINALLY issued (not ones they only amended as a delegate), most recent first.
   * 200 [] when they issued nothing; 404 PROVIDER_NOT_FOUND for an unknown provider. ⚠ No auth yet (Module 11).
   */
  router.get('/providers/:providerId/prescriptions', async (req, res, next) => {
    try {
      const prescriptions = await repository.getPrescriptionsByProvider(req.params.providerId);
      if (prescriptions === null) throw new ApiError(404, 'PROVIDER_NOT_FOUND', `No provider with id ${req.params.providerId}`);
      res.json(prescriptions);
    } catch (err) {
      handleReadError(err, res, next);
    }
  });

  /**
   * dob and age are DISPLAY data for the prescriber. age is derived here with the SAME helper the scoring payload
   * uses, so the portal shows exactly the age the AI is scored with. Age is never accepted from a client and is
   * never stored on a prescription — the patient record's date of birth stays the only source.
   */
  router.get('/patients', async (req, res) => {
    const [rows] = await pool.query('SELECT patient_id, name, dob FROM patient ORDER BY patient_id');
    const now = new Date();
    res.json(rows.map((row) => ({ patientId: row.patient_id, name: row.name, dob: row.dob, age: wholeYearsBetween(row.dob, now) })));
  });

  return router;
}

module.exports = { createReferenceRouter };
