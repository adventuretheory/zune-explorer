const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const platformName = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform] || 'linux';
const platform = require('./platform-' + platformName + '.js');
const { ZuneManager } = require('./zune/zune-manager');
const { DeviceCache } = require('./zune/device-cache');
const { MetadataCache } = require('./metadata-cache.js');
const musicbrainz = require('./musicbrainz.js');
const { SongFixer } = require('./song-fixer.js');
const { ArtistImages } = require('./artist-images');
const { getFanartApiKey } = require('./app-config');
const PodcastManager = require('./podcast-manager');
const preferences = require('./preferences');
const { detectInstallType, importLegacyFiles } = require('./preferences-migrations');

const execFileAsync = promisify(execFile);
const ffmpegPath = require('ffmpeg-static');
const { CoverFinder, isImage: isCoverImage } = require('./cover-finder');

const zuneManager = new ZuneManager();
let deviceCache = null; // initialized after app.whenReady
let metadataCache;
let songFixer;
let mediaTools; // import new music, rip and burn CDs
const { MediaTools } = require('./media-tools.js');
let artistImages = null;
let coverFinder = null;
let podcastManager = null;

// Simple dev mode detection
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

let mainWindow;
let pendingFirstRun = null;

// Path validation: restrict file operations to allowed directories
function isAllowedPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedPrefixes = platform.getAllowedPrefixes();
  return allowedPrefixes.some(prefix => {
    const base = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
    return resolved === prefix || resolved.startsWith(base);
  });
}

function createWindow() {
  const windowOptions = {
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#000000',
    show: false
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.vibrancy = 'dark';
    windowOptions.visualEffectState = 'active';
  } else if (process.platform === 'win32') {
    windowOptions.frame = false;
  } else {
    // Linux: use frameless window with custom title bar, same as Windows
    windowOptions.frame = false;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent navigation to arbitrary URLs
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Prevent opening new windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  deviceCache = new DeviceCache(app.getPath('userData'));
  metadataCache = new MetadataCache(app.getPath('userData'));
  songFixer = new SongFixer({
    ffmpegPath,
    dataDir: app.getPath('userData'),
    fetchBinary: musicbrainz.fetchUnlimited,
    trashItem: (p) => shell.trashItem(p),
    searchRecordings: musicbrainz.searchRecordings,
  });
  mediaTools = new MediaTools({
    ffmpegPath,
    dataDir: path.join(app.getPath('userData'), 'song-fixer'),
    songFixer,
    trashItem: (p) => shell.trashItem(p),
    musicbrainz,
    coverForRelease: (id) => coverForRelease(id),
    findAlbumArt: (info) => coverFinder.online(info || {}).then(r => r && r.image),
  });
  coverFinder = new CoverFinder({
    fetchJson: musicbrainz.fetchJsonUnlimited,
    fetchBinary: musicbrainz.fetchUnlimited,
    musicbrainzCover: (info) => findAlbumArt(info),
    readCover: (p) => songFixer.readCover(p),
    artistPhoto: async (name) => {
      const r = artistImages && await artistImages.find(name);
      if (!r || !r.url) return null;
      return fs.readFile(require('url').fileURLToPath(r.url.split('?')[0]));
    },
    identify: async (p) => {
      const key = (preferences.get('songFixer.acoustidKey') || '').trim();
      let timer;
      const r = await Promise.race([
        songFixer.identify(p, key, {}),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 90000); }),
      ]).finally(() => clearTimeout(timer));
      return (r && r.proposal) || null;
    },
    releaseGroupCover: async (id) => (await songFixer._fetchCover(id))?.data || null,
    toJpeg: (buf) => imageToJpeg(buf),
  });
  artistImages = new ArtistImages(app.getPath('userData'), {
    searchArtists: musicbrainz.searchArtists,
    fetchJson: musicbrainz.fetchJsonUnlimited,
    fetchBinary: musicbrainz.fetchUnlimited,
    getApiKey: () => getFanartApiKey(),
  });
  zuneManager.metadataCache = metadataCache;

  // Preferences: load, migrate legacy files on first run after upgrade.
  // Must happen before podcastManager is constructed so its getDownloadDirectory
  // injection can read from the loaded store.
  const userDataDir = app.getPath('userData');
  const install = await detectInstallType(userDataDir);
  const prefFile = path.join(userDataDir, 'preferences.json');
  const hadPreferencesFile = await fs.access(prefFile).then(() => true).catch(() => false);

  await preferences.load(userDataDir, { defaultHome: app.getPath('home') });

  podcastManager = new PodcastManager(app.getPath('userData'), {
    getDownloadDirectory: () => preferences.get('podcasts.downloadDirectory'),
  });
  podcastManager.cleanupPartialDownloads();

  if (!hadPreferencesFile) {
    const legacyPatch = await importLegacyFiles(userDataDir);
    if (Object.keys(legacyPatch).length > 0) {
      await preferences.update(legacyPatch);
    }
    await preferences.update({
      meta: { installedVersion: app.getVersion(), firstRunAt: new Date().toISOString() },
    });
    pendingFirstRun = { type: install.type, version: app.getVersion() };
  }

  preferences.subscribe((evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preferences-changed', evt);
    }
  });

  createWindow();

  // Start Zune USB detection
  zuneManager.start();

  // Forward Zune events to renderer
  zuneManager.on('status', (status) => {
    if (mainWindow) mainWindow.webContents.send('zune-status', status);
  });
  zuneManager.on('transfer-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('zune-transfer-progress', progress);
  });
  zuneManager.on('browse-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('zune-browse-progress', data);
  });
  zuneManager.on('art-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('zune-art-progress', data);
  });
  zuneManager.on('delete-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('zune-delete-progress', data);
  });
  zuneManager.on('pull-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('zune-pull-progress', data);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  zuneManager.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Let go of the Zune properly before quitting (Cmd+Q, or Ctrl+C in Terminal):
// otherwise it stays on its sync screen until it's restarted.
let zuneReleased = false;
async function releaseZune() {
  if (zuneReleased) return;
  zuneReleased = true;
  try {
    zuneManager.cancelRequested = true;
    await Promise.race([zuneManager.disconnect(), new Promise(r => setTimeout(r, 3000))]);
  } catch { /* quitting anyway */ }
}

app.on('before-quit', (event) => {
  if (podcastManager) podcastManager.persistLastPlaybackState();
  if (!zuneReleased && zuneManager.connected) {
    event.preventDefault();
    releaseZune().finally(() => app.quit());
  }
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.log(`\nquitting: letting go of the zune first\u2026`);
    releaseZune().finally(() => app.exit(0));
  });
}

// IPC handlers for file system operations
ipcMain.handle('get-directory-contents', async (event, dirPath) => {
  if (!isAllowedPath(dirPath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    const fileData = (await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file.name);
        try {
          const stats = await fs.stat(filePath);
          return {
            name: file.name,
            path: filePath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modified: stats.mtime,
            extension: stats.isDirectory() ? '' : path.extname(file.name).toLowerCase()
          };
        } catch {
          return null;
        }
      })
    )).filter(Boolean);
    return { success: true, files: fileData };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-home-directory', async () => {
  return app.getPath('home');
});

ipcMain.handle('open-file', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('show-item-in-folder', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  shell.showItemInFolder(filePath);
  return { success: true };
});

