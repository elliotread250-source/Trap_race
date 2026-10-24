// Synthesised sound effects and a small procedural music loop. Audio starts after the first user gesture.
import { settings } from './store';

let ctx: AudioContext | null = null;
let sfxGain: GainNode | null = null;
let musicGain: GainNode | null = null;
let musicTimer: number | null = null;
let musicStep = 0;

export function unlockAudio() {
  if (ctx) { if (ctx.state === 'suspended') void ctx.resume(); return; }
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    sfxGain = ctx.createGain(); sfxGain.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.connect(ctx.destination);
    applyVolumes();
  } catch { ctx = null; }
}

export function applyVolumes() {
  if (sfxGain) sfxGain.gain.value = settings.sfx * 0.5;
  if (musicGain) musicGain.gain.value = settings.music * 0.22;
}

function tone(freq: number, dur: number, type: OscillatorType = 'square', vol = 0.3, slide = 0, delay = 0) {
  if (!ctx || !sfxGain || settings.sfx <= 0) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(sfxGain);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur: number, vol = 0.3, hp = 600) {
  if (!ctx || !sfxGain || settings.sfx <= 0) return;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(sfxGain);
  src.start();
}

export const sfx = {
  count: () => tone(520, 0.14, 'square', 0.25),
  go: () => { tone(780, 0.25, 'square', 0.3); tone(1170, 0.25, 'triangle', 0.2, 0, 0.05); },
  jump: () => tone(380, 0.11, 'square', 0.12, 260),
  wallJump: () => tone(460, 0.12, 'square', 0.14, 340),
  land: () => noise(0.05, 0.08, 1200),
  warn: () => tone(1320, 0.06, 'sine', 0.1),
  fire: () => noise(0.12, 0.18, 300),
  sniper: () => { noise(0.08, 0.25, 2000); tone(200, 0.1, 'sawtooth', 0.1, -120); },
  impact: () => noise(0.1, 0.2, 200),
  death: () => { tone(300, 0.35, 'sawtooth', 0.22, -240); noise(0.25, 0.2, 400); },
  power: () => { tone(660, 0.1, 'triangle', 0.2); tone(990, 0.15, 'triangle', 0.2, 0, 0.08); },
  shield: () => tone(880, 0.25, 'sine', 0.25, -400),
  coin: () => { tone(988, 0.08, 'square', 0.15); tone(1319, 0.14, 'square', 0.15, 0, 0.07); },
  bank: () => { tone(1319, 0.1, 'square', 0.15); tone(1760, 0.2, 'square', 0.15, 0, 0.08); },
  finish: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.18, 0, i * 0.09)); },
  results: () => { [392, 523, 659].forEach((f, i) => tone(f, 0.25, 'triangle', 0.2, 0, i * 0.12)); },
  place: () => { tone(240, 0.08, 'square', 0.2); noise(0.06, 0.12, 800); },
  bomb: () => { noise(0.5, 0.4, 80); tone(90, 0.4, 'sawtooth', 0.25, -50); },
  click: () => tone(700, 0.04, 'square', 0.1),
  deny: () => tone(180, 0.15, 'square', 0.18, -40),
  spring: () => tone(300, 0.2, 'triangle', 0.25, 600),
  /** a distinct sound per cause of death (falls back to the generic one) */
  deathBy: (cause: string) => {
    switch (cause) {
      case 'crush': noise(0.18, 0.35, 120); tone(90, 0.2, 'square', 0.25, -40); break;
      case 'sniper': case 'arrow': noise(0.06, 0.3, 2500); tone(500, 0.18, 'sawtooth', 0.15, -380); break;
      case 'dart': tone(1400, 0.05, 'square', 0.12); tone(320, 0.3, 'triangle', 0.18, -180, 0.04); break;
      case 'cannon': noise(0.6, 0.45, 60); tone(70, 0.5, 'sawtooth', 0.3, -40); break;
      case 'rspikes': tone(900, 0.06, 'square', 0.2); noise(0.12, 0.25, 900); break;
      case 'wire': for (let i = 0; i < 4; i++) tone(1800 + i * 300, 0.04, 'square', 0.08, -600, i * 0.03); noise(0.15, 0.15, 3000); break;
      case 'oval': tone(700, 0.08, 'triangle', 0.25, 600); noise(0.1, 0.25, 1500); break;
      case 'fall': case 'pull-fall': tone(600, 0.9, 'sine', 0.22, -540); break;
      case 'drown': for (let i = 0; i < 5; i++) tone(300 + i * 90, 0.08, 'sine', 0.15, 200, i * 0.09); break;
      case 'tsunami': noise(0.9, 0.35, 200); tone(140, 0.8, 'sine', 0.2, -60); break;
      case 'ghost': tone(500, 0.7, 'sine', 0.2, -300); tone(760, 0.7, 'sine', 0.12, -420, 0.1); break;
      case 'lava': case 'geyser': noise(0.5, 0.3, 400); tone(200, 0.4, 'sawtooth', 0.15, -120); break;
      default: tone(300, 0.35, 'sawtooth', 0.22, -240); noise(0.25, 0.2, 400);
    }
  },
  siren: () => { for (let i = 0; i < 3; i++) { tone(620, 0.22, 'square', 0.18, 300, i * 0.5); tone(920, 0.22, 'square', 0.18, -300, i * 0.5 + 0.25); } },
  crumple: () => noise(0.12, 0.18, 1800),
};

// four-bar loop: bass + arpeggio, deliberately light so effects stay readable
const BASS = [45, 45, 52, 52, 50, 50, 48, 47];
const ARP = [0, 7, 12, 7, 3, 7, 12, 15];
export function startMusic() {
  if (!ctx || musicTimer !== null) return;
  const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
  musicTimer = window.setInterval(() => {
    if (!ctx || !musicGain || settings.music <= 0) return;
    const t = ctx.currentTime;
    const bar = Math.floor(musicStep / 8) % BASS.length;
    const root = BASS[bar];
    const play = (note: number, dur: number, type: OscillatorType, vol: number) => {
      const o = ctx!.createOscillator(); const g = ctx!.createGain();
      o.type = type; o.frequency.value = midi(note);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(musicGain!); o.start(t); o.stop(t + dur + 0.02);
    };
    if (musicStep % 2 === 0) play(root - 12, 0.22, 'triangle', 0.5);
    play(root + 12 + ARP[musicStep % 8], 0.1, 'square', 0.12);
    musicStep++;
  }, 150);
}
export function stopMusic() { if (musicTimer !== null) { clearInterval(musicTimer); musicTimer = null; } }
