"use strict";

const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// ============================================================================
// Configuration & Validation
// ============================================================================

const CONFIG = Object.freeze({
  jackett: {
    baseUrl:
      process.env.JACKETT_URL?.replace(/\/$/, "") || "http://localhost:9696",
    apiKey: process.env.JACKETT_API_KEY,
    timeout: parseInt(process.env.JACKETT_TIMEOUT, 10) || 30000,
    maxRetries: parseInt(process.env.JACKETT_MAX_RETRIES, 10) || 2,
    retryDelay: parseInt(process.env.JACKETT_RETRY_DELAY, 10) || 1000,
    categories: { movie: [2000], tv: [5000] },
    maxResults: 50,
  },
  scoring: {
    resolution: { "2160p": 50, "1080p": 30, "720p": 10 },
    source: { REMUX: 80, BluRay: 50, "WEB-DL": 30, WEBRip: 20 },
    hdr: { "Dolby Vision": 40, "HDR10+": 35, HDR: 25 },
    codec: { x265: 15, x264: 5 },
    audio: { TrueHD: 20, "DTS-HD": 15, DTS: 10 },
    remuxBoost: 30,
    maxSeedScore: 30,
  },
  search: {
    minTitleLength: 2, // Allow short titles like "Up", "It"
    cleanPatterns: /[^a-zA-Z0-9 ]/g,
  },
});

// Validate configuration on load
if (!CONFIG.jackett.apiKey) {
  throw new Error("❌ JACKETT_API_KEY environment variable is required");
}

// ============================================================================
// Types & Interfaces (JSDoc)
// ============================================================================

/**
 * @typedef {Object} TorrentMeta
 * @property {string} quality - Resolution (e.g., "1080p")
 * @property {string} source - Source type (e.g., "REMUX")
 * @property {string} codec - Video codec (e.g., "x265")
 * @property {string} hdr - HDR type (e.g., "HDR10+")
 * @property {string} audio - Audio format (e.g., "TrueHD")
 */

/**
 * @typedef {Object} TorrentResult
 * @property {TorrentMeta} meta
 * @property {string} size - Formatted size string
 * @property {number} seeds - Seed count
 * @property {number} peers - Peer count
 * @property {string} hash - Torrent info hash
 * @property {string} magnet - Magnet URI
 * @property {string} indexer - Indexer name
 * @property {string} title - Full torrent title
 * @property {number} score - Calculated quality score
 */

/**
 * @typedef {Object} MovieResult
 * @property {string} imdbId
 * @property {string} title
 * @property {TorrentResult[]} torrents
 */

// ============================================================================
// Utilities
// ============================================================================

class JackettError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "JackettError";
    this.cause = cause;
  }
}

function sanitizeQuery(input) {
  if (typeof input !== "string") return "";
  return input.trim().substring(0, 100); // Prevent overly long queries
}

