'use strict';

/**
 * Anchor Rx API — minimal HTTP layer over Modules 1–4.
 *
 * Start: npm run api   (port 4000 by default; API_PORT, DB_NAME and CORS_ORIGINS override)
 */

const express = require('express');
const cors = require('cors');
const { getPool, closePool } = require('../db/connection');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createPrescriptionRouter } = require('./routes/prescriptions');
const { createReferenceRouter } = require('./routes/reference');
const { notFoundHandler, errorMiddleware } = require('./errors');

const DEFAULT_PORT = 4000;
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']; // Vite dev server

function parseCorsOrigins(value) {
  if (!value) return DEFAULT_CORS_ORIGINS;
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

/**
 * Builds the Express app without listening, so tests can mount it on any port and inject services.
 */
function createApp({
  pool,
  repository = createPrescriptionVersionRepository(pool),
  amendmentService = createAmendmentService(pool, { repository }),
  corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/prescriptions', createPrescriptionRouter({ repository, amendmentService }));
  app.use('/api', createReferenceRouter({ pool }));

  app.use(notFoundHandler);
  app.use(errorMiddleware);
  return app;
}

function main() {
  const pool = getPool();
  const port = Number(process.env.API_PORT || DEFAULT_PORT);
  const server = createApp({ pool }).listen(port, () => {
    console.log(`Anchor Rx API listening on http://localhost:${port} (database: ${process.env.DB_NAME || 'anchor_rx'})`);
  });

  const shutdown = () => {
    server.close(() => {
      closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { createApp };
