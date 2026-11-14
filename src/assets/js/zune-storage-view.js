/* global document, window */
// Settings → zune storage: everything on the Zune with its size, to find what
// takes up the most space and remove it. Songs show whether this computer
// also has them, so it's clear what's safe to take off.

const ZS_PAGE = 300;

function zsEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function zsSize(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function zsTime(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

class ZuneStorageView {
  constructor(explorer) {
    this.explorer = explorer;
    this.cat = 'all';       // all | music | videos | pictures | podcasts
    this.group = 'items';   // items | albums | artists
    this.sortKey = 'size';  // column: title | artist | album | cat | duration | kbps | size | on | count
    this.sortDir = -1;      // largest first
    this.sortKey2 = null;   // shift-click: second column
    this.sortDir2 = 1;
    this.anchor = null;     // for shift-click ranges
    this.query = '';
    this.onlyZune = false;  // songs only on the zune
    this.selected = new Set();
    this.limit = ZS_PAGE;
  }

  async render(container) {
    this.container = container;
    container.classList.add('song-fixer', 'zune-storage');
    const zp = this.explorer.zunePanel;
    if (zp?.state === 'connected' && zp.browseData && !this.explorer._zuneMembership) {
      try { await this.explorer._loadZuneMembership(); } catch { /* shown without it */ }
    }
    this._draw();
  }

  /** Everything on the Zune as one list. */
  _items() {
    const zp = this.explorer.zunePanel;
    const bd = zp?.browseData || {};
    const zm = this.explorer._zuneMembership;
    const onComputer = new Set();
    const localOf = new Map(); // handle -> this computer's copy
    if (zm && !zm.none) for (const [p, h] of zm.onZune) { onComputer.add(h); localOf.set(h, p); }
    const tidy = (v) => (window.songFixerLogic ? window.songFixerLogic.cleanTagText(v) : v) || '';
    const secs = (d) => (d > 36000 ? d / 1000 : d) || 0;
    const out = [];
    const add = (cat, list, f) => { for (const d of list || []) if (d && d.handle != null) out.push({ cat, handle: d.handle, size: d.size || 0, ...f(d) }); };
    add('music', bd.music, d => {
      const sec = secs(d.duration);
      return {
        title: tidy(d.title) || d.title || d.filename || '?', artist: tidy(d.artist) || '', album: tidy(d.album) || '',
        duration: sec, kbps: d.size && sec >= 1 ? Math.round(d.size * 8 / sec / 1000) : 0,
        onComputer: zm && !zm.none ? onComputer.has(d.handle) : null,
        localPath: localOf.get(d.handle) || null,
      };
    });
    add('videos', bd.videos, d => ({ title: d.title || d.filename || '?', artist: '', album: '', duration: secs(d.duration), kbps: 0, onComputer: null }));
    add('pictures', bd.pictures, d => ({ title: d.filename || d.title || '?', artist: '', album: d.album || '', duration: 0, kbps: 0, onComputer: null }));
    add('podcasts', bd.podcasts, d => ({ title: d.title || '?', artist: d.seriesName || '', album: d.seriesName || '', duration: secs(d.duration), kbps: 0, onComputer: null }));
    return out;
  }

  _visible() {
    const q = this.query.trim().toLowerCase();
    let list = this._items().filter(i =>
      (this.cat === 'all' || i.cat === this.cat) &&
      (!this.onlyZune || i.onComputer === false) &&
      (!q || [i.title, i.artist, i.album].some(v => String(v || '').toLowerCase().includes(q))));
    if (this.group !== 'items') {
      // One row per album or artist, with the total size of its items
      const groups = new Map();
      for (const i of list) {
        const name = this.group === 'albums' ? (i.album || '(no album)') : (i.artist || '(no artist)');
        const key = this.group === 'albums' ? `${i.artist}|||${name}` : name.toLowerCase();
        if (!groups.has(key)) groups.set(key, { group: true, key, title: name, artist: this.group === 'albums' ? i.artist : '', items: [], size: 0, duration: 0 });
        const g = groups.get(key);
        g.items.push(i);
        g.size += i.size;
        g.duration += i.duration;
      }
      // "on computer" is only known for songs
      const where = (items) => {
        const songs = items.filter(i => i.onComputer === true || i.onComputer === false);
        if (!songs.length) return null;
        const here = songs.filter(i => i.onComputer).length;
        return here === songs.length ? true : here ? 'some' : false;
      };
      list = [...groups.values()].map(g => ({ ...g, count: g.items.length, onComputer: where(g.items) }));
    }
    const ON = { false: 1, some: 2, true: 3 }; // only on zune first
    const val = (r, k) => (k === 'on' ? (r.onComputer == null ? 0 : ON[String(r.onComputer)]) : r[k]);
    const coll = this._coll || (this._coll = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }));
    const cmp = (a, b, k, d) => {
      const va = val(a, k), vb = val(b, k);
      if (!va !== !vb) return va ? -1 : 1; // unknown / empty last
      return typeof va === 'number' || typeof vb === 'number' ? ((va || 0) - (vb || 0)) * d : coll.compare(String(va || ''), String(vb || '')) * d;
    };
    const k2 = this.sortKey2 && this.sortKey2 !== this.sortKey ? this.sortKey2 : null;
    return list.sort((a, b) => cmp(a, b, this.sortKey, this.sortDir) || (k2 ? cmp(a, b, k2, this.sortDir2) : 0) || coll.compare(String(a.title), String(b.title)));
  }

  _handlesOf(row) { return row.group ? row.items.map(i => i.handle) : [row.handle]; }

  _draw() {
    const c = this.container;
    if (!c) return;
    c.innerHTML = '';
    const zp = this.explorer.zunePanel;
    if (zp?.state !== 'connected' || !zp.browseData) {
      c.appendChild(zsEl('div', 'song-fixer-note', 'connect your zune and open it in the zune panel so its contents are read, then come back here.'));
      return;
    }

    // Space used and free
    const st = zp.lastStatus?.storage;
    const all = this._items();
    const byCat = { music: 0, videos: 0, pictures: 0, podcasts: 0 };
    for (const i of all) byCat[i.cat] += i.size;
    if (st && st.maxCapacity) {
      const bar = zsEl('div', 'zs-bar');
      const colors = { music: '#ff6900', videos: '#e0245e', pictures: '#3b82f6', podcasts: '#9b59b6' };
      for (const [k, v] of Object.entries(byCat)) {
        const seg = zsEl('div', 'zs-seg');
        seg.style.width = ((v / st.maxCapacity) * 100).toFixed(2) + '%';
        seg.style.background = colors[k];
        seg.title = `${k}: ${zsSize(v)}`;
        bar.appendChild(seg);
      }
      c.appendChild(bar);
      c.appendChild(zsEl('div', 'zs-sum',
        `${zsSize(st.freeSpace)} free of ${zsSize(st.maxCapacity)} · music ${zsSize(byCat.music)} · videos ${zsSize(byCat.videos)} · pictures ${zsSize(byCat.pictures)} · podcasts ${zsSize(byCat.podcasts)}`));
    }

    // Search, type, grouping, order
    const controls = zsEl('div', 'zs-controls');
    const search = zsEl('input', 'zune-diff-filter-input zs-search');
    search.placeholder = 'search the zune…';
    search.value = this.query;
    search.addEventListener('input', () => { this.query = search.value; this.limit = ZS_PAGE; this._drawList(); });
    const select = (opts, value, onChange) => {
      const s = zsEl('select', 'song-sort-select');
      for (const [v, label] of opts) { const o = zsEl('option', null, label); o.value = v; s.appendChild(o); }
      s.value = value;
      s.addEventListener('change', () => { onChange(s.value); this.limit = ZS_PAGE; this._draw(); });
      return s;
    };
    controls.append(search,
      select([['all', 'everything'], ['music', 'music'], ['videos', 'videos'], ['pictures', 'pictures'], ['podcasts', 'podcasts']], this.cat, v => { this.cat = v; }),
      select([['items', 'each item'], ['albums', 'by album'], ['artists', 'by artist']], this.group, v => {
        this.group = v;
        this.selected.clear();
        // Columns differ between items and groups
        const ok = this._cols().map(c => c[0]);
        if (!ok.includes(this.sortKey)) { this.sortKey = 'size'; this.sortDir = -1; }
        if (!ok.includes(this.sortKey2)) this.sortKey2 = null;
      }));
    const oz = zsEl('label', 'media-opt');
    const ozBox = zsEl('input');
    ozBox.type = 'checkbox';
    ozBox.checked = this.onlyZune;
    ozBox.addEventListener('change', () => { this.onlyZune = ozBox.checked; this._draw(); });
    oz.append(ozBox, document.createTextNode(' only songs not on my computer'));
    oz.title = 'songs whose only copy is on the zune';
    controls.appendChild(oz);
    c.appendChild(controls);

    c.tabIndex = -1;
    if (!c.dataset.zsKeys) {
      c.dataset.zsKeys = '1';
      c.addEventListener('keydown', (e) => {
        if (e.target.closest('input, textarea, select')) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault(); e.stopPropagation();
          for (const r of (this.rows || []).slice(0, this.limit)) this.selected.add(this._rowKey(r));
          this._paintSelection();
        } else if (e.key === 'Escape' && this.selected.size) {
          e.preventDefault(); e.stopPropagation();
          this.selected.clear();
          this._paintSelection();
        }
      });
    }
    this.selBar = zsEl('div', 'songs-table-selbar zs-selbar');
    // Search, filters, selection bar and column headers stay at the top while scrolling
    const sticky = zsEl('div', 'zs-sticky');
    c.insertBefore(sticky, controls);
    sticky.append(controls, this.selBar);
    this.headEl = zsEl('div', 'zs-headwrap');
    sticky.appendChild(this.headEl);
    this.listEl = zsEl('div', 'zs-list');
    c.appendChild(this.listEl);
    this._drawList();
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }

  _cols() {
    if (this.group === 'items') {
      return [['play', ''], ['title', 'title'], ['artist', 'artist'], ['album', 'album'], ['cat', 'type'], ['duration', 'time'], ['kbps', 'quality'], ['size', 'size'], ['on', 'on']];
    }
    return this.group === 'albums'
      ? [['title', 'album'], ['artist', 'artist'], ['count', 'items'], ['duration', 'time'], ['size', 'size'], ['on', 'on']]
      : [['title', 'artist'], ['count', 'items'], ['duration', 'time'], ['size', 'size'], ['on', 'on']];
  }

  _rowKey(r) { return r.group ? 'g:' + r.key : String(r.handle); }

  /** Handles of the selected rows (a selected album or artist counts all its items). */
  _selectedHandles() {
    const out = new Set();
    for (const r of this.rows || []) if (this.selected.has(this._rowKey(r))) for (const h of this._handlesOf(r)) out.add(h);
    return [...out];
  }

  _drawSelBar() {
    const bar = this.selBar;
    bar.innerHTML = '';
    bar.style.display = '';
    const byHandle = new Map(this._items().map(i => [i.handle, i]));
    const sel = this._selectedHandles().map(h => byHandle.get(h)).filter(Boolean);
    bar.classList.toggle('empty', !sel.length);
    if (!sel.length) {
      bar.appendChild(zsEl('span', 'songs-table-selhint', 'click to select · ⌘-click to add more, shift-click for a range, ⌘A for all shown · click a column to sort, shift-click another to sort within it'));
      return;
    }
    const bytes = sel.reduce((s, i) => s + i.size, 0);
    const notHere = sel.filter(i => i.onComputer === false).length;
    bar.appendChild(zsEl('span', 'songs-table-selcount', `${sel.length} selected · frees ${zsSize(bytes)}`));
    const rm = zsEl('button', 'songs-table-selbtn danger', 'remove from zune');
    rm.addEventListener('click', () => this._remove(sel));
    const clear = zsEl('button', 'songs-table-selbtn dim', 'clear');
    clear.addEventListener('click', () => { this.selected.clear(); this._paintSelection(); });
    bar.append(rm, clear);
    if (notHere) bar.appendChild(zsEl('span', 'song-fixer-dim', `${notHere} only on the zune — you’ll be asked to copy them first`));
  }

  _paintSelection() {
    for (const el of this.listEl.querySelectorAll('.zs-tbody .zs-trow')) el.classList.toggle('selected', this.selected.has(el.dataset.key));
    this._drawSelBar();
  }

  _drawList() {
    const list = this.listEl;
    if (!list) return;
    list.innerHTML = '';
    if (this.headEl) this.headEl.innerHTML = '';
    const top = this.headEl || list;
    const rows = this._visible();
    this.rows = rows;
    const cols = this._cols();
    const total = rows.reduce((s, r) => s + r.size, 0);
    const k2 = this.sortKey2 && this.sortKey2 !== this.sortKey ? this.sortKey2 : null;
    const name = (k) => (cols.find(c => c[0] === k) || [k, k])[1];
    top.appendChild(zsEl('div', 'zs-count', `${rows.length} ${this.group === 'items' ? 'item' : this.group === 'albums' ? 'album' : 'artist'}${rows.length === 1 ? '' : 's'} · ${zsSize(total)}` +
      (k2 ? ` · by ${name(this.sortKey)}, then ${name(k2)}` : '')));

    // Column headers: click to sort, shift-click to sort within
    const head = zsEl('div', 'zs-trow zs-thead zs-' + this.group);
    for (const [k, label] of cols) {
      const h = zsEl('div', 'zs-cell zs-c-' + k + (k === this.sortKey || k === k2 ? ' sorted' : ''));
      if (k === 'play') { head.appendChild(h); continue; }
      const arrow = (d) => (d > 0 ? ' ▴' : ' ▾');
      h.textContent = label + (k === this.sortKey ? arrow(this.sortDir) + (k2 ? '1' : '') : k === k2 ? arrow(this.sortDir2) + '2' : '');
      h.title = 'click to sort · shift-click to also sort by this';
      h.addEventListener('click', (e) => {
        const first = (key) => (key === 'size' || key === 'duration' || key === 'count' ? -1 : 1);
        if (e.shiftKey && this.sortKey !== k) {
          if (this.sortKey2 === k) this.sortDir2 = -this.sortDir2; else { this.sortKey2 = k; this.sortDir2 = first(k); }
        } else if (this.sortKey === k) this.sortDir = -this.sortDir;
        else { this.sortKey = k; this.sortDir = first(k); if (this.sortKey2 === k) this.sortKey2 = null; }
        this._drawList();
      });
      head.appendChild(h);
    }
    top.appendChild(head);

    const body = zsEl('div', 'zs-tbody');
    const shown = rows.slice(0, this.limit);
    for (const r of shown) {
      const row = zsEl('div', 'zs-trow zs-' + this.group);
      row.dataset.key = this._rowKey(r);
      if (this.selected.has(row.dataset.key)) row.classList.add('selected');
      for (const [k] of cols) {
        const c = zsEl('div', 'zs-cell zs-c-' + k);
        if (k === 'play') {
          if (!r.group && r.cat === 'music') {
            const b = zsEl('button', 'song-play-btn zs-play', '\u25B6');
            b.title = r.localPath ? 'play (your computer\u2019s copy)' : 'play (copied from the zune first)';
            b.dataset.key = this._rowKey(r);
            c.appendChild(b);
          }
          row.appendChild(c);
          continue;
        }
        if (k === 'title') c.textContent = r.title;
        else if (k === 'artist') c.textContent = r.artist || '';
        else if (k === 'album') c.textContent = r.album || '';
        else if (k === 'cat') c.textContent = r.cat === 'music' ? 'song' : r.cat.replace(/s$/, '');
        else if (k === 'duration') c.textContent = zsTime(r.duration);
        else if (k === 'kbps') c.textContent = r.kbps ? r.kbps + ' kbps' : '';
        else if (k === 'size') c.textContent = zsSize(r.size);
        else if (k === 'count') c.textContent = String(r.count);
        else if (k === 'on') {
          const w = r.onComputer === true ? ['both', 'zs-ok'] : r.onComputer === 'some' ? ['some on computer', 'zs-some'] : r.onComputer === false ? ['zune only', 'zs-only'] : null;
          if (w) { c.textContent = w[0]; c.classList.add(w[1]); }
          c.title = r.onComputer === true ? 'also on your computer' : r.onComputer === false ? 'its only copy is on the zune' : '';
        }
        if (k !== 'on') c.title = c.textContent;
        row.appendChild(c);
      }
      body.appendChild(row);
    }
    list.appendChild(body);

    // Selecting: click, cmd-click, shift-click (the highlight moves; nothing is redrawn)
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.zs-trow');
      if (!row) return;
      const key = row.dataset.key;
      const rowData = shown.find(r => this._rowKey(r) === key);
      // Play button, or double-click / double-tap a song
      if (e.target.closest('.zs-play') || (e.detail >= 2 && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        if (rowData && !rowData.group && rowData.cat === 'music') this._play(rowData);
        if (e.target.closest('.zs-play')) {
          if (!this.selected.has(key)) { this.selected = new Set([key]); this.anchor = key; this._paintSelection(); }
          return;
        }
        return;
      }
      const keys = shown.map(r => this._rowKey(r));
      if (e.shiftKey && this.anchor) {
        const a = keys.indexOf(this.anchor), b = keys.indexOf(key);
        if (a !== -1 && b !== -1) {
          if (!(e.metaKey || e.ctrlKey)) this.selected.clear();
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(keys[i]);
        }
      } else if (e.metaKey || e.ctrlKey) {
        if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
        this.anchor = key;
      } else {
        this.selected = new Set([key]);
        this.anchor = key;
      }
      this.container.focus({ preventScroll: true });
      this._paintSelection();
    });

    if (rows.length > this.limit) {
      const more = zsEl('button', 'song-fixer-link song-fixer-more', `show more (${rows.length - this.limit} left)`);
      more.addEventListener('click', () => { this.limit += ZS_PAGE; this._drawList(); });
      list.appendChild(more);
    }
    this._drawSelBar();
  }

  /** Play a Zune song: this computer's copy if there is one, else copied off the Zune. */
  async _play(r) {
    const ex = this.explorer;
    let p = r.localPath;
    if (!p) {
      ex.showToast?.(`getting \u201c${r.title}\u201d from your zune\u2026`);
      const res = await window.electronAPI.zunePreviewFile(r.handle);
      if (!res.success) { ex.showToast?.('couldn\u2019t play it: ' + res.error); return; }
      p = res.path;
    }
    const file = { path: p, name: r.title, title: r.title, artist: r.artist, album: r.album };
    if (r.localPath && ex.playPath) ex.playPath(p);
    else ex.audioPlayer.play(file, [file]);
  }

  async _remove(items) {
    const zp = this.explorer.zunePanel;
    const songs = items.filter(i => i.cat === 'music').map(i => i.handle);
    const other = items.filter(i => i.cat !== 'music');
    if (other.length) {
      const bytes = other.reduce((s, i) => s + i.size, 0);
      if (!window.confirm(`Remove ${other.length} video/picture/podcast item${other.length === 1 ? '' : 's'} (${zsSize(bytes)}) from your Zune?\n\nThey aren’t copied to your computer first.`)) return;
      await zp.deleteDeviceItems(other.map(i => i.handle));
    }
    // Songs: the computer's copy is checked, and missing ones are offered to be copied first
    if (songs.length) await zp.removeFromDevice(songs);
    this.selected.clear();
    this._draw();
  }
}

window.ZuneStorageView = ZuneStorageView;
