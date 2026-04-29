"use strict";

/**
 * Fallback Provider - 2026 Resiliency Standard
 * Prevents aggregator crashes by returning valid but empty data structures.
 */

async function listMovies(params = {}) {
  console.log("🟡 Fallback: Returning empty movie list");
  return [];
}

async function getMovieByImdb(imdbId) {
  console.log(`🟡 Fallback: Metadata placeholder for ${imdbId}`);
  return {
    imdbId,
    title: "Content Unavailable",
    year: "N/A",
    rating: null,
    description:
      "The metadata providers are currently unreachable. Please try again later.",
    genres: [],
    poster: null,
    torrents: [], // Crucial: Stremio won't see any links but won't crash
    provider: "fallback",
  };
}

async function getLatestShows(page = 1) {
  console.log("🟡 Fallback: Returning empty latest shows");
  return [];
}

async function getShowTorrents(imdbId) {
  console.log(`🟡 Fallback: Returning empty stream object for ${imdbId}`);
  return {}; // Returns empty season map: {}
}

async function getShowMeta(imdbId) {
  console.log(`🟡 Fallback: Meta placeholder for ${imdbId}`);
  return {
    imdbId,
    title: "Show Unavailable",
    year: null,
    genres: [],
    description: "Metadata offline.",
    provider: "fallback",
  };
}

module.exports = {
  listMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents,
  getShowMeta,
};
