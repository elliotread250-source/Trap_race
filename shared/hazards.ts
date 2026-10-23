// Hazard geometry as pure functions of the object and its phase, shared by the server sim, renderer and bots.
import { CELL, HAZARD, PHYS } from './config';
import { DIRS, rotDirIndex, rotVec, type Rect, type Vec } from './grid';
import { getItem } from './items';
import { spikeStripPx, springPadPx, wireStripPx, type PlacedObject, type World } from './world';

export const C = CELL;

export function cellCenter(x: number, y: number): Vec { return { x: x * C + C / 2, y: y * C + C / 2 }; }

export function pingpong(t: number, len: number): number {
  if (len <= 0) return 0;
  const m = t % (2 * len);
  return m < len ? m : 2 * len - m;
}

// ---- retracting spikes: retracted first, warning at the end of the retracted span, then out
export function rspikeState(phase: number): 'in' | 'warn' | 'out' {
  const period = HAZARD.rspikeIn + HAZARD.rspikeOut;
  const p = phase % period;
  if (p < HAZARD.rspikeIn - HAZARD.rspikeWarn) return 'in';
  if (p < HAZARD.rspikeIn) return 'warn';
  return 'out';
}

// ---- laser: off (with warning at the end) then on
export function laserState(phase: number): 'off' | 'warn' | 'on' {
  const period = HAZARD.laserOff + HAZARD.laserOn;
  const p = phase % period;
  if (p < HAZARD.laserOff - HAZARD.laserWarn) return 'off';
  if (p < HAZARD.laserOff) return 'warn';
  return 'on';
}
export function laserInOff(phase: number): boolean { return phase % (HAZARD.laserOff + HAZARD.laserOn) < HAZARD.laserOff; }

/** Beam cells: from the emitter outward until a solid, a protected cell, or the max length. */
export function laserCells(world: World, o: PlacedObject): number {
  const d = DIRS[rotDirIndex(1, o.rot)];
  let n = 0;
  for (let i = 1; i <= HAZARD.laserMaxCells; i++) {
    const cx = o.x + d.x * i, cy = o.y + d.y * i;
    if (!world.inBounds(cx, cy) || world.solidCell(cx, cy) || world.isProtectedCell(cx, cy)) break;
    n = i;
  }
  return n;
}
export function laserBeamRect(o: PlacedObject, cells: number): Rect | null {
  if (cells <= 0) return null;
  const d = DIRS[rotDirIndex(1, o.rot)];
  const th = 10;
  const cx = o.x * C + C / 2, cy = o.y * C + C / 2;
  const len = cells * C;
  if (d.x > 0) return { x: (o.x + 1) * C, y: cy - th / 2, w: len, h: th };
  if (d.x < 0) return { x: o.x * C - len, y: cy - th / 2, w: len, h: th };
  if (d.y > 0) return { x: cx - th / 2, y: (o.y + 1) * C, w: th, h: len };
  return { x: cx - th / 2, y: o.y * C - len, w: th, h: len };
}

// ---- saw rail: 4 cells along rotated right
export function sawPos(o: PlacedObject, phase: number): Vec {
  const t = DIRS[rotDirIndex(1, o.rot)];
  const def = getItem(o.item);
  const len = (def.mask.length - 1) * C;
  const startCell = o.cells[0];
  // the rail runs between the first and last footprint cell centres
  const cells = [...o.cells].sort((a, b) => (a[0] - b[0]) * t.x + (a[1] - b[1]) * t.y);
  const s = cellCenter(cells[0][0], cells[0][1]);
  void startCell;
  const d = pingpong((phase / HAZARD.sawPeriod) * 2 * len, len);
  return { x: s.x + t.x * d, y: s.y + t.y * d };
}

// ---- swinging axe: hangs along rotated down from the pivot
export function pendulumPos(o: PlacedObject, phase: number): { pivot: Vec; ball: Vec; angle: number } {
  const pivot = cellCenter(o.x, o.y);
  const base = DIRS[rotDirIndex(2, o.rot)];
  const amp = (HAZARD.pendulumSwingDeg * Math.PI) / 180;
  const ang = amp * Math.sin((phase / HAZARD.pendulumPeriod) * Math.PI * 2);
  const c = Math.cos(ang), s = Math.sin(ang);
  const vx = base.x * c - base.y * s, vy = base.x * s + base.y * c;
  return { pivot, ball: { x: pivot.x + vx * HAZARD.pendulumArm, y: pivot.y + vy * HAZARD.pendulumArm }, angle: ang };
}
/** Sample points of the whole swing, used to keep the blade out of protected zones. */
export function pendulumSweep(o: PlacedObject): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i <= 24; i++) pts.push(pendulumPos(o, (i / 24) * HAZARD.pendulumPeriod).ball);
  return pts;
}

