'use strict';

const yts = require('./yts');
const fallback = require('./fallback');
const jackett = require('./jackett');
const eztv = require('./eztv');
const omdb = require('./omdb');
const { cached } = require('./cache');
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
  let jackettTitle = null;

  // Start OMDb title lookup in background (non-blocking), with caching
  const omdbPromise = cached(`omdb:title:${imdbId}`, 24 * 60 * 60 * 1000, () => omdb.getMetaByImdb(imdbId))
    .then(meta => { if (meta && meta.title) jackettTitle = meta.title; })
    .catch(() => {});

  // Fetch YTS with timeout
  let ytsResult;
  try {
    ytsResult = await withTimeout(yts.getMovieByImdb(imdbId), 6000);
  } catch (err) {
    console.warn(`[aggregator] YTS movie failed: ${err.message}`);
    health.markFailure('yts');
    ytsResult = null;
  }

  // Process YTS result
  if (ytsResult) {
    const movieYts = ytsResult;
    if (movieYts && movieYts.torrents) {
      allTorrents.push(...movieYts.torrents);
      movieMeta = movieYts;
      jackettTitle = movieYts.title; // Use YTS title for Jackett
      health.markSuccess('yts');
    }
  }

  // If YTS failed, wait briefly for OMDb title before Jackett search
  if (!jackettTitle) {
    await Promise.race([
      omdbPromise,
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
  }

  // Fetch from Jackett in parallel using the title we have
  const jackettPromise = jackett.getMovieByImdb(imdbId, jackettTitle, 15000);

  const [jackettResult] = await Promise.allSettled([jackettPromise]);

  if (jackettResult.status === 'fulfilled') {
    const movieJackett = jackettResult.value;
    if (movieJackett && movieJackett.torrents && movieJackett.torrents.length > 0) {
      // Tag each torrent so the stream label knows the source
      const tagged = movieJackett.torrents.map(t => ({ ...t, provider: 'jackett' }));
      allTorrents.push(...tagged);
      health.markSuccess('jackett');
    }
    // Empty result is normal (movie not indexed) — don't penalize
  } else {
    // Only penalize on actual errors (network failure, crash, etc.)
    console.warn(`[aggregator] Jackett error: ${jackettResult.reason?.message}`);
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
    title: jackettTitle || 'Aggregated Result',
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
    const torrents = await withTimeout(eztv.getShowTorrents(imdbId), 6000);
    if (torrents && Object.keys(torrents).length > 0) {
      health.markSuccess('eztv');
      return torrents;
    }
  } catch (err) {
    console.warn(`[aggregator] EZTV show torrents failed: ${err.message}`);
    health.markFailure('eztv');
  }

  try {
    const torrents = await withTimeout(jackett.getShowTorrents(imdbId, 5000), 6000);
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