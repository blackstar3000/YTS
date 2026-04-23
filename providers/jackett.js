'use strict';

const axios = require('axios');

/**
 * Jackett Provider — uses Torznab API with IMDb ID search
 */

async function getTorrents(imdbId, title = null, timeout = 15000) {
  const baseUrl = process.env.JACKETT_URL || 'http://localhost:9696';
  const apiKey  = process.env.JACKETT_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ JACKETT_API_KEY is not set. Skipping Jackett provider.');
    return [];
  }

  // --- XML helpers (no external parser needed) ---

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g,  "'");
  }

  function getTag(xml, tag) {
    // Matches <tag ...>CDATA or plain text</tag>
    const cdataRe = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[[\\s\\S]*?\\]\\]><\\/' + tag + '>');
    const plainRe = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>');

    const cdataM = xml.match(cdataRe);
    if (cdataM) {
      const inner = cdataM[0].replace(/<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
      return decodeEntities(inner.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());
    }
    const plainM = xml.match(plainRe);
    return plainM ? decodeEntities(plainM[1].trim()) : '';
  }

  function getAttr(xml, name) {
    // Matches torznab:attr or attr elements with name/value pairs (case-insensitive, handles namespace prefix)
    const re = new RegExp('name=["\']' + name + '["\']\\s+value=["\']([^"\']*)["\']|value=["\']([^"\']*)["\']\\s+name=["\']' + name + '["\']', 'i');
    const m = xml.match(re);
    return m ? decodeEntities((m[1] || m[2] || '').trim()) : '';
  }

async function executeSearch(params) {
  const imdbId = params.imdbid;
  console.log(`[Prowlarr Debug] Searching for IMDb: ${imdbId}`);
  
  const url = `${baseUrl}/api/v1/search`;
  
  let res;
  try {
    res = await axios.get(url, {
      params: {
        query: imdbId,
        categories: [2000],  // Movies
        type: 'movie'
      },
      timeout,
      headers: { 
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      },
    });
  } catch (err) {
    console.error(`[Prowlarr Debug] Request failed: ${err.message}`);
    return [];
  }

    const items = res.data;
    console.log(`[Jackett Debug] Torznab returned ${items.length} items`);

    const found = [];

for (const item of items) {
  const torrentTitle = item.title;

  if (!torrentTitle) continue;

  if (/\bS\d{1,2}E\d{1,2}\b/i.test(torrentTitle)) continue;

  const qualityMatch = torrentTitle.match(/\b(2160p|1080p|720p|480p)\b/i);
  const quality = qualityMatch ? qualityMatch[0].toLowerCase() : null;

  if (!quality || quality === '480p') continue;

  const magnet = item.magnetUrl;
  const hash   = item.infoHash;

  const sizeGB = item.size
    ? `${(item.size / (1024 ** 3)).toFixed(2)} GB`
    : 'Unknown';

  const seeds = item.seeders || 0;
  const peers = item.leechers || 0;

  found.push({
    quality,
    type: 'web',
    size: sizeGB,
    seeds,
    peers,
    hash,
    magnet,
    indexer: item.indexer || 'Prowlarr',
    title: item.title || '',
  });
}

    return found;
  }

  // IMDb ID search only — text search returns too many unrelated results
  if (imdbId) {
    console.log(`[Jackett] Searching by IMDb ID: ${imdbId}`);
    try {
      const results = await executeSearch({ imdbid: imdbId });
      if (results.length > 0) {
        console.log(`[Jackett] Found ${results.length} results via IMDb ID.`);
        return results;
      }
      console.log(`[Jackett] No results found for IMDb ID: ${imdbId}`);
    } catch (err) {
      console.error(`❌ Jackett provider error: ${err.message}`);
    }
  }

  return [];
}

async function getMovieByImdb(imdbId, title = null, timeout = 15000) {
  const torrents = await getTorrents(imdbId, title, timeout);
  if (!torrents.length) return null;
  return { imdbId, title: title || 'Jackett Result', torrents };
}

async function getShowTorrents(imdbId, timeout = 15000) {
  const torrents = await getTorrents(imdbId, null, timeout);
  if (!torrents.length) return {};

  const seasons = {};
  for (const t of torrents) {
    const sMatch = (t.title || '').match(/S(\d+)/i);
    const eMatch = (t.title || '').match(/E(\d+)/i);
    if (!sMatch || !eMatch) continue;

    const s = String(parseInt(sMatch[1]));
    const e = String(parseInt(eMatch[1]));
    if (!seasons[s]) seasons[s] = {};
    if (!seasons[s][e]) seasons[s][e] = [];
    seasons[s][e].push(t);
  }
  return seasons;
}

async function listMovies() {
  return [];
}

module.exports = { getMovieByImdb, getShowTorrents, listMovies, getTorrents };
