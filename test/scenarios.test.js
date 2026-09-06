// ─────────────────────────────────────────────────────────────────────────────
// scenarios.test.js — the movement + IO stories.
//
// A scenario's job is to be a believable machine day, because a receiver can
// only be tested against data shaped like the data it will really get. The
// assertions here are therefore about PLAUSIBILITY and INTENT, not exact
// coordinates: timestamps must advance, ignition must not flicker impossibly,
// and the parameters that matter for billing must appear only where the story
// says the hardware could have produced them.
//
// The most important test in this file is the last one: engine worktime (AVL 102)
// must never appear on a device with no CAN adapter. That is invariant 9 stated
// at the source of the data, and a scenario that violated it would train the
// whole pipeline on impossible input.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCENARIOS,
  SCENARIO_NAMES,
  DEFAULT_SCENARIO,
  buildScenario,
  scenarioRecords,
  distanceMeters,
  HANDOVER_TS_MS,
  SITE_JEBEL_ALI,
} from '../src/scenarios.js';
import { IO } from '../src/avl-io.js';
import { demoDeviceByImei } from '../src/demo-devices.js';
import { encodeAvlPacket, readAvlFrame, CODEC_8E } from '../src/protocol/codec.js';

const ioValue = (rec, id) => {
  const e = rec.io.find((x) => x.id === id);
  return e ? Number(e.value) : undefined;
};

// ── The catalogue ────────────────────────────────────────────────────────────
test('the default scenario exists and is listed', () => {
  assert.ok(SCENARIO_NAMES.includes(DEFAULT_SCENARIO));
  assert.ok(SCENARIOS[DEFAULT_SCENARIO]);
});

test('every scenario documents what it proves', () => {
  // A scenario nobody can explain is a scenario nobody will trust when it fails.
  for (const name of SCENARIO_NAMES) {
    const s = SCENARIOS[name];
    assert.ok(s.description, `${name} needs a description`);
    assert.ok(Array.isArray(s.proves) && s.proves.length > 0, `${name} needs proves[]`);
    assert.ok(Array.isArray(s.tracks) && s.tracks.length > 0, `${name} needs tracks`);
  }
});

test('an unknown scenario name is refused and lists the real ones', () => {
  assert.throws(() => buildScenario('does-not-exist'), /unknown scenario/);
  assert.throws(() => buildScenario('does-not-exist'), new RegExp(DEFAULT_SCENARIO));
});

// ── Every scenario, structurally ─────────────────────────────────────────────
for (const name of SCENARIO_NAMES) {
  test(`scenario ${name}: records are chronological within each track`, () => {
    for (const track of buildScenario(name).tracks) {
      for (let i = 1; i < track.records.length; i++) {
        assert.ok(
          track.records[i].timestampMs > track.records[i - 1].timestampMs,
          `${name}/${track.imei} record ${i} goes backwards in time`,
        );
      }
    }
  });

  test(`scenario ${name}: every position is a plausible coordinate`, () => {
    for (const track of buildScenario(name).tracks) {
      for (const r of track.records) {
        assert.ok(r.gps.lat >= -90 && r.gps.lat <= 90, `lat ${r.gps.lat}`);
        assert.ok(r.gps.lon >= -180 && r.gps.lon <= 180, `lon ${r.gps.lon}`);
        // Null Island is the classic "we lost the fix but reported anyway" bug.
        // A scenario should never emit it by accident.
        assert.ok(!(r.gps.lat === 0 && r.gps.lon === 0), 'exact 0,0 is suspicious');
        assert.ok(r.gps.speed >= 0, `negative speed ${r.gps.speed}`);
        assert.ok(r.gps.satellites >= 0 && r.gps.satellites <= 32, `sats ${r.gps.satellites}`);
      }
    }
  });

  test(`scenario ${name}: is deterministic — two builds are identical`, () => {
    // Reproducibility is what makes a scenario a shared reference point between
    // two people debugging the same complaint.
    const a = scenarioRecords(buildScenario(name));
    const b = scenarioRecords(buildScenario(name));
    assert.equal(a.length, b.length);
    assert.deepEqual(
      a.map((r) => [r.imei, r.timestampMs, r.gps.lat, r.gps.lon]),
      b.map((r) => [r.imei, r.timestampMs, r.gps.lat, r.gps.lon]),
    );
  });

  test(`scenario ${name}: every record survives a real encode/decode round trip`, () => {
    // A scenario that cannot be put on the wire is not a test fixture, it is a
    // drawing. This is the check that keeps them honest.
    for (const track of buildScenario(name).tracks) {
      for (const r of track.records) {
        const { packet } = readAvlFrame(encodeAvlPacket({ codecId: CODEC_8E, records: [r] }));
        const back = packet.records[0];
        assert.equal(Number(back.timestampMs), r.timestampMs);
        assert.ok(Math.abs(back.gps.lat - r.gps.lat) < 1e-6);
        assert.equal(back.io.length, r.io.length, 'no IO element may be lost');
      }
    }
  });
}

