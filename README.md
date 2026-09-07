# teltonika-device-sim

A Teltonika FMC-series GPS tracker simulator that speaks the **real Codec 8 /
Codec 8 Extended wire protocol over TCP** — the same framing, the same IMEI
handshake, the same CRC-16/IBM, the same 4-byte ACK, the same store-and-forward
behaviour as physical hardware.

It is not a mock. Point it at [Traccar](https://www.traccar.org/) and Traccar
cannot tell the difference, which is the whole point: everything from "bytes on
a socket" upward can be learned, tested and debugged before any hardware
arrives.

Zero dependencies. Node ≥ 20. Nothing to install.

---

## Quick start

```bash
npm test                       # 113 tests, no install needed

npx teltonika-sim init         # write a device.conf (= open Configurator)
npx teltonika-sim config       # read the profile back, with real param IDs
npx teltonika-sim provision    # the IMEI to register on your server, and how
npx teltonika-sim connect      # handshake ONLY — verify 0x01 before streaming
npx teltonika-sim stream       # send records, watch ACKs and the backlog
```

Run them **in that order** the first time. Every stage fails differently, and
knowing *which* stage failed is most of debugging a real install.

**New here? Read [`docs/TUTORIAL.md`](docs/TUTORIAL.md) instead of this file.**
It walks from decoding a packet by hand through to a side-by-side diff against
Traccar, and it is written to be worked through rather than skimmed.

---

## Try it against Traccar, with a browser panel

This is the full path from nothing installed to watching a simulated machine
move on a real, independent GPS platform's map — no hardware, no SIM card.
Everything here also works from the CLI one flag at a time (see `docs/TUTORIAL.md`
§5); this is the same thing with a Run button.

### 0. Prerequisites

- **Node.js ≥ 20** — `node --version`
- **Docker Desktop**, running — `docker --version`

Nothing else. This package has zero dependencies.

### 1. Install and prove it works

```bash
git clone https://github.com/afsalali1238/simteltonika.git
cd simteltonika
npm test
```

Expect `# pass 113`, `# fail 0`, `# skipped 0`.

### 2. Start Traccar

```bash
docker run -d --name traccar -p 8082:8082 -p 5027:5027 traccar/traccar:latest
```

First run downloads the image — wait for `docker ps` to show `traccar` with
status `Up ...` and both ports listed before continuing. Then open
`http://localhost:8082`.

**First visit only:** there's no account yet. Fill in any name/email and a
password — the first account created on a fresh install becomes admin
automatically.

- **8082** — Traccar's web UI.
- **5027** — Traccar's Teltonika listener. This is also the conventional
  Teltonika port, which is why this package's own test ingest (used by
  `compare`) defaults somewhere else — see `docs/TUTORIAL.md` §7.

### 3. Register the device

Traccar only accepts data from IMEIs it already knows. An unregistered device
completes the TCP handshake and then Traccar silently discards everything that
follows — no error, no red light, just an empty map. This step is the one
everyone forgets and then blames the simulator for.

1. In Traccar: **Settings → Devices → +**
2. **Name:** anything, e.g. `D1 Excavator X`
3. **Identifier:** `356307042441013` — must match exactly. This is the IMEI
   `npx teltonika-sim init` writes into `device.conf` by default.
4. Save.

(Registering `356307042441099` too lets you also run the `yard-idle` and
`dic-to-reem` scenarios, which use device **D2** instead of D1 — see
`npx teltonika-sim scenarios` for the full roster.)

### 4. Start the panel

```bash
npx teltonika-sim init      # writes device.conf if you don't have one yet
npx teltonika-sim panel
```

Open `http://127.0.0.1:4173`. Keep the Traccar tab open alongside it — the
panel does not draw its own map, Traccar already does that job.

### 5. Run a scenario

The **target** fields are pre-filled from `device.conf` (host `127.0.0.1`,
port `5027`, the D1 IMEI, codec `8E`) — that already points at the Traccar
you just started. Pick a scenario from the dropdown (the box underneath shows
what it proves and which device(s) it uses), choose a pace, and click **Run**.

Watch the log panel: handshake accepted, then every record sent with its
ACK. Flip to the Traccar tab (refresh if needed) — the device goes from
**Offline** to **Online**, with a moving marker and live speed/ignition state,
decoded by Traccar's own independent implementation from the exact bytes the
panel just sent.

### 6. What to actually look at

Click the device's position for details, then look for `io102` in its
attribute list. It's engine hours (AVL 102, minutes) — and it's a bare,
unlabelled number, because Traccar has no named decoder for a CAN-derived,
machine-specific parameter. That gap — the one parameter billing depends on
being the one thing the independent platform can't validate — is the actual
point of this whole exercise. `docs/TUTORIAL.md` §5 and §7 go through it, and
through the `hours` attribute Traccar derives nearby (which is **not** a
decode of `io102` — read that section before trusting it).

### Troubleshooting

| Symptom | Cause |
|---|---|
| Panel shows "no connection... is the receiver running?" | Traccar isn't up yet, or the port is wrong. Check `docker ps`. |
| Panel shows "handshake REJECTED (0x00)" | The IMEI isn't registered on Traccar, or doesn't match exactly. Redo step 3. |
| Device stays "Offline" in Traccar after a run that showed ACKs | You're looking at the wrong device row, or registered the IMEI with a typo. |
| `docker run` fails with "port is already allocated" | Something else is already using 8082 or 5027 — stop it, or map different host ports and adjust `device.conf` / the panel's target fields to match. |

---

## Commands

