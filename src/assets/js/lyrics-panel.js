/* global document, window, localStorage */
// Now Playing → lyrics: the words of the song that's playing (from LRCLIB),
// following along line by line when the lyrics are time-synced. For a song
// that can't be found: search the web for words you hear, identify it by
// sound, and fix its name right here.

class LyricsPanel {
  constructor(explorer) {
    this.explorer = explorer;
    this.box = document.getElementById('np-lyrics');
    this.queueBox = document.getElementById('np-queue');
    this.cache = new Map();     // path -> lyrics result
    this.path = null;
    this.lines = null;          // synced lines of the current song
    this.lineEls = [];
    this.current = -1;
    this.toolsOpen = false;

    document.getElementById('np-tab-queue')?.addEventListener('click', () => this.showTab('queue'));
    document.getElementById('np-tab-lyrics')?.addEventListener('click', () => this.showTab('lyrics'));
    const p = explorer.audioPlayer;
    p.on('trackchange', ({ file }) => { this.file = file; this.toolsOpen = false; if (this.visible()) this.load(); });
    p.on('timeupdate', ({ currentTime }) => this._follow(currentTime));
    let tab = 'queue';
    try { tab = localStorage.getItem('np-tab') || 'queue'; } catch { /* default */ }
    this.showTab(tab);
  }

  visible() { return this.tab === 'lyrics'; }

  showTab(tab) {
    this.tab = tab === 'lyrics' ? 'lyrics' : 'queue';
    try { localStorage.setItem('np-tab', this.tab); } catch { /* per-session */ }
    document.getElementById('np-tab-queue')?.classList.toggle('active', this.tab === 'queue');
    document.getElementById('np-tab-lyrics')?.classList.toggle('active', this.tab === 'lyrics');
    if (this.queueBox) this.queueBox.style.display = this.tab === 'queue' ? '' : 'none';
    if (this.box) this.box.style.display = this.tab === 'lyrics' ? '' : 'none';
    if (this.visible()) this.load();
  }

  _info() {
    const f = this.file || this.explorer.audioPlayer.getCurrentFile?.();
    if (!f || !f.path) return null;
    const t = this.explorer.musicLibrary.tracks.get(f.path) || {};
    return {
      path: f.path,
      title: t.title || f.title || f.name || '',
      artist: t.artist || f.artist || '',
      album: t.album || f.album || '',
      duration: t.duration || this.explorer.audioPlayer.audio?.duration || 0,
    };
  }

  async load(force = false) {
    const info = this._info();
    if (!this.box) return;
    if (!info) { this._render({ state: 'nothing' }); return; }
    this.file = this.file || { path: info.path };
    this.path = info.path;
    if (!force && this.cache.has(info.path)) { this._render(this.cache.get(info.path), info); return; }
    this._render({ state: 'loading' }, info);
    const q = window.lyricsLogic.lyricsQuery(info);
    const r = await window.electronAPI.lyricsGet({ ...q, duration: info.duration });
    const result = !r.success ? { state: 'error', error: r.error }
      : !r.found ? { state: 'missing', query: q }
      : { state: r.instrumental ? 'instrumental' : 'found', ...r };
    if (result.state !== 'error') this.cache.set(info.path, result);
    if (this.path === info.path) this._render(result, info);
  }

  _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  _render(res, info) {
    const b = this.box;
    b.innerHTML = '';
    this.lines = null;
    this.lineEls = [];
    this.current = -1;
    if (res.state === 'nothing') { b.appendChild(this._el('div', 'np-lyrics-note', 'play a song to see its lyrics.')); return; }
    if (res.state === 'loading') { b.appendChild(this._el('div', 'np-lyrics-note', 'looking for lyrics…')); return; }

    if (res.state === 'found') {
      const lines = res.synced ? window.lyricsLogic.parseLrc(res.synced) : null;
      if (lines && lines.length) {
        this.lines = lines;
        const wrap = this._el('div', 'np-lyrics-lines');
        lines.forEach((l, i) => {
          const d = this._el('div', 'np-lyrics-line', l.text || '♪');
          d.title = 'jump here';
          d.addEventListener('click', () => { const a = this.explorer.audioPlayer.audio; if (a) a.currentTime = l.time; });
          this.lineEls[i] = d;
          wrap.appendChild(d);
        });
        b.appendChild(wrap);
        this._follow(this.explorer.audioPlayer.audio?.currentTime || 0);
      } else {
        b.appendChild(this._el('div', 'np-lyrics-plain', res.plain));
      }
      b.appendChild(this._el('div', 'np-lyrics-source', `lyrics: lrclib.net · ${res.title}${res.artist ? ' — ' + res.artist : ''}`));
    } else if (res.state === 'instrumental') {
      b.appendChild(this._el('div', 'np-lyrics-note', 'instrumental — no words in this one.'));
    } else if (res.state === 'missing') {
      b.appendChild(this._el('div', 'np-lyrics-note',
        `no lyrics found for “${res.query.title}”${res.query.artist ? ' by ' + res.query.artist : ''}. ` +
        'if the name is wrong, type some words you hear and search the web for them, or identify it by sound — then fix the name below.'));
      this.toolsOpen = true;
    } else {
      b.appendChild(this._el('div', 'np-lyrics-note', `couldn’t get lyrics: ${res.error}`));
    }
    if (info) b.appendChild(this._tools(info));
  }

