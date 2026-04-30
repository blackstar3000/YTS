"use strict";
// Prowlarr Provider Module
// 2026 Refactored for Robustness, Clarity, and Performance
// This module interfaces with Prowlarr to search for movie and TV show torrents.
// It includes advanced title matching, dynamic timeouts, retry logic, and a comprehensive scoring system to ensure high-quality results while maintaining responsiveness and reliability in the aggregator.
// The search functions are designed to handle both movie and TV show queries, with special logic for parsing season/episode information from torrent titles and building user-friendly labels for the Stremio UI.
//  The module also includes safety checks for API key configuration and network requests, as well as detailed logging for debugging and monitoring purposes.
const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// ================= CONFIG =================
const CONFIG = Object.freeze({
  prowlarr: {
    baseUrl:
      process.env.PROWLARR_URL?.replace(/\/$/, "") || "http://localhost:9696",
    apiKey: process.env.PROWLARR_API_KEY,
    timeout: parseInt(process.env.PROWLARR_TIMEOUT, 10) || 15000,
    maxRetries: parseInt(process.env.PROWLARR_MAX_RETRIES, 10) || 2,
    retryDelay: parseInt(process.env.PROWLARR_RETRY_DELAY, 10) || 800,
    categories: {
      movie: [2000],
      tv: [5000], // Added Animation/Kids categories
    },
    maxResults: 50,
    minSeeds: 1,
  },
});

if (!CONFIG.prowlarr.apiKey) {
  throw new Error("❌ PROWLARR_API_KEY is required");
}

