// Authoritative race simulation. Pure and deterministic: the server runs it, practice mode and rehearsal run it locally.
import { CELL, DT, HAZARD, PHYS, POWER, TICK_HZ, SCORING, MATCH } from './config';
import { circleRect, rectsOverlap, segRect, type Rect, type Vec } from './grid';
import {
  cellCenter, laserBeamRect, laserCells, laserInOff, laserState, launcherDir, moverPathLen, moverRect, muzzle,
  pendulumPos, rspikeState, sawPos, springDir, springRect, staticLethal, type StaticLethal,
} from './hazards';
import { getItem, type PowerType } from './items';
import { childCount, childId, childRect } from './movers';
import { bodyCenter, bodyRect, newBody, stepBody, type Body, type Mover, type PhysEnv } from './physics';
import { spikeStripPx, type PlacedObject, type World } from './world';

export type PlayerStatus = 'racing' | 'finished' | 'dead' | 'timeout';

export interface Effects { speed: number; jump: number; shield: number; immune: number }

export interface RacePlayer {
  id: string;
  body: Body;
  status: PlayerStatus;
  finishTick: number;
  deathTick: number;
  cause: string;
  killer: string | null;
  effects: Effects;
  coins: string[];
  lastPull: { owner: string | null; src: string; tick: number } | null;
  springCd: number;
  connected: boolean;
  disconnectedTick: number;
  spawn: Vec;
}

export type ProjKind = 'sniper' | 'cannon' | 'arrow' | 'dart';
export interface Projectile { id: number; kind: ProjKind; owner: string | null; src: string; x: number; y: number; vx: number; vy: number; r: number; age: number; hit: string[]; alive: boolean }

export type CoinPhase = 'origin' | 'carried' | 'dropped' | 'banked' | 'lost';
export interface CoinState { id: string; ox: number; oy: number; x: number; y: number; state: CoinPhase; carrier: string | null }
export interface PickupState { id: string; x: number; y: number; power: PowerType; available: boolean }

export type RaceEvent =
  | { id: string; t: number; type: 'finish'; pid: string; tick: number }
  | { id: string; t: number; type: 'death'; pid: string; credit: string | null; cause: string; src: string | null; x: number; y: number }
  | { id: string; t: number; type: 'bank'; pid: string; coin: string }
  | { id: string; t: number; type: 'coin'; pid: string; coin: string; action: 'pickup' | 'drop' | 'lost' }
  | { id: string; t: number; type: 'power'; pid: string; power: PowerType; src: string }
  | { id: string; t: number; type: 'shield'; pid: string }
  | { id: string; t: number; type: 'fire'; src: string; kind: ProjKind }
  | { id: string; t: number; type: 'spring'; pid: string }
  | { id: string; t: number; type: 'jump'; pid: string; wall: boolean };

interface Hz { o: PlacedObject; kind: string; phase: number; slowable: boolean; pathLen: number; beam: number; fireAcc: number }

export interface SimMover { id: string; o: PlacedObject; child: number; hz: Hz | null; rect: Rect; prev: Rect }

interface CrumbleState { o: PlacedObject; rect: Rect; trigger: number; brokenUntil: number; broken: boolean }

export interface RaceOptions { roundKey: string; maxTicks: number; seed?: number }

const W = PHYS.bodyW, H = PHYS.bodyH;

export class RaceSim {
  readonly world: World;
  readonly opts: RaceOptions;
  tick = 0;
  players: RacePlayer[] = [];
  projectiles: Projectile[] = [];
  coins: CoinState[] = [];
  pickups: PickupState[] = [];
  hz: Hz[] = [];
  /**
   * Every solid moving body, in a fixed order shared with clients: legacy moving platforms (phase-driven) first, then
   * kinematic platform children (tick-driven) by object id and child index. Body.groundMover indexes this list.
   */
  movers: SimMover[] = [];
  crumbles = new Map<string, CrumbleState>();
  slowTicks = 0;
  events: RaceEvent[] = [];
  private eventIds = new Set<string>();
  private projSeq = 1;
  private lethal: StaticLethal;
  private holes: { x: number; y: number; owner: string | null; src: string }[] = [];
  private springs: { o: PlacedObject; r: Rect }[] = [];
  over = false;

