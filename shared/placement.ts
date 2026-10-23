// Placement and demolition rules. The client preview and the server call the same functions with the same integers.
import { CELL, HAZARD, MATCH } from './config';
import { DIRS, rotDirIndex, type Cell, type Rect, type Rot } from './grid';
import { pendulumSweep } from './hazards';
import { cellsTouched, childCount, childRect, isKinematic, newMotion, referenceHit, sweepOf } from './movers';
import { getItem, ITEMS, SUPPORT_KINDS, type ItemDef } from './items';
import { NavGraph } from './nav';
import { C_SOLID, footprint, TERRAIN_ID, type PlacedObject, World } from './world';

export interface PlaceRequest { item: string; x: number; y: number; rot: number; variant: number }

export interface PlaceCheck {
  ok: boolean;
  reason?: string;
  cells: Cell[];
  support: string | null;
  wireLen?: number;
  trimmed?: number; // wire segments removed for lack of support
  targets?: string[]; // bomb: objects removed directly
  dependents?: string[]; // bomb: attached objects removed with them
  warning?: string;
  region?: Rect | null;
  /** moving platforms: every cell the platform passes over (shown in the build preview; reserves nothing) */
  sweep?: Cell[];
  /** Ferris wheel: gondolas whose whole starting body is in legal open space (at least one is needed), and the start cells that overlap terrain or items */
  validChildren?: number[];
  overlapCells?: Cell[];
  /** platforms that start partly inside a wall: how many of their start cells are wall (shown in the preview) */
  wallCells?: Cell[];
}

const KINEMATIC = new Set(['shuttle', 'wheel']);

