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
  else if (title === fileStem(filePath) && (/_/.test(title) || TRACK_NO_RE.test(title))) reasons.push('title is a filename');
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
 * @param opts.linked  Map path -> device handle known to be that song's Zune copy
 * @param opts.libraryKeys  Set of "title|artist" keys (see tagKey) for songs still
 *                 in the library. A deleted song's Zune copy is kept when another
 *                 copy of it stays on the computer (deleting a duplicate).
 * @returns {{ replace, remove, resend, upToDate, kept, notOnZune, needsRescan }}
 */
function planZuneUpdate(pending, device, current, { libraryKeys = new Set(), linked = new Map() } = {}) {
  const base = (f) => String(f || '').split(/[/\\]/).pop().toLowerCase();
  // "Unknown Album" on one side and blank on the other are the same thing
  const val = (v) => (PLACEHOLDER_RE.test(clean(v)) || GUID_RE.test(clean(v)) ? '' : norm(v));
  const full = (x) => `${val(x.title)}|${val(x.artist)}|${val(x.album)}`;
  const byName = new Map();
  const byTags = new Map();
  const add = (map, k, item) => { if (!map.has(k)) map.set(k, []); map.get(k).push(item); };
  for (const d of device) {
    if (d.filename) add(byName, base(d.filename), d);
    if (d.title) add(byTags, tagKey(d.title, d.artist), d);
  }
  const used = new Set();
  const take = (list) => (list || []).find(d => !used.has(d));
  const byHandle = new Map(device.filter(d => d.handle).map(d => [d.handle, d]));
  const findOld = (e) => {
    // A known link (copied from this Zune song, or currently matched to it)
    // beats guessing from names and old tags
    const h = linked.get(e.path);
    let old = h != null && byHandle.has(h) && !used.has(byHandle.get(h)) ? byHandle.get(h) : null;
    if (!old) old = take(byName.get(base(e.fileName)));
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
      // New cover art doesn't change the tags, but the Zune copy still needs replacing
      else if (now.title && full(old) === full(now) && !e.artChanged) plan.upToDate.push(e.path);
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

const COMPILATION_RE = /\b(greatest hits|best of|the best|hits|collection|anthology|now that.?s|what i call music|now \d+|ultimate|essentials?|compilation|various|mixtape|top \d+|party|club|workout|karaoke|ministry of sound|nrj|bravo hits|soundtrack)\b/i;
const OUT_OF_PLACE_RE = /[/\\](downloads|desktop|tmp|temp|\.trash|trash)[/\\]/i;
const COPY_SUFFIX_RE = /( copy( \d+)?| \(\d+\)|[ _-]\d{1,2})$/i;

function kbpsOf(it) {
  return it.size > 0 && it.duration > 0 ? Math.round((it.size * 8) / it.duration / 1000) : 0;
}

/**
 * Score one copy of a song. Higher is better. `good`/`bad` are short reasons
 * shown next to the copy so people can see why one was picked.
 */
function scoreCopy(it, group) {
  const good = [];
  const bad = [];
  let score = 0;
  const album = clean(it.album);
  const realAlbum = !!album && !PLACEHOLDER_RE.test(album) && !GUID_RE.test(album) && !URL_RE.test(album);

  if (suspectReasons(it, it.where || '').length === 0) { score += 4; good.push('clean tags'); }
  else bad.push('messy tags');

  if (realAlbum) {
    const compilation = COMPILATION_RE.test(album) || /various/i.test(clean(it.albumArtist));
    if (compilation) { score += 1; bad.push('compilation'); }
    else { score += 3; good.push('original album'); }
  } else {
    bad.push('no album');
  }

  if (it.where && OUT_OF_PLACE_RE.test(it.where)) { score -= 2; bad.push('in downloads/desktop'); }

  // "Song (1).mp3", "Song copy.mp3", "Song 2.mp3" next to a plain "Song.mp3"
  const stem = String(it.where || '').split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
  if (COPY_SUFFIX_RE.test(stem)) {
    const plain = stem.replace(COPY_SUFFIX_RE, '').toLowerCase();
    const others = group.filter(o => o !== it).map(o => String(o.where || '').split(/[/\\]/).pop().replace(/\.[^.]+$/, '').toLowerCase());
    if (/ copy| \(\d+\)/i.test(stem) || others.includes(plain)) { score -= 3; bad.push('looks like a copy'); }
  }

  if (it.hasArt) { score += 1; good.push('cover art'); }
  if (it.trackNumber > 0) score += 1;
  if (it.year > 0) score += 1;

  const kbps = kbpsOf(it);
  const best = Math.max(...group.map(kbpsOf));
  if (kbps && best) {
    if (kbps >= best * 0.95) { score += 2; good.push(`best quality (${kbps} kbps)`); }
    else if (kbps < best * 0.7) { score -= 1; bad.push(`lower quality (${kbps} kbps)`); }
    else good.push(`${kbps} kbps`);
  }
  return { score, good, bad, kbps };
}

/**
 * Group copies of the same song: same title and artist (ignoring case and
 * punctuation) and lengths within a few seconds. Songs without a real title
 * are skipped — there's nothing reliable to compare.
 *
 * Each group is 'identical' (same album, same size and length — safe to clean
 * up without looking) or 'different' (different album or file — worth a look).
 *
 * @param items [{ id, title, artist, album, albumArtist, duration (s), size,
 *                 hasArt, trackNumber, year, where (path or file name) }]
 * @returns [{ title, artist, kind, items, keepId }] with the keeper first; every
 *          item gets { score, good, bad, kbps }
 */
function isJunkArtist(a) {
  const v = clean(a);
  return !v || PLACEHOLDER_RE.test(v) || GUID_RE.test(v) || URL_RE.test(v);
}

const GUID_ANY_RE = /\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/gi;

/**
 * What song an item really is, for duplicate matching. A copy with no tags
 * may carry its title as "{ID} - Title" or "Title - Artist"; pick the part
 * that's a title other songs actually have.
 */
function dupeIdentity(it, knownTitles) {
  let title = clean(it.title).replace(GUID_ANY_RE, ' ').replace(/\s+/g, ' ').trim();
  let artist = isJunkArtist(it.artist) ? '' : clean(it.artist);
  if (!artist && /\s-\s/.test(title)) {
    const parts = title.split(/\s+-\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length === 1) {
      title = parts[0];
    } else if (parts.length >= 2) {
      const ti = parts.findIndex(x => knownTitles.has(norm(x)));
      const t = ti === -1 ? parts.length - 1 : ti;
      title = parts[t];
      const rest = parts.filter((_, i) => i !== t);
      artist = rest.length === 1 && !isJunkArtist(rest[0]) ? rest[0] : '';
    }
  }
  // A file-name title with a copy number ("Song (2)") is the same song
  if (!clean(it.artist) || isJunkArtist(it.artist) || /\s-\s/.test(clean(it.title))) title = title.replace(/\s\(\d{1,2}\)$/, '');
  title = title.replace(/^[\s\-–]+|[\s\-–]+$/g, '');
  return { title, artist };
}

function findDuplicateGroups(items, { toleranceSec = 3 } = {}) {
  // Titles of properly tagged songs, to read "{ID} - Title - Artist" names
  const knownTitles = new Set();
  for (const it of items) {
    const t = clean(it.title);
    if (t && !isJunkArtist(it.artist) && !/\s-\s/.test(t)) knownTitles.add(norm(t));
  }

  const byTitle = new Map();
  for (const it of items) {
    const id = dupeIdentity(it, knownTitles);
    if (!id.title || PLACEHOLDER_RE.test(id.title) || GUID_RE.test(id.title)) continue;
    const k = norm(id.title);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push({ it, artist: norm(id.artist) });
  }

  const groups = [];
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    // Split by length: a 3:30 album version and a 7:00 extended mix aren't duplicates.
    // Songs with unknown length go with the first cluster.
    const known = list.filter(e => e.it.duration > 0).sort((a, b) => a.it.duration - b.it.duration);
    const unknown = list.filter(e => !(e.it.duration > 0));
    const clusters = [];
    for (const e of known) {
      const last = clusters[clusters.length - 1];
      if (last && e.it.duration - last[0].it.duration <= toleranceSec) last.push(e);
      else clusters.push([e]);
    }
    if (clusters.length === 0) clusters.push([]);
    clusters[0].push(...unknown);

    for (const c of clusters) {
      // Same artist = same song. Copies with no real artist join the one
      // artist this title has; if several artists share the title, it's
      // impossible to say whose song an untagged copy is, so leave it out.
      const byArtist = new Map();
      const noArtist = [];
      for (const e of c) {
        if (!e.artist) noArtist.push(e.it);
        else {
          if (!byArtist.has(e.artist)) byArtist.set(e.artist, []);
          byArtist.get(e.artist).push(e.it);
        }
      }
      let subgroups;
      if (byArtist.size === 0) subgroups = [noArtist];
      else if (byArtist.size === 1) subgroups = [[...byArtist.values()][0].concat(noArtist)];
      else subgroups = [...byArtist.values()];

      for (const sub of subgroups) {
        if (sub.length < 2) continue;
        const scored = sub.map(it => ({ ...it, ...scoreCopy(it, sub) }));
        scored.sort((a, b) =>
          b.score - a.score || b.kbps - a.kbps || (b.size || 0) - (a.size || 0) ||
          String(a.where || '').length - String(b.where || '').length);
        const keep = scored[0];
        const others = scored.slice(1);

        const sameAlbum = scored.every(i => norm(i.album) === norm(keep.album));
        const sameFile = scored.every(i =>
          Math.abs((i.size || 0) - (keep.size || 0)) <= Math.max(keep.size || 0, 1) * 0.02 &&
          Math.abs((i.duration || 0) - (keep.duration || 0)) <= 1.5);
        // The extras only differ by having junk tags, and the keeper is clean
        const messyCopies = !keep.bad.includes('messy tags') &&
          others.every(i => i.bad.includes('messy tags') &&
            (!(i.duration > 0) || !(keep.duration > 0) || Math.abs(i.duration - keep.duration) <= 2));

        groups.push({
          title: dupeIdentity(keep, knownTitles).title || clean(keep.title),
          artist: dupeIdentity(keep, knownTitles).artist || clean(keep.artist),
          kind: sameAlbum && sameFile ? 'identical' : messyCopies ? 'messy' : 'different',
          items: scored,
          keepId: keep.id,
        });
      }
    }
  }
  groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

// ---------------------------------------------------------------------------
// Title search: when the audio isn't recognised, use the words in the title
// ---------------------------------------------------------------------------

const NOISE_RE = /\b(official( music)? video|official audio|music video|lyrics?( video)?|lyric video|audio|video|hq|hd|high quality|\d{2,3} ?kbps|mp3|m4a|wma|free download|download|full song|explicit|clean|radio rip|remaster(ed)?( \d{4})?|youtube)\b/gi;
const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)[ ._-]*(19|20)\d{2}\b/gi;

function words(s) {
  return norm(s).split(' ').filter(Boolean);
}

/**
 * Turn a messy title (or file name) into words worth searching for.
 * "1-11_March_2005-02-DJ_Sammy-Heaven(1-11_remix)" -> "dj sammy heaven remix"
 * @returns {{ text: string, artist: string, parts: string[] }} text '' when nothing usable
 */
function titleSearchTerms(track, filePath) {
  let raw = clean(track.title);
  if (!raw || PLACEHOLDER_RE.test(raw) || GUID_RE.test(raw)) raw = fileStem(filePath);
  let t = raw
    .replace(/\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/gi, ' ')
    .replace(/\[[^\]]*(www\.|\.com|\.net|\.org)[^\]]*\]/gi, ' ')
    .replace(/(https?:\/\/)?(www\.)?[a-z0-9-]+\.(com|net|org|info|biz|ru|co\.uk|me|tv|fm)\b\S*/gi, ' ')
    .replace(/_/g, ' ')
    .replace(MONTH_RE, ' ')
    .replace(/\b(19|20)\d{2}[-.](0?[1-9]|1[0-2])([-.]\d{1,2})?\b/g, ' ')
    .replace(NOISE_RE, ' ');
  // Leading track/disc numbers: "01 ", "1-11 ", "02-", "3. "
  // Only clear track numbers: zero-padded ("03 "), followed by a separator
  // ("3. ", "02-"), or disc-track pairs ("1-11 ") — so "99 Problems" stays.
  t = t.replace(TRACK_NO_RE, ' ');
  // Number pairs like "1-11" left over inside the text
  t = t.replace(/\b\d{1,2}-\d{1,2}\b/g, ' ');

  const parts = t.split(/\s+-\s+|\s*[-–—]\s*(?=[A-Za-z])/).map(x => words(x).join(' ')).filter(Boolean);
  const text = words(t).join(' ');

  const artist = clean(track.artist);
  const realArtist = artist && !PLACEHOLDER_RE.test(artist) && !GUID_RE.test(artist) && !URL_RE.test(artist)
    && !/^unknown artist$/i.test(artist) ? artist : '';
  return { text, artist: realArtist, parts };
}

