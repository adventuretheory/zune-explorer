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
      ], { timeout: 120000 }); // a damaged file mustn't hang everything
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
    let timer;
    const md = await Promise.race([
      parseFile(filePath, { duration: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('reading the song\u2019s tags took too long (damaged file?)')), 30000); }),
    ]).finally(() => clearTimeout(timer));
    const c = md.common;
    return {
      title: c.title || '',
      artist: c.artist || '',
      album: c.album || '',
      albumArtist: c.albumartist || '',
      genre: (c.genre && c.genre[0]) || '',
      comment: (c.comment || []).map(x => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean).join(' '),
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
      const proc = spawn(this.ffmpegPath, args, { timeout: 180000 });
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

  /** Length in seconds found by decoding the whole file (slower, exact). */
  async decodedDuration(filePath) {
    const out = await new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-i', filePath, '-vn', '-f', 'null', '-'], { timeout: 180000 });
      let err = '';
      proc.stderr.on('data', (c) => { err += c; if (err.length > 200000) err = err.slice(-100000); });
      proc.on('error', () => resolve(''));
      proc.on('close', () => resolve(err));
    });
    const times = [...out.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (!times.length) return 0;
    const t = times[times.length - 1];
    return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  }

  /**
   * A song saved with a wrong ending (".net", ".com" — left over from a title)
   * gets the ending of the audio it really holds. Returns the (new) path.
   */
  async _fixWrongExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (logic.WRITABLE_EXTENSIONS.has(ext) || ext === '.wav') return filePath;
    const head = Buffer.alloc(16);
    const fh = await fs.open(filePath, 'r');
    try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
    const real = logic.sniffAudioExt(head);
    if (!real) return filePath;
    const dir = path.dirname(filePath);
    const base = ext && ext.length <= 5 && !/\s/.test(ext) ? path.basename(filePath, ext) : path.basename(filePath);
    let to = path.join(dir, base + real);
    for (let n = 2; ; n++) {
      try { await fs.access(to); } catch { break; }
      to = path.join(dir, `${base} (${n})${real}`);
    }
    await fs.rename(filePath, to);
    return to;
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
      if (db && (!da || Math.abs(da - db) <= 1)) return;
      // Header-based lengths can be guesses (MP3s without a length header).
      // Play both through to the end and compare the real lengths.
      const [ra, rb] = await Promise.all([this.decodedDuration(filePath), this.decodedDuration(temp)]);
      if (!rb || (ra && Math.abs(ra - rb) > Math.max(1, ra * 0.01))) throw new Error('rewritten file is a different length');
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
        await execFileAsync(this.ffmpegPath, args, { maxBuffer: 1 << 24, timeout: 300000 });
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
        lastReason = err.killed ? 'ffmpeg took too long on this file (damaged?)' : stderr.length ? stderr[stderr.length - 1] : String(err.message).split('\n')[0];
        if (err.killed) { await fs.unlink(temp).catch(() => {}); break; }
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
    const originalPath = filePath;
    filePath = await this._fixWrongExtension(filePath);
    const renamedTo = filePath !== originalPath ? filePath : undefined;
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
    return { addedCover, transcoded: !!outcome.transcoded, coverSkipped: !!outcome.coverSkipped, renamedTo };
  }

  /**
   * Take website names out of a song's tags (title, artist, album, album
   * artist, genre, comment). Reads the file itself, so tags the library
   * doesn't show are covered too.
   * @returns {{ changed: object, renamedTo?: string }} changed = new values ({} if clean)
   */
  async stripSites(batchId, filePath) {
    const current = await this.readTags(filePath);
    const changed = logic.stripSiteTags(current, filePath);
    if (!Object.keys(changed).length) return { changed };
    const res = await this.apply(batchId, filePath, changed, { addCover: false });
    return { changed, renamedTo: res.renamedTo };
  }

  // ---- Restoring sound (volume, hiss, clicks, rumble) -----------------------

  /** Filters for the chosen fixes (loudness is added separately: it needs measuring). */
  _restoreFilters(opts) {
    const f = [];
    if (opts.rumble) f.push('highpass=f=30');
    if (opts.clicks) f.push('adeclick');
    if (opts.hiss) f.push('afftdn=nr=10:nf=-50:tn=1');
    return f;
  }

  _sampleRate(stderr) {
    const m = String(stderr).match(/Audio:[^\n]*?(\d{4,6}) Hz/);
    const sr = m ? Number(m[1]) : 44100;
    return sr >= 8000 && sr <= 192000 ? sr : 44100;
  }

  _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      // Restoring a long song with every fix can take a few minutes, never this long
      const proc = spawn(this.ffmpegPath, args, { timeout: 900000 });
      let err = '';
      proc.stderr.on('data', (c) => { err += c; if (err.length > 400000) err = err.slice(-200000); });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve(err) : reject(Object.assign(new Error(`ffmpeg failed (${code})`), { stderr: err }))));
    });
  }

  /**
   * The full filter chain for a file (or excerpt): the chosen fixes, then
   * volume levelling measured on the same audio (two-pass loudnorm).
   * @param input ffmpeg input args, e.g. ['-ss', '60', '-t', '30', '-i', file]
   */
  async _restoreChain(input, opts) {
    const pre = this._restoreFilters(opts);
    const info = await this._runFfmpeg(['-hide_banner', ...input, '-t', '0', '-f', 'null', '-']).catch(e => e.stderr || '');
    const sr = this._sampleRate(info);
    if (!opts.volume) return { chain: pre.length ? pre.join(',') : 'anull', sr };
    const target = 'I=-14:TP=-1.0:LRA=11';
    const out = await this._runFfmpeg(['-hide_banner', ...input, '-vn', '-af', [...pre, `loudnorm=${target}:print_format=json`].join(','), '-f', 'null', '-']);
    const json = out.slice(out.lastIndexOf('{'), out.lastIndexOf('}') + 1);
    let m;
    try { m = JSON.parse(json); } catch { throw new Error('couldn\u2019t measure the volume'); }
    const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
    return { chain: [...pre, `loudnorm=${target}:${measured}:linear=true`, `aresample=${sr}`].join(','), sr };
  }

  /**
   * Short before/after clips (30 s, a third of the way in) to compare.
   * @returns {{ original: string, restored: string }} paths of WAV files
   */
  async restorePreview(filePath, opts) {
    const dir = path.join(require('os').tmpdir(), 'zune-restore-preview');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(dir, { recursive: true });
    let duration = 0;
    try { duration = (await this.readTags(filePath)).duration || 0; } catch { /* unknown */ }
    const start = duration > 60 ? Math.floor(duration / 3) : 0;
    const input = ['-ss', String(start), '-t', '30', '-i', filePath];
    const stamp = Date.now();
    const original = path.join(dir, `original-${stamp}.wav`);
    const restored = path.join(dir, `restored-${stamp}.wav`);
    await this._runFfmpeg(['-hide_banner', '-loglevel', 'error', ...input, '-vn', '-c:a', 'pcm_s16le', '-y', original]);
    const { chain } = await this._restoreChain(input, opts);
    await this._runFfmpeg(['-hide_banner', '-loglevel', 'error', ...input, '-vn', '-af', chain, '-c:a', 'pcm_s16le', '-y', restored]);
    return { original, restored };
  }

  /**
   * Clean up a song's sound and save it in place. The original is kept in
   * the undo folder, so "undo last fix" puts it back.
   * @param opts { volume, hiss, clicks, rumble }
   */
  async restore(batchId, filePath, opts) {
    if (!opts || !['volume', 'hiss', 'clicks', 'rumble'].some(k => opts[k])) throw new Error('nothing chosen to fix');
    const ext = path.extname(filePath).toLowerCase();
    const CODEC = {
      '.mp3': ['-c:a', 'libmp3lame', '-q:a', '0'],
      '.m4a': ['-c:a', 'aac', '-b:a', '256k'],
      '.mp4': ['-c:a', 'aac', '-b:a', '256k'],
      '.aac': ['-c:a', 'aac', '-b:a', '256k'],
      '.flac': ['-c:a', 'flac'],
      '.ogg': ['-c:a', 'libvorbis', '-q:a', '6'],
      '.wav': ['-c:a', 'pcm_s16le'],
      '.wma': ['-c:a', 'wmav2', '-b:a', '192k'],
    }[ext];
    if (!CODEC) throw new Error(`can\u2019t restore ${ext.replace('.', '').toUpperCase()} files`);
    const current = await this.readTags(filePath);
    const { chain } = await this._restoreChain(['-i', filePath], opts);
    const dir = path.dirname(filePath);
    const temp = path.join(dir, `.${path.basename(filePath, ext)}.zunerestore-${Date.now()}${ext}`);
    const keepsArt = ['.mp3', '.m4a', '.mp4', '.flac'].includes(ext);
    const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', '0:a:0'];
    if (keepsArt) args.push('-map', '0:v?', '-c:v', 'copy');
    args.push('-map_metadata', '0', '-af', chain, ...CODEC);
    if (ext === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
    if (keepsArt && ext !== '.mp3') args.push('-disposition:v', 'attached_pic');
    args.push('-y', temp);
    try {
      await this._runFfmpeg(args);
      const [a, b] = await Promise.all([this.decodedDuration(filePath), this.decodedDuration(temp)]);
      if (!b || (a && Math.abs(a - b) > Math.max(1, a * 0.01))) throw new Error('restored file is a different length');
      const backups = path.join(this.undoDir, 'originals');
      await fs.mkdir(backups, { recursive: true });
      const backupFile = path.join(backups, `${batchId}-${Date.now()}-${path.basename(filePath)}`);
      await fs.copyFile(filePath, backupFile);
      await fs.rename(temp, filePath);
      await this._record(batchId, { path: filePath, before: {}, backupFile });
      await this._addPending(filePath, current, { artChanged: true });
      return { restored: true };
    } catch (err) {
      await fs.unlink(temp).catch(() => {});
      const why = String(err.stderr || '').trim().split('\n').filter(Boolean).pop();
      throw new Error(why ? `${err.message}: ${why}` : err.message);
    }
  }

  // ---- Sound quality (fake bitrates) -----------------------------------------

  _qualityFile() { return path.join(this.undoDir, 'quality.json'); }

  async _readQuality() {
    if (this._quality) return this._quality;
    try { this._quality = JSON.parse(await fs.readFile(this._qualityFile(), 'utf8')); } catch { this._quality = {}; }
    return this._quality;
  }

  async _saveQuality() {
    await fs.mkdir(this.undoDir, { recursive: true });
    await fs.writeFile(this._qualityFile(), JSON.stringify(this._quality || {}));
  }

  /** Measured cutoffs saved earlier: { path: cutoffHz } (only still-valid ones). */
  async qualityKnown() {
    const q = await this._readQuality();
    const out = {};
    for (const [p, v] of Object.entries(q)) if (v && v.cutoffHz) out[p] = v.cutoffHz;
    return out;
  }

  /**
   * Measure how much of the sound each song really has (see audio-quality.js).
   * Results are kept until the file changes. Runs a few songs at a time.
   * @param items [{ path, duration }]
   * @param onResult (path, cutoffHz) for each measured song
   * @param shouldStop () => boolean
   */
  async qualityScan(items, { onResult = () => {}, onProgress = () => {}, shouldStop = () => false } = {}) {
    const { measureCutoff } = require('./audio-quality.js');
    const q = await this._readQuality();
    let next = 0;
    let done = 0;
    let lastSave = Date.now();
    const worker = async () => {
      while (next < items.length && !shouldStop()) {
        const { path: p, duration } = items[next++];
        try {
          const st = await fs.stat(p);
          const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
          let entry = q[p];
          if (!entry || entry.stamp !== stamp) {
            const r = await measureCutoff(this.ffmpegPath, p, duration || 0);
            entry = { stamp, cutoffHz: r ? r.cutoffHz : 0 };
            q[p] = entry;
          }
          if (entry.cutoffHz) onResult(p, entry.cutoffHz);
        } catch { /* missing or unreadable */ }
        done++;
        if (done % 20 === 0) onProgress(done, items.length);
        if (Date.now() - lastSave > 15000) { lastSave = Date.now(); await this._saveQuality().catch(() => {}); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    onProgress(done, items.length);
    await this._saveQuality().catch(() => {});
    return { measured: done, stopped: shouldStop() };
  }

  // ---- Website pictures used as album art -----------------------------------

  /**
   * Read every song's cover and find pictures that are a website's logo or
   * advert (see logic.groupSiteCovers). Results per file are cached until the
   * file changes. `onProgress(done, total)` is called as files are read.
   * @returns [{ hash, kind, paths, count, siteSongs, artists, albums, examples, image }]
   *          image = data URL of the picture
   */
  async coverScan(paths, onProgress = () => {}, shouldStop = () => false) {
    const { parseFile } = await import('music-metadata');
    const crypto = require('crypto');
    if (!this._coverCache) this._coverCache = new Map();
    const images = new Map(); // hash -> data URL (one sample)
    // Songs that had a website in their tags before being fixed still count
    const pendingSite = new Set();
    for (const e of await this._readPending()) {
      if (Object.values(e.before || {}).some(logic.hasSite)) pendingSite.add(e.path);
    }
    const entries = [];
    let read = 0;
    for (let i = 0; i < paths.length; i++) {
      if (shouldStop()) break; // what's been read so far is still grouped and shown
      read = i + 1;
      const p = paths[i];
      if (i % 25 === 0) onProgress(i, paths.length);
      let st;
      try { st = await fs.stat(p); } catch { continue; }
      const stamp = `${st.size}:${st.mtimeMs}`;
      let info = this._coverCache.get(p);
      if (!info || info.stamp !== stamp) {
        info = { stamp, hash: null };
        try {
          let timer;
          const md = await Promise.race([
            parseFile(p, { duration: false, skipCovers: false }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 15000); }),
          ]).finally(() => clearTimeout(timer));
          const c = md.common;
          const pic = c.picture && c.picture[0];
          const comment = (c.comment || []).map(x => (typeof x === 'string' ? x : x?.text || '')).join(' ');
          info.title = c.title || '';
          info.artist = c.artist || '';
          info.album = c.album || '';
          info.siteInTags = [c.title, c.artist, c.album, c.albumartist, comment, c.genre && c.genre[0]].some(logic.hasSite);
          if (pic && pic.data && pic.data.length) {
            info.hash = crypto.createHash('sha1').update(pic.data).digest('hex');
            if (!images.has(info.hash)) images.set(info.hash, `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`);
          }
        } catch { /* unreadable: no cover */ }
        this._coverCache.set(p, info);
      }
      if (!info.hash) continue;
      entries.push({
        path: p, hash: info.hash, title: info.title, artist: info.artist, album: info.album,
        siteLinked: info.siteInTags || pendingSite.has(p) || logic.hasSite(path.basename(p, path.extname(p))),
      });
    }
    onProgress(read, paths.length);
    const groups = logic.groupSiteCovers(entries);
    // Pictures read in an earlier scan (cached) need loading again for display
    for (const g of groups) {
      if (!images.has(g.hash)) {
        for (const p of g.paths) {
          try {
            const md = await parseFile(p, { duration: false, skipCovers: false });
            const pic = md.common.picture && md.common.picture[0];
            if (pic) { images.set(g.hash, `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`); break; }
          } catch { /* try the next */ }
        }
      }
      g.image = images.get(g.hash) || null;
    }
    return groups;
  }

  /**
   * Remove a song's cover picture if it is the one with this hash. The
   * picture is kept in the undo folder so "undo" can put it back.
   * @returns {{ removed: boolean, skipped?: string }}
   */
  async removeCover(batchId, filePath, hash) {
    const { parseFile } = await import('music-metadata');
    const crypto = require('crypto');
    const md = await parseFile(filePath, { duration: false, skipCovers: false });
    const pic = md.common.picture && md.common.picture[0];
    if (!pic) return { removed: false, skipped: 'no album art' };
    const h = crypto.createHash('sha1').update(pic.data).digest('hex');
    if (h !== hash) return { removed: false, skipped: 'album art has changed since the scan' };
    const coverDir = path.join(this.undoDir, 'covers');
    await fs.mkdir(coverDir, { recursive: true });
    const saved = path.join(coverDir, hash + (/png/i.test(pic.format || '') ? '.png' : '.jpg'));
    if (!fsSync.existsSync(saved)) await fs.writeFile(saved, pic.data);
    const current = await this.readTags(filePath);
    await this._rewrite(filePath, {}, { dropCover: true });
    await this._record(batchId, { path: filePath, before: {}, restoreCover: saved });
    await this._addPending(filePath, current, { artChanged: true });
    return { removed: true };
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
  zuneMarkRemoved(paths) {
    return this._serial(() => this._zuneMarkRemoved(paths));
  }

  async _zuneMarkRemoved(paths) {
    const set = new Set(paths);
    const list = await this._readPending();
    for (const e of list) if (set.has(e.path)) e.removedFromZune = true;
    await this._writePending(list);
  }

  /** Run changes to the Zune lists one after another (songs finish close together). */
  _serial(fn) {
    const run = (this._pendingQueue || Promise.resolve()).then(fn, fn);
    this._pendingQueue = run.catch(() => {});
    return run;
  }

  zuneDone(paths) {
    return this._serial(() => this._zuneDone(paths));
  }

  async _zuneDone(paths) {
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

  // ---- Songs ignored on the "needs fixing" list ------------------------------

  _ignoredFile() { return path.join(this.undoDir, 'ignored.json'); }

  /** Paths ignored earlier whose files haven't changed since (a changed file is checked again). */
  async ignoredGet() {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(this._ignoredFile(), 'utf8')); } catch { /* none yet */ }
    const out = [];
    for (const [p, sig] of Object.entries(saved)) if (sig && sig === await this._fileSig(p)) out.push(p);
    return out;
  }

  async ignoredSet(paths, ignore) {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(this._ignoredFile(), 'utf8')); } catch { /* none yet */ }
    for (const p of paths) {
      if (!ignore) { delete saved[p]; continue; }
      const sig = await this._fileSig(p);
      if (sig) saved[p] = sig;
    }
    await fs.mkdir(this.undoDir, { recursive: true });
    await fs.writeFile(this._ignoredFile(), JSON.stringify(saved));
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
        if (e.backupFile) {
          // Restored sound: put the original file back
          if (!fsSync.existsSync(e.backupFile)) throw new Error('the original file is no longer saved');
          await fs.copyFile(e.backupFile, e.path);
          await fs.unlink(e.backupFile).catch(() => {});
          restored.push(e.path);
          continue;
        }
        if (e.restoreCover && !fsSync.existsSync(e.restoreCover)) throw new Error('the removed picture is no longer saved');
        await this._rewrite(e.path, e.before, { dropCover: e.addedCover, coverPath: e.restoreCover || null });
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
