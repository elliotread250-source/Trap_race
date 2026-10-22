// Original procedural vector art. Characters are drawn around the shared 28x42 body; ears, hats and tails are
// decoration outside it and never change the hitbox.
import { CELL, HAZARD, PHYS } from '../../shared/config';
import { DIRS, rotDirIndex, rotateMask, type Rot } from '../../shared/grid';
import { getItem, type ItemDef } from '../../shared/items';

export const PLAYER_COLORS = ['#ffd25e', '#3ee0c5', '#ff5e8a', '#7aa8ff', '#b07aff', '#7bea5c', '#ff9b4a', '#f2f2f2', '#ff6ad5', '#5ad1ff'];

export interface SkinDef { id: string; name: string; body: string; belly: string; dark: string; detail: string }
export const SKINS: SkinDef[] = [
  { id: 'fox', name: 'Fox', body: '#f08a2c', belly: '#fff3e2', dark: '#7a3a12', detail: '#2a1406' },
  { id: 'robot', name: 'Robot', body: '#9aa9c2', belly: '#d6e2f2', dark: '#4c5870', detail: '#57e6ff' },
  { id: 'astronaut', name: 'Astronaut', body: '#f4f6fb', belly: '#dfe5f0', dark: '#8a93a8', detail: '#2b3d74' },
  { id: 'frog', name: 'Frog', body: '#5fcf4a', belly: '#d8f7a8', dark: '#2a6b24', detail: '#1a1a1a' },
  { id: 'ninja', name: 'Ninja', body: '#2b2b3d', belly: '#3d3d55', dark: '#15151f', detail: '#ff3b4e' },
  { id: 'skeleton', name: 'Skeleton', body: '#efeadc', belly: '#2d2a3a', dark: '#9c958a', detail: '#1c1a24' },
  { id: 'penguin', name: 'Penguin', body: '#24283b', belly: '#f5f7ff', dark: '#11131d', detail: '#ffa41b' },
  { id: 'knight', name: 'Knight', body: '#b9c3cf', belly: '#8e99a8', dark: '#596372', detail: '#e2463e' },
];

export type AnimState = 'idle' | 'run' | 'sprint' | 'jump' | 'fall' | 'wallslide' | 'walljump' | 'land' | 'celebrate' | 'ghost';

export interface Pose { state: AnimState; t: number; facing: number; squash?: number; wallDir?: number }