function luceneWords(s) {
  return words(s).map(w => w.replace(/[^\p{L}\p{N}']/gu, '')).filter(w => w.length > 0).join(' ');
}

/** MusicBrainz recording queries to try, most specific first. */
function titleSearchQueries(terms) {
  const q = [];
  const all = luceneWords(terms.text);
  if (!all) return q;
  if (terms.artist) {
    const a = luceneWords(terms.artist);
    // Title words are whatever isn't the artist's name
    const aw = new Set(words(terms.artist));
    const titleOnly = luceneWords(words(terms.text).filter(w => !aw.has(w)).join(' ')) || all;
    q.push(`recording:(${titleOnly}) AND artist:(${a})`);
  }
  // We don't know which words are the artist and which the title: let both
  // fields match any of them, and let relevance sort it out.
  q.push(`recording:(${all}) AND artist:(${all})`);
  return q;
}

function creditName(credit) {
  return (credit || []).map(c => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim();
}

/**
 * Pick a MusicBrainz recording whose title words all appear in the messy
 * title, whose artist appears in it too (or matches the known artist), and
 * whose length matches. Returns a proposal like pickBestMatch, with
 * source: 'title', or null.
 */
function pickTitleSearchMatch(mbResponse, terms, durationSec, current = {}) {
  const have = new Set(words(terms.text));
  const knownArtist = words(terms.artist);
  const candidates = [];
  for (const rec of mbResponse?.recordings || []) {
    const titleWords = words(rec.title).filter(w => !/^(the|a|an|feat|ft|and)$/.test(w));
    if (!titleWords.length) continue;
    const covered = titleWords.filter(w => have.has(w)).length / titleWords.length;
    if (covered < 1) continue; // every title word must be in what we have

    const artistName = creditName(rec['artist-credit']);
    // Judge by the main artist; featured artists rarely make it into file names
    const credit = rec['artist-credit'] || [];
    const mainArtist = credit[0]?.name || credit[0]?.artist?.name || artistName;
    const aw = words(mainArtist).filter(w => !/^(the|feat|ft|and)$/.test(w));
    const artistOk = knownArtist.length
      ? aw.some(w => knownArtist.includes(w))
      : aw.length > 0 && aw.filter(w => have.has(w)).length / aw.length >= 0.5;
    if (!artistOk) continue;

    const lenSec = rec.length ? rec.length / 1000 : 0;
    if (durationSec && lenSec && Math.abs(lenSec - durationSec) > 8) continue; // a different version
    const lengthMatch = !!(durationSec && lenSec && Math.abs(lenSec - durationSec) <= 3);

    // Prefer candidates that explain more of our words
    const used = new Set([...titleWords, ...aw]);
    const explained = [...have].filter(w => used.has(w)).length / Math.max(have.size, 1);
    const score = Math.min(0.95, ((rec.score || 0) / 100) * 0.5 + explained * 0.3 + (lengthMatch ? 0.2 : 0));
    candidates.push({ rec, score, artistName });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const { rec, score, artistName } = candidates[0];

  // Reshape into the AcoustID form so album choice works the same way
  const groups = new Map();
  for (const rel of rec.releases || []) {
    const rg = rel['release-group'] || {};
    const id = rg.id || rel.id;
    if (!groups.has(id)) {
      groups.set(id, {
        id: rg.id || null, title: rel.title, type: rg['primary-type'] || '',
        secondarytypes: rg['secondary-types'] || [],
        artists: rel['artist-credit'] ? [{ name: creditName(rel['artist-credit']) }] : undefined,
        releases: [],
      });
    }
    const year = rel.date ? parseInt(String(rel.date).slice(0, 4), 10) : null;
    groups.get(id).releases.push({
      date: year ? { year } : undefined,
      mediums: (rel.media || []).map(m => ({
        position: m.position,
        tracks: (m.track || []).map(tr => ({ position: parseInt(tr.number, 10) || null })),
      })),
    });
  }
  const albums = albumOptions({ id: rec.id, artists: [{ name: artistName }], releasegroups: [...groups.values()] }, current.album);
  const top = albums[0] || {};
  return {
    score,
    source: 'title',
    recordingId: rec.id || null,
    title: rec.title,
    artist: artistName,
    album: top.album || null,
    albumArtist: top.albumArtist || artistName || null,
    year: top.year || null,
    trackNumber: top.trackNumber || null,
    discNumber: top.discNumber || null,
    releaseGroupId: top.releaseGroupId || null,
    albums,
  };
}

// ---------------------------------------------------------------------------
// Cleaning up names without looking anything up
// ---------------------------------------------------------------------------

const SITE_RE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9][a-z0-9-]*\.(com|net|org|info|biz|ru|co\.uk|me|tv|fm|us|cc)\b(\/\S*)?)/gi;
const JUNK_PHRASE_RE = /\b(official( music)? video|official audio|official lyrics?|music ?video|lyrics? video|lyric video|with lyrics|lyrics on screen|lyrics in description|top quality|high quality|full song|free download|\d{2,3} ?kbps)\b/gi;

/**
 * Remove junk from one tag value: ID codes, website names and links,
 * "(Official Music Video)"-style noise, underscores, dangling separators.
 * Returns '' when nothing real is left (e.g. an album that was just a site).
 */
function cleanTagText(value) {
  let t = clean(value);
  if (!t) return '';
  t = t
    .replace(GUID_ANY_RE, ' ')
    // a site name split by brackets: "(FULL + NoShout).com"
    .replace(/[([{][^)\]}]*[)\]}]\.(com|net|org|info|biz|ru|me|tv|fm)\b/gi, ' ')
    // brackets that only hold a site or junk: "[www.site.com]", "(Lyrics)"
    .replace(/[([{][^)\]}]*(https?:|www\.|\.(com|net|org|info|biz|ru|me|tv|fm)\b)[^)\]}]*[)\]}]/gi, ' ')
    .replace(SITE_RE, ' ')
    .replace(/_/g, ' ')
    .replace(JUNK_PHRASE_RE, ' ')
    .replace(/\s+amp\s+/gi, ' & ')          // "&amp;" mangled in a file name
    .replace(/\s+(hd|hq)\s*$/i, ' ')
    .replace(/[([{]\s*(hq|hd|lyrics?|audio|video|mp3)?\s*[)\]}]/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    // separators left dangling at either end: "- Song -", "-~-Song-~-"
    .replace(/^[\s\-–—|~:.,]+|[\s\-–—|~:,]+$/g, '')
    .trim();
  // A value that's now wrapped in brackets loses them: "(New Music Studio)"
  const m = t.match(/^[([](.*)[)\]]$/);
  if (m && !/[()[\]]/.test(m[1])) t = m[1].trim();
  return t;
}

