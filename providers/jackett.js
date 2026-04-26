"use strict";

const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// ============================================================================
// Constants & Configuration
// ============================================================================

const LIMITS = Object.freeze({
  MAX_QUERY_LENGTH: 100,
  MAX_RESULTS: 50,
  MIN_TITLE_LENGTH: 2,
  SEED_LOG_BASE: 10,
  CACHE_TTL: 300,
  MAX_RETRIES: 2,
  RETRY_DELAY: 500,
  CONNECT_TIMEOUT: 5000,
});

const CONFIG = Object.freeze({
  jackett: {
    baseUrl:
      process.env.JACKETT_URL?.replace(/\/$/, "") || "http://localhost:9696",
    apiKey: process.env.JACKETT_API_KEY,
    timeout: parseInt(process.env.JACKETT_TIMEOUT, 10) || 15000,
    tvTimeout: parseInt(process.env.JACKETT_TV_TIMEOUT, 10) || 15000,
    maxRetries:
      parseInt(process.env.JACKETT_MAX_RETRIES, 10) || LIMITS.MAX_RETRIES,
    retryDelay:
      parseInt(process.env.JACKETT_RETRY_DELAY, 10) || LIMITS.RETRY_DELAY,
    categories: { movie: [2000], tv: [5000, 5040, 100001] },
    maxResults: LIMITS.MAX_RESULTS,
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
    cleanPattern: /[^a-zA-Z0-9\s]/g,
  },
});

// ============================================================================
// Validation & Security
// ============================================================================

function validateConfig() {
  if (!CONFIG.jackett.apiKey) {
    throw new Error("❌ JACKETT_API_KEY environment variable is required");
  }
  if (!/^[a-z0-9]{32}$/i.test(CONFIG.jackett.apiKey)) {
    throw new Error(
      "❌ JACKETT_API_KEY must be a 32-character alphanumeric string",
    );
  }

  try {
    const url = new URL(CONFIG.jackett.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only HTTP/HTTPS protocols allowed");
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      console.warn(
        "⚠️  Using localhost for Jackett URL - ensure it's accessible from this container",
      );
    }
  } catch (e) {
    throw new Error(`Invalid JACKETT_URL: ${e.message}`);
  }
}

function validateImdbId(imdbId) {
  if (!imdbId) return false;
  return /^tt\d{7,}$/.test(imdbId);
}

// ============================================================================
// API Version Detection
// ============================================================================

let detectedApiVersion = null;

async function detectApiVersion() {
  if (detectedApiVersion) return detectedApiVersion;

  const { baseUrl, apiKey } = CONFIG.jackett;

  console.log(`[Provider] Detecting Jackett API version at ${baseUrl}...`);

  // Try v2 endpoint (server config is lightweight)
  try {
    await axios.get(`${baseUrl}/api/v2.0/server/config`, {
      headers: { "X-Api-Key": apiKey },
      timeout: LIMITS.CONNECT_TIMEOUT,
    });
    detectedApiVersion = "v2";
    console.log("✅ Jackett v2 API detected and authenticated");
    return detectedApiVersion;
  } catch (v2Err) {
    // Try v1 search endpoint
    try {
      await axios.get(`${baseUrl}/api/v1/search`, {
        params: { query: "test", categories: "2000" },
        headers: { "X-Api-Key": apiKey },
        timeout: LIMITS.CONNECT_TIMEOUT,
      });
      detectedApiVersion = "v1";
      console.log("✅ Jackett v1 API detected and authenticated");
      return detectedApiVersion;
    } catch (v1Err) {
      console.error("❌ Jackett v2 connection error:", v2Err.message);
      console.error("❌ Jackett v1 connection error:", v1Err.message);
      throw new Error(
        `Cannot connect to Jackett at ${baseUrl}. Please verify:\n` +
          `1. Jackett is running and accessible\n` +
          `2. JACKETT_URL is correct (no trailing slash)\n` +
          `3. JACKETT_API_KEY is valid\n` +
          `4. API key has access to at least one indexer\n\n` +
          `v2 Error: ${v2Err.message}\n` +
          `v1 Error: ${v1Err.message}`,
      );
    }
  }
}

// ============================================================================
// In-Memory Cache
// ============================================================================

class SearchCache {
  constructor(ttl = LIMITS.CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl * 1000) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const searchCache = new SearchCache();

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

function sanitize(input, options = { keepSpaces: true }) {
  if (typeof input !== "string") return "";
  const pattern = options.keepSpaces
    ? CONFIG.search.cleanPattern
    : /[^a-zA-Z0-9]/g;
  return input
    .replace(pattern, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, LIMITS.MAX_QUERY_LENGTH);
}

function normalize(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(CONFIG.search.cleanPattern, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatches(torrentTitle, targetTitle) {
  if (!torrentTitle || !targetTitle) return false;

  const t1 = normalize(torrentTitle);
  const t2 = normalize(targetTitle);

  if (t2.length <= 3) {
    return t1.split(/\s+/).includes(t2);
  }

  return t1.includes(t2) || t2.includes(t1);
}

// ============================================================================
// Scoring Engine
// ============================================================================

function calculateScore(torrent) {
  const { scoring } = CONFIG;
  let score = 0;

  score += scoring.resolution[torrent.quality] || 0;
  score += scoring.source[torrent.source] || 0;
  if (torrent.source === "REMUX") {
    score += scoring.remuxBoost;
  }
  score += scoring.hdr[torrent.hdr] || 0;
  score += scoring.codec[torrent.codec] || 0;
  score += scoring.audio[torrent.audio] || 0;
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
    // Never retry on timeout - fail fast
    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
      throw error;
    }

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

async function executeSearch(query, type = "movie", timeout) {
  const { baseUrl, apiKey, categories } = CONFIG.jackett;

  if (!query) {
    return [];
  }

  const cacheKey = `${query}:${type}:${timeout}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[Cache] HIT for "${query}" (${type})`);
    return cached;
  }

  const sanitizedQuery = sanitize(query);
  console.log(`[Provider] Searching: ${sanitizedQuery} (${type})`);

  const apiVersion = await detectApiVersion();

  try {
    let response;
    let results = [];

    if (apiVersion === "v2") {
      response = await fetchWithRetry(
        `${baseUrl}/api/v2.0/indexers/all/results`,
        {
          params: {
            Query: sanitizedQuery,
            Category: categories[type].join(","),
          },
          timeout,
          headers: {
            "X-Api-Key": apiKey,
            Accept: "application/json",
            "User-Agent": "JackettProvider/1.0",
          },
        },
      );
      results = Array.isArray(response.data?.Results)
        ? response.data.Results
        : [];
    } else {
      // v1 API - uses different param format
      response = await fetchWithRetry(`${baseUrl}/api/v1/search`, {
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
      results = Array.isArray(response.data) ? response.data : [];
    }

    searchCache.set(cacheKey, results);
    return results;
  } catch (err) {
    // Sanitize API key from error message
    const safeMessage = err.message?.replace(apiKey, "[REDACTED]");
    // Preserve original error as cause
    throw new JackettError(`Search failed for "${sanitizedQuery}"`, {
      ...err,
      message: safeMessage,
    });
  }
}

// ============================================================================
// Result Processing
// ============================================================================

function createTorrentKey(item) {
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

function parseAndFilterTorrent(
  item,
  { title, year, type = "movie", strict = false },
) {
  const torrentTitle = item.title;
  if (!torrentTitle) return null;

  // Skip TV episodes for movie searches
  if (type === "movie" && /\bS\d{1,2}E\d{1,2}\b/i.test(torrentTitle)) {
    return null;
  }

  // For TV, require season indicator (episode optional)
  const hasSeason = /\bS\d{1,2}\b/i.test(torrentTitle);
  if (type === "tv" && !hasSeason) {
    if (strict) return null;
  }

  // Title matching
  if (title && !titleMatches(torrentTitle, title)) {
    if (strict && type === "movie") return null;
  }

  const meta = parseRelease(torrentTitle);

  // Ensure resolution is detected
  if (!meta.resolution) {
    const fallback = torrentTitle.match(/\b(2160p|1080p|720p)\b/i);
    if (fallback) {
      meta.resolution = fallback[0].toLowerCase();
    } else if (type === "movie" && strict) {
      return null;
    }
  }

  // Validate required fields
  if (!item.magnetUrl && !item.infoHash) {
    return null;
  }

  const sizeGB = item.size
    ? `${(item.size / 1024 ** 3).toFixed(2)} GB`
    : "Unknown";

  return {
    quality: meta.resolution || "720p",
    source: meta.source,
    codec: meta.codec,
    hdr: meta.hdr,
    audio: meta.audio,
    type: type === "tv" ? "tv" : "web",
    size: sizeGB,
    seeds: item.seeders || 0,
    peers: item.leechers || 0,
    hash: item.infoHash || null,
    magnet: item.magnetUrl || null,
    indexer: item.indexer || "Jackett",
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
  timeout = null,
  type = "movie",
) {
  try {
    const actualTimeout =
      timeout ||
      (type === "tv" ? CONFIG.jackett.tvTimeout : CONFIG.jackett.timeout);

    const searches = [];
    const searchLabels = [];

    // Search by IMDB ID
    if (validateImdbId(imdbId)) {
      searches.push(executeSearch(imdbId, type, actualTimeout));
      searchLabels.push(`IMDB:${imdbId}`);
    }

    // Search by Title + Year
    if (title && title.length >= LIMITS.MIN_TITLE_LENGTH) {
      const query = year ? `${sanitize(title)} ${year}` : sanitize(title);
      searches.push(executeSearch(query, type, actualTimeout));
      searchLabels.push(`Query:${query}`);
    }

    if (searches.length === 0) {
      console.warn("[Provider] No valid search criteria provided");
      return [];
    }

    // Execute searches with proper error isolation and logging
    const resultsArrays = await Promise.all(
      searches.map((searchPromise, idx) =>
        searchPromise.catch((err) => {
          // err is JackettError, original Axios error is in err.cause
          const originalError = err.cause || err;

          // Build detailed error object for logging
          const logDetails = {
            wrapperMessage: err.message,
            originalMessage: originalError.message,
            code: originalError.code,
            isAxiosError: originalError.isAxiosError,
            responseStatus: originalError.response?.status,
            responseStatusText: originalError.response?.statusText,
            responseData: originalError.response?.data,
            config: {
              url: originalError.config?.url,
              method: originalError.config?.method,
              params: originalError.config?.params,
            },
          };

          // Remove undefined values for cleaner logs
          Object.keys(logDetails).forEach((key) => {
            if (logDetails[key] === undefined) delete logDetails[key];
          });
          Object.keys(logDetails.config || {}).forEach((key) => {
            if (logDetails.config?.[key] === undefined)
              delete logDetails.config[key];
          });

          console.error(
            `[Provider] Search branch failed for "${searchLabels[idx]}":`,
            logDetails,
          );
          return [];
        }),
      ),
    );

    const rawItems = resultsArrays.flat();
    console.log(`[Provider] Total raw results: ${rawItems.length}`);

    if (!rawItems.length) return [];

    // Deduplicate
    const uniqueItems = deduplicateResults(rawItems);
    console.log(`[Provider] After dedupe: ${uniqueItems.length}`);

    // Transform & filter
    const found = uniqueItems
      .map((item) => parseAndFilterTorrent(item, { title, year, type }))
      .filter(Boolean);

    console.log(`[Provider] Final results: ${found.length}`);

    // Score and sort
    return found
      .map((t) => ({ ...t, score: calculateScore(t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.jackett.maxResults);
  } catch (error) {
    console.error(`[Provider] Fatal error in getTorrents: ${error.message}`, {
      error: error.cause || error,
    });
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
  timeout = null,
) {
  const torrents = await getTorrents(imdbId, title, year, timeout, "movie");
  return torrents.length > 0
    ? { imdbId, title: title || "Jackett Result", torrents }
    : null;
}

async function getShowTorrents(
  imdbId,
  title = null,
  year = null,
  timeout = null,
) {
  if (imdbId && !validateImdbId(imdbId)) {
    throw new Error(`Invalid IMDB ID format: ${imdbId}`);
  }

  const cleanTitle = sanitize(title);
  const currentYear = new Date().getFullYear();
  const cleanYear = year && year <= currentYear ? year : null;

  console.log(
    `[Provider] TV Search: IMDB=${imdbId}, Title=${cleanTitle}, Year=${cleanYear}`,
  );

  const torrents = await getTorrents(
    imdbId,
    cleanTitle,
    cleanYear,
    timeout,
    "tv",
  );

  if (!torrents.length) {
    return { imdbId, title: cleanTitle, seasons: {}, seasonPacks: [] };
  }

  const result = {
    imdbId,
    title: cleanTitle,
    seasons: {},
    seasonPacks: [],
  };

  for (const t of torrents) {
    const sMatch = t.title.match(/S(\d{1,2})/i);
    if (!sMatch) continue;

    const seasonNum = parseInt(sMatch[1], 10);
    const eMatch = t.title.match(/E(\d{1,2})/i);

    if (!eMatch) {
      // Season pack (no episode)
      result.seasonPacks.push({ season: seasonNum, torrent: t });
      continue;
    }

    const episodeNum = parseInt(eMatch[1], 10);
    const seasonKey = `season_${seasonNum}`;

    if (!result.seasons[seasonKey]) {
      result.seasons[seasonKey] = {};
    }

    result.seasons[seasonKey][`episode_${episodeNum}`] = t;
  }

  return result;
}

async function listMovies() {
  return [];
}

// ============================================================================
// Startup Validation
// ============================================================================

(async function init() {
  try {
    validateConfig();
    await detectApiVersion();
    console.log("[Provider] Jackett provider initialized successfully");
  } catch (error) {
    console.error("❌ Fatal error during initialization:", error.message);
    process.exit(1);
  }
})();

module.exports = {
  getMovieByImdb,
  getShowTorrents,
  listMovies,
  getTorrents,
  CONFIG,
  calculateScore,
  deduplicateResults,
  parseAndFilterTorrent,
  // Testing exports
  validateImdbId,
  sanitize,
  searchCache,
  detectApiVersion,
};
("use strict");

const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// ============================================================================
// Constants & Configuration
// ============================================================================

const LIMITS = Object.freeze({
  MAX_QUERY_LENGTH: 100,
  MAX_RESULTS: 50,
  MIN_TITLE_LENGTH: 2,
  SEED_LOG_BASE: 10,
  CACHE_TTL: 300,
  MAX_RETRIES: 2,
  RETRY_DELAY: 500,
  CONNECT_TIMEOUT: 5000,
});

const CONFIG = Object.freeze({
  jackett: {
    baseUrl:
      process.env.JACKETT_URL?.replace(/\/$/, "") || "http://localhost:9696",
    apiKey: process.env.JACKETT_API_KEY,
    timeout: parseInt(process.env.JACKETT_TIMEOUT, 10) || 15000,
    tvTimeout: parseInt(process.env.JACKETT_TV_TIMEOUT, 10) || 15000,
    maxRetries:
      parseInt(process.env.JACKETT_MAX_RETRIES, 10) || LIMITS.MAX_RETRIES,
    retryDelay:
      parseInt(process.env.JACKETT_RETRY_DELAY, 10) || LIMITS.RETRY_DELAY,
    categories: { movie: [2000], tv: [5000, 5040, 100001] },
    maxResults: LIMITS.MAX_RESULTS,
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
    cleanPattern: /[^a-zA-Z0-9\s]/g,
  },
});

// ============================================================================
// Validation & Security
// ============================================================================

function validateConfig() {
  if (!CONFIG.jackett.apiKey) {
    throw new Error("❌ JACKETT_API_KEY environment variable is required");
  }
  if (!/^[a-z0-9]{32}$/i.test(CONFIG.jackett.apiKey)) {
    throw new Error(
      "❌ JACKETT_API_KEY must be a 32-character alphanumeric string",
    );
  }

  try {
    const url = new URL(CONFIG.jackett.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only HTTP/HTTPS protocols allowed");
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      console.warn(
        "⚠️  Using localhost for Jackett URL - ensure it's accessible from this container",
      );
    }
  } catch (e) {
    throw new Error(`Invalid JACKETT_URL: ${e.message}`);
  }
}

function validateImdbId(imdbId) {
  if (!imdbId) return false;
  return /^tt\d{7,}$/.test(imdbId);
}

// ============================================================================
// API Version Detection
// ============================================================================

let detectedApiVersion = null;

async function detectApiVersion() {
  if (detectedApiVersion) return detectedApiVersion;

  const { baseUrl, apiKey } = CONFIG.jackett;

  console.log(`[Provider] Detecting Jackett API version at ${baseUrl}...`);

  // Try v2 endpoint (server config is lightweight)
  try {
    await axios.get(`${baseUrl}/api/v2.0/server/config`, {
      headers: { "X-Api-Key": apiKey },
      timeout: LIMITS.CONNECT_TIMEOUT,
    });
    detectedApiVersion = "v2";
    console.log("✅ Jackett v2 API detected and authenticated");
    return detectedApiVersion;
  } catch (v2Err) {
    // Try v1 search endpoint
    try {
      await axios.get(`${baseUrl}/api/v1/search`, {
        params: { query: "test", categories: "2000" },
        headers: { "X-Api-Key": apiKey },
        timeout: LIMITS.CONNECT_TIMEOUT,
      });
      detectedApiVersion = "v1";
      console.log("✅ Jackett v1 API detected and authenticated");
      return detectedApiVersion;
    } catch (v1Err) {
      console.error("❌ Jackett v2 connection error:", v2Err.message);
      console.error("❌ Jackett v1 connection error:", v1Err.message);
      throw new Error(
        `Cannot connect to Jackett at ${baseUrl}. Please verify:\n` +
          `1. Jackett is running and accessible\n` +
          `2. JACKETT_URL is correct (no trailing slash)\n` +
          `3. JACKETT_API_KEY is valid\n` +
          `4. API key has access to at least one indexer\n\n` +
          `v2 Error: ${v2Err.message}\n` +
          `v1 Error: ${v1Err.message}`,
      );
    }
  }
}

// ============================================================================
// In-Memory Cache
// ============================================================================

class SearchCache {
  constructor(ttl = LIMITS.CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl * 1000) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const searchCache = new SearchCache();

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

function sanitize(input, options = { keepSpaces: true }) {
  if (typeof input !== "string") return "";
  const pattern = options.keepSpaces
    ? CONFIG.search.cleanPattern
    : /[^a-zA-Z0-9]/g;
  return input
    .replace(pattern, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, LIMITS.MAX_QUERY_LENGTH);
}

function normalize(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(CONFIG.search.cleanPattern, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatches(torrentTitle, targetTitle) {
  if (!torrentTitle || !targetTitle) return false;

  const t1 = normalize(torrentTitle);
  const t2 = normalize(targetTitle);

  if (t2.length <= 3) {
    return t1.split(/\s+/).includes(t2);
  }

  return t1.includes(t2) || t2.includes(t1);
}

// ============================================================================
// Scoring Engine
// ============================================================================

function calculateScore(torrent) {
  const { scoring } = CONFIG;
  let score = 0;

  score += scoring.resolution[torrent.quality] || 0;
  score += scoring.source[torrent.source] || 0;
  if (torrent.source === "REMUX") {
    score += scoring.remuxBoost;
  }
  score += scoring.hdr[torrent.hdr] || 0;
  score += scoring.codec[torrent.codec] || 0;
  score += scoring.audio[torrent.audio] || 0;
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
    // Never retry on timeout - fail fast
    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
      throw error;
    }

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

async function executeSearch(query, type = "movie", timeout) {
  const { baseUrl, apiKey, categories } = CONFIG.jackett;

  if (!query) {
    return [];
  }

  const cacheKey = `${query}:${type}:${timeout}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[Cache] HIT for "${query}" (${type})`);
    return cached;
  }

  const sanitizedQuery = sanitize(query);
  console.log(`[Provider] Searching: ${sanitizedQuery} (${type})`);

  const apiVersion = await detectApiVersion();

  try {
    let response;
    let results = [];

    if (apiVersion === "v2") {
      response = await fetchWithRetry(
        `${baseUrl}/api/v2.0/indexers/all/results`,
        {
          params: {
            Query: sanitizedQuery,
            Category: categories[type].join(","),
          },
          timeout,
          headers: {
            "X-Api-Key": apiKey,
            Accept: "application/json",
            "User-Agent": "JackettProvider/1.0",
          },
        },
      );
      results = Array.isArray(response.data?.Results)
        ? response.data.Results
        : [];
    } else {
      // v1 API - uses different param format
      response = await fetchWithRetry(`${baseUrl}/api/v1/search`, {
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
      results = Array.isArray(response.data) ? response.data : [];
    }

    searchCache.set(cacheKey, results);
    return results;
  } catch (err) {
    // Sanitize API key from error message
    const safeMessage = err.message?.replace(apiKey, "[REDACTED]");
    // Preserve original error as cause
    throw new JackettError(`Search failed for "${sanitizedQuery}"`, {
      ...err,
      message: safeMessage,
    });
  }
}

// ============================================================================
// Result Processing
// ============================================================================

function createTorrentKey(item) {
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

function parseAndFilterTorrent(
  item,
  { title, year, type = "movie", strict = false },
) {
  const torrentTitle = item.title;
  if (!torrentTitle) return null;

  // Skip TV episodes for movie searches
  if (type === "movie" && /\bS\d{1,2}E\d{1,2}\b/i.test(torrentTitle)) {
    return null;
  }

  // For TV, require season indicator (episode optional)
  const hasSeason = /\bS\d{1,2}\b/i.test(torrentTitle);
  if (type === "tv" && !hasSeason) {
    if (strict) return null;
  }

  // Title matching
  if (title && !titleMatches(torrentTitle, title)) {
    if (strict && type === "movie") return null;
  }

  const meta = parseRelease(torrentTitle);

  // Ensure resolution is detected
  if (!meta.resolution) {
    const fallback = torrentTitle.match(/\b(2160p|1080p|720p)\b/i);
    if (fallback) {
      meta.resolution = fallback[0].toLowerCase();
    } else if (type === "movie" && strict) {
      return null;
    }
  }

  // Validate required fields
  if (!item.magnetUrl && !item.infoHash) {
    return null;
  }

  const sizeGB = item.size
    ? `${(item.size / 1024 ** 3).toFixed(2)} GB`
    : "Unknown";

  return {
    quality: meta.resolution || "720p",
    source: meta.source,
    codec: meta.codec,
    hdr: meta.hdr,
    audio: meta.audio,
    type: type === "tv" ? "tv" : "web",
    size: sizeGB,
    seeds: item.seeders || 0,
    peers: item.leechers || 0,
    hash: item.infoHash || null,
    magnet: item.magnetUrl || null,
    indexer: item.indexer || "Jackett",
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
  timeout = null,
  type = "movie",
) {
  try {
    const actualTimeout =
      timeout ||
      (type === "tv" ? CONFIG.jackett.tvTimeout : CONFIG.jackett.timeout);

    const searches = [];
    const searchLabels = [];

    // Search by IMDB ID
    if (validateImdbId(imdbId)) {
      searches.push(executeSearch(imdbId, type, actualTimeout));
      searchLabels.push(`IMDB:${imdbId}`);
    }

    // Search by Title + Year
    if (title && title.length >= LIMITS.MIN_TITLE_LENGTH) {
      const query = year ? `${sanitize(title)} ${year}` : sanitize(title);
      searches.push(executeSearch(query, type, actualTimeout));
      searchLabels.push(`Query:${query}`);
    }

    if (searches.length === 0) {
      console.warn("[Provider] No valid search criteria provided");
      return [];
    }

    // Execute searches with proper error isolation and logging
    const resultsArrays = await Promise.all(
      searches.map((searchPromise, idx) =>
        searchPromise.catch((err) => {
          // err is JackettError, original Axios error is in err.cause
          const originalError = err.cause || err;

          // Build detailed error object for logging
          const logDetails = {
            wrapperMessage: err.message,
            originalMessage: originalError.message,
            code: originalError.code,
            isAxiosError: originalError.isAxiosError,
            responseStatus: originalError.response?.status,
            responseStatusText: originalError.response?.statusText,
            responseData: originalError.response?.data,
            config: {
              url: originalError.config?.url,
              method: originalError.config?.method,
              params: originalError.config?.params,
            },
          };

          // Remove undefined values for cleaner logs
          Object.keys(logDetails).forEach((key) => {
            if (logDetails[key] === undefined) delete logDetails[key];
          });
          Object.keys(logDetails.config || {}).forEach((key) => {
            if (logDetails.config?.[key] === undefined)
              delete logDetails.config[key];
          });

          console.error(
            `[Provider] Search branch failed for "${searchLabels[idx]}":`,
            logDetails,
          );
          return [];
        }),
      ),
    );

    const rawItems = resultsArrays.flat();
    console.log(`[Provider] Total raw results: ${rawItems.length}`);

    if (!rawItems.length) return [];

    // Deduplicate
    const uniqueItems = deduplicateResults(rawItems);
    console.log(`[Provider] After dedupe: ${uniqueItems.length}`);

    // Transform & filter
    const found = uniqueItems
      .map((item) => parseAndFilterTorrent(item, { title, year, type }))
      .filter(Boolean);

    console.log(`[Provider] Final results: ${found.length}`);

    // Score and sort
    return found
      .map((t) => ({ ...t, score: calculateScore(t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.jackett.maxResults);
  } catch (error) {
    console.error(`[Provider] Fatal error in getTorrents: ${error.message}`, {
      error: error.cause || error,
    });
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
  timeout = null,
) {
  const torrents = await getTorrents(imdbId, title, year, timeout, "movie");
  return torrents.length > 0
    ? { imdbId, title: title || "Jackett Result", torrents }
    : null;
}

async function getShowTorrents(
  imdbId,
  title = null,
  year = null,
  timeout = null,
) {
  if (imdbId && !validateImdbId(imdbId)) {
    throw new Error(`Invalid IMDB ID format: ${imdbId}`);
  }

  const cleanTitle = sanitize(title);
  const currentYear = new Date().getFullYear();
  const cleanYear = year && year <= currentYear ? year : null;

  console.log(
    `[Provider] TV Search: IMDB=${imdbId}, Title=${cleanTitle}, Year=${cleanYear}`,
  );

  const torrents = await getTorrents(
    imdbId,
    cleanTitle,
    cleanYear,
    timeout,
    "tv",
  );

  if (!torrents.length) {
    return { imdbId, title: cleanTitle, seasons: {}, seasonPacks: [] };
  }

  const result = {
    imdbId,
    title: cleanTitle,
    seasons: {},
    seasonPacks: [],
  };

  for (const t of torrents) {
    const sMatch = t.title.match(/S(\d{1,2})/i);
    if (!sMatch) continue;

    const seasonNum = parseInt(sMatch[1], 10);
    const eMatch = t.title.match(/E(\d{1,2})/i);

    if (!eMatch) {
      // Season pack (no episode)
      result.seasonPacks.push({ season: seasonNum, torrent: t });
      continue;
    }

    const episodeNum = parseInt(eMatch[1], 10);
    const seasonKey = `season_${seasonNum}`;

    if (!result.seasons[seasonKey]) {
      result.seasons[seasonKey] = {};
    }

    result.seasons[seasonKey][`episode_${episodeNum}`] = t;
  }

  return result;
}

async function listMovies() {
  return [];
}

// ============================================================================
// Startup Validation
// ============================================================================

(async function init() {
  try {
    validateConfig();
    await detectApiVersion();
    console.log("[Provider] Jackett provider initialized successfully");
  } catch (error) {
    console.error("❌ Fatal error during initialization:", error.message);
    process.exit(1);
  }
})();

module.exports = {
  getMovieByImdb,
  getShowTorrents,
  listMovies,
  getTorrents,
  CONFIG,
  calculateScore,
  deduplicateResults,
  parseAndFilterTorrent,
  // Testing exports
  validateImdbId,
  sanitize,
  searchCache,
  detectApiVersion,
};
