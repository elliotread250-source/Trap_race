// Scenery for the large maps (The Great Oak, Under the Mountain): layered parallax backgrounds, material-aware terrain
// painting, baked decoration and capped ambient life. Everything here is visual only: collision is the terrain grid,
// nothing drawn here is a platform, and ambient life is drawn behind objects and players so it never hides them.
import { CELL } from '../../shared/config';
import type { MapDef } from '../../shared/maps';
import type { World } from '../../shared/world';

const C = CELL;

/** Deterministic hash noise in [0, 1) for stable textures. */
export function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const hasScenery = (m: MapDef) => m.id === 'oak' || m.id === 'mountain';

export function materialAt(m: MapDef, x: number, y: number): string {
  if (!m.materials) return '';
  for (let i = m.materials.length - 1; i >= 0; i--) {
    const z = m.materials[i];
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.m;
  }
  return '';
}

// ------------------------------------------------------------------ backgrounds (screen space, gentle parallax)
export interface ViewInfo { camX: number; camY: number; zoom: number; vw: number; vh: number; t: number; reduced: boolean; budget: number }

export function drawSceneryBackground(ctx: CanvasRenderingContext2D, map: MapDef, v: ViewInfo) {
  const th = map.theme;
  const g = ctx.createLinearGradient(0, 0, 0, v.vh);
  g.addColorStop(0, th.skyTop); g.addColorStop(0.62, th.skyBottom); g.addColorStop(1, th.far2 ?? th.far);
  ctx.fillStyle = g; ctx.fillRect(0, 0, v.vw, v.vh);
  const mapH = map.h * C;
  const par = (f: number) => ({ ox: -(v.camX * f), oy: -(v.camY - mapH / 2) * f * 0.25 });
  if (map.id === 'oak') {
    // sun and its warm bloom
    const sx = v.vw * 0.8 + par(0.02).ox % 40, sy = v.vh * 0.14;
    const sun = ctx.createRadialGradient(sx, sy, 6, sx, sy, Math.max(v.vw, v.vh) * 0.45);
    sun.addColorStop(0, 'rgba(255,250,215,0.95)'); sun.addColorStop(0.08, 'rgba(255,240,170,0.55)'); sun.addColorStop(1, 'rgba(255,240,170,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, v.vw, v.vh);
    // three tree lines, far to near: blue-green and hazy to rich green
    treeLine(ctx, v, par(0.05), v.vh * 0.5, th.far2 ?? th.far, 46, 70, 11);
    hazeBand(ctx, v, v.vh * 0.42, v.vh * 0.25, th.haze);
    treeLine(ctx, v, par(0.12), v.vh * 0.62, th.far, 38, 58, 23);
    hazeBand(ctx, v, v.vh * 0.56, v.vh * 0.2, th.haze);
    treeLine(ctx, v, par(0.24), v.vh * 0.76, th.mid, 30, 48, 37, th.accent2);
    if (!v.reduced) {
      // slow light shafts through the canopy
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const x = ((i * 290 + par(0.3).ox) % (v.vw + 600) + v.vw + 600) % (v.vw + 600) - 300;
        const a = 0.05 + 0.03 * Math.sin(v.t * 0.4 + i);
        ctx.fillStyle = `rgba(255,244,190,${a})`;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 90, 0); ctx.lineTo(x + 260, v.vh); ctx.lineTo(x + 140, v.vh); ctx.fill();
      }
      ctx.restore();
    }
  } else {
    // sunset: low sun, layered violet peaks with snow and haze between them
    const sx = v.vw * 0.22, sy = v.vh * 0.34;
    const sun = ctx.createRadialGradient(sx, sy, 10, sx, sy, v.vw * 0.5);
    sun.addColorStop(0, 'rgba(255,236,190,0.95)'); sun.addColorStop(0.1, 'rgba(255,190,120,0.5)'); sun.addColorStop(1, 'rgba(255,170,120,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, v.vw, v.vh);
    peaks(ctx, v, par(0.04), v.vh * 0.55, th.far2 ?? th.far, 260, 0.9, 5, true);
    hazeBand(ctx, v, v.vh * 0.45, v.vh * 0.25, th.haze);
    peaks(ctx, v, par(0.1), v.vh * 0.68, th.far, 190, 0.8, 17, true);
    hazeBand(ctx, v, v.vh * 0.6, v.vh * 0.2, th.haze);
    peaks(ctx, v, par(0.22), v.vh * 0.82, th.mid, 120, 0.7, 29, false);
  }
}

