'use strict';

/** Module 15 Step 2 — previewCache unit tests (no database). A controllable clock stands in for real time. */

const { createPreviewCache, DEFAULT_TTL_MS } = require('../ml/previewCache');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function clockedCache(options = {}) {
  let time = 1_000_000;
  const cache = createPreviewCache({ now: () => time, ...options });
  return { cache, advance: (ms) => (time += ms) };
}

test('store returns a UUID token; retrieve returns the data once, then null (single use)', () => {
  const { cache } = clockedCache();
  const token = cache.store({ medicines: [{ drugName: 'Ibuprofen', riskScore: 25 }] });

  expect(token).toMatch(UUID_V4);
  expect(cache.retrieve(token)).toEqual({ medicines: [{ drugName: 'Ibuprofen', riskScore: 25 }] });
  expect(cache.retrieve(token)).toBeNull();
});

test('default TTL is 10 minutes: available just before, gone at expiry', () => {
  expect(DEFAULT_TTL_MS).toBe(600_000);
  const { cache, advance } = clockedCache();
  const early = cache.store('early');
  const late = cache.store('late');

  advance(DEFAULT_TTL_MS - 1);
  expect(cache.retrieve(early)).toBe('early');
  advance(1);
  expect(cache.retrieve(late)).toBeNull();
});

test('unknown, malformed and non-string tokens return null', () => {
  const { cache } = clockedCache();
  cache.store('x');
  for (const token of ['00000000-0000-4000-8000-000000000000', 'not-a-token', '', null, undefined, 42, {}]) {
    expect(cache.retrieve(token)).toBeNull();
  }
  expect(cache.size()).toBe(1); // bad lookups never consume a real entry
});

test('expired entries are purged lazily on store/retrieve, so the map does not grow without bound', () => {
  const { cache, advance } = clockedCache({ ttlMs: 1000 });
  for (let i = 0; i < 50; i += 1) cache.store(i);
  expect(cache.size()).toBe(50);

  advance(1000);
  cache.store('fresh'); // store purges
  expect(cache.size()).toBe(1);
});

test('stores a copy: mutating the original object after store() cannot change what is retrieved', () => {
  const { cache } = clockedCache();
  const data = { scores: [{ riskScore: 12 }] };
  const token = cache.store(data);
  data.scores[0].riskScore = 99;
  expect(cache.retrieve(token)).toEqual({ scores: [{ riskScore: 12 }] });
});

test('tokens are unique', () => {
  const { cache } = clockedCache();
  const tokens = new Set(Array.from({ length: 200 }, (_, i) => cache.store(i)));
  expect(tokens.size).toBe(200);
});
