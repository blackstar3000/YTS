"use strict";

const yts = require("./yts");
const fallback = require("./fallback");
const jackett = require("./jackett");
const eztv = require("./eztv");
const omdb = require("./omdb");
const { cached } = require("./cache");
const { raceProviders } = require("./race");
const health = require("./health");
const { parseRelease } = require("./sceneParser");

function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    ),
  ]);
}

async function getMovies(params) {
  let providers = [
    { name: "yts", fn: () => withTimeout(yts.listMovies(params), 8000) },
    {
      name: "fallback",
      fn: () => withTimeout(fallback.listMovies(params), 8000),
    },
  ].filter((p) => health.isHealthy(p.name));

  // 🔥 critical safety
  if (!providers.length) {
    console.warn("⚠️ All providers unhealthy → resetting");
    providers = [
      { name: "yts", fn: () => withTimeout(yts.listMovies(params), 15000) },
      {
        name: "fallback",
        fn: () => withTimeout(fallback.listMovies(params), 15000),
      },
    ];
  }

  try {
    const { result, name } = await raceProviders(providers);

    if (name !== "none" && result && result.length) {
      health.markSuccess(name);
      console.log(`🏆 Winner: ${name}`);
      return result;
    }

    throw new Error("No results from race");
  } catch (err) {
    console.warn("❌ All providers failed or empty → fallback loop");

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

// Constants for configuration
const TIMEOUTS = {
  YTS: 6000,
  OMDb: 5000,
  JACKETT: 30000,
  EZTV: 6000,
  CACHE_TTL: 24 * 60 * 60 * 1000,
};

async function getMovieByImdb(imdbId) {
  const allTorrents = [];
  let movieMeta = null;
  let searchTitle = null;
  let searchYear = null;

  // 1. Start OMDb lookup immediately (Cached)
  const omdbPromise = cached(`omdb:title:${imdbId}`, TIMEOUTS.CACHE_TTL, () =>
    omdb.getMetaByImdb(imdbId),
  ).catch((err) => {
    console.warn(`[aggregator] OMDb cache miss/error: ${err.message}`);
    return null;
  });

  // 2. Fetch YTS in parallel with OMDb
  const ytsPromise = withTimeout(yts.getMovieByImdb(imdbId), TIMEOUTS.YTS)
    .then((res) => {
      health.markSuccess("yts");
      return res;
    })
    .catch((err) => {
      console.warn(`[aggregator] YTS movie failed: ${err.message}`);
      health.markFailure("yts");
      return null;
    });

  // 3. Wait for YTS, but don't block OMDb
  const ytsResult = await ytsPromise;

  // 4. Determine Metadata & Search Title
  if (ytsResult && ytsResult.torrents?.length) {
    allTorrents.push(...ytsResult.torrents);
    movieMeta = ytsResult;
    searchTitle = ytsResult.title;
    searchYear = ytsResult.year;
  } else {
    const omdbMeta = await omdbPromise;
    if (omdbMeta) {
      searchTitle = omdbMeta.title;
      searchYear = omdbMeta.year;
      if (!movieMeta) movieMeta = omdbMeta;
    }
  }

  // 5. Fetch Jackett if we have a title to search
  if (searchTitle) {
    const jackettPromise = jackett.getMovieByImdb(
      imdbId,
      searchTitle,
      searchYear,
      TIMEOUTS.JACKETT,
    );

    const jackettResult = await Promise.resolve(jackettPromise).catch((err) => {
      console.warn(`[aggregator] Jackett error: ${err.message}`);
      health.markFailure("jackett");
      return null;
    });

    if (jackettResult?.torrents?.length > 0) {
      const tagged = jackettResult.torrents.map((t) => ({
        ...t,
        provider: "jackett",
      }));
      allTorrents.push(...tagged);
      health.markSuccess("jackett");
    }
  }

  // 6. Final Fallback
  if (allTorrents.length === 0) {
    return fallback.getMovieByImdb(imdbId);
  }

  // 7. Enrich & Sort torrents
  const enrichedTorrents = allTorrents.map((t) => {
    const parsed = parseRelease(t.title || t.filename || t.name || "");
    return {
      ...t,
      parsed,
      qualityScore: parsed?.score || 0,
    };
  });

  enrichedTorrents.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }
    return (b.seeds || 0) - (a.seeds || 0);
  });

  // 8. Return Merged Object
  return {
    ...movieMeta,
    imdbId,
    title: searchTitle || "Aggregated Result",
    torrents: enrichedTorrents,
    provider: "merged",
  };
}

