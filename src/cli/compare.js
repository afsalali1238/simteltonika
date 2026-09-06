#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// compare.js — send ONE packet of known bytes to two receivers, then read back
// what each of them decoded, and put the two answers next to each other.
//
// This is the exercise that makes the whole Traccar detour worth doing. Streaming
// into Traccar on its own only proves our bytes are well-formed — a useful but
// small result. The interesting result is the DISAGREEMENT, and specifically
// WHERE it falls:
//
//   • Position, time, speed, ignition (AVL 239), movement (AVL 240) — both sides
//     should land on the same values. Traccar has named decoders for these. If
//     these disagree, one of the two is wrong about the wire, and since Traccar
//     is the mature independent implementation, assume it's us and go look.
//
//   • Engine worktime (AVL 102), tracker worktime (103), ignition count (449) —
//     Traccar has NO named handler for these. They survive as untyped entries in
//     its `attributes` map (usually keyed `io102` etc.) with no unit, no meaning,
//     and no notion that 102 is in MINUTES. Our side treats 102 as the billing
//     parameter with source 'ecu'.
//
// That second bullet is the lesson: a third-party parser agreeing with you on
// position tells you nothing about whether your billing number is right. Traccar
// cannot validate the parameter the invoice depends on, because Traccar does not
// know what it is. Anyone who concludes "Traccar decoded it, so we're correct"
// has drawn exactly the wrong inference, and this tool exists to make that
// visible rather than assumed.
//
// Exit code is 0 even when the sides differ. A difference here is the expected
// finding, not a build failure — see --help.
//
// Neither receiver is modified. This only sends a packet and issues two reads.
// ─────────────────────────────────────────────────────────────────────────────

import { BufferedDevice } from '../buffered-device.js';
import { buildScenario, SCENARIO_NAMES, DEFAULT_SCENARIO } from '../scenarios.js';
import { IO, IO_NAME, TRACCAR_NAMED_PARAMS } from '../avl-io.js';
import { loadConfig } from '../device-config.js';

const line = (c = '─') => console.log(c.repeat(88));

function printHelp() {
  console.log(`
teltonika-sim compare — decode the same bytes twice, ours vs Traccar

  npx teltonika-sim compare [flags]

What it does
  1. Streams a scenario at Traccar   (Teltonika TCP port, default 5027)
  2. Streams the SAME records at our ingest (default 5127)
  3. Reads Traccar's decode back over its REST API   (/api/positions)
  4. Reads our decode back over our read API         (/positions)
  5. Prints them field by field, and flags which AVL params Traccar had no
     named handler for.

Flags
  --imei N                 device to stream as. MUST be registered on BOTH
                           receivers first, or that side rejects the handshake.
  --scenario NAME          ${SCENARIO_NAMES.join(' | ')}
                           (default ${DEFAULT_SCENARIO})
  --traccar-host H         default 127.0.0.1
  --traccar-port N         Teltonika TCP port          (default 5027)
  --traccar-api URL        default http://127.0.0.1:8082
  --traccar-user U         Traccar login (default admin)
  --traccar-pass P         Traccar password (default admin)
  --ours-host H            default 127.0.0.1
  --ours-port N            our ingest TCP port         (default 5127)
  --ours-api URL           our read API (default http://127.0.0.1:8080 —
                           what 'npm run start:api' binds)
  --tenant UUID            X-Tenant-Id for our read API. Required to read our
                           side — every read of ours is tenant-scoped, and that
                           is itself part of the comparison: Traccar's API has
                           no equivalent of this header.
  --skip-traccar           only stream+read our side (useful before Traccar is up)
  --skip-ours              only stream+read Traccar's side
  --self-check             assert this tool reads Traccar's JSON shape correctly,
                           without needing Traccar. Does NOT test Traccar itself.
  -h, --help               this help

Exit code
  Always 0 on a successful run, EVEN IF THE TWO SIDES DISAGREE. The engine-hour
  gap is the correct, expected outcome of this comparison — failing the process
  on it would train you to treat a true finding as a broken build. Only a real
  error (cannot connect, handshake rejected, bad credentials) exits non-zero.

Before you run this
  Register the IMEI on BOTH sides:
    Traccar : Settings → Devices → Add, Identifier = the IMEI
    Ours    : it must exist in the device registry (see the sim tutorial)
  Traccar's default Teltonika port is 5027 and so is ours — run ours on 5127
  (the default here) so they don't fight over the port.

  IMPORTANT — start our side with ONE process that holds both servers:
    npm run dashboard          (ingest on 5027 + read API on 8080, one store)
  'npm run start:ingest' and 'npm run start:api' are SEPARATE processes, and in
  memory mode each gets its OWN store — so the API would honestly report zero
  positions for packets the ingest definitely accepted. That is not a bug and
  not lost data; it is two processes with two in-memory stores. Use 'dashboard'
  in memory mode, or run both against Postgres (DB=pg) where the store is shared.
`);
}

