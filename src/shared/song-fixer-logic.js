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

// ---------------------------------------------------------------------------
// Updating fixed songs on the Zune
// ---------------------------------------------------------------------------

/**
 * Work out what to do on the Zune for each fixed or deleted song.
 * @param pending  [{ path, fileName, before:{title,artist}, removedFromZune, action? }]
 *                 action 'delete' = the file was deleted; take its copy off the Zune
 * @param device   browse items: [{ handle, filename, title, artist, album }]
 * @param current  Map path -> current tags ({ title, artist, album })
 * @param opts.libraryKeys  Set of "title|artist" keys (see tagKey) for songs still
 *                 in the library. A deleted song's Zune copy is kept when another
 *                 copy of it stays on the computer (deleting a duplicate).
 * @returns {{ replace, remove, resend, upToDate, kept, notOnZune, needsRescan }}
 */
function planZuneUpdate(pending, device, current, { libraryKeys = new Set() } = {}) {
  const base = (f) => String(f || '').split(/[/\\]/).pop().toLowerCase();
  const full = (x) => `${norm(x.title)}|${norm(x.artist)}|${norm(x.album)}`;
  const byName = new Map();
  const byTags = new Map();
  const add = (map, k, item) => { if (!map.has(k)) map.set(k, []); map.get(k).push(item); };
  for (const d of device) {
    if (d.filename) add(byName, base(d.filename), d);
    if (d.title) add(byTags, tagKey(d.title, d.artist), d);
  }
  const used = new Set();
  const take = (list) => (list || []).find(d => !used.has(d));
  const findOld = (e) => {
    let old = take(byName.get(base(e.fileName)));
    if (!old && e.before?.title) old = take(byTags.get(tagKey(e.before.title, e.before.artist)));
    if (old) used.add(old);
    return old;
  };

  const plan = { replace: [], remove: [], resend: [], upToDate: [], kept: [], notOnZune: [], needsRescan: [] };
  for (const e of pending) {
    if (e.action === 'delete') {
      if (e.removedFromZune) { plan.upToDate.push(e.path); continue; }
      if (e.before?.title && libraryKeys.has(tagKey(e.before.title, e.before.artist))) { plan.kept.push(e.path); continue; }
      const old = findOld(e);
      if (!old) plan.notOnZune.push(e.path);
      else if (!old.handle) plan.needsRescan.push(e.path);
      else plan.remove.push({ path: e.path, handle: old.handle });
      continue;
    }

    if (e.removedFromZune) { plan.resend.push(e.path); continue; }
    const now = current.get(e.path) || {};
    // The old copy: same file name, or the tags the song had before it was fixed
    const old = findOld(e);
    if (old) {
      if (!old.handle) plan.needsRescan.push(e.path);
      else if (now.title && full(old) === full(now)) plan.upToDate.push(e.path);
      else plan.replace.push({ path: e.path, handle: old.handle });
      continue;
    }
    const fresh = now.title ? take((byTags.get(tagKey(now.title, now.artist)) || []).filter(d => full(d) === full(now))) : null;
    if (fresh) { used.add(fresh); plan.upToDate.push(e.path); continue; }
    plan.notOnZune.push(e.path);
  }
  return plan;
}

function tagKey(title, artist) {
  return `${norm(title)}|${norm(artist)}`;
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/**
 * Group copies of the same song: same title and artist (ignoring case and
 * punctuation) and lengths within a few seconds. Songs without a real title
 * are skipped — there's nothing reliable to compare.
 * @param items [{ id, title, artist, album, duration (seconds), size, hasArt }]
 * @returns [{ title, artist, items, keepId }] with the suggested keeper first
 */
function findDuplicateGroups(items, { toleranceSec = 3 } = {}) {
  const byKey = new Map();
  for (const it of items) {
    const title = clean(it.title);
    if (!title || PLACEHOLDER_RE.test(title) || GUID_RE.test(title)) continue;
    const k = tagKey(title, it.artist);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }

  const albumIsReal = (a) => {
    const v = clean(a);
    return !!v && !PLACEHOLDER_RE.test(v) && !GUID_RE.test(v) && !URL_RE.test(v);
  };
  const rank = (it) => [albumIsReal(it.album) ? 1 : 0, it.hasArt ? 1 : 0, it.size || 0];
  const better = (a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
    return false;
  };

  const groups = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    // Split by length: a 3:30 album version and a 7:00 extended mix aren't duplicates.
    // Songs with unknown length go with the first cluster.
    const known = list.filter(i => i.duration > 0).sort((a, b) => a.duration - b.duration);
    const unknown = list.filter(i => !(i.duration > 0));
    const clusters = [];
    for (const it of known) {
      const last = clusters[clusters.length - 1];
      if (last && it.duration - last[0].duration <= toleranceSec) last.push(it);
      else clusters.push([it]);
    }
    if (clusters.length === 0) clusters.push([]);
    clusters[0].push(...unknown);

    for (const c of clusters) {
      if (c.length < 2) continue;
      let keep = c[0];
      for (const it of c) if (better(it, keep)) keep = it;
      const ordered = [keep, ...c.filter(i => i !== keep)];
      groups.push({ title: clean(keep.title), artist: clean(keep.artist), items: ordered, keepId: keep.id });
    }
  }
  groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

const songFixerLogic = {
  planZuneUpdate,
  findDuplicateGroups,
  tagKey,
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
