// Navigation by simulation. Every edge is a recorded input script run through the real physics step from a standing
// position, so route checks and bots use exactly the movement players have: sprint jumps, air steering, wall slides
// and unlimited same-wall wall jumps. This is a conservative sampled search, not a proof of solvability.
import { CELL, HAZARD, PHYS } from './config';
import { circleRect, rectsOverlap, type Rect } from './grid';
import { cellCenter, moverBaseRect, springDir, springRect, staticLethal, type StaticLethal } from './hazards';
import { getItem } from './items';
import { IN_DOWN, IN_JUMP, IN_LEFT, IN_RIGHT, IN_SPRINT, newBody, stepBody, type Body, type Mover, type PhysEnv } from './physics';
import { C_ONEWAY, type World } from './world';

const W = PHYS.bodyW, H = PHYS.bodyH;
export const FINISH = -1;
/** start offsets (px) a recorded edge must tolerate to count as a route */
const ROBUST_OFFSETS = [-3, 3];

export interface NavNode { key: number; cx: number; cy: number; x: number; y: number }
export interface NavEdge {
  from: number; to: number; frames: number; inputs: Uint8Array; path: Int16Array; kind: string;
  bbox: Rect; wallJumps: number;
}

type Ctrl = (f: number, b: Body) => number;

export interface HoleInfo { x: number; y: number; owner: string | null; src: string }

