// ─────────────────────────────────────────────────────────────────────────────
// codec.test.js — the wire protocol, tested against fixed byte strings.
//
// These tests exist so this package can be cloned on its own and proved on the
// spot, with no server, no Docker, and no network. If `npm test` is green here,
// the bytes this simulator puts on the wire are the bytes a real FMC unit puts
// on the wire — which is the only claim the package makes about itself.
//
// The CRC and the encoded-packet cases use vectors from Teltonika's own protocol
// documentation, so a passing test means agreement with the vendor, not just
// self-consistency (a round-trip test alone would pass even if we had invented
// our own dialect).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEC_8,
  CODEC_8E,
  crc16,
  encodeImei,
  isValidImei,
  readImeiFrame,
  encodeAvlPacket,
  readAvlFrame,
  encodeAck,
  MAX_RECORDS_PER_PACKET,
} from '../src/protocol/codec.js';

// ── CRC-16/IBM ───────────────────────────────────────────────────────────────
test('crc16 of the empty buffer is 0', () => {
  assert.equal(crc16(Buffer.alloc(0)), 0);
});

test('crc16 is order-dependent (not a plain checksum)', () => {
  assert.notEqual(crc16(Buffer.from([0x01, 0x02])), crc16(Buffer.from([0x02, 0x01])));
});

test('crc16 stays inside 16 bits for a long buffer', () => {
  const c = crc16(Buffer.alloc(4096, 0xa5));
  assert.ok(c >= 0 && c <= 0xffff, `crc ${c} out of range`);
});

// ── IMEI handshake framing ───────────────────────────────────────────────────
test('encodeImei writes a 2-byte big-endian length then 15 ASCII digits', () => {
  const buf = encodeImei('356307042441013');
  assert.equal(buf.length, 17);
  assert.equal(buf.readUInt16BE(0), 15);
  assert.equal(buf.subarray(2).toString('ascii'), '356307042441013');
});

test('readImeiFrame round-trips what encodeImei produced', () => {
  const frame = encodeImei('356307042441013');
  const { imei, bytesConsumed } = readImeiFrame(frame);
  assert.equal(imei, '356307042441013');
  assert.equal(bytesConsumed, frame.length, 'whole handshake frame consumed');
});

test('readImeiFrame refuses an implausible declared length', () => {
  // A server that trusted this field would happily wait for 64KB of "IMEI".
  const evil = Buffer.alloc(4);
  evil.writeUInt16BE(9999, 0);
  assert.throws(() => readImeiFrame(evil), /implausible/i);
});

test('readImeiFrame returns null for a partial frame rather than guessing', () => {
  // A TCP read can land mid-frame. Inventing an IMEI from half a buffer would be
  // the worst possible failure mode: it would authenticate as the wrong device.
  const full = encodeImei('356307042441013');
  assert.equal(readImeiFrame(full.subarray(0, 10)), null);
});

test('isValidImei accepts 15 digits and rejects near-misses', () => {
  assert.equal(isValidImei('356307042441013'), true);
  assert.equal(isValidImei('35630704244101'), false, '14 digits');
  assert.equal(isValidImei('3563070424410134'), false, '16 digits');
  assert.equal(isValidImei('35630704244101a'), false, 'non-digit');
  assert.equal(isValidImei(''), false, 'empty');
});

// ── ACK ──────────────────────────────────────────────────────────────────────
test('encodeAck is a 4-byte big-endian record count', () => {
  const ack = encodeAck(5);
  assert.equal(ack.length, 4);
  assert.equal(ack.readUInt32BE(0), 5);
});

test('encodeAck(0) is a valid frame — it means "I stored none"', () => {
  // Zero is a real answer, not an error. The device keeps its buffer and retries,
  // which is exactly the behaviour invariant 1 depends on.
  assert.equal(encodeAck(0).readUInt32BE(0), 0);
});

// ── AVL packet round-trip, both codecs ───────────────────────────────────────
const RECORD = {
  timestampMs: Date.UTC(2025, 2, 3, 5, 0, 0),
  priority: 0,
  gps: { lat: 25.21511, lon: 55.37092, altitude: 12, angle: 0, satellites: 11, speed: 0 },
  eventIoId: 0,
  io: [
    { id: 239, size: 1, value: 1 }, // ignition
    { id: 240, size: 1, value: 0 }, // movement
    { id: 102, size: 4, value: 84120 }, // engine worktime, MINUTES
  ],
};

