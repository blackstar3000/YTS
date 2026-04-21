'use strict';

/**
 * Fallback provider serves as a safety net when primary providers are down.
 * It returns safe, empty structures to prevent the aggregator from crashing.
 */

async function listMovies() {
  console.log('🟡 Fallback provider active: listMovies');
  return [];
}

async function getMovieByImdb() {
  console.log('🟡 Fallback provider active: getMovieByImdb');
  return null;
}

async function getLatestShows() {
  console.log('🟡 Fallback provider active: getLatestShows');
  return [];
}

async function getShowTorrents() {
  console.log('🟡 Fallback provider active: getShowTorrents');
  return [];
}

module.exports = {
  listMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents
};
