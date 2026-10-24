// Navigation by simulation. Every edge is a recorded input script run through the real physics step from a standing
// position, so route checks and bots use exactly the movement players have: sprint jumps, air steering, wall slides
// and unlimited same-wall wall jumps. This is a conservative sampled search, not a proof of solvability.
import { CELL, HAZARD, PHYS } from './config';
import { circleRect, rectsOverlap, type Rect } from './grid';
import { fieldAccel, type HoleInfo } from './field';
import { cellCenter, moverBaseRect, ovalHitsRect, springDir, springRect, staticLethal, type StaticLethal } from './hazards';
import { getItem } from './items';
import { fanAccel, fanFields, graveDirt, graveStone, type FanField } from './fans';
import { ballRect, gravityAt } from './mapfx';
import { childCount, childId, childRect, motionOf, sweepOf } from './movers';
import { IN_DOWN, IN_JUMP, IN_LEFT, IN_RIGHT, IN_SPRINT, newBody, stepBody, type Body, type Mover, type PhysEnv } from './physics';
import { C_ONEWAY, World, type PlacedObject } from './world';

const W = PHYS.bodyW, H = PHYS.bodyH;
export const FINISH = -1;
/** start offsets (px) a recorded edge must tolerate to count as a route */
const ROBUST_OFFSETS = [-3, 3];

export interface NavNode { key: number; cx: number; cy: number; x: number; y: number }
export interface NavEdge {
  from: number; to: number; frames: number; inputs: Uint8Array; path: Int16Array; kind: string;
  bbox: Rect; wallJumps: number;
  /** timed edges (moving platforms involved): valid only when started on a tick t with t % period === phase */
  phase?: number; period?: number;
}

/**
 * Riding a kinematic platform child is a graph node of its own. Keys are stable across placements: they come from the
 * object's numeric id and the child index, never from list positions.
 */
export const MOVER_KEY_BASE = 1 << 24;
export const isMoverKey = (k: number) => k >= MOVER_KEY_BASE;
const idNum = (id: string) => { const n = Number(id.slice(1)); return Number.isFinite(n) ? n : 0; };
export function moverKey(o: PlacedObject, child: number) { return MOVER_KEY_BASE + idNum(o.id) * 4 + child; }

/** Departure ticks sampled for timed edges from standing spots and from a ridden platform. */
const TIMED_STEP = 32, RIDE_STEP = 32, MAX_SAMPLES = 12;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

interface KinChild { o: PlacedObject; child: number; id: string; key: number; period: number; box: Rect; envIdx: number; poses: Float64Array }

type Ctrl = (f: number, b: Body) => number;

export type { HoleInfo };

/** Shared black-hole pull used by probes (the race sim uses the same field). */
export function holeAccel(world: World, holes: HoleInfo[], b: Body, blocked: (x0: number, y0: number, x1: number, y1: number) => boolean) {
  const cx = b.x + W / 2, cy = b.y + H / 2;
  if (world.inProtectedPx(cx, cy)) return null;
  return fieldAccel(holes, cx, cy, blocked);
}

/** Grid ray through static solids. */
export function staticRayBlocked(world: World, x0: number, y0: number, x1: number, y1: number): boolean {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(dist / 12);
  for (let i = 1; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    if (world.solidCell(Math.floor(x / CELL), Math.floor(y / CELL))) return true;
  }
  return false;
}