// "headhunters" -> "Headhunters" (only when it's all lower case)
function smartCase(s) {
  if (!s || s !== s.toLowerCase() || !/[a-z]/.test(s)) return s;
  return s.replace(/(^|[\s(\-[/])([a-z])/g, (_, pre, c) => pre + c.toUpperCase());
}

const TRACK_NO_RE = /^\s*(?:(?:0\d{1,2}|\d{1,3}-\d{1,3}(?=\s))(?:\s*[-.)]\s*|\s+)|\d{1,3}\s*[.)]\s+|\d{1,3}\s+[-–]\s+)+(?=\D)/;

/**
 * Propose cleaned title / artist / album from a song's messy tags or file
 * name, without any lookup. `knownArtists` (normalised names in the library)
 * lets "Basshunter-Welcome To Rainbow" split even without spaces.
 * @returns {{ title, artist, album }} ('' where nothing usable is left)
 */
function proposeCleanTags(track, filePath, knownArtists = new Set()) {
  const rawTitle = clean(track.title);
  const titleSource = !rawTitle || PLACEHOLDER_RE.test(rawTitle) || GUID_RE.test(rawTitle) ? fileStem(filePath) : rawTitle;
  let title = cleanTagText(titleSource).replace(TRACK_NO_RE, '').trim();
  let artist = isJunkArtist(track.artist) ? '' : cleanTagText(track.artist);

  if (!artist) {
    const parts = title.split(/\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      artist = parts[0];
      title = parts.slice(1).join(' - ');
    } else {
      // "Basshunter-Welcome To Rainbow": split only on an artist we know
      const m = title.match(/^([^-]{2,40})-(.+)$/);
      if (m && knownArtists.has(norm(m[1]))) { artist = m[1].trim(); title = m[2].trim(); }
    }
  }
  let album = cleanTagText(track.album);
  if (PLACEHOLDER_RE.test(album) || GUID_RE.test(album)) album = '';
  if (PLACEHOLDER_RE.test(artist)) artist = '';
  return { title: smartCase(title), artist: smartCase(artist), album };
}

