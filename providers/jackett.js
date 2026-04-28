"use strict";

const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// ================= CONFIG =================
const CONFIG = Object.freeze({
  jackett: {
    baseUrl:
      process.env.JACKETT_URL?.replace(/\/$/, "") || "http://localhost:9696",
    apiKey: process.env.JACKETT_API_KEY,
    timeout: parseInt(process.env.JACKETT_TIMEOUT, 10) || 20000,
    maxRetries: parseInt(process.env.JACKETT_MAX_RETRIES, 10) || 2,
    retryDelay: parseInt(process.env.JACKETT_RETRY_DELAY, 10) || 800,
    categories: { movie: [2000], tv: [5000] },
    maxResults: 50,
    minSeeds: 1,
  },
});

if (!CONFIG.jackett.apiKey) {
  throw new Error("❌ JACKETT_API_KEY is required");
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

function buildMagnet(hash, name) {
  if (!hash) return null;
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(name)}${TRACKERS}`;
}

// ================= SCORE =================
function calculateScore(t) {
  let score = 0;

  // Resolution
  if (t.quality === "2160p") score += 50;
  else if (t.quality === "1080p") score += 30;
  else if (t.quality === "720p") score += 10;

  // Source — single block, no double-counting
  if (t.source === "REMUX") score += 110;
  else if (t.source === "BluRay") score += 50;
  else if (t.source === "WEB-DL") score += 30;
  else if (t.source === "WEBRip") score += 20;

  // HDR
  if (t.hdr === "Dolby Vision") score += 40;
  else if (t.hdr === "HDR10+") score += 35;
  else if (t.hdr === "HDR") score += 25;

  // Codec
  if (t.codec === "x265") score += 15;
  else if (t.codec === "x264") score += 5;

  // Audio
  if (t.audio === "TrueHD") score += 20;
  else if (t.audio === "DTS-HD") score += 15;

  // Seeder health — log scale, capped at 30pts
  // Dead torrents (0 seeds) get -20 penalty instead of a neutral 0
  if (t.seeds <= 0) {
    score -= 20;
  } else {
    score += Math.min(Math.log10(t.seeds) * 5, 30);
  }

  // Penalise known lower-quality public indexers
  if (t.indexer?.toLowerCase().includes("1337x")) score -= 10;

  // Penalise suspiciously small 4K files — source-aware thresholds:
  // WEB-DL/WEBRip 4K can legitimately be ~8-15 GB; REMUX/BluRay should be much larger
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
  retries = CONFIG.jackett.maxRetries,
) {
  try {
    return await axios.get(url, options);
  } catch (err) {
    // Don't retry auth/bad-request errors — they won't resolve
    if (NON_RETRYABLE_STATUS.has(err.response?.status)) throw err;

    if (retries > 0) {
      await new Promise((r) => setTimeout(r, CONFIG.jackett.retryDelay));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

// ================= SEARCH =================
async function executeSearch(query, type, signal, advancedParams = {}) {
  // Prowlarr expects the full "ttXXXXXXX" IMDb format — pass it through as-is.
  // Do NOT strip the "tt" prefix here.

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
        categories: CONFIG.jackett.categories.tv,
        ...(query &&
          !advancedParams.tvdbid &&
          !advancedParams.tvmazeid &&
          !advancedParams.imdbid && { query }),
        ...(advancedParams.tvdbid && { tvdbid: advancedParams.tvdbid }),
        ...(advancedParams.tvmazeid && { tvmazeid: advancedParams.tvmazeid }),
        ...(advancedParams.imdbid && { imdbid: advancedParams.imdbid }),
        ...(advancedParams.season && { season: advancedParams.season }),
        ...(advancedParams.ep && { ep: advancedParams.ep }),
      };
    } else {
      params = {
        type: "moviesearch",
        categories: CONFIG.jackett.categories.movie,
        ...(query &&
          !advancedParams.imdbid &&
          !advancedParams.tmdbid && { query }),
        ...(advancedParams.imdbid && { imdbid: advancedParams.imdbid }),
        ...(advancedParams.tmdbid && { tmdbid: advancedParams.tmdbid }),
      };
    }

    // Remove undefined/null keys
    Object.keys(params).forEach(
      (key) => params[key] == null && delete params[key],
    );

    const res = await fetchWithRetry(
      `${CONFIG.jackett.baseUrl}/api/v1/search`,
      {
        params,
        timeout: CONFIG.jackett.timeout,
        signal,
        headers: {
          "X-Api-Key": CONFIG.jackett.apiKey,
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
async function getTorrents(imdbId, title, year) {
  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(),
    CONFIG.jackett.timeout,
  );

  try {
    const searches = [];

    if (imdbId) {
      searches.push(
        executeSearch(null, "moviesearch", controller.signal, {
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
      .filter((t) => t.seeds >= CONFIG.jackett.minSeeds);

    const scored = parsed.map((t) => ({ ...t, score: calculateScore(t) }));
    const clusters = clusterTorrents(scored);
    const bestPerCluster = pickBestFromClusters(clusters);

    return bestPerCluster
      .map((t) => ({ ...t, label: buildLabel(title, year, t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.jackett.maxResults);
  } finally {
    clearTimeout(abortTimer);
  }
}

// ================= MOVIE =================
async function getMovieByImdb(imdbId, title, year) {
  const torrents = await getTorrents(imdbId, title, year);
  return torrents.length ? { imdbId, title, year, torrents } : null;
}

async function searchMovies(query, limit = 20) {
  const torrents = await getTorrents(null, query, null);
  return torrents.slice(0, limit);
}

// ================= SHOW =================
/**
 * TV search via Prowlarr.
 *
 * @param {string} imdbId  - Full IMDb ID with tt prefix (e.g. "tt0944947")
 * @param {string} title   - Show title for title-match fallback
 * @param {number} [season]  - Optional season number for targeted search
 * @param {number} [ep]      - Optional episode number (requires season)
 * @returns {object} seasons map: { "1": { "1": [torrents], "2": [torrents] }, ... }
 *                   Full-season packs land under { "1": { "0": [torrents] } } by convention.
 */
async function getShowTorrents(imdbId, title, season, ep) {
  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(),
    CONFIG.jackett.timeout,
  );

  try {
    const searches = [];

    // Primary: search by IMDb ID (most indexers support this via Prowlarr)
    if (imdbId) {
      searches.push(
        executeSearch(null, "tvsearch", controller.signal, {
          imdbid: imdbId,
          ...(season != null && { season }),
          ...(ep != null && { ep }),
        }),
      );
    }

    // Fallback: title query — handles indexers that don't support IMDb ID for TV
    if (title) {
      const query = [
        cleanTitle(title),
        season != null ? `S${String(season).padStart(2, "0")}` : null,
        ep != null ? `E${String(ep).padStart(2, "0")}` : null,
      ]
        .filter(Boolean)
        .join(" ");

      searches.push(
        executeSearch(query, "tvsearch", controller.signal, {
          ...(season != null && { season }),
          ...(ep != null && { ep }),
        }),
      );
    }

    const raw = (await Promise.all(searches)).flat();
    const unique = deduplicateResults(raw);

    const parsed = unique
      .map((item) => parseTorrent(item, title))
      .filter(Boolean);

    // Group by season and episode
    // Supports: S01E01, 1x01, S01 (full season pack → ep "0"), S01-S03 (multi-season → ep "0")
    const seasons = {};

    for (const t of parsed) {
      const name = t.title || "";

      // Full season pack: S01 with no episode
      const packMatch = name.match(/\bS(\d+)\b(?!E\d)/i);
      // Episode: S01E01 or 1x01
      const epMatch =
        name.match(/S(\d{1,2})E(\d{1,2})/i) || name.match(/(\d{1,2})x(\d{2})/i);

      let s, e;

      if (epMatch) {
        s = String(parseInt(epMatch[1]));
        e = String(parseInt(epMatch[2]));
      } else if (packMatch) {
        s = String(parseInt(packMatch[1]));
        e = "0"; // convention: episode 0 = full season pack
      } else {
        continue; // skip unrecognised naming
      }

      seasons[s] ??= {};
      seasons[s][e] ??= [];
      seasons[s][e].push({ ...t, score: calculateScore(t) });
    }

    // Sort each episode's torrent list by score descending
    for (const s of Object.values(seasons)) {
      for (const epList of Object.values(s)) {
        epList.sort((a, b) => b.score - a.score);
      }
    }

    return seasons;
  } finally {
    clearTimeout(abortTimer);
  }
}

// ================= EXPORT =================
module.exports = {
  getMovieByImdb,
  getTorrents,
  getShowTorrents,
  searchMovies,
};
