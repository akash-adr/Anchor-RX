'use strict';

/**
 * GET /api/drug-reference — passthrough + in-memory cache over the AI service's GET /drug-reference.
 * The AI service is a stub fetch (counted); no database is touched.
 */

const express = require('express');
const { createDrugReferenceSource, createDrugReferenceRouter, DEFAULT_TTL_MS } = require('../api/routes/drugReference');

const TABLE = {
  Amoxicillin: { dose_min: 250, dose_max: 500, dosage_unit: 'mg', dose_per_kg_max: 25, freq_min: 2, freq_max: 3, dur_min: 5, dur_max: 14, drug_class: 'antibiotic' },
  Diphenhydramine: { dose_min: 10, dose_max: 20, dosage_unit: 'ml', dose_per_kg_max: 0.4, freq_min: 3, freq_max: 4, dur_min: 3, dur_max: 7, drug_class: 'antihistamine' },
};

let server;
let baseUrl;
let clock;
let upstream; // 'ok' | 'down' | 'http500'
const fetchImpl = jest.fn(async (url) => {
  if (upstream === 'down') throw new TypeError('fetch failed');
  if (upstream === 'http500') return new Response('boom', { status: 500 });
  return new Response(JSON.stringify(TABLE), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

beforeEach(async () => {
  clock = 1_000_000;
  upstream = 'ok';
  fetchImpl.mockClear();
  const drugReferenceSource = createDrugReferenceSource({ baseUrl: 'http://ai.test/', fetchImpl, now: () => clock });
  const app = express();
  app.use('/api', createDrugReferenceRouter({ drugReferenceSource }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = async () => {
  const response = await fetch(`${baseUrl}/api/drug-reference`);
  return { status: response.status, body: await response.json() };
};

test('relays the AI service body unchanged, from its /drug-reference endpoint', async () => {
  expect(await get()).toEqual({ status: 200, body: TABLE });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toBe('http://ai.test/drug-reference');
});

test('caches in memory: repeat and concurrent requests within the TTL make ONE upstream call; after the TTL it refetches', async () => {
  expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
  await Promise.all([get(), get(), get()]);
  clock += DEFAULT_TTL_MS - 1;
  await get();
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  clock += 2;
  expect(await get()).toEqual({ status: 200, body: TABLE });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test.each(['down', 'http500'])('AI service %s → 503 DRUG_REFERENCE_UNAVAILABLE, and the failure is NOT cached', async (mode) => {
  upstream = mode;
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await get()).toMatchObject({ status: 503, body: { reason: 'DRUG_REFERENCE_UNAVAILABLE' } });
  } finally {
    spy.mockRestore();
  }
  upstream = 'ok';
  expect(await get()).toEqual({ status: 200, body: TABLE }); // recovers on the very next request
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
