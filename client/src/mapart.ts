// Art for the batch-update maps (Tropical Island, Magma Works, Orbital Lab, Sandstorm Dunes): backgrounds, material
// painting for their terrain, and the animated map mechanics (sea, tsunami, lava, geysers, low gravity, sandstorm, ball).
// Purely visual: collision is the terrain grid and the mechanics are computed in shared/mapfx.ts.
import { CELL } from '../../shared/config';
import type { MapDef } from '../../shared/maps';
import { geyserRects, geyserWarnings, gustAt, liquidSurface, tsunamiLevel } from '../../shared/mapfx';
import type { World } from '../../shared/world';
import { hash, materialAt, type ViewInfo } from './scenery';

const C = CELL;

export const hasMapArt = (m: MapDef) => m.id === 'tropical' || m.id === 'magma' || m.id === 'orbital' || m.id === 'dunes';

// ------------------------------------------------------------------ backgrounds (screen space)
export function drawMapBackground(ctx: CanvasRenderingContext2D, map: MapDef, v: ViewInfo) {
  const th = map.theme;
  const g = ctx.createLinearGradient(0, 0, 0, v.vh);
  g.addColorStop(0, th.skyTop); g.addColorStop(1, th.skyBottom);
  ctx.fillStyle = g; ctx.fillRect(0, 0, v.vw, v.vh);
  const par = (f: number) => -(v.camX * f);
  const t = v.reduced ? 0 : v.t;
  switch (map.id) {
    case 'tropical': {
      // big sun, a far island, distant sea and palm silhouettes
      const sx = v.vw * 0.78, sy = v.vh * 0.16;
      const sun = ctx.createRadialGradient(sx, sy, 8, sx, sy, v.vh * 0.5);
      sun.addColorStop(0, 'rgba(255,253,220,1)'); sun.addColorStop(0.1, 'rgba(255,240,170,.6)'); sun.addColorStop(1, 'rgba(255,240,170,0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, v.vw, v.vh);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (let i = 0; i < 6; i++) { const x = ((i * 300 + par(0.03) + t * 6) % (v.vw + 400) + v.vw + 400) % (v.vw + 400) - 200, y = v.vh * (0.1 + (i % 3) * 0.07); cloud(ctx, x, y, 40 + (i % 2) * 20); }
      ctx.fillStyle = '#5fc7d8'; ctx.fillRect(0, v.vh * 0.62, v.vw, v.vh);
      ctx.fillStyle = 'rgba(255,255,255,.25)'; for (let i = 0; i < 40; i++) ctx.fillRect(((i * 97 + par(0.1)) % v.vw + v.vw) % v.vw, v.vh * 0.64 + (i % 7) * 14, 30, 2);
      ctx.fillStyle = th.far; ctx.beginPath(); ctx.ellipse(((par(0.06) % (v.vw * 2)) + v.vw * 2) % (v.vw * 2) - v.vw * 0.3, v.vh * 0.63, 220, 46, 0, Math.PI, 0); ctx.fill();
      for (let i = 0; i < 9; i++) palm(ctx, ((i * 260 + par(0.18)) % (v.vw + 500) + v.vw + 500) % (v.vw + 500) - 250, v.vh * 0.8, 70 + (i % 3) * 20, th.mid, t + i);
      return;
    }
    case 'magma': {
      // a smoking volcano range under a red sky, glowing lava light from below
      for (const [f, col, hgt] of [[0.05, th.far, 0.45], [0.14, th.mid, 0.3]] as [number, string, number][]) {
        ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, v.vh);
        for (let x = -100; x <= v.vw + 100; x += 30) { const wx = x - par(f); const y = v.vh * (1 - hgt) + Math.abs(Math.sin(wx / 260)) * 90 - Math.max(0, 120 - Math.abs(((wx % 900) + 900) % 900 - 450) * 0.6); ctx.lineTo(x, y); }
        ctx.lineTo(v.vw, v.vh); ctx.closePath(); ctx.fill();
      }
      const glow = ctx.createLinearGradient(0, v.vh * 0.6, 0, v.vh); glow.addColorStop(0, 'rgba(255,90,20,0)'); glow.addColorStop(1, 'rgba(255,90,20,.35)');
      ctx.fillStyle = glow; ctx.fillRect(0, v.vh * 0.6, v.vw, v.vh * 0.4);
      ctx.fillStyle = 'rgba(80,60,60,.25)'; for (let i = 0; i < 6; i++) { const x = ((i * 240 + par(0.08)) % (v.vw + 300) + v.vw + 300) % (v.vw + 300) - 150; ctx.beginPath(); ctx.arc(x, v.vh * 0.25 - ((t * 14 + i * 40) % 160), 40 + i * 6, 0, Math.PI * 2); ctx.fill(); }
      for (let i = 0; i < 50 * v.budget; i++) { ctx.fillStyle = i % 3 ? 'rgba(255,160,60,.8)' : 'rgba(255,230,140,.9)'; ctx.fillRect((hash(i, 3) * v.vw + t * 10 * (i % 4)) % v.vw, v.vh - ((hash(i, 7) * v.vh + t * 40 * (1 + (i % 3))) % v.vh), 2, 2); }
      return;
    }
    case 'orbital': {
      // deep space: twinkling stars, a ringed planet and a slow nebula
      for (let i = 0; i < 160; i++) { const tw = 0.5 + 0.5 * Math.sin(t * 2 + i); ctx.fillStyle = `rgba(255,255,255,${(0.3 + 0.6 * hash(i, 1) * tw).toFixed(2)})`; ctx.fillRect(((hash(i, 2) * v.vw * 1.5 + par(0.02 + hash(i, 4) * 0.04)) % v.vw + v.vw) % v.vw, hash(i, 5) * v.vh, 1.5, 1.5); }
      const neb = ctx.createRadialGradient(v.vw * 0.3, v.vh * 0.4, 10, v.vw * 0.3, v.vh * 0.4, v.vw * 0.5); neb.addColorStop(0, 'rgba(255,111,216,.18)'); neb.addColorStop(1, 'rgba(94,242,255,0)');
      ctx.fillStyle = neb; ctx.fillRect(0, 0, v.vw, v.vh);
      const px = v.vw * 0.72 + par(0.03) % 200, py = v.vh * 0.3;
      const pg = ctx.createRadialGradient(px - 30, py - 30, 10, px, py, 90); pg.addColorStop(0, '#ffcf8a'); pg.addColorStop(1, '#c05a3c');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, 80, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,180,.6)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.ellipse(px, py, 140, 26, -0.3, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    case 'dunes': {
      const sx = v.vw * 0.7, sy = v.vh * 0.22;
      const sun = ctx.createRadialGradient(sx, sy, 10, sx, sy, v.vh * 0.6); sun.addColorStop(0, 'rgba(255,255,230,1)'); sun.addColorStop(0.12, 'rgba(255,220,150,.6)'); sun.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, v.vw, v.vh);
      for (const [f, col, base] of [[0.05, th.far, 0.6], [0.15, th.mid, 0.74]] as [number, string, number][]) {
        ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, v.vh);
        for (let x = -50; x <= v.vw + 50; x += 20) { const wx = x - par(f); ctx.lineTo(x, v.vh * base - Math.sin(wx / 210) * 40 - Math.sin(wx / 83) * 12); }
        ctx.lineTo(v.vw, v.vh); ctx.closePath(); ctx.fill();
      }
      return;
    }
    default: return;
  }
}

