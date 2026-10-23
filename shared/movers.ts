// Kinematic platforms: the Shuttle Block (one 2x1 body sliding back and forth) and the Ferris Wheel (four 2x1 gondolas
// orbiting a non-solid pivot). Every pose is a pure function of the object's stored motion and the race tick, so the
// server sim, client prediction, rendering, placement validation and bots all evaluate exactly the same positions.
import { CELL, MOVERS, PHYS } from './config';
import { DIRS, rotDirIndex, type Cell, type Rect } from './grid';
import { getItem, KINEMATIC_KINDS } from './items';
import type { PlacedObject } from './world';

const C = CELL;

/** Authoritative motion definition, stored on the placed object when it is placed (shared with clients). */
export interface Motion {
  k: 'shuttle' | 'wheel';
  /** whole ticks per full cycle */
  period: number;
  /** shuttle: cells travelled from the anchor before turning back */
  travel?: number;
  /** wheel: pixels from the pivot centre to each gondola centre */
  radius?: number;
  /** wheel: +1 clockwise on screen (y points down), -1 counter-clockwise */
  dir?: 1 | -1;
}

export function isKinematic(o: { item: string }): boolean { return KINEMATIC_KINDS.has(getItem(o.item).kind); }

/** Motion for a new placement, from the current tuning. */
export function newMotion(item: string, variant: number): Motion | undefined {
  const k = getItem(item).kind;
  if (k === 'shuttle') return { k, period: MOVERS.shuttlePeriodTicks, travel: MOVERS.shuttleTravelCells };
  if (k === 'wheel') return { k, period: MOVERS.wheelPeriodTicks, radius: MOVERS.wheelRadiusCells * C, dir: variant === 1 ? -1 : 1 };
  return undefined;
}

export function motionOf(o: PlacedObject): Motion {
  return o.mv ?? newMotion(o.item, o.variant)!;
}

export function childCount(o: PlacedObject): number { return motionOf(o).k === 'wheel' ? 4 : 1; }

/** Stable child id: `<object id>#<child index>`. */
export const childId = (o: PlacedObject, i: number) => `${o.id}#${i}`;

const q = (v: number) => Math.round(v * 1000) / 1000; // keep poses identical across engines' last-bit float differences

function footRect(o: PlacedObject): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of o.cells) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0 * C, y: y0 * C, w: (x1 - x0 + 1) * C, h: (y1 - y0 + 1) * C };
}

/** Shuttle travel direction (rotated right): right, down, left, up for rotations 0..3. */
export function shuttleDir(o: PlacedObject) { return DIRS[rotDirIndex(1, o.rot)]; }

/** Wheel pivot centre in pixels. */
export function pivotPx(o: PlacedObject) { return { x: o.x * C + C / 2, y: o.y * C + C / 2 }; }

/** Gondola angle (radians, screen convention) of child i at tick t. Phase 0 at GO is the build rotation's quarter turn. */
export function wheelAngle(o: PlacedObject, i: number, t: number): number {
  const m = motionOf(o);
  return (o.rot * Math.PI) / 2 + (m.dir ?? 1) * ((2 * Math.PI * t) / m.period) + (i * Math.PI) / 2;
}

/** Solid rectangle of one child at tick t (t may be fractional for rendering). */
export function childRect(o: PlacedObject, i: number, t: number): Rect {
  const m = motionOf(o);
  if (m.k === 'shuttle') {
    const r = footRect(o);
    const d = shuttleDir(o);
    const off = ((m.travel ?? 0) * C * (1 - Math.cos((2 * Math.PI * t) / m.period))) / 2;
    return { x: q(r.x + d.x * off), y: q(r.y + d.y * off), w: r.w, h: r.h };
  }
  const p = pivotPx(o);
  const a = wheelAngle(o, i, t);
  const upright = o.rot % 2 === 1;
  const w = upright ? C : 2 * C, h = upright ? 2 * C : C;
  const R = m.radius ?? MOVERS.wheelRadiusCells * C;
  return { x: q(p.x + Math.cos(a) * R - w / 2), y: q(p.y + Math.sin(a) * R - h / 2), w, h };
}

/** Pose at GO: what bombs target and what the build view freezes on while a bomb is selected. */
export function referenceRects(o: PlacedObject): Rect[] {
  return Array.from({ length: childCount(o) }, (_, i) => childRect(o, i, 0));
}

/** Samples of one full cycle (all children). Shuttle samples are dense enough to never skip a pixel. */
function poses(o: PlacedObject): Rect[] {
  const m = motionOf(o);
  const out: Rect[] = [];
  const n = m.k === 'shuttle' ? m.period : 1440;
  for (let s = 0; s < n; s++) {
    const t = (s / n) * m.period;
    for (let i = 0; i < childCount(o); i++) out.push(childRect(o, i, t));
  }
  return out;
}

function cellsOf(rects: Rect[], grow: number): Set<string> {
  const out = new Set<string>();
  for (const r of rects) {
    const x0 = Math.floor((r.x - grow) / C), x1 = Math.floor((r.x + r.w + grow - 0.01) / C);
    const y0 = Math.floor((r.y - grow) / C), y1 = Math.floor((r.y + r.h + grow - 0.01) / C);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.add(`${x},${y}`);
  }
  return out;
}

const sweepCache = new Map<string, { sweep: Cell[]; bbox: Rect }>();
function geomKey(o: PlacedObject) { const m = motionOf(o); return `${o.item}:${o.x},${o.y}:${o.rot}:${o.cells.map(c => c.join(',')).join(';')}:${m.period}:${m.travel}:${m.radius}:${m.dir}`; }

/**
 * Cells any child body ever overlaps over a full cycle. Used for the build preview, bomb highlight regions and the
 * bots' timed-edge planning. It reserves nothing: blocks may be built in a path, and a platform passes through them.
 */
export function sweepOf(o: PlacedObject): { sweep: Cell[]; bbox: Rect } {
  const key = geomKey(o);
  const hit = sweepCache.get(key);
  if (hit) return hit;
  const ps = poses(o);
  // between samples a wheel gondola moves at most 2πR/1440 ≈ 0.63 px; grow by that so the lane is conservative
  const sweepSet = cellsOf(ps, motionOf(o).k === 'wheel' ? 0.7 : 0);
  const sweep = [...sweepSet].map(k => k.split(',').map(Number) as Cell).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of sweep) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const res = { sweep, bbox: { x: x0 * C, y: y0 * C, w: (x1 - x0 + 1) * C, h: (y1 - y0 + 1) * C } };
  if (sweepCache.size > 4000) sweepCache.clear();
  sweepCache.set(key, res);
  return res;
}

/** Cells a pixel rect touches (any overlap counts). */
export function cellsTouched(r: Rect): Cell[] {
  const out: Cell[] = [];
  const x0 = Math.floor(r.x / C), x1 = Math.floor((r.x + r.w - 0.01) / C), y0 = Math.floor(r.y / C), y1 = Math.floor((r.y + r.h - 0.01) / C);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

/** Does a pixel rect overlap any reference-pose body of the object (bomb targeting)? */
export function referenceHit(o: PlacedObject, r: Rect): boolean {
  return referenceRects(o).some(b => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y);
}

/** The pivot is only an anchor and a bomb handle: never solid, never a projectile target. */
export const PIVOT_SOLID = false;

/** Body height reference for headroom checks (identical for every character). */
export const RIDER_H = PHYS.bodyH;
