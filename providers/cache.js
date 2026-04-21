'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache.json');
let cache = {};

try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE));
} catch {}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const entry = cache[key];

  if (entry && (now - entry.ts < ttlMs)) {
    return entry.value;
  }

  try {
    const value = await fn();
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