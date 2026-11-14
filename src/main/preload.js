const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDirectoryContents: (path) => ipcRenderer.invoke('get-directory-contents', path),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
  deleteFile: (path) => ipcRenderer.invoke('delete-file', path),
  getAppIcon: (path) => ipcRenderer.invoke('get-app-icon', path),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getSpecialFolders: () => ipcRenderer.invoke('get-special-folders'),
  getExternalVolumes: () => ipcRenderer.invoke('get-external-volumes'),
  scanApplications: () => ipcRenderer.invoke('scan-applications'),
  getAudioMetadata: (path) => ipcRenderer.invoke('get-audio-metadata', path),
  getPlayablePath: (filePath) => ipcRenderer.invoke('get-playable-path', filePath),
  batchScanAudioMetadata: (paths, options) => ipcRenderer.invoke('batch-scan-audio-metadata', paths, options),
  onMusicScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('music-scan-progress', handler);
    return handler;
  },
  offMusicScanProgress: (handler) => ipcRenderer.removeListener('music-scan-progress', handler),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // Zune sync
  zuneGetStatus: () => ipcRenderer.invoke('zune-get-status'),
  zuneDeviceInfo: () => ipcRenderer.invoke('zune-device-info'),
  zuneSendFiles: (paths, opts) => ipcRenderer.invoke('zune-send-files', paths, opts),
  zuneCancelTransfer: () => ipcRenderer.invoke('zune-cancel-transfer'),
  zuneSendPodcastEpisodes: (refs) => ipcRenderer.invoke('zune-send-podcast-episodes', refs),
  zuneSetPodcastBookmarks: (writes) => ipcRenderer.invoke('zune-set-podcast-bookmarks', writes),
  zunePullPodcastEpisode: (item) => ipcRenderer.invoke('zune-pull-podcast-episode', item),
  zuneBrowseContents: () => ipcRenderer.invoke('zune-browse-contents'),
  zuneDeleteObjects: (handles) => ipcRenderer.invoke('zune-delete-objects', handles),
  zuneRetag: (edits) => ipcRenderer.invoke('zune-retag', edits),
  lyricsGet: (info) => ipcRenderer.invoke('lyrics-get', info),
  zuneSavePlaylist: (name, trackHandles, replaceHandle) => ipcRenderer.invoke('zune-save-playlist', name, trackHandles, replaceHandle),
  zuneRemoveAsk: (name, localPath, counts) => ipcRenderer.invoke('zune-remove-ask', name, localPath, counts),
  zuneEject: () => ipcRenderer.invoke('zune-eject'),
  zuneCacheLoad: (deviceKey) => ipcRenderer.invoke('zune-cache-load', deviceKey),
  zuneCacheLatest: () => ipcRenderer.invoke('zune-cache-latest'),
  zuneCacheSave: (deviceKey, data) => ipcRenderer.invoke('zune-cache-save', deviceKey, data),
  zuneCacheInvalidate: (deviceKey) => ipcRenderer.invoke('zune-cache-invalidate', deviceKey),
  fixExtensionlessFiles: (paths) => ipcRenderer.invoke('fix-extensionless-files', paths),
  pickPullDestination: () => ipcRenderer.invoke('pick-pull-destination'),
  pinsLoad: () => ipcRenderer.invoke('pins-load'),
  pinsSave: (pins) => ipcRenderer.invoke('pins-save', pins),
  playlistsLoadAll: () => ipcRenderer.invoke('playlists-load-all'),
  playlistSave: (playlist) => ipcRenderer.invoke('playlist-save', playlist),
  playlistDelete: (id) => ipcRenderer.invoke('playlist-delete', id),
  nowPlayingLoad: () => ipcRenderer.invoke('now-playing-load'),
  nowPlayingSave: (data) => ipcRenderer.invoke('now-playing-save', data),
  zunePullFile: (handle, filename, destDir, metadata, onConflict) => ipcRenderer.invoke('zune-pull-file', handle, filename, destDir, metadata, onConflict),
  zunePullCheck: (destDir, items) => ipcRenderer.invoke('zune-pull-check', destDir, items),
  zuneRepairCopyNames: (destDir) => ipcRenderer.invoke('zune-repair-copy-names', destDir),
  zunePullAskConflicts: (conflicts) => ipcRenderer.invoke('zune-pull-ask-conflicts', conflicts),
  zuneProbeProperties: (handle) => ipcRenderer.invoke('zune-probe-properties', handle),
  zuneProbeWmdrmpd: () => ipcRenderer.invoke('zune-probe-wmdrmpd'),
  zuneInstallDriver: () => ipcRenderer.invoke('zune-install-driver'),
  onZuneStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('zune-status', handler);
    return handler;
  },
  offZuneStatus: (handler) => ipcRenderer.removeListener('zune-status', handler),
  onZuneTransferProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('zune-transfer-progress', handler);
    return handler;
  },
  offZuneTransferProgress: (handler) => ipcRenderer.removeListener('zune-transfer-progress', handler),
  onZuneBrowseProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('zune-browse-progress', handler);
    return handler;
  },
  offZuneBrowseProgress: (handler) => ipcRenderer.removeListener('zune-browse-progress', handler),
  onZuneDeleteProgress: (cb) => { const h = (e, d) => cb(d); ipcRenderer.on('zune-delete-progress', h); return h; },
  offZuneDeleteProgress: (h) => ipcRenderer.removeListener('zune-delete-progress', h),
  onZunePullProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('zune-pull-progress', handler);
    return handler;
  },
  offZunePullProgress: (handler) => ipcRenderer.removeListener('zune-pull-progress', handler),

  // Metadata enrichment
  metadataSearch: (album, artist) => ipcRenderer.invoke('metadata-search', album, artist),
  metadataThumbnail: (mbid) => ipcRenderer.invoke('metadata-thumbnail', mbid),
  metadataFetch: (mbid) => ipcRenderer.invoke('metadata-fetch', mbid),
  metadataCacheGet: (artist, album) => ipcRenderer.invoke('metadata-cache-get', artist, album),
  metadataCacheSet: (artist, album, data) => ipcRenderer.invoke('metadata-cache-set', artist, album, data),
  metadataCacheGetAll: () => ipcRenderer.invoke('metadata-cache-get-all'),

  // Artist images (all resolve null while artist images are turned off)
  artistImageGet: (name) => ipcRenderer.invoke('artist-image-get', name),
  artistImageFind: (name) => ipcRenderer.invoke('artist-image-find', name),
  artistImageNext: (name) => ipcRenderer.invoke('artist-image-next', name),
  artistImageRemove: (name) => ipcRenderer.invoke('artist-image-remove', name),
  artistImageRestore: (name) => ipcRenderer.invoke('artist-image-restore', name),
  artistImageState: (name) => ipcRenderer.invoke('artist-image-state', name),
  clearArtistImages: () => ipcRenderer.invoke('clear-artist-images'),

  // Drag-and-drop path resolution (sandbox-safe)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Podcasts — unwrap { success, ...data } responses from main process
  podcastSearch: async (query) => {
    const r = await ipcRenderer.invoke('podcast-search', query);
    if (!r.success) throw new Error(r.error);
    return r.results;
  },
  podcastSubscribe: async (feedUrl) => {
    const r = await ipcRenderer.invoke('podcast-subscribe', feedUrl);
    if (!r.success) throw new Error(r.error);
    return r.subscription;
  },
  podcastUnsubscribe: async (id) => {
    const r = await ipcRenderer.invoke('podcast-unsubscribe', id);
    if (!r.success) throw new Error(r.error);
  },
  podcastPickOpmlFile: async () => {
    const r = await ipcRenderer.invoke('podcast-pick-opml-file');
    if (r.cancelled) return null;
    return r.filePath;
  },
  podcastImportOpml: async (filePath) => {
    const r = await ipcRenderer.invoke('podcast-import-opml', filePath);
    if (!r.success) throw new Error(r.error);
    return r.count;
  },
  podcastRefresh: async (subscriptionId) => {
    const r = await ipcRenderer.invoke('podcast-refresh', subscriptionId);
    if (!r.success) throw new Error(r.error);
    return r.result || r.results;
  },
  podcastGetSubscriptions: async () => {
    const r = await ipcRenderer.invoke('podcast-get-subscriptions');
    if (!r.success) throw new Error(r.error);
    return r.subscriptions;
  },
  podcastGetEpisodes: async (subscriptionId) => {
    const r = await ipcRenderer.invoke('podcast-get-episodes', subscriptionId);
    if (!r.success) throw new Error(r.error);
    return r.episodes;
  },
  podcastDownloadEpisode: async (subId, epId) => {
    const r = await ipcRenderer.invoke('podcast-download-episode', subId, epId);
    if (!r.success) throw new Error(r.error);
    return r.localPath;
  },
  podcastCancelDownload: (epId) => ipcRenderer.invoke('podcast-cancel-download', epId),
  podcastDeleteDownload: (subId, epId) => ipcRenderer.invoke('podcast-delete-download', subId, epId),
  podcastSavePlaybackPosition: (subId, epId, pos) => ipcRenderer.invoke('podcast-save-playback-position', subId, epId, pos),
  podcastMarkPlayed: (subId, epId, played) => ipcRenderer.invoke('podcast-mark-played', subId, epId, played),
  podcastGetAllDownloaded: async () => {
    const r = await ipcRenderer.invoke('podcast-get-all-downloaded');
    if (!r.success) throw new Error(r.error);
    return r.episodes;
  },
  podcastUpdatePositionFromSync: (subId, epId, positionSeconds, played) =>
    ipcRenderer.invoke('podcast-update-position-from-sync', subId, epId, positionSeconds, played),
  podcastGetPreferences: async () => {
    const r = await ipcRenderer.invoke('podcast-get-preferences');
    if (!r.success) throw new Error(r.error);
    return r.preferences;
  },
  podcastPickDownloadDirectory: async () => {
    const r = await ipcRenderer.invoke('podcast-pick-download-directory');
    if (!r.success) return null;
    return r.directory;
  },
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  onPodcastDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('podcast-download-progress', handler);
    return handler;
  },
  offPodcastDownloadProgress: (handler) => ipcRenderer.removeListener('podcast-download-progress', handler),
  onPodcastDownloadComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('podcast-download-complete', handler);
    return handler;
  },
  offPodcastDownloadComplete: (handler) => ipcRenderer.removeListener('podcast-download-complete', handler),
  onPodcastDownloadError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('podcast-download-error', handler);
    return handler;
  },
  offPodcastDownloadError: (handler) => ipcRenderer.removeListener('podcast-download-error', handler),
  onPodcastRefreshComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('podcast-refresh-complete', handler);
    return handler;
  },
  offPodcastRefreshComplete: (handler) => ipcRenderer.removeListener('podcast-refresh-complete', handler),
  onPodcastImportProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('podcast-import-progress', handler);
    return handler;
  },
  offPodcastImportProgress: (handler) => ipcRenderer.removeListener('podcast-import-progress', handler),

  // Preferences, settings, and first-run
  preferencesLoad: () => ipcRenderer.invoke('preferences-load'),
  preferencesUpdate: (patch) => ipcRenderer.invoke('preferences-update', patch),
  preferencesReset: (section) => ipcRenderer.invoke('preferences-reset', section),
  onPreferencesChanged: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('preferences-changed', handler);
    return handler;
  },
  offPreferencesChanged: (h) => ipcRenderer.removeListener('preferences-changed', h),
  consumeFirstRun: () => ipcRenderer.invoke('consume-first-run'),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  songFixerIdentify: (filePath, libraryTrack) => ipcRenderer.invoke('song-fixer-identify', filePath, libraryTrack),
  songFixerApply: (batchId, filePath, tags, opts) => ipcRenderer.invoke('song-fixer-apply', batchId, filePath, tags, opts),
  songFixerUndoInfo: () => ipcRenderer.invoke('song-fixer-undo-info'),
  songFixerUndo: () => ipcRenderer.invoke('song-fixer-undo'),
  songFixerZunePending: () => ipcRenderer.invoke('song-fixer-zune-pending'),
  songFixerConfirmedGet: () => ipcRenderer.invoke('song-fixer-confirmed-get'),
  songFixerConfirmedAdd: (paths) => ipcRenderer.invoke('song-fixer-confirmed-add', paths),
  songFixerTrash: (paths, opts) => ipcRenderer.invoke('song-fixer-trash', paths, opts),
  songFixerAddArt: (batchId, filePath, info, opts) => ipcRenderer.invoke('song-fixer-add-art', batchId, filePath, info, opts),
  importScan: (folders, libraryFolders) => ipcRenderer.invoke('import-scan', folders, libraryFolders),
  importFiles: (items, musicRoot, opts) => ipcRenderer.invoke('import-files', items, musicRoot, opts),
  importIgnore: (paths) => ipcRenderer.invoke('import-ignore', paths),
  mediaStop: () => ipcRenderer.invoke('media-stop'),
  cdFind: () => ipcRenderer.invoke('cd-find'),
  cdLookup: () => ipcRenderer.invoke('cd-lookup'),
  cdRip: (req) => ipcRenderer.invoke('cd-rip', req),
  cdEject: () => ipcRenderer.invoke('cd-eject'),
  burnStatus: () => ipcRenderer.invoke('burn-status'),
  burnCd: (paths) => ipcRenderer.invoke('burn-cd', paths),
  onMediaProgress: (cb) => { const h = (e, d) => cb(d); ipcRenderer.on('media-progress', h); return h; },
  offMediaProgress: (h) => ipcRenderer.removeListener('media-progress', h),
  songFixerRestorePreview: (filePath, opts) => ipcRenderer.invoke('song-fixer-restore-preview', filePath, opts),
  songFixerRestore: (batchId, filePath, opts) => ipcRenderer.invoke('song-fixer-restore', batchId, filePath, opts),
  qualityKnown: () => ipcRenderer.invoke('quality-known'),
  qualityScan: (items) => ipcRenderer.invoke('quality-scan', items),
  qualityScanStop: () => ipcRenderer.invoke('quality-scan-stop'),
  onQualityResults: (cb) => { const h = (e, d) => cb(d); ipcRenderer.on('quality-results', h); return h; },
  offQualityResults: (h) => ipcRenderer.removeListener('quality-results', h),
  onQualityProgress: (cb) => { const h = (e, d) => cb(d); ipcRenderer.on('quality-progress', h); return h; },
  offQualityProgress: (h) => ipcRenderer.removeListener('quality-progress', h),
  songFixerStripSites: (batchId, filePath) => ipcRenderer.invoke('song-fixer-strip-sites', batchId, filePath),
  songFixerCoverScan: (paths) => ipcRenderer.invoke('song-fixer-cover-scan', paths),
  songFixerRemoveCover: (batchId, filePath, hash) => ipcRenderer.invoke('song-fixer-remove-cover', batchId, filePath, hash),
  onSongFixerCoverProgress: (cb) => {
    const handler = (e, data) => cb(data);
    ipcRenderer.on('song-fixer-cover-progress', handler);
    return handler;
  },
  offSongFixerCoverProgress: (handler) => ipcRenderer.removeListener('song-fixer-cover-progress', handler),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  songFixerZuneRemoved: (paths) => ipcRenderer.invoke('song-fixer-zune-removed', paths),
  songFixerZuneDone: (paths) => ipcRenderer.invoke('song-fixer-zune-done', paths),
  clearMetadataCache: () => ipcRenderer.invoke('clear-metadata-cache'),
  clearDeviceCache: () => ipcRenderer.invoke('clear-device-cache'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