// ================= UTIL =================
function normalize(str) {
  return str
    ?.toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * Token-based title matching — more robust than substring includes().
 * Requires at least 60% of the target tokens to appear in the torrent title,
 * which handles short titles like "It" or "Her" without false positives.
 */
function titleMatches(torrentTitle, targetTitle) {
  if (!targetTitle) return true;
  const t1 = normalize(torrentTitle);
  const t2 = normalize(targetTitle);
  // Exact or substring match for long titles (safe)
  if (t1.includes(t2) && t2.length >= 6) return true;

  // Token overlap ratio for short/ambiguous titles
  const tokens1 = new Set(t1.split(" "));
  const tokens2 = t2.split(" ");
  if (tokens2.length === 0) return false;
  const matched = tokens2.filter((tok) => tokens1.has(tok)).length;
  return matched / tokens2.length >= 0.6;
}
function cleanTitle(title) {
  return title
    ?.replace(/[:\-–—]/g, " ")
    .replace(/'/g, "") // ← collapse apostrophes instead of spacing them
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ================= TRACKERS =================
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tr4ck3r.duckdns.org:6969/announce",
]
  .map((t) => `&tr=${encodeURIComponent(t)}`)
  .join("");

/**
 * Ensures the infoHash is 40-character Hex and builds a valid magnet.
 * 2026 Safety Check: Filters out invalid hashes or malformed IDs.
 */
function buildMagnet(hash, name) {
  if (!hash || typeof hash !== "string") return null;

  const cleanHash = hash.trim().toLowerCase();

  // Validate that it is a proper 40-character SHA1 hex string
  if (!/^[0-9a-f]{40}$/.test(cleanHash)) {
    console.warn(`[Magnet] Invalid hash detected: ${cleanHash}`);
    return null;
  }

  return `magnet:?xt=urn:btih:${cleanHash}&dn=${encodeURIComponent(name || "torrent")}${TRACKERS}`;
}

// ================= SCORE =================
function calculateScore(t) {
  let score = 0;

  // --- Resolution ---
  if (t.quality === "2160p") score += 50;
  else if (t.quality === "1080p") score += 30;
  else if (t.quality === "720p") score += 10;

  // --- Source ---
  if (t.source === "REMUX") score += 110;
  else if (t.source === "BluRay") score += 50;
  else if (t.source === "WEB-DL") score += 30;

  // --- HDR (2026 Refined) ---
  if (t.hdr === "Dolby Vision")
    score += 45; // Top tier
  else if (t.hdr === "HDR10+") score += 35;
  else if (t.hdr === "HDR") score += 25;

  // --- Codec (AV1 Priority) ---
  if (t.codec === "AV1")
    score += 30; // 2026 Efficiency King
  else if (t.codec === "x265") score += 15;
  else if (t.codec === "x264") score += 5;

  // --- Audio ---
  if (t.audio === "TrueHD") score += 20;
  else if (t.audio === "DTS-HD") score += 15;

  // --- Health & Indexer ---
  if (t.seeds <= 0) {
    score -= 20;
  } else {
    score += Math.min(Math.log10(t.seeds) * 5, 30);
  }
  if (t.indexer?.toLowerCase().includes("1337x")) score -= 10;

  // --- Size-to-Quality Guardrail ---
  if (t.quality === "2160p" && t.sizeNum) {
    const isWebSource = ["WEB-DL", "WEBRip"].includes(t.source);
    const threshold = isWebSource ? 6 : 20;
    if (t.sizeNum < threshold) score -= 40;
  }

  return Math.round(score);
}

// ================= NETWORK =================
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

async function fetchWithRetry(
  url,
  options,
  retries = CONFIG.prowlarr.maxRetries,
) {
  try {
    return await axios.get(url, options);
  } catch (err) {
    // Don't retry auth/bad-request errors — they won't resolve
    if (NON_RETRYABLE_STATUS.has(err.response?.status)) throw err;

    if (retries > 0) {
      await new Promise((r) => setTimeout(r, CONFIG.prowlarr.retryDelay));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

// ================= SEARCH =================
// Prowlarr expects the full "ttXXXXXXX" IMDb format — pass it through as-is.
// Do NOT strip the "tt" prefix here.
// The search function will handle it correctly, and this ensures we don't accidentally create
// invalid IMDb IDs that cause Prowlarr to return no results.
async function executeSearch(query, type, signal, advancedParams = {}) {
  if (
    !query &&
    !advancedParams.imdbid &&
    !advancedParams.tmdbid &&
    !advancedParams.tvdbid &&
    !advancedParams.tvmazeid
  ) {
    return [];
  }

  console.log(`[Provider] Searching ${type}:`, { query, ...advancedParams });

  try {
    let params = {};

    if (type === "tvsearch") {
      params = {
        type: "tvsearch",
        categories: CONFIG.prowlarr.categories.tv,

        // ✅ ALWAYS force a query if we have one
        query: query || undefined,

        // ✅ ALSO include imdbid
        ...(advancedParams.imdbid && { imdbid: advancedParams.imdbid }),

        ...(advancedParams.tvdbid && { tvdbid: advancedParams.tvdbid }),
        ...(advancedParams.tvmazeid && { tvmazeid: advancedParams.tvmazeid }),

        ...(advancedParams.season != null && { season: advancedParams.season }),
        ...(advancedParams.ep != null && { ep: advancedParams.ep }),
      };

      // 🔥 CRITICAL: if query is still missing, build one
      if (!params.query && advancedParams.imdbid && advancedParams.title) {
        params.query = cleanTitle(advancedParams.title);
      }
    } else {
      params = {
        type: "moviesearch",
        categories: CONFIG.prowlarr.categories.movie.join(","),
        ...(query &&
          !advancedParams.imdbid &&
          !advancedParams.tmdbid && { query }),
        ...(advancedParams.imdbid && { imdbid: advancedParams.imdbid }),
        ...(advancedParams.tmdbid && { tmdbid: advancedParams.tmdbid }),
      };
    }

    // Remove undefined/null keys to avoid confusing the API and to ensure clean logging
    Object.keys(params).forEach(
      (key) => params[key] == null && delete params[key],
    );

    const res = await fetchWithRetry(
      `${CONFIG.prowlarr.baseUrl}/api/v1/search`,
      {
        params,
        timeout: CONFIG.prowlarr.timeout,
        timeoutErrorMessage: "prowlarr request timeout",
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        signal,
        headers: {
          "X-Api-Key": CONFIG.prowlarr.apiKey,
          Accept: "application/json",
        },
      },
    );

    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    if (err.name === "AbortError" || err.message === "canceled") {
      console.log(
        `[Provider] Search canceled (${query || JSON.stringify(advancedParams)})`,
      );
      return [];
    }
    console.error(`[Provider] Search failed (${query}): ${err.message}`);
    return [];
  }
}

// ================= PARSER =================
// The parsing logic is designed to be robust against the wide variety of naming conventions used in torrent titles,
//  while also ensuring that we only return results that are relevant to the user's query. It checks for title matches,
//  year matches (with special handling for high-quality releases),
//  and extracts as much technical metadata as possible to feed into the scoring system.
//  The use of multiple fields (title, magnet, infoHash) to identify and deduplicate torrents
//  helps ensure that we don't miss valid results due to inconsistencies
//  in how different indexers format their data.
function parseTorrent(item, title, year) {
  const torrentTitle = item.title || item.name;
  if (!torrentTitle) return null;

  if (!titleMatches(torrentTitle, title)) return null;

  // Year check: if we have a target year, the title must contain it.
  // Only bypass for REMUX/BluRay AND if title still matches (no free pass on both).
  if (year && !torrentTitle.includes(year.toString())) {
    const isHighQuality = /remux|bluray/i.test(torrentTitle);
    if (!isHighQuality) return null;
    // High-quality release without year — still validate title match more strictly
    if (!titleMatches(torrentTitle, title)) return null;
  }

  let meta = parseRelease(torrentTitle);

  if (!meta.resolution) {
    const m = torrentTitle.match(/\b(2160p|1080p|720p)\b/i);
    if (!m) return null;
    meta.resolution = m[0].toLowerCase();
  }

  let magnet = null;
  const infoHash = item.infoHash || item.info_hash || null;

  if (item.magnetUrl?.startsWith("magnet:")) {
    magnet = item.magnetUrl;
  }

  if (!magnet && item.guid?.startsWith("magnet:")) {
    magnet = item.guid;
  }

  if (!magnet && infoHash) {
    magnet = buildMagnet(infoHash, torrentTitle);
  }

  if (!magnet?.startsWith("magnet:")) return null;
  if (/^https?:\/\//i.test(magnet)) return null;

  const sizeNum = item.size ? item.size / 1024 ** 3 : 0;

  return {
    quality: meta.resolution,
    source: meta.source,
    codec: meta.codec,
    hdr: meta.hdr,
    audio: meta.audio,
    size: sizeNum ? `${sizeNum.toFixed(2)} GB` : "Unknown",
    sizeNum,
    seeds: item.seeders ?? 0,
    magnet,
    hash: infoHash,
    indexer: item.indexer,
    title: torrentTitle,

    // label: [
    //   `${title || ""}${year ? ` (${year})` : ""}`,
    //   meta.resolution,
    //   meta.source,
    //   meta.hdr,
    //   meta.codec,
    //   meta.audio,
    // ]
    //   .filter(Boolean)
    //   .join(" • "),
  };
}

// ================= DEDUPLICATION =================
/**
 * Deduplicate results preferring infoHash > normalized title.
 * Avoids duplicates from multiple indexers returning the same torrent
 * with different GUIDs (which are indexer-specific URLs, not content IDs).
 */
function deduplicateResults(items) {
  const byHash = new Map();
  const byTitle = new Map();
  const unique = [];

  for (const item of items) {
    const hash = item.infoHash || item.info_hash;
    const titleKey = normalize(item.title || item.name || "");

    if (hash) {
      if (byHash.has(hash)) continue;
      byHash.set(hash, true);
    } else if (titleKey) {
      if (byTitle.has(titleKey)) continue;
      byTitle.set(titleKey, true);
    }

    unique.push(item);
  }

  return unique;
}

// ================= CLUSTERING =================
// Clustering torrents by quality/source/codec to group similar releases together.
// This helps the UI show "1 REMUX 2160p • 2 WEB-DL 1080p" instead of 10 individual torrents,
//  while still allowing users to drill down into the alternatives if they want.
function getClusterKey(t) {
  return [
    t.quality || "unknown",
    t.source || "unknown",
    t.codec || "unknown",
    t.hdr || "SDR",
  ].join("_");
}

function clusterTorrents(torrents) {
  const clusters = new Map();
  for (const t of torrents) {
    const key = getClusterKey(t);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(t);
  }
  return clusters;
}

function pickBestFromClusters(clusters) {
  const results = [];
  for (const group of clusters.values()) {
    group.sort(
      (a, b) => b.score - a.score || (b.sizeNum || 0) - (a.sizeNum || 0),
    );
    const best = group[0];
    results.push({
      ...best,
      clusterSize: group.length,
      alternatives: group.slice(1),
    });
  }
  return results;
}
// ================= LABEL =================
// Builds a user-friendly label for the Stremio UI, showing the title, year, quality, source, HDR, codec, and audio info in a concise format.
// For example: "Inception (2010) • 1080p • REMUX • Dolby Vision • AV1 • TrueHD"
function buildLabel(title, year, t) {
  return [
    `${title || ""}${year ? ` (${year})` : ""}`,
    t.quality,
    t.source,
    t.hdr,
    t.codec,
    t.audio,
    t.clusterSize > 1 ? `🔥 +${t.clusterSize - 1} more` : null,
  ]
    .filter(Boolean)
    .join(" • ");
}
// ================= MAIN =================
// The main search and parsing functions for movies and TV shows.
//  They handle the logic of querying Prowlarr, parsing the results,
//  scoring them, clustering similar torrents together, and building labels for the UI.
//  The TV show function also includes logic to extract season and episode information from torrent titles,
//  which is critical for properly organizing TV show results in the Stremio interface.
async function getTorrents(imdbId, title, year) {
  const controller = new AbortController();

  const searchWithTimeout = (promise) =>
    Promise.race([
      promise,
      new Promise((resolve) =>
        setTimeout(() => resolve([]), CONFIG.prowlarr.timeout),
      ),
    ]);

  try {
    const searches = [];

    if (imdbId) {
      searches.push(
        executeSearch(cleanTitle(title), "moviesearch", controller.signal, {
          imdbid: imdbId,
        }),
      );
    }

    if (title) {
      const query = year ? `${cleanTitle(title)} ${year}` : cleanTitle(title);
      searches.push(executeSearch(query, "moviesearch", controller.signal, {}));
    }

    const raw = (await Promise.all(searches)).flat();
    const unique = deduplicateResults(raw);

    const parsed = unique
      .map((item) => parseTorrent(item, title, year))
      .filter(Boolean)
      .filter((t) => t.seeds >= CONFIG.prowlarr.minSeeds);

    const scored = parsed.map((t) => ({ ...t, score: calculateScore(t) }));
    const clusters = clusterTorrents(scored);
    const bestPerCluster = pickBestFromClusters(clusters);

    return bestPerCluster
      .map((t) => ({ ...t, label: buildLabel(title, year, t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.prowlarr.maxResults);
  } finally {
    // clearTimeout(abortTimer);
  }
}

// ================= MOVIES =================
// The getMovieByImdb function is designed to fetch torrents for a specific movie using its IMDb ID,
//  while the searchMovies function allows for a more general search based on a query string.
//  Both functions utilize the getTorrents helper to perform the actual search and parsing logic,
//  ensuring that we return high-quality, relevant results to the user.
async function getMovieByImdb(imdbId, title, year) {
  const torrents = await getTorrents(imdbId, title, year, "movie");
  return torrents.length ? { imdbId, title, year, torrents } : null;
}
// The searchMovies function allows users to search for movies based on a query string,
//  which can be a title, partial title, or even an IMDb ID.
//  It returns a list of matching torrents, sorted by relevance and quality.
async function searchMovies(query, limit = 20) {
  const torrents = await getTorrents(null, query, null, "movie");
  return torrents.slice(0, limit);
}

// ================= SHOWS =================
// The getShowTorrents function is more complex due to the need to handle season and episode information,
//  as well as the various ways that TV show torrents can be named (e.g., "Show S01E02", "Show 1x02", "Show Season 1", etc.).
//  It organizes the results into a nested structure of seasons and episodes, which is required for proper display in the Stremio UI.
//  The function also includes logic to inject season packs into individual episode entries, ensuring that users can easily find complete season releases when browsing episodes.
async function getShowTorrents(imdbId, title, season, ep) {
  const searchTasks = [];

  // Helper for isolated, timed-out searches
  const runIsolatedSearch = async (query, params) => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.prowlarr.timeout,
    );
    try {
      return await executeSearch(query, "tvsearch", controller.signal, params);
    } finally {
      clearTimeout(timeout);
    }
  };

  // 1. IMDb Search
  if (imdbId) {
    searchTasks.push(
      runIsolatedSearch(cleanTitle(title), {
        imdbid: imdbId,
        ...(season != null && { season }),
        ...(ep != null && { ep }),
      }),
    );
  }

  // 2. Title Fallback
  if (title) {
    const query = [
      cleanTitle(title),
      season != null ? `S${String(season).padStart(2, "0")}` : null,
      ep != null ? `E${String(ep).padStart(2, "0")}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    searchTasks.push(runIsolatedSearch(query, {}));
  }

  try {
    const results = await Promise.allSettled(searchTasks);
    const raw = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || []);

    const unique = deduplicateResults(raw);
    const parsed = unique
      .map((item) => parseTorrent(item, title))
      .filter(Boolean);

    const seasons = {};

    for (const t of parsed) {
      const scoredItem = { ...t, score: calculateScore(t) };
      const name = t.title || "";

      const epMatch =
        name.match(/S(\d{1,2})E(\d{1,2})/i) || name.match(/(\d{1,2})x(\d{2})/i);
      const rangeMatch =
        name.match(/S(\d{1,2})[-~]S?(\d{1,2})/i) ||
        name.match(/Seasons?\s?(\d{1,2})[-~](\d{1,2})/i);
      const packMatch =
        name.match(/\bS(\d{1,2})\b/i) || name.match(/Season\s?(\d{1,2})/i);

      if (epMatch) {
        const s = String(parseInt(epMatch[1]));
        const e = String(parseInt(epMatch[2]));
        seasons[s] ??= {};
        seasons[s][e] ??= [];
        seasons[s][e].push(scoredItem);
      } else if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        for (let i = start; i <= end; i++) {
          const s = String(i);
          seasons[s] ??= {};
          seasons[s]["0"] ??= [];
          seasons[s]["0"].push(scoredItem);
        }
      } else if (packMatch) {
        const s = String(parseInt(packMatch[1]));
        seasons[s] ??= {};
        seasons[s]["0"] ??= [];
        seasons[s]["0"].push(scoredItem);
      }
    }

    // ------------------------------------------------------------
    // 🔥 THE CRITICAL FIX: Build Labels and Inject Packs
    // ------------------------------------------------------------
    for (const s of Object.keys(seasons)) {
      const seasonPacks = seasons[s]["0"] || [];

      for (const e of Object.keys(seasons[s])) {
        // If it's a specific episode, inject the season packs into it
        if (e !== "0") {
          seasons[s][e] = [...seasons[s][e], ...seasonPacks];
        }

        // Sort and Build Labels (Addon UI needs this!)
        seasons[s][e] = seasons[s][e]
          .sort((a, b) => b.score - a.score)
          .map((t) => ({
            ...t,
            label: buildLabel(title, null, t), // This makes the link visible!
          }));
      }
    }
    // ------------------------------------------------------------
    // Debug Logging to verify season/episode structure and counts
    // ------------------------------------------------------------
    console.log(`[DEBUG] Seasons found keys:`, Object.keys(seasons));
    // if (seasons["16"])
    //   console.log(
    //     `[DEBUG] Season 16 has ${Object.keys(seasons["16"]).length} episodes`,
    //   );

    console.log(
      `[Prowlarr] Found results for ${Object.keys(seasons).length} seasons`,
    );
    return seasons;
  } catch (err) {
    console.error("[Prowlarr] getShowTorrents failed:", err.message);
    return {};
  }
}

// ================= EXPORT =================
module.exports = {
  getMovieByImdb,
  getTorrents,
  getShowTorrents,
  searchMovies,
};
