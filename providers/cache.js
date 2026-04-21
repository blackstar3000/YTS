'use strict';

const fs = require('fs').promises;
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache.json');
const MAX_CACHE_SIZE = 1000;
let cache = {};
let savePending = false;
let cacheInitialized = false;

async function initCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    cache = JSON.parse(data);
  } catch {}
  cacheInitialized = true;
}

const initPromise = initCache();

async function saveCache() {
  if (savePending) return;
  savePending = true;

  // Debounce writes slightly to avoid disk thrashing
  setTimeout(async () => {
    try {
      await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
    } catch (err) {
      console.error('❌ Cache write error:', err.message);
    } finally {
      savePending = false;
    }
  }, 500);
}

async function cached(key, ttlMs, fn) {
  // Ensure cache is initialized before proceeding
  if (!cacheInitialized) {
    await initPromise;
  }

  const now = Date.now();
  const entry = cache[key];

  if (entry && (now - entry.ts < ttlMs)) {
    // Update timestamp for LRU
    entry.ts = now;
    return entry.value;
  }

  try {
    const value = await fn();

    // LRU Eviction: If cache too large, remove oldest entry
    if (Object.keys(cache).length >= MAX_CACHE_SIZE) {
      const oldestKey = Object.keys(cache).reduce((a, b) =>
        cache[a].ts < cache[b].ts ? a : b
      );
      delete cache[oldestKey];
    }

    cache[key] = { ts: now, value };
    saveCache();
    return value;
  } catch (err) {
    if (entry) {
      console.warn('⚠️ Using stale cache for', key);
      return entry.value;
    }
    throw err;
  }
}

module.exports = { cached };