// ─────────────────────────────────────────────────────────────────────────────
// buffered-device.test.js — store-and-forward, tested against a real TCP server.
//
// These tests spin a tiny throwaway server that speaks just enough of the
// protocol to handshake and ACK, because the behaviour under test is entirely
// about what the device does with the ACK it gets back. A mock would let us
// assert our own assumptions; a socket makes us live with the real ordering.
//
// The behaviour being pinned down is the device half of invariant 1: a record
// leaves the buffer ONLY once an ACK has covered it. A server that ACKs before
// its write is durable causes silent, permanent data loss right here — the
// device will have erased its only copy.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { BufferedDevice } from '../src/buffered-device.js';
import { readImeiFrame, readAvlFrame, encodeAck } from '../src/protocol/codec.js';

const IMEI = '356307042441013';

function record(tsMs) {
  return {
    timestampMs: tsMs,
    priority: 0,
    gps: { lat: 25.2, lon: 55.3, altitude: 10, angle: 0, satellites: 9, speed: 0 },
    eventIoId: 0,
    io: [{ id: 239, size: 1, value: 1 }],
  };
}

/**
 * A server whose ACK policy is injectable, so a test can be explicit about the
 * one thing that matters: what number went back on the wire.
 *
 * @param {(n:number)=>number|null} ackPolicy  records received -> count to ACK.
 *        Return null to send nothing at all (a hung server).
 */