function hazeBand(ctx: CanvasRenderingContext2D, v: ViewInfo, y: number, h: number, color = 'rgba(255,255,255,0.3)') {
  const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, color); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, y - h / 2, v.vw, h);
}

function treeLine(ctx: CanvasRenderingContext2D, v: ViewInfo, p: { ox: number; oy: number }, base: number, color: string, r0: number, r1: number, seed: number, highlight?: string) {
  const y0 = base + p.oy;
  const step = r0 * 1.3;
  const start = Math.floor(-p.ox / step) - 2;
  ctx.fillStyle = color;
  ctx.fillRect(0, y0, v.vw, v.vh - y0);
  for (let i = start; i < start + v.vw / step + 4; i++) {
    const x = i * step + p.ox;
    const r = r0 + hash(i, seed) * (r1 - r0);
    const y = y0 - r * 0.5 - hash(i, seed + 1) * r * 0.6;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.arc(x + r * 0.6, y + r * 0.3, r * 0.75, 0, Math.PI * 2); ctx.fill();
    if (highlight) { ctx.fillStyle = 'rgba(255,255,200,0.08)'; ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.35, r * 0.55, 0, Math.PI * 2); ctx.fill(); }
  }
}

function peaks(ctx: CanvasRenderingContext2D, v: ViewInfo, p: { ox: number; oy: number }, base: number, color: string, height: number, jag: number, seed: number, snow: boolean) {
  const y0 = base + p.oy;
  const step = height * 0.9;
  const start = Math.floor(-p.ox / step) - 2;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(-10, v.vh);
  const tops: [number, number][] = [];
  for (let i = start; i < start + v.vw / step + 4; i++) {
    const x = i * step + p.ox;
    const h = height * (0.55 + hash(i, seed) * 0.6);
    ctx.lineTo(x - step / 2, y0 - h * 0.25 * jag);
    ctx.lineTo(x, y0 - h);
    tops.push([x, y0 - h]);
  }
  ctx.lineTo(v.vw + 10, v.vh); ctx.closePath(); ctx.fill();
  if (snow) {
    ctx.fillStyle = 'rgba(255,250,245,0.55)';
    for (const [x, y] of tops) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 22, y + 26); ctx.lineTo(x - 6, y + 20); ctx.lineTo(x + 4, y + 30); ctx.lineTo(x + 20, y + 22); ctx.closePath(); ctx.fill(); }
  }
}

