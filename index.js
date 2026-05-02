#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
require("dotenv").config();

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const {
  getMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents,
  getShowMeta,
} = require("./providers/aggregator");
const { cached } = require("./providers/cache");

/** One key + TTL for meta and stream so “open detail” and “play” reuse the same getMovieByImdb result. */
const MOVIE_PAYLOAD_CACHE_MS = Number.parseInt(
  process.env.MOVIE_CACHE_MS ||
    process.env.STREAM_MOVIE_CACHE_MS ||
    "600000",
  10,
);

function moviePayloadCacheKey(imdbId) {
  return `movie:payload:${imdbId}`;
}

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 7000;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function extractHash(t) {
  if (t.hash) return t.hash.toLowerCase();

  if (t.infoHash) return t.infoHash.toLowerCase();

  if (t.magnet?.startsWith("magnet:")) {
    const match = t.magnet.match(/btih:([A-Z0-9]{32,40})/i);
    if (match) return match[1].toLowerCase();
  }

  return null;
}

function isValidTorrent(t) {
  const hash = extractHash(t);
  if (!hash) {
    if (process.env.DEBUG)
      console.log("❌ NO HASH:", t.title);
    return false;
  }

  if (t.provider === "yts") {
    return true;
  }

  if (t.seeds != null && t.seeds < 1) {
    if (process.env.DEBUG)
      console.log("❌ LOW SEEDS:", t.title, t.seeds);
    return false;
  }

  return true;
}

function dedupeTorrents(list) {
  const seen = new Set();
  return list.filter((t) => {
    const hash = extractHash(t);
    if (!hash || seen.has(hash)) return false;
    seen.add(hash);
    t.hash = hash;
    return true;
  });
}

function buildQualityLabel(t) {
  const tags = [];
  const title = (t.title || "").toUpperCase();

  if (/DV|DOLBY.?VISION/.test(title)) tags.push("DV");
  if (/HDR10\+/.test(title)) tags.push("HDR10+");
  else if (/HDR/.test(title)) tags.push("HDR");
  if (/X265|HEVC/.test(title)) tags.push("HEVC");
  if (/REMUX/.test(title)) tags.push("REMUX");
  if (/BLURAY/.test(title)) tags.push("BluRay");

  const base = t.quality === "2160p" ? "4K" : t.quality || "Unknown";
  return tags.length ? `${base} ${tags.join(" · ")}` : base;
}

function torrentToStream(t, { imdbId, season, episode }) {
  const hash = extractHash(t);
  if (!hash) return null;

  const source =
    t.provider === "yts"
      ? "YTS"
      : t.provider === "eztv"
        ? "EZTV"
        : t.indexer || "Prowlarr";

  const title = (t.title || "").slice(0, 50);

  return {
    name: `Phantom\n${buildQualityLabel(t)}`,
    title: `${title}
${season ? `📺 S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}\n` : ""}
🌱 ${t.seeds || 0}  💀 ${t.size || "?"}  📀 ${source}`,
    infoHash: hash,
    behaviorHints: {
      bingeGroup: season ? `series-${imdbId}` : `movie-${imdbId}`,
    },
  };
}

/** Order preserved from aggregator ranking; cap list size for Stremio UX. */
function processTorrents(list, ctx) {
  return dedupeTorrents(list.filter(isValidTorrent))
    .map((t) => torrentToStream(t, ctx))
    .filter(Boolean)
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// META HELPERS
// ---------------------------------------------------------------------------

function movieToMeta(m) {
  return {
    id: m.imdbId,
    type: "movie",
    name: m.title,
    year: m.year,
    poster: m.poster,
    background: m.background,
    genres: m.genres,
    imdbRating: m.rating ? String(m.rating) : undefined,
    runtime: m.runtime ? `${m.runtime} min` : undefined,
    description: m.summary ?? m.description,
  };
}

function showToMeta(show) {
  return {
    id: show.imdbId,
    type: "series",
    name: show.title,
    poster: show.screenshot || "",
    description: `Latest: S${show.season}E${show.episode}`,
  };
}

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------

const manifest = {
  id: "community.phantom.stremio",
  version: "3.0.0",
  name: "Phantom",
  description: "Optimized Torrent Streaming Addon",
  logo: "https://hosting.photobucket.com/26a6037f-4bda-4fe6-a73d-662dc9064777/892c5dcb-091d-4082-900c-4e3febc820c8.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    { id: "yts-latest", type: "movie", name: "🎬 Latest" },
    { id: "eztv-latest", type: "series", name: "📺 Latest Episodes" },
  ],
  behaviorHints: { p2p: true },
};

