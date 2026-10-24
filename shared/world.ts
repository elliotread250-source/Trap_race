// Persistent course state: immutable map terrain plus placed objects, an occupancy grid and a derived collision grid.
import { CELL, CONTENT_VERSION, HAZARD, PROTECT_PAD_CELLS } from './config';
import { DIRS, rotDirIndex, rotateMask, type Cell, type Rect, type Rot } from './grid';
import { getItem, ITEMS, LEGACY_ITEMS, type ItemDef } from './items';
import { getMap, type MapDef } from './maps';
import { newMotion, type Motion } from './movers';

export type Provenance = 'map' | 'player';

export interface PlacedObject {
  id: string;
  item: string;
  owner: string | null;
  prov: Provenance;
  x: number; // anchor cell
  y: number;
  rot: Rot;
  variant: number;
  cells: Cell[]; // absolute occupied placement footprint
  attach: string | null; // support object id, 'terrain' for map terrain
  wireLen?: number;
  round: number;
  /** kinematic platforms only: the authoritative motion definition */
  mv?: Motion;
}

export const TERRAIN_ID = 'terrain';

const idNum = (id: string) => { const n = Number(id.slice(1)); return Number.isFinite(n) ? n : 1e9; };

// collision cell types
export const C_EMPTY = 0, C_SOLID = 1, C_ONEWAY = 2;
// surface types
export const S_NORMAL = 0, S_ICE = 1, S_CONVEYOR = 2;

export class World {
  readonly map: MapDef;
  readonly w: number;
  readonly h: number;
  /** 0 empty, 1 solid, 2 ice, 3 oneway (map authored, normal up) */
  readonly terrain: Uint8Array;
  objects = new Map<string, PlacedObject>();
  /** placement occupancy: '' empty, 'terrain', or object id */
  occ: string[];
  coll: Uint8Array;
  collDir: Uint8Array; // one-way normal / conveyor normal
  surf: Uint8Array;
  collObj: (string | null)[];
  /** kinematic platform objects in a stable order (numeric id), shared by server and clients */
  kinematic: PlacedObject[] = [];
  /** coins that were carried to the flag: gone for the rest of the match (tombstones, so nothing can bring them back) */
  consumed = new Set<string>();
  version = 0;
  nextId = 1;
  readonly spawnPx: Rect;
  readonly finishPx: Rect;
  readonly protectedCells: Rect[];
  readonly protectedPx: Rect[];