// ------------------------------------------------------------------ terrain (baked once per map into the terrain cache)
export function paintSceneryTerrain(ctx: CanvasRenderingContext2D, world: World) {
  const m = world.map, th = m.theme;
  const solid = (x: number, y: number) => { const t = world.terrainAt(x, y); return t === 1 || t === 2; };
  // the cave backdrop first: deep, low-contrast stone behind every open cell inside the mountain, so it never reads as rock
  for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) {
    if (world.terrainAt(x, y) || materialAt(m, x, y) !== 'cave') continue;
    const px = x * C, py = y * C;
    const depth = Math.min(1, Math.max(0, (y - 8) / 22));
    ctx.fillStyle = lerpColor('#3a2f5e', '#1c1834', depth);
    ctx.fillRect(px, py, C, C);
    const n = hash(x, y, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    if (n < 0.5) ctx.fillRect(px + n * 30, py + 6 + n * 20, 18, 4);
    if (n > 0.86) { ctx.fillStyle = n > 0.95 ? 'rgba(255,111,216,0.35)' : 'rgba(94,242,255,0.28)'; ctx.fillRect(px + 10 + n * 20, py + 12, 3, 3); }
  }
  for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) {
    const t = world.terrainAt(x, y);
    if (!t) continue;
    const px = x * C, py = y * C;
    const mat = materialAt(m, x, y);
    if (t === 3) { drawOneway(ctx, px, py, th.oneway, mat); continue; }
    const top = !solid(x, y - 1), bottom = !solid(x, y + 1), left = !solid(x - 1, y), right = !solid(x + 1, y);
    const n = hash(x, y);
    switch (mat) {
      case 'leaf': {
        // canopy: layered greens, sunlit crown, shaded underside
        const shade = Math.min(1, (y - 9) / 9);
        ctx.fillStyle = lerpColor(th.accent3 ?? '#a7e34f', th.accent2 ?? '#2f8f4e', 0.35 + shade * 0.5);
        ctx.fillRect(px, py, C, C);
        for (let i = 0; i < 4; i++) {
          const r = 9 + hash(x, y, i) * 9;
          ctx.fillStyle = i % 2 ? 'rgba(20,80,40,0.28)' : 'rgba(210,255,140,0.22)';
          ctx.beginPath(); ctx.arc(px + hash(x, y, i + 5) * C, py + hash(x, y, i + 9) * C, r, 0, Math.PI * 2); ctx.fill();
        }
        if (top) {
          ctx.fillStyle = th.accent3 ?? '#a7e34f'; ctx.fillRect(px, py, C, 9);
          ctx.fillStyle = 'rgba(255,255,200,0.6)';
          for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(px + 6 + i * 12, py + 6, 6, Math.PI, 0); ctx.fill(); }
        }
        if (bottom) { ctx.fillStyle = 'rgba(10,40,20,0.55)'; ctx.fillRect(px, py + C - 10, C, 10); for (let i = 0; i < 3; i++) { ctx.fillStyle = '#1f5f34'; ctx.beginPath(); ctx.arc(px + 8 + i * 16, py + C, 7, 0, Math.PI); ctx.fill(); } }
        if (left || right) { ctx.fillStyle = 'rgba(10,40,20,0.3)'; ctx.fillRect(left ? px : px + C - 6, py, 6, C); }
        break;
      }
      case 'bark': case 'branch': case 'root': {
        const base = mat === 'root' ? '#5a3a22' : mat === 'branch' ? '#8a5d36' : '#7a5233';
        ctx.fillStyle = base; ctx.fillRect(px, py, C, C);
        ctx.strokeStyle = 'rgba(40,20,8,0.35)'; ctx.lineWidth = 2;
        ctx.beginPath();
        if (mat === 'branch') { for (let i = 0; i < 3; i++) { ctx.moveTo(px, py + 10 + i * 12 + n * 4); ctx.lineTo(px + C, py + 12 + i * 12 - n * 4); } }
        else { for (let i = 0; i < 3; i++) { const xx = px + 8 + i * 15 + n * 6; ctx.moveTo(xx, py); ctx.bezierCurveTo(xx + 5, py + 16, xx - 5, py + 32, xx + 2, py + C); } }
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,210,150,0.12)'; ctx.fillRect(px + 4, py, 6, C); // warm light on the bark
        if (n > 0.8 && mat === 'bark') { ctx.fillStyle = '#3e2a1a'; ctx.beginPath(); ctx.ellipse(px + 24, py + 24, 6, 9, 0, 0, Math.PI * 2); ctx.fill(); } // knot
        if (top) { ctx.fillStyle = mat === 'root' ? '#4fae3c' : '#69c94a'; ctx.fillRect(px, py, C, 7); ctx.fillStyle = '#9be36b'; ctx.fillRect(px, py, C, 2); }
        if (left) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(px, py, 4, C); }
        if (right) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(px + C - 4, py, 4, C); }
        if (bottom) { ctx.fillStyle = 'rgba(20,10,4,0.45)'; ctx.fillRect(px, py + C - 5, C, 5); }
        break;
      }
      case 'cave': {
        // layered cave rock: lighter near open faces, mineral veins, mossy or crystal-lit edges
        const exposed = top || bottom || left || right;
        ctx.fillStyle = exposed ? lerpColor(th.terrain, '#9a90b8', 0.25) : lerpColor(th.terrain, th.terrainDark, 0.55);
        ctx.fillRect(px, py, C, C);
        ctx.fillStyle = 'rgba(0,0,0,0.12)'; if ((x * 3 + y) % 4 === 0) ctx.fillRect(px, py + 14, C, 6);
        if (n > 0.9) { ctx.fillStyle = n > 0.96 ? th.accent3 ?? '#ff6fd8' : th.accent2 ?? '#5ef2ff'; ctx.globalAlpha = 0.6; ctx.fillRect(px + n * 30, py + 10, 4, 12); ctx.globalAlpha = 1; }
        if (top) {
          const outside = y < 20 && !materialAt(m, x, y - 1) ? false : true;
          ctx.fillStyle = outside ? '#b9b2d6' : th.terrainEdge; ctx.fillRect(px, py, C, 7);
          ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(px, py, C, 2);
        }
        if (bottom) { ctx.fillStyle = 'rgba(10,6,24,0.55)'; ctx.fillRect(px, py + C - 6, C, 6); ctx.fillStyle = 'rgba(30,24,50,0.9)'; if (n > 0.55) { ctx.beginPath(); ctx.moveTo(px + 12, py + C); ctx.lineTo(px + 18 + n * 8, py + C + 14); ctx.lineTo(px + 26, py + C); ctx.fill(); } }
        if (left) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(px, py, 4, C); }
        if (right) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(px + C - 4, py, 4, C); }
        break;
      }
      case 'peak': {
        // the mountain's outer rock: cool layered stone, bright snow on every exposed top, shadowed overhangs
        const k = Math.min(1, y / 22);
        ctx.fillStyle = lerpColor('#b7aed6', '#6f6a8a', k * 0.8 + n * 0.1);
        ctx.fillRect(px, py, C, C);
        ctx.fillStyle = 'rgba(40,30,70,0.14)'; if ((x + y * 2) % 5 === 0) ctx.fillRect(px, py + 18, C, 5);
        if (n > 0.85) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(px + 8, py + 8, 10, 3); }
        if (top) { ctx.fillStyle = '#fbf7ff'; ctx.fillRect(px, py, C, 10); ctx.beginPath(); ctx.arc(px + 14, py + 10, 6, 0, Math.PI); ctx.arc(px + 34, py + 10, 5, 0, Math.PI); ctx.fill(); }
        if (left) { ctx.fillStyle = 'rgba(255,220,200,0.22)'; ctx.fillRect(px, py, 5, C); } // warm sunset light on the west faces
        if (right) { ctx.fillStyle = 'rgba(30,20,60,0.3)'; ctx.fillRect(px + C - 5, py, 5, C); }
        if (bottom) { ctx.fillStyle = 'rgba(20,14,40,0.5)'; ctx.fillRect(px, py + C - 6, C, 6); }
        break;
      }
      default: {
        // meadow earth and foothill rock outside the special zones
        const isOak = m.id === 'oak';
        ctx.fillStyle = isOak ? lerpColor('#8a5d36', '#5a3a22', Math.min(1, (y - 28) / 10)) : lerpColor('#8a7fa6', '#4a4466', Math.min(1, (y - 26) / 10));
        ctx.fillRect(px, py, C, C);
        if (n > 0.7) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.arc(px + n * 40, py + 30, 5, 0, Math.PI * 2); ctx.fill(); }
        if (n < 0.15) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.arc(px + 30, py + 18 + n * 60, 6, 0, Math.PI * 2); ctx.fill(); }
        if (top) {
          ctx.fillStyle = th.terrainEdge; ctx.fillRect(px, py, C, 9);
          ctx.fillStyle = isOak ? '#9be36b' : '#c8f0a0'; ctx.fillRect(px, py, C, 3);
          ctx.fillStyle = isOak ? '#3f9a32' : '#6fae5a';
          for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(px + 4 + i * 12, py + 9); ctx.lineTo(px + 8 + i * 12, py + 15 + hash(x, i) * 4); ctx.lineTo(px + 12 + i * 12, py + 9); ctx.fill(); }
        }
        if (left) { ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(px, py, 4, C); }
        if (right) { ctx.fillStyle = 'rgba(0,0,0,0.24)'; ctx.fillRect(px + C - 4, py, 4, C); }
        if (bottom) { ctx.fillStyle = th.terrainDark; ctx.fillRect(px, py + C - 5, C, 5); }
      }
    }
  }
  paintStaticDecor(ctx, world);
}

