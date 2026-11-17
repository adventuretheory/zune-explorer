/* global document, window */
// Settings → fix songs & find duplicates.
// Finds songs with missing or messy tags, recognises them by their audio
// (AcoustID), shows the proposed changes, and writes only what you approve.

const PAGE_SIZE = 200;

class SongFixerView {
  constructor(explorer) {
    this.explorer = explorer;
    this.items = null;          // [{ path, track, reasons, state, result, albumIdx, selected, error }]
    this.mode = 'fix';          // 'fix' | 'all' | 'dupes' | 'zune-dupes'
    this.dupeChoice = new Map(); // duplicate id -> ticked for deletion (default: all but the keeper)
    this.dupeKind = 'identical'; // which duplicate groups to show: 'identical' | 'different'
    this.sortKey = 'title';      // order of the needs fixing / all songs lists
    this.filter = '';
    this.limit = PAGE_SIZE;
    this.running = false;
    this.stopRequested = false;
    this.status = '';
    this.undoInfo = null;
    this.container = null;
    this.rowEls = new Map();
  }

  // ---- data -----------------------------------------------------------------

  _loadItems() {
    const logic = window.songFixerLogic;
    const prev = new Map((this.items || []).map(i => [i.path, i]));
    const items = [];
    for (const [path, track] of this.explorer.musicLibrary.tracks) {
      const old = prev.get(path);
      const reasons = logic.suspectReasons(track, path);
      const item = old ? Object.assign(old, { track, reasons }) : {
        path, track, reasons, state: 'idle', result: null, albumIdx: 0, selected: false, error: null,
      };
      // Confirmed correct by sound earlier (and the file hasn't changed since)
      if (item.state === 'idle' && this.confirmed?.has(path)) item.state = 'confirmed';
      item.ignored = !!this.ignored?.has(path);
      items.push(item);
    }
    items.sort((a, b) => (a.track.title || '').localeCompare(b.track.title || ''));
    this.items = items;
  }

  /** 'zune' (also on the Zune), 'computer' (only here) or '' when unknown. */
  _whereOf(path) {
    const zm = this.explorer._zuneMembership;
    if (!zm || zm.none) return '';
    return zm.onZune.has(path) ? 'zune' : 'computer';
  }

  /** On the "needs fixing" list: something's wrong, not fixed, checked or ignored. */
  _needsFixing(i) {
    // A song whose name was found on MusicBrainz exactly as it is isn't
    // "needing a fix" just because the sound database doesn't know it
    return !i.ignored && i.state !== 'applied' && i.state !== 'confirmed' && (i.reasons.length > 0 || (i.state !== 'idle' && i.state !== 'matched'));
  }

  /** Songs listed now. A "show only" pick (e.g. not recognised) narrows it unless `all`. */
  _visible({ all = false } = {}) {
    const q = this.filter.trim().toLowerCase();
    // The pick is the songs that were in that group when it was clicked, so a
    // song doesn't vanish while it's being identified or fixed
    const pick = !all && this.pick && this.pick.mode === this.mode ? this.pick.paths : null;
    const list = this.items.filter(i =>
      // Fixed songs leave "needs fixing" (they're still under "all songs"),
      // so select all / delete only cover what's left
      (this.mode === 'all' || this._needsFixing(i)) &&
      (!pick || pick.has(i.path)) &&
      (!q || [i.track.title, i.track.artist, i.track.album, i.path].some(v => String(v || '').toLowerCase().includes(q))));
    if (!this._sizes || this._sizes.size !== (this.explorer.categorizedFiles?.music || []).length) {
      this._sizes = new Map((this.explorer.categorizedFiles?.music || []).map(f => [f.path, f.size || 0]));
    }
    return window.songFixerLogic.sortSongs(list, this.sortKey, (i) => ({
      title: i.track.title, artist: i.track.artist, album: i.track.album,
      duration: i.track.duration || 0, size: this._sizes.get(i.path) || 0, path: i.path,
    }));
  }

  _sortMenu(onChange) {
    const row = this._el('div', 'zune-diff-sort-row song-fixer-sort');
    row.style.display = 'flex';
    row.appendChild(this._el('span', null, 'sort'));
    const sel = this._el('select', 'song-sort-select');
    for (const [value, label] of window.songFixerLogic.SORT_OPTIONS) {
      const opt = this._el('option', null, label);
      opt.value = value;
      sel.appendChild(opt);
    }
    sel.value = this.sortKey;
    sel.addEventListener('change', () => { this.sortKey = sel.value; this.limit = PAGE_SIZE; onChange(); });
    row.appendChild(sel);
    return row;
  }

  _proposal(item) {
    const p = item.result?.proposal;
    if (!p) return null;
    const alt = p.albums?.[item.albumIdx];
    if (!alt || item.albumIdx === 0) return p;
    return {
      ...p,
      album: alt.album,
      albumArtist: alt.albumArtist || p.albumArtist,
      year: alt.year,
      trackNumber: alt.trackNumber,
      discNumber: alt.discNumber,
      releaseGroupId: alt.releaseGroupId,
    };
  }

  // ---- rendering --------------------------------------------------------------

  async render(container) {
    this.container = container;
    if (!this.confirmed) {
      try { this.confirmed = new Set(await window.electronAPI.songFixerConfirmedGet()); } catch { this.confirmed = new Set(); }
    }
    if (!this.ignored) {
      try { this.ignored = new Set(await window.electronAPI.songFixerIgnoredGet()); } catch { this.ignored = new Set(); }
    }
    if (!this.running) this._loadItems();
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch { this.undoInfo = null; }
    // Which of these songs are also on the Zune (connected, or as of its last scan)
    if (!this.explorer._zuneMembership && this.explorer._loadZuneMembership) {
      try { await this.explorer._loadZuneMembership(); } catch { /* shown without it */ }
    }
    if (this.container !== container) return;
    this._draw();
  }

  _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  _draw() {
    const c = this.container;
    if (!c) return;
    c.innerHTML = '';
    c.classList.add('song-fixer');
    this.rowEls.clear();

    const key = this.explorer.preferences?.songFixer?.acoustidKey || '';
    c.appendChild(this._keySection(key));
    // Recognising songs needs the key; deleting and duplicates don't
    this.hasKey = !!key;

    if (this.explorer.musicLibrary.tracks.size === 0) {
      c.appendChild(this._el('div', 'song-fixer-note', 'your music library is still loading, or has no songs yet.'));
      return;
    }

    // Same songs as the "needs fixing" list shows
    const suspects = this.items.filter(i => this._needsFixing(i)).length;
    const summary = this._el('div', 'zune-diff-summary song-fixer-summary');
    summary.appendChild(this._el('span', 'zune-diff-stat zune-diff-stat-push', `${suspects} songs need fixing`));
    summary.appendChild(this._el('span', 'zune-diff-stat', `${this.items.length} songs in library`));
    const rescan = this._el('button', 'zune-rescan-link', 'rescan music folders');
    rescan.title = 'read your music folders again: finds new files and drops moved or deleted ones';
    rescan.addEventListener('click', async () => {
      if (this.running) return;
      this.running = true;
      this._setStatus('rescanning your music folders \u2014 this can take a few minutes with a big library\u2026');
      rescan.disabled = true;
      const ok = await this.explorer.rescanMusicLibrary?.();
      this.running = false;
      this.dupeChoice.clear();
      this._loadItems();
      this._setStatus(ok === false ? 'a scan is already running \u2014 try again in a moment.' : `rescanned: ${this.items.length} songs in your library.`);
      this._draw();
    });
    summary.appendChild(rescan);
    c.appendChild(summary);

    // Which songs to list
    const tabs = this._el('div', 'zune-diff-tabs');
    for (const [label, mode] of [['needs fixing', 'fix'], ['all songs', 'all'], ['album art', 'art'], ['websites', 'sites'], ['duplicates', 'dupes'], ['duplicates on zune', 'zune-dupes']]) {
      const t = this._el('button', 'zune-diff-tab' + (this.mode === mode ? ' active' : ''), label);
      t.addEventListener('click', () => { if (this.running) return; this.mode = mode; this.limit = PAGE_SIZE; this.status = ''; this._draw(); });
      tabs.appendChild(t);
    }
    c.appendChild(tabs);

    if (this.mode === 'dupes' || this.mode === 'zune-dupes') {
      this._drawDuplicates(c);
      return;
    }
    if (this.mode === 'sites') {
      this._drawSites(c);
      return;
    }
    if (this.mode === 'art') {
      this._drawArt(c);
      return;
    }

    const filterWrap = this._el('div', 'zune-diff-filter');
    const filter = this._el('input', 'zune-diff-filter-input');
    filter.placeholder = 'Filter...';
    filter.value = this.filter;
    filter.addEventListener('input', () => {
      this.filter = filter.value;
      this.limit = PAGE_SIZE;
      this._drawList();
      filter.focus();
    });
    filterWrap.appendChild(filter);
    c.appendChild(filterWrap);

    c.appendChild(this._actions());

    this.statusEl = this._el('div', 'song-fixer-status', this.status);
    c.appendChild(this.statusEl);

    this.listWrap = this._el('div', 'song-fixer-list');
    c.appendChild(this.listWrap);
    this._drawList();
  }

  _keySection(key) {
    const wrap = this._el('div', 'song-fixer-key');
    if (key && !this.editingKey) {
      const row = this._el('div', 'song-fixer-key-row');
      row.appendChild(this._el('span', 'song-fixer-dim', 'acoustid key saved'));
      const change = this._el('button', 'song-fixer-link', 'change');
      change.addEventListener('click', () => { this.editingKey = true; this._draw(); });
      row.appendChild(change);
      wrap.appendChild(row);
      return wrap;
    }

    wrap.appendChild(this._el('div', 'song-fixer-note',
      'songs are recognised by listening to the audio, using the free AcoustID service. ' +
      'it needs a free key: sign in at acoustid.org, register an application ' +
      '(any name, e.g. "my zune explorer"), then paste the API key here.'));
    const row = this._el('div', 'song-fixer-key-row');
    const link = this._el('button', 'song-fixer-link', 'get a free key');
    link.addEventListener('click', () => window.electronAPI.openExternal('https://acoustid.org/new-application'));
    const input = this._el('input', 'zune-diff-filter-input song-fixer-key-input');
    input.placeholder = 'paste your AcoustID API key';
    input.value = key;
    const save = this._el('button', 'song-fixer-link song-fixer-strong', 'save');
    save.addEventListener('click', async () => {
      const v = input.value.trim();
      if (!/^[A-Za-z0-9]{6,40}$/.test(v)) {
        this.explorer.showToast?.('that doesn’t look like an AcoustID key');
        return;
      }
      this.editingKey = false;
      await window.electronAPI.preferencesUpdate({ songFixer: { acoustidKey: v } });
      if (this.explorer.preferences) {
        this.explorer.preferences.songFixer = { ...(this.explorer.preferences.songFixer || {}), acoustidKey: v };
      }
      this._draw();
    });
    row.append(input, save, link);
    wrap.appendChild(row);
    return wrap;
  }

