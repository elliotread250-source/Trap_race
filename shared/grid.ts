// Grid math shared by placement, physics and rendering. Rotation is in clockwise quarter turns (y points down).

export type Rot = 0 | 1 | 2 | 3;
export type Cell = [number, number];
export interface Vec { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const DIRS: Vec[] = [
  { x: 0, y: -1 }, // up
  { x: 1, y: 0 }, // right
  { x: 0, y: 1 }, // down
  { x: -1, y: 0 }, // left
];

/** Rotate a direction vector clockwise by rot quarter turns. */
export function rotVec(v: Vec, rot: Rot | number): Vec {
  let x = v.x, y = v.y;
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) { const nx = -y; y = x; x = nx; }
  return { x: x + 0, y: y + 0 };
}

/** Index into DIRS for a base dir index rotated by rot. */
export function rotDirIndex(base: number, rot: number): number { return (((base + rot) % 4) + 4) % 4; }

export function maskBounds(mask: readonly Cell[]): { w: number; h: number } {
  let w = 0, h = 0;
  for (const [x, y] of mask) { w = Math.max(w, x + 1); h = Math.max(h, y + 1); }
  return { w, h };
}

/** Rotate a cell mask clockwise within its bounding box and renormalise to start at 0,0. */
export function rotateMask(mask: readonly Cell[], rot: Rot | number): Cell[] {
  let cur: Cell[] = mask.map(([x, y]) => [x, y]);
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) {
    const { h } = maskBounds(cur);
    cur = cur.map(([x, y]) => [h - 1 - y, x]);
  }
  return cur.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function circleRect(cx: number, cy: number, r: number, b: Rect): boolean {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** Segment p0->p1 versus rect; returns entry time in [0,1] or -1. */
export function segRect(x0: number, y0: number, x1: number, y1: number, r: Rect): number {
  const dx = x1 - x0, dy = y1 - y0;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) { if (x0 < r.x || x0 > r.x + r.w) return -1; }
  else {
    let t1 = (r.x - x0) / dx, t2 = (r.x + r.w - x0) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-9) { if (y0 < r.y || y0 > r.y + r.h) return -1; }
  else {
    let t1 = (r.y - y0) / dy, t2 = (r.y + r.h - y0) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

export const cellKey = (x: number, y: number) => `${x},${y}`;
