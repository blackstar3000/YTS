"use strict";

const axios = require("axios");

// Configuration
const TIMEOUT_MS = 7000; // Slightly less than aggregator's 8000ms wrapper
const LIMIT_PER_PAGE = 20;

// YTS mirrors (most stable first)
const YTS_BASES = [
  "https://movies-api.accel.li/api/v2/",
  "https://yts.mx/api/v2/",
  "https://yts.unblockit.cat/api/v2/",
];

// Maintained tracker list (removed known dead trackers)
const TRACKERS = [
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://torrent.gresille.org:80/announce",
  "udp://p4p.arenabg.ch:1337",
  "udp://tracker.leechers-paradise.org:6969",
  "udp://exodus.desync.com:6969",
  "udp://tracker.internetwarriors.net:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://tracker.port443.xyz:6969/announce",
]
  .map((t) => `&tr=${encodeURIComponent(t)}`)
  .join("");

// Axios instance for reuse
const apiClient = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json",
  },
  timeout: TIMEOUT_MS,
});

async function ytsGet(endpoint, params = {}) {
  let lastErr;

  for (const base of YTS_BASES) {
    try {
      const res = await apiClient.get(`${base}/${endpoint}`, { params });

      if (res.data && res.data.status === "ok") {
        return res.data.data;
      }
    } catch (err) {
      lastErr = err;
      // Debug logging only (disable in production or use logging library)
      // console.warn(`[yts] ${base} failed: ${err.code || err.message}`);
    }
  }

  throw lastErr || new Error("All YTS mirrors failed");
}

function buildMagnet(hash, title) {
  if (!hash) {
    console.error(`[yts] ❌ buildMagnet: missing hash for "${title}"`);
    return null;
  }
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${TRACKERS}`;
}

function formatMovie(m) {
  if (!m) {
    console.error("[yts] ❌ formatMovie: received null/undefined movie");
    return null;
  }

  const torrents = (m.torrents || [])
    .map((t) => {
      if (!t.hash) {
        console.warn(`[yts] ⚠️ Missing hash for ${m.title} ${t.quality}`);
        return null;
      }

      return {
        quality: t.quality,
        type: t.type || "web",
        size: t.size || "Unknown",
        seeds: t.seeds || 0,
        peers: t.peers || 0,
        hash: t.hash,
        magnet: buildMagnet(t.hash, m.title_long || m.title),
        title: `${m.title_english || m.title} (${m.year}) ${t.quality}`,
        provider: "yts", // ✅ Tag source for aggregator
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
    summary: m.synopsis || m.description_full || "",
    language: m.language,
    mpaRating: m.mpa_rating,
    ytTrailer: m.yt_trailer_code,
    poster: m.large_cover_image || m.medium_cover_image || "",
    background: m.background_image_original || m.background_image || "",
    torrents,
    provider: "yts", // ✅ Tag source for aggregator
  };
}

async function listMovies({
  query,
  genre,
  page = 1,
  limit = LIMIT_PER_PAGE,
  sortBy = "date_added",
  minRating = 0,
  quality,
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
  if (quality) params.quality = quality;

  try {
    const data = await ytsGet("list_movies.json", params);

    if (!data.movies || data.movies.length === 0) {
      return [];
    }

    return data.movies.map(formatMovie).filter(Boolean);
  } catch (err) {
    console.error(`[yts] listMovies error: ${err.message}`);
    return [];
  }
}

async function getMovieByImdb(imdbId) {
  try {
    const data = await ytsGet("list_movies.json", {
      query_term: imdbId,
      limit: 1,
    });

    if (!data.movies || data.movies.length === 0) {
      return null;
    }

    return formatMovie(data.movies[0]);
  } catch (err) {
    console.error(`[yts] getMovieByImdb(${imdbId}) error: ${err.message}`);
    return null;
  }
}

module.exports = { listMovies, getMovieByImdb };
