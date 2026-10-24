// Local settings, profile and key bindings. Storage can be unavailable (private mode), so every access is guarded.

export type Action = 'left' | 'right' | 'jump' | 'sprint' | 'down' | 'rotate' | 'flip' | 'confirm' | 'menu' | 'zoom' | 'retry' | 'spectNext' | 'emote' | 'sandboxMenu';
export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'left', label: 'Move left' }, { id: 'right', label: 'Move right' }, { id: 'jump', label: 'Jump / wall jump' },
  { id: 'sprint', label: 'Sprint (hold)' }, { id: 'down', label: 'Down (drops through one-way platforms)' },
  { id: 'rotate', label: 'Rotate item' }, { id: 'flip', label: 'Flip sniper facing' }, { id: 'confirm', label: 'Confirm placement' },
  { id: 'zoom', label: 'Build zoom' }, { id: 'retry', label: 'Practice: instant retry' }, { id: 'spectNext', label: 'Spectate next player' },
  { id: 'emote', label: 'Emote wheel (hold, scroll to choose, release)' }, { id: 'sandboxMenu', label: 'Sandbox: item menu' },
  { id: 'menu', label: 'Menu / cancel' },
];

export const DEFAULT_BINDS: Record<Action, string[]> = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], jump: ['Space', 'KeyW', 'ArrowUp'], sprint: ['ShiftLeft', 'ShiftRight'],
  down: ['KeyS', 'ArrowDown'], rotate: ['KeyR', 'KeyQ'], flip: ['KeyF'], confirm: ['Enter', 'KeyE'], menu: ['Escape'], zoom: ['KeyZ'],
  retry: ['KeyT'], spectNext: ['Tab'], emote: ['KeyG'], sandboxMenu: ['KeyM'],
};

export interface Settings {
  name: string; skin: number; music: number; sfx: number; reducedMotion: boolean; particles: 'low' | 'medium' | 'high';
  binds: Record<Action, string[]>; devOverlay: boolean; touch: 'auto' | 'on' | 'off'; token?: string; tokenRoom?: string;
}

const KEY = 'trapRace.settings.v1';
const prefersReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const defaults = (): Settings => ({
  name: '', skin: Math.floor(Math.random() * 16), music: 0.35, sfx: 0.7, reducedMotion: prefersReduced, particles: 'medium',
  binds: structuredClone(DEFAULT_BINDS), devOverlay: false, touch: 'auto',
});

function load(): Settings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return { ...d, ...s, binds: { ...d.binds, ...(s.binds ?? {}) } };
  } catch { return d; }
}

export const settings: Settings = load();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = { Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ShiftLeft: 'Shift', ShiftRight: 'R-Shift', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab' };
  return map[code] ?? code;
}
