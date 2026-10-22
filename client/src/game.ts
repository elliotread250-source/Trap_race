// Client state: mirrors what the server says, predicts only the local player's movement, interpolates everyone else.
import { DT, HAZARD, PROTOCOL_VERSION, TICK_HZ } from '../../shared/config';
import { laserInOff, moverRect } from '../../shared/hazards';
import { getItem } from '../../shared/items';
import { cloneBody, newBody, stepBody, type Body } from '../../shared/physics';
import { checkPlacement, type PlaceCheck, type PlaceRequest } from '../../shared/placement';
import type { Card, ClientMsg, Phase, RoomInfo, ServerMsg } from '../../shared/protocol';
import { applyBodySnap, RaceSim, type PlayerSnap, type RaceEvent, type RaceSnapshot } from '../../shared/race';
import type { PlayerTally, RoundRow } from '../../shared/scoring';
import { World } from '../../shared/world';
import { inputBits } from './input';
import { LocalTransport, WsTransport, type ConnStatus, type Transport } from './net';
import { settings } from './store';

export interface Toast { msg: string; kind: 'info' | 'good' | 'bad'; until: number }
export interface Fx { kind: string; x: number; y: number; t0: number; color?: string; data?: number }

const STEP = 1000 / TICK_HZ;

export class GameClient {
  transport: Transport | null = null;
  status: ConnStatus = 'closed';
  you = '';
  code = '';
  room: RoomInfo | null = null;
  phase: Phase = 'lobby';
  round = 0;
  rounds = 0;
  endsAt = 0;
  competitive = false;
  tally: Record<string, PlayerTally> = {};
  world: World | null = null;
  cards: Card[] = [];
  demolition = false;
  placedThisRound = false;
  race: RaceSim | null = null;
  roundKey = '';
  snaps: { s: RaceSnapshot; at: number }[] = [];
  lastSnapAt = 0;
  pred: Body | null = null;
  predPrev: Body | null = null;
  pending: { seq: number; b: number }[] = [];
  seq = 0;
  sendBuf: { seq: number; b: number }[] = [];
  acc = 0;
  corr = { x: 0, y: 0 };
  results: { rows: RoundRow[]; competitive: boolean; last: boolean } | null = null;
  matchEnd: { order: string[]; winners: string[]; tally: Record<string, PlayerTally>; votes: string[] } | null = null;
  votes: string[] = [];
  toasts: Toast[] = [];
  fx: Fx[] = [];
  spectateIdx = 0;
  error = '';
  fatal = '';
  // build
  cursor = { x: 10, y: 10 };
  rot = 0;
  variant = 0;
  check: PlaceCheck | null = null;
  awaitingPlace = false;
  rehearsal: { sim: RaceSim; acc: number; prevJump: boolean } | null = null;
  onChange: () => void = () => {};
  onSessionEnded: () => void = () => {};
  private practiceStarted = false;
  onEvent: (e: RaceEvent | { type: string; [k: string]: unknown }) => void = () => {};
  stats = { snapsPerSec: 0, lastCorr: 0, predSteps: 0 };
  private snapCount = 0;
  private snapWindow = performance.now();

  // ------------------------------------------------ connections
  connectOnline(): Promise<void> {
    // keep any saved session token: the hello below uses it to restore our identity
    this.transport?.close();
    this.transport = null;
    this.reset();
    const t = new WsTransport(() => ({ t: 'hello', v: PROTOCOL_VERSION, name: settings.name || 'Player', skin: settings.skin, token: this.savedToken() }));
    this.attach(t);
    return new Promise(res => {
      const prev = t.onStatus;
      t.onStatus = s => { prev(s); if (s === 'online') res(); };
    });
  }

  startPractice(mapId: string) {
    this.closeTransport();
    this.clearToken();
    const t = new LocalTransport(settings.name || 'Player', settings.skin, mapId);
    this.attach(t);
  }

  private attach(t: Transport) {
    this.transport = t;
    t.onMessage = m => this.handle(m);
    t.onStatus = s => { this.status = s; this.onChange(); };
  }

