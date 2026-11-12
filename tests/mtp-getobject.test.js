const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MtpProtocol } = require('../src/main/zune/mtp-protocol.js');

function container(type, code, txId, payload = Buffer.alloc(0)) {
  const buf = Buffer.alloc(12 + payload.length);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(type, 4);
  buf.writeUInt16LE(code, 6);
  buf.writeUInt32LE(txId, 8);
  payload.copy(buf, 12);
  return buf;
}

function fakeTransport(replies) {
  return {
    async bulkWrite() {},
    async bulkRead() {
      if (!replies.length) throw new Error('test: read with nothing queued (would hang on a real device)');
      return replies.shift();
    },
  };
}

test('getObject rejects promptly when the device answers with an error response', async () => {
  // 0x2009 = InvalidObjectHandle, sent as a RESPONSE (type 3) with no DATA phase
  const mtp = new MtpProtocol(fakeTransport([container(3, 0x2009, 1)]));
  await assert.rejects(mtp.getObject(0x1234), /GetObject failed/);
});

test('getObject returns the payload on a normal DATA + OK exchange', async () => {
  const body = Buffer.from('song bytes');
  const mtp = new MtpProtocol(fakeTransport([container(2, 0x1009, 1, body), container(3, 0x2001, 1)]));
  assert.deepEqual(await mtp.getObject(0x1234), body);
});

// Serves queued USB packets; a read takes at most `length` bytes of the next
// packet. An empty Buffer is a zero-length packet (ZLP).
function packetTransport(packets) {
  return {
    async bulkWrite() {},
    async bulkRead(length) {
      if (!packets.length) throw new Error('test: read with nothing queued (would hang on a real device)');
      const p = packets.shift();
      if (p.length > length) { packets.unshift(p.subarray(length)); return p.subarray(0, length); }
      return p;
    },
  };
}

test('a zero-length packet after a 512-multiple file does not break the next reply', async () => {
  // DATA container of exactly 1024 bytes (12 header + 1012 payload), then the
  // ZLP the device sends to end it, then the OK response.
  const body = Buffer.alloc(1012, 7);
  const dataContainer = container(2, 0x1009, 1, body);
  assert.equal(dataContainer.length % 512, 0);
  const packets = [dataContainer, Buffer.alloc(0), container(3, 0x2001, 1)];
  // Next request: GetObjectHandles returns one handle, then OK
  const handles = Buffer.alloc(8); handles.writeUInt32LE(1, 0); handles.writeUInt32LE(0x42, 4);
  packets.push(container(2, 0x1007, 2, handles), container(3, 0x2001, 2));

  const mtp = new MtpProtocol(packetTransport(packets));
  assert.deepEqual(await mtp.getObject(0x10013b7), body);
  assert.deepEqual(await mtp.getObjectHandles(0x10001, 0, 0), [0x42]);
});

test('a reply header split across packets is reassembled', async () => {
  const resp = container(3, 0x2001, 1);
  const mtp = new MtpProtocol(packetTransport([resp.subarray(0, 4), resp.subarray(4)]));
  const c = await mtp.receiveData();
  assert.equal(c.type, 3);
  assert.equal(c.code, 0x2001);
});
