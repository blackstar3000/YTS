"use strict";
// LRU in-memory cache + in-flight coalescing + stale-on-error fallback.

const { LRUCache } = require("lru-cache");
const logger = require("./logger");

const STALE_MS = 24 * 60 * 60 * 1000;
const inFlight = new Map();
/** @type {Map<string, { value: unknown, ts: number }>} */
const shadow = new Map();

const lru = new LRUCache({
  max: 2000,
});

function trimShadow() {
  if (shadow.size <= 2500) return;
  const oldest = [...shadow.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < 200 && i < oldest.length; i++) {
    shadow.delete(oldest[i][0]);
  }
}

/**
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function cached(key, ttlMs, fn) {
  const hit = lru.get(key);
  if (hit !== undefined) return hit;

  if (inFlight.has(key)) return /** @type {Promise<T>} */ (inFlight.get(key));

  const fetchPromise = (async () => {
    try {
      const value = await fn();
      const ttl = Math.max(Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60000, 1);
      lru.set(key, value, { ttl });
      shadow.set(key, { value, ts: Date.now() });
      trimShadow();
      return value;
    } catch (err) {
      const entry = shadow.get(key);
      const now = Date.now();
      if (entry && now - entry.ts < STALE_MS) {
        logger.warn({ err: err.message, key }, "cache: serving stale after error");
        return /** @type {T} */ (entry.value);
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, fetchPromise);
  return fetchPromise;
}

module.exports = { cached };
