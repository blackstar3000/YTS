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
      { name: 'fallback', fn: () => fallback.listMovies(params) }
    ];
  }

  try {
    const { result, name } = await raceProviders(providers);

    if (name !== 'none' && result && result.length) {
      health.markSuccess(name);
      console.log(`🏆 Winner: ${name}`);
      return result;
    }

    // If result was empty or winner was 'none', we treat it as a failure
    // and fall through to the catch/fallback block.
    throw new Error('No results from race');

  } catch (err) {
    console.warn('❌ All providers failed or empty → fallback loop');

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
  let movieMeta = null;

  // Fetch from both YTS and Jackett in parallel
  const results = await Promise.allSettled([
    withTimeout(yts.getMovieByImdb(imdbId), 8000),
    // We pass null for title initially; we'll handle the title fallback below
  ]);

  // Process YTS result
  if (results[0].status === 'fulfilled') {
    const movieYts = results[0].value;
    if (movieYts && movieYts.torrents) {
      allTorrents.push(...movieYts.torrents);
      movieMeta = movieYts; // Preserve rich YTS metadata
      health.markSuccess('yts');
    }
  } else {
    console.warn(`[aggregator] YTS movie failed: ${results[0].reason?.message}`);
    health.markFailure('yts');
  }

  // Now we determine the best title to use for Jackett search
  let bestTitle = movieMeta ? movieMeta.title : null;
  if (!bestTitle) {
    try {
      const meta = await withTimeout(omdb.getMetaByImdb(imdbId), 5000);
      if (meta) bestTitle = meta.title;
    } catch (err) {
      console.warn(`[aggregator] OMDb title fetch failed: ${err.message}`);
    }
  }

  // Fetch from Jackett using the best available title
  try {
    const movieJackett = await withTimeout(jackett.getMovieByImdb(imdbId, bestTitle), 8000);
    if (movieJackett && movieJackett.torrents) {
      allTorrents.push(...movieJackett.torrents);
      health.markSuccess('jackett');
    }
  } catch (err) {
    console.warn(`[aggregator] Jackett movie failed: ${err.message}`);
    health.markFailure('jackett');
  }

  if (allTorrents.length === 0) {
    return fallback.getMovieByImdb(imdbId);
  }

  // If we have YTS metadata, use it. Otherwise, create a minimal object.
  if (movieMeta) {
    return {
      ...movieMeta,
      torrents: allTorrents,
      provider: 'merged'
    };
  }

  return {
    imdbId,
    title: bestTitle || 'Aggregated Result',
    provider: 'jackett',
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