  _actions() {
    const bar = this._el('div', 'zune-diff-actions song-fixer-actions');
    const selected = this.items.filter(i => i.selected);
    // Already confirmed correct: no need to check again
    const toIdentify = selected.filter(i => !['found', 'applied', 'working', 'confirmed'].includes(i.state));
    const toApply = selected.filter(i => i.state === 'found');

    if (this.running) {
      const stop = this._el('button', 'zune-sync-btn zune-pull-btn', 'stop');
      stop.addEventListener('click', () => { this.stopRequested = true; stop.disabled = true; stop.textContent = 'stopping after the current song…'; });
      bar.appendChild(stop);
      return bar;
    }

    const identify = this._el('button', 'zune-sync-btn zune-push-btn', `identify ${toIdentify.length} song${toIdentify.length === 1 ? '' : 's'}`);
    identify.disabled = toIdentify.length === 0;
    identify.title = this.hasKey
      ? 'listens to each song, and searches by its title if the sound isn\u2019t recognised'
      : 'searches by title only \u2014 add an AcoustID key above to also recognise songs by sound';
    identify.addEventListener('click', () => this._identify(toIdentify));

    const apply = this._el('button', 'zune-sync-btn zune-pull-btn', `apply ${toApply.length} fix${toApply.length === 1 ? '' : 'es'}`);
    apply.disabled = toApply.length === 0;
    apply.addEventListener('click', () => this._apply(toApply));

    // Songs that couldn't be recognised can at least get tidy names
    const toClean = selected.filter(i => i.state === 'idle' || i.state === 'none' || i.state === 'error');
    const tidy = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', `clean up ${toClean.length} name${toClean.length === 1 ? '' : 's'}`);
    tidy.disabled = toClean.length === 0;
    tidy.title = 'remove ID codes, website names and junk from the name, and split \u201cArtist - Title\u201d \u2014 no lookup; review, then apply';
    tidy.addEventListener('click', () => this._cleanupNames(toClean));

    // Cover art for selected songs, looked up online
    const toArt = selected.filter(i => i.state !== 'working');
    const art = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', `add album art (${toArt.length})`);
    art.disabled = toArt.length === 0;
    art.title = 'finds each song\u2019s cover (from the same album, MusicBrainz, Apple or Deezer; else the artist\u2019s photo or a made cover) and adds it to the file; songs that already have art are skipped';
    art.addEventListener('click', async () => {
      this.running = true;
      this.stopRequested = false;
      this._refreshActions();
      const r = await this.explorer.addAlbumArt(toArt.map(i => i.path), {
        shouldStop: () => this.stopRequested,
        standIns: this._standInsOn(),
        onProgress: (n, total) => this._setStatus(`looking for album art: ${n} of ${total}\u2026`),
      });
      this.running = false;
      if (r) {
        this._setStatus(r.summary + '.' + (r.added ? ' ' + this.explorer.zuneArtNote() : ''));
      }
      try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
      await new Promise(res => setTimeout(res, 300));
      this._loadItems();
      this._draw();
    });

    bar.append(identify, tidy, apply, art);

    // Songs that can't be fixed (or aren't wanted) can go to the Trash
    const toDelete = selected.filter(i => i.state !== 'working' && i.state !== 'applied');
    const del = this._el('button', 'zune-sync-btn zune-diff-delete-btn', `delete ${toDelete.length} song${toDelete.length === 1 ? '' : 's'}`);
    del.disabled = toDelete.length === 0;
    del.title = 'moves the files to the Trash; their copies on the zune are removed the next time you press \u201cupdate zune\u201d';
    this._confirmButton(del, () => `move ${toDelete.length} to trash and remove from zune? click again`,
      () => this._deleteLocal(toDelete.map(i => i.path), { removeFromZune: true }));
    bar.appendChild(del);

    // Leave songs off the list for good (until the file changes); "all songs" can bring them back
    const toIgnore = selected.filter(i => i.state !== 'working' && !i.ignored);
    const toUnignore = selected.filter(i => i.ignored);
    if (toUnignore.length && this.mode === 'all') {
      const un = this._el('button', 'zune-sync-btn', `un-ignore ${toUnignore.length}`);
      un.title = 'put these back on the needs fixing list';
      un.addEventListener('click', () => this._setIgnored(toUnignore, false));
      bar.appendChild(un);
    } else {
      const ign = this._el('button', 'zune-sync-btn', `ignore ${toIgnore.length}`);
      ign.disabled = toIgnore.length === 0;
      ign.title = 'stop listing these here (they stay in your library; \u201call songs\u201d still shows them and can un-ignore)';
      ign.addEventListener('click', () => this._setIgnored(toIgnore, true));
      bar.appendChild(ign);
    }

    if (this.undoInfo?.count) {
      const undo = this._el('button', 'zune-sync-btn', `undo last fix (${this.undoInfo.count} song${this.undoInfo.count === 1 ? '' : 's'})`);
      undo.addEventListener('click', () => this._undo());
      bar.appendChild(undo);
    }
    return bar;
  }

  _refreshActions() {
    const old = this.container?.querySelector('.song-fixer-actions');
    if (old) old.replaceWith(this._actions());
  }