ipcMain.handle('delete-file', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      message: 'Are you sure you want to delete this item?',
      detail: `This will permanently delete: ${path.basename(filePath)}`
    });

    if (result.response === 1) {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true });
      } else {
        await fs.unlink(filePath);
      }
      return { success: true };
    }
    return { success: false, cancelled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-app-icon', async (event, appPath) => {
  if (!isAllowedPath(appPath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    return await platform.getAppIcon(appPath);
  } catch (error) {
    console.error('Error getting app icon:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-recent-files', async () => {
  try {
    const homePath = app.getPath('home');
    const files = await platform.getRecentFiles(homePath);
    return { success: true, files };
  } catch (error) {
    console.error('Error getting recent files:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-platform', async () => {
  return process.platform;
});

ipcMain.handle('get-special-folders', async () => {
  const names = ['desktop', 'documents', 'downloads', 'music', 'videos', 'pictures', 'home'];
  const result = {};
  for (const name of names) {
    try { result[name] = app.getPath(name); } catch { /* not available */ }
  }
  return result;
});

ipcMain.handle('open-external', async (_evt, url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { success: false };
    await shell.openExternal(url);
    return { success: true };
  } catch {
    return { success: false };
  }
});

ipcMain.handle('get-external-volumes', async () => {
  try {
    const volumes = await platform.getExternalVolumes();
    return { success: true, volumes };
  } catch (error) {
    return { success: false, error: error.message, volumes: [] };
  }
});

ipcMain.handle('scan-applications', async () => {
  try {
    const homePath = app.getPath('home');
    const applications = await platform.scanApplications(homePath);
    return { success: true, applications };
  } catch (error) {
    console.error('Error scanning applications:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-audio-metadata', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied' };
  }
  try {
    const { parseFile } = await import('music-metadata');
    const metadata = await parseFile(filePath);
    const result = {
      success: true,
      title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
      artist: metadata.common.artist || 'Unknown Artist',
      album: metadata.common.album || 'Unknown Album',
      duration: metadata.format.duration || 0,
    };
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      const base64 = Buffer.from(pic.data).toString('base64');
      result.albumArt = `data:${pic.format};base64,${base64}`;
    } else {
      result.albumArt = null;
    }
    return result;
  } catch (error) {
    return {
      success: true,
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      duration: 0,
      albumArt: null,
    };
  }
});

// ASF content encryption objects (DRM): "Content Encryption" and
// "Extended Content Encryption", as stored in the file (little-endian GUIDs)
const ASF_DRM_GUIDS = [
  Buffer.from('FBB31122 23BDD211 B4B700AA 00A9C114'.replace(/ /g, ''), 'hex'),
  Buffer.from('14E68A29 2226174C B935DAE0 7EE9289C'.replace(/ /g, ''), 'hex'),
];
async function isDrmProtectedAsf(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    return ASF_DRM_GUIDS.some(g => head.indexOf(g) !== -1);
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// Formats the built-in player can't play (Windows Media): converted once to a
// cached M4A and played from there. Copy-protected files can't be converted.
const NEEDS_PLAYBACK_CONVERSION = new Set(['.wma', '.asf']);
const playbackConversions = new Map(); // cache path -> Promise
ipcMain.handle('get-playable-path', async (event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    if (!NEEDS_PLAYBACK_CONVERSION.has(path.extname(filePath).toLowerCase())) return { success: true, path: filePath };
    if (await isDrmProtectedAsf(filePath)) return { success: false, drm: true, error: 'copy-protected (DRM)' };
    const st = await fs.stat(filePath);
    const key = require('crypto').createHash('sha1').update(`${filePath}|${st.size}|${st.mtimeMs}`).digest('hex');
    const dir = path.join(app.getPath('userData'), 'playback-cache');
    const out = path.join(dir, key + '.m4a');
    try { await fs.access(out); return { success: true, path: out, converted: true }; } catch { /* not converted yet */ }
    if (!playbackConversions.has(out)) {
      playbackConversions.set(out, (async () => {
        await fs.mkdir(dir, { recursive: true });
        const tmp = out + '.part.m4a';
        await new Promise((resolve, reject) => {
          const { spawn } = require('child_process');
          const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vn', '-c:a', 'aac', '-b:a', '256k', '-y', tmp]);
          let err = '';
          proc.stderr.on('data', (c) => { err += c; });
          proc.on('error', reject);
          proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(/drm/i.test(err) ? 'copy-protected (DRM)' : (err.trim().split('\n').pop() || 'conversion failed')))));
        });
        await fs.rename(tmp, out);
        // Keep the cache small: the 40 most recently converted songs
        const names = (await fs.readdir(dir)).filter(n => n.endsWith('.m4a') && !n.includes('.part'));
        if (names.length > 40) {
          const stats = await Promise.all(names.map(async n => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })));
          stats.sort((a, b) => b.t - a.t);
          for (const { n } of stats.slice(40)) await fs.unlink(path.join(dir, n)).catch(() => {});
        }
      })().finally(() => playbackConversions.delete(out)));
    }
    await playbackConversions.get(out);
    return { success: true, path: out, converted: true };
  } catch (error) {
    return { success: false, drm: /DRM/.test(error.message), error: error.message };
  }
});

