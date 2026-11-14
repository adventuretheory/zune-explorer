/* global document, window */
// Settings → import new music, and settings → CDs: rip & burn.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const fmtTime = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const home = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

/** Music folder picker (the library's music folders). */
function musicRootSelect(explorer, onChange) {
  const folders = explorer.preferences?.library?.music || [];
  const sel = el('select', 'song-sort-select');
  for (const f of folders) {
    const o = el('option', null, home(f));
    o.value = f;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange?.(sel.value));
  return sel;
}

/** Add songs to the library right away (they're picked up properly on the next scan too). */
async function addToLibrary(explorer, paths) {
  const known = new Set(explorer.categorizedFiles.music.map(f => f.path));
  for (const p of paths) {
    if (known.has(p)) continue;
    explorer.categorizedFiles.music.push({
      path: p, name: p.split(/[/\\]/).pop(), extension: '.' + p.split('.').pop().toLowerCase(),
      size: 0, modified: new Date(), isDirectory: false,
    });
  }
  if (paths.length) await window.electronAPI.batchScanAudioMetadata(paths, { includeArt: true });
}

/** "send N to zune" once songs are in (when a Zune is connected). */
function sendToZuneButton(explorer, paths, setStatus) {
  const zp = explorer.zunePanel;
  if (!paths.length) return null;
  const b = el('button', 'zune-sync-btn zune-push-btn', `send ${paths.length} to zune`);
  if (zp?.state !== 'connected') {
    b.disabled = true;
    b.title = 'connect your zune to send them';
  }
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'sending… (see the zune panel)';
    const r = await window.electronAPI.zuneSendFiles(paths);
    b.textContent = r.success ? `sent ${(r.succeeded || paths).length} to zune` : 'couldn’t send';
    if (!r.success) setStatus?.('sending failed: ' + r.error);
  });
  return b;
}

// ---------------------------------------------------------------------------
// Import new music
// ---------------------------------------------------------------------------

class ImportView {
  constructor(explorer) {
    this.explorer = explorer;
    this.items = null;     // [{ path, name, size, tags, proposal, selected, editing }]
    this.running = false;
    this.status = '';
    this.imported = [];
  }

  _prefs() { return this.explorer.preferences?.import || { folders: [], move: true, findArt: true }; }

  async render(container) {
    this.container = container;
    container.classList.add('song-fixer', 'media-view');
    if (!this.items && !this.running) await this.scan();
    this._draw();
  }

  async scan() {
    this.running = true;
    this.status = 'looking for new songs…';
    if (this.container) this._draw();
    const lib = this.explorer.preferences?.library?.music || [];
    const r = await window.electronAPI.importScan(this._prefs().folders || [], lib);
    this.running = false;
    if (!r.success) { this.items = []; this.status = 'couldn’t look: ' + r.error; return; }
    const logic = window.songFixerLogic;
    this.items = r.items.map(it => {
      // Proposed details: cleaned-up tags (website names, ID codes, "Artist - Title" in the name)
      const p = logic.cleanupProposal(it.tags || {}, it.path, new Set());
      const proposal = {
        title: p.title || it.tags?.title || it.name.replace(/\.[^.]+$/, ''),
        artist: p.artist || it.tags?.artist || '',
        album: p.clear?.includes('album') ? '' : (p.album || it.tags?.album || ''),
        albumArtist: it.tags?.albumArtist || '',
        year: it.tags?.year || '',
        trackNumber: it.tags?.trackNumber || '',
      };
      return { ...it, proposal, selected: true };
    });
    this.status = this.items.length
      ? `${this.items.length} new song${this.items.length === 1 ? '' : 's'} found.`
      : 'no new songs — everything in these folders is already in your library.';
  }