  closeTransport() {
    if (this.transport && this.transport.kind === 'ws' && this.code) this.transport.send({ t: 'leave' });
    this.transport?.close();
    this.transport = null;
    this.reset();
    this.status = 'closed';
    this.clearToken();
  }

  reset() {
    this.you = ''; this.code = ''; this.room = null; this.phase = 'lobby'; this.world = null; this.race = null; this.cards = [];
    this.results = null; this.matchEnd = null; this.pred = null; this.pending = []; this.rehearsal = null; this.fx = []; this.practiceStarted = false;
  }

  send(m: ClientMsg) { this.transport?.send(m); }

  private savedToken(): string | undefined {
    try { return sessionStorage.getItem('trapRace.token') ?? undefined; } catch { return undefined; }
  }
  private saveToken(tok: string) { try { sessionStorage.setItem('trapRace.token', tok); } catch { /* ignore */ } }
  private clearToken() { try { sessionStorage.removeItem('trapRace.token'); } catch { /* ignore */ } }

  get isPractice() { return this.transport?.kind === 'local'; }
  get me() { return this.room?.members.find(m => m.id === this.you); }
  get isHost() { return !!this.me?.host; }
  member(id: string) { return this.room?.members.find(m => m.id === id); }
  get timeLeft() { return Math.max(0, this.endsAt - performance.now()); }
  get myCard() { return this.cards.find(c => c.by === this.you) ?? null; }
  get inRoster() { return !!this.race?.players.some(p => p.id === this.you) || (this.phase !== 'lobby' && !this.me?.spectator); }

  toast(msg: string, kind: Toast['kind'] = 'info', ms = 3200) {
    this.toasts.push({ msg, kind, until: performance.now() + ms });
    if (this.toasts.length > 4) this.toasts.shift();
    this.onChange();
  }

  // ------------------------------------------------ server messages
  handle(m: ServerMsg) {
    switch (m.t) {
      case 'welcome':
        this.you = m.you; this.code = m.code;
        if (this.transport?.kind === 'ws') this.saveToken(m.token);
        break;
      case 'room': {
        const prevPhase = this.room?.phase;
        this.room = m.room; this.you = m.room.youId;
        if (m.room.phase === 'lobby' && prevPhase && prevPhase !== 'lobby') this.toLobbyState();
        if (this.isPractice && m.room.phase === 'lobby' && m.room.members.length === 1 && !this.practiceStarted) { this.practiceStarted = true; this.send({ t: 'host', a: 'start' }); }
        break;
      }
      case 'error':
        if (m.code === 'version') this.fatal = m.msg;
        if (m.code === 'session') { this.clearToken(); this.onSessionEnded(); return; }
        this.error = m.msg;
        this.toast(m.msg, 'bad');
        break;
      case 'phase':
        this.phase = m.phase; this.round = m.round; this.rounds = m.rounds; this.competitive = m.competitive; this.tally = m.tally;
        this.endsAt = performance.now() + m.endsIn;
        if (m.phase === 'lobby') this.toLobbyState();
        if (m.phase === 'draft') { this.placedThisRound = false; this.results = null; this.matchEnd = null; this.awaitingPlace = false; this.race = null; this.pred = null; }
        if (m.phase === 'build') { this.awaitingPlace = false; this.rot = 0; this.variant = 0; }
        if (m.phase !== 'build') this.rehearsal = null;
        if (m.phase === 'race') { this.acc = 0; this.onEvent({ type: 'go' }); }
        if (m.phase === 'countdown') this.onEvent({ type: 'countdown' });
        break;
      case 'world': this.world = World.fromJSON(m.world); this.refreshCheck(); break;
      case 'draft': this.cards = m.cards; this.demolition = m.demolition; break;
      case 'claimed': {
        const c = this.cards.find(k => k.id === m.card);
        if (c) c.by = m.by;
        if (m.by === this.you) this.onEvent({ type: 'claimed' });
        break;
      }
      case 'claimFail': this.toast(m.msg, 'bad'); this.onEvent({ type: 'deny' }); break;
      case 'placed':
        if (this.world) { this.world.objects.set(m.obj.id, m.obj); this.world.rebuild(); this.world.version = m.version; }
        if (m.by === this.you) { this.placedThisRound = true; this.awaitingPlace = false; this.check = null; }
        this.onEvent({ type: 'placed', obj: m.obj, by: m.by });
        this.refreshCheck();
        break;
      case 'removed':
        if (this.world) { for (const id of m.ids) this.world.objects.delete(id); this.world.rebuild(); this.world.version = m.version; }
        if (m.by === this.you) { this.placedThisRound = true; this.awaitingPlace = false; this.check = null; }
        this.onEvent({ type: 'bomb', cells: m.cells, by: m.by });
        this.refreshCheck();
        break;
      case 'placeFail': this.awaitingPlace = false; this.toast(m.msg, 'bad'); this.onEvent({ type: 'deny' }); break;
      case 'skip':
        if (m.pid === this.you) this.placedThisRound = true;
        this.toast(m.msg, 'info');
        break;
      case 'notice': this.toast(m.msg, 'info', 4500); break;
      case 'raceStart':
        if (this.world) {
          this.race = new RaceSim(this.world.clone(), m.ids, { roundKey: m.roundKey, maxTicks: m.maxTicks });
          this.roundKey = m.roundKey;
          this.snaps = []; this.pred = null; this.pending = []; this.seq = 0; this.sendBuf = []; this.spectateIdx = 0;
          const me = this.race.player(this.you);
          if (me) { this.pred = cloneBody(me.body); this.predPrev = cloneBody(me.body); }
        }
        break;
      case 'snap': this.onSnap(m.s, m.ev); break;
      case 'results': this.results = { rows: m.rows, competitive: m.competitive, last: m.last }; this.onEvent({ type: 'results' }); break;
      case 'matchEnd': this.matchEnd = { order: m.order, winners: m.winners, tally: m.tally, votes: m.votes }; this.votes = m.votes; break;
      case 'votes': this.votes = m.votes; break;
      case 'pong': break;
    }
    this.onChange();
  }