ipcMain.handle('batch-scan-audio-metadata', async (event, filePaths, options = {}) => {
  const { batchSize = 15, includeArt = true } = options;
  const validPaths = filePaths.filter(fp => isAllowedPath(fp));
  const total = validPaths.length;
  let scanned = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = validPaths.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (filePath) => {
      try {
        const { parseFile } = await import('music-metadata');
        const metadata = await Promise.race([
          parseFile(filePath),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        const result = {
          path: filePath,
          title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
          artist: metadata.common.artist || 'Unknown Artist',
          album: metadata.common.album || 'Unknown Album',
          albumArtist: metadata.common.albumartist || metadata.common.artist || 'Unknown Artist',
          genre: (metadata.common.genre && metadata.common.genre[0]) || 'Unknown',
          trackNumber: (metadata.common.track && metadata.common.track.no) || 0,
          year: metadata.common.year || 0,
          duration: metadata.format.duration || 0,
          bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : 0, // kbps
          albumArt: null
        };
        // Copy-protected Windows Media (Zune Pass, old stores) can't be played here
        if (/\.(wma|asf)$/i.test(filePath) && await isDrmProtectedAsf(filePath)) result.drm = true;
        if (includeArt && metadata.common.picture && metadata.common.picture.length > 0) {
          const pic = metadata.common.picture[0];
          result.albumArt = `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
        }
        return result;
      } catch (error) {
        return {
          path: filePath,
          title: path.basename(filePath, path.extname(filePath)),
          artist: 'Unknown Artist',
          album: 'Unknown Album',
          albumArtist: 'Unknown Artist',
          genre: 'Unknown',
          trackNumber: 0,
          year: 0,
          duration: 0,
          albumArt: null
        };
      }
    }));

    scanned += results.length;
    if (mainWindow) {
      mainWindow.webContents.send('music-scan-progress', { scanned, total, batch: results });
    }

    // Yield to event loop between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return { success: true, total: scanned };
});

ipcMain.handle('zune-get-status', async () => {
  return zuneManager.getCurrentStatus();
});

ipcMain.handle('zune-device-info', async () => {
  return zuneManager.getDeviceInfo();
});

ipcMain.handle('zune-send-files', async (event, filePaths, opts) => {
  try {
    // Replacing fixed songs: path -> handle of the old copy, removed just before each send
    let replace = null;
    if (opts?.replace && typeof opts.replace === 'object') {
      replace = {};
      for (const [p, h] of Object.entries(opts.replace)) if (Number.isInteger(h)) replace[p] = h;
    }
    const result = await zuneManager.sendFiles(filePaths, {
      replaceArt: !!opts?.replaceArt,
      replace,
      // Remembered right away, so a stopped update resends this song next time
      onOldRemoved: replace ? (p) => { songFixer.zuneMarkRemoved([p]).catch(() => {}); } : null,
      // Updating fixed songs: each one counts as done the moment it's on the
      // Zune, so quitting part-way and updating again carries on from there
      onSent: opts?.markDone ? (p) => { songFixer.zuneDone([p]).catch(() => {}); } : null,
    });
    return { success: true, ...(result || {}) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// `refs` are [{ subscriptionId, episodeId }]; file paths and metadata come from
// the podcast manager rather than the renderer.
ipcMain.handle('zune-send-podcast-episodes', async (event, refs) => {
  try {
    const wanted = new Set(refs.map(r => `${r.subscriptionId}\u0000${r.episodeId}`));
    const episodes = podcastManager.getAllDownloaded()
      .filter(ep => wanted.has(`${ep.subscriptionId}\u0000${ep.episodeId}`));
    const result = await zuneManager.sendPodcastEpisodes(episodes);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-set-podcast-bookmarks', async (event, writes) => {
  try {
    return { success: true, ...(await zuneManager.setPodcastBookmarks(writes)) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cancel-transfer', async () => {
  zuneManager.cancelTransfer();
  return { success: true };
});

ipcMain.handle('zune-browse-contents', async () => {
  try {
    const contents = await zuneManager.browseContents();
    return { success: true, contents };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Lyrics for a song, from LRCLIB (a free, open lyrics library): plain and
// time-synced (LRC) text. Looked up by title + artist (+ album and length).
function lrclibGet(url) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers: { 'User-Agent': 'ZuneExplorer/1.7 (https://github.com/adventuretheory/zune-explorer)' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`lyrics service answered ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('lyrics service sent something unreadable')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('lyrics service didn\u2019t answer')); });
  });
}

ipcMain.handle('lyrics-get', async (event, info) => {
  try {
    const str = (v) => String(v || '').slice(0, 300).trim();
    const title = str(info?.title), artist = str(info?.artist), album = str(info?.album);
    const duration = Math.round(Number(info?.duration) || 0);
    if (!title) return { success: true, found: false };
    const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    let hit = null;
    if (artist && duration) {
      hit = await lrclibGet(`https://lrclib.net/api/get?${q({ track_name: title, artist_name: artist, album_name: album, duration })}`);
    }
    if (!hit) {
      const list = await lrclibGet(`https://lrclib.net/api/search?${q({ track_name: title, artist_name: artist })}`) || [];
      const usable = list.filter(x => x.plainLyrics || x.syncedLyrics || x.instrumental);
      // Prefer the one whose length matches the song
      usable.sort((a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration));
      hit = usable.find(x => !duration || !x.duration || Math.abs(x.duration - duration) <= 8) || null;
    }
    if (!hit) return { success: true, found: false };
    return {
      success: true, found: true,
      instrumental: !!hit.instrumental,
      plain: hit.plainLyrics || '', synced: hit.syncedLyrics || '',
      title: hit.trackName || title, artist: hit.artistName || artist, album: hit.albumName || '',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Play a song that's only on the Zune: copy it to a small cache and play that
ipcMain.handle('zune-preview-file', async (event, handle) => {
  try {
    if (!Number.isInteger(handle)) throw new Error('Bad request');
    const dir = path.join(app.getPath('userData'), 'zune-preview');
    await fs.mkdir(dir, { recursive: true });
    const existing = (await fs.readdir(dir)).find(n => n.startsWith(`${handle}.`));
    if (existing) return { success: true, path: path.join(dir, existing) };
    const data = await zuneManager.getFile(handle);
    if (!data || !data.length) throw new Error('the zune sent an empty file');
    const out = path.join(dir, `${handle}${sniffAudioExt(data) || '.mp3'}`);
    await fs.writeFile(out, data);
    // Keep the cache small: the 10 most recent
    const names = await fs.readdir(dir);
    if (names.length > 10) {
      const st = await Promise.all(names.map(async n => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })));
      st.sort((a, b) => b.t - a.t);
      for (const { n } of st.slice(10)) await fs.unlink(path.join(dir, n)).catch(() => {});
    }
    return { success: true, path: out };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Playlists on the Zune: create, or update one with the same name
ipcMain.handle('zune-save-playlist', async (event, name, trackHandles, replaceHandle) => {
  try {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Playlist needs a name');
    const handles = (Array.isArray(trackHandles) ? trackHandles : []).filter(Number.isInteger);
    const r = await zuneManager.savePlaylist(name.trim().slice(0, 200), handles, Number.isInteger(replaceHandle) ? replaceHandle : null);
    return { success: true, ...r };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Change song details directly on the Zune (e.g. remove website names)
ipcMain.handle('zune-retag', async (event, edits) => {
  try {
    if (!Array.isArray(edits)) throw new Error('Bad request');
    const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre'];
    const str = (v) => (v == null ? '' : String(v).slice(0, 254));
    const clean = edits.filter(e => e && Number.isInteger(e.handle) && e.changes && typeof e.changes === 'object').map(e => {
      const changes = {};
      for (const f of FIELDS) if (f in e.changes) changes[f] = str(e.changes[f]);
      return { handle: e.handle, changes, old: { artist: str(e.old?.artist), album: str(e.old?.album) } };
    });
    return { success: true, ...(await zuneManager.retagTracks(clean)) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// New covers onto songs already on the Zune (no re-sending). Songs whose only
// change was the cover are then done for "update zune".
ipcMain.handle('zune-set-art', async (event, items) => {
  try {
    if (!Array.isArray(items)) throw new Error('Bad request');
    const ok = items.filter(i => i && Number.isInteger(i.handle) && typeof i.path === 'string' && isAllowedPath(i.path));
    const send = [];
    const pathOf = new Map();
    const pictures = new Map(); // same picture bytes -> one JPEG
    for (const it of ok) {
      let pic = null;
      try { pic = await songFixer.readCover(it.path); } catch { /* unreadable */ }
      if (!pic) continue;
      const key = require('crypto').createHash('sha1').update(pic).digest('hex');
      if (!pictures.has(key)) pictures.set(key, await imageToJpeg(pic, 500));
      const image = pictures.get(key);
      if (!image) continue;
      const tags = await songFixer.readTags(it.path).catch(() => ({}));
      send.push({ handle: it.handle, album: String(it.zuneAlbum || tags.album || ''), image });
      pathOf.set(it.handle, { path: it.path, tags });
    }
    if (!send.length) return { success: true, done: [], noAlbum: [], errors: [], albums: 0 };
    const r = await zuneManager.setAlbumArt(send);
    // Done for "update zune" when nothing else about the song changed
    const pending = new Map((await songFixer.zunePending().catch(() => [])).map(e => [e.path, e]));
    const finished = [];
    for (const h of r.done) {
      const { path: p, tags } = pathOf.get(h) || {};
      const e = p && pending.get(p);
      if (!e) continue;
      const b = e.before || {};
      if ((b.title || '') === (tags.title || '') && (b.artist || '') === (tags.artist || '') && (b.album || '') === (tags.album || '')) finished.push(p);
    }
    if (finished.length) await songFixer.zuneDone(finished);
    return { success: true, ...r, donePaths: r.done.map(h => pathOf.get(h)?.path).filter(Boolean), finished: finished.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-delete-objects', async (event, handles) => {
  try {
    const result = await zuneManager.deleteObjects(handles);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-probe-properties', async (event, handle) => {
  try {
    console.log(`\n=== PROBING OBJECT PROPERTIES (handle=${handle}) ===`);
    const results = await zuneManager.probeObjectProperties(handle);
    console.log('=== PROBE COMPLETE ===\n');
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-probe-wmdrmpd', async () => {
  try {
    console.log('\n=== PROBING WMDRMPD COMMANDS ===');
    const results = await zuneManager.probeWmdrmpd();
    console.log('=== WMDRMPD PROBE COMPLETE ===\n');
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Device cache IPC
ipcMain.handle('zune-cache-load', async (event, deviceKey) => {
  try {
    const data = await deviceCache.load(deviceKey);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// The most recently scanned Zune, for showing what's on it while it isn't plugged in
ipcMain.handle('zune-cache-latest', async () => {
  try {
    return { success: true, data: await deviceCache.latest() };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cache-save', async (event, deviceKey, cacheData) => {
  try {
    await deviceCache.save(deviceKey, cacheData);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cache-invalidate', async (event, deviceKey) => {
  try {
    await deviceCache.invalidate(deviceKey);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Pull file from device — converts WMA to MP3, embeds metadata + album art
const WMA_EXTENSIONS = new Set(['.wma']);

ipcMain.handle('fix-extensionless-files', async (event, filePaths) => {
  const renamed = [];
  for (const filePath of filePaths) {
    if (!isAllowedPath(filePath)) continue;
    if (path.extname(filePath) !== '') continue; // already has extension
    try {
      const buf = Buffer.alloc(12);
      const fh = await fs.open(filePath, 'r');
      await fh.read(buf, 0, 12, 0);
      await fh.close();

      let ext = null;
      // MP3: ID3 header or MPEG sync word
      if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ext = '.mp3';       // ID3
      else if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) ext = '.mp3';             // MPEG sync
      // FLAC
      else if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) ext = '.flac';
      // OGG
      else if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) ext = '.ogg';
      // M4A/AAC (ftyp box)
      else if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) ext = '.m4a';
      // WAV (RIFF)
      else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) ext = '.wav';
      // WMA (ASF header)
      else if (buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xB2 && buf[3] === 0x75) ext = '.wma';

      if (ext) {
        const newPath = filePath + ext;
        await fs.rename(filePath, newPath);
        renamed.push({ oldPath: filePath, newPath });
      }
    } catch {
      // Skip files we can't read or rename
    }
  }
  return { success: true, renamed };
});

// Preferences IPC
ipcMain.handle('consume-first-run', async () => {
  const payload = pendingFirstRun;
  pendingFirstRun = null;
  return payload;
});

ipcMain.handle('preferences-load', async () => {
  return { success: true, preferences: preferences.get('') };
});

ipcMain.handle('preferences-update', async (_evt, patch) => {
  try {
    if (patch && patch.library) {
      for (const cat of ['music', 'videos', 'pictures']) {
        if (Array.isArray(patch.library[cat]) && patch.library[cat].length === 0) {
          return { success: false, error: `library.${cat} cannot be empty` };
        }
      }
    }
    await preferences.update(patch);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('preferences-reset', async (_evt, section) => {
  try {
    await preferences.reset(section);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Generic folder picker (reused by library / sync / podcasts)
ipcMain.handle('pick-folder', async (_evt, title) => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || r.filePaths.length === 0) return { success: false, canceled: true };
  return { success: true, path: r.filePaths[0] };
});

ipcMain.handle('get-app-version', async () => app.getVersion());

ipcMain.handle('clear-metadata-cache', async () => {
  try {
    if (metadataCache && typeof metadataCache.clear === 'function') {
      await metadataCache.clear();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('clear-device-cache', async () => {
  try {
    if (deviceCache && typeof deviceCache.clear === 'function') {
      await deviceCache.clear();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pick-pull-destination', async () => {
  const defaultPath = preferences.get('sync.pullDestination') || app.getPath('music');

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose destination folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, cancelled: true };
  }

  const chosen = result.filePaths[0];
  await preferences.update({ sync: { pullDestination: chosen } });
  return { success: true, path: chosen };
});

// --- Pins ---
const pinsPath = path.join(app.getPath('userData'), 'pins.json');

ipcMain.handle('pins-load', async () => {
  try {
    const data = await fs.readFile(pinsPath, 'utf-8');
    return { success: true, data: JSON.parse(data) };
  } catch {
    return { success: true, data: [] };
  }
});

ipcMain.handle('pins-save', async (event, pins) => {
  try {
    await fs.writeFile(pinsPath, JSON.stringify(pins, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Playlists ---
const playlistsDir = path.join(app.getPath('userData'), 'playlists');

ipcMain.handle('playlists-load-all', async () => {
  try {
    await fs.mkdir(playlistsDir, { recursive: true });
    const files = await fs.readdir(playlistsDir);
    const playlists = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(playlistsDir, file), 'utf-8');
        playlists.push(JSON.parse(data));
      } catch { /* skip corrupt files */ }
    }
    return { success: true, data: playlists };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('playlist-save', async (event, playlist) => {
  try {
    await fs.mkdir(playlistsDir, { recursive: true });
    const filename = playlist.id + '.json';
    const resolved = path.resolve(playlistsDir, filename);
    if (!resolved.startsWith(playlistsDir)) {
      return { success: false, error: 'Invalid playlist ID' };
    }
    await fs.writeFile(resolved, JSON.stringify(playlist, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('playlist-delete', async (event, playlistId) => {
  try {
    const filename = playlistId + '.json';
    const resolved = path.resolve(playlistsDir, filename);
    if (!resolved.startsWith(playlistsDir)) {
      return { success: false, error: 'Invalid playlist ID' };
    }
    await fs.unlink(resolved);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Now Playing ---
const nowPlayingPath = path.join(app.getPath('userData'), 'now-playing.json');

ipcMain.handle('now-playing-load', async () => {
  try {
    const data = await fs.readFile(nowPlayingPath, 'utf-8');
    return { success: true, data: JSON.parse(data) };
  } catch {
    return { success: true, data: { tracks: [], currentIndex: 0 } };
  }
});

ipcMain.handle('now-playing-save', async (event, nowPlaying) => {
  try {
    await fs.writeFile(nowPlayingPath, JSON.stringify(nowPlaying, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Two different tracks can share "Artist - Title" (album version vs. live,
// compilations, etc.). Never overwrite: add " (2)", " (3)"... instead.
async function uniqueDestPath(dir, baseName, ext) {
  let candidate = path.join(dir, baseName + ext);
  for (let n = 2; ; n++) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${baseName} (${n})${ext}`);
  }
}

// The name a copied file gets: "Artist - Title" when tags are known.
// Only real audio extensions count: Zune file names are often titles that
// end in ".com" or ".se-sa mix 2008", which are not file types.
const AUDIO_EXTS = new Set(['.mp3', '.wma', '.m4a', '.mp4', '.aac', '.flac', '.ogg', '.wav']);
function knownAudioExt(filename) {
  const e = path.extname(String(filename || '')).toLowerCase();
  return AUDIO_EXTS.has(e) ? e : '';
}

/** What kind of audio a file holds, from its first bytes ('.mp3', '.wma', …) or null. */
const sniffAudioExt = (buf) => require('../shared/song-fixer-logic.js').sniffAudioExt(buf);

function pullBaseName(filename, metadata) {
  const ext = knownAudioExt(filename);
  let baseName = path.basename(filename, ext);
  if (metadata?.title) {
    baseName = metadata.title.replace(/[<>:"/\\|?*]/g, '_');
    if (metadata?.artist) baseName = `${metadata.artist.replace(/[<>:"/\\|?*]/g, '_')} - ${baseName}`;
  }
  return baseName;
}

// Was this song already copied here on an earlier run? Same name and the same
// length (within 2 s) — then don't copy it again as "Song (2).mp3".
// Where a copied song lands: "Artist - Title" plus its final extension
// (WMA is converted to MP3).
function pullTargetPath(destDir, filename, metadata) {
  let ext = knownAudioExt(filename) || '.mp3';
  if (WMA_EXTENSIONS.has(ext)) ext = '.mp3';
  return path.join(destDir, pullBaseName(filename, metadata) + ext);
}

async function findEarlierCopy(destDir, filename, metadata) {
  const durationMs = Number(metadata?.duration) || 0;
  if (!durationMs) return null;
  const candidate = pullTargetPath(destDir, filename, metadata);
  try {
    const stats = await fs.stat(candidate);
    const { parseFile } = await import('music-metadata');
    const md = await parseFile(candidate, { duration: true });
    const secs = md.format.duration || 0;
    if (secs && Math.abs(secs - durationMs / 1000) <= 2) return { path: candidate, size: stats.size };
  } catch { /* not there, or unreadable */ }
  return null;
}

// Before a copy: which songs would land on a file name that's already taken
// by something that isn't the same song (same length)?
ipcMain.handle('zune-pull-check', async (event, destDir, items) => {
  const conflicts = [];
  if (typeof destDir !== 'string' || !Array.isArray(items)) return { conflicts };
  for (let i = 0; i < items.length; i++) {
    const { filename, metadata } = items[i] || {};
    if (typeof filename !== 'string') continue;
    const target = pullTargetPath(destDir, filename, metadata);
    try { await fs.access(target); } catch { continue; } // free
    if (await findEarlierCopy(destDir, filename, metadata)) continue; // same song: skipped anyway
    conflicts.push({ index: i, name: path.basename(target) });
  }
  return { conflicts };
});

// Removing one song from the Zune. Returns 'remove' | 'copy' | 'cancel'.
ipcMain.handle('zune-remove-ask', async (event, name, localPath, counts = {}) => {
  const song = String(name || 'this song').slice(0, 200);
  const total = Number(counts?.total) || 1;
  const missing = Number(counts?.missing) || 0;
  if (total > 1) {
    if (!missing) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question', buttons: ['Remove from Zune', 'Cancel'], defaultId: 0, cancelId: 1,
        message: `Remove ${total} songs from your Zune?`,
        detail: 'They all stay on your computer.',
      });
      return response === 0 ? 'remove' : 'cancel';
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Copy to Computer, Then Remove', 'Remove Without Copying', 'Cancel'],
      defaultId: 0, cancelId: 2,
      message: `${missing} of these ${total} songs ${missing === 1 ? 'isn\u2019t' : 'aren\u2019t'} on your computer`,
      detail: 'Copy them to your computer first? Each one is only removed from the Zune once its copy has worked. The others are already on your computer and are just removed from the Zune.',
    });
    return ['copy', 'remove', 'cancel'][response] || 'cancel';
  }
  if (typeof localPath === 'string' && localPath) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Remove from Zune', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Remove \u201c${song}\u201d from your Zune?`,
      detail: `It stays on your computer:\n${localPath}`,
    });
    return response === 0 ? 'remove' : 'cancel';
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Copy to Computer, Then Remove', 'Remove Without Copying', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `\u201c${song}\u201d isn\u2019t on your computer`,
    detail: 'If you remove it from the Zune now, you won\u2019t have a copy anywhere. Copy it to your computer first? It\u2019s only removed from the Zune once the copy has worked.',
  });
  return ['copy', 'remove', 'cancel'][response] || 'cancel';
});

// Ask once what to do with name clashes. Returns 'skip' | 'keep' | 'replace' | 'cancel'.
ipcMain.handle('zune-pull-ask-conflicts', async (event, conflicts) => {
  const list = Array.isArray(conflicts) ? conflicts : [];
  const shown = list.slice(0, 8).map(c => '\u2022 ' + c.name).join('\n') + (list.length > 8 ? `\n\u2026and ${list.length - 8} more` : '');
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Skip them', 'Keep both', 'Replace', 'Cancel'],
    defaultId: 0,
    cancelId: 3,
    message: `${list.length} song${list.length === 1 ? ' has' : 's have'} the same name as a different file already in that folder`,
    detail: `${shown}\n\nSkip them: don't copy these songs.\nKeep both: save the new ones as "Song (2)".\nReplace: move the existing files to the Trash and save the new ones in their place.`,
  });
  return ['skip', 'keep', 'replace', 'cancel'][response] || 'cancel';
});

// Earlier copies saved with a wrong "extension" (e.g. "Song (FULL).com"):
// give them the right one so the library sees them as music again.
ipcMain.handle('zune-repair-copy-names', async (event, destDir) => {
  const renamed = [];
  if (typeof destDir !== 'string' || !isAllowedPath(destDir)) return { renamed };
  let names = [];
  try { names = await fs.readdir(destDir); } catch { return { renamed }; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (AUDIO_EXTS.has(ext)) continue;
    const from = path.join(destDir, name);
    let head;
    try {
      const st = await fs.stat(from);
      if (!st.isFile() || st.size < 1024) continue;
      const fh = await fs.open(from, 'r');
      try { head = Buffer.alloc(16); await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
    } catch { continue; }
    const real = sniffAudioExt(head);
    if (!real) continue;
    // ".com" etc. was a leftover of the title; drop short fake extensions
    const base = ext && ext.length <= 5 && !/\s/.test(ext) ? path.basename(name, ext) : name;
    const to = await uniqueDestPath(destDir, base, real);
    try {
      await fs.rename(from, to);
      renamed.push({ from, to });
    } catch { /* leave it */ }
  }
  return { renamed };
});

ipcMain.handle('zune-pull-file', async (event, handle, filename, destDir, metadata, onConflict = 'keep') => {
  const tempFiles = [];
  try {
    const earlier = await findEarlierCopy(destDir, filename, metadata);
    if (earlier) return { success: true, path: earlier.path, size: earlier.size, alreadyCopied: true };

    // A different file already has this name: do what the person chose
    const target = pullTargetPath(destDir, filename, metadata);
    let taken = false;
    try { await fs.access(target); taken = true; } catch { /* free */ }
    if (taken && onConflict === 'skip') return { success: true, skipped: true, path: target };
    // Where to save: the exact name when replacing (old file goes to the Trash), else a free name
    const destFor = async (base, ext) => {
      if (taken && onConflict === 'replace') {
        const exact = path.join(destDir, base + ext);
        try { await shell.trashItem(exact); } catch { /* already gone */ }
        return exact;
      }
      return uniqueDestPath(destDir, base, ext);
    };

    const data = await zuneManager.getFile(handle);
    if (!data || data.length === 0) {
      console.error(`zune-pull-file: handle ${handle} returned empty data (0 bytes)`);
      return { success: false, error: 'Device returned empty file (0 bytes)' };
    }
    // The file type comes from what's actually in the file; the Zune's file
    // name may have no extension, or something like ".com" from a title
    let ext = sniffAudioExt(data) || knownAudioExt(filename) || '.mp3';
    let baseName;

    // Use title as filename if available (ZMDB filenames can be cryptic)
    baseName = pullBaseName(filename, metadata);

    // Save raw file to temp location first
    const tempRaw = path.join(os.tmpdir(), `zune-pull-${Date.now()}-${baseName}${ext}`);
    await fs.writeFile(tempRaw, data);
    tempFiles.push(tempRaw);

    let finalPath;
    let cleanTagsAfterMove = false;

    if (WMA_EXTENSIONS.has(ext)) {
      // Convert WMA → MP3 via ffmpeg
      finalPath = await destFor(baseName, '.mp3');

      const ffArgs = ['-i', tempRaw];

      // Embed album art if available (base64 data URL → temp file)
      let tempArt = null;
      const albumArt = metadata?.albumArt;
      if (albumArt && albumArt.startsWith('data:image/')) {
        try {
          const match = albumArt.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const artExt = match[1] === 'jpeg' ? 'jpg' : match[1];
            tempArt = path.join(os.tmpdir(), `zune-art-${Date.now()}.${artExt}`);
            await fs.writeFile(tempArt, Buffer.from(match[2], 'base64'));
            tempFiles.push(tempArt);
            ffArgs.push('-i', tempArt);
          }
        } catch (_) { /* art embedding is best-effort */ }
      }

      ffArgs.push(
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ar', '44100',
        '-ac', '2',
      );

      // Map audio from input 0, art from input 1 (if present)
      if (tempArt) {
        ffArgs.push(
          '-map', '0:a',
          '-map', '1:0',
          '-c:v', 'copy',
          '-id3v2_version', '3',
          '-metadata:s:v', 'title=Album cover',
          '-metadata:s:v', 'comment=Cover (front)',
        );
      }

      // Embed text metadata
      // Cleaned names replace the WMA's own junk tags (empty clears a field)
      if (metadata?.cleaned) {
        if (!metadata.artist) ffArgs.push('-metadata', 'artist=');
        if (!metadata.album) ffArgs.push('-metadata', 'album=');
      }
      if (metadata?.title) ffArgs.push('-metadata', `title=${metadata.title}`);
      if (metadata?.artist) ffArgs.push('-metadata', `artist=${metadata.artist}`);
      if (metadata?.album) ffArgs.push('-metadata', `album=${metadata.album}`);
      if (metadata?.genre) ffArgs.push('-metadata', `genre=${metadata.genre}`);
      if (metadata?.trackNumber) ffArgs.push('-metadata', `track=${metadata.trackNumber}`);

      ffArgs.push('-y', finalPath);

      try {
        await execFileAsync(ffmpegPath, ffArgs);
      } catch (err) {
        // Don't leave a half-written MP3 behind for the retry to dodge around
        await fs.unlink(finalPath).catch(() => {});
        throw err;
      }
    } else {
      // MP3/AAC — just move to destination (already playable)
      finalPath = await destFor(baseName, ext);
      cleanTagsAfterMove = !!metadata?.cleaned;
      await fs.rename(tempRaw, finalPath).catch(async () => {
        // rename fails across filesystems, fall back to copy+delete
        await fs.copyFile(tempRaw, finalPath);
      });
    }

    // The Zune's tags had junk (website names, ID codes): put the cleaned
    // ones into the copied file as well. Best-effort; the copy is kept anyway.
    if (cleanTagsAfterMove && songFixer) {
      try {
        await songFixer._rewrite(finalPath, {
          title: metadata.title || '', artist: metadata.artist || '', album: metadata.album || '',
        });
      } catch (err) {
        console.log(`zune-pull-file: could not clean tags of ${path.basename(finalPath)}: ${err.message}`);
      }
    }

    const finalStats = await fs.stat(finalPath);
    return { success: true, path: finalPath, size: finalStats.size };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    for (const tmp of tempFiles) {
      try { await fs.unlink(tmp); } catch (_) { /* already cleaned or never created */ }
    }
  }
});

// Copy one podcast episode off the Zune and file it under a subscription.
// `item` is a device podcast entry from browseContents(). Returns
// { success:false, code:'NO_DOWNLOAD_DIR' } so the renderer can ask for a folder.
// Show artwork isn't read from the device: .ser objects synced by the Zune
// software don't expose it, and unsupported property reads stall the session.

ipcMain.handle('zune-pull-podcast-episode', async (event, item) => {
  const tempFiles = [];
  try {
    const data = await zuneManager.getFile(item.handle);
    if (!data || data.length === 0) {
      return { success: false, error: 'Device returned empty file (0 bytes)' };
    }

    const isWma = item.format === 0xB901;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const raw = path.join(os.tmpdir(), `zune-podcast-${stamp}${isWma ? '.wma' : '.mp3'}`);
    await fs.writeFile(raw, data);
    tempFiles.push(raw);

    let source = raw;
    if (isWma) {
      // WMA doesn't play in the app on macOS; keep podcasts as MP3
      source = path.join(os.tmpdir(), `zune-podcast-${stamp}.mp3`);
      await execFileAsync(ffmpegPath, ['-i', raw, '-c:a', 'libmp3lame', '-b:a', '128k', '-y', source]);
      tempFiles.push(source);
    }

    const result = podcastManager.importFromDevice(item, source);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, code: error.code, error: error.message };
  } finally {
    for (const tmp of tempFiles) {
      try { await fs.unlink(tmp); } catch (_) { /* moved into place or already gone */ }
    }
  }
});

ipcMain.handle('zune-eject', async () => {
  try {
    await zuneManager.eject();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-install-driver', async () => {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Only applicable on Windows' };
  }

  const infPath = app.isPackaged
    ? path.join(process.resourcesPath, 'zune-winusb.inf')
    : path.join(__dirname, '../../build-resources/zune-winusb.inf');

  // Verify the .inf file actually exists before attempting installation
  try {
    await fs.access(infPath);
  } catch {
    return { success: false, error: `Driver file not found: ${infPath}` };
  }

  // Write the install script to a temp file to avoid quoting hell
  const tmpScript = path.join(os.tmpdir(), 'zune-driver-install.ps1');
  const tmpLog = path.join(os.tmpdir(), 'zune-driver-install.log');
  // Build the script as an array of lines so the PowerShell here-string
  // closing "@ is guaranteed to start at column 0 (required by PS syntax).
  const scriptLines = [
    `$infSrc = "${infPath}"`,
    `$log    = "${tmpLog.replace(/\\/g, '\\\\')}"`,
    `$hwids  = @("USB\\VID_045E&PID_063E", "USB\\VID_045E&PID_0710")`,
    ``,
    `# Work in a temp directory so we can write the .cat alongside the .inf`,
    `$workDir = Join-Path $env:TEMP "zune-driver-pkg"`,
    `New-Item -ItemType Directory -Force -Path $workDir | Out-Null`,
    `$inf = Join-Path $workDir "zune-winusb.inf"`,
    `$cat = Join-Path $workDir "zune-winusb.cat"`,
    `Copy-Item $infSrc $inf -Force`,
    ``,
    `# 1. Create a self-signed code-signing cert (Zadig does the same thing)`,
    `$cert = New-SelfSignedCertificate \``,
    `    -Subject "CN=Zune Explorer Driver" \``,
    `    -Type CodeSigningCert \``,
    `    -KeyUsage DigitalSignature \``,
    `    -CertStoreLocation "Cert:\\LocalMachine\\My" \``,
    `    -NotAfter (Get-Date).AddYears(10)`,
    ``,
    `# 2. Trust the cert so Windows accepts driver packages signed with it`,
    `foreach ($store in @("Root", "TrustedPublisher")) {`,
    `    $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($store, "LocalMachine")`,
    `    $s.Open("ReadWrite"); $s.Add($cert); $s.Close()`,
    `}`,
    ``,
    `# 3. Create and sign the catalog file`,
    `New-FileCatalog -Path $inf -CatalogFilePath $cat -CatalogVersion 1 | Out-Null`,
    `Set-AuthenticodeSignature -FilePath $cat -Certificate $cert | Out-Null`,
    ``,
    `# 4. Stage + install the signed package`,
    `$out = pnputil /add-driver $inf /install 2>&1 | Out-String`,
    `Add-Content $log "pnputil: $out"`,
    ``,
    `# 5. Force-update any currently connected Zune from MTP to WinUSB`,
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class ZuneSetupApi {`,
    `    public const uint INSTALLFLAG_FORCE = 0x00000001;`,
    `    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]`,
    `    public static extern bool UpdateDriverForPlugAndPlayDevices(`,
    `        IntPtr hwndParent, string hardwareId, string fullInfPath,`,
    `        uint installFlags, ref bool bRebootRequired);`,
    `}`,
    `"@`,
    ``,
    `$reboot = $false`,
    `foreach ($hwid in $hwids) {`,
    `    [ZuneSetupApi]::UpdateDriverForPlugAndPlayDevices(`,
    `        [IntPtr]::Zero, $hwid, $inf,`,
    `        [ZuneSetupApi]::INSTALLFLAG_FORCE, [ref]$reboot) | Out-Null`,
    `}`,
    `Add-Content $log "done"`,
  ];
  const scriptContent = scriptLines.join('\r\n');

  try {
    await fs.writeFile(tmpScript, scriptContent, 'utf8');

    // Run the script elevated via UAC
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmpScript}' -Verb RunAs -Wait`
    ], { timeout: 60000 });

    // Read back the log written by the elevated script
    const log = await fs.readFile(tmpLog, 'utf8').catch(() => '(no log output)');
    console.log('zune-install-driver log:\n', log);
    if (log.includes('invalid') || log.includes('error') || log.includes('Error')) {
      return { success: false, error: log.trim() };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    await fs.unlink(tmpScript).catch(() => {});
    await fs.unlink(tmpLog).catch(() => {});
  }
});

// Metadata enrichment
ipcMain.handle('metadata-search', async (event, album, artist) => {
  try {
    const results = await musicbrainz.searchReleases(album, artist);
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-thumbnail', async (event, mbid) => {
  try {
    const dataUrl = await musicbrainz.getThumbnail(mbid);
    return { success: true, dataUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-fetch', async (event, mbid) => {
  try {
    const release = await musicbrainz.getRelease(mbid);
    const albumArt = await musicbrainz.getCoverArt(mbid);
    const result = { ...release, albumArt };
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Song fixer: recognise songs by audio (AcoustID) and rewrite their tags
ipcMain.handle('song-fixer-identify', async (event, filePath, libraryTrack) => {
  try {
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    const key = (preferences.get('songFixer.acoustidKey') || '').trim();
    const lt = libraryTrack && typeof libraryTrack === 'object' ? {
      title: String(libraryTrack.title || '').slice(0, 500),
      artist: String(libraryTrack.artist || '').slice(0, 500),
      album: String(libraryTrack.album || '').slice(0, 500),
      duration: Number(libraryTrack.duration) || 0,
      hint: libraryTrack.hint === true,
    } : {};
    const result = await songFixer.identify(filePath, key, lt);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('song-fixer-apply', async (event, batchId, filePath, tags, opts) => {
  try {
    if (!/^\d+$/.test(String(batchId))) throw new Error('Bad batch id');
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    const allowed = ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber', 'discNumber'];
    const clean = {};
    for (const k of allowed) if (tags && k in tags) clean[k] = tags[k] == null ? '' : String(tags[k]).slice(0, 500);
    const result = await songFixer.apply(String(batchId), filePath, clean, {
      releaseGroupId: /^[0-9a-f-]{36}$/i.test(opts?.releaseGroupId || '') ? opts.releaseGroupId : null,
      addCover: opts?.addCover !== false,
    });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('song-fixer-undo-info', async () => songFixer.undoInfo());
ipcMain.handle('song-fixer-zune-pending', async () => songFixer.zunePending());
ipcMain.handle('song-fixer-ignored-get', async () => songFixer.ignoredGet());
ipcMain.handle('song-fixer-ignored-set', async (event, paths, ignore) => {
  if (Array.isArray(paths)) await songFixer.ignoredSet(paths.filter(p => typeof p === 'string' && isAllowedPath(p)), !!ignore);
});
ipcMain.handle('song-fixer-confirmed-get', async () => songFixer.confirmedGet());
ipcMain.handle('song-fixer-confirmed-add', async (event, paths) => {
  if (Array.isArray(paths)) await songFixer.confirmedAdd(paths.filter(p => typeof p === 'string' && isAllowedPath(p)));
});

// Cover art for one release from the Cover Art Archive, as bytes (or null)
async function coverForRelease(mbid) {
  const dataUrl = await musicbrainz.getCoverArt(mbid);
  const m = dataUrl && dataUrl.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
  return m ? Buffer.from(m[2], 'base64') : null;
}

// Find album art online: by album + artist, else via the song's own title
async function findAlbumArt({ title, artist, album }) {
  const clean = (v) => String(v || '').replace(/["\\]/g, ' ').trim();
  const junk = (v) => !clean(v) || /^unknown (artist|album)$/i.test(clean(v));
  const tried = new Set();
  const tryReleases = async (ids) => {
    for (const id of ids.slice(0, 4)) {
      if (!id || tried.has(id)) continue;
      tried.add(id);
      const img = await coverForRelease(id).catch(() => null);
      if (img && img.length > 1000) return img;
    }
    return null;
  };
  if (!junk(album) && !junk(artist)) {
    const releases = await musicbrainz.searchReleases(clean(album), clean(artist)).catch(() => []);
    const img = await tryReleases(releases.map(r => r.mbid));
    if (img) return img;
  }
  if (!junk(title) && !junk(artist)) {
    const res = await musicbrainz.searchRecordings(`recording:"${clean(title)}" AND artist:"${clean(artist)}"`, 5).catch(() => null);
    const ids = [];
    for (const rec of res?.recordings || []) for (const rel of rec.releases || []) ids.push(rel.id);
    const img = await tryReleases(ids);
    if (img) return img;
  }
  return null;
}

// Any picture (e.g. a WebP artist photo) as a JPEG, via ffmpeg. null if it can't be read.
function imageToJpeg(buf, max = 1000) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${max},iw)':-2`, '-q:v', '3', '-f', 'mjpeg', 'pipe:1'], { timeout: 20000 });
    const out = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 ? Buffer.concat(out) : null));
    proc.stdin.on('error', () => {});
    proc.stdin.end(buf);
  });
}

// A big picture made smaller for the Zune (at most 1000 pixels across), as JPEG
function shrinkForZune(img) {
  const { width, height } = img.getSize();
  if (width > 1000 || height > 1000) img = img.resize(width >= height ? { width: 1000 } : { height: 1000 });
  return img.toJPEG(90);
}

ipcMain.handle('song-fixer-standins-get', async () => {
  try { return { success: true, standIns: await songFixer.standInsGet() }; } catch (error) { return { success: false, error: error.message }; }
});

// Add album art to one song: from an image file the person picked, a picture
// they copied, a cover made in the window, or found (same album, online,
// artist's photo, identify by sound)
ipcMain.handle('song-fixer-add-art', async (event, batchId, filePath, info, opts) => {
  try {
    if (!/^\d+$/.test(String(batchId))) throw new Error('Bad batch id');
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    let image = null;
    let source = 'image';
    let standIn = null;
    let names = null;
    if (opts?.imagePath) {
      if (typeof opts.imagePath !== 'string') throw new Error('Bad image');
      image = await fs.readFile(opts.imagePath);
    } else if (opts?.fromClipboard) {
      const img = clipboard.readImage();
      if (img.isEmpty()) throw new Error('no picture copied \u2014 right-click the cover in your browser, choose \u201cCopy Image\u201d, then paste again');
      image = shrinkForZune(img);
      source = 'pasted';
    } else if (opts?.imageData) {
      image = Buffer.from(opts.imageData);
      if (image.length > 8 * 1024 * 1024 || !isCoverImage(image)) throw new Error('Bad image');
      if (opts.standIn === 'made') { standIn = 'made'; source = 'made'; }
    } else {
      // Skip the lookup for songs that already have art (unless replacing)
      if (!opts?.replace) {
        const tags = await songFixer.readTags(filePath).catch(() => null);
        if (tags?.hasCover) return { success: true, added: false, skipped: 'already has album art' };
      }
      const siblings = Array.isArray(opts?.siblings)
        ? opts.siblings.filter(p => typeof p === 'string' && p !== filePath && isAllowedPath(p)).slice(0, 3) : [];
      const found = await coverFinder.find(info || {}, { path: filePath, siblings, standIns: !!opts?.standIns });
      if (!found) return { success: true, added: false, skipped: 'no album art found online' };
      if (found.needsMade) return { success: true, added: false, needsMade: true };
      ({ image, source } = found);
      standIn = found.standIn || null;
      if (found.names) names = { title: found.names.title || '', artist: found.names.artist || '', album: found.names.album || '' };
    }
    const r = await songFixer.addCover(String(batchId), filePath, image, { replace: !!opts?.replace, standIn });
    return { success: true, ...r, source, names };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Website names out of one song's tags
ipcMain.handle('song-fixer-strip-sites', async (event, batchId, filePath) => {
  try {
    if (!/^\d+$/.test(String(batchId))) throw new Error('Bad batch id');
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    return { success: true, ...(await songFixer.stripSites(String(batchId), filePath)) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Find album art that is a website's picture (read from every song's file)
let coverScanStop = false;
ipcMain.handle('song-fixer-cover-scan-stop', async () => { coverScanStop = true; });
ipcMain.handle('song-fixer-cover-scan', async (event, paths) => {
  try {
    if (!Array.isArray(paths)) throw new Error('Bad request');
    const ok = paths.filter(p => typeof p === 'string' && isAllowedPath(p));
    coverScanStop = false;
    let read = 0;
    const groups = await songFixer.coverScan(ok, (done, total) => {
      read = done;
      if (!event.sender.isDestroyed()) event.sender.send('song-fixer-cover-progress', { done, total });
    }, () => coverScanStop);
    return { success: true, groups, stopped: coverScanStop, read, total: ok.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('song-fixer-remove-cover', async (event, batchId, filePath, hash) => {
  try {
    if (!/^\d+$/.test(String(batchId))) throw new Error('Bad batch id');
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    if (!/^[0-9a-f]{40}$/.test(String(hash))) throw new Error('Bad picture id');
    return { success: true, ...(await songFixer.removeCover(String(batchId), filePath, hash)) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ---- Import new music, audio CDs -------------------------------------------
let mediaStop = false;
let lastDisc = null;
const sendMediaProgress = (event, data) => { if (!event.sender.isDestroyed()) event.sender.send('media-progress', data); };

ipcMain.handle('import-scan', async (event, folders, libraryFolders) => {
  try {
    const ok = (Array.isArray(folders) ? folders : []).filter(f => typeof f === 'string' && isAllowedPath(f));
    const lib = (Array.isArray(libraryFolders) ? libraryFolders : []).filter(f => typeof f === 'string');
    return { success: true, items: await mediaTools.scan(ok, lib) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-files', async (event, items, musicRoot, opts) => {
  try {
    if (typeof musicRoot !== 'string' || !isAllowedPath(musicRoot)) throw new Error('Music folder not allowed');
    mediaStop = false;
    const done = [];
    const failed = [];
    const list = (Array.isArray(items) ? items : []).filter(i => i && typeof i.path === 'string' && isAllowedPath(i.path));
    for (let i = 0; i < list.length; i++) {
      if (mediaStop) break;
      const it = list[i];
      sendMediaProgress(event, { kind: 'import', index: i, total: list.length, name: path.basename(it.path) });
      const tags = {};
      for (const k of ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber']) {
        if (it.tags && it.tags[k] != null) tags[k] = String(it.tags[k]).slice(0, 300);
      }
      try {
        const r = await mediaTools.importFile(it.path, tags, musicRoot, { move: opts?.move !== false, findArt: opts?.findArt !== false });
        done.push({ from: it.path, to: r.path, artAdded: r.artAdded });
      } catch (err) {
        failed.push({ path: it.path, error: err.message });
      }
    }
    return { success: true, done, failed, stopped: mediaStop };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-ignore', async (event, paths) => {
  if (Array.isArray(paths)) await mediaTools.ignore(paths.filter(p => typeof p === 'string' && isAllowedPath(p)));
});

ipcMain.handle('media-stop', async () => { mediaStop = true; });

ipcMain.handle('cd-find', async () => {
  try {
    const r = await mediaTools.findAudioCd();
    lastDisc = r.disc || null;
    return { success: true, ...r };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cd-lookup', async () => {
  try {
    return { success: true, candidates: await mediaTools.lookupDisc(lastDisc) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cd-rip', async (event, req) => {
  try {
    if (!lastDisc) throw new Error('no CD found \u2014 put one in and look again');
    if (typeof req?.musicRoot !== 'string' || !isAllowedPath(req.musicRoot)) throw new Error('Music folder not allowed');
    const str = (v) => (v == null ? '' : String(v).slice(0, 300));
    const byN = new Map(lastDisc.tracks.map(t => [t.n, t]));
    const tracks = (req.tracks || []).filter(t => byN.has(Number(t.n))).map(t => ({
      n: Number(t.n), file: byN.get(Number(t.n)).file, title: str(t.title), artist: str(t.artist),
    }));
    const a = req.album || {};
    const album = {
      album: str(a.album), albumArtist: str(a.albumArtist), year: str(a.year), genre: str(a.genre),
      disc: Number(a.disc) || 1, discs: Number(a.discs) || 1, trackCount: lastDisc.tracks.length,
      releaseId: /^[0-9a-f-]{36}$/i.test(a.releaseId || '') ? a.releaseId : null,
    };
    mediaStop = false;
    const r = await mediaTools.rip(tracks, album, req.musicRoot, req.format,
      (p) => sendMediaProgress(event, { kind: 'rip', ...p }), () => mediaStop);
    return { success: true, ...r, stopped: mediaStop };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cd-eject', async () => {
  try { if (lastDisc) await mediaTools.ejectCd(lastDisc.volume); lastDisc = null; return { success: true }; } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('burn-status', async () => mediaTools.burnStatus());

ipcMain.handle('burn-cd', async (event, paths) => {
  try {
    const ok = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && isAllowedPath(p));
    mediaStop = false;
    await mediaTools.burn(ok, (p) => sendMediaProgress(event, { kind: 'burn', ...p }), () => mediaStop);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Restoring sound: before/after clips, and the real thing
const restoreOpts = (o) => ({ volume: !!o?.volume, hiss: !!o?.hiss, clicks: !!o?.clicks, rumble: !!o?.rumble });
ipcMain.handle('song-fixer-restore-preview', async (event, filePath, opts) => {
  try {
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    return { success: true, ...(await songFixer.restorePreview(filePath, restoreOpts(opts))) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
ipcMain.handle('song-fixer-restore', async (event, batchId, filePath, opts) => {
  try {
    if (!/^\d+$/.test(String(batchId))) throw new Error('Bad batch id');
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    return { success: true, ...(await songFixer.restore(String(batchId), filePath, restoreOpts(opts))) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Sound quality: measured cutoffs (fake 320s), saved between runs
let qualityStop = false;
ipcMain.handle('quality-known', async () => songFixer.qualityKnown());
ipcMain.handle('quality-scan', async (event, items) => {
  try {
    if (!Array.isArray(items)) throw new Error('Bad request');
    const ok = items.filter(i => i && typeof i.path === 'string' && isAllowedPath(i.path))
      .map(i => ({ path: i.path, duration: Number(i.duration) || 0 }));
    qualityStop = false;
    const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, data); };
    let batch = [];
    const flush = () => { if (batch.length) { send('quality-results', batch); batch = []; } };
    const r = await songFixer.qualityScan(ok, {
      onResult: (p, cutoffHz) => { batch.push([p, cutoffHz]); if (batch.length >= 25) flush(); },
      onProgress: (done, total) => { flush(); send('quality-progress', { done, total }); },
      shouldStop: () => qualityStop,
    });
    flush();
    return { success: true, ...r };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
ipcMain.handle('quality-scan-stop', async () => { qualityStop = true; });

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose album art',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('song-fixer-trash', async (event, paths, opts) => {
  try {
    if (!Array.isArray(paths)) throw new Error('Bad request');
    const ok = paths.filter(p => typeof p === 'string' && isAllowedPath(p));
    const keepers = {};
    if (opts?.keepers && typeof opts.keepers === 'object') {
      for (const [k, v] of Object.entries(opts.keepers)) {
        if (Array.isArray(v)) keepers[k] = v.filter(x => typeof x === 'string').slice(0, 50);
      }
    }
    const result = await songFixer.trash(ok, { removeFromZune: !!opts?.removeFromZune, keepers });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
ipcMain.handle('song-fixer-zune-removed', async (event, paths) => {
  if (Array.isArray(paths)) await songFixer.zuneMarkRemoved(paths.filter(p => typeof p === 'string'));
});
ipcMain.handle('song-fixer-zune-done', async (event, paths) => {
  if (Array.isArray(paths)) await songFixer.zuneDone(paths.filter(p => typeof p === 'string'));
});

ipcMain.handle('song-fixer-undo', async () => {
  try {
    return { success: true, ...(await songFixer.undoLast()) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-cache-get', async (event, artist, album) => {
  const data = await metadataCache.get(artist, album);
  return { success: true, data };
});

ipcMain.handle('metadata-cache-set', async (event, artist, album, data) => {
  await metadataCache.set(artist, album, data);
  return { success: true };
});

ipcMain.handle('metadata-cache-get-all', async () => {
  const data = await metadataCache.getAll();
  return { success: true, data };
});

// Artist images: every handler is a no-op unless the user turned them on,
// so nothing is downloaded without opt-in.
function artistImageHandler(method) {
  return async (_event, name) => {
    if (!preferences.get('artistImages.enabled') || typeof name !== 'string' || !artistImages) return null;
    try {
      return (await artistImages[method](name)) || null;
    } catch (err) {
      console.error(`artist image ${method} failed`, err);
      return null;
    }
  };
}
ipcMain.handle('artist-image-get', artistImageHandler('get'));
ipcMain.handle('artist-image-find', artistImageHandler('find'));
ipcMain.handle('artist-image-next', artistImageHandler('next'));
ipcMain.handle('artist-image-remove', artistImageHandler('remove'));
ipcMain.handle('artist-image-restore', artistImageHandler('restore'));
ipcMain.handle('artist-image-state', artistImageHandler('state'));

ipcMain.handle('clear-artist-images', async () => {
  try {
    if (artistImages) await artistImages.clear();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('window-minimize', async () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window-maximize', async () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', async () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

// --- Podcasts ---

ipcMain.handle('podcast-search', async (event, query) => {
  try {
    const results = await podcastManager.search(query);
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-subscribe', async (event, feedUrl) => {
  try {
    const subscription = await podcastManager.subscribe(feedUrl);
    return { success: true, subscription };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-unsubscribe', async (event, subscriptionId) => {
  try {
    podcastManager.unsubscribe(subscriptionId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-pick-opml-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'OPML Files', extensions: ['opml', 'xml'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, cancelled: true };
  }
  return { success: true, filePath: result.filePaths[0] };
});

ipcMain.handle('podcast-import-opml', async (event, filePath) => {
  try {
    const count = await podcastManager.importOPML(filePath, mainWindow?.webContents);
    return { success: true, count };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-refresh', async (event, subscriptionId) => {
  try {
    if (subscriptionId) {
      const result = await podcastManager.refresh(subscriptionId);
      return { success: true, result };
    } else {
      await podcastManager.refreshAll(mainWindow?.webContents);
      return { success: true };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-get-subscriptions', async () => {
  try {
    const subscriptions = podcastManager.getSubscriptions();
    return { success: true, subscriptions };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-get-episodes', async (event, subscriptionId) => {
  try {
    const episodes = podcastManager.getEpisodes(subscriptionId);
    return { success: true, episodes };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-download-episode', async (event, subscriptionId, episodeId) => {
  try {
    const localPath = await podcastManager.downloadEpisode(subscriptionId, episodeId, mainWindow?.webContents);
    return { success: true, localPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-cancel-download', async (event, episodeId) => {
  try {
    podcastManager.cancelDownload(episodeId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-delete-download', async (event, subscriptionId, episodeId) => {
  try {
    podcastManager.deleteDownload(subscriptionId, episodeId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-save-playback-position', async (event, subscriptionId, episodeId, position) => {
  try {
    podcastManager.savePlaybackPosition(subscriptionId, episodeId, position);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-mark-played', async (event, subscriptionId, episodeId, played) => {
  try {
    podcastManager.markPlayed(subscriptionId, episodeId, played);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-get-all-downloaded', async () => {
  try {
    return { success: true, episodes: podcastManager.getAllDownloaded() };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-update-position-from-sync', async (event, subscriptionId, episodeId, positionSeconds, played) => {
  try {
    return { success: podcastManager.updatePositionFromSync(subscriptionId, episodeId, positionSeconds, played) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-get-preferences', async () => {
  try {
    const preferences = podcastManager.getPreferences();
    return { success: true, preferences };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('podcast-pick-download-directory', async () => {
  try {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({
      title: 'Choose Podcast Download Directory',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: preferences.get('podcasts.downloadDirectory') || undefined,
    });
    if (r.canceled || !r.filePaths || r.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }
    await preferences.update({ podcasts: { downloadDirectory: r.filePaths[0] } });
    return { success: true, directory: r.filePaths[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-user-data-path', async () => {
  return app.getPath('userData');
});