function cloud(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.arc(x, y, r * 0.6, 0, Math.PI * 2); ctx.arc(x + r * 0.6, y - r * 0.2, r * 0.5, 0, Math.PI * 2); ctx.arc(x + r * 1.1, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
}

function palm(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, col: string, t: number) {
  ctx.strokeStyle = col; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 12, y - h * 0.5, x + 6, y - h); ctx.stroke();
  ctx.fillStyle = col;
  for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + (i - 2.5) * 0.55 + Math.sin(t * 1.2) * 0.05; ctx.beginPath(); ctx.ellipse(x + 6 + Math.cos(a) * 22, y - h + Math.sin(a) * 12 + 6, 26, 6, a, 0, Math.PI * 2); ctx.fill(); }
}

// ------------------------------------------------------------------ terrain materials (baked into the terrain cache)
/** Paint one terrain cell of a batch-update map. */
export function paintMapCell(ctx: CanvasRenderingContext2D, world: World, x: number, y: number) {
  const m = world.map, th = m.theme;
  const t = world.terrainAt(x, y);
  const px = x * C, py = y * C;
  const mat = materialAt(m, x, y);
  const open = (dx: number, dy: number) => { const k = world.terrainAt(x + dx, y + dy); return k !== 1 && k !== 2; };
  if (t === 3) {
    // one-way platforms: leafy canopies, vine rungs, parasol canopies, metal catwalks
    if (mat === 'canopy') { ctx.fillStyle = '#2f9a45'; ctx.fillRect(px, py, C, 16); ctx.fillStyle = '#49c25a'; for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(px + 4 + i * 10, py + 4 + (i % 2) * 3, 7, 0, Math.PI * 2); ctx.fill(); } ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(px, py + 14, C, 3); return; }
    if (mat === 'parasol' || mat === 'parasol2') { const a = mat === 'parasol' ? '#ff5e5e' : '#4aa8ff'; for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#fff' : a; ctx.fillRect(px + i * 12, py, 12, 10); } ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(px, py + 9, C, 2); return; }
    if (mat === 'vines') { ctx.fillStyle = '#5a3a1e'; ctx.fillRect(px, py + 2, C, 7); ctx.strokeStyle = '#3f9a3a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, py + 5); for (let i = 0; i <= 6; i++) ctx.lineTo(px + i * 8, py + 5 + (i % 2 ? 3 : -3)); ctx.stroke(); return; }
    ctx.fillStyle = th.oneway; ctx.fillRect(px, py, C, 12); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(px, py + 10, C, 2);
    return;
  }
  const n = hash(x, y, 5);
  if (x === 0 || y === 0 || x === world.w - 1) {
    // the world's frame: dark and plain so it reads as a boundary, not part of the course
    ctx.fillStyle = th.terrainDark; ctx.fillRect(px, py, C, C);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; if ((x + y) % 2) ctx.fillRect(px, py, C, C);
    return;
  }
  switch (mat) {
    case 'boat': {
      ctx.fillStyle = y >= 39 ? '#7a3b22' : '#b5743f'; ctx.fillRect(px, py, C, C);
      ctx.strokeStyle = 'rgba(60,30,10,.5)'; ctx.lineWidth = 1.5; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(px, py + i * 12); ctx.lineTo(px + C, py + i * 12); ctx.stroke(); }
      if (y >= 39) { ctx.fillStyle = '#f2f2f2'; ctx.fillRect(px, py + 4, C, 5); }
      if (open(0, -1)) { ctx.fillStyle = '#e6c08a'; ctx.fillRect(px, py, C, 6); }
      return;
    }
    case 'sand': case 'desert': {
      ctx.fillStyle = mat === 'sand' ? th.terrain : (y > 31 ? '#d39e5c' : th.terrain); ctx.fillRect(px, py, C, C);
      ctx.fillStyle = 'rgba(120,80,30,.18)'; for (let i = 0; i < 6; i++) ctx.fillRect(px + hash(x, y, i) * 44, py + hash(y, x, i) * 44, 2, 2);
      if (open(0, -1)) { ctx.fillStyle = th.terrainEdge; ctx.fillRect(px, py, C, 7); ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillRect(px + 6, py + 2, 12, 2); }
      return;
    }
    case 'chair': { ctx.fillStyle = '#7a4a26'; ctx.fillRect(px + 2, py + 2, C - 4, C - 4); for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#fff' : '#ff6a5e'; ctx.fillRect(px + 4, py + 4 + i * 10, C - 8, 10); } return; }
    case 'basket': { ctx.fillStyle = '#c98b4f'; ctx.fillRect(px + 4, py + 10, C - 8, C - 10); ctx.strokeStyle = '#8a5a2c'; ctx.lineWidth = 2; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(px + 4, py + 16 + i * 8); ctx.lineTo(px + C - 4, py + 16 + i * 8); ctx.stroke(); } ctx.beginPath(); ctx.arc(px + C / 2, py + 12, 14, Math.PI, 0); ctx.stroke(); return; }
    case 'jungle': { ctx.fillStyle = '#4a3a22'; ctx.fillRect(px, py, C, C); ctx.fillStyle = 'rgba(0,0,0,.12)'; if (n > 0.5) ctx.fillRect(px + 8, py + 10, 14, 10); if (open(0, -1)) { ctx.fillStyle = '#3f9a3a'; ctx.fillRect(px, py, C, 8); for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(px + 6 + i * 12, py + 8); ctx.lineTo(px + 9 + i * 12, py - 4 - n * 5); ctx.lineTo(px + 12 + i * 12, py + 8); ctx.fill(); } } return; }
    case 'trunk': { ctx.fillStyle = '#7a5032'; ctx.fillRect(px, py, C, C); ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 2; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(px + 8 + i * 14, py); ctx.lineTo(px + 6 + i * 14 + n * 4, py + C); ctx.stroke(); } return; }
    case 'basalt': case 'forge': {
      ctx.fillStyle = mat === 'forge' ? '#4a3a3c' : th.terrain; ctx.fillRect(px, py, C, C);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; ctx.strokeRect(px + 1, py + 1, C / 2 - 1, C - 2); ctx.strokeRect(px + C / 2, py + 1, C / 2 - 1, C - 2);
      if (n > 0.7) { ctx.strokeStyle = 'rgba(255,110,30,.7)'; ctx.beginPath(); ctx.moveTo(px + 10, py + 6); ctx.lineTo(px + 22, py + 20); ctx.lineTo(px + 16, py + 34); ctx.stroke(); }
      if (open(0, -1)) { ctx.fillStyle = th.terrainEdge; ctx.fillRect(px, py, C, 5); }
      if (mat === 'forge') { ctx.fillStyle = 'rgba(255,180,60,.3)'; ctx.fillRect(px + 6, py + 20, 8, 8); }
      return;
    }
    case 'hull': {
      ctx.fillStyle = th.terrain; ctx.fillRect(px, py, C, C);
      ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(px + 3, py + 3, C - 6, 6);
      ctx.strokeStyle = 'rgba(20,24,50,.6)'; ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, C - 2, C - 2);
      ctx.fillStyle = 'rgba(20,24,50,.6)'; for (const [bx, by] of [[6, 6], [C - 6, 6], [6, C - 6], [C - 6, C - 6]]) { ctx.beginPath(); ctx.arc(px + bx, py + by, 2, 0, Math.PI * 2); ctx.fill(); }
      if (open(0, -1)) { ctx.fillStyle = th.terrainEdge; ctx.fillRect(px, py, C, 4); }
      if (open(0, 1)) { ctx.fillStyle = th.terrainEdge; ctx.globalAlpha = 0.5; ctx.fillRect(px, py + C - 3, C, 3); ctx.globalAlpha = 1; }
      return;
    }
    case 'mesa': {
      ctx.fillStyle = (y % 3 === 0) ? '#b65a32' : (y % 3 === 1) ? '#c96a3c' : '#a8502c'; ctx.fillRect(px, py, C, C);
      if (open(0, -1)) { ctx.fillStyle = '#e8a86a'; ctx.fillRect(px, py, C, 6); }
      return;
    }
    default: {
      ctx.fillStyle = th.terrain; ctx.fillRect(px, py, C, C);
      if (open(0, -1)) { ctx.fillStyle = th.terrainEdge; ctx.fillRect(px, py, C, 7); }
    }
  }
}

