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

test('a song the Zune stops answering on is retried once after reconnecting, then skipped; the rest still go', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const fsx = require('fs'); const os = require('os'); const pathx = require('path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'zsend-'));
  const a = pathx.join(dir, 'a.mp3'), b = pathx.join(dir, 'b.mp3');
  fsx.writeFileSync(a, Buffer.alloc(2000)); fsx.writeFileSync(b, Buffer.alloc(2000));
  const zm = connectedManager();
  const timeouts = [];
  zm.transport = { setTransferTimeout: (ms) => timeouts.push(ms) };
  let recoveries = 0;
  zm._recoverSession = async () => { recoveries++; };
  zm._readMetadata = async () => ({});
  zm._createAlbumObjects = async () => {};
  let handle = 100;
  const deleted = [];
  zm.mtp = {
    sendObjectInfo: async () => ({ objectHandle: ++handle }),
    sendObject: async (data) => { if (sending === a) throw new Error('LIBUSB_TRANSFER_TIMED_OUT'); },
    setObjectPropString: async () => {}, setObjectPropUint32: async () => {}, setObjectPropUint16: async () => {},
    deleteObject: async (h) => { deleted.push(h); },
    getStorageInfo: async () => ({}),
  };
  let sending = null;
  zm.on('transfer-progress', (p) => { if (p.state === 'sending' && p.bytesTransferred === 0) sending = p.fileName === 'a.mp3' ? a : b; });
  const r = await zm.sendFiles([a, b]);
  assert.deepEqual(r.succeeded, [b]);
  assert.equal(r.failed.length, 1);
  assert.equal(recoveries, 2, 'reconnected after each stall, then gave up on that song');
  assert.deepEqual(deleted, [101, 102], 'half-sent copies cleaned up');
  assert.ok(timeouts.includes(60000) && timeouts[timeouts.length - 1] === 0, 'time limit set while sending and cleared after');
  fsx.rmSync(dir, { recursive: true, force: true });
});

test('disconnecting closes the session with a time limit, even if the Zune never answers', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  const timeouts = [];
  let closed = false;
  zm.transport = { setTransferTimeout: (ms) => timeouts.push(ms), close: async () => { closed = true; } };
  zm.mtp = { closeSession: async () => { throw new Error('LIBUSB_TRANSFER_TIMED_OUT'); } };
  await zm.disconnect();
  assert.deepEqual(timeouts, [2000, 0]);
  assert.equal(closed, true);
  assert.equal(zm.connected, false);
});

test('connecting retries from the start when the Zune stops answering during the handshake', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const { MtpProtocol } = require('../src/main/zune/mtp-protocol.js');
  const { MtpzAuth } = require('../src/main/zune/mtpz-auth.js');
  const saved = {
    open: MtpProtocol.prototype.openSession, info: MtpProtocol.prototype.getDeviceInfo,
    ids: MtpProtocol.prototype.getStorageIDs, st: MtpProtocol.prototype.getStorageInfo, auth: MtpzAuth.prototype.authenticate,
  };
  let auths = 0;
  MtpProtocol.prototype.openSession = async () => {};
  MtpProtocol.prototype.getDeviceInfo = async () => ({});
  MtpProtocol.prototype.getStorageIDs = async () => [0x10001];
  MtpProtocol.prototype.getStorageInfo = async () => ({ free: 1 });
  MtpzAuth.prototype.authenticate = async () => { if (++auths === 1) throw new Error('LIBUSB_TRANSFER_TIMED_OUT'); };
  try {
    const zm = new ZuneManager();
    const log = [];
    zm.transport = {
      open: async () => log.push('open'), close: async () => log.push('close'),
      drainIn: async () => 0, setTransferTimeout: () => {},
    };
    const statuses = [];
    zm.on('status', (st) => statuses.push(st.state));
    const realTimeout = global.setTimeout;
    global.setTimeout = (fn) => realTimeout(fn, 0); // skip the waits
    try { await zm._handleAttach({ productId: 0x063e }); } finally { global.setTimeout = realTimeout; }
    assert.equal(zm.connected, true);
    assert.equal(auths, 2);
    assert.deepEqual(log, ['open', 'close', 'open']);
    assert.equal(statuses.at(-1), 'connected');
  } finally {
    Object.assign(MtpProtocol.prototype, { openSession: saved.open, getDeviceInfo: saved.info, getStorageIDs: saved.ids, getStorageInfo: saved.st });
    MtpzAuth.prototype.authenticate = saved.auth;
  }
});

test('playlists are created on the Zune with their songs, or updated in place', { skip: !ZuneManager && 'usb module not built' }, async () => {
  const zm = connectedManager();
  zm.storageId = 0x10001;
  zm.transport = { setTransferTimeout: () => {} };
  const calls = [];
  zm.mtp = {
    sendObjectInfo: async (st, parent, info) => { calls.push(['info', info.objectFormat.toString(16), info.filename]); return { objectHandle: 700 }; },
    sendObject: async (b) => calls.push(['data', b.length]),
    setObjectPropString: async (h, p, v) => calls.push(['name', h, v]),
    setObjectReferences: async (h, refs) => calls.push(['refs', h, refs]),
    syncDeviceDB: async () => calls.push(['sync']),
  };
  const made = await zm.savePlaylist('Road Trip: 2024', [11, 12, 13]);
  assert.deepEqual(made, { handle: 700, updated: false });
  assert.deepEqual(calls, [['info', 'ba05', 'Road Trip_ 2024.pla'], ['data', 0], ['name', 700, 'Road Trip: 2024'], ['refs', 700, [11, 12, 13]], ['sync']]);
  calls.length = 0;
  const upd = await zm.savePlaylist('Road Trip: 2024', [13, 11], 700);
  assert.deepEqual(upd, { handle: 700, updated: true });
  assert.deepEqual(calls.slice(0, 1), [['refs', 700, [13, 11]]]);
  assert.equal(zm.transferring, false);
});
