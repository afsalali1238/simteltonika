// ─────────────────────────────────────────────────────────────────────────────
// config.test.js — the Configurator stand-in.
//
// The point of device.conf is that provisioning a simulated unit costs the same
// effort, and fails in the same ways, as provisioning a real one. So these tests
// are mostly about REFUSALS: the config layer earns its keep by being strict at
// the moment a human types something wrong, not by being permissive and failing
// silently three steps later on the wire.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_SPEC,
  parseConfigText,
  resolveConfig,
  sampleConfigText,
  describeConfig,
} from '../src/device-config.js';

const VALID = {
  'device.imei': '356307042441013',
  'server.host': '127.0.0.1',
  'server.port': '5027',
};

// ── The spec itself ──────────────────────────────────────────────────────────
test('every spec key that maps to a real Configurator param records its number', () => {
  // This is the claim the whole package makes: these are not invented settings.
  // If a param number goes missing, the teaching value goes with it.
  const withParams = Object.entries(CONFIG_SPEC).filter(([, v]) => v.param);
  assert.ok(withParams.length >= 6, `only ${withParams.length} keys carry a param id`);
  for (const [key, v] of withParams) {
    assert.equal(typeof v.param, 'number', `${key} param must be a number`);
    assert.ok(v.doc, `${key} must document itself`);
  }
});

test('the documented server params are the real Teltonika ones', () => {
  assert.equal(CONFIG_SPEC['server.host'].param, 2004);
  assert.equal(CONFIG_SPEC['server.port'].param, 2005);
  assert.equal(CONFIG_SPEC['server.protocol'].param, 2006);
  assert.equal(CONFIG_SPEC['apn.name'].param, 2001);
});

// ── Parsing ──────────────────────────────────────────────────────────────────
test('parseConfigText ignores comments and blank lines', () => {
  const { raw, errors } = parseConfigText(`
# a comment
server.host = 10.0.0.5     # trailing comment

server.port = 5027
`);
  assert.deepEqual(errors, []);
  assert.equal(raw['server.host'], '10.0.0.5');
  assert.equal(raw['server.port'], '5027');
});

test('parseConfigText reports a line with no `=` and keeps going', () => {
  const { raw, errors } = parseConfigText('server.host = 1.2.3.4\nthis is not a setting\n');
  assert.equal(raw['server.host'], '1.2.3.4', 'good lines still parse');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 2/);
});

test('the shipped sample config parses and resolves cleanly', () => {
  // If our own example file does not survive the validator, nobody's will.
  const { raw, errors } = parseConfigText(sampleConfigText());
  assert.deepEqual(errors, [], 'the sample must not produce parse errors');
  const cfg = resolveConfig(raw);
  assert.equal(cfg['server.protocol'], 'TCP');
  assert.ok(cfg['device.imei']);
});

// ── Refusals ─────────────────────────────────────────────────────────────────
test('a missing server address is refused', () => {
  assert.throws(() => resolveConfig({ 'device.imei': VALID['device.imei'] }), /server\.host/);
});

test('an IMEI that is not 15 digits is refused', () => {
  assert.throws(() => resolveConfig({ ...VALID, 'device.imei': '12345' }), /15/);
});

test('a non-numeric IMEI is refused', () => {
  assert.throws(() => resolveConfig({ ...VALID, 'device.imei': '35630704244101X' }), /digit/i);
});

test('UDP is refused with an explanation, not a silent downgrade to TCP', () => {
  // Real units do speak UDP. Quietly pretending we had is how someone concludes
  // their UDP setup works when it was never exercised.
  assert.throws(() => resolveConfig({ ...VALID, 'server.protocol': 'UDP' }), /UDP/);
});

test('an out-of-range port is refused', () => {
  assert.throws(() => resolveConfig({ ...VALID, 'server.port': '70000' }), /port/i);
  assert.throws(() => resolveConfig({ ...VALID, 'server.port': '0' }), /port/i);
});

test('an unknown config key is reported with its line number', () => {
  // A typo'd key that is silently dropped is the cruellest possible failure: the
  // setting appears to be applied and simply is not. Caught at parse time, where
  // the line number is still known, rather than at resolve time.
  const { errors } = parseConfigText('server.hostname = x\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown key/i);
  assert.match(errors[0], /server\.hostname/);
});

test('all config errors are reported at once, not one per run', () => {
  // Fixing a config one error per attempt is miserable. Collect them.
  let msg = '';
  try {
    resolveConfig({ 'device.imei': 'nope', 'server.port': '99999' });
  } catch (err) {
    msg = err.message;
  }
  assert.match(msg, /device\.imei/);
  assert.match(msg, /server\.port/);
  assert.match(msg, /server\.host/, 'the missing host should also be reported');
});

// ── Warnings (non-fatal on purpose) ──────────────────────────────────────────
test('a Luhn-invalid IMEI warns but does not refuse to start', () => {
  // Refusing would be wrong: D2 in our own demo set has a deliberately invalid
  // check digit, and a real unit with a bad IMEI still powers on and dials out.
  // The server is where that identity gets judged.
  const cfg = resolveConfig({ ...VALID, 'device.imei': '356307042441099' });
  assert.ok(cfg._warnings.some((w) => /luhn/i.test(w)), `warnings: ${cfg._warnings}`);
});

test('a Luhn-valid IMEI produces no Luhn warning', () => {
  const cfg = resolveConfig(VALID);
  assert.equal(cfg._warnings.filter((w) => /luhn/i.test(w)).length, 0);
});

// ── Defaults and description ─────────────────────────────────────────────────
test('unset keys fall back to their documented defaults', () => {
  const cfg = resolveConfig(VALID);
  assert.equal(cfg['device.codec'], CONFIG_SPEC['device.codec'].default);
  assert.equal(cfg['buffer.enabled'], true, 'buffering on by default, like real flash');
});

test('booleans and numbers are coerced from their string form', () => {
  const cfg = resolveConfig({ ...VALID, 'buffer.enabled': 'false', 'server.port': '5027' });
  assert.equal(cfg['buffer.enabled'], false);
  assert.equal(cfg['server.port'], 5027);
  assert.equal(typeof cfg['server.port'], 'number');
});

test('describeConfig names the Configurator param beside each value', () => {
  const text = describeConfig(resolveConfig(VALID));
  assert.match(text, /2004/, 'server address param');
  assert.match(text, /2005/, 'server port param');
  assert.match(text, /356307042441013/);
});