// ── Invariant 3 at the source: absent is absent, never zero ──────────────────
test('an IO element is either present with a value or absent — never a filler 0', () => {
  // If a scenario emitted 0 for "we did not read this", every downstream NULL≠0
  // guard would be testing against data that had already lost the distinction.
  for (const name of SCENARIO_NAMES) {
    for (const track of buildScenario(name).tracks) {
      for (const r of track.records) {
        for (const e of r.io) {
          assert.notEqual(e.value, undefined, `${name}: IO ${e.id} present with no value`);
          assert.notEqual(e.value, null, `${name}: IO ${e.id} present as null`);
          assert.ok([1, 2, 4, 8].includes(e.size), `${name}: IO ${e.id} odd size ${e.size}`);
        }
      }
    }
  }
});

test('IO ids are never duplicated within one record', () => {
  // Two values for one parameter in a single record has no defined meaning, and
  // whichever one a decoder happens to keep would be arbitrary.
  for (const name of SCENARIO_NAMES) {
    for (const track of buildScenario(name).tracks) {
      for (const r of track.records) {
        const ids = r.io.map((e) => e.id);
        assert.equal(new Set(ids).size, ids.length, `${name}: duplicate IO id in a record`);
      }
    }
  }
});

// ── The handover story (invariant 6) ─────────────────────────────────────────
test('the handover scenario straddles the handover instant', () => {
  // The whole point of this scenario is that ONE device produces records on both
  // sides of a contract boundary, so attribution must be resolved per record.
  const recs = scenarioRecords(buildScenario('handover'));
  const before = recs.filter((r) => r.timestampMs < HANDOVER_TS_MS);
  const after = recs.filter((r) => r.timestampMs >= HANDOVER_TS_MS);
  assert.ok(before.length > 0, 'no records before the handover');
  assert.ok(after.length > 0, 'no records after the handover');
  assert.equal(new Set(recs.map((r) => r.imei)).size, 1, 'must be the SAME device');
});

// ── Invariant 9 at the source ────────────────────────────────────────────────
test('engine worktime never appears on a device with no CAN adapter', () => {
  // This is invariant 9 enforced where the data is born. A no-CAN unit physically
  // cannot read the machine's hour meter, so a scenario emitting AVL 102 for one
  // would be fabricating billing evidence.
  for (const name of SCENARIO_NAMES) {
    for (const track of buildScenario(name).tracks) {
      const dev = demoDeviceByImei(track.imei);
      if (!dev || dev.hasCan) continue;
      for (const r of track.records) {
        assert.equal(
          ioValue(r, IO.ENGINE_WORKTIME_MIN),
          undefined,
          `${name}: ${track.imei} has no CAN yet reports AVL ${IO.ENGINE_WORKTIME_MIN}`,
        );
      }
    }
  }
});

test('engine worktime, where present, never goes backwards', () => {
  // It is a cumulative meter. A decrease means either a wrong parameter or a
  // replaced ECU, and both are conditions a reconciliation must catch rather than
  // average away.
  for (const name of SCENARIO_NAMES) {
    for (const track of buildScenario(name).tracks) {
      let last = -Infinity;
      for (const r of track.records) {
        const v = ioValue(r, IO.ENGINE_WORKTIME_MIN);
        if (v === undefined) continue;
        assert.ok(v >= last, `${name}: AVL 102 went ${last} -> ${v}`);
        last = v;
      }
    }
  }
});

// ── Geometry helper ──────────────────────────────────────────────────────────
test('distanceMeters is zero for a point against itself', () => {
  const { lat, lon } = SITE_JEBEL_ALI;
  assert.ok(distanceMeters({ lat, lon }, { lat, lon }) < 0.001);
});

test('distanceMeters is symmetric and grows with separation', () => {
  const a = { lat: 25.0, lon: 55.0 };
  const b = { lat: 25.01, lon: 55.0 };
  const c = { lat: 25.02, lon: 55.0 };
  const ab = distanceMeters(a, b);
  assert.ok(Math.abs(ab - distanceMeters(b, a)) < 0.001, 'must be symmetric');
  assert.ok(distanceMeters(a, c) > ab, 'further apart must measure further');
  // ~0.01 degree of latitude is ~1.1 km; a sanity band catches a unit mix-up.
  assert.ok(ab > 900 && ab < 1300, `0.01 deg lat measured ${ab} m`);
});
