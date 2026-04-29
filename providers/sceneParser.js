"use strict";

/**
 * Scene Release Parser - 2026 Elite Edition
 * Optimized for high-fidelity technical metadata extraction.
 */

const PATTERNS = {
  resolution: /\b(2160p|1080p|720p|480p|4k|uhd)\b/i,
  source: {
    remux: /\bremux\b/i,
    bluray: /\b(bluray|bdrip|bd-rip|blu-ray)\b/i,
    webdl: /\b(web[-_. ]?dl|webdl|amazonhd|amzn|nf|dsnp|hmax)\b/i, // Added common service tags
    webrip: /\bweb[-_. ]?rip\b/i,
    hdrip: /\bhd[-_. ]?rip\b/i,
    dvd: /\b(dvdrip|dvd-rip|dvdr)\b/i,
  },
  codec: {
    hevc: /\b(x265|hevc|h265|10bit)\b/i,
    av1: /\bav1\b/i,
    h264: /\b(x264|h264|avc)\b/i,
    xvid: /\bxvid\b/i,
  },
  hdr: {
    dv: /\b(dolby[-_. ]?vision|dv|dovi)\b/i,
    hdr10p: /\bhdr10\+?\b/i,
    hdr: /\bhdr\b/i,
  },
  audio: {
    atmos: /\batmos\b/i,
    truehd: /\btrue[-_. ]?hd\b/i,
    dtshd: /\bdts[-_. ]?hd\b/i,
    dts: /\bdts\b/i,
    ddplus: /\b(dd\+|eac3|dolby[-_. ]?digital[-_. ]?plus)\b/i,
    ac3: /\b(ac3|dolby[-_. ]?digital|dd\d\.?\d)\b/i,
    aac: /\baac\b/i,
  },
  extension: /\.(mkv|mp4|avi|mov|wmv|flv|webm|torrent)$/i,
  checksum: /\b([a-f0-9]{8,})\b$/i,
};

function parseRelease(title = "") {
  if (!title) return null;

  const cleanTitle = title
    .replace(PATTERNS.extension, "")
    .replace(PATTERNS.checksum, "")
    .trim();

  // --- Resolution ---
  const resMatch = title.match(PATTERNS.resolution);
  let resolution = null;
  if (resMatch) {
    const res = resMatch[0].toLowerCase();
    resolution = res === "4k" || res === "uhd" ? "2160p" : res;
  }

  // --- Source ---
  let source = null;
  if (PATTERNS.source.remux.test(title)) source = "REMUX";
  else if (PATTERNS.source.bluray.test(title)) source = "BluRay";
  else if (PATTERNS.source.webdl.test(title)) source = "WEB-DL";
  else if (PATTERNS.source.webrip.test(title)) source = "WEBRip";
  else if (PATTERNS.source.hdrip.test(title)) source = "HDRip";
  else if (PATTERNS.source.dvd.test(title)) source = "DVDRip";

  // --- Codec ---
  let codec = null;
  if (PATTERNS.codec.av1.test(title)) codec = "AV1";
  else if (PATTERNS.codec.hevc.test(title)) codec = "x265";
  else if (PATTERNS.codec.h264.test(title)) codec = "x264";
  else if (PATTERNS.codec.xvid.test(title)) codec = "XviD";

  // --- HDR ---
  let hdr = null;
  if (PATTERNS.hdr.dv.test(title)) hdr = "Dolby Vision";
  else if (PATTERNS.hdr.hdr10p.test(title)) hdr = "HDR10+";
  else if (PATTERNS.hdr.hdr.test(title)) hdr = "HDR";

  // --- Audio ---
  let audio = null;
  if (PATTERNS.audio.atmos.test(title)) audio = "Atmos";
  else if (PATTERNS.audio.truehd.test(title)) audio = "TrueHD";
  else if (PATTERNS.audio.dtshd.test(title)) audio = "DTS-HD";
  else if (PATTERNS.audio.dts.test(title)) audio = "DTS";
  else if (PATTERNS.audio.ddplus.test(title)) audio = "DD+";
  else if (PATTERNS.audio.ac3.test(title)) audio = "AC3";
  else if (PATTERNS.audio.aac.test(title)) audio = "AAC";

  // --- Group ---
  const groupMatch = cleanTitle.match(/[-[\]() ]([A-Za-z0-9]+)$/);
  const group = groupMatch ? groupMatch[1] : "Unknown";

  return {
    resolution,
    source,
    codec,
    hdr,
    audio,
    group,
    isHDR: !!hdr,
    isRemux: source === "REMUX",
    score: calculateQualityScore({ resolution, source, hdr, codec, audio }),
  };
}

function calculateQualityScore({ resolution, source, hdr, codec, audio }) {
  let score = 0;

  // 1. Resolution (Base)
  if (resolution === "2160p") score += 50;
  else if (resolution === "1080p") score += 30;
  else if (resolution === "720p") score += 10;

  // 2. Source (Reliability)
  if (source === "REMUX") score += 60;
  else if (source === "BluRay") score += 40;
  else if (source === "WEB-DL") score += 25;

  // 3. HDR (Visual Fidelity)
  if (hdr === "Dolby Vision") score += 20;
  else if (hdr === "HDR10+") score += 15;
  else if (hdr === "HDR") score += 10;

  // 4. Codec (Efficiency King in 2026)
  if (codec === "AV1") score += 25;
  else if (codec === "x265") score += 10;

  // 5. Audio (Immersive)
  if (audio === "Atmos" || audio === "TrueHD") score += 15;
  else if (audio === "DTS-HD") score += 10;

  return score;
}

module.exports = { parseRelease, calculateQualityScore };
