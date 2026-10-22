// HTTP + WebSocket entry point. One process, in-memory rooms: rooms end when the process restarts, and the service must
// run as a single replica (no cross-instance room coordination).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { NET, PROTOCOL_VERSION, TICK_HZ, TIMERS, type Difficulty } from '../shared/config';
import { MAPS } from '../shared/maps';
import { parseClientMsg, type ServerMsg } from '../shared/protocol';
import { Room, randomCode } from './room';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? join(here, '../client'));
const STARTED = Date.now();

// test hooks: shorter phases for automated browser runs (unset in production)
for (const [env, key] of [['DRAFT_MS', 'draftMs'], ['BUILD_MS', 'buildMs'], ['RACE_MS', 'raceMs'], ['RESULTS_MS', 'resultsMs']] as const) {
  const v = Number(process.env[env]);
  if (v > 0) (TIMERS as Record<string, unknown>)[key] = v;
}

const rooms = new Map<string, Room>();
const tokens = new Map<string, { code: string; id: string }>();

interface Conn { ws: WebSocket; code: string | null; id: string | null; hello: boolean; tokens: number; lastRefill: number; alive: boolean }
const sockets = new Map<string, Conn>(); // `${code}:${memberId}` -> connection

const encoded = new WeakMap<object, string>();
function deliverFor(code: string) {
  return (memberId: string, msg: ServerMsg) => {
    const c = sockets.get(`${code}:${memberId}`);
    if (!c || c.ws.readyState !== c.ws.OPEN) return;
    let s = encoded.get(msg);
    if (!s) { s = JSON.stringify(msg); encoded.set(msg, s); }
    c.ws.send(s);
  };
}

function newRoom(mode: 'online' | 'practice'): Room {
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const r = new Room(code, mode, deliverFor(code));
  rooms.set(code, r);
  return r;
}

function bind(c: Conn, room: Room, memberId: string) {
  const key = `${room.code}:${memberId}`;
  const old = sockets.get(key);
  if (old && old !== c) { old.code = null; old.id = null; try { old.ws.close(4000, 'replaced'); } catch { /* already closed */ } }
  c.code = room.code; c.id = memberId;
  sockets.set(key, c);
}

function unbind(c: Conn) {
  if (c.code && c.id) {
    const key = `${c.code}:${c.id}`;
    if (sockets.get(key) === c) sockets.delete(key);
  }
  c.code = null; c.id = null;
}

function send(c: Conn, msg: ServerMsg) { if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg)); }

function onMessage(c: Conn, data: string) {
  // token bucket rate limit
  const now = Date.now();
  c.tokens = Math.min(NET.msgBurst, c.tokens + ((now - c.lastRefill) / 1000) * NET.msgPerSecond);
  c.lastRefill = now;
  if (c.tokens < 1) return;
  c.tokens--;
  let raw: unknown;
  try { raw = JSON.parse(data); } catch { return; }
  const msg = parseClientMsg(raw);
  if (!msg) return;
  if (msg.t === 'ping') { send(c, { t: 'pong', c: msg.c, s: now }); return; }
  if (!c.hello) {
    if (msg.t !== 'hello') return;
    if (msg.v !== PROTOCOL_VERSION) { send(c, { t: 'error', code: 'version', msg: 'Trap Race was updated. Refresh the page to get the new version.' }); return; }
    c.hello = true;
    if (msg.token) {
      const t = tokens.get(msg.token);
      const room = t ? rooms.get(t.code) : undefined;
      const m = room && t ? room.member(t.id) : undefined;
      if (room && m && !room.closed && m.token === msg.token) {
        bind(c, room, m.id);
        send(c, { t: 'welcome', you: m.id, token: m.token, code: room.code });
        room.setConnected(m.id, true);
        room.sendFullState(m.id);
        return;
      }
      send(c, { t: 'error', code: 'session', msg: 'Your previous session has ended.' });
    }
    pendingProfiles.set(c, { name: msg.name, skin: msg.skin });
    return;
  }
  const profile = pendingProfiles.get(c) ?? { name: 'Player', skin: 0 };
  if (msg.t === 'profile') pendingProfiles.set(c, { name: msg.name, skin: msg.skin });
  if (msg.t === 'create') {
    if (c.code) leave(c);
    if (msg.mode === 'practice') { send(c, { t: 'error', code: 'practice', msg: 'Solo practice runs in your browser' }); return; }
    const room = newRoom('online');
    if (msg.mapId && MAPS[msg.mapId] && msg.mapId !== 'lab') room.mapId = msg.mapId;
    const m = room.addHuman(profile.name, profile.skin);
    if ('error' in m) { send(c, { t: 'error', code: 'create', msg: m.error }); return; }
    tokens.set(m.token, { code: room.code, id: m.id });
    bind(c, room, m.id);
    if (msg.mode === 'bots') {
      const n = Math.max(1, Math.min(5, msg.bots ?? 3));
      for (let i = 0; i < n; i++) room.addBot((msg.difficulty ?? 'medium') as Difficulty);
    }
    send(c, { t: 'welcome', you: m.id, token: m.token, code: room.code });
    room.broadcastRoom();
    return;
  }
  if (msg.t === 'join') {
    const code = msg.code.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.closed) { send(c, { t: 'error', code: 'badcode', msg: `No room with code ${code}. Check the code with your host.` }); return; }
    if (room.mode === 'practice') { send(c, { t: 'error', code: 'badcode', msg: 'That room is private' }); return; }
    if (c.code === room.code) return;
    if (c.code) leave(c);
    const m = room.addHuman(profile.name, profile.skin);
    if ('error' in m) { send(c, { t: 'error', code: 'full', msg: m.error }); return; }
    tokens.set(m.token, { code: room.code, id: m.id });
    bind(c, room, m.id);
    send(c, { t: 'welcome', you: m.id, token: m.token, code: room.code });
    if (m.spectator) send(c, { t: 'notice', msg: 'A match is underway. You are spectating and will join the next match.' });
    room.broadcastRoom();
    room.sendFullState(m.id);
    return;
  }
  if (msg.t === 'leave') { leave(c); return; }
  if (!c.code || !c.id) return;
  const room = rooms.get(c.code);
  if (!room) return;
  room.handle(c.id, msg);
}

