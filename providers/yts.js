"use strict";

const axios = require("axios");

// ================= CONFIG =================
const TIMEOUT_MS = 6500; // Slightly faster than aggregator's 8000ms
const LIMIT_PER_PAGE = 20;

// 2026 Optimized Mirror List
const YTS_BASES = [
  "https://yts.mx/api/v2/",
  "https://movies-api.accel.li/api/v2/",
  "https://yts.unblockit.cat/api/v2/",
];

// 2026 High-Uptime Tracker List
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tr4ck3r.duckdns.org:6969/announce",
  "udp://exodus.desync.com:6969",
  "udp://tracker.leechers-paradise.org:6969",
  "udp://tracker.dler.org:6969/announce",
]
  .map((t) => `&tr=${encodeURIComponent(t)}`)
  .join("");

const apiClient = axios.create({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 2026-Browser/1.0",
    Accept: "application/json",
  },
  timeout: TIMEOUT_MS,
});

// ================= UTIL =================
async function ytsGet(endpoint, params = {}) {
  let lastErr;
  for (const base of YTS_BASES) {
    try {
      const res = await apiClient.get(`${base}/${endpoint}`, { params });
      if (res.data?.status === "ok") return res.data.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All YTS mirrors failed");
}

function buildMagnet(hash, title) {
  if (!hash) return null;
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(title)}${TRACKERS}`;
}

/**
 * 2026 Internal Scoring for YTS.
 * YTS encodes are standard (low bitrate), so they get a reliable base score
 * but won't accidentally outrank a 40GB REMUX from Jackett.
 */
function calculateYtsScore(quality, size) {
  let score = 0;
  if (quality === "2160p") score += 50;
  else if (quality === "1080p") score += 30;
  else if (quality === "720p") score += 10;

  // YTS 4K is almost always x265/HEVC
  if (quality === "2160p") score += 15;

  // Size-based penalty: If a 1080p file is < 1GB, it's very low quality
  const sizeGB = parseFloat(size) || 0;
  if (quality === "1080p" && sizeGB < 1.2) score -= 10;

  return score;
}

function formatMovie(m) {
  if (!m) return null;

  const torrents = (m.torrents || [])
    .map((t) => {
      if (!t.hash) return null;

      const quality = t.quality || "720p";
      const score = calculateYtsScore(quality, t.size);

      return {
        quality,
        type: t.type || "web",
        size: t.size || "Unknown",
        seeds: t.seeds || 0,
        peers: t.peers || 0,
        hash: t.hash,
        magnet: buildMagnet(t.hash, m.title_long || m.title),
        title: `${m.title_english || m.title} (${m.year}) [YTS] ${quality}`,
        provider: "yts",
        score: score, // Pre-calculated for aggregator sorting
      };
    })
    .filter(Boolean);

  return {
    ytsId: m.id,
    imdbId: m.imdb_code,
    title: m.title_english || m.title,
    year: m.year,
    rating: m.rating,
    runtime: m.runtime,
    genres: m.genres || [],
    poster: m.large_cover_image || m.medium_cover_image || "",
    torrents,
    provider: "yts",
  };
}

// ================= EXPORTS =================
async function listMovies({
  query,
  genre,
  page = 1,
  limit = LIMIT_PER_PAGE,
  sortBy = "date_added",
  minRating = 0,
} = {}) {
  const params = {
    limit,
    page,
    sort_by: sortBy,
    order_by: "desc",
    minimum_rating: minRating,
  };
  if (query) params.query_term = query;
  if (genre) params.genre = genre;

  try {
    const data = await ytsGet("list_movies.json", params);
    return (data.movies || []).map(formatMovie).filter(Boolean);
  } catch (err) {
    return [];
  }
}

async function getMovieByImdb(imdbId) {
  try {
    const data = await ytsGet("list_movies.json", {
      query_term: imdbId,
      limit: 1,
    });
    return data.movies?.[0] ? formatMovie(data.movies[0]) : null;
  } catch (err) {
    return null;
  }
}

module.exports = { listMovies, getMovieByImdb };
