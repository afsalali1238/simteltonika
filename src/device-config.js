// ─────────────────────────────────────────────────────────────────────────────
// device-config.js — the simulator's stand-in for Teltonika Configurator.
//
// A real tracker out of the box does nothing. It has an IMEI burned into it and
// no idea where to send data. Someone has to sit down with Teltonika Configurator
// (or send SMS commands, or push a FOTA profile) and set, at minimum:
//
//   param 2004  the server domain/IP        ("Server Address")
//   param 2005  the server port             ("Server Port")
//   param 2006  the protocol, TCP or UDP    ("Protocol")
//   the APN     so the SIM can reach the internet at all
//
// Until those are set the unit sits dark. That is the single most common reason
// a real install "doesn't work", and a simulator that skips it teaches the wrong
// lesson. So this simulator REFUSES TO START without a config file, and the
// parameter names below are the real Configurator parameter IDs, so what you
// learn here transfers to the physical device.
//
// Format is deliberately dumb — `key = value`, `#` comments. No YAML, no JSON,
// no dependency. Teltonika's own config export is a flat key=value list too.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { isValidImei } from './protocol/codec.js';
import { luhnValid } from './imei.js';

/**
 * Every recognised key, with the real Teltonika parameter ID where one exists.
 * `required` keys have no default: a real device cannot guess them either.
 */
export const CONFIG_SPEC = {
  'server.host': {
    param: 2004,
    required: true,
    doc: 'Server address — domain or IP of the receiver (Configurator param 2004)',
  },
  'server.port': {
    param: 2005,
    required: true,
    kind: 'int',
    doc: 'Server port (Configurator param 2005). Traccar Teltonika default is 5027',
  },
  'server.protocol': {
    param: 2006,
    default: 'TCP',
    oneOf: ['TCP', 'UDP'],
    doc: 'Protocol (Configurator param 2006). This simulator implements TCP only',
  },
  'device.imei': {
    required: true,
    doc: 'The IMEI burned into this unit. On real hardware you cannot change this',
  },
  'device.codec': {
    default: '8E',
    oneOf: ['8', '8E'],
    doc: 'Codec 8 or Codec 8 Extended. Real FMC-series firmware defaults to 8E',
  },
  'apn.name': {
    param: 2001,
    default: 'internet',
    doc: 'APN name (param 2001). Not simulated — recorded so the ritual is complete',
  },
  'apn.username': { param: 2002, default: '', doc: 'APN username (param 2002)' },
  'apn.password': { param: 2003, default: '', doc: 'APN password (param 2003)' },
  'records.sendPeriodMs': {
    default: 1000,
    kind: 'int',
    doc: 'How often a record is sent. Real param is in seconds; ms here so demos are quick',
  },
  'records.perPacket': {
    default: 1,
    kind: 'int',
    doc: 'Records batched into one AVL packet. A real unit batches when it has a backlog',
  },
  'buffer.enabled': {
    default: true,
    kind: 'bool',
    doc: 'Keep unacknowledged records and resend after reconnect. Real units do this',
  },
  'buffer.maxRecords': {
    default: 1000,
    kind: 'int',
    doc: 'Backlog cap. Real FMC-series units hold tens of thousands in flash',
  },
  'scenario': {
    default: 'day-cycle',
    doc: 'Which built-in movement scenario to drive. `npx teltonika-sim scenarios` lists them',
  },
};

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** Parse `key = value` lines. Returns a plain map of raw string values. */
export function parseConfigText(text) {
  const raw = {};
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const stripped = line.replace(/#.*$/, '').trim();
    if (!stripped) return;
    const eq = stripped.indexOf('=');
    if (eq === -1) {
      errors.push(`line ${i + 1}: expected \`key = value\`, got: ${stripped}`);
      return;
    }
    const key = stripped.slice(0, eq).trim();
    const value = stripped.slice(eq + 1).trim();
    if (!(key in CONFIG_SPEC)) {
      errors.push(`line ${i + 1}: unknown key \`${key}\``);
      return;
    }
    raw[key] = value;
  });
  return { raw, errors };
}

/**
 * Validate + coerce. Throws with EVERY problem listed at once, the way a good
 * configurator does — not one error per run.
 */
