// Authoritative race simulation. Pure and deterministic: the server runs it, practice mode and rehearsal run it locally.
import { CELL, DT, HAZARD, NEWITEMS, PHYS, POWER, TICK_HZ, SCORING, MATCH } from './config';
import { circleRect, rectsOverlap, segRect, type Rect, type Vec } from './grid';
import { closestOnSegment, fieldAccel, traceShot, type HoleInfo, type ShotSeg } from './field';
import {
  cellCenter, laserBeamRect, laserCells, laserInOff, laserState, launcherDir, moverPathLen, moverRect, muzzle,
  moverBaseRect, onMover, ovalHitsRect, pendulumPos, rspikeParts, rspikeState, sawPos, springDir, springRect, staticLethal, type StaticLethal,
} from './hazards';
import { getItem, PLANE_PASSES, type PowerType } from './items';
import { fanAccel, fanDist, fanFields, ghostOrbit, graveDirt, graveStone, planeDir, planeSpawnRect, type FanField } from './fans';
import { childCount, childId, childRect } from './movers';
import { bodyCenter, bodyRect, newBody, stepBody, type Body, type Mover, type PhysEnv } from './physics';
import { spikeStripPx, wireStripPx, type PlacedObject, type World } from './world';

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

/** Sniper shots are instantaneous and never exist as travelling projectiles; 'sniper' is only a cause and a fire-event kind. */
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
  /** an instant sniper shot: the evaluated path as x0,y0,x1,y1,... and how far it got */
  | { id: string; t: number; type: 'shot'; src: string; pts: number[] }
  | { id: string; t: number; type: 'absorb'; x: number; y: number }
  | { id: string; t: number; type: 'crumble'; obj: string; hp: number }
  | { id: string; t: number; type: 'spring'; pid: string }
  | { id: string; t: number; type: 'jump'; pid: string; wall: boolean }
  /** a paper plane crumpled at (x, y); hx/hy set when a black hole sucked it in */
  | { id: string; t: number; type: 'crumple'; x: number; y: number; dx: number; dy: number; hx?: number; hy?: number }
  | { id: string; t: number; type: 'plane'; src: string }
  /** a player touched a gravestone: a flower broke and a ghost now hunts them */
  | { id: string; t: number; type: 'ghost'; grave: string; pid: string };

/** A paper plane in its fixed mover slot. Velocity includes any sideways strafe from fans; t is the tick of x/y. */
export interface Plane { slot: number; alive: boolean; x: number; y: number; w: number; h: number; vx: number; vy: number; dx: number; dy: number; t: number }
export type GhostState = 'idle' | 'wait' | 'chase' | 'gone';
export interface Ghost { grave: string; idx: number; state: GhostState; x: number; y: number; target: string | null; waitT: number; hits: string[] }
export interface GraveState { o: PlacedObject; flowers: number; broken: number; ghosts: Ghost[] }
const GHOST_STATES: GhostState[] = ['idle', 'wait', 'chase', 'gone'];
/** where a dead plane slot parks: far off the map, zero size, so nothing can touch it */
const OFF: Rect = { x: -100000, y: -100000, w: 0, h: 0 };

interface Hz { o: PlacedObject; kind: string; phase: number; slowable: boolean; pathLen: number; beam: number }

export interface SimMover {
  id: string; o: PlacedObject; child: number; hz: Hz | null; rect: Rect; prev: Rect;
  /** paper plane slot (soft: crumples rather than crushing) */
  plane?: Plane;
  /** a fixed, top-only platform (gravestone dirt pile) */
  fixed?: boolean;
  /** ice laid on this moving platform */
  ice?: boolean;
}

/** hp counts down per interaction (new landing, new wall-slide contact, unique projectile impact); 0 means broken for the round. */
interface CrumbleState { o: PlacedObject; rect: Rect; hp: number; broken: boolean; touch: Map<string, number>; impacts: Set<string> }

