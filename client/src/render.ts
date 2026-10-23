// Canvas renderer. Reads client state and draws; never changes game state.
import { CELL, HAZARD, PHYS, TICK_HZ } from '../../shared/config';
import { DIRS, rotDirIndex, type Rot } from '../../shared/grid';
import {
  cellCenter, laserBeamRect, laserCells, laserState, launcherDir, moverPathLen, moverRect, muzzle, pendulumPos, pendulumSweep, rspikeState, sawPos,
} from '../../shared/hazards';
import { getItem } from '../../shared/items';
import type { MapDef } from '../../shared/maps';
import type { Body } from '../../shared/physics';
import type { RaceSim } from '../../shared/race';
import { footprint, TERRAIN_ID, type PlacedObject, type World } from '../../shared/world';
import { NavGraph } from '../../shared/nav';
import { drawBlackHole, drawCharacter, drawCoinShape, drawGondola, drawItem, drawShuttleBody, drawWheelHub, PLAYER_COLORS, type AnimState } from './art';
import { drawAmbient, drawSceneryBackground, hasScenery, paintSceneryTerrain, type ViewInfo } from './scenery';
import { childCount, childRect, isKinematic, newMotion, pivotPx, referenceRects, shuttleDir, sweepOf, wheelAngle } from '../../shared/movers';
import type { GameClient } from './game';
import { settings } from './store';

const C = CELL;
const BW = PHYS.bodyW, BH = PHYS.bodyH;

