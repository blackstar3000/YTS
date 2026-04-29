"use strict";

const axios = require("axios");
const { parseRelease } = require("./sceneParser");

// ================= CONFIG =================
const TIMEOUT_MS = 6000;
const LIMIT_PER_PAGE = 100;

// 2026 Optimized EZTV Mirrors
const EZTV_BASES = [
  "https://eztv.re/api",
  "https://eztvx.to/api",
  "https://eztv.wf/api",
  "https://eztv.tf/api",
];

const apiClient = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 2026-TV-Browser/1.1",
    Accept: "application/json",
  },
  timeout: TIMEOUT_MS,
});

// ================= UTIL =================
async function eztvGet(params = {}) {
  let lastErr;
  for (const base of EZTV_BASES) {
    try {
      const res = await apiClient.get(`${base}/get-torrents`, {
        params: { limit: LIMIT_PER_PAGE, ...params },
      });
      if (res.data && typeof res.data.torrents_count !== "undefined") {
        return res.data;
      }
    } catch (err) {
      console.warn(`[eztv] Mirror ${base} down: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error("All EZTV mirrors failed");
}

function formatBytes(bytes) {
  if (!bytes) return "0 GB";
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb.toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// ================= MAIN =================

async function getLatestShows(page = 1) {
  try {
    const data = await eztvGet({ page });
    const torrents = data.torrents || [];
    const seen = new Set();
    const shows = [];

    for (const t of torrents) {
      if (!t.imdb_id || seen.has(t.imdb_id)) continue;
      seen.add(t.imdb_id);

      shows.push({
        imdbId: `tt${t.imdb_id.replace(/^tt/, "")}`,
        title: t.title
          .split(/S\d+E\d+|S\d+/i)[0]
          .replace(/\./g, " ")
          .trim(),
        season: parseInt(t.season) || 1,
        episode: parseInt(t.episode) || 1,
        screenshot: t.large_screenshot?.startsWith("//")
          ? `https:${t.large_screenshot}`
          : t.large_screenshot,
      });
    }
    return shows;
  } catch (err) {
    return [];
  }
}

async function getShowTorrents(imdbId) {
  const numericId = imdbId.replace(/^tt0*/, "");
  const seasons = {};

  try {
    const data = await eztvGet({ imdb_id: numericId });
    const torrents = data.torrents || [];

    for (const t of torrents) {
      const s = String(parseInt(t.season) || 1);
      const e = String(parseInt(t.episode) || 1);

      seasons[s] ??= {};
      seasons[s][e] ??= [];

      // Unified parsing with your 2026 sceneParser
      const meta = parseRelease(t.title);

      seasons[s][e].push({
        title: t.title,
        magnet: t.magnet_url,
        hash: t.hash,
        seeds: parseInt(t.seeds) || 0,
        peers: parseInt(t.peers) || 0,
        size: formatBytes(t.size_bytes),
        sizeNum: t.size_bytes / 1024 ** 3,
        quality: meta.resolution || "SD",
        source: meta.source || "WEB",
        codec: meta.codec || "x264",
        score: meta.score || 0, // Align with Jackett scoring
        provider: "eztv",
      });
    }

    // Sort by Score (Quality) first, then Seeds
    for (const s of Object.keys(seasons)) {
      for (const e of Object.keys(seasons[s])) {
        seasons[s][e].sort((a, b) => b.score - a.score || b.seeds - a.seeds);
      }
    }

    return seasons;
  } catch (err) {
    return {};
  }
}

module.exports = { getLatestShows, getShowTorrents };
