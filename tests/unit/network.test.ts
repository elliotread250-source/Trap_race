// Integration: real server process, real WebSocket clients.
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../shared/config';
import type { ServerMsg } from '../../shared/protocol';

const PORT = 18000 + Math.floor(Math.random() * 1000);
let proc: ChildProcess;

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  open: Promise<void>;
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.on('message', d => this.msgs.push(JSON.parse(String(d))));
    this.open = new Promise(r => this.ws.on('open', () => r()));
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async waitFor<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 8000): Promise<Extract<ServerMsg, { t: T }>> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = this.msgs.find(m => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (f) return f as Extract<ServerMsg, { t: T }>;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${t}`);
  }
  close() { this.ws.close(); }
}

beforeAll(async () => {
  proc = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start');
});
afterAll(() => { proc?.kill(); });

describe('network', () => {
  it('serves a health endpoint', async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
    expect(r.ok).toBe(true);
  });

  it('rejects incompatible clients and unknown room codes with useful messages', async () => {
    const c = new Client(); await c.open;
    c.send({ t: 'hello', v: PROTOCOL_VERSION + 99, name: 'old', skin: 0 });
    expect((await c.waitFor('error')).code).toBe('version');
    c.close();
    const d = new Client(); await d.open;
    d.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'x', skin: 0 });
    d.send({ t: 'join', code: 'ZZZZZ' });
    expect((await d.waitFor('error')).code).toBe('badcode');
    d.close();
  });

  it('two independent clients create/join a room, draft exclusively, build, race and reconnect with their identity', async () => {
    const a = new Client(), b = new Client();
    await Promise.all([a.open, b.open]);
    a.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Alice', skin: 1 });
    b.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Bob', skin: 2 });
    a.send({ t: 'create', mode: 'online' });
    const wa = await a.waitFor('welcome');
    b.send({ t: 'join', code: wa.code });
    const wb = await b.waitFor('welcome');
    expect(wb.code).toBe(wa.code);
    await a.waitFor('room', m => m.room.members.length === 2);
    // the room code alone never grants another identity or host rights
    b.send({ t: 'host', a: 'start' });
    expect((await b.waitFor('error', m => m.code === 'host')).msg).toMatch(/host/);
    b.send({ t: 'ready', ready: true });
    await a.waitFor('room', m => m.room.members.some(x => x.id === wb.you && x.ready));
    a.send({ t: 'host', a: 'target', target: 99 });
    expect((await a.waitFor('error', m => m.code === 'host')).msg).toMatch(/whole number from 5 to 15/);
    a.send({ t: 'host', a: 'target', target: 6 });
    await b.waitFor('room', m => m.room.target === 6);
    a.send({ t: 'host', a: 'start' });
    const draft = await a.waitFor('draft');
    expect(draft.cards.length).toBeGreaterThanOrEqual(5);
    // both race for the same card: exactly one owner
    const card = draft.cards[0].id;
    a.send({ t: 'claim', round: 1, card });
    b.send({ t: 'claim', round: 1, card });
    const claimed = await a.waitFor('claimed', m => m.card === card);
    const loser = claimed.by === wa.you ? b : a;
    await loser.waitFor('claimFail');
    loser.send({ t: 'claim', round: 1, card: draft.cards[1].id });
    await a.waitFor('phase', m => m.phase === 'build');
    // both clients see the same world; disconnect b mid-match and reconnect with the token
    b.close();
    await a.waitFor('room', m => m.room.members.some(x => x.id === wb.you && !x.connected));
    const b2 = new Client(); await b2.open;
    b2.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Bob', skin: 2, token: wb.token });
    const back = await b2.waitFor('welcome');
    expect(back.you).toBe(wb.you); // same identity
    await b2.waitFor('world');
    await b2.waitFor('phase', m => m.phase === 'build');
    await a.waitFor('room', m => m.room.members.some(x => x.id === wb.you && x.connected));
    // nobody places: the build timer runs out, then countdown and race snapshots arrive for both
    const snapA = await a.waitFor('snap', () => true, 45000);
    const snapB = await b2.waitFor('snap', () => true, 45000);
    expect(snapA.s.players.map(p => p.id).sort()).toEqual(snapB.s.players.map(p => p.id).sort());
    await a.waitFor('phase', m => m.phase === 'race', 10000);
    // inputs move the player on the authoritative server; a client cannot claim a position
    for (let i = 0; i < 40; i++) { a.send({ t: 'in', round: 1, s: 1 + i * 2, b: [2, 2] }); await new Promise(r => setTimeout(r, 30)); }
    const later = await a.waitFor('snap', m => (m.s.players.find(p => p.id === wa.you)?.x ?? 0) > snapA.s.players.find(p => p.id === wa.you)!.x + 40, 5000);
    expect(later).toBeTruthy();
    a.close(); b2.close();
  }, 90000);
});
