// Album art for songs that have none. Tries, in order:
//   1. another song from the same album that already has a real cover
//   2. online: MusicBrainz / Cover Art Archive, then Apple (iTunes), then Deezer
//   3. the artist's photo                        } stand-ins, used only when
//   4. identify the song by sound, then online   } allowed; anything still
//   5. (the caller makes a simple cover)         } without art gets a made one
// Network and file access are injected so this can be tested offline.

const { normalizeArtistName, primaryArtist, isPlaceholderArtist } = require('../shared/artist-name');

const EXTRA_WORDS = /\b(deluxe|edition|remaster(ed)?|version|expanded|bonus|explicit|clean|anniversary|special|reissue)\b/;

/** Album or song title reduced for comparing: no accents, punctuation or "(Deluxe Edition)". */
function normTitle(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, (m) => (EXTRA_WORDS.test(m) || /\b(feat|ft)\b/.test(m) ? '' : m))
    .replace(/\s+-\s+(single|ep)$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameTitle(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "Greatest Hits" vs "Greatest Hits Volume One" is too loose; allow only a
  // long shared start (e.g. a subtitle missing on one side)
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length < 8 || !l.startsWith(s + ' ')) return false;
  // ...but "Vol. 2", "Part II" or "2" make it a different album
  return !/^(vol(ume)?|part|pt|disc|cd|chapter|\d|[ivx]+\b)/.test(l.slice(s.length + 1));
}

function sameArtist(a, b) {
  const x = normalizeArtistName(primaryArtist(a)), y = normalizeArtistName(primaryArtist(b));
  return !!x && x === y;
}

const junk = (v, kind) => {
  const s = String(v || '').trim();
  if (!s) return true;
  if (kind === 'artist') return isPlaceholderArtist(s);
  return /^(unknown( album)?|untitled|track \d+)$/i.test(s);
};

/** A real picture: JPEG or PNG and not tiny. */
function isImage(buf) {
  if (!buf || buf.length < 1000) return false;
  return (buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50);
}

/** Apple results → the best cover URL for this album or song (600×600). */
function itunesPick(json, { album, artist, title }) {
  for (const r of json?.results || []) {
    if (!r.artworkUrl100 || !sameArtist(r.artistName, artist)) continue;
    const ok = album ? sameTitle(r.collectionName, album) : sameTitle(r.trackName, title);
    if (ok) return r.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.jpg');
  }
  return null;
}

/** Deezer results → the best cover URL. Deezer's "no cover" placeholder is skipped. */
function deezerPick(json, { album, artist, title }) {
  for (const r of json?.data || []) {
    const cover = r.cover_xl || r.album?.cover_xl;
    if (!cover || /\/cover\/\/|\/images\/cover\/?$/.test(cover) || !sameArtist(r.artist?.name, artist)) continue;
    const ok = album ? sameTitle(r.title, album) : sameTitle(r.title, title);
    if (ok) return cover;
  }
  return null;
}

class CoverFinder {
  /**
   * @param {object} deps
   *   fetchJson(url), fetchBinary(url) → { data }
   *   musicbrainzCover({title, artist, album}) → Buffer|null
   *   readCover(path) → Buffer|null           cover inside another song file
   *   artistPhoto(name) → Buffer|null
   *   identify(path) → { title, artist, album, releaseGroupId }|null
   *   releaseGroupCover(id) → Buffer|null
   *   toJpeg(buf) → Buffer|null               for photos that aren't JPEG/PNG
   */
  constructor(deps) { this.d = deps; }

  async _get(url) {
    const { data } = await this.d.fetchBinary(url);
    return isImage(data) ? data : null;
  }

  async _apple(info) {
    const { artist, album, title } = info;
    if (!junk(album)) {
      const j = await this.d.fetchJson(`https://itunes.apple.com/search?media=music&entity=album&limit=10&term=${encodeURIComponent(`${primaryArtist(artist)} ${album}`)}`);
      const url = itunesPick(j, { artist, album });
      if (url) return this._get(url);
    }
    if (!junk(title)) {
      const j = await this.d.fetchJson(`https://itunes.apple.com/search?media=music&entity=song&limit=10&term=${encodeURIComponent(`${primaryArtist(artist)} ${title}`)}`);
      const url = itunesPick(j, { artist, title });
      if (url) return this._get(url);
    }
    return null;
  }

  async _deezer(info) {
    const { artist, album, title } = info;
    const q = (s) => String(s).replace(/"/g, ' ');
    if (!junk(album)) {
      const j = await this.d.fetchJson(`https://api.deezer.com/search/album?limit=10&q=${encodeURIComponent(`artist:"${q(primaryArtist(artist))}" album:"${q(album)}"`)}`);
      const url = deezerPick(j, { artist, album });
      if (url) return this._get(url);
    }
    if (!junk(title)) {
      const j = await this.d.fetchJson(`https://api.deezer.com/search?limit=10&q=${encodeURIComponent(`artist:"${q(primaryArtist(artist))}" track:"${q(title)}"`)}`);
      const url = deezerPick(j, { artist, title });
      if (url) return this._get(url);
    }
    return null;
  }

  /** Online only. → { image, source } or null */
  async online(info) {
    if (junk(info.artist, 'artist') || (junk(info.album) && junk(info.title))) return null;
    const tries = [
      ['musicbrainz', () => this.d.musicbrainzCover(info)],
      ['apple', () => this._apple(info)],
      ['deezer', () => this._deezer(info)],
    ];
    for (const [source, fn] of tries) {
      try {
        const image = await fn();
        if (isImage(image)) return { image, source };
      } catch { /* that site is down or blocked: try the next */ }
    }
    return null;
  }

  /**
   * @param {object} info     { title, artist, album }
   * @param {object} opts     { path, siblings: paths of same-album songs with a real cover, standIns }
   * @returns {{ image?, source, standIn?, needsMade? } | null}
   */
  async find(info, { path, siblings = [], standIns = false } = {}) {
    for (const p of siblings.slice(0, 3)) {
      try {
        const image = await this.d.readCover(p);
        if (isImage(image)) return { image, source: 'album' };
      } catch { /* unreadable: next */ }
    }
    const found = await this.online(info);
    if (found) return found;
    if (!standIns) return null;

    if (!junk(info.artist, 'artist') && this.d.artistPhoto) {
      try {
        let image = await this.d.artistPhoto(info.artist);
        if (image && !isImage(image) && this.d.toJpeg) image = await this.d.toJpeg(image);
        if (isImage(image)) return { image, source: 'artist', standIn: 'artist' };
      } catch { /* no photo */ }
    }

    // Last resort before a made cover: recognise the song by sound, then look again
    if (path && this.d.identify) {
      try {
        const p = await this.d.identify(path);
        if (p) {
          if (p.releaseGroupId && this.d.releaseGroupCover) {
            const image = await this.d.releaseGroupCover(p.releaseGroupId);
            if (isImage(image)) return { image, source: 'sound', names: p };
          }
          const again = await this.online({ title: p.title, artist: p.artist, album: p.album || '' });
          if (again) return { ...again, source: 'sound', names: p };
        }
      } catch { /* not recognised */ }
    }
    return { needsMade: true, source: 'made' };
  }
}

module.exports = { CoverFinder, normTitle, sameTitle, sameArtist, itunesPick, deezerPick, isImage };
