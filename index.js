#!/usr/bin/env node
'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { getMovies, getMovieByImdb, getLatestShows, getShowTorrents } = require('./providers/aggregator');
const { cached } = require('./providers/cache');

// ---------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------
const MOVIE_GENRES = [
  'Action','Adventure','Animation','Biography','Comedy','Crime',
  'Documentary','Drama','Family','Fantasy','Film-Noir','History',
  'Horror','Music','Musical','Mystery','Romance','Sci-Fi',
  'Sport','Thriller','War','Western',
];

// ---------------------------------------------------------------------------
// Manifest — 6 movie catalogs + 1 series catalog
// ---------------------------------------------------------------------------
const manifest = {
  id: 'community.ytseztv.stremio',
  version: '2.0.0',
  name: 'YTS + EZTV',
  description: 'Movies from YTS (720p/1080p/4K) + TV Series from EZTV — all via magnet links',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/1/18/YTS_logo.png',

  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],

  catalogs: [
    // ---- Movies ----
    {
      id: 'yts-latest',
      type: 'movie',
      name: '🎬 YTS — Latest',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
        { name: 'genre',  isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-top-rated',
      type: 'movie',
      name: '⭐ YTS — Top Rated',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-trending',
      type: 'movie',
      name: '🔥 YTS — Trending',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-4k',
      type: 'movie',
      name: '🎥 YTS — 4K Ultra HD',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-hindi',
      type: 'movie',
      name: '🇮🇳 YTS — Bollywood / Hindi',
      extra: [
        { name: 'skip',   isRequired: false },
        { name: 'search', isRequired: false },
      ],
    },
    {
      id: 'yts-recent-high-rated',
      type: 'movie',
      name: '🏆 YTS — Recent & Highly Rated',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    // ---- Series ----
    {
      id: 'eztv-latest',
      type: 'series',
      name: '📺 EZTV — Latest Episodes',
      extra: [
        { name: 'skip', isRequired: false },
      ],
    },
  ],

  behaviorHints: { adult: false, p2p: true },
};

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------
// const cache = new Map();
// function cached(key, ttlMs, fn) {
//   const now = Date.now();
//   if (cache.has(key)) {
//     const { ts, value } = cache.get(key);
//     if (now - ts < ttlMs) return Promise.resolve(value);
//   }
//   return Promise.resolve(fn()).then(value => {
//     cache.set(key, { ts: now, value });
//     return value;
//   });
// }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function movieToMeta(m) {
  return {
    id:          m.imdbId,
    type:        'movie',
    name:        m.title,
    year:        m.year,
    poster:      m.poster,
    background:  m.background,
    genres:      m.genres,
    imdbRating:  m.rating ? String(m.rating) : undefined,
    runtime:     m.runtime ? `${m.runtime} min` : undefined,
    description: m.summary,
    trailers:    m.ytTrailer ? [{ source: m.ytTrailer, type: 'Trailer' }] : [],
  };
}

function movieToStreams(m) {
  if (!m.torrents || !m.torrents.length) return [];
  const qOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
  return [...m.torrents]
    .sort((a, b) => (qOrder[b.quality] || 0) - (qOrder[a.quality] || 0) || b.seeds - a.seeds)
    .map(t => ({
      name:  `YTS ${t.quality}`,
      title: `🎬 ${m.title}\n${t.quality} | ${t.type ? t.type.toUpperCase() : ''} | ${t.size}\n🌱 ${t.seeds} seeds  👥 ${t.peers} peers`,
      infoHash: t.hash ? t.hash.toLowerCase() : undefined,
      externalUrl: t.magnet,
      behaviorHints: { bingeGroup: `yts-${m.imdbId}` },
    }));
}

function showToMeta(show) {
  return {
    id:     show.imdbId,
    type:   'series',
    name:   show.title,
    poster: show.screenshot || '',
    description: `Latest: S${String(show.season).padStart(2,'0')}E${String(show.episode).padStart(2,'0')}`,
  };
}

