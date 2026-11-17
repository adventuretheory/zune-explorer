/* global document, window */
// Right-click → "Fix Song Details…": change the title, artist and album of one
// song or many (on the computer, the Zune, or both), with "identify by sound"
// and "search by name" for one song, and a new album cover to match.
// Songs on a connected Zune are changed there right away (no "update zune").

class SongDetailsDialog {
  /**
   * @param {object} explorer
   * @param {{ paths?: string[], handles?: number[] }} songs
   *   paths = songs on this computer, handles = songs only on the Zune
   */
  constructor(explorer, { paths = [], handles = [] } = {}) {
    this.x = explorer;
    this.paths = paths;
    this.handles = handles;
    this.open();
  }

  _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** Each song's current details: { key, path?, handle?, title, artist, album } */
  _songs() {
    const lib = this.x.musicLibrary.tracks;
    const music = this.x.zunePanel?.browseData?.music || [];
    const byHandle = new Map(music.map(d => [d.handle, d]));
    const tidy = (v) => (window.songFixerLogic ? window.songFixerLogic.cleanTagText(v) : v) || v || '';
    const out = [];
    for (const p of this.paths) {
      const t = lib.get(p) || {};
      out.push({ key: p, path: p, title: t.title || '', artist: t.artist || '', album: t.album || '' });
    }
    for (const h of this.handles) {
      const d = byHandle.get(h) || {};
      out.push({ key: 'zune:' + h, handle: h, title: tidy(d.title) || d.title || '', artist: d.artist || '', album: d.album || '' });
    }
    return out;
  }

