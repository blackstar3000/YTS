'use strict';

const axios = require('axios');

/**
 * Jackett Provider
 * Fetches torrents from a Jackett instance using a set of configured indexers.
 */

async function getTorrents(imdbId, quality = null) {
  const baseUrl = process.env.JACKETT_URL || 'http://localhost:9117';
  const apiKey = process.env.JACKETT_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ JACKETT_API_KEY is not set. Skipping Jackett provider.');
    return [];
  }

  const indexers = ['1337x', 'torrentia', 'thepiratebay'];
  const results = [];

  try {
    const requests = indexers.map(indexer => {
      const url = `${baseUrl}/api/v2.0/indexers/${indexer}/results`;
      return axios.get(url, {
        params: {
          apikey: apiKey,
          imdbid: imdbId,
        },
        timeout: 10000,
      });
    });

    const responses = await Promise.allSettled(requests);

    for (const res of responses) {
      if (res.status === 'fulfilled' && res.value.data) {
        const torrents = res.value.data;

        for (const t of torrents) {
          // Better quality extraction: check both title and description
          const searchString = `${t.title} ${t.description || ''}`;
          const qualityMatch = searchString.match(/\b(2160p|1080p|720p|480p)\b/i);
          const extractedQuality = qualityMatch ? qualityMatch[0].toLowerCase() : 'Unknown';

          if (quality && extractedQuality !== quality) continue;

          const typeMatch = searchString.match(/\b(BluRay|WEB-DL|HDRip|BRRip)\b/i);

          results.push({
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

    return results;
  } catch (err) {
    console.error(`❌ Jackett provider error: ${err.message}`);
    return [];
  }
}

// Map to the expected "Movie" format for the aggregator/index.js
async function getMovieByImdb(imdbId) {
  const torrents = await getTorrents(imdbId);
  if (torrents.length === 0) return null;

  // Since Jackett only provides torrents, we return a minimal movie object
  // that contains the torrents array required by movieToStreams.
  return {
    imdbId,
    title: 'Jackett Result', // Title will be filled by the aggregator or index.js
    torrents,
  };
}

// For catalog search (simulated as Jackett is best for specific IDs)
async function listMovies(params) {
  console.warn('⚠️ Jackett listMovies is not fully supported (requires specific queries)');
  return [];
}

module.exports = {
  getMovieByImdb,
  listMovies,
  getTorrents,
};
