#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// teltonika-sim — the CLI.
//
// The commands are deliberately SEPARATE stages rather than one "run" button,
// because that is how a real install goes and each stage fails in its own way:
//
//   init        write a device.conf                (= open Teltonika Configurator)
//   config      show the resolved profile          (= read the profile back)
//   provision   print the IMEI to register         (= platform onboarding)
//   connect     handshake ONLY, then stop          (= "is the unit talking?")
//   stream      send records, show ACKs            (= normal operation)
//   drill       reproduce a named real-world fault
//   scenarios   list the built-in movement stories
//   compare     same bytes into Traccar and into our ingest, then diff the decodes
//
// Run them in that order the first time. `connect` before `stream` is the habit
// worth building: if the handshake fails, nothing about the record format
// matters yet, and people waste hours debugging the wrong layer.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadConfig,
  sampleConfigText,
  describeConfig,
  CONFIG_SPEC,
} from '../device-config.js';
import { BufferedDevice } from '../buffered-device.js';
import { SimDevice } from '../device.js';
import { buildScenario, SCENARIOS, SCENARIO_NAMES, scenarioRecords } from '../scenarios.js';
import { DEMO_DEVICES } from '../demo-devices.js';
import { luhnValid } from '../imei.js';
import { IO_NAME, TRACCAR_NAMED_PARAMS } from '../avl-io.js';

const DEFAULT_CONF = 'device.conf';

// ── tiny arg parser (no dependency) ──────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

/** CLI flags that override a config key, so you don't edit the file to retarget. */
const FLAG_TO_KEY = {
  host: 'server.host',
  port: 'server.port',
  imei: 'device.imei',
  codec: 'device.codec',
  scenario: 'scenario',
  interval: 'records.sendPeriodMs',
  'per-packet': 'records.perPacket',
};

function overridesFrom(args) {
  const o = {};
  for (const [flag, key] of Object.entries(FLAG_TO_KEY)) {
    if (args[flag] !== undefined) o[key] = String(args[flag]);
  }
  return o;
}

