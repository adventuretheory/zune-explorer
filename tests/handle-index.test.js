const { test } = require('node:test');
const assert = require('node:assert');
const { HandleIndex } = require('../src/main/zune/handle-index.js');

test('matches unique filenames case-insensitively', () => {
  const idx = new HandleIndex([{ atomId: 1, filename: 'Song.WMA', size: 100 }]);
  const map = idx.matchAll([{ handle: 0x10, filename: 'song.wma', size: 100 }]);
  assert.strictEqual(map.get(1), 0x10);
});

test('duplicate filenames each get their own handle, by size', () => {
  const idx = new HandleIndex([
    { atomId: 1, filename: '01 Intro.wma', size: 111 },
    { atomId: 2, filename: '01 Intro.wma', size: 222 },
    { atomId: 3, filename: '01 Intro.wma', size: 333 },
  ]);
  const map = idx.matchAll([
    { handle: 0xC, filename: '01 Intro.wma', size: 333 },
    { handle: 0xA, filename: '01 Intro.wma', size: 111 },
    { handle: 0xB, filename: '01 Intro.wma', size: 222 },
  ]);
  assert.deepStrictEqual([map.get(1), map.get(2), map.get(3)], [0xA, 0xB, 0xC]);
});

test('size mismatch does not steal an exact match from another object', () => {
  const idx = new HandleIndex([
    { atomId: 1, filename: 'a.mp3', size: 500 },
    { atomId: 2, filename: 'a.mp3', size: 900 },
  ]);
  // First object has an odd size; second is an exact match for atom 1.
  const map = idx.matchAll([
    { handle: 0x1, filename: 'a.mp3', size: 777 },
    { handle: 0x2, filename: 'a.mp3', size: 500 },
  ]);
  assert.strictEqual(map.get(1), 0x2);
  assert.strictEqual(map.get(2), 0x1);
});

test('unknown files and extra copies are left unmatched', () => {
  const idx = new HandleIndex([{ atomId: 1, filename: 'x.mp3', size: 1 }]);
  const map = idx.matchAll([
    { handle: 0x1, filename: 'x.mp3', size: 1 },
    { handle: 0x2, filename: 'x.mp3', size: 1 },
    { handle: 0x3, filename: 'y.mp3', size: 1 },
  ]);
  assert.strictEqual(map.size, 1);
  assert.strictEqual(map.get(1), 0x1);
});

test('filenames with folder paths match on basename', () => {
  const idx = new HandleIndex([{ atomId: 7, filename: 'Music\\Artist\\Track.wma', size: 0 }]);
  assert.strictEqual(idx.matchAll([{ handle: 9, filename: 'Track.wma', size: 42 }]).get(7), 9);
});