| Command | Real-world equivalent |
|---|---|
| `init` | Open Teltonika Configurator on a new unit |
| `config` | Read the profile back off the device |
| `provision` | Platform onboarding — the server's allow-list |
| `connect` | "Is the unit talking?" — handshake, then stop |
| `stream` | Normal operation |
| `drill <name>` | Reproduce a named real-world fault |
| `scenarios` | List the built-in movement stories |
| `compare` | Same bytes into Traccar **and** our ingest, then diff the decodes |
| `panel` | Browser scenario picker — same code as `stream`, a Run button instead of flags |

Flags override `device.conf` without editing it:

```
--config <path>  --host  --port  --imei  --codec  --scenario
--interval <ms>  --per-packet <n>  --records <n>
```

### The drills

```bash
npx teltonika-sim drill wrong-port     # wrong address/port/APN: total silence, no error
npx teltonika-sim drill unknown-imei   # connects fine, then rejected 0x00
npx teltonika-sim drill server-down    # link lost: records buffer, resend after reconnect
```

Run these against a **live** receiver. Each one ends by explaining what the
observation means, including the uncomfortable part: a wrong APN, a wrong
address and a wrong port are **indistinguishable from the server side**.

---

## `device.conf` is the Configurator stand-in

Real devices are configured through numbered parameters in Teltonika
Configurator over USB. This package's `device.conf` mirrors that, and every key
that maps to a real parameter records its real number — so the ritual
transfers to hardware.

| Param | Key | What goes wrong if it's wrong |
|---|---|---|
| **2004** | `server.host` | Total silence. No error anywhere. |
| **2005** | `server.port` | Total silence. Identical symptom. |
| **2006** | `server.protocol` | Silence again. |
| **2001–2003** | `apn.*` | Unit never reaches the internet. **Also identical.** |

`device.imei` exists here because we have to invent devices. On real hardware
it is burned in at the factory — treat it as read-only.

See [`device.conf.example`](device.conf.example).

---

## What it proves, and what it cannot

**Proves** — everything above the socket: framing, handshake accept/reject,
Codec 8 and 8E record layout, CRC, ACK-gated buffering, overflow behaviour,
recovery with original timestamps, duplicate delivery.

**Cannot prove** — that a GPS fix is accurate; that a real CAN adapter reads
the machine's hour meter correctly (a decoded engine-hour figure is **not
evidence until reconciled against the physical hour-meter**); that a real
cellular link behaves like our clean socket drops; that a real Configurator
profile is right; anything about power, mounting, antennas or SIM plans.

That second list is the useful output: it tells you exactly which questions
still need hardware, so you don't re-prove the ones that don't.

`docs/TUTORIAL.md` §0 and §8 go through this properly.

---

## Engine hours, and why Traccar can't check them

Traccar has named decoders for AVL **239** (ignition) and **240** (movement).
It has none for **102** (Engine Worktime, minutes — the billing parameter),
**103** (tracker-counted) or **449** (ignition-on counter). Those are
CAN-derived and machine-specific, so there is no universal mapping to publish.

They still arrive — as untyped `io102` / `io103` / `io449` attributes with a raw
number, no unit and no meaning.

So the independent, battle-tested platform we use to validate our wire format
has **nothing to say about the number we invoice from**. That is not a
shortcoming in Traccar; it is the honest state of the ecosystem, and it is why
`compare` exists:

```bash
npx teltonika-sim compare --self-check     # verify the tool's own parsing, no Traccar needed
npx teltonika-sim compare --help           # the full flag list + port-conflict notes
```

`compare` exits **0 even when the two sides disagree** — the engine-hour gap is
the correct, expected finding, and failing the build on a true result would
train you to ignore it.

---

## Correctness rules baked into the data

The scenarios and the buffering are not free-form; they enforce rules the
receiving pipeline depends on. The tests in `test/` are the enforcement.

- **A record leaves the buffer only once an ACK covers it.** A server that ACKs
  before its write is durable causes permanent, silent data loss — the device
  has already erased its only copy.
- **Absent is absent, never zero.** An IO element with no reading is *omitted*,
  not sent as `0`. A false zero in an engine-hours field is a false invoice.
- **Every record carries its own timestamp**, set when the event happened.
  Attribution happens at that time, never "as of now".
- **Duplicate delivery is normal**, so ingest must be idempotent or a resent
  packet double-counts.
- **A device with no CAN program yields position + ignition only** — never
  engine hours. Enforced at the source: see the last test in
  `test/scenarios.test.js`.
- **Overflow drops the oldest records**, as flash does. The present is more
  operationally useful than history.

---

## Layout

```
src/protocol/codec.js   the wire format — encode/decode, CRC, framing, ACK
src/device.js           one simulated unit: connect, handshake, send
src/buffered-device.js  store-and-forward on top of it
src/device-config.js    device.conf parsing + the Configurator param map
src/scenarios.js        the movement stories
src/phases.js           the scenario vocabulary (deterministic, seeded PRNG)
src/avl-io.js           AVL IO ids and which ones Traccar names
src/imei.js             TAC + serial + Luhn, per 3GPP TS 23.003
src/cli/sim.js          the staged CLI
src/cli/compare.js      ours vs Traccar, field by field
test/                   113 tests, written to be read
docs/TUTORIAL.md        the guided walkthrough — start here
```

---

## Tests

```bash
npm test
```

113 passing, nothing skipped. Start with `test/buffered-device.test.js` — it
runs against a real TCP server with an injectable ACK policy, so each test
asserts what number actually went back on the wire.

Two tests exist specifically to stop well-meant edits: `imei.test.js` pins
demo device **D2**'s deliberately Luhn-invalid IMEI (it exists to exercise the
rejection path — do not "fix" the check digit), and it pins
`makeImei(244101) === '356307042441013'` because that IMEI is written down in
seed data, docs and the tutorial.
