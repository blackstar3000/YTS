'use strict';

const yts = require('./yts');
const fallback = require('./fallback');
const jackett = require('./jackett');
const { raceProviders } = require('./race');
const health = require('./health');

function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    )
  ]);
}

async function getMovies(params) {
  let providers = [
    { name: 'yts', fn: () => withTimeout(yts.listMovies(params), 8000) },
    { name: 'fallback', fn: () => withTimeout(fallback.getMovies(params), 8000) }
  ].filter(p => health.isHealthy(p.name));

  // 🔥 critical safety
  if (!providers.length) {
    console.warn('⚠️ All providers unhealthy → resetting');
    providers = [
      { name: 'yts', fn: () => yts.listMovies(params) },
      { name: 'fallback', fn: () => fallback.getMovies(params) }
    ];
  }

  try {
    const { result, name } = await raceProviders(providers);

    health.markSuccess(name);
    console.log(`🏆 Winner: ${name}`);

    return result;

  } catch (err) {
    console.warn('❌ All providers failed → fallback loop');

    for (const p of providers) {
      try {
        const res = await p.fn();

        if (res && res.length) {
          health.markSuccess(p.name);
          return res;
        }

      } catch {
        health.markFailure(p.name);
      }
    }

    return [];
  }
}

async function getMovieByImdb(imdbId) {
  try {
    const movie = await withTimeout(yts.getMovieByImdb(imdbId), 8000);

    if (movie) {
      health.markSuccess('yts');
      return movie;
    }

  } catch {
    health.markFailure('yts');
  }

  try {
    const movie = await withTimeout(jackett.getMovieByImdb(imdbId), 8000);
    if (movie) {
      health.markSuccess('jackett');
      return movie;
    }
  } catch {
    health.markFailure('jackett');
  }

  return fallback.getMovieByImdb(imdbId);
}

module.exports = {
  getMovies,
  getMovieByImdb
};