/** A "cleanup" proposal (same shape as a lookup's) from current tags. */
function cleanupProposal(current, filePath, knownArtists) {
  const c = proposeCleanTags(current, filePath, knownArtists);
  const proposal = { source: 'cleanup', score: null, title: c.title || null, artist: c.artist || null, album: c.album || null, albums: [], clear: [] };
  // Fields that held only junk get emptied rather than left as they were
  for (const f of ['artist', 'album']) {
    const had = clean(current[f]);
    if (!c[f] && had && !/^unknown (artist|album)$/i.test(had)) proposal.clear.push(f);
  }
  return proposal;
}

// ---------------------------------------------------------------------------
// Sorting song lists (Zune lists, fixer, songs table)
// ---------------------------------------------------------------------------

const SORT_OPTIONS = [
  ['title', 'title (a–z)'],
  ['artist', 'artist (a–z)'],
  ['album', 'album (a–z)'],
  ['longest', 'longest first'],
  ['shortest', 'shortest first'],
  ['best', 'best quality first'],
  ['worst', 'lowest quality first'],
  ['largest', 'largest file first'],
  ['messy', 'messy first (no album, junk names)'],
];

/** kbps from size (bytes) and duration (seconds); 0 if unknown. */
function kbpsFrom(size, durationSec) {
  return size > 0 && durationSec > 0 ? Math.round((size * 8) / durationSec / 1000) : 0;
}

