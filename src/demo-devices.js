// ─────────────────────────────────────────────────────────────────────────────
// demo-devices.js — the demo device identities the built-in scenarios reference.
//
// These are IMEIs only: no tenants, no assets, no assignments, no billing. That
// separation is deliberate. A real tracker knows exactly one thing about itself
// — its burned-in IMEI. Who is billed for it, what machine it is bolted to, and
// which CAN program that machine runs are all facts the SERVER holds, not the
// device. Keeping them out of the simulator is what makes it a device simulator
// rather than a fake backend.
//
// The IMEIs match the parent project's fixtures exactly so a packet captured
// against Traccar and a packet captured against our own ingest are comparable.
//
//   D1  356307042441013  FMC130 — has a CAN adapter, sends AVL 102 (engine hours)
//   D2  356307042441099  FMC920 — no CAN, position + ignition only
//
// D1's IMEI is the one used in Teltonika's OWN published protocol documentation
// for the IMEI-handshake example (`000f...356307042441013`). That is why TAC
// 35630704 is the default in imei.js: packets from this simulator can be
// compared byte-for-byte against the vendor's documented example.
//
// ⚠ D2's check digit is 9; Luhn wants 6, so D2 is NOT Luhn-valid. This is
// deliberate and must NOT be "fixed": it is a committed fixture in the parent
// project and real firmware accepts it, because the handshake gate is a
// format check (15 ASCII digits), not a Luhn check. It is also a useful test
// case — a device whose IMEI is technically malformed still connects.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO_DEVICES = [
  {
    imei: '356307042441013',
    model: 'FMC130',
    firmware: '03.27.06',
    hasCan: true,
  },
  {
    imei: '356307042441099',
    model: 'FMC920',
    firmware: '03.27.06',
    hasCan: false,
  },
];

/** Look up a demo device by IMEI. Returns null when unknown. */
export function demoDeviceByImei(imei, devices = DEMO_DEVICES) {
  return devices.find((d) => d.imei === imei) || null;
}
