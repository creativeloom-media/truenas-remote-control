'use strict';
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const cfg = {
  host: process.env.NAS_HOST || '192.168.1.12',
  port: Number(process.env.NAS_PORT || 443),
  apiKey: process.env.NAS_API_KEY || '',
  mac: process.env.NAS_MAC || '',
  wolBroadcast: process.env.WOL_BROADCAST || '255.255.255.255',
  verifyTls: process.env.NAS_VERIFY_TLS === 'true',
  pin: process.env.APP_PIN || '',
  listen: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};

if (!cfg.pin || cfg.pin.length < 4) {
  console.error('APP_PIN must be set (min 4 chars). Refusing to start without it.');
  process.exit(1);
}

fs.mkdirSync(cfg.dataDir, { recursive: true });
const schedFile = path.join(cfg.dataDir, 'schedules.json');

/* ---------- schedules storage ---------- */
let schedules = [];
try { schedules = JSON.parse(fs.readFileSync(schedFile, 'utf8')); } catch { schedules = []; }
function saveSchedules() {
  const tmp = schedFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2));
  fs.renameSync(tmp, schedFile);
}

/* ---------- helpers ---------- */
function tcpUp(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function sendWol(mac, broadcast) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('NAS_MAC is missing or invalid');
  const macBuf = Buffer.from(hex, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => { sock.close(); reject(e); });
    sock.bind(() => {
      sock.setBroadcast(true);
      let pending = 3; // send a few times for reliability
      const fire = () => sock.send(packet, 9, broadcast, (err) => {
        if (err) { sock.close(); return reject(err); }
        if (--pending === 0) { sock.close(); resolve(); }
      });
      fire(); setTimeout(fire, 150); setTimeout(fire, 300);
    });
  });
}