/**
 * Sort songs. `get(item)` returns { title, artist, album, duration (s),
 * size, path }. Returns a new array; the input is left alone.
 */
function sortSongs(items, key, get) {
  const textCmp = (a, b) => {
    // Empty / placeholder values go last when sorting by name
    const ea = !a || PLACEHOLDER_RE.test(a), eb = !b || PLACEHOLDER_RE.test(b);
    if (ea !== eb) return ea ? 1 : -1;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  };
  const rows = items.map(item => {
    const v = get(item) || {};
    const duration = Number(v.duration) || 0;
    return {
      item,
      title: clean(v.title), artist: clean(v.artist), album: clean(v.album),
      duration, size: Number(v.size) || 0, kbps: kbpsFrom(Number(v.size) || 0, duration),
      messy: key === 'messy' ? suspectReasons({ title: v.title, artist: v.artist, album: v.album }, v.path || '').length : 0,
    };
  });
  const byTitle = (a, b) => textCmp(a.title, b.title);
  const unknownLast = (x, y) => (x ? 0 : 1) - (y ? 0 : 1);
  const cmp = {
    title: byTitle,
    artist: (a, b) => textCmp(a.artist, b.artist) || textCmp(a.album, b.album) || byTitle(a, b),
    album: (a, b) => textCmp(a.album, b.album) || byTitle(a, b),
    longest: (a, b) => unknownLast(a.duration, b.duration) || b.duration - a.duration || byTitle(a, b),
    shortest: (a, b) => unknownLast(a.duration, b.duration) || a.duration - b.duration || byTitle(a, b),
    best: (a, b) => unknownLast(a.kbps, b.kbps) || b.kbps - a.kbps || byTitle(a, b),
    worst: (a, b) => unknownLast(a.kbps, b.kbps) || a.kbps - b.kbps || byTitle(a, b),
    largest: (a, b) => b.size - a.size || byTitle(a, b),
    messy: (a, b) => b.messy - a.messy || byTitle(a, b),
  }[key] || byTitle;
  return rows.sort(cmp).map(r => r.item);
}