  /** Keep the line being sung highlighted and in view. */
  _follow(t) {
    if (!this.lines || !this.visible()) return;
    const i = window.lyricsLogic.currentLine(this.lines, t);
    if (i === this.current) return;
    if (this.lineEls[this.current]) this.lineEls[this.current].classList.remove('now');
    this.current = i;
    const e = this.lineEls[i];
    if (e) {
      e.classList.add('now');
      e.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /** Name not right? Search words online, identify by sound, fix the details. */
  _tools(info) {
    const wrap = this._el('div', 'np-lyrics-tools');
    const toggle = this._el('button', 'np-lyrics-toggle', this.toolsOpen ? 'don’t know this song? ▴' : 'don’t know this song? ▾');
    toggle.addEventListener('click', () => { this.toolsOpen = !this.toolsOpen; this._render(this.cache.get(info.path) || { state: 'found', plain: '' }, info); });
    wrap.appendChild(toggle);
    if (!this.toolsOpen) return wrap;

    const words = this._el('div', 'np-lyrics-row');
    const inp = this._el('input', 'np-lyrics-input');
    inp.placeholder = 'type some words you hear…';
    const go = this._el('button', 'np-lyrics-btn', 'search the web');
    const search = () => {
      const w = inp.value.trim();
      if (!w) { inp.focus(); return; }
      window.electronAPI.openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(`"${w}" lyrics`)}`);
    };
    go.addEventListener('click', search);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    words.append(inp, go);
    wrap.appendChild(words);

    const form = this._el('div', 'np-lyrics-form');
    const fields = {};
    for (const [k, label] of [['title', 'title'], ['artist', 'artist'], ['album', 'album']]) {
      const f = this._el('input', 'np-lyrics-input');
      f.placeholder = label;
      // Start from the tidied name (website junk removed, "Artist - Title" split)
      const q = window.lyricsLogic.lyricsQuery(info);
      const own = info[k] && !/^unknown (artist|album)$/i.test(info[k]) ? info[k] : '';
      f.value = k === 'album' ? (q.album || own) : (q[k] || own);
      fields[k] = f;
      form.appendChild(f);
    }
    const status = this._el('div', 'np-lyrics-status');
    const idBtn = this._el('button', 'np-lyrics-btn', 'identify by sound');
    idBtn.addEventListener('click', async () => {
      idBtn.disabled = true;
      status.textContent = 'listening…';
      const r = await window.electronAPI.songFixerIdentify(info.path, { title: fields.title.value, artist: fields.artist.value, album: fields.album.value });
      idBtn.disabled = false;
      const p = r?.success && r.proposal;
      if (!p) { status.textContent = r?.success ? 'not recognised — try the words search' : 'couldn’t identify: ' + (r?.error || ''); return; }
      fields.title.value = p.title || fields.title.value;
      fields.artist.value = p.artist || fields.artist.value;
      fields.album.value = p.album || fields.album.value;
      status.textContent = `sounds like “${p.title}” by ${p.artist} — check it, then save.`;
    });
    const save = this._el('button', 'np-lyrics-btn np-lyrics-save', 'save details');
    save.addEventListener('click', async () => {
      const tags = { title: fields.title.value.trim(), artist: fields.artist.value.trim(), album: fields.album.value.trim() };
      if (!tags.title) { fields.title.focus(); return; }
      save.disabled = true;
      status.textContent = 'saving…';
      const r = await window.electronAPI.songFixerApply(String(Date.now()), info.path, tags, { addCover: true });
      save.disabled = false;
      if (!r.success) { status.textContent = 'couldn’t save: ' + r.error; return; }
      let p = info.path;
      if (r.renamedTo) { this.explorer.renameLibraryPath?.(info.path, r.renamedTo); p = r.renamedTo; this.file = { ...this.file, path: p }; }
      await window.electronAPI.batchScanAudioMetadata([p], { includeArt: true });
      const t = this.explorer.musicLibrary.tracks.get(p);
      if (t) Object.assign(t, tags);
      this.cache.delete(info.path);
      this.toolsOpen = false;
      this.explorer.showToast?.(`saved “${tags.title}” — press “update zune” to put the new name on your zune`);
      document.getElementById('np-title') && (document.getElementById('np-title').textContent = tags.title);
      this.load(true);
    });
    const actions = this._el('div', 'np-lyrics-row');
    actions.append(idBtn, save);
    wrap.append(form, actions, status);
    return wrap;
  }
}

window.LyricsPanel = LyricsPanel;