function parseArgs(argv) {
  const out = {};
  const take = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inlineVal] = eq > 2 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const val = () => inlineVal ?? take(i++);
    switch (flag) {
      case '-h': case '--help': out.help = true; break;
      case '--self-check': out.selfCheck = true; break;
      case '--conf': out.conf = val(); break;
      case '--imei': out.imei = val(); break;
      case '--scenario': out.scenario = val(); break;
      case '--traccar-host': out.traccarHost = val(); break;
      case '--traccar-port': out.traccarPort = Number(val()); break;
      case '--traccar-api': out.traccarApi = val(); break;
      case '--traccar-user': out.traccarUser = val(); break;
      case '--traccar-pass': out.traccarPass = val(); break;
      case '--ours-host': out.oursHost = val(); break;
      case '--ours-port': out.oursPort = Number(val()); break;
      case '--ours-api': out.oursApi = val(); break;
      case '--tenant': out.tenant = val(); break;
      case '--skip-traccar': out.skipTraccar = true; break;
      case '--skip-ours': out.skipOurs = true; break;
      default: break;
    }
  }
  return out;
}

// ── Streaming ────────────────────────────────────────────────────────────────
// Deliberately one packet per record and a wait for each ACK: this tool is about
// what got decoded, so batching would only blur which record produced which row.
async function streamTo({ label, host, port, imei, records, codec }) {
  const dev = new BufferedDevice({ host, port, imei, codec, perPacket: 1 });
  const ok = await dev.connect();
  if (!ok) {
    throw new Error(
      `${label}: handshake failed at ${host}:${port}. Is it listening, and is ` +
        `${imei} registered there? An unregistered IMEI gets 0x00, by design.`,
    );
  }
  const acked = await dev.send(records);
  dev.close();
  return { sent: records.length, acked };
}

// ── Reading Traccar back ─────────────────────────────────────────────────────
// Traccar's REST API is session-cookie based: POST /api/session with form-encoded
// credentials, then reuse the JSESSIONID cookie. Basic auth also works on many
// builds, but the session route is the documented one and behaves consistently.
async function traccarSession({ api, user, pass }) {
  const res = await get(
    `${api}/api/session`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: user, password: pass }).toString(),
    },
    'Is Traccar running, and is that its WEB port (default 8082, not 5027)?',
  );
  if (!res.ok) {
    throw new Error(
      `Traccar login failed (${res.status}) at ${api}. Check --traccar-user / ` +
        `--traccar-pass and that the web port is right (default 8082, not 5027).`,
    );
  }
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { cookie };
}

async function traccarJson({ api, cookie, path }) {
  const res = await get(
    `${api}${path}`,
    { headers: { cookie, accept: 'application/json' } },
    'The login worked, so this is unexpected — is Traccar still up?',
  );
  if (!res.ok) throw new Error(`Traccar GET ${path} -> ${res.status}`);
  return res.json();
}

async function readTraccar({ api, user, pass, imei }) {
  const { cookie } = await traccarSession({ api, user, pass });
  const devices = await traccarJson({ api, cookie, path: '/api/devices' });
  const dev = devices.find((d) => String(d.uniqueId) === String(imei));
  if (!dev) {
    throw new Error(
      `Traccar has no device with Identifier ${imei}. Add it under ` +
        `Settings → Devices → Add before comparing — otherwise it dropped our ` +
        `packets on the floor and there is nothing to read.`,
    );
  }
  // /api/positions with no from/to returns the LATEST position per device id,
  // which is what we want: the last record of the scenario we just streamed.
  const positions = await traccarJson({
    api,
    cookie,
    path: `/api/positions?deviceId=${encodeURIComponent(dev.id)}`,
  });
  return { device: dev, positions };
}