// ---- moving platform: 3x1 (rotated) glides along rotated right, path clipped against solids and protected zones
export function moverBaseRect(o: PlacedObject): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of o.cells) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return { x: minX * C, y: minY * C, w: (maxX - minX + 1) * C, h: (maxY - minY + 1) * C };
}
export function moverPathLen(world: World, o: PlacedObject): number {
  const r = moverBaseRect(o);
  const t = DIRS[rotDirIndex(1, o.rot)];
  const max = HAZARD.movingPathCells * C;
  for (let d = 4; d <= max; d += 4) {
    const x = r.x + t.x * d, y = r.y + t.y * d;
    const x0 = Math.floor(x / C), x1 = Math.floor((x + r.w - 0.01) / C), y0 = Math.floor(y / C), y1 = Math.floor((y + r.h - 0.01) / C);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      if (world.solidCell(cx, cy) || !world.inBounds(cx, cy) || world.isProtectedCell(cx, cy) || world.reservedAt(cx, cy)) return d - 4;
    }
  }
  return max;
}
export function moverRect(o: PlacedObject, phase: number, pathLen: number): Rect {
  const r = moverBaseRect(o);
  const t = DIRS[rotDirIndex(1, o.rot)];
  const d = pingpong(phase * HAZARD.movingSpeed, pathLen);
  return { x: r.x + t.x * d, y: r.y + t.y * d, w: r.w, h: r.h };
}

// ---- launchers
export function launcherDir(o: PlacedObject): Vec {
  const def = getItem(o.item);
  if (def.kind === 'sniper') return { x: o.variant === 1 ? -1 : 1, y: 0 };
  if (def.kind === 'cannon') {
    const v = rotVec({ x: Math.cos(Math.PI / 6), y: -Math.sin(Math.PI / 6) }, o.rot);
    return v;
  }
  return DIRS[rotDirIndex(1, o.rot)];
}
export function muzzle(o: PlacedObject): Vec {
  const c = cellCenter(o.x, o.y);
  const d = launcherDir(o);
  const def = getItem(o.item);
  const yOff = def.kind === 'sniper' ? -6 : 0;
  // start just outside the launcher's own cell
  const k = (C / 2 + 2) / Math.max(Math.abs(d.x), Math.abs(d.y));
  return { x: c.x + d.x * k, y: c.y + yOff + d.y * k };
}

export function springDir(o: PlacedObject): Vec { return DIRS[rotDirIndex(0, o.rot)]; }

export interface StaticLethal { rects: { r: Rect; owner: string | null; src: string }[]; circles: { x: number; y: number; r: number; owner: string | null; src: string }[] }

/** Always-on lethal shapes: spikes, barbed wire and black hole cores. */
export function staticLethal(world: World): StaticLethal {
  const rects: StaticLethal['rects'] = [];
  const circles: StaticLethal['circles'] = [];
  for (const o of world.objects.values()) {
    const k = getItem(o.item).kind;
    if (k === 'spikes') for (const [x, y] of o.cells) rects.push({ r: spikeStripPx(x, y, o.rot), owner: o.owner, src: o.id });
    if (k === 'wire') for (const [x, y] of o.cells) rects.push({ r: wireStripPx(x, y, o.rot), owner: o.owner, src: o.id });
    if (k === 'blackhole') { const c = cellCenter(o.x, o.y); circles.push({ x: c.x, y: c.y, r: HAZARD.holeCore, owner: o.owner, src: o.id }); }
  }
  return { rects, circles };
}

export function springRect(o: PlacedObject): Rect { return springPadPx(o.x, o.y, o.rot); }

/** Player body dimensions are identical for every character and skin. */
export const BODY = { w: PHYS.bodyW, h: PHYS.bodyH };