const BW = PHYS.bodyW, BH = PHYS.bodyH;

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw a character whose collision body's top-left is (x, y). */
export function drawCharacter(ctx: CanvasRenderingContext2D, skinIdx: number, x: number, y: number, pose: Pose, accent: string, carryingCoins = 0) {
  const s = SKINS[skinIdx % SKINS.length];
  const cx = x + BW / 2, feet = y + BH;
  const t = pose.t;
  ctx.save();
  ctx.translate(cx, feet);
  let lean = 0, bob = 0, legA = 0, armA = 0, armUp = 0, sx = 1, sy = 1;
  switch (pose.state) {
    case 'idle': bob = Math.sin(t * 3) * 0.8; armA = Math.sin(t * 3) * 0.08; break;
    case 'run': legA = Math.sin(t * 15) * 0.7; armA = -legA * 0.7; bob = Math.abs(Math.sin(t * 15)) * 1.5; lean = 0.06; break;
    case 'sprint': legA = Math.sin(t * 21) * 0.95; armA = -legA * 0.9; bob = Math.abs(Math.sin(t * 21)) * 2; lean = 0.16; break;
    case 'jump': legA = 0.5; armUp = 0.9; sy = 1.05; sx = 0.96; break;
    case 'fall': legA = -0.25; armUp = 0.45; break;
    case 'wallslide': legA = 0.3; armUp = 1.4; lean = -0.12; break;
    case 'walljump': legA = 0.7; armUp = 1.1; lean = 0.25; break;
    case 'land': sy = 0.86; sx = 1.1; break;
    case 'celebrate': armUp = 1.8 + Math.sin(t * 10) * 0.2; bob = -Math.abs(Math.sin(t * 6)) * 6; break;
    default: break;
  }
  if (pose.squash) { sy *= 1 - pose.squash * 0.18; sx *= 1 + pose.squash * 0.14; }
  const face = pose.facing >= 0 ? 1 : -1;
  ctx.scale(face * sx, sy);
  ctx.rotate(lean);
  ctx.translate(0, bob);
  const line = 'rgba(14,10,30,.9)';
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // tail / pack behind the body
  if (s.id === 'fox') {
    ctx.fillStyle = s.body; ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(-8, -14); ctx.quadraticCurveTo(-22, -12 - Math.sin(t * 6) * 3, -20, -26); ctx.quadraticCurveTo(-14, -22, -6, -18); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = s.belly; ctx.beginPath(); ctx.arc(-19, -24, 3, 0, Math.PI * 2); ctx.fill();
  }
  if (s.id === 'astronaut') { ctx.fillStyle = s.dark; ctx.strokeStyle = line; rr(ctx, -15, -30, 8, 15, 3); ctx.fill(); ctx.stroke(); }

  // legs
  const leg = (ang: number, sideX: number) => {
    ctx.save(); ctx.translate(sideX, -12); ctx.rotate(ang);
    ctx.fillStyle = s.id === 'skeleton' ? s.body : s.dark; ctx.strokeStyle = line;
    rr(ctx, -3, 0, 6, 12, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = s.id === 'penguin' || s.id === 'fox' ? s.detail === '#ffa41b' ? s.detail : s.dark : s.dark;
    if (s.id === 'penguin') ctx.fillStyle = s.detail;
    rr(ctx, -4, 9, 9, 4, 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  };
  leg(-legA, -4); leg(legA, 4);

  // torso
  ctx.fillStyle = s.body; ctx.strokeStyle = line;
  rr(ctx, -10, -27, 20, 17, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = s.belly;
  if (s.id === 'skeleton') { ctx.strokeStyle = s.belly; ctx.lineWidth = 1.6; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-6, -23 + i * 4); ctx.lineTo(6, -23 + i * 4); ctx.stroke(); } ctx.lineWidth = 2.2; ctx.strokeStyle = line; }
  else if (s.id === 'knight') { ctx.fillStyle = s.detail; rr(ctx, -6, -25, 12, 13, 3); ctx.fill(); ctx.fillStyle = '#ffd25e'; ctx.fillRect(-1.5, -24, 3, 11); }
  else if (s.id === 'robot') { ctx.fillStyle = s.belly; rr(ctx, -6, -24, 12, 9, 2); ctx.fill(); ctx.fillStyle = s.detail; ctx.fillRect(-4, -22, 3, 3); ctx.fillStyle = '#ff5e8a'; ctx.fillRect(1, -22, 3, 3); }
  else if (s.id === 'ninja') { ctx.fillStyle = s.detail; ctx.fillRect(-10, -16, 20, 3); }
  else { ctx.beginPath(); ctx.ellipse(1, -18, 6, 7, 0, 0, Math.PI * 2); ctx.fill(); }

  // arms
  const arm = (ang: number, sideX: number, front: boolean) => {
    ctx.save(); ctx.translate(sideX, -24); ctx.rotate(Math.PI + ang);
    ctx.fillStyle = front ? s.body : s.dark; ctx.strokeStyle = line;
    if (s.id === 'penguin') ctx.fillStyle = s.body;
    rr(ctx, -2.5, 0, 5, 11, 2.5); ctx.fill(); ctx.stroke();
    ctx.restore();
  };
  arm(-armA - armUp, -9, false);
  arm(armA + armUp * 0.8, 9, true);

  // head
  const hy = -36;
  ctx.fillStyle = s.body; ctx.strokeStyle = line;
  if (s.id === 'robot') { rr(ctx, -10, hy - 9, 20, 17, 4); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, hy - 9); ctx.lineTo(0, hy - 15); ctx.stroke(); ctx.fillStyle = '#ff5e8a'; ctx.beginPath(); ctx.arc(0, hy - 16, 2.5, 0, Math.PI * 2); ctx.fill(); }
  else if (s.id === 'knight') { rr(ctx, -10, hy - 10, 20, 19, 6); ctx.fill(); ctx.stroke(); ctx.fillStyle = s.detail; ctx.beginPath(); ctx.moveTo(-2, hy - 10); ctx.quadraticCurveTo(-10, hy - 22, 6, hy - 20); ctx.quadraticCurveTo(2, hy - 14, 3, hy - 10); ctx.fill(); }
  else { ctx.beginPath(); ctx.arc(0, hy, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }

  // ears and hats (decorative, outside the hitbox)
  if (s.id === 'fox') {
    for (const ex of [-6, 5]) { ctx.fillStyle = s.body; ctx.beginPath(); ctx.moveTo(ex - 4, hy - 7); ctx.lineTo(ex + 1, hy - 18); ctx.lineTo(ex + 5, hy - 6); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = s.belly; ctx.beginPath(); ctx.ellipse(5, hy + 4, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (s.id === 'frog') { for (const ex of [-5, 6]) { ctx.fillStyle = s.body; ctx.beginPath(); ctx.arc(ex, hy - 8, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } }
  if (s.id === 'ninja') { ctx.fillStyle = s.detail; ctx.fillRect(-11, hy - 5, 22, 4); ctx.beginPath(); ctx.moveTo(-10, hy - 3); ctx.lineTo(-19, hy - 6 + Math.sin(t * 9) * 2); ctx.lineTo(-18, hy + 1); ctx.closePath(); ctx.fill(); }
  if (s.id === 'astronaut') { ctx.fillStyle = s.detail; rr(ctx, -3, hy - 6, 13, 10, 5); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.beginPath(); ctx.arc(6, hy - 3, 2, 0, Math.PI * 2); ctx.fill(); }

  // faces
  ctx.fillStyle = s.detail;
  const eye = (ex: number, ey: number, r = 2) => { ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.fill(); };
  switch (s.id) {
    case 'fox': eye(2, hy - 2); eye(7, hy - 2); ctx.fillStyle = '#1b0d05'; eye(10, hy + 3, 1.6); break;
    case 'robot': ctx.fillStyle = s.detail; rr(ctx, -6, hy - 5, 15, 6, 3); ctx.fill(); ctx.fillStyle = '#073042'; eye(1, hy - 2, 1.4); eye(6, hy - 2, 1.4); break;
    case 'frog': ctx.fillStyle = '#fff'; eye(-5, hy - 8, 2.6); eye(6, hy - 8, 2.6); ctx.fillStyle = s.detail; eye(-4, hy - 8, 1.3); eye(7, hy - 8, 1.3); ctx.strokeStyle = s.dark; ctx.beginPath(); ctx.arc(2, hy + 1, 5, 0.2, Math.PI - 0.2); ctx.stroke(); break;
    case 'ninja': ctx.fillStyle = '#f2d2b6'; rr(ctx, -2, hy - 4, 12, 5, 2); ctx.fill(); ctx.fillStyle = '#111'; eye(3, hy - 2, 1.4); eye(7, hy - 2, 1.4); break;
    case 'skeleton': ctx.fillStyle = s.detail; eye(1, hy - 2, 2.8); eye(7, hy - 2, 2.8); ctx.fillRect(2, hy + 4, 5, 1.5); break;
    case 'penguin': ctx.fillStyle = s.belly; ctx.beginPath(); ctx.ellipse(4, hy + 1, 6, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#111'; eye(3, hy - 2, 1.6); eye(8, hy - 2, 1.6); ctx.fillStyle = s.detail; ctx.beginPath(); ctx.moveTo(8, hy + 1); ctx.lineTo(14, hy + 3); ctx.lineTo(8, hy + 5); ctx.fill(); break;
    case 'knight': ctx.fillStyle = '#1b1b24'; ctx.fillRect(-5, hy - 3, 14, 3); ctx.fillRect(2, hy - 3, 2, 8); break;
    case 'astronaut': break;
    default: break;
  }
  ctx.restore();

  // accent: player colour ring under the feet + coin marker above the head
  ctx.save();
  ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.ellipse(cx, feet + 1, 13, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  if (carryingCoins > 0) drawCoinMarker(ctx, cx, y - 26, carryingCoins, t);
}

export function drawCoinMarker(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, t: number) {
  ctx.save();
  ctx.translate(x, y + Math.sin(t * 4) * 1.5);
  drawCoinShape(ctx, 0, 0, 7, t);
  if (n > 1) { ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.strokeText(`×${n}`, 9, 0); ctx.fillText(`×${n}`, 9, 0); }
  ctx.restore();
}

export function drawCoinShape(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, t: number) {
  const w = Math.abs(Math.cos(t * 3)) * 0.65 + 0.35;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(w, 1);
  ctx.fillStyle = '#ffcf33'; ctx.strokeStyle = '#a66a00'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff1a8'; ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.3, r * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#a66a00'; ctx.beginPath(); ctx.moveTo(0, -r * 0.5); ctx.lineTo(0, r * 0.5); ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- items

export interface ItemDrawOpts { owner?: string; ghost?: boolean; t: number; phase?: number; state?: string; variant?: number; mapProv?: boolean }

const C = CELL;

/** Draw the static body of an item whose anchor cell is at (ax, ay) in pixels, rotation rot. */
export function drawItem(ctx: CanvasRenderingContext2D, def: ItemDef, cells: [number, number][], ax: number, ay: number, rot: Rot, o: ItemDrawOpts) {
  const own = o.owner ?? '#ffffff';
  ctx.save();
  if (o.ghost) ctx.globalAlpha = 0.6;
  const px = (cx: number, cy: number) => [ax + cx * C, ay + cy * C] as const;
  switch (def.kind) {
    case 'block': {
      const plank = def.id.startsWith('plank');
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = plank ? '#c98b4f' : '#8f6ad8';
        ctx.fillRect(x, y, C, C);
        ctx.fillStyle = plank ? '#a86c36' : '#7552bd';
        ctx.fillRect(x, y + C - 8, C, 8);
        ctx.strokeStyle = 'rgba(20,10,40,.55)'; ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, C - 2, C - 2);
        if (plank) { ctx.strokeStyle = 'rgba(90,50,20,.5)'; ctx.beginPath(); ctx.moveTo(x + 6, y + 16); ctx.lineTo(x + C - 6, y + 16); ctx.moveTo(x + 6, y + 30); ctx.lineTo(x + C - 10, y + 30); ctx.stroke(); }
        else { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(x + 4, y + 4, C - 8, 5); }
      }
      outlineCells(ctx, cells, ax, ay, own);
      break;
    }
    case 'oneway': {
      const n = rotDirIndex(0, rot);
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = '#d9a35a';
        const r = sideStrip(x, y, n, 12);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = '#ffe1a8';
        const d = DIRS[n];
        ctx.beginPath();
        const mx = x + C / 2, my = y + C / 2;
        ctx.moveTo(mx + d.x * 8 - d.y * 7, my + d.y * 8 + d.x * 7);
        ctx.lineTo(mx + d.x * 16, my + d.y * 16);
        ctx.lineTo(mx + d.x * 8 + d.y * 7, my + d.y * 8 - d.x * 7);
        ctx.globalAlpha *= 0.5; ctx.fill(); ctx.globalAlpha = o.ghost ? 0.6 : 1;
      }
      outlineCells(ctx, cells, ax, ay, own, 0.5);
      break;
    }
    case 'spring': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      const n = rotDirIndex(0, rot);
      ctx.translate(x + C / 2, y + C / 2); ctx.rotate((n * Math.PI) / 2);
      ctx.strokeStyle = '#d0d6e2'; ctx.lineWidth = 3;
      ctx.beginPath(); for (let i = 0; i < 4; i++) { ctx.moveTo(-12, 20 - i * 4); ctx.lineTo(12, 18 - i * 4); } ctx.stroke();
      ctx.fillStyle = '#ff5e8a'; rr(ctx, -18, 6, 36, 6, 3); ctx.fill();
      ctx.fillStyle = '#3a3f55'; ctx.fillRect(-16, 20, 32, 4);
      break;
    }
    case 'conveyor': {
      const tdir = DIRS[rotDirIndex(1, rot)];
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = '#3d4459'; ctx.fillRect(x, y, C, C);
        ctx.fillStyle = '#596381'; ctx.fillRect(x + 3, y + 3, C - 6, C - 6);
        ctx.fillStyle = '#ffd25e';
        const off = ((o.t * 40) % 16);
        for (let i = -1; i < 3; i++) {
          const k = i * 16 + off;
          const ox = tdir.x !== 0 ? (tdir.x > 0 ? k : C - k) : C / 2, oy = tdir.y !== 0 ? (tdir.y > 0 ? k : C - k) : C / 2;
          if (ox < 2 || ox > C - 2 || oy < 2 || oy > C - 2) continue;
          ctx.beginPath(); ctx.moveTo(x + ox + tdir.x * 6, y + oy + tdir.y * 6); ctx.lineTo(x + ox - tdir.y * 5 - tdir.x * 2, y + oy + tdir.x * 5 - tdir.y * 2); ctx.lineTo(x + ox + tdir.y * 5 - tdir.x * 2, y + oy - tdir.x * 5 - tdir.y * 2); ctx.fill();
        }
      }
      outlineCells(ctx, cells, ax, ay, own);
      break;
    }
    case 'moving': {
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = '#5f6b8c'; ctx.fillRect(x, y, C, C);
        ctx.fillStyle = '#8a97ba'; ctx.fillRect(x + 3, y + 3, C - 6, 10);
        ctx.fillStyle = '#2b3146'; for (const [rx, ry] of [[8, 30], [C - 8, 30]]) { ctx.beginPath(); ctx.arc(x + rx, y + ry, 3, 0, Math.PI * 2); ctx.fill(); }
      }
      outlineCells(ctx, cells, ax, ay, own);
      break;
    }
    case 'crumble': {
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = '#b59a7a'; ctx.fillRect(x, y, C, C);
        ctx.strokeStyle = '#6b5640'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x + 10, y); ctx.lineTo(x + 18, y + 18); ctx.lineTo(x + 12, y + 30); ctx.moveTo(x + 18, y + 18); ctx.lineTo(x + 34, y + 24); ctx.lineTo(x + 40, y + C); ctx.stroke();
      }
      outlineCells(ctx, cells, ax, ay, own);
      break;
    }
    case 'spikes': case 'rspikes': {
      const n = rotDirIndex(0, rot);
      const ext = def.kind === 'spikes' ? 1 : o.state === 'out' ? 1 : o.state === 'warn' ? 0.35 : 0.08;
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.save(); ctx.translate(x + C / 2, y + C / 2); ctx.rotate((n * Math.PI) / 2);
        ctx.fillStyle = '#4a4f63'; ctx.fillRect(-C / 2, C / 2 - 5, C, 5);
        ctx.fillStyle = o.state === 'warn' ? '#ffb0a0' : '#dfe4ef'; ctx.strokeStyle = '#5b6074'; ctx.lineWidth = 1.5;
        const h = HAZARD.spikeHeight * ext;
        for (let i = 0; i < 4; i++) {
          const sx = -C / 2 + 2 + i * 11;
          ctx.beginPath(); ctx.moveTo(sx, C / 2 - 4); ctx.lineTo(sx + 5.5, C / 2 - 4 - h); ctx.lineTo(sx + 11, C / 2 - 4); ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
      outlineCells(ctx, cells, ax, ay, own, 0.35);
      break;
    }
    case 'saw': {
      const tdir = DIRS[rotDirIndex(1, rot)];
      const first = cells.reduce((a, b) => ((b[0] - a[0]) * tdir.x + (b[1] - a[1]) * tdir.y < 0 ? b : a));
      const last = cells.reduce((a, b) => ((b[0] - a[0]) * tdir.x + (b[1] - a[1]) * tdir.y > 0 ? b : a));
      const [x0, y0] = px(first[0], first[1]); const [x1, y1] = px(last[0], last[1]);
      ctx.strokeStyle = '#3b3f52'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0 + C / 2, y0 + C / 2); ctx.lineTo(x1 + C / 2, y1 + C / 2); ctx.stroke();
      ctx.strokeStyle = '#6f7591'; ctx.lineWidth = 3; ctx.stroke();
      outlineCells(ctx, cells, ax, ay, own, 0.3);
      break;
    }
    case 'dart': case 'laser': case 'cannon': case 'crossbow': case 'sniper': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      drawLauncher(ctx, def, x, y, rot, o);
      outlineCells(ctx, cells, ax, ay, own, 0.6);
      break;
    }
    case 'pendulum': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      ctx.fillStyle = '#3b3f52'; ctx.beginPath(); ctx.arc(x + C / 2, y + C / 2, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9aa1b8'; ctx.beginPath(); ctx.arc(x + C / 2, y + C / 2, 4, 0, Math.PI * 2); ctx.fill();
      outlineCells(ctx, cells, ax, ay, own, 0.3);
      break;
    }
    case 'blackhole': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      drawBlackHole(ctx, x + C / 2, y + C / 2, o.t, !!o.ghost);
      break;
    }
    case 'wire': {
      for (const [cx, cy] of cells) drawWireCell(ctx, ax + cx * C, ay + cy * C, rot, o.mapProv ?? false);
      if (!o.mapProv) outlineCells(ctx, cells, ax, ay, own, 0.25);
      break;
    }
    case 'coin': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      drawCoinShape(ctx, x + C / 2, y + C / 2, 13, o.t);
      break;
    }
    case 'power': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      drawStation(ctx, def, x, y, o.t, o.state !== 'used');
      break;
    }
    case 'bomb': {
      const n = def.bombSize ?? 1;
      const [x, y] = px(0, 0);
      ctx.fillStyle = 'rgba(255,120,40,.22)'; ctx.fillRect(x, y, n * C, n * C);
      ctx.strokeStyle = '#ff9b4a'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]); ctx.strokeRect(x + 1.5, y + 1.5, n * C - 3, n * C - 3); ctx.setLineDash([]);
      ctx.fillStyle = '#2b2b3d'; ctx.beginPath(); ctx.arc(x + (n * C) / 2, y + (n * C) / 2 + 3, 13, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffd25e'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x + (n * C) / 2 + 6, y + (n * C) / 2 - 8); ctx.quadraticCurveTo(x + (n * C) / 2 + 12, y + (n * C) / 2 - 18, x + (n * C) / 2 + 18, y + (n * C) / 2 - 14); ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

function sideStrip(x: number, y: number, n: number, th: number) {
  if (n === 0) return { x, y, w: C, h: th };
  if (n === 1) return { x: x + C - th, y, w: th, h: C };
  if (n === 2) return { x, y: y + C - th, w: C, h: th };
  return { x, y, w: th, h: C };
}

/** Owner colour along the outer boundary of an object's occupied cells. */
export function outlineCells(ctx: CanvasRenderingContext2D, cells: [number, number][], ax: number, ay: number, color: string, alpha = 0.9) {
  const set = new Set(cells.map(([x, y]) => `${x},${y}`));
  ctx.save();
  ctx.strokeStyle = color; ctx.globalAlpha *= alpha; ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [cx, cy] of cells) {
    const x = ax + cx * C, y = ay + cy * C;
    if (!set.has(`${cx},${cy - 1}`)) { ctx.moveTo(x, y + 1.5); ctx.lineTo(x + C, y + 1.5); }
    if (!set.has(`${cx},${cy + 1}`)) { ctx.moveTo(x, y + C - 1.5); ctx.lineTo(x + C, y + C - 1.5); }
    if (!set.has(`${cx - 1},${cy}`)) { ctx.moveTo(x + 1.5, y); ctx.lineTo(x + 1.5, y + C); }
    if (!set.has(`${cx + 1},${cy}`)) { ctx.moveTo(x + C - 1.5, y); ctx.lineTo(x + C - 1.5, y + C); }
  }
  ctx.stroke();
  ctx.restore();
}