export class Prober {
  readonly world: World;
  readonly lethal: StaticLethal;
  readonly holes: HoleInfo[] = [];
  readonly springs: { r: Rect; dir: { x: number; y: number } }[] = [];
  readonly movers: Mover[] = [];
  readonly env: PhysEnv;
  readonly fans: FanField[];
  /** static movers that count as standing spots (gravestone dirt, the beach ball at rest) */
  readonly floorMovers = new Set<number>();
  /** kinematic platform children, in the same order as the race sim's kinematic movers */
  readonly kin: KinChild[] = [];
  /** 1 where a kinematic platform's lane is (no standing spots there; anything crossing it is timed) */
  readonly lane: Uint8Array;
  private timedEnv: PhysEnv | null = null;
  private rideSafe = new Map<number, boolean>();
  steps = 0;
  /** union of every probe's swept area since the last reset (failed probes included) */
  sweep = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  constructor(world: World) {
    this.world = world;
    this.lethal = staticLethal(world);
    for (const o of world.objects.values()) {
      const k = getItem(o.item).kind;
      if (k === 'blackhole') { const c = cellCenter(o.x, o.y); this.holes.push({ x: c.x, y: c.y, owner: o.owner, src: o.id }); }
      if (k === 'spring') this.springs.push({ r: springRect(o), dir: springDir(o) });
      if (k === 'moving') { const r = moverBaseRect(o); this.movers.push({ ...r, dx: 0, dy: 0 }); } // boarding point at rest
      if (k === 'grave') {
        this.floorMovers.add(this.movers.length);
        this.movers.push({ ...graveDirt(o), dx: 0, dy: 0, top: true });
        // touching the stone sets a ghost on you: routes treat it as a no-go so bots steer clear
        this.lethal.rects.push({ r: graveStone(o), owner: o.owner, src: o.id });
      }
    }
    // the map's beach ball at rest is a stepping stone; the calm sea or lava lake is certain death
    const ball = ballRect(world.map, 0);
    if (ball) { this.floorMovers.add(this.movers.length); this.movers.push({ ...ball, dx: 0, dy: 0 }); }
    const liq = world.map.fx?.liquid;
    if (liq) this.lethal.rects.push({ r: { x: 0, y: liq.level + 6 - H, w: world.w * CELL, h: world.h * CELL }, owner: null, src: 'liquid' });
    const holes = this.holes;
    this.fans = fanFields(world);
    const fans = this.fans;
    const holeFn = holes.length ? (b: Body) => holeAccel(world, holes, b, (a, c, d, e) => staticRayBlocked(world, a, c, d, e)) : null;
    this.env = {
      world, isSolid: (x, y) => world.solidCell(x, y), movers: this.movers, speedMul: 1, jumpMul: 1,
      accel: holeFn || fans.length ? (b: Body) => {
        const h = holeFn ? holeFn(b) : null;
        if (!fans.length) return h;
        const cx = b.x + W / 2, cy = b.y + H / 2;
        if (world.inProtectedPx(cx, cy)) return h;
        const f = fanAccel(fans, cx, cy, b.vx, b.vy);
        return f ? (h ? { ax: h.ax + f.ax, ay: h.ay + f.ay } : f) : h;
      } : undefined,
      gravMul: world.map.fx?.lowGrav ? (b: Body) => gravityAt(world.map, b.x + W / 2, b.y + H / 2) : undefined,
    };
    this.lane = new Uint8Array(world.w * world.h);
    for (const o of world.kinematic) {
      const sw = sweepOf(o);
      for (const [x, y] of sw.sweep) if (world.inBounds(x, y)) this.lane[world.idx(x, y)] = 1;
      const period = motionOf(o).period;
      for (let i = 0; i < childCount(o); i++) {
        // pose table over one cycle: probes look poses up instead of recomputing trig every frame
        const poses = new Float64Array(period * 4);
        for (let t = 0; t < period; t++) { const r = childRect(o, i, t); poses.set([r.x, r.y, r.w, r.h], t * 4); }
        this.kin.push({ o, child: i, id: childId(o, i), key: moverKey(o, i), period, box: sw.bbox, envIdx: this.movers.length + this.kin.length, poses });
      }
    }
    if (this.kin.length) {
      const movers = [...this.movers, ...this.kin.map(() => ({ x: 0, y: 0, w: 0, h: 0, dx: 0, dy: 0 }))];
      this.timedEnv = { ...this.env, movers };
    }
  }

  kinByKey(key: number): KinChild | undefined { return this.kin.find(k => k.key === key); }

  /** Put every kinematic child at its pose for tick t (rect at t, displacement since t-1). */
  private setTick(t: number) {
    const ms = this.timedEnv!.movers;
    for (const k of this.kin) {
      const P = k.period, a = (((t % P) + P) % P) * 4, b = ((((t - 1) % P) + P) % P) * 4, q = k.poses;
      const m = ms[k.envIdx];
      m.x = q[a]; m.y = q[a + 1]; m.w = q[a + 2]; m.h = q[a + 3]; m.dx = q[a] - q[b]; m.dy = q[a + 1] - q[b + 1]; m.id = k.id;
    }
  }

  /** Does a recorded path ever put the body into a platform lane? */
  touchesLane(path: Int16Array): boolean {
    const w = this.world;
    for (let i = 0; i < path.length; i += 2) {
      const x = path[i], y = path[i + 1];
      for (const [px, py] of [[x, y], [x + W - 1, y], [x, y + H - 1], [x + W - 1, y + H - 1]]) {
        const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
        if (w.inBounds(cx, cy) && this.lane[cy * w.w + cx]) return true;
      }
    }
    return false;
  }

  /** Kinematic children whose lane is within jumping or dropping range of a pixel point. */
  kinNear(x: number, y: number): KinChild[] {
    return this.kin.filter(k => x > k.box.x - 6 * CELL && x < k.box.x + k.box.w + 6 * CELL && y > k.box.y - 9 * CELL && y < k.box.y + k.box.h + 3 * CELL);
  }

