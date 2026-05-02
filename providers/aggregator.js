"use strict";
// Aggregates providers: catalog from YTS (+ race/fallback), merged movie streams, TV graph.

const yts = require("./yts");
const fallback = require("./fallback");
const prowlarr = require("./prowlarr");
const eztv = require("./eztv");
const omdb = require("./omdb");
const { cached } = require("./cache");
const { raceProvidersV2 } = require("./race");
const {
  dynamicTimeout,
  isProviderHealthy,
  isHealthy,
  markFailure,
  markSuccess,
} = require("./providersHealth");
const logger = require("./logger");
const { parseRelease } = require("./sceneParser");

function withTimeout(promise, ms = 8000) {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 8000;
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), safeMs),
    ),
  ]);
}

function extractHashFromMagnet(magnet) {
  if (!magnet) return null;
  const match = magnet.match(/xt=urn:btih:([a-fA-F0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizeTitle(title) {
  return title
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 50);
}

function deduplicateTorrents(torrents) {
  const seen = new Map();
  let counter = 0;

  for (const t of torrents) {
    const key =
      t.hash ||
      extractHashFromMagnet(t.magnet) ||
      normalizeTitle(t.title) ||
      `unknown_${counter++}`;
    if (!seen.has(key) || (t.seeds || 0) > (seen.get(key).seeds || 0)) {
      seen.set(key, t);
    }
  }
  return Array.from(seen.values());
}

/**
 * Single sort order for stream payloads (YTS + Prowlarr scores + sceneParser).
 * @param {import("./types").Torrent[]} torrents
 */
function rankTorrentsForStream(torrents) {
  const Q = { "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };
  return [...torrents].sort((a, b) => {
    const scoreA =
      a.score ??
      a.qualityScore ??
      a.parsed?.score ??
      a.finalScore ??
      0;
    const scoreB =
      b.score ??
      b.qualityScore ??
      b.parsed?.score ??
      b.finalScore ??
      0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    const qDiff = (Q[b.quality] || 0) - (Q[a.quality] || 0);
    if (qDiff !== 0) return qDiff;
    return (b.seeds || 0) - (a.seeds || 0);
  });
}

// ------------------------------
// Movie catalog: YTS-shaped rows only (imdbId for Stremio meta).
// ------------------------------
async function getMovies(params) {
  const providers = [
    {
      name: "yts",
      fn: () => withTimeout(yts.listMovies(params), dynamicTimeout("yts")),
    },
    {
      name: "fallback",
      fn: () =>
        withTimeout(fallback.listMovies(params), dynamicTimeout("fallback")),
    },
  ].filter((p) => isHealthy(p.name) && isProviderHealthy(p.name));

  try {
    const { result } = await raceProvidersV2(providers, 4500);
    const limit = params.limit ?? 20;
    const list = Array.isArray(result) ? result : [];
    return list.slice(0, limit);
  } catch (err) {
    logger.warn({ err: err.message }, "getMovies failed");
    return [];
  }
}

const TIMEOUTS = {
  YTS: 6000,
  OMDb: 5000,
  PROWLARR: 30000,
  EZTV: 6000,
  CACHE_TTL: 24 * 60 * 60 * 1000,
};

async function getMovieByImdb(imdbId) {
  const [ytsResult, omdbMeta] = await Promise.all([
    withTimeout(yts.getMovieByImdb(imdbId), TIMEOUTS.YTS).catch(() => null),
    cached(
      `omdb:title:${imdbId}`,
      TIMEOUTS.CACHE_TTL,
      () => omdb.getMetaByImdb(imdbId),
    ).catch(() => null),
  ]);

  const allTorrents = [];
  let movieMeta = null;

  if (ytsResult?.torrents) {
    allTorrents.push(...ytsResult.torrents);
    movieMeta = ytsResult;
  }

  const title = movieMeta?.title || omdbMeta?.title;
  const year = movieMeta?.year || omdbMeta?.year;

  if (prowlarr.isEnabled && title) {
    const prowlarrResult = await prowlarr
      .getMovieByImdb(imdbId, title, year)
      .catch(() => null);
    if (prowlarrResult?.torrents) {
      allTorrents.push(
        ...prowlarrResult.torrents.map((t) => ({ ...t, provider: "prowlarr" })),
      );
    }
  }

  const enriched = deduplicateTorrents(allTorrents).map((t) => {
    const parsed = parseRelease(t.title || t.name || "");
    return {
      ...t,
      parsed,
      qualityScore: t.qualityScore ?? parsed?.score ?? 0,
    };
  });

  const ranked = rankTorrentsForStream(enriched);
  const metaBase = movieMeta || {};

  const description = omdbMeta?.description || metaBase.summary;
  const summary = metaBase.summary ?? omdbMeta?.description;

  return {
    ...metaBase,
    ...(!movieMeta && omdbMeta ? omdbMeta : {}),
    imdbId,
    title: title || "Result",
    year: year ?? metaBase.year,
    torrents: ranked,
    provider: "merged",
    summary,
    description,
    background: metaBase.background || omdbMeta?.poster,
  };
}

async function getShowMeta(imdbId) {
  const meta = await omdb.getMetaByImdb(imdbId).catch(() => null);
  return meta || { title: `TV Show (${imdbId})` };
}

function cleanShowTitle(title) {
  return title
    ?.replace(/\s*[–-]\s*\d{4}\s*$/, "")
    .replace(/\s*\(\d{4}[–-]\d{4}\)\s*$/, "")
    .trim();
}

async function getShowTorrents(imdbId) {
  const allTorrents = {};

  const omdbMeta = await cached(
    `omdb:title:${imdbId}`,
    TIMEOUTS.CACHE_TTL,
    () => omdb.getMetaByImdb(imdbId),
  ).catch(() => null);
  const showTitle = omdbMeta?.title;
  const cleanedTitle = cleanShowTitle(showTitle);

  const eztvPromise = withTimeout(
    eztv.getShowTorrents(imdbId, showTitle),
    TIMEOUTS.EZTV,
  ).catch(() => ({}));
  const prowlarrPromise = prowlarr.isEnabled
    ? withTimeout(
        prowlarr.getShowTorrents(imdbId, cleanedTitle, null, null),
        TIMEOUTS.PROWLARR,
      ).catch(() => ({}))
    : Promise.resolve({});

  const [eztvData, prowlarrData] = await Promise.all([
    eztvPromise,
    prowlarrPromise,
  ]);

  const merge = (source, provider) => {
    if (!source) return;
    for (const [s, eps] of Object.entries(source)) {
      allTorrents[s] ??= {};
      for (const [e, torrents] of Object.entries(eps)) {
        allTorrents[s][e] ??= [];
        allTorrents[s][e].push(
          ...torrents.map((t) => ({ ...t, provider: t.provider || provider })),
        );
      }
    }
  };

  merge(eztvData, "eztv");
  merge(prowlarrData, "prowlarr");

  for (const s of Object.keys(allTorrents)) {
    const packs = allTorrents[s]["0"] || [];
    for (const e of Object.keys(allTorrents[s])) {
      if (e !== "0") {
        const hashes = new Set(
          allTorrents[s][e].map((t) => t.hash || t.infoHash),
        );
        allTorrents[s][e].push(
          ...packs.filter((p) => !hashes.has(p.hash || p.infoHash)),
        );
      }
      allTorrents[s][e] = rankTorrentsForStream(allTorrents[s][e]);
    }
  }

  return allTorrents;
}

async function getLatestShows(page) {
  try {
    const shows = await eztv.getLatestShows(page);
    if (shows?.length) {
      markSuccess("eztv");
      return shows;
    }
  } catch (err) {
    logger.warn({ err: err.message }, "EZTV getLatestShows failed");
    markFailure("eztv");
  }
  return fallback.getLatestShows(page);
}

module.exports = {
  getMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents,
  getShowMeta,
  rankTorrentsForStream,
};
