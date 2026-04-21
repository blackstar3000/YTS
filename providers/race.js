'use strict';

async function raceProviders(providers) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let errors = 0;

    providers.forEach(async (p) => {
      try {
        const result = await p.fn();

        if (!finished && result && result.length) {
          finished = true;
          resolve({ result, name: p.name });
        }
      } catch (err) {
        errors++;
        if (errors === providers.length) {
          reject(new Error('All providers failed'));
        }
      }
    });
  });
}

module.exports = { raceProviders };