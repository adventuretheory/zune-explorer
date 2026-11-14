// Importing new music (e.g. from Downloads) and audio CDs: ripping and
// burning. CD work uses macOS's own tools (the CD shows up in /Volumes,
// drutil burns), so it's Mac-only for now.

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const media = require('../shared/media-logic.js');
const logic = require('../shared/song-fixer-logic.js');

const execFileAsync = promisify(execFile);

class MediaTools {
  /**
   * @param {object} o
   * @param {string} o.ffmpegPath
   * @param {string} o.dataDir         where the "ignored" list is kept
   * @param {object} o.songFixer       for reading and writing tags
   * @param {(p: string) => Promise} o.trashItem
   * @param {object} o.musicbrainz     { lookupDisc }
   * @param {(id: string) => Promise<Buffer|null>} o.coverForRelease
   * @param {(info: object) => Promise<Buffer|null>} o.findAlbumArt
   */
  constructor(o) {
    Object.assign(this, o);
    this.ignoreFile = path.join(o.dataDir, 'import-ignored.json');
  }

  // ---- Import -------------------------------------------------------------

  async _ignored() {
    try { return JSON.parse(await fs.readFile(this.ignoreFile, 'utf8')); } catch { return {}; }
  }

  /** Don't offer these files again (until they change). */
  async ignore(paths) {
    const list = await this._ignored();
    for (const p of paths) {
      try { const st = await fs.stat(p); list[p] = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* gone */ }
    }
    await fs.mkdir(path.dirname(this.ignoreFile), { recursive: true });
    await fs.writeFile(this.ignoreFile, JSON.stringify(list));
  }

