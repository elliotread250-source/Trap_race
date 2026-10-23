// Server-side bots. They draft and build through the same rules as humans, and race by producing input bits for the
// same physics: no teleporting, no flying, no hazard immunity. Difficulty only changes timing, judgement and mistakes.
import { BOT_DIFFICULTY, CELL, DT, HAZARD, PHYS, TICK_HZ, type Difficulty } from '../shared/config';
import { circleRect, rectsOverlap, type Rect } from '../shared/grid';
import { cellCenter, laserBeamRect, laserState, pendulumPos, rspikeParts, rspikeState, sawPos } from '../shared/hazards';
import { getItem, ITEMS, type ItemDef } from '../shared/items';
import { FINISH, isMoverKey, moverKey, type NavEdge, type NavGraph } from '../shared/nav';
import { childRect } from '../shared/movers';
import { IN_JUMP, IN_LEFT, IN_RIGHT, IN_SPRINT } from '../shared/physics';
import { airDistance, assessPlacement, checkPlacement, progressOf, type PlaceRequest } from '../shared/placement';
import type { Card } from '../shared/protocol';
import type { RacePlayer, RaceSim } from '../shared/race';
import { Rng } from '../shared/rng';
import { S_ICE, spikeStripPx, TERRAIN_ID, type World } from '../shared/world';

const BW = PHYS.bodyW, BH = PHYS.bodyH;

// ---------------- drafting
export function botPickCard(cards: Card[], difficulty: Difficulty, rng: Rng, needDemolition: boolean, worldPlayerObjects: number, mustBuild = false): Card | null {
  const open = cards.filter(c => !c.by);
  if (!open.length) return null;
  const d = BOT_DIFFICULTY[difficulty];
  return rng.weighted(open, c => {
    const def = ITEMS[c.item];
    let w = 1;
    if (def.group === 'hazard') w = 0.6 + d.hazardPlacement * 1.6;
    if (def.group === 'construction') w = 1.1 - d.hazardPlacement * 0.4;
    if (def.group === 'utility') w = def.kind === 'coin' ? 0.5 + d.coinGreed : 0.7;
    if (def.group === 'demolition') w = needDemolition ? 6 : worldPlayerObjects > 6 ? 0.6 : 0.15;
    if (mustBuild) w = def.group === 'construction' ? 6 : 0.2; // nobody can finish until someone builds the crossing
    return w * (0.6 + rng.next() * 0.8);
  }) ?? open[0];
}

// ---------------- building
function routeCells(nav: NavGraph): Set<number> {
  const out = new Set<number>();
  const starts = nav.spawnNodes();
  if (!starts.length) return out;
  const r = nav.route(starts[0]);
  if (!r) return out;
  const w = nav.world.w;
  for (const e of r) for (let i = 0; i < e.path.length; i += 6) {
    const x = e.path[i], y = e.path[i + 1];
    for (const [ox, oy] of [[0, 0], [BW, 0], [0, BH], [BW, BH]]) out.add(Math.floor((y + oy) / CELL) * w + Math.floor((x + ox) / CELL));
  }
  return out;
}

