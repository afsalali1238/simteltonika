// ─────────────────────────────────────────────────────────────────────────────
// src/cli/panel.js — a local, zero-dependency scenario launcher.
//
// Every other command in this package is a single CLI invocation because that
// mirrors how a real install goes stage by stage. This one is different on
// purpose: once you already know what `connect` and `stream` do, retyping
// `--scenario X --host Y --port Z` for the fifteenth time while showing a
// teammate around is friction with no teaching value left in it. This is that
// convenience, and nothing else — it calls the exact same BufferedDevice +
// buildScenario() code path `stream` uses, so the bytes it puts on the wire
// are identical. It does not decode anything, does not draw a map, and does
// not talk to Traccar's API — Traccar (or whatever you point it at) is
// already the map. This panel just gives you a button instead of a flag, and
// a live log of what just went out, in the browser instead of a terminal.
//
// Usage:
//   npx teltonika-sim panel               # opens on http://127.0.0.1:4173
//   npx teltonika-sim panel --port 4200
//
// ⚠ NO AUTH, LOOPBACK BY DEFAULT. Like sim-control-server in the parent repo,
// this exists to be opened on your own machine while you watch. Pass
// --host 0.0.0.0 only if you know what that means on your network.
// ────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../device-config.js';
import { BufferedDevice } from '../buffered-device.js';
import { buildScenario, SCENARIOS, SCENARIO_NAMES, scenarioRecords } from '../scenarios.js';

const DEFAULT_CONF = 'device.conf';

// Fallback profile so the panel is useful even before `npx teltonika-sim init`
// has been run — the whole point is to lower friction, not add a prerequisite.
const FALLBACK = {
  'server.host': '127.0.0.1',
  'server.port': 5027,
  'device.imei': '356307042441013',
  'device.codec': '8E',
  'records.sendPeriodMs': 1000,
  'records.perPacket': 1,
  'buffer.enabled': true,
  'buffer.maxRecords': 1000,
};

function loadDefaults(configPath) {
  const path = resolve(configPath || DEFAULT_CONF);
  if (!existsSync(path)) return { ...FALLBACK, _source: 'built-in defaults (no device.conf found)' };
  try {
    const cfg = loadConfig(path);
    return { ...cfg, _source: path };
  } catch (err) {
    return { ...FALLBACK, _source: `built-in defaults (${path} failed to parse: ${err.message})` };
  }
}

