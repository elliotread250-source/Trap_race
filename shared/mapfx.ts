// Map mechanics: water and lava, the Tropical Island tsunami, geysers, low-gravity zones, sandstorm gusts and the
// floating beach ball. Every one is a pure function of the map and the race tick (like the moving platforms), so the
// server, client prediction, rendering and bots all agree without any extra network traffic.
import { CELL, TICK_HZ } from './config';
import type { Rect } from './grid';
import type { MapDef } from './maps';

const C = CELL;

export interface MapFx {
  /** a sea (or lava lake) whose surface sits at `level` px; touching it is death */
  liquid?: { kind: 'water' | 'lava'; level: number };
  /** a periodic tsunami: the water rises to `high` px. Times in seconds from GO. */
  tsunami?: { start: number; on: number; off: number; rise: number; high: number; warn: number };
  /** columns of eruption: lethal from the liquid up to `top` (cell row) while active */
  geysers?: { x: number; top: number; period: number; on: number; phase: number; warn: number }[];
  /** cell rects where gravity is scaled by `mul` */
  lowGrav?: { x: number; y: number; w: number; h: number; mul: number }[];
  /** a sandstorm: every `period` s (from `start`) a gust blows with `accel` px/s^2 for `on` s, with a `warn` s warning */
  gusts?: { start: number; period: number; on: number; accel: number; warn: number };
  /** a floating 2x2 beach ball resting on the liquid at cell column x (rides the tsunami up) */
  ball?: { x: number; w: number; h: number; sink: number };
}

const smooth = (k: number) => k * k * (3 - 2 * k);

/** Height of the tsunami (0 calm .. 1 fully up) at a tick. */
export function tsunamiLevel(fx: MapFx, tick: number): number {
  const ts = fx.tsunami;
  if (!ts) return 0;
  const t = tick / TICK_HZ - ts.start;
  if (t < 0) return 0;
  const cyc = t % (ts.on + ts.off);
  if (cyc >= ts.on) return 0;
  if (cyc < ts.rise) return smooth(cyc / ts.rise);
  if (cyc > ts.on - ts.rise) return smooth((ts.on - cyc) / ts.rise);
  return 1;
}

/** Seconds until the next tsunami starts rising, or null when it is already up (or there is none). */
export function tsunamiIn(fx: MapFx, tick: number): number | null {
  const ts = fx.tsunami;
  if (!ts) return null;
  const t = tick / TICK_HZ;
  if (t < ts.start) return ts.start - t;
  const cyc = (t - ts.start) % (ts.on + ts.off);
  return cyc < ts.on ? null : ts.on + ts.off - cyc;
}

/** The liquid surface (px from the top of the map) at a tick, or null when the map has none. */
export function liquidSurface(map: MapDef, tick: number): number | null {
  const fx = map.fx;
  if (!fx?.liquid) return null;
  const base = fx.liquid.level;
  if (!fx.tsunami) return base;
  return base + (fx.tsunami.high - base) * tsunamiLevel(fx, tick);
}

/** Is the tsunami (not the calm sea) what reaches this height right now? */
export function tsunamiUp(map: MapDef, tick: number): boolean { return !!map.fx?.tsunami && tsunamiLevel(map.fx, tick) > 0.02; }

/** Rects of geyser columns erupting at a tick. */
export function geyserRects(map: MapDef, tick: number): Rect[] {
  const fx = map.fx;
  if (!fx?.geysers || !fx.liquid) return [];
  const t = tick / TICK_HZ;
  const out: Rect[] = [];
  for (const g of fx.geysers) {
    const cyc = (((t + g.phase) % g.period) + g.period) % g.period;
    if (cyc < g.period - g.on) continue;
    out.push({ x: g.x * C + 6, y: g.top * C, w: C - 12, h: fx.liquid.level - g.top * C });
  }
  return out;
}

/** Geysers about to erupt (within their warning time) at a tick: columns that bubble before they blow. */
export function geyserWarnings(map: MapDef, tick: number): number[] {
  const fx = map.fx;
  if (!fx?.geysers) return [];
  const t = tick / TICK_HZ;
  return fx.geysers.filter(g => { const cyc = (((t + g.phase) % g.period) + g.period) % g.period; return cyc >= g.period - g.on - g.warn && cyc < g.period - g.on; }).map(g => g.x);
}

/** Gravity multiplier at a point (low-gravity modules). */
export function gravityAt(map: MapDef, x: number, y: number): number {
  const z = map.fx?.lowGrav;
  if (!z) return 1;
  const cx = x / C, cy = y / C;
  for (const r of z) if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) return r.mul;
  return 1;
}

/** Sandstorm gust acceleration (px/s^2, horizontal) at a tick: 0 when calm. */
export function gustAt(map: MapDef, tick: number): number {
  const g = map.fx?.gusts;
  if (!g) return 0;
  const t = tick / TICK_HZ - g.start;
  if (t < 0) return 0;
  const cyc = t % g.period;
  if (cyc >= g.on) return 0;
  // ease in and out over half a second so it shoves rather than snaps
  const k = Math.min(1, cyc / 0.5, (g.on - cyc) / 0.5);
  return g.accel * k;
}

/** Seconds until the next gust, or null while one is blowing. */
export function gustIn(map: MapDef, tick: number): number | null {
  const g = map.fx?.gusts;
  if (!g) return null;
  const t = tick / TICK_HZ - g.start;
  if (t < 0) return -t;
  const cyc = t % g.period;
  return cyc < g.on ? null : g.period - cyc;
}

/** The beach ball's rect at a tick: floating on the liquid, rising and falling with the tsunami, kept under the ceiling. */
export function ballRect(map: MapDef, tick: number): Rect | null {
  const b = map.fx?.ball;
  if (!b) return null;
  const s = liquidSurface(map, tick) ?? map.h * C;
  const h = b.h * C, w = b.w * C;
  return { x: b.x * C, y: Math.max(C, s - h + b.sink), w, h };
}

/** Is a body (rect) in the liquid? Feet have to dip a few pixels below the surface. */
export function inLiquid(map: MapDef, tick: number, r: Rect): boolean {
  const s = liquidSurface(map, tick);
  return s !== null && r.y + r.h > s + 6;
}