export interface Camera { x: number; y: number; zoom: number }

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; grav: number }

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  buildZoom = 1;
  insetTop = 0;
  insetBottom = 0;
  dpr = 1;
  private terrainCache: { key: string; canvas: HTMLCanvasElement } | null = null;
  private particles: Particle[] = [];
  private anim = new Map<string, { land: number; wj: number; lastG: boolean }>();
  private devNav: { key: string; nav: NavGraph } | null = null;
  t = 0;
  fps = 60;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * this.dpr);
    this.canvas.height = Math.floor(window.innerHeight * this.dpr);
  }

  get vw() { return this.canvas.width / this.dpr; }
  get vh() { return this.canvas.height / this.dpr; }

  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.vw / 2) / this.cam.zoom + this.cam.x, y: (sy - this.vh / 2) / this.cam.zoom + this.cam.y };
  }

  /** Grid cell under a screen point: the same integers the server validates. */
  screenToCell(sx: number, sy: number) {
    const w = this.screenToWorld(sx, sy);
    return { x: Math.floor(w.x / C), y: Math.floor(w.y / C) };
  }

  particleBudget() { return settings.particles === 'low' ? 0.35 : settings.particles === 'high' ? 1.6 : 1; }

  burst(x: number, y: number, n: number, color: string, speed = 160, grav = 600, size = 3) {
    const count = Math.round(n * this.particleBudget());
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.3, life: 0, max: 0.4 + Math.random() * 0.5, color, size: size * (0.6 + Math.random() * 0.8), grav });
    }
    if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);
  }

  // ------------------------------------------------------------- frame
  frame(g: GameClient, dt: number) {
    this.t += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const world = g.world;
    if (!world) { this.drawIdleBackground(); return; }
    this.updateCamera(g, dt);
    const map = world.map;
    this.drawBackground(map);
    ctx.save();
    ctx.translate(this.vw / 2, this.vh / 2);
    ctx.scale(this.cam.zoom, this.cam.zoom);
    ctx.translate(-this.cam.x, -this.cam.y);
    this.drawTerrain(world);
    if (hasScenery(map)) drawAmbient(this.ctx, map, this.view());
    this.drawZones(world, g);
    const sim = g.rehearsal?.sim ?? g.race;
    this.drawObjects(world, sim, g);
    if (g.phase === 'build' && !g.rehearsal) this.drawBuildOverlay(g, world);
    if (sim) this.drawRace(g, sim);
    this.drawParticles(dt);
    if (settings.devOverlay) this.drawDev(g, world, sim);
    ctx.restore();
    if (sim) this.drawOffscreenCoins(g, sim);
  }

  private drawIdleBackground() {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.vh);
    g.addColorStop(0, '#2b2d6e'); g.addColorStop(1, '#f08a6c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.vw, this.vh);
    // slow drifting skyline for the menus
    ctx.fillStyle = 'rgba(40,30,90,.7)';
    const off = (this.t * 12) % 120;
    for (let i = -1; i < this.vw / 60 + 2; i++) {
      const h = 80 + ((i * 37) % 7) * 22;
      ctx.fillRect(i * 60 - off, this.vh - h, 52, h);
    }
  }

  private updateCamera(g: GameClient, dt: number) {
    const w = g.world!;
    const mw = w.w * C, mh = w.h * C;
    const cam = this.cam;
    const sim = g.rehearsal?.sim ?? g.race;
    let tx = mw / 2, ty = mh / 2, tz: number;
    const overview = (g.phase === 'build' && !g.rehearsal) || g.phase === 'draft' || g.phase === 'lobby' || g.phase === 'results' || g.phase === 'matchEnd';
    // keep the course clear of the HUD row and the build bar
    const top = overview ? this.insetTop : 0, bottom = overview ? this.insetBottom : 0;
    const fit = Math.min(this.vw / mw, Math.max(80, this.vh - top - bottom) / mh) * 0.96;
    if (overview) {
      tz = fit * this.buildZoom;
      if (this.buildZoom > 1) { const c = g.cursor; tx = c.x * C + C / 2; ty = c.y * C + C / 2; }
      ty += (bottom - top) / 2 / tz;
    } else {
      tz = Math.max(fit, Math.min(1.6, this.vw / (C * (this.vw < 900 ? 17 : 24)))); // phones see fewer, larger cells
      let body: { x: number; y: number; vx: number } | null = null;
      if (g.rehearsal) body = g.rehearsal.sim.players[0].body;
      else if (g.pred) body = { x: g.pred.x + g.corr.x, y: g.pred.y + g.corr.y, vx: g.pred.vx };
      else if (sim) {
        const id = g.spectateTarget();
        const rp = id ? g.remotePos(id) : null;
        if (rp) body = rp;
        else { const f = w.finishPx; tx = f.x + f.w / 2; ty = f.y; }
      }
      if (!body && g.phase === 'countdown' && sim) { const p = sim.player(g.you) ?? sim.players[0]; body = p ? p.body : null; }
      // look ahead in the direction of travel so long jumps on the big maps are never blind
      if (body) { tx = body.x + BW / 2 + Math.max(-140, Math.min(140, body.vx * 0.42)); ty = body.y + BH / 2 - 30; }
    }
    const halfW = this.vw / 2 / tz, halfH = this.vh / 2 / tz;
    tx = mw <= halfW * 2 ? mw / 2 : Math.max(halfW, Math.min(mw - halfW, tx));
    const shift = (bottom - top) / 2 / tz;
    ty = mh + Math.abs(shift) * 2 <= halfH * 2 ? mh / 2 + shift : Math.max(halfH - top / tz, Math.min(mh - halfH + bottom / tz, ty));
    const k = settings.reducedMotion ? 1 - Math.pow(0.0005, dt) : 1 - Math.pow(0.002, dt);
    if (Math.abs(cam.zoom - tz) > 0.5 || cam.x === 0) { cam.x = tx; cam.y = ty; cam.zoom = tz; }
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; cam.zoom += (tz - cam.zoom) * Math.min(1, k * 1.5);
  }

  // ------------------------------------------------------------- background
  view(): ViewInfo { return { camX: this.cam.x, camY: this.cam.y, zoom: this.cam.zoom, vw: this.vw, vh: this.vh, t: this.t, reduced: settings.reducedMotion, budget: this.particleBudget() }; }

  private drawBackground(map: MapDef) {
    if (hasScenery(map)) { drawSceneryBackground(this.ctx, map, this.view()); return; }
    const ctx = this.ctx, th = map.theme;
    const g = ctx.createLinearGradient(0, 0, 0, this.vh);
    g.addColorStop(0, th.skyTop); g.addColorStop(1, th.skyBottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.vw, this.vh);
    const par = (f: number) => ({ ox: -(this.cam.x * f) % 4000, oy: -(this.cam.y - map.h * C / 2) * f * 0.3 });
    // far layer silhouettes, themed
    for (const [layer, color, f] of [[0, th.far, 0.15], [1, th.mid, 0.3]] as [number, string, number][]) {
      const p = par(f);
      ctx.fillStyle = color;
      const baseY = this.vh * (layer === 0 ? 0.58 : 0.72) + p.oy;
      ctx.beginPath();
      ctx.moveTo(0, this.vh);
      for (let x = -200; x <= this.vw + 200; x += 20) {
        const wx = x - p.ox;
        let h: number;
        switch (map.id) {
          case 'rooftop': h = (Math.floor(wx / 90) * 7919) % 5 * 26 + 40; break;
          case 'factory': h = (Math.floor(wx / 140) % 3 === 0 ? 120 : 50) + ((Math.floor(wx / 70) * 31) % 3) * 12; break;
          case 'forest': h = 60 + Math.sin(wx / 90) * 30 + Math.sin(wx / 37) * 12; break;
          default: h = 90 + Math.abs(((wx / 160) % 2) - 1) * 140 * (layer === 0 ? 1.3 : 0.7); break;
        }
        ctx.lineTo(x, baseY - h * (layer === 0 ? 1.2 : 0.8));
      }
      ctx.lineTo(this.vw, this.vh);
      ctx.closePath();
      ctx.fill();
      // lit windows inside the mid-layer buildings
      if (layer === 1 && map.id === 'rooftop') {
        ctx.fillStyle = 'rgba(255,214,120,.28)';
        for (let x = -200; x < this.vw + 200; x += 20) {
          const wx = x - p.ox;
          const bh = ((Math.floor(wx / 90) * 7919) % 5 * 26 + 40) * 0.8;
          const col = Math.floor(wx / 20);
          if (col % 2 !== 0 || ((col * 31) % 5) === 0) continue;
          for (let wy = baseY - bh + 14; wy < this.vh - 10; wy += 22) if (((col * 7 + Math.floor(wy / 22) * 3) % 4) !== 0) ctx.fillRect(x + 4, wy, 7, 10);
        }
      }
    }
    if (map.id === 'frost') {
      ctx.fillStyle = 'rgba(160,255,220,.12)';
      ctx.beginPath(); ctx.ellipse(this.vw * 0.5 + Math.sin(this.t * 0.2) * 40, this.vh * 0.12, this.vw * 0.6, 40, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      for (let i = 0; i < 40 * this.particleBudget(); i++) { const x = (i * 97 + this.t * 20 * (1 + (i % 3))) % this.vw; const y = (i * 53 + this.t * 40 * (1 + (i % 2))) % this.vh; ctx.fillRect(x, y, 2, 2); }
    }
    if (map.id === 'forest') { ctx.fillStyle = 'rgba(255,240,180,.85)'; ctx.beginPath(); ctx.arc(this.vw * 0.78, this.vh * 0.14, 28, 0, Math.PI * 2); ctx.fill(); }
    if (map.id === 'factory') {
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      for (let i = 0; i < 6; i++) { const x = ((i * 220 - this.cam.x * 0.2) % (this.vw + 300)) - 100; ctx.beginPath(); ctx.arc(x, this.vh * 0.2 - ((this.t * 15 + i * 30) % 120), 30 + i * 4, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  // ------------------------------------------------------------- terrain (cached per world version)
  private drawTerrain(world: World) {
    const key = `${world.map.id}`;
    if (!this.terrainCache || this.terrainCache.key !== key) this.terrainCache = { key, canvas: this.renderTerrain(world) };
    // blit only the visible part: the large maps' terrain canvas is several thousand pixels wide
    const cv = this.terrainCache.canvas, z = this.cam.zoom;
    const x0 = Math.max(0, Math.floor(this.cam.x - this.vw / 2 / z) - 2), y0 = Math.max(0, Math.floor(this.cam.y - this.vh / 2 / z) - 2);
    const x1 = Math.min(cv.width, Math.ceil(this.cam.x + this.vw / 2 / z) + 2), y1 = Math.min(cv.height, Math.ceil(this.cam.y + this.vh / 2 / z) + 2);
    if (x1 > x0 && y1 > y0) this.ctx.drawImage(cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }

  private renderTerrain(world: World): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = world.w * C; cv.height = world.h * C;
    const ctx = cv.getContext('2d')!;
    if (hasScenery(world.map)) { paintSceneryTerrain(ctx, world); return cv; }
    const th = world.map.theme;
    const solid = (x: number, y: number) => { const t = world.terrainAt(x, y); return t === 1 || t === 2; };
    for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) {
      const t = world.terrainAt(x, y);
      if (!t) continue;
      const px = x * C, py = y * C;
      if (t === 3) {
        ctx.fillStyle = th.oneway; ctx.fillRect(px, py, C, 12);
        ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(px, py + 10, C, 2);
        ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.moveTo(px + 6, py + 12); ctx.lineTo(px + 12, py + 22); ctx.moveTo(px + C - 6, py + 12); ctx.lineTo(px + C - 12, py + 22); ctx.stroke();
        continue;
      }
      const isIce = t === 2;
      ctx.fillStyle = isIce ? th.ice ?? '#7fd8ff' : th.terrain;
      ctx.fillRect(px, py, C, C);
      // texture
      ctx.fillStyle = 'rgba(0,0,0,.08)';
      if ((x + y) % 2 === 0) ctx.fillRect(px, py, C, C);
      if (world.map.id === 'rooftop' && !isIce) { ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, C / 2, C / 3); ctx.strokeRect(px + C / 2 + 0.5, py + C / 3 + 0.5, C / 2 - 1, C / 3); }
      if (world.map.id === 'factory') { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(px + 4, py + 4, 4, 4); ctx.fillRect(px + C - 8, py + C - 8, 4, 4); }
      if (isIce) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(px + 6, py + 8, 14, 3); ctx.fillRect(px + 24, py + 20, 10, 3); }
      // top edge
      if (!solid(x, y - 1)) {
        ctx.fillStyle = isIce ? '#e6fbff' : th.terrainEdge;
        ctx.fillRect(px, py, C, 8);
        if (world.map.id === 'forest') { ctx.fillStyle = '#5aa83f'; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(px + 6 + i * 12, py + 8, 5, 0, Math.PI); ctx.fill(); } }
        if (world.map.id === 'frost' && !isIce) { ctx.fillStyle = '#fff'; ctx.fillRect(px, py, C, 6); ctx.beginPath(); ctx.arc(px + 14, py + 6, 5, 0, Math.PI); ctx.arc(px + 36, py + 6, 4, 0, Math.PI); ctx.fill(); }
      }
      if (!solid(x, y + 1)) { ctx.fillStyle = th.terrainDark; ctx.fillRect(px, py + C - 5, C, 5); }
      if (!solid(x - 1, y)) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(px, py, 4, C); }
      if (!solid(x + 1, y)) { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(px + C - 4, py, 4, C); }
    }
    return cv;
  }

  // ------------------------------------------------------------- start / finish
  private drawZones(world: World, g: GameClient) {
    const ctx = this.ctx;
    const s = world.spawnPx, f = world.finishPx;
    ctx.save();
    ctx.fillStyle = 'rgba(80,255,180,.10)'; ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = 'rgba(80,255,180,.6)'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeRect(s.x, s.y, s.w, s.h); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('START', s.x + s.w / 2, s.y + 16);
    // flag
    const fx = f.x + f.w / 2, fy = f.y + f.h;
    ctx.fillStyle = 'rgba(255,210,94,.12)'; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.strokeStyle = '#e8e8f0'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, f.y - 20); ctx.stroke();
    const wave = settings.reducedMotion ? 0 : Math.sin(this.t * 5) * 5;
    ctx.fillStyle = '#ff5e8a';
    ctx.beginPath(); ctx.moveTo(fx, f.y - 20); ctx.quadraticCurveTo(fx + 25, f.y - 26 + wave, fx + 46, f.y - 14 + wave); ctx.quadraticCurveTo(fx + 25, f.y - 6 + wave, fx, f.y + 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('FINISH', fx, f.y + f.h - 6);
    if (g.phase === 'build' || g.phase === 'draft') {
      // protected zones while building
      for (const z of world.protectedPx) {
        ctx.save(); ctx.beginPath(); ctx.rect(z.x, z.y, z.w, z.h); ctx.clip();
        ctx.strokeStyle = 'rgba(80,255,180,.22)'; ctx.lineWidth = 3;
        for (let i = -z.h; i < z.w; i += 18) { ctx.beginPath(); ctx.moveTo(z.x + i, z.y + z.h); ctx.lineTo(z.x + i + z.h, z.y); ctx.stroke(); }
        ctx.restore();
        ctx.strokeStyle = 'rgba(80,255,180,.55)'; ctx.strokeRect(z.x, z.y, z.w, z.h);
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------- objects and hazards
  ownerColor(g: GameClient, owner: string | null): string {
    if (!owner) return '#9aa0ad';
    const m = g.member(owner);
    return m ? PLAYER_COLORS[m.color % PLAYER_COLORS.length] : '#ffffff';
  }

  private drawObjects(world: World, sim: RaceSim | null, g: GameClient) {
    const ctx = this.ctx;
    const t = this.t;
    const hzByObj = new Map<string, number>();
    if (sim) sim.hz.forEach(h => hzByObj.set(h.o.id, h.phase));
    const broken = new Set<string>();
    if (sim) for (const c of sim.crumbles.values()) if (c.broken) broken.add(c.o.id);
    const usedPick = new Set<string>();
    if (sim) for (const p of sim.pickups) if (!p.available) usedPick.add(p.id);
    const coinAtOrigin = new Set<string>();
    if (sim) for (const c of sim.coins) if (c.state === 'origin') coinAtOrigin.add(c.id);
    const demo = g.phase === 'build' && g.myItem() && getItem(g.myItem()!).kind === 'bomb';
    const targets = new Set([...(g.check?.targets ?? []), ...(g.check?.dependents ?? [])]);
    for (const o of world.objects.values()) {
      const def = getItem(o.item);
      const phase = hzByObj.get(o.id) ?? (sim ? 0 : t);
      const col = this.ownerColor(g, o.owner);
      if (def.kind === 'coin' && sim && !coinAtOrigin.has(o.id)) {
        // origin slot shows a faint marker when the coin is away
        ctx.save(); ctx.globalAlpha = 0.25; drawCoinShape(ctx, o.x * C + C / 2, o.y * C + C / 2, 9, 0); ctx.restore();
        continue;
      }
      if (isKinematic(o)) {
        // bomb aiming freezes every moving platform at its GO pose, the pose bombs target
        const frozen = demo;
        const tick = frozen ? 0 : g.renderTick();
        if (g.phase === 'build' || g.phase === 'draft') this.drawLane(o, targets.has(o.id) || g.check?.reserved === o.id ? 'rgba(255,90,60,' : 'rgba(127,240,224,');
        this.drawKinematic(o, tick, col, false);
        if (demo && targets.has(o.id)) {
          ctx.save(); ctx.strokeStyle = '#ff5a2a'; ctx.lineWidth = 4; ctx.fillStyle = 'rgba(255,90,40,.3)';
          for (const r of referenceRects(o)) { ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4); }
          if (getItem(o.item).kind === 'wheel') { const p = pivotPx(o); ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, Math.PI * 2); ctx.stroke(); }
          ctx.restore();
        }
        continue;
      }
      if (def.kind === 'moving') {
        const len = sim ? sim.movers.find(m => m.o.id === o.id)?.hz?.pathLen ?? 0 : moverPathLen(world, o);
        const r = moverRect(o, phase, len);
        if (!sim || g.phase === 'build') this.drawMoverPath(o, len);
        const dx = r.x - o.cells[0][0] * C, dy = r.y - o.cells[0][1] * C;
        const minX = Math.min(...o.cells.map(c => c[0])), minY = Math.min(...o.cells.map(c => c[1]));
        drawItem(ctx, def, o.cells.map(([x, y]) => [x - minX, y - minY]), minX * C + dx + (o.cells[0][0] - minX) * 0, minY * C + dy - (o.cells[0][1] - minY) * 0, o.rot, { owner: col, t });
        continue;
      }
      if (def.kind === 'crumble' && broken.has(o.id)) {
        ctx.save(); ctx.globalAlpha = 0.2; drawItem(ctx, def, o.cells, 0, 0, o.rot, { owner: col, t }); ctx.restore();
        continue;
      }
      let state: string | undefined;
      if (def.kind === 'rspikes') state = rspikeState(phase);
      if (def.kind === 'laser') state = laserState(phase);
      if (def.kind === 'sniper' && sim) { const since = (sim.tick / TICK_HZ) % HAZARD.sniperInterval; state = since > HAZARD.sniperInterval - HAZARD.sniperWarn ? 'warn' : undefined; }
      if (def.kind === 'power' && usedPick.has(o.id)) state = 'used';
      drawItem(ctx, def, o.cells, 0, 0, o.rot, { owner: col, t, state, variant: o.variant, mapProv: o.prov === 'map' });
      // dynamic parts
      if (def.kind === 'saw') {
        const p = sawPos(o, phase);
        this.drawSaw(p.x, p.y, t);
      }
      if (def.kind === 'pendulum') {
        const p = pendulumPos(o, phase);
        this.drawPendulum(p.pivot, p.ball, p.angle, o.rot);
      }
      if (def.kind === 'laser') {
        const n = sim ? sim.hz.find(h => h.o.id === o.id)?.beam ?? 0 : laserCells(world, o);
        const r = laserBeamRect(o, n);
        if (r) {
          if (state === 'on') { ctx.fillStyle = 'rgba(255,60,110,.9)'; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.fillStyle = 'rgba(255,220,230,.9)'; ctx.fillRect(r.x + (r.w > r.h ? 0 : r.w / 2 - 1.5), r.y + (r.w > r.h ? r.h / 2 - 1.5 : 0), r.w > r.h ? r.w : 3, r.w > r.h ? 3 : r.h); }
          else if (state === 'warn') { ctx.fillStyle = Math.floor(t * 16) % 2 ? 'rgba(255,170,60,.5)' : 'rgba(255,170,60,.15)'; ctx.fillRect(r.x, r.y + (r.w > r.h ? r.h / 2 - 1 : 0), r.w > r.h ? r.w : 2, r.w > r.h ? 2 : r.h); }
          else { ctx.strokeStyle = 'rgba(255,90,140,.15)'; ctx.setLineDash([4, 8]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]); }
        }
      }
      if (demo && (targets.has(o.id))) {
        ctx.save(); ctx.fillStyle = 'rgba(255,90,40,.38)';
        for (const [x, y] of o.cells) ctx.fillRect(x * C, y * C, C, C);
        ctx.strokeStyle = '#ff5a2a'; ctx.lineWidth = 3; for (const [x, y] of o.cells) ctx.strokeRect(x * C + 2, y * C + 2, C - 4, C - 4);
        ctx.restore();
      }
      if (demo && o.prov === 'map') {
        ctx.save(); ctx.strokeStyle = 'rgba(200,200,220,.8)'; ctx.setLineDash([3, 3]); for (const [x, y] of o.cells) ctx.strokeRect(x * C + 4, y * C + 4, C - 8, C - 8); ctx.restore();
      }
    }
  }

  /** A moving platform's reserved lane and rider headroom (shown only while drafting and building). */
  private drawLane(o: PlacedObject, color: string, cells?: { sweep: [number, number][]; headroom: [number, number][] }) {
    const ctx = this.ctx;
    const sw = cells ?? sweepOf(o);
    ctx.save();
    ctx.fillStyle = color + '.10)';
    for (const [x, y] of sw.sweep) ctx.fillRect(x * C, y * C, C, C);
    ctx.strokeStyle = color + '.35)'; ctx.lineWidth = 1;
    for (const [x, y] of sw.sweep) ctx.strokeRect(x * C + 0.5, y * C + 0.5, C - 1, C - 1);
    ctx.setLineDash([2, 5]); ctx.strokeStyle = color + '.3)';
    for (const [x, y] of sw.headroom) ctx.strokeRect(x * C + 4, y * C + 4, C - 8, C - 8);
    ctx.restore();
  }

  /** Draw a shuttle or wheel at a (possibly fractional) tick. */
  private drawKinematic(o: PlacedObject, tick: number, owner: string, ghost: boolean) {
    const kind = getItem(o.item).kind;
    if (kind === 'shuttle') {
      const r = childRect(o, 0, tick), r2 = childRect(o, 0, tick + 1);
      const d = shuttleDir(o);
      const moving = Math.sign((r2.x - r.x) * d.x + (r2.y - r.y) * d.y) || 1;
      drawShuttleBody(this.ctx, r, { x: d.x * moving, y: d.y * moving }, owner, this.t, ghost);
      return;
    }
    const p = pivotPx(o);
    const rects = Array.from({ length: childCount(o) }, (_, i) => childRect(o, i, tick));
    drawWheelHub(this.ctx, p.x, p.y, rects.map(r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })), owner, wheelAngle(o, 0, tick), ghost);
    rects.forEach((r, i) => drawGondola(this.ctx, r, owner, i, ghost));
  }

  private drawMoverPath(o: PlacedObject, len: number) {
    const ctx = this.ctx;
    const t = DIRS[rotDirIndex(1, o.rot)];
    const minX = Math.min(...o.cells.map(c => c[0])), minY = Math.min(...o.cells.map(c => c[1]));
    const maxX = Math.max(...o.cells.map(c => c[0])), maxY = Math.max(...o.cells.map(c => c[1]));
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
    ctx.strokeRect(minX * C + t.x * len, minY * C + t.y * len, (maxX - minX + 1) * C, (maxY - minY + 1) * C);
    ctx.restore();
  }

  private drawSaw(x: number, y: number, t: number) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y); ctx.rotate(t * 14);
    ctx.fillStyle = '#d7dbe6'; ctx.strokeStyle = '#59607a'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; const r = i % 2 ? HAZARD.sawR - 5 : HAZARD.sawR; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#59607a'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  private drawPendulum(pivot: { x: number; y: number }, ball: { x: number; y: number }, angle: number, rot: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#6b6f80'; ctx.lineWidth = 4; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(pivot.x, pivot.y); ctx.lineTo(ball.x, ball.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.translate(ball.x, ball.y);
    ctx.rotate(angle + (rotDirIndex(2, rot) - 2) * (Math.PI / 2));
    ctx.fillStyle = '#c4cad8'; ctx.strokeStyle = '#4b5068'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-HAZARD.pendulumBallR - 4, -4); ctx.quadraticCurveTo(0, HAZARD.pendulumBallR + 10, HAZARD.pendulumBallR + 4, -4); ctx.lineTo(0, -10); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4b5068'; ctx.beginPath(); ctx.arc(0, -6, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------- build overlay
  private drawBuildOverlay(g: GameClient, world: World) {
    const ctx = this.ctx;
    const b = world.map.build;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = b.x; x <= b.x + b.w; x++) { ctx.moveTo(x * C, b.y * C); ctx.lineTo(x * C, (b.y + b.h) * C); }
    for (let y = b.y; y <= b.y + b.h; y++) { ctx.moveTo(b.x * C, y * C); ctx.lineTo((b.x + b.w) * C, y * C); }
    ctx.stroke();
    ctx.restore();
    const item = g.myItem();
    if (!item || g.placedThisRound) return;
    const def = getItem(item);
    const chk = g.check;
    const r = g.request()!;
    const ok = !!chk?.ok;
    const col = ok ? 'rgba(80,240,140,' : 'rgba(255,80,90,';
    let cells = chk?.cells ?? [];
    if (!cells.length) cells = footprint(world, def, r.x, r.y, r.rot as Rot).cells;
    if (!cells.length) cells = [[r.x, r.y]];
    // footprint cells
    ctx.save();
    ctx.fillStyle = col + '.22)'; ctx.strokeStyle = col + '.95)'; ctx.lineWidth = 3;
    for (const [x, y] of cells) { ctx.fillRect(x * C, y * C, C, C); ctx.strokeRect(x * C + 1.5, y * C + 1.5, C - 3, C - 3); }
    // trimmed wire segments
    if (def.kind === 'wire') {
      const want = def.wireLength ?? 1;
      const t = DIRS[rotDirIndex(1, r.rot)];
      ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(255,120,120,.7)';
      for (let i = cells.length; i < want; i++) ctx.strokeRect((r.x + t.x * i) * C + 6, (r.y + t.y * i) * C + 6, C - 12, C - 12);
      ctx.setLineDash([]);
    }
    ctx.restore();
    // ghost art
    if (def.kind !== 'bomb') {
      if (def.kind === 'sniper' || def.kind === 'cannon' || def.kind === 'crossbow' || def.kind === 'dart') this.drawAim(world, def.kind, r, cells);
      if (def.kind === 'blackhole') { /* drawn by item art with radius */ }
      if (def.kind === 'pendulum') {
        const o = { id: '_', item, owner: null, prov: 'player' as const, x: r.x, y: r.y, rot: r.rot as Rot, variant: 0, cells, attach: null, round: 0 };
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([4, 6]); ctx.beginPath();
        pendulumSweep(o).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); ctx.restore();
      }
      if (def.kind === 'laser') {
        const o = { id: '_', item, owner: null, prov: 'player' as const, x: r.x, y: r.y, rot: r.rot as Rot, variant: 0, cells, attach: null, round: 0 };
        const rr = laserBeamRect(o, laserCells(world, o));
        if (rr) { ctx.fillStyle = 'rgba(255,60,110,.35)'; ctx.fillRect(rr.x, rr.y, rr.w, rr.h); }
      }
      if (def.kind === 'moving') {
        const o = { id: '_', item, owner: null, prov: 'player' as const, x: r.x, y: r.y, rot: r.rot as Rot, variant: 0, cells, attach: null, round: 0 };
        this.drawMoverPath(o, moverPathLen(world, o));
      }
      if (def.kind === 'shuttle' || def.kind === 'wheel') { this.drawMoverPreview(world, def.kind, r, cells, ok); }
      else drawItem(ctx, def, cells, 0, 0, r.rot as Rot, { ghost: true, owner: '#ffd25e', t: this.t, variant: r.variant, state: 'out' });
    } else {
      const n = def.bombSize ?? 1;
      drawItem(ctx, def, [], r.x * C, r.y * C, 0, { ghost: false, t: this.t });
      void n;
    }
    // reason label
    if (chk && !chk.ok && chk.reason) {
      const [x, y] = cells[0];
      ctx.save();
      ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'left';
      const text = chk.reason;
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = 'rgba(40,10,20,.85)'; ctx.fillRect(x * C, y * C - 30, w, 24);
      ctx.fillStyle = '#ffc1c9'; ctx.fillText(text, x * C + 8, y * C - 13);
      ctx.restore();
    }
  }

  /**
   * Moving platform preview: the whole swept lane and rider headroom it will reserve, the GO pose solid, a ghost moving
   * along the real path, the direction of travel and the timing. Validity never depends on the animation.
   */
  private drawMoverPreview(world: World, kind: 'shuttle' | 'wheel', r: { item: string; x: number; y: number; rot: number; variant: number }, cells: [number, number][], ok: boolean) {
    const ctx = this.ctx;
    const o: PlacedObject = { id: '_', item: r.item, owner: null, prov: 'player', x: r.x, y: r.y, rot: r.rot as Rot, variant: r.variant, cells, attach: null, round: 0, mv: newMotion(r.item, r.variant) };
    this.drawLane(o, ok ? 'rgba(80,240,140,' : 'rgba(255,80,90,');
    const m = o.mv!;
    const tick = ((performance.now() / 1000) * 60) % m.period;
    this.drawKinematic(o, tick, '#ffd25e', true);
    this.drawKinematic(o, 0, ok ? '#50f08c' : '#ff505a', false);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
    let label: string;
    if (kind === 'shuttle') {
      const a = childRect(o, 0, 0), b = childRect(o, 0, m.period / 2), d = shuttleDir(o);
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(bx + d.x * 10, by + d.y * 10); ctx.lineTo(bx - d.y * 8 - d.x * 4, by + d.x * 8 - d.y * 4); ctx.lineTo(bx + d.y * 8 - d.x * 4, by - d.x * 8 - d.y * 4); ctx.fill();
      label = `${m.travel} cells out and back every ${(m.period / 60).toFixed(1)}s`;
    } else {
      const p = pivotPx(o), R = m.radius!;
      ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      // direction arrow on the orbit, just ahead of gondola 1's starting point
      const a0 = wheelAngle(o, 0, 0) + (m.dir ?? 1) * 0.5;
      const ax = p.x + Math.cos(a0) * R, ay = p.y + Math.sin(a0) * R, tx = -Math.sin(a0) * (m.dir ?? 1), ty = Math.cos(a0) * (m.dir ?? 1);
      ctx.beginPath(); ctx.moveTo(ax + tx * 12, ay + ty * 12); ctx.lineTo(ax - ty * 8 - tx * 4, ay + tx * 8 - ty * 4); ctx.lineTo(ax + ty * 8 - tx * 4, ay - tx * 8 - ty * 4); ctx.fill();
      label = `${m.dir === -1 ? 'Counter-clockwise' : 'Clockwise'}, one lap every ${(m.period / 60).toFixed(0)}s · centre is open`;
    }
    ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
    const bb = sweepOf(o).bbox;
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = 'rgba(10,14,30,.8)'; ctx.fillRect(bb.x, bb.y + bb.h + 4, w, 22);
    ctx.fillStyle = '#dff'; ctx.fillText(label, bb.x + 7, bb.y + bb.h + 20);
    ctx.restore();
    void world;
  }

  private drawAim(world: World, kind: string, r: { x: number; y: number; rot: number; variant: number; item: string }, cells: [number, number][]) {
    const ctx = this.ctx;
    const o: PlacedObject = { id: '_', item: r.item, owner: null, prov: 'player', x: r.x, y: r.y, rot: r.rot as Rot, variant: r.variant, cells, attach: null, round: 0 };
    const m = muzzle(o), d = launcherDir(o);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,220,120,.6)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(m.x, m.y);
    if (kind === 'cannon') {
      // predicted arc against current geometry (does not predict players)
      let x = m.x, y = m.y, vx = d.x * HAZARD.cannonMuzzleSpeed, vy = d.y * HAZARD.cannonMuzzleSpeed;
      for (let i = 0; i < 240; i++) {
        vy += HAZARD.cannonGravity / 60; x += vx / 60; y += vy / 60;
        ctx.lineTo(x, y);
        if (world.solidCell(Math.floor(x / C), Math.floor(y / C)) || world.inProtectedPx(x, y) || y > world.h * C) break;
      }
    } else {
      let x = m.x, y = m.y;
      for (let i = 0; i < 400; i++) {
        x += d.x * 8; y += d.y * 8;
        if (world.solidCell(Math.floor(x / C), Math.floor(y / C)) || world.inProtectedPx(x, y) || x < 0 || x > world.w * C) break;
      }
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------- race layer
  private drawRace(g: GameClient, sim: RaceSim) {
    const ctx = this.ctx;
    const t = this.t;
    // coins in the world
    for (const c of sim.coins) {
      if (c.state === 'dropped') drawCoinShape(ctx, c.x, c.y + Math.sin(t * 4) * 2, 12, t);
      if (c.state === 'lost') { ctx.save(); ctx.globalAlpha = 0.35; drawCoinShape(ctx, c.x, c.y, 10, 0); ctx.restore(); }
    }
    // projectiles (extrapolated from the last snapshot)
    const since = g.rehearsal ? 0 : Math.min(0.12, (performance.now() - g.lastSnapAt) / 1000);
    for (const p of sim.projectiles) {
      const x = p.x + p.vx * since, y = p.y + p.vy * since + (p.kind === 'cannon' ? 0.5 * HAZARD.cannonGravity * since * since : 0);
      const ang = Math.atan2(p.vy, p.vx);
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      if (p.kind === 'sniper') { const gr = ctx.createLinearGradient(-60, 0, 6, 0); gr.addColorStop(0, 'rgba(255,240,150,0)'); gr.addColorStop(1, 'rgba(255,250,200,1)'); ctx.fillStyle = gr; ctx.fillRect(-60, -2, 66, 4); }
      else if (p.kind === 'arrow') { ctx.strokeStyle = '#6b4424'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(8, 0); ctx.stroke(); ctx.fillStyle = '#ccd'; ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(5, -4); ctx.lineTo(5, 4); ctx.fill(); ctx.fillStyle = '#ff5e8a'; ctx.fillRect(-20, -3, 5, 6); }
      else if (p.kind === 'dart') { ctx.fillStyle = '#c9d19c'; ctx.fillRect(-10, -2, 16, 4); ctx.fillStyle = '#7aa04a'; ctx.fillRect(-12, -3, 4, 6); }
      else { ctx.fillStyle = '#20202c'; ctx.beginPath(); ctx.arc(0, 0, HAZARD.cannonBallR, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(-4, -4, 4, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    // players: remote interpolated, local predicted
    for (const p of sim.players) {
      const m = g.member(p.id);
      const skin = m?.skin ?? 0;
      const color = PLAYER_COLORS[(m?.color ?? 0) % PLAYER_COLORS.length];
      let b: { x: number; y: number; vx: number; vy: number; g: boolean; ws: boolean; wd: number; f: number };
      const isLocal = p.id === g.you && !!g.pred && !g.rehearsal;
      if (g.rehearsal) { const bb = p.body; b = { x: bb.x, y: bb.y, vx: bb.vx, vy: bb.vy, g: bb.grounded, ws: bb.wallSliding, wd: bb.wallDir, f: bb.facing }; }
      else if (isLocal) { const bb = g.pred!; b = { x: bb.x + g.corr.x, y: bb.y + g.corr.y, vx: bb.vx, vy: bb.vy, g: bb.grounded, ws: bb.wallSliding, wd: bb.wallDir, f: bb.facing }; }
      else {
        const rp = g.remotePos(p.id);
        if (!rp) { const bb = p.body; b = { x: bb.x, y: bb.y, vx: bb.vx, vy: bb.vy, g: bb.grounded, ws: bb.wallSliding, wd: bb.wallDir, f: bb.facing }; }
        else b = { x: rp.x, y: rp.y, vx: rp.vx, vy: rp.vy, g: rp.snap.g === 1, ws: rp.snap.ws === 1, wd: rp.snap.wd, f: rp.snap.f };
      }
      if (p.status === 'dead') continue;
      const a = this.anim.get(p.id) ?? { land: 0, wj: 0, lastG: true };
      if (b.g && !a.lastG) { a.land = 0.12; this.burst(b.x + BW / 2, b.y + BH, 5, 'rgba(255,255,255,.7)', 70, 200, 2.5); }
      if (!b.g && a.lastG && b.vy < -100) this.burst(b.x + BW / 2, b.y + BH, 3, 'rgba(255,255,255,.5)', 50, 100, 2);
      a.lastG = b.g; a.land = Math.max(0, a.land - 1 / 60); a.wj = Math.max(0, a.wj - 1 / 60);
      this.anim.set(p.id, a);
      let state: AnimState = 'idle';
      if (p.status === 'finished') state = 'celebrate';
      else if (b.ws) state = 'wallslide';
      else if (!b.g) state = b.vy < 0 ? (Math.abs(b.vx) > 200 && a.wj > 0 ? 'walljump' : 'jump') : 'fall';
      else if (a.land > 0) state = 'land';
      else if (Math.abs(b.vx) > 260) state = 'sprint';
      else if (Math.abs(b.vx) > 20) state = 'run';
      if (b.ws && Math.random() < 0.3 * this.particleBudget()) this.burst(b.x + (b.wd > 0 ? BW : 0), b.y + BH - 6, 1, 'rgba(255,255,255,.6)', 30, -60, 2);
      const facing = b.ws ? -b.wd * -1 : b.f;
      ctx.save();
      if (p.effects.immune > 0 && Math.floor(t * 20) % 2) ctx.globalAlpha = 0.45;
      if (!p.connected) ctx.globalAlpha = 0.5;
      drawCharacter(ctx, skin, b.x, b.y, { state, t: t + p.id.length, facing: facing || 1, wallDir: b.wd }, color, p.coins.length || (sim.coins.filter(c => c.carrier === p.id && c.state === 'carried').length));
      ctx.restore();
      // effects
      if (p.effects.shield > 0) { ctx.save(); ctx.strokeStyle = 'rgba(122,168,255,.85)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(b.x + BW / 2, b.y + BH / 2, BW, BH * 0.75, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
      if (p.effects.speed > 0 && Math.random() < 0.5 * this.particleBudget()) this.burst(b.x + BW / 2, b.y + BH / 2, 1, '#3ee0c5', 40, 0, 2.5);
      if (p.effects.jump > 0 && Math.random() < 0.4 * this.particleBudget()) this.burst(b.x + BW / 2, b.y + BH, 1, '#7bea5c', 40, -100, 2.5);
      // label
      ctx.save();
      ctx.font = `bold ${p.id === g.you ? 14 : 12}px sans-serif`; ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,6,30,.85)'; ctx.fillStyle = color;
      const label = (m?.name ?? p.id) + (p.connected ? '' : ' (offline)');
      ctx.strokeText(label, b.x + BW / 2, b.y - 30); ctx.fillText(label, b.x + BW / 2, b.y - 30);
      ctx.restore();
      if (settings.devOverlay) { ctx.strokeStyle = '#0f0'; ctx.lineWidth = 1; ctx.strokeRect(b.x, b.y, BW, BH); }
    }
    if (sim.slowTicks > 0) {
      ctx.save(); ctx.fillStyle = 'rgba(176,122,255,.06)'; ctx.fillRect(0, 0, sim.world.w * C, sim.world.h * C); ctx.restore();
    }
  }

  private drawOffscreenCoins(g: GameClient, sim: RaceSim) {
    const ctx = this.ctx;
    for (const c of sim.coins) {
      if (c.state !== 'dropped' && c.state !== 'lost') continue;
      const sx = (c.x - this.cam.x) * this.cam.zoom + this.vw / 2, sy = (c.y - this.cam.y) * this.cam.zoom + this.vh / 2;
      if (sx > 0 && sy > 0 && sx < this.vw && sy < this.vh) continue;
      const x = Math.max(24, Math.min(this.vw - 24, sx)), y = Math.max(70, Math.min(this.vh - 24, sy));
      ctx.save();
      ctx.globalAlpha = c.state === 'lost' ? 0.5 : 0.95;
      drawCoinShape(ctx, x, y, 10, this.t);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(c.state === 'lost' ? 'LOST' : 'DROPPED', x, y + 22);
      ctx.restore();
    }
    void g;
  }

  private drawParticles(dt: number) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.life += dt; p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      const a = 1 - p.life / p.max;
      if (a <= 0) continue;
      ctx.globalAlpha = a; ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter(p => p.life < p.max);
  }

  // ------------------------------------------------------------- dev overlay (hidden in normal play)
  private drawDev(g: GameClient, world: World, sim: RaceSim | null) {
    const ctx = this.ctx;
    const key = `${world.map.id}:${world.version}`;
    if (!this.devNav || this.devNav.key !== key) { this.devNav = { key, nav: new NavGraph(world) }; this.devNav.nav.reach(true); }
    const nav = this.devNav.nav;
    ctx.save();
    ctx.fillStyle = 'rgba(0,255,120,.5)';
    const r = nav.reach(true);
    for (const k of r.visited) { const n = nav.node(k); ctx.fillRect(n.x + BW / 2 - 3, n.y + BH - 6, 6, 6); }
    ctx.strokeStyle = 'rgba(255,0,255,.6)';
    for (const o of world.objects.values()) for (const [x, y] of o.cells) ctx.strokeRect(x * C + 3, y * C + 3, C - 6, C - 6);
    if (sim) for (const h of sim.hz) { const c = cellCenter(h.o.x, h.o.y); ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.fillText(`${h.kind} ${h.phase.toFixed(2)}`, c.x - 20, c.y - 26); }
    ctx.restore();
    void g; void TERRAIN_ID;
  }

  /** Small map thumbnail for the lobby. */
  static mapThumb(canvas: HTMLCanvasElement, world: World) {
    const ctx = canvas.getContext('2d')!;
    const sx = canvas.width / world.w, sy = canvas.height / world.h;
    const th = world.map.theme;
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, th.skyTop); g.addColorStop(1, th.skyBottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) {
      const t = world.terrainAt(x, y);
      if (!t) continue;
      ctx.fillStyle = t === 2 ? th.ice ?? '#7fd8ff' : t === 3 ? th.oneway : th.terrain;
      ctx.fillRect(x * sx, y * sy + (t === 3 ? 0 : 0), Math.ceil(sx), t === 3 ? Math.ceil(sy / 3) : Math.ceil(sy));
    }
    ctx.fillStyle = '#ff5e8a'; const f = world.map.finish; ctx.fillRect(f.x * sx, f.y * sy, f.w * sx, f.h * sy);
    ctx.fillStyle = '#50ffb4'; const s = world.map.spawn; ctx.fillRect(s.x * sx, s.y * sy, s.w * sx, s.h * sy);
  }

  bodyAnimFor(b: Body) { return b; }
}