function rectOfCells(cells: Cell[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0 * CELL, y: y0 * CELL, w: (x1 - x0 + 1) * CELL, h: (y1 - y0 + 1) * CELL };
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

/** Shape, bounds, occupancy, zones and attachment. No route search. */
export function checkPlacement(world: World, req: PlaceRequest): PlaceCheck {
  const fail = (reason: string, cells: Cell[] = [], extra: Partial<PlaceCheck> = {}): PlaceCheck => ({ ok: false, reason, cells, support: null, ...extra });
  const def: ItemDef | undefined = ITEMS[req.item];
  if (!def) return fail('Unknown item');
  if (!isInt(req.x) || !isInt(req.y) || !isInt(req.rot) || !isInt(req.variant)) return fail('Placement must snap to the grid');
  if (req.rot < 0 || req.rot > 3) return fail('Bad rotation');
  if (!def.rotatable && req.rot !== 0) return fail(`${def.name} can't be rotated`);
  const maxVariant = def.variants ? def.variants.length - 1 : 0;
  if (req.variant < 0 || req.variant > maxVariant) return fail('Bad variant');
  const rot = req.rot as Rot;
  const b = world.map.build;
  const inBuild = (x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;

  if (def.kind === 'bomb') {
    const n = def.bombSize ?? 1;
    const cells: Cell[] = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cells.push([req.x + dx, req.y + dy]);
    if (!cells.every(([x, y]) => world.inBounds(x, y))) return fail('Blast area is outside the map', cells);
    const hit = new Set<string>();
    let permanent = false;
    for (const [x, y] of cells) {
      const id = world.occAt(x, y);
      if (!id) continue;
      if (id === TERRAIN_ID) { permanent = true; continue; }
      const o = world.objects.get(id);
      if (!o) continue;
      if (o.prov === 'map') { permanent = true; continue; } // map-authored wire is indestructible
      hit.add(o.id);
    }
    // moving platforms are hit at their GO pose (the pose the build view freezes on while a bomb is selected)
    const blast: Rect = { x: req.x * CELL, y: req.y * CELL, w: n * CELL, h: n * CELL };
    for (const o of world.kinematic) if (o.prov === 'player' && referenceHit(o, blast)) hit.add(o.id);
    if (hit.size === 0) return fail(permanent ? 'No removable items here (map terrain is permanent)' : 'No removable items here', cells);
    const deps = dependentsOf(world, hit);
    return { ok: true, cells, support: null, targets: [...hit], dependents: [...deps], region: regionOf(world, [...hit, ...deps]) };
  }

  const fp = footprint(world, def, req.x, req.y, rot);
  let cells = fp.cells;
  let trimmed = 0;
  if (def.kind === 'wire' || def.kind === 'sniper') {
    // nothing bolts onto moving platforms: attachments on moving bodies aren't supported
    const n = def.kind === 'sniper' ? [0, 1] : [[0, 1], [-1, 0], [0, -1], [1, 0]][rot];
    const sx = req.x + n[0], sy = req.y + n[1];
    const id = world.occAt(sx, sy);
    const so = id && id !== TERRAIN_ID ? world.objects.get(id) : null;
    if (so && isKinematic(so)) return fail(`${def.kind === 'sniper' ? 'Snipers' : 'Barbed wire'} can't attach to moving platforms`, [[req.x, req.y]]);
  }
  if (def.kind === 'wire') {
    trimmed = (def.wireLength ?? 1) - cells.length;
    if (cells.length === 0) return fail('Barbed wire must touch an exposed block edge', [[req.x, req.y]]);
  }
  if (cells.length === 0) return fail('Nothing to place');
  for (const [x, y] of cells) {
    if (!world.inBounds(x, y) || !inBuild(x, y)) return fail('Outside the build area', cells);
  }
  // Platforms that glide through walls may start partly inside terrain, never wholly (checked below); everything else is ordinary occupancy.
  const wallOk = def.kind === 'shuttle' || def.kind === 'moving';
  const wallCells: Cell[] = [];
  for (const [x, y] of cells) {
    const o = world.occAt(x, y);
    if (o === TERRAIN_ID) {
      const t = world.terrainAt(x, y);
      if (wallOk && (t === 1 || t === 2)) { wallCells.push([x, y]); continue; }
      return fail('Overlaps the map terrain', cells);
    }
    if (o) {
      const other = world.objects.get(o);
      const od = other ? getItem(other.item) : null;
      return fail(od?.solid ? 'Overlaps another solid object' : `Overlaps ${od ? 'a ' + od.name : 'another item'}`, cells);
    }
  }
  if (wallOk && wallCells.length === cells.length) return fail('A moving platform can’t start completely inside a wall', cells, { wallCells });
  for (const [x, y] of cells) {
    if (world.isProtectedCell(x, y)) {
      const s = world.protectedCells[0];
      const inStart = x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
      return fail(inStart ? 'Inside start safety zone' : 'Inside finish safety zone', cells);
    }
  }
  let support: string | null = fp.support;
  if (KINEMATIC.has(def.kind) || def.kind === 'moving') {
    const probe: PlacedObject = { id: '_probe', item: def.id, owner: null, prov: 'player', x: req.x, y: req.y, rot, variant: req.variant, cells, attach: null, round: 0, mv: newMotion(def.id, req.variant) };
    // the whole route must stay on the map and out of the start and finish safety zones; walls, blocks and other platforms are no obstacle
    let travel: Cell[];
    let bbox: Rect;
    if (def.kind === 'moving') {
      const t = DIRS[rotDirIndex(1, rot)], len = HAZARD.movingPathCells * CELL;
      const r0 = rectOfCells(cells), r1 = { ...r0, x: r0.x + t.x * len, y: r0.y + t.y * len };
      travel = [...cellsTouched(r0), ...cellsTouched(r1), ...cellsTouched({ x: Math.min(r0.x, r1.x), y: Math.min(r0.y, r1.y), w: r0.w + Math.abs(t.x) * len, h: r0.h + Math.abs(t.y) * len })];
      bbox = { x: Math.min(r0.x, r1.x), y: Math.min(r0.y, r1.y), w: r0.w + Math.abs(t.x) * len, h: r0.h + Math.abs(t.y) * len };
    } else { const sw = sweepOf(probe); travel = sw.sweep; bbox = sw.bbox; }
    const shown = def.kind === 'moving' ? undefined : travel;
    for (const [x, y] of travel) {
      if (!world.inBounds(x, y)) return fail(def.kind === 'moving' ? 'Its path would leave the map' : 'Its path leaves the map', cells, { sweep: shown, wallCells });
      if (world.isProtectedCell(x, y)) return fail('Its path enters a safety zone', cells, { sweep: shown, wallCells });
    }
    const extra: Partial<PlaceCheck> = { sweep: shown, wallCells };
    if (def.kind === 'wheel') {
      // at least one whole gondola must start in legal open space; the others may begin inside blocks and terrain and still orbit
      const valid: number[] = [], overlap: Cell[] = [];
      for (let i = 0; i < childCount(probe); i++) {
        let ok = true;
        for (const [x, y] of cellsTouched(childRect(probe, i, 0))) {
          const bad = !world.inBounds(x, y) || !inBuild(x, y) || world.occAt(x, y) !== '' || world.isProtectedCell(x, y);
          if (bad) { ok = false; if (world.inBounds(x, y) && world.occAt(x, y) !== '') overlap.push([x, y]); }
        }
        if (ok) valid.push(i);
      }
      extra.validChildren = valid; extra.overlapCells = overlap;
      if (valid.length === 0) return fail('At least one gondola has to start in open space', cells, { sweep: shown, validChildren: valid, overlapCells: overlap });
    }
    if (world.playerObjectCount() >= MATCH.maxPlacedObjects) return fail('The course is full', cells, extra);
    return { ok: true, cells, support: null, trimmed: 0, region: { x: bbox.x - CELL, y: bbox.y - CELL, w: bbox.w + 2 * CELL, h: bbox.h + 2 * CELL }, ...extra };
  }
  if (def.kind === 'sniper') {
    const owner = world.supportOwner(req.x, req.y + 1);
    if (!owner) return fail('Snipers must sit on top of a solid block', cells);
    if (owner !== TERRAIN_ID) {
      const so = world.objects.get(owner)!;
      if (!SUPPORT_KINDS.has(getItem(so.item).kind)) return fail('Snipers need a stationary solid block underneath', cells);
    }
    support = owner;
  }
  if (def.kind === 'pendulum') {
    const probe: PlacedObject = { id: '_', item: def.id, owner: null, prov: 'player', x: req.x, y: req.y, rot, variant: 0, cells, attach: null, round: 0 };
    for (const p of pendulumSweep(probe)) {
      if (world.inProtectedPx(p.x, p.y)) return fail('The blade would swing into a safety zone', cells);
      if (p.x < 0 || p.y < 0 || p.x > world.w * CELL || p.y > world.h * CELL) return fail('The blade would swing off the map', cells);
    }
  }
  if (world.playerObjectCount() >= MATCH.maxPlacedObjects) return fail('The course is full', cells);
  const region = regionForCells(cells, def.kind === 'blackhole' ? HAZARD.holeRadius + CELL : def.kind === 'pendulum' ? HAZARD.pendulumArm + CELL : CELL);
  return { ok: true, cells, support, wireLen: def.kind === 'wire' ? cells.length : undefined, trimmed, region };
}

export function regionForCells(cells: Cell[], pad: number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0 * CELL - pad, y: y0 * CELL - pad, w: (x1 - x0 + 1) * CELL + 2 * pad, h: (y1 - y0 + 1) * CELL + 2 * pad };
}

function regionOf(world: World, ids: string[]): Rect | null {
  const cells: Cell[] = [];
  let pad = CELL;
  for (const id of ids) {
    const o = world.objects.get(id);
    if (!o) continue;
    cells.push(...o.cells);
    if (isKinematic(o)) cells.push(...sweepOf(o).sweep);
    const k = getItem(o.item).kind;
    if (k === 'blackhole') pad = Math.max(pad, HAZARD.holeRadius + CELL);
    if (k === 'pendulum') pad = Math.max(pad, HAZARD.pendulumArm + CELL);
  }
  return cells.length ? regionForCells(cells, pad) : null;
}

/** Snipers and wire bolted to removed objects go with them (transitively). */
export function dependentsOf(world: World, removed: Set<string>): Set<string> {
  const deps = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of world.objects.values()) {
      if (o.prov !== 'player' || removed.has(o.id) || deps.has(o.id)) continue;
      if (o.attach && o.attach !== TERRAIN_ID && (removed.has(o.attach) || deps.has(o.attach))) { deps.add(o.id); changed = true; }
    }
  }
  return deps;
}

