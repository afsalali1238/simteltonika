# Learning Teltonika by pretending to be one

A hands-on tutorial. By the end you will have decoded a Teltonika packet by
hand, provisioned a device, connected it to Traccar — real GPS platform
software we did not write — watched it stream, broken it three ways on
purpose, and compared Traccar's decode against ours field by field.

You need **Node ≥ 20** and, for part 5 onward, **Docker**. No hardware, no SIM
card, no GPS antenna.

Budget about two hours if you actually stop and read the output. Rushing it
gets you a green checkmark and no understanding, which is worse than not
doing it, because now you think you know.

---

## 0. Read this first: what a simulator cannot prove

This is not a disclaimer to skim. It is the boundary of everything you are
about to learn, and knowing where it sits is the difference between confidence
and false confidence.

**What the simulator genuinely proves.** Everything from "bytes on a TCP
socket" upward. The framing, the IMEI handshake, the Codec 8/8E record layout,
the CRC-16/IBM, the 4-byte ACK, store-and-forward behaviour, and how a
receiver reacts to all of it. These bytes are indistinguishable from a real
FMC130's bytes. A receiver cannot tell the difference, and that is not a
figure of speech — it is why part 5 works at all.

**What it cannot prove, and never will.**

- **That a GPS fix is correct.** Our coordinates come from arithmetic. A real
  unit's come from satellites, with multipath error near buildings, cold-start
  delays, and urban-canyon dropouts. We never emit a wrong-but-plausible fix
  because we have no mechanism to.
- **That the CAN adapter reads the machine correctly.** This is the big one.
  We emit AVL 102 (Engine Worktime, minutes) as a number we chose. On real
  hardware that number comes from a CAN adapter running a program specific to
  that machine's make, model and year. Whether it reads the *right* register,
  in the *right* unit, is a hardware question. Our own rule is that a decoded
  engine-hour figure is **not evidence until it has been reconciled against
  the machine's physical hour-meter**. The simulator cannot do that
  reconciliation, and no amount of testing here substitutes for it.
- **That the cellular link behaves like a cellular link.** We drop sockets
  cleanly on demand. Real GSM gives you half-open connections, 40-second
  stalls, NAT timeouts, and a device that thinks it is connected while its
  packets go nowhere.
- **That a real unit's configuration is right.** We simulate the *ritual* of
  configuration (part 3), not the firmware. A real unit has hundreds of
  parameters and a wrong one fails silently.
- **Anything about power, mounting, antenna placement, or SIM provisioning.**

Keep a running list as you go: every time this tutorial says "this is what a
real install does", ask yourself whether you are being shown the behaviour or
being *told about* it. Both are here. They are not the same.

---

## 1. Install and prove the package works

```bash
git clone <the-simulator-repo-url> teltonika-device-sim
cd teltonika-device-sim
npm test
```

You should see:

```
# tests 113
# pass 113
# fail 0
# skipped 0
```

There are **zero dependencies**, so `npm install` has nothing to do. If
`npm test` does not come back 113/113 with nothing skipped, stop — something
is wrong with your Node version or the clone, and every later step will
mislead you.

While it runs, notice what the tests are about. Open
`test/buffered-device.test.js` and read the test named *"a short ACK keeps the
uncovered records queued"*. That single test is the reason a tracker offline
for a day still bills correctly. Then read
`test/imei.test.js`'s *"D2 has a deliberately Luhn-INVALID IMEI, and that is
not a bug"*. The tests here are written to be read, not just run.

---

## 2. Decode one packet by hand

**Do not skip this.** Everything after this point is a tool doing the work for
you, and you will not be able to tell when a tool is lying to you unless you
have done it once yourself. It takes ten minutes.

Here is a real Codec 8 packet, exactly what goes on the wire:

```
000000000000002308010000019728C8D5A00120D17D400EE83920000C005A0B0000EF0101EF010000000100004765
```

That is 47 bytes. Take a pencil. Split it up:

| Bytes | Hex | Field | Meaning |
|---|---|---|---|
| 0–3 | `00000000` | Preamble | Always four zero bytes. A frame that doesn't start this way is not a frame. |
| 4–7 | `00000023` | Data field length | 0x23 = **35** bytes. Everything between here and the CRC. |
| 8 | `08` | Codec ID | Codec 8. (`8E` would be Codec 8 Extended.) |
| 9 | `01` | Number of Data 1 | One AVL record in this packet. |
| 10–17 | `0000019728C8D5A0` | Timestamp | ms since Unix epoch, **8 bytes**. = 1748735940000 = `2025-06-01T00:59:00.000Z` |
| 18 | `01` | Priority | 0 low, 1 high, 2 panic. |
| 19–22 | `20D17D40` | Longitude | signed int32, **degrees × 10⁷**. 550600000 → 55.06 |
| 23–26 | `0EE83920` | Latitude | signed int32 × 10⁷. 250100000 → 25.01 |
| 27–28 | `000C` | Altitude | 12 m |
| 29–30 | `005A` | Angle | 90° |
| 31 | `0B` | Satellites | 11 |
| 32–33 | `0000` | Speed | 0 km/h |
| 34 | `EF` | Event IO ID | 0xEF = **239** = ignition. This record was *generated because* ignition changed. |
| 35 | `01` | N total IO | one IO element in total |
| 36 | `01` | N1 (1-byte) | one 1-byte element |
| 37 | `EF` | IO id | 239 = ignition |
| 38 | `01` | value | 1 = on |
| 39 | `00` | N2 (2-byte) | none |
| 40 | `00` | N4 | none |
| 41 | `00` | N8 | none |
| 42 | `01` | Number of Data 2 | **must equal Number of Data 1** — this is the frame's own integrity check |
| 43–46 | `00004765` | CRC-16/IBM | over bytes 8–42 only (the data field), not the whole packet |

Two things here are worth more than the rest.

**The timestamp is 8 bytes of milliseconds.** Not seconds, not 4 bytes. Every
record carries its *own* time, set by the device when the event happened — not
when the server received it. That is why a device that was offline for a day
can reconnect and still produce a correct utilisation figure, and why a server
must attribute each record at its own timestamp rather than "as of now".

**The CRC covers the data field only.** Bytes 8 through 42 — 35 bytes, exactly
the length declared in bytes 4–7. Not the preamble, not the length, not
itself. Get that wrong when writing a decoder and every packet fails CRC and
you will spend an afternoon convinced the device is broken.

Check your work:

```bash
node -e "
import('./src/protocol/codec.js').then(c => {
  const buf = Buffer.from('000000000000002308010000019728C8D5A00120D17D400EE83920000C005A0B0000EF0101EF010000000100004765','hex');
  const { packet } = c.readAvlFrame(buf);
  console.log(JSON.stringify(packet.records[0], null, 2));
  console.log('crc16(data field) =', c.crc16(buf.subarray(8, 43)).toString(16));
});
"
```

Now break it deliberately. Change the last hex digit from `5` to `6` and run
it again. You get a thrown CRC error, not a silently mangled record — because
a corrupt frame in an evidence chain must be refused, not guessed at.

Now break the *length contract* instead — a subtler fault, and the more
interesting one. Here is the same record with one padding byte added inside the
data field, the declared length bumped from `0x23` to `0x24`, and the CRC
recomputed so the checksum is perfectly valid:

```bash
node -e "
import('./src/protocol/codec.js').then(c => {
  const buf = Buffer.from('000000000000002408010000019728C8D5A00120D17D400EE83920000C005A0B0000EF0101EF01000000010000002B87','hex');
  try { c.readAvlFrame(buf); } catch (e) { console.log('threw:', e.message); }
});
"
```

```
threw: trailing bytes after record count: 1 unconsumed
```

Refused, despite a valid CRC. That surprises people, so it is worth being clear
about why: the frame declared its own length, and after parsing the records and
the closing record count there is a byte left over. Either the length was wrong
or something appended data. A CRC only proves the bytes arrived as sent — it
says nothing about whether they *should* have been sent.

It matters because the raw frame is stored verbatim as the sealed artefact a
utilisation dispute gets argued from. Padding that no parser ever looked at does
not belong in evidence. So the whole frame is refused rather than the part that
happened to parse.

Now you know what the bytes are. Everything from here is convenience.

---

## 3. Provision the device — the whole ritual

Real devices are not configured by command-line flags. They are configured
through **Teltonika Configurator**, a desktop app over USB, where you set
numbered parameters. This package's stand-in for that is a `device.conf` file,
and every key that corresponds to a real parameter is annotated with its real
number. The point is that the *ritual transfers*: when hardware arrives, you
will already know what you are looking for.

```bash
npx teltonika-sim init
```

That writes `device.conf`. Open it. Then:

```bash
npx teltonika-sim config
```

You get the resolved profile with the Configurator parameter IDs beside each
value. Learn these four, because they are 90% of every field install:

| Param | Setting | What goes wrong |
|---|---|---|
| **2004** | Server address | Wrong → total silence. No error anywhere. |
| **2005** | Server port | Wrong → total silence. Identical symptom. |
| **2006** | Protocol (TCP/UDP) | Mismatch → silence again. |
| **2001** | APN name | Wrong → the unit never reaches the internet. **Also identical symptom.** |

Four different faults, one observable symptom: nothing happens. This is why
field debugging of GPS units is miserable, and why part 6's first drill exists.

Note what you *cannot* set: `device.imei`. On real hardware the IMEI is burned
in at the factory. You can change it in our file because we have to invent
devices, but treat it as read-only in your head.

Now the server side:

```bash
npx teltonika-sim provision
```

Read that output carefully. It is telling you something structural: **a GPS
server will not accept data from an IMEI it has never heard of.** The device
does not authenticate. It presents 15 digits and the server decides. There is
no password, no key, no certificate — the IMEI *is* the credential.

Which means registering the device on the server comes **first**, always,
before you try to connect. Nothing about that step is device configuration; it
is the server's allow-list.

---

## 4. Connect to our own receiver first

Before Traccar, use the receiver we control, because when it fails you can
read its source.

Terminal 1 — start our side. Use **one** command:

```bash
cd <the-main-telematics-repo>/telematics
npm run dashboard
```

That gives you ingest on **5027** and the read API on **8080**, in one process
sharing one store.

> **The trap.** `npm run start:ingest` and `npm run start:api` are *separate
> processes*. In memory mode each gets its **own** store. So the API will
> honestly report zero positions for packets the ingest server definitely
> accepted and ACKed. That is not lost data and not a bug — it is two
> processes with two in-memory stores. Use `dashboard` in memory mode, or run
> both against Postgres where the store is genuinely shared.

Terminal 2 — the staged connection. Do these **in order**:

```bash
npx teltonika-sim connect
```

Handshake only. It sends a 2-byte length plus 15 ASCII digits, waits for one
byte back, and stops. `0x01` means accepted, `0x00` means rejected.

This is the habit worth building. If the handshake fails, nothing about your
record format matters yet, and people lose hours debugging the wrong layer.
Confirm the door opens before you argue about the furniture.

```bash
npx teltonika-sim stream
```

Now records flow. Watch the ACK numbers and the backlog counter. At the end
you get a summary; `acked == queued` with backlog 0 means every record is
durably stored server-side.

The ACK is a count, not an acknowledgment of specific records. The server says
"I stored 5". The device erases its oldest 5 and keeps the rest. Which leads
directly to something you should sit with: **a server that ACKs before its
write is durable causes permanent, silent data loss** — the device has already
erased its only copy. Nothing downstream can detect it. There is no log line
for data that never existed anywhere.

Try `npx teltonika-sim scenarios` to see the other movement stories, then
re-run stream with `--scenario handover` and watch a single device produce
records on both sides of a contract boundary.

---

## 5. Now Traccar — software we did not write

This is the part that makes the whole exercise worth doing. Traccar is a
mature, widely-deployed, independent GPS platform. If it decodes our bytes, we
are speaking real Teltonika, not a protocol we invented and then wrote a
decoder for.

> **Verified 2026-09-07 against Traccar 6.6** (installed from the official
> release zip, not Docker, in a sandbox with no Docker registry access — same
> commands, different install method). Handshake, streaming, and ACKs all
> matched this section exactly. **One thing below is now out of date — see the
> callout after the "Sit with that" paragraph.**

```bash
docker run -d --name traccar \
  -p 8082:8082 \
  -p 5027:5027 \
  traccar/traccar:latest
```

- **8082** — web UI, `http://localhost:8082`, login `admin` / `admin`.
- **5027** — Traccar's Teltonika listener.

**Port conflict, on purpose.** 5027 is *the* conventional Teltonika port, so
Traccar and our own ingest both want it. You cannot run both on 5027 on one
machine. Part 7 solves this by putting ours on 5127. That collision is itself
informative: it is why a real deployment gives each protocol family its own
port and why the port, not a handshake field, is how Traccar knows which
decoder to use. There is no "protocol" byte in a Teltonika frame telling
Traccar what it is. **The port is the protocol declaration.**