function leave(c: Conn) {
  if (!c.code || !c.id) return;
  const room = rooms.get(c.code);
  const id = c.id;
  unbind(c);
  if (room) {
    const m = room.member(id);
    room.removeMember(id);
    if (m && !room.member(id)) tokens.delete(m.token);
  }
}

const pendingProfiles = new WeakMap<Conn, { name: string; skin: number }>();

// ---------------- static files
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(STATIC_DIR, p));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403).end(); return; }
  const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('dir');
    const ext = extname(file);
    headers['Content-Type'] = TYPES[ext] ?? 'application/octet-stream';
    headers['Cache-Control'] = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(await readFile(file));
  } catch {
    // single page app: unknown paths without an extension load the game shell (deep links and refresh)
    if (!extname(p)) {
      try {
        const html = await readFile(join(STATIC_DIR, 'index.html'));
        res.writeHead(200, { ...headers, 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      } catch { /* fall through */ }
    }
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url?.startsWith('/healthz?')) {
    let players = 0;
    for (const r of rooms.values()) players += r.members.filter(m => !m.bot && m.connected).length;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, game: 'trap-race', version: PROTOCOL_VERSION, rooms: rooms.size, players, uptimeS: Math.round((Date.now() - STARTED) / 1000) }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  void serveStatic(req, res);
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: NET.maxPayloadBytes,
  verifyClient: (info: { origin: string; req: IncomingMessage }) => {
    const origin = info.origin;
    if (!origin) return true; // non-browser clients (tests)
    try {
      const o = new URL(origin);
      const host = info.req.headers.host ?? '';
      if (o.host === host) return true;
      if (/^(localhost|127\.0\.0\.1)$/.test(o.hostname)) return true;
      return allowedOrigins.includes(origin);
    } catch { return false; }
  },
});

wss.on('connection', ws => {
  const c: Conn = { ws, code: null, id: null, hello: false, tokens: NET.msgBurst, lastRefill: Date.now(), alive: true };
  ws.on('message', (data, isBinary) => { if (!isBinary) onMessage(c, data.toString()); });
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => {
    if (c.code && c.id) {
      const room = rooms.get(c.code);
      const id = c.id;
      unbind(c);
      room?.setConnected(id, false);
    }
  });
  ws.on('error', () => { /* close follows */ });
});

// heartbeat: drop dead sockets so players never appear connected after a silent failure
setInterval(() => {
  for (const ws of wss.clients) {
    const anyWs = ws as WebSocket & { _alive?: boolean };
    if (anyWs._alive === false) { ws.terminate(); continue; }
    anyWs._alive = false;
    ws.ping();
    ws.once('pong', () => { anyWs._alive = true; });
  }
}, 10000);

// ---------------- simulation loop: fixed 60 Hz steps on a drift-free accumulator
const STEP = 1000 / TICK_HZ;
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  let n = 0;
  while (acc >= STEP && n < 6) {
    for (const r of rooms.values()) r.tick();
    acc -= STEP; n++;
  }
  if (n === 6) acc = 0; // fell far behind: drop time rather than spiral
  for (const [code, r] of rooms) {
    if (!r.closed) continue;
    rooms.delete(code);
    for (const m of r.members) { if (m.token) tokens.delete(m.token); sockets.delete(`${code}:${m.id}`); }
  }
}, 5);

server.listen(PORT, HOST, () => {
  console.log(`Trap Race server on http://${HOST}:${PORT} (static: ${STATIC_DIR})`);
});

export { server, rooms };