  _draw() {
    const c = this.container;
    if (!c) return;
    c.innerHTML = '';
    const prefs = this._prefs();

    c.appendChild(el('div', 'song-fixer-note',
      'finds songs you’ve bought or downloaded and brings them into your music folder: named Artist / Album / Title, details tidied, ' +
      'album art added, ready to send to your zune.'));

    // Watched folders
    const fw = el('div', 'media-row');
    fw.appendChild(el('span', 'song-fixer-dim', 'looking in: '));
    for (const f of prefs.folders || []) {
      const chip = el('span', 'media-chip', home(f));
      const x = el('button', 'media-chip-x', '✕');
      x.title = 'stop looking in this folder';
      x.addEventListener('click', async () => {
        const folders = (prefs.folders || []).filter(p => p !== f);
        await this._savePrefs({ folders });
        this.items = null;
        this.render(this.container);
      });
      chip.appendChild(x);
      fw.appendChild(chip);
    }
    const add = el('button', 'song-fixer-link', '+ add folder');
    add.addEventListener('click', async () => {
      const r = await window.electronAPI.pickFolder('Choose a folder to look for new music');
      if (r?.success && r.path) {
        await this._savePrefs({ folders: [...new Set([...(prefs.folders || []), r.path])] });
        this.items = null;
        this.render(this.container);
      }
    });
    fw.appendChild(add);
    c.appendChild(fw);

    // Where they go, and options
    const dest = el('div', 'media-row');
    dest.appendChild(el('span', 'song-fixer-dim', 'put them in: '));
    this.musicRoot = this.musicRoot || (this.explorer.preferences?.library?.music || [])[0];
    const rootSel = musicRootSelect(this.explorer, (v) => { this.musicRoot = v; });
    rootSel.value = this.musicRoot || '';
    dest.appendChild(rootSel);
    const opt = (label, key, help) => {
      const l = el('label', 'media-opt');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = prefs[key] !== false;
      cb.addEventListener('change', () => this._savePrefs({ [key]: cb.checked }));
      l.title = help;
      l.append(cb, document.createTextNode(' ' + label));
      return l;
    };
    dest.append(opt('find album art', 'findArt', 'looks up the cover online for songs that have none'),
      opt('move originals to the Trash', 'move', 'after copying into your music folder; untick to leave them where they are'));
    c.appendChild(dest);

    // Actions
    const bar = el('div', 'zune-diff-actions');
    const selected = (this.items || []).filter(i => i.selected);
    if (this.running) {
      const stop = el('button', 'zune-sync-btn zune-pull-btn', 'stop');
      stop.addEventListener('click', () => { window.electronAPI.mediaStop(); stop.disabled = true; stop.textContent = 'stopping after the current song…'; });
      bar.appendChild(stop);
    } else {
      const go = el('button', 'zune-sync-btn zune-push-btn', `import ${selected.length} song${selected.length === 1 ? '' : 's'}`);
      go.disabled = !selected.length || !this.musicRoot;
      go.addEventListener('click', () => this._import(selected));
      const idf = el('button', 'zune-sync-btn song-fixer-cleanup-btn', `identify ${selected.length} by sound`);
      idf.disabled = !selected.length;
      idf.title = 'listens to each song (AcoustID) and fills in the real title, artist and album';
      idf.addEventListener('click', () => this._identify(selected));
      const ign = el('button', 'zune-sync-btn', `ignore ${selected.length}`);
      ign.disabled = !selected.length;
      ign.title = 'don’t offer these again (e.g. sound effects, voice notes)';
      ign.addEventListener('click', async () => {
        await window.electronAPI.importIgnore(selected.map(i => i.path));
        this.items = this.items.filter(i => !i.selected);
        this.status = `${selected.length} ignored.`;
        this._draw();
      });
      const again = el('button', 'zune-rescan-link', 'look again');
      again.addEventListener('click', async () => { await this.scan(); this._draw(); });
      bar.append(go, idf, ign, again);
    }
    c.appendChild(bar);
    this.statusEl = el('div', 'song-fixer-status song-fixer-sites-status', this.status);
    c.appendChild(this.statusEl);
    if (this.imported.length && !this.running) {
      const b = sendToZuneButton(this.explorer, this.imported, (t) => { this.statusEl.textContent = t; });
      if (b) c.appendChild(b);
    }

    // The songs
    if (!this.items?.length) return;
    const all = el('label', 'zune-diff-select-all');
    const allBox = el('input');
    allBox.type = 'checkbox';
    allBox.checked = this.items.every(i => i.selected);
    allBox.addEventListener('change', () => { for (const i of this.items) i.selected = allBox.checked; this._draw(); });
    all.append(allBox, document.createTextNode(`${allBox.checked ? 'deselect' : 'select'} all (${this.items.length} songs)`));
    c.appendChild(all);
    for (const it of this.items) c.appendChild(this._row(it));
  }