  periodOf(ks: KinChild[]): number { return ks.reduce((a, k) => lcm(a, k.period), 1); }

  /** Can a rider stand centred on this child for a whole cycle without being shoved off or touching a lethal shape? */
  canRide(k: KinChild): boolean {
    const hit = this.rideSafe.get(k.key);
    if (hit !== undefined) return hit;
    const b = this.rideStart(k, 0, 0);
    const P = this.periodOf(this.kinNear(b.x, b.y).concat(k));
    let ok = true;
    for (let f = 0; f < P && ok; f++) {
      this.setTick(f + 1);
      stepBody(b, 0, this.timedEnv!);
      this.steps++;
      if (b.crushMover >= 0 || !b.grounded || this.timedEnv!.movers[b.groundMover]?.id !== k.id || this.lethalAt(b.x, b.y)) ok = false;
    }
    this.rideSafe.set(k.key, ok);
    return ok;
  }

  /** A rider standing at the centre of a child's top at tick t. */
  rideStart(k: KinChild, t: number, offset: number): Body {
    const r = childRect(k.o, k.child, t);
    const b = newBody(r.x + r.w / 2 - W / 2 + offset, r.y - H);
    b.grounded = true; b.groundMover = k.envIdx; b.coyote = PHYS.coyoteTime;
    return b;
  }

  isNodeCell(cx: number, cy: number): boolean {
    const w = this.world;
    if (!w.inBounds(cx, cy) || !w.inBounds(cx, cy + 1)) return false;
    if (w.solidCell(cx, cy)) return false;
    const below = w.coll[w.idx(cx, cy + 1)];
    let floor = w.solidCell(cx, cy + 1) || (below === C_ONEWAY && w.collDir[w.idx(cx, cy + 1)] === 0);
    if (!floor && this.floorMovers.size) {
      const nx = cx * CELL + (CELL - W) / 2, top = (cy + 1) * CELL;
      for (const i of this.floorMovers) { const m = this.movers[i]; if (Math.abs(m.y - top) < 0.5 && m.x < nx + W && m.x + m.w > nx) { floor = true; break; } }
    }
    if (!floor) return false;
    if (this.lane[cy * w.w + cx]) return false; // a platform sweeps through here: nowhere to wait safely
    // head room: the cell above may be solid only if the body still fits (body is shorter than a cell)
    const n = this.nodeAt(cx, cy);
    return !this.lethalAt(n.x, n.y);
  }

  nodeAt(cx: number, cy: number): NavNode {
    return { key: cy * this.world.w + cx, cx, cy, x: cx * CELL + (CELL - W) / 2, y: (cy + 1) * CELL - H };
  }

  lethalAt(x: number, y: number): boolean {
    const r: Rect = { x, y, w: W, h: H };
    for (const l of this.lethal.rects) if (rectsOverlap(r, l.r)) return true;
    for (const c of this.lethal.circles) if (circleRect(c.x, c.y, c.r, r)) return true;
    for (const l of this.lethal.ovals) if (ovalHitsRect(l.ov, r)) return true;
    return false;
  }

  /** One unverified run of a primitive (robustness is checked later, only for the edges worth keeping). */
  private once(start: NavNode, ctrl: Ctrl, maxFrames: number, kind: string): NavEdge | null { return this.runOnce(start, ctrl, maxFrames, kind, 0); }

  /** The same inputs must still reach the same place from slightly off-centre starts. */
  private robust(start: NavNode, e: NavEdge): boolean {
    for (const off of ROBUST_OFFSETS) {
      const replay: Ctrl = f => (f < e.inputs.length ? e.inputs[f] : 0);
      const r = this.runOnce(start, replay, e.frames + 90, e.kind, off);
      if (!r || r.to !== e.to) return false;
    }
    return true;
  }

  /** Run a primitive and keep it only if the same inputs still reach the same place from slightly off-centre starts. */
  run(start: NavNode, ctrl: Ctrl, maxFrames: number, kind: string): NavEdge | null {
    const e = this.runOnce(start, ctrl, maxFrames, kind, 0);
    if (!e) return null;
    for (const off of ROBUST_OFFSETS) {
      const replay: Ctrl = f => (f < e.inputs.length ? e.inputs[f] : 0);
      const r = this.runOnce(start, replay, e.frames + 90, kind, off);
      if (!r || r.to !== e.to) return null;
    }
    return e;
  }