/* One short-lived JSON-RPC session against the TrueNAS websocket API */
function truenasRpc(method, params = [], { fireAndForget = false, timeout = 8000 } = {}) {
  if (!cfg.apiKey) return Promise.reject(new Error('NAS_API_KEY is not set'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${cfg.host}:${cfg.port}/api/current`, {
      rejectUnauthorized: cfg.verifyTls,
      handshakeTimeout: 4000,
    });
    let step = 'login';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('TrueNAS API timed out')), timeout);
    ws.on('error', (e) => finish(e));
    ws.on('close', () => { if (step === 'call' && fireAndForget) finish(null, true); else finish(new Error('Connection closed')); });
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.login_with_api_key', params: [cfg.apiKey] }));
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id === 1) {
        if (msg.error || msg.result !== true) return finish(new Error('API key rejected by TrueNAS'));
        step = 'call';
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }));
        if (fireAndForget) setTimeout(() => finish(null, true), 1500);
      } else if (msg.id === 2) {
        msg.error ? finish(new Error(msg.error.data?.reason || msg.error.message || 'RPC error')) : finish(null, msg.result);
      }
    });
  });
}

/* ---------- status ---------- */
let lastAction = null; // { action, at }
let infoCache = { at: 0, data: null };

async function getStatus() {
  const up = await tcpUp(cfg.host, cfg.port);
  let info = null;
  if (up && cfg.apiKey) {
    if (Date.now() - infoCache.at < 10000) info = infoCache.data;
    else {
      try {
        const i = await truenasRpc('system.info', [], { timeout: 5000 });
        info = { hostname: i.hostname, version: i.version, uptimeSeconds: Math.round(i.uptime_seconds) };
        infoCache = { at: Date.now(), data: info };
      } catch (e) { info = { error: e.message }; }
    }
  }
  let state = up ? 'online' : 'offline';
  if (lastAction && Date.now() - lastAction.at < 5 * 60 * 1000) {
    if (lastAction.action === 'off' && up) state = 'shutting-down';
    if (lastAction.action === 'restart' && !up) state = 'restarting';
    if (lastAction.action === 'restart' && up && Date.now() - lastAction.at < 20000) state = 'shutting-down';
    if (lastAction.action === 'on' && !up) state = 'starting';
  }
  return { state, up, host: cfg.host, info, wolConfigured: !!cfg.mac, apiConfigured: !!cfg.apiKey };
}

/* ---------- power actions ---------- */
async function power(action, source = 'manual') {
  console.log(`[power] ${action} (${source})`);
  if (action === 'on') {
    await sendWol(cfg.mac, cfg.wolBroadcast);
  } else if (action === 'off') {
    await truenasRpc('system.shutdown', [`Remote control (${source})`], { fireAndForget: true });
  } else if (action === 'restart') {
    await truenasRpc('system.reboot', [`Remote control (${source})`], { fireAndForget: true });
  } else throw new Error('Unknown action');
  lastAction = { action, at: Date.now() };
}

/* ---------- scheduler ---------- */
let lastTick = '';
async function tick() {
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  const dateKey = now.toLocaleDateString('en-CA');
  const key = `${dateKey} ${hhmm}`;
  if (key === lastTick) return;
  lastTick = key;
  let changed = false;
  for (const s of schedules) {
    if (!s.enabled || s.time !== hhmm) continue;
    const once = !s.days || s.days.length === 0;
    if (once ? s.date !== dateKey : !s.days.includes(now.getDay())) continue;
    try {
      const st = await getStatus();
      let result = 'ok';
      if (s.action === 'on' && st.up) result = 'skipped: already on';
      else if ((s.action === 'off' || s.action === 'restart') && !st.up) result = 'skipped: already off';
      else await power(s.action, 'schedule');
      s.lastRun = new Date().toISOString();
      s.lastResult = result;
    } catch (e) {
      s.lastRun = new Date().toISOString();
      s.lastResult = 'error: ' + e.message;
      console.error('[sched] failed:', e.message);
    }
    if (once) s.enabled = false;
    changed = true;
  }
  if (changed) saveSchedules();
}

/* ---------- http ---------- */
const failures = new Map(); // ip -> {count, until}
function authOk(req) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return 'locked';
  const given = Buffer.from(String(req.headers['x-pin'] || ''));
  const want = Buffer.from(cfg.pin);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    const c = (f?.count || 0) + 1;
    failures.set(ip, { count: c, until: c >= 5 ? Date.now() + 60000 : 0 });
    return false;
  }
  failures.delete(ip);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 10000) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Bad JSON')); } });
  });
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function validSchedule(b) {
  if (!['on', 'off', 'restart'].includes(b.action)) return 'Invalid action';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) return 'Invalid time (HH:MM)';
  if (b.days && (!Array.isArray(b.days) || b.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) return 'Invalid days';
  if ((!b.days || !b.days.length) && !/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return 'One-time schedule needs a date';
  return null;
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const pub = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      const a = authOk(req);
      if (a === 'locked') return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
      if (!a) return send(res, 401, { error: 'Wrong PIN' });

      if (url.pathname === '/api/status' && req.method === 'GET') return send(res, 200, await getStatus());

      if (url.pathname === '/api/power' && req.method === 'POST') {
        const { action } = await readBody(req);
        const st = await getStatus();
        if (action === 'on' && st.up) return send(res, 409, { error: 'NAS is already on' });
        if ((action === 'off' || action === 'restart') && !st.up) return send(res, 409, { error: 'NAS is already off' });
        await power(action);
        return send(res, 200, { ok: true });
      }

      if (url.pathname === '/api/schedules' && req.method === 'GET') return send(res, 200, schedules);

      if (url.pathname === '/api/schedules' && req.method === 'POST') {
        const b = await readBody(req);
        const err = validSchedule(b);
        if (err) return send(res, 400, { error: err });
        if (schedules.length >= 50) return send(res, 400, { error: 'Too many schedules' });
        const s = { id: crypto.randomUUID(), action: b.action, time: b.time, days: b.days || [], date: b.date || null, enabled: true };
        schedules.push(s); saveSchedules();
        return send(res, 201, s);
      }

      const m = url.pathname.match(/^\/api\/schedules\/([\w-]+)$/);
      if (m) {
        const i = schedules.findIndex((s) => s.id === m[1]);
        if (i < 0) return send(res, 404, { error: 'Not found' });
        if (req.method === 'DELETE') { schedules.splice(i, 1); saveSchedules(); return send(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const b = await readBody(req);
          if (typeof b.enabled === 'boolean') schedules[i].enabled = b.enabled;
          saveSchedules();
          return send(res, 200, schedules[i]);
        }
      }
      return send(res, 404, { error: 'Not found' });
    }

    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(pub, p));
    if (!file.startsWith(pub + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(cfg.listen, () => console.log(`TrueNAS remote on :${cfg.listen} -> ${cfg.host}:${cfg.port}`));
  setInterval(() => tick().catch(console.error), 15000);
}
module.exports = { validSchedule, sendWol };