  _row(it) {
    const row = el('div', 'zune-diff-item song-fixer-row');
    const box = el('input', 'zune-diff-check');
    box.type = 'checkbox';
    box.checked = it.selected;
    box.disabled = this.running;
    box.addEventListener('change', () => { it.selected = box.checked; this._draw(); });
    row.appendChild(box);
    const play = el('button', 'song-play-btn', '▶');
    play.title = 'play';
    play.addEventListener('click', () => this.explorer.audioPlayer.play({ path: it.path, name: it.name }, [{ path: it.path, name: it.name }]));
    row.appendChild(play);
    const info = el('div', 'zune-diff-info');
    const p = it.proposal;
    info.appendChild(el('div', 'zune-diff-title', p.title || it.name));
    info.appendChild(el('div', 'zune-diff-meta', `${p.artist || 'unknown artist'} — ${p.album || 'no album'}${it.found ? ' · identified by sound' : ''}`));
    info.appendChild(el('div', 'song-fixer-dim media-file', `${home(it.path)} · ${(it.size / 1048576).toFixed(1)} MB`));
    if (it.editing) {
      const ed = el('div', 'song-fixer-editor');
      for (const [k, label] of [['title', 'title'], ['artist', 'artist'], ['album', 'album']]) {
        const inp = el('input', 'zune-diff-filter-input');
        inp.placeholder = label;
        inp.value = p[k] || '';
        inp.addEventListener('input', () => { p[k] = inp.value; });
        ed.appendChild(inp);
      }
      const done = el('button', 'song-fixer-link song-fixer-edit', 'done');
      done.addEventListener('click', () => { it.editing = false; this._draw(); });
      ed.appendChild(done);
      info.appendChild(ed);
    } else if (!this.running) {
      const e = el('button', 'song-fixer-link song-fixer-edit', 'edit');
      e.addEventListener('click', () => { it.editing = true; this._draw(); });
      info.appendChild(e);
    }
    if (it.error) info.appendChild(el('div', 'song-fixer-result song-fixer-error', it.error));
    row.appendChild(info);
    return row;
  }

  async _savePrefs(patch) {
    await window.electronAPI.preferencesUpdate({ import: patch });
    const prefs = this.explorer.preferences;
    if (prefs) prefs.import = { ...(prefs.import || {}), ...patch };
  }

  async _identify(items) {
    this.running = true;
    this._draw();
    let n = 0;
    for (const it of items) {
      this.statusEl.textContent = `identifying ${++n} of ${items.length}…`;
      const res = await window.electronAPI.songFixerIdentify(it.path, { title: it.proposal.title, artist: it.proposal.artist, album: it.proposal.album });
      const pr = res?.success && res.proposal;
      if (pr) {
        Object.assign(it.proposal, {
          title: pr.title || it.proposal.title, artist: pr.artist || it.proposal.artist, album: pr.album || it.proposal.album,
          albumArtist: pr.albumArtist || '', year: pr.year || '', trackNumber: pr.trackNumber || '',
        });
        it.found = true;
      }
    }
    this.running = false;
    this.status = `identified ${items.filter(i => i.found).length} of ${items.length}. check the names, then import.`;
    this._draw();
  }

  async _import(items) {
    this.running = true;
    this._draw();
    const h = window.electronAPI.onMediaProgress((p) => {
      if (p.kind === 'import' && this.statusEl) this.statusEl.textContent = `importing ${p.index + 1} of ${p.total} — ${p.name}`;
    });
    let r;
    try {
      r = await window.electronAPI.importFiles(items.map(i => ({ path: i.path, tags: i.proposal })), this.musicRoot,
        { move: this._prefs().move !== false, findArt: this._prefs().findArt !== false });
    } finally {
      window.electronAPI.offMediaProgress(h);
    }
    this.running = false;
    if (!r.success) {
      this.status = 'import failed: ' + r.error;
    } else {
      const moved = new Set(r.done.map(d => d.from));
      for (const f of r.failed) { const it = this.items.find(i => i.path === f.path); if (it) it.error = 'couldn’t import: ' + f.error; }
      this.items = this.items.filter(i => !moved.has(i.path));
      const paths = r.done.map(d => d.to);
      this.imported.push(...paths);
      await addToLibrary(this.explorer, paths);
      const art = r.done.filter(d => d.artAdded).length;
      this.status = `imported ${r.done.length} song${r.done.length === 1 ? '' : 's'}` + (art ? ` (album art added to ${art})` : '') +
        (r.failed.length ? `, ${r.failed.length} couldn’t be imported` : '') + '.' +
        (paths.length ? ' they’re in your library now — send them to your zune below.' : '');
    }
    this._draw();
  }
}

