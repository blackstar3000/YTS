"use strict";

async function raceProviders(providers) {
  const WINDOW_MS = 1000;
  const start = Date.now();

  return new Promise((resolve) => {
    let resolved = false;
    let pending = providers.length;
    let bestResult = null;
    let bestName = "none";
    let bestScore = -1;

    providers.forEach(async (p) => {
      try {
        const result = await p.fn();
        const elapsed = Date.now() - start;

        if (result && result.length) {
          const score = calculateScore(result, elapsed);

          if (!bestResult || score > bestScore) {
            bestResult = result;
            bestName = p.name;
            bestScore = score;
          }
        }
      } catch (err) {
        // Treat error as empty result
      } finally {
        pending--;

        if (pending === 0) {
          if (!resolved) {
            resolved = true;
            resolve({ result: bestResult || [], name: bestName });
          }
        }
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ result: bestResult || [], name: bestName });
      }
    }, WINDOW_MS);
  });
}

function calculateScore(result, elapsedMs) {
  const baseCount = result.length;
  const timeBonus = elapsedMs < 500 ? 50 : elapsedMs < 1000 ? 25 : 0;

  let qualityBonus = 0;
  for (const item of result.slice(0, 5)) {
    if (item.quality === "2160p") qualityBonus += 10;
    else if (item.quality === "1080p") qualityBonus += 5;
    if (item.seeds > 100) qualityBonus += 5;
  }

  return baseCount * 2 + timeBonus + qualityBonus;
}

module.exports = { raceProviders };
