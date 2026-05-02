"use strict";
// Parallel provider fan-out with early exit when outcome is strong enough.

const {
  updateStats,
  scoreProvider,
} = require("./providersHealth");

/**
 * @param {unknown[]} res
 */
function isGoodEarlyCatalogResult(res) {
  return (
    Array.isArray(res) &&
    res.length >= 5 &&
    res.every((item) => item && typeof item === "object")
  );
}

/**
 * @typedef {{ name: string, fn: () => Promise<unknown>, result?: unknown }} ProviderTask
 */

/**
 * @param {ProviderTask[]} providers
 * @param {number} [timeoutMs]
 * @returns {Promise<{ result: unknown[], name: string }>}
 */
async function raceProvidersV2(providers, timeoutMs = 4500) {
  if (!providers.length) return { result: [], name: "none" };

  return new Promise((resolve) => {
    let settled = false;
    /** @type {{ name: string, result: unknown[], time?: number }[]} */
    const outcomes = [];

    function pickBestFallback() {
      if (!outcomes.length) return { result: [], name: "none" };
      outcomes.sort(
        (a, b) =>
          scoreProvider(b.name, b.result) - scoreProvider(a.name, a.result),
      );
      const w = outcomes[0];
      return { result: w.result, name: w.name };
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(pickBestFallback());
    }, timeoutMs);

    let remaining = providers.length;

    providers.forEach((p) => {
      const t0 = Date.now();
      Promise.resolve()
        .then(() => p.fn())
        .then((res) => {
          const time = Date.now() - t0;
          if (!Array.isArray(res) || res.length === 0) {
            updateStats(p.name, false, time);
            return;
          }

          const arrRes = res;
          updateStats(p.name, true, time);
          outcomes.push({ name: p.name, result: arrRes, time });

          if (!settled && isGoodEarlyCatalogResult(arrRes)) {
            settled = true;
            clearTimeout(timer);
            resolve({ result: arrRes, name: p.name });
          }
        })
        .catch(() => {
          updateStats(p.name, false, Date.now() - t0);
        })
        .finally(() => {
          remaining--;
          if (remaining === 0 && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(pickBestFallback());
          }
        });
    });
  });
}

module.exports = {
  raceProvidersV2,
  raceProviders: raceProvidersV2,
};