// ---------------------------------------------------------------------------
// CDs: rip and burn
// ---------------------------------------------------------------------------

class CdView {
  constructor(explorer) {
    this.explorer = explorer;
    this.tab = 'rip';
    this.disc = null;       // from cdFind
    this.candidates = null; // from cdLookup
    this.pick = 0;          // which candidate (-1 = typed in)
    this.album = null;      // { album, albumArtist, year, genre, disc, discs, releaseId }
    this.tracks = [];       // [{ n, title, artist, seconds, selected }]
    this.burnPaths = null;  // songs chosen for burning
    this.running = false;
    this.status = '';
    this.ripped = [];
  }

  /** Open the burn tab with these songs (from the songs table). */
  openBurn(paths) {
    this.tab = 'burn';
    this.burnPaths = paths.slice();
    this.burnSource = 'selection';
  }

  async render(container) {
    this.container = container;
    container.classList.add('song-fixer', 'media-view');
    if (this.tab === 'rip' && !this.disc && !this.running) await this._find();
    this._draw();
  }

  _draw() {
    const c = this.container;
    if (!c) return;
    c.innerHTML = '';
    const tabs = el('div', 'zune-diff-tabs');
    for (const [label, key] of [['rip a cd', 'rip'], ['burn a cd', 'burn']]) {
      const t = el('button', 'zune-diff-tab' + (this.tab === key ? ' active' : ''), label);
      t.addEventListener('click', async () => {
        if (this.running) return;
        this.tab = key;
        this.status = '';
        if (key === 'rip' && !this.disc) await this._find();
        this._draw();
      });
      tabs.appendChild(t);
    }
    c.appendChild(tabs);
    this.statusEl = el('div', 'song-fixer-status song-fixer-sites-status', this.status);
    if (this.tab === 'rip') this._drawRip(c); else this._drawBurn(c);
  }

  // ---- rip ----

  async _find() {
    this.status = 'looking for a cd…';
    const r = await window.electronAPI.cdFind();
    this.supported = r.supported !== false;
    this.disc = r.success ? r.disc : null;
    this.candidates = null;
    this.tracks = [];
    if (!this.disc) { this.status = ''; return; }
    this.tracks = this.disc.tracks.map(t => ({ n: t.n, title: `Track ${t.n}`, artist: '', seconds: t.seconds, selected: true }));
    this.album = { album: this.disc.name === 'Audio CD' ? '' : this.disc.name, albumArtist: '', year: '', genre: '', disc: 1, discs: 1, releaseId: null };
    this.status = 'looking the cd up online…';
    if (this.container) this._draw();
    const l = await window.electronAPI.cdLookup();
    this.candidates = l.success ? l.candidates : [];
    if (this.candidates.length) this._useCandidate(0);
    this.status = this.candidates.length
      ? `found ${this.candidates.length === 1 ? 'it' : this.candidates.length + ' possible albums'} on MusicBrainz — check the names, then rip.`
      : (l.success ? 'this cd isn’t in MusicBrainz — type the album and song names below.' : 'couldn’t look it up (' + l.error + ') — type the names below.');
  }

  _useCandidate(i) {
    this.pick = i;
    const cand = this.candidates[i];
    if (!cand) return;
    this.album = { album: cand.album, albumArtist: cand.artist, year: cand.year, genre: '', disc: cand.disc, discs: cand.discs, releaseId: cand.releaseId };
    this.tracks = this.tracks.map((t, idx) => ({ ...t, title: cand.tracks[idx]?.title || t.title, artist: cand.tracks[idx]?.artist || cand.artist }));
  }

