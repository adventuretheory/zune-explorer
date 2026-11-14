// Song fixer (main process): recognise songs by their audio with AcoustID and
// rewrite their tags. Audio is never re-encoded — only the tags change — and
// every change is recorded so the last batch can be undone.

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const logic = require('../shared/song-fixer-logic.js');

const execFileAsync = promisify(execFile);

const FINGERPRINT_SECONDS = 120; // same as fpcalc's default
const SAMPLE_RATE = 44100;
const CHANNELS = 2;

class SongFixer {
  /**
   * @param {object} opts
   * @param {string} opts.ffmpegPath
   * @param {string} opts.dataDir   where undo records are kept
   * @param {(url:string)=>Promise<{data:Buffer, contentType:string}>} [opts.fetchBinary]
   */
  constructor({ ffmpegPath, dataDir, fetchBinary, trashItem, searchRecordings }) {
    this.ffmpegPath = ffmpegPath;
    this.trashItem = trashItem; // moves a file to the system Trash (Electron shell.trashItem)
    this.searchRecordings = searchRecordings; // MusicBrainz recording search, for title fallback
    this.undoDir = path.join(dataDir, 'song-fixer');
    this.fetchBinary = fetchBinary;
    this._chromaprint = null;
    this._lastLookup = 0;
    this._batches = new Map(); // batchId -> [{ path, before, addedCover }]
  }

  // ---- Fingerprinting -------------------------------------------------------

  async _loadChromaprint() {
    if (this._chromaprint) return this._chromaprint;
    const dist = path.join(path.dirname(require.resolve('@unimusic/chromaprint/package.json')), 'dist');
    const wasmBinary = await fs.readFile(path.join(dist, 'chromaprint.wasm'));
    // The module is built for browsers and checks for `window` while it starts.
    const hadWindow = 'window' in globalThis;
    if (!hadWindow) globalThis.window = globalThis;
    try {
      const { default: create } = await import(pathToFileURL(path.join(dist, 'chromaprint.js')).href);
      this._chromaprint = await create({ wasmBinary });
    } finally {
      if (!hadWindow) delete globalThis.window;
    }
    return this._chromaprint;
  }

