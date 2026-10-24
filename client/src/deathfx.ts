// Death effects: one distinct animation per cause of death. Purely visual, driven by the server's death event (cause,
// position, source object), so every client plays the same effect at the same spot. Drawn in world space.
import { CELL, PHYS } from '../../shared/config';
import { drawCharacter } from './art';

const BW = PHYS.bodyW, BH = PHYS.bodyH;

export interface DeathFx {
  cause: string; x: number; y: number; t0: number; color: string; skin: number;
  /** unit direction the killing blow came from (projectiles, saws), or 0,0 */
  dx: number; dy: number;
  /** hole / gravestone / water surface reference point when relevant */
  rx?: number; ry?: number;
  seed: number;
}

/** How long each effect plays (s). */
export function fxDuration(cause: string): number {
  switch (cause) {
    case 'fall': case 'pull-fall': return 1.4;
    case 'ghost': return 1.6;
    case 'tsunami': case 'drown': return 1.5;
    default: return 1.2;
  }
}

/** Families of causes share one animation. */
export function fxKind(cause: string): string {
  switch (cause) {
    case 'crush': return 'crush';
    case 'sniper': case 'arrow': return 'shot';
    case 'dart': return 'dart';
    case 'cannon': return 'explode';
    case 'rspikes': return 'impale';
    case 'wire': return 'snag';
    case 'oval': return 'pop';
    case 'fall': case 'pull-fall': return 'void';
    case 'drown': return 'drown';
    case 'tsunami': return 'tsunami';
    case 'ghost': return 'ghost';
    case 'blackhole': return 'spaghetti';
    case 'laser': return 'zap';
    case 'saw': case 'pendulum': return 'slice';
    case 'lava': case 'geyser': return 'burn';
    default: return 'generic';
  }
}

const rnd = (seed: number, i: number) => { const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453; return v - Math.floor(v); };
const ease = (k: number) => 1 - Math.pow(1 - k, 3);