export function makeObject(world: World, req: PlaceRequest, chk: PlaceCheck, owner: string, round: number): PlacedObject {
  const def = getItem(req.item);
  return {
    id: world.allocId(), item: def.id, owner, prov: 'player', x: req.x, y: req.y, rot: req.rot as Rot, variant: req.variant,
    cells: chk.cells, attach: def.kind === 'wire' || def.kind === 'sniper' ? chk.support : null, wireLen: chk.wireLen, round,
    ...(KINEMATIC.has(def.kind) ? { mv: newMotion(def.id, req.variant) } : {}),
  };
}

/**
 * Advisory route assessment for bots and optional warnings. It NEVER decides whether a placement is accepted: any
 * placement that passes checkPlacement is legal even when it seals the course. `blocksRoute` is true when the placement
 * would leave no route to the flag on a course that had one.
 */
export function assessPlacement(world: World, req: PlaceRequest, nav: NavGraph | null): { check: PlaceCheck; nav: NavGraph | null; blocksRoute: boolean; cutsProgress: boolean } {
  const check = checkPlacement(world, req);
  if (!check.ok) return { check, nav, blocksRoute: false, cutsProgress: false };
  const def = getItem(req.item);
  const test = world.clone();
  if (def.kind === 'bomb') {
    for (const id of [...check.targets!, ...check.dependents!]) test.objects.delete(id);
    test.rebuild();
    const g = nav ? NavGraph.derive(nav, test, check.region ?? null) : new NavGraph(test);
    return { check, nav: g, blocksRoute: false, cutsProgress: false };
  }
  const obj = makeObject(test, req, check, '_probe', 0);
  test.objects.set(obj.id, obj);
  test.rebuild();
  const g = nav ? NavGraph.derive(nav, test, check.region ?? null) : new NavGraph(test);
  const r = g.reach(false);
  if (r.finish) return { check, nav: g, blocksRoute: false, cutsProgress: false };
  const before = (nav ?? new NavGraph(world)).reach(false);
  if (before.finish) return { check, nav: g, blocksRoute: true, cutsProgress: true };
  const pb = progressOf(world, before.visited), pa = progressOf(test, r.visited);
  const cuts = pa.stage < pb.stage || (pa.stage === pb.stage && pa.dist > pb.dist + 0.01);
  return { check, nav: g, blocksRoute: false, cutsProgress: cuts };
}