  /**
   * Timed version of run(): the same primitive started on tick `tau` with every kinematic platform at its real pose for
   * each frame. `from` is a standing node or a ridden child (rider starts centred on it). Robust to ±3 px like run().
   */
  runTimed(from: NavNode | KinChild, ctrl: Ctrl, maxFrames: number, kind: string, tau: number): NavEdge | null {
    const e = this.runOnce(from, ctrl, maxFrames, kind, 0, tau);
    if (!e) return null;
    for (const off of ROBUST_OFFSETS) {
      const replay: Ctrl = f => (f < e.inputs.length ? e.inputs[f] : 0);
      const r = this.runOnce(from, replay, e.frames + 90, kind, off, tau);
      if (!r || r.to !== e.to) return null;
    }
    return e;
  }

  private runOnce(start: NavNode | KinChild, ctrl: Ctrl, maxFrames: number, kind: string, offset: number, tau = -1): NavEdge | null {
    const timed = tau >= 0 && !!this.timedEnv;
    const env = timed ? this.timedEnv! : this.env;
    const riding = 'envIdx' in start;
    let b: Body;
    if (riding) { this.setTick(tau); b = this.rideStart(start, tau, offset); }
    else { b = newBody(start.x + offset, start.y); b.grounded = true; b.coyote = PHYS.coyoteTime; }
    const fromKey = riding ? start.key : start.key;
    const legacy = this.movers.length;
    const inputs = new Uint8Array(maxFrames);
    const path = new Int16Array(maxFrames * 2);
    let minX = b.x, minY = b.y, maxX = b.x, maxY = b.y;
    const fin = this.world.finishPx;
    const killY = (this.world.h + 1) * CELL;
    let wallJumps = 0;
    let springCd = 0;
    const sw = this.sweep;
    const done = () => { sw.x0 = Math.min(sw.x0, minX - CELL); sw.y0 = Math.min(sw.y0, minY - CELL); sw.x1 = Math.max(sw.x1, maxX + W + CELL); sw.y1 = Math.max(sw.y1, maxY + H + CELL); };
    for (let f = 0; f < maxFrames; f++) {
      const inp = ctrl(f, b);
      inputs[f] = inp;
      if (timed) this.setTick(tau + f + 1);
      stepBody(b, inp, env);
      this.steps++;
      if (b.wallJumped) wallJumps++;
      if (springCd > 0) springCd--;
      if (this.springs.length && springCd === 0) {
        const br: Rect = { x: b.x, y: b.y, w: W, h: H };
        for (const s of this.springs) if (rectsOverlap(br, s.r)) {
          if (s.dir.y !== 0) { b.vy = s.dir.y * PHYS.springSpeed; b.jumpRising = false; }
          else { b.vx = s.dir.x * PHYS.springSideSpeed; b.vy = -PHYS.springSideLift; b.lockT = PHYS.springControlLock; }
          b.grounded = false; springCd = 9; break;
        }
      }
      path[f * 2] = Math.round(b.x); path[f * 2 + 1] = Math.round(b.y);
      if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x; if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
      if (b.y > killY || b.crushMover >= 0 || this.lethalAt(b.x, b.y)) { done(); return null; }
      const bbox = () => ({ x: minX - CELL, y: minY - CELL, w: maxX - minX + W + 2 * CELL, h: maxY - minY + H + 2 * CELL });
      if (b.x < fin.x + fin.w && b.x + W > fin.x && b.y < fin.y + fin.h && b.y + H > fin.y) {
        done();
        return { from: fromKey, to: FINISH, frames: f + 1, inputs: inputs.slice(0, f + 1), path: path.slice(0, (f + 1) * 2), kind, bbox: bbox(), wallJumps };
      }
      if (timed && f > 3 && b.grounded && b.groundMover >= legacy) {
        // landed on a moving platform child: boarding (or transferring) edge into its riding node
        const k = this.kin[b.groundMover - legacy];
        if (riding && k.key === fromKey) { if (f > 40) { done(); return null; } continue; }
        done();
        return { from: fromKey, to: k.key, frames: f + 1, inputs: inputs.slice(0, f + 1), path: path.slice(0, (f + 1) * 2), kind: 'board', bbox: bbox(), wallJumps };
      }
      if (f > 3 && b.grounded && Math.abs(b.vx) < 1 && (b.groundMover < 0 || this.floorMovers.has(b.groundMover))) {
        const land = this.landingNode(b);
        done();
        if (land === null || land === fromKey) return null;
        return { from: fromKey, to: land, frames: f + 1, inputs: inputs.slice(0, f + 1), path: path.slice(0, (f + 1) * 2), kind, bbox: bbox(), wallJumps };
      }
    }
    done();
    return null;
  }

