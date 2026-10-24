import './style.css';
import { CELL, fmtPts, SCORING } from '../../shared/config';
import { getItem } from '../../shared/items';
import type { RaceEvent } from '../../shared/race';
import { sfx, startMusic, unlockAudio } from './audio';
import { PLAYER_COLORS } from './art';
import { GameClient } from './game';
import { clearPressed, initInput, isDown, setGameKeysActive } from './input';
import { Renderer } from './render';
import { settings, saveSettings } from './store';
import { animatePreviews, UI } from './ui';
import type { LocalTransport } from './net';
import { applyPlacement, checkPlacement, makeObject } from '../../shared/placement';
import { gustIn, tsunamiIn } from '../../shared/mapfx';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const root = document.getElementById('ui')!;
const game = new GameClient();
const renderer = new Renderer(canvas);
const ui = new UI(root, game);

game.onChange = () => ui.render();
game.onSessionEnded = () => { if (!game.code) { game.closeTransport(); ui.go(new URLSearchParams(location.search).get('room') ? 'join' : 'menu'); } };
ui.onPracticeRetry = () => (game.transport as LocalTransport | null)?.retry?.();
ui.onZoom = () => { renderer.buildZoom = renderer.buildZoom > 1 ? 1 : 2.2; };

// ------------------------------------------------ sound and effects from game events
let lastWarn = 0;
let alarmed = '';
game.onEvent = (e: RaceEvent | { type: string; [k: string]: unknown }) => {
  const sim = game.localSim() ?? game.race;
  const colorOf = (id: string) => PLAYER_COLORS[(game.member(id)?.color ?? 0) % PLAYER_COLORS.length];
  switch (e.type) {
    case 'countdown': sfx.count(); break;
    case 'go': sfx.go(); break;
    case 'localJump': (e as { wall?: boolean }).wall ? sfx.wallJump() : sfx.jump(); break;
    case 'localLand': sfx.land(); break;
    case 'claimed': sfx.place(); break;
    case 'deny': sfx.deny(); break;
    case 'placed': {
      const o = e as unknown as { obj: { cells: [number, number][] }; by: string };
      sfx.place();
      for (const [x, y] of o.obj.cells.slice(0, 4)) renderer.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, 6, colorOf(o.by), 120, 300, 3);
      break;
    }
    case 'bomb': {
      sfx.bomb();
      for (const [x, y] of (e as unknown as { cells: [number, number][] }).cells) renderer.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, 16, '#ff9b4a', 300, 400, 4);
      break;
    }
    case 'results': sfx.results(); break;
    case 'death': {
      const d = e as Extract<RaceEvent, { type: 'death' }>;
      sfx.deathBy(d.cause);
      // which way the blow came from (launchers, blades), where the void or water is, which hole pulled them in
      const src = d.src ? game.world?.objects.get(d.src) : undefined;
      let dx = 0, dy = 0, rx: number | undefined, ry: number | undefined;
      const by = d.y, mh = (game.world?.h ?? 0) * CELL;
      if (src) { const sx = src.x * CELL + CELL / 2, sy = src.y * CELL + CELL / 2, l = Math.hypot(d.x - sx, by - sy) || 1; dx = (d.x - sx) / l; dy = (by - sy) / l; if (d.cause === 'blackhole' || d.cause === 'ghost') { rx = sx; ry = sy; } }
      const ex = (e as { fx?: { dx?: number; dy?: number; ry?: number } }).fx;
      if (ex) { dx = ex.dx ?? dx; dy = ex.dy ?? dy; ry = ex.ry ?? ry; }
      if (d.cause === 'fall' || d.cause === 'pull-fall') ry = mh - 30;
      renderer.addDeath({ cause: d.cause, x: d.x, y: Math.min(by, mh - 20), color: colorOf(d.pid), skin: game.member(d.pid)?.skin ?? 0, dx, dy, rx, ry });
      const how: Record<string, string> = { crush: 'Crushed', drown: 'You drowned', tsunami: 'Swept away by the tsunami', ghost: 'The ghost got you', dart: 'Darted', lava: 'Burned in the lava', geyser: 'Blasted by a geyser', fall: 'You fell!' };
      if (d.pid === game.you) game.toast(d.credit ? `${how[d.cause] ?? 'Eliminated'} by ${game.member(d.credit)?.name ?? 'a'}'s ${d.cause === 'crush' ? 'platform' : 'trap'}` : how[d.cause] ?? 'Eliminated', 'bad');
      else if (d.credit === game.you) game.toast(`Your ${d.cause === 'crush' ? 'platform crushed' : 'trap got'} ${game.member(d.pid)?.name}! +${fmtPts(SCORING.trapElim)}`, 'good');
      break;
    }
    case 'finish': {
      const f = e as Extract<RaceEvent, { type: 'finish' }>;
      sfx.finish();
      const p = sim?.player(f.pid);
      if (p) for (let i = 0; i < 4; i++) renderer.burst(p.body.x + 14, p.body.y, 12, PLAYER_COLORS[i * 2], 280, 500, 4);
      if (f.pid === game.you) game.toast(`Finished in ${(f.tick / 60).toFixed(2)}s!`, 'good');
      break;
    }
    case 'bank': if ((e as { pid: string }).pid === game.you) { sfx.bank(); game.toast(`Coin banked! +${fmtPts(SCORING.coin)}`, 'good'); } break;
    case 'coin': {
      const c = e as Extract<RaceEvent, { type: 'coin' }>;
      if (c.action === 'pickup') { sfx.coin(); if (c.pid === game.you) game.toast('Coin picked up: carry it to the flag', 'info', 2200); }
      break;
    }
    case 'power': { sfx.power(); const pw = e as Extract<RaceEvent, { type: 'power' }>; if (pw.pid === game.you) game.toast(`${pw.power === 'slow' ? 'Slow pulse: timed traps slowed' : pw.power[0].toUpperCase() + pw.power.slice(1) + ' boost'}!`, 'good', 1800); break; }
    case 'shield': { sfx.shield(); const p = sim?.player((e as { pid: string }).pid); if (p) renderer.burst(p.body.x + 14, p.body.y + 21, 18, '#7aa8ff', 220, 0, 3); break; }
    case 'spring': sfx.spring(); break;
    case 'fire': {
      const f = e as Extract<RaceEvent, { type: 'fire' }>;
      const o = game.world?.objects.get(f.src);
      if (o && renderer.cam) {
        const kind = getItem(o.item).kind;
        if (kind === 'sniper') sfx.sniper(); else sfx.fire();
        renderer.burst(o.x * CELL + CELL / 2, o.y * CELL + CELL / 2, 5, '#fff3c0', 90, 0, 3);
      }
      break;
    }
    case 'emote': sfx.click(); break;
    case 'crumple': { const c = e as Extract<RaceEvent, { type: 'crumple' }>; sfx.crumple(); renderer.addCrumple(c.x, c.y, c.hx, c.hy); break; }
    case 'plane': break;
    case 'ghost': {
      const gh = e as Extract<RaceEvent, { type: 'ghost' }>;
      sfx.deathBy('ghost');
      if (gh.pid === game.you) game.toast('A ghost is coming for you! Reach the flag to lose it', 'bad', 3500);
      break;
    }
    case 'shot': renderer.addTracer((e as Extract<RaceEvent, { type: 'shot' }>).pts); break;
    case 'absorb': { const a = e as Extract<RaceEvent, { type: 'absorb' }>; renderer.burst(a.x, a.y, 8, '#ff3bd0', 90, 0, 2.5); break; }
    case 'crumble': {
      const c = e as Extract<RaceEvent, { type: 'crumble' }>;
      const o = game.world?.objects.get(c.obj);
      if (o) {
        if (c.hp === 0) renderer.addDebris(o.cells, '#a58868'); // the whole platform falls away
        for (const [x, y] of o.cells) renderer.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, c.hp === 0 ? 10 : 4, '#b59a7a', 120, 500, c.hp === 0 ? 4 : 3);
      }
      break;
    }
    default: break;
  }
};

