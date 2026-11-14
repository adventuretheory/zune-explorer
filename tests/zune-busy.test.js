// The Zune can only hold one conversation at a time: copying from it and
// sending to it must never interleave on the USB connection.
const { test } = require('node:test');
const assert = require('node:assert/strict');

let ZuneManager;
try { ({ ZuneManager } = require('../src/main/zune/zune-manager.js')); } catch { /* usb native module unavailable */ }

function connectedManager() {
  const zm = new ZuneManager();
  zm.connected = true;
  zm.zmdbHandlesValid = undefined;
  return zm;
}

test('copying from the Zune is refused while songs are being sent', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  zm.transferring = true;
  await assert.rejects(zm.getFile(1), /busy receiving/);
});

test('sending is refused while a copy is in flight, and allowed after', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  let release;
  zm.mtp = { getObject: () => new Promise(r => { release = r; }) };
  zm.transport = { setTransferTimeout() {} };

  const pull = zm.getFile(7);
  await new Promise(r => setImmediate(r));
  await assert.rejects(zm.sendFiles(['/x.mp3']), /busy copying/);
  assert.equal(zm.transferring, false, 'refused send must not leave the transfer flag set');

  release(Buffer.from('data'));
  assert.deepEqual(await pull, Buffer.from('data'));
  assert.equal(zm._pullsInFlight, 0);
});

test('retagTracks sets names, renames a fully cleaned album and drops songs from an emptied one', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  const props = new Map();
  const albums = new Map([[900, { name: 'DOPEHOOD.COM', refs: [1, 2] }], [901, { name: 'Hits [MP3JUICES.COM]', refs: [3] }], [902, { name: 'Freedom', refs: [4] }]]);
  const deleted = [];
  let synced = 0;
  zm.mtp = {
    setObjectPropString: async (h, p, v) => {
      if (albums.has(h)) albums.get(h).name = v; else props.set(`${h}:${p}`, v);
    },
    getObjectPropString: async (h, p) => (albums.has(h) ? albums.get(h).name : (props.get(`${h}:${p}`) ?? '')),
    getObjectHandles: async (storage, format) => (format === 47619 ? [...albums.keys()] : []),
    getObjectReferences: async (h) => albums.get(h).refs,
    setObjectReferences: async (h, refs) => { albums.get(h).refs = refs; },
    deleteObject: async (h) => { deleted.push(h); albums.delete(h); },
    syncDeviceDB: async () => { synced++; },
  };
  const r = await zm.retagTracks([
    { handle: 1, changes: { album: '' }, old: { album: 'DOPEHOOD.COM', artist: 'Kevin Rudolf' } },
    { handle: 2, changes: { title: 'All Mine', album: '' }, old: { album: 'DOPEHOOD.COM', artist: 'Kevin Rudolf' } },
    { handle: 3, changes: { album: 'Hits' }, old: { album: 'Hits [MP3JUICES.COM]', artist: 'X' } },
  ]);
  assert.deepEqual(r, { done: [1, 2, 3], errors: [] });
  assert.equal(props.get('2:56388'), 'All Mine'); // Name 0xDC44
  assert.equal(props.get('1:56474'), '');          // AlbumName 0xDC9A
  assert.deepEqual(deleted, [900]);
  assert.equal(albums.get(901).name, 'Hits');
  assert.equal(albums.get(902).name, 'Freedom');
  assert.equal(synced, 1);
  assert.equal(zm.transferring, false);
});

test('deleting reports progress for each song', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  zm.mtp = { deleteObject: async () => {}, getStorageInfo: async () => ({}) };
  const seen = [];
  zm.on('delete-progress', (p) => seen.push(`${p.done}/${p.total}`));
  const r = await zm.deleteObjects([1, 2, 3]);
  assert.equal(r.deleted, 3);
  assert.deepEqual(seen, ['0/3', '1/3', '2/3', '3/3']);
});

test('replacing removes each old copy just before sending its new one, and skips a song whose old copy stays', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  const log = [];
  zm.mtp = {
    deleteObject: async (h) => { log.push('delete ' + h); if (h === 22) throw new Error('DeviceBusy'); },
    getStorageInfo: async () => ({}),
  };
  // Stand-in for the real send of one file: record it and succeed
  zm._readMetadata = async (p) => { log.push('send ' + p); throw new Error('stop-after-log'); };
  const removed = [];
  await zm.sendFiles(['/a.mp3', '/b.mp3'], {
    replace: { '/a.mp3': 11, '/b.mp3': 22 },
    onOldRemoved: (p) => removed.push(p),
  }).catch(() => {});
  assert.deepEqual(log.slice(0, 2), ['delete 11', 'send /a.mp3'], 'old copy goes right before its new one');
  assert.ok(log.includes('delete 22'));
  assert.ok(!log.includes('send /b.mp3'), 'not sent when the old copy could not be removed');
  assert.deepEqual(removed, ['/a.mp3']);
  assert.equal(zm.transferring, false);
});
