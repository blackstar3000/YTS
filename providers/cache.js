"use strict";

const fs = require("fs").promises;
const path = require("path");

const CACHE_FILE = path.join(__dirname, "cache.json");
const MAX_CACHE_SIZE = 1000;
let cache = {};
let savePending = false;
let cacheInitialized = false;
const inFlight = new Map(); // deduplicates concurrent fetches for the same key

async function initCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf8");
    cache = JSON.parse(data);
  } catch {}
  cacheInitialized = true;
}

const initPromise = initCache();

async function saveCache() {
  if (savePending) return;
  savePending = true;
  setTimeout(async () => {
    try {
      await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
    } catch (err) {
      console.error("❌ Cache write error:", err.message);
    } finally {
      savePending = false;
    }
  }, 500);
}

async function cached(key, ttlMs, fn) {
  if (!cacheInitialized) await initPromise;

  const now = Date.now();
  const entry = cache[key];

  // Return fresh cache hit immediately
  if (entry && now - entry.ts < ttlMs) {
    entry.ts = now;
    return entry.value;
  }

  // If a fetch is already in progress for this key, wait for it
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = (async () => {
    try {
      const value = await fn();

      // LRU eviction
      if (Object.keys(cache).length >= MAX_CACHE_SIZE) {
        const oldestKey = Object.keys(cache).reduce((a, b) =>
          cache[a].ts < cache[b].ts ? a : b,
        );
        delete cache[oldestKey];
      }

      cache[key] = { ts: Date.now(), value };
      saveCache();
      return value;
    } catch (err) {
      // Serve stale cache on error, but only if less than 1 hour old
      const MAX_STALE_MS = 60 * 60 * 1000;
      if (entry && Date.now() - entry.ts < MAX_STALE_MS) {
        console.warn("⚠️ Using stale cache for", key);
        return entry.value;
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

module.exports = { cached };