function loadOrDie(args) {
  const path = resolve(args.config || DEFAULT_CONF);
  try {
    const cfg = loadConfig(path, { overrides: overridesFrom(args) });
    cfg._path = path;
    for (const w of cfg._warnings) console.error(`warning: ${w}\n`);
    return cfg;
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── init ─────────────────────────────────────────────────────────────────────
function cmdInit(args) {
  const path = resolve(args.config || DEFAULT_CONF);
  if (existsSync(path) && !args.force) {
    console.error(`${path} already exists. Pass --force to overwrite.`);
    process.exit(2);
  }
  const imei = args.imei || DEMO_DEVICES[0].imei;
  writeFileSync(path, sampleConfigText({ imei }), 'utf8');
  console.log(`wrote ${path}

That file is the equivalent of a Teltonika Configurator profile. Open it and set
server.host / server.port to your receiver. Then:

    npx teltonika-sim config       # read the profile back
    npx teltonika-sim provision    # what to register on the server
    npx teltonika-sim connect      # handshake only
    npx teltonika-sim stream       # send records
`);
}

// ── config ───────────────────────────────────────────────────────────────────
function cmdConfig(args) {
  const cfg = loadOrDie(args);
  console.log(`\ndevice profile — ${cfg._path}\n`);
  console.log(describeConfig(cfg));
  console.log(`
PARAM is the real Teltonika Configurator parameter ID. Setting 2004/2005/2006 on
a physical unit is the same act as editing this file.
`);
}

// ── provision ────────────────────────────────────────────────────────────────
function cmdProvision(args) {
  const cfg = loadOrDie(args);
  const imei = cfg['device.imei'];
  console.log(`
──────────────────────────────────────────────────────────────────────
STAGE: platform onboarding (server side, not device side)
──────────────────────────────────────────────────────────────────────

  IMEI            ${imei}
  Luhn check      ${luhnValid(imei) ? 'valid' : 'INVALID (accepted anyway — format-only gate)'}
  Target          ${cfg['server.host']}:${cfg['server.port']} over ${cfg['server.protocol']}

A GPS server will not accept data from an IMEI it has never heard of. It closes
the connection, or in Teltonika's protocol replies 0x00 to the handshake. So the
IMEI must be registered FIRST. Nothing below is device configuration — it is the
server's allow-list.

  Traccar:  Settings → Devices → +
              Name:       anything, e.g. sim-${imei.slice(-4)}
              Identifier: ${imei}          <- must match EXACTLY
            No protocol picker: Traccar identifies Teltonika by the port (5027).

  This project's own ingest:  the IMEI must exist in the device registry.
            Memory mode seeds ${DEMO_DEVICES.map((d) => d.imei).join(' and ')}.
            For a generated fleet see src/simulator/provision.js in the parent repo.

Then check the handshake before you send anything:

    npx teltonika-sim connect
`);
}

// ── connect ──────────────────────────────────────────────────────────────────
async function cmdConnect(args) {
  const cfg = loadOrDie(args);
  const host = cfg['server.host'];
  const port = cfg['server.port'];
  const imei = cfg['device.imei'];

  console.log(`\nconnecting to ${host}:${port} as ${imei} (TCP) ...\n`);
  const t0 = Date.now();
  const dev = new BufferedDevice({
    host,
    port,
    imei,
    codec: cfg['device.codec'],
    onEvent: (e) => {
      if (e.type === 'handshake-accepted') {
        console.log(`  → sent 2-byte length + 15 ASCII digits`);
        console.log(`  ← 0x01  ACCEPTED  (${Date.now() - t0} ms)`);
      }
    },
  });
  const ok = await dev.connect();
  if (!ok) {
    const s = dev.stats;
    if (s.handshakeRejects) {
      console.log(`  → sent 2-byte length + 15 ASCII digits`);
      console.log(`  ← 0x00  REJECTED

The server is running and understood the frame. It does not know this IMEI.
Register ${imei} on the server, then try again:

    npx teltonika-sim provision
`);
    } else {
      console.log(`  ✗ no TCP connection to ${host}:${port}

Nothing is listening there, or a firewall dropped it. This is the same symptom a
real unit shows with a wrong param 2004/2005 or a bad APN: total silence, no
error anywhere. Check the receiver is up and the port matches.
`);
    }
    dev.close();
    process.exit(1);
  }
  console.log(`
Handshake complete. The socket stays open on a real unit and records follow.

    npx teltonika-sim stream
`);
  dev.close();
}

// ── stream ───────────────────────────────────────────────────────────────────
async function cmdStream(args) {
  const cfg = loadOrDie(args);
  const host = cfg['server.host'];
  const port = cfg['server.port'];
  const imei = cfg['device.imei'];
  const name = cfg['scenario'];
  const limit = args.records ? Number(args.records) : 0;

  if (!SCENARIO_NAMES.includes(name)) {
    console.error(`unknown scenario \`${name}\`. Known: ${SCENARIO_NAMES.join(', ')}`);
    process.exit(2);
  }

  // Take this device's track from the scenario, or the first track if the
  // scenario doesn't feature this IMEI (a generated fleet member, say).
  const built = buildScenario(name);
  const track = built.tracks.find((t) => t.imei === imei) || built.tracks[0];
  let records = track.records.slice();
  if (track.imei !== imei) {
    console.error(
      `note: scenario \`${name}\` has no track for ${imei}; replaying ${track.imei}'s ` +
        `movement under this IMEI instead.\n`,
    );
  }
  if (limit > 0) records = records.slice(0, limit);

  console.log(`
──────────────────────────────────────────────────────────────────────
STAGE: normal operation
  device    ${imei}  codec ${cfg['device.codec']}
  target    ${host}:${port}
  scenario  ${name}  (${records.length} records, ${cfg['records.perPacket']}/packet)
  period    ${cfg['records.sendPeriodMs']} ms   buffering ${cfg['buffer.enabled'] ? 'on' : 'OFF'}
──────────────────────────────────────────────────────────────────────
`);

  const dev = new BufferedDevice({
    host,
    port,
    imei,
    codec: cfg['device.codec'],
    bufferEnabled: cfg['buffer.enabled'],
    maxRecords: cfg['buffer.maxRecords'],
    perPacket: cfg['records.perPacket'],
    onEvent: (e) => {
      if (e.type === 'acked') console.log(`  ← ACK ${e.ack ?? e.count}   backlog ${e.buffered}`);
      else if (e.type === 'ack-mismatch')
        console.log(`  ← ACK ${e.ack} for ${e.sent} sent — MISMATCH, ${e.kept} kept for resend`);
      else if (e.type === 'link-down') console.log(`  ✗ link down, ${e.buffered} records buffered`);
      else if (e.type === 'dropped-overflow')
        console.log(`  ! backlog hit ${e.cap}, dropped ${e.count} oldest`);
    },
  });

  if (!(await dev.connect())) {
    console.error(
      dev.stats.handshakeRejects
        ? `handshake REJECTED (0x00). Register ${imei} on the server first.`
        : `no connection to ${host}:${port}. Is the receiver running?`,
    );
    process.exit(1);
  }
  console.log(`handshake accepted (0x01)\n`);

  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });

  let n = 0;
  for (const rec of records) {
    if (stop) break;
    n++;
    await dev.send([rec]);
    if (n === 1 || n % 5 === 0 || n === records.length) {
      const eh = rec.io?.find?.((x) => x.id === 102);
      const ign = rec.io?.find?.((x) => x.id === 239);
      console.log(
        `  → record ${n}/${records.length}  ${new Date(rec.timestampMs).toISOString()}  ` +
          `${rec.gps.lat.toFixed(5)},${rec.gps.lon.toFixed(5)}` +
          (ign ? `  ign=${ign.value}` : '') +
          (eh ? `  AVL102=${eh.value}min` : ''),
      );
    }
    if (cfg['records.sendPeriodMs'] > 0) await sleep(cfg['records.sendPeriodMs']);
  }

  const s = dev.stats;
  console.log(`
──────────────────────────────────────────────────────────────────────
  queued ${s.queued}   sent ${s.sent}   acked ${s.acked}   still buffered ${dev.pending}
  link drops ${s.linkDrops}   ack mismatches ${s.ackMismatches}
──────────────────────────────────────────────────────────────────────

acked == queued and backlog 0 means every record is durably stored server-side.
Anything still buffered was never acknowledged, so the device would resend it.
`);
  dev.close();
}

