"use strict";

/**
 * Race Provider Logic - 2026 Adaptive Intelligence
 * Manages provider health, dynamic timeouts, and result scoring.
 */

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
    // 2026 EMA: 80% old, 20% new for smoother stability
    s.avgTime = s.avgTime ? s.avgTime * 0.8 + time * 0.2 : time;
  } else {
    s.fail++;
  }
  s.lastTime = time;
}

/**
 * The 2026 Scoring Algorithm
 * Balanced to prioritize Quality > Reliability > Speed.
 */
function scoreProvider(name, results) {
  const s = getStats(name);

  // 1. Reliability (0-100)
  const reliability = (s.success / (s.success + s.fail + 1)) * 100;

  // 2. Quality (Weighted by best result in batch)
  // We check the first item because aggregator sorts by score before passing here
  const topQuality = results?.[0]?.score || results?.[0]?.qualityScore || 0;

  // 3. Speed (Inverted time penalty)
  const speedScore = s.avgTime ? Math.max(0, 100 - s.avgTime / 200) : 50;

  // Final Formula: 60% Quality, 30% Reliability, 10% Speed
  return topQuality * 0.6 + reliability * 0.3 + speedScore * 0.1;
}

function isProviderHealthy(name) {
  const s = getStats(name);
  if (!s || s.success + s.fail < 5) return true; // Grace period for new providers
  const failRate = s.fail / (s.success + s.fail);
  return failRate < 0.7; // Healthy if success rate > 30%
}

function dynamicTimeout(name) {
  const s = getStats(name);
  if (!s || !s.avgTime) return 10000; // Default 10s
  // 2.5x avg time, capped strictly for Stremio UX (3s - 25s)
  return Math.min(Math.max(s.avgTime * 2.5, 3000), 25000);
}

async function raceProvidersV2(providers, windowMs = 1500) {
  const start = Date.now();
  const results = [];

  // Start all races
  const tasks = providers.map(async (p) => {
    const t0 = Date.now();
    try {
      const res = await p.fn();
      const time = Date.now() - t0;

      if (res && (res.length > 0 || Object.keys(res).length > 0)) {
        updateStats(p.name, true, time);
        results.push({ name: p.name, result: res, time });
      } else {
        updateStats(p.name, false, time);
      }
    } catch (err) {
      updateStats(p.name, false, Date.now() - t0);
    }
  });

  // WAIT logic: We wait at most for the full timeout,
  // but we can proceed early if a "Perfect" result is found.
  await Promise.all(tasks);

  if (!results.length) return { result: [], name: "none" };

  // Sort by the 2026 Weighted Score
  results.sort(
    (a, b) => scoreProvider(b.name, b.result) - scoreProvider(a.name, a.result),
  );

  const winner = results[0];
  console.log(
    `🏁 Race Winner: ${winner.name} (Score: ${scoreProvider(winner.name, winner.result).toFixed(1)})`,
  );

  return winner;
}

module.exports = {
  raceProvidersV2,
  raceProviders: raceProvidersV2,
  getStats,
  isProviderHealthy,
  dynamicTimeout,
};