  _setStatus(text) {
    this.status = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  _drawList() {
    const wrap = this.listWrap;
    if (!wrap) return;
    wrap.innerHTML = '';
    this.rowEls.clear();
    let visible = this._visible();
    const picked = this.pick && this.pick.mode === this.mode ? this.pick : null;
    if (picked && !visible.length) { this.pick = null; visible = this._visible(); }
    const base = picked ? this._visible({ all: true }) : visible;

    if (visible.length === 0) {
      wrap.appendChild(this._el('div', 'zune-diff-empty', this.mode === 'all' ? 'no songs match' : 'no songs need fixing — nice'));
      return;
    }

    wrap.appendChild(this._sortMenu(() => this._drawList()));

    if (this.mode === 'all') {
      wrap.appendChild(this._el('div', 'song-fixer-note song-fixer-howto',
        'to check songs that look fine: tick some (filter by an artist or album, or use \u201cshow only: not checked yet\u201d) and press identify. ' +
        'songs whose tags match what the audio really is get \u2713 confirmed and are remembered; the rest show what\u2019s wrong.'));
    }

    // Select all (visible)
    const all = this._el('label', 'zune-diff-select-all');
    const allBox = this._el('input');
    allBox.type = 'checkbox';
    allBox.checked = visible.every(i => i.selected);
    allBox.addEventListener('change', () => {
      for (const i of visible) if (i.state !== 'applied') i.selected = allBox.checked;
      this._drawList();
      this._refreshActions();
    });
    all.append(allBox, document.createTextNode(`${allBox.checked ? 'deselect' : 'select'} all (${visible.length} songs)`));

    // Quick picks once songs have been looked up: e.g. tick only the ones
    // that weren't recognised, then "clean up names"
    // "show only": list just one group (e.g. the songs not recognised) and tick them
    const groups = [
      ['not recognised', base.filter(i => i.state === 'none' || i.state === 'error')],
      ['tags look wrong', base.filter(i => i.state === 'found')],
      ['not checked yet', base.filter(i => i.state === 'idle')],
      ['confirmed', base.filter(i => i.state === 'confirmed')],
      ['name found as is', base.filter(i => i.state === 'matched')],
      ['ignored', base.filter(i => i.ignored)],
      ['no album art', base.filter(i => !(i.track.albumArtKey || i.track.albumArt))],
      ['on zune too', base.filter(i => this._whereOf(i.path) === 'zune')],
      ['computer only', base.filter(i => this._whereOf(i.path) === 'computer')],
    ].filter(([label, list]) => (list.length && list.length < base.length) || picked?.label === label);
    const selRow = this._el('div', 'song-fixer-quickselect');
    selRow.appendChild(all);
    if (groups.length || picked) {
      selRow.appendChild(this._el('span', 'song-fixer-dim', 'show only:'));
      for (const [label, list] of groups) {
        const on = picked?.label === label;
        const b = this._el('button', 'song-fixer-link song-fixer-pick' + (on ? ' active' : ''), `${label} (${on ? visible.length : list.length})`);
        b.title = on ? 'showing only these — press “show all” to see every song again' : `list only these ${list.length} songs, ticked`;
        b.addEventListener('click', () => {
          if (this.running) return;
          for (const i of this.items) if (i.state !== 'applied') i.selected = false;
          for (const i of list) if (i.state !== 'applied') i.selected = true;
          this.pick = { mode: this.mode, label, paths: new Set(list.map(i => i.path)) };
          this.limit = PAGE_SIZE;
          this._drawList();
          this._refreshActions();
        });
        selRow.appendChild(b);
      }
      if (picked) {
        const showAll = this._el('button', 'song-fixer-link song-fixer-pick song-fixer-showall', `show all (${base.length})`);
        showAll.addEventListener('click', () => { this.pick = null; this.limit = PAGE_SIZE; this._drawList(); this._refreshActions(); });
        selRow.appendChild(showAll);
      }
      const none = this._el('button', 'song-fixer-link song-fixer-pick', 'tick none');
      none.addEventListener('click', () => { for (const i of base) i.selected = false; this._drawList(); this._refreshActions(); });
      selRow.appendChild(none);
    }
    wrap.appendChild(selRow);

    for (const item of visible.slice(0, this.limit)) {
      const row = this._row(item);
      this.rowEls.set(item.path, row);
      wrap.appendChild(row);
    }

    if (visible.length > this.limit) {
      const more = this._el('button', 'song-fixer-link song-fixer-more', `show more (${visible.length - this.limit} left)`);
      more.addEventListener('click', () => { this.limit += PAGE_SIZE; this._drawList(); });
      wrap.appendChild(more);
    }
  }

  _row(item) {
    const row = this._el('div', 'zune-diff-item song-fixer-row state-' + item.state);
    const box = this._el('input', 'zune-diff-check');
    box.type = 'checkbox';
    box.checked = item.selected;
    box.disabled = item.state === 'applied' || item.state === 'working';
    box.addEventListener('change', () => { item.selected = box.checked; this._refreshActions(); });
    row.appendChild(box);

    const info = this._el('div', 'zune-diff-info');
    const t = item.track;
    info.appendChild(this._el('div', 'zune-diff-title', t.title || item.path.split(/[/\\]/).pop()));
    const meta = `${t.artist || '?'} — ${t.album || '?'}` + (item.reasons.length ? `  ·  ${item.reasons.join(', ')}` : '');
    const metaEl = this._el('div', 'zune-diff-meta', meta);
    if (item.ignored) metaEl.appendChild(this._el('span', 'song-fixer-where where-computer', 'ignored'));
    // Every song here is a file on this computer; say whether the Zune has it too
    const where = this._whereOf(item.path);
    if (where) {
      const tag = this._el('span', 'song-fixer-where where-' + where, where === 'zune' ? 'on zune too' : 'computer only');
      tag.title = where === 'zune'
        ? 'this file is on your computer and a copy is on your zune \u2014 after fixing, \u201cupdate zune\u201d puts the fix on the zune'
        : 'this file is only on your computer, not on your zune';
      metaEl.appendChild(tag);
    }
    info.appendChild(metaEl);
    info.appendChild(this._resultLine(item));
    if (item.state !== 'working' && item.state !== 'applied' && !this.running) {
      if (item.editing) {
        info.appendChild(this._editor(item));
      } else {
        const editLink = this._el('button', 'song-fixer-link song-fixer-edit', 'edit');
        editLink.title = 'type the title, artist and album yourself';
        editLink.addEventListener('click', () => { item.editing = true; this._updateRow(item); });
        info.appendChild(editLink);
      }
    }
    row.appendChild(this._playButton(item.path));
    row.appendChild(info);
    row.addEventListener('contextmenu', (e) => this._songMenu(e, item.path));
    return row;
  }

  _resultLine(item) {
    const line = this._el('div', 'song-fixer-result');
    switch (item.state) {
      case 'working':
        line.textContent = 'listening…';
        return line;
      case 'none':
        line.textContent = (this.hasKey ? 'not recognised by sound or title' : 'not found by title') +
          (item.note ? ` \u00b7 ${item.note}` : '') + ' \u2014 try \u201cclean up names\u201d or \u201cedit\u201d';
        line.classList.add('dim');
        return line;
      case 'error':
        line.textContent = item.error || 'something went wrong';
        line.classList.add('bad');
        return line;
      case 'matched':
        line.textContent = '\u2713 name found on musicbrainz, same as yours \u2014 most likely right (this recording isn\u2019t in the sound database, so it couldn\u2019t be checked by sound)';
        line.classList.add('good');
        return line;
      case 'confirmed':
        line.textContent = '\u2713 tags confirmed by sound';
        line.classList.add('good');
        return line;
      case 'applied':
        line.textContent = '✓ fixed';
        line.classList.add('good');
        return line;
      case 'found': break;
      default:
        return line;
    }

    const p = this._proposal(item);
    const changes = window.songFixerLogic.proposedChanges(item.result.current, p);
    const pct = Math.round((p.score || 0) * 100);

    const arrow = this._el('span', 'song-fixer-arrow', '→ ');
    line.appendChild(arrow);
    const parts = [
      ['title', p.title], ['artist', p.artist], ['album', p.album],
    ];
    const clears = p.clear || [];
    parts.forEach(([field, value], idx) => {
      if (idx) line.appendChild(document.createTextNode(' — '));
      const removed = clears.includes(field) && !value;
      const changed = removed || changes.some(c => c.field === field);
      const span = this._el('span', changed ? 'song-fixer-changed' : '', removed ? `no ${field}` : (value || '?'));
      if (removed) span.title = `the junk ${field} (e.g. a website name) will be left empty`;
      line.appendChild(span);
    });
    const extra = [p.year, p.trackNumber ? `track ${p.trackNumber}` : null].filter(Boolean).join(', ');
    if (extra) line.appendChild(document.createTextNode(` (${extra})`));
    if (p.source === 'title') {
      line.appendChild(this._el('span', 'song-fixer-title-match', '  found by title \u2014 check it'));
    } else if (p.source === 'cleanup') {
      line.appendChild(this._el('span', 'song-fixer-title-match', '  cleaned-up name \u2014 check it'));
    } else if (p.source === 'manual') {
      line.appendChild(this._el('span', 'song-fixer-score', '  your edit'));
    } else {
      line.appendChild(this._el('span', 'song-fixer-score', `  ${pct}% match`));
    }
    if (changes.length === 0 && clears.length === 0) line.appendChild(this._el('span', 'song-fixer-score', ' · tags already match'));
    if (item.applyError) {
      const err = this._el('div', 'song-fixer-apply-error', `couldn\u2019t save: ${item.applyError.replace(/^Could not update tags:\s*/, '')} \u2014 press apply to try again`);
      line.appendChild(err);
    }

    const albums = item.result.proposal.albums || [];
    if (albums.length > 1) {
      const sel = this._el('select', 'song-fixer-album-select');
      albums.slice(0, 12).forEach((a, i) => {
        const opt = this._el('option', null, `${a.album}${a.year ? ' (' + a.year + ')' : ''}${a.type ? ' · ' + a.type : ''}`);
        opt.value = String(i);
        if (i === item.albumIdx) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.title = 'this song is on several albums — pick one';
      sel.addEventListener('change', () => { item.albumIdx = Number(sel.value); this._updateRow(item); });
      line.appendChild(sel);
    }
    return line;
  }

  _updateRow(item) {
    const old = this.rowEls.get(item.path);
    if (!old || !old.isConnected) return;
    const fresh = this._row(item);
    old.replaceWith(fresh);
    this.rowEls.set(item.path, fresh);
  }

  /** A ▶ button that plays a song file without leaving this page. */
  _playButton(filePath) {
    const playing = !!this.explorer.isPathPlaying?.(filePath);
    const b = this._el('button', 'song-play-btn' + (playing ? ' playing' : ''), playing ? '\u23F8' : '\u25B6');
    b.title = playing ? 'pause' : 'play';
    b.dataset.path = filePath;
    b.addEventListener('click', (e) => {
      // Rows are labels; don't let the click tick the checkbox
      e.preventDefault();
      e.stopPropagation();
      this.explorer.playPath?.(filePath);
    });
    return b;
  }

  /** Right-click: Show in Finder / Move to Trash (plus playlist options). */
  _songMenu(e, filePath) {
    e.preventDefault();
    const ex = this.explorer;
    const t = ex.musicLibrary.tracks.get(filePath) || {};
    if (ex.showMusicItemContextMenu) {
      ex.showMusicItemContextMenu(e, [{ path: filePath, name: filePath.split(/[/\\]/).pop(), title: t.title, artist: t.artist, album: t.album, duration: t.duration }]);
    }
  }

  /** Two-click button: the first click asks, the second within 4s acts. */
  _confirmButton(btn, question, action) {
    let timer = null;
    const label = btn.textContent;
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = question();
        timer = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      btn.classList.remove('confirm');
      btn.textContent = label;
      action();
    });
  }

  // ---- clean-up and manual edits -------------------------------------------

  _knownArtists() {
    const logic = window.songFixerLogic;
    const set = new Set();
    for (const t of this.explorer.musicLibrary.tracks.values()) {
      if (t.artist) set.add(logic.tagKey('', t.artist).slice(1));
    }
    return set;
  }

  _currentOf(item) {
    const t = item.track || {};
    return { title: t.title || '', artist: t.artist || '', album: t.album || '' };
  }

  _cleanupNames(items) {
    const logic = window.songFixerLogic;
    const known = this._knownArtists();
    let n = 0;
    for (const item of items) {
      const current = this._currentOf(item);
      const proposal = logic.cleanupProposal(current, item.path, known);
      if (!proposal.title) continue;
      // Already clean: nothing to suggest
      if (!logic.proposedChanges(current, proposal).length && !proposal.clear.length) continue;
      item.result = { current, proposal };
      item.albumIdx = 0;
      item.state = 'found';
      item.selected = true;
      n++;
    }
    this._setStatus(`${n} name${n === 1 ? '' : 's'} cleaned up. check them (\u25B6 to listen, \u201cedit\u201d to change one), then press apply.`);
    this._drawList();
    this._refreshActions();
  }

  /** Inline title / artist / album editor for one song. */
  _editor(item) {
    const logic = window.songFixerLogic;
    const box = this._el('div', 'song-fixer-editor');
    // Start from the suggestion if there is one, else from a cleaned-up name
    const start = item.state === 'found' && item.result?.proposal
      ? this._proposal(item)
      : logic.cleanupProposal(this._currentOf(item), item.path, this._knownArtists());
    const fields = {};
    for (const [key, label] of [['title', 'title'], ['artist', 'artist'], ['album', 'album']]) {
      const input = this._el('input', 'zune-diff-filter-input song-fixer-edit-input');
      input.placeholder = label;
      input.value = start?.[key] || '';
      input.addEventListener('click', (e) => e.stopPropagation());
      fields[key] = input;
      box.appendChild(input);
    }
    const values = () => ({ title: fields.title.value.trim(), artist: fields.artist.value.trim(), album: fields.album.value.trim() });

    const btns = this._el('div', 'song-fixer-edit-buttons');
    const use = this._el('button', 'song-fixer-link song-fixer-strong', 'use these');
    use.addEventListener('click', () => {
      const v = values();
      if (!v.title) { fields.title.focus(); return; }
      const current = this._currentOf(item);
      const clear = ['artist', 'album'].filter(f => !v[f] && current[f] && !/^unknown (artist|album)$/i.test(current[f]));
      item.result = { current, proposal: { source: 'manual', score: null, title: v.title, artist: v.artist || null, album: v.album || null, albums: [], clear } };
      item.albumIdx = 0;
      item.state = 'found';
      item.selected = true;
      item.editing = false;
      this._updateRow(item);
      this._refreshActions();
    });
    const search = this._el('button', 'song-fixer-link', 'search with these');
    search.title = 'look the song up using what you typed';
    search.addEventListener('click', () => this._searchWithHint(item, values()));
    const cancel = this._el('button', 'song-fixer-link', 'cancel');
    cancel.addEventListener('click', () => { item.editing = false; this._updateRow(item); });
    btns.append(use, search, cancel);
    box.appendChild(btns);
    setTimeout(() => fields.title.focus(), 0);
    return box;
  }

  async _searchWithHint(item, v) {
    if (!v.title) return;
    item.editing = false;
    item.state = 'working';
    this._updateRow(item);
    const res = await window.electronAPI.songFixerIdentify(item.path, {
      title: v.artist ? `${v.artist} - ${v.title}` : v.title,
      artist: v.artist, album: v.album, duration: item.track?.duration, hint: true,
    });
    if (res.success && res.proposal) {
      item.result = res;
      item.albumIdx = 0;
      item.state = 'found';
      item.selected = true;
      this._setStatus('found it \u2014 check the suggestion, then apply.');
    } else {
      // Not found: keep what was typed as the suggestion, so it can still be applied
      const current = this._currentOf(item);
      item.result = { current, proposal: { source: 'manual', score: null, title: v.title, artist: v.artist || null, album: v.album || null, albums: [], clear: [] } };
      item.state = 'found';
      item.selected = true;
      this._setStatus(res.success ? 'no match found for that \u2014 your text is kept as the suggestion; apply it as is, or edit and search again.' : ('search failed: ' + res.error));
    }
    this._updateRow(item);
    this._refreshActions();
  }

  // ---- duplicates -----------------------------------------------------------

  // ---- websites: "DOPEHOOD.COM" in names, and website pictures as album art --

  /** Songs whose library tags contain a website, with the cleaned values. */
  _siteItems() {
    const logic = window.songFixerLogic;
    const out = [];
    for (const [path, t] of this.explorer.musicLibrary.tracks) {
      const tags = { title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, genre: t.genre };
      const changes = logic.stripSiteTags(tags, path);
      if (Object.keys(changes).length) out.push({ path, track: t, tags, changes });
    }
    return window.songFixerLogic.sortSongs(out, 'title', (i) => ({ title: i.track.title, artist: i.track.artist, album: i.track.album, path: i.path }));
  }

  _drawSites(c) {
    if (!this.siteSkip) this.siteSkip = new Set();     // paths unticked in the names list
    if (!this.coverSkip) this.coverSkip = new Set();   // picture hashes unticked
    if (!this.siteLimit) this.siteLimit = PAGE_SIZE;

    this.statusEl = this._el('div', 'song-fixer-status song-fixer-sites-status', this.status);
    c.appendChild(this.statusEl);

    // 1. Names
    const names = this._el('div', 'song-fixer-sites');
    names.appendChild(this._el('h3', 'song-fixer-sites-head', 'website names in song details'));
    const items = this._siteItems();
    const ticked = items.filter(i => !this.siteSkip.has(i.path));
    if (!items.length) {
      names.appendChild(this._el('div', 'song-fixer-note', 'no song names, artists or albums with a website in them. ✓'));
    } else {
      names.appendChild(this._el('div', 'song-fixer-note',
        `${items.length} song${items.length === 1 ? ' has' : 's have'} a website in the name, artist, album or genre. ` +
        'the website is taken out and the rest kept; an album that was only a website is left empty. ' +
        'hidden comments with websites are emptied too. untick any you want left alone.'));
      const bar = this._el('div', 'zune-diff-actions song-fixer-actions');
      if (this.running && this.coverScanning) {
        // the album art check is running; its stop button is in that section
      } else if (this.running) {
        const stop = this._el('button', 'zune-sync-btn zune-pull-btn', 'stop');
        stop.addEventListener('click', () => { this.stopRequested = true; stop.disabled = true; stop.textContent = 'stopping after the current song…'; });
        bar.appendChild(stop);
      } else {
        const go = this._el('button', 'zune-sync-btn zune-push-btn', `remove websites from ${ticked.length} song${ticked.length === 1 ? '' : 's'}`);
        go.disabled = !ticked.length;
        go.addEventListener('click', () => this._stripSites(ticked.map(i => i.path)));
        bar.appendChild(go);
        if (this.undoInfo?.count) {
          const undo = this._el('button', 'zune-sync-btn', `undo last fix (${this.undoInfo.count} song${this.undoInfo.count === 1 ? '' : 's'})`);
          undo.addEventListener('click', () => this._undo());
          bar.appendChild(undo);
        }
      }
      names.appendChild(bar);

      const all = this._el('label', 'zune-diff-select-all');
      const allBox = this._el('input');
      allBox.type = 'checkbox';
      allBox.checked = ticked.length === items.length;
      allBox.disabled = this.running;
      allBox.addEventListener('change', () => {
        if (allBox.checked) this.siteSkip.clear(); else for (const i of items) this.siteSkip.add(i.path);
        this._draw();
      });
      all.append(allBox, document.createTextNode(`${allBox.checked ? 'deselect' : 'select'} all (${items.length} songs)`));
      names.appendChild(all);

      for (const item of items.slice(0, this.siteLimit)) {
        const row = this._el('div', 'zune-diff-item song-fixer-row');
        const box = this._el('input', 'zune-diff-check');
        box.type = 'checkbox';
        box.checked = !this.siteSkip.has(item.path);
        box.disabled = this.running;
        box.addEventListener('change', () => {
          if (box.checked) this.siteSkip.delete(item.path); else this.siteSkip.add(item.path);
          this._draw();
        });
        row.appendChild(box);
        row.appendChild(this._playButton(item.path));
        const info = this._el('div', 'zune-diff-info');
        info.appendChild(this._el('div', 'zune-diff-title', item.track.title || item.path.split(/[/\\]/).pop()));
        info.appendChild(this._el('div', 'zune-diff-meta', `${item.track.artist || '?'} — ${item.track.album || '?'}`));
        this._siteChangeLines(info, item);
        row.appendChild(info);
        row.addEventListener('contextmenu', (e) => this._songMenu(e, item.path));
        names.appendChild(row);
      }
      if (items.length > this.siteLimit) {
        const more = this._el('button', 'song-fixer-link song-fixer-more', `show more (${items.length - this.siteLimit} left)`);
        more.addEventListener('click', () => { this.siteLimit += PAGE_SIZE; this._draw(); });
        names.appendChild(more);
      }
    }
    c.appendChild(names);

    // 2. Songs on the Zune (including ones not on this computer)
    this._drawZuneSites(c);

    // Album art lives on its own tab now
    const pointer = this._el('div', 'song-fixer-note song-fixer-pointer');
    pointer.append(document.createTextNode('looking for website logos used as album art? they\u2019re on the '));
    const go = this._el('button', 'song-fixer-link', 'album art');
    go.addEventListener('click', () => { if (this.running) return; this.mode = 'art'; this.status = ''; this._draw(); });
    pointer.append(go, document.createTextNode(' tab now, with songs missing album art.'));
    c.appendChild(pointer);
  }

  /** The album art tab: songs with no cover, and wrong pictures (website logos etc.). */
  _drawArt(c) {
    if (!this.artSkip) this.artSkip = new Set();   // paths unticked in the missing list
    if (!this.artLimit) this.artLimit = PAGE_SIZE;
    this.statusEl = this._el('div', 'song-fixer-status song-fixer-sites-status', this.status);
    c.appendChild(this.statusEl);

    const sec = this._el('div', 'song-fixer-sites');
    sec.appendChild(this._el('h3', 'song-fixer-sites-head', 'songs with no album art'));
    const missing = this.items.filter(i => !(i.track.albumArtKey || i.track.albumArt));
    if (!missing.length) {
      sec.appendChild(this._el('div', 'song-fixer-note', 'every song has album art. \u2713'));
    } else {
      const q = (this.artFilter || '').trim().toLowerCase();
      const shown = missing.filter(i => !q || [i.track.title, i.track.artist, i.track.album].some(v => String(v || '').toLowerCase().includes(q)))
        .sort((x, y) => String(x.track.artist || '').localeCompare(String(y.track.artist || '')) || String(x.track.album || '').localeCompare(String(y.track.album || '')));
      const ticked = shown.filter(i => !this.artSkip.has(i.path));
      sec.appendChild(this._el('div', 'song-fixer-note',
        `${missing.length} song${missing.length === 1 ? ' has' : 's have'} no album art. \u201cfind album art\u201d uses a cover from another song on the same album, ` +
        'else looks it up by artist and album on musicbrainz, apple and deezer. not found? \u201csearch the web\u201d on a song opens an image search: ' +
        'right-click the right cover, \u201cCopy Image\u201d, then press \u201cpaste\u201d. \u201cset from an image\u201d puts a picture file on the ticked songs.'));
      const opt = this._el('label', 'zune-diff-select-all');
      const optBox = this._el('input');
      optBox.type = 'checkbox';
      optBox.checked = this._standInsOn();
      optBox.disabled = this.running;
      optBox.addEventListener('change', () => { try { localStorage.setItem('fixer-art-standins', optBox.checked ? 'on' : 'off'); } catch { /* this session */ } });
      opt.append(optBox, document.createTextNode('if no real cover is found: use the artist\u2019s photo; else identify the song by sound and look again; else make a simple cover'));
      sec.appendChild(opt);
      const filter = this._el('input', 'zune-diff-filter-input');
      filter.placeholder = 'filter by song, artist or album\u2026';
      filter.value = this.artFilter || '';
      filter.addEventListener('input', () => { this.artFilter = filter.value; this.artLimit = PAGE_SIZE; this._draw(); const f = this.container.querySelector('.song-fixer-art-filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } });
      filter.classList.add('song-fixer-art-filter');
      sec.appendChild(filter);

      const bar = this._el('div', 'zune-diff-actions');
      if (this.running && !this.coverScanning && !this.findingRealArt) {
        const stop = this._el('button', 'zune-sync-btn zune-pull-btn', this.stopRequested ? 'stopping after the current song\u2026' : 'stop');
        stop.disabled = !!this.stopRequested;
        stop.addEventListener('click', () => { this.stopRequested = true; stop.disabled = true; stop.textContent = 'stopping after the current song\u2026'; });
        bar.appendChild(stop);
      }
      if (!this.running) {
        const find = this._el('button', 'zune-sync-btn zune-push-btn', `find album art (${ticked.length})`);
        find.disabled = !ticked.length;
        find.addEventListener('click', () => this._addArt(ticked, {}));
        const paste = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', `paste copied picture (${ticked.length})`);
        paste.disabled = !ticked.length;
        paste.title = 'put the picture you copied (e.g. from a web image search) on the ticked songs';
        paste.addEventListener('click', () => this._addArt(ticked, { fromClipboard: true }));
        const pick = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', `set from an image\u2026 (${ticked.length})`);
        pick.disabled = !ticked.length;
        pick.title = 'choose a picture on your computer and put it on the ticked songs (e.g. one album)';
        pick.addEventListener('click', () => this._addArt(ticked, { pickImage: true }));
        bar.append(find, paste, pick);
      }
      sec.appendChild(bar);

      const all = this._el('label', 'zune-diff-select-all');
      const allBox = this._el('input');
      allBox.type = 'checkbox';
      allBox.checked = ticked.length === shown.length;
      allBox.addEventListener('change', () => {
        for (const i of shown) { if (allBox.checked) this.artSkip.delete(i.path); else this.artSkip.add(i.path); }
        this._draw();
      });
      all.append(allBox, document.createTextNode(`${allBox.checked ? 'deselect' : 'select'} all (${shown.length} songs)`));
      sec.appendChild(all);
      for (const it of shown.slice(0, this.artLimit)) {
        const row = this._el('div', 'zune-diff-item song-fixer-row');
        const box = this._el('input', 'zune-diff-check');
        box.type = 'checkbox';
        box.checked = !this.artSkip.has(it.path);
        box.disabled = this.running;
        box.addEventListener('change', () => { if (box.checked) this.artSkip.delete(it.path); else this.artSkip.add(it.path); this._draw(); });
        const info = this._el('div', 'zune-diff-info');
        info.appendChild(this._el('div', 'zune-diff-title', it.track.title || it.path.split(/[/\\]/).pop()));
        info.appendChild(this._el('div', 'zune-diff-meta', `${it.track.artist || '?'} \u2014 ${it.track.album || 'no album'}`));
        row.append(box, this._playButton(it.path), info, this._coverButtons(it.path));
        row.addEventListener('contextmenu', (e) => this._songMenu(e, it.path));
        sec.appendChild(row);
      }
      if (shown.length > this.artLimit) {
        const more = this._el('button', 'song-fixer-link song-fixer-more', `show more (${shown.length - this.artLimit} left)`);
        more.addEventListener('click', () => { this.artLimit += PAGE_SIZE; this._draw(); });
        sec.appendChild(more);
      }
    }
    c.appendChild(sec);
    this._drawStandIns(c);
    this._drawCoverCheck(c);
  }

  async _addArt(items, how = {}) {
    if (typeof how === 'boolean') how = { pickImage: how };
    this.running = true;
    this.stopRequested = false;
    this._draw();
    const given = how.pickImage || how.fromClipboard;
    const r = await this.explorer.addAlbumArt(items.map(i => i.path), {
      shouldStop: () => this.stopRequested,
      standIns: this._standInsOn(),
      ...how,
      onProgress: (n, total) => this._setStatus(`${given ? 'adding the picture' : how.realOnly ? 'looking for the real album art' : 'looking for album art'}: ${n} of ${total}\u2026`),
    });
    this.running = false;
    if (r) {
      this.status = r.summary + '.' + (r.added ? ' ' + this.explorer.zuneArtNote() : '');
    } else {
      this.status = '';
    }
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
    await new Promise(res => setTimeout(res, 400));
    await this._loadStandIns();
    this._loadItems();
    this._draw();
  }

  /** "if no real cover is found, use a stand-in" (on unless turned off). */
  _standInsOn() {
    try { return localStorage.getItem('fixer-art-standins') !== 'off'; } catch { return true; }
  }

  /** Songs whose cover is the artist's photo or a made cover: { path: kind }. */
  async _loadStandIns() {
    try { const r = await window.electronAPI.songFixerStandIns(); this.standIns = r?.success ? r.standIns : {}; } catch { this.standIns = {}; }
  }

  /** Songs with a stand-in cover, and a way to look again for the real one. */
  _drawStandIns(c) {
    if (!this.standIns) { this._loadStandIns().then(() => { if (this.container?.isConnected && this.mode === 'art' && Object.keys(this.standIns).length) this._draw(); }); return; }
    const lib = this.explorer.musicLibrary.tracks;
    const list = Object.entries(this.standIns).filter(([p]) => lib.has(p));
    if (!list.length) return;
    const sec = this._el('div', 'song-fixer-sites');
    sec.appendChild(this._el('h3', 'song-fixer-sites-head', 'stand-in covers'));
    const photos = list.filter(([, k]) => k === 'artist').length;
    const made = list.length - photos;
    sec.appendChild(this._el('div', 'song-fixer-note',
      `${list.length} song${list.length === 1 ? ' has' : 's have'} a stand-in cover because no real one was found` +
      ` (${[photos ? `${photos} artist photo${photos === 1 ? '' : 's'}` : '', made ? `${made} made cover${made === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}). ` +
      'after fixing a song\u2019s name, or some time later, look again: only a real album cover replaces a stand-in.'));
    if (!this.running) {
      const bar = this._el('div', 'zune-diff-actions');
      const again = this._el('button', 'zune-sync-btn zune-push-btn', `look again for real covers (${list.length})`);
      again.addEventListener('click', () => this._addArt(list.map(([p]) => ({ path: p })), { realOnly: true, replace: true }));
      bar.appendChild(again);
      sec.appendChild(bar);
    }
    const shown = list.map(([p, k]) => ({ path: p, kind: k, track: lib.get(p) }))
      .sort((x, y) => String(x.track.artist || '').localeCompare(String(y.track.artist || '')) || String(x.track.album || '').localeCompare(String(y.track.album || '')));
    if (!this.standInLimit) this.standInLimit = 20;
    for (const it of shown.slice(0, this.standInLimit)) {
      const row = this._el('div', 'zune-diff-item song-fixer-row');
      const info = this._el('div', 'zune-diff-info');
      info.appendChild(this._el('div', 'zune-diff-title', it.track.title || it.path.split(/[/\\]/).pop()));
      info.appendChild(this._el('div', 'zune-diff-meta', `${it.track.artist || '?'} \u2014 ${it.track.album || 'no album'} \u00b7 ${it.kind === 'artist' ? 'artist photo' : 'made cover'}`));
      row.append(this._playButton(it.path), info, this._coverButtons(it.path));
      row.addEventListener('contextmenu', (e) => this._songMenu(e, it.path));
      sec.appendChild(row);
    }
    if (shown.length > this.standInLimit) {
      const more = this._el('button', 'song-fixer-link song-fixer-more', `show more (${shown.length - this.standInLimit} left)`);
      more.addEventListener('click', () => { this.standInLimit += 50; this._draw(); });
      sec.appendChild(more);
    }
    c.appendChild(sec);
  }

  /** "search the web" and "paste" for one song: find a cover in the browser, copy it, paste it here. */
  _coverButtons(path) {
    const box = this._el('div', 'song-fixer-cover-btns');
    const web = this._el('button', 'song-fixer-link', 'search the web');
    web.title = 'opens an image search for this album in your browser \u2014 right-click the right cover, \u201cCopy Image\u201d, then press \u201cpaste\u201d here';
    web.addEventListener('click', () => this.explorer.searchCoverOnline(path));
    const paste = this._el('button', 'song-fixer-link', 'paste');
    paste.title = 'put the picture you copied on this song';
    paste.disabled = !!this.running;
    paste.addEventListener('click', () => this._addArt([{ path }], { fromClipboard: true }));
    box.append(web, paste);
    return box;
  }

  /** Website logos / one picture on many albums: find, remove, then look up real covers. */
  _drawCoverCheck(c) {
    if (!this.coverSkip) this.coverSkip = new Set();
    const art = this._el('div', 'song-fixer-sites');
    art.appendChild(this._el('h3', 'song-fixer-sites-head', 'wrong pictures: website logos and covers on the wrong songs'));
    art.appendChild(this._el('div', 'song-fixer-note',
      'reads the album art in every song and groups identical pictures. a picture is listed when songs that use it have (or had) a website in their details, ' +
      'or when the same picture is on lots of different artists and albums — real covers aren’t. look at each one: ticked pictures are removed from their songs ' +
      '(undo puts them back), then the real album art can be looked up.'));
    const artBar = this._el('div', 'zune-diff-actions');
    if (this.findingRealArt) {
      const stop = this._el('button', 'zune-sync-btn zune-pull-btn', this.stopRequested ? 'stopping after the current song\u2026' : 'stop');
      stop.disabled = !!this.stopRequested;
      stop.addEventListener('click', () => { this.stopRequested = true; stop.disabled = true; stop.textContent = 'stopping after the current song\u2026'; });
      artBar.appendChild(stop);
    } else if (this.coverScanning) {
      const stop = this._el('button', 'zune-sync-btn zune-pull-btn', 'stop checking');
      stop.title = 'stops reading album art; pictures found so far are still shown';
      stop.addEventListener('click', () => {
        stop.disabled = true;
        stop.textContent = 'stopping\u2026';
        window.electronAPI.songFixerCoverScanStop?.();
      });
      artBar.appendChild(stop);
    } else if (!this.running) {
      const scan = this._el('button', 'zune-sync-btn zune-push-btn', this.coverGroups ? 'check album art again' : 'check album art');
      scan.addEventListener('click', () => this._scanCovers());
      artBar.appendChild(scan);
      if (this.coverGroups?.length) {
        // Tick / untick every picture at once
        const selAll = this._el('button', 'song-fixer-link song-fixer-pick', 'select all');
        selAll.addEventListener('click', () => { this.coverSkip.clear(); this._draw(); });
        const selNone = this._el('button', 'song-fixer-link song-fixer-pick', 'deselect all');
        selNone.addEventListener('click', () => { this.coverSkip = new Set(this.coverGroups.map(g => g.hash)); this._draw(); });
        const selLogos = this._el('button', 'song-fixer-link song-fixer-pick', 'only likely logos');
        selLogos.title = 'tick only pictures that are on several different artists';
        selLogos.addEventListener('click', () => { this.coverSkip = new Set(this.coverGroups.filter(g => g.kind !== 'site').map(g => g.hash)); this._draw(); });
        artBar.append(selAll, selNone, selLogos);
        const chosen = this.coverGroups.filter(g => !this.coverSkip.has(g.hash));
        const n = chosen.reduce((sum, g) => sum + g.count, 0);
        const rm = this._el('button', 'zune-sync-btn zune-pull-btn', `remove ${chosen.length} picture${chosen.length === 1 ? '' : 's'} from ${n} song${n === 1 ? '' : 's'}`);
        rm.disabled = !chosen.length;
        rm.addEventListener('click', () => this._removeCovers(chosen));
        artBar.appendChild(rm);
      }
      if (this.coverRemovedPaths?.length) {
        const find = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', `find real album art for ${this.coverRemovedPaths.length} song${this.coverRemovedPaths.length === 1 ? '' : 's'}`);
        find.title = 'looks up each song’s cover online (MusicBrainz / Cover Art Archive)';
        find.addEventListener('click', () => this._findRealArt());
        artBar.appendChild(find);
      }
    }
    art.appendChild(artBar);

    if (this.coverGroups && !this.coverGroups.length) {
      art.appendChild(this._el('div', 'song-fixer-note', 'no website pictures found in your album art. ✓'));
    }
    if (this.coverGroups?.length) {
      const grid = this._el('div', 'song-fixer-cover-grid');
      for (const g of this.coverGroups) {
        const card = this._el('label', 'song-fixer-cover-card' + (this.coverSkip.has(g.hash) ? '' : ' chosen'));
        const box = this._el('input', 'zune-diff-check');
        box.type = 'checkbox';
        box.checked = !this.coverSkip.has(g.hash);
        box.disabled = this.running;
        box.addEventListener('change', () => {
          if (box.checked) this.coverSkip.delete(g.hash); else this.coverSkip.add(g.hash);
          this._draw();
        });
        const img = this._el('img', 'song-fixer-cover-img');
        if (g.image) img.src = g.image;
        img.alt = '';
        const text = this._el('div', 'song-fixer-cover-text');
        text.appendChild(this._el('div', 'zune-diff-title', `on ${g.count} song${g.count === 1 ? '' : 's'}`));
        text.appendChild(this._el('div', 'zune-diff-meta', g.kind === 'site'
          ? `on ${g.artists} different artists, and ${g.siteSongs} of the songs have a website in the name \u2014 likely the site\u2019s logo`
          : g.kind === 'single'
            ? 'all by one artist \u2014 probably the real album cover (listed because the songs came from a website; leave it unticked unless it\u2019s a logo)'
            : `same picture on ${g.artists} artists and ${g.albums} albums`));
        for (const ex of g.examples) text.appendChild(this._el('div', 'song-fixer-dim song-fixer-cover-ex', ex));
        card.append(box, img, text);
        grid.appendChild(card);
      }
      art.appendChild(grid);
    }
    c.appendChild(art);
  }

  _siteChangeLines(info, item) {
    const FIELD = { title: 'name', artist: 'artist', album: 'album', albumArtist: 'album artist', genre: 'genre' };
    const show = (v) => (v ? `“${v}”` : 'empty');
    for (const [f, nv] of Object.entries(item.changes)) {
      const line = this._el('div', 'song-fixer-result song-fixer-site-change');
      line.appendChild(this._el('span', 'song-fixer-dim', `${FIELD[f] || f}: `));
      line.appendChild(this._el('span', 'song-fixer-site-old', show(item.tags[f])));
      line.appendChild(document.createTextNode(' → '));
      line.appendChild(this._el('span', 'song-fixer-site-new', show(nv)));
      info.appendChild(line);
    }
  }

  /** Songs on the Zune whose details contain a website. */
  _zuneSiteItems() {
    const logic = window.songFixerLogic;
    const out = [];
    for (const d of this.explorer.zunePanel?.browseData?.music || []) {
      if (d.handle == null) continue;
      const tags = { title: d.title, artist: d.artist, album: d.album, genre: d.genre };
      const changes = logic.stripSiteTags(tags, d.filename || '');
      if (Object.keys(changes).length) out.push({ handle: d.handle, item: d, tags, changes });
    }
    return logic.sortSongs(out, 'title', (i) => ({ title: i.item.title, artist: i.item.artist, album: i.item.album, path: i.item.filename }));
  }

  _drawZuneSites(c) {
    if (!this.zuneSiteSkip) this.zuneSiteSkip = new Set();
    const sec = this._el('div', 'song-fixer-sites');
    sec.appendChild(this._el('h3', 'song-fixer-sites-head', 'website names on your zune'));
    const zp = this.explorer.zunePanel;
    if (zp?.state !== 'connected' || !zp?.browseData) {
      sec.appendChild(this._el('div', 'song-fixer-note',
        'connect your zune and open it in the zune panel so its songs are read, then come back here to clean website names on the zune itself — including songs that aren’t on your computer.'));
      c.appendChild(sec);
      return;
    }
    const items = this._zuneSiteItems();
    if (!items.length) {
      sec.appendChild(this._el('div', 'song-fixer-note', 'no songs on your zune have a website in their details. ✓'));
      c.appendChild(sec);
      return;
    }
    const ticked = items.filter(i => !this.zuneSiteSkip.has(i.handle));
    sec.appendChild(this._el('div', 'song-fixer-note',
      `${items.length} song${items.length === 1 ? '' : 's'} on your zune ${items.length === 1 ? 'has' : 'have'} a website in the details. ` +
      'they’re changed on the zune directly, nothing is re-sent. an album that was only a website is removed from the zune’s album list (the songs stay). ' +
      'first time: try it on a few songs and check them on the zune before doing them all.'));
    const bar = this._el('div', 'zune-diff-actions');
    if (!this.running) {
      const go = this._el('button', 'zune-sync-btn zune-push-btn', `clean ${ticked.length} song${ticked.length === 1 ? '' : 's'} on the zune`);
      go.disabled = !ticked.length;
      go.addEventListener('click', () => this._stripZuneSites(ticked));
      bar.appendChild(go);
      const few = this._el('button', 'song-fixer-link song-fixer-pick', 'tick only the first 3');
      few.addEventListener('click', () => {
        this.zuneSiteSkip = new Set(items.slice(3).map(i => i.handle));
        this._draw();
      });
      bar.appendChild(few);
    }
    sec.appendChild(bar);

    const all = this._el('label', 'zune-diff-select-all');
    const allBox = this._el('input');
    allBox.type = 'checkbox';
    allBox.checked = ticked.length === items.length;
    allBox.disabled = this.running;
    allBox.addEventListener('change', () => {
      if (allBox.checked) this.zuneSiteSkip.clear(); else for (const i of items) this.zuneSiteSkip.add(i.handle);
      this._draw();
    });
    all.append(allBox, document.createTextNode(`${allBox.checked ? 'deselect' : 'select'} all (${items.length} songs)`));
    sec.appendChild(all);

    const limit = this.zuneSiteLimit || PAGE_SIZE;
    for (const it of items.slice(0, limit)) {
      const row = this._el('div', 'zune-diff-item song-fixer-row');
      const box = this._el('input', 'zune-diff-check');
      box.type = 'checkbox';
      box.checked = !this.zuneSiteSkip.has(it.handle);
      box.disabled = this.running;
      box.addEventListener('change', () => {
        if (box.checked) this.zuneSiteSkip.delete(it.handle); else this.zuneSiteSkip.add(it.handle);
        this._draw();
      });
      row.appendChild(box);
      const info = this._el('div', 'zune-diff-info');
      info.appendChild(this._el('div', 'zune-diff-title', it.item.title || it.item.filename || '?'));
      info.appendChild(this._el('div', 'zune-diff-meta', `${it.item.artist || '?'} — ${it.item.album || '?'}`));
      this._siteChangeLines(info, it);
      row.appendChild(info);
      sec.appendChild(row);
    }
    if (items.length > limit) {
      const more = this._el('button', 'song-fixer-link song-fixer-more', `show more (${items.length - limit} left)`);
      more.addEventListener('click', () => { this.zuneSiteLimit = limit + PAGE_SIZE; this._draw(); });
      sec.appendChild(more);
    }
    c.appendChild(sec);
  }

  async _stripZuneSites(items) {
    this.running = true;
    this._draw();
    this._setStatus(`cleaning ${items.length} song${items.length === 1 ? '' : 's'} on the zune… keep it connected.`);
    let res;
    try {
      res = await this.explorer.zunePanel.retagDeviceItems(items.map(i => ({
        handle: i.handle, changes: i.changes, old: { artist: i.item.artist || '', album: i.item.album || '' },
      })));
    } catch (err) {
      res = { done: [], errors: [{ error: err.message }] };
    }
    this.running = false;
    const errs = res.errors || [];
    const why = [...new Set(errs.map(e => e.error))].slice(0, 2).join('; ');
    this._setStatus(`cleaned ${res.done?.length || 0} song${res.done?.length === 1 ? '' : 's'} on the zune` +
      (errs.length ? `, ${errs.length} couldn’t be changed (${why})` : '') + '.' +
      (res.done?.length ? ' check them on the zune; if a change doesn’t show, unplug and replug it.' : ''));
    this._draw();
  }

  async _stripSites(paths) {
    this.running = true;
    this.stopRequested = false;
    this._draw();
    const batchId = String(Date.now());
    const done = [];
    const failed = [];
    for (let n = 0; n < paths.length; n++) {
      if (this.stopRequested) break;
      this._setStatus(`removing websites: ${n + 1} of ${paths.length}…`);
      let p = paths[n];
      const res = await window.electronAPI.songFixerStripSites(batchId, p);
      if (!res.success) { failed.push(res.error); continue; }
      if (res.renamedTo) { this.explorer.renameLibraryPath?.(p, res.renamedTo); p = res.renamedTo; }
      if (Object.keys(res.changed || {}).length) done.push(p);
    }
    this.running = false;
    const why = [...new Set(failed)].slice(0, 2).join('; ');
    this._setStatus(`websites removed from ${done.length} song${done.length === 1 ? '' : 's'}` +
      (failed.length ? `, ${failed.length} couldn’t be saved (${why})` : '') + '.' +
      (done.length ? ' to put the fixes on your zune, press “update zune” at the top of its music list.' : ''));
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
    if (done.length) await this._reloadTracks(done);
    else this._draw();
  }

  async _scanCovers() {
    this.running = true;
    this.coverScanning = true;
    this._draw();
    const paths = [...this.explorer.musicLibrary.tracks.keys()];
    this._setStatus(`reading album art: 0 of ${paths.length}…`);
    const h = window.electronAPI.onSongFixerCoverProgress?.((p) => this._setStatus(`reading album art: ${p.done} of ${p.total}…`));
    let res;
    try { res = await window.electronAPI.songFixerCoverScan(paths); } finally { if (h) window.electronAPI.offSongFixerCoverProgress(h); }
    this.running = false;
    this.coverScanning = false;
    if (!res?.success) {
      this._setStatus('couldn’t read album art: ' + (res?.error || 'unknown error'));
    } else {
      this.coverGroups = res.groups;
      // Pictures not linked to a website start unticked: they need a look first
      this.coverSkip = new Set(res.groups.filter(g => g.kind !== 'site').map(g => g.hash));
      const site = res.groups.filter(g => g.kind === 'site').length;
      const single = res.groups.filter(g => g.kind === 'single').length;
      const spread = res.groups.filter(g => g.kind === 'spread').length;
      const parts = [];
      if (site) parts.push(`${site} likely website logo${site === 1 ? '' : 's'} (on several artists, ticked)`);
      if (spread) parts.push(`${spread} shared by many albums (not ticked)`);
      if (single) parts.push(`${single} probably real album cover${single === 1 ? '' : 's'} from downloaded albums (not ticked)`);
      const partial = res.stopped ? ` (stopped after ${res.read} of ${res.total} songs \u2014 press \u201ccheck album art again\u201d to read them all)` : '';
      this._setStatus((res.groups.length
        ? `${res.groups.length} picture${res.groups.length === 1 ? '' : 's'} to look at: ${parts.join(', ')}. look at each one before removing.`
        : (res.stopped ? 'stopped.' : '')) + partial);
    }
    this._draw();
  }

  async _removeCovers(groups) {
    this.running = true;
    this.stopRequested = false;
    this._draw();
    const batchId = String(Date.now());
    const jobs = groups.flatMap(g => g.paths.map(p => [p, g.hash]));
    const removed = [];
    const failed = [];
    for (let n = 0; n < jobs.length; n++) {
      if (this.stopRequested) break;
      this._setStatus(`removing pictures: ${n + 1} of ${jobs.length}…`);
      const [p, hash] = jobs[n];
      const res = await window.electronAPI.songFixerRemoveCover(batchId, p, hash);
      if (!res.success) failed.push(res.error);
      else if (res.removed) removed.push(p);
    }
    this.running = false;
    const why = [...new Set(failed)].slice(0, 2).join('; ');
    this._setStatus(`picture removed from ${removed.length} song${removed.length === 1 ? '' : 's'}` +
      (failed.length ? `, ${failed.length} couldn’t be changed (${why})` : '') + '.' +
      (removed.length ? ' press “find real album art” to look up their covers, then “update zune” in its music list.' : ''));
    this.coverRemovedPaths = removed;
    const gone = new Set(groups.map(g => g.hash));
    this.coverGroups = (this.coverGroups || []).filter(g => !gone.has(g.hash));
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
    await this._refreshArt(removed);
    this._draw();
  }

  async _findRealArt() {
    const paths = (this.coverRemovedPaths || []).filter(p => this.explorer.musicLibrary.tracks.has(p));
    this.running = true;
    this.stopRequested = false;
    this.findingRealArt = true;
    this._draw();
    const r = await this.explorer.addAlbumArt(paths, {
      shouldStop: () => this.stopRequested,
      standIns: this._standInsOn(),
      onProgress: (n, total) => this._setStatus(`looking for album art: ${n} of ${total}…`),
    });
    this.findingRealArt = false;
    this.running = false;
    if (r) {
      this._setStatus(r.summary + '.' +
        (r.added ? ' ' + this.explorer.zuneArtNote() : ''));
      this.coverRemovedPaths = [];
    }
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
    await this._refreshArt(paths);
    await this._loadStandIns();
    this._draw();
  }

  /** The library shows one picture per album: forget the old one and read the files again. */
  async _refreshArt(paths) {
    const lib = this.explorer.musicLibrary;
    const keys = new Set(paths.map(p => lib.tracks.get(p)?.albumArtKey).filter(Boolean));
    if (!keys.size) return;
    for (const k of keys) delete lib.albumArtMap[k];
    const again = [];
    for (const [p, t] of lib.tracks) if (keys.has(t.albumArtKey)) { delete t.albumArtKey; again.push(p); }
    await window.electronAPI.batchScanAudioMetadata(again, { includeArt: true });
    await new Promise(r => setTimeout(r, 300));
  }

  _localDuplicateItems() {
    const sizes = new Map((this.explorer.categorizedFiles?.music || []).map(f => [f.path, f.size || 0]));
    const out = [];
    for (const [p, t] of this.explorer.musicLibrary.tracks) {
      out.push({
        id: p, title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
        trackNumber: t.trackNumber || 0, year: t.year || 0,
        duration: t.duration || 0, size: sizes.get(p) || 0, hasArt: !!(t.albumArtKey || t.albumArt),
        where: p, format: (p.split('.').pop() || '').toLowerCase(),
      });
    }
    return out;
  }

  _zuneDuplicateItems() {
    const zp = this.explorer.zunePanel;
    const music = zp?.browseData?.music || [];
    return music.filter(d => d.handle).map(d => ({
      id: d.handle, title: d.title, artist: d.artist, album: d.album, trackNumber: d.trackNumber || 0,
      // Zune durations are in milliseconds
      duration: d.duration > 0 ? d.duration / 1000 : 0, size: d.size || 0,
      hasArt: !!(d.albumArt || d.albumArtKey), where: d.filename || '', format: (String(d.filename || '').split('.').pop() || '').toLowerCase(),
    }));
  }

  _drawDuplicates(c) {
    const onZune = this.mode === 'zune-dupes';
    const zp = this.explorer.zunePanel;
    if (onZune && (zp?.state !== 'connected' || !zp?.browseData)) {
      c.appendChild(this._el('div', 'song-fixer-note',
        'connect your zune and open it in the zune panel so its songs are read, then come back here.'));
      return;
    }

    const all = window.songFixerLogic.findDuplicateGroups(onZune ? this._zuneDuplicateItems() : this._localDuplicateItems());
    if (!all.length) {
      c.appendChild(this._el('div', 'song-fixer-note', onZune ? 'no duplicate songs on the zune.' : 'no duplicate songs in your library.'));
      this.statusEl = this._el('div', 'song-fixer-status', this.status);
      c.appendChild(this.statusEl);
      return;
    }
    // "Safe" = exact copies, or extra copies that only add junk tags to a clean song
    const identical = all.filter(g => g.kind !== 'different');
    const different = all.filter(g => g.kind === 'different');
    const groups = this.dupeKind === 'identical' ? identical : different;
    const isTicked = (g, it) => this.dupeChoice.has(it.id) ? this.dupeChoice.get(it.id) : it.id !== g.keepId;
    const ticked = [];
    for (const g of groups) for (const it of g.items) if (isTicked(g, it)) ticked.push(it);
    const extra = (list) => list.reduce((n, g) => n + g.items.length - 1, 0);

    // Identical copies vs different versions
    const kinds = this._el('div', 'zune-diff-group-bar');
    for (const [kind, label, list] of [
      ['identical', 'safe to delete', identical],
      ['different', 'different versions', different],
    ]) {
      const b = this._el('button', 'zune-diff-group-btn' + (this.dupeKind === kind ? ' active' : ''), `${label} (${extra(list)})`);
      b.addEventListener('click', () => { this.dupeKind = kind; this.limit = PAGE_SIZE; this.status = ''; this._draw(); });
      kinds.appendChild(b);
    }
    c.appendChild(kinds);

    c.appendChild(this._el('div', 'song-fixer-note', this.dupeKind === 'identical'
      ? 'exact copies (same album, size and length), and messy copies (same song and length, but with junk tags like ID codes or “unknown album”) of a song you have properly tagged. the clean copy is kept, so these are safe to delete without checking each one.'
      : 'same song but a different album or a different file (quality, length). the best copy is picked for you and its reasons are shown — worth a quick look before deleting.'));

    const bar = this._el('div', 'zune-diff-actions song-fixer-actions');
    const del = this._el('button', 'zune-sync-btn zune-diff-delete-btn',
      `delete ${ticked.length} cop${ticked.length === 1 ? 'y' : 'ies'}${onZune ? ' from zune' : ''}`);
    del.disabled = ticked.length === 0 || this.running;
    this._confirmButton(del,
      () => onZune ? `delete ${ticked.length} from the zune? click again` : `move ${ticked.length} to trash? click again`,
      () => {
        if (onZune) return this._deleteZuneDupes(ticked.map(i => i.id));
        // For each copy being deleted: the copies in its group being kept
        const keepers = {};
        for (const g of groups) {
          const keep = g.items.filter(it => !isTicked(g, it)).map(it => it.id);
          for (const it of g.items) if (isTicked(g, it) && keep.length) keepers[it.id] = keep;
        }
        return this._deleteLocal(ticked.map(i => i.id), { removeFromZune: false, keepers });
      });
    bar.appendChild(del);
    c.appendChild(bar);
    this.statusEl = this._el('div', 'song-fixer-status', this.status);
    c.appendChild(this.statusEl);

    const list = this._el('div', 'song-fixer-list');
    if (!groups.length) list.appendChild(this._el('div', 'zune-diff-empty', 'none in this list'));
    for (const g of groups.slice(0, this.limit)) {
      const head = this._el('div', 'zune-diff-group-header song-fixer-dupe-head');
      head.appendChild(this._el('span', 'zune-diff-group-name', `${g.title} — ${g.artist || '?'}`));
      const kindLabel = { identical: 'exact copies', messy: 'messy copies of a clean song' }[g.kind] || 'different versions';
      head.appendChild(this._el('span', 'zune-diff-group-meta', `${g.items.length} copies · ${kindLabel}`));
      list.appendChild(head);
      for (const it of g.items) {
        const keep = it.id === g.keepId;
        const row = this._el('label', 'zune-diff-item song-fixer-row' + (keep ? ' song-fixer-keep' : ''));
        const box = this._el('input', 'zune-diff-check');
        box.type = 'checkbox';
        box.checked = isTicked(g, it);
        box.addEventListener('change', () => { this.dupeChoice.set(it.id, box.checked); this._draw(); });
        row.appendChild(box);
        const info = this._el('div', 'zune-diff-info');
        const mins = it.duration ? `${Math.floor(it.duration / 60)}:${String(Math.round(it.duration % 60)).padStart(2, '0')}` : '';
        const size = it.size ? `${(it.size / 1048576).toFixed(1)} MB` : '';
        info.appendChild(this._el('div', 'zune-diff-title', it.album || 'no album'));
        info.appendChild(this._el('div', 'zune-diff-meta', [it.format, mins, size, it.where].filter(Boolean).join('  ·  ')));
        const why = this._el('div', 'song-fixer-why');
        if (keep) {
          why.appendChild(this._el('span', 'song-fixer-keep-label', 'keep'));
          if (it.good.length) why.appendChild(document.createTextNode(' — ' + it.good.join(', ')));
        } else if (it.bad.length) {
          why.appendChild(document.createTextNode(it.bad.join(', ')));
        }
        info.appendChild(why);
        if (!onZune) {
          row.appendChild(this._playButton(it.id));
          row.addEventListener('contextmenu', (e) => this._songMenu(e, it.id));
        }
        row.appendChild(info);
        list.appendChild(row);
      }
    }
    if (groups.length > this.limit) {
      const more = this._el('button', 'song-fixer-link song-fixer-more', `show more (${groups.length - this.limit} left)`);
      more.addEventListener('click', () => { this.limit += PAGE_SIZE; this._draw(); });
      list.appendChild(more);
    }
    c.appendChild(list);
  }

  async _deleteZuneDupes(handles) {
    const zp = this.explorer.zunePanel;
    this.running = true;
    this._setStatus(`deleting ${handles.length} from the zune\u2026`);
    try {
      const res = await zp.deleteDeviceItems(handles);
      const failed = (res.errors || []).length;
      this._setStatus(`${handles.length - failed} removed from the zune${failed ? `, ${failed} couldn\u2019t be removed` : ''}.`);
    } catch (err) {
      this._setStatus('delete failed: ' + err.message);
    }
    this.running = false;
    for (const h of handles) this.dupeChoice.delete(h);
    this._draw();
  }

  // ---- deleting from the computer -------------------------------------------

  async _deleteLocal(paths, { removeFromZune, keepers }) {
    // Large deletes get an extra, explicit question (they're easy to trigger
    // by accident with "select all")
    if (paths.length > 50 && !window.confirm(
      `Move ${paths.length} songs to the Trash?\n\nThat's a lot of songs. You can put them back from the Trash, but check that this is what you meant.`)) {
      this._setStatus('nothing deleted.');
      return;
    }
    this.running = true;
    this._setStatus(`moving ${paths.length} song${paths.length === 1 ? '' : 's'} to the trash\u2026`);
    const res = await window.electronAPI.songFixerTrash(paths, { removeFromZune, keepers });
    this.running = false;
    if (!res.success) {
      this._setStatus('delete failed: ' + res.error);
      this._draw();
      return;
    }

    // Take them out of the library everywhere in the app (including files
    // that were already gone from disk)
    const gone = new Set([...res.trashed, ...(res.missing || [])]);
    const ex = this.explorer;
    for (const p of gone) ex.musicLibrary.tracks.delete(p);
    if (ex.categorizedFiles?.music) ex.categorizedFiles.music = ex.categorizedFiles.music.filter(f => !gone.has(f.path));
    ex.rebuildMusicIndexes?.();
    this.items = this.items.filter(i => !gone.has(i.path));
    for (const p of gone) this.dupeChoice.delete(p);
    const zp = ex.zunePanel;
    if (zp?.diffActive) {
      zp._computeDiff();
      zp._renderDiffSummary();
      zp._destroyDiffScroller();
      zp._renderDiffList();
    }

    const missingN = (res.missing || []).length;
    const blocked = res.failed.filter(f => f.keeperMissing).length;
    const otherFailed = res.failed.filter(f => !f.keeperMissing);
    const parts = [`${res.trashed.length} moved to the trash`];
    if (missingN) parts.push(`${missingN} were already gone from your computer (removed from the list)`);
    if (blocked) parts.push(`${blocked} kept because the copy you\u2019re keeping isn\u2019t available right now (is its drive connected?)`);
    if (otherFailed.length) parts.push(`${otherFailed.length} couldn\u2019t be moved (${otherFailed[0].error})`);
    this._setStatus(parts.join(', ') + '.' +
      (removeFromZune && res.trashed.length ? ' to remove them from your zune too, press \u201cupdate zune\u201d in its music list.' : ''));
    this._draw();
  }

  // ---- actions --------------------------------------------------------------

  async _identify(items) {
    this.running = true;
    this.stopRequested = false;
    this._refreshActions();
    let found = 0, none = 0, failed = 0, confirmed = 0, matched = 0;
    const newlyConfirmed = [];
    if (items.length > 60) {
      const mins = Math.max(1, Math.round(items.length * 2 / 60));
      this.explorer.showToast?.(`checking ${items.length} songs takes about ${mins < 90 ? mins + ' minutes' : Math.round(mins / 60) + ' hours'} \u2014 you can press stop any time; checked songs are remembered`);
    }

    for (let n = 0; n < items.length; n++) {
      if (this.stopRequested) break;
      const item = items[n];
      item.state = 'working';
      this._updateRow(item);
      this._setStatus(`identifying ${n + 1} of ${items.length}…`);

      const t = item.track || {};
      const res = await window.electronAPI.songFixerIdentify(item.path, {
        title: t.title, artist: t.artist, album: t.album, duration: t.duration,
      });
      if (!res.success) {
        item.state = 'error';
        item.error = res.error;
        failed++;
        // A bad key will fail every song the same way; stop and say so.
        if (/key/i.test(res.error || '')) {
          this._updateRow(item);
          this.explorer.showToast?.(res.error);
          break;
        }
      } else if (!res.proposal) {
        item.state = 'none';
        item.note = res.note || null;
        none++;
      } else {
        const really = window.songFixerLogic.meaningfulChanges(res.current, res.proposal);
        if (!really.length && res.proposal.source === 'sound') {
          // The audio says this is exactly what the tags already say
          item.state = 'confirmed';
          item.selected = false;
          item.result = res;
          newlyConfirmed.push(item.path);
          confirmed++;
        } else if (!really.length) {
          // The sound database doesn't know this recording (live versions,
          // demos, remixes...), but MusicBrainz has a song by exactly this
          // name and artist: nothing to change, most likely right
          item.state = 'matched';
          item.selected = false;
          item.result = res;
          matched++;
        } else {
          item.result = res;
          item.albumIdx = 0;
          item.state = 'found';
          found++;
        }
      }
      this._updateRow(item);
      // Save confirmations as we go, so a long run can be stopped and resumed
      if (newlyConfirmed.length >= 20) {
        const batch = newlyConfirmed.splice(0);
        batch.forEach(p => this.confirmed.add(p));
        window.electronAPI.songFixerConfirmedAdd(batch);
      }
    }
    if (newlyConfirmed.length) {
      newlyConfirmed.forEach(p => this.confirmed.add(p));
      await window.electronAPI.songFixerConfirmedAdd(newlyConfirmed.splice(0));
    }

    // Anything still marked working (stopped early) goes back to idle, and songs
    // that weren't recognised are unticked so "apply" is the obvious next step.
    for (const i of items) {
      if (i.state === 'working') i.state = 'idle';
      if (i.state === 'none' || i.state === 'error') i.selected = false;
    }
    this.running = false;
    this._setStatus(`${confirmed ? `${confirmed} confirmed correct, ` : ''}${matched ? `${matched} name found as is (most likely right), ` : ''}${found} ${confirmed ? 'look wrong' : 'recognised'}, ${none} not recognised${failed ? `, ${failed} failed (couldn\u2019t reach the music databases \u2014 try those again later)` : ''}. ` +
      (found ? 'check the suggestions, untick any that look wrong, then press apply. ' : '') +
      (none + failed ? 'for the rest: \u201cshow only: not recognised\u201d below, then \u201cclean up names\u201d \u2014 or \u201cedit\u201d one song.' : ''));
    this._drawList();
    this._refreshActions();
  }

  async _apply(items) {
    this.running = true;
    this.stopRequested = false;
    this._refreshActions();
    const batchId = String(Date.now());
    const fixedPaths = [];
    let failed = 0;

    for (let n = 0; n < items.length; n++) {
      if (this.stopRequested) break;
      const item = items[n];
      this._setStatus(`saving ${n + 1} of ${items.length}…`);
      const p = this._proposal(item);
      const tags = {};
      for (const f of ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNumber', 'discNumber']) {
        if (p[f] != null && p[f] !== '') tags[f] = p[f];
      }
      // Fields that only held junk (an album that was a website) get emptied
      for (const f of p.clear || []) if (!(f in tags)) tags[f] = '';
      const res = await window.electronAPI.songFixerApply(batchId, item.path, tags, { releaseGroupId: p.releaseGroupId, addCover: true });
      if (res.success) {
        // Saved as ".net" etc.: it now has its real ending, e.g. ".mp3"
        if (res.renamedTo) {
          this.explorer.renameLibraryPath?.(item.path, res.renamedTo);
          item.path = res.renamedTo;
        }
        item.state = 'applied';
        item.selected = false;
        item.applyError = null;
        fixedPaths.push(item.path);
      } else {
        // Keep the suggestion so it can simply be applied again
        item.applyError = res.error;
        failed++;
      }
      this._updateRow(item);
    }

    this.running = false;
    this._setStatus(`${fixedPaths.length} song${fixedPaths.length === 1 ? '' : 's'} fixed${failed ? `, ${failed} couldn’t be saved` : ''}. ` +
      (fixedPaths.length ? 'to put the fixes on your zune, connect it and press \u201cupdate zune\u201d at the top of its music list (not \u201csync music\u201d, which sends everything).' : ''));
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
    this._refreshActions();
    if (fixedPaths.length) await this._reloadTracks(fixedPaths);
  }

  async _setIgnored(items, ignore) {
    const paths = items.map(i => i.path);
    await window.electronAPI.songFixerIgnoredSet(paths, ignore);
    for (const i of items) {
      i.ignored = ignore;
      i.selected = false;
      if (ignore) this.ignored.add(i.path); else this.ignored.delete(i.path);
    }
    this._setStatus(ignore
      ? `${items.length} song${items.length === 1 ? '' : 's'} ignored \u2014 they won\u2019t be listed here again unless the file changes (\u201call songs\u201d \u2192 show only: ignored, to bring them back).`
      : `${items.length} song${items.length === 1 ? '' : 's'} back on the needs fixing list.`);
    this._draw();
  }

  async _undo() {
    if (!this.undoInfo?.count) return;
    this.running = true;
    this._refreshActions();
    this._setStatus(`undoing ${this.undoInfo.count} change${this.undoInfo.count === 1 ? '' : 's'}…`);
    const res = await window.electronAPI.songFixerUndo();
    this.running = false;
    if (!res.success) {
      this._setStatus('undo failed: ' + res.error);
    } else {
      for (const p of res.restored) {
        const item = this.items.find(i => i.path === p);
        if (item) { item.state = 'idle'; item.result = null; }
      }
      this._setStatus(`restored ${res.restored.length} song${res.restored.length === 1 ? '' : 's'}` +
        (res.failed.length ? `, ${res.failed.length} couldn’t be restored` : '') + '.');
      if (res.restored.length) await this._reloadTracks(res.restored);
    }
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch {}
    this._refreshActions();
  }

  /** Re-read changed files so the library (and this list) show the new tags. */
  async _reloadTracks(paths) {
    await window.electronAPI.batchScanAudioMetadata(paths, { includeArt: true });
    // The scan results arrive through the library's normal scan handler
    await new Promise(r => setTimeout(r, 300));
    this._loadItems();
    // Whole page, so the "N songs need fixing" count updates too
    if (this.container?.isConnected) this._draw();
  }
}

window.SongFixerView = SongFixerView;
