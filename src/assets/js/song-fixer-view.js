/* global document, window */
// Settings → library → fix song info.
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
      items.push(old ? Object.assign(old, { track, reasons }) : {
        path, track, reasons, state: 'idle', result: null, albumIdx: 0, selected: false, error: null,
      });
    }
    items.sort((a, b) => (a.track.title || '').localeCompare(b.track.title || ''));
    this.items = items;
  }

  _visible() {
    const q = this.filter.trim().toLowerCase();
    return this.items.filter(i =>
      (this.mode === 'all' || i.reasons.length > 0 || i.state !== 'idle') &&
      (!q || [i.track.title, i.track.artist, i.track.album, i.path].some(v => String(v || '').toLowerCase().includes(q))));
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
    if (!this.running) this._loadItems();
    try { this.undoInfo = await window.electronAPI.songFixerUndoInfo(); } catch { this.undoInfo = null; }
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

    const suspects = this.items.filter(i => i.reasons.length > 0).length;
    const summary = this._el('div', 'zune-diff-summary song-fixer-summary');
    summary.appendChild(this._el('span', 'zune-diff-stat zune-diff-stat-push', `${suspects} songs need fixing`));
    summary.appendChild(this._el('span', 'zune-diff-stat', `${this.items.length} songs in library`));
    c.appendChild(summary);

    // Which songs to list
    const tabs = this._el('div', 'zune-diff-tabs');
    for (const [label, mode] of [['needs fixing', 'fix'], ['all songs', 'all'], ['duplicates', 'dupes'], ['duplicates on zune', 'zune-dupes']]) {
      const t = this._el('button', 'zune-diff-tab' + (this.mode === mode ? ' active' : ''), label);
      t.addEventListener('click', () => { if (this.running) return; this.mode = mode; this.limit = PAGE_SIZE; this.status = ''; this._draw(); });
      tabs.appendChild(t);
    }
    c.appendChild(tabs);

    if (this.mode === 'dupes' || this.mode === 'zune-dupes') {
      this._drawDuplicates(c);
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
    const toIdentify = selected.filter(i => i.state !== 'found' && i.state !== 'applied' && i.state !== 'working');
    const toApply = selected.filter(i => i.state === 'found');

    if (this.running) {
      const stop = this._el('button', 'zune-sync-btn zune-pull-btn', 'stop');
      stop.addEventListener('click', () => { this.stopRequested = true; stop.disabled = true; stop.textContent = 'stopping…'; });
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

    bar.append(identify, apply);

    // Songs that can't be fixed (or aren't wanted) can go to the Trash
    const toDelete = selected.filter(i => i.state !== 'working' && i.state !== 'applied');
    const del = this._el('button', 'zune-sync-btn zune-diff-delete-btn', `delete ${toDelete.length} song${toDelete.length === 1 ? '' : 's'}`);
    del.disabled = toDelete.length === 0;
    del.title = 'moves the files to the Trash; their copies on the zune are removed the next time you press \u201cupdate zune\u201d';
    this._confirmButton(del, () => `move ${toDelete.length} to trash and remove from zune? click again`,
      () => this._deleteLocal(toDelete.map(i => i.path), { removeFromZune: true }));
    bar.appendChild(del);

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
    const visible = this._visible();

    if (visible.length === 0) {
      wrap.appendChild(this._el('div', 'zune-diff-empty', this.mode === 'all' ? 'no songs match' : 'no songs need fixing — nice'));
      return;
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
    wrap.appendChild(all);

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
    info.appendChild(this._el('div', 'zune-diff-meta', meta));
    info.appendChild(this._resultLine(item));
    row.appendChild(info);
    row.appendChild(this._playButton(item.path));
    return row;
  }

  _resultLine(item) {
    const line = this._el('div', 'song-fixer-result');
    switch (item.state) {
      case 'working':
        line.textContent = 'listening…';
        return line;
      case 'none':
        line.textContent = this.hasKey ? 'not recognised by sound or title' : 'not found by title';
        line.classList.add('dim');
        return line;
      case 'error':
        line.textContent = item.error || 'something went wrong';
        line.classList.add('bad');
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
    parts.forEach(([field, value], idx) => {
      if (idx) line.appendChild(document.createTextNode(' — '));
      const changed = changes.some(c => c.field === field);
      line.appendChild(this._el('span', changed ? 'song-fixer-changed' : '', value || '?'));
    });
    const extra = [p.year, p.trackNumber ? `track ${p.trackNumber}` : null].filter(Boolean).join(', ');
    if (extra) line.appendChild(document.createTextNode(` (${extra})`));
    if (p.source === 'title') {
      line.appendChild(this._el('span', 'song-fixer-title-match', '  found by title \u2014 check it'));
    } else {
      line.appendChild(this._el('span', 'song-fixer-score', `  ${pct}% match`));
    }
    if (changes.length === 0) line.appendChild(this._el('span', 'song-fixer-score', ' · tags already match'));

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
    const b = this._el('button', 'song-play-btn', '\u25B6');
    b.title = 'play';
    b.addEventListener('click', (e) => {
      // Rows are labels; don't let the click tick the checkbox
      e.preventDefault();
      e.stopPropagation();
      this.explorer.playPath?.(filePath);
    });
    return b;
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

  // ---- duplicates -----------------------------------------------------------

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
      () => onZune ? this._deleteZuneDupes(ticked.map(i => i.id)) : this._deleteLocal(ticked.map(i => i.id), { removeFromZune: false }));
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
        row.appendChild(info);
        if (!onZune) row.appendChild(this._playButton(it.id));
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

  async _deleteLocal(paths, { removeFromZune }) {
    this.running = true;
    this._setStatus(`moving ${paths.length} song${paths.length === 1 ? '' : 's'} to the trash\u2026`);
    const res = await window.electronAPI.songFixerTrash(paths, { removeFromZune });
    this.running = false;
    if (!res.success) {
      this._setStatus('delete failed: ' + res.error);
      this._draw();
      return;
    }

    // Take them out of the library everywhere in the app
    const gone = new Set(res.trashed);
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

    this._setStatus(`${res.trashed.length} moved to the trash` +
      (res.failed.length ? `, ${res.failed.length} couldn\u2019t be moved (${res.failed[0].error})` : '') + '.' +
      (removeFromZune && res.trashed.length ? ' to remove them from your zune too, press \u201cupdate zune\u201d in its music list.' : ''));
    this._draw();
  }

  // ---- actions --------------------------------------------------------------

  async _identify(items) {
    this.running = true;
    this.stopRequested = false;
    this._refreshActions();
    let found = 0, none = 0, failed = 0;

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
        none++;
      } else {
        item.result = res;
        item.albumIdx = 0;
        item.state = 'found';
        found++;
      }
      this._updateRow(item);
    }

    // Anything still marked working (stopped early) goes back to idle, and songs
    // that weren't recognised are unticked so "apply" is the obvious next step.
    for (const i of items) {
      if (i.state === 'working') i.state = 'idle';
      if (i.state === 'none' || i.state === 'error') i.selected = false;
    }
    this.running = false;
    this._setStatus(`${found} recognised, ${none} not recognised${failed ? `, ${failed} failed` : ''}. ` +
      (found ? 'check the suggestions, untick any that look wrong, then press apply.' : ''));
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
      const res = await window.electronAPI.songFixerApply(batchId, item.path, tags, { releaseGroupId: p.releaseGroupId, addCover: true });
      if (res.success) {
        item.state = 'applied';
        item.selected = false;
        fixedPaths.push(item.path);
      } else {
        item.state = 'error';
        item.error = res.error;
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
    if (this.container?.isConnected) this._drawList();
  }
}

window.SongFixerView = SongFixerView;
