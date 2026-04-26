"use strict";

/**
 * Scene Release Parser
 * Extracts structured data from torrent titles with robust regex patterns.
 */

// Pre-compiled regex patterns for performance
const PATTERNS = {
  resolution: /\b(2160p|1080p|720p|480p|4k|uhd)\b/i,
  source: {
    remux: /\bremux\b/i,
    bluray: /\b(bluray|bdrip|bd-rip|blu-ray)\b/i,
    webdl: /\b(web[-_. ]?dl|webdl)\b/i,
    webrip: /\bweb[-_. ]?rip\b/i,
    hdrip: /\bhd[-_. ]?rip\b/i,
    dvd: /\b(dvdrip|dvd-rip|dvdr)\b/i,
  },
  codec: {
    hevc: /\b(x265|hevc|h265)\b/i,
    av1: /\bav1\b/i,
    h264: /\b(x264|h264|avc)\b/i,
    xvid: /\bxvid\b/i,
  },
  hdr: {
    dv: /\b(dolby[-_. ]?vision|dv)\b/i,
    hdr10p: /\bhdr10\+?\b/i,
    hdr: /\bhdr\b/i,
  },
  audio: {
    atmos: /\batmos\b/i,
    truehd: /\btrue[-_. ]?hd\b/i,
    dtshd: /\bdts[-_. ]?hd\b/i,
    dts: /\bdts\b/i,
    ddplus: /\b(dd\+|dolby[-_. ]?digital[-_. ]?plus)\b/i,
    ac3: /\b(ac3|dolby[-_. ]?digital|dd\d\.?\d)\b/i,
    aac: /\baac\b/i,
  },
  extension: /\.(mkv|mp4|avi|mov|wmv|flv|webm|torrent)$/i,
  checksum: /\b([a-f0-9]{8,})\b$/i, // Removes trailing hash strings
};

function parseRelease(title = "") {
  if (!title) return null;

  // Clean title for group extraction (remove extension and trailing hashes)
  const cleanTitle = title
    .replace(PATTERNS.extension, "")
    .replace(PATTERNS.checksum, "")
    .trim();

  // ---------------------------
  // 🎬 Resolution
  // ---------------------------
  const resMatch = title.match(PATTERNS.resolution);
  let resolution = null;
  if (resMatch) {
    const res = resMatch[0].toLowerCase();
    resolution = res === "4k" || res === "uhd" ? "2160p" : res;
  }

  // ---------------------------
  // 📦 Source (Priority Order)
  // ---------------------------
  let source = null;
  if (PATTERNS.source.remux.test(title)) source = "REMUX";
  else if (PATTERNS.source.bluray.test(title)) source = "BluRay";
  else if (PATTERNS.source.webdl.test(title)) source = "WEB-DL";
  else if (PATTERNS.source.webrip.test(title)) source = "WEBRip";
  else if (PATTERNS.source.hdrip.test(title)) source = "HDRip";
  else if (PATTERNS.source.dvd.test(title)) source = "DVDRip";

  // ---------------------------
  // 🧠 Codec
  // ---------------------------
  let codec = null;
  if (PATTERNS.codec.hevc.test(title)) codec = "x265";
  else if (PATTERNS.codec.av1.test(title)) codec = "AV1";
  else if (PATTERNS.codec.h264.test(title)) codec = "x264";
  else if (PATTERNS.codec.xvid.test(title)) codec = "XviD";

  // ---------------------------
  // 🌈 HDR / Dolby Vision
  // ---------------------------
  let hdr = null;
  if (PATTERNS.hdr.dv.test(title)) hdr = "Dolby Vision";
  else if (PATTERNS.hdr.hdr10p.test(title)) hdr = "HDR10+";
  else if (PATTERNS.hdr.hdr.test(title)) hdr = "HDR";

  // ---------------------------
  // 🔊 Audio
  // ---------------------------
  let audio = null;
  if (PATTERNS.audio.atmos.test(title)) audio = "Atmos";
  else if (PATTERNS.audio.truehd.test(title)) audio = "TrueHD";
  else if (PATTERNS.audio.dtshd.test(title)) audio = "DTS-HD";
  else if (PATTERNS.audio.dts.test(title)) audio = "DTS";
  else if (PATTERNS.audio.ddplus.test(title)) audio = "DD+";
  else if (PATTERNS.audio.ac3.test(title)) audio = "AC3";
  else if (PATTERNS.audio.aac.test(title)) audio = "AAC";

  // ---------------------------
  // 👥 Release Group
  // ---------------------------
  // Look for -GROUP or [GROUP] at the end of the cleaned title
  const groupMatch = cleanTitle.match(/[-[\]()]([A-Za-z0-9]+)[-\]()]?$/);
  const group = groupMatch ? groupMatch[1] : null;

  // ---------------------------
  // 🎯 Flags
  // ---------------------------
  const is3D = /\b3d\b/i.test(title);
  const isHDR = !!hdr;
  const isRemux = source === "REMUX";

  return {
    resolution,
    source,
    codec,
    hdr,
    audio,
    group,
    is3D,
    isHDR,
    isRemux,
    // ✅ Added for sorting
    score: calculateQualityScore({ resolution, source, isRemux, isHDR, codec }),
  };
}

/**
 * Calculate a numerical score for sorting torrents.
 * Higher score = Better quality preference.
 */
function calculateQualityScore({ resolution, source, isRemux, isHDR, codec }) {
  let score = 0;

  // Resolution Base
  if (resolution === "2160p") score += 40;
  else if (resolution === "1080p") score += 30;
  else if (resolution === "720p") score += 20;
  else if (resolution === "480p") score += 10;

  // Source Priority
  if (isRemux) score += 50;
  else if (source === "BluRay") score += 40;
  else if (source === "WEB-DL") score += 30;
  else if (source === "WEBRip") score += 25;
  else if (source === "HDRip") score += 15;

  // HDR Bonus
  if (isHDR) score += 10;

  // Codec Bonus (Efficiency)
  if (codec === "x265" || codec === "AV1") score += 5;

  return score;
}

module.exports = { parseRelease, calculateQualityScore };
