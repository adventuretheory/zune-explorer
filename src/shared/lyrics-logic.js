// Lyrics helpers: reading time-synced (LRC) lyrics, and tidying a song's
// details before looking its lyrics up.

/**
 * Parse LRC text ("[01:23.45] line") into [{ time (seconds), text }],
 * sorted. Lines with several time stamps appear once for each.
 */
function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const sec = Number(m[1]) * 60 + Number(m[2].replace(':', '.'));
      if (Number.isFinite(sec)) out.push({ time: sec, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Index of the line being sung at `t` seconds (-1 before the first). */
function currentLine(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t + 0.15) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Title and artist as a lyrics site knows them: no "(feat. X)", "(Radio
 * Edit)", "[Explicit]", track numbers or website junk.
 */
function lyricsQuery({ title = '', artist = '', album = '' } = {}) {
  const tidy = (typeof window !== 'undefined' && window.songFixerLogic) ? window.songFixerLogic.cleanTagText
    : (typeof require === 'function' ? require('./song-fixer-logic.js').cleanTagText : (v) => v);
  let t = tidy(title) || String(title || '');
  t = t.replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([](?:radio edit|explicit|clean|album version|single version|remaster(?:ed)?(?: \d{4})?|\d{4} remaster(?:ed)?|original mix|edit)[)\]]/gi, '')
    .replace(/^\d{1,2}[\s.-]+(?=\D)/, '')
    .trim();
  let a = tidy(artist) || String(artist || '');
  if (/^unknown artist$/i.test(a)) a = '';
  a = a.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
  // No artist, but the name reads "Artist - Title": split it
  if (!a) {
    const parts = t.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) { a = parts[0].trim(); t = parts.slice(1).join(' - ').trim(); }
  }
  let al = tidy(album) || '';
  if (/^unknown album$/i.test(al)) al = '';
  return { title: t, artist: a, album: al };
}

const lyricsLogic = { parseLrc, currentLine, lyricsQuery };
if (typeof module !== 'undefined' && module.exports) module.exports = lyricsLogic;
if (typeof window !== 'undefined') window.lyricsLogic = lyricsLogic;