  private toLobbyState() {
    this.world = null; this.race = null; this.cards = []; this.results = null; this.matchEnd = null; this.pred = null; this.rehearsal = null;
  }

  // ------------------------------------------------ race: snapshots, prediction, reconciliation
  private onSnap(s: RaceSnapshot, ev: RaceEvent[]) {
    const race = this.race;
    if (!race) return;
    const now = performance.now();
    this.snaps.push({ s, at: now });
    if (this.snaps.length > 30) this.snaps.shift();
    this.lastSnapAt = now;
    this.snapCount++;
    if (now - this.snapWindow > 1000) { this.stats.snapsPerSec = this.snapCount; this.snapCount = 0; this.snapWindow = now; }
    race.applySnapshot(s);
    for (const ps of s.players) { const p = race.player(ps.id); if (p) applyBodySnap(p.body, ps); }
    race.projectiles = s.proj.map(([id, kind, x, y, vx, vy]) => ({ id, kind, owner: null, src: '', x, y, vx, vy, r: kind === 'cannon' ? HAZARD.cannonBallR : 4, age: 0, hit: [], alive: true }));
    for (const e of ev) this.onEvent(e);
    const me = s.players.find(p => p.id === this.you);
    if (me) this.reconcile(me);
  }

  private reconcile(me: PlayerSnap) {
    const race = this.race!;
    if (me.st !== 'racing') { this.pred = null; this.pending = []; return; }
    if (!this.pred) this.pred = newBody(me.x, me.y);
    const before = { x: this.pred.x, y: this.pred.y };
    applyBodySnap(this.pred, me);
    this.pending = this.pending.filter(p => p.seq > me.ack);
    const p = race.player(this.you)!;
    const movers = this.predMovers();
    for (const pi of this.pending) { stepBody(this.pred, pi.b, race.envFor(p, movers)); this.stats.predSteps++; }
    const dx = before.x - this.pred.x, dy = before.y - this.pred.y;
    this.stats.lastCorr = Math.hypot(dx, dy);
    // small corrections are smoothed visually; big ones snap
    if (Math.hypot(dx, dy) < 64) { this.corr.x += dx; this.corr.y += dy; } else { this.corr.x = 0; this.corr.y = 0; }
  }

