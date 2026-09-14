'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const mysql = require('mysql2/promise');

function createPool(overrides = {}) {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'anchor_rx',
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    // DECIMAL columns come back as strings (mysql2 default) — keeps
    // dosage_value exact for byte-level comparison and hashing in Module 2.
    ...overrides,
  });

  // mysql2 interprets DATETIME/TIMESTAMP text as UTC ('Z'), so the MySQL session must speak UTC too.
  // Without this, a server running in local time (e.g. IST) makes every DB-generated timestamp read
  // back shifted, and ledger entry hashes that include anchored_at would not round-trip.
  // The SET is queued ahead of any other command on each new connection.
  pool.pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });

  return pool;
}

let sharedPool;

function getPool() {
  if (!sharedPool) sharedPool = createPool();
  return sharedPool;
}

async function closePool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

module.exports = { createPool, getPool, closePool };
