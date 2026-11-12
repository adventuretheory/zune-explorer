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