/** Non-colliding decoration baked with the terrain: masts, parasol poles, the picnic blanket. */
export function paintMapDecor(ctx: CanvasRenderingContext2D, world: World) {
  for (const d of world.map.decor) {
    const x0 = d.x * C, y0 = d.y * C;
    switch (d.kind) {
      case 'mast': ctx.fillStyle = '#6b4424'; ctx.fillRect(x0 + 20, y0, 6, 8 * C - 40); ctx.fillStyle = '#f4f4f0'; ctx.beginPath(); ctx.moveTo(x0 + 26, y0 + 10); ctx.lineTo(x0 + 26 + 90, y0 + 3 * C); ctx.lineTo(x0 + 26, y0 + 3.6 * C); ctx.closePath(); ctx.fill(); break;
      case 'parasolpole': ctx.fillStyle = '#e8e2d0'; ctx.fillRect(x0 + 22, y0, 4, 3 * C); break;
      case 'blanket': for (let i = 0; i < (d.w ?? 3) * 4; i++) { ctx.fillStyle = i % 2 ? '#ff5e5e' : '#fff'; ctx.fillRect(x0 + i * 12, y0 + C - 6, 12, 6); } break;
      default: break;
    }
  }
}

// ------------------------------------------------------------------ mechanics (world space, every frame)
/** Sea, tsunami or lava, drawn over everything it covers. */
export function drawLiquid(ctx: CanvasRenderingContext2D, map: MapDef, tick: number, t: number, x0: number, x1: number) {
  const fx = map.fx;
  if (!fx?.liquid) return;
  const s = liquidSurface(map, tick)!;
  const bottom = map.h * C + 40;
  const lava = fx.liquid.kind === 'lava';
  const up = fx.tsunami ? tsunamiLevel(fx, tick) : 0;
  const g = ctx.createLinearGradient(0, s, 0, bottom);
  if (lava) { g.addColorStop(0, '#ffb347'); g.addColorStop(0.08, '#ff5a1f'); g.addColorStop(1, '#7a1205'); }
  else { g.addColorStop(0, `rgba(80,210,235,${0.82 + up * 0.1})`); g.addColorStop(0.2, 'rgba(30,140,200,.9)'); g.addColorStop(1, 'rgba(10,50,110,.97)'); }
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(x0, bottom);
  const amp = lava ? 3 : 4 + up * 10, spd = lava ? 1.5 : 2.4 + up * 3;
  for (let x = x0; x <= x1; x += 16) ctx.lineTo(x, s + Math.sin(x / 60 + t * spd) * amp + Math.sin(x / 23 - t * 1.7) * amp * 0.4);
  ctx.lineTo(x1, bottom); ctx.closePath(); ctx.fill();
  // foam or a glowing crust along the surface
  ctx.strokeStyle = lava ? 'rgba(255,230,140,.9)' : `rgba(255,255,255,${0.7 + up * 0.3})`; ctx.lineWidth = lava ? 3 : 3 + up * 4;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 16) { const y = s + Math.sin(x / 60 + t * spd) * amp + Math.sin(x / 23 - t * 1.7) * amp * 0.4; if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
  if (lava) for (let i = 0; i < 18; i++) { const bx = x0 + ((i * 173 + t * 30) % Math.max(1, x1 - x0)), k = (t * 0.8 + i * 0.37) % 1; ctx.fillStyle = `rgba(255,220,120,${(1 - k).toFixed(2)})`; ctx.beginPath(); ctx.arc(bx, s + 6 - k * 4, 3 + k * 5, 0, Math.PI * 2); ctx.fill(); }
}

