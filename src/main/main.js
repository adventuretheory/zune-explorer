const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

const zuneManager = new ZuneManager();
let deviceCache = null; // initialized after app.whenReady
let metadataCache;
let songFixer;
let artistImages = null;
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

app.on('before-quit', () => {
  if (podcastManager) podcastManager.persistLastPlaybackState();
});

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
          albumArt: null
        };
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

ipcMain.handle('zune-send-files', async (event, filePaths) => {
  try {
    const result = await zuneManager.sendFiles(filePaths);
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

// Add album art to one song: from an image file the person picked, or found online
ipcMain.handle('song-fixer-add-art', async (event, batchId, filePath, info, opts) => {
  try {
    if (!/^\d+$/.test(String(batchId))) throw new Error('Bad batch id');
    if (typeof filePath !== 'string' || !isAllowedPath(filePath)) throw new Error('Path not allowed');
    let image = null;
    if (opts?.imagePath) {
      if (typeof opts.imagePath !== 'string') throw new Error('Bad image');
      image = await fs.readFile(opts.imagePath);
    } else {
      // Skip the lookup for songs that already have art (unless replacing)
      if (!opts?.replace) {
        const tags = await songFixer.readTags(filePath).catch(() => null);
        if (tags?.hasCover) return { success: true, added: false, skipped: 'already has album art' };
      }
      image = await findAlbumArt(info || {});
      if (!image) return { success: true, added: false, skipped: 'no album art found online' };
    }
    const r = await songFixer.addCover(String(batchId), filePath, image, { replace: !!opts?.replace });
    return { success: true, ...r };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

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