// ---------------------------------------------------------------------------
// BUILDER
// ---------------------------------------------------------------------------

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------------------
// CATALOG
// ---------------------------------------------------------------------------

builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    if (type === "movie") {
      const movies = await cached(
        `catalog:movies:${id || "yts-latest"}`,
        300000,
        () => getMovies({ limit: 20 }),
      );
      return { metas: movies.map(movieToMeta) };
    }

    if (type === "series") {
      const shows = await cached(
        `catalog:shows:${id || "eztv-latest"}`,
        300000,
        getLatestShows,
      );
      return { metas: shows.map(showToMeta) };
    }
  } catch (e) {
    console.error("catalog error", e.message);
  }

  return { metas: [] };
});

// ---------------------------------------------------------------------------
// META
// ---------------------------------------------------------------------------

builder.defineMetaHandler(async ({ type, id }) => {
  const imdbId = id.split(":")[0];

  try {
    if (type === "movie") {
      const movie = await cached(
        moviePayloadCacheKey(imdbId),
        MOVIE_PAYLOAD_CACHE_MS,
        () => getMovieByImdb(imdbId),
      );
      return { meta: movie ? movieToMeta(movie) : null };
    }

    if (type === "series") {
      const showMeta = await getShowMeta(imdbId);
      const seasons = await getShowTorrents(imdbId);

      const videos = [];

      for (const s in seasons) {
        for (const e in seasons[s]) {
          videos.push({
            id: `${imdbId}:${s}:${e}`,
            title: `S${s}E${e}`,
            season: +s,
            episode: +e,
          });
        }
      }

      return {
        meta: {
          id: imdbId,
          type: "series",
          name: showMeta?.title || imdbId,
          videos,
        },
      };
    }
  } catch (e) {
    console.error("meta error", e.message);
  }

  return { meta: null };
});

// ---------------------------------------------------------------------------
// STREAM
// ---------------------------------------------------------------------------

builder.defineStreamHandler(async ({ type, id }) => {
  const [imdbId, s, e] = id.split(":");
  const season = s ? +s : null;
  const episode = e ? +e : null;

  try {
    if (type === "movie") {
      const movie = await cached(
        moviePayloadCacheKey(imdbId),
        MOVIE_PAYLOAD_CACHE_MS,
        () => getMovieByImdb(imdbId),
      );
      if (!movie?.torrents) return { streams: [] };

      return {
        streams: processTorrents(movie.torrents, { imdbId }),
        cacheMaxAge: 1800,
      };
    }

    if (type === "series") {
      const seasons = await getShowTorrents(imdbId);
      const eps = seasons?.[season]?.[episode] || [];

      return {
        streams: processTorrents(eps, { imdbId, season, episode }),
        cacheMaxAge: 1800,
      };
    }
  } catch (e) {
    console.error("stream error", e.message);
  }

  return { streams: [] };
});

// ---------------------------------------------------------------------------
// SERVER
// ---------------------------------------------------------------------------
// Rate limiting: stremio-addon-sdk uses a plain http handler (not Express).
// For public hosts, add a reverse-proxy limiter or a small token-bucket here.

const addonInterface = builder.getInterface();
const originalHandler = addonInterface.handler;

const logoPath = path.join(__dirname, "logo.png");
const logoBuffer = fs.readFileSync(logoPath);

addonInterface.handler = (req, res) => {
  const url = req.url.split("?")[0];

  console.log("Addon request:", url);

  if (url === "/logo.png") {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400"
    });
    return res.end(logoBuffer);
  }

  return originalHandler(req, res);
};

serveHTTP(addonInterface, { port: PORT });

console.log(`👻 Phantom running → http://localhost:${PORT}/manifest.json`);