  _drawRip(c) {
    if (this.supported === false) {
      c.appendChild(el('div', 'song-fixer-note', 'ripping cds works on a mac for now.'));
      return;
    }
    if (!this.disc) {
      c.appendChild(el('div', 'song-fixer-note', 'put an audio cd in the drive, wait for it to show up in Finder, then press look again.'));
      const b = el('button', 'zune-sync-btn zune-push-btn', 'look again');
      b.addEventListener('click', async () => { await this._find(); this._draw(); });
      c.appendChild(b);
      c.appendChild(this.statusEl);
      return;
    }
    const total = this.tracks.reduce((s, t) => s + (t.seconds || 0), 0);
    c.appendChild(el('div', 'song-fixer-note', `cd in the drive: ${this.disc.tracks.length} tracks, ${fmtTime(total)}.`));

    if (this.candidates?.length > 1) {
      const row = el('div', 'media-row');
      row.appendChild(el('span', 'song-fixer-dim', 'album: '));
      const sel = el('select', 'song-sort-select');
      this.candidates.forEach((cd, i) => {
        const o = el('option', null, `${cd.album} — ${cd.artist}${cd.year ? ' (' + cd.year + (cd.country ? ', ' + cd.country : '') + ')' : ''}${cd.discs > 1 ? ` disc ${cd.disc}/${cd.discs}` : ''}`);
        o.value = String(i);
        sel.appendChild(o);
      });
      sel.value = String(this.pick);
      sel.addEventListener('change', () => { this._useCandidate(Number(sel.value)); this._draw(); });
      row.appendChild(sel);
      c.appendChild(row);
    }

    // Album details
    const ed = el('div', 'media-album');
    const field = (label, key, w) => {
      const l = el('label', 'media-field');
      l.appendChild(el('span', 'song-fixer-dim', label));
      const inp = el('input', 'zune-diff-filter-input');
      inp.value = this.album[key] || '';
      if (w) inp.style.width = w;
      inp.addEventListener('input', () => { this.album[key] = inp.value; if (key === 'albumArtist') this._artistDefault = inp.value; });
      l.appendChild(inp);
      return l;
    };
    ed.append(field('album', 'album'), field('artist', 'albumArtist'), field('year', 'year', '70px'), field('genre', 'genre', '120px'));
    c.appendChild(ed);

    // Format and destination
    const fr = el('div', 'media-row');
    fr.appendChild(el('span', 'song-fixer-dim', 'save as: '));
    const fmt = el('select', 'song-sort-select');
    for (const [v, label] of [['mp3', 'MP3 320 kbps (best for the zune)'], ['mp3v0', 'MP3 VBR high (smaller)'], ['aac', 'AAC 256 kbps (.m4a)'], ['flac', 'FLAC (lossless; converted when sent to the zune)']]) {
      const o = el('option', null, label);
      o.value = v;
      fmt.appendChild(o);
    }
    fmt.value = this.explorer.preferences?.cd?.format || 'mp3';
    fmt.addEventListener('change', async () => {
      await window.electronAPI.preferencesUpdate({ cd: { format: fmt.value } });
      if (this.explorer.preferences) this.explorer.preferences.cd = { format: fmt.value };
    });
    this.fmtSel = fmt;
    fr.appendChild(fmt);
    fr.appendChild(el('span', 'song-fixer-dim', ' into: '));
    this.musicRoot = this.musicRoot || (this.explorer.preferences?.library?.music || [])[0];
    const rootSel = musicRootSelect(this.explorer, (v) => { this.musicRoot = v; });
    rootSel.value = this.musicRoot || '';
    fr.appendChild(rootSel);
    c.appendChild(fr);

    const bar = el('div', 'zune-diff-actions');
    const sel = this.tracks.filter(t => t.selected);
    if (this.running) {
      const stop = el('button', 'zune-sync-btn zune-pull-btn', 'stop');
      stop.addEventListener('click', () => { window.electronAPI.mediaStop(); stop.disabled = true; stop.textContent = 'stopping after this track…'; });
      bar.appendChild(stop);
    } else {
      const go = el('button', 'zune-sync-btn zune-push-btn', `rip ${sel.length} track${sel.length === 1 ? '' : 's'}`);
      go.disabled = !sel.length || !this.musicRoot;
      go.addEventListener('click', () => this._rip(sel));
      const ej = el('button', 'zune-sync-btn', 'eject');
      ej.addEventListener('click', async () => { await window.electronAPI.cdEject(); this.disc = null; this.status = 'ejected.'; this._draw(); });
      const again = el('button', 'zune-rescan-link', 'look again');
      again.addEventListener('click', async () => { await this._find(); this._draw(); });
      bar.append(go, ej, again);
    }
    c.appendChild(bar);
    c.appendChild(this.statusEl);
    if (this.ripped.length && !this.running) {
      const b = sendToZuneButton(this.explorer, this.ripped, (t) => { this.statusEl.textContent = t; });
      if (b) c.appendChild(b);
    }

    for (const t of this.tracks) {
      const row = el('div', 'zune-diff-item media-track');
      const box = el('input', 'zune-diff-check');
      box.type = 'checkbox';
      box.checked = t.selected;
      box.disabled = this.running;
      box.addEventListener('change', () => { t.selected = box.checked; this._draw(); });
      const num = el('span', 'media-track-n', String(t.n));
      const title = el('input', 'zune-diff-filter-input media-track-title');
      title.value = t.title;
      title.addEventListener('input', () => { t.title = title.value; });
      const artist = el('input', 'zune-diff-filter-input media-track-artist');
      artist.value = t.artist;
      artist.placeholder = 'artist (if different)';
      artist.addEventListener('input', () => { t.artist = artist.value; });
      const len = el('span', 'song-fixer-dim media-track-len', fmtTime(t.seconds));
      row.append(box, num, title, artist, len);
      if (t.state) row.appendChild(el('span', 'media-track-state ' + t.state, t.state === 'done' ? '✓' : t.state === 'failed' ? '✕' : '…'));
      c.appendChild(row);
    }
  }

