// Fan wind and the batch-update item geometry (paper plane maker, gravestone, dart turret, ice). Pure functions of the
// world, shared by the race sim, client prediction, rendering and the bots' route probe.
import { CELL, NEWITEMS } from './config';
import { DIRS, rotDirIndex, rotVec, type Cell, type Rect, type Vec } from './grid';
import { getItem } from './items';
import type { PlacedObject, World } from './world';

const C = CELL;

/** One fan's wind: its blowing direction, the casing face it blows from, and one lane rect per casing cell (cut short by solids). */
export interface FanField { o: PlacedObject; dir: Vec; lanes: { r: Rect; face: number }[] }

/** Wind direction of a fan: up at rotation 0, turning with the item. */
export function fanDir(o: PlacedObject): Vec { return DIRS[rotDirIndex(0, o.rot)]; }

/** Lanes of wind out of each casing cell, up to fanRange cells, stopped by static solids (walls and blocks). */
export function fanField(world: World, o: PlacedObject, solid: (x: number, y: number) => boolean = (x, y) => world.solidCell(x, y)): FanField {
  const d = fanDir(o);
  const lanes: { r: Rect; face: number }[] = [];
  for (const [cx, cy] of o.cells) {
    let n = 0;
    for (let i = 1; i <= NEWITEMS.fanRange; i++) {
      const x = cx + d.x * i, y = cy + d.y * i;
      if (!world.inBounds(x, y) || solid(x, y)) break;
      n = i;
    }
    if (n === 0) continue;
    const x0 = Math.min(cx + d.x, cx + d.x * n), y0 = Math.min(cy + d.y, cy + d.y * n);
    const r = { x: x0 * C, y: y0 * C, w: (Math.abs(d.x) * (n - 1) + 1) * C, h: (Math.abs(d.y) * (n - 1) + 1) * C };
    // pixel coordinate of the casing face along the wind axis
    const face = d.x > 0 ? (cx + 1) * C : d.x < 0 ? cx * C : d.y > 0 ? (cy + 1) * C : cy * C;
    lanes.push({ r, face });
  }
  return { o, dir: d, lanes };
}

export function fanFields(world: World): FanField[] {
  const out: FanField[] = [];
  for (const o of world.objects.values()) if (getItem(o.item).kind === 'fan') out.push(fanField(world, o));
  return out;
}

/** Distance (px) of a point from a fan's face along its wind, if the point is in one of its lanes. */
export function fanDist(f: FanField, x: number, y: number): number | null {
  for (const l of f.lanes) {
    if (x < l.r.x || x >= l.r.x + l.r.w || y < l.r.y || y >= l.r.y + l.r.h) continue;
    return f.dir.x !== 0 ? (x - l.face) * f.dir.x : (y - l.face) * f.dir.y;
  }
  return null;
}

/**
 * Wind acceleration on a body centred at (x, y) moving at (vx, vy). Stronger closer to the fan (linear falloff to zero at
 * the end of the range) plus damping along the wind, so a player in an upward column settles into steady levitation.
 */
export function fanAccel(fields: readonly FanField[], x: number, y: number, vx: number, vy: number, mul = 1, damp = true): { ax: number; ay: number } | null {
  let ax = 0, ay = 0, any = false;
  for (const f of fields) {
    const d = fanDist(f, x, y);
    if (d === null) continue;
    const k = Math.max(0, 1 - d / (NEWITEMS.fanRange * C));
    const push = (f.dir.y < 0 ? NEWITEMS.fanPushUp : NEWITEMS.fanPush) * k * mul;
    ax += f.dir.x * push; ay += f.dir.y * push;
    if (damp) {
      const along = vx * f.dir.x + vy * f.dir.y;
      ax -= f.dir.x * along * NEWITEMS.fanDamp; ay -= f.dir.y * along * NEWITEMS.fanDamp;
    }
    any = true;
  }
  return any ? { ax, ay } : null;
}

// ---------------------------------------------------------------- paper plane maker
/** Firing direction: right (or left with F) at rotation 0, turning with the machine. */
export function planeDir(o: PlacedObject): Vec { return rotVec({ x: o.variant === 1 ? -1 : 1, y: 0 }, o.rot); }

/** The emitter is the machine's "top" cell: the one furthest along its rotated up direction. */
export function planeEmitter(o: PlacedObject): Cell {
  const n = DIRS[rotDirIndex(0, o.rot)];
  return o.cells.reduce((a, c) => (c[0] * n.x + c[1] * n.y > a[0] * n.x + a[1] * n.y ? c : a));
}

/** Rect of a freshly launched plane: just outside the emitter cell, on the firing side, centred on it. */
export function planeSpawnRect(o: PlacedObject): Rect {
  const d = planeDir(o), [ex, ey] = planeEmitter(o);
  const horiz = d.x !== 0;
  const w = horiz ? NEWITEMS.planeLen : NEWITEMS.planeThick, h = horiz ? NEWITEMS.planeThick : NEWITEMS.planeLen;
  const cx = ex * C + C / 2, cy = ey * C + C / 2;
  if (d.x > 0) return { x: (ex + 1) * C, y: cy - h / 2, w, h };
  if (d.x < 0) return { x: ex * C - w, y: cy - h / 2, w, h };
  if (d.y > 0) return { x: cx - w / 2, y: (ey + 1) * C, w, h };
  return { x: cx - w / 2, y: ey * C - h, w, h };
}

// ---------------------------------------------------------------- gravestone
/** The dirt pile: a thin top-only platform along the bottom of the grave's cell. */
export function graveDirt(o: PlacedObject): Rect { return { x: o.x * C, y: (o.y + 1) * C - NEWITEMS.dirtH, w: C, h: NEWITEMS.dirtH }; }
/** The stone itself: touching it angers a ghost. */
export function graveStone(o: PlacedObject): Rect { return { x: o.x * C + 12, y: o.y * C + 6, w: C - 24, h: C - 6 - NEWITEMS.dirtH }; }
/** Idle ghosts circle the grave: deterministic orbit position of ghost i of n at time t (s). */
export function ghostOrbit(o: PlacedObject, i: number, n: number, t: number): Vec {
  const a = t * 1.3 + (i / Math.max(1, n)) * Math.PI * 2;
  return { x: o.x * C + C / 2 + Math.cos(a) * 30, y: o.y * C + C / 2 - 8 + Math.sin(a) * 16 };
}

// ---------------------------------------------------------------- ice
/** The cell an ice cell coats (directly below it). */
export const iceSupport = (c: Cell): Cell => [c[0], c[1] + 1];
