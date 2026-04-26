"use strict";

async function raceProviders(providers) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let resultsProcessed = 0;

    providers.forEach(async (p) => {
      try {
        const result = await p.fn();

        if (!finished && result && result.length) {
          finished = true;
          return resolve({ result, name: p.name });
        }
      } catch (err) {
        // Treat error as an empty result for the purpose of the race
      } finally {
        resultsProcessed++;
        if (!finished && resultsProcessed === providers.length) {
          // All providers finished, none returned results
          resolve({ result: [], name: "none" });
        }
      }
    });
  });
}

module.exports = { raceProviders };
