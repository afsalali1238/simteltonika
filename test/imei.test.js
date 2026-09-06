// ─────────────────────────────────────────────────────────────────────────────
// imei.test.js — device identity.
//
// An IMEI is not an arbitrary string. It is TAC(8) + serial(6) + a Luhn check
// digit, per 3GPP TS 23.003. Minting them correctly matters because the IMEI is
// the ONLY thing a Teltonika unit presents at the handshake — it is the identity
// the server authorises, so a fleet of simulated units with colliding or
// malformed IMEIs would exercise a registry gate that no real fleet resembles.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FMC130_TAC,
  DEFAULT_SERIAL_BASE,
  luhnCheckDigit,
  luhnValid,
  makeImei,
  generateFleet,
} from '../src/imei.js';
import { isValidImei } from '../src/protocol/codec.js';
import { DEMO_DEVICES, demoDeviceByImei } from '../src/demo-devices.js';

// ── Luhn ─────────────────────────────────────────────────────────────────────
test('luhnCheckDigit returns a single digit', () => {
  for (const serial of [0, 1, 244101, 500000, 999999]) {
    const body = `${FMC130_TAC}${String(serial).padStart(6, '0')}`;
    const d = luhnCheckDigit(body);
    assert.ok(Number.isInteger(d) && d >= 0 && d <= 9, `got ${d} for ${body}`);
  }
});

test('luhnValid accepts a minted IMEI and rejects it with one digit changed', () => {
  const imei = makeImei(244101);
  assert.equal(luhnValid(imei), true, imei);
  // Change a body digit; the check digit no longer agrees.
  const broken = imei.slice(0, 9) + String((Number(imei[9]) + 1) % 10) + imei.slice(10);
  assert.equal(luhnValid(broken), false, broken);
});

test('luhnValid catches a wrong check digit', () => {
  const imei = makeImei(244101);
  const wrong = imei.slice(0, 14) + String((Number(imei[14]) + 1) % 10);
  assert.equal(luhnValid(wrong), false, wrong);
});

// ── Minting ──────────────────────────────────────────────────────────────────
test('makeImei produces 15 digits on the FMC130 TAC', () => {
  const imei = makeImei(DEFAULT_SERIAL_BASE);
  assert.equal(imei.length, 15);
  assert.ok(imei.startsWith(FMC130_TAC), `${imei} should start with ${FMC130_TAC}`);
  assert.equal(isValidImei(imei), true, 'must also pass wire-level validation');
  assert.equal(luhnValid(imei), true);
});

test('makeImei is deterministic — the same serial always gives the same IMEI', () => {
  // This is what lets a demo IMEI be written on a whiteboard and still be that
  // unit next week.
  assert.equal(makeImei(500000), makeImei(500000));
});

test('makeImei(244101) is D1 — the documented demo unit', () => {
  // Pinned deliberately: this IMEI appears in seed data, docs and the tutorial.
  // If this test fails, something renumbered a device that is written down
  // elsewhere, and the fix is to change the code back, not the test.
  assert.equal(makeImei(244101), '356307042441013');
});

test('makeImei(500000) is the reserved Actros demo unit', () => {
  assert.equal(makeImei(500000), '356307045000006');
});

test('different serials give different IMEIs', () => {
  const a = makeImei(1);
  const b = makeImei(2);
  assert.notEqual(a, b);
});

// ── Fleets ───────────────────────────────────────────────────────────────────
test('generateFleet mints the requested count, all unique and all valid', () => {
  const fleet = generateFleet({ count: 50, serialBase: 700000 });
  assert.equal(fleet.length, 50);
  assert.equal(new Set(fleet).size, 50, 'IMEIs must not collide');
  for (const imei of fleet) {
    assert.equal(isValidImei(imei), true, imei);
    assert.equal(luhnValid(imei), true, imei);
  }
});

test('generateFleet is contiguous from serialBase', () => {
  const fleet = generateFleet({ count: 3, serialBase: 800000 });
  assert.deepEqual(fleet, [makeImei(800000), makeImei(800001), makeImei(800002)]);
});

test('two fleets from the same serialBase are identical', () => {
  assert.deepEqual(
    generateFleet({ count: 5, serialBase: 900000 }),
    generateFleet({ count: 5, serialBase: 900000 }),
  );
});

test('generateFleet refuses a count that would overflow the 6-digit serial space', () => {
  // Wrapping around would silently re-mint IMEIs already in use — a duplicate
  // identity is the one thing a device registry cannot recover from.
  assert.throws(() => generateFleet({ count: 10, serialBase: 999_995 }), /overflow/i);
});

test('generateFleet refuses a nonsensical count instead of returning nothing', () => {
  assert.throws(() => generateFleet({ count: 0 }), /positive integer/);
  assert.throws(() => generateFleet({}), /positive integer/);
});

// ── The demo devices ─────────────────────────────────────────────────────────
test('demo devices are looked up by IMEI', () => {
  const d1 = demoDeviceByImei('356307042441013');
  assert.ok(d1, 'D1 must be findable');
  assert.equal(d1.model, 'FMC130');
  assert.equal(d1.hasCan, true, 'D1 is the CAN-equipped unit');
});

test('an unknown IMEI looks up to null, not to a default device', () => {
  // Falling back to a device would let an unregistered unit silently borrow
  // another one's identity.
  assert.equal(demoDeviceByImei('860000000000007'), null);
});

test('D2 has a deliberately Luhn-INVALID IMEI, and that is not a bug', () => {
  // D2 exists to exercise the "server rejects a malformed identity" path. It is
  // committed, billing-adjacent fixture data. Do NOT "fix" the check digit — this
  // test is here to stop exactly that well-meant edit.
  const d2 = DEMO_DEVICES.find((d) => d.imei === '356307042441099');
  assert.ok(d2, 'D2 must exist');
  assert.equal(isValidImei(d2.imei), true, 'it is still 15 digits — wire-valid');
  assert.equal(luhnValid(d2.imei), false, 'but the check digit is intentionally wrong');
  assert.equal(d2.hasCan, false, 'D2 has no CAN adapter');
});

test('the two demo devices differ in CAN capability', () => {
  // That difference is the whole point: invariant 9 says no CAN program means
  // position + ignition only, never engine hours.
  const withCan = DEMO_DEVICES.filter((d) => d.hasCan);
  const without = DEMO_DEVICES.filter((d) => !d.hasCan);
  assert.equal(withCan.length, 1);
  assert.equal(without.length, 1);
});
