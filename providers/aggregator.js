"use strict";

const yts = require("./yts");
const fallback = require("./fallback");
const jackett = require("./jackett");
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
// Safe timeout with NaN guard
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

// NEW: Search Jackett by query (since getMovies doesn't have IMDb ID)
async function fetchJackettSearchResults(params) {
  const query = (params.query || params.query_term || "").trim();
  if (!query) return [];

  try {
    const results = await withTimeout(
      async function smartJackettSearch(params) {
        const { imdb_id, query, year, season, episode, type } = params;

        // 🎬 MOVIE SEARCH
        if (type === "movie") {
          return jackett.getTorrents(
            imdb_id || null,
            query || "",
            year || null,
          );
        }

        // 📺 TV SEARCH
        if (type === "series") {
          return jackett.getShowTorrents(imdb_id, season, episode);
        }

        // fallback
        return jackett.getTorrents(null, query || "", null);
      },
      15000, // Shorter timeout for merge phase
    );
    return results || [];
  } catch (err) {
    console.warn(`[aggregator] Jackett search failed: ${err.message}`);
    return [];
  }
}

// NEW: Extract hash from magnet URL
function extractHashFromMagnet(magnet) {
  if (!magnet) return null;
  const match = magnet.match(/xt=urn:btih:([a-fA-F0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// NEW: Normalize title for deduplication
function normalizeTitle(title) {
  return title
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 50);
}

// NEW: Deduplicate torrents by hash, magnet, or title
function deduplicateTorrents(torrents) {
  const seen = new Map();
  let counter = 0;

  for (const t of torrents) {
    // Priority: hash > magnet > title > indexed fallback
    const key =
      t.hash ||
      extractHashFromMagnet(t.magnet) ||
      normalizeTitle(t.title) ||
      `unknown_${counter++}`;

    // Keep higher-seeded version
    if (!seen.has(key) || (t.seeds || 0) > (seen.get(key).seeds || 0)) {
      seen.set(key, t);
    }
  }

  return Array.from(seen.values());
}

// NEW: Final scoring formula (quality + seeds + provider boost)
function calculateFinalScore(torrent) {
  const qualityScore = torrent.qualityScore || torrent.parsed?.score || 0;
  const seeds = torrent.seeds || 0;
  const providerBoost = torrent.provider === "jackett" ? 10 : 0;

  // Formula: quality * 1.5 + seeds * 0.3 + providerBoost (favors quality over seed spam)
  return qualityScore * 1.5 + seeds * 0.3 + providerBoost;
}

// ------------------------------
// Get movies with provider racing and health checks
// ------------------------------
async function getMovies(params) {
  const isMovie = params.type === "movie";
  const isSeries = params.type === "series";
  let providers = [
    {
      name: "yts",
      fn: () => withTimeout(yts.listMovies(params), dynamicTimeout("yts")),
    },
    {
      name: "jackett",
      fn: () =>
        withTimeout(
          jackett.searchMovies(params.query || params.query_term || "", 20),
          dynamicTimeout("jackett"),
        ),
    },
    {
      name: "fallback",
      fn: () =>
        withTimeout(fallback.listMovies(params), dynamicTimeout("fallback")),
    },
  ]
    .filter((p) => health.isHealthy(p.name) && isProviderHealthy(p.name))
    .sort((a, b) => {
      // Order by historical avg time (fastest first)
      const sa = getStats(a.name)?.avgTime || Infinity;
      const sb = getStats(b.name)?.avgTime || Infinity;
      return sa - sb;
    });

  if (!providers.length) {
    console.warn("⚠️ All providers unhealthy → resetting");
    providers = [
      { name: "yts", fn: () => withTimeout(yts.listMovies(params), 15000) },
      {
        name: "jackett",
        fn: () =>
          withTimeout(
            jackett.searchMovies(params.query || params.query_term || "", 20),
            15000,
          ),
      },
      {
        name: "fallback",
        fn: () => withTimeout(fallback.listMovies(params), 15000),
      },
    ];
  }

  // Ensure Jackett is always included (even if health check failed)
  if (!providers.some((p) => p.name === "jackett")) {
    providers.push({
      name: "jackett",
      fn: () =>
        withTimeout(
          jackett.searchMovies(params.query || params.query_term || "", 20),
          12000,
        ),
    });
  }

  try {
    // PHASE 1: Race for fastest result
    const { result: winnerResult, name: winnerName } = await raceProvidersV2(
      providers,
      1000,
    );

    if (!winnerResult || !winnerResult.length) {
      throw new Error("No results from race");
    }

    console.log(`🏆 Race winner: ${winnerName}`);
    health.markSuccess(winnerName);

    // PHASE 2: Merge Jackett results (always include Jackett for diversity)
    let allTorrents = [...winnerResult];

    // Fetch Jackett if it didn't win (ensures Jackett always contributes)
    if (winnerName !== "jackett") {
      const jackettResults = await fetchJackettSearchResults(params);
      if (jackettResults?.length) {
        const tagged = jackettResults.map((t) => ({
          ...t,
          provider: "jackett",
        }));
        allTorrents.push(...tagged);
        console.log(`📦 Merged ${jackettResults.length} Jackett results`);
      }
    }

    // Deduplicate by hash/magnet/title
    const deduped = deduplicateTorrents(allTorrents);

    // Enrich with parsed metadata and qualityScore (if not already present)
    const enriched = deduped.map((t) => ({
      ...t,
      parsed: t.parsed || parseRelease(t.title || t.filename || t.name || ""),
      qualityScore: t.qualityScore || t.parsed?.score || 0,
    }));

    // Re-score with combined formula
    const scored = enriched.map((t) => ({
      ...t,
      finalScore: calculateFinalScore(t),
    }));

    // Sort by finalScore, cap at 20
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Logging for visibility
    console.log(`📊 Final results: ${scored.length}`);
    console.log(`📊 Providers in final set:`, [
      ...new Set(scored.map((t) => t.provider)),
    ]);

    return scored.slice(0, 20);
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

const TIMEOUTS = {
  YTS: 6000,
  OMDb: 5000,
  JACKETT: 30000,
  EZTV: 6000,
  CACHE_TTL: 24 * 60 * 60 * 1000,
};

// ------------------------------
// Get movie by IMDb ID with aggregation and enrichment
// ------------------------------
async function getMovieByImdb(imdbId) {
  const allTorrents = [];
  let movieMeta = null;
  let searchTitle = null;
  let searchYear = null;

  const omdbPromise = cached(`omdb:title:${imdbId}`, TIMEOUTS.CACHE_TTL, () =>
    omdb.getMetaByImdb(imdbId),
  ).catch((err) => {
    console.warn(`[aggregator] OMDb cache miss/error: ${err.message}`);
    return null;
  });

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

  const ytsResult = await ytsPromise;

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

  if (allTorrents.length === 0) {
    return fallback.getMovieByImdb(imdbId);
  }

  const enrichedTorrents = allTorrents.map((t) => {
    const parsed = parseRelease(t.title || t.filename || t.name || "");
    return {
      ...t,
      parsed,
      qualityScore: parsed?.score || 0,
    };
  });

  enrichedTorrents.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore)
      return b.qualityScore - a.qualityScore;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  return {
    ...movieMeta,
    imdbId,
    title: searchTitle || "Aggregated Result",
    torrents: enrichedTorrents,
    provider: "merged",
  };
}

// ------------------------------
// ✅ FIXED: getShowMeta - was missing
// ------------------------------
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

// ------------------------------
// Helper: clean show title (remove year ranges)
// ------------------------------
function cleanShowTitle(title) {
  if (!title) return title;
  let cleaned = title
    .replace(/\s*[–-]\s*\d{4}\s*$/, "")
    .replace(/\s*\(\d{4}[–-]\d{4}\)\s*$/, "")
    .replace(/\s*[–-]\s*$/, "")
    .trim();
  return cleaned;
}

// ------------------------------
// Improved getShowTorrents with year fixes
// ------------------------------
async function getShowTorrents(imdbId) {
  const allTorrents = {};
  let showTitle = null;
  let showYear = null;

  // 1. Fetch OMDb metadata
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

  const cleanedTitle = showTitle ? cleanShowTitle(showTitle) : null;
  console.log(
    `[aggregator] Cleaned show title: ${cleanedTitle} (original: ${showTitle})`,
  );

  // 2. EZTV promise (uses IMDb ID and original title)
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

  // 3. Jackett promise – pass year = null to disable year filtering
  const jackettPromise = withTimeout(
    jackett.getShowTorrents(imdbId, cleanedTitle),
    35000,
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

  // 4. Wait for both
  const [eztvData, jackettData] = await Promise.all([
    eztvPromise,
    jackettPromise,
  ]);

  // 5. Merge torrents
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

  if (Object.keys(allTorrents).length === 0) {
    console.warn(
      `[aggregator] No torrents found for ${imdbId} from EZTV or Jackett`,
    );
    return fallback.getShowTorrents(imdbId);
  }

  // 6. Sort torrents within each episode (Quality > Seeds)
  for (const season of Object.keys(allTorrents)) {
    for (const episode of Object.keys(allTorrents[season])) {
      allTorrents[season][episode].sort((a, b) => {
        if (b.qualityScore !== a.qualityScore)
          return b.qualityScore - a.qualityScore;
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
  getShowMeta, // ✅ now defined
};
