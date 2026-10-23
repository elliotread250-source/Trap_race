// Transports. Online play talks to the authoritative server over WebSocket; solo practice runs the same Room code in
// the browser (so it can pause) behind an identical message interface.
import { PROTOCOL_VERSION, TICK_HZ } from '../../shared/config';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import { Room } from '../../server/room';

export type ConnStatus = 'connecting' | 'online' | 'lost' | 'local' | 'closed';

/** Round-trip samples from application pings echoed by the game server over the gameplay socket (monotonic clock). */
export class RttStats {
  samples: number[] = [];
  timeouts = 0;
  region = '';
  add(ms: number) { this.samples.push(ms); if (this.samples.length > 60) this.samples.shift(); }
  private sorted() { return [...this.samples].sort((a, b) => a - b); }
  get median() { const s = this.sorted(); return s.length ? s[Math.floor(s.length / 2)] : 0; }
  get p95() { const s = this.sorted(); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; }
  /** mean absolute difference between consecutive samples */
  get jitter() { const a = this.samples; let j = 0; for (let i = 1; i < a.length; i++) j += Math.abs(a[i] - a[i - 1]); return a.length > 1 ? j / (a.length - 1) : 0; }
}

export interface Transport {
  kind: 'ws' | 'local';
  /** latest full round trip in ms (never halved, never smoothed); see stats for median, p95 and jitter */
  rtt: number;
  stats: RttStats;
  send(msg: ClientMsg): void;
  close(): void;
  onMessage: (m: ServerMsg) => void;
  onStatus: (s: ConnStatus) => void;
}

export class WsTransport implements Transport {
  kind = 'ws' as const;
  rtt = 0;
  stats = new RttStats();
  private outstanding = new Map<number, number>();
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: ConnStatus) => void = () => {};
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private queue: ClientMsg[] = [];
  private pingTimer: number | null = null;
  private hello: () => ClientMsg;
  /** artificial latency for testing (ms each way), from ?lag= */
  lag = 0;

  constructor(hello: () => ClientMsg) {
    this.hello = hello;
    const q = new URLSearchParams(location.search).get('lag');
    if (q) this.lag = Math.max(0, Math.min(500, Number(q) || 0));
    this.connect();
  }

  private url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  private connect() {
    if (this.closed) return;
    this.onStatus('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url()); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('online');
      this.rawSend(this.hello());
      const q = this.queue; this.queue = [];
      for (const m of q) this.rawSend(m);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        const c = performance.now();
        // a ping unanswered after 5 s counts as a timeout (a TCP socket hides real packet loss, so this is not a loss rate)
        for (const [k, at] of this.outstanding) if (c - at > 5000) { this.outstanding.delete(k); this.stats.timeouts++; }
        this.outstanding.set(c, c);
        this.rawSend({ t: 'ping', c });
      }, 1000);
    };
    ws.onmessage = ev => {
      let m: ServerMsg;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      const deliver = () => {
        if (m.t === 'pong' && this.outstanding.delete(m.c)) { this.rtt = performance.now() - m.c; this.stats.add(this.rtt); if (m.r) this.stats.region = m.r; }
        this.onMessage(m);
      };
      if (this.lag) setTimeout(deliver, this.lag); else deliver();
    };
    ws.onclose = () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) { this.onStatus('closed'); return; }
      this.onStatus('lost'); // never pretend to be connected
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* close follows */ };
  }

  private scheduleReconnect() {
    const delay = Math.min(8000, 500 * Math.pow(1.6, this.retry++));
    window.setTimeout(() => this.connect(), delay);
  }

  private rawSend(m: ClientMsg) {
    const go = () => { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); };
    if (this.lag) setTimeout(go, this.lag); else go();
  }

  send(m: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.rawSend(m);
    else if (m.t !== 'in' && m.t !== 'ping') this.queue.push(m); // inputs are never replayed late
  }

  close() { this.closed = true; this.ws?.close(); this.ws = null; if (this.pingTimer) clearInterval(this.pingTimer); }
}

/** Solo practice: the whole room runs locally and can pause. */
export class LocalTransport implements Transport {
  kind = 'local' as const;
  rtt = 0;
  stats = new RttStats();
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: ConnStatus) => void = () => {};
  room: Room;
  memberId: string;
  paused = false;
  private timer: number;
  private last = performance.now();
  private acc = 0;

  constructor(name: string, skin: number, mapId: string) {
    this.room = new Room('SOLO', 'practice', (_id, msg) => {
      const copy = JSON.parse(JSON.stringify(msg)) as ServerMsg; // same isolation as the network
      queueMicrotask(() => this.onMessage(copy));
    });
    this.room.mapId = mapId;
    const m = this.room.addHuman(name, skin);
    if ('error' in m) throw new Error(m.error);
    this.memberId = m.id;
    queueMicrotask(() => {
      this.onStatus('local');
      this.onMessage({ t: 'welcome', you: m.id, token: m.token, code: 'SOLO' });
      this.room.broadcastRoom();
    });
    const step = 1000 / TICK_HZ;
    this.timer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(250, now - this.last);
      this.last = now;
      if (this.paused || document.hidden) return; // practice pauses with the menu or a hidden tab
      this.acc += dt;
      while (this.acc >= step) { this.room.tick(); this.acc -= step; }
    }, 4);
  }

  send(m: ClientMsg) {
    if (m.t === 'ping') { this.onMessage({ t: 'pong', c: m.c, s: Date.now() }); return; }
    this.room.handle(this.memberId, JSON.parse(JSON.stringify(m)));
  }

  retry() { this.room.match?.practiceRetry(); }

  close() { clearInterval(this.timer); this.room.close(); }
}

export { PROTOCOL_VERSION };
