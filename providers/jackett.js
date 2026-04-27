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

function titleMatches(torrentTitle, targetTitle) {
  if (!targetTitle) return true;
  const t1 = normalize(torrentTitle);
  const t2 = normalize(targetTitle);
  return t1.includes(t2) || t2.includes(t1);
}

function cleanTitle(title) {
  return title
    ?.replace(/[:\-–—]/g, " ")
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

  if (t.quality === "2160p") score += 50;
  else if (t.quality === "1080p") score += 30;
  else if (t.quality === "720p") score += 10;

  if (t.source === "REMUX") score += 80;
  else if (t.source === "BluRay") score += 50;
  else if (t.source === "WEB-DL") score += 30;
  else if (t.source === "WEBRip") score += 20;

  if (t.source === "REMUX") score += 30;

  if (t.hdr === "Dolby Vision") score += 40;
  else if (t.hdr === "HDR10+") score += 35;
  else if (t.hdr === "HDR") score += 25;

  if (t.codec === "x265") score += 15;
  else if (t.codec === "x264") score += 5;

  if (t.audio === "TrueHD") score += 20;
  else if (t.audio === "DTS-HD") score += 15;

  score += Math.min(Math.log10(Math.max(t.seeds, 1)) * 5, 30);

  if (t.indexer?.toLowerCase().includes("1337x")) score -= 10;

  if (t.quality === "2160p" && t.sizeNum && t.sizeNum < 8) score -= 40;

  return Math.round(score);
}

// ================= NETWORK =================
async function fetchWithRetry(
  url,
  options,
  retries = CONFIG.jackett.maxRetries,
) {
  try {
    return await axios.get(url, options);
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, CONFIG.jackett.retryDelay));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

async function executeSearch(query, signal) {
  if (!query) return [];

  console.log(`[Provider] Searching: ${query}`);

  try {
    const res = await fetchWithRetry(
      `${CONFIG.jackett.baseUrl}/api/v1/search`,
      {
        params: {
          query,
          categories: CONFIG.jackett.categories.movie,
          type: "movie",
        },
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
    console.error(`[Provider] Search failed (${query}): ${err.message}`);
    return [];
  }
}

// ================= PARSER =================
function parseTorrent(item, title, year) {
  const torrentTitle = item.title || item.name;
  if (!torrentTitle) return null;

  if (!titleMatches(torrentTitle, title)) return null;

  if (year && !torrentTitle.includes(year.toString())) {
    if (!/remux|bluray/i.test(torrentTitle)) return null;
  }

  let meta = parseRelease(torrentTitle);

  if (!meta.resolution) {
    const m = torrentTitle.match(/\b(2160p|1080p|720p)\b/i);
    if (!m) return null;
    meta.resolution = m[0].toLowerCase();
  }

  let magnet = null;
  let infoHash = item.infoHash || item.info_hash || null;

  if (item.magnetUrl && item.magnetUrl.startsWith("magnet:")) {
    magnet = item.magnetUrl;
  }

  if (!magnet && item.guid && item.guid.startsWith("magnet:")) {
    magnet = item.guid;
  }

  if (!magnet && infoHash) {
    magnet = buildMagnet(infoHash, torrentTitle);
  }

  if (!magnet || !magnet.startsWith("magnet:")) return null;
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
    seeds: item.seeders || 0,
    magnet,
    hash: infoHash, // ✅ FIXED
    indexer: item.indexer,
    title: torrentTitle,

    label: [
      `${title || ""}${year ? ` (${year})` : ""}`,
      meta.resolution,
      meta.source,
      meta.hdr,
      meta.codec,
      meta.audio,
    ]
      .filter(Boolean)
      .join(" • "),
  };
}

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

    if (!clusters.has(key)) {
      clusters.set(key, []);
    }

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
// ================= MAIN =================
async function getTorrents(imdbId, title, year) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), CONFIG.jackett.timeout);

  const searches = [];

  if (imdbId) searches.push(executeSearch(imdbId, controller.signal));

  if (title) {
    const query = year ? `${cleanTitle(title)} ${year}` : cleanTitle(title);
    searches.push(executeSearch(query, controller.signal));
  }

  const results = (await Promise.all(searches)).flat();

  const unique = new Map();
  for (const item of results) {
    const key = item.infoHash || item.guid || item.title;
    if (!unique.has(key)) unique.set(key, item);
  }

  const parsed = [];

  for (const item of unique.values()) {
    const t = parseTorrent(item, title, year);
    if (t) parsed.push(t);
  }

  const scored = parsed.map((t) => ({
    ...t,
    score: calculateScore(t),
  }));

  const clusters = clusterTorrents(scored);

  const bestPerCluster = pickBestFromClusters(clusters);
  const withLabels = bestPerCluster.map((t) => ({
    ...t,
    label: [
      `${title || ""}${year ? ` (${year})` : ""}`,
      t.quality,
      t.source,
      t.hdr,
      t.codec,
      t.audio,
      t.clusterSize > 1 ? `🔥 +${t.clusterSize - 1} more` : null,
    ]
      .filter(Boolean)
      .join(" • "),
  }));

  return withLabels
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.jackett.maxResults);
}

// ================= MOVIE =================
async function getMovieByImdb(imdbId, title, year) {
  const torrents = await getTorrents(imdbId, title, year);
  return torrents.length ? { imdbId, title, torrents } : null;
}

// ================= SHOW =================
async function getShowTorrents(imdbId, title) {
  const torrents = await getTorrents(imdbId, title, null);
  if (!torrents.length) return {};

  const seasons = {};

  for (const t of torrents) {
    const name = t.title || "";

    const m = name.match(/S(\d+)E(\d+)/i) || name.match(/(\d+)x(\d+)/i);

    if (!m) continue;

    const s = String(parseInt(m[1]));
    const e = String(parseInt(m[2]));

    seasons[s] ??= {};
    seasons[s][e] ??= [];

    seasons[s][e].push(t);
  }

  return seasons;
}

// ================= EXPORT =================
module.exports = {
  getMovieByImdb,
  getTorrents,
  getShowTorrents,
};
