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
