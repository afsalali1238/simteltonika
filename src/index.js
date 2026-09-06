// ─────────────────────────────────────────────────────────────────────────────
// teltonika-device-sim — public API.
//
// Import this package when you want to drive a simulated tracker from your own
// code (a test, a load harness, a UI). Use the CLI (`npx teltonika-sim`) when
// you want to operate one by hand.
//
// The package has ZERO dependencies and knows nothing about any particular
// backend: no database, no tenants, no assets, no billing. It is a device. It
// connects somewhere, identifies itself, sends records, and waits for an ACK.
// Everything about what the data MEANS lives on the server side, which is
// exactly the split that exists in real life.
// ─────────────────────────────────────────────────────────────────────────────

// The wire protocol — Codec 8 / 8E encode + decode, CRC-16/IBM, IMEI framing.
export {
  CODEC_8,
  CODEC_8E,
  crc16,
  encodeImei,
  MAX_IMEI_FRAME_LEN,
  isValidImei,
  readImeiFrame,
  encodeRecord,
  MAX_RECORDS_PER_PACKET,
  encodeAvlPacket,
  DEFAULT_MAX_PACKET_BYTES,
  readAvlFrame,
  encodeAck,
} from './protocol/codec.js';

// The device itself. SimDevice is the bare wire behaviour; BufferedDevice adds
// the store-and-forward buffer that makes a tracker survive losing its link.
export { SimDevice } from './device.js';
export { BufferedDevice, EVENTS } from './buffered-device.js';

// Device identity: mint valid IMEIs (TAC + serial + Luhn check digit).
export {
  FMC130_TAC,
  DEFAULT_SERIAL_BASE,
  luhnCheckDigit,
  luhnValid,
  makeImei,
  generateFleet,
} from './imei.js';

// Movement + IO scenarios: pre-built record streams that tell a story.
export {
  HANDOVER_TS_MS,
  SITE_JEBEL_ALI,
  buildIo,
  makeScenario,
  SCENARIOS,
  SCENARIO_NAMES,
  DEFAULT_SCENARIO,
  buildScenario,
  scenarioRecords,
  distanceMeters,
  PHASES,
} from './scenarios.js';

// The AVL parameter map, including which IDs Traccar has named handlers for.
export { IO, IO_NAME, RETIRED_ENGINE_HOURS_STANDIN_ID, TRACCAR_NAMED_PARAMS } from './avl-io.js';

// The Configurator-equivalent config layer.
export {
  CONFIG_SPEC,
  parseConfigText,
  resolveConfig,
  loadConfig,
  sampleConfigText,
  describeConfig,
} from './device-config.js';

// Demo device identities the built-in scenarios reference.
export { DEMO_DEVICES, demoDeviceByImei } from './demo-devices.js';