export function drawWireCell(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, permanent: boolean) {
  const n = rotDirIndex(0, rot);
  const th = HAZARD.wireThickness;
  ctx.save();
  ctx.translate(x + C / 2, y + C / 2);
  ctx.rotate((n * Math.PI) / 2);
  // strip sits at the bottom of the rotated cell (against the support)
  const by = C / 2 - th;
  ctx.strokeStyle = permanent ? '#9aa0ad' : '#c9ced8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const cx = -C / 2 + i * 12;
    ctx.moveTo(cx, by + th / 2);
    ctx.arc(cx + 6, by + th / 2, 5, Math.PI, Math.PI * 3);
  }
  ctx.stroke();
  ctx.strokeStyle = permanent ? '#6c727f' : '#ff5e8a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) { const cx = -C / 2 + 6 + i * 12; ctx.moveTo(cx - 3, by + 1); ctx.lineTo(cx + 3, by + th - 1); ctx.moveTo(cx + 3, by + 1); ctx.lineTo(cx - 3, by + th - 1); }
  ctx.stroke();
  ctx.restore();
}

export function drawBlackHole(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, ghost: boolean) {
  ctx.save();
  // attraction zone
  const g = ctx.createRadialGradient(x, y, 4, x, y, HAZARD.holeRadius);
  g.addColorStop(0, 'rgba(120,60,220,.35)'); g.addColorStop(0.6, 'rgba(80,40,180,.12)'); g.addColorStop(1, 'rgba(60,30,140,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, HAZARD.holeRadius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(190,150,255,.35)'; ctx.setLineDash([6, 10]); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, HAZARD.holeRadius, t * 0.3, t * 0.3 + Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  // swirl arms
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = `rgba(200,160,255,${0.55 - i * 0.12})`; ctx.lineWidth = 3;
    ctx.beginPath();
    for (let k = 0; k < 24; k++) {
      const a = -t * 3 + i * 2.1 + k * 0.25, r = 34 - k * 1.2;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // lethal core
  ctx.fillStyle = '#05010f'; ctx.beginPath(); ctx.arc(x, y, HAZARD.holeCore, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ghost ? '#ff5e8a' : '#ff3bd0'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, HAZARD.holeCore + 1, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawLauncher(ctx: CanvasRenderingContext2D, def: ItemDef, x: number, y: number, rot: Rot, o: ItemDrawOpts) {
  const cx = x + C / 2, cy = y + C / 2;
  ctx.save();
  if (def.kind === 'sniper') {
    const face = o.variant === 1 ? -1 : 1;
    ctx.strokeStyle = '#3b3f52'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy + 2); ctx.lineTo(x + 8, y + C); ctx.moveTo(cx, cy + 2); ctx.lineTo(x + C - 8, y + C); ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, y + C); ctx.stroke();
    ctx.fillStyle = '#4b5068'; rr(ctx, cx - 12, cy - 12, 24, 10, 3); ctx.fill();
    ctx.fillStyle = '#2b2f40'; ctx.fillRect(face > 0 ? cx + 4 : cx - 26, cy - 9, 22, 4);
    ctx.fillStyle = '#7ad1ff'; ctx.beginPath(); ctx.arc(cx - face * 4, cy - 14, 4, 0, Math.PI * 2); ctx.fill();
    if (o.state === 'warn') { ctx.strokeStyle = 'rgba(255,40,40,.75)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx + face * 24, cy - 7); ctx.lineTo(cx + face * 900, cy - 7); ctx.stroke(); }
    ctx.restore();
    return;
  }
  ctx.translate(cx, cy);
  if (def.kind === 'cannon') {
    const n = rot;
    ctx.rotate((n * Math.PI) / 2);
    ctx.fillStyle = '#5a4030'; ctx.beginPath(); ctx.arc(0, 10, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b2b3d'; ctx.save(); ctx.rotate(-Math.PI / 6); rr(ctx, -6, -9, 30, 18, 6); ctx.fill(); ctx.fillStyle = '#4b4b66'; ctx.fillRect(18, -9, 6, 18); ctx.restore();
    ctx.fillStyle = '#c99055'; ctx.beginPath(); ctx.arc(0, 10, 5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.rotate((rotDirIndex(1, rot) - 1) * (Math.PI / 2));
    if (def.kind === 'crossbow') {
      ctx.fillStyle = '#7a4a26'; rr(ctx, -16, -5, 30, 10, 3); ctx.fill();
      ctx.strokeStyle = '#3b2412'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(4, 0, 18, -1.2, 1.2); ctx.stroke();
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(4 + Math.cos(-1.2) * 18, Math.sin(-1.2) * 18); ctx.lineTo(-8, 0); ctx.lineTo(4 + Math.cos(1.2) * 18, Math.sin(1.2) * 18); ctx.stroke();
    } else if (def.kind === 'dart') {
      ctx.fillStyle = '#5e6b54'; rr(ctx, -22, -22, 44, 44, 6); ctx.fill();
      ctx.fillStyle = '#3a4434'; rr(ctx, -16, -16, 32, 32, 4); ctx.fill();
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(16, 0, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c9d19c'; ctx.fillRect(-10, -3, 14, 6);
    } else if (def.kind === 'laser') {
      ctx.fillStyle = '#39324f'; rr(ctx, -22, -22, 44, 44, 8); ctx.fill();
      ctx.fillStyle = o.state === 'on' ? '#ff3b6a' : o.state === 'warn' ? '#ffb347' : '#5a5370';
      ctx.beginPath(); ctx.arc(14, 0, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7d73a8'; ctx.fillRect(-14, -14, 10, 28);
    }
  }
  ctx.restore();
}

function drawStation(ctx: CanvasRenderingContext2D, def: ItemDef, x: number, y: number, t: number, available: boolean) {
  const cx = x + C / 2;
  ctx.save();
  ctx.fillStyle = '#3b3560'; rr(ctx, x + 8, y + C - 10, C - 16, 10, 3); ctx.fill();
  const col = def.power === 'speed' ? '#3ee0c5' : def.power === 'jump' ? '#7bea5c' : def.power === 'shield' ? '#7aa8ff' : '#b07aff';
  if (available) {
    const bob = Math.sin(t * 3) * 3;
    ctx.fillStyle = col; ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(cx, y + 20 + bob, 17, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(cx, y + 20 + bob, 11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath();
    const yy = y + 20 + bob;
    if (def.power === 'speed') { ctx.moveTo(cx - 5, yy - 5); ctx.lineTo(cx + 2, yy); ctx.lineTo(cx - 5, yy + 5); ctx.moveTo(cx, yy - 5); ctx.lineTo(cx + 7, yy); ctx.lineTo(cx, yy + 5); }
    else if (def.power === 'jump') { ctx.moveTo(cx - 6, yy + 3); ctx.lineTo(cx, yy - 5); ctx.lineTo(cx + 6, yy + 3); }
    else if (def.power === 'shield') { ctx.moveTo(cx, yy - 6); ctx.lineTo(cx + 6, yy - 3); ctx.lineTo(cx + 4, yy + 4); ctx.lineTo(cx, yy + 7); ctx.lineTo(cx - 4, yy + 4); ctx.lineTo(cx - 6, yy - 3); ctx.closePath(); }
    else { ctx.arc(cx, yy, 5, 0, Math.PI * 2); ctx.moveTo(cx, yy); ctx.lineTo(cx, yy - 4); ctx.moveTo(cx, yy); ctx.lineTo(cx + 3, yy + 1); }
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, y + 20, 11, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

/** Card thumbnail: the item at rotation 0 with its exact footprint on a small grid. */
export function drawCardPreview(canvas: HTMLCanvasElement, itemId: string, t = 0) {
  const def = getItem(itemId);
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const mask = def.kind === 'bomb' ? Array.from({ length: (def.bombSize ?? 1) ** 2 }, (_, i) => [i % (def.bombSize ?? 1), Math.floor(i / (def.bombSize ?? 1))] as [number, number]) : rotateMask(def.mask, 0);
  let mw = 0, mh = 0;
  for (const [x, y] of mask) { mw = Math.max(mw, x + 1); mh = Math.max(mh, y + 1); }
  const showW = Math.max(mw + 2, 3), showH = Math.max(mh + 2, 3);
  const scale = Math.min(W / (showW * C), H / (showH * C));
  ctx.save();
  ctx.translate((W - showW * C * scale) / 2, (H - showH * C * scale) / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1 / scale;
  for (let x = 0; x <= showW; x++) { ctx.beginPath(); ctx.moveTo(x * C, 0); ctx.lineTo(x * C, showH * C); ctx.stroke(); }
  for (let y = 0; y <= showH; y++) { ctx.beginPath(); ctx.moveTo(0, y * C); ctx.lineTo(showW * C, y * C); ctx.stroke(); }
  const ox = Math.floor((showW - mw) / 2), oy = Math.floor((showH - mh) / 2);
  if (def.kind === 'wire' || def.kind === 'sniper') {
    // show the support block the item needs
    ctx.fillStyle = '#5b4d8f';
    for (let i = 0; i < mw; i++) ctx.fillRect((ox + i) * C, (oy + mh) * C, C, C);
  }
  ctx.fillStyle = 'rgba(255,210,94,.12)';
  for (const [x, y] of mask) ctx.fillRect((ox + x) * C, (oy + y) * C, C, C);
  if (def.kind === 'blackhole') { ctx.beginPath(); ctx.rect(0, 0, showW * C, showH * C); ctx.clip(); }
  drawItem(ctx, def, mask, ox * C, oy * C, 0, { t, state: 'out', owner: '#ffd25e' });
  ctx.restore();
}