// Node's fetch throws a bare "fetch failed" with the cause buried, which tells a
// reader nothing about which of the four endpoints this tool talks to was down.
// Every HTTP call goes through here so the message names the URL.
async function get(url, init, hint) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`could not reach ${url} (${err.cause?.code ?? err.message}). ${hint}`);
  }
}

// ── Reading our side back ────────────────────────────────────────────────────
async function readOurs({ api, tenant, imei }) {
  if (!tenant) {
    throw new Error(
      'Reading our side needs --tenant <uuid>: every read of ours is ' +
        'tenant-scoped (no tenant => 400). Traccar has no equivalent — that ' +
        'difference is itself worth noticing.',
    );
  }
  const headers = { 'x-tenant-id': tenant, accept: 'application/json' };
  const dRes = await get(
    `${api}/devices`,
    { headers },
    "Start it with 'npm run start:api' (it binds 8080 by default), or pass --ours-api.",
  );
  if (!dRes.ok) {
    throw new Error(
      `our /devices -> ${dRes.status}. Is 'npm run start:api' running on ${api}, ` +
        `and is ${tenant} a real tenant id?`,
    );
  }
  const { devices = [] } = await dRes.json();
  const dev = devices.find((d) => String(d.imei) === String(imei));
  if (!dev) {
    throw new Error(
      `${imei} is not visible to tenant ${tenant} on our side. Either it is not ` +
        `registered, or it belongs to a different tenant (invariant 7 — that is ` +
        `the isolation working, not a bug).`,
    );
  }
  const pRes = await get(
    `${api}/positions?device=${encodeURIComponent(dev.id)}&limit=100`,
    { headers },
    'The /devices call worked, so this is unexpected — is the API still up?',
  );
  if (!pRes.ok) throw new Error(`our /positions -> ${pRes.status}`);
  const { positions = [] } = await pRes.json();
  if (positions.length === 0) {
    // The single most likely cause, and one that looks exactly like data loss if
    // nobody names it: ingest and API were started as two processes, so in
    // memory mode they hold two different stores.
    console.error(
      `\nnote: our API returned 0 positions for a device that just ACKed.\n` +
        `      In memory mode 'start:ingest' and 'start:api' are SEPARATE\n` +
        `      processes with SEPARATE stores — the API cannot see what ingest\n` +
        `      wrote. Nothing was lost. Use 'npm run dashboard' (one process,\n` +
        `      both servers, one store) or run against Postgres (DB=pg).\n`,
    );
  }
  return { device: dev, positions };
}

// ── Normalising the two shapes onto one vocabulary ───────────────────────────
// Neither side is the reference. Both are mapped onto a neutral set of field
// names so the comparison is about VALUES, not about whose JSON keys we prefer.
function normaliseTraccar(p) {
  if (!p) return null;
  const attrs = p.attributes ?? {};
  const attr = (...keys) => {
    for (const k of keys) if (attrs[k] !== undefined) return attrs[k];
    return undefined;
  };
  return {
    tsMs: p.deviceTime ? Date.parse(p.deviceTime) : null,
    lat: p.latitude ?? null,
    lon: p.longitude ?? null,
    speedKph: p.speed == null ? null : p.speed * 1.852, // Traccar reports knots
    valid: p.valid ?? null,
    // Traccar's Teltonika driver names these two, so they arrive as real fields.
    ignition: attr('ignition') ?? null,
    movement: attr('motion') ?? null,
    // These it does not name. If present at all they are raw ioNNN entries.
    engineWorktime: attr(`io${IO.ENGINE_WORKTIME_MIN}`, 'engineWorktime'),
    trackerWorktime: attr(`io${IO.ENGINE_WORKTIME_COUNTED_MIN}`),
    ignitionCount: attr(`io${IO.IGNITION_ON_COUNTER_S}`),
    rawAttributeKeys: Object.keys(attrs),
  };
}

