"use strict";

/**
 * @typedef {Object} Torrent
 * @property {string} [title]
 * @property {number} [seeds]
 * @property {number} [peers]
 * @property {string} [size]
 * @property {string} [magnet]
 * @property {string} [hash]
 * @property {string} [infoHash]
 * @property {string} [quality]
 * @property {string} [provider]
 * @property {number} [score]
 * @property {number} [qualityScore]
 * @property {Object|null} [parsed]
 */

/**
 * Movie row for Stremio catalog (YTS-shaped; may include optional fields).
 * @typedef {Object} MovieCatalogEntry
 * @property {string} imdbId
 * @property {string} title
 * @property {string|number} [year]
 * @property {Torrent[]} [torrents]
 * @property {string[]} [genres]
 * @property {string} [poster]
 * @property {string} [background]
 * @property {string|number} [rating]
 * @property {number} [runtime]
 * @property {string} [summary]
 * @property {string} [description]
 */

module.exports = {};