/** Lava geysers: bubbling warnings, then roaring columns. */
export function drawGeysers(ctx: CanvasRenderingContext2D, map: MapDef, tick: number, t: number) {
  const fx = map.fx;
  if (!fx?.geysers || !fx.liquid) return;
  const s = fx.liquid.level;
  for (const gx of geyserWarnings(map, tick)) {
    for (let i = 0; i < 5; i++) { const k = (t * 3 + i * 0.2) % 1; ctx.fillStyle = `rgba(255,200,90,${(1 - k).toFixed(2)})`; ctx.beginPath(); ctx.arc(gx * C + 10 + i * 7, s - k * 26, 3 + i % 3, 0, Math.PI * 2); ctx.fill(); }
  }
  for (const r of geyserRects(map, tick)) {
    const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
    g.addColorStop(0, 'rgba(255,90,20,.6)'); g.addColorStop(0.5, 'rgba(255,220,120,.95)'); g.addColorStop(1, 'rgba(255,90,20,.6)');
    ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
    for (let i = 0; i < 10; i++) { const k = (t * 2 + i * 0.1) % 1; ctx.fillStyle = 'rgba(255,170,60,.8)'; ctx.beginPath(); ctx.arc(r.x + r.w / 2 + Math.sin(i * 7 + t * 9) * 18, r.y + k * 30 - 10, 4 + (i % 3) * 2, 0, Math.PI * 2); ctx.fill(); }
  }
}

