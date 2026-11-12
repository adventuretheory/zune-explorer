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
  constructor({ ffmpegPath, dataDir, fetchBinary, trashItem }) {
    this.ffmpegPath = ffmpegPath;
    this.trashItem = trashItem; // moves a file to the system Trash (Electron shell.trashItem)
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
      duration: String(Math.round(duration)),
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
  async identify(filePath, apiKey) {
    if (!apiKey) throw new Error('Add your AcoustID key first');
    const current = await this.readTags(filePath);
    if (!current.duration) throw new Error('Could not read the song length');
    const fp = await this.fingerprint(filePath);
    const response = await this._acoustidLookup(apiKey, fp, current.duration);
    const proposal = logic.pickBestMatch(response, current);
    return { current, proposal };
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
  async _rewrite(filePath, tags, { coverPath = null, dropCover = false } = {}) {
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);
    const temp = path.join(dir, `.${path.basename(filePath, ext)}.zunefix-${Date.now()}${ext}`);
    const args = logic.buildTagArgs(filePath, temp, tags, { coverPath, ext });
    if (dropCover) {
      // Remove the "-map 0:v?" pair so only audio is kept
      const i = args.indexOf('0:v?');
      if (i > 0) args.splice(i - 1, 2);
    }

    const before = await fs.stat(filePath);
    try {
      await execFileAsync(this.ffmpegPath, args, { maxBuffer: 1 << 24 });
      const after = await fs.stat(temp);
      // The audio is copied as-is, so the new file should be about the same size
      if (after.size < before.size * 0.9) throw new Error('rewritten file came out too small');
      const { parseFile } = await import('music-metadata');
      await parseFile(temp, { duration: false });
      await fs.rename(temp, filePath);
    } catch (err) {
      await fs.unlink(temp).catch(() => {});
      throw new Error(`Could not update tags: ${err.message.split('\n')[0]}`);
    }
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

    try {
      await this._rewrite(filePath, tags, { coverPath });
      addedCover = !!coverPath;
    } finally {
      if (coverPath) await fs.unlink(coverPath).catch(() => {});
    }

    await this._record(batchId, { path: filePath, before, addedCover });
    await this._addPending(filePath, current);
    return { addedCover };
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

  async _addPending(filePath, oldTags) {
    const list = await this._readPending();
    // Keep the oldest tags: that's the version the Zune still has
    if (!list.some(e => e.path === filePath)) {
      list.push({
        path: filePath,
        fileName: path.basename(filePath),
        before: { title: oldTags.title || '', artist: oldTags.artist || '', album: oldTags.album || '' },
        removedFromZune: false,
      });
      await this._writePending(list);
    }
  }

  /**
   * Songs waiting for the Zune: fixed files that still exist, and deleted
   * files whose Zune copy should be removed.
   */
  async zunePending() {
    return (await this._readPending()).filter(e => e.action === 'delete' || fsSync.existsSync(e.path));
  }

  /**
   * Move songs to the Trash. With removeFromZune, remember each one (and its
   * tags) so "update zune" can take its copy off the device too.
   */
  async trash(paths, { removeFromZune = false } = {}) {
    if (!this.trashItem) throw new Error('Trash is not available');
    const trashed = [];
    const failed = [];
    const list = removeFromZune ? await this._readPending() : null;
    for (const p of paths) {
      try {
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
        failed.push({ path: p, error: err.message });
      }
    }
    if (list) await this._writePending(list);
    return { trashed, failed };
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