/** Shared black-hole pull used by both the race sim and probes. */
export function holeAccel(world: World, holes: HoleInfo[], b: Body, blocked: (x0: number, y0: number, x1: number, y1: number) => boolean) {
  const cx = b.x + W / 2, cy = b.y + H / 2;
  if (world.inProtectedPx(cx, cy)) return null;
  let ax = 0, ay = 0, strongest = 0, src: HoleInfo | null = null;
  for (const h of holes) {
    const dx = h.x - cx, dy = h.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= HAZARD.holeRadius || d < 1) continue;
    if (blocked(h.x, h.y, cx, cy)) continue;
    const a = HAZARD.holeMaxPull * (1 - d / HAZARD.holeRadius);
    const ux = dx / d, uy = dy / d;
    if (b.vx * ux + b.vy * uy > HAZARD.holeMaxAffectedSpeed) continue;
    ax += ux * a; ay += uy * a;
    if (a > strongest) { strongest = a; src = h; }
  }
  const mag = Math.hypot(ax, ay);
  if (mag === 0) return null;
  if (mag > HAZARD.holeMaxTotal) { ax *= HAZARD.holeMaxTotal / mag; ay *= HAZARD.holeMaxTotal / mag; }
  return { ax, ay, src, strongest };
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
    }
    const holes = this.holes;
    this.env = {
      world, isSolid: (x, y) => world.solidCell(x, y), movers: this.movers, speedMul: 1, jumpMul: 1,
      accel: holes.length ? (b: Body) => holeAccel(world, holes, b, (a, c, d, e) => staticRayBlocked(world, a, c, d, e)) : undefined,
    };
  }

  isNodeCell(cx: number, cy: number): boolean {
    const w = this.world;
    if (!w.inBounds(cx, cy) || !w.inBounds(cx, cy + 1)) return false;
    if (w.solidCell(cx, cy)) return false;
    const below = w.coll[w.idx(cx, cy + 1)];
    const floor = w.solidCell(cx, cy + 1) || (below === C_ONEWAY && w.collDir[w.idx(cx, cy + 1)] === 0);
    if (!floor) return false;
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
    return false;
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

  private runOnce(start: NavNode, ctrl: Ctrl, maxFrames: number, kind: string, offset: number): NavEdge | null {
    const b = newBody(start.x + offset, start.y);
    b.grounded = true; b.coyote = PHYS.coyoteTime;
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
      stepBody(b, inp, this.env);
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
      if (b.y > killY || this.lethalAt(b.x, b.y)) { done(); return null; }
      const bbox = () => ({ x: minX - CELL, y: minY - CELL, w: maxX - minX + W + 2 * CELL, h: maxY - minY + H + 2 * CELL });
      if (b.x < fin.x + fin.w && b.x + W > fin.x && b.y < fin.y + fin.h && b.y + H > fin.y) {
        done();
        return { from: start.key, to: FINISH, frames: f + 1, inputs: inputs.slice(0, f + 1), path: path.slice(0, (f + 1) * 2), kind, bbox: bbox(), wallJumps };
      }
      if (f > 3 && b.grounded && Math.abs(b.vx) < 1 && b.groundMover < 0) {
        const land = this.landingNode(b);
        done();
        if (land === null || land === start.key) return null;
        return { from: start.key, to: land, frames: f + 1, inputs: inputs.slice(0, f + 1), path: path.slice(0, (f + 1) * 2), kind, bbox: bbox(), wallJumps };
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
    const out = new Map<number, NavEdge>();
    const add = (e: NavEdge | null) => {
      if (!e) return;
      const cur = out.get(e.to);
      const cost = e.frames + e.wallJumps * 6;
      if (!cur || cost < cur.frames + cur.wallJumps * 6) out.set(e.to, e);
    };
    const w = this.world;
    // walk one cell (stops on the neighbour, or walks off an edge and falls)
    for (const dir of [-1, 1]) {
      const tx = n.x + dir * CELL;
      add(this.run(n, (f, b) => {
        if (b.grounded && Math.abs(b.x - tx) < 1.5 && f > 0) return 0;
        if (!b.grounded) return f < 14 ? (dir < 0 ? IN_LEFT : IN_RIGHT) : 0;
        const dx = tx - b.x;
        const stop = (b.vx * b.vx) / (2 * PHYS.groundDecel);
        if (Math.abs(dx) <= stop + 0.5 && Math.sign(b.vx) === Math.sign(dx)) return 0;
        return dx < 0 ? IN_LEFT : IN_RIGHT;
      }, 150, 'walk'));
      // walk off and keep steering (long drop)
      add(this.run(n, (f, b) => (f > 4 && b.grounded ? 0 : dir < 0 ? IN_LEFT : IN_RIGHT), 200, 'walk'));
    }
    // jumps
    const jumpCtrl = (dir: number, sprint: boolean, run: number, mode: 'hold' | 'stop' | 'rev' | 'hop', k: number): Ctrl => (f, b) => {
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
    add(this.run(n, jumpCtrl(0, false, 0, 'hold', 0), 120, 'jump'));
    for (const dir of [-1, 1]) {
      for (const sprint of [false, true]) {
        for (const run of [0, 12]) {
          add(this.run(n, jumpCtrl(dir, sprint, run, 'hold', 0), 140, 'jump'));
          add(this.run(n, jumpCtrl(dir, sprint, run, 'stop', 14), 140, 'jump'));
          add(this.run(n, jumpCtrl(dir, sprint, run, 'rev', 22), 140, 'jump'));
        }
      }
      add(this.run(n, jumpCtrl(dir, false, 0, 'hop', 0), 100, 'jump'));
      add(this.run(n, jumpCtrl(dir, false, 0, 'stop', 6), 120, 'jump'));
      // same-wall climb: jump at the wall, wall-jump on every recontact, steer back to the same wall
      add(this.run(n, climbCtrl(dir, 'same'), 600, 'climb'));
      // shaft zig-zag between facing walls
      add(this.run(n, climbCtrl(dir, 'zig'), 600, 'climb'));
      // climb then hop off the top away from the wall
      add(this.run(n, climbCtrl(dir, 'sameSprint'), 600, 'climb'));
    }
    // drop through a one-way floor
    const below = w.inBounds(n.cx, n.cy + 1) ? w.coll[w.idx(n.cx, n.cy + 1)] : 0;
    if (below === C_ONEWAY) {
      for (const dir of [0, -1, 1]) {
        const d = dir < 0 ? IN_LEFT : dir > 0 ? IN_RIGHT : 0;
        add(this.run(n, f => (f < 2 ? IN_DOWN | IN_JUMP : f > 10 ? d : 0), 160, 'drop'));
      }
    }
    return [...out.values()];
  }
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

  node(key: number): NavNode { const w = this.world.w; return this.prober.nodeAt(key % w, Math.floor(key / w)); }

  edges(key: number): NavEdge[] {
    let e = this.cache.get(key);
    if (!e) {
      const p = this.prober;
      p.sweep = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const n = this.node(key);
      const isNode = p.isNodeCell(n.cx, n.cy);
      const edges = isNode ? p.edgesFrom(n) : [];
      const sw = p.sweep;
      // a non-node can become a node when something is placed under or removed from it
      const sweep = isNode && sw.x0 < Infinity ? { x: sw.x0, y: sw.y0, w: sw.x1 - sw.x0, h: sw.y1 - sw.y0 } : { x: n.x - CELL, y: n.y - CELL, w: W + 2 * CELL, h: H + 3 * CELL };
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

/** Placement check: does at least one sampled route from spawn to flag survive? */
export function courseReachable(world: World): { ok: boolean; ms: number; steps: number } {
  const g = new NavGraph(world);
  const r = g.reach(false);
  return { ok: r.finish, ms: r.ms, steps: g.prober.steps };
}
