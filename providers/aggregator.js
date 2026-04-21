'use strict';

const yts = require('./yts');
const eztv = require('./eztv');
const fallback = require('./fallback');

/**
 * Aggregator serves as the brain layer, orchestrating requests
 * between primary providers and the safety-net fallback.
 */

async function getMovies(params) {
  try {
    const movies = await yts.listMovies(params);
    if (movies && movies.length > 0) {
      console.log('✅ YTS success');
      return movies;
    }
    console.warn('⚠️ YTS returned empty → using fallback');
  } catch (err) {
    console.warn(`❌ YTS failed (${err.message}) → fallback triggered`);
  }
  return await fallback.listMovies();
}

async function getMovieByImdb(imdbId) {
  try {
    const movie = await yts.getMovieByImdb(imdbId);
    if (movie) return movie;
    console.warn(`⚠️ YTS movie not found for ${imdbId} → using fallback`);
  } catch (err) {
    console.warn(`❌ YTS error for ${imdbId} (${err.message}) → fallback triggered`);
  }
  return await fallback.getMovieByImdb(imdbId);
}

async function getLatestShows(params) {
  try {
    const shows = await eztv.getLatestShows(params);
    if (shows && shows.length > 0) {
      console.log('✅ EZTV success');
      return shows;
    }
    console.warn('⚠️ EZTV returned empty → using fallback');
  } catch (err) {
    console.warn(`❌ EZTV failed (${err.message}) → fallback triggered`);
  }
  return await fallback.getLatestShows();
}

async function getShowTorrents(imdbId, params) {
  try {
    const torrents = await eztv.getShowTorrents(imdbId, params);
    if (torrents && torrents.length > 0) {
      console.log('✅ EZTV torrents success');
      return torrents;
    }
    console.warn(`⚠️ EZTV torrents empty for ${imdbId} → using fallback`);
  } catch (err) {
    console.warn(`❌ EZTV error for ${imdbId} (${err.message}) → fallback triggered`);
  }
  return await fallback.getShowTorrents(imdbId, params);
}

module.exports = {
  getMovies,
  getMovieByImdb,
  getLatestShows,
  getShowTorrents
};