  landingNode(b: Body): number | null {
    const cy = Math.round((b.y + H) / CELL) - 1;
    const cc = Math.floor((b.x + W / 2) / CELL);
    if (this.isNodeCell(cc, cy)) return cy * this.world.w + cc;
    const c0 = Math.floor(b.x / CELL), c1 = Math.floor((b.x + W - 0.01) / CELL);
    for (const cx of [c0, c1]) if (this.isNodeCell(cx, cy)) return cy * this.world.w + cx;
    return null;
  }

  /** All movement primitives from a node, deduplicated to the fastest edge per destination. */
  edgesFrom(n: NavNode): NavEdge[] {
    // every primitive runs once; only the cheapest candidate per destination pays for the ±3 px robustness replays
    const cands = new Map<number, NavEdge[]>();
    const laneHits: NavEdge[] = [];
    const add = (e: NavEdge | null) => {
      if (!e) return;
      // a path through a platform lane only works at some times: re-checked below as a timed edge
      if (this.kin.length && this.touchesLane(e.path)) { laneHits.push(e); return; }
      const list = cands.get(e.to);
      if (list) list.push(e); else cands.set(e.to, [e]);
    };
    const w = this.world;
    const wallNear = (dir: number) => {
      for (let k = 1; k <= 3; k++) for (let dy = -3; dy <= 0; dy++) if (w.solidCell(n.cx + dir * k, n.cy + dy) && w.inBounds(n.cx + dir * k, n.cy + dy)) return true;
      return false;
    };
    // walk one cell (stops on the neighbour, or walks off an edge and falls)
    for (const dir of [-1, 1]) {
      const tx = n.x + dir * CELL;
      add(this.once(n, (f, b) => {
        if (b.grounded && Math.abs(b.x - tx) < 1.5 && f > 0) return 0;
        if (!b.grounded) return f < 14 ? (dir < 0 ? IN_LEFT : IN_RIGHT) : 0;
        const dx = tx - b.x;
        const stop = (b.vx * b.vx) / (2 * PHYS.groundDecel);
        if (Math.abs(dx) <= stop + 0.5 && Math.sign(b.vx) === Math.sign(dx)) return 0;
        return dx < 0 ? IN_LEFT : IN_RIGHT;
      }, 150, 'walk'));
      // walk off and keep steering (long drop)
      add(this.once(n, (f, b) => (f > 4 && b.grounded ? 0 : dir < 0 ? IN_LEFT : IN_RIGHT), 200, 'walk'));
    }
    // jumps
    add(this.once(n, jumpCtrl(0, false, 0, 'hold', 0), 120, 'jump'));
    for (const dir of [-1, 1]) {
      for (const sprint of [false, true]) {
        for (const run of [0, 12]) {
          add(this.once(n, jumpCtrl(dir, sprint, run, 'hold', 0), 140, 'jump'));
          add(this.once(n, jumpCtrl(dir, sprint, run, 'stop', 14), 140, 'jump'));
          add(this.once(n, jumpCtrl(dir, sprint, run, 'rev', 22), 140, 'jump'));
        }
      }
      add(this.once(n, jumpCtrl(dir, false, 0, 'hop', 0), 100, 'jump'));
      add(this.once(n, jumpCtrl(dir, false, 0, 'stop', 6), 120, 'jump'));
      if (wallNear(dir)) {
        // same-wall climb: jump at the wall, wall-jump on every recontact, steer back to the same wall
        add(this.once(n, climbCtrl(dir, 'same'), 600, 'climb'));
        // shaft zig-zag between facing walls
        if (wallNear(-dir)) add(this.once(n, climbCtrl(dir, 'zig'), 600, 'climb'));
        // climb then hop off the top away from the wall
        add(this.once(n, climbCtrl(dir, 'sameSprint'), 600, 'climb'));
      }
    }
    // drop through a one-way floor
    const below = w.inBounds(n.cx, n.cy + 1) ? w.coll[w.idx(n.cx, n.cy + 1)] : 0;
    if (below === C_ONEWAY) {
      for (const dir of [0, -1, 1]) {
        const d = dir < 0 ? IN_LEFT : dir > 0 ? IN_RIGHT : 0;
        add(this.once(n, f => (f < 2 ? IN_DOWN : f > 10 ? d : 0), 160, 'drop'));
      }
    }
    const edges: NavEdge[] = [];
    for (const list of cands.values()) {
      list.sort((a, b) => a.frames + a.wallJumps * 6 - (b.frames + b.wallJumps * 6));
      const ok = list.find(e => this.robust(n, e));
      if (ok) edges.push(ok);
    }
    if (this.kin.length) edges.push(...this.timedFrom(n, laneHits));
    return edges;
  }