/**
 * Differences that mean a song's tags are actually wrong (not just written
 * differently): title, artist or album after ignoring case, accents,
 * punctuation, "feat." credits and placeholders like "Unknown Album".
 * @returns {string[]} the fields that really differ
 */
function meaningfulChanges(current, proposal) {
  const loose = (v, field) => {
    let t = clean(v);
    if (!t || PLACEHOLDER_RE.test(t) || GUID_RE.test(t)) return '';
    if (field === 'artist') t = t.replace(/\s*[([]?\b(feat\.?|ft\.?|featuring|with)\b.*$/i, '');
    if (field === 'title') t = t.replace(/\s*[([](feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/gi, '');
    return norm(t).replace(/\bthe\b/g, '').replace(/\band\b/g, '').replace(/\s+/g, ' ').trim();
  };
  const out = [];
  for (const f of ['title', 'artist', 'album']) {
    const want = loose(proposal[f], f);
    if (!want) continue; // the lookup has nothing to say about this field
    if (loose(current[f], f) !== want) out.push(f);
  }
  return out;
}

const songFixerLogic = {
  meaningfulChanges,
  SORT_OPTIONS,
  sortSongs,
  kbpsFrom,
  cleanTagText,
  proposeCleanTags,
  cleanupProposal,
  titleSearchTerms,
  titleSearchQueries,
  pickTitleSearchMatch,
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
