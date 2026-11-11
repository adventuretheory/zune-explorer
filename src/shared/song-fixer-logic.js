// Song fixer: decide which songs have bad tags, and turn an AcoustID lookup
// into proposed tags. Pure functions — shared by the main process and renderer.

const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const URL_RE = /(https?:\/\/|www\.|\.(com|net|org|info|biz|ru|co\.uk)\b)/i;
const PLACEHOLDER_RE = /^(unknown( artist| album| title)?|untitled|no name|various|n\/a|none|track ?\d*|audio ?track ?\d*|\d+)$/i;

function clean(v) {
  return v == null ? '' : String(v).trim();
}

function fileStem(filePath) {
  const base = String(filePath || '').split(/[/\\]/).pop();
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Why a track's tags look wrong. Returns [] when they look fine.
 * `track` has title / artist / album as the library shows them.
 */
function suspectReasons(track, filePath) {
  const reasons = [];
  const title = clean(track.title);
  const artist = clean(track.artist);
  const album = clean(track.album);

  const isJunk = (v) => !v || PLACEHOLDER_RE.test(v) || GUID_RE.test(v);

  if (isJunk(title)) reasons.push('no title');
  else if (title === fileStem(filePath) && /[_]|^\d+[\s._-]/.test(title)) reasons.push('title is a filename');
  else if (/_/.test(title) && !/\s/.test(title)) reasons.push('title is a filename');

  if (isJunk(artist)) reasons.push('no artist');
  if (isJunk(album)) reasons.push('no album');

  for (const [field, v] of [['title', title], ['artist', artist], ['album', album]]) {
    if (v && URL_RE.test(v)) reasons.push(`website in ${field}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// AcoustID response → proposal
// ---------------------------------------------------------------------------

function joinArtists(artists) {
  if (!Array.isArray(artists) || artists.length === 0) return '';
  return artists.map((a, i) => a.name + (i < artists.length - 1 ? (a.joinphrase || ', ') : '')).join('').trim();
}

function norm(s) {
  return clean(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Lower is better: studio albums first, compilations and live albums last.
function releaseGroupRank(rg) {
  const type = (rg.type || '').toLowerCase();
  const secondary = (rg.secondarytypes || []).map(t => String(t).toLowerCase());
  if (type === 'album' && secondary.length === 0) return 0;
  if (type === 'ep' && secondary.length === 0) return 1;
  if (type === 'single' && secondary.length === 0) return 2;
  if (secondary.includes('compilation') && !secondary.includes('live')) return 3;
  if (!type) return 4;
  return 5;
}

function releaseYear(release) {
  const y = release?.date?.year;
  return Number.isFinite(y) && y > 0 ? y : null;
}

/**
 * Track number of the recording on a release. AcoustID only lists, under each
 * release, the track(s) where this recording appears, so the first one is it.
 */
function trackNumberOn(release) {
  for (const medium of release?.mediums || []) {
    const t = (medium.tracks || [])[0];
    if (t && t.position) return { trackNumber: t.position, discNumber: medium.position || null };
  }
  return { trackNumber: null, discNumber: null };
}

/** Albums a recording appears on, best first. */
function albumOptions(recording, currentAlbum) {
  const groups = [];
  const seen = new Set();
  const push = (rg, releases) => {
    if (!rg || !rg.title || seen.has(rg.id || rg.title)) return;
    seen.add(rg.id || rg.title);
    const rels = releases || rg.releases || [];
    const years = rels.map(releaseYear).filter(Boolean);
    // Earliest release that tells us the track number
    const sorted = [...rels].sort((a, b) => (releaseYear(a) || 9999) - (releaseYear(b) || 9999));
    let pos = { trackNumber: null, discNumber: null };
    for (const r of sorted) {
      pos = trackNumberOn(r);
      if (pos.trackNumber) break;
    }
    groups.push({
      album: rg.title,
      albumArtist: joinArtists(rg.artists) || joinArtists(recording.artists),
      year: years.length ? Math.min(...years) : null,
      type: [rg.type, ...(rg.secondarytypes || [])].filter(Boolean).join(' / ').toLowerCase(),
      releaseGroupId: rg.id || null,
      trackNumber: pos.trackNumber,
      discNumber: pos.discNumber,
      _rank: releaseGroupRank(rg),
    });
  };

  for (const rg of recording.releasegroups || []) push(rg, rg.releases);
  // Some responses list releases without grouping them
  for (const r of recording.releases || []) {
    push({ id: r.releasegroup?.id || r.id, title: r.title, type: r.releasegroup?.type, secondarytypes: r.releasegroup?.secondarytypes, artists: r.artists }, [r]);
  }

  const cur = norm(currentAlbum);
  groups.sort((a, b) =>
    (norm(b.album) === cur) - (norm(a.album) === cur) ||
    a._rank - b._rank ||
    (a.year || 9999) - (b.year || 9999));
  return groups.map(({ _rank, ...g }) => g);
}

/**
 * Pick the most likely recording from an AcoustID lookup.
 * @param response parsed JSON from /v2/lookup
 * @param current  the file's current tags (used only to break ties)
 * @returns proposal or null when nothing confident was found
 */
function pickBestMatch(response, current = {}, { minScore = 0.6 } = {}) {
  const results = (response?.results || [])
    .filter(r => (r.score || 0) >= minScore && Array.isArray(r.recordings) && r.recordings.some(rec => rec.title))
    .sort((a, b) => b.score - a.score);
  if (results.length === 0) return null;

  const best = results[0];
  const curTitle = norm(current.title);
  const curArtist = norm(current.artist);
  const recordings = best.recordings.filter(rec => rec.title);

  // Prefer a recording that agrees with what the file already says; otherwise
  // the one released on the most albums (usually the canonical version).
  recordings.sort((a, b) => {
    const agree = (r) => (norm(r.title) === curTitle ? 2 : 0) + (norm(joinArtists(r.artists)) === curArtist ? 1 : 0);
    return agree(b) - agree(a) ||
      ((b.releasegroups || b.releases || []).length - (a.releasegroups || a.releases || []).length);
  });
  const rec = recordings[0];
  const albums = albumOptions(rec, current.album);
  const top = albums[0] || {};

  return {
    score: best.score,
    acoustId: best.id,
    recordingId: rec.id || null,
    title: rec.title,
    artist: joinArtists(rec.artists),
    album: top.album || null,
    albumArtist: top.albumArtist || joinArtists(rec.artists) || null,
    year: top.year || null,
    trackNumber: top.trackNumber || null,
    discNumber: top.discNumber || null,
    releaseGroupId: top.releaseGroupId || null,
    albums,
  };
}

/** Fields that would actually change, as [{ field, from, to }]. */
function proposedChanges(current, proposal) {
  const fields = ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber'];
  const changes = [];
  for (const f of fields) {
    const to = proposal[f];
    if (to == null || to === '') continue;
    const from = current[f];
    if (String(from ?? '') !== String(to)) changes.push({ field: f, from: from ?? '', to });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Writing tags
// ---------------------------------------------------------------------------

const WRITABLE_EXTENSIONS = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.ogg', '.wma']);

const FFMPEG_TAG_NAMES = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album_artist',
  year: 'date',
  trackNumber: 'track',
  discNumber: 'disc',
};

/**
 * ffmpeg arguments to rewrite tags without re-encoding the audio.
 * Existing tags and cover art are kept unless overridden.
 */
function buildTagArgs(input, output, tags, { coverPath = null, ext = '.mp3' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', input];
  const replaceCover = !!coverPath && (ext === '.mp3' || ext === '.m4a' || ext === '.mp4' || ext === '.flac');
  if (replaceCover) args.push('-i', coverPath);

  args.push('-map', '0:a');
  if (replaceCover) args.push('-map', '1:0');
  else args.push('-map', '0:v?');
  args.push('-map_metadata', '0', '-c', 'copy');

  if (replaceCover) args.push('-disposition:v:0', 'attached_pic');

  for (const [key, ffName] of Object.entries(FFMPEG_TAG_NAMES)) {
    if (!(key in tags)) continue;
    const v = tags[key] == null ? '' : String(tags[key]);
    // WMA readers (and the Zune) look for WM/Year rather than ffmpeg's "date"
    const name = ext === '.wma' && key === 'year' ? 'WM/Year' : ffName;
    args.push('-metadata', `${name}=${v}`);
    // Ogg keeps its tags on the audio stream, which would otherwise win
    if (ext === '.ogg') args.push('-metadata:s:a:0', `${name}=${v}`);
  }
  if (ext === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
  args.push('-y', output);
  return args;
}

const songFixerLogic = {
  suspectReasons,
  pickBestMatch,
  albumOptions,
  proposedChanges,
  buildTagArgs,
  joinArtists,
  WRITABLE_EXTENSIONS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = songFixerLogic;
}
if (typeof window !== 'undefined') {
  window.songFixerLogic = songFixerLogic;
}