  /**
   * Timed edges from a standing node: every lane-crossing primitive replayed, plus boarding jumps, at departure ticks
   * sampled over the nearby platforms' common period. Kept per (destination, phase) when robust to ±3 px.
   */
  private timedFrom(n: NavNode, laneHits: NavEdge[]): NavEdge[] {
    const near = this.kinNear(n.x, n.y);
    if (!near.length && !laneHits.length) return [];
    const P = this.periodOf(near.length ? near : this.kin);
    // replay only the cheapest lane-crossing primitive per destination
    const byTo = new Map<number, NavEdge>();
    for (const e of laneHits) { const c = byTo.get(e.to); if (!c || e.frames < c.frames) byTo.set(e.to, e); }
    const ctrls: [Ctrl, number, string][] = [...byTo.values()].map(e => [(f: number) => (f < e.inputs.length ? e.inputs[f] : 0), e.frames + 60, e.kind] as [Ctrl, number, string]);
    if (near.length) {
      const dirs = new Set(near.map(k => Math.sign(k.box.x + k.box.w / 2 - (n.x + W / 2)) || 1));
      for (const d of dirs) for (const c of boardCtrls(d)) ctrls.push(c);
      ctrls.push([jumpCtrl(0, false, 0, 'hold', 0), 120, 'jump']);
    }
    return this.collectTimed(n, ctrls, P, Math.max(TIMED_STEP, Math.ceil(P / MAX_SAMPLES / 8) * 8));
  }

  /** Alight edges from riding a child: a centred rider jumps, hops or walks off at sampled ticks of the cycle. */
  edgesFromRide(key: number): NavEdge[] {
    const k = this.kinByKey(key);
    if (!k || !this.canRide(k)) return [];
    const r = childRect(k.o, k.child, 0);
    const P = this.periodOf(this.kinNear(r.x, r.y).concat(k));
    const ctrls = rideCtrls();
    // climbing off a platform onto a wall (a lift up to a cliff face) only where a wall is actually beside the lane
    const w = this.world;
    const bx0 = Math.floor(k.box.x / CELL), bx1 = Math.floor((k.box.x + k.box.w - 1) / CELL), by0 = Math.floor(k.box.y / CELL) - 4, by1 = Math.floor((k.box.y + k.box.h - 1) / CELL);
    for (const dir of [-1, 1]) {
      let wall = false;
      for (let i = 1; i <= 3 && !wall; i++) for (let y = by0; y <= by1 && !wall; y++) { const x = dir < 0 ? bx0 - i : bx1 + i; if (w.inBounds(x, y) && w.solidCell(x, y)) wall = true; }
      if (wall) ctrls.push([climbCtrl(dir, 'same'), 500, 'climb']);
    }
    return this.collectTimed(k, ctrls, P, Math.max(RIDE_STEP, Math.ceil(P / MAX_SAMPLES / 8) * 8));
  }

  private collectTimed(from: NavNode | KinChild, ctrls: [Ctrl, number, string][], P: number, stepT: number): NavEdge[] {
    const out: NavEdge[] = [];
    for (let tau = 0; tau < P; tau += stepT) {
      // one run each, then robustness only for the cheapest candidate per destination at this departure tick
      const cands = new Map<number, NavEdge[]>();
      for (const [ctrl, max, kind] of ctrls) {
        const e = this.runOnce(from, ctrl, max, kind, 0, tau);
        if (!e) continue;
        const list = cands.get(e.to);
        if (list) list.push(e); else cands.set(e.to, [e]);
      }
      for (const list of cands.values()) {
        list.sort((a, b) => a.frames + a.wallJumps * 6 - (b.frames + b.wallJumps * 6));
        const ok = list.find(e => this.robustTimed(from, e, tau));
        if (ok) { ok.phase = tau; ok.period = P; out.push(ok); }
      }
    }
    return out;
  }

  private robustTimed(from: NavNode | KinChild, e: NavEdge, tau: number): boolean {
    for (const off of ROBUST_OFFSETS) {
      const replay: Ctrl = f => (f < e.inputs.length ? e.inputs[f] : 0);
      const r = this.runOnce(from, replay, e.frames + 90, e.kind, off, tau);
      if (!r || r.to !== e.to) return false;
    }
    return true;
  }
}

function jumpCtrl(dir: number, sprint: boolean, run: number, mode: 'hold' | 'stop' | 'rev' | 'hop', k: number): Ctrl {
  return (f, b) => {
    const d = dir < 0 ? IN_LEFT : dir > 0 ? IN_RIGHT : 0;
    const rd = dir < 0 ? IN_RIGHT : dir > 0 ? IN_LEFT : 0;
    const sp = sprint ? IN_SPRINT : 0;
    if (f < run) return d | sp;
    const jf = f - run;
    const holdJ = mode === 'hop' ? jf < 7 : jf < 34;
    let mv = d;
    if (mode === 'stop' && jf >= k) mv = 0;
    if (mode === 'rev' && jf >= k) mv = rd;
    if (b.grounded && jf > 3) mv = 0;
    return mv | sp | (holdJ ? IN_JUMP : 0);
  };
}