  /** Called every animation frame with elapsed ms. */
  update(dtMs: number) {
    const now = performance.now();
    this.toasts = this.toasts.filter(t => t.until > now);
    this.fx = this.fx.filter(f => now - f.t0 < 1500);
    if (this.rehearsal) { this.updateRehearsal(dtMs); return; }
    const race = this.race;
    if (!race) return;
    // advance the mirror's timed hazards between snapshots (purely visual and for prediction movers)
    const slow = race.slowTicks > 0 ? 0.5 : 1;
    const steps = dtMs / 1000;
    if (this.phase === 'race') {
      for (const h of race.hz) h.phase += steps * (h.kind === 'laser' ? (laserInOff(h.phase) ? slow : 1) : h.slowable ? slow : 1);
      for (const m of race.movers) { m.prev = m.rect; m.rect = moverRect(m.o, m.hz.phase, m.hz.pathLen); }
    }
    const k = Math.pow(0.0001, dtMs / 1000); // decay correction offset quickly
    this.corr.x *= k; this.corr.y *= k;
    if (this.phase !== 'race' || !this.pred) return;
    this.acc += Math.min(dtMs, 200);
    while (this.acc >= STEP) { this.acc -= STEP; this.localTick(); }
    this.flushInputs(true);
  }

  private localTick() {
    const race = this.race!;
    const p = race.player(this.you);
    if (!p || !this.pred) return;
    const bits = inputBits();
    this.seq++;
    this.pending.push({ seq: this.seq, b: bits });
    if (this.pending.length > 240) this.pending.shift();
    this.sendBuf.push({ seq: this.seq, b: bits });
    this.predPrev = cloneBody(this.pred);
    stepBody(this.pred, bits, race.envFor(p, this.predMovers()));
    if (this.pred.jumped || this.pred.wallJumped) this.onEvent({ type: 'localJump', wall: this.pred.wallJumped });
    if (this.pred.landed) this.onEvent({ type: 'localLand' });
    this.flushInputs(false);
  }

  /** Moving platforms at the mirror's current phase with a one-tick delta (so riding carries exactly like the server). */
  private predMovers() {
    const race = this.race!;
    const slow = race.slowTicks > 0 ? 0.5 : 1;
    return race.movers.map(m => {
      const r = moverRect(m.o, m.hz.phase, m.hz.pathLen);
      const pr = moverRect(m.o, m.hz.phase - DT * slow, m.hz.pathLen);
      return { x: r.x, y: r.y, w: r.w, h: r.h, dx: r.x - pr.x, dy: r.y - pr.y };
    });
  }

  private flushInputs(force: boolean) {
    if (!this.sendBuf.length) return;
    if (!force && this.sendBuf.length < 2) return;
    this.send({ t: 'in', round: this.round, s: this.sendBuf[0].seq, b: this.sendBuf.map(x => x.b) });
    this.sendBuf = [];
  }

  /** Estimated server tick for interpolation. */
  serverTickNow(): number {
    const last = this.snaps[this.snaps.length - 1];
    if (!last) return 0;
    return last.s.tick + ((performance.now() - last.at) / 1000) * TICK_HZ;
  }