async function getShowMeta(imdbId) {
  try {
    const meta = await omdb.getMetaByImdb(imdbId);
    if (meta) {
      health.markSuccess("omdb");
      return meta;
    }
  } catch (err) {
    console.warn(`[aggregator] OMDb meta failed: ${err.message}`);
    health.markFailure("omdb");
  }
  return { title: `TV Show (${imdbId})` };
}

async function getShowTorrents(imdbId) {
  const allTorrents = {};
  let showTitle = null;
  let showYear = null;

  // 1. Fetch OMDb metadata first (to get title for Jackett search)
  try {
    const omdbMeta = await cached(
      `omdb:title:${imdbId}`,
      TIMEOUTS.CACHE_TTL,
      () => omdb.getMetaByImdb(imdbId),
    );
    if (omdbMeta) {
      showTitle = omdbMeta.title;
      showYear = omdbMeta.year;
      health.markSuccess("omdb");
    }
  } catch (err) {
    console.warn(`[aggregator] OMDb meta failed: ${err.message}`);
    health.markFailure("omdb");
  }

  // 2. Fetch EZTV (uses IMDB ID primarily, title as fallback)
  const eztvPromise = withTimeout(
    eztv.getShowTorrents(imdbId, showTitle),
    TIMEOUTS.EZTV,
  )
    .then((data) => {
      health.markSuccess("eztv");
      return data;
    })
    .catch((err) => {
      console.warn(`[aggregator] EZTV show torrents failed: ${err.message}`);
      health.markFailure("eztv");
      return {};
    });

  // 3. Fetch Jackett (uses IMDB ID + Title for better results)
  const jackettPromise = withTimeout(
    jackett.getShowTorrents(imdbId, showTitle, showYear, 15000),
    20000,
  )
    .then((data) => {
      health.markSuccess("jackett");
      return data;
    })
    .catch((err) => {
      console.warn(`[aggregator] Jackett show torrents failed: ${err.message}`);
      health.markFailure("jackett");
      return {};
    });

  // 4. Wait for both to complete
  const [eztvData, jackettData] = await Promise.all([
    eztvPromise,
    jackettPromise,
  ]);

  // 5. Merge helper
  const mergeTorrents = (target, source, providerName) => {
    if (!source || Object.keys(source).length === 0) return;
    for (const [season, episodes] of Object.entries(source)) {
      if (!target[season]) target[season] = {};
      for (const [episode, torrents] of Object.entries(episodes)) {
        if (!target[season][episode]) target[season][episode] = [];
        const tagged = torrents.map((t) => {
          const parsed = parseRelease(t.title || t.filename || "");
          return {
            ...t,
            provider: t.provider || providerName,
            parsed,
            qualityScore: parsed?.score || 0,
          };
        });
        target[season][episode].push(...tagged);
      }
    }
  };

  mergeTorrents(allTorrents, eztvData, "eztv");
  mergeTorrents(allTorrents, jackettData, "jackett");

  // 6. Fallback if both empty
  if (Object.keys(allTorrents).length === 0) {
    return fallback.getShowTorrents(imdbId);
  }

  // 7. Sort torrents within each episode (Quality > Seeds)
  for (const season of Object.keys(allTorrents)) {
    for (const episode of Object.keys(allTorrents[season])) {
      allTorrents[season][episode].sort((a, b) => {
        if (b.qualityScore !== a.qualityScore) {
          return b.qualityScore - a.qualityScore;
        }
        return (b.seeds || 0) - (a.seeds || 0);
      });
    }
  }

  return allTorrents;
}

async function getLatestShows(page) {
  try {
    const shows = await eztv.getLatestShows(page);
    if (shows && shows.length > 0) {
      health.markSuccess("eztv");
      return shows;
    }
  } catch (err) {
    console.warn(`[aggregator] EZTV latest shows failed: ${err.message}`);
    health.markFailure("eztv");
  }
  return fallback.getLatestShows(page);
}

module.exports = {
  getMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents,
  getShowMeta,
};