async function startServer({ accept = true, ackPolicy = (n) => n } = {}) {
  const received = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let shookHands = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!shookHands) {
        const frame = readImeiFrame(buf);
        if (!frame) return;
        buf = buf.subarray(frame.bytesConsumed);
        shookHands = true;
        sock.write(Buffer.from([accept ? 0x01 : 0x00]));
        if (!accept) sock.end();
        return;
      }
      for (;;) {
        let parsed;
        try {
          parsed = readAvlFrame(buf);
        } catch {
          return sock.destroy();
        }
        if (!parsed) return;
        buf = buf.subarray(parsed.bytesConsumed);
        received.push(...parsed.packet.records);
        const ack = ackPolicy(parsed.packet.records.length);
        if (ack !== null) sock.write(encodeAck(ack));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ── The happy path ───────────────────────────────────────────────────────────
test('a fully ACKed batch leaves an empty buffer', async () => {
  const srv = await startServer();
  const dev = new BufferedDevice({ host: '127.0.0.1', port: srv.port, imei: IMEI });
  assert.equal(await dev.connect(), true);

  const acked = await dev.send([record(1), record(2), record(3)]);
  assert.equal(acked, 3);
  assert.equal(dev.pending, 0, 'nothing should still be queued');
  assert.equal(srv.received.length, 3);
  assert.equal(dev.stats.acked, 3);

  dev.close();
  await srv.close();
});

test('perPacket batches records into fewer, larger packets', async () => {
  const srv = await startServer();
  const dev = new BufferedDevice({
    host: '127.0.0.1',
    port: srv.port,
    imei: IMEI,
    perPacket: 5,
  });
  await dev.connect();
  await dev.send([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(record));
  assert.equal(srv.received.length, 10, 'all records still arrive');
  assert.equal(dev.pending, 0);
  dev.close();
  await srv.close();
});

// ── The refusal ──────────────────────────────────────────────────────────────
test('a rejected handshake is reported, not thrown', async () => {
  // A real unit does not crash when the server says "who are you"; it retries.
  const srv = await startServer({ accept: false });
  const events = [];
  const dev = new BufferedDevice({
    host: '127.0.0.1',
    port: srv.port,
    imei: IMEI,
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(await dev.connect(), false);
  assert.equal(dev.stats.handshakeRejects, 1);
  assert.ok(events.includes('handshake-rejected'), `events: ${events}`);
  dev.close();
  await srv.close();
});

test('connecting to nothing at all is reported, not thrown', async () => {
  const dev = new BufferedDevice({ host: '127.0.0.1', port: 1, imei: IMEI });
  assert.equal(await dev.connect(), false);
  assert.equal(dev.stats.connects, 0);
  dev.close();
});

// ── The invariant this file exists for ───────────────────────────────────────
test('a short ACK keeps the uncovered records queued', async () => {
  // The server claims only 1 of 3 was stored. The other 2 must NOT be erased —
  // they are the only copy in existence.
  const srv = await startServer({ ackPolicy: () => 1 });
  const events = [];
  const dev = new BufferedDevice({
    host: '127.0.0.1',
    port: srv.port,
    imei: IMEI,
    perPacket: 3,
    onEvent: (e) => events.push(e.type),
  });
  await dev.connect();

  const acked = await dev.send([record(1), record(2), record(3)]);
  assert.equal(acked, 1, 'only the covered record counts as delivered');
  assert.equal(dev.pending, 2, 'the uncovered tail must survive');
  assert.equal(dev.stats.ackMismatches, 1);
  assert.ok(events.includes('ack-mismatch'), `events: ${events}`);

  dev.close();
  await srv.close();
});

test('an ACK of 0 erases nothing', async () => {
  const srv = await startServer({ ackPolicy: () => 0 });
  const dev = new BufferedDevice({
    host: '127.0.0.1',
    port: srv.port,
    imei: IMEI,
    perPacket: 2,
  });
  await dev.connect();
  await dev.send([record(1), record(2)]);
  assert.equal(dev.pending, 2, 'zero stored means zero erased');
  assert.equal(dev.stats.acked, 0);
  dev.close();
  await srv.close();
});

test('records queued while offline are delivered after a reconnect, in order', async () => {
  const srv = await startServer();
  const dev = new BufferedDevice({ host: '127.0.0.1', port: srv.port, imei: IMEI });
  await dev.connect();
  await dev.send([record(1)]);

  // Drop the link and WAIT for the close to actually land, so the device knows
  // it is offline before the next enqueue. Without the wait it still believes it
  // is connected and the test becomes a coin flip.
  const closed = new Promise((r) => dev.dev.socket.once('close', r));
  dev.dev.socket.destroy();
  await closed;
  assert.equal(dev.connected, false);
  assert.equal(dev.stats.linkDrops, 1);

  dev.enqueue([record(2), record(3), record(4)]);
  assert.equal(dev.pending, 3, 'offline records must pile up, not vanish');

  assert.equal(await dev.connect(), true);
  const acked = await dev.flush();
  assert.equal(acked, 3);
  assert.equal(dev.pending, 0);

  // Original timestamps, oldest first — this is why an offline day still yields
  // a correct utilisation figure afterwards (invariant 6 attributes each record
  // at its OWN time, not at delivery time).
  const ts = srv.received.map((r) => Number(r.timestampMs));
  assert.deepEqual(ts, [1, 2, 3, 4]);

  dev.close();
  await srv.close();
});

test('with buffering OFF, a record sent while offline is dropped and counted', async () => {
  const srv = await startServer();
  const events = [];
  const dev = new BufferedDevice({
    host: '127.0.0.1',
    port: srv.port,
    imei: IMEI,
    bufferEnabled: false,
    onEvent: (e) => events.push(e.type),
  });
  await dev.connect();
  const closed = new Promise((r) => dev.dev.socket.once('close', r));
  dev.dev.socket.destroy();
  await closed;

  dev.enqueue([record(1), record(2)]);
  assert.equal(dev.pending, 0, 'nothing is held');
  assert.equal(dev.stats.droppedNoBuffer, 2);
  assert.ok(events.includes('dropped-no-buffer'));

  dev.close();
  await srv.close();
});

test('an overflowing buffer drops the OLDEST records, as flash does', async () => {
  // Newest data is the most operationally useful, so hardware sacrifices history
  // rather than the present. Getting this backwards would make a recovered
  // backlog look plausible while being wrong about right now.
  const events = [];
  const dev = new BufferedDevice({
    host: '127.0.0.1',
    port: 1,
    imei: IMEI,
    maxRecords: 3,
    onEvent: (e) => events.push(e),
  });
  dev.enqueue([1, 2, 3, 4, 5].map(record));
  assert.equal(dev.pending, 3);
  assert.equal(dev.stats.droppedOverflow, 2);
  assert.deepEqual(
    dev.buffer.map((r) => r.timestampMs),
    [3, 4, 5],
    'the two oldest went, the newest three stayed',
  );
  assert.ok(events.some((e) => e.type === 'dropped-overflow'));
  dev.close();
});

test('flush on a disconnected device is a no-op, not an error', async () => {
  const dev = new BufferedDevice({ host: '127.0.0.1', port: 1, imei: IMEI });
  dev.enqueue([record(1)]);
  assert.equal(await dev.flush(), 0);
  assert.equal(dev.pending, 1, 'the record is still there for the next attempt');
  dev.close();
});