function drawOneway(ctx: CanvasRenderingContext2D, px: number, py: number, color: string, mat: string) {
  // logs, mushroom caps and stalagmite tops: solid only from above, drawn as thin tops with a clear shadow line
  ctx.fillStyle = color; ctx.fillRect(px, py, C, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(px, py, C, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(px, py + 10, C, 3);
  if (mat === 'cave') { ctx.fillStyle = 'rgba(199,163,255,0.4)'; ctx.beginPath(); ctx.moveTo(px + 10, py + 12); ctx.lineTo(px + 24, py + 30); ctx.lineTo(px + 38, py + 12); ctx.fill(); }
}

function paintStaticDecor(ctx: CanvasRenderingContext2D, world: World) {
  const m = world.map;
  for (const d of m.decor) {
    const x0 = d.x * C, y0 = d.y * C;
    switch (d.kind) {
      case 'flowers': for (let i = 0; i < (d.w ?? 4) * 3; i++) {
        const x = x0 + i * 16 + hash(i, d.x) * 10;
        const cx = Math.floor(x / C);
        if (world.terrainAt(cx, d.y) !== 1 || world.terrainAt(cx, d.y - 1)) continue; // only on open ground tops
        const col = ['#ff6f91', '#ffd166', '#f7f7ff', '#c77dff', '#ff9f43'][i % 5];
        ctx.strokeStyle = '#3f9a32'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y0 + 2); ctx.lineTo(x, y0 - 8); ctx.stroke();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y0 - 10, 3.5, 0, Math.PI * 2); ctx.fill();
      } break;
      case 'fern': for (let i = -2; i <= 2; i++) { ctx.strokeStyle = '#2f8f4e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x0 + 24, y0); ctx.quadraticCurveTo(x0 + 24 + i * 10, y0 - 26, x0 + 24 + i * 18, y0 - 18 + Math.abs(i) * 4); ctx.stroke(); } break;
      case 'mushroom': ctx.fillStyle = '#f2e6d0'; ctx.fillRect(x0 + 20, y0 - 14, 6, 14); ctx.fillStyle = '#e2453c'; ctx.beginPath(); ctx.arc(x0 + 23, y0 - 14, 11, Math.PI, 0); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x0 + 19, y0 - 19, 2, 0, Math.PI * 2); ctx.arc(x0 + 27, y0 - 17, 1.6, 0, Math.PI * 2); ctx.fill(); break;
      case 'crystals': for (let i = 0; i < 7; i++) {
        // crystal clusters on cave walls: only where a solid cell touches open cave
        const cx = d.x + Math.floor(hash(i, d.x, 2) * (d.w ?? 4)), cy = d.y + Math.floor(hash(i, d.y, 4) * (d.h ?? 4));
        if (world.terrainAt(cx, cy) !== 1 || !openNeighbour(world, cx, cy)) continue;
        const col = i % 3 === 0 ? '#ff6fd8' : '#5ef2ff';
        crystal(ctx, cx * C + 24, cy * C + (world.terrainAt(cx, cy - 1) ? C : 0), col, world.terrainAt(cx, cy - 1) ? 1 : -1);
      } break;
      case 'lake': {
        const g = ctx.createLinearGradient(0, y0, 0, y0 + (d.h ?? 6) * C);
        g.addColorStop(0, 'rgba(60,220,255,0.55)'); g.addColorStop(1, 'rgba(20,40,120,0.85)');
        ctx.fillStyle = g; ctx.fillRect(x0, y0 + 20, (d.w ?? 4) * C, (d.h ?? 6) * C);
        ctx.fillStyle = 'rgba(200,250,255,0.7)'; ctx.fillRect(x0, y0 + 20, (d.w ?? 4) * C, 3);
        break;
      }
      case 'torch': ctx.fillStyle = '#5a3a22'; ctx.fillRect(x0 + 20, y0 + 10, 7, 26); ctx.fillStyle = '#3e2a1a'; ctx.fillRect(x0 + 16, y0 + 8, 15, 5); break;
      default: break;
    }
  }
}