  /** Interpolated position of a remote player ~100 ms in the past. */
  remotePos(id: string): { x: number; y: number; vx: number; vy: number; snap: PlayerSnap } | null {
    if (this.snaps.length === 0) return null;
    const target = this.serverTickNow() - 6;
    let a = this.snaps[0], b = this.snaps[this.snaps.length - 1];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].s.tick <= target && this.snaps[i + 1].s.tick >= target) { a = this.snaps[i]; b = this.snaps[i + 1]; break; }
    }
    const pa = a.s.players.find(p => p.id === id), pb = b.s.players.find(p => p.id === id);
    if (!pa || !pb) return null;
    if (b.s.tick === a.s.tick || target >= b.s.tick) {
      const ext = Math.min(6, Math.max(0, target - b.s.tick)) / TICK_HZ;
      return { x: pb.x + pb.vx * ext, y: pb.y + pb.vy * ext, vx: pb.vx, vy: pb.vy, snap: pb };
    }
    const f = Math.max(0, Math.min(1, (target - a.s.tick) / (b.s.tick - a.s.tick)));
    return { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f, vx: pb.vx, vy: pb.vy, snap: f < 0.5 ? pa : pb };
  }

  /** Who the camera follows when we are not racing. */
  spectateTarget(): string | null {
    const race = this.race;
    if (!race) return null;
    const alive = race.players.filter(p => p.status === 'racing');
    if (!alive.length) return null;
    return alive[((this.spectateIdx % alive.length) + alive.length) % alive.length].id;
  }

  // ------------------------------------------------ building
  myItem(): string | null { return this.myCard?.item ?? null; }

  setCursor(x: number, y: number) {
    if (x === this.cursor.x && y === this.cursor.y) return;
    this.cursor = { x, y };
    this.refreshCheck();
  }

  rotate(dir = 1) {
    const item = this.myItem();
    if (!item) return;
    const def = getItem(item);
    if (!def.rotatable) { this.toast(`${def.name} can't rotate`, 'bad', 1800); return; }
    this.rot = (this.rot + dir + 4) % 4;
    this.refreshCheck();
  }

  flip() {
    const item = this.myItem();
    if (!item) return;
    const def = getItem(item);
    if (!def.variants) return;
    this.variant = (this.variant + 1) % def.variants.length;
    this.refreshCheck();
  }

  request(): PlaceRequest | null {
    const item = this.myItem();
    if (!item) return null;
    return { item, x: this.cursor.x, y: this.cursor.y, rot: getItem(item).rotatable ? this.rot : 0, variant: this.variant };
  }

  refreshCheck() {
    const r = this.request();
    if (!this.world || !r || this.phase !== 'build' || this.placedThisRound) { this.check = null; return; }
    this.check = checkPlacement(this.world, r);
  }

  confirmPlace() {
    if (this.phase !== 'build' || this.placedThisRound || this.awaitingPlace) return;
    const r = this.request();
    if (!r) return;
    this.refreshCheck();
    if (!this.check?.ok) { this.toast(this.check?.reason ?? 'Can’t place there', 'bad', 2000); this.onEvent({ type: 'deny' }); return; }
    this.awaitingPlace = true;
    this.send({ t: 'place', round: this.round, x: r.x, y: r.y, rot: r.rot, variant: r.variant });
    this.onChange();
  }

  // ------------------------------------------------ rehearsal (local only, never scored)
  startRehearsal() {
    if (!this.world || this.phase !== 'build') return;
    this.rehearsal = { sim: new RaceSim(this.world.clone(), [this.you || 'me'], { roundKey: 'rehearsal', maxTicks: 60 * 60 }), acc: 0, prevJump: false };
    this.onChange();
  }
  stopRehearsal() { this.rehearsal = null; this.onChange(); }

  private updateRehearsal(dtMs: number) {
    const r = this.rehearsal!;
    r.acc += Math.min(dtMs, 200);
    while (r.acc >= STEP) {
      r.acc -= STEP;
      const bits = inputBits();
      const id = r.sim.players[0].id;
      r.sim.step(new Map([[id, bits]]));
      const p = r.sim.players[0];
      for (const e of r.sim.drainEvents()) this.onEvent(e);
      if (p.status !== 'racing' || r.sim.over) {
        // instant reset in rehearsal
        this.toast(p.status === 'finished' ? `Rehearsal: flag reached in ${(p.finishTick / TICK_HZ).toFixed(2)}s` : 'Rehearsal: eliminated, restarting', p.status === 'finished' ? 'good' : 'bad', 1800);
        r.sim = new RaceSim(this.world!.clone(), [id], { roundKey: 'rehearsal' + Math.random(), maxTicks: 60 * 60 });
      }
    }
  }
}

export { DT };
