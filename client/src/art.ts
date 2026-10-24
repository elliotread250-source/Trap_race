// Original procedural vector art. Characters are drawn around the shared 28x42 body; ears, hats and tails are
// decoration outside it and never change the hitbox.
import { CELL, EMOTES, HAZARD, MOVERS, PHYS } from '../../shared/config';
import { DIRS, rotDirIndex, rotateMask, type Rot } from '../../shared/grid';
import { getItem, type ItemDef } from '../../shared/items';
import { splitRspike } from '../../shared/world';

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

export type AnimState = 'idle' | 'run' | 'sprint' | 'jump' | 'fall' | 'wallslide' | 'walljump' | 'land' | 'celebrate' | 'ghost' | 'skid' | 'ready' | 'bored';

export interface Pose {
  state: AnimState; t: number; facing: number; squash?: number; wallDir?: number;
  /** index into EMOTES while an emote plays, with the seconds since it started */
  emote?: number; emoteT?: number;
  /** which dance a finisher celebrates with (stable per player) */
  dance?: number;
}

/** Dances a finisher cycles through on the flag (indices into EMOTES). */
export const VICTORY_DANCES = [1, 9, 3, 7];

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
  let headTilt = 0, spinX = 1;
  let armF: number | null = null, armB: number | null = null; // explicit arm angles (raised forward from hanging), when an emote sets them
  let bubble: string | null = null;
  let tears = false, emoteId: string | null = null;
  switch (pose.state) {
    case 'idle': bob = Math.sin(t * 3) * 0.8; armA = Math.sin(t * 3) * 0.08; headTilt = Math.sin(t * 0.9) * 0.04; break;
    case 'bored': { // waited a while: looks around and taps a foot
      bob = Math.sin(t * 3) * 0.8; headTilt = Math.sin(t * 1.3) * 0.18; legA = Math.max(0, Math.sin(t * 7)) * 0.25; armA = 0.15; break;
    }
    case 'ready': { // countdown crouch: knees bent, arms back, bouncing on the spot
      const k = Math.abs(Math.sin(t * 5)); sy = 0.92 + k * 0.05; sx = 1.04; lean = 0.12; armF = -0.6; armB = -0.8; legA = 0.15; bob = k * 1.5; break;
    }
    case 'skid': { lean = -0.28; legA = -0.55; armF = 1.1; armB = 1.3; sy = 0.95; break; } // braking hard after a turn
    case 'run': legA = Math.sin(t * 15) * 0.7; armA = -legA * 0.7; bob = Math.abs(Math.sin(t * 15)) * 1.5; lean = 0.06; break;
    case 'sprint': legA = Math.sin(t * 21) * 0.95; armA = -legA * 0.9; bob = Math.abs(Math.sin(t * 21)) * 2; lean = 0.16; break;
    case 'jump': legA = 0.5; armUp = 0.9; sy = 1.05; sx = 0.96; break;
    case 'fall': legA = -0.25; armUp = 0.45 + Math.sin(t * 18) * 0.15; break; // arms flail a little on the way down
    case 'wallslide': legA = 0.3; armUp = 1.4; lean = -0.12; break;
    case 'walljump': legA = 0.7; armUp = 1.1; lean = 0.25; break;
    case 'land': sy = 0.86; sx = 1.1; break;
    case 'celebrate': armUp = 1.8 + Math.sin(t * 10) * 0.2; bob = -Math.abs(Math.sin(t * 6)) * 6; break;
    default: break;
  }
  // finishers dance on the flag; emotes override the base pose
  let em = pose.emote;
  let et = pose.emoteT ?? t;
  if (em === undefined && pose.state === 'celebrate' && pose.dance !== undefined) { em = VICTORY_DANCES[pose.dance % VICTORY_DANCES.length]; et = t; }
  if (em !== undefined && EMOTES[em]) {
    emoteId = EMOTES[em].id;
    if (pose.emote !== undefined) bubble = EMOTES[em].bubble;
    legA = 0; armA = 0; armUp = 0; lean = 0; bob = 0;
    switch (emoteId) {
      case 'wave': armF = 2.7 + Math.sin(et * 12) * 0.45; armB = 0.1; headTilt = 0.08; bob = Math.sin(et * 6) * 0.8; break;
      case 'dance': { const b = Math.sin(et * 8); bob = -Math.abs(b) * 4; lean = Math.sin(et * 4) * 0.16; armF = b > 0 ? 2.6 : 0.4; armB = b > 0 ? 0.4 : 2.6; legA = b * 0.35; headTilt = Math.sin(et * 4) * 0.12; break; }
      case 'spin': spinX = Math.cos(et * 9); bob = -Math.abs(Math.sin(et * 9)) * 5; armF = 1.6; armB = 1.6; break;
      case 'flex': { const p = 0.5 + 0.5 * Math.sin(et * 6); armF = 2.2; armB = 2.2; sx = 1.04 + p * 0.06; sy = 1 - p * 0.03; lean = -0.05; break; }
      case 'laugh': lean = -0.18 + Math.sin(et * 28) * 0.03; bob = Math.sin(et * 28) * 1.2; armF = 0.5; armB = 0.5; headTilt = -0.15; break;
      case 'cry': lean = 0.12; armF = 2.5; armB = 2.5; bob = Math.sin(et * 20) * 0.6; headTilt = 0.2; tears = true; break;
      case 'point': armF = 1.57 + Math.sin(et * 5) * 0.05; armB = 0.2; lean = 0.08; legA = 0.25; headTilt = 0.05; break;
      case 'heart': armF = 2.9; armB = 2.9; bob = -Math.abs(Math.sin(et * 5)) * 3; sx = 1 + Math.sin(et * 10) * 0.02; break;
      case 'thumbs': armF = 1.2; armB = 0.1; headTilt = Math.sin(et * 7) * 0.1; bob = Math.sin(et * 7) * 0.8; break;
      case 'floss': { const f = Math.sin(et * 11); armF = 0.6 + f * 0.9; armB = 0.6 - f * 0.9; lean = -f * 0.12; legA = f * 0.15; bob = -Math.abs(f) * 1.5; break; }
      default: break;
    }
  }
  if (pose.squash) { sy *= 1 - pose.squash * 0.18; sx *= 1 + pose.squash * 0.14; }
  const face = pose.facing >= 0 ? 1 : -1;
  ctx.scale(face * sx * (Math.abs(spinX) < 0.15 ? 0.15 * Math.sign(spinX || 1) : spinX), sy);
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
  // arm angle: 0 hangs straight down, positive raises it forward (PI is straight up)
  const arm = (ang: number, sideX: number, front: boolean) => {
    ctx.save(); ctx.translate(sideX, -24); ctx.rotate(-ang);
    ctx.fillStyle = front ? s.body : s.dark; ctx.strokeStyle = line;
    if (s.id === 'penguin') ctx.fillStyle = s.body;
    rr(ctx, -2.5, 0, 5, 11, 2.5); ctx.fill(); ctx.stroke();
    ctx.restore();
  };
  arm(armB ?? -armA + armUp, -9, false);
  arm(armF ?? armA + armUp * 0.8, 9, true);
  if (emoteId === 'thumbs') { ctx.save(); ctx.translate(9, -24); ctx.rotate(-(armF ?? 0)); ctx.fillStyle = s.body; ctx.strokeStyle = line; ctx.beginPath(); ctx.arc(0, 12, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); rr(ctx, -1.2, 12, 2.4, 6, 1.2); ctx.fill(); ctx.stroke(); ctx.restore(); }

  // head (tilts for idle glances and emotes)
  const hy = -36;
  ctx.save(); ctx.translate(0, hy + 8); ctx.rotate(headTilt); ctx.translate(0, -(hy + 8));
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

  // faces (everyone blinks every few seconds, at their own moment)
  ctx.fillStyle = s.detail;
  const blink = ((t + skinIdx * 0.7) % 3.4) < 0.12 || emoteId === 'laugh';
  const eye = (ex: number, ey: number, r = 2) => { ctx.beginPath(); if (blink) ctx.ellipse(ex, ey, r, Math.max(0.5, r * 0.2), 0, 0, Math.PI * 2); else ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.fill(); };
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
  if (tears) { ctx.fillStyle = '#7ad1ff'; for (const [tx, ph] of [[2, 0], [8, 0.5]]) { const k = ((t * 1.6 + ph) % 1); ctx.beginPath(); ctx.ellipse(tx, hy + 2 + k * 14, 1.6, 2.4, 0, 0, Math.PI * 2); ctx.fill(); } }
  if (emoteId === 'laugh') { ctx.fillStyle = '#1b0d18'; ctx.beginPath(); ctx.ellipse(5, hy + 5, 3.5, 2.2 + Math.abs(Math.sin(t * 28)), 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore(); // head tilt
  if (emoteId === 'heart') { ctx.fillStyle = '#ff5e8a'; ctx.strokeStyle = line; ctx.lineWidth = 1.5; const hx = 0, hy2 = -62 - Math.abs(Math.sin(t * 5)) * 3; ctx.beginPath(); ctx.moveTo(hx, hy2 + 5); ctx.bezierCurveTo(hx - 9, hy2 - 3, hx - 4, hy2 - 9, hx, hy2 - 4); ctx.bezierCurveTo(hx + 4, hy2 - 9, hx + 9, hy2 - 3, hx, hy2 + 5); ctx.fill(); ctx.stroke(); }
  if (emoteId === 'dance' || emoteId === 'floss') { ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.save(); ctx.scale(face, 1); ctx.fillText('♪', -16 + Math.sin(t * 3) * 3, -48 - ((t * 20) % 14)); ctx.restore(); }
  ctx.restore();

  // accent: player colour ring under the feet + coin marker above the head
  ctx.save();
  ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.ellipse(cx, feet + 1, 13, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  if (carryingCoins > 0) drawCoinMarker(ctx, cx, y - 26, carryingCoins, t);
  if (bubble) drawBubble(ctx, cx, y - (carryingCoins > 0 ? 62 : 48), bubble, pose.emoteT ?? 0); // above the name tag
}

/** A small speech bubble above a character, popping in and fading out over the emote's lifetime. */
export function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, age: number) {
  const pop = Math.min(1, age / 0.15), fade = Math.max(0, Math.min(1, (2.6 - age) / 0.4));
  if (fade <= 0) return;
  ctx.save();
  ctx.globalAlpha *= fade;
  ctx.font = 'bold 12px sans-serif';
  const w = ctx.measureText(text).width + 14, h = 20;
  ctx.translate(x, y); ctx.scale(pop, pop);
  ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.strokeStyle = 'rgba(20,14,40,.9)'; ctx.lineWidth = 2;
  rr(ctx, -w / 2, -h, w, h, 8); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-5, -1); ctx.lineTo(0, 6); ctx.lineTo(5, -1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = text === '♥' ? '#ff3b6a' : '#1d1630'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, -h / 2 + 1);
  ctx.restore();
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
      const cracked = o.state === 'cracked';
      for (const [cx, cy] of cells) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = cracked ? '#a58868' : '#b59a7a'; ctx.fillRect(x, y, C, C);
        ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(x + 3, y + 3, C - 6, 5);
        ctx.strokeStyle = '#6b5640'; ctx.lineWidth = 2;
        if (cracked) {
          // obviously damaged: one more hit and it is gone for the round
          ctx.beginPath(); ctx.moveTo(x + 10, y); ctx.lineTo(x + 18, y + 18); ctx.lineTo(x + 12, y + 30); ctx.moveTo(x + 18, y + 18); ctx.lineTo(x + 34, y + 24); ctx.lineTo(x + 40, y + C); ctx.moveTo(x + 30, y); ctx.lineTo(x + 26, y + 12); ctx.lineTo(x + 34, y + 24); ctx.stroke();
          ctx.fillStyle = 'rgba(40,25,10,.28)'; ctx.fillRect(x, y + C - 10, C, 10);
        } else { ctx.globalAlpha *= 0.55; ctx.beginPath(); ctx.moveTo(x + 8, y + 30); ctx.lineTo(x + 16, y + 34); ctx.moveTo(x + 30, y + 14); ctx.lineTo(x + 38, y + 10); ctx.stroke(); ctx.globalAlpha = o.ghost ? 0.6 : 1; }
      }
      outlineCells(ctx, cells, ax, ay, own);
      break;
    }
    case 'oval': {
      drawSpikyOval(ctx, cells, ax, ay);
      outlineCells(ctx, cells, ax, ay, own, 0.3);
      break;
    }
    case 'rspikes': {
      // one assembly: a solid base block with the spikes rising from its outward face
      const parts = splitRspike(cells, rot);
      const n = rotDirIndex(0, rot);
      const ext = o.state === 'out' ? 1 : o.state === 'warn' ? 0.35 : 0.08;
      for (const [cx, cy] of parts.base) {
        const [x, y] = px(cx, cy);
        ctx.fillStyle = '#4d5470'; ctx.fillRect(x, y, C, C);
        ctx.fillStyle = '#6a7394'; ctx.fillRect(x + 3, y + 3, C - 6, 6);
        ctx.fillStyle = '#383e55'; ctx.fillRect(x, y + C - 8, C, 8);
        ctx.strokeStyle = 'rgba(15,12,30,.6)'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, C - 2, C - 2);
        ctx.fillStyle = '#8f98b8'; for (const [bx, by] of [[8, 14], [C - 8, 14]]) { ctx.beginPath(); ctx.arc(x + bx, y + by, 2.5, 0, Math.PI * 2); ctx.fill(); }
      }
      for (const [cx, cy] of parts.spikes) {
        const [x, y] = px(cx, cy);
        ctx.save(); ctx.translate(x + C / 2, y + C / 2); ctx.rotate((n * Math.PI) / 2);
        // slots in the top of the base show where the spikes retract into
        ctx.fillStyle = '#1d2030'; ctx.fillRect(-C / 2 + 3, C / 2 - 4, C - 6, 4);
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
    case 'laser': case 'cannon': case 'crossbow': case 'sniper': {
      const [x, y] = px(cells[0][0], cells[0][1]);
      drawLauncher(ctx, def, x, y, rot, o);
      outlineCells(ctx, cells, ax, ay, own, 0.6);
      break;
    }
    case 'pendulum': {
      // a real 1x1 solid pivot block with the axe's hinge bolted to it
      const [x, y] = px(cells[0][0], cells[0][1]);
      ctx.fillStyle = '#59607a'; ctx.fillRect(x, y, C, C);
      ctx.fillStyle = '#7b83a3'; ctx.fillRect(x + 3, y + 3, C - 6, 6);
      ctx.fillStyle = '#3d435a'; ctx.fillRect(x, y + C - 8, C, 8);
      ctx.strokeStyle = 'rgba(15,12,30,.6)'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, C - 2, C - 2);
      ctx.fillStyle = '#2b2f40'; ctx.beginPath(); ctx.arc(x + C / 2, y + C / 2, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c3c9de'; ctx.beginPath(); ctx.arc(x + C / 2, y + C / 2, 4, 0, Math.PI * 2); ctx.fill();
      outlineCells(ctx, cells, ax, ay, own, 0.6);
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

/** An elongated oval covered in spikes, filling its 3x1 (or 1x3) footprint. */
export function drawSpikyOval(ctx: CanvasRenderingContext2D, cells: [number, number][], ax: number, ay: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of cells) { x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); }
  const w = (x1 - x0 + 1) * C, h = (y1 - y0 + 1) * C;
  const cx = ax + x0 * C + w / 2, cy = ay + y0 * C + h / 2;
  const rx = w / 2 - 1, ry = h / 2 - 1, sp = 11; // spike length
  const n = Math.max(14, Math.round((w + h) / 11));
  ctx.save();
  ctx.fillStyle = '#e4e8f2'; ctx.strokeStyle = '#4c5168'; ctx.lineWidth = 1.2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, da = Math.PI / n * 0.8;
    const bx = (aa: number) => cx + Math.cos(aa) * (rx - sp * 1.05), by = (aa: number) => cy + Math.sin(aa) * (ry - sp * 1.05);
    // outward normal of the ellipse at angle a
    let nx = Math.cos(a) / rx, ny = Math.sin(a) / ry; const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
    ctx.beginPath(); ctx.moveTo(bx(a - da), by(a - da)); ctx.lineTo(cx + Math.cos(a) * (rx - 1) + nx * 0, cy + Math.sin(a) * (ry - 1) + ny * 0); ctx.lineTo(bx(a + da), by(a + da)); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  const g = ctx.createLinearGradient(cx, cy - ry, cx, cy + ry);
  g.addColorStop(0, '#7b829e'); g.addColorStop(1, '#2f3347');
  ctx.fillStyle = g; ctx.strokeStyle = '#1b1e2c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx - sp, ry - sp, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.ellipse(cx - rx * 0.15, cy - ry * 0.25, (rx - sp) * 0.5, Math.max(2, (ry - sp) * 0.25), 0, 0, Math.PI * 2); ctx.fill();
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
    // restrained pre-fire cue: a small glint at the muzzle, not a beam across the level
    if (o.state === 'warn') { const g = ctx.createRadialGradient(cx + face * 24, cy - 7, 0, cx + face * 24, cy - 7, 9); g.addColorStop(0, 'rgba(255,230,200,.95)'); g.addColorStop(1, 'rgba(255,120,80,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx + face * 24, cy - 7, 9, 0, Math.PI * 2); ctx.fill(); }
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

// ---------------------------------------------------------------- kinematic platforms
/** Shuttle Block body: teal metal deck with chevrons pointing the way it is travelling. */
export function drawShuttleBody(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, dir: { x: number; y: number }, owner: string, t: number, ghost = false) {
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#1f9e90'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#7ff0e0'; ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 7);
  ctx.fillStyle = '#0f4a44'; ctx.fillRect(r.x, r.y + r.h - 7, r.w, 7);
  ctx.fillStyle = 'rgba(220,255,250,0.75)';
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2 + 2;
  const off = ((t * 1.6) % 1) * 10;
  for (let i = -1; i <= 1; i++) {
    const k = i * 14 + off - 5;
    const px = cx + dir.x * k, py = cy + dir.y * k;
    ctx.beginPath();
    ctx.moveTo(px + dir.x * 6, py + dir.y * 6);
    ctx.lineTo(px - dir.y * 7 - dir.x * 3, py + dir.x * 7 - dir.y * 3);
    ctx.lineTo(px + dir.y * 7 - dir.x * 3, py - dir.x * 7 - dir.y * 3);
    ctx.fill();
  }
  // readable outline on every background, then the owner's colour
  ctx.strokeStyle = 'rgba(8,16,24,0.85)'; ctx.lineWidth = 3; ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
  ctx.strokeStyle = owner; ctx.lineWidth = 2; ctx.strokeRect(r.x + 3.5, r.y + 3.5, r.w - 7, r.h - 7);
  ctx.restore();
}

/** One Ferris wheel gondola: a warm, level seat platform. index 0 carries a small marker so the starting phase reads. */
export function drawGondola(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, owner: string, index: number, ghost = false) {
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#e8932e'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#ffe08a'; ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 7);
  ctx.fillStyle = '#7a4a12'; ctx.fillRect(r.x, r.y + r.h - 7, r.w, 7);
  ctx.fillStyle = 'rgba(122,74,18,0.6)';
  for (let i = 1; i < 4; i++) { if (r.w > r.h) ctx.fillRect(r.x + (r.w * i) / 4 - 1, r.y + 12, 2, r.h - 20); else ctx.fillRect(r.x + 12, r.y + (r.h * i) / 4 - 1, r.w - 24, 2); }
  if (index === 0) { ctx.fillStyle = '#fff6d8'; ctx.beginPath(); ctx.arc(r.x + r.w / 2, r.y + r.h / 2 + 3, 5, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(8,16,24,0.85)'; ctx.lineWidth = 3; ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
  ctx.strokeStyle = owner; ctx.lineWidth = 2; ctx.strokeRect(r.x + 3.5, r.y + 3.5, r.w - 7, r.h - 7);
  ctx.restore();
}

/** The wheel's hub and spokes: decoration only (no collision), drawn thin and translucent behind the gondolas. */
export function drawWheelHub(ctx: CanvasRenderingContext2D, px: number, py: number, centres: { x: number; y: number }[], owner: string, angle: number, ghost = false) {
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'rgba(230,236,255,0.35)'; ctx.lineWidth = 3;
  for (const c of centres) { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(c.x, c.y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(230,236,255,0.18)'; ctx.lineWidth = 2;
  if (centres.length) { const R = Math.hypot(centres[0].x - px, centres[0].y - py); ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.stroke(); }
  ctx.translate(px, py); ctx.rotate(angle);
  ctx.fillStyle = '#3b3f52'; ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9cfe0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = owner; ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9cfe0'; for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(10, 0); ctx.stroke(); }
  ctx.restore();
}

/** Card thumbnail: the item at rotation 0 with its exact footprint on a small grid. */
export function drawCardPreview(canvas: HTMLCanvasElement, itemId: string, t = 0) {
  const def = getItem(itemId);
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (def.kind === 'shuttle' || def.kind === 'wheel') { drawMoverCard(ctx, def.kind, W, H, t); return; }
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

/** Card art for the moving platforms: the whole lane or orbit at true scale, animated, with the exact 2x1 bodies. */
function drawMoverCard(ctx: CanvasRenderingContext2D, kind: 'shuttle' | 'wheel', W: number, H: number, t: number) {
  const cellsW = kind === 'shuttle' ? 2 + MOVERS.shuttleTravelCells + 1 : MOVERS.wheelRadiusCells * 2 + 3;
  const cellsH = kind === 'shuttle' ? 3 : MOVERS.wheelRadiusCells * 2 + 2;
  const scale = Math.min(W / (cellsW * C), H / (cellsH * C));
  ctx.save();
  ctx.translate((W - cellsW * C * scale) / 2, (H - cellsH * C * scale) / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1 / scale;
  for (let x = 0; x <= cellsW; x++) { ctx.beginPath(); ctx.moveTo(x * C, 0); ctx.lineTo(x * C, cellsH * C); ctx.stroke(); }
  for (let y = 0; y <= cellsH; y++) { ctx.beginPath(); ctx.moveTo(0, y * C); ctx.lineTo(cellsW * C, y * C); ctx.stroke(); }
  if (kind === 'shuttle') {
    const lane = 2 + MOVERS.shuttleTravelCells;
    ctx.fillStyle = 'rgba(127,240,224,.12)'; ctx.fillRect(0.5 * C, C, lane * C, C);
    ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(127,240,224,.6)'; ctx.lineWidth = 3; ctx.strokeRect(0.5 * C, C, lane * C, C); ctx.setLineDash([]);
    const off = (MOVERS.shuttleTravelCells * C * (1 - Math.cos((2 * Math.PI * t * 60) / MOVERS.shuttlePeriodTicks))) / 2;
    const dir = Math.sin((2 * Math.PI * t * 60) / MOVERS.shuttlePeriodTicks) >= 0 ? 1 : -1;
    drawShuttleBody(ctx, { x: 0.5 * C + off, y: C, w: 2 * C, h: C }, { x: dir, y: 0 }, '#ffd25e', t);
  } else {
    const R = MOVERS.wheelRadiusCells * C, px = (cellsW * C) / 2, py = (cellsH * C) / 2;
    const a0 = (2 * Math.PI * t * 60) / MOVERS.wheelPeriodTicks;
    const rects = [0, 1, 2, 3].map(i => { const a = a0 + (i * Math.PI) / 2; return { x: px + Math.cos(a) * R - C, y: py + Math.sin(a) * R - C / 2, w: 2 * C, h: C }; });
    drawWheelHub(ctx, px, py, rects.map(r => ({ x: r.x + C, y: r.y + C / 2 })), '#ffd25e', a0);
    rects.forEach((r, i) => drawGondola(ctx, r, '#ffd25e', i));
  }
  ctx.restore();
}