/** Low-gravity bays: a soft cyan field with drifting motes. */
export function drawLowGrav(ctx: CanvasRenderingContext2D, map: MapDef, t: number) {
  const z = map.fx?.lowGrav;
  if (!z) return;
  for (const r of z) {
    const x = r.x * C, y = r.y * C, w = r.w * C, h = r.h * C;
    ctx.fillStyle = 'rgba(94,242,255,.06)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(94,242,255,.35)'; ctx.setLineDash([10, 8]); ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); ctx.setLineDash([]);
    for (let i = 0; i < 14; i++) { const k = (t * 0.15 + hash(i, r.x) ) % 1; ctx.fillStyle = 'rgba(200,250,255,.6)'; ctx.fillRect(x + hash(i, r.y) * w, y + h - k * h, 2, 2); }
    ctx.fillStyle = 'rgba(200,250,255,.7)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`ZERO-G BAY · ${Math.round(r.mul * 100)}% gravity`, x + w / 2, y + 24);
  }
}

/** Sandstorm: streaks of sand blowing across the view (screen space). */
export function drawGust(ctx: CanvasRenderingContext2D, map: MapDef, tick: number, v: ViewInfo) {
  const a = gustAt(map, tick);
  if (!a) return;
  const k = Math.min(1, Math.abs(a) / (Math.abs(map.fx!.gusts!.accel) || 1));
  ctx.save();
  ctx.fillStyle = `rgba(230,180,110,${(0.18 * k).toFixed(3)})`; ctx.fillRect(0, 0, v.vw, v.vh);
  ctx.strokeStyle = `rgba(255,235,190,${(0.6 * k).toFixed(3)})`; ctx.lineWidth = 2;
  const dir = Math.sign(a);
  for (let i = 0; i < 70 * v.budget; i++) {
    const y = hash(i, 11) * v.vh, len = 30 + hash(i, 13) * 60;
    const x = (((hash(i, 17) * v.vw - dir * v.t * (600 + hash(i, 19) * 500)) % (v.vw + 200)) + v.vw + 200) % (v.vw + 200) - 100;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dir * len, y + 3); ctx.stroke();
  }
  ctx.restore();
}

/** The beach ball. */
export function drawBeachBall(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, t: number) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = r.w / 2;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.sin(t * 0.8) * 0.15);
  const cols = ['#ff4a4a', '#ffffff', '#ffd25e', '#ffffff', '#3aa0ff', '#ffffff'];
  for (let i = 0; i < 6; i++) { ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, rad, (i * Math.PI) / 3, ((i + 1) * Math.PI) / 3); ctx.closePath(); ctx.fill(); }
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, rad * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(30,30,40,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.beginPath(); ctx.ellipse(-rad * 0.35, -rad * 0.4, rad * 0.25, rad * 0.14, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