function scenarioCatalogue() {
  return SCENARIO_NAMES.map((name) => {
    const s = SCENARIOS[name];
    const built = buildScenario(name);
    return {
      name,
      records: scenarioRecords(built).length,
      proves: s.proves || [],
      tracks: built.tracks.map((t) => ({ imei: t.imei, label: t.label, records: t.records.length })),
    };
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    }
  }
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>teltonika-sim — scenario panel</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, Segoe UI, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #888; margin-bottom: 20px; font-size: 13px; }
  fieldset { border: 1px solid #8884; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  legend { padding: 0 6px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  label { display: block; font-size: 12px; color: #888; margin: 8px 0 3px; }
  input, select { width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit; border-radius: 6px; border: 1px solid #8886; background: transparent; color: inherit; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; }
  button { padding: 8px 18px; font: inherit; font-weight: 600; border-radius: 6px; border: none; cursor: pointer; }
  #run { background: #2563eb; color: white; }
  #stop { background: #6b7280; color: white; }
  #run:disabled, #stop:disabled { opacity: .4; cursor: default; }
  #proves { font-size: 12px; color: #888; margin: 8px 0 0; padding-left: 18px; }
  #log { background: #0d1117; color: #c9d1d9; font: 12px/1.5 ui-monospace, monospace; padding: 12px; border-radius: 8px; height: 320px; overflow-y: auto; white-space: pre-wrap; }
  .ok { color: #7ee787; } .warn { color: #f0883e; } .err { color: #ff7b72; } .dim { color: #8b949e; }
  .note { font-size: 12px; color: #888; margin-top: 10px; }
</style>
</head>
<body>
<h1>teltonika-sim — scenario panel</h1>
<p class="sub">Runs the same BufferedDevice + scenario code <code>stream</code> uses. This page does not draw a map — open your receiver's own UI (Traccar: <code>http://localhost:8082</code>) alongside it and watch the device move there.</p>

<fieldset>
  <legend>target</legend>
  <div class="row3">
    <div><label>host</label><input id="host"></div>
    <div><label>port</label><input id="port"></div>
    <div><label>codec</label><select id="codec"><option value="8E">8E</option><option value="8">8</option></select></div>
  </div>
  <label>IMEI (must already be registered on the target server)</label>
  <input id="imei">
</fieldset>

<fieldset>
  <legend>scenario</legend>
  <select id="scenario"></select>
  <ul id="proves"></ul>
  <div class="row">
    <div>
      <label>pace</label>
      <select id="pace">
        <option value="realtime">realtime (device.conf interval)</option>
        <option value="fast">fast (150ms/record)</option>
      </select>
    </div>
    <div>
      <label>&nbsp;</label>
      <div style="display:flex; gap:8px;">
        <button id="run">▶ run</button>
        <button id="stop" disabled>■ stop</button>
      </div>
    </div>
  </div>
</fieldset>

<div id="log"></div>
<p class="note" id="source"></p>

<script>
let es = null;

function line(cls, text) {
  const log = document.getElementById('log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function boot() {
  const defaults = await (await fetch('/defaults')).json();
  host.value = defaults['server.host'];
  port.value = defaults['server.port'];
  imei.value = defaults['device.imei'];
  codec.value = defaults['device.codec'];
  document.getElementById('source').textContent = 'defaults loaded from: ' + defaults._source;

  const scenarios = await (await fetch('/scenarios')).json();
  const sel = document.getElementById('scenario');
  for (const s of scenarios) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name + '  —  ' + s.records + ' records / ' + s.tracks.length + ' device(s)';
    opt.dataset.proves = JSON.stringify(s.proves);
    opt.dataset.tracks = JSON.stringify(s.tracks);
    sel.appendChild(opt);
  }
  updateProves();
  sel.addEventListener('change', updateProves);
}

function updateProves() {
  const sel = document.getElementById('scenario');
  const opt = sel.selectedOptions[0];
  const proves = opt ? JSON.parse(opt.dataset.proves) : [];
  const tracks = opt ? JSON.parse(opt.dataset.tracks) : [];
  const ul = document.getElementById('proves');
  ul.innerHTML = '';
  for (const t of tracks) {
    const li = document.createElement('li');
    li.textContent = t.imei + '  ' + t.records + ' records  ' + t.label;
    ul.appendChild(li);
  }
  for (const p of proves) {
    const li = document.createElement('li');
    li.textContent = 'proves: ' + p;
    ul.appendChild(li);
  }
}

document.getElementById('run').addEventListener('click', async () => {
  document.getElementById('log').innerHTML = '';
  run.disabled = true; stop.disabled = false;

  const body = {
    host: host.value.trim(),
    port: Number(port.value),
    imei: imei.value.trim(),
    codec: codec.value,
    scenario: scenario.value,
    pace: pace.value,
  };

  es = new EventSource('/events');
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === 'log') line(e.cls, e.text);
    if (e.type === 'done') { run.disabled = false; stop.disabled = true; es.close(); }
  };

  const res = await fetch('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    line('err', 'could not start: ' + err.error);
    run.disabled = false; stop.disabled = true;
    if (es) es.close();
  }
});

document.getElementById('stop').addEventListener('click', async () => {
  await fetch('/stop', { method: 'POST' });
});

boot();
</script>
</body>
</html>`;

export async function panel(argv) {
  const args = parseArgs(argv);
  const panelPort = Number(args.port || 4173);
  const panelHost = args.host || '127.0.0.1';
  const defaults = loadDefaults(args.config);

  const clients = new Set();
  let stopRequested = false;
  let running = false;

  function broadcast(type, extra) {
    const line = `data: ${JSON.stringify({ type, ...extra })}\n\n`;
    for (const res of clients) res.write(line);
  }
  const log = (cls, text) => broadcast('log', { cls, text });

  async function runScenario({ host, port, imei, codec, scenario, pace }) {
    if (running) throw new Error('a run is already in progress — stop it first');
    if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`unknown scenario \`${scenario}\``);
    running = true;
    stopRequested = false;

    try {
      const built = buildScenario(scenario);
      const track = built.tracks.find((t) => t.imei === imei) || built.tracks[0];
      const records = track.records.slice();
      if (track.imei !== imei) {
        log('warn', `note: scenario has no track for ${imei}; replaying ${track.imei}'s movement under this IMEI.`);
      }

      log('dim', `target    ${host}:${port}`);
      log('dim', `device    ${imei}  codec ${codec}`);
      log('dim', `scenario  ${scenario}  (${records.length} records)`);
      log('dim', '─'.repeat(60));

      const dev = new BufferedDevice({
        host,
        port,
        imei,
        codec,
        bufferEnabled: defaults['buffer.enabled'] ?? true,
        maxRecords: defaults['buffer.maxRecords'] ?? 1000,
        perPacket: 1,
        onEvent: (e) => {
          if (e.type === 'acked') log('ok', `← ACK ${e.ack ?? e.count}   backlog ${e.buffered}`);
          else if (e.type === 'ack-mismatch') log('warn', `← ACK ${e.ack} for ${e.sent} sent — MISMATCH`);
          else if (e.type === 'link-down') log('err', `✗ link down, ${e.buffered} records buffered`);
          else if (e.type === 'dropped-overflow') log('warn', `! backlog hit ${e.cap}, dropped ${e.count} oldest`);
        },
      });

      if (!(await dev.connect())) {
        const why = dev.stats.handshakeRejects
          ? `handshake REJECTED (0x00) — is ${imei} registered on ${host}:${port}?`
          : `no connection to ${host}:${port} — is the receiver running?`;
        log('err', why);
        return;
      }
      log('ok', 'handshake accepted (0x01)');

      const intervalMs = pace === 'fast' ? 150 : defaults['records.sendPeriodMs'] ?? 1000;
      let n = 0;
      for (const rec of records) {
        if (stopRequested) {
          log('warn', `stopped at record ${n}/${records.length}`);
          break;
        }
        n++;
        await dev.send([rec]);
        const eh = rec.io?.find?.((x) => x.id === 102);
        const ign = rec.io?.find?.((x) => x.id === 239);
        log(
          null,
          `→ ${n}/${records.length}  ${new Date(rec.timestampMs).toISOString()}  ` +
            `${rec.gps.lat.toFixed(5)},${rec.gps.lon.toFixed(5)}` +
            (ign ? `  ign=${ign.value}` : '') +
            (eh ? `  AVL102=${eh.value}min` : ''),
        );
        if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
      }

      const s = dev.stats;
      log('dim', '─'.repeat(60));
      log(
        s.acked === s.queued ? 'ok' : 'warn',
        `queued ${s.queued}  sent ${s.sent}  acked ${s.acked}  buffered ${dev.pending}`,
      );
    } catch (err) {
      log('err', err.stack || err.message);
    } finally {
      running = false;
      broadcast('done', {});
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else if (req.method === 'GET' && req.url === '/defaults') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(defaults));
      } else if (req.method === 'GET' && req.url === '/scenarios') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(scenarioCatalogue()));
      } else if (req.method === 'GET' && req.url === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else if (req.method === 'POST' && req.url === '/run') {
        const body = await readJsonBody(req);
        if (running) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'a run is already in progress' }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ started: true }));
        runScenario(body);
      } else if (req.method === 'POST' && req.url === '/stop') {
        stopRequested = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stopping: running }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolveListen) => server.listen(panelPort, panelHost, resolveListen));
  console.log(`
scenario panel running at http://${panelHost === '0.0.0.0' ? 'localhost' : panelHost}:${panelPort}

Open it in a browser, and open your receiver's own UI (e.g. Traccar at
http://localhost:8082) in another tab or window — this panel sends the
bytes, the receiver shows the result. Ctrl+C here stops the server.
`);

  process.on('SIGINT', () => {
    console.log('\nstopping...');
    server.close(() => process.exit(0));
  });
}
