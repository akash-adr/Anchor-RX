'use strict';

const express = require('express');
const { DispensingError, DISPENSING_REJECTIONS } = require('../../dispensing/dispensePartial');
const { ApiError, handleReadError } = require('../errors');

/**
 * Module 14 dispensing endpoints. Thin wrappers — every rule lives in dispensing/dispensePartial.js.
 * NOTE: no authentication yet (Module 11); pharmacyId comes from the request body.
 */

const STATUS_BY_CODE = Object.freeze({
  [DISPENSING_REJECTIONS.INVALID_INPUT]: 400,
  [DISPENSING_REJECTIONS.INVALID_QUANTITY]: 400,
  [DISPENSING_REJECTIONS.UNKNOWN_PHARMACY]: 400,
  [DISPENSING_REJECTIONS.MEDICINE_NOT_FOUND]: 404,
  [DISPENSING_REJECTIONS.VERSION_NOT_FOUND]: 404,
  [DISPENSING_REJECTIONS.VERSION_NOT_DISPENSABLE]: 409,
  [DISPENSING_REJECTIONS.EXCEEDS_REMAINING]: 409,
  [DISPENSING_REJECTIONS.MEDICINE_TAMPERED]: 409,
  [DISPENSING_REJECTIONS.INTEGRITY_UNVERIFIABLE]: 409,
});

function createDispensingRouter({ dispensing }) {
  const router = express.Router();

  /** Per-medicine quantities + the fresh medicine-scoped integrity flags, for one exact version. */
  router.get('/dispensing/:prescriptionId/versions/:versionNumber', async (req, res, next) => {
    const { prescriptionId, versionNumber } = req.params;
    try {
      if (!/^[1-9]\d{0,8}$/.test(versionNumber)) {
        throw new ApiError(400, 'INVALID_VERSION', 'versionNumber must be a positive integer');
      }
      const status = await dispensing.getDispensingStatus(prescriptionId, Number(versionNumber));
      if (!status) throw new ApiError(404, 'VERSION_NOT_FOUND', `${prescriptionId} has no version ${versionNumber}`);
      res.json(status);
    } catch (err) {
      handleReadError(err, res, next);
    }
  });

  /** Body: { prescriptionVersionId, medicineId, quantity, pharmacyId }. Values are passed through unparsed. */
  router.post('/dispense', async (req, res, next) => {
    const { prescriptionVersionId, medicineId, quantity, pharmacyId } = req.body ?? {};
    try {
      res.status(201).json(await dispensing.dispensePartial(prescriptionVersionId, medicineId, quantity, pharmacyId));
    } catch (err) {
      if (err instanceof DispensingError) {
        const body = { error: true, reason: err.code, message: err.message };
        if (err.details) body.details = err.details;
        return res.status(STATUS_BY_CODE[err.code] ?? 400).json(body);
      }
      return next(err);
    }
  });

  return router;
}

module.exports = { createDispensingRouter };