/** Draw one effect; returns false once finished. `now` in seconds (performance clock), `reduced` tones down motion. */
export function drawDeathFx(ctx: CanvasRenderingContext2D, f: DeathFx, now: number, reduced: boolean): boolean {
  const dur = fxDuration(f.cause);
  const age = now - f.t0;
  if (age > dur) return false;
  const k = age / dur, a = 1 - k;
  const { x, y } = f;
  ctx.save();
  switch (fxKind(f.cause)) {
    case 'crush': {
      // flattened pancake of the character with dust puffing out of both sides
      const flat = Math.min(1, age / 0.08);
      ctx.save();
      ctx.translate(x, y + BH / 2);
      ctx.scale(1 + flat * 0.9, Math.max(0.12, 1 - flat * 0.88));
      ctx.globalAlpha = a;
      drawCharacter(ctx, f.skin, -BW / 2, -BH, { state: 'idle', t: 0, facing: 1 }, f.color);
      ctx.restore();
      for (let i = 0; i < 10; i++) {
        const side = i % 2 ? 1 : -1, r = 4 + rnd(f.seed, i) * 6;
        const px = x + side * (14 + ease(k) * (30 + rnd(f.seed, i + 9) * 30)), py = y + BH / 2 - 4 - rnd(f.seed, i + 3) * 10 * k;
        ctx.fillStyle = `rgba(230,220,200,${0.7 * a})`; ctx.beginPath(); ctx.arc(px, py, r * (0.6 + k), 0, Math.PI * 2); ctx.fill();
      }
      // cartoon stars circling the flattened spot
      ctx.fillStyle = `rgba(255,230,90,${a})`;
      for (let i = 0; i < 3; i++) { const ang = age * 6 + (i * Math.PI * 2) / 3; star(ctx, x + Math.cos(ang) * 22, y + BH / 2 - 16 + Math.sin(ang) * 6, 5); }
      break;
    }
    case 'shot': case 'dart': {
      // knocked back along the shot: the character tumbles away and fades, with a spark streak where it was hit
      const dx = f.dx || 1, dy = f.dy;
      const dist = ease(k) * 70;
      ctx.save();
      ctx.translate(x + dx * dist, y + dy * dist - Math.sin(k * Math.PI) * 26 + k * k * 40);
      ctx.rotate(dx * k * 5);
      ctx.globalAlpha = a;
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'fall', t: age, facing: dx > 0 ? -1 : 1 }, f.color);
      ctx.restore();
      ctx.strokeStyle = fxKind(f.cause) === 'dart' ? `rgba(120,255,120,${a})` : `rgba(255,240,180,${a})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const ang = Math.atan2(dy, dx) + (rnd(f.seed, i) - 0.5) * 1.6, l = 10 + ease(k) * 26 * rnd(f.seed, i + 4);
        ctx.beginPath(); ctx.moveTo(x + Math.cos(ang) * l * 0.4, y + Math.sin(ang) * l * 0.4); ctx.lineTo(x + Math.cos(ang) * l, y + Math.sin(ang) * l); ctx.stroke();
      }
      if (fxKind(f.cause) === 'dart') {
        // a sickly green puff and a dart left quivering in the air where it struck
        for (let i = 0; i < 6; i++) { ctx.fillStyle = `rgba(110,230,90,${0.35 * a})`; ctx.beginPath(); ctx.arc(x + (rnd(f.seed, i) - 0.5) * 30, y - k * 30 - rnd(f.seed, i + 2) * 12, 6 + k * 10, 0, Math.PI * 2); ctx.fill(); }
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(dy, dx) + Math.sin(age * 40) * 0.1 * a); ctx.fillStyle = '#d8dee8'; ctx.fillRect(-14, -1.5, 14, 3); ctx.fillStyle = '#5ce05c'; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(-20, -5); ctx.lineTo(-20, 5); ctx.fill(); ctx.restore();
      }
      break;
    }
    case 'explode': {
      // fireball, shock ring, smoke and flying debris in the player's colour
      const r = ease(Math.min(1, k * 2.5)) * 52;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r + 1);
      g.addColorStop(0, `rgba(255,250,210,${a})`); g.addColorStop(0.4, `rgba(255,170,60,${a * 0.9})`); g.addColorStop(1, `rgba(200,40,20,0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r + 1, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * a})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 20 + ease(k) * 80, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i++) { ctx.fillStyle = `rgba(70,64,72,${0.45 * a})`; ctx.beginPath(); ctx.arc(x + (rnd(f.seed, i) - 0.5) * 50, y - k * 50 - rnd(f.seed, i + 5) * 20, 8 + k * 16, 0, Math.PI * 2); ctx.fill(); }
      for (let i = 0; i < 10; i++) {
        const ang = rnd(f.seed, i + 20) * Math.PI * 2, sp = 90 + rnd(f.seed, i + 30) * 140;
        ctx.fillStyle = i % 3 ? f.color : '#2b2b3d';
        ctx.fillRect(x + Math.cos(ang) * sp * age - 3, y + Math.sin(ang) * sp * age + 300 * age * age - 3, 6, 6);
      }
      break;
    }
    case 'impale': {
      // spikes thrust up through the spot, a red flash, the character pops up and drops away
      ctx.fillStyle = `rgba(255,40,60,${0.4 * a})`; ctx.fillRect(x - 30, y - 40, 60, 80);
      ctx.fillStyle = '#e8ecf4'; ctx.strokeStyle = '#4b5068'; ctx.lineWidth = 1.5;
      const h = Math.min(1, age / 0.06) * 34 * (1 - k * 0.5);
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(x + i * 10 - 5, y + BH / 2); ctx.lineTo(x + i * 10, y + BH / 2 - h - (i % 2 ? 0 : 8)); ctx.lineTo(x + i * 10 + 5, y + BH / 2); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      ctx.save(); ctx.translate(x, y - Math.sin(k * Math.PI) * 40 + k * 60); ctx.rotate(k * 3); ctx.globalAlpha = a;
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'fall', t: age, facing: 1 }, f.color); ctx.restore();
      break;
    }
    case 'snag': {
      // caught on the wire: crackling sparks, a zig-zag of wire and shreds of the character's colour fluttering down
      ctx.strokeStyle = `rgba(230,234,244,${a})`; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i <= 8; i++) { const px = x - 28 + i * 7, py = y + (i % 2 ? -8 : 8) * (1 - k); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.stroke();
      for (let i = 0; i < 12; i++) {
        const px = x + (rnd(f.seed, i) - 0.5) * 50 + Math.sin(age * 8 + i) * 6, py = y - 10 + age * (40 + rnd(f.seed, i + 3) * 50);
        ctx.save(); ctx.translate(px, py); ctx.rotate(age * 6 + i); ctx.fillStyle = f.color; ctx.globalAlpha = a; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
      }
      if (!reduced || k < 0.3) for (let i = 0; i < 6; i++) { if (rnd(f.seed + Math.floor(age * 20), i) > 0.5) continue; ctx.fillStyle = '#ffe36a'; ctx.fillRect(x + (rnd(f.seed, i + 40) - 0.5) * 40, y + (rnd(f.seed, i + 50) - 0.5) * 30, 3, 3); }
      break;
    }
    case 'pop': {
      // burst like a balloon on the spikes: a ring of spike shards and confetti
      ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(x, y, Math.min(1, age / 0.08) * 26 * a, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2, d = 10 + ease(k) * 60;
        ctx.save(); ctx.translate(x + Math.cos(ang) * d, y + Math.sin(ang) * d + 80 * k * k); ctx.rotate(ang); ctx.globalAlpha = a;
        ctx.fillStyle = i % 2 ? '#e4e8f2' : f.color; ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -3); ctx.lineTo(-4, 3); ctx.closePath(); ctx.fill(); ctx.restore();
      }
      break;
    }
    case 'void': {
      // falling into the void: a dark swirl opens where they dropped and the shrinking character spins down into it
      const vy = f.ry ?? y;
      ctx.save(); ctx.translate(x, vy);
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = `rgba(160,110,255,${(0.55 - i * 0.1) * a})`; ctx.lineWidth = 3; ctx.beginPath();
        for (let j = 0; j < 30; j++) { const ang = -age * 5 + i * 1.6 + j * 0.3, r = 40 - j * 1.2; const px = Math.cos(ang) * r, py = Math.sin(ang) * r * 0.4; if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
        ctx.stroke();
      }
      const s = Math.max(0.05, 1 - ease(k));
      ctx.rotate(age * 8); ctx.scale(s, s); ctx.globalAlpha = a;
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'fall', t: age, facing: 1 }, f.color);
      ctx.restore();
      break;
    }
    case 'drown': case 'tsunami': {
      // a splash and a column of rising bubbles; the tsunami version adds a curling crest of foam
      const sy = f.ry ?? y;
      ctx.strokeStyle = `rgba(220,245,255,${a})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(x, sy, 10 + ease(k) * 46, 4 + ease(k) * 8, 0, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 14; i++) {
        const bx = x + (rnd(f.seed, i) - 0.5) * 36 + Math.sin(age * 6 + i) * 4, by = y - age * (60 + rnd(f.seed, i + 7) * 80);
        if (by < sy - 6 && fxKind(f.cause) === 'drown') continue;
        ctx.strokeStyle = `rgba(230,250,255,${0.8 * a})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(bx, by, 2 + rnd(f.seed, i + 3) * 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (fxKind(f.cause) === 'tsunami') {
        ctx.fillStyle = `rgba(255,255,255,${0.7 * a})`;
        for (let i = 0; i < 9; i++) { const ang = -age * 4 + i * 0.7, r = 26 + i * 2; ctx.beginPath(); ctx.arc(x + Math.cos(ang) * r, y + Math.sin(ang) * r, 5 - i * 0.3, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.save(); ctx.translate(x + Math.sin(age * 3) * 6, y + age * 30); ctx.globalAlpha = a * 0.6; ctx.rotate(Math.sin(age * 2) * 0.4);
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'fall', t: age, facing: 1 }, f.color); ctx.restore();
      break;
    }
    case 'ghost': {
      // the soul leaves the body: a pale wisp of the character floats up while a purple flash fades
      ctx.fillStyle = `rgba(170,90,255,${0.35 * a})`; ctx.beginPath(); ctx.arc(x, y, 18 + k * 30, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(x + Math.sin(age * 4) * 8, y - ease(k) * 90); ctx.globalAlpha = 0.7 * a;
      ctx.filter = 'grayscale(1) brightness(1.8)';
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'idle', t: age, facing: 1 }, 'rgba(255,255,255,.6)');
      ctx.filter = 'none'; ctx.restore();
      ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y + BH / 2 - 6); ctx.rotate(Math.PI / 2); ctx.globalAlpha = a * 0.8;
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'idle', t: 0, facing: 1 }, f.color); ctx.restore();
      break;
    }
    case 'spaghetti': {
      // stretched thin and pulled into the hole's core
      const hx = f.rx ?? x, hy = f.ry ?? y;
      const px = x + (hx - x) * ease(k), py = y + (hy - y) * ease(k);
      ctx.save(); ctx.translate(px, py); ctx.rotate(Math.atan2(hy - y, hx - x) + Math.PI / 2 + age * 4); ctx.scale(Math.max(0.1, 1 - k), 1 + k * 2.5); ctx.globalAlpha = a;
      drawCharacter(ctx, f.skin, -BW / 2, -BH / 2, { state: 'fall', t: age, facing: 1 }, f.color); ctx.restore();
      break;
    }
    case 'zap': {
      // disintegrated by the beam: the silhouette breaks into glowing pixels that drift up
      for (let i = 0; i < 40; i++) {
        const px = x - BW / 2 + rnd(f.seed, i) * BW + (rnd(f.seed, i + 60) - 0.5) * 40 * k, py = y - BH / 2 + rnd(f.seed, i + 30) * BH - k * 50 * rnd(f.seed, i + 90);
        ctx.fillStyle = i % 4 ? f.color : '#ff5a8c'; ctx.globalAlpha = a * (rnd(f.seed, i + 120) > k ? 1 : 0.3); ctx.fillRect(px, py, 4, 4);
      }
      break;
    }
    case 'slice': {
      // cut in two: halves slide apart and fall
      const dx = f.dx || 1;
      for (const half of [-1, 1]) {
        ctx.save(); ctx.beginPath();
        if (half < 0) ctx.rect(x - 60, y - 120, 120, 120); else ctx.rect(x - 60, y, 120, 120);
        ctx.clip();
        ctx.translate(half * dx * ease(k) * 18, half * ease(k) * 10 + k * k * 60); ctx.globalAlpha = a;
        drawCharacter(ctx, f.skin, x - BW / 2, y - BH / 2, { state: 'idle', t: 0, facing: 1 }, f.color);
        ctx.restore();
      }
      ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 30, y); ctx.lineTo(x + 30, y); ctx.stroke();
      break;
    }
    case 'burn': {
      // charred to ash: flames lick up, then grey flakes drift away
      for (let i = 0; i < 12; i++) {
        const fx = x + (rnd(f.seed, i) - 0.5) * 34, fy = y + BH / 2 - age * (40 + rnd(f.seed, i + 5) * 60);
        ctx.fillStyle = k < 0.5 ? `rgba(255,${120 + i * 8},40,${a})` : `rgba(90,86,90,${a})`;
        ctx.beginPath(); ctx.arc(fx, fy, 4 + rnd(f.seed, i + 9) * 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.save(); ctx.globalAlpha = a * (1 - k); ctx.filter = 'brightness(.3)'; drawCharacter(ctx, f.skin, x - BW / 2, y - BH / 2, { state: 'idle', t: 0, facing: 1 }, '#222'); ctx.filter = 'none'; ctx.restore();
      break;
    }
    default: {
      for (let i = 0; i < 16; i++) {
        const ang = rnd(f.seed, i) * Math.PI * 2, d = ease(k) * 60;
        ctx.fillStyle = f.color; ctx.globalAlpha = a; ctx.fillRect(x + Math.cos(ang) * d - 3, y + Math.sin(ang) * d - 3 + 60 * k * k, 6, 6);
      }
    }
  }
  ctx.restore();
  void CELL;
  return true;
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const ang = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr); }
  ctx.closePath(); ctx.fill();
}
