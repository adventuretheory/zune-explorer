// New covers go onto songs already on the Zune by setting their album's picture.
const { test } = require('node:test');
const assert = require('node:assert/strict');

let ZuneManager;
try { ({ ZuneManager } = require('../src/main/zune/zune-manager.js')); } catch { /* usb native module unavailable */ }

test('setAlbumArt puts the picture on each song\'s album once, and reports songs with no album', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = new ZuneManager();
  zm.connected = true;
  zm.zmdbHandlesValid = undefined;
  const set = [];
  let synced = 0;
  zm.mtp = {
    getObjectHandles: async () => [100, 101, 102],
    getObjectPropString: async (h) => ({ 100: 'Record', 101: 'Other', 102: 'Record' })[h],
    getObjectReferences: async (h) => ({ 100: [1, 2], 101: [3], 102: [9] })[h],
    setObjectPropArray: async (h, prop, data) => set.push([h, data.toString()]),
    setObjectPropUint32: async () => {},
    setObjectPropUint16: async () => {},
    syncDeviceDB: async () => { synced++; },
  };
  const img = Buffer.from('jpeg-a');
  const r = await zm.setAlbumArt([
    { handle: 1, album: 'Record', image: img },
    { handle: 2, album: 'Record', image: img },
    { handle: 5, album: 'Loose', image: img },
  ]);
  assert.deepEqual(set, [[100, 'jpeg-a']]);
  assert.deepEqual(r.done.sort(), [1, 2]);
  assert.deepEqual(r.noAlbum, [5]);
  assert.equal(r.albums, 1);
  assert.equal(synced, 1);
  assert.equal(zm.transferring, false);
});

test('setAlbumArt is refused while songs are being sent', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = new ZuneManager();
  zm.connected = true;
  zm.transferring = true;
  await assert.rejects(zm.setAlbumArt([]), /busy/);
});
