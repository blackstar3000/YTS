"use strict";

const fs = require("fs").promises;
const path = require("path");

const CACHE_FILE = path.join(__dirname, "cache.json");
const MAX_CACHE_SIZE = 2000; // Increased for better Prowlarr performance
let cache = {};
let savePending = false;
let cacheInitialized = false;
const inFlight = new Map();

async function initCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf8");
    cache = JSON.parse(data);
    console.log(`[Cache] Loaded ${Object.keys(cache).length} entries`);
  } catch {
    cache = {};
  }
  cacheInitialized = true;
}

const initPromise = initCache();

/**
 * Atomic Save: Writes to a temp file then renames.
 * This prevents cache corruption if the process crashes during a write.
 */
async function saveCache() {
  if (savePending) return;
  savePending = true;

  setTimeout(async () => {
    try {
      const tempFile = `${CACHE_FILE}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify(cache));
      await fs.rename(tempFile, CACHE_FILE);
    } catch (err) {
      console.error("❌ Cache atomic write error:", err.message);
    } finally {
      savePending = false;
    }
  }, 2000); // 2-second buffer to batch multiple updates
}

async function cached(key, ttlMs, fn) {
  if (!cacheInitialized) await initPromise;

  const now = Date.now();
  const entry = cache[key];

  // 1. Fresh Hit
  if (entry && now - entry.ts < ttlMs) {
    entry.ts = now; // Update "Last Used" time for LRU
    return entry.value;
  }

  // 2. Coalesce concurrent requests (Prevents "Cache Stampede")
  if (inFlight.has(key)) return inFlight.get(key);

  const fetchPromise = (async () => {
    try {
      const value = await fn();

      // 3. LRU Eviction (Cleanup if full)
      const keys = Object.keys(cache);
      if (keys.length >= MAX_CACHE_SIZE) {
        // Remove the 100 oldest entries at once to avoid constant recalculation
        const sorted = keys.sort((a, b) => cache[a].ts - cache[b].ts);
        for (let i = 0; i < 100; i++) delete cache[sorted[i]];
      }

      cache[key] = { ts: Date.now(), value };
      saveCache();
      return value;
    } catch (err) {
      // 4. Stale-on-Error: If provider fails, use old data if it's < 24 hours old
      const STALE_LIMIT = 24 * 60 * 60 * 1000;
      if (entry && now - entry.ts < STALE_LIMIT) {
        console.warn(`[Cache] Provider failed, serving stale: ${key}`);
        return entry.value;
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
