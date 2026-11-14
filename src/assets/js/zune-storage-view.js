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
    this.sort = 'largest';  // largest | smallest | longest | shortest | lowest | name
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
    if (zm && !zm.none) for (const h of zm.onZune.values()) onComputer.add(h);
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
    const by = {
      largest: (a, b) => b.size - a.size,
      smallest: (a, b) => (a.size || Infinity) - (b.size || Infinity),
      longest: (a, b) => b.duration - a.duration,
      shortest: (a, b) => (a.duration || Infinity) - (b.duration || Infinity),
      lowest: (a, b) => (a.kbps || Infinity) - (b.kbps || Infinity),
      name: (a, b) => String(a.title).localeCompare(String(b.title)),
    }[this.sort] || ((a, b) => b.size - a.size);
    return list.sort((a, b) => by(a, b) || String(a.title).localeCompare(String(b.title)));
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
      select([['items', 'each item'], ['albums', 'by album'], ['artists', 'by artist']], this.group, v => { this.group = v; }),
      select([['largest', 'largest first'], ['smallest', 'smallest first'], ['longest', 'longest first'], ['shortest', 'shortest first'], ['lowest', 'lowest quality first'], ['name', 'name (a–z)']], this.sort, v => { this.sort = v; }));
    const oz = zsEl('label', 'media-opt');
    const ozBox = zsEl('input');
    ozBox.type = 'checkbox';
    ozBox.checked = this.onlyZune;
    ozBox.addEventListener('change', () => { this.onlyZune = ozBox.checked; this._draw(); });
    oz.append(ozBox, document.createTextNode(' only songs not on my computer'));
    oz.title = 'songs whose only copy is on the zune';
    controls.appendChild(oz);
    c.appendChild(controls);

    this.selBar = zsEl('div', 'songs-table-selbar zs-selbar');
    c.appendChild(this.selBar);
    this.listEl = zsEl('div', 'zs-list');
    c.appendChild(this.listEl);
    this._drawList();
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }

  _drawSelBar() {
    const bar = this.selBar;
    bar.innerHTML = '';
    const byHandle = new Map(this._items().map(i => [i.handle, i]));
    const sel = [...this.selected].map(h => byHandle.get(h)).filter(Boolean);
    if (!sel.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const bytes = sel.reduce((s, i) => s + i.size, 0);
    const notHere = sel.filter(i => i.onComputer === false).length;
    bar.appendChild(zsEl('span', 'songs-table-selcount', `${sel.length} selected · frees ${zsSize(bytes)}`));
    if (notHere) bar.appendChild(zsEl('span', 'song-fixer-dim', `${notHere} of them only on the zune (you’ll be asked to copy them first)`));
    const rm = zsEl('button', 'songs-table-selbtn danger', 'remove from zune');
    rm.addEventListener('click', () => this._remove(sel));
    const clear = zsEl('button', 'songs-table-selbtn dim', 'clear');
    clear.addEventListener('click', () => { this.selected.clear(); this._drawList(); });
    bar.append(rm, clear);
  }

  _drawList() {
    const list = this.listEl;
    if (!list) return;
    list.innerHTML = '';
    const rows = this._visible();
    const total = rows.reduce((s, r) => s + r.size, 0);
    const head = zsEl('div', 'zs-head');
    const allBox = zsEl('input');
    allBox.type = 'checkbox';
    const visHandles = rows.flatMap(r => this._handlesOf(r));
    allBox.checked = visHandles.length > 0 && visHandles.every(h => this.selected.has(h));
    allBox.addEventListener('change', () => {
      for (const h of visHandles) { if (allBox.checked) this.selected.add(h); else this.selected.delete(h); }
      this._drawList();
    });
    const label = zsEl('label', 'zune-diff-select-all');
    label.append(allBox, document.createTextNode(` ${rows.length} ${this.group === 'items' ? 'item' : this.group === 'albums' ? 'album' : 'artist'}${rows.length === 1 ? '' : 's'} · ${zsSize(total)}`));
    head.appendChild(label);
    list.appendChild(head);

    for (const r of rows.slice(0, this.limit)) {
      const handles = this._handlesOf(r);
      const row = zsEl('div', 'zune-diff-item zs-row');
      const box = zsEl('input', 'zune-diff-check');
      box.type = 'checkbox';
      box.checked = handles.every(h => this.selected.has(h));
      box.addEventListener('change', () => {
        for (const h of handles) { if (box.checked) this.selected.add(h); else this.selected.delete(h); }
        this._drawSelBar();
      });
      const info = zsEl('div', 'zune-diff-info');
      info.appendChild(zsEl('span', 'zune-diff-title', r.title));
      const sub = r.group
        ? `${r.artist ? r.artist + ' · ' : ''}${r.count} item${r.count === 1 ? '' : 's'}`
        : [r.cat !== 'music' ? r.cat.replace(/s$/, '') : '', r.artist, r.album].filter(Boolean).join(' — ');
      if (sub) info.appendChild(zsEl('span', 'zune-diff-meta', sub));
      const where = r.onComputer === true ? ['on computer too', 'zs-ok'] : r.onComputer === 'some' ? ['some on computer', 'zs-some'] : r.onComputer === false ? ['only on zune', 'zs-only'] : null;
      const tag = where ? zsEl('span', 'zs-tag ' + where[1], where[0]) : zsEl('span', 'zs-tag');
      const len = zsEl('span', 'zs-num', zsTime(r.duration));
      const q = zsEl('span', 'zs-num zs-kbps', !r.group && r.kbps ? r.kbps + ' kbps' : '');
      const size = zsEl('span', 'zs-num zs-size', zsSize(r.size));
      row.append(box, info, tag, len, q, size);
      list.appendChild(row);
    }
    if (rows.length > this.limit) {
      const more = zsEl('button', 'song-fixer-link song-fixer-more', `show more (${rows.length - this.limit} left)`);
      more.addEventListener('click', () => { this.limit += ZS_PAGE; this._drawList(); });
      list.appendChild(more);
    }
    this._drawSelBar();
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
    const left = new Set([...(zp.browseData?.music || []), ...(zp.browseData?.videos || []), ...(zp.browseData?.pictures || []), ...(zp.browseData?.podcasts || [])].map(d => d.handle));
    for (const h of [...this.selected]) if (!left.has(h)) this.selected.delete(h);
    this._draw();
  }
}

window.ZuneStorageView = ZuneStorageView;
