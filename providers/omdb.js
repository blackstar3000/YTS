"use strict";

const axios = require("axios");

/**
 * OMDb Provider - 2026 Elite Edition
 * Fetches high-quality metadata and normalizes it for Prowlarr/Jackett consumption.
 */

async function getMetaByImdb(imdbId) {
  const apiKey = process.env.OMDB_API_KEY;

  if (!apiKey) {
    console.warn("⚠️ OMDB_API_KEY is not set. Metadata lookup disabled.");
    return null;
  }

  const url = `https://www.omdbapi.com/`;

  try {
    const res = await axios.get(url, {
      params: {
        i: imdbId,
        apikey: apiKey,
        plot: "short", // "full" can sometimes bloat the response unnecessarily
      },
      timeout: 5000,
    });

    const data = res.data;

    if (data.Response === "False") {
      console.warn(`[omdb] No results for ${imdbId}: ${data.Error}`);
      return null;
    }

    // 2026 Normalization Logic:
    // Prowlarr/Jackett hate year ranges like "2019–2024".
    // We extract only the start year for better search matching.
    const rawYear = data.Year || "";
    const cleanYear = rawYear.match(/\d{4}/) ? rawYear.match(/\d{4}/)[0] : null;

    return {
      imdbId: data.imdbID || imdbId,
      title: data.Title,
      year: cleanYear,
      rawYear: data.Year, // Keep original for UI display if needed
      type: data.Type, // 'movie' or 'series' - critical for provider routing
      rating: data.imdbRating !== "N/A" ? data.imdbRating : null,
      description: data.Plot !== "N/A" ? data.Plot : "",
      genres: data.Genre ? data.Genre.split(", ") : [],
      runtime:
        data.Runtime && data.Runtime !== "N/A" ? parseInt(data.Runtime) : null,
      poster: data.Poster && data.Poster !== "N/A" ? data.Poster : null,
      director: data.Director !== "N/A" ? data.Director : null,
      votes: data.imdbVotes ? data.imdbVotes.replace(/,/g, "") : 0,
    };
  } catch (err) {
    console.error(`❌ OMDb provider error: ${err.message}`);
    return null;
  }
}

module.exports = { getMetaByImdb };
