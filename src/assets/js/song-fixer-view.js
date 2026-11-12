/* global document, window */
// Settings → library → fix song info.
// Finds songs with missing or messy tags, recognises them by their audio
// (AcoustID), shows the proposed changes, and writes only what you approve.

const PAGE_SIZE = 200;

class SongFixerView {
  constructor(explorer) {
    this.explorer = explorer;
    this.items = null;          // [{ path, track, reasons, state, result, albumIdx, selected, error }]
    this.showAll = false;
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
      (this.showAll || i.reasons.length > 0 || i.state !== 'idle') &&
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
    if (!key) return;

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
    for (const [label, all] of [['needs fixing', false], ['all songs', true]]) {
      const t = this._el('button', 'zune-diff-tab' + (this.showAll === all ? ' active' : ''), label);
      t.addEventListener('click', () => { this.showAll = all; this.limit = PAGE_SIZE; this._draw(); });
      tabs.appendChild(t);
    }
    c.appendChild(tabs);

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
    identify.addEventListener('click', () => this._identify(toIdentify));

    const apply = this._el('button', 'zune-sync-btn zune-pull-btn', `apply ${toApply.length} fix${toApply.length === 1 ? '' : 'es'}`);
    apply.disabled = toApply.length === 0;
    apply.addEventListener('click', () => this._apply(toApply));

    bar.append(identify, apply);

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
      wrap.appendChild(this._el('div', 'zune-diff-empty', this.showAll ? 'no songs match' : 'no songs need fixing — nice'));
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
    return row;
  }

  _resultLine(item) {
    const line = this._el('div', 'song-fixer-result');
    switch (item.state) {
      case 'working':
        line.textContent = 'listening…';
        return line;
      case 'none':
        line.textContent = 'not recognised';
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
    line.appendChild(this._el('span', 'song-fixer-score', `  ${pct}% match`));
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

      const res = await window.electronAPI.songFixerIdentify(item.path);
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
      (fixedPaths.length ? 'to put the fixes on your zune, connect it and press \u201cupdate fixed songs\u201d at the top of its music list (not \u201csync music\u201d, which sends everything).' : ''));
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