  constructor(world: World, playerIds: string[], opts: RaceOptions) {
    this.world = world;
    this.opts = opts;
    const sp = world.spawnPx;
    const n = playerIds.length;
    playerIds.forEach((id, i) => {
      const span = sp.w - W - 12;
      const x = sp.x + 6 + (n > 1 ? (span * i) / (n - 1) : span / 2);
      const y = sp.y + sp.h - H;
      const body = newBody(x, y);
      body.grounded = true;
      this.players.push({
        id, body, status: 'racing', finishTick: -1, deathTick: -1, cause: '', killer: null,
        effects: { speed: 0, jump: 0, shield: 0, immune: 0 }, coins: [], lastPull: null, springCd: 0,
        connected: true, disconnectedTick: -1, spawn: { x, y },
      });
    });
    for (const o of world.objects.values()) {
      const def = getItem(o.item);
      const c = cellCenter(o.x, o.y);
      switch (def.kind) {
        case 'coin': this.coins.push({ id: o.id, ox: c.x, oy: c.y, x: c.x, y: c.y, state: 'origin', carrier: null }); break;
        case 'power': this.pickups.push({ id: o.id, x: c.x, y: c.y, power: def.power!, available: true }); break;
        case 'blackhole': this.holes.push({ x: c.x, y: c.y, owner: o.owner, src: o.id }); break;
        case 'spring': this.springs.push({ o, r: springRect(o) }); break;
        case 'crumble': {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const [x, y] of o.cells) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
          this.crumbles.set(o.id, { o, rect: { x: minX * CELL, y: minY * CELL, w: (maxX - minX + 1) * CELL, h: (maxY - minY + 1) * CELL }, trigger: -1, brokenUntil: -1, broken: false });
          break;
        }
        case 'rspikes': case 'saw': case 'dart': case 'laser': case 'pendulum': case 'moving': case 'sniper': case 'cannon': case 'crossbow': {
          const h: Hz = { o, kind: def.kind, phase: 0, slowable: def.slowable, pathLen: 0, beam: 0, fireAcc: 0 };
          if (def.kind === 'moving') h.pathLen = moverPathLen(world, o);
          if (def.kind === 'laser') h.beam = laserCells(world, o);
          this.hz.push(h);
          if (def.kind === 'moving') {
            const r = moverRect(o, 0, h.pathLen);
            this.movers.push({ id: childId(o, 0), o, child: 0, hz: h, rect: r, prev: { ...r } });
          }
          break;
        }
        default: break;
      }
    }
    // kinematic platforms start at their GO pose (tick 0) every race, for every player
    for (const o of world.kinematic) for (let i = 0; i < childCount(o); i++) {
      const r = childRect(o, i, 0);
      this.movers.push({ id: childId(o, i), o, child: i, hz: null, rect: r, prev: { ...r } });
    }
    this.lethal = staticLethal(world);
  }

  /** Mover poses at an arbitrary tick: kinematic bodies exactly, legacy ones at their current phase. */
  moversAt(tick: number, legacy?: (m: SimMover) => { rect: Rect; prev: Rect }): Mover[] {
    return this.movers.map(m => {
      let r: Rect, pr: Rect;
      if (m.hz) { const l = legacy ? legacy(m) : { rect: m.rect, prev: m.prev }; r = l.rect; pr = l.prev; }
      else { r = childRect(m.o, m.child, tick); pr = childRect(m.o, m.child, tick - 1); }
      return { x: r.x, y: r.y, w: r.w, h: r.h, dx: r.x - pr.x, dy: r.y - pr.y, id: m.id };
    });
  }

  get time() { return this.tick / TICK_HZ; }
  get slowMul() { return this.slowTicks > 0 ? POWER.slowFactor : 1; }

  player(id: string) { return this.players.find(p => p.id === id); }

  private emit(e: RaceEvent) {
    if (this.eventIds.has(e.id)) return; // idempotent: duplicate callbacks never duplicate events
    this.eventIds.add(e.id);
    this.events.push(e);
  }

  isSolid = (cx: number, cy: number): boolean => {
    if (!this.world.solidCell(cx, cy)) return false;
    if (this.crumbles.size) {
      const id = this.world.inBounds(cx, cy) ? this.world.collObj[this.world.idx(cx, cy)] : null;
      if (id) { const c = this.crumbles.get(id); if (c && c.broken) return false; }
    }
    return true;
  };

  moverList(): Mover[] {
    return this.movers.map(m => ({ x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h, dx: m.rect.x - m.prev.x, dy: m.rect.y - m.prev.y, id: m.id }));
  }

  /** Physics environment for one player (shared with client prediction). */
  envFor(p: RacePlayer, movers: Mover[]): PhysEnv {
    return {
      world: this.world, isSolid: this.isSolid, movers,
      speedMul: p.effects.speed > 0 ? POWER.speedMul : 1,
      jumpMul: p.effects.jump > 0 ? POWER.jumpMul : 1,
      accel: this.holes.length ? (b: Body) => this.holePull(b, p) : undefined,
    };
  }

  /** Black hole attraction: falloff, occlusion by solids, capped, ignored in protected zones. */
  holePull(b: Body, p: RacePlayer | null): { ax: number; ay: number } | null {
    const c = bodyCenter(b);
    if (this.world.inProtectedPx(c.x, c.y)) return null;
    let ax = 0, ay = 0, strongest = 0, src: (typeof this.holes)[number] | null = null;
    for (const h of this.holes) {
      const dx = h.x - c.x, dy = h.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d >= HAZARD.holeRadius || d < 1) continue;
      if (this.rayBlocked(h.x, h.y, c.x, c.y)) continue;
      const a = HAZARD.holeMaxPull * (1 - d / HAZARD.holeRadius);
      const ux = dx / d, uy = dy / d;
      // do not keep accelerating past the max affected speed along the pull direction
      const along = b.vx * ux + b.vy * uy;
      if (along > HAZARD.holeMaxAffectedSpeed) continue;
      ax += ux * a; ay += uy * a;
      if (a > strongest) { strongest = a; src = h; }
    }
    const mag = Math.hypot(ax, ay);
    if (mag > HAZARD.holeMaxTotal) { ax *= HAZARD.holeMaxTotal / mag; ay *= HAZARD.holeMaxTotal / mag; }
    if (p && src && strongest > 120) p.lastPull = { owner: src.owner, src: src.src, tick: this.tick };
    return mag > 0 ? { ax, ay } : null;
  }

  /** Grid ray test between two points through dynamic solids. */
  rayBlocked(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.rayHitT(x0, y0, x1, y1) >= 0;
  }

  /** Earliest t in [0,1] where segment enters a solid cell (exact grid traversal) or a mover. -1 if none. */
  rayHitT(x0: number, y0: number, x1: number, y1: number): number {
    let best = -1;
    let cx = Math.floor(x0 / CELL), cy = Math.floor(y0 / CELL);
    const ex = Math.floor(x1 / CELL), ey = Math.floor(y1 / CELL);
    const dx = x1 - x0, dy = y1 - y0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX ? Math.abs(CELL / dx) : Infinity, tDeltaY = stepY ? Math.abs(CELL / dy) : Infinity;
    let tMaxX = stepX > 0 ? ((cx + 1) * CELL - x0) / dx : stepX < 0 ? (cx * CELL - x0) / dx : Infinity;
    let tMaxY = stepY > 0 ? ((cy + 1) * CELL - y0) / dy : stepY < 0 ? (cy * CELL - y0) / dy : Infinity;
    let t = 0;
    if (this.isSolid(cx, cy) && this.world.inBounds(cx, cy)) best = 0;
    for (let guard = 0; best < 0 && guard < 400 && (cx !== ex || cy !== ey); guard++) {
      if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; } else { t = tMaxY; tMaxY += tDeltaY; cy += stepY; }
      if (t > 1) break;
      if (this.world.inBounds(cx, cy) && this.isSolid(cx, cy)) best = t;
    }
    for (const m of this.movers) {
      // relative motion: test the segment in the platform's frame so fast shots and moving bodies never tunnel
      const mt = segRect(x0 + (m.rect.x - m.prev.x), y0 + (m.rect.y - m.prev.y), x1, y1, m.rect);
      if (mt >= 0 && (best < 0 || mt < best)) best = mt;
    }
    return best;
  }

  setConnected(id: string, connected: boolean) {
    const p = this.player(id);
    if (!p) return;
    p.connected = connected;
    p.disconnectedTick = connected ? -1 : this.tick;
  }

  /** Advance one tick with the given input bits per player id. */
  step(inputs: Map<string, number>): void {
    if (this.over) return;
    this.tick++;
    const slow = this.slowMul;
    if (this.slowTicks > 0) this.slowTicks--;

    // hazards and movers
    for (const h of this.hz) {
      if (h.kind === 'laser') {
        // slow pulse stretches only the off span, never the dangerous on span
        h.phase += DT * (laserInOff(h.phase) ? slow : 1);
      } else h.phase += DT * (h.slowable ? slow : 1);
    }
    for (const m of this.movers) { m.prev = m.rect; m.rect = m.hz ? moverRect(m.o, m.hz.phase, m.hz.pathLen) : childRect(m.o, m.child, this.tick); }
    const movers = this.moverList();

    this.fireLaunchers(slow);

    // movement
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      const inp = p.connected ? inputs.get(p.id) ?? 0 : 0; // disconnect clears held inputs
      stepBody(p.body, inp, this.envFor(p, movers));
      if (p.body.jumped || p.body.wallJumped) this.emit({ id: `${this.opts.roundKey}:j:${p.id}:${this.tick}`, t: this.tick, type: 'jump', pid: p.id, wall: p.body.wallJumped });
      const e = p.effects;
      if (e.speed > 0) e.speed -= DT;
      if (e.jump > 0) e.jump -= DT;
      if (e.shield > 0) e.shield -= DT;
      if (e.immune > 0) e.immune -= DT;
      if (p.springCd > 0) p.springCd -= DT;
    }

    this.updateCrumbles();
    this.updateSprings();
    this.updateProjectiles();
    this.checkHazards();
    this.checkFalls();
    this.checkDisconnects();
    this.checkFinish();
    this.updatePickups();

    if (this.players.every(p => p.status !== 'racing')) this.over = true;
    if (this.tick >= this.opts.maxTicks) {
      for (const p of this.players) if (p.status === 'racing') { p.status = 'timeout'; this.dropCoins(p, true); }
      this.over = true;
    }
  }

  private fireLaunchers(slow: number) {
    for (const h of this.hz) {
      let fire = false;
      if (h.kind === 'sniper') fire = this.tick % Math.round(HAZARD.sniperInterval * TICK_HZ) === 0; // exact 2.5 s cadence from GO
      else if (h.kind === 'cannon') fire = this.tick % Math.round(HAZARD.cannonInterval * TICK_HZ) === 0;
      else if (h.kind === 'crossbow') fire = this.tick % Math.round(HAZARD.crossbowInterval * TICK_HZ) === 0;
      else if (h.kind === 'dart') {
        h.fireAcc += DT * slow;
        if (h.fireAcc >= HAZARD.dartInterval) { h.fireAcc -= HAZARD.dartInterval; fire = true; }
      }
      if (!fire || this.projectiles.length >= MATCH.maxProjectiles) continue;
      const m = muzzle(h.o), d = launcherDir(h.o);
      const kind: ProjKind = h.kind === 'sniper' ? 'sniper' : h.kind === 'cannon' ? 'cannon' : h.kind === 'crossbow' ? 'arrow' : 'dart';
      const speed = kind === 'sniper' ? HAZARD.sniperSpeed : kind === 'cannon' ? HAZARD.cannonMuzzleSpeed : kind === 'arrow' ? HAZARD.arrowSpeed : HAZARD.dartSpeed;
      const r = kind === 'cannon' ? HAZARD.cannonBallR : kind === 'sniper' ? 3 : 4;
      if (this.world.inProtectedPx(m.x, m.y)) continue;
      this.projectiles.push({ id: this.projSeq++, kind, owner: h.o.owner, src: h.o.id, x: m.x, y: m.y, vx: d.x * speed, vy: d.y * speed, r, age: 0, hit: [], alive: true });
      this.emit({ id: `${this.opts.roundKey}:f:${h.o.id}:${this.tick}`, t: this.tick, type: 'fire', src: h.o.id, kind });
    }
  }

  private updateCrumbles() {
    if (!this.crumbles.size) return;
    const t = this.time;
    for (const c of this.crumbles.values()) {
      if (c.broken) {
        if (t >= c.brokenUntil && !this.players.some(p => p.status === 'racing' && rectsOverlap(bodyRect(p.body), c.rect))) { c.broken = false; c.trigger = -1; }
        continue;
      }
      if (c.trigger < 0 && this.players.some(p => p.status === 'racing' && p.body.grounded && p.body.groundObj === c.o.id)) c.trigger = t;
      if (c.trigger >= 0 && t - c.trigger >= HAZARD.crumbleDelay) { c.broken = true; c.brokenUntil = t + HAZARD.crumbleRespawn; }
    }
  }

  private updateSprings() {
    for (const p of this.players) {
      if (p.status !== 'racing' || p.springCd > 0) continue;
      const br = bodyRect(p.body);
      for (const s of this.springs) {
        if (!rectsOverlap(br, s.r)) continue;
        const d = springDir(s.o);
        const b = p.body;
        if (d.y !== 0) { b.vy = d.y * PHYS.springSpeed; b.jumpRising = false; }
        else { b.vx = d.x * PHYS.springSideSpeed; b.vy = -PHYS.springSideLift; b.lockT = PHYS.springControlLock; }
        b.grounded = false; b.coyote = 0;
        p.springCd = 0.15;
        this.emit({ id: `${this.opts.roundKey}:s:${p.id}:${this.tick}`, t: this.tick, type: 'spring', pid: p.id });
        break;
      }
    }
  }

  private updateProjectiles() {
    const wpx = this.world.w * CELL, hpx = this.world.h * CELL;
    for (const pr of this.projectiles) {
      if (!pr.alive) continue;
      pr.age += DT;
      if (pr.kind === 'cannon') pr.vy += HAZARD.cannonGravity * DT;
      const x1 = pr.x + pr.vx * DT, y1 = pr.y + pr.vy * DT;
      let tBlock = this.rayHitT(pr.x, pr.y, x1, y1);
      for (const z of this.world.protectedPx) {
        const tz = segRect(pr.x, pr.y, x1, y1, z);
        if (tz >= 0 && (tBlock < 0 || tz < tBlock)) tBlock = tz;
      }
      const limit = tBlock < 0 ? 1 : tBlock;
      // players along the path, earliest first; nothing behind a block is reachable
      const hits: { p: RacePlayer; t: number }[] = [];
      for (const p of this.players) {
        if (p.status !== 'racing' || pr.hit.includes(p.id)) continue;
        const r = bodyRect(p.body);
        const t = segRect(pr.x, pr.y, x1, y1, { x: r.x - pr.r, y: r.y - pr.r, w: r.w + pr.r * 2, h: r.h + pr.r * 2 });
        if (t >= 0 && t <= limit) hits.push({ p, t });
      }
      hits.sort((a, b) => a.t - b.t);
      let stopT = -1;
      for (const h of hits) {
        pr.hit.push(h.p.id);
        this.lethalHit(h.p, pr.owner, pr.kind, pr.src);
        if (pr.kind !== 'sniper') { stopT = h.t; break; } // arrows break, cannonballs and darts stop; sniper rounds pierce
      }
      if (stopT >= 0) { pr.x += (x1 - pr.x) * stopT; pr.y += (y1 - pr.y) * stopT; pr.alive = false; continue; }
      if (tBlock >= 0) { pr.x += (x1 - pr.x) * tBlock; pr.y += (y1 - pr.y) * tBlock; pr.alive = false; continue; }
      pr.x = x1; pr.y = y1;
      if (pr.x < 0 || pr.y < 0 || pr.x > wpx || pr.y > hpx || pr.age > HAZARD.projectileLifetime) pr.alive = false;
    }
    if (this.projectiles.some(p => !p.alive)) this.projectiles = this.projectiles.filter(p => p.alive);
  }

  /** Trap contact. Shields absorb one hit and grant brief immunity. */
  lethalHit(p: RacePlayer, owner: string | null, cause: string, src: string | null) {
    if (p.status !== 'racing') return;
    if (p.effects.immune > 0) return;
    if (p.effects.shield > 0) {
      p.effects.shield = 0; p.effects.immune = POWER.shieldImmunity;
      this.emit({ id: `${this.opts.roundKey}:sh:${p.id}:${this.tick}`, t: this.tick, type: 'shield', pid: p.id });
      return;
    }
    this.kill(p, owner, cause, src);
  }

  private kill(p: RacePlayer, owner: string | null, cause: string, src: string | null) {
    if (p.status !== 'racing') return;
    p.status = 'dead'; p.deathTick = this.tick; p.cause = cause;
    const credit = owner && owner !== p.id ? owner : null; // self-eliminations and map hazards credit nobody
    p.killer = credit;
    const c = bodyCenter(p.body);
    this.emit({ id: `${this.opts.roundKey}:death:${p.id}`, t: this.tick, type: 'death', pid: p.id, credit, cause, src, x: c.x, y: c.y });
    this.dropCoins(p, cause === 'fall' || cause === 'pull-fall');
  }

  /** Same coin, same identity: dropped exactly where its carrier died, or lost for the round if that spot is unreachable. */
  private dropCoins(p: RacePlayer, lost: boolean) {
    const c = bodyCenter(p.body);
    for (const id of p.coins) {
      const coin = this.coins.find(k => k.id === id);
      if (!coin) continue;
      coin.carrier = null; coin.x = c.x; coin.y = c.y;
      const inaccessible = lost || p.status === 'timeout' || this.pointInaccessible(c.x, c.y);
      coin.state = inaccessible ? 'lost' : 'dropped';
      this.emit({ id: `${this.opts.roundKey}:c:${id}:${p.id}:${this.tick}`, t: this.tick, type: 'coin', pid: p.id, coin: id, action: inaccessible ? 'lost' : 'drop' });
    }
    p.coins = [];
  }

  pointInaccessible(x: number, y: number): boolean {
    const wpx = this.world.w * CELL, hpx = this.world.h * CELL;
    if (x < 0 || y < 0 || x > wpx || y > hpx) return true;
    if (this.world.solidCell(Math.floor(x / CELL), Math.floor(y / CELL))) return true;
    const probe: Rect = { x: x - 2, y: y - 2, w: 4, h: 4 }; // the death point itself inside a lethal shape
    if (this.lethal.rects.some(l => rectsOverlap(l.r, probe))) return true;
    if (this.lethal.circles.some(l => circleRect(l.x, l.y, l.r, probe))) return true;
    return false;
  }

  private checkHazards() {
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      const br = bodyRect(p.body);
      for (const l of this.lethal.rects) if (rectsOverlap(br, l.r)) { this.lethalHit(p, l.owner, getItem(this.world.objects.get(l.src)!.item).kind, l.src); break; }
      if (p.status !== 'racing') continue;
      for (const l of this.lethal.circles) if (circleRect(l.x, l.y, l.r, br)) { this.lethalHit(p, l.owner, 'blackhole', l.src); break; }
      if (p.status !== 'racing') continue;
      for (const h of this.hz) {
        let hit = false;
        if (h.kind === 'rspikes') { if (rspikeState(h.phase) === 'out') hit = h.o.cells.some(([x, y]) => rectsOverlap(br, spikeStripPx(x, y, h.o.rot))); }
        else if (h.kind === 'laser') { if (laserState(h.phase) === 'on') { const r = laserBeamRect(h.o, h.beam); hit = !!r && rectsOverlap(br, r); } }
        else if (h.kind === 'saw') { const s = sawPos(h.o, h.phase); hit = circleRect(s.x, s.y, HAZARD.sawR, br); }
        else if (h.kind === 'pendulum') { const s = pendulumPos(h.o, h.phase).ball; hit = circleRect(s.x, s.y, HAZARD.pendulumBallR, br); }
        if (hit) { this.lethalHit(p, h.o.owner, h.kind, h.o.id); if (p.status !== 'racing') break; }
      }
    }
  }

  private checkFalls() {
    const limit = (this.world.h + 1) * CELL;
    for (const p of this.players) {
      if (p.status !== 'racing' || p.body.y < limit) continue;
      // a fall right after a trap pull credits that trap's owner within the attribution window
      let owner: string | null = null, src: string | null = null;
      if (p.lastPull && this.tick - p.lastPull.tick <= SCORING.attributionWindowS * TICK_HZ) { owner = p.lastPull.owner; src = p.lastPull.src; }
      this.kill(p, owner, owner ? 'pull-fall' : 'fall', src);
    }
  }

  private checkDisconnects() {
    const grace = 20 * TICK_HZ;
    for (const p of this.players) {
      if (p.status === 'racing' && !p.connected && p.disconnectedTick >= 0 && this.tick - p.disconnectedTick >= grace) this.kill(p, null, 'disconnect', null);
    }
  }

  private checkFinish() {
    const f = this.world.finishPx;
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      if (!rectsOverlap(bodyRect(p.body), f)) continue;
      p.status = 'finished'; p.finishTick = this.tick;
      this.emit({ id: `${this.opts.roundKey}:finish:${p.id}`, t: this.tick, type: 'finish', pid: p.id, tick: this.tick });
      for (const id of p.coins) {
        const coin = this.coins.find(k => k.id === id);
        if (!coin || coin.state !== 'carried') continue;
        coin.state = 'banked'; coin.carrier = p.id;
        this.emit({ id: `${this.opts.roundKey}:bank:${id}`, t: this.tick, type: 'bank', pid: p.id, coin: id });
      }
    }
  }

  private updatePickups() {
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      const br = bodyRect(p.body);
      for (const coin of this.coins) {
        if (coin.state !== 'origin' && coin.state !== 'dropped') continue;
        if (!circleRect(coin.x, coin.y, 14, br)) continue;
        coin.state = 'carried'; coin.carrier = p.id; // first player in tick order wins; the coin can't be taken twice
        p.coins.push(coin.id);
        this.emit({ id: `${this.opts.roundKey}:c:${coin.id}:${p.id}:${this.tick}:p`, t: this.tick, type: 'coin', pid: p.id, coin: coin.id, action: 'pickup' });
      }
      for (const pk of this.pickups) {
        if (!pk.available || !circleRect(pk.x, pk.y, 16, br)) continue;
        pk.available = false;
        const e = p.effects, cap = POWER.maxStackDur;
        if (pk.power === 'speed') e.speed = Math.min(cap, Math.max(0, e.speed) + POWER.speedDur);
        if (pk.power === 'jump') e.jump = Math.min(cap, Math.max(0, e.jump) + POWER.jumpDur);
        if (pk.power === 'shield') e.shield = Math.min(cap, Math.max(0, e.shield) + POWER.shieldDur);
        if (pk.power === 'slow') this.slowTicks = Math.min(cap * TICK_HZ, this.slowTicks + POWER.slowDur * TICK_HZ);
        this.emit({ id: `${this.opts.roundKey}:pw:${pk.id}`, t: this.tick, type: 'power', pid: p.id, power: pk.power, src: pk.id });
      }
    }
    for (const coin of this.coins) {
      if (coin.state === 'carried' && coin.carrier) {
        const p = this.player(coin.carrier);
        if (p) { const c = bodyCenter(p.body); coin.x = c.x; coin.y = c.y - 30; }
      }
    }
  }

  drainEvents(): RaceEvent[] { const e = this.events; this.events = []; return e; }

  // ---- network snapshot
  snapshot(acks?: Map<string, number>): RaceSnapshot {
    return {
      tick: this.tick,
      slow: this.slowTicks,
      players: this.players.map(p => ({
        id: p.id, x: r1(p.body.x), y: r1(p.body.y), vx: r1(p.body.vx), vy: r1(p.body.vy), st: p.status, f: p.body.facing,
        g: p.body.grounded ? 1 : 0, wd: p.body.wallDir, ws: p.body.wallSliding ? 1 : 0, wr: p.body.wallJumpReady ? 1 : 0,
        co: r3(p.body.coyote), jb: r3(p.body.jumpBuf), pj: p.body.prevJump ? 1 : 0, jr: p.body.jumpRising ? 1 : 0,
        at: r3(p.body.assistT), ad: p.body.assistDir, lt: r3(p.body.lockT), dt: r3(p.body.dropT), gm: p.body.groundMover,
        e: [r2(p.effects.speed), r2(p.effects.jump), r2(p.effects.shield), r2(p.effects.immune)], c: p.coins.length,
        ack: acks?.get(p.id) ?? 0, cn: p.connected ? 1 : 0, sc: r3(p.springCd),
      })),
      proj: this.projectiles.map(pr => [pr.id, pr.kind, r1(pr.x), r1(pr.y), r1(pr.vx), r1(pr.vy)] as ProjSnap),
      coins: this.coins.map(c => ({ id: c.id, s: c.state, x: r1(c.x), y: r1(c.y), c: c.carrier })),
      pick: this.pickups.filter(p => !p.available).map(p => p.id),
      crumble: [...this.crumbles.values()].filter(c => c.broken).map(c => c.o.id),
      hz: this.hz.map(h => r3(h.phase)),
    };
  }

  /** Apply a server snapshot to a client-side mirror (for rendering and prediction environment). */
  applySnapshot(s: RaceSnapshot) {
    this.tick = s.tick;
    this.slowTicks = s.slow;
    s.hz.forEach((ph, i) => { if (this.hz[i]) this.hz[i].phase = ph; });
    for (const m of this.movers) {
      if (m.hz) { m.rect = moverRect(m.o, m.hz.phase, m.hz.pathLen); m.prev = { ...m.rect }; }
      else { m.rect = childRect(m.o, m.child, this.tick); m.prev = childRect(m.o, m.child, this.tick - 1); }
    }
    const broken = new Set(s.crumble);
    for (const c of this.crumbles.values()) c.broken = broken.has(c.o.id);
    const gone = new Set(s.pick);
    for (const p of this.pickups) p.available = !gone.has(p.id);
    for (const cs of s.coins) {
      const c = this.coins.find(k => k.id === cs.id);
      if (c) { c.state = cs.s; c.x = cs.x; c.y = cs.y; c.carrier = cs.c; }
    }
    for (const ps of s.players) {
      const p = this.player(ps.id);
      if (!p) continue;
      p.status = ps.st;
      p.effects = { speed: ps.e[0], jump: ps.e[1], shield: ps.e[2], immune: ps.e[3] };
      p.connected = ps.cn === 1;
    }
  }
}

export function applyBodySnap(b: Body, ps: PlayerSnap) {
  b.x = ps.x; b.y = ps.y; b.vx = ps.vx; b.vy = ps.vy; b.facing = ps.f; b.grounded = ps.g === 1; b.wallDir = ps.wd; b.wallSliding = ps.ws === 1;
  b.wallJumpReady = ps.wr === 1; b.coyote = ps.co; b.jumpBuf = ps.jb; b.prevJump = ps.pj === 1; b.jumpRising = ps.jr === 1;
  b.assistT = ps.at; b.assistDir = ps.ad; b.lockT = ps.lt; b.dropT = ps.dt; b.groundMover = ps.gm;
}

const r1 = (v: number) => Math.round(v * 100) / 100;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 10000) / 10000;

export type ProjSnap = [number, ProjKind, number, number, number, number];
export interface PlayerSnap {
  id: string; x: number; y: number; vx: number; vy: number; st: PlayerStatus; f: number; g: number; wd: number; ws: number; wr: number;
  co: number; jb: number; pj: number; jr: number; at: number; ad: number; lt: number; dt: number; gm: number;
  e: [number, number, number, number]; c: number; ack: number; cn: number; sc: number;
}
export interface RaceSnapshot {
  tick: number; slow: number; players: PlayerSnap[]; proj: ProjSnap[];
  coins: { id: string; s: CoinPhase; x: number; y: number; c: string | null }[];
  pick: string[]; crumble: string[]; hz: number[];
}