/** Primitives tried toward a moving platform from a standing spot (in addition to replaying lane-crossing edges). */
function boardCtrls(dir: number): [Ctrl, number, string][] {
  const out: [Ctrl, number, string][] = [];
  for (const sprint of [false, true]) out.push([jumpCtrl(dir, sprint, 0, 'hold', 0), 140, 'jump'], [jumpCtrl(dir, sprint, 0, 'stop', 14), 140, 'jump']);
  out.push([(f, b) => (f > 4 && b.grounded ? 0 : dir < 0 ? IN_LEFT : IN_RIGHT), 160, 'walk']);
  return out;
}

/** Ways off a ridden platform: jumps both ways (walking pace and sprinting, held or stopped), hops, a straight jump, walking off. */
function rideCtrls(): [Ctrl, number, string][] {
  const out: [Ctrl, number, string][] = [[jumpCtrl(0, false, 0, 'hold', 0), 120, 'jump']];
  for (const dir of [-1, 1]) {
    for (const sprint of [false, true]) out.push([jumpCtrl(dir, sprint, 0, 'hold', 0), 150, 'jump'], [jumpCtrl(dir, sprint, 0, 'stop', 16), 150, 'jump']);
    out.push([jumpCtrl(dir, false, 0, 'hop', 0), 110, 'jump']);
    out.push([(f, b) => (f > 4 && b.grounded && b.groundMover < 0 ? 0 : dir < 0 ? IN_LEFT | IN_SPRINT : IN_RIGHT | IN_SPRINT), 160, 'walk']);
  }
  return out;
}