function normaliseOurs(p) {
  if (!p) return null;
  return {
    tsMs: p.tsMs ?? null,
    lat: p.lat ?? null,
    lon: p.lon ?? null,
    speedKph: p.speed ?? null,
    valid: p.positionValid ?? null,
    ignition: p.ignition ?? null,
    movement: p.movement ?? null,
    // Engine hours are NOT on /positions by design: they are billing evidence
    // and live behind /assets/:id/engine-hours with an explicit source ('ecu'
    // vs 'estimated', invariant 4). Marked as such rather than reported null,
    // because "not on this endpoint" and "absent from the data" are different
    // claims and conflating them is exactly the mistake invariant 3 guards.
    engineWorktime: '(separate endpoint)',
    trackerWorktime: '(refused as billing evidence)',
    ignitionCount: '(refused as billing evidence)',
  };
}

// ── Presentation ─────────────────────────────────────────────────────────────
const fmt = (v) => {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(5);
  return String(v);
};

// Compared with a tolerance because the two sides carry these through different
// numeric paths (Traccar converts knots to km/h in a double; we keep km/h). An
// exact-equality check would report noise as disagreement.
function sameEnough(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01;
  if (a == null && b == null) return true;
  return false;
}

const WIRE_FIELDS = [
  ['tsMs', 'timestamp (ms)'],
  ['lat', 'latitude'],
  ['lon', 'longitude'],
  ['speedKph', 'speed (km/h)'],
  ['valid', 'position valid'],
  ['ignition', `ignition (AVL ${IO.IGNITION})`],
  ['movement', `movement (AVL ${IO.MOVEMENT})`],
];

const BILLING_FIELDS = [
  ['engineWorktime', `engine worktime (AVL ${IO.ENGINE_WORKTIME_MIN}, MINUTES)`],
  ['trackerWorktime', `tracker worktime (AVL ${IO.ENGINE_WORKTIME_COUNTED_MIN})`],
  ['ignitionCount', `ignition count (AVL ${IO.IGNITION_ON_COUNTER_S})`],
];

function printTable({ t, o, haveT, haveO }) {
  // padEnd only; never truncate a value. A silently clipped number in a tool
  // whose entire job is comparing numbers would be worse than a ragged column.
  const col = (s, w) => String(s).padEnd(w);
  const W = [38, 20, 30];
  console.log('');
  line();
  console.log('SIDE BY SIDE — same bytes, two independent decoders');
  line();
  console.log(col('field', W[0]) + col('Traccar', W[1]) + col('ours', W[2]));
  line('·');

  let wireDiffs = 0;
  console.log('wire-level (Traccar has named decoders for these):');
  for (const [key, label] of WIRE_FIELDS) {
    const tv = haveT ? t?.[key] : '(skipped)';
    const ov = haveO ? o?.[key] : '(skipped)';
    const both = haveT && haveO;
    const agree = both ? sameEnough(tv, ov) : null;
    if (both && !agree) wireDiffs++;
    const mark = agree === null ? '' : agree ? '  ✓' : '  ← DIFFERS';
    console.log('  ' + col(label, W[0] - 2) + col(fmt(tv), W[1]) + col(fmt(ov), W[2]) + mark);
  }

  console.log('');
  console.log('billing-relevant (Traccar has NO named decoder for these):');
  for (const [key, label] of BILLING_FIELDS) {
    const tv = haveT ? t?.[key] : '(skipped)';
    const ov = haveO ? o?.[key] : '(skipped)';
    console.log('  ' + col(label, W[0] - 2) + col(fmt(tv), W[1]) + col(fmt(ov), W[2]));
  }
  line();
  return { wireDiffs };
}