  /** Decode up to 2 minutes of audio to 16-bit PCM with ffmpeg. */
  _decodePcm(filePath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-i', filePath,
        '-t', String(FINGERPRINT_SECONDS),
        '-vn', '-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-',
      ]);
      const chunks = [];
      let stderr = '';
      proc.stdout.on('data', (c) => chunks.push(c));
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.on('error', reject);
      proc.on('close', (code) => {
        const pcm = Buffer.concat(chunks);
        if (pcm.length === 0) reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`));
        else resolve(pcm);
      });
    });
  }

  async fingerprint(filePath) {
    const M = await this._loadChromaprint();
    const pcm = await this._decodePcm(filePath);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));

    const ctx = M._chromaprint_new(1);
    if (!ctx) throw new Error('Could not start fingerprinting');
    const CHUNK = SAMPLE_RATE * CHANNELS; // 1 second at a time
    const buf = M._malloc(CHUNK * 2);
    try {
      if (!M._chromaprint_start(ctx, SAMPLE_RATE, CHANNELS)) throw new Error('Could not start fingerprinting');
      for (let i = 0; i < samples.length; i += CHUNK) {
        const part = samples.subarray(i, Math.min(i + CHUNK, samples.length));
        M.HEAP16.set(part, buf / 2);
        if (!M._chromaprint_feed(ctx, buf, part.length)) throw new Error('Fingerprinting failed');
      }
      if (!M._chromaprint_finish(ctx)) throw new Error('Fingerprinting failed');
      const out = M._malloc(4);
      try {
        if (!M._chromaprint_get_fingerprint(ctx, out)) throw new Error('Fingerprinting failed');
        const strPtr = M.HEAP32[out / 4];
        const fp = M.UTF8ToString(strPtr);
        M._free(strPtr);
        return fp;
      } finally {
        M._free(out);
      }
    } finally {
      M._free(buf);
      M._chromaprint_free(ctx);
    }
  }

  // ---- Lookup ---------------------------------------------------------------

  async _acoustidLookup(apiKey, fingerprint, duration) {
    // AcoustID allows 3 requests per second
    const wait = Math.max(0, 350 - (Date.now() - this._lastLookup));
    if (wait) await new Promise(r => setTimeout(r, wait));
    this._lastLookup = Date.now();

    const body = new URLSearchParams({
      client: apiKey,
      format: 'json',
      duration: String(Math.max(1, Math.round(Number(duration) || 0))),
      fingerprint,
      meta: 'recordings releasegroups releases tracks compress',
    }).toString();

    const json = await new Promise((resolve, reject) => {
      const req = https.request('https://api.acoustid.org/v2/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'ZuneExplorer (https://github.com/NiceBeard/zune-explorer)',
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(`AcoustID returned HTTP ${res.statusCode}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('AcoustID did not respond')));
      req.end(body);
    });

    if (json.status !== 'ok') {
      const msg = json.error?.message || 'lookup failed';
      const err = new Error(/invalid api key/i.test(msg) ? 'AcoustID key not accepted — check it in settings' : `AcoustID: ${msg}`);
      err.code = json.error?.code;
      throw err;
    }
    return json;
  }

  async readTags(filePath) {
    const { parseFile } = await import('music-metadata');
    const md = await parseFile(filePath, { duration: true });
    const c = md.common;
    return {
      title: c.title || '',
      artist: c.artist || '',
      album: c.album || '',
      albumArtist: c.albumartist || '',
      year: c.year || '',
      trackNumber: c.track?.no || '',
      discNumber: c.disk?.no || '',
      hasCover: !!(c.picture && c.picture.length),
      duration: md.format.duration || 0,
    };
  }

  /**
   * Recognise one file. Resolves to { current, proposal } where proposal is
   * null if AcoustID didn't recognise the song.
   */
  async identify(filePath, apiKey, libraryTrack = {}) {
    let current;
    try {
      current = await this.readTags(filePath);
    } catch {
      current = { title: '', artist: '', album: '', duration: 0 };
    }

    // Some files have no usable length in their header (or a bogus one);
    // AcoustID needs a real one, so measure it from the audio itself.
    if (!(Number.isFinite(current.duration) && current.duration >= 1)) {
      current.duration = await this.measureDuration(filePath);
    }

    // 1. Listen to the audio (needs an AcoustID key and a readable length).
    // A "hint" search uses the person's own typed title and skips this.
    let soundError = null;
    if (apiKey && current.duration >= 1 && !libraryTrack.hint) {
      try {
        const fp = await this.fingerprint(filePath);
        const response = await this._acoustidLookup(apiKey, fp, current.duration);
        const proposal = logic.pickBestMatch(response, current);
        if (proposal) return { current, proposal: { ...proposal, source: 'sound' } };
      } catch (err) {
        // A rejected key affects every song; report it rather than hide it
        if (/key/i.test(err.message)) throw err;
        soundError = err;
      }
    }

    // 2. Fall back to the words in the title (or file name)
    const proposal = await this._identifyByTitle(filePath, current, libraryTrack);
    if (proposal) return { current, proposal };
    // Neither worked. A failed sound check isn't an error for the person:
    // the song just wasn't recognised; say why as a note.
    return {
      current, proposal: null,
      triedSound: !!(apiKey && current.duration >= 1),
      note: soundError ? `couldn\u2019t check the sound (${soundError.message.replace(/^AcoustID:\s*/, '')})` : null,
    };
  }

  /**
   * Song length in seconds, worked out by ffmpeg: first from the container
   * ("Duration: 00:03:21.45"), else by reading through the audio. 0 if unknown.
   */
  async measureDuration(filePath) {
    const run = (args) => new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, args);
      let err = '';
      proc.stderr.on('data', (c) => { err += c; if (err.length > 200000) err = err.slice(-100000); });
      proc.on('error', () => resolve(''));
      proc.on('close', () => resolve(err));
    });
    const toSec = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);
    let out = await run(['-hide_banner', '-i', filePath]);
    let m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m && toSec(m[1], m[2], m[3]) >= 1) return toSec(m[1], m[2], m[3]);
    // No usable header: decode it (fast, no output) and take the last position
    out = await run(['-hide_banner', '-nostats', '-progress', 'pipe:2', '-i', filePath, '-vn', '-f', 'null', '-']);
    const times = [...out.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (times.length) {
      const t = times[times.length - 1];
      const sec = toSec(t[1], t[2], t[3]);
      if (sec >= 1) return sec;
    }
    return 0;
  }

  async _identifyByTitle(filePath, current, libraryTrack) {
    if (!this.searchRecordings) return null;
    // Prefer what the file says; the library's view fills gaps. Text the
    // person typed in ("hint") wins over both.
    const track = libraryTrack.hint ? {
      title: libraryTrack.title || '',
      artist: libraryTrack.artist || '',
      album: libraryTrack.album || '',
    } : {
      title: current.title || libraryTrack.title || '',
      artist: current.artist || libraryTrack.artist || '',
      album: current.album || libraryTrack.album || '',
    };
    const terms = logic.titleSearchTerms(track, filePath);
    for (const query of logic.titleSearchQueries(terms)) {
      let response;
      try { response = await this.searchRecordings(query); } catch { continue; }
      const proposal = logic.pickTitleSearchMatch(response, terms, current.duration || libraryTrack.duration || 0, current);
      if (proposal) return proposal;
    }
    return null;
  }

  // ---- Writing --------------------------------------------------------------

  async _fetchCover(releaseGroupId) {
    if (!releaseGroupId || !this.fetchBinary) return null;
    try {
      const { data, contentType } = await this.fetchBinary(`https://coverartarchive.org/release-group/${releaseGroupId}/front-500`);
      if (!data || data.length < 1000 || !/image\/(jpeg|png)/.test(contentType || '')) return null;
      return { data, ext: /png/.test(contentType) ? '.png' : '.jpg' };
    } catch {
      return null;
    }
  }

  /**
   * Rewrite tags via a temp file next to the original, check the result, then
   * swap it in. The original is untouched if anything goes wrong.
   */
  /**
   * Rewrite tags via a temp file next to the original, check the result, then
   * swap it in. The original is untouched if anything goes wrong.
   *
   * If the first attempt fails it tries the next sensible thing:
   * - an ".mp3" that actually holds other audio (often AAC from a download)
   *   can't take MP3 tags as-is, so its audio is converted to MP3 (320 kbps);
   * - if the cover image is the problem, the tags are saved without it.
   * @returns {{ transcoded: boolean, coverSkipped: boolean }}
   */
  async _rewrite(filePath, tags, { coverPath = null, dropCover = false } = {}) {
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);
    const before = await fs.stat(filePath);
    const { parseFile } = await import('music-metadata');
    const sameLength = async (temp) => {
      const [a, b] = await Promise.all([parseFile(filePath, { duration: true }), parseFile(temp, { duration: true })]);
      const da = a.format.duration || 0, db = b.format.duration || 0;
      if (!db || (da && Math.abs(da - db) > 1)) throw new Error('rewritten file is a different length');
    };
    const MP3_MISMATCH = /exactly one mp3 audio stream|invalid audio stream|not currently supported in container|could not find tag for codec|codec .* not supported/i;

    let plan = { cover: coverPath, transcode: false };
    let lastReason = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const temp = path.join(dir, `.${path.basename(filePath, ext)}.zunefix-${Date.now()}-${attempt}${ext}`);
      const args = logic.buildTagArgs(filePath, temp, tags, { coverPath: plan.cover, ext });
      if (dropCover) {
        // Remove the "-map 0:v?" pair so only audio is kept
        const i = args.indexOf('0:v?');
        if (i > 0) args.splice(i - 1, 2);
      }
      if (plan.transcode) args.splice(args.length - 2, 0, '-c:a', 'libmp3lame', '-b:a', '320k');
      try {
        await execFileAsync(this.ffmpegPath, args, { maxBuffer: 1 << 24 });
        if (dropCover || plan.transcode) {
          // Size changes when a cover is removed or audio converted: compare lengths
          await sameLength(temp);
        } else {
          // The audio is copied as-is, so the new file should be about the same
          // size; if it shrank (e.g. bulky junk tags were dropped), the audio
          // must at least be just as long
          const after = await fs.stat(temp);
          if (after.size < before.size * 0.9) await sameLength(temp);
          else await parseFile(temp, { duration: false });
        }
        await fs.rename(temp, filePath);
        return { transcoded: plan.transcode, coverSkipped: !!coverPath && !plan.cover };
      } catch (err) {
        await fs.unlink(temp).catch(() => {});
        // ffmpeg's own explanation is on stderr; keep its last meaningful line
        const stderr = String(err.stderr || '').trim().split('\n').filter(Boolean);
        lastReason = stderr.length ? stderr[stderr.length - 1] : String(err.message).split('\n')[0];
        const all = `${err.stderr || ''} ${err.message || ''}`;
        if (ext === '.mp3' && !plan.transcode && MP3_MISMATCH.test(all)) plan = { ...plan, transcode: true };
        else if (plan.cover) plan = { ...plan, cover: null };
        else break;
      }
    }
    throw new Error(`Could not update tags: ${lastReason}`);
  }

  /**
   * Apply new tags to one file as part of a batch (for undo).
   * @param {object} tags  subset of title/artist/album/albumArtist/year/trackNumber/discNumber
   * @param {object} opts  { releaseGroupId, addCover }
   */
  async apply(batchId, filePath, tags, { releaseGroupId = null, addCover = true } = {}) {
    const ext = path.extname(filePath).toLowerCase();
    if (!logic.WRITABLE_EXTENSIONS.has(ext)) throw new Error(`Can't write tags to ${ext} files`);

    const current = await this.readTags(filePath);
    const before = {};
    for (const k of Object.keys(tags)) before[k] = current[k] ?? '';

    let coverPath = null;
    let addedCover = false;
    if (addCover && !current.hasCover && releaseGroupId) {
      const cover = await this._fetchCover(releaseGroupId);
      if (cover) {
        coverPath = path.join(require('os').tmpdir(), `zunefix-cover-${Date.now()}${cover.ext}`);
        await fs.writeFile(coverPath, cover.data);
      }
    }

    let outcome = {};
    try {
      outcome = await this._rewrite(filePath, tags, { coverPath });
      addedCover = !!coverPath && !outcome.coverSkipped;
    } finally {
      if (coverPath) await fs.unlink(coverPath).catch(() => {});
    }

    await this._record(batchId, { path: filePath, before, addedCover });
    await this._addPending(filePath, current);
    return { addedCover, transcoded: !!outcome.transcoded, coverSkipped: !!outcome.coverSkipped };
  }

  // ---- Songs fixed here but not yet updated on the Zune ---------------------

  _pendingFile() { return path.join(this.undoDir, 'zune-pending.json'); }

  async _readPending() {
    try {
      return JSON.parse(await fs.readFile(this._pendingFile(), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') return [];
    }
    // First use: songs fixed before this list existed are in the undo records
    const list = [];
    let names = [];
    try { names = await fs.readdir(this.undoDir); } catch { /* nothing fixed yet */ }
    const batches = names.filter(n => /^\d+\.json$/.test(n)).sort((x, y) => Number(x.slice(0, -5)) - Number(y.slice(0, -5)));
    for (const name of batches) {
      let entries = [];
      try { entries = JSON.parse(await fs.readFile(path.join(this.undoDir, name), 'utf8')); } catch { continue; }
      for (const e of entries) {
        if (!e?.path || list.some(x => x.path === e.path)) continue;
        list.push({
          path: e.path,
          fileName: path.basename(e.path),
          before: { title: e.before?.title || '', artist: e.before?.artist || '', album: e.before?.album || '' },
          removedFromZune: false,
        });
      }
    }
    if (list.length) await this._writePending(list);
    return list;
  }

  async _writePending(list) {
    await fs.mkdir(this.undoDir, { recursive: true });
    await fs.writeFile(this._pendingFile(), JSON.stringify(list, null, 1));
  }

  async _addPending(filePath, oldTags, { artChanged = false } = {}) {
    const list = await this._readPending();
    // Keep the oldest tags: that's the version the Zune still has
    const existing = list.find(e => e.path === filePath);
    if (!existing) {
      list.push({
        path: filePath,
        fileName: path.basename(filePath),
        before: { title: oldTags.title || '', artist: oldTags.artist || '', album: oldTags.album || '' },
        removedFromZune: false,
        ...(artChanged ? { artChanged: true } : {}),
      });
      await this._writePending(list);
    } else if (artChanged && !existing.artChanged) {
      existing.artChanged = true;
      await this._writePending(list);
    }
  }

  /**
   * Embed cover art in a song (MP3, M4A or FLAC). Recorded in the batch so
   * "undo last fix" removes it again, and queued for "update zune".
   * @param {Buffer} image  JPEG or PNG bytes
   * @returns {{ added: boolean, skipped?: string }}
   */
  async addCover(batchId, filePath, image, { replace = false } = {}) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.mp3', '.m4a', '.mp4', '.flac'].includes(ext)) {
      throw new Error(`album art can't be added to ${ext.replace('.', '').toUpperCase()} files`);
    }
    const current = await this.readTags(filePath);
    if (current.hasCover && !replace) return { added: false, skipped: 'already has album art' };
    const isPng = image[0] === 0x89 && image[1] === 0x50;
    const coverPath = path.join(require('os').tmpdir(), `zunefix-cover-${Date.now()}${isPng ? '.png' : '.jpg'}`);
    await fs.writeFile(coverPath, image);
    let outcome = {};
    try {
      outcome = await this._rewrite(filePath, {}, { coverPath });
    } finally {
      await fs.unlink(coverPath).catch(() => {});
    }
    if (outcome.coverSkipped) throw new Error('this image couldn\u2019t be added to the file');
    await this._record(batchId, { path: filePath, before: {}, addedCover: !current.hasCover });
    await this._addPending(filePath, current, { artChanged: true });
    return { added: true };
  }

  /**
   * Songs waiting for the Zune: fixed files that still exist, and deleted
   * files whose Zune copy should be removed.
   */
  async zunePending() {
    const list = await this._readPending();
    // Every song in the fix history is re-checked too, so a song wrongly
    // marked done (or fixed again later) still gets onto the Zune. The plan
    // skips the ones that are already up to date or aren't on the Zune.
    const seen = new Set(list.map(e => e.path));
    const synced = await this._readSynced();
    let names = [];
    try { names = await fs.readdir(this.undoDir); } catch { /* no history */ }
    const batches = names.filter(n => /^\d+\.json$/.test(n)).sort((x, y) => Number(x.slice(0, -5)) - Number(y.slice(0, -5)));
    for (const name of batches) {
      let entries = [];
      try { entries = JSON.parse(await fs.readFile(path.join(this.undoDir, name), 'utf8')); } catch { continue; }
      for (const e of entries) {
        if (!e?.path || seen.has(e.path)) continue;
        seen.add(e.path);
        // Already handled for the Zune and unchanged since: nothing to do
        if (synced[e.path] && synced[e.path] === await this._fileSig(e.path)) continue;
        list.push({
          path: e.path,
          fileName: path.basename(e.path),
          before: { title: e.before?.title || '', artist: e.before?.artist || '', album: e.before?.album || '' },
          removedFromZune: false,
          fromHistory: true,
        });
      }
    }
    return list.filter(e => e.action === 'delete' || fsSync.existsSync(e.path));
  }

  /**
   * Move songs to the Trash. With removeFromZune, remember each one (and its
   * tags) so "update zune" can take its copy off the device too.
   */
  /**
   * @param opts.keepers  path -> paths of the copies being kept instead (for
   *   duplicates). A copy is only deleted if one of those is reachable now, so
   *   a disconnected drive can't turn "delete the extra" into "delete the last".
   * @returns {{ trashed, missing, failed }}  missing = already gone from disk
   */
  async trash(paths, { removeFromZune = false, keepers = {} } = {}) {
    if (!this.trashItem) throw new Error('Trash is not available');
    const trashed = [];
    const missing = [];
    const failed = [];
    const list = removeFromZune ? await this._readPending() : null;
    const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
    for (const p of paths) {
      try {
        const kept = keepers[p];
        if (Array.isArray(kept) && kept.length) {
          let reachable = false;
          for (const k of kept) if (await exists(k)) { reachable = true; break; }
          if (!reachable) {
            failed.push({ path: p, error: 'the copy being kept isn\u2019t available (is its drive connected?)', keeperMissing: true });
            continue;
          }
        }
        if (!(await exists(p))) { missing.push(p); continue; }
        let tags = null;
        if (removeFromZune) {
          try { tags = await this.readTags(p); } catch { tags = {}; }
        }
        await this.trashItem(p);
        trashed.push(p);
        if (list) {
          const existing = list.find(e => e.path === p);
          if (existing) {
            // A fixed song that's now deleted: its Zune copy still has the old tags
            existing.action = 'delete';
          } else {
            list.push({
              path: p,
              fileName: path.basename(p),
              before: { title: tags.title || '', artist: tags.artist || '', album: tags.album || '' },
              removedFromZune: false,
              action: 'delete',
            });
          }
        }
      } catch (err) {
        // Gone between the check and the move: nothing left to delete
        if (/doesn.t exist|no such file|ENOENT/i.test(err.message)) missing.push(p);
        else failed.push({ path: p, error: err.message });
      }
    }
    if (list) await this._writePending(list);
    return { trashed, missing, failed };
  }

  /** removed: the old copy is off the Zune (resend even if no match is found later). */
  async zuneMarkRemoved(paths) {
    const set = new Set(paths);
    const list = await this._readPending();
    for (const e of list) if (set.has(e.path)) e.removedFromZune = true;
    await this._writePending(list);
  }

  async zuneDone(paths) {
    const set = new Set(paths);
    await this._writePending((await this._readPending()).filter(e => !set.has(e.path)));
    // Remember each file as it is now: unless it changes again (a new fix),
    // it won't be offered for "update zune" any more
    const synced = await this._readSynced();
    for (const p of paths) {
      const sig = await this._fileSig(p);
      if (sig) synced[p] = sig;
    }
    await fs.mkdir(this.undoDir, { recursive: true });
    await fs.writeFile(path.join(this.undoDir, 'zune-synced.json'), JSON.stringify(synced));
  }

  // ---- Songs confirmed correct by sound --------------------------------------

  _confirmedFile() { return path.join(this.undoDir, 'confirmed.json'); }

  /** Paths confirmed earlier whose files haven't changed since. */
  async confirmedGet() {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(this._confirmedFile(), 'utf8')); } catch { /* none yet */ }
    const out = [];
    for (const [p, sig] of Object.entries(saved)) {
      if (sig && sig === await this._fileSig(p)) out.push(p);
    }
    return out;
  }

  async confirmedAdd(paths) {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(this._confirmedFile(), 'utf8')); } catch { /* none yet */ }
    for (const p of paths) {
      const sig = await this._fileSig(p);
      if (sig) saved[p] = sig;
    }
    await fs.mkdir(this.undoDir, { recursive: true });
    await fs.writeFile(this._confirmedFile(), JSON.stringify(saved));
  }

  async _readSynced() {
    try { return JSON.parse(await fs.readFile(path.join(this.undoDir, 'zune-synced.json'), 'utf8')); } catch { return {}; }
  }

  async _fileSig(p) {
    try { const st = await fs.stat(p); return `${Math.round(st.mtimeMs)}:${st.size}`; } catch { return null; }
  }

  // ---- Undo -----------------------------------------------------------------

  async _record(batchId, entry) {
    if (!this._batches.has(batchId)) this._batches.set(batchId, []);
    this._batches.get(batchId).push(entry);
    await fs.mkdir(this.undoDir, { recursive: true });
    await fs.writeFile(path.join(this.undoDir, `${batchId}.json`), JSON.stringify(this._batches.get(batchId), null, 1));
  }

  async _lastBatchFile() {
    let names;
    try { names = await fs.readdir(this.undoDir); } catch { return null; }
    const batches = names.filter(n => /^\d+\.json$/.test(n)).sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));
    return batches.length ? path.join(this.undoDir, batches[0]) : null;
  }

  async undoInfo() {
    const file = await this._lastBatchFile();
    if (!file) return null;
    try {
      const entries = JSON.parse(await fs.readFile(file, 'utf8'));
      return { count: entries.length, when: Number(path.basename(file, '.json')) };
    } catch {
      return null;
    }
  }

  /** Put the tags of the most recent batch back the way they were. */
  async undoLast() {
    const file = await this._lastBatchFile();
    if (!file) return { restored: [], failed: [] };
    const entries = JSON.parse(await fs.readFile(file, 'utf8'));
    const restored = [];
    const failed = [];
    for (const e of entries.reverse()) {
      try {
        if (!fsSync.existsSync(e.path)) throw new Error('file no longer exists');
        await this._rewrite(e.path, e.before, { dropCover: e.addedCover });
        restored.push(e.path);
      } catch (err) {
        failed.push({ path: e.path, error: err.message });
      }
    }
    // Restored songs match the Zune's copy again, unless that copy was already replaced
    const pending = await this._readPending();
    const restoredSet = new Set(restored);
    await this._writePending(pending.filter(e => !restoredSet.has(e.path) || e.removedFromZune));

    // Keep the record if anything couldn't be restored, so it can be retried
    if (failed.length === 0) await fs.unlink(file).catch(() => {});
    this._batches.delete(path.basename(file, '.json'));
    return { restored, failed };
  }
}

module.exports = { SongFixer };
