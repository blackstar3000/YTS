"use strict";
// Aggregator Module
// Combines results from multiple providers with intelligent deduplication and scoring
// 2026 Refactored for Robustness, Clarity, and Performance
const yts = require("./yts");
const fallback = require("./fallback");
const prowlarr = require("./prowlarr");
const eztv = require("./eztv");
const omdb = require("./omdb");
const { cached } = require("./cache");
const {
  raceProvidersV2,
  getStats,
  dynamicTimeout,
  isProviderHealthy,
} = require("./race");
const health = require("./health");
const { parseRelease } = require("./sceneParser");

// ------------------------------
// Safe timeout with NaN guard and default value
// ------------------------------
function withTimeout(promise, ms = 8000) {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 8000;
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), safeMs),
    ),
  ]);
}

// ===============================
// Hybrid Race + Merge Helpers
// ===============================

async function fetchprowlarrSearchResults(params) {
  const query = (params.query || params.query_term || "").trim();
  if (!query && !params.imdb_id) return [];

  try {
    const results = await withTimeout(prowlarr.searchMovies(query, 20), 15000);
    return results || [];
  } catch (err) {
    console.warn(`[aggregator] prowlarr search failed: ${err.message}`);
    return [];
  }
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

function calculateFinalScore(torrent) {
  const qualityScore = torrent.qualityScore || torrent.parsed?.score || 0;
  const seeds = torrent.seeds || 0;
  const providerBoost = torrent.provider === "prowlarr" ? 10 : 0;
  return qualityScore * 1.5 + seeds * 0.3 + providerBoost;
}

// ------------------------------
// Get movies and shows with intelligent provider selection, deduplication, and scoring
// ------------------------------
async function getMovies(params) {
  let providers = [
    {
      name: "yts",
      fn: () => withTimeout(yts.listMovies(params), dynamicTimeout("yts")),
    },
    {
      name: "prowlarr",
      fn: () =>
        withTimeout(
          prowlarr.searchMovies(params.query || params.query_term || "", 20),
          dynamicTimeout("prowlarr"),
        ),
    },
    {
      name: "fallback",
      fn: () =>
        withTimeout(fallback.listMovies(params), dynamicTimeout("fallback")),
    },
  ].filter((p) => health.isHealthy(p.name) && isProviderHealthy(p.name));

  try {
    const { result: winnerResult, name: winnerName } = await raceProvidersV2(
      providers,
      1000,
    );
    let allTorrents = [...(winnerResult || [])];

    if (winnerName !== "prowlarr") {
      const prowlarrResults = await fetchprowlarrSearchResults(params);
      allTorrents.push(
        ...prowlarrResults.map((t) => ({ ...t, provider: "prowlarr" })),
      );
    }

    const deduped = deduplicateTorrents(allTorrents);
    const enriched = deduped.map((t) => {
      const parsed = t.parsed || parseRelease(t.title || t.name || "");
      return {
        ...t,
        parsed,
        qualityScore: t.qualityScore || parsed?.score || 0,
      };
    });

    const scored = enriched.map((t) => ({
      ...t,
      finalScore: calculateFinalScore(t),
    }));
    scored.sort((a, b) => b.finalScore - a.finalScore);

    return scored.slice(0, 20);
  } catch (err) {
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
  const allTorrents = [];
  let movieMeta = null;

  const ytsResult = await withTimeout(
    yts.getMovieByImdb(imdbId),
    TIMEOUTS.YTS,
  ).catch(() => null);
  if (ytsResult?.torrents) {
    allTorrents.push(...ytsResult.torrents);
    movieMeta = ytsResult;
  }

  const omdbMeta = await cached(
    `omdb:title:${imdbId}`,
    TIMEOUTS.CACHE_TTL,
    () => omdb.getMetaByImdb(imdbId),
  ).catch(() => null);
  const title = movieMeta?.title || omdbMeta?.title;
  const year = movieMeta?.year || omdbMeta?.year;

  if (title) {
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
    return { ...t, parsed, qualityScore: parsed?.score || 0 };
  });

  enriched.sort((a, b) => b.qualityScore - a.qualityScore || b.seeds - a.seeds);

  return {
    ...movieMeta,
    imdbId,
    title: title || "Result",
    torrents: enriched,
    provider: "merged",
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

// ------------------------------
// Improved getShowTorrents (FIXED SYNTAX)
// ------------------------------
async function getShowTorrents(imdbId) {
  const allTorrents = {};
  let showTitle = null;

  const omdbMeta = await cached(
    `omdb:title:${imdbId}`,
    TIMEOUTS.CACHE_TTL,
    () => omdb.getMetaByImdb(imdbId),
  ).catch(() => null);
  showTitle = omdbMeta?.title;
  const cleanedTitle = cleanShowTitle(showTitle);

  const eztvPromise = withTimeout(
    eztv.getShowTorrents(imdbId, showTitle),
    TIMEOUTS.EZTV,
  ).catch(() => ({}));
  const prowlarrPromise = withTimeout(
    prowlarr.getShowTorrents(imdbId, cleanedTitle, null, null),
    TIMEOUTS.PROWLARR,
  ).catch(() => ({}));

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

  // Pack Injection Logic
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
      allTorrents[s][e].sort(
        (a, b) =>
          (b.score || b.qualityScore || 0) - (a.score || a.qualityScore || 0),
      );
    }
  }

  return allTorrents;
}

async function getLatestShows(page) {
  try {
    const shows = await eztv.getLatestShows(page);
    if (shows?.length) {
      health.markSuccess("eztv");
      return shows;
    }
  } catch (err) {
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