function climbCtrl(dir: number, mode: 'same' | 'zig' | 'sameSprint'): Ctrl {
  let holdT = 0, rel = 0, steer = dir, walls = 0;
  return (f, b) => {
    if (f === 0) { holdT = 0; rel = 0; steer = dir; walls = 0; }
    let inp = steer < 0 ? IN_LEFT : IN_RIGHT;
    if (mode === 'sameSprint' && walls > 0 && b.wallDir === 0 && b.vy > -60 && !b.grounded) inp |= IN_SPRINT;
    if (holdT > 0) { inp |= IN_JUMP; holdT--; if (holdT === 0) rel = 1; }
    else if (rel > 0) rel--;
    else if (f === 0 || (b.wallDir !== 0 && !b.grounded)) {
      if (b.wallDir !== 0) { walls++; if (mode === 'zig') steer = -b.wallDir; }
      inp |= IN_JUMP; holdT = 16;
      if (walls > 40) return 0;
    }
    if (b.grounded && f > 10) return 0;
    return inp;
  };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

/** Lazily built graph over standing nodes. */
export class NavGraph {
  readonly prober: Prober;
  private cache = new Map<number, { edges: NavEdge[]; sweep: Rect }>();
  constructor(world: World) { this.prober = new Prober(world); }
  get world() { return this.prober.world; }

  /** New graph for a changed world that reuses every cached edge whose swept area misses the changed region. */
  static derive(base: NavGraph, world: World, region: Rect | null): NavGraph {
    const g = new NavGraph(world);
    if (!region) return g;
    for (const [k, entry] of base.cache) {
      if (rectsOverlap(entry.sweep, region)) continue;
      g.cache.set(k, entry);
    }
    return g;
  }
  cachedNodes() { return this.cache.size; }

  /** Compute edges for every standing spot on the map, reachable from the spawn or not. */
  warmAll() {
    const w = this.world;
    for (let cy = 0; cy < w.h; cy++) for (let cx = 0; cx < w.w; cx++) if (this.prober.isNodeCell(cx, cy)) this.edges(cy * w.w + cx);
  }

  node(key: number): NavNode {
    if (isMoverKey(key)) {
      // riding node: its position at GO (it moves; bots track the live platform instead)
      const k = this.prober.kinByKey(key);
      const r = k ? childRect(k.o, k.child, 0) : { x: 0, y: 0, w: 0, h: 0 };
      return { key, cx: -1, cy: -1, x: r.x + r.w / 2 - W / 2, y: r.y - H };
    }
    const w = this.world.w; return this.prober.nodeAt(key % w, Math.floor(key / w));
  }

  /** Copy every cached edge of a graph built on an identical world (the clean base map). */
  static fromBase(base: NavGraph, world: World): NavGraph {
    const g = new NavGraph(world);
    for (const [k, v] of base.cache) g.cache.set(k, v);
    return g;
  }

  edges(key: number): NavEdge[] {
    let e = this.cache.get(key);
    if (!e) {
      const p = this.prober;
      p.sweep = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      let edges: NavEdge[];
      let sweep: Rect;
      if (isMoverKey(key)) {
        edges = p.edgesFromRide(key);
        const k = p.kinByKey(key);
        const sw = p.sweep;
        const box = k ? k.box : { x: 0, y: 0, w: 0, h: 0 };
        sweep = sw.x0 < Infinity ? unionRect({ x: sw.x0, y: sw.y0, w: sw.x1 - sw.x0, h: sw.y1 - sw.y0 }, box) : box;
      } else {
        const n = this.node(key);
        const isNode = p.isNodeCell(n.cx, n.cy);
        edges = isNode ? p.edgesFrom(n) : [];
        const sw = p.sweep;
        // a non-node can become a node when something is placed under or removed from it
        sweep = isNode && sw.x0 < Infinity ? { x: sw.x0, y: sw.y0, w: sw.x1 - sw.x0, h: sw.y1 - sw.y0 } : { x: n.x - CELL, y: n.y - CELL, w: W + 2 * CELL, h: H + 3 * CELL };
        // timed edges depend on the platforms near this node: any change to them invalidates the entry
        if (isNode) for (const k of p.kinNear(n.x, n.y)) sweep = unionRect(sweep, k.box);
      }
      e = { edges, sweep };
      this.cache.set(key, e);
    }
    return e.edges;
  }

  spawnNodes(): number[] {
    const s = this.world.map.spawn;
    const out: number[] = [];
    for (let cx = s.x; cx < s.x + s.w; cx++) for (let cy = s.y; cy < s.y + s.h; cy++) if (this.prober.isNodeCell(cx, cy)) out.push(cy * this.world.w + cx);
    return out;
  }

  /** Breadth-first reachability from the spawn. Stops early when the flag is reached unless `full`. */
  reach(full = false): { finish: boolean; visited: Set<number>; ms: number } {
    const t0 = Date.now();
    const start = this.spawnNodes();
    const visited = new Set<number>(start);
    const q = [...start];
    let finish = false;
    while (q.length) {
      const k = q.shift()!;
      for (const e of this.edges(k)) {
        if (e.to === FINISH) { finish = true; if (!full) return { finish, visited, ms: Date.now() - t0 }; continue; }
        if (!visited.has(e.to)) { visited.add(e.to); q.push(e.to); }
      }
    }
    return { finish, visited, ms: Date.now() - t0 };
  }

  /** Dijkstra to the flag. cost(edge) lets bots add risk; returns edge list or null. */
  route(from: number, cost: (e: NavEdge) => number = e => e.frames + e.wallJumps * 6): NavEdge[] | null {
    const dist = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, NavEdge>();
    const open: [number, number][] = [[0, from]];
    const done = new Set<number>();
    let best: NavEdge | null = null, bestCost = Infinity;
    let guard = 0;
    while (open.length && guard++ < 20000) {
      open.sort((a, b) => a[0] - b[0]);
      const [d, k] = open.shift()!;
      if (done.has(k)) continue;
      done.add(k);
      if (d >= bestCost) break;
      for (const e of this.edges(k)) {
        const nd = d + Math.max(1, cost(e));
        if (e.to === FINISH) { if (nd < bestCost) { bestCost = nd; best = e; } continue; }
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, e); open.push([nd, e.to]); }
      }
    }
    if (!best) return null;
    const out: NavEdge[] = [best];
    let k = best.from;
    while (k !== from) { const e = prev.get(k); if (!e) break; out.unshift(e); k = e.from; }
    return out;
  }
}

/**
 * Every standing spot of a clean base map, computed once per process and shared by every match on that map (matches
 * copy it with NavGraph.fromBase, then derive from it as the course changes). Without this, the first placement that
 * opens a new part of a large map pays for exploring it.
 */
const baseGraphs = new Map<string, NavGraph>();
export function baseNav(mapId: string): NavGraph {
  let g = baseGraphs.get(mapId);
  if (!g) { g = new NavGraph(new World(mapId)); g.warmAll(); baseGraphs.set(mapId, g); }
  return g;
}

/** Placement check: does at least one sampled route from spawn to flag survive? */
export function courseReachable(world: World): { ok: boolean; ms: number; steps: number } {
  const g = new NavGraph(world);
  const r = g.reach(false);
  return { ok: r.finish, ms: r.ms, steps: g.prober.steps };
}