  constructor(mapId: string) {
    this.map = getMap(mapId);
    this.w = this.map.w;
    this.h = this.map.h;
    const n = this.w * this.h;
    this.terrain = new Uint8Array(n);
    for (const r of this.map.terrain) {
      const code = r.t === 'solid' ? 1 : r.t === 'ice' ? 2 : 3;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (this.inBounds(x, y)) this.terrain[y * this.w + x] = code;
    }
    this.occ = new Array(n).fill('');
    this.coll = new Uint8Array(n);
    this.collDir = new Uint8Array(n);
    this.surf = new Uint8Array(n);
    this.collObj = new Array(n).fill(null);
    const m = this.map;
    this.spawnPx = { x: m.spawn.x * CELL, y: m.spawn.y * CELL, w: m.spawn.w * CELL, h: m.spawn.h * CELL };
    this.finishPx = { x: m.finish.x * CELL, y: m.finish.y * CELL, w: m.finish.w * CELL, h: m.finish.h * CELL };
    const pad = PROTECT_PAD_CELLS;
    this.protectedCells = [m.spawn, m.finish].map(r => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }));
    this.protectedPx = this.protectedCells.map(r => ({ x: r.x * CELL, y: r.y * CELL, w: r.w * CELL, h: r.h * CELL }));
    // map-authored barbed wire is the only map trap
    m.wires.forEach((wd, i) => {
      const cells = wireCells(this, wd.x, wd.y, wd.rot, wd.len, true);
      if (cells.cells.length === 0) throw new Error(`map ${m.id} wire ${i} has no support`);
      const item = `wire_${Math.min(3, Math.max(1, wd.len))}`;
      this.objects.set(`m${i}`, { id: `m${i}`, item, owner: null, prov: 'map', x: wd.x, y: wd.y, rot: wd.rot, variant: 0, cells: cells.cells, attach: TERRAIN_ID, wireLen: cells.cells.length, round: 0 });
    });
    this.rebuild();
  }

  inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  idx(x: number, y: number) { return y * this.w + x; }
  terrainAt(x: number, y: number): number { return this.inBounds(x, y) ? this.terrain[this.idx(x, y)] : 0; }
  occAt(x: number, y: number): string { return this.inBounds(x, y) ? this.occ[this.idx(x, y)] : TERRAIN_ID; }

  /** Recompute occupancy and collision from terrain + objects. */
  rebuild() {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const t = this.terrain[i];
      this.occ[i] = t ? TERRAIN_ID : '';
      this.coll[i] = t === 1 || t === 2 ? C_SOLID : t === 3 ? C_ONEWAY : C_EMPTY;
      this.collDir[i] = 0;
      this.surf[i] = t === 2 ? S_ICE : S_NORMAL;
      this.collObj[i] = null;
    }
    this.kinematic = [];
    for (const o of this.objects.values()) {
      const def = getItem(o.item);
      const kin = def.kind === 'shuttle' || def.kind === 'wheel';
      if (kin) this.kinematic.push(o);
      // the retracting-spike assembly is solid only under its spikes (its base); everything else solid is solid all over
      const baseKeys = def.kind === 'rspikes' ? new Set(rspikeBase(o).map(c => c[1] * this.w + c[0])) : null;
      for (const [x, y] of o.cells) {
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        if (def.overlay) continue; // saw rails and ice take up no grid squares (see applyOverlays)
        this.occ[i] = o.id;
        if (def.kind === 'moving' || kin) continue; // dynamic, not in the static grid
        if (def.solid || (baseKeys && baseKeys.has(i))) { this.coll[i] = C_SOLID; this.collObj[i] = o.id; }
        if (def.kind === 'oneway') { this.coll[i] = C_ONEWAY; this.collDir[i] = rotDirIndex(0, o.rot); this.collObj[i] = o.id; }
        if (def.kind === 'conveyor') { this.surf[i] = S_CONVEYOR; this.collDir[i] = rotDirIndex(1, o.rot); } // belt tangent
      }
    }
    this.kinematic.sort((a, b) => idNum(a.id) - idNum(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.applyOverlays();
    this.version++;
  }

  /** Ice coats the top surface under each of its cells (ice on a moving platform rides with it instead: see race.ts). */
  private applyOverlays() {
    for (const o of this.objects.values()) {
      if (getItem(o.item).kind !== 'ice') continue;
      const sup = o.attach && o.attach !== TERRAIN_ID ? this.objects.get(o.attach) : null;
      if (sup && (getItem(sup.item).kind === 'shuttle' || getItem(sup.item).kind === 'moving')) continue;
      for (const [x, y] of o.cells) {
        if (!this.inBounds(x, y + 1)) continue;
        const i = this.idx(x, y + 1);
        if ((this.coll[i] === C_SOLID || this.coll[i] === C_ONEWAY) && this.surf[i] !== S_CONVEYOR) this.surf[i] = S_ICE;
      }
    }
  }

  isProtectedCell(x: number, y: number): boolean {
    return this.protectedCells.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }
  inProtectedPx(px: number, py: number): boolean {
    return this.protectedPx.some(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
  }

  /** Static solid test (ignores crumble state; race code layers that on top). */
  solidCell(x: number, y: number): boolean {
    if (x < 0 || x >= this.w || y < 0) return true;
    if (y >= this.h) return false;
    return this.coll[this.idx(x, y)] === C_SOLID;
  }

  /** Object that owns a collision cell, or 'terrain'. */
  supportOwner(x: number, y: number): string | null {
    if (!this.inBounds(x, y)) return null;
    const i = this.idx(x, y);
    const t = this.terrain[i];
    if (t === 1 || t === 2) return TERRAIN_ID;
    const id = this.occ[i];
    if (!id || id === TERRAIN_ID) return null;
    const o = this.objects.get(id);
    if (!o) return null;
    const def = getItem(o.item);
    return def.supportive ? o.id : null;
  }

  allocId(): string { return `o${this.nextId++}`; }

  playerObjectCount(): number { let n = 0; for (const o of this.objects.values()) if (o.prov === 'player') n++; return n; }

  toJSON(): WorldSnapshot {
    return { mapId: this.map.id, content: CONTENT_VERSION, version: this.version, nextId: this.nextId, objects: [...this.objects.values()], consumed: [...this.consumed] };
  }

  /** Builds a world from a snapshot, migrating data saved under an older content version first (never throws on legacy items). */
  static fromJSON(s0: WorldSnapshot): World {
    const s = migrateSnapshot(s0).snapshot;
    const w = new World(s.mapId);
    w.objects.clear();
    for (const o of s.objects) w.objects.set(o.id, { ...o, cells: o.cells.map(c => [c[0], c[1]] as Cell), mv: o.mv ? { ...o.mv } : undefined });
    w.consumed = new Set(s.consumed ?? []);
    w.nextId = s.nextId;
    w.rebuild();
    w.version = s.version;
    return w;
  }

  /** A coin carried to the flag is removed for the rest of the match. Idempotent: consuming twice changes nothing. */
  consumeCoin(id: string): boolean {
    if (this.consumed.has(id)) return false;
    this.consumed.add(id);
    if (this.objects.delete(id)) this.rebuild();
    return true;
  }

  clone(): World { return World.fromJSON(JSON.parse(JSON.stringify(this.toJSON()))); }
}

export interface WorldSnapshot { mapId: string; content?: number; version: number; nextId: number; objects: PlacedObject[]; consumed?: string[] }

/**
 * Retracting spikes are one assembly: a solid 2x1 base block with the spike row on its outward face. The outward normal
 * is "up" at rotation 0 and turns with the item, so for any rotation the spike cells are the two furthest along it.
 */
export function splitRspike(cells: readonly Cell[], rot: Rot | number): { base: Cell[]; spikes: Cell[] } {
  const n = DIRS[rotDirIndex(0, rot)];
  const key = (c: Cell) => c[0] * n.x + c[1] * n.y;
  let best = -Infinity;
  for (const c of cells) best = Math.max(best, key(c));
  const spikes: Cell[] = [], base: Cell[] = [];
  for (const c of cells) (key(c) === best ? spikes : base).push([c[0], c[1]]);
  return { base, spikes };
}
export function rspikeBase(o: PlacedObject): Cell[] { return splitRspike(o.cells, o.rot).base; }

export interface Migration { snapshot: WorldSnapshot; converted: string[]; removed: string[] }

/**
 * Brings a saved world up to the current content version. Removed items (Dart Launcher) are dropped; the Spike Strip
 * becomes a Spiky Oval and the old flat Retracting Spikes gain their base block, but only when the bigger shape fits
 * on free cells of the same place. Otherwise the instance is removed and reported, never squeezed in among neighbours.
 */
export function migrateSnapshot(s: WorldSnapshot): Migration {
  if ((s.content ?? 1) >= CONTENT_VERSION) return { snapshot: s, converted: [], removed: [] };
  const base = new World(s.mapId);
  const taken = new Set<string>();
  for (const o of s.objects) if (ITEMS[o.item] || o.item in LEGACY_ITEMS) for (const [x, y] of o.cells) taken.add(`${x},${y}`);
  const free = (cells: Cell[], own: Cell[]) => {
    const mine = new Set(own.map(c => `${c[0]},${c[1]}`));
    return cells.every(([x, y]) => base.inBounds(x, y) && !base.terrainAt(x, y) && (mine.has(`${x},${y}`) || !taken.has(`${x},${y}`)));
  };
  const out: PlacedObject[] = [], converted: string[] = [], removed: string[] = [];
  for (const o of s.objects) {
    let item = o.item;
    let cells = o.cells.map(c => [c[0], c[1]] as Cell);
    let x = o.x, y = o.y;
    if (o.item in LEGACY_ITEMS) {
      const repl = LEGACY_ITEMS[o.item];
      if (!repl) { removed.push(o.id); continue; }
      const t = DIRS[rotDirIndex(1, o.rot)];
      const last = cells.reduce((a, c) => (c[0] * t.x + c[1] * t.y > a[0] * t.x + a[1] * t.y ? c : a));
      const next: Cell = [last[0] + t.x, last[1] + t.y];
      const grown: Cell[] = [...cells, next];
      if (!free(grown, cells)) { removed.push(o.id); continue; }
      item = repl; cells = grown;
    } else if (!ITEMS[o.item]) { removed.push(o.id); continue; }
    else if (o.item === 'rspikes' && cells.length === 2) {
      const n = DIRS[rotDirIndex(0, o.rot)];
      const under: Cell[] = cells.map(([cx, cy]) => [cx - n.x, cy - n.y] as Cell);
      const all: Cell[] = [...cells, ...under];
      if (!free(all, cells)) { removed.push(o.id); continue; }
      cells = all;
    } else if (o.mv && (o.item === 'shuttle' || o.item === 'wheel')) {
      // a stored motion definition is authoritative; this one predates the longer shuttle lane, so refresh it
      const mv = newMotion(o.item, o.variant);
      if (mv) { out.push({ ...o, mv }); continue; }
    } else { out.push(o); continue; }
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    x = Math.min(...cells.map(c => c[0])); y = Math.min(...cells.map(c => c[1]));
    for (const [cx, cy] of cells) taken.add(`${cx},${cy}`);
    out.push({ ...o, item, cells, x, y, attach: null, mv: undefined });
    converted.push(o.id);
  }
  return { snapshot: { ...s, content: CONTENT_VERSION, objects: out }, converted, removed };
}

/** Wire geometry: anchor cell sits outside the support face; normal = rotated up; extends along rotated right. */
export function wireDirs(rot: Rot | number) {
  const n = DIRS[rotDirIndex(0, rot)];
  const t = DIRS[rotDirIndex(1, rot)];
  return { n, t };
}

/**
 * Trim barbed wire to the contiguous exposed edge of the one support object under its first segment.
 * Returns surviving cells and the support id. `ignoreOcc` is used for map wires during construction.
 */
export function wireCells(world: World, ax: number, ay: number, rot: Rot | number, len: number, ignoreOcc = false): { cells: Cell[]; support: string | null } {
  const { n, t } = wireDirs(rot);
  const cells: Cell[] = [];
  let support: string | null = null;
  for (let i = 0; i < len; i++) {
    const cx = ax + t.x * i, cy = ay + t.y * i;
    const sx = cx - n.x, sy = cy - n.y;
    if (!world.inBounds(cx, cy)) break;
    const owner = world.supportOwner(sx, sy);
    if (!owner) break;
    if (support === null) support = owner; else if (owner !== support) break;
    // the wire cell itself must be open space (exposed edge), not solid terrain
    const ti = world.terrainAt(cx, cy);
    if (ti === 1 || ti === 2) break;
    if (!ignoreOcc) {
      const o = world.occAt(cx, cy);
      if (o === TERRAIN_ID) break;
    }
    cells.push([cx, cy]);
  }
  return { cells, support: cells.length ? support : null };
}

/** Absolute footprint cells for an item at an anchor. Wire uses trimming; everything else uses its rotated mask. */
export function footprint(world: World, def: ItemDef, x: number, y: number, rot: Rot): { cells: Cell[]; support: string | null } {
  if (def.kind === 'wire') return wireCells(world, x, y, rot, def.wireLength ?? 1);
  const mask = def.rotatable ? rotateMask(def.mask, rot) : def.mask.map(c => [c[0], c[1]] as Cell);
  return { cells: mask.map(([mx, my]) => [x + mx, y + my] as Cell), support: null };
}

/** Pixel hazard strip for a wire cell (thin strip touching the support face). */
export function wireStripPx(cx: number, cy: number, rot: Rot | number): Rect {
  const th = HAZARD.wireThickness;
  const x0 = cx * CELL, y0 = cy * CELL;
  switch (rotDirIndex(0, rot)) {
    case 0: return { x: x0, y: y0 + CELL - th, w: CELL, h: th }; // on top of block below
    case 1: return { x: x0, y: y0, w: th, h: CELL }; // on right face of block to the left
    case 2: return { x: x0, y: y0, w: CELL, h: th }; // under block above
    default: return { x: x0 + CELL - th, y: y0, w: th, h: CELL }; // on left face of block to the right
  }
}

/** Spike strip inside a cell, based on the side opposite the pointing direction. */
export function spikeStripPx(cx: number, cy: number, rot: Rot | number): Rect {
  const th = HAZARD.spikeHeight;
  const x0 = cx * CELL, y0 = cy * CELL;
  switch (rotDirIndex(0, rot)) {
    case 0: return { x: x0 + 2, y: y0 + CELL - th, w: CELL - 4, h: th };
    case 1: return { x: x0, y: y0 + 2, w: th, h: CELL - 4 };
    case 2: return { x: x0 + 2, y: y0, w: CELL - 4, h: th };
    default: return { x: x0 + CELL - th, y: y0 + 2, w: th, h: CELL - 4 };
  }
}

/** Spring pad trigger rect. */
export function springPadPx(cx: number, cy: number, rot: Rot | number): Rect {
  const th = 16;
  const x0 = cx * CELL, y0 = cy * CELL;
  switch (rotDirIndex(0, rot)) {
    case 0: return { x: x0 + 4, y: y0 + CELL - th, w: CELL - 8, h: th };
    case 1: return { x: x0, y: y0 + 4, w: th, h: CELL - 8 };
    case 2: return { x: x0 + 4, y: y0, w: CELL - 8, h: th };
    default: return { x: x0 + CELL - th, y: y0 + 4, w: th, h: CELL - 8 };
  }
}
