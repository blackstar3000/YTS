'use strict';

const yts = require('./yts');
const fallback = require('./fallback');
const { raceProviders } = require('./race');
const health = require('./health');

async function getMovies(params) {
  const providers = [
    {
      name: 'yts',
      fn: () => yts.listMovies(params)
    },
    {
      name: 'fallback',
      fn: () => fallback.getMovies(params)
    }
  ].filter(p => health.isHealthy(p.name));

  try {
    const { result, name } = await raceProviders(providers);

    health.markSuccess(name);
    console.log(`🏆 Winner: ${name}`);

    return result;

  } catch (err) {
    console.warn('❌ All providers failed → trying fallback');

    for (const p of providers) {
      try {
        const res = await p.fn();
        if (res && res.length) return res;
      } catch {
        health.markFailure(p.name);
      }
    }

    return [];
  }
}

async function getMovieByImdb(imdbId) {
  try {
    const movie = await yts.getMovieByImdb(imdbId);
    if (movie) {
      health.markSuccess('yts');
      return movie;
    }
  } catch {
    health.markFailure('yts');
  }

  return fallback.getMovieByImdb(imdbId);
}

module.exports = {
  getMovies,
  getMovieByImdb
};