export interface RaceOptions { roundKey: string; maxTicks: number; seed?: number; /** human players in the race (gravestone flowers); defaults to everyone */ humans?: number }

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
  private holes: HoleInfo[] = [];
  private springs: { o: PlacedObject; r: Rect }[] = [];
  /** barbed wire riding a moving platform: its strips follow the platform's displacement from its starting pose */
  moverWires: { o: PlacedObject; m: SimMover; base: Rect }[] = [];
  fans: FanField[] = [];
  makers: PlacedObject[] = [];
  graves: GraveState[] = [];
  turrets: { o: PlacedObject; cd: number }[] = [];
  /** players who have already angered a ghost this round */
  angered = new Set<string>();
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
        case 'coin': if (world.consumed.has(o.id)) break; this.coins.push({ id: o.id, ox: c.x, oy: c.y, x: c.x, y: c.y, state: 'origin', carrier: null }); break;
        case 'power': this.pickups.push({ id: o.id, x: c.x, y: c.y, power: def.power!, available: true }); break;
        case 'blackhole': this.holes.push({ x: c.x, y: c.y, owner: o.owner, src: o.id }); break;
        case 'spring': this.springs.push({ o, r: springRect(o) }); break;
        case 'crumble': {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const [x, y] of o.cells) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
          this.crumbles.set(o.id, { o, rect: { x: minX * CELL, y: minY * CELL, w: (maxX - minX + 1) * CELL, h: (maxY - minY + 1) * CELL }, hp: HAZARD.crumbleHits, broken: false, touch: new Map(), impacts: new Set() });
          break;
        }
        case 'rspikes': case 'saw': case 'laser': case 'pendulum': case 'moving': case 'sniper': case 'cannon': case 'crossbow': {
          const h: Hz = { o, kind: def.kind, phase: 0, slowable: def.slowable, pathLen: 0, beam: 0 };
          if (def.kind === 'moving') h.pathLen = moverPathLen();
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
    // batch-update items: paper plane slots, gravestone dirt piles, fans, turrets, ice riding moving platforms
    const nComp = playerIds.length, nHum = Math.max(1, Math.min(nComp, opts.humans ?? nComp));
    for (const o of world.objects.values()) {
      const k = getItem(o.item).kind;
      if (k === 'planemaker') {
        this.makers.push(o);
        for (let i = 0; i < NEWITEMS.planeSlots; i++) {
          const plane: Plane = { slot: this.movers.length, alive: false, x: OFF.x, y: OFF.y, w: 0, h: 0, vx: 0, vy: 0, dx: 0, dy: 0, t: 0 };
          this.movers.push({ id: `${o.id}#p${i}`, o, child: 1000 + i, hz: null, rect: { ...OFF }, prev: { ...OFF }, plane });
        }
      }
      if (k === 'grave') {
        const r = graveDirt(o);
        this.movers.push({ id: `${o.id}#dirt`, o, child: -1, hz: null, rect: r, prev: { ...r }, fixed: true });
        const ghosts: Ghost[] = Array.from({ length: nComp }, (_, i) => { const p = ghostOrbit(o, i, nComp, 0); return { grave: o.id, idx: i, state: 'idle' as GhostState, x: p.x, y: p.y, target: null, waitT: 0, hits: [] }; });
        this.graves.push({ o, flowers: nHum, broken: 0, ghosts });
      }
      if (k === 'turret') this.turrets.push({ o, cd: 0 });
      if (k === 'ice' && o.attach) for (const m of this.movers) if (m.o.id === o.attach && !m.plane && !m.fixed) m.ice = true;
    }
    this.fans = fanFields(world);
    this.lethal = staticLethal(world);
    for (const o of world.objects.values()) {
      if (getItem(o.item).kind !== 'wire') continue;
      const sup = onMover(world, o);
      const m = sup ? this.movers.find(mm => mm.o.id === sup.id) : undefined;
      if (sup && m) this.moverWires.push({ o, m, base: m.hz ? moverBaseRect(sup) : childRect(sup, 0, 0) });
    }
  }

  /** Lethal strips of a wire riding a moving platform, where they are this tick (or for a given platform rect). */
  moverWireRects(w: { o: PlacedObject; base: Rect }, rect: Rect): Rect[] {
    const dx = rect.x - w.base.x, dy = rect.y - w.base.y;
    return w.o.cells.map(([x, y]) => { const r = wireStripPx(x, y, w.o.rot); return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }; });
  }

  /** Mover poses at an arbitrary tick: kinematic bodies exactly, legacy ones at their current phase. */
  moversAt(tick: number, legacy?: (m: SimMover) => { rect: Rect; prev: Rect }): Mover[] {
    return this.movers.map(m => {
      let r: Rect, pr: Rect;
      if (m.plane) { r = planeRectAt(m.plane, tick); pr = planeRectAt(m.plane, tick - 1); }
      else if (m.fixed) { r = m.rect; pr = m.rect; }
      else if (m.hz) { const l = legacy ? legacy(m) : { rect: m.rect, prev: m.prev }; r = l.rect; pr = l.prev; }
      else { r = childRect(m.o, m.child, tick); pr = childRect(m.o, m.child, tick - 1); }
      return { x: r.x, y: r.y, w: r.w, h: r.h, dx: r.x - pr.x, dy: r.y - pr.y, id: m.id, soft: !!m.plane, top: !!m.fixed, ice: !!m.ice };
    });
  }

  /** Where a mover is drawn or tested at a tick (kinematic bodies exactly, planes extrapolated, the rest as mirrored). */
  moverRectAt(m: SimMover, tick: number): Rect {
    if (m.plane) return planeRectAt(m.plane, tick);
    if (m.fixed || m.hz) return m.rect;
    return childRect(m.o, m.child, tick);
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
    return this.movers.map(m => ({ x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h, dx: m.rect.x - m.prev.x, dy: m.rect.y - m.prev.y, id: m.id, soft: !!m.plane, top: !!m.fixed, ice: !!m.ice }));
  }

  /** Physics environment for one player (shared with client prediction). */
  envFor(p: RacePlayer, movers: Mover[]): PhysEnv {
    return {
      world: this.world, isSolid: this.isSolid, movers,
      speedMul: p.effects.speed > 0 ? POWER.speedMul : 1,
      jumpMul: p.effects.jump > 0 ? POWER.jumpMul : 1,
      accel: this.holes.length || this.fans.length ? (b: Body) => this.fieldPull(b, p) : undefined,
    };
  }

  /** Black holes plus fan wind on a player's body. */
  fieldPull(b: Body, p: RacePlayer | null): { ax: number; ay: number } | null {
    const h = this.holes.length ? this.holePull(b, p) : null;
    if (!this.fans.length) return h;
    const c = bodyCenter(b);
    if (this.world.inProtectedPx(c.x, c.y)) return h;
    const f = fanAccel(this.fans, c.x, c.y, b.vx, b.vy);
    if (!f) return h;
    return h ? { ax: h.ax + f.ax, ay: h.ay + f.ay } : f;
  }

  /** Black hole attraction (see field.ts): softened falloff, occlusion by solids, capped, ignored in protected zones. */
  holePull(b: Body, p: RacePlayer | null): { ax: number; ay: number } | null {
    const c = bodyCenter(b);
    if (this.world.inProtectedPx(c.x, c.y)) return null;
    const f = fieldAccel(this.holes, c.x, c.y, this.blockedFn);
    if (!f) return null;
    if (p && f.src && f.strongest > 120) p.lastPull = { owner: f.src.owner, src: f.src.src, tick: this.tick };
    return { ax: f.ax, ay: f.ay };
  }
  private blockedFn = (x0: number, y0: number, x1: number, y1: number) => this.rayBlocked(x0, y0, x1, y1);

  /** Grid ray test between two points through dynamic solids. */
  rayBlocked(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.rayHitT(x0, y0, x1, y1) >= 0;
  }

  /** Earliest t in [0,1] where segment enters a solid cell (exact grid traversal) or a mover. -1 if none. */
  rayHitT(x0: number, y0: number, x1: number, y1: number): number {
    return this.rayHit(x0, y0, x1, y1).t;
  }

  /** As rayHitT, plus the cell that was entered (null when the hit was a moving platform or nothing). */
  rayHit(x0: number, y0: number, x1: number, y1: number): { t: number; cx: number; cy: number } {
    let best = -1, bx = 0, by = 0;
    let cx = Math.floor(x0 / CELL), cy = Math.floor(y0 / CELL);
    const ex = Math.floor(x1 / CELL), ey = Math.floor(y1 / CELL);
    const dx = x1 - x0, dy = y1 - y0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX ? Math.abs(CELL / dx) : Infinity, tDeltaY = stepY ? Math.abs(CELL / dy) : Infinity;
    let tMaxX = stepX > 0 ? ((cx + 1) * CELL - x0) / dx : stepX < 0 ? (cx * CELL - x0) / dx : Infinity;
    let tMaxY = stepY > 0 ? ((cy + 1) * CELL - y0) / dy : stepY < 0 ? (cy * CELL - y0) / dy : Infinity;
    let t = 0;
    if (this.isSolid(cx, cy) && this.world.inBounds(cx, cy)) { best = 0; bx = cx; by = cy; }
    for (let guard = 0; best < 0 && guard < 400 && (cx !== ex || cy !== ey); guard++) {
      if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; } else { t = tMaxY; tMaxY += tDeltaY; cy += stepY; }
      if (t > 1) break;
      if (this.world.inBounds(cx, cy) && this.isSolid(cx, cy)) { best = t; bx = cx; by = cy; }
    }
    let viaCell = best >= 0;
    for (const m of this.movers) {
      if (m.plane || m.fixed) continue; // planes are handled by the projectile code; dirt piles never stop a shot
      // relative motion: test the segment in the platform's frame so fast shots and moving bodies never tunnel
      const mt = segRect(x0 + (m.rect.x - m.prev.x), y0 + (m.rect.y - m.prev.y), x1, y1, m.rect);
      if (mt >= 0 && (best < 0 || mt < best)) { best = mt; viaCell = false; }
    }
    return { t: best, cx: viaCell ? bx : -1, cy: viaCell ? by : -1 };
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
    for (const m of this.movers) { if (m.plane || m.fixed) continue; m.prev = m.rect; m.rect = m.hz ? moverRect(m.o, m.hz.phase, m.hz.pathLen) : childRect(m.o, m.child, this.tick); }
    this.updatePlanes();
    const movers = this.moverList();

    this.fireLaunchers(slow);
    this.fireTurrets();

    // movement
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      const inp = p.connected ? inputs.get(p.id) ?? 0 : 0; // disconnect clears held inputs
      stepBody(p.body, inp, this.envFor(p, movers));
      if (p.body.crushMover >= 0) { this.crush(p, p.body.crushMover); continue; }
      if (p.body.jumped || p.body.wallJumped) this.emit({ id: `${this.opts.roundKey}:j:${p.id}:${this.tick}`, t: this.tick, type: 'jump', pid: p.id, wall: p.body.wallJumped });
      const e = p.effects;
      if (e.speed > 0) e.speed -= DT;
      if (e.jump > 0) e.jump -= DT;
      if (e.shield > 0) e.shield -= DT;
      if (e.immune > 0) e.immune -= DT;
      if (p.springCd > 0) p.springCd -= DT;
    }

    this.landOnPlanes();
    this.updateGhosts();
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

  private fireLaunchers(_slow: number) {
    for (const h of this.hz) {
      let fire = false;
      if (h.kind === 'sniper') fire = this.tick % Math.round(HAZARD.sniperInterval * TICK_HZ) === 0; // exact 2.5 s cadence from GO
      else if (h.kind === 'cannon') fire = this.tick % Math.round(HAZARD.cannonInterval * TICK_HZ) === 0;
      else if (h.kind === 'crossbow') fire = this.tick % Math.round(HAZARD.crossbowInterval * TICK_HZ) === 0; // exactly once a second
      if (!fire) continue;
      const m = muzzle(h.o), d = launcherDir(h.o);
      if (this.world.inProtectedPx(m.x, m.y)) continue;
      if (h.kind === 'sniper') {
        this.emit({ id: `${this.opts.roundKey}:f:${h.o.id}:${this.tick}`, t: this.tick, type: 'fire', src: h.o.id, kind: 'sniper' });
        this.fireSniper(h.o, m);
        continue;
      }
      if (this.projectiles.length >= MATCH.maxProjectiles) continue;
      const kind: ProjKind = h.kind === 'cannon' ? 'cannon' : 'arrow';
      const speed = kind === 'cannon' ? HAZARD.cannonMuzzleSpeed : HAZARD.arrowSpeed;
      const r = kind === 'cannon' ? HAZARD.cannonBallR : 4;
      this.projectiles.push({ id: this.projSeq++, kind, owner: h.o.owner, src: h.o.id, x: m.x, y: m.y, vx: d.x * speed, vy: d.y * speed, r, age: 0, hit: [], alive: true });
      this.emit({ id: `${this.opts.roundKey}:f:${h.o.id}:${this.tick}`, t: this.tick, type: 'fire', src: h.o.id, kind });
    }
  }

  // ---- paper planes: fixed mover slots per maker, so mover indices never shift under riders
  private planeSlots(o: PlacedObject) { return this.movers.filter(m => m.plane && m.o.id === o.id); }

  private updatePlanes() {
    if (!this.makers.length) return;
    // launch on an exact cadence from GO, like the other launchers
    if (this.tick % Math.round(NEWITEMS.planeInterval * TICK_HZ) === 0) for (const o of this.makers) {
      const r = planeSpawnRect(o);
      if (this.world.inProtectedPx(r.x + r.w / 2, r.y + r.h / 2)) continue;
      const slot = this.planeSlots(o).find(m => !m.plane!.alive);
      if (!slot) continue;
      const d = planeDir(o), p = slot.plane!;
      Object.assign(p, { alive: true, x: r.x, y: r.y, w: r.w, h: r.h, vx: d.x * NEWITEMS.planeSpeed, vy: d.y * NEWITEMS.planeSpeed, dx: d.x, dy: d.y, t: this.tick });
      slot.rect = { ...r }; slot.prev = { ...r };
      this.emit({ id: `${this.opts.roundKey}:pl:${o.id}:${this.tick}`, t: this.tick, type: 'plane', src: o.id });
    }
    const alive = this.movers.filter(m => m.plane?.alive);
    for (const m of alive) {
      const p = m.plane!;
      if (!p.alive || p.t === this.tick) continue; // crumpled by another plane this tick, or launched this tick
      // fans: wind across the flight path makes it strafe; flying straight into the wind crumples it close to the fan
      let sx = 0, sy = 0;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      for (const f of this.fans) {
        const d = fanDist(f, cx, cy);
        if (d === null) continue;
        const dot = f.dir.x * p.dx + f.dir.y * p.dy;
        if (dot < -0.5) { if (d <= NEWITEMS.planeHeadwindCells * CELL) { this.crumplePlane(m); break; } }
        else if (Math.abs(dot) < 0.5) { sx = f.dir.x * NEWITEMS.planeStrafe; sy = f.dir.y * NEWITEMS.planeStrafe; }
      }
      if (!p.alive) continue;
      // within 4.5 cells of a black hole it is crumpled and sucked in
      const hole = this.holes.find(h => Math.hypot(h.x - cx, h.y - cy) <= NEWITEMS.planeHoleCrumple);
      if (hole) { this.crumplePlane(m, hole); continue; }
      const vx = p.dx * NEWITEMS.planeSpeed + sx, vy = p.dy * NEWITEMS.planeSpeed + sy;
      const next: Rect = { x: p.x + vx * DT, y: p.y + vy * DT, w: p.w, h: p.h };
      if (this.planeBlocked(m, next)) { this.crumplePlane(m); continue; }
      m.prev = m.rect; m.rect = next;
      p.x = next.x; p.y = next.y; p.vx = vx; p.vy = vy; p.t = this.tick;
    }
  }

  /** Would a plane at `r` hit something that crumples it: a solid, an object, a moving body, a blade, a player, the map edge? */
  private planeBlocked(m: SimMover, r: Rect): boolean {
    const w = this.world;
    if (r.x < 0 || r.y < 0 || r.x + r.w > w.w * CELL || r.y + r.h > w.h * CELL) return true;
    if (w.protectedPx.some(z => rectsOverlap(z, r))) return true;
    const x0 = Math.floor(r.x / CELL), x1 = Math.floor((r.x + r.w - 0.01) / CELL), y0 = Math.floor(r.y / CELL), y1 = Math.floor((r.y + r.h - 0.01) / CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      if (this.isSolid(cx, cy)) return true;
      const id = w.occAt(cx, cy);
      if (!id || id === m.o.id) continue;
      const o = id === 'terrain' ? null : w.objects.get(id);
      if (!o) continue;
      if (!PLANE_PASSES.has(getItem(o.item).kind)) return true;
    }
    for (const other of this.movers) {
      if (other === m || other.fixed) continue;
      if (other.plane && !other.plane.alive) continue;
      if (rectsOverlap(other.rect, r)) { if (other.plane) this.crumplePlane(other); return true; }
    }
    for (const h of this.hz) {
      if (h.kind === 'saw') { const sp = sawPos(h.o, h.phase); if (circleRect(sp.x, sp.y, HAZARD.sawR, r)) return true; }
      if (h.kind === 'pendulum') { const b = pendulumPos(h.o, h.phase).ball; if (circleRect(b.x, b.y, HAZARD.pendulumBallR, r)) return true; }
    }
    // a player in the way (its nose included); riders on top never count because they only touch its top edge
    const tol = 0.5;
    for (const pl of this.players) {
      if (pl.status !== 'racing') continue;
      const b = pl.body;
      if (b.x < r.x + r.w - tol && b.x + W > r.x + tol && b.y < r.y + r.h - tol && b.y + H > r.y + tol) return true;
    }
    return false;
  }

  crumplePlane(m: SimMover, hole?: HoleInfo) {
    const p = m.plane!;
    if (!p.alive) return;
    p.alive = false;
    this.emit({ id: `${this.opts.roundKey}:cp:${m.id}:${this.tick}`, t: this.tick, type: 'crumple', x: p.x + p.w / 2, y: p.y + p.h / 2, dx: p.dx, dy: p.dy, hx: hole?.x, hy: hole?.y });
    p.x = OFF.x; p.y = OFF.y; p.w = 0; p.h = 0; p.vx = 0; p.vy = 0;
    m.rect = { ...OFF }; m.prev = { ...OFF };
  }

  /** Landing on a plane that is flying upward crumples it; downward planes carry their rider down. */
  private landOnPlanes() {
    for (const pl of this.players) {
      if (pl.status !== 'racing' || !pl.body.grounded || pl.body.groundMover < 0) continue;
      const m = this.movers[pl.body.groundMover];
      if (m?.plane?.alive && m.plane.dy < 0) this.crumplePlane(m);
    }
  }

  // ---- dart turrets: aim at the closest visible player within 6 cells
  private fireTurrets() {
    for (const t of this.turrets) {
      if (t.cd > 0) { t.cd -= DT; if (t.cd > 0) continue; }
      const c = cellCenter(t.o.x, t.o.y);
      let best: { d: number; ux: number; uy: number } | null = null;
      for (const pl of this.players) {
        if (pl.status !== 'racing') continue;
        const pc = bodyCenter(pl.body);
        const d = Math.hypot(pc.x - c.x, pc.y - c.y);
        if (d > NEWITEMS.turretRange || d < 1 || (best && d >= best.d)) continue;
        const ux = (pc.x - c.x) / d, uy = (pc.y - c.y) / d;
        const k = (CELL / 2 + 2) / Math.max(Math.abs(ux), Math.abs(uy));
        const mx = c.x + ux * k, my = c.y + uy * k;
        const hit = this.rayHitT(mx, my, pc.x, pc.y);
        if (hit >= 0 && hit < 1) continue; // a wall is in the way: it can't see them
        best = { d, ux, uy };
      }
      if (!best) { t.cd = 0; continue; }
      const k = (CELL / 2 + 2) / Math.max(Math.abs(best.ux), Math.abs(best.uy));
      const mx = c.x + best.ux * k, my = c.y + best.uy * k;
      if (this.world.inProtectedPx(mx, my) || this.projectiles.length >= MATCH.maxProjectiles) { t.cd = 0; continue; }
      t.cd = NEWITEMS.turretInterval;
      this.projectiles.push({ id: this.projSeq++, kind: 'dart', owner: t.o.owner, src: t.o.id, x: mx, y: my, vx: best.ux * NEWITEMS.dartSpeed, vy: best.uy * NEWITEMS.dartSpeed, r: NEWITEMS.dartR, age: 0, hit: [], alive: true });
      this.emit({ id: `${this.opts.roundKey}:f:${t.o.id}:${this.tick}`, t: this.tick, type: 'fire', src: t.o.id, kind: 'dart' });
    }
  }

  // ---- gravestones and their ghosts
  private updateGhosts() {
    if (!this.graves.length) return;
    const time = this.tick / TICK_HZ;
    for (const pl of this.players) {
      if (pl.status !== 'racing' || this.angered.has(pl.id)) continue;
      const br = bodyRect(pl.body);
      for (const g of this.graves) {
        if (!rectsOverlap(br, graveStone(g.o))) continue;
        const ghost = g.ghosts.find(x => x.state === 'idle');
        if (!ghost) continue;
        this.angered.add(pl.id);
        if (g.broken < g.flowers) g.broken++;
        ghost.state = 'wait'; ghost.waitT = NEWITEMS.ghostWait; ghost.target = pl.id;
        this.emit({ id: `${this.opts.roundKey}:gh:${g.o.id}:${pl.id}`, t: this.tick, type: 'ghost', grave: g.o.id, pid: pl.id });
        break;
      }
    }
    for (const g of this.graves) for (const gh of g.ghosts) {
      if (gh.state === 'idle') { const p = ghostOrbit(g.o, gh.idx, g.ghosts.length, time); gh.x = p.x; gh.y = p.y; continue; }
      if (gh.state === 'gone') continue;
      const target = gh.target ? this.player(gh.target) : undefined;
      // the ghost gives up once its target is out of the race (finished, dead or out of time)
      if (!target || target.status !== 'racing') { gh.state = 'gone'; continue; }
      if (gh.state === 'wait') { gh.waitT -= DT; if (gh.waitT <= 0) gh.state = 'chase'; continue; }
      // straight through walls, unaffected by projectiles, holes, fans and the slow pulse
      const tc = bodyCenter(target.body);
      const dx = tc.x - gh.x, dy = tc.y - gh.y, d = Math.hypot(dx, dy);
      const step = NEWITEMS.ghostSpeed * DT;
      if (d > step) { gh.x += (dx / d) * step; gh.y += (dy / d) * step; } else { gh.x = tc.x; gh.y = tc.y; }
      for (const pl of this.players) {
        if (pl.status !== 'racing' || !circleRect(gh.x, gh.y, NEWITEMS.ghostR, bodyRect(pl.body))) continue;
        if (pl.id === gh.target) { this.lethalHit(pl, g.o.owner, 'ghost', g.o.id); gh.state = 'gone'; break; }
        if (!gh.hits.includes(pl.id)) { gh.hits.push(pl.id); this.lethalHit(pl, g.o.owner, 'ghost', g.o.id); }
      }
    }
  }

  // ---- crumbling platforms: two interactions per round, then gone until the next round
  /** One interaction. `impact` is a unique id (a landing, a wall-slide episode or one projectile/shot), processed at most once. */
  private damageCrumble(id: string, impact: string) {
    const c = this.crumbles.get(id);
    if (!c || c.broken || c.impacts.has(impact)) return;
    c.impacts.add(impact);
    c.hp = Math.max(0, c.hp - 1);
    if (c.hp === 0) c.broken = true;
    this.emit({ id: `${this.opts.roundKey}:cr:${id}:${c.hp}`, t: this.tick, type: 'crumble', obj: id, hp: c.hp });
  }

  private updateCrumbles() {
    if (!this.crumbles.size) return;
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      const b = p.body;
      const touched: string[] = [];
      if (b.grounded && b.groundObj && this.crumbles.has(b.groundObj)) touched.push(b.groundObj);
      if (b.wallSliding && b.wallObj && this.crumbles.has(b.wallObj) && !touched.includes(b.wallObj)) touched.push(b.wallObj);
      for (const id of touched) {
        const c = this.crumbles.get(id)!;
        const last = c.touch.get(p.id);
        c.touch.set(p.id, this.tick);
        // contact that resumes within the debounce gap is the same episode; a landing then a wall-slide on one block is one too
        if (last !== undefined && this.tick - last <= HAZARD.crumbleDebounceTicks) continue;
        this.damageCrumble(id, `${p.id}@${this.tick}`);
      }
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
      // black holes pull projectiles with the same field as players; momentum is kept, nothing is teleported
      if (this.holes.length && !this.world.inProtectedPx(pr.x, pr.y)) {
        const f = fieldAccel(this.holes, pr.x, pr.y, this.blockedFn, HAZARD.holeProjectileMul);
        if (f) {
          const before = Math.hypot(pr.vx, pr.vy);
          pr.vx += f.ax * DT; pr.vy += f.ay * DT;
          const after = Math.hypot(pr.vx, pr.vy), limit = Math.max(before, HAZARD.holeMaxSpeed);
          if (after > limit) { pr.vx *= limit / after; pr.vy *= limit / after; }
        }
      }
      // fans push projectiles along their wind (a share of the force players feel)
      if (this.fans.length && !this.world.inProtectedPx(pr.x, pr.y)) {
        const f = fanAccel(this.fans, pr.x, pr.y, pr.vx, pr.vy, NEWITEMS.fanProjectileMul, false);
        if (f) { pr.vx += f.ax * DT; pr.vy += f.ay * DT; }
      }
      const x1 = pr.x + pr.vx * DT, y1 = pr.y + pr.vy * DT;
      const ray = this.rayHit(pr.x, pr.y, x1, y1);
      let tBlock = ray.t, blockCell: [number, number] | null = ray.cx >= 0 ? [ray.cx, ray.cy] : null;
      for (const z of this.world.protectedPx) {
        const tz = segRect(pr.x, pr.y, x1, y1, z);
        if (tz >= 0 && (tBlock < 0 || tz < tBlock)) { tBlock = tz; blockCell = null; }
      }
      // a black hole's core swallows the projectile at its closest approach; anything earlier on the path still counts
      let absorbed: { t: number; hole: HoleInfo } | null = null;
      for (const h of this.holes) {
        const c = closestOnSegment(pr.x, pr.y, x1, y1, h.x, h.y);
        if (c.d <= HAZARD.holeCore + pr.r * 0.5 && (!absorbed || c.t < absorbed.t)) absorbed = { t: c.t, hole: h };
      }
      if (absorbed && (tBlock < 0 || absorbed.t < tBlock)) { tBlock = absorbed.t; blockCell = null; } else absorbed = null;
      // a paper plane in the way crumples, and the projectile goes with it
      let planeHit: SimMover | null = null;
      for (const m of this.movers) {
        if (!m.plane?.alive) continue;
        const r = m.rect;
        const tp = segRect(pr.x, pr.y, x1, y1, { x: r.x - pr.r, y: r.y - pr.r, w: r.w + pr.r * 2, h: r.h + pr.r * 2 });
        if (tp >= 0 && (tBlock < 0 || tp < tBlock)) { tBlock = tp; blockCell = null; absorbed = null; planeHit = m; }
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
        if (pr.kind === 'dart') continue; // darts pierce players and keep going
        stopT = h.t; break; // arrows break and cannonballs stop on the first player
      }
      if (stopT >= 0) { pr.x += (x1 - pr.x) * stopT; pr.y += (y1 - pr.y) * stopT; pr.alive = false; continue; }
      if (planeHit) { this.crumplePlane(planeHit); pr.x += (x1 - pr.x) * tBlock; pr.y += (y1 - pr.y) * tBlock; pr.alive = false; continue; }
      if (tBlock >= 0) {
        pr.x += (x1 - pr.x) * tBlock; pr.y += (y1 - pr.y) * tBlock; pr.alive = false;
        if (absorbed) this.emit({ id: `${this.opts.roundKey}:ab:${pr.id}`, t: this.tick, type: 'absorb', x: absorbed.hole.x, y: absorbed.hole.y });
        else if (blockCell) {
          const owner = this.world.collObj[this.world.idx(blockCell[0], blockCell[1])];
          if (owner) this.damageCrumble(owner, `proj${pr.id}`); // one interaction per projectile, even if it breaks the block
        }
        continue;
      }
      pr.x = x1; pr.y = y1;
      if (pr.x < 0 || pr.y < 0 || pr.x > wpx || pr.y > hpx || pr.age > HAZARD.projectileLifetime) pr.alive = false;
    }
    if (this.projectiles.some(p => !p.alive)) this.projectiles = this.projectiles.filter(p => p.alive);
  }

  // ---- sniper: an instantaneous authoritative query on the firing tick
  /**
   * The shot lands on the tick it fires (see traceShot in field.ts for the path, including the black-hole bend). It
   * pierces players in path order, stops at the first solid, protected zone or hole core, and is length-bounded.
   */
  private fireSniper(o: PlacedObject, m: Vec) {
    const d0 = launcherDir(o);
    const shotId = `${this.opts.roundKey}:sn:${o.id}:${this.tick}`;
    const hit = new Set<string>();
    const segment = (ax: number, ay: number, bx: number, by: number): ShotSeg => {
      const ray = this.rayHit(ax, ay, bx, by);
      let tBlock = ray.t, cell: [number, number] | null = ray.cx >= 0 ? [ray.cx, ray.cy] : null;
      for (const z of this.world.protectedPx) {
        const tz = segRect(ax, ay, bx, by, z);
        if (tz >= 0 && (tBlock < 0 || tz < tBlock)) { tBlock = tz; cell = null; }
      }
      const limit = tBlock < 0 ? 1 : tBlock;
      const found: { p: RacePlayer; t: number }[] = [];
      for (const p of this.players) {
        if (p.status !== 'racing' || hit.has(p.id)) continue;
        const r = bodyRect(p.body);
        const t = segRect(ax, ay, bx, by, { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 });
        if (t >= 0 && t <= limit) found.push({ p, t });
      }
      found.sort((a, b) => a.t - b.t);
      for (const f of found) { hit.add(f.p.id); this.lethalHit(f.p, o.owner, 'sniper', o.id); } // pierces players
      // sniper rounds pass straight through paper planes, crumpling them
      for (const m of this.movers) if (m.plane?.alive) { const tp = segRect(ax, ay, bx, by, m.rect); if (tp >= 0 && tp <= limit) this.crumplePlane(m); }
      if (tBlock < 0) return { stop: false, ex: bx, ey: by };
      if (cell) {
        const owner = this.world.collObj[this.world.idx(cell[0], cell[1])];
        if (owner) this.damageCrumble(owner, shotId); // one interaction, and the shot ends here even if the block breaks
      }
      return { stop: true, ex: ax + (bx - ax) * tBlock, ey: ay + (by - ay) * tBlock };
    };
    const pts = traceShot(this.holes, m.x, m.y, d0.x, d0.y, this.blockedFn, segment, { w: this.world.w * CELL, h: this.world.h * CELL });
    this.emit({ id: shotId, t: this.tick, type: 'shot', src: o.id, pts: pts.map(v => Math.round(v * 10) / 10) });
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

  /** A platform squeezed this player against something solid. One deterministic death; shields cannot make a body fit. */
  private crush(p: RacePlayer, moverIdx: number) {
    const m = this.movers[moverIdx];
    this.kill(p, m ? m.o.owner : null, 'crush', m ? m.o.id : null);
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
    if (this.lethal.ovals.some(l => ovalHitsRect(l.ov, probe))) return true;
    if (this.lethal.circles.some(l => circleRect(l.x, l.y, l.r, probe))) return true;
    return false;
  }

  private checkHazards() {
    for (const p of this.players) {
      if (p.status !== 'racing') continue;
      const br = bodyRect(p.body);
      for (const l of this.lethal.rects) if (rectsOverlap(br, l.r)) { this.lethalHit(p, l.owner, getItem(this.world.objects.get(l.src)!.item).kind, l.src); break; }
      if (p.status !== 'racing') continue;
      for (const l of this.lethal.ovals) if (ovalHitsRect(l.ov, br)) { this.lethalHit(p, l.owner, 'oval', l.src); break; }
      if (p.status !== 'racing') continue;
      for (const l of this.lethal.circles) if (circleRect(l.x, l.y, l.r, br)) { this.lethalHit(p, l.owner, 'blackhole', l.src); break; }
      if (p.status !== 'racing') continue;
      for (const mw of this.moverWires) if (this.moverWireRects(mw, mw.m.rect).some(r => rectsOverlap(br, r))) { this.lethalHit(p, mw.o.owner, 'wire', mw.o.id); break; }
      if (p.status !== 'racing') continue;
      for (const h of this.hz) {
        let hit = false;
        if (h.kind === 'rspikes') { if (rspikeState(h.phase) === 'out') hit = rspikeParts(h.o).spikes.some(([x, y]) => rectsOverlap(br, spikeStripPx(x, y, h.o.rot))); }
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
      for (const g of this.graves) for (const gh of g.ghosts) if (gh.target === p.id && gh.state !== 'idle') gh.state = 'gone'; // reaching the flag loses the ghost
      this.emit({ id: `${this.opts.roundKey}:finish:${p.id}`, t: this.tick, type: 'finish', pid: p.id, tick: this.tick });
      for (const id of p.coins) {
        const coin = this.coins.find(k => k.id === id);
        if (!coin || coin.state !== 'carried') continue;
        coin.state = 'banked'; coin.carrier = p.id;
        this.emit({ id: `${this.opts.roundKey}:bank:${id}`, t: this.tick, type: 'bank', pid: p.id, coin: id });
      }
      p.coins = p.coins.filter(id => this.coins.find(k => k.id === id)?.state === 'carried'); // banked coins leave the carrier for good
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
      crumble: [...this.crumbles.values()].filter(c => c.hp < HAZARD.crumbleHits).map(c => [c.o.id, c.hp] as [string, number]),
      hz: this.hz.map(h => r3(h.phase)),
      pl: this.movers.filter(m => m.plane?.alive).map(m => [m.plane!.slot, r1(m.plane!.x), r1(m.plane!.y), r1(m.plane!.vx), r1(m.plane!.vy), m.plane!.dx, m.plane!.dy] as PlaneSnap),
      gh: this.graves.flatMap(g => g.ghosts.filter(x => x.state !== 'idle').map(x => [g.o.id, x.idx, GHOST_STATES.indexOf(x.state), r1(x.x), r1(x.y), x.target ?? ''] as GhostSnap)),
      gb: this.graves.filter(g => g.broken > 0).map(g => [g.o.id, g.broken] as [string, number]),
    };
  }

  /** Apply a server snapshot to a client-side mirror (for rendering and prediction environment). */
  applySnapshot(s: RaceSnapshot) {
    this.tick = s.tick;
    this.slowTicks = s.slow;
    s.hz.forEach((ph, i) => { if (this.hz[i]) this.hz[i].phase = ph; });
    for (const m of this.movers) {
      if (m.plane || m.fixed) continue;
      if (m.hz) { m.rect = moverRect(m.o, m.hz.phase, m.hz.pathLen); m.prev = { ...m.rect }; }
      else { m.rect = childRect(m.o, m.child, this.tick); m.prev = childRect(m.o, m.child, this.tick - 1); }
    }
    // paper planes: every slot not in the snapshot is empty
    const live = new Map((s.pl ?? []).map(p => [p[0], p]));
    for (const m of this.movers) {
      if (!m.plane) continue;
      const ps = live.get(m.plane.slot);
      const p = m.plane;
      if (!ps) { p.alive = false; m.rect = { ...OFF }; m.prev = { ...OFF }; continue; }
      const horiz = ps[5] !== 0;
      Object.assign(p, { alive: true, x: ps[1], y: ps[2], vx: ps[3], vy: ps[4], dx: ps[5], dy: ps[6], t: s.tick, w: horiz ? NEWITEMS.planeLen : NEWITEMS.planeThick, h: horiz ? NEWITEMS.planeThick : NEWITEMS.planeLen });
      m.rect = planeRectAt(p, s.tick); m.prev = planeRectAt(p, s.tick - 1);
    }
    // ghosts and flowers
    const ghs = new Map((s.gh ?? []).map(g => [`${g[0]}#${g[1]}`, g]));
    const broken = new Map(s.gb ?? []);
    for (const g of this.graves) {
      g.broken = broken.get(g.o.id) ?? 0;
      for (const gh of g.ghosts) {
        const x = ghs.get(`${g.o.id}#${gh.idx}`);
        if (!x) { gh.state = 'idle'; gh.target = null; continue; }
        gh.state = GHOST_STATES[x[2]]; gh.x = x[3]; gh.y = x[4]; gh.target = x[5] || null;
      }
    }
    const dmg = new Map(s.crumble);
    for (const c of this.crumbles.values()) { c.hp = dmg.get(c.o.id) ?? HAZARD.crumbleHits; c.broken = c.hp <= 0; }
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

/** A plane's rect at a tick, extrapolated from its last known state (straight flight between snapshots). */
export function planeRectAt(p: Plane, tick: number): Rect {
  if (!p.alive) return { ...OFF };
  const k = (tick - p.t) / TICK_HZ;
  return { x: p.x + p.vx * k, y: p.y + p.vy * k, w: p.w, h: p.h };
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
/** slot, x, y, vx, vy, dir x, dir y */
export type PlaneSnap = [number, number, number, number, number, number, number];
/** grave id, ghost index, state index, x, y, target id ('' none) */
export type GhostSnap = [string, number, number, number, number, string];
export interface PlayerSnap {
  id: string; x: number; y: number; vx: number; vy: number; st: PlayerStatus; f: number; g: number; wd: number; ws: number; wr: number;
  co: number; jb: number; pj: number; jr: number; at: number; ad: number; lt: number; dt: number; gm: number;
  e: [number, number, number, number]; c: number; ack: number; cn: number; sc: number;
}
export interface RaceSnapshot {
  tick: number; slow: number; players: PlayerSnap[]; proj: ProjSnap[];
  coins: { id: string; s: CoinPhase; x: number; y: number; c: string | null }[];
  pick: string[]; crumble: [string, number][]; hz: number[];
  pl?: PlaneSnap[]; gh?: GhostSnap[]; gb?: [string, number][];
}
