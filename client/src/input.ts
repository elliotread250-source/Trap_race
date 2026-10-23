// Keyboard (rebindable), touch buttons and gamepad, merged into the same input bits the server simulates.
import { IN_DOWN, IN_JUMP, IN_LEFT, IN_RIGHT, IN_SPRINT } from '../../shared/physics';
import { settings, type Action } from './store';

const held = new Set<string>();
const pressedOnce = new Set<Action>();
const touch = { left: false, right: false, jump: false, sprint: false, down: false };
let captureKey: ((code: string) => void) | null = null;
export let lastDevice: 'keyboard' | 'touch' | 'gamepad' = 'keyboard';
let gameKeysActive = false;

export function setGameKeysActive(v: boolean) { gameKeysActive = v; }

function actionFor(code: string): Action[] {
  const out: Action[] = [];
  for (const [a, codes] of Object.entries(settings.binds) as [Action, string[]][]) if (codes.includes(code)) out.push(a);
  return out;
}

export function initInput(onAction: (a: Action, e: KeyboardEvent) => void) {
  window.addEventListener('keydown', e => {
    if (captureKey) { e.preventDefault(); const f = captureKey; captureKey = null; f(e.code); return; }
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    if (typing) { if (e.code === 'Escape') (target as HTMLElement).blur(); return; }
    lastDevice = 'keyboard';
    const acts = actionFor(e.code);
    // stop page scrolling / focus jumps while playing
    if (gameKeysActive && (acts.length || ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code))) e.preventDefault();
    if (!e.repeat) for (const a of acts) { pressedOnce.add(a); onAction(a, e); }
    held.add(e.code);
  });
  window.addEventListener('keyup', e => { held.delete(e.code); });
  // focus loss must never leave a key "held"
  const releaseAll = () => { held.clear(); for (const k of Object.keys(touch) as (keyof typeof touch)[]) touch[k] = false; };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
}

export function captureNextKey(f: (code: string) => void) { captureKey = f; }

export function isDown(a: Action): boolean {
  for (const c of settings.binds[a]) if (held.has(c)) return true;
  return false;
}

export function consumePressed(a: Action): boolean { const had = pressedOnce.has(a); pressedOnce.delete(a); return had; }
export function clearPressed() { pressedOnce.clear(); }

let padPrevJump = false;
export function pollGamepad(): number {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let bits = 0;
  for (const p of pads) {
    if (!p) continue;
    const ax = p.axes[0] ?? 0;
    const b = (i: number) => !!p.buttons[i]?.pressed;
    if (ax < -0.35 || b(14)) bits |= IN_LEFT;
    if (ax > 0.35 || b(15)) bits |= IN_RIGHT;
    if ((p.axes[1] ?? 0) > 0.5 || b(13)) bits |= IN_DOWN;
    if (b(0)) bits |= IN_JUMP;
    if (b(2) || b(7) || b(5)) bits |= IN_SPRINT;
    if (bits) lastDevice = 'gamepad';
  }
  padPrevJump = (bits & IN_JUMP) !== 0;
  void padPrevJump;
  return bits;
}

export function inputBits(): number {
  let bits = 0;
  if (isDown('left') || touch.left) bits |= IN_LEFT;
  if (isDown('right') || touch.right) bits |= IN_RIGHT;
  if (isDown('jump') || touch.jump) bits |= IN_JUMP;
  if (isDown('sprint') || touch.sprint) bits |= IN_SPRINT;
  if (isDown('down') || touch.down) bits |= IN_DOWN;
  bits |= pollGamepad();
  return bits;
}

let sawTouch = false;
if (typeof window !== 'undefined') {
  window.addEventListener('touchstart', () => { sawTouch = true; lastDevice = 'touch'; }, { passive: true, capture: true });
  window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') { sawTouch = true; lastDevice = 'touch'; } }, { capture: true });
}

/** True on phones/tablets (or any device that has been touched); Settings can force it on or off. */
export function touchSupported(): boolean {
  if (settings.touch === 'on') return true;
  if (settings.touch === 'off') return false;
  if (sawTouch) return true;
  if (typeof window === 'undefined') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
}

/** On-screen controls: left/right pad, down, a big JUMP and a separate RUN (sprint) button. Multi-touch. */
export function buildTouchControls(root: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'touch';
  const mk = (label: string, key: keyof typeof touch, cls: string) => {
    const b = document.createElement('div');
    b.className = `tbtn ${cls}`; b.textContent = label; b.setAttribute('role', 'button'); b.setAttribute('aria-label', key);
    const active = new Set<number>();
    const sync = () => { touch[key] = active.size > 0; b.classList.toggle('on', touch[key]); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); active.add(e.pointerId); try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ } lastDevice = 'touch'; sync(); });
    const end = (e: PointerEvent) => { e.preventDefault(); active.delete(e.pointerId); sync(); };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end); b.addEventListener('lostpointercapture', end);
    b.addEventListener('contextmenu', e => e.preventDefault());
    wrap.appendChild(b);
  };
  mk('◀', 'left', 't-left');
  mk('▶', 'right', 't-right');
  mk('▼', 'down', 't-down');
  mk('RUN', 'sprint', 't-run');
  mk('JUMP', 'jump', 't-jump');
  root.appendChild(wrap);
  return wrap;
}

export function releaseTouch() { for (const k of Object.keys(touch) as (keyof typeof touch)[]) touch[k] = false; }
