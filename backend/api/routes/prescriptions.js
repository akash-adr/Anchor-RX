'use strict';

const express = require('express');
const { toCreateInput, toAmendChanges, presentMedicine, presentVersion, presentDiff } = require('../presenters');
const { ApiError, handleCreateError, handleChangeError, handleReadError, handleRiskPreviewError } = require('../errors');
const { buildVersionQr } = require('../../qr/qrEngine');

/**
 * QR for a version that is ALREADY committed and anchored. Regenerated per request, never stored.
 * A failure here must not turn a successful create/amend into an error response (the doctor would
 * assume nothing happened and create a duplicate), so it degrades to null and is logged.
 */
async function versionQr(row) {
  try {
    return await buildVersionQr(row);
  } catch (err) {
    console.error(`[api] QR generation failed for ${row.prescription_id} v${row.version_number}:`, err);
    return { qrPayload: null, qrImage: null };
  }
}

/**
 * Thin HTTP wrappers — no business logic here. Authorization, validation, hashing and anchoring all
 * happen in the repository / amendment service these call.
 *
 * NOTE: no authentication yet (Module 11). requestingProviderId / providerId are taken from the body.
 */
async function createdResponse(row) {
  const { qrPayload, qrImage } = await versionQr(row);
  return {
    prescriptionId: row.prescription_id,
    versionNumber: row.version_number,
    integrityRoot: row.integrity_root,
    ledgerAnchorRef: row.ledger_anchor_ref,
    medicines: row.medicines.map(presentMedicine), // medicineId values are needed to amend this version
    qrPayload,
    qrImage,
  };
}

function createPrescriptionRouter({ repository, amendmentService, prescriptionDocuments, riskPreview }) {
  const router = express.Router();

  // Creates WITHOUT locked risk. Kept for the current Doctor Portal until it moves to preview → confirm (Module 15).
  router.post('/', async (req, res, next) => {
    try {
      const row = await repository.createPrescription(toCreateInput(req.body));
      res.status(201).json(await createdResponse(row));
    } catch (err) {
      handleCreateError(err, res, next);
    }
  });

  /**
   * Module 15 step 1 of 2: score every medicine, cache the result, save NOTHING.
   * Body: the create body. → { previewToken, medicines: [{ drugName, riskScore, riskBand, reasons }] }
   */
  router.post('/preview-risk', async (req, res, next) => {
    try {
      res.json(await riskPreview.previewRisk(toCreateInput(req.body)));
    } catch (err) {
      handleRiskPreviewError(err, res, next);
    }
  });

  /**
   * Module 15 step 2 of 2: create the previewed prescription with its cached risk locked per medicine.
   * Body: { previewToken } ONLY — the prescription data and risk come from the server-side cache, never the client.
   * 410 RISK_PREVIEW_EXPIRED when the token is expired, already used, or unknown.
   */
  router.post('/confirm', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const extra = Object.keys(body).filter((key) => key !== 'previewToken');
      if (extra.length > 0) {
        throw new ApiError(400, 'FIELD_NOT_ALLOWED', `confirm accepts only previewToken; the previewed prescription is used as-is (got: ${extra.join(', ')})`);
      }
      const row = await riskPreview.confirmPrescription(body.previewToken);
      res.status(201).json(await createdResponse(row));
    } catch (err) {
      handleRiskPreviewError(err, res, next);
    }
  });

  router.post('/:prescriptionId/amend', async (req, res, next) => {
    const { prescriptionId } = req.params;
    const { requestingProviderId, changes, reason } = req.body ?? {};
    try {
      const row = await amendmentService.amendPrescriptionAuthorized(
        prescriptionId,
        toAmendChanges(changes),
        requestingProviderId,
        reason,
      );
      // The new version's parent is always version_number - 1.
      const diff = await amendmentService.diffVersions(prescriptionId, row.version_number - 1, row.version_number);
      const { qrPayload, qrImage } = await versionQr(row);
      res.json({ versionNumber: row.version_number, diff: presentDiff(diff), medicines: row.medicines.map(presentMedicine), qrPayload, qrImage });
    } catch (err) {
      handleChangeError(err, res, next);
    }
  });

  router.post('/:prescriptionId/revoke', async (req, res, next) => {
    const { prescriptionId } = req.params;
    const { providerId, reason } = req.body ?? {};
    try {
      const row = await amendmentService.revokePrescription(prescriptionId, providerId, reason);
      res.json({ versionNumber: row.version_number, status: row.status });
    } catch (err) {
      handleChangeError(err, res, next);
    }
  });

  router.get('/:prescriptionId/provenance', async (req, res, next) => {
    try {
      const { prescriptionId, chain, diffs } = await amendmentService.getFullProvenance(req.params.prescriptionId);
      res.json({ prescriptionId, versions: chain.map(presentVersion), diffs: diffs.map(presentDiff) });
    } catch (err) {
      handleReadError(err, res, next);
    }
  });

  /**
   * Everything needed to render a printable document for ONE exact version (the PDF itself is built client-side).
   * The QR is regenerated from the version's stored created_at, so it matches the QR issued with that version.
   * 404 VERSION_NOT_FOUND if that prescriptionId + versionNumber doesn't exist; 400 INVALID_VERSION if not a positive integer.
   */
  router.get('/:prescriptionId/versions/:versionNumber/document', async (req, res, next) => {
    const { prescriptionId, versionNumber } = req.params;
    try {
      if (!/^[1-9]\d{0,8}$/.test(versionNumber)) {
        throw new ApiError(400, 'INVALID_VERSION', 'versionNumber must be a positive integer');
      }
      const document = await prescriptionDocuments.getPrescriptionDocument(prescriptionId, Number(versionNumber));
      if (!document) {
        throw new ApiError(404, 'VERSION_NOT_FOUND', `${prescriptionId} has no version ${versionNumber}`);
      }
      res.json(document);
    } catch (err) {
      handleReadError(err, res, next);
    }
  });

  return router;
}

module.exports = { createPrescriptionRouter };
