#!/usr/bin/env node
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config();

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { getMovies, getMovieByImdb, getLatestShows, getShowTorrents, getShowMeta } = require('./providers/aggregator');
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
  id: 'community.phantom.stremio',
  version: '2.0.0',
  name: 'Phantom',
  description: 'Movies & TV Series via magnet links — powered by YTS, EZTV & Prowlarr',
  logo: 'https://hosting.photobucket.com/26a6037f-4bda-4fe6-a73d-662dc9064777/892c5dcb-091d-4082-900c-4e3febc820c8.png',

  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],

  catalogs: [
    // ---- Movies ----
    {
      id: 'yts-latest',
      type: 'movie',
      name: '🎬 Phantom — Latest',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
        { name: 'genre',  isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-top-rated',
      type: 'movie',
      name: '⭐ Phantom — Top Rated',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-trending',
      type: 'movie',
      name: '🔥 Phantom — Trending',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-4k',
      type: 'movie',
      name: '🎥 Phantom — 4K Ultra HD',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    {
      id: 'yts-hindi',
      type: 'movie',
      name: '🇮🇳 Phantom — Bollywood / Hindi',
      extra: [
        { name: 'skip',   isRequired: false },
        { name: 'search', isRequired: false },
      ],
    },
    {
      id: 'yts-recent-high-rated',
      type: 'movie',
      name: '🏆 Phantom — Recent & Highly Rated',
      extra: [
        { name: 'skip',  isRequired: false },
        { name: 'genre', isRequired: false, options: MOVIE_GENRES },
      ],
    },
    // ---- Series ----
    {
      id: 'eztv-latest',
      type: 'series',
      name: '📺 Phantom — Latest Episodes',
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

  // Detect HDR/DV tags from torrent title for quality label
  function getQualityLabel(t) {
    const title = (t.title || '').toUpperCase();
    const q = t.quality || '';
    const tags = [];
    if (/\bDV\b|DOLBY.?VISION/i.test(title))  tags.push('DV');
    if (/HDR10\+/i.test(title))                tags.push('HDR10+');
    else if (/\bHDR\b/i.test(title))           tags.push('HDR');
    const label = q === '2160p' ? '4k' : q;
    return tags.length ? `${label} ${tags.join(' | ')}` : label;
  }

  return [...m.torrents]
    .sort((a, b) => (qOrder[b.quality] || 0) - (qOrder[a.quality] || 0) || b.seeds - a.seeds)
    .map(t => {
      const isYTS     = t.provider !== 'jackett';
      const source    = isYTS ? 'YTS' : (t.indexer || 'Prowlarr');
      const titleLine = t.title || m.title || '';
      const shortTitle = titleLine.length > 50 ? titleLine.slice(0, 50) + '…' : titleLine;

      return {
        name:  `Phantom\n${getQualityLabel(t)}`,
        title: `${shortTitle}\n👤 ${t.seeds}  💾 ${t.size}  ⚙️ ${source}`,
        infoHash:    t.hash   ? t.hash.toLowerCase() : undefined,
        externalUrl: !t.hash  ? t.magnet             : undefined,
        behaviorHints: { bingeGroup: `phantom-${m.imdbId}` },
      };
    });
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
      const movie = await cached(`movie:${imdbId}`, 10 * 60 * 1000, () => getMovieByImdb(imdbId));
      return { meta: movie ? movieToMeta(movie) : null };
    } catch (err) {
      console.error('[meta/movie]', err.message);
      return { meta: null };
    }
  }

  if (type === 'series') {
    try {
      // Get real show title from aggregator (via OMDb)
      const showMeta = await cached(`meta:series-title:${imdbId}`, 24 * 60 * 60 * 1000, () => getShowMeta(imdbId));

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
          name:   showMeta ? showMeta.title : `TV Show (${imdbId})`,
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
      const movie = await cached(`movie:${imdbId}`, 10 * 60 * 1000, () => getMovieByImdb(imdbId));
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
const addonInterface = builder.getInterface();

// Serve logo.png statically
const http = require('http');
const originalHandler = addonInterface.handler;
addonInterface.handler = (req, res) => {
  if (req.url === '/logo.png') {
    const logoPath = path.join(__dirname, 'Stremio logo.png');
    fs.readFile(logoPath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }
  originalHandler(req, res);
};

serveHTTP(addonInterface, { port: PORT });

console.log('\n👻  Phantom is running!');
console.log(`    Manifest : http://localhost:${PORT}/manifest.json`);
console.log(`    Install  : stremio://localhost:${PORT}/manifest.json\n`);
console.log('Catalogs:');
console.log('  Movies  → Latest, Top Rated, Trending, 4K, Bollywood, Recent High Rated');
console.log('  Series  → Latest Episodes\n');
