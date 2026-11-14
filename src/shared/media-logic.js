// Helpers for importing new music and for audio CDs (rip and burn).
// Pure functions, shared by the main process and the page (and tests).

const AUDIO_IMPORT_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wma', '.ogg', '.wav', '.aiff', '.aif', '.opus']);

/** Is this a finished audio file worth offering for import (not a partial download)? */
function isImportableAudio(name) {
  const n = String(name || '');
  if (!n || n.startsWith('.')) return false;
  if (/\.(part|crdownload|download|tmp)$/i.test(n)) return false;
  const m = n.match(/(\.[^.]+)$/);
  return !!m && AUDIO_IMPORT_EXTS.has(m[1].toLowerCase());
}

/** Safe for a file or folder name on Mac, Windows and Linux. */
function safeName(s, fallback = 'Unknown') {
  let t = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  t = t.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!t) t = fallback;
  return t.length > 120 ? t.slice(0, 120).trim() : t;
}

/**
 * Where a song goes inside the music folder: Artist / Album / "01 Title.ext".
 * The album artist is used for the folder when there is one (compilations
 * stay together).
 * @returns {string[]} path parts, to be joined with the music folder
 */
function organizedParts({ artist, albumArtist, album, title, trackNumber, discNumber } = {}, ext = '.mp3') {
  const folderArtist = safeName(albumArtist || artist, 'Unknown Artist');
  const folderAlbum = safeName(album, 'Unknown Album');
  const n = Number(trackNumber) || 0;
  const d = Number(discNumber) || 0;
  const num = n ? `${d > 1 ? d + '-' : ''}${String(n).padStart(2, '0')} ` : '';
  const file = `${num}${safeName(title, 'Untitled')}${String(ext || '.mp3').toLowerCase()}`;
  return [folderArtist, folderAlbum, file];
}

// ---------------------------------------------------------------------------
// Audio CDs
// ---------------------------------------------------------------------------

/**
 * The table of contents of an audio CD, from macOS's ".TOC.plist" (already
 * converted to JSON). Offsets are in CD frames and include the 150-frame
 * lead-in, as MusicBrainz expects.
 * @returns {{ first, last, offsets: number[], leadout: number } | null}
 */
function parseMacToc(toc) {
  const sessions = toc && toc.Sessions;
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const s0 = sessions[0];
  const tracks = (s0['Track Array'] || [])
    .filter(t => Number.isInteger(t.Point) && t.Point >= 1 && t.Point <= 99 && t['Data'] !== true)
    .sort((a, b) => a.Point - b.Point);
  if (!tracks.length) return null;
  const first = tracks[0].Point;
  const last = tracks[tracks.length - 1].Point;
  let leadout = Number(s0['Leadout Block']);
  // Enhanced CD (a data session after the music): the audio part ends
  // 11400 frames before the data session starts
  if (sessions.length > 1) {
    const dataStart = (sessions[1]['Track Array'] || [])
      .map(t => Number(t['Start Block'])).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (Number.isFinite(dataStart)) leadout = dataStart - 11400;
  }
  if (!Number.isFinite(leadout)) return null;
  return {
    first,
    last,
    offsets: tracks.map(t => Number(t['Start Block']) + 150),
    leadout: leadout + 150,
  };
}

/**
 * The text MusicBrainz hashes (SHA-1) to get a disc ID; see discIdFromHash.
 */
function discIdSource({ first, last, offsets, leadout }) {
  const hex = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
  let s = hex(first, 2) + hex(last, 2) + hex(leadout, 8);
  for (let i = 1; i <= 99; i++) {
    const idx = i - first;
    s += hex(i >= first && i <= last ? offsets[idx] : 0, 8);
  }
  return s;
}

/** MusicBrainz disc ID from the base64 of the SHA-1 of discIdSource(). */
function discIdFromHash(base64) {
  return String(base64).replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-');
}

/** "1 12 245000 150 18000 ..." for MusicBrainz's fuzzy lookup by TOC. */
function tocParam({ first, last, offsets, leadout }) {
  return [first, last, leadout, ...offsets].join('+');
}

/** Length of each track in seconds, from the TOC. */
function trackSeconds({ offsets, leadout }) {
  return offsets.map((o, i) => ((i + 1 < offsets.length ? offsets[i + 1] : leadout) - o) / 75);
}

/**
 * Albums a disc could be, from MusicBrainz's discid lookup response. Only
 * the disc (medium) that matches this CD is used, and only ones with the
 * same number of tracks.
 * @returns [{ releaseId, releaseGroupId, album, artist, year, disc, discs, tracks: [{ n, title, artist }] }]
 */
function discCandidates(response, discId, trackCount) {
  const out = [];
  const credit = (ac) => (ac || []).map(a => a.name + (a.joinphrase || '')).join('').trim();
  for (const rel of (response && response.releases) || []) {
    const media = rel.media || [];
    let medium = media.find(m => (m.discs || []).some(d => d.id === discId));
    if (!medium) medium = media.find(m => (m['track-count'] || (m.tracks || []).length) === trackCount);
    if (!medium || (medium.tracks || []).length !== trackCount) continue;
    out.push({
      releaseId: rel.id,
      releaseGroupId: rel['release-group'] && rel['release-group'].id,
      album: rel.title || '',
      artist: credit(rel['artist-credit']),
      year: rel.date ? parseInt(rel.date.slice(0, 4), 10) || '' : '',
      country: rel.country || '',
      disc: medium.position || 1,
      discs: media.length || 1,
      exact: (medium.discs || []).some(d => d.id === discId),
      tracks: medium.tracks.map((t, i) => ({
        n: t.position || i + 1,
        title: (t.recording && t.recording.title) || t.title || `Track ${i + 1}`,
        artist: credit(t['artist-credit'] || (t.recording && t.recording['artist-credit'])) || credit(rel['artist-credit']),
      })),
    });
  }
  // Exact disc matches first, then the oldest release (usually the original)
  return out.sort((a, b) => (b.exact - a.exact) || ((a.year || 9999) - (b.year || 9999)));
}

// An audio CD holds 80 minutes; drives need a little room
const CD_MAX_SECONDS = 79 * 60 + 30;

/** Does this list of songs fit on an audio CD (with 2-second gaps)? */
function cdFits(durations, gap = 2) {
  const total = durations.reduce((s, d) => s + (Number(d) || 0), 0) + Math.max(0, durations.length - 1) * gap;
  return { total, fits: total <= CD_MAX_SECONDS && durations.length <= 99, max: CD_MAX_SECONDS, tooMany: durations.length > 99 };
}

const mediaLogic = {
  isImportableAudio, safeName, organizedParts,
  parseMacToc, discIdSource, discIdFromHash, tocParam, trackSeconds, discCandidates, cdFits, CD_MAX_SECONDS,
};
if (typeof module !== 'undefined' && module.exports) module.exports = mediaLogic;
if (typeof window !== 'undefined') window.mediaLogic = mediaLogic;
