// Black-hole gravity field. One definition shared by player physics, projectiles, bot probes and the bent sniper shot.
import { HAZARD } from './config';

export interface HoleInfo { x: number; y: number; owner: string | null; src: string }

export interface FieldPull { ax: number; ay: number; strongest: number; src: HoleInfo | null }

/**
 * Acceleration of one hole at distance d (px) from its centre, as a magnitude along the unit vector to the hole:
 *   pull * (1 - d / radius)^falloff, fading smoothly to zero at the field edge, times d / sqrt(d^2 + soft^2).
 * The softened factor means the pull stops growing close to the centre (no singularity, no sudden snap) while the
 * direction stays continuous. Returns the vector factor: multiply by (dx, dy) of the offset to the hole.
 */
export function holePullAt(d: number): { mag: number; k: number } {
  if (d >= HAZARD.holeRadius) return { mag: 0, k: 0 };
  const fade = Math.pow(1 - d / HAZARD.holeRadius, HAZARD.holeFalloff);
  const mag = Math.min(HAZARD.holeMaxPull, HAZARD.holePull * fade);
  const k = mag / Math.sqrt(d * d + HAZARD.holeSoft * HAZARD.holeSoft);
  return { mag, k };
}

/**
 * Summed pull at a point from every hole whose field reaches it and whose line of sight is not blocked by a solid.
 * `mul` scales the response (projectiles use holeProjectileMul). The result is capped by holeMaxTotal.
 */
export function fieldAccel(
  holes: readonly HoleInfo[], x: number, y: number, blocked: (hx: number, hy: number, x: number, y: number) => boolean, mul = 1,
): FieldPull | null {
  let ax = 0, ay = 0, strongest = 0, src: HoleInfo | null = null;
  for (const h of holes) {
    const dx = h.x - x, dy = h.y - y;
    const d = Math.hypot(dx, dy);
    if (d >= HAZARD.holeRadius) continue;
    if (d > 1 && blocked(h.x, h.y, x, y)) continue;
    const { mag, k } = holePullAt(d);
    ax += dx * k * mul; ay += dy * k * mul;
    if (mag > strongest) { strongest = mag; src = h; }
  }
  const total = Math.hypot(ax, ay);
  if (total === 0) return null;
  const cap = HAZARD.holeMaxTotal * mul;
  if (total > cap) { ax *= cap / total; ay *= cap / total; }
  return { ax, ay, strongest, src };
}

/** True when a point is inside any hole's field radius (cheap pre-test; the straight-ray fast path uses it). */
export function inAnyField(holes: readonly HoleInfo[], x: number, y: number): boolean {
  for (const h of holes) if (Math.hypot(h.x - x, h.y - y) < HAZARD.holeRadius) return true;
  return false;
}

/** Does the straight segment come within a field radius of any hole? */
export function segmentTouchesField(holes: readonly HoleInfo[], x0: number, y0: number, x1: number, y1: number, pad = 0): boolean {
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  for (const h of holes) {
    let t = len2 > 0 ? ((h.x - x0) * dx + (h.y - y0) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(x0 + dx * t - h.x, y0 + dy * t - h.y) < HAZARD.holeRadius + pad) return true;
  }
  return false;
}

export interface ShotSeg { stop: boolean; ex: number; ey: number }

/** Closest approach (t in [0,1]) of a point to a segment, and its distance. */
export function closestOnSegment(x0: number, y0: number, x1: number, y1: number, px: number, py: number): { t: number; d: number } {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  return { t, d: Math.hypot(x0 + dx * t - px, y0 + dy * t - py) };
}

/**
 * The path of an instantaneous shot. Outside every field it is one straight segment of at most sniperMaxPathPx. Where its
 * straight line meets a field it is marched in short steps whose direction bends as a sniperBendSpeed round would
 * (dir += a * step / v^2), stopping at a hole's core, when `segment` says it hit something, at the map edge, or at the
 * length limit. `segment` is asked about each piece in order and decides blocks and players, so the real shot and the
 * build-preview line share exactly this geometry. Returns the points as x0,y0,x1,y1,...
 */
export function traceShot(
  holes: readonly HoleInfo[], x0: number, y0: number, dx0: number, dy0: number,
  blocked: (hx: number, hy: number, x: number, y: number) => boolean,
  segment: (ax: number, ay: number, bx: number, by: number) => ShotSeg,
  bounds: { w: number; h: number },
): number[] {
  const maxPath = HAZARD.sniperMaxPathPx;
  const pts: number[] = [x0, y0];
  let x = x0, y = y0, dx = dx0, dy = dy0;
  const clipEnd = (ax: number, ay: number, bx: number, by: number): [number, number] => {
    // trim a straight run at the map rectangle so the drawn tracer does not extend into the void
    let t = 1;
    if (bx < 0) t = Math.min(t, (0 - ax) / (bx - ax)); if (bx > bounds.w) t = Math.min(t, (bounds.w - ax) / (bx - ax));
    if (by < 0) t = Math.min(t, (0 - ay) / (by - ay)); if (by > bounds.h) t = Math.min(t, (bounds.h - ay) / (by - ay));
    return [ax + (bx - ax) * Math.max(0, t), ay + (by - ay) * Math.max(0, t)];
  };
  if (!holes.length || !segmentTouchesField(holes, x, y, x + dx * maxPath, y + dy * maxPath)) {
    const r = segment(x, y, x + dx * maxPath, y + dy * maxPath);
    const [ex, ey] = r.stop ? [r.ex, r.ey] : clipEnd(x, y, x + dx * maxPath, y + dy * maxPath);
    pts.push(ex, ey);
    return pts;
  }
  const step = HAZARD.sniperStepPx, v2 = HAZARD.sniperBendSpeed * HAZARD.sniperBendSpeed;
  let travelled = 0, n = 0;
  while (travelled < maxPath) {
    const f = fieldAccel(holes, x, y, blocked);
    if (f) {
      dx += (f.ax * step) / v2; dy += (f.ay * step) / v2;
      const l = Math.hypot(dx, dy); dx /= l; dy /= l;
    }
    let bx = x + dx * step, by = y + dy * step;
    // a core swallows the shot at its closest approach; anything before that point still counts
    let absorbed = false;
    for (const h of holes) {
      const c = closestOnSegment(x, y, bx, by, h.x, h.y);
      if (c.d <= HAZARD.holeCore) { bx = x + (bx - x) * c.t; by = y + (by - y) * c.t; absorbed = true; break; }
    }
    const r = segment(x, y, bx, by);
    x = r.stop ? r.ex : bx; y = r.stop ? r.ey : by; travelled += step;
    if (r.stop || absorbed) { pts.push(x, y); return pts; }
    if (++n % 4 === 0) pts.push(x, y);
    if (x < 0 || y < 0 || x > bounds.w || y > bounds.h) { pts.push(...clipEnd(pts[pts.length - 2], pts[pts.length - 1], x, y)); return pts; }
  }
  pts.push(x, y);
  return pts;
}