function printVerdict({ wireDiffs, haveT, haveO, t }) {
  console.log('');
  console.log('WHAT THIS DOES AND DOES NOT TELL YOU');
  line();
  if (haveT && haveO) {
    if (wireDiffs === 0) {
      console.log('✓ Both decoders agree on every wire-level field. Our Codec 8/8E');
      console.log('  framing, CRC, timestamps, coordinates and the two named IO');
      console.log('  parameters are independently confirmed by a mature parser we');
      console.log('  did not write. That is a real result.');
    } else {
      console.log(`← ${wireDiffs} wire-level field(s) DIFFER. Traccar is the independent,`);
      console.log('  battle-tested implementation here, so start from the assumption');
      console.log('  that our decode is the wrong one and go read the bytes by hand.');
    }
  } else {
    console.log('⚠ Only one side was read, so nothing was actually compared.');
    console.log('  Re-run without --skip-* to get the comparison this tool is for.');
  }

  console.log('');
  console.log('✗ It does NOT confirm the engine-hour figure — the number an invoice');
  console.log(`  depends on. Traccar has named handlers for AVL ${[...TRACCAR_NAMED_PARAMS].join(' and ')} only.`);
  console.log(`  AVL ${IO.ENGINE_WORKTIME_MIN} (engine worktime, MINUTES) reaches it as an untyped`);
  console.log('  attribute with no unit and no meaning attached. It cannot tell you');
  console.log('  the value is right, that minutes are not hours, or that the reading');
  console.log('  came from the ECU rather than being counted by the tracker.');
  if (haveT && t?.rawAttributeKeys?.length) {
    console.log('');
    console.log('  Traccar attribute keys it kept for this position:');
    console.log('    ' + t.rawAttributeKeys.join(', '));
    const unnamed = t.rawAttributeKeys.filter((k) => /^io\d+$/.test(k));
    if (unnamed.length) {
      console.log('  Untyped io* passthroughs (decoded as bytes, understood as nothing):');
      console.log('    ' + unnamed.map((k) => {
        const id = Number(k.slice(2));
        return IO_NAME[id] ? `${k} = ${IO_NAME[id]}` : k;
      }).join(', '));
    }
  }
  console.log('');
  console.log('✗ Nor does it check tenancy, attribution-at-record-time, or');
  console.log('  idempotency on a resent packet. Traccar has no concept of any of');
  console.log('  those, so there is nothing to compare against. Those are proved');
  console.log('  by our own test suite, not by this exercise.');
  line();
  console.log('Exit 0 regardless of differences — see --help for why.');
}

// ── self-check ───────────────────────────────────────────────────────────────
// `compare --self-check` exercises the Traccar-side PARSING without Traccar. It
// feeds normaliseTraccar a response in Traccar's documented /api/positions shape
// and asserts the mapping — knots→km/h, deviceTime→ms, attributes.ignition, and
// the io102/io103/io449 passthroughs landing as untyped values.
//
// Be clear about what this is worth: it proves this tool reads Traccar's JSON
// correctly IF Traccar emits that shape. It does NOT prove Traccar accepts our
// bytes or decodes them to these values — only a live run against a real Traccar
// can show that, and nothing here should be mistaken for having done it.
const TRACCAR_FIXTURE = {
  id: 1,
  deviceId: 1,
  protocol: 'teltonika',
  deviceTime: '2025-03-03T05:00:00.000Z',
  fixTime: '2025-03-03T05:00:00.000Z',
  valid: true,
  latitude: 25.21511,
  longitude: 55.37092,
  altitude: 12,
  speed: 0, // knots
  course: 0,
  attributes: {
    priority: 0,
    sat: 11,
    ignition: false,
    motion: false,
    io102: 84120, // untyped passthrough — Traccar has no name for this
    io449: 37,
    distance: 0,
    totalDistance: 0,
  },
};