/** Candidate placements near the current best route, filtered by the cheap rules; full validation happens in the match. */
export function botPlacementCandidates(world: World, nav: NavGraph, def: ItemDef, difficulty: Difficulty, rng: Rng, max = 6): PlaceRequest[] {
  const d = BOT_DIFFICULTY[difficulty];
  const route = routeCells(nav);
  const w = world.w;
  const routeList = [...route].map(k => [k % w, Math.floor(k / w)] as [number, number]);
  const out: PlaceRequest[] = [];
  if (def.kind === 'bomb') {
    // aim at the player-built clutter closest to the route
    const scored: { req: PlaceRequest; score: number }[] = [];
    for (const o of world.objects.values()) {
      if (o.prov !== 'player') continue;
      const near = o.cells.filter(([x, y]) => routeList.some(([rx, ry]) => Math.abs(rx - x) <= 2 && Math.abs(ry - y) <= 2)).length;
      const [cx, cy] = o.cells[Math.floor(o.cells.length / 2)];
      const n = def.bombSize ?? 1;
      const req = { item: def.id, x: cx - Math.floor((n - 1) / 2), y: cy - Math.floor((n - 1) / 2), rot: 0, variant: 0 };
      if (checkPlacement(world, req).ok) scored.push({ req, score: near * 2 + (getItem(o.item).group === 'hazard' ? 3 : 1) + rng.next() });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, max).map(s => s.req);
  }
  const hazard = def.group === 'hazard';
  const tries = 400;
  for (let i = 0; i < tries && out.length < max; i++) {
    if (!routeList.length) break;
    const [rx, ry] = rng.pick(routeList);
    const spread = hazard ? (rng.chance(d.hazardPlacement) ? 1 : 3) : 3;
    const x = rx + rng.int(-spread, spread), y = ry + rng.int(-spread, spread);
    const rot = def.rotatable ? rng.int(0, 3) : 0;
    let variant = 0;
    if (def.kind === 'sniper') variant = rng.int(0, 1);
    let req: PlaceRequest = { item: def.id, x, y, rot, variant };
    if (def.kind === 'sniper') {
      // put it on a top face: walk down to the first supported cell
      let yy = y;
      while (yy < world.h - 1 && !world.supportOwner(x, yy + 1)) yy++;
      req = { ...req, y: yy };
      // face the route
      const sx = x;
      const left = routeList.filter(([px, py]) => px < sx && Math.abs(py - yy) <= 1).length;
      const right = routeList.filter(([px, py]) => px > sx && Math.abs(py - yy) <= 1).length;
      req.variant = left > right ? 1 : 0;
    }
    if (def.kind === 'wire') {
      // look for an exposed block edge next to this cell
      for (let r = 0; r < 4; r++) {
        const t = { ...req, rot: r };
        if (checkPlacement(world, t).ok) { req = t; break; }
      }
    }
    if (def.kind === 'oval' || def.kind === 'rspikes') {
      // these sit best on a floor: drop to a supported cell (the retracting-spike assembly is 2 cells tall)
      const h = def.kind === 'rspikes' ? 2 : 1;
      let yy = y;
      while (yy < world.h - h && !world.solidCell(x, yy + h) && yy - y < 4) yy++;
      req = { ...req, y: yy, rot: 0 };
    }
    // keep pickups and hazards off the exact cells the route needs only for hard bots that want risky lines
    const c = checkPlacement(world, req);
    if (!c.ok) continue;
    if (hazard && c.cells.some(([cx, cy]) => route.has(cy * w + cx)) && !rng.chance(d.riskTolerance)) continue;
    if (out.some(o => o.x === req.x && o.y === req.y)) continue;
    out.push(req);
  }
  return out;
}

/**
 * Building on an unfinished course: try the piece around the furthest-forward reachable spots, keep the legal ones whose
 * top reaches closest to the flag, then rank a handful by how far players can actually get afterwards (route probe).
 */
