'use strict';

const yts = require('./yts');
const fallback = require('./fallback');
const jackett = require('./jackett');
const eztv = require('./eztv');
const omdb = require('./omdb');
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
    { name: 'fallback', fn: () => withTimeout(fallback.listMovies(params), 8000) }
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
  const allTorrents = [];
  let providerUsed = 'yts'; // Default

  try {
    const movieYts = await withTimeout(yts.getMovieByImdb(imdbId), 8000);
    if (movieYts && movieYts.torrents) {
      allTorrents.push(...movieYts.torrents);
      health.markSuccess('yts');
    }
  } catch (err) {
    console.warn(`[aggregator] YTS movie failed: ${err.message}`);
    health.markFailure('yts');
  }

  try {
    const movieJackett = await withTimeout(jackett.getMovieByImdb(imdbId), 8000);
    if (movieJackett && movieJackett.torrents) {
      allTorrents.push(...movieJackett.torrents);
      health.markSuccess('jackett');
      // If we got Jackett results, we mark the provider as jackett
      // (since we merge, the a mix of both is present)
      providerUsed = 'jackett';
    }
  } catch (err) {
    console.warn(`[aggregator] Jackett movie failed: ${err.message}`);
    health.markFailure('jackett');
  }

  if (allTorrents.length === 0) {
    return fallback.getMovieByImdb(imdbId);
  }

  return {
    imdbId,
    title: 'Aggregated Result',
    provider: providerUsed,
    torrents: allTorrents
  };
}

async function getShowMeta(imdbId) {
  try {
    const meta = await omdb.getMetaByImdb(imdbId);
    if (meta) {
      health.markSuccess('omdb');
      return meta;
    }
  } catch (err) {
    console.warn(`[aggregator] OMDb meta failed: ${err.message}`);
    health.markFailure('omdb');
  }
  return { title: `TV Show (${imdbId})` };
}

async function getShowTorrents(imdbId) {
  try {
    const torrents = await eztv.getShowTorrents(imdbId);
    if (torrents && Object.keys(torrents).length > 0) {
      health.markSuccess('eztv');
      return torrents;
    }
  } catch (err) {
    console.warn(`[aggregator] EZTV show torrents failed: ${err.message}`);
    health.markFailure('eztv');
  }

  try {
    const torrents = await jackett.getShowTorrents(imdbId);
    if (torrents && Object.keys(torrents).length > 0) {
      health.markSuccess('jackett');
      return torrents;
    }
  } catch (err) {
    console.warn(`[aggregator] Jackett show torrents failed: ${err.message}`);
    health.markFailure('jackett');
  }

  return fallback.getShowTorrents(imdbId);
}

async function getLatestShows(page) {
  try {
    const shows = await eztv.getLatestShows(page);
    if (shows && shows.length > 0) {
      health.markSuccess('eztv');
      return shows;
    }
  } catch (err) {
    console.warn(`[aggregator] EZTV latest shows failed: ${err.message}`);
    health.markFailure('eztv');
  }
  return fallback.getLatestShows(page);
}

module.exports = {
  getMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents,
  getShowMeta
};