export function selfCheck() {
  const n = normaliseTraccar(TRACCAR_FIXTURE);
  const checks = [
    ['deviceTime → ms', n.tsMs === Date.parse('2025-03-03T05:00:00.000Z')],
    ['latitude passthrough', n.lat === 25.21511],
    ['longitude passthrough', n.lon === 55.37092],
    ['knots → km/h', n.speedKph === 0],
    ['valid flag', n.valid === true],
    ['attributes.ignition → ignition', n.ignition === false],
    ['attributes.motion → movement', n.movement === false],
    [`io${IO.ENGINE_WORKTIME_MIN} read as untyped value`, n.engineWorktime === 84120],
    [`io${IO.IGNITION_ON_COUNTER_S} read as untyped value`, n.ignitionCount === 37],
    [
      `io${IO.ENGINE_WORKTIME_COUNTED_MIN} absent stays absent (not 0 — invariant 3)`,
      n.trackerWorktime === undefined,
    ],
  ];
  // 10 knots must not silently stay 10: a unit bug here would read as a genuine
  // wire-level disagreement and send someone hunting our decoder for no reason.
  const fast = normaliseTraccar({ ...TRACCAR_FIXTURE, speed: 10 });
  checks.push(['10 knots → 18.52 km/h', Math.abs(fast.speedKph - 18.52) < 0.001]);

  line();
  console.log('compare --self-check — Traccar-response parsing, no Traccar needed');
  line();
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  }
  line();
  if (failed) {
    console.log(`${failed} check(s) FAILED — this tool would misread Traccar's JSON.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${checks.length} parsing checks passed.`);
  }
  console.log('');
  console.log('What this did NOT do: talk to Traccar. It asserts we read Traccar\'s');
  console.log('documented response shape correctly — not that Traccar accepts our');
  console.log('bytes, nor what it decodes them to. Run a live compare for that.');
  line();
  return { failed, total: checks.length };
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function compare(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  if (args.selfCheck) return selfCheck();

  // device.conf supplies the IMEI and codec when it exists, so compare obeys the
  // same provisioning ritual as the rest of the CLI rather than inventing an
  // identity out of thin air. A missing conf is fine as long as --imei was given.
  let cfg = null;
  try {
    cfg = loadConfig(args.conf ?? 'device.conf');
  } catch {
    /* fall through to --imei */
  }
  const imei = args.imei ?? cfg?.['device.imei'];
  if (!imei) {
    console.error(
      'No IMEI. Pass --imei <15 digits>, or run `teltonika-sim init` first so\n' +
        'there is a device.conf to read it from.',
    );
    process.exitCode = 1;
    return;
  }
  const codec = cfg?.['device.codec'] ?? '8E';
  const scenarioName = args.scenario ?? cfg?.['scenario'] ?? DEFAULT_SCENARIO;

  // Scenarios are multi-device stories. Take this IMEI's own track if it has
  // one; otherwise replay another track's movement under this IMEI and say so,
  // matching what `sim stream` does — the movement is the point, the identity is
  // whichever unit we are pretending to be.
  const built = buildScenario(scenarioName);
  const track = built.tracks.find((t) => t.imei === imei) || built.tracks[0];
  if (track.imei !== imei) {
    console.error(
      `note: scenario \`${scenarioName}\` has no track for ${imei}; replaying ` +
        `${track.imei}'s movement under this IMEI instead.\n`,
    );
  }
  const records = track.records;

  const traccar = {
    host: args.traccarHost ?? '127.0.0.1',
    port: args.traccarPort ?? 5027,
    api: args.traccarApi ?? 'http://127.0.0.1:8082',
    user: args.traccarUser ?? 'admin',
    pass: args.traccarPass ?? 'admin',
  };
  const ours = {
    host: args.oursHost ?? '127.0.0.1',
    port: args.oursPort ?? 5127,
    api: args.oursApi ?? 'http://127.0.0.1:8080',
  };

  line();
  console.log('teltonika-sim compare');
  line();
  console.log(`  IMEI      : ${imei}`);
  console.log(`  Scenario  : ${scenarioName}  (${records.length} record(s), codec ${codec})`);
  console.log(`  Traccar   : tcp ${traccar.host}:${traccar.port}   api ${traccar.api}`);
  console.log(`  Ours      : tcp ${ours.host}:${ours.port}   api ${ours.api}`);
  line();

  const haveT = !args.skipTraccar;
  const haveO = !args.skipOurs;

  if (haveT) {
    const r = await streamTo({ label: 'Traccar', ...traccar, imei, records, codec });
    console.log(`Traccar : streamed ${r.sent}, ACKed ${r.acked}`);
  }
  if (haveO) {
    const r = await streamTo({ label: 'ours', ...ours, imei, records, codec });
    console.log(`Ours    : streamed ${r.sent}, ACKed ${r.acked}`);
  }

  // Both receivers write asynchronously after ACK. A short settle keeps this
  // from reading before the last record has landed and reporting a false diff.
  await new Promise((r) => setTimeout(r, 750));

  let tNorm = null;
  let oNorm = null;
  if (haveT) {
    const { positions } = await readTraccar({ ...traccar, imei });
    tNorm = normaliseTraccar(positions.at(-1));
    console.log(`Traccar : read back ${positions.length} position(s)`);
  }
  if (haveO) {
    const { positions } = await readOurs({ api: ours.api, tenant: args.tenant, imei });
    oNorm = normaliseOurs(positions.at(-1));
    console.log(`Ours    : read back ${positions.length} position(s)`);
  }

  const { wireDiffs } = printTable({ t: tNorm, o: oNorm, haveT, haveO });
  printVerdict({ wireDiffs, haveT, haveO, t: tNorm });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  compare().catch((e) => {
    console.error(`\ncompare failed: ${e.message}`);
    process.exitCode = 1;
  });
}
