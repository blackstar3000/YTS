"use strict";

const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// Configuration
const TIMEOUT_MS = 5000; // Match aggregator's external timeout (6s) to avoid leaks
const LIMIT_PER_PAGE = 100;

// EZTV mirrors (Order matters: try most stable first)
const EZTV_BASES = [
  "https://eztv.re/api",
  "https://eztvx.to/api",
  "https://eztv.wf/api",
  "https://eztv.tf/api",
];

// Axios instance for reuse (optional but cleaner)
const apiClient = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json",
  },
  timeout: TIMEOUT_MS,
});

async function eztvGet(params = {}) {
  let lastErr;
  for (const base of EZTV_BASES) {
    try {
      const res = await apiClient.get(`${base}/get-torrents`, {
        params: { limit: LIMIT_PER_PAGE, ...params },
      });

      // Validate response structure
      if (res.data && typeof res.data.torrents_count !== "undefined") {
        return res.data;
      }
    } catch (err) {
      // Log specific mirror failure
      console.warn(`[eztv] ${base} failed: ${err.code || err.message}`);
      lastErr = err;
      // Continue to next mirror
    }
  }
  throw lastErr || new Error("All EZTV mirrors failed");
}

async function getLatestShows(page = 1) {
  const data = await eztvGet({ page });
  const torrents = data.torrents || [];

  const seen = new Set();
  const shows = [];

  for (const t of torrents) {
    if (!t.imdb_id || seen.has(t.imdb_id)) continue;
    seen.add(t.imdb_id);

    shows.push({
      imdbId: `tt${t.imdb_id.replace(/^tt/, "")}`,
      title: extractShowTitle(t.title) || "Unknown Show",
      season: parseInt(t.season) || 1,
      episode: parseInt(t.episode) || 1,
      filename: t.filename,
      // ✅ Safe URL construction
      screenshot: t.large_screenshot
        ? t.large_screenshot.startsWith("http")
          ? t.large_screenshot
          : `https:${t.large_screenshot}`
        : null,
    });
  }
  return shows;
}

async function getShowTorrents(imdbId) {
  const numericId = imdbId.replace(/^tt0*/, "");
  const data = await eztvGet({ imdb_id: numericId });
  const torrents = data.torrents || [];

  const seasons = {};

  for (const t of torrents) {
    const s = String(parseInt(t.season) || 1);
    const e = String(parseInt(t.episode) || 1);

    if (!seasons[s]) seasons[s] = {};
    if (!seasons[s][e]) seasons[s][e] = [];

    const quality = detectQuality(t.title);

    // Inside getShowTorrents loop:
    const parsed = parseRelease(t.title);
    seasons[s][e].push({
      // ...
      quality: parsed?.resolution || "SD",
      source: parsed?.source || "Unknown",
      qualityScore: parsed?.score || 0,
    });

    seasons[s][e].push({
      title: t.title,
      magnet: t.magnet_url,
      hash: t.hash,
      seeds: t.seeds,
      peers: t.peers,
      size: t.size_bytes ? formatBytes(t.size_bytes) : "",
      quality,
      source: detectSource(t.title), // ✅ New: Distinguish WEB-DL vs HDTV
    });
  }

  // Sort: Quality Score -> Seeds -> Size (larger usually better quality within same res)
  for (const s of Object.keys(seasons)) {
    for (const e of Object.keys(seasons[s])) {
      seasons[s][e].sort((a, b) => {
        const qDiff = qualityScore(b.quality) - qualityScore(a.quality);
        if (qDiff !== 0) return qDiff;
        if (b.seeds !== a.seeds) return b.seeds - a.seeds;
        return 0;
      });
    }
  }

  return seasons;
}

// ---- Helpers ----

function extractShowTitle(filename) {
  if (!filename) return null;
  // Try S01E01 pattern
  let match = filename.match(/^(.+?)\.S\d+E\d+/i);
  if (match && match[1]) return match[1].replace(/\./g, " ").trim();

  // Try 1x01 pattern
  match = filename.match(/^(.+?)\.\d+x\d+/i);
  if (match && match[1]) return match[1].replace(/\./g, " ").trim();

  // Fallback: Remove common extensions/tags
  return filename
    .replace(/\.(mkv|mp4|avi|eztv|rar|zip)$/i, "")
    .replace(/\./g, " ")
    .trim();
}

function detectSource(title) {
  if (/web.?dl|web.?rip|amazon|netflix|disney|hulu/i.test(title)) return "WEB";
  if (/bluray|bdrip|bdremux/i.test(title)) return "BluRay";
  if (/hdtv|iTV/i.test(title)) return "HDTV";
  return "Unknown";
}

function detectQuality(title) {
  if (/2160p|4k|uhd/i.test(title)) return "4K";
  if (/1080p/i.test(title)) return "1080p";
  if (/720p/i.test(title)) return "720p";
  if (/480p|iPod|iPhone/i.test(title)) return "480p";
  // If no resolution but high quality source
  if (/bluray|web.?dl/i.test(title)) return "720p"; // Assume decent quality
  return "SD";
}

function qualityScore(q) {
  return { "4K": 4, "1080p": 3, "720p": 2, "480p": 1, SD: 0 }[q] || 0;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb.toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

module.exports = { getLatestShows, getShowTorrents };
