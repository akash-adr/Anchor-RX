'use strict';

const express = require('express');
const { toCreateInput, toAmendChanges, presentVersion, presentDiff } = require('../presenters');
const { handleCreateError, handleChangeError, handleReadError } = require('../errors');

/**
 * Thin HTTP wrappers — no business logic here. Authorization, validation, hashing and anchoring all
 * happen in the repository / amendment service these call.
 *
 * NOTE: no authentication yet (Module 11). requestingProviderId / providerId are taken from the body.
 */
function createPrescriptionRouter({ repository, amendmentService }) {
  const router = express.Router();

  router.post('/', async (req, res, next) => {
    try {
      const row = await repository.createPrescription(toCreateInput(req.body));
      res.status(201).json({
        prescriptionId: row.prescription_id,
        versionNumber: row.version_number,
        integrityRoot: row.integrity_root,
        ledgerAnchorRef: row.ledger_anchor_ref,
      });
    } catch (err) {
      handleCreateError(err, res, next);
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
      res.json({ versionNumber: row.version_number, diff: presentDiff(diff) });
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

  return router;
}

module.exports = { createPrescriptionRouter };