/**
 * Air-path distance (cells) from every open cell of a map to its flag, through cells free of map terrain. Unlike a
 * straight line it knows that the space under an overhang is further from the goal than the open edge beside it.
 */
const airCache = new Map<string, Float64Array>();
export function airDistance(world: World): Float64Array {
  const m = world.map;
  let d = airCache.get(m.id);
  if (d) return d;
  d = new Float64Array(world.w * world.h).fill(Infinity);
  const q: number[] = [];
  for (let y = m.finish.y; y < m.finish.y + m.finish.h; y++) for (let x = m.finish.x; x < m.finish.x + m.finish.w; x++) { d[y * world.w + x] = 0; q.push(y * world.w + x); }
  for (let i = 0; i < q.length; i++) {
    const k = q[i], x = k % world.w, y = Math.floor(k / world.w);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (!world.inBounds(nx, ny)) continue;
      const t = world.terrainAt(nx, ny);
      const nk = ny * world.w + nx;
      if (t === 1 || t === 2 || d[nk] <= d[k] + 1) continue;
      d[nk] = d[k] + 1; q.push(nk);
    }
  }
  airCache.set(m.id, d);
  return d;
}

/** How far toward the flag a reachable set gets: highest map stage touched, then the shortest air path left (cells). */
export function progressOf(world: World, visited: Set<number>): { stage: number; dist: number } {
  const m = world.map;
  const air = airDistance(world);
  let stage = -1, dist = Infinity;
  for (const k of visited) {
    if (k < 0 || k >= world.w * world.h) continue; // riding nodes count through where they let players land
    const cx = k % world.w, cy = Math.floor(k / world.w);
    dist = Math.min(dist, air[k]);
    if (m.stages) m.stages.forEach((z, i) => { if (i > stage && cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h) stage = i; });
  }
  return { stage, dist };
}

/** Commit an already validated placement. */
export function applyPlacement(world: World, obj: PlacedObject) { world.objects.set(obj.id, obj); world.rebuild(); }

export function applyBomb(world: World, ids: string[]): string[] {
  const removed: string[] = [];
  for (const id of ids) { const o = world.objects.get(id); if (o && o.prov === 'player') { world.objects.delete(id); removed.push(id); } }
  // re-resolve dependents against the post-blast world
  const deps = dependentsOf(world, new Set(removed));
  for (const id of deps) { world.objects.delete(id); removed.push(id); }
  world.rebuild();
  return removed;
}
