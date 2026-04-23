'use strict';

const axios = require('axios');

// YTS mirrors — verified working
const YTS_BASES = [
  //'https://yts.lt/api.accel.li/api/v2/',
  //'https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&language=en-US&api_key=9e5740ad1ac975679728bae65307824c',
  // 'https://yts.tl/api/v2',
  // 'https://yts.pm/api/v2',
  // 'https://yts.do/api/v2',
  //'https://yts.proxyninja.net/api/v2/',
  'https://movies-api.accel.li/api/v2/'
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
  'udp://exodus.desync.com:6969',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function buildMagnet(hash, title) {
  if (!hash) {
    console.error('❌ buildMagnet: missing hash for', title);
    return null;
  }
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${TRACKERS}`;
}

async function ytsGet(endpoint, params = {}) {
  let lastErr;
  
  for (const base of YTS_BASES) {
    try {
      console.log(`🔍 Trying YTS mirror: ${base}`);
      
      const res = await axios.get(`${base}/${endpoint}`, {
        params,
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      
      console.log(`✅ ${base} responded with status: ${res.data?.status}`);
      
      if (res.data && res.data.status === 'ok') {
        console.log(`✅ Success with ${base}`);
        return res.data.data;
      }
      
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  [yts] ${base} failed: ${err.message}`);
    }
  }
  
  console.error('❌ All YTS mirrors failed!');
  throw lastErr || new Error('All YTS mirrors failed');
}

function formatMovie(m) {
  if (!m) {
    console.error('❌ formatMovie: received null/undefined movie');
    return null;
  }
  
  const torrents = (m.torrents || []).map(t => {
    if (!t.hash) {
      console.warn(`⚠️  Missing hash for ${m.title} ${t.quality}`);
      return null;
    }
    
    return {
      quality: t.quality,
      type:    t.type || 'web',
      size:    t.size || 'Unknown',
      seeds:   t.seeds || 0,
      peers:   t.peers || 0,
      hash:    t.hash,
      magnet:  buildMagnet(t.hash, m.title_long || m.title),
      title:   `${m.title_english || m.title} (${m.year}) ${t.quality}`,
    };
  }).filter(Boolean); // Remove null entries
  
  if (torrents.length === 0) {
    console.warn(`⚠️  No valid torrents for ${m.title}`);
  }
  
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
    torrents,
  };
}

async function listMovies({ query, genre, page = 1, limit = 20, sortBy = 'date_added', minRating = 0, quality } = {}) {
  try {
    const params = { 
      limit, 
      page, 
      sort_by: sortBy, 
      order_by: 'desc', 
      minimum_rating: minRating 
    };
    
    if (query)   params.query_term = query;
    if (genre)   params.genre = genre;
    if (quality) params.quality = quality;
    
    console.log('🎬 YTS Query:', params);
    
    const data = await ytsGet('list_movies.json', params);
    
    if (!data.movies || data.movies.length === 0) {
      console.warn('⚠️  No movies returned from YTS');
      return [];
    }
    
    console.log(`✅ Found ${data.movies.length} movies`);
    
    return data.movies.map(formatMovie).filter(Boolean);
  } catch (err) {
    console.error('❌ listMovies error:', err.message);
    return [];
  }
}

async function getMovieByImdb(imdbId) {
  try {
    console.log(`🔍 Fetching YTS movie: ${imdbId}`);
    
    const data = await ytsGet('list_movies.json', { 
      query_term: imdbId, 
      limit: 1 
    });
    
    if (!data.movies || data.movies.length === 0) {
      console.warn(`⚠️  No movie found for ${imdbId}`);
      return null;
    }
    
    const movie = formatMovie(data.movies[0]);
    
    if (!movie) {
      console.error(`❌ Failed to format movie ${imdbId}`);
      return null;
    }
    
    console.log(`✅ Found movie: ${movie.title} with ${movie.torrents.length} torrents`);
    
    return movie;
    
  } catch (err) {
    console.error(`❌ getMovieByImdb(${imdbId}) error:`, err.message);
    return null;
  }
}

module.exports = { listMovies, getMovieByImdb };