// ------------------------------------------------ keyboard actions
// emotes: hold the emote key to open the wheel, scroll the mouse wheel to choose, release to play (cosmetic only)
window.addEventListener('wheel', e => {
  if (!ui.emoteWheel.open) return;
  e.preventDefault();
  ui.scrollEmote(e.deltaY > 0 ? 1 : -1);
}, { passive: false, capture: true });

initInput((a, ev) => {
  unlockAudio();
  if (ui.screen !== 'game') return;
  if (a === 'emote') { if (ui.emoteWheel.open && !ui.emoteWheel.viaKey) ui.closeEmoteWheel(true); else ui.openEmoteWheel(true); return; }
  if (game.sandbox) {
    // sandbox: M opens the item menu, T respawns, Esc backs out of placing or the menu before pausing
    if (a === 'sandboxMenu') { game.toggleSandboxMenu(); sfx.click(); return; }
    if (a === 'retry') { game.sandboxRespawn(); return; }
    if (a === 'menu' && (game.sandbox.menu || game.sandbox.placing)) { if (game.sandbox.menu) game.toggleSandboxMenu(); else game.sandboxPick(null); return; }
  }
  if (a === 'menu') {
    if (ui.emoteWheel.open) { ui.closeEmoteWheel(false); return; }
    if (game.rehearsal) { game.stopRehearsal(); return; }
    ui.setPaused(!ui.paused);
    return;
  }
  if (ui.paused) return;
  if (game.isBuilding()) {
    if (a === 'rotate') { game.rotate(ev.shiftKey ? -1 : 1); sfx.click(); }
    if (a === 'flip') { game.flip(); sfx.click(); }
    if (a === 'confirm') game.confirmPlace();
    if (a === 'zoom') ui.onZoom();
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = arrows[ev.code];
    if (d) { game.setCursor(game.cursor.x + d[0], game.cursor.y + d[1]); ui.render(); }
    if (ev.code === 'Space') game.confirmPlace();
  }
  if (game.phase === 'race' && a === 'spectNext' && !game.sandbox) game.spectateIdx++;
  if (game.phase === 'race' && a === 'retry' && game.isPractice) ui.onPracticeRetry();
});