// ---------------------------------------------------------------------------
// Catalog handler
// ---------------------------------------------------------------------------
const SORT_MAP = {
  'yts-latest':            { sortBy: 'date_added',     minRating: 0 },
  'yts-top-rated':         { sortBy: 'rating',         minRating: 7 },
  'yts-trending':          { sortBy: 'download_count', minRating: 0 },
  'yts-4k':                { sortBy: 'date_added',     minRating: 0, quality: '2160p' },
  'yts-hindi':             { sortBy: 'date_added',     minRating: 0, genre: 'Hindi' },
  'yts-recent-high-rated': { sortBy: 'year',           minRating: 7 },
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra && extra.search;
  const skip   = parseInt((extra && extra.skip) || '0', 10);
  const genre  = extra && extra.genre;
  const page   = Math.floor(skip / 20) + 1;

  // --- Series catalog ---
  if (type === 'series' && id === 'eztv-latest') {
    const cacheKey = `eztv:latest:${page}`;
    try {
      const shows = await cached(cacheKey, 5 * 60 * 1000, () => getLatestShows(page));
      return { metas: shows.map(showToMeta) };
    } catch (err) {
      console.error('[catalog/series]', err.message);
      return { metas: [] };
    }
  }

  // --- Movie catalogs ---
  if (type === 'movie' && SORT_MAP[id]) {
    const { sortBy, minRating, quality } = SORT_MAP[id];
    // Hindi catalog ignores genre filter (it IS the genre filter)
    const effectiveGenre = id === 'yts-hindi' ? undefined : genre;
    const cacheKey = `yts:${id}:${page}:${effectiveGenre || ''}:${search || ''}`;
    try {
      const movies = await cached(cacheKey, 5 * 60 * 1000, () =>
        getMovies({ query: search, genre: effectiveGenre, page, limit: 20, sortBy, minRating, quality })
      );
      return { metas: movies.map(movieToMeta) };
    } catch (err) {
      console.error('[catalog/movie]', err.message);
      return { metas: [] };
    }
  }

  return { metas: [] };
});

// ---------------------------------------------------------------------------
// Meta handler
// ---------------------------------------------------------------------------
builder.defineMetaHandler(async ({ type, id }) => {
  const imdbId = id.split(':')[0];

  if (type === 'movie') {
    try {
      const movie = await cached(`meta:movie:${imdbId}`, 10 * 60 * 1000, () => getMovieByImdb(imdbId));
      return { meta: movie ? movieToMeta(movie) : null };
    } catch (err) {
      console.error('[meta/movie]', err.message);
      return { meta: null };
    }
  }

  if (type === 'series') {
    try {
      // Build series meta with video objects per episode from EZTV
      const seasons = await cached(`meta:series:${imdbId}`, 10 * 60 * 1000, () => getShowTorrents(imdbId));
      const videos = [];
      for (const [s, eps] of Object.entries(seasons)) {
        for (const [e] of Object.entries(eps)) {
          const sNum = parseInt(s);
          const eNum = parseInt(e);
          videos.push({
            id:       `${imdbId}:${sNum}:${eNum}`,
            title:    `S${String(sNum).padStart(2,'0')}E${String(eNum).padStart(2,'0')}`,
            season:   sNum,
            episode:  eNum,
            released: new Date(2000, 0, 1).toISOString(),
          });
        }
      }
      videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
      return {
        meta: {
          id:     imdbId,
          type:   'series',
          name:   `TV Show (${imdbId})`,
          videos,
        },
      };
    } catch (err) {
      console.error('[meta/series]', err.message);
      return { meta: null };
    }
  }

  return { meta: null };
});

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------
builder.defineStreamHandler(async ({ type, id }) => {
  // id format: "tt1234567" for movies, "tt1234567:1:2" for series (show:season:episode)
  const parts   = id.split(':');
  const imdbId  = parts[0];
  const season  = parts[1] ? parseInt(parts[1]) : null;
  const episode = parts[2] ? parseInt(parts[2]) : null;

  if (type === 'movie') {
    try {
      const movie = await cached(`streams:movie:${imdbId}`, 10 * 60 * 1000, () => getMovieByImdb(imdbId));
      return { streams: movie ? movieToStreams(movie) : [], cacheMaxAge: 3600 };
    } catch (err) {
      console.error('[stream/movie]', err.message);
      return { streams: [], cacheMaxAge: 3600 };
    }
  }

  if (type === 'series' && season !== null && episode !== null) {
    try {
      const seasons = await cached(`streams:series:${imdbId}`, 10 * 60 * 1000, () => getShowTorrents(imdbId));
      const eps = (seasons[String(season)] || {})[String(episode)] || [];
      const streams = eps.map(t => ({
        name:  `EZTV ${t.quality}`,
        title: `📺 S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}\n${t.quality} | ${t.size}\n🌱 ${t.seeds} seeds  👥 ${t.peers} peers`,
        infoHash:    t.hash ? t.hash.toLowerCase() : undefined,
        externalUrl: t.magnet,
        behaviorHints: { bingeGroup: `eztv-${imdbId}` },
      }));
      return { streams, cacheMaxAge: 3600 };
    } catch (err) {
      console.error('[stream/series]', err.message);
      return { streams: [], cacheMaxAge: 3600 };
    }
  }

  return { streams: [], cacheMaxAge: 3600 };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

console.log('\n🎬  YTS + EZTV Stremio Addon is running!');
console.log(`    Manifest : http://localhost:${PORT}/manifest.json`);
console.log(`    Install  : stremio://localhost:${PORT}/manifest.json\n`);
console.log('Catalogs:');
console.log('  Movies  → YTS Latest, Top Rated, Trending, 4K, Bollywood, Recent High Rated');
console.log('  Series  → EZTV Latest Episodes\n');
