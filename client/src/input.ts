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

export function touchSupported(): boolean {
  if (settings.touch === 'on') return true;
  if (settings.touch === 'off') return false;
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0) && matchMedia('(pointer: coarse)').matches;
}

/** On-screen controls for movement, jump and a separate sprint button. */
export function buildTouchControls(root: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'touch';
  const mk = (label: string, key: keyof typeof touch, style: string) => {
    const b = document.createElement('div');
    b.className = 'tbtn'; b.textContent = label; b.setAttribute('style', style); b.setAttribute('role', 'button'); b.setAttribute('aria-label', key);
    const on = (e: Event) => { e.preventDefault(); touch[key] = true; b.classList.add('on'); lastDevice = 'touch'; };
    const off = (e: Event) => { e.preventDefault(); touch[key] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
    wrap.appendChild(b);
  };
  mk('◀', 'left', 'left:16px');
  mk('▶', 'right', 'left:104px');
  mk('▼', 'down', 'left:60px;bottom:100px;width:56px;height:56px');
  mk('JUMP', 'jump', 'right:16px;width:86px;height:86px');
  mk('RUN', 'sprint', 'right:116px');
  root.appendChild(wrap);
  return wrap;
}