// ── scenarios ────────────────────────────────────────────────────────────────
function cmdScenarios() {
  console.log('\nbuilt-in scenarios:\n');
  for (const name of SCENARIO_NAMES) {
    const s = SCENARIOS[name];
    const built = buildScenario(name);
    const recs = scenarioRecords(built).length;
    console.log(`  ${name}  —  ${recs} records across ${built.tracks.length} device(s)`);
    for (const t of built.tracks) {
      console.log(`      ${t.imei}  ${String(t.records.length).padStart(3)} records  ${t.label}`);
    }
    for (const p of s.proves || []) console.log(`      proves: ${p}`);
    console.log();
  }
  console.log(`
Pick one with \`scenario = <name>\` in device.conf or --scenario on the CLI.
`);
}

// ── drill ────────────────────────────────────────────────────────────────────
const DRILLS = {
  'wrong-port': {
    blurb: 'server address/port wrong (or APN broken): total silence, no error',
    async run(cfg) {
      const badPort = cfg['server.port'] === 1 ? 2 : 1;
      console.log(`Config says port ${cfg['server.port']}. Dialling ${badPort} instead —
this is what a typo in Configurator param 2005 does.\n`);
      const dev = new BufferedDevice({
        host: cfg['server.host'],
        port: badPort,
        imei: cfg['device.imei'],
      });
      const ok = await dev.connect();
      console.log(`  connect: ${ok ? 'succeeded (unexpected)' : 'FAILED'}`);
      console.log(`
WHAT TO LEARN
  The device produced no error message a technician would ever see. On real
  hardware the LED pattern is the only clue, and the server shows nothing at all
  because no connection was ever made. A wrong APN looks IDENTICAL from the
  server side. When a real install "isn't working", this is the first suspect,
  and you cannot tell these two causes apart from the server.
`);
      dev.close();
      return !ok;
    },
  },

  'unknown-imei': {
    blurb: 'IMEI not registered on the server: connects, then rejected 0x00',
    async run(cfg) {
      const fake = '860000000000007';
      console.log(`Config IMEI is ${cfg['device.imei']}. Dialling as ${fake},
which is not in the server's device registry.\n`);
      const dev = new BufferedDevice({
        host: cfg['server.host'],
        port: cfg['server.port'],
        imei: fake,
      });
      const ok = await dev.connect();
      const rejected = dev.stats.handshakeRejects > 0;
      console.log(`  TCP connection: ${ok || rejected ? 'established' : 'failed'}`);
      console.log(`  handshake     : ${rejected ? '0x00 REJECTED' : ok ? '0x01 accepted (!)' : 'no reply'}`);
      if (!ok && !rejected) {
        console.log(`
  Could not reach ${cfg['server.host']}:${cfg['server.port']} at all, so this drill
  did not actually run. Start the receiver first.`);
        dev.close();
        return false;
      }
      console.log(`
WHAT TO LEARN
  The TCP connection SUCCEEDED. Network, port, firewall — all fine. The failure
  is one layer up: authorisation. A real unit in this state connects and
  reconnects forever, quietly, and its data goes nowhere.

  Note what a server MUST NOT do here: accept the records anyway. Data from an
  unknown device has no owner, so it cannot be billed to anyone and it cannot be
  silently attached to whoever seems likely. Rejecting is the correct behaviour.
  ${rejected ? '' : '\n  This server ACCEPTED an unregistered IMEI. That is worth reporting.'}
`);
      dev.close();
      return rejected;
    },
  },

  'server-down': {
    blurb: 'link lost mid-stream: records buffer, then resend after reconnect',
    async run(cfg) {
      const host = cfg['server.host'];
      const port = cfg['server.port'];
      const imei = cfg['device.imei'];
      const built = buildScenario(cfg['scenario']);
      const track = built.tracks.find((t) => t.imei === imei) || built.tracks[0];
      const recs = track.records.slice(0, 12);

      console.log(`Sending 4 records, then simulating a dead link for 4 records,
then reconnecting. Buffering is ${cfg['buffer.enabled'] ? 'ON' : 'OFF'}.\n`);

      const dev = new BufferedDevice({
        host,
        port,
        imei,
        codec: cfg['device.codec'],
        bufferEnabled: cfg['buffer.enabled'],
        maxRecords: cfg['buffer.maxRecords'],
        perPacket: cfg['records.perPacket'],
      });
      if (!(await dev.connect())) {
        console.log(`  could not connect to ${host}:${port} — start the receiver first.`);
        return false;
      }

      for (const r of recs.slice(0, 4)) await dev.send([r]);
      console.log(`  phase 1: sent 4, acked ${dev.stats.acked}, backlog ${dev.pending}`);

      // Kill the socket from the device side — indistinguishable, to the device,
      // from the server going away. Destroying it fires our own 'close' handler,
      // which is what flips `connected` and counts the drop, so WAIT for that
      // event rather than setting the flag by hand. Without the wait the device
      // still believes it is online for one more record, buffers it, and only
      // then discovers the link is gone — realistic, but it makes the drill's
      // numbers look arbitrary.
      const linkClosed = new Promise((r) => dev.dev.socket.once('close', r));
      dev.dev.socket.destroy();
      await linkClosed;
      console.log(`  ✗ link lost`);

      for (const r of recs.slice(4, 8)) await dev.send([r]);
      console.log(`  phase 2: 4 records produced while offline, backlog ${dev.pending}`);

      const reconnected = await dev.connect();
      console.log(`  ↻ reconnect + re-handshake: ${reconnected ? 'accepted' : 'FAILED'}`);
      const drained = await dev.flush();
      console.log(`  phase 3: drained ${drained}, backlog ${dev.pending}`);

      for (const r of recs.slice(8, 12)) await dev.send([r]);
      const s = dev.stats;
      console.log(`
  totals: queued ${s.queued}  sent ${s.sent}  acked ${s.acked}  backlog ${dev.pending}
          link drops ${s.linkDrops}  dropped (buffering off) ${s.droppedNoBuffer}

WHAT TO LEARN
  ${
    cfg['buffer.enabled']
      ? `The 4 offline records were NOT lost. They arrived after the reconnect with
  their ORIGINAL timestamps — that is why a tracker offline for a day still
  yields a correct utilisation figure, and why the server must key on
  (device, timestamp) rather than arrival order.

  It also means duplicate delivery is NORMAL: the device resends anything it
  did not see an ACK for. Ingest must be idempotent or a resent packet
  double-counts. Try \`buffer.enabled = false\` and watch data vanish instead.`
      : `Buffering is OFF, so ${s.droppedNoBuffer} records were destroyed. Real hardware does
  not behave this way; this mode exists to show you what the buffer is for.`
  }
`);
      dev.close();
      return true;
    },
  },
};

async function cmdDrill(args) {
  const name = args._[1];
  if (!name || !DRILLS[name]) {
    console.log(`\nusage: npx teltonika-sim drill <name>\n`);
    for (const [k, d] of Object.entries(DRILLS)) console.log(`  ${k.padEnd(14)} ${d.blurb}`);
    console.log(`
Each drill reproduces a fault that happens on real installs, and tells you what
the observation means. Run them against a LIVE receiver — the point is to see
how the failure looks from both ends.
`);
    process.exit(name ? 2 : 0);
  }
  const cfg = loadOrDie(args);
  console.log(`
──────────────────────────────────────────────────────────────────────
DRILL: ${name} — ${DRILLS[name].blurb}
──────────────────────────────────────────────────────────────────────
`);
  const ok = await DRILLS[name].run(cfg);
  process.exit(ok ? 0 : 1);
}

// ── help ─────────────────────────────────────────────────────────────────────
function cmdHelp() {
  console.log(`
teltonika-sim — a Teltonika FMC-series device simulator that speaks the real
Codec 8 / 8E wire protocol over TCP.

  npx teltonika-sim init         write a starter device.conf
  npx teltonika-sim config       show the resolved profile + Configurator params
  npx teltonika-sim provision    the IMEI to register on your server, and how
  npx teltonika-sim connect      IMEI handshake only — verify 0x01 before streaming
  npx teltonika-sim stream       send records, print ACKs and the backlog
  npx teltonika-sim drill <name> reproduce a real-world fault
  npx teltonika-sim scenarios    list the built-in movement stories
  npx teltonika-sim compare      send the same bytes to Traccar AND our ingest,
                                 then diff what each one decoded

Flags override device.conf without editing it:
  --config <path>  --host  --port  --imei  --codec  --scenario
  --interval <ms>  --per-packet <n>  --records <n>

Run them in order the first time. Every stage fails differently, and knowing
WHICH stage failed is most of debugging a real install.
`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || (args.help ? 'help' : 'help');

const COMMANDS = {
  init: cmdInit,
  config: cmdConfig,
  provision: cmdProvision,
  connect: cmdConnect,
  stream: cmdStream,
  scenarios: cmdScenarios,
  drill: cmdDrill,
  // compare has its own flag vocabulary (two hosts, two APIs, credentials), so
  // it parses raw argv itself rather than being squeezed through FLAG_TO_KEY.
  compare: async () => {
    const { compare } = await import('./compare.js');
    return compare(process.argv.slice(3));
  },
  help: cmdHelp,
};

if (!COMMANDS[cmd]) {
  console.error(`unknown command \`${cmd}\`. Try: npx teltonika-sim help`);
  process.exit(2);
}

try {
  await COMMANDS[cmd](args);
} catch (err) {
  console.error(`\n${err.stack || err.message}\n`);
  process.exit(1);
}