  async _rip(tracks) {
    this.running = true;
    for (const t of this.tracks) delete t.state;
    this._draw();
    const h = window.electronAPI.onMediaProgress((p) => {
      if (p.kind !== 'rip') return;
      if (p.phase === 'ripping') {
        const t = tracks[p.index];
        if (t) t.state = 'working';
        if (this.statusEl) this.statusEl.textContent = `ripping ${p.index + 1} of ${p.total} — ${p.title}`;
      }
    });
    let r;
    try {
      r = await window.electronAPI.cdRip({
        tracks: tracks.map(t => ({ n: t.n, title: t.title, artist: t.artist || this.album.albumArtist })),
        album: this.album, format: this.fmtSel?.value || 'mp3', musicRoot: this.musicRoot,
      });
    } finally {
      window.electronAPI.offMediaProgress(h);
    }
    this.running = false;
    if (!r.success) {
      this.status = 'ripping failed: ' + r.error;
    } else {
      const failedN = new Set(r.failed.map(f => f.n));
      for (const t of tracks) t.state = failedN.has(t.n) ? 'failed' : (t.state === 'working' ? 'done' : t.state);
      this.ripped.push(...r.done);
      await addToLibrary(this.explorer, r.done);
      this.status = `ripped ${r.done.length} track${r.done.length === 1 ? '' : 's'}` +
        (r.failed.length ? `, ${r.failed.length} failed (${r.failed[0].error})` : '') + (r.stopped ? ' (stopped)' : '') +
        '. they’re in your library — send them to your zune below, or eject the cd.';
    }
    this._draw();
  }

  // ---- burn ----

  _playlistTracks(id) {
    const pl = (this.explorer.playlists || []).find(p => p.id === id);
    return pl ? pl.tracks.map(t => t.path) : [];
  }

