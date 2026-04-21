'use strict';

const axios = require('axios');

/**
 * Jackett Provider
 * Fetches torrents from a Jackett instance using a set of configured indexers.
 */

async function getTorrents(imdbId, title = null, quality = null) {
  const baseUrl = process.env.JACKETT_URL || 'http://localhost:9117';
  const apiKey = process.env.JACKETT_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ JACKETT_API_KEY is not set. Skipping Jackett provider.');
    return [];
  }

  const indexers = ['rutor', 'rutracker', 'thepiratebay', 'therarbg'];
  const results = [];

  // Helper to execute requests and parse results
  async function executeSearch(params) {
    const requests = indexers.map(indexer => {
      const url = `${baseUrl}/api/v2.0/indexers/${indexer}/results`;
      return axios.get(url, {
        params: {
          apikey: apiKey,
          ...params,
        },
        timeout: 10000,
      });
    });

    const responses = await Promise.allSettled(requests);
    const found = [];

    for (const res of responses) {
      if (res.status === 'fulfilled' && res.value.data) {
        const torrents = res.value.data;
        for (const t of torrents) {
          const searchString = `${t.title} ${t.description || ''}`;
          const qualityMatch = searchString.match(/\b(2160p|1080p|720p|480p)\b/i);
          const extractedQuality = qualityMatch ? qualityMatch[0].toLowerCase() : (searchString.match(/hd|720|1080/i) ? '720p' : '480p');

          if (quality && extractedQuality !== quality) continue;

          const typeMatch = searchString.match(/\b(BluRay|WEB-DL|HDRip|BRRip)\b/i);
          found.push({
            quality: extractedQuality,
            type: typeMatch ? typeMatch[0] : 'web',
            size: t.size || 'Unknown',
            seeds: t.seeders || 0,
            peers: t.peers || 0,
            hash: t.hash,
            magnet: t.magnet,
          });
        }
      }
    }
    return found;
  }

  try {
    // 1. Try IMDb ID Search (Precise)
    if (imdbId) {
      console.log(`[Jackett] Attempting IMDb search: ${imdbId}`);
      const idResults = await executeSearch({ imdbid: imdbId.replace(/^tt/, '') });
      if (idResults.length > 0) {
        console.log(`[Jackett] Found ${idResults.length} results via IMDb ID.`);
        return idResults;
      }
    }

    // 2. Try Text Search Fallback (Broader)
    if (title) {
      console.log(`[Jackett] IMDb search failed. Falling back to text search: "${title}"`);
      const textResults = await executeSearch({ q: title });
      if (textResults.length > 0) {
        console.log(`[Jackett] Found ${textResults.length} results via text search.`);
        return textResults;
      }
    }

    return [];
  } catch (err) {
    console.error(`❌ Jackett provider error: ${err.message}`);
    throw err;
  }
}

// Map to the expected "Movie" format for the aggregator/index.js
async function getMovieByImdb(imdbId, title = null) {
  const torrents = await getTorrents(imdbId, title);
  if (torrents.length === 0) return null;

  return {
    imdbId,
    title: title || 'Jackett Result',
    torrents,
  };
}

/**
 * Get TV show torrents and group them by season and episode.
 * Returns: { "1": { "1": [torrents], "2": [torrents] }, "2": { ... } }
 */
async function getShowTorrents(imdbId) {
  const torrents = await getTorrents(imdbId);
  if (torrents.length === 0) return {};

  const seasons = {};

  for (const t of torrents) {
    const title = t.title || '';

    // Regex to match S01E01 or Season 1 Episode 1
    const sMatch = title.match(/S(\d+)/i) || title.match(/Season\s*(\d+)/i);
    const eMatch = title.match(/E(\d+)/i) || title.match(/Episode\s*(\d+)/i);

    if (!sMatch || !eMatch) continue;

    const s = String(parseInt(sMatch[1]) || 1);
    const e = String(parseInt(eMatch[1]) || 1);

    if (!seasons[s]) seasons[s] = {};
    if (!seasons[s][e]) seasons[s][e] = [];

    seasons[s][e].push({
      title: t.title,
      magnet: t.magnet,
      hash: t.hash,
      seeds: t.seeds,
      peers: t.peers,
      size: t.size,
      quality: t.quality,
    });
  }

  return seasons;
}

// For catalog search (simulated as Jackett is best for specific IDs)
async function listMovies(params) {
  console.warn('⚠️ Jackett listMovies is not fully supported (requires specific queries)');
  return [];
}

module.exports = {
  getMovieByImdb,
  getShowTorrents,
  listMovies,
  getTorrents,
};
