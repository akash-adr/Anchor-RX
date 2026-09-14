'use strict';

const { getPool } = require('../connection');
const {
  createPrescriptionVersionRepository,
  RepositoryError,
} = require('./prescriptionVersionRepository');

let prescriptionVersionRepository;

function getPrescriptionVersionRepository() {
  if (!prescriptionVersionRepository) {
    prescriptionVersionRepository = createPrescriptionVersionRepository(getPool());
  }
  return prescriptionVersionRepository;
}

module.exports = {
  getPrescriptionVersionRepository,
  createPrescriptionVersionRepository,
  RepositoryError,
};