export function resolveConfig(raw, { overrides = {} } = {}) {
  const merged = { ...raw, ...overrides };
  const out = {};
  const errors = [];

  for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
    let v = merged[key];

    if (v === undefined || v === '') {
      if (spec.required) {
        errors.push(`missing required key \`${key}\` — ${spec.doc}`);
        continue;
      }
      out[key] = spec.default;
      continue;
    }

    if (spec.kind === 'int') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        errors.push(`\`${key}\` must be a non-negative integer, got \`${v}\``);
        continue;
      }
      v = n;
    } else if (spec.kind === 'bool') {
      const s = String(v).toLowerCase();
      if (TRUE.has(s)) v = true;
      else if (FALSE.has(s)) v = false;
      else {
        errors.push(`\`${key}\` must be true/false, got \`${v}\``);
        continue;
      }
    }

    if (spec.oneOf) {
      const up = String(v).toUpperCase();
      if (!spec.oneOf.includes(up)) {
        errors.push(`\`${key}\` must be one of ${spec.oneOf.join('/')}, got \`${v}\``);
        continue;
      }
      v = up;
    }

    out[key] = v;
  }

  // Cross-field checks that mirror real-device constraints.
  if (out['server.port'] !== undefined && (out['server.port'] < 1 || out['server.port'] > 65535)) {
    errors.push(`\`server.port\` must be 1-65535, got \`${out['server.port']}\``);
  }
  if (out['server.protocol'] === 'UDP') {
    errors.push(
      '`server.protocol = UDP` is not implemented by this simulator. Real FMC units ' +
        'support UDP, but the ACK semantics differ and simulating that badly would ' +
        'teach the wrong thing. Use TCP.',
    );
  }
  if (out['device.imei'] !== undefined && !isValidImei(out['device.imei'])) {
    errors.push(
      `\`device.imei\` must be exactly 15 ASCII digits, got \`${out['device.imei']}\`. ` +
        'This is the same check real firmware applies to the handshake frame.',
    );
  }
  if (out['records.perPacket'] !== undefined && out['records.perPacket'] < 1) {
    errors.push('`records.perPacket` must be at least 1');
  }

  if (errors.length) {
    const e = new Error(
      `device config is not valid:\n  - ${errors.join('\n  - ')}\n\n` +
        'A real tracker with an incomplete profile does not start either.',
    );
    e.configErrors = errors;
    throw e;
  }

  // Advisory, not fatal: a malformed-but-accepted IMEI is a real situation.
  out._warnings = [];
  if (!luhnValid(out['device.imei'])) {
    out._warnings.push(
      `device.imei ${out['device.imei']} has an invalid Luhn check digit. Real ` +
        'firmware and this simulator both still accept it (the handshake gate is a ' +
        'format check, not a Luhn check) — but a genuine factory IMEI would be valid.',
    );
  }

  return out;
}

/** Read + validate a config file. Throws a clear error when it does not exist. */
export function loadConfig(path, { overrides = {} } = {}) {
  if (!existsSync(path)) {
    throw new Error(
      `no device config at ${path}\n\n` +
        'A real Teltonika unit ships with no server configured and sends nothing\n' +
        'until someone provisions it. Same here. Create one with:\n\n' +
        '    npx teltonika-sim init\n',
    );
  }
  const { raw, errors } = parseConfigText(readFileSync(path, 'utf8'));
  if (errors.length) {
    const e = new Error(`could not parse ${path}:\n  - ${errors.join('\n  - ')}`);
    e.configErrors = errors;
    throw e;
  }
  return resolveConfig(raw, { overrides });
}

/** The starter file `init` writes. Comments carry the teaching. */
export function sampleConfigText({ imei = '356307042441013' } = {}) {
  return `# device.conf — this simulator's stand-in for Teltonika Configurator.
#
# Every key marked with a param number is a REAL Teltonika Configurator
# parameter. Setting it here is the same act as setting it on the physical
# device, which is the point: the ritual transfers.

# ── Identity (burned in at the factory; you cannot change this on real hardware)
device.imei          = ${imei}
device.codec         = 8E          # 8 or 8E. Real FMC firmware defaults to 8E

# ── Where to send data. A unit with these unset sends NOTHING. (params 2004-2006)
server.host          = 127.0.0.1
server.port          = 5027        # Traccar's Teltonika port. Our own ingest: 5027
server.protocol      = TCP         # UDP exists on real units; not simulated here

# ── APN (params 2001-2003). Not simulated — recorded so the checklist is complete.
# On real hardware a wrong APN means the unit never reaches the internet at all,
# and the symptom is identical to a wrong server address: silence.
apn.name             = internet
apn.username         =
apn.password         =

# ── Sending behaviour
records.sendPeriodMs = 1000
records.perPacket    = 1           # raise this to see real batching + a bigger ACK
buffer.enabled       = true        # hold unacked records, resend after reconnect
buffer.maxRecords    = 1000

# ── Which built-in movement story to drive. \`npx teltonika-sim scenarios\` lists all.
scenario             = day-cycle
`;
}

/** Render the resolved config the way Configurator shows a profile. */
export function describeConfig(cfg) {
  const rows = Object.entries(CONFIG_SPEC).map(([key, spec]) => {
    const shown = cfg[key] === '' ? '(empty)' : String(cfg[key]);
    return { param: spec.param ? String(spec.param) : '—', key, value: shown };
  });
  const w1 = Math.max(5, ...rows.map((r) => r.param.length));
  const w2 = Math.max(...rows.map((r) => r.key.length));
  const head = `${'PARAM'.padEnd(w1)}  ${'KEY'.padEnd(w2)}  VALUE`;
  const body = rows.map((r) => `${r.param.padEnd(w1)}  ${r.key.padEnd(w2)}  ${r.value}`);
  return [head, '─'.repeat(head.length), ...body].join('\n');
}
