'use strict';

/**
 * Anchor Rx — Module 15: short-lived, single-use, in-memory cache for risk previews.
 *
 * store(data)      → UUID token; keeps a deep copy of data until now + ttl (10 minutes by default)
 * retrieve(token)  → the data if present and unexpired, else null. SINGLE USE: the entry is deleted on retrieval.
 *
 * Deliberately simple: no database table, nothing survives a server restart, and each API process has its own cache.
 * That is acceptable for a preview the prescriber confirms within minutes — a lost or expired preview just means the
 * risk assessment is shown again. Expired entries are purged lazily on every store/retrieve (no timers to leak or to
 * keep a process alive), so memory is bounded by the previews created within one TTL window.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createPreviewCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map(); // token → { data, expiresAt }

  function purgeExpired() {
    const current = now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(token);
    }
  }

  function store(data) {
    purgeExpired();
    const token = crypto.randomUUID();
    // A copy: later mutation of the caller's object can never change what gets confirmed.
    entries.set(token, { data: structuredClone(data), expiresAt: now() + ttlMs });
    return token;
  }

  function retrieve(token) {
    purgeExpired();
    if (typeof token !== 'string') return null;
    const entry = entries.get(token);
    if (!entry) return null; // unknown, already used, or expired (purged above)
    entries.delete(token); // single use
    return entry.data;
  }

  /** Live entries (after purging) — for tests and diagnostics. */
  function size() {
    purgeExpired();
    return entries.size;
  }

  return Object.freeze({ store, retrieve, size });
}

module.exports = { createPreviewCache, DEFAULT_TTL_MS };