  open() {
    document.querySelector('.restore-overlay')?.remove();
    const songs = this._songs();
    if (!songs.length) return;
    const one = songs.length === 1;
    const overlay = this._el('div', 'restore-overlay');
    const box = this._el('div', 'restore-dialog song-details-dialog');
    overlay.appendChild(box);
    const close = () => { window.removeEventListener('keydown', onKey, true); overlay.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const xBtn = this._el('button', 'restore-close', '✕');
    xBtn.addEventListener('click', close);
    box.appendChild(xBtn);
    box.appendChild(this._el('div', 'restore-title', one ? 'fix song details' : `fix details of ${songs.length} songs`));
    if (one) box.appendChild(this._el('div', 'restore-song', `${songs[0].title || '?'} — ${songs[0].artist || '?'} — ${songs[0].album || 'no album'}`));
    else box.appendChild(this._el('div', 'restore-song', 'fill in only what should change; empty boxes keep each song’s own.'));

    // Fields: title only for one song; artist/album start with the shared value
    const same = (k) => (songs.every(s => s[k] === songs[0][k]) ? songs[0][k] : '');
    const fields = {};
    const form = this._el('div', 'song-details-form');
    for (const [k, label] of [['title', 'title'], ['artist', 'artist'], ['album', 'album']]) {
      if (k === 'title' && !one) continue;
      const lab = this._el('label', 'song-details-field');
      lab.appendChild(this._el('span', null, label));
      const inp = this._el('input', 'zune-diff-filter-input');
      inp.value = same(k);
      if (!one && !inp.value) inp.placeholder = '(keep each song’s own)';
      lab.appendChild(inp);
      fields[k] = inp;
      form.appendChild(lab);
    }
    box.appendChild(form);

    const status = this._el('div', 'song-details-status');
    const local = songs.filter(s => s.path);

    // One song on the computer: let the app suggest the details
    if (one && local.length) {
      const row = this._el('div', 'song-details-row');
      const idBtn = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', 'identify by sound');
      idBtn.title = 'listens to the song and fills in what it really is';
      const nameBtn = this._el('button', 'zune-sync-btn song-fixer-cleanup-btn', 'search by name');
      nameBtn.title = 'looks up what you typed above on musicbrainz and fills in the rest';
      const suggest = async (hint) => {
        idBtn.disabled = nameBtn.disabled = true;
        status.textContent = hint ? 'searching…' : 'listening…';
        const v = { title: fields.title.value.trim(), artist: fields.artist.value.trim(), album: fields.album.value.trim() };
        let r;
        try {
          r = await window.electronAPI.songFixerIdentify(local[0].path, hint
            ? { title: v.artist ? `${v.artist} - ${v.title}` : v.title, artist: v.artist, album: v.album, hint: true }
            : { title: v.title, artist: v.artist, album: v.album });
        } catch (e) { r = { success: false, error: e.message }; }
        idBtn.disabled = nameBtn.disabled = false;
        const p = r?.success && r.proposal;
        if (!p) { status.textContent = r?.success ? 'nothing found — type the details yourself, then save.' : 'couldn’t look it up: ' + (r?.error || ''); return; }
        fields.title.value = p.title || fields.title.value;
        fields.artist.value = p.artist || fields.artist.value;
        fields.album.value = p.album || fields.album.value;
        art.checked = true;
        status.textContent = `${p.source === 'sound' ? 'sounds like' : 'found'} “${p.title}” by ${p.artist}${p.album ? ` (${p.album})` : ''} — check it, then save.`;
      };
      idBtn.addEventListener('click', () => suggest(false));
      nameBtn.addEventListener('click', () => suggest(true));
      row.append(idBtn, nameBtn);
      box.appendChild(row);
    }

    // A new album cover to go with the new details
    const artLab = this._el('label', 'restore-option');
    const art = this._el('input');
    art.type = 'checkbox';
    art.checked = false;
    artLab.append(art, this._el('span', null, 'also replace the album cover with the one for these details'));
    if (local.length) {
      box.appendChild(artLab);
      const mark = () => { art.checked = ['artist', 'album'].some(k => fields[k] && fields[k].value.trim() && fields[k].value.trim() !== same(k)); };
      fields.artist.addEventListener('input', mark);
      fields.album.addEventListener('input', mark);
    }

    const zp = this.x.zunePanel;
    const connected = zp && zp.state === 'connected' && zp.browseData;
    const onZune = local.filter(s => this.x._zuneMembership?.onZune?.has(s.path)).length + this.handles.length;
    if (onZune) {
      box.appendChild(this._el('div', 'song-details-note', connected
        ? `${onZune === 1 ? 'it’s' : `${onZune} are`} on your zune too — the zune is changed right away.`
        : `${onZune === 1 ? 'it’s' : `${onZune} are`} on your zune too — connect it ${this.handles.length ? 'first (songs only on the zune can only be changed while it’s connected)' : 'and the changes go on with “update zune”'}.`));
    }

    box.appendChild(status);
    const actions = this._el('div', 'song-details-row');
    const save = this._el('button', 'zune-sync-btn zune-push-btn', 'save');
    const cancel = this._el('button', 'zune-sync-btn', 'cancel');
    cancel.addEventListener('click', close);
    save.addEventListener('click', async () => {
      const want = {};
      for (const [k, f] of Object.entries(fields)) {
        const v = f.value.trim();
        if (v && (one || v !== same(k) || songs.some(s => s[k] !== v))) want[k] = v;
      }
      if (one && !fields.title.value.trim()) { fields.title.focus(); return; }
      if (!Object.keys(want).length && !art.checked) { close(); return; }
      save.disabled = cancel.disabled = true;
      try {
        const msg = await this._save(songs, want, art.checked, (t) => { status.textContent = t; });
        close();
        this.x.showToast?.(msg);
      } catch (e) {
        status.textContent = 'couldn’t save: ' + e.message;
        save.disabled = cancel.disabled = false;
      }
    });
    actions.append(save, cancel);
    box.appendChild(actions);
    document.body.appendChild(overlay);
    (fields.title || fields.artist).focus();
  }

  async _save(songs, want, newArt, say) {
    const x = this.x;
    const zp = x.zunePanel;
    const connected = zp && zp.state === 'connected' && zp.browseData;
    const changesFor = (s) => {
      const c = {};
      for (const [k, v] of Object.entries(want)) if (s[k] !== v) c[k] = v;
      return c;
    };
    const batchId = String(Date.now());
    const savedPaths = [];
    const failed = [];
    const edits = [];      // for the Zune: { handle, changes, old }
    const zuneOf = new Map(); // handle -> computer path
    const music = zp?.browseData?.music || [];
    const byHandle = new Map(music.map(d => [d.handle, d]));

    // 1. The files on this computer
    let n = 0;
    for (const s of songs.filter(s => s.path)) {
      const c = changesFor(s);
      let p = s.path;
      if (Object.keys(c).length) {
        say(`saving ${++n} of ${songs.length}…`);
        const r = await window.electronAPI.songFixerApply(batchId, s.path, c, { addCover: false });
        if (!r.success) { failed.push(r.error); continue; }
        if (r.renamedTo) { x.renameLibraryPath?.(s.path, r.renamedTo); p = r.renamedTo; }
        const t = x.musicLibrary.tracks.get(p);
        if (t) Object.assign(t, c);
        const h = x._zuneMembership?.onZune?.get(s.path);
        if (h != null && connected) {
          const d = byHandle.get(h) || {};
          edits.push({ handle: h, changes: c, old: { artist: d.artist || '', album: d.album || '' } });
          zuneOf.set(h, p);
        }
      }
      savedPaths.push(p);
    }
    if (savedPaths.length) await window.electronAPI.batchScanAudioMetadata(savedPaths, { includeArt: true });

    // 2. Songs only on the Zune
    for (const s of songs.filter(s => s.handle != null)) {
      const c = changesFor(s);
      if (!Object.keys(c).length) continue;
      if (!connected) { failed.push('the zune isn’t connected'); continue; }
      const d = byHandle.get(s.handle) || {};
      edits.push({ handle: s.handle, changes: c, old: { artist: d.artist || '', album: d.album || '' } });
    }

    // 3. The Zune, changed in place
    let onZuneDone = 0;
    if (edits.length) {
      say('changing the songs on your zune…');
      try {
        const r = await zp.retagDeviceItems(edits);
        const done = r.done || [];
        onZuneDone = done.length;
        const paths = done.map(h => zuneOf.get(h)).filter(Boolean);
        if (paths.length) await window.electronAPI.songFixerZuneDone(paths);
        if (r.errors?.length) failed.push(`zune: ${r.errors[0].error}`);
      } catch (e) {
        failed.push(`zune: ${e.message} (“update zune” will put the change on)`);
      }
    }

    // 4. A new cover (also goes onto the Zune by itself)
    let artMsg = '';
    if (newArt && savedPaths.length) {
      say('looking for the album cover…');
      // (not copied from the album's other songs: their cover may be the wrong one too)
      const r = await x.addAlbumArt(savedPaths, { replace: true, standIns: true, noSiblings: true });
      if (r) artMsg = r.added ? ` · new cover from ${Object.keys(r.sources)[0] === 'album' ? 'the same album' : Object.keys(r.sources)[0]}` : ' · no cover found (right-click → Search the Web for Album Art)';
    }

    x._zuneMembershipChanged?.(300);
    x._songsTableRefreshSoon?.(0);
    const fixer = x.settingsView?.songFixer;
    if (fixer?.container?.isConnected) { fixer._loadItems?.(); fixer._draw?.(); }

    const total = songs.length - failed.length;
    return `saved ${total} song${total === 1 ? '' : 's'}` +
      (onZuneDone ? ` · changed on your zune too` : (songs.some(s => x._zuneMembership?.onZune?.has(s.path)) && !connected ? ' · press “update zune” when your zune is connected' : '')) +
      artMsg + (failed.length ? ` · ${failed.length} problem${failed.length === 1 ? '' : 's'}: ${failed[0]}` : '');
  }
}

window.SongDetailsDialog = SongDetailsDialog;
