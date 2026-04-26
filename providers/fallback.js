"use strict";

/**
 * Fallback provider serves as a safety net when primary providers are down.
 * It returns safe, empty structures to prevent the aggregator from crashing.
 */

async function listMovies(params = {}) {
  console.log("🟡 Fallback provider active: listMovies");
  return [];
}

async function getMovieByImdb(imdbId) {
  console.log("🟡 Fallback provider active: getMovieByImdb");
  return {
    imdbId,
    title: "Unavailable",
    year: null,
    rating: 0,
    runtime: 0,
    genres: [],
    summary: "Content temporarily unavailable from all sources.",
    language: "en",
    mpaRating: "N/A",
    ytTrailer: null,
    poster: "",
    background: "",
    torrents: [],
    provider: "fallback",
  };
}

async function getLatestShows(page = 1) {
  console.log("🟡 Fallback provider active: getLatestShows");
  return [];
}

async function getShowTorrents(imdbId) {
  console.log("🟡 Fallback provider active: getShowTorrents");
  return {};
}

// ✅ ADDED: Missing export to match aggregator
async function getShowMeta(imdbId) {
  console.log("🟡 Fallback provider active: getShowMeta");
  return {
    imdbId,
    title: `TV Show (${imdbId})`,
    year: null,
    rating: 0,
    genres: [],
    provider: "fallback",
  };
}

module.exports = {
  listMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents,
  getShowMeta, // ✅ Exported
};
