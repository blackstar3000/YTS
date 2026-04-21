'use strict';

const axios = require('axios');

// EZTV free public API — no key required
const EZTV_BASES = [
  'https://eztvx.to/api',
  'https://eztv.re/api',
  'https://eztv.wf/api',
  'https://eztv.tf/api',
];

async function eztvGet(params = {}) {
  let lastErr;
  for (const base of EZTV_BASES) {
    try {
      const res = await axios.get(`${base}/get-torrents`, {
        params: { limit: 100, ...params },
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (res.data && res.data.torrents_count !== undefined) {
        return res.data;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[eztv] ${base} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('All EZTV mirrors failed');
}

/**
 * Get the latest TV show episodes (for catalog browsing).
 * Returns a deduplicated list of shows from recent torrents.
 */
async function getLatestShows(page = 1) {
  const data = await eztvGet({ page });
  const torrents = data.torrents || [];

  // Deduplicate by imdb_id to get unique shows
  const seen = new Set();
  const shows = [];
  for (const t of torrents) {
    if (!t.imdb_id || seen.has(t.imdb_id)) continue;
    seen.add(t.imdb_id);
    shows.push({
      imdbId:     `tt${t.imdb_id.replace(/^tt/, '')}`,
      title:      extractShowTitle(t.title),
      season:     parseInt(t.season) || 1,
      episode:    parseInt(t.episode) || 1,
      filename:   t.filename,
      screenshot: t.large_screenshot ? `https:${t.large_screenshot}` : null,
    });
  }
  return shows;
}

/**
 * Get all torrents for a specific show by IMDb ID.
 * Returns them grouped by season → episode → quality.
 */
async function getShowTorrents(imdbId) {
  const numericId = imdbId.replace(/^tt0*/, '');
  const data = await eztvGet({ imdb_id: numericId });
  const torrents = data.torrents || [];

  // Group: season -> episode -> [torrents]
  const seasons = {};
  for (const t of torrents) {
    const s = String(parseInt(t.season) || 1);
    const e = String(parseInt(t.episode) || 1);
    if (!seasons[s]) seasons[s] = {};
    if (!seasons[s][e]) seasons[s][e] = [];
    seasons[s][e].push({
      title:   t.title,
      magnet:  t.magnet_url,
      hash:    t.hash,
      seeds:   t.seeds,
      peers:   t.peers,
      size:    t.size_bytes ? formatBytes(t.size_bytes) : '',
      quality: detectQuality(t.title),
    });
  }

  // Sort each episode's torrents best quality first
  for (const s of Object.keys(seasons)) {
    for (const e of Object.keys(seasons[s])) {
      seasons[s][e].sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality) || b.seeds - a.seeds);
    }
  }

  return seasons;
}

// ---- helpers ----

function extractShowTitle(filename) {
  // "Show.Name.S01E02.720p..." → "Show Name"
  return (filename || '')
    .replace(/\.(S\d+E\d+|Season|\d{4}).*$/i, '')
    .replace(/\./g, ' ')
    .trim();
}

function detectQuality(title) {
  if (/2160p|4k|uhd/i.test(title)) return '4K';
  if (/1080p/i.test(title))        return '1080p';
  if (/720p/i.test(title))         return '720p';
  if (/480p/i.test(title))         return '480p';
  return 'SD';
}

function qualityScore(q) {
  return { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'SD': 0 }[q] || 0;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

module.exports = { getLatestShows, getShowTorrents };