function normalize(str) {
  return str
    ?.toLowerCase()
    .replace(CONFIG.search.cleanPatterns, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatches(torrentTitle, targetTitle) {
  if (!torrentTitle || !targetTitle) return false;

  const t1 = normalize(torrentTitle);
  const t2 = normalize(targetTitle);

  // More robust matching: check word inclusion for short titles
  if (t2.length <= 3) {
    return t1.split(/\s+/).includes(t2);
  }

  return t1.includes(t2) || t2.includes(t1);
}

function extractYear(title) {
  const match = title.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

// ============================================================================
// Scoring Engine
// ============================================================================

function calculateScore(torrent) {
  const { scoring } = CONFIG;
  let score = 0;

  // Resolution scoring
  score += scoring.resolution[torrent.quality] || 0;

  // Source scoring (with REMUX boost)
  score += scoring.source[torrent.source] || 0;
  if (torrent.source === "REMUX") {
    score += scoring.remuxBoost;
  }

  // HDR scoring
  score += scoring.hdr[torrent.hdr] || 0;

  // Codec scoring
  score += scoring.codec[torrent.codec] || 0;

  // Audio scoring
  score += scoring.audio[torrent.audio] || 0;

  // Seeds scaling (logarithmic to reduce dominance)
  score += Math.min(
    Math.log10(Math.max(torrent.seeds, 1)) * 5,
    scoring.maxSeedScore,
  );

  return Math.round(score);
}

// ============================================================================
// Retry & Request Handler
// ============================================================================

async function fetchWithRetry(
  url,
  options,
  retries = CONFIG.jackett.maxRetries,
) {
  try {
    return await axios.get(url, options);
  } catch (error) {
    if (retries > 0 && axios.isAxiosError(error)) {
      const delay =
        CONFIG.jackett.retryDelay *
        Math.pow(2, CONFIG.jackett.maxRetries - retries);
      console.warn(
        `[Provider] Request failed, retrying in ${delay}ms... (${retries} retries left)`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

// ============================================================================
// Search Executor
// ============================================================================

async function executeSearch(query, type = "movie") {
  const { baseUrl, apiKey, timeout, categories } = CONFIG.jackett;

  if (!query) {
    console.debug("[Provider] Skipping empty query");
    return [];
  }

  const sanitizedQuery = sanitizeQuery(query);
  console.log(`[Provider] Searching: ${sanitizedQuery}`);

  try {
    const response = await fetchWithRetry(`${baseUrl}/api/v1/search`, {
      params: {
        query: sanitizedQuery,
        categories: categories[type],
        type,
      },
      timeout,
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
        "User-Agent": "JackettProvider/1.0",
      },
    });

    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    throw new JackettError(`Search failed for "${query}"`, err);
  }
}

// ============================================================================
// Result Processing
// ============================================================================

function createTorrentKey(item) {
  // Prefer infoHash, fallback to normalized title + indexer
  if (item.infoHash) return `hash:${item.infoHash.toLowerCase()}`;
  const indexer = item.indexer || "unknown";
  const normalized = normalize(item.title || "");
  return `title:${indexer}:${normalized.substring(0, 50)}`;
}

function deduplicateResults(results) {
  const unique = new Map();

  for (const item of results) {
    const key = createTorrentKey(item);
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }

  return Array.from(unique.values());
}

function parseAndFilterTorrent(item, { title, year, strict = false }) {
  const torrentTitle = item.title;
  if (!torrentTitle) return null;

  // Skip TV episodes for movie searches
  if (/\bS\d{1,2}E\d{1,2}\b/i.test(torrentTitle)) {
    return null;
  }

  // Title matching
  if (title && !titleMatches(torrentTitle, title)) {
    if (strict) return null;
    // In non-strict mode, allow if IMDb ID is present (already searched by ID)
  }

  // Year matching (if no year in title, allow if it's a high-quality source)
  if (year && !torrentTitle.includes(year.toString())) {
    const hasQualityIndicator = /remux|bluray|web-?dl|webrip/i.test(
      torrentTitle,
    );
    if (!hasQualityIndicator) {
      console.debug(`[Provider] Skipping "${torrentTitle}" - year mismatch`);
      return null;
    }
  }

  const meta = parseRelease(torrentTitle);

  // Ensure resolution is detected
  if (!meta.resolution) {
    const fallback = torrentTitle.match(/\b(2160p|1080p|720p)\b/i);
    if (fallback) {
      meta.resolution = fallback[0].toLowerCase();
    } else {
      console.debug(`[Provider] Skipping "${torrentTitle}" - no resolution`);
      return null;
    }
  }

  // Validate required fields
  if (!item.magnetUrl && !item.infoHash) {
    console.debug(`[Provider] Skipping "${torrentTitle}" - no magnet/hash`);
    return null;
  }

  const sizeGB = item.size
    ? `${(item.size / 1024 ** 3).toFixed(2)} GB`
    : "Unknown";

  return {
    quality: meta.resolution,
    source: meta.source,
    codec: meta.codec,
    hdr: meta.hdr,
    audio: meta.audio,
    type: "web",
    size: sizeGB,
    seeds: item.seeders || 0,
    peers: item.leechers || 0,
    hash: item.infoHash || null,
    magnet: item.magnetUrl || null,
    indexer: item.indexer || "Prowlarr",
    title: torrentTitle,
  };
}

// ============================================================================
// Main Search Function
// ============================================================================

async function getTorrents(
  imdbId,
  title = null,
  year = null,
  timeout = CONFIG.jackett.timeout,
) {
  try {
    // Build search queries
    const searches = [];

    if (imdbId?.startsWith("tt")) {
      searches.push(executeSearch(imdbId, "movie"));
    }

    if (title && title.length >= CONFIG.search.minTitleLength) {
      const cleaned = title
        .replace(CONFIG.search.cleanPatterns, " ")
        .replace(/\s+/g, " ")
        .trim();
      const query = year ? `${cleaned} ${year}` : cleaned;
      searches.push(executeSearch(query, "movie"));
    }

    if (searches.length === 0) {
      console.warn("[Provider] No valid search criteria provided");
      return [];
    }

    // Execute searches with timeout control
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const resultsArrays = await Promise.all(
        searches.map((s) =>
          s.catch((err) => {
            console.error(`[Provider] Search branch failed: ${err.message}`);
            return [];
          }),
        ),
      );

      clearTimeout(timeoutId);

      const rawItems = resultsArrays.flat();
      console.log(`[Provider] Total raw results: ${rawItems.length}`);

      if (!rawItems.length) return [];

      // Deduplicate
      const uniqueItems = deduplicateResults(rawItems);
      console.log(`[Provider] After dedupe: ${uniqueItems.length}`);

      // Transform & filter
      const found = uniqueItems
        .map((item) => parseAndFilterTorrent(item, { title, year }))
        .filter(Boolean);

      console.log(`[Provider] Final results: ${found.length}`);

      // Score and sort
      return found
        .map((t) => ({ ...t, score: calculateScore(t) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, CONFIG.jackett.maxResults);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  } catch (error) {
    console.error(`[Provider] Fatal error: ${error.message}`);
    if (error instanceof JackettError) {
      console.error(`[Provider] Cause: ${error.cause?.message}`);
    }
    return [];
  }
}

// ============================================================================
// API Wrappers
// ============================================================================

async function getMovieByImdb(
  imdbId,
  title = null,
  year = null,
  timeout = CONFIG.jackett.timeout,
) {
  const torrents = await getTorrents(imdbId, title, year, timeout);
  return torrents.length > 0
    ? { imdbId, title: title || "Jackett Result", torrents }
    : null;
}

async function getShowTorrents(imdbId, timeout = 15000) {
  const torrents = await getTorrents(imdbId, null, null, timeout);
  if (!torrents.length) return {};

  const seasons = {};

  for (const t of torrents) {
    const sMatch = t.title.match(/S(\d+)/i);
    const eMatch = t.title.match(/E(\d+)/i);
    if (!sMatch || !eMatch) continue;

    const s = String(parseInt(sMatch[1], 10));
    const e = String(parseInt(eMatch[1], 10));

    seasons[s] = seasons[s] || {};
    seasons[s][e] = seasons[s][e] || [];
    seasons[s][e].push(t);
  }

  return seasons;
}

async function listMovies() {
  return [];
}

module.exports = {
  getMovieByImdb,
  getShowTorrents,
  listMovies,
  getTorrents,
  // Export internals for testing
  CONFIG,
  calculateScore,
  deduplicateResults,
  parseAndFilterTorrent,
};