**Register the device first** (same rule as part 3 — the server's allow-list):

1. `http://localhost:8082` → log in.
2. Settings → Devices → **+**
3. **Identifier** = your IMEI (`356307042441013` if you kept the default).
   It must match **exactly**. No protocol picker — the port decides that.
4. Save.

Point the simulator at it:

```bash
npx teltonika-sim connect --host 127.0.0.1 --port 5027
npx teltonika-sim stream  --host 127.0.0.1 --port 5027
```

> Prefer clicking to typing flags? `npx teltonika-sim panel` opens a browser
> page with the same target fields, a scenario dropdown, and a Run button —
> same BufferedDevice + buildScenario() code underneath, so the bytes are
> identical to what `stream` sends. It doesn't draw a map of its own; keep
> the Traccar tab open next to it. See the README's "Try it against Traccar,
> with a browser panel" section for the full click-through.

Then look at the Traccar map. You should see the device online, moving, with
speed and ignition state — decoded from the exact same bytes our own receiver
decoded a moment ago.

**Then do the thing that actually teaches you something.** In Traccar, open
the device's latest position and look at its attribute list. You will find
`ignition` and `motion` as named, typed fields. Now look for engine hours.

You will find `io102` — an untyped attribute with a raw number, no unit, no
name, no meaning, incrementing 1-per-minute exactly like our own AVL102
output. Traccar has named decoders for AVL 239 (ignition) and 240 (movement).
It does not have a *named* one for 102, 103 or 449, because those are
CAN-derived and machine-specific — there is no universal mapping to give.

Sit with that for a moment. **Traccar cannot validate the one parameter our
billing depends on.** It is not a shortcoming in Traccar; it is the honest
state of the ecosystem. The independent oracle we just used to prove our wire
format is correct has *nothing to say* about the number we invoice from. That
gap is the finding, and part 7 puts it on screen.

> **Update, verified against Traccar 6.6:** Traccar *also* now writes a
> second, typed attribute called `hours` alongside the raw `io102`. Do not
> mistake it for a decode of AVL102. Watch it across a `day-cycle` run and
> you'll see it start at `null` on the first position, then increase in
> fixed 60000ms (1-minute) steps from there — it is `(current io102 − io102
> at the first position Traccar ever saw for this device) × 60000`, i.e. a
> **relative delta seeded at first contact**, not the absolute engine-hour
> meter `io102` carries. It also does not go absent when ignition drops and
> `io102` disappears from the wire — it freezes at its last value instead of
> reporting unknown. Both behaviours are exactly the kind of thing Rule 2
> (absent is not zero) and invariant 5 (a tracker-side accumulator is not
> billing evidence) exist to catch: if `hours` were ever wired into an
> invoice, a device re-registered on a fresh Traccar instance would silently
> reset its billable hours to zero. File this as a Stage-3 finding — it's a
> real one, not a hypothetical.

---

## 6. Break it three ways

Each drill reproduces a fault that happens on real installs, then tells you
what the observation means. Run them against a **live** receiver — Traccar or
ours — because the point is seeing the failure from both ends.

```bash
npx teltonika-sim drill
```

lists them. Take them in order.

### Drill 1 — `wrong-port`

```bash
npx teltonika-sim drill wrong-port
```

The device dials a port nothing is listening on. Observe: **no error message a
technician would ever see.** On real hardware the LED pattern is the only
clue. The server shows nothing at all, because no connection was ever made.

Now recall part 3's table. A wrong APN looks **identical** from the server
side. So do a wrong address and a wrong port. You cannot tell these apart from
the server, ever. That is why a field install that "isn't working" starts with
checking config against the physical unit, not with reading server logs.

### Drill 2 — `unknown-imei`

```bash
npx teltonika-sim drill unknown-imei
```

The TCP connection **succeeds**. Network, port, firewall, APN — all fine. The
failure is one layer up: authorisation. The server replies `0x00` and closes.

A real unit in this state connects and reconnects forever, quietly, and its
data goes nowhere. There is no alarm, because from the network's point of view
nothing is broken.

Note what a server must **not** do here: accept the records anyway. Data from
an unknown device has no owner. It cannot be billed to anyone, and it must not
be silently attached to whoever seems likely. Rejecting is correct.

Try this drill against Traccar too, with an IMEI you did not register.

### Drill 3 — `server-down`

```bash
npx teltonika-sim drill server-down
```

Four records go through. The link dies. Four more records are produced while
offline. Then it reconnects, re-handshakes, and drains the backlog.

Three things to take from the output:

**The offline records were not lost.** They arrive after the reconnect with
their **original timestamps**. That is why a tracker offline for a day still
yields a correct utilisation figure — and why a server must key on
(device, timestamp) rather than on arrival order.

**Duplicate delivery is normal.** The device resends anything it did not see
an ACK for. It has no way to know whether a missing ACK means "not stored" or
"stored, ACK lost in transit", so it must assume the worse case and resend.
**Ingest must therefore be idempotent, or a resent packet double-counts.**
That is not a nice-to-have; it is a billing correctness requirement created by
this exact behaviour.

**Then run it with buffering off.** Edit `device.conf`, set
`buffer.enabled = false`, and run the drill again. Watch the records get
destroyed and counted. Real hardware does not behave this way — that mode
exists only so you can see what the buffer is for.

One more, worth doing by hand: set `buffer.maxRecords = 3` and enqueue more
than that. The **oldest** records get dropped, not the newest. That is what
flash does, because the present is more operationally useful than history. If
you had guessed it the other way round, a recovered backlog would look
plausible while being wrong about right now.

---

## 7. Compare the two decodes side by side

Same bytes, two independent decoders, printed field by field.

Traccar keeps 5027. Put ours on 5127 so they do not fight:

```bash
# terminal 1 — Traccar already running on 5027 / 8082 (part 5)

# terminal 2 — our side, one process, ingest on 5127
cd <the-main-telematics-repo>/telematics
INGEST_PORT=5127 npm run dashboard

# terminal 3
npx teltonika-sim compare \
  --imei 356307042441013 \
  --traccar-port 5027 --traccar-api http://127.0.0.1:8082 \
  --ours-port 5127     --ours-api    http://127.0.0.1:8080 \
  --tenant 11111111-1111-4111-8111-111111111111
```

Register the IMEI on **both** sides first, or that side rejects the handshake.

Before you run it live, run the self-check — it proves the tool reads
Traccar's JSON shape correctly, using a fixture, without needing Traccar:

```bash
npx teltonika-sim compare --self-check
```

It ends by telling you plainly that it did not talk to Traccar. That honesty
is deliberate: a tool that says "✓ all good" when it only tested itself is
worse than no tool.

**Reading the output.** Seven wire-level fields are compared and marked ✓ or
`← DIFFERS`. Then three billing fields are listed but **not** compared.

If all seven agree, that is a real result: two independent implementations
extracted the same values from the same bytes. If something DIFFERS, start
from the assumption that **ours** is wrong — Traccar is the battle-tested
implementation here.

Two details in the output worth understanding:

- **Traccar reports speed in knots.** The tool converts (×1.852). If you ever
  see a speed that is off by a factor of about 1.85, this is why.
- **Our side shows `(separate endpoint)` for engine hours, not `null`.** Those
  are different claims. "Not on this endpoint" and "absent from the data" mean
  opposite things, and conflating them is exactly the mistake the NULL ≠ zero
  invariant guards against.

**The exit code is always 0, even when the two sides disagree.** That is
deliberate. The engine-hour gap *is* the correct, expected outcome of this
comparison. Failing the process on a true finding would train you to read it
as a broken build, and then you would stop reading it.

The tool finishes by decoding Traccar's untyped `ioNNN` attributes for you —
`io102` → Engine Worktime (minutes), `io449` → ignition-on counter. Traccar
carried those numbers faithfully. It simply has no idea what they mean. We do,
and that knowledge lives in our code, not in any protocol.

---

## 8. What you now know, and what you don't

You have done these things:

- Decoded a Teltonika Codec 8 frame by hand, and broken its CRC and its length
  contract to see them refused.
- Provisioned a device through a Configurator-shaped ritual, with the real
  parameter numbers.
- Watched the IMEI handshake accept and reject.
- Streamed records and watched ACK-gated buffering, including recovery with
  original timestamps.
- Proved our wire format against independent third-party software.
- Reproduced the three most common field faults and learned that two of them
  are indistinguishable from the server.
- Seen, concretely, that the industry-standard platform cannot validate the
  parameter we bill from.

You still do not know:

- Whether a real CAN adapter, running a real program for a real machine, reads
  AVL 102 correctly, in minutes, from the register we think it does. **This
  requires a physical hour-meter comparison. Nothing above substitutes for
  it.**
- How the unit behaves on a real cellular link, with half-open sockets and NAT
  timeouts.
- Whether a real Configurator profile is right — we simulated the ritual, not
  the firmware.
- Anything about GPS accuracy, power, mounting, antennas, or SIM plans.

That second list is not a failure of the exercise. It is the exercise's most
useful output: you now know exactly which questions still need hardware, and
you will not waste time re-proving the ones that don't.

---

## Reference

- `npx teltonika-sim help` — all commands.
- `npx teltonika-sim scenarios` — the movement stories and what each proves.
- `npx teltonika-sim compare --help` — the full flag list and the port-conflict
  notes.
- `test/` — 113 tests, written to be read. Start with
  `buffered-device.test.js`.
