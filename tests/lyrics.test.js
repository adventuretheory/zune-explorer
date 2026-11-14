const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/lyrics-logic.js');

test('LRC lyrics are read into timed lines, in order', () => {
  const lines = L.parseLrc('[ar:Someone]\n[00:12.50] First line\n[00:05.00]Intro\n[01:02.3][01:30.00] Chorus\n\nno time here');
  assert.deepEqual(lines.map(l => [l.time, l.text]), [[5, 'Intro'], [12.5, 'First line'], [62.3, 'Chorus'], [90, 'Chorus']]);
});

test('the line being sung follows the time', () => {
  const lines = L.parseLrc('[00:05.00]a\n[00:10.00]b\n[00:20.00]c');
  assert.equal(L.currentLine(lines, 2), -1);
  assert.equal(L.currentLine(lines, 5), 0);
  assert.equal(L.currentLine(lines, 15), 1);
  assert.equal(L.currentLine(lines, 99), 2);
});

test('lookups use the plain song name and main artist', () => {
  assert.deepEqual(L.lyricsQuery({ title: 'Gonorrhea (feat. Drake) [Explicit]', artist: 'Lil Wayne feat. Drake', album: 'DOPEHOOD.COM' }),
    { title: 'Gonorrhea', artist: 'Lil Wayne', album: '' });
  assert.deepEqual(L.lyricsQuery({ title: '03 - Mr. Brightside (Radio Edit)', artist: 'The Killers', album: 'Hot Fuss' }),
    { title: 'Mr. Brightside', artist: 'The Killers', album: 'Hot Fuss' });
  assert.equal(L.lyricsQuery({ title: 'Halo', artist: 'Unknown Artist' }).artist, '');
  assert.deepEqual(L.lyricsQuery({ title: 'Lil Wayne - Gonorrhea - DOPEHOOD.COM', artist: 'Unknown Artist' }),
    { title: 'Gonorrhea', artist: 'Lil Wayne', album: '' });
});
