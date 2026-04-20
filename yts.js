'use strict';

const axios = require('axios');

// YTS mirrors — tried in order, first working one wins
const YTS_BASES = [
  'https://ytstv.bz/api/v2',
  'https://www6.yts-official.to/api/v2',
  'https://yts.lt/api/v2',
  'https://yts.mx/api/v2',
  'https://yts.am/api/v2',
];

const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://glotorrents.pw:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://torrent.gresille.org:80/announce',
  'udp://p4p.arenabg.ch:1337',
  'udp://tracker.leechers-paradise.org:6969',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function buildMagnet(hash, title) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${TRACKERS}`;
}

async function ytsGet(endpoint, params = {}) {
  let lastErr;
  for (const base of YTS_BASES) {
    try {
      const res = await axios.get(`${base}/${endpoint}`, {
        params,
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (res.data && res.data.status === 'ok') {
        return res.data.data;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[yts] ${base} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('All YTS mirrors failed');
}

function formatMovie(m) {
  return {
    ytsId:      m.id,
    imdbId:     m.imdb_code,
    title:      m.title_english || m.title,
    year:       m.year,
    rating:     m.rating,
    runtime:    m.runtime,
    genres:     m.genres || [],
    summary:    m.synopsis || m.description_full || '',
    language:   m.language,
    mpaRating:  m.mpa_rating,
    ytTrailer:  m.yt_trailer_code,
    poster:     m.large_cover_image  || m.medium_cover_image || '',
    background: m.background_image_original || m.background_image || '',
    torrents: (m.torrents || []).map(t => ({
      quality: t.quality,
      type:    t.type,
      size:    t.size,
      seeds:   t.seeds,
      peers:   t.peers,
      hash:    t.hash,
      magnet:  buildMagnet(t.hash, m.title_long),
    })),
  };
}

async function listMovies({ query, genre, page = 1, limit = 20, sortBy = 'date_added', minRating = 0, quality } = {}) {
  const params = { limit, page, sort_by: sortBy, order_by: 'desc', minimum_rating: minRating };
  if (query)   params.query_term = query;
  if (genre)   params.genre = genre;
  if (quality) params.quality = quality;
  const data = await ytsGet('list_movies.json', params);
  return (data.movies || []).map(formatMovie);
}

async function getMovieByImdb(imdbId) {
  const data = await ytsGet('list_movies.json', { query_term: imdbId, limit: 1 });
  const m = (data.movies || [])[0];
  return m ? formatMovie(m) : null;
}

module.exports = { listMovies, getMovieByImdb };
