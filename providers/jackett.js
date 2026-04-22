'use strict';

const axios = require('axios');

/**
 * Jackett Provider — uses Torznab API with IMDb ID search
 */

async function getTorrents(imdbId, title = null, timeout = 15000) {
  const baseUrl = process.env.JACKETT_URL || 'http://localhost:9117';
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
    // Matches name="x" value="y" or value="y" name="x" (case-insensitive)
    const re = new RegExp('name=["\']' + name + '["\']\\s+value=["\']([^"\']*)["\']|value=["\']([^"\']*)["\']\\s+name=["\']' + name + '["\']', 'i');
    const m = xml.match(re);
    return m ? decodeEntities((m[1] || m[2] || '').trim()) : '';
  }

  async function executeSearch(params) {
    console.log(`[Jackett Debug] Searching with params:`, JSON.stringify(params));
    const url = `${baseUrl}/api/v2.0/indexers/all/results/torznab/api`;
    let res;
    try {
      res = await axios.get(url, {
        params: { apikey: apiKey, ...params },
        timeout,
        headers: { 'Accept': 'application/xml, text/xml' },
      });
    } catch (err) {
      console.error(`[Jackett Debug] Request failed: ${err.message}`);
      return [];
    }

    const xml   = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    console.log(`[Jackett Debug] Torznab returned ${items.length} items`);

    const found = [];

    for (const item of items) {
      const torrentTitle = getTag(item, 'title');

      // Skip TV episodes
      if (/\bS\d{1,2}E\d{1,2}\b/i.test(torrentTitle) || /\bSeason\s*\d+/i.test(torrentTitle)) {
        continue;
      }

      // Quality filter — skip 480p and unknown
      const qualityMatch = torrentTitle.match(/\b(2160p|1080p|720p|480p)\b/i);
      const quality = qualityMatch
        ? qualityMatch[0].toLowerCase()
        : (/\b(hd|720|1080)\b/i.test(torrentTitle) ? '720p' : null);

      if (!quality || quality === '480p') {
        console.log(`[Jackett] Filtered (${quality || 'unknown'}): ${torrentTitle}`);
        continue;
      }

      // Extract magnet — try torznab attr first, then <guid>
      let magnet = getAttr(item, 'magneturl') || getAttr(item, 'MagnetUrl');
      let hash   = getAttr(item, 'infohash')  || getAttr(item, 'InfoHash');

      if (!magnet) {
        const guid = getTag(item, 'guid');
        if (guid.startsWith('magnet:')) {
          magnet = guid;
        }
      }

      if (!hash && magnet) {
        const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{32,40})/i);
        if (hashMatch) hash = hashMatch[1];
      }

      if (!magnet && !hash) {
        // Some indexers (e.g. TorrentGalaxy) only provide a page URL in <guid>, not a magnet — skip silently
        continue;
      }

      const sizeRaw = getAttr(item, 'size') || getAttr(item, 'Size') || '';
      const sizeGB  = sizeRaw && !isNaN(parseInt(sizeRaw))
        ? `${(parseInt(sizeRaw) / (1024 ** 3)).toFixed(2)} GB`
        : 'Unknown';

      const seeds = parseInt(getAttr(item, 'seeders') || getAttr(item, 'Seeders') || '0');
      const peers = parseInt(getAttr(item, 'peers')   || getAttr(item, 'Peers')   || '0');

      const typeMatch = torrentTitle.match(/\b(BluRay|WEB-DL|HDRip|BRRip|Remux)\b/i);

      console.log(`[Jackett] Accepted (${quality}): ${torrentTitle}`);

      found.push({
        quality,
        type:   typeMatch ? typeMatch[0] : 'web',
        size:   sizeGB,
        seeds,
        peers,
        hash,
        magnet,
      });
    }

    return found;
  }

  // IMDb ID search only — text search returns too many unrelated results
  if (imdbId) {
    console.log(`[Jackett] Searching by IMDb ID: ${imdbId}`);
    try {
      const results = await executeSearch({ t: 'movie', imdbid: imdbId, cat: '2000' });
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
