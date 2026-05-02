"use strict";
// Consolidated operational health (catalog cooldown) + adaptive race timeouts / stats.

// --- Catalog cooldown (was health.js): deprioritize flapping providers ---
const catalog = new Map();

function markSuccess(name) {
  const h = catalog.get(name) || { score: 0 };
  h.score += 1;
  h.lastSuccess = Date.now();
  catalog.set(name, h);
}

function markFailure(name) {
  const h = catalog.get(name) || { score: 0 };
  h.score -= 2;
  h.lastFail = Date.now();
  catalog.set(name, h);
}

function isHealthy(name) {
  const h = catalog.get(name);
  if (!h) return true;

  if (h.score <= -5 && h.lastFail && Date.now() - h.lastFail > 5 * 60 * 1000) {
    console.log(`Health reset for ${name} after cooldown`);
    h.score = 0;
    catalog.set(name, h);
    return true;
  }

  return h.score > -5;
}

function getScore(name) {
  return catalog.get(name)?.score || 0;
}

// --- Race / latency stats for dynamic timeouts ---
const raceStats = new Map();

function getStats(name) {
  if (!raceStats.has(name)) {
    raceStats.set(name, {
      success: 0,
      fail: 0,
      avgTime: 0,
      lastTime: 0,
    });
  }
  return raceStats.get(name);
}

function updateStats(name, success, time) {
  const s = getStats(name);
  if (success) {
    s.success++;
    s.avgTime = s.avgTime ? s.avgTime * 0.8 + time * 0.2 : time;
  } else {
    s.fail++;
  }
  s.lastTime = time;
}

function scoreProvider(name, results) {
  const s = getStats(name);

  const reliability = (s.success / (s.success + s.fail + 1)) * 100;

  const topQuality = results?.[0]?.score || results?.[0]?.qualityScore || 0;

  const speedScore = s.avgTime ? Math.max(0, 100 - s.avgTime / 200) : 50;

  return topQuality * 0.6 + reliability * 0.3 + speedScore * 0.1;
}

function isProviderHealthy(name) {
  const s = getStats(name);
  if (!s || s.success + s.fail < 5) return true;
  const failRate = s.fail / (s.success + s.fail);
  return failRate < 0.7;
}

function dynamicTimeout(name) {
  const s = getStats(name);
  if (!s || !s.avgTime) return 10000;
  return Math.min(Math.max(s.avgTime * 2.5, 3000), 25000);
}

module.exports = {
  markSuccess,
  markFailure,
  isHealthy,
  getScore,
  getStats,
  updateStats,
  scoreProvider,
  isProviderHealthy,
  dynamicTimeout,
};
