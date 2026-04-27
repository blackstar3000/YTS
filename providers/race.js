"use strict";

// In-memory provider statistics (resets on restart)
const providerStats = new Map();

function getStats(name) {
  if (!providerStats.has(name)) {
    providerStats.set(name, {
      success: 0,
      fail: 0,
      avgTime: 0,
      lastTime: 0,
    });
  }
  return providerStats.get(name);
}

function updateStats(name, success, time) {
  const s = getStats(name);

  if (success) {
    s.success++;
    // Exponential moving average: 70% old, 30% new
    s.avgTime = s.avgTime ? s.avgTime * 0.7 + time * 0.3 : time;
  } else {
    s.fail++;
  }

  s.lastTime = time;
}

function scoreProvider(name, result) {
  const s = getStats(name);

  // Speed score: faster = higher (inverted time)
  const speedScore = s.avgTime ? 1000 / s.avgTime : 1;

  // Reliability: success rate
  const reliability = s.success / (s.success + s.fail + 1);

  // Quality: from result (qualityScore or seeds)
  const quality = result?.[0]?.qualityScore || result?.[0]?.seeds || 1;

  // Weighted combination
  return speedScore * 0.4 + reliability * 50 + quality * 0.6;
}

function isProviderHealthy(name) {
  const s = getStats(name);
  if (!s) return true;

  const failRate = s.fail / (s.success + s.fail + 1);
  return failRate < 0.6;
}

function dynamicTimeout(name) {
  const s = getStats(name);
  if (!s || !s.avgTime) return 8000;

  // 2x average time, clamped between 3s and 15s
  return Math.min(Math.max(s.avgTime * 2, 3000), 15000);
}

async function raceProvidersV2(providers, windowMs = 1000) {
  const start = Date.now();
  const results = [];

  await Promise.all(
    providers.map(async (p) => {
      const t0 = Date.now();
      try {
        const res = await p.fn();
        const time = Date.now() - t0;

        if (res && res.length) {
          updateStats(p.name, true, time);
          results.push({
            name: p.name,
            result: res,
            time,
          });
        } else {
          updateStats(p.name, false, time);
        }
      } catch {
        updateStats(p.name, false, Date.now() - t0);
      }
    }),
  );

  // Wait for decision window
  const elapsed = Date.now() - start;
  if (elapsed < windowMs) {
    await new Promise((r) => setTimeout(r, windowMs - elapsed));
  }

  if (!results.length) {
    return { result: [], name: "none" };
  }

  // Pick BEST by score (not fastest)
  results.sort(
    (a, b) => scoreProvider(b.name, b.result) - scoreProvider(a.name, a.result),
  );

  return results[0];
}

// Legacy wrapper for backwards compatibility
async function raceProviders(providers, windowMs = 1000) {
  return raceProvidersV2(providers, windowMs);
}

module.exports = {
  raceProvidersV2,
  raceProviders,
  getStats,
  isProviderHealthy,
  dynamicTimeout,
};
