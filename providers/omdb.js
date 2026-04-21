'use strict';

const axios = require('axios');

/**
 * OMDb Provider
 * Fetches high-quality metadata for movies and series using IMDb IDs.
 */

async function getMetaByImdb(imdbId) {
  const apiKey = process.env.OMDB_API_KEY || '633989b';
  const url = `https://www.omdbapi.com/`;

  try {
    const res = await axios.get(url, {
      params: {
        i: imdbId,
        apikey: apiKey,
      },
      timeout: 5000,
    });

    const data = res.data;

    if (data.Response === 'False') {
      return null;
    }

    return {
      title: data.Title,
      year: data.Year,
      rating: data.imdbRating,
      description: data.Plot,
      genres: data.Genre ? data.Genre.split(', ') : [],
      runtime: data.Runtime ? parseInt(data.Runtime) : undefined,
      poster: data.Poster !== 'N/A' ? data.Poster : null,
    };
  } catch (err) {
    console.error(`❌ OMDb provider error: ${err.message}`);
    return null;
  }
}

module.exports = { getMetaByImdb };