function openNeighbour(world: World, x: number, y: number) { return !world.terrainAt(x, y - 1) || !world.terrainAt(x, y + 1) || !world.terrainAt(x - 1, y) || !world.terrainAt(x + 1, y); }

function crystal(ctx: CanvasRenderingContext2D, x: number, y: number, col: string, dir: number) {
  ctx.fillStyle = col; ctx.globalAlpha = 0.85;
  for (const [ox, h, w] of [[-8, 16, 5], [0, 24, 6], [8, 13, 5]]) { ctx.beginPath(); ctx.moveTo(x + ox - w, y); ctx.lineTo(x + ox, y + dir * h); ctx.lineTo(x + ox + w, y); ctx.fill(); }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ ambient life (world space, drawn behind objects)
/** Small moving touches. Capped, deterministic from time, frozen under reduced motion, thinned by the particle setting. */
export function drawAmbient(ctx: CanvasRenderingContext2D, map: MapDef, v: ViewInfo) {
  const t = v.reduced ? 0 : v.t;
  const view = { x0: v.camX - v.vw / 2 / v.zoom - 60, x1: v.camX + v.vw / 2 / v.zoom + 60, y0: v.camY - v.vh / 2 / v.zoom - 60, y1: v.camY + v.vh / 2 / v.zoom + 60 };
  const visible = (x: number, y: number) => x > view.x0 && x < view.x1 && y > view.y0 && y < view.y1;
  for (const d of map.decor) {
    const x0 = d.x * C, y0 = d.y * C, w = (d.w ?? 1) * C, h = (d.h ?? 1) * C;
    if (x0 > view.x1 || x0 + w < view.x0 || y0 > view.y1 + 400 || y0 + h < view.y0 - 400) continue;
    switch (d.kind) {
      case 'leaves': {
        const n = Math.round(20 * v.budget);
        for (let i = 0; i < n; i++) {
          const fall = ((t * (22 + hash(i, 1) * 18) + hash(i, 2) * h) % h);
          const x = x0 + hash(i, 3) * w + Math.sin(t * 1.3 + i) * 22, y = y0 + fall;
          if (!visible(x, y)) continue;
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * 2 + i) * 1.2);
          ctx.fillStyle = i % 3 ? 'rgba(167,227,79,0.85)' : 'rgba(255,200,80,0.85)';
          ctx.beginPath(); ctx.ellipse(0, 0, 5, 2.6, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
        break;
      }
      case 'butterflies': {
        const n = Math.round(5 * v.budget);
        for (let i = 0; i < n; i++) {
          const x = x0 + ((hash(i, 7) * w + t * 30 * (i % 2 ? 1 : -1)) % w + w) % w, y = y0 + hash(i, 8) * h + Math.sin(t * 2.2 + i * 2) * 18;
          if (!visible(x, y)) continue;
          const flap = Math.abs(Math.sin(t * 12 + i)) * 5 + 1;
          ctx.fillStyle = ['#ff8fd0', '#ffd166', '#8fd3ff'][i % 3];
          ctx.beginPath(); ctx.ellipse(x - flap / 2, y, flap, 4, 0, 0, Math.PI * 2); ctx.ellipse(x + flap / 2, y, flap, 4, 0, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'birds': {
        const n = Math.round(4 * v.budget);
        ctx.strokeStyle = 'rgba(40,40,70,0.55)'; ctx.lineWidth = 2;
        for (let i = 0; i < n; i++) {
          const x = x0 + ((hash(i, 11) * w + t * (40 + i * 7)) % (w + 200)) - 100, y = y0 + hash(i, 12) * h + Math.sin(t + i) * 10;
          if (!visible(x, y)) continue;
          const f = Math.sin(t * 8 + i) * 5;
          ctx.beginPath(); ctx.moveTo(x - 9, y - f); ctx.quadraticCurveTo(x - 4, y - 4, x, y); ctx.quadraticCurveTo(x + 4, y - 4, x + 9, y - f); ctx.stroke();
        }
        break;
      }
      case 'bats': {
        const n = Math.round(5 * v.budget);
        ctx.fillStyle = 'rgba(20,14,36,0.8)';
        for (let i = 0; i < n; i++) {
          const x = x0 + ((hash(i, 21) * w + t * (35 + i * 9) * (i % 2 ? 1 : -1)) % w + w) % w, y = y0 + hash(i, 22) * h + Math.sin(t * 3 + i) * 14;
          if (!visible(x, y)) continue;
          const f = Math.sin(t * 14 + i) * 6;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 10, y - f); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x, y + 2); ctx.lineTo(x + 5, y + 3); ctx.lineTo(x + 10, y - f); ctx.closePath(); ctx.fill();
        }
        break;
      }
      case 'dust': {
        const n = Math.round(26 * v.budget);
        for (let i = 0; i < n; i++) {
          const x = x0 + hash(i, 31) * w + Math.sin(t * 0.3 + i) * 30, y = y0 + ((hash(i, 32) * h - t * 6) % h + h) % h;
          if (!visible(x, y)) continue;
          ctx.fillStyle = `rgba(255,230,190,${0.15 + 0.15 * Math.sin(t + i)})`;
          ctx.fillRect(x, y, 2, 2);
        }
        break;
      }
      case 'torch': {
        const fx = x0 + 23, fy = y0 + 4;
        if (!visible(fx, fy)) continue;
        const fl = 1 + 0.12 * Math.sin(t * 13) + 0.08 * Math.sin(t * 7.3);
        const g = ctx.createRadialGradient(fx, fy, 2, fx, fy, 150 * fl);
        g.addColorStop(0, 'rgba(255,200,110,0.45)'); g.addColorStop(1, 'rgba(255,160,80,0)');
        ctx.fillStyle = g; ctx.fillRect(fx - 160, fy - 160, 320, 320);
        ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.ellipse(fx, fy, 6 * fl, 11 * fl, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff2c2'; ctx.beginPath(); ctx.ellipse(fx, fy + 2, 3, 5, 0, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'crystals': case 'glowshrooms': {
        // soft pulsing glow pools: light pockets that make the cave inviting without hiding anything
        const n = d.kind === 'glowshrooms' ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const x = x0 + (i + 0.5) / n * w, y = y0 + (d.kind === 'glowshrooms' ? -10 : h * 0.4);
          if (!visible(x, y)) continue;
          const a = 0.1 + 0.05 * Math.sin(t * 1.5 + i * 2);
          const g = ctx.createRadialGradient(x, y, 4, x, y, 170);
          g.addColorStop(0, d.kind === 'glowshrooms' ? `rgba(160,255,140,${a})` : i % 2 ? `rgba(255,111,216,${a})` : `rgba(94,242,255,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g; ctx.fillRect(x - 180, y - 180, 360, 360);
        }
        if (d.kind === 'glowshrooms') for (let i = 0; i < (d.w ?? 4); i += 2) {
          const x = x0 + i * C + 20;
          const col = world2col(i);
          ctx.fillStyle = '#d8f5c8'; ctx.fillRect(x - 2, y0 - 10, 4, 10);
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y0 - 10, 7 + Math.sin(t * 2 + i), Math.PI, 0); ctx.fill();
        }
        break;
      }
      case 'lake': {
        if (v.reduced) break;
        ctx.strokeStyle = 'rgba(200,250,255,0.5)'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) { const x = x0 + ((t * 25 + i * 90) % w); ctx.beginPath(); ctx.moveTo(x, y0 + 22); ctx.lineTo(x + 20, y0 + 22); ctx.stroke(); }
        break;
      }
      default: break;
    }
  }
}

const world2col = (i: number) => (i % 4 === 0 ? '#9dff7a' : i % 4 === 2 ? '#5ef2ff' : '#ffd166');

export function lerpColor(a: string, b: string, k: number): string {
  const pa = parseHex(a), pb = parseHex(b);
  const f = Math.max(0, Math.min(1, k));
  return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * f)},${Math.round(pa[1] + (pb[1] - pa[1]) * f)},${Math.round(pa[2] + (pb[2] - pa[2]) * f)})`;
}
function parseHex(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
