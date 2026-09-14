'use strict';

const express = require('express');

/** Read-only reference data for form dropdowns. Errors fall through to the error middleware (500). */
function createReferenceRouter({ pool }) {
  const router = express.Router();

  router.get('/providers', async (req, res) => {
    const [rows] = await pool.query("SELECT provider_id, name FROM provider WHERE status = 'active' ORDER BY provider_id");
    res.json(rows.map((row) => ({ providerId: row.provider_id, name: row.name })));
  });

  router.get('/patients', async (req, res) => {
    const [rows] = await pool.query('SELECT patient_id, name FROM patient ORDER BY patient_id');
    res.json(rows.map((row) => ({ patientId: row.patient_id, name: row.name })));
  });

  return router;
}

module.exports = { createReferenceRouter };
