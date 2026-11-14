// Shuffle plays each song once before repeating, and "previous" retraces it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadPlayer() {
  const store = {};
  const ctx = {
    Audio: class { constructor() { this.currentTime = 0; } addEventListener() {} play() { return Promise.resolve(); } pause() {} },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    window: { electronAPI: { getAudioMetadata: async () => ({}) }, pathUtils: { toFileUrl: p => 'file://' + p } },
    MediaError: {}, console,
  };
  const src = fs.readFileSync(path.join(__dirname, '../src/assets/js/audio-player.js'), 'utf8');
  const fn = new Function(...Object.keys(ctx), src + '\nreturn AudioPlayer;');
  return { AudioPlayer: fn(...Object.values(ctx)), store };
}

test('shuffle plays every song once, then stops (or starts a new round with repeat all)', async () => {
  const { AudioPlayer, store } = loadPlayer();
  const p = new AudioPlayer();
  const queue = Array.from({ length: 20 }, (_, i) => ({ path: `/m/${i}.mp3` }));
  await p.play(queue[5], queue);
  p.setShuffle(true);
  assert.equal(store['player-shuffle'], '1');
  const seen = [p.currentIndex];
  for (let i = 0; i < 19; i++) { await p.next(); seen.push(p.currentIndex); }
  assert.equal(new Set(seen).size, 20, 'no song repeated');
  let ended = false;
  p.on('queueend', () => { ended = true; });
  await p.next();
  assert.equal(ended, true);

  p.repeat = 'all';
  await p.next();
  assert.ok(p.currentIndex >= 0 && p.currentIndex < 20, 'new round starts');
});

test('previous in shuffle goes back through what played', async () => {
  const { AudioPlayer } = loadPlayer();
  const p = new AudioPlayer();
  const queue = Array.from({ length: 10 }, (_, i) => ({ path: `/m/${i}.mp3` }));
  await p.play(queue[0], queue);
  p.setShuffle(true);
  const order = [0];
  for (let i = 0; i < 4; i++) { await p.next(); order.push(p.currentIndex); }
  await p.previous();
  assert.equal(p.currentIndex, order[3]);
  await p.previous();
  assert.equal(p.currentIndex, order[2]);
});

test('shuffle choice is remembered for the next start', () => {
  const { AudioPlayer, store } = loadPlayer();
  store['player-shuffle'] = '1';
  assert.equal(new AudioPlayer().shuffle, true);
});