  /**
   * New songs in the watched folders: audio files (looked for two folders
   * deep) that aren't inside the music library and weren't ignored.
   * @param {string[]} folders
   * @param {string[]} libraryFolders  files under these are already in the library
   * @returns [{ path, name, size, modified, tags }]
   */
  async scan(folders, libraryFolders = []) {
    const ignored = await this._ignored();
    const inLibrary = (p) => libraryFolders.some(f => p === f || p.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
    const found = [];
    const walk = async (dir, depth) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 2 && !inLibrary(p) && !/\.(app|photoslibrary|musiclibrary)$/i.test(e.name)) await walk(p, depth + 1);
        } else if (e.isFile() && media.isImportableAudio(e.name) && !inLibrary(p)) {
          let st;
          try { st = await fs.stat(p); } catch { continue; }
          if (st.size < 100 * 1024) continue; // ringtones, sounds, broken downloads
          if (ignored[p] === `${st.size}:${Math.round(st.mtimeMs)}`) continue;
          found.push({ path: p, name: e.name, size: st.size, modified: st.mtimeMs });
        }
      }
    };
    for (const f of folders) await walk(f, 0);
    found.sort((a, b) => b.modified - a.modified);
    for (const f of found.slice(0, 500)) {
      try { f.tags = await this.songFixer.readTags(f.path); } catch { f.tags = {}; }
    }
    return found.slice(0, 500);
  }

  async _uniquePath(parts) {
    const dir = path.join(...parts.slice(0, -1));
    const file = parts[parts.length - 1];
    const ext = path.extname(file);
    const base = file.slice(0, file.length - ext.length);
    let p = path.join(dir, file);
    for (let n = 2; fsSync.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
    return p;
  }

  /**
   * Bring one song into the music folder: Artist/Album/"01 Title.ext", with
   * the given tags written and album art added when it has none. The
   * original is moved to the Trash (when `move`) once the copy is done.
   * @param {object} tags  { title, artist, album, albumArtist, year, trackNumber }
   * @returns {{ path: string, artAdded: boolean }}
   */
  async importFile(src, tags, musicRoot, { move = true, findArt = true } = {}) {
    const ext = path.extname(src).toLowerCase();
    const parts = [musicRoot, ...media.organizedParts(tags, ext)];
    await fs.mkdir(path.join(...parts.slice(0, -1)), { recursive: true });
    const dest = await this._uniquePath(parts);
    await fs.copyFile(src, dest);
    let artAdded = false;
    try {
      if (logic.WRITABLE_EXTENSIONS.has(ext)) {
        const current = await this.songFixer.readTags(dest).catch(() => ({}));
        const want = {};
        for (const k of ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber']) {
          if (tags[k] != null && tags[k] !== '' && String(tags[k]) !== String(current[k] ?? '')) want[k] = tags[k];
        }
        let coverPath = null;
        if (findArt && !current.hasCover && ['.mp3', '.m4a', '.mp4', '.flac'].includes(ext) && this.findAlbumArt) {
          const img = await this.findAlbumArt({ title: tags.title, artist: tags.albumArtist || tags.artist, album: tags.album }).catch(() => null);
          if (img) {
            coverPath = path.join(os.tmpdir(), `zune-import-cover-${Date.now()}${img[0] === 0x89 ? '.png' : '.jpg'}`);
            await fs.writeFile(coverPath, img);
          }
        }
        try {
          if (Object.keys(want).length || coverPath) {
            const r = await this.songFixer._rewrite(dest, want, { coverPath });
            artAdded = !!coverPath && !r.coverSkipped;
          }
        } finally {
          if (coverPath) await fs.unlink(coverPath).catch(() => {});
        }
      }
    } catch (err) {
      // Tags couldn't be written: keep the copy as it is rather than lose the song
      console.log(`import: tags not written for ${path.basename(dest)}: ${err.message}`);
    }
    if (move) await this.trashItem(src).catch(() => {});
    return { path: dest, artAdded };
  }

  // ---- Audio CDs (macOS) --------------------------------------------------

  /** The audio CD in the drive, if there is one: its volume, tracks and TOC. */
  async findAudioCd() {
    if (process.platform !== 'darwin') return { supported: false };
    let vols = [];
    try { vols = await fs.readdir('/Volumes'); } catch { return { supported: true, disc: null }; }
    for (const v of vols) {
      const dir = path.join('/Volumes', v);
      const tocFile = path.join(dir, '.TOC.plist');
      if (!fsSync.existsSync(tocFile)) continue;
      let files = [];
      try { files = (await fs.readdir(dir)).filter(f => /\.aiff?$/i.test(f) && !f.startsWith('.')); } catch { continue; }
      if (!files.length) continue;
      const tracks = files
        .map(f => ({ n: parseInt(f, 10), file: path.join(dir, f) }))
        .filter(t => t.n > 0)
        .sort((a, b) => a.n - b.n);
      let toc = null;
      try {
        const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', tocFile], { maxBuffer: 1 << 22 });
        toc = media.parseMacToc(JSON.parse(stdout));
      } catch (err) {
        console.log(`cd: couldn't read the CD's table of contents: ${err.message}`);
      }
      const discId = toc ? media.discIdFromHash(crypto.createHash('sha1').update(media.discIdSource(toc)).digest('base64')) : null;
      const seconds = toc ? media.trackSeconds(toc) : [];
      return {
        supported: true,
        disc: { volume: dir, name: v, discId, toc, tracks: tracks.map((t, i) => ({ ...t, seconds: seconds[i] || 0 })) },
      };
    }
    return { supported: true, disc: null };
  }

  /** Albums this CD could be (MusicBrainz), best first. */
  async lookupDisc(disc) {
    if (!disc || !disc.discId || !disc.toc) return [];
    const res = await this.musicbrainz.lookupDisc(disc.discId, media.tocParam(disc.toc));
    return media.discCandidates(res, disc.discId, disc.tracks.length);
  }

  /**
   * Rip tracks off the CD into the music folder, tagged and with the cover.
   * @param {object[]} tracks [{ file, n, title, artist }]
   * @param {object} album { album, albumArtist, year, genre, disc, discs, releaseId }
   * @param {'mp3'|'mp3v0'|'aac'|'flac'} format
   * @param {(p: object) => void} onProgress
   * @returns {{ done: string[], failed: [{ n, error }] }}
   */
  async rip(tracks, album, musicRoot, format = 'mp3', onProgress = () => {}, shouldStop = () => false) {
    const CODEC = {
      mp3: { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', '-write_id3v1', '1'] },
      mp3v0: { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3', '-write_id3v1', '1'] },
      aac: { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', '256k'] },
      flac: { ext: '.flac', args: ['-c:a', 'flac'] },
    }[format] || null;
    if (!CODEC) throw new Error('unknown format');
    let coverPath = null;
    if (album.releaseId && this.coverForRelease) {
      const img = await this.coverForRelease(album.releaseId).catch(() => null);
      if (img) {
        coverPath = path.join(os.tmpdir(), `zune-cd-cover-${Date.now()}${img[0] === 0x89 ? '.png' : '.jpg'}`);
        await fs.writeFile(coverPath, img);
      }
    }
    const done = [];
    const failed = [];
    try {
      for (let i = 0; i < tracks.length; i++) {
        if (shouldStop()) break;
        const t = tracks[i];
        onProgress({ phase: 'ripping', index: i, total: tracks.length, title: t.title });
        const tags = {
          title: t.title || `Track ${t.n}`, artist: t.artist || album.albumArtist, album: album.album,
          albumArtist: album.albumArtist, trackNumber: t.n, discNumber: album.discs > 1 ? album.disc : 0,
        };
        const parts = [musicRoot, ...media.organizedParts(tags, CODEC.ext)];
        try {
          await fs.mkdir(path.join(...parts.slice(0, -1)), { recursive: true });
          const dest = await this._uniquePath(parts);
          const temp = dest + '.part' + CODEC.ext;
          const args = ['-hide_banner', '-loglevel', 'error', '-i', t.file];
          if (coverPath) args.push('-i', coverPath, '-map', '0:a', '-map', '1:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
          else args.push('-map', '0:a');
          args.push(...CODEC.args);
          const meta = {
            title: tags.title, artist: tags.artist, album: album.album, album_artist: album.albumArtist,
            track: `${t.n}/${album.trackCount || tracks.length}`, date: album.year || '', genre: album.genre || '',
          };
          if (album.discs > 1) meta.disc = `${album.disc}/${album.discs}`;
          for (const [k, v] of Object.entries(meta)) if (v !== '' && v != null) args.push('-metadata', `${k}=${v}`);
          args.push('-y', temp);
          await this._ffmpeg(args, 15 * 60 * 1000);
          await fs.rename(temp, dest);
          done.push(dest);
        } catch (err) {
          failed.push({ n: t.n, error: err.message });
        }
      }
    } finally {
      if (coverPath) await fs.unlink(coverPath).catch(() => {});
    }
    onProgress({ phase: 'done', index: tracks.length, total: tracks.length });
    return { done, failed };
  }

  async ejectCd(volume) {
    if (process.platform !== 'darwin') return;
    try { await execFileAsync('diskutil', ['eject', volume], { timeout: 30000 }); } catch {
      await execFileAsync('drutil', ['eject'], { timeout: 30000 }).catch(() => {});
    }
  }

  /** Is there a blank disc in the drive? { drive: bool, blank: bool, text } */
  async burnStatus() {
    if (process.platform !== 'darwin') return { supported: false };
    try {
      const { stdout } = await execFileAsync('drutil', ['status'], { timeout: 15000 });
      const text = stdout.trim();
      const drive = !/No drives|No burner/i.test(text);
      const noMedia = /No Media|Type:\s*$/im.test(text) && !/Type:\s*CD/i.test(text);
      const blank = /Type:\s*CD-R/i.test(text) && (/Blank/i.test(text) || /Sessions:\s*0/i.test(text) || /Space Free:/i.test(text));
      return { supported: true, drive, noMedia, blank, text };
    } catch (err) {
      return { supported: true, drive: false, blank: false, text: err.message };
    }
  }

  /**
   * Burn songs to an audio CD, in order. Each is first converted to CD audio
   * (16-bit 44.1 kHz AIFF) in a temporary folder.
   */
  async burn(paths, onProgress = () => {}, shouldStop = () => false) {
    if (process.platform !== 'darwin') throw new Error('burning CDs only works on a Mac for now');
    if (!paths.length) throw new Error('no songs to burn');
    if (paths.length > 99) throw new Error('an audio CD holds at most 99 songs');
    const dir = path.join(os.tmpdir(), `zune-burn-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      for (let i = 0; i < paths.length; i++) {
        if (shouldStop()) throw new Error('stopped');
        onProgress({ phase: 'preparing', index: i, total: paths.length, name: path.basename(paths[i]) });
        const out = path.join(dir, `${String(i + 1).padStart(2, '0')}.aiff`);
        await this._ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', paths[i], '-vn', '-map_metadata', '-1',
          '-c:a', 'pcm_s16be', '-ar', '44100', '-ac', '2', '-y', out], 10 * 60 * 1000);
      }
      if (shouldStop()) throw new Error('stopped');
      onProgress({ phase: 'burning', index: paths.length, total: paths.length });
      await new Promise((resolve, reject) => {
        const proc = spawn('drutil', ['burn', '-audio', '-noverify', '-eject', dir]);
        let out = '';
        const onData = (c) => {
          out += c;
          const m = String(c).match(/(\d{1,3})%/g);
          if (m) onProgress({ phase: 'burning', percent: parseInt(m[m.length - 1], 10) });
          if (out.length > 20000) out = out.slice(-10000);
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0 && !/error|failed/i.test(out.split('\n').slice(-5).join(' '))) resolve();
          else reject(new Error((out.trim().split('\n').filter(Boolean).pop() || `drutil exited with ${code}`).replace(/\r/g, '')));
        });
      });
      onProgress({ phase: 'done' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  _ffmpeg(args, timeout) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args, { timeout });
      let err = '';
      proc.stderr.on('data', (c) => { err += c; if (err.length > 100000) err = err.slice(-50000); });
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(signal ? 'took too long' : (err.trim().split('\n').pop() || `ffmpeg exited with ${code}`)));
      });
    });
  }
}

module.exports = { MediaTools };