// ------------------------------------------------ pointer for building (same grid as the server)
// Mouse: the preview follows the pointer and a click places. Touch: tap a cell to aim there, or drag anywhere to
// nudge the preview cell by cell (works when zoomed in and keeps your finger off the preview); the Place button confirms.
let drag: { id: number; sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
const building = () => game.isBuilding() && ui.screen === 'game';
canvas.addEventListener('pointermove', e => {
  if (!building()) return;
  if (e.pointerType === 'mouse') {
    const c = renderer.screenToCell(e.clientX, e.clientY);
    game.setCursor(c.x, c.y);
    ui.render();
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 10) return;
  drag.moved = true;
  const cellPx = CELL * renderer.cam.zoom;
  game.setCursor(drag.cx + Math.round(dx / cellPx), drag.cy + Math.round(dy / cellPx));
  ui.render();
});
canvas.addEventListener('pointerdown', e => {
  unlockAudio(); startMusic();
  if (!building()) return;
  if (e.pointerType !== 'mouse') {
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: game.cursor.x, cy: game.cursor.y, moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    return;
  }
  if (e.button === 2) { game.rotate(1); sfx.click(); ui.render(); return; }
  const c = renderer.screenToCell(e.clientX, e.clientY);
  game.setCursor(c.x, c.y);
  game.confirmPlace();
});
const endDrag = (e: PointerEvent) => {
  if (!drag || drag.id !== e.pointerId) return;
  if (!drag.moved && building()) {
    const c = renderer.screenToCell(e.clientX, e.clientY);
    game.setCursor(c.x, c.y);
    sfx.click();
    ui.render();
  }
  drag = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', e => { if (drag?.id === e.pointerId) drag = null; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  if (!game.isBuilding()) return;
  e.preventDefault();
  renderer.buildZoom = Math.max(1, Math.min(3, renderer.buildZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
}, { passive: false });
// keep browsers from scrolling or zooming the page while playing
document.addEventListener('touchmove', e => { if (ui.screen === 'game' && (e.target as HTMLElement).tagName === 'CANVAS') e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());

// ------------------------------------------------ main loop
let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  setGameKeysActive(ui.screen === 'game' && (game.phase === 'race' || game.phase === 'build' || game.phase === 'countdown' || !!game.sandbox));
  if (!ui.paused || (!game.isPractice && !game.sandbox)) game.update(dt * 1000);
  const bar = game.isBuilding() ? document.querySelector('.buildbar') : null;
  renderer.insetBottom = bar ? window.innerHeight - bar.getBoundingClientRect().top + 6 : 0;
  const hudTop = document.querySelector('.hud-top');
  renderer.insetTop = hudTop && game.isBuilding() ? hudTop.getBoundingClientRect().bottom + 4 : 0;
  // a wheel opened by holding the emote key plays its selection when the key is let go
  if (ui.emoteWheel.open && ui.emoteWheel.viaKey && !isDown('emote')) ui.closeEmoteWheel(true);
  renderer.frame(game, dt);
  ui.render();
  animatePreviews(now / 1000);
  // map hazard alarms: a siren before every tsunami, a howl before every sandstorm gust
  {
    const sim = game.localSim() ?? (game.phase === 'race' ? game.race : null);
    const fx = game.world?.map.fx;
    if (sim && fx) {
      const tk = sim.tick;
      if (fx.tsunami) { const tin = tsunamiIn(fx, tk); const key = Math.floor((tk / 60 - fx.tsunami.start) / (fx.tsunami.on + fx.tsunami.off)); if (tin !== null && tin <= fx.tsunami.warn && alarmed !== `t${key}`) { alarmed = `t${key}`; sfx.siren(); } }
      if (fx.gusts) { const gin = gustIn(game.world!.map, tk); const key = Math.floor((tk / 60 - fx.gusts.start) / fx.gusts.period); if (gin !== null && gin <= fx.gusts.warn && alarmed !== `g${key}`) { alarmed = `g${key}`; sfx.howl(); } }
    }
  }
  // timed-trap warning tick for the local player's nearby sniper warnings
  if (game.race && game.phase === 'race' && now - lastWarn > 2500 && [...(game.world?.objects.values() ?? [])].some(o => getItem(o.item).kind === 'sniper')) {
    const t = (game.race.tick / 60) % 2.5;
    if (t > 2.1) { sfx.warn(); lastWarn = now; }
  }
  clearPressed();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ------------------------------------------------ boot: invite links and saved sessions
window.addEventListener('pointerdown', () => { unlockAudio(); startMusic(); }, { once: true });
window.addEventListener('keydown', () => { unlockAudio(); startMusic(); }, { once: true });
const params = new URLSearchParams(location.search);
const invite = params.get('room');
let hadToken = false;
try { hadToken = !!sessionStorage.getItem('trapRace.token'); } catch { /* ignore */ }
if (hadToken) {
  // a refresh mid-match rejoins with the same identity (falls back to the menu if the session ended)
  void game.connectOnline().then(() => ui.go('game'));
  ui.go('connecting');
} else if (invite) {
  if (!settings.name) { settings.name = `Player${Math.floor(Math.random() * 900 + 100)}`; saveSettings(); }
  ui.go('join');
} else ui.go('menu');

// debug handle used by the browser tests (placement helpers let them set up courses directly)
(window as unknown as { __trap: unknown }).__trap = { game, ui, renderer, dev: { checkPlacement, makeObject, applyPlacement } };