  _drawBurn(c) {
    c.appendChild(el('div', 'song-fixer-note',
      'makes an audio cd that plays in any cd player or car. pick a playlist (or select songs in music → songs and press “burn to cd”), ' +
      'put a blank cd-r in the drive, and burn. an audio cd holds about 80 minutes.'));
    const row = el('div', 'media-row');
    row.appendChild(el('span', 'song-fixer-dim', 'songs: '));
    const sel = el('select', 'song-sort-select');
    if (this.burnSource === 'selection' && this.burnPaths?.length) {
      const o = el('option', null, `selected songs (${this.burnPaths.length})`);
      o.value = 'selection';
      sel.appendChild(o);
    }
    const none = el('option', null, '— choose a playlist —');
    none.value = '';
    sel.appendChild(none);
    for (const pl of [...(this.explorer.playlists || [])].sort((a, b) => a.name.localeCompare(b.name))) {
      const o = el('option', null, `${pl.name} (${pl.tracks.length})`);
      o.value = pl.id;
      sel.appendChild(o);
    }
    sel.value = this.burnSource || '';
    sel.addEventListener('change', () => {
      this.burnSource = sel.value;
      if (sel.value && sel.value !== 'selection') this.burnPaths = this._playlistTracks(sel.value);
      else if (!sel.value) this.burnPaths = [];
      this._draw();
    });
    row.appendChild(sel);
    c.appendChild(row);

    const paths = (this.burnPaths || []).filter(p => this.explorer.musicLibrary.tracks.has(p));
    const durs = paths.map(p => this.explorer.musicLibrary.tracks.get(p)?.duration || 0);
    const fit = window.mediaLogic.cdFits(durs);
    if (paths.length) {
      const meter = el('div', 'media-fit');
      const fill = el('div', 'media-fit-fill' + (fit.fits ? '' : ' over'));
      fill.style.width = Math.min(100, (fit.total / fit.max) * 100).toFixed(1) + '%';
      meter.appendChild(fill);
      c.appendChild(meter);
      c.appendChild(el('div', 'song-fixer-dim', `${paths.length} songs, ${fmtTime(fit.total)} of ${fmtTime(fit.max)}` +
        (fit.fits ? '' : fit.tooMany ? ' — too many songs (99 at most)' : ' — too long for one cd: untick some songs')));
    }

    const bar = el('div', 'zune-diff-actions');
    if (this.running) {
      const stop = el('button', 'zune-sync-btn zune-pull-btn', 'stop');
      stop.title = 'stops while songs are being prepared; once burning has started it has to finish';
      stop.addEventListener('click', () => { window.electronAPI.mediaStop(); stop.disabled = true; stop.textContent = 'stopping…'; });
      bar.appendChild(stop);
    } else {
      const go = el('button', 'zune-sync-btn zune-push-btn', `burn ${paths.length} song${paths.length === 1 ? '' : 's'} to cd`);
      go.disabled = !paths.length || !fit.fits;
      go.addEventListener('click', () => this._burn(paths));
      const chk = el('button', 'zune-rescan-link', 'check the drive');
      chk.addEventListener('click', async () => {
        const st = await window.electronAPI.burnStatus();
        this.status = st.supported === false ? 'burning works on a mac for now.'
          : !st.drive ? 'no cd burner found — plug in the drive.'
          : st.blank ? 'a blank cd is ready.' : st.noMedia ? 'no disc — put a blank cd-r in.' : 'the disc in the drive doesn’t look blank — use a new cd-r.';
        this._draw();
      });
      bar.append(go, chk);
    }
    c.appendChild(bar);
    c.appendChild(this.statusEl);

    for (const p of paths) {
      const t = this.explorer.musicLibrary.tracks.get(p) || {};
      const r = el('div', 'zune-diff-item media-burn-row');
      const x = el('button', 'media-chip-x', '✕');
      x.title = 'leave this one off';
      x.disabled = this.running;
      x.addEventListener('click', () => { this.burnPaths = this.burnPaths.filter(q => q !== p); this._draw(); });
      r.append(x, el('span', 'zune-diff-title', t.title || p.split('/').pop()), el('span', 'zune-diff-meta', ` ${t.artist || ''} · ${fmtTime(t.duration)}`));
      c.appendChild(r);
    }
  }

  async _burn(paths) {
    const st = await window.electronAPI.burnStatus();
    if (st.supported === false) { this.status = 'burning works on a mac for now.'; this._draw(); return; }
    if (!st.drive) { this.status = 'no cd burner found — plug in the drive and try again.'; this._draw(); return; }
    if (!st.blank && !window.confirm('The disc in the drive may not be blank (or there is none). Burn anyway? macOS will ask for a blank disc if needed.')) return;
    this.running = true;
    this._draw();
    const h = window.electronAPI.onMediaProgress((p) => {
      if (p.kind !== 'burn' || !this.statusEl) return;
      if (p.phase === 'preparing') this.statusEl.textContent = `preparing ${p.index + 1} of ${p.total} — ${p.name}`;
      else if (p.phase === 'burning') this.statusEl.textContent = `burning… ${p.percent != null ? p.percent + '%' : ''} (keep the drive connected; this takes a few minutes)`;
    });
    let r;
    try { r = await window.electronAPI.burnCd(paths); } finally { window.electronAPI.offMediaProgress(h); }
    this.running = false;
    this.status = r.success ? 'done — the cd has been burned and ejected.' : 'burning failed: ' + r.error;
    this._draw();
  }
}

window.ImportView = ImportView;
window.CdView = CdView;