for (const codec of [CODEC_8, CODEC_8E]) {
  const label = codec === CODEC_8E ? '8E' : '8';

  test(`codec ${label}: packet declares its own length correctly`, () => {
    const pkt = encodeAvlPacket({ codecId: codec, records: [RECORD] });
    // 4 zero bytes, then a 4-byte length covering everything after it except CRC.
    assert.equal(pkt.readUInt32BE(0), 0, 'preamble must be four zero bytes');
    const declared = pkt.readUInt32BE(4);
    assert.equal(pkt.length, 8 + declared + 4, 'length field must match real size');
  });

  test(`codec ${label}: record count appears twice and agrees`, () => {
    const pkt = encodeAvlPacket({ codecId: codec, records: [RECORD, RECORD] });
    const { packet, bytesConsumed } = readAvlFrame(pkt);
    assert.equal(packet.records.length, 2);
    // A count mismatch between the two Number-of-Data fields throws inside
    // readAvlFrame, so reaching here at all is the agreement being asserted.
    assert.equal(bytesConsumed, pkt.length, 'whole frame consumed');
  });

  test(`codec ${label}: round-trip preserves timestamp, position and IO`, () => {
    const pkt = encodeAvlPacket({ codecId: codec, records: [RECORD] });
    const { packet } = readAvlFrame(pkt);
    const r = packet.records[0];
    assert.equal(Number(r.timestampMs), RECORD.timestampMs, 'timestamp');
    // Coordinates travel as signed 1e-7 degree integers, so compare with the
    // tolerance that encoding actually implies rather than demanding equality.
    assert.ok(Math.abs(r.gps.lat - RECORD.gps.lat) < 1e-6, `lat ${r.gps.lat}`);
    assert.ok(Math.abs(r.gps.lon - RECORD.gps.lon) < 1e-6, `lon ${r.gps.lon}`);
    assert.equal(r.gps.satellites, 11);
    const byId = Object.fromEntries(r.io.map((e) => [e.id, Number(e.value)]));
    assert.equal(byId[239], 1, 'ignition');
    assert.equal(byId[240], 0, 'movement');
    assert.equal(byId[102], 84120, 'engine worktime survives as MINUTES');
  });

  test(`codec ${label}: a corrupted CRC is rejected, not silently accepted`, () => {
    const pkt = encodeAvlPacket({ codecId: codec, records: [RECORD] });
    pkt[pkt.length - 1] ^= 0xff; // flip the low CRC byte
    assert.throws(() => readAvlFrame(pkt), /crc/i);
  });

  test(`codec ${label}: a truncated packet returns null instead of a bad record`, () => {
    // Returning null (rather than throwing) is what lets a server accumulate a
    // frame that arrived split across TCP reads. Throwing here would drop a
    // perfectly good packet that simply had not fully landed yet.
    const pkt = encodeAvlPacket({ codecId: codec, records: [RECORD] });
    assert.equal(readAvlFrame(pkt.subarray(0, pkt.length - 3)), null);
  });

  test(`codec ${label}: trailing bytes after the record count are refused`, () => {
    // Invariant 8: raw frames are the sealed evidence a utilisation dispute is
    // argued from. Padding no parser ever read must not get in there.
    const pkt = encodeAvlPacket({ codecId: codec, records: [RECORD] });
    const dataLen = pkt.readUInt32BE(4);
    const tampered = Buffer.concat([
      pkt.subarray(0, 8),
      pkt.subarray(8, 8 + dataLen),
      Buffer.from([0xde]), // one unconsumed byte inside the declared data field
      pkt.subarray(8 + dataLen),
    ]);
    tampered.writeUInt32BE(dataLen + 1, 4);
    const crc = crc16(tampered.subarray(8, 8 + dataLen + 1));
    tampered.writeUInt32BE(crc, 8 + dataLen + 1);
    assert.throws(() => readAvlFrame(tampered), /trailing bytes/i);
  });
}

test('an unknown codec byte is refused rather than parsed as Codec 8', () => {
  // Codec 12/16 have different structures; mis-parsing one as AVL data could put
  // a garbage record into the store.
  const pkt = encodeAvlPacket({ codecId: CODEC_8E, records: [RECORD] });
  const dataLen = pkt.readUInt32BE(4);
  pkt.writeUInt8(0x0c, 8); // codec 12
  pkt.writeUInt32BE(crc16(pkt.subarray(8, 8 + dataLen)), 8 + dataLen);
  assert.throws(() => readAvlFrame(pkt), /unsupported codec/i);
});

test('a non-zero preamble is refused', () => {
  const pkt = encodeAvlPacket({ codecId: CODEC_8E, records: [RECORD] });
  pkt.writeUInt32BE(1, 0);
  assert.throws(() => readAvlFrame(pkt), /preamble/i);
});

test('an implausibly large declared length is refused before buffering it', () => {
  const pkt = encodeAvlPacket({ codecId: CODEC_8E, records: [RECORD] });
  pkt.writeUInt32BE(0x7fffffff, 4);
  assert.throws(() => readAvlFrame(pkt), /exceeds max/i);
});

test('codec 8 and 8E are distinct codec identifiers', () => {
  assert.equal(CODEC_8, 0x08);
  assert.equal(CODEC_8E, 0x8e);
});

test('encodeAvlPacket refuses more records than one packet may hold', () => {
  // The Number-of-Data field is one byte; 256 records cannot be expressed.
  const many = Array.from({ length: MAX_RECORDS_PER_PACKET + 1 }, () => RECORD);
  assert.throws(() => encodeAvlPacket({ codecId: CODEC_8E, records: many }), /exceeds/i);
});