export function botBridgeCandidates(world: World, nav: NavGraph, def: ItemDef, rng: Rng, max = 5): PlaceRequest[] {
  const air = airDistance(world);
  const visited = [...nav.reach(false).visited].filter(k => k >= 0 && k < world.w * world.h);
  const d = (k: number) => air[k];
  const frontier = visited.sort((a, b) => d(a) - d(b)).slice(0, 16);
  const cheap: { req: PlaceRequest; h: number }[] = [];
  const seen = new Set<string>();
  for (const k of frontier) {
    const cx = k % world.w, cy = Math.floor(k / world.w);
    for (let dx = -5; dx <= 4; dx++) for (let dy = -8; dy <= 1; dy++) for (const rot of def.rotatable ? [0, 1, 3] : [0]) {
      const req = { item: def.id, x: cx + dx, y: cy + dy, rot, variant: 0 };
      const key = `${req.x},${req.y},${rot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = checkPlacement(world, req);
      if (!c.ok) continue;
      // it must start where players can get to it: resting at, or one jump above, this reachable spot
      const bottom = Math.max(...c.cells.map(cc => cc[1]));
      if (bottom < cy - 2 || bottom > cy + 1 || Math.min(...c.cells.map(cc => Math.abs(cc[0] - cx))) > 2) continue;
      // the air cell just above the piece's best top cell: how much of the remaining path it could shorten
      let best = Infinity;
      for (const [x, y] of c.cells) { const a = world.inBounds(x, y - 1) ? air[(y - 1) * world.w + x] : Infinity; if (a < best) best = a; }
      cheap.push({ req, h: best + rng.next() * 1.5 });
    }
  }
  cheap.sort((a, b) => a.h - b.h);
  const scored: { req: PlaceRequest; p: number }[] = [];
  // full route probes are the expensive part: a few for static pieces, fewer for moving ones (timed edges)
  for (const { req } of cheap.slice(0, def.kind === 'shuttle' || def.kind === 'wheel' ? 3 : 6)) {
    const { check, nav: g, blocksRoute } = assessPlacement(world, req, nav);
    if (!check.ok || !g || blocksRoute) continue; // bots plan to keep their own way open; the rules themselves would allow sealing it
    const r = g.reach(false);
    const pr = progressOf(g.world, r.visited);
    scored.push({ req, p: r.finish ? 1e9 : pr.stage * 1000 - pr.dist });
  }
  scored.sort((a, b) => b.p - a.p);
  return scored.slice(0, max).map(s => s.req);
}

/** Fallback for timeouts: a random legal spot anywhere in the build area. */
export function randomCandidates(world: World, def: ItemDef, rng: Rng, max: number): PlaceRequest[] {
  const out: PlaceRequest[] = [];
  const b = world.map.build;
  for (let i = 0; i < 600 && out.length < max; i++) {
    const req = { item: def.id, x: rng.int(b.x, b.x + b.w - 1), y: rng.int(b.y, b.y + b.h - 1), rot: def.rotatable ? rng.int(0, 3) : 0, variant: 0 };
    if (checkPlacement(world, req).ok) out.push(req);
  }
  return out;
}

// ---------------- racing
type Mode = 'start' | 'idle' | 'align' | 'exec' | 'walk' | 'wait' | 'air' | 'wander';

export class BotRacer {
  readonly id: string;
  readonly diff: (typeof BOT_DIFFICULTY)[Difficulty];
  private rng: Rng;
  private mode: Mode = 'start';
  private plan: NavEdge[] | null = null;
  private edge: NavEdge | null = null;
  private frame = 0;
  private waitT = 0;
  private reactT: number;
  private mistakeT = 0;
  private mistakeBits = 0;
  private lastNode = -1;
  private lastProgressTick = 0;
  private visited = new Set<number>();
  private bad = new Set<NavEdge>();
  private noise = new WeakMap<NavEdge, number>();
  private target: number | null = null; // coin node detour
  private timed: NavEdge | null = null;
  private waitSince = -1;
  private waitEdge: NavEdge | null = null;
  stuckCount = 0;

  constructor(id: string, difficulty: Difficulty, seed: number) {
    this.id = id;
    this.diff = BOT_DIFFICULTY[difficulty];
    this.rng = new Rng(seed);
    this.reactT = this.diff.reaction + this.rng.range(0, 0.25);
  }

  private cost(e: NavEdge, sim: RaceSim): number {
    let n = this.noise.get(e);
    if (n === undefined) { n = 1 + this.rng.range(0, this.diff.routeNoise); this.noise.set(e, n); }
    let c = (e.frames + e.wallJumps * 8) * n;
    if (e.period) c += e.period / 4 + 20; // expected wait for a timed departure
    if (this.bad.has(e)) c += 900;
    c += hazardRisk(e, sim) * (1 - this.diff.riskTolerance) * 120;
    return c;
  }

  /** Decide this tick's input bits. */
  think(sim: RaceSim, nav: NavGraph): number {
    const p = sim.player(this.id);
    if (!p || p.status !== 'racing') return 0;
    const b = p.body;
    if (this.reactT > 0) { this.reactT -= DT; return 0; }
    let bits = this.decide(sim, nav, p);
    // occasional mistakes: a brief wrong input
    if (this.mistakeT > 0) { this.mistakeT -= DT; bits ^= this.mistakeBits; }
    else if (this.diff.mistakePerSec > 0 && this.rng.chance(this.diff.mistakePerSec * DT)) {
      this.mistakeT = this.rng.range(0.08, 0.25); this.mistakeBits = this.rng.pick([IN_LEFT, IN_RIGHT, IN_JUMP]);
    }
    // stuck detection: no new standing spot reached for a while (route order, not straight-line distance)
    if (b.grounded && this.mode !== 'exec') {
      const n = nav.prober.landingNode(b);
      if (n !== null && !this.visited.has(n)) { this.visited.add(n); this.lastProgressTick = sim.tick; }
    }
    if (this.mode !== 'exec' && sim.tick - this.lastProgressTick > 6 * TICK_HZ) {
      this.stuckCount++;
      if (this.plan?.[0]) this.bad.add(this.plan[0]);
      this.plan = null; this.edge = null; this.mode = 'idle';
      this.lastProgressTick = sim.tick;
      this.visited.clear();
    }
    return bits;
  }

  private decide(sim: RaceSim, nav: NavGraph, p: RacePlayer): number {
    const b = p.body;
    const prober = nav.prober;
    if (this.mode === 'exec' && this.edge) {
      const e = this.edge;
      if (this.frame < e.frames) {
        const f = this.frame++;
        const ex = f > 0 ? e.path[f * 2 - 2] : nav.node(e.from).x, ey = f > 0 ? e.path[f * 2 - 1] : nav.node(e.from).y;
        // drifted off the recorded line (pull, platform, collision): let physics settle and replan
        if (f > 2 && Math.hypot(ex - b.x, ey - b.y) > 52) { this.mode = 'air'; this.edge = null; return 0; }
        // closed-loop: keep the recorded jump/sprint timing but steer to track the recorded x
        let bits = e.inputs[f];
        const tx = e.path[f * 2];
        const predicted = b.x + b.vx * DT;
        const err = tx - predicted;
        if (Math.abs(err) > 1.5) {
          bits &= ~(IN_LEFT | IN_RIGHT);
          bits |= err > 0 ? IN_RIGHT : IN_LEFT;
          if (Math.abs(err) > 10) bits |= IN_SPRINT;
        }
        return bits;
      }
      this.edge = null; this.mode = b.grounded ? 'idle' : 'air';
      if (this.plan) this.plan.shift();
    }
    if (this.mode === 'air' || !b.grounded) {
      if (b.grounded) this.mode = 'idle';
      else {
        // in the air off-plan: steer toward the closest standable cell under us, wall-jump if sliding forever
        return b.wallSliding && this.rng.chance(0.03) ? IN_JUMP : 0;
      }
    }
    const ridden = b.groundMover >= 0 ? sim.movers[b.groundMover] : undefined;
    if (ridden && ridden.hz) {
      // riding a legacy moving platform: hop off toward the flag once it is roughly aligned
      const fin = sim.world.finishPx;
      const dir = fin.x > b.x ? IN_RIGHT : IN_LEFT;
      return this.rng.chance(0.04) ? dir | IN_JUMP : dir;
    }
    const node = ridden ? moverKey(ridden.o, ridden.child) : prober.landingNode(b);
    if (node === null) {
      // standing somewhere odd (edge lip, crumbling floor): shuffle toward the flag
      const fin = sim.world.finishPx;
      return fin.x > b.x ? IN_RIGHT : IN_LEFT;
    }
    if (node !== this.lastNode) { this.lastNode = node; }
    if (!this.plan || !this.plan.length || this.plan[0].from !== node) {
      this.plan = this.makePlan(sim, nav, node);
      if (!this.plan) return this.wander(sim, b);
    }
    let e = this.plan[0];
    if (e.period) {
      // timed edge: among the variants to the same place, take the one that departs soonest, then wait for its tick
      if (this.timed?.from !== e.from || this.timed.to !== e.to) this.timed = soonest(nav.edges(e.from), e, sim.tick);
      e = this.timed;
      this.plan[0] = e;
    } else this.timed = null;
    if (isMoverKey(e.from) && ridden) {
      // riding: stay centred on the live platform until the departure tick, then run the recorded jump
      const r = childRect(ridden.o, ridden.child, sim.tick);
      const want = r.x + r.w / 2 - BW / 2;
      this.holdProgress(sim, e);
      const due = (e.phase! - (sim.tick % e.period!) + e.period!) % e.period! === 0;
      const rel = want - b.x;
      if (!due) return Math.abs(rel) > 1 ? (rel > 0 ? IN_RIGHT : IN_LEFT) : 0;
      if (Math.abs(rel) > 3) return rel > 0 ? IN_RIGHT : IN_LEFT; // missed this lap's window: try the next one
      this.edge = e; this.frame = 0; this.mode = 'exec';
      return e.inputs[this.frame++];
    }
    const start = nav.node(e.from);
    const dx = start.x - b.x;
    if (e.kind === 'walk' && e.frames < 40 && !e.period) {
      // walking edges: steer straight to the next cell, no need to stop and align
      const nxt = e.to === FINISH ? null : nav.node(e.to);
      if (nxt) {
        const ddx = nxt.x - b.x;
        if (Math.abs(ddx) < 3) { this.plan.shift(); return 0; }
        if (b.groundSurf === S_ICE) return steerTo(b, ddx, 2);
        return ddx > 0 ? IN_RIGHT : IN_LEFT;
      }
    }
    // align on the recorded start position
    if (Math.abs(dx) > this.diff.alignTol || Math.abs(b.vx) > 30) return steerTo(b, dx, this.diff.alignTol);
    // wait for a safe window on timed hazards
    if (this.waitT <= 0 && this.rng.chance(this.diff.safetyCheck) && !edgeSafe(e, sim)) { this.waitT = 0.25; }
    if (this.waitT > 0) {
      this.waitT -= DT;
      if (this.waitT <= 0 && !edgeSafe(e, sim) && this.rng.chance(0.85)) this.waitT = 0.2;
      return 0;
    }
    if (e.period && (e.phase! - (sim.tick % e.period) + e.period) % e.period !== 0) { this.holdProgress(sim, e); return 0; } // wait for the platform
    this.edge = e; this.frame = 0; this.mode = 'exec';
    return e.inputs[this.frame++];
  }

  /** Waiting for a platform is progress, for up to two of its cycles; after that the stuck detector may step in. */
  private holdProgress(sim: RaceSim, e: NavEdge) {
    if (this.waitSince < 0 || this.waitEdge !== e) { this.waitSince = sim.tick; this.waitEdge = e; }
    if (sim.tick - this.waitSince < 2 * e.period!) this.lastProgressTick = sim.tick;
  }

  private makePlan(sim: RaceSim, nav: NavGraph, node: number): NavEdge[] | null {
    const direct = nav.route(node, e => this.cost(e, sim));
    // coin detour: only when cheap and the bot is greedy enough
    if (direct && this.rng.chance(this.diff.coinGreed)) {
      const coin = sim.coins.find(c => (c.state === 'origin' || c.state === 'dropped'));
      if (coin) {
        const ck = nav.prober.landingNode({ x: coin.x - BW / 2, y: Math.floor(coin.y / CELL + 1) * CELL - BH } as never);
        if (ck !== null && ck !== node) {
          const toCoin = routeTo(nav, node, ck, e => this.cost(e, sim));
          if (toCoin && toCoin.reduce((a, e) => a + e.frames, 0) < 360) return toCoin;
        }
      }
    }
    return direct;
  }

  private wander(sim: RaceSim, b: { x: number; grounded: boolean }): number {
    const fin = sim.world.finishPx;
    const dir = fin.x > b.x ? IN_RIGHT : IN_LEFT;
    return dir | (this.rng.chance(0.06) ? IN_JUMP : 0) | (this.rng.chance(0.5) ? IN_SPRINT : 0);
  }
}

/** Ground steering to a target offset that accounts for ice: brake by counter-steering when release would slide. */
/** The variant of a timed edge (same start and destination) whose departure tick comes up first. */
function soonest(edges: NavEdge[], e: NavEdge, tick: number): NavEdge {
  let best = e, bestWait = Infinity;
  for (const c of edges) {
    if (c.to !== e.to || !c.period) continue;
    const wait = (c.phase! - (tick % c.period) + c.period) % c.period;
    if (wait < bestWait || (wait === bestWait && c.frames < best.frames)) { best = c; bestWait = wait; }
  }
  return best;
}

function steerTo(b: { vx: number; groundSurf: number }, dx: number, tol: number): number {
  const ice = b.groundSurf === S_ICE;
  const decel = ice ? PHYS.groundAccel * PHYS.iceAccelMul + PHYS.groundDecel * PHYS.iceDecelMul : PHYS.groundDecel;
  const stop = (b.vx * b.vx) / (2 * decel);
  const toward = Math.sign(b.vx) === Math.sign(dx) && b.vx !== 0;
  if (toward && Math.abs(dx) <= stop + 0.5) return ice ? (b.vx > 0 ? IN_LEFT : IN_RIGHT) : 0;
  if (Math.abs(dx) <= tol) return ice && Math.abs(b.vx) > 20 ? (b.vx > 0 ? IN_LEFT : IN_RIGHT) : 0;
  return dx > 0 ? IN_RIGHT : IN_LEFT;
}

function routeTo(nav: NavGraph, from: number, to: number, cost: (e: NavEdge) => number): NavEdge[] | null {
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, NavEdge>();
  const open: [number, number][] = [[0, from]];
  const done = new Set<number>();
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, k] = open.shift()!;
    if (k === to) break;
    if (done.has(k)) continue;
    done.add(k);
    if (done.size > 400) break;
    for (const e of nav.edges(k)) {
      if (e.to === FINISH) continue;
      const nd = d + cost(e);
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, e); open.push([nd, e.to]); }
    }
  }
  if (!prev.has(to)) return null;
  const out: NavEdge[] = [];
  let k = to;
  while (k !== from) { const e = prev.get(k)!; out.unshift(e); k = e.from; }
  return out;
}

const riskCache = new WeakMap<NavEdge, { sim: RaceSim; v: number }>();
/** Static proximity of an edge's path to timed hazards and black holes. */
function hazardRisk(e: NavEdge, sim: RaceSim): number {
  const c = riskCache.get(e);
  if (c && c.sim === sim) return c.v;
  let v = 0;
  for (const h of sim.hz) {
    if (h.kind === 'moving') continue;
    const cc = cellCenter(h.o.x, h.o.y);
    const reach = h.kind === 'pendulum' ? HAZARD.pendulumArm + 40 : h.kind === 'laser' ? HAZARD.laserMaxCells * CELL : 80;
    for (let i = 0; i < e.path.length; i += 8) {
      if (Math.hypot(e.path[i] + BW / 2 - cc.x, e.path[i + 1] + BH / 2 - cc.y) < reach) { v += 1; break; }
    }
  }
  riskCache.set(e, { sim, v });
  return v;
}

/** Predict timed hazards and projectiles along the edge's recorded path. */
export function edgeSafe(e: NavEdge, sim: RaceSim): boolean {
  const slow = sim.slowMul;
  for (let f = 0; f < e.frames; f += 3) {
    const x = e.path[f * 2], y = e.path[f * 2 + 1];
    const br: Rect = { x: x - 4, y: y - 4, w: BW + 8, h: BH + 8 };
    const t = f * DT;
    for (const h of sim.hz) {
      const ph = h.phase + t * (h.slowable ? slow : 1);
      if (h.kind === 'rspikes' && rspikeState(ph) !== 'in' && rspikeParts(h.o).spikes.some(([cx, cy]) => rectsOverlap(br, spikeStripPx(cx, cy, h.o.rot)))) return false;
      if (h.kind === 'laser' && laserState(ph) !== 'off') { const r = laserBeamRect(h.o, h.beam); if (r && rectsOverlap(br, r)) return false; }
      if (h.kind === 'saw') { const s = sawPos(h.o, ph); if (circleRect(s.x, s.y, HAZARD.sawR + 6, br)) return false; }
      if (h.kind === 'pendulum') { const s = pendulumPos(h.o, ph).ball; if (circleRect(s.x, s.y, HAZARD.pendulumBallR + 6, br)) return false; }
    }
    for (const pr of sim.projectiles) {
      let px = pr.x + pr.vx * t, py = pr.y + pr.vy * t;
      if (pr.kind === 'cannon') py += 0.5 * HAZARD.cannonGravity * t * t;
      if (circleRect(px, py, pr.r + 6, br)) return false;
      void px;
    }
    // launchers about to fire across the path
    for (const h of sim.hz) {
      if (h.kind !== 'sniper' && h.kind !== 'crossbow' && h.kind !== 'cannon') continue;
      const interval = h.kind === 'sniper' ? HAZARD.sniperInterval : h.kind === 'crossbow' ? HAZARD.crossbowInterval : HAZARD.cannonInterval;
      const tNow = sim.tick / TICK_HZ + t;
      const sinceFire = tNow % interval;
      // the shot lands instantly on the firing tick, so stay off its line from just before it fires until just after
      if (h.kind === 'sniper' && (sinceFire > interval - 0.2 || sinceFire < 0.05)) {
        const cc = cellCenter(h.o.x, h.o.y);
        if (Math.abs(cc.y - 6 - (y + BH / 2)) < BH / 2 + 4 && (h.o.variant === 1 ? x < cc.x : x > cc.x)) return false;
      }
    }
  }
  void TERRAIN_ID;
  return true;
}
