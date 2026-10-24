// DOM interface. Names and other player text are always set with textContent, never parsed as HTML.
import { EMOTES, fmtPts, GAME_TITLE, HAZARD, MATCH, MOVERS, POWER, SCORING, TIMERS, type Difficulty } from '../../shared/config';
import { getItem, ITEM_LIST } from '../../shared/items';
import { MAP_LIST } from '../../shared/maps';
import { World } from '../../shared/world';
import { gustIn, tsunamiIn } from '../../shared/mapfx';
import { drawCardPreview, drawCharacter, PLAYER_COLORS, SKINS } from './art';
import { applyVolumes, sfx, unlockAudio } from './audio';
import type { GameClient } from './game';
import { buildTouchControls, captureNextKey, releaseTouch, touchSupported } from './input';
import { Renderer } from './render';
import { ACTIONS, DEFAULT_BINDS, keyLabel, saveSettings, settings } from './store';

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

type Screen = 'menu' | 'join' | 'ai' | 'practice' | 'sandbox' | 'howto' | 'skins' | 'settings' | 'game' | 'connecting';

const previews = new Set<{ canvas: HTMLCanvasElement; skin: number; color: string; state: 'idle' | 'run' | 'celebrate' | 'wallslide'; emote?: number }>();
/** Extra build-bar guidance for the items whose rules are spatial rather than visible in their footprint. */
function buildTip(kind: string, rotationNote: string): string {
  if (kind === 'shuttle' || kind === 'moving') return 'Shaded cells show its whole path. It passes through walls and blocks, may start partly inside a wall (amber), and crushes anyone it pins. ' + rotationNote;
  if (kind === 'wheel') return 'Green gondolas start outside walls (one is enough), amber ones start inside walls and orbit through them. The pivot may sit in a wall. ' + rotationNote;
  if (kind === 'bomb') return 'Moving platforms freeze at their starting pose while you aim: hit a shuttle, any gondola or a wheel\'s pivot to remove the whole thing.';
  if (kind === 'wire') return rotationNote + ' Bolt it to a Moving Platform or Shuttle Block and it rides along, through walls too.';
  if (kind === 'sniper') return rotationNote + ' Snipers can\u2019t bolt onto moving platforms.';
  if (kind === 'planemaker') return 'The dashed line shows where its paper planes fly. Planes never kill: stand on them. ' + rotationNote;
  if (kind === 'fan') return 'Shaded lanes show its wind (5 cells, blocked by walls). Facing up, players float. ' + rotationNote;
  if (kind === 'grave') return 'Touch the stone and a ghost hunts you. Its dirt pile is a platform. One flower per player, one ghost per player and bot.';
  if (kind === 'turret') return 'The circle is its 6-cell vision; walls block its view. It aims by itself.';
  if (kind === 'ice') return 'Lay it on top of a block, platform or item (moving platforms too). It takes no grid squares, so you can build over it.';
  if (kind === 'saw') return 'The rail takes up no grid squares: lay it through blocks and items, and build over it. The saw passes straight through. ' + rotationNote;
  return rotationNote;
}

const moverCards = new Set<{ canvas: HTMLCanvasElement; item: string }>();

function skinCanvas(skin: number, color: string, w: number, hgt: number, state: 'idle' | 'run' | 'celebrate' | 'wallslide' = 'idle', emote?: number) {
  const c = h('canvas', { width: w * 2, height: hgt * 2 });
  previews.add({ canvas: c, skin, color, state, emote });
  return c;
}
export function animatePreviews(t: number) {
  for (const c of [...moverCards]) {
    if (!c.canvas.isConnected) { moverCards.delete(c); continue; }
    drawCardPreview(c.canvas, c.item, settings.reducedMotion ? 0 : t);
  }
  for (const p of [...previews]) {
    if (!p.canvas.isConnected) { previews.delete(p); continue; }
    const ctx = p.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    const scale = p.canvas.height / 70;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const w = p.canvas.width / scale;
    // looping emote previews (winners dancing, the emote picker) restart every few seconds
    drawCharacter(ctx, p.skin, w / 2 - 14, 24, { state: p.state, t, facing: 1, emote: p.emote, emoteT: p.emote !== undefined ? (t % 2.2) + 0.2 : undefined }, p.color);
  }
}

export class UI {
  readonly root: HTMLElement;
  readonly g: GameClient;
  screen: Screen = 'menu';
  paused = false;
  private sig = new Map<string, string>();
  private layers: Record<string, HTMLElement> = {};
  private menuErr = '';
  private aiOpts = { bots: 3, difficulty: 'medium' as Difficulty, map: 'rooftop' };
  private practiceMap = 'rooftop';
  private handicaps = false;
  private settingsReturn: Screen = 'menu';
  private touchEl: HTMLElement | null = null;
  onPracticeRetry: () => void = () => {};

  constructor(root: HTMLElement, g: GameClient) {
    this.root = root;
    this.g = g;
    for (const name of ['screen', 'game', 'hud', 'overlay', 'touch', 'toasts', 'rotate', 'pause']) {
      const el = h('div', { class: 'layer' });
      el.dataset.layer = name;
      root.appendChild(el);
      this.layers[name] = el;
    }
  }

  go(s: Screen) { this.screen = s; this.sig.clear(); this.menuErr = ''; this.render(); }
  setError(e: string) { this.menuErr = e; this.sig.delete('screen'); this.render(); }

  private once(layer: string, key: string, build: () => Child) {
    if (this.sig.get(layer) === key) return;
    this.sig.set(layer, key);
    const el = this.layers[layer];
    el.replaceChildren();
    const c = build();
    if (c) el.append(c);
  }

  /** Re-render whatever changed (cheap when nothing did). */
  render() {
    const g = this.g;
    if (g.fatal) { this.once('screen', 'fatal', () => this.fatalScreen()); return; }
    if (this.screen !== 'game') {
      this.once('screen', `${this.screen}:${this.menuErr}:${settings.skin}`, () => this.menuScreen());
      for (const l of ['game', 'hud', 'overlay', 'pause', 'rotate']) this.once(l, 'none', () => null);
      this.touch(false);
      return;
    }
    this.once('screen', 'none', () => null);
    this.renderGame();
    this.renderToasts();
    this.rotatePrompt();
  }

  private touch(on: boolean) {
    if (on && !this.touchEl && touchSupported()) this.touchEl = buildTouchControls(this.layers.touch);
    if (!on && this.touchEl) { this.touchEl.remove(); this.touchEl = null; releaseTouch(); }
  }

  /** Phones play in landscape: the course is wide, so portrait gets a rotate prompt instead of a tiny map. */
  private rotatePrompt() {
    const portrait = window.innerHeight > window.innerWidth;
    const need = this.screen === 'game' && touchSupported() && portrait && !!this.g.room && this.g.phase !== 'lobby' && this.g.phase !== 'matchEnd';
    this.once('rotate', need ? 'rotate' : 'none', () => need ? h('div', { class: 'screen rotate' }, h('div', { class: 'card', style: 'text-align:center' },
      h('div', { class: 'rotate-icon', 'aria-hidden': 'true' }),
      h('h2', {}, 'Turn your phone sideways'),
      h('p', {}, 'Trap Race plays in landscape. The match keeps running while you rotate.'),
      h('button', { class: 'btn primary', onclick: () => void goFullscreen() }, 'Go fullscreen'))) : null);
  }

  // ======================================================== menus
  private menuScreen(): Child {
    switch (this.screen) {
      case 'menu': return this.mainMenu();
      case 'join': return this.joinScreen();
      case 'ai': return this.aiScreen();
      case 'practice': return this.practiceScreen();
      case 'sandbox': return this.sandboxScreen();
      case 'howto': return this.howTo();
      case 'skins': return this.skinsScreen();
      case 'settings': return this.settingsScreen();
      case 'connecting': return h('div', { class: 'screen' }, h('div', { class: 'card' }, h('h2', {}, 'Connecting…'), h('p', {}, 'Reaching the Trap Race server.'), h('button', { class: 'btn', onclick: () => { this.g.closeTransport(); this.go('menu'); } }, 'Cancel')));
      default: return null;
    }
  }

  private fatalScreen(): Child {
    return h('div', { class: 'screen' }, h('div', { class: 'card' }, h('h2', {}, 'Update available'), h('p', {}, this.g.fatal), h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Refresh')));
  }

  private nameField() {
    const inp = h('input', { class: 'input', maxlength: 16, placeholder: 'Your name', value: settings.name, 'aria-label': 'Your name' }) as HTMLInputElement;
    inp.addEventListener('input', () => { settings.name = inp.value.slice(0, 16); saveSettings(); });
    return inp;
  }

  private mainMenu(): Child {
    const color = PLAYER_COLORS[0];
    return h('div', { class: 'screen' },
      h('div', { class: 'card' },
        h('div', { class: 'logo' }, h('h1', {}, GAME_TITLE.toUpperCase()), h('div', { class: 'tag' }, 'Draft it. Build it. Race through it. Can you get past your own trap?')),
        h('div', { class: 'row', style: 'margin-bottom:14px' },
          h('button', { class: 'btn small', title: 'Change skin', onclick: () => this.go('skins'), style: 'padding:2px 6px' }, skinCanvas(settings.skin, color, 44, 52, 'idle')),
          h('label', { class: 'field grow' }, 'Name', this.nameField()),
        ),
        h('div', { class: 'menu-grid' },
          h('button', { class: 'btn primary', onclick: () => this.createRoom() }, 'Create Room'),
          h('button', { class: 'btn teal', onclick: () => this.go('join') }, 'Join Room by Code'),
          h('button', { class: 'btn pink', onclick: () => this.go('ai') }, 'Play Against AI'),
          h('button', { class: 'btn', onclick: () => this.go('practice') }, 'Solo Practice'),
          h('button', { class: 'btn teal', onclick: () => this.go('sandbox') }, 'Sandbox'),
          h('button', { class: 'btn', onclick: () => this.go('howto') }, 'How to Play'),
          h('button', { class: 'btn', onclick: () => this.go('skins') }, 'Skins'),
          h('button', { class: 'btn', onclick: () => { this.settingsReturn = 'menu'; this.go('settings'); } }, 'Settings'),
          h('a', { class: 'btn', href: 'https://open-arcade.up.railway.app', 'data-hub': '', style: 'text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center' }, '← Back to Open Arcade'),
        ),
        h('div', { class: 'err' }, this.menuErr),
        h('p', { class: 'small-note' }, 'Plays on desktop (keyboard, mouse or gamepad) and on phones and tablets in landscape with on-screen controls.'),
        touchSupported() && h('button', { class: 'btn block', style: 'margin-top:8px', onclick: () => void goFullscreen() }, 'Play fullscreen'),
      ));
  }

  async createRoom(mode: 'online' | 'bots' = 'online') {
    unlockAudio();
    this.go('connecting');
    await this.g.connectOnline();
    if (mode === 'bots') this.g.send({ t: 'create', mode: 'bots', bots: this.aiOpts.bots, difficulty: this.aiOpts.difficulty, mapId: this.aiOpts.map });
    else this.g.send({ t: 'create', mode: 'online' });
    this.go('game');
  }

  async joinRoom(code: string) {
    unlockAudio();
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(c)) { this.setError('Room codes are 5 letters and numbers'); return; }
    this.go('connecting');
    await this.g.connectOnline();
    this.g.error = '';
    this.g.send({ t: 'join', code: c });
    // wait briefly for welcome or an error
    const t0 = performance.now();
    const wait = () => {
      if (this.g.code) { this.go('game'); return; }
      if (this.g.error) { const e = this.g.error; this.g.closeTransport(); this.go('join'); this.setError(e); return; }
      if (performance.now() - t0 > 8000) { this.g.closeTransport(); this.go('join'); this.setError('The server did not answer. Try again.'); return; }
      setTimeout(wait, 50);
    };
    wait();
  }

  private joinScreen(): Child {
    const inp = h('input', { class: 'input code-input', maxlength: 8, placeholder: 'CODE', 'aria-label': 'Room code', autocomplete: 'off' }) as HTMLInputElement;
    const q = new URLSearchParams(location.search).get('room');
    if (q) inp.value = q.toUpperCase();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') void this.joinRoom(inp.value); });
    setTimeout(() => inp.focus(), 30);
    return h('div', { class: 'screen' }, h('div', { class: 'card' },
      h('h2', {}, 'Join a room'),
      h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Name', this.nameField()), h('label', { class: 'field' }, 'Room code', inp)),
      h('div', { class: 'err' }, this.menuErr),
      h('div', { class: 'row spread' }, h('button', { class: 'btn', onclick: () => this.go('menu') }, 'Back'), h('button', { class: 'btn primary', onclick: () => void this.joinRoom(inp.value) }, 'Join')),
    ));
  }

  private mapPicker(selected: string, onPick: (id: string) => void, disabled = false) {
    return h('div', { class: 'maps' }, ...MAP_LIST.map(m => {
      const cv = h('canvas', { width: 256, height: 104 });
      Renderer.mapThumb(cv, new World(m.id));
      return h('button', { class: `map-tile ${m.id === selected ? 'sel' : ''}`, disabled, onclick: () => { sfx.click(); onPick(m.id); }, title: m.blurb }, cv,
        h('div', { class: 'mt' }, m.name, m.size === 'large' && h('span', { class: 'badge' }, m.buildRequired ? 'Large · build to cross' : 'Large')));
    }));
  }

  private aiScreen(): Child {
    const o = this.aiOpts;
    const rerender = () => { this.sig.delete('screen'); this.render(); };
    return h('div', { class: 'screen' }, h('div', { class: 'card wide' },
      h('h2', {}, 'Play against AI'),
      h('p', {}, 'Bots draft, build and race under exactly the same rules and physics as you. One human with bots is a real competitive match: every bonus counts.'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Bots', h('select', { class: 'input', onchange: (e: Event) => { o.bots = Number((e.target as HTMLSelectElement).value); } }, ...[1, 2, 3, 4, 5].map(n => h('option', { value: n, selected: n === o.bots }, `${n} bot${n > 1 ? 's' : ''}`)))),
        h('label', { class: 'field' }, 'Difficulty', h('select', { class: 'input', onchange: (e: Event) => { o.difficulty = (e.target as HTMLSelectElement).value as Difficulty; } }, ...(['easy', 'medium', 'hard'] as Difficulty[]).map(d => h('option', { value: d, selected: d === o.difficulty }, d[0].toUpperCase() + d.slice(1))))),
      ),
      h('h3', {}, 'Map'),
      this.mapPicker(o.map, id => { o.map = id; rerender(); }),
      h('div', { class: 'err' }, this.menuErr),
      h('div', { class: 'row spread' }, h('button', { class: 'btn', onclick: () => this.go('menu') }, 'Back'), h('button', { class: 'btn primary', onclick: () => void this.createRoom('bots') }, 'Create match')),
    ));
  }

  private practiceScreen(): Child {
    const rerender = () => { this.sig.delete('screen'); this.render(); };
    return h('div', { class: 'screen' }, h('div', { class: 'card wide' },
      h('h2', {}, 'Solo practice'),
      h('p', {}, 'Just you, running in your browser. Draft, build and race to learn the maps and items. Practice shows finish times and coins but awards no competitive bonuses. Esc pauses; T restarts the current race.'),
      this.mapPicker(this.practiceMap, id => { this.practiceMap = id; rerender(); }),
      h('div', { class: 'row spread', style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => this.go('menu') }, 'Back'), h('button', { class: 'btn primary', onclick: () => { unlockAudio(); this.g.startPractice(this.practiceMap); this.go('game'); } }, 'Start practice')),
    ));
  }

  private sandboxMap = 'rooftop';
  private sandboxScreen(): Child {
    const rerender = () => { this.sig.delete('screen'); this.render(); };
    return h('div', { class: 'screen' }, h('div', { class: 'card wide' },
      h('h2', {}, 'Sandbox'),
      h('p', {}, `Just you, any map, every item. Press ${keyLabel(settings.binds.sandboxMenu[0])} for the item menu and place anything anywhere (bombs remove things). ${keyLabel(settings.binds.retry[0])} respawns at the start. No scoring, no timers: dying or reaching the flag just respawns you.`),
      this.mapPicker(this.sandboxMap, id => { this.sandboxMap = id; rerender(); }),
      h('div', { class: 'row spread', style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => this.go('menu') }, 'Back'), h('button', { class: 'btn primary', onclick: () => { unlockAudio(); this.g.startSandbox(this.sandboxMap); this.go('game'); } }, 'Start sandbox')),
    ));
  }

  /** The sandbox item menu: every item in the game, grouped like the draft. */
  private sandboxMenu(): Child {
    const g = this.g;
    const groups: [string, string][] = [['construction', 'Construction'], ['hazard', 'Hazards'], ['utility', 'Utility'], ['demolition', 'Demolition (removes things)']];
    return h('div', { class: 'screen' }, h('div', { class: 'card wide sandbox-menu', style: 'max-height:92vh;overflow-y:auto;max-width:1100px' },
      h('div', { class: 'row spread' }, h('h2', {}, `Sandbox items · ${ITEM_LIST.length}`),
        h('div', { class: 'row' }, h('button', { class: 'btn small pink', onclick: () => g.sandboxClear() }, 'Clear everything'), h('button', { class: 'btn small', onclick: () => g.toggleSandboxMenu() }, `Close (${keyLabel(settings.binds.sandboxMenu[0])})`))),
      ...groups.map(([grp, label]) => h('div', {},
        h('h3', {}, label),
        h('div', { class: 'sb-grid' }, ...ITEM_LIST.filter(d => d.group === grp).map(d => {
          const cv = h('canvas', { width: 160, height: 110 });
          drawCardPreview(cv, d.id, 0.5);
          if (d.kind === 'shuttle' || d.kind === 'wheel') moverCards.add({ canvas: cv, item: d.id });
          return h('button', { class: 'sb-item', title: d.desc, 'data-item': d.id, onclick: () => { sfx.click(); g.sandboxPick(d.id); } }, cv, h('span', {}, d.name));
        })))),
      h('p', { class: 'small-note' }, 'Click an item, then click on the course to place it (as many as you like). Right-click or R rotates, F flips. Esc stops placing and puts you back in control.'),
    ));
  }

  private sandboxBar(): Child {
    const g = this.g, sb = g.sandbox!;
    if (!sb.placing) return h('div', { class: 'buildbar sandbox-hint' }, h('div', { class: 'info' }, h('b', {}, `Sandbox · ${g.world?.map.name ?? ''}`), h('span', {}, `${keyLabel(settings.binds.sandboxMenu[0])} item menu · ${keyLabel(settings.binds.retry[0])} respawn · Esc menu`)),
      h('button', { class: 'btn small primary', onclick: () => g.toggleSandboxMenu() }, 'Items'), h('button', { class: 'btn small', onclick: () => g.sandboxRespawn() }, 'Respawn'));
    const def = getItem(sb.placing);
    const chk = g.check;
    return h('div', { class: 'buildbar' },
      h('div', { class: 'info' }, h('b', {}, `Placing ${def.name}` + (def.variants ? ` · ${def.variants[g.variant]}` : '')), h('span', {}, buildTip(def.kind, def.rotationNote))),
      chk?.ok ? h('span', { class: 'valid ok' }, def.kind === 'bomb' ? `Removes ${(chk.targets?.length ?? 0) + (chk.dependents?.length ?? 0)} item(s)` : 'Valid spot') : h('span', { class: 'valid bad' }, chk?.reason ?? 'Move the cursor onto the course'),
      def.rotatable && h('button', { class: 'btn small', onclick: () => g.rotate(1) }, 'Rotate'),
      def.variants && h('button', { class: 'btn small', onclick: () => g.flip() }, 'Flip'),
      h('button', { class: 'btn small', onclick: () => g.toggleSandboxMenu() }, 'Items'),
      h('button', { class: 'btn primary', onclick: () => g.sandboxPick(null) }, 'Done (Esc)'),
    );
  }

  private howTo(): Child {
    const row = (a: string, b: string, c: string) => h('tr', {}, h('td', {}, a), h('td', { class: 'num' }, b), h('td', {}, c));
    return h('div', { class: 'screen' }, h('div', { class: 'card wide', style: 'max-height:92vh;overflow-y:auto' },
      h('h2', {}, 'How to play'),
      h('p', {}, `A match is played on one map and ends the moment somebody reaches the score to win (the host picks ${MATCH.minTarget} to ${MATCH.maxTarget} points). Each round: draft one item (${TIMERS.draftMs / 1000}s), place it on the shared course (${TIMERS.buildMs / 1000}s), then everyone races from START to the flag (${TIMERS.raceMs / 1000}s). Everything that survives stays on the course, so it gets nastier every round.`),
      h('h3', {}, 'Draft'),
      h('p', {}, 'A shared pool of 5–10 cards, always at least one per player. Each card can be taken by exactly one player. Humans pick first: the AI players only choose from what is left after every human has picked. Miss the timer and you get a random leftover card.'),
      h('h3', {}, 'Build'),
      h('p', {}, 'Everything snaps to the grid. Green means legal, red tells you why not. Items can’t overlap anything, and can’t go in the striped safety zones around START and FINISH. Nothing checks that the course stays finishable: you may seal it, and if you do, bombs are how it gets reopened. Bombs remove player-built objects (never map terrain or map wire). Press Rehearse to test the course; it never scores.'),
      h('h3', {}, 'Moving platforms'),
      h('p', {}, `The Shuttle Block slides ${MOVERS.shuttleTravelCells} cells and back every ${MOVERS.shuttlePeriodTicks / 60}s, the Moving Platform glides ${HAZARD.movingPathCells} cells end to end, and the Ferris Wheel carries four level gondolas around a pivot you can pass through, one lap every ${MOVERS.wheelPeriodTicks / 60}s. They carry you exactly as they move and restart from the same pose at every GO. Walls and blocks do not stop them: they slide straight through. A platform may start partly inside a wall but never wholly (a wheel needs one gondola outside walls). Barbed wire can be bolted to Moving Platforms and Shuttle Blocks and rides with them. Get squeezed between a moving platform and something solid and you die; if another player owns the platform it counts as their trap kill. Jumping off keeps no platform speed. Bombs hit them at their starting pose, which the build view freezes on while you hold a bomb.`),
      h('h3', {}, 'Big maps'),
      h('p', {}, 'The Great Oak can’t be crossed until someone builds a way over the tree: while there is no full route, every draft guarantees building cards, races are short scouting runs, and you may place anything that doesn’t cut players off from the furthest point they can reach. Under the Mountain is sealed to the sky: the only way on is through the cave.'),
      h('h3', {}, 'Controls'),
      h('p', {}, `${keyLabel(settings.binds.left[0])}/${keyLabel(settings.binds.right[0])} move, ${keyLabel(settings.binds.jump[0])} jump, hold ${keyLabel(settings.binds.sprint[0])} to sprint, ${keyLabel(settings.binds.down[0])} drops you through one-way platforms (no jump needed). Slide down any wall by falling against it and press jump to wall-jump. You can steer back to the same wall and keep climbing as often as you like. Building: mouse to aim, click or ${keyLabel(settings.binds.confirm[0])} to place, right-click or ${keyLabel(settings.binds.rotate[0])} to rotate, ${keyLabel(settings.binds.flip[0])} flips a sniper’s facing or a Ferris wheel’s spin, the mouse wheel or ${keyLabel(settings.binds.zoom[0])} zooms. Arrow keys also move the cursor while building.`),
      h('h3', {}, 'Scoring'),
      h('div', { class: 'results-wrap' }, h('table', { class: 'results' },
        h('tr', {}, h('th', {}, 'Event'), h('th', {}, 'Points'), h('th', {}, 'When')),
        row('Finish', `+${fmtPts(SCORING.finish)}`, 'Reach the flag alive'),
        row('First finisher', `+${fmtPts(SCORING.firstFinisher)}`, 'Earliest finish tick (ties all get it). Not paid to a sole finisher, who gets the sole bonus instead. Not in solo practice.'),
        row('Sole finisher', `+${fmtPts(SCORING.soleFinisher)}`, 'You are the only finisher in a round with 2+ competitors. Replaces the first-finisher bonus (they never stack). Awarded once nobody else can still finish.'),
        row('Trap elimination', `+${fmtPts(SCORING.trapElim)}`, `Someone else dies to a trap you placed, crushes included. Counts ${SCORING.trapCapElimsPerRound} eliminations per round at most. Never for yourself.`),
        row('Banked coin', `+${fmtPts(SCORING.coin)}`, 'Carry a coin to the flag. Picking it up is worth nothing until you finish.'),
        row('Comeback', `+${fmtPts(SCORING.comeback)}`, `Reach the flag after missing it ${SCORING.comebackAfter} or more rounds in a row. Your streak resets when you finish.`),
      )),
      h('p', {}, 'Coins drop where their carrier dies, and anyone can pick them up. A coin nobody banks returns to where it was placed next round. A coin that reaches the flag is spent and gone for the rest of the match.'),
      h('h3', {}, 'Winning'),
      h('p', {}, `The first player to reach the score to win takes the match immediately, even mid-race. Players who reach it on the same tick share the victory. The host can also set a round limit (either can be off, never both): when it is reached, the most points wins, then most finishes, then the lowest total time, else a shared victory. With individual win requirements each player has their own points to win, and at the round limit players are ranked by how much of their own requirement they earned.`),
      h('h3', {}, 'Traps worth knowing'),
      h('p', {}, `Tripod snipers sit on blocks and fire every ${HAZARD.sniperInterval}s exactly; the shot lands instantly and pierces players. The crossbow fires every ${HAZARD.crossbowInterval}s, slow arrows that break on the first player. Cannonballs arc. Black holes pull players and projectiles in; come at one with sideways speed and you can swing around it, aim straight at it and the core kills. Crumbling platforms break on their second hit (a landing, a wall-slide or a shot) and stay gone for the round. Barbed wire is deadly even while wall sliding. Shields absorb one trap hit (${POWER.shieldDur}s), never a fall.`),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', onclick: () => this.go(this.g.transport ? 'game' : 'menu') }, 'Got it')),
    ));
  }

  private skinsScreen(): Child {
    return h('div', { class: 'screen' }, h('div', { class: 'card wide' },
      h('h2', {}, 'Skins'),
      h('p', {}, 'All skins are free and purely cosmetic: every character has the exact same 28 × 42 hitbox, speed and jump.'),
      h('div', { class: 'skins' }, ...SKINS.map((s, i) => h('button', { class: `skin ${settings.skin === i ? 'sel' : ''}`, onclick: () => { settings.skin = i; saveSettings(); sfx.click(); if (this.g.code) this.g.send({ t: 'profile', name: settings.name || 'Player', skin: i }); this.sig.delete('screen'); this.render(); } }, skinCanvas(i, PLAYER_COLORS[i % PLAYER_COLORS.length], 120, 120, i % 2 ? 'run' : 'idle'), s.name))),
      h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: () => this.go(this.g.transport ? 'game' : 'menu') }, 'Done')),
    ));
  }

  private settingsScreen(): Child {
    const slider = (label: string, val: number, set: (v: number) => void) => {
      const r = h('input', { type: 'range', min: 0, max: 100, value: Math.round(val * 100), class: 'range', 'aria-label': label }) as HTMLInputElement;
      r.addEventListener('input', () => { set(Number(r.value) / 100); applyVolumes(); saveSettings(); });
      return h('label', { class: 'field' }, label, r);
    };
    const rerender = () => { this.sig.delete('screen'); this.render(); };
    const binds = h('div', { class: 'binds' });
    for (const a of ACTIONS) {
      const keys = settings.binds[a.id];
      binds.append(h('div', { class: 'act' }, a.label), h('div', {}, ...keys.map(k => h('kbd', {}, keyLabel(k)))),
        h('button', { class: 'btn small', onclick: (e: Event) => { (e.target as HTMLButtonElement).textContent = 'Press a key…'; captureNextKey(code => { if (code !== 'Escape' || a.id === 'menu') settings.binds[a.id] = [code, ...keys.filter(k => k !== code)].slice(0, 2); saveSettings(); rerender(); }); } }, 'Rebind'));
    }
    return h('div', { class: 'screen' }, h('div', { class: 'card wide', style: 'max-height:92vh;overflow-y:auto' },
      h('h2', {}, 'Settings'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, slider('Music volume', settings.music, v => { settings.music = v; })), h('div', { class: 'grow' }, slider('Effects volume', settings.sfx, v => { settings.sfx = v; }))),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('label', { class: 'field' }, 'Motion', h('select', { class: 'input', onchange: (e: Event) => { settings.reducedMotion = (e.target as HTMLSelectElement).value === 'reduced'; saveSettings(); } }, h('option', { value: 'full', selected: !settings.reducedMotion }, 'Full'), h('option', { value: 'reduced', selected: settings.reducedMotion }, 'Reduced'))),
        h('label', { class: 'field' }, 'Particles', h('select', { class: 'input', onchange: (e: Event) => { settings.particles = (e.target as HTMLSelectElement).value as 'low'; saveSettings(); } }, ...(['low', 'medium', 'high'] as const).map(p => h('option', { value: p, selected: settings.particles === p }, p)))),
        h('label', { class: 'field' }, 'Touch controls', h('select', { class: 'input', onchange: (e: Event) => { settings.touch = (e.target as HTMLSelectElement).value as 'auto'; saveSettings(); } }, ...(['auto', 'on', 'off'] as const).map(p => h('option', { value: p, selected: settings.touch === p }, p)))),
        h('label', { class: 'field' }, 'Developer overlay', h('select', { class: 'input', onchange: (e: Event) => { settings.devOverlay = (e.target as HTMLSelectElement).value === 'on'; saveSettings(); } }, h('option', { value: 'off', selected: !settings.devOverlay }, 'Off'), h('option', { value: 'on', selected: settings.devOverlay }, 'On'))),
      ),
      h('h3', {}, 'Key bindings'),
      binds,
      h('div', { class: 'row spread', style: 'margin-top:14px' },
        h('button', { class: 'btn', onclick: () => { settings.binds = structuredClone(DEFAULT_BINDS); saveSettings(); rerender(); } }, 'Reset keys'),
        h('button', { class: 'btn primary', onclick: () => this.go(this.settingsReturn) }, 'Done')),
    ));
  }

  // ======================================================== in game
  private renderGame() {
    const g = this.g;
    const room = g.room;
    const phase = g.phase;
    const me = g.me;
    // lobby overlay
    if (!room) { this.once('game', 'wait', () => h('div', { class: 'screen' }, h('div', { class: 'card' }, h('h2', {}, g.status === 'lost' ? 'Reconnecting…' : 'Joining…'), h('button', { class: 'btn', onclick: () => this.leave() }, 'Back to menu')))); return; }
    if (g.sandbox) {
      const sb = g.sandbox;
      this.once('game', sb.menu ? 'sbmenu' : 'none', () => (sb.menu ? this.sandboxMenu() : null));
      this.once('overlay', sb.menu ? 'none' : JSON.stringify(['sb', sb.placing, g.check?.ok, g.check?.reason, g.rot, g.variant, g.check?.targets?.length]), () => (sb.menu ? null : this.sandboxBar()));
      this.touch(!sb.menu && !sb.placing);
      this.updateHud();
      this.once('pause', this.paused ? 'paused' : 'none', () => (this.paused ? this.pauseMenu() : null));
      return;
    }
    if (phase === 'lobby') {
      const key = JSON.stringify([room, g.status]);
      this.once('game', 'lobby' + key, () => this.lobby());
    } else if (phase === 'draft') {
      this.once('game', 'draft' + JSON.stringify([g.cards, g.round, g.you, me?.spectator]), () => this.draft());
    } else if (phase === 'build') {
      this.once('game', 'build', () => null);
    } else if (phase === 'results' && g.results) {
      this.once('game', 'results' + g.round + JSON.stringify(g.results.rows.length), () => this.results());
    } else if (phase === 'matchEnd' && g.matchEnd) {
      this.once('game', 'matchEnd' + JSON.stringify([g.votes, room.members.map(m => m.host), room.mapId]), () => this.matchEndPanel());
    } else this.once('game', 'none', () => null);
    // build bar
    const item = g.myItem();
    const buildKey = phase === 'build' ? JSON.stringify([item, g.placedThisRound, g.awaitingPlace, g.check?.ok, g.check?.reason, g.check?.warning, g.rot, g.variant, !!g.rehearsal, g.check?.wireLen, g.check?.targets?.length]) : 'none';
    this.once('overlay', buildKey, () => (phase === 'build' ? this.buildBar() : null));
    const racing = phase === 'race' && !!g.pred;
    this.touch(racing || !!g.rehearsal);
    this.updateHud();
    this.once('pause', this.paused ? 'paused' : 'none', () => (this.paused ? this.pauseMenu() : null));
  }

  private leave() { this.paused = false; this.g.closeTransport(); history.replaceState(null, '', location.pathname); this.go('menu'); }

  private lobby(): Child {
    const g = this.g, room = g.room!;
    const host = g.isHost;
    const practice = room.mode === 'practice';
    const invite = `${location.origin}${location.pathname}?room=${room.code}`;
    const competitors = room.members.filter(m => !m.spectator);
    const copy = (text: string, label: string) => { void navigator.clipboard?.writeText(text).then(() => g.toast(`${label} copied`, 'good'), () => g.toast('Copy failed: select and copy it manually', 'bad')); };
    const handicaps = room.target > 0 && (this.handicaps || room.members.some(m => m.target !== undefined));
    const players = h('div', { class: 'players' }, ...room.members.map(m => {
      const col = PLAYER_COLORS[m.color % PLAYER_COLORS.length];
      const row = h('div', { class: 'player-row', style: `--c:${col}` }, skinCanvas(m.skin, col, 40, 48), h('div', { class: 'name' }, m.name + (m.id === g.you ? ' (you)' : '')));
      if (handicaps && !m.spectator) {
        if (host) row.append(h('select', { class: 'input', style: 'min-height:32px;padding:2px 6px;font-size:13px', 'aria-label': `Points to win for ${m.name}`, title: 'Points this player needs to win', onchange: (e: Event) => g.send({ t: 'host', a: 'memberTarget', id: m.id, target: Number((e.target as HTMLSelectElement).value) }) },
          h('option', { value: 0, selected: m.target === undefined }, `Needs ${room.target} (default)`),
          ...Array.from({ length: MATCH.maxTarget - MATCH.minTarget + 1 }, (_, i) => MATCH.minTarget + i).map(n => h('option', { value: n, selected: n === m.target }, `Needs ${n}`))));
        else row.append(h('span', { class: 'pill' }, `Needs ${m.target ?? room.target}`));
      }
      if (m.host) row.append(h('span', { class: 'pill host' }, 'Host'));
      if (m.bot) {
        if (host) row.append(h('select', { class: 'input', style: 'min-height:32px;padding:2px 6px;font-size:13px', 'aria-label': 'Bot difficulty', onchange: (e: Event) => g.send({ t: 'host', a: 'botDiff', id: m.id, difficulty: (e.target as HTMLSelectElement).value as Difficulty }) }, ...(['easy', 'medium', 'hard'] as Difficulty[]).map(d => h('option', { value: d, selected: d === m.difficulty }, d))));
        else row.append(h('span', { class: 'pill' }, `Bot · ${m.difficulty}`));
        if (host) row.append(h('button', { class: 'btn small', onclick: () => g.send({ t: 'host', a: 'removeBot', id: m.id }) }, 'Remove'));
      } else {
        row.append(h('span', { class: `pill ${m.ready || m.host ? 'ok' : ''}` }, m.host ? 'Host' : m.ready ? 'Ready' : 'Not ready'));
        if (!m.connected) row.append(h('span', { class: 'pill warn' }, 'Offline'));
        if (m.spectator) row.append(h('span', { class: 'pill' }, 'Spectating'));
      }
      return row;
    }));
    const canAdd = host && !practice && competitors.length < MATCH.maxPlayers;
    return h('div', { class: 'screen' }, h('div', { class: 'card wide', style: 'max-height:94vh;overflow-y:auto' },
      h('div', { class: 'row spread' },
        h('h2', {}, practice ? 'Solo practice' : competitors.length === 1 ? 'Lobby (add a bot or invite a friend)' : `Lobby · ${competitors.length}/${MATCH.maxPlayers} players`),
        h('span', { class: `conn ${g.status === 'online' || g.status === 'local' ? '' : 'bad'}` }, g.status === 'online' ? '● Connected' : g.status === 'local' ? '● Local' : '● ' + g.status),
      ),
      !practice && h('div', { class: 'row' },
        h('div', { class: 'code-box' }, h('span', { class: 'small-note' }, 'Room code'), h('span', { class: 'code' }, room.code)),
        h('button', { class: 'btn small', onclick: () => copy(room.code, 'Code') }, 'Copy code'),
        h('button', { class: 'btn small teal', onclick: () => copy(invite, 'Invite link') }, 'Copy invite link'),
      ),
      players,
      room.target > 0 && h('label', { class: 'row small-note', style: 'gap:8px;cursor:pointer' },
        h('input', { type: 'checkbox', checked: handicaps, disabled: !host, onchange: (e: Event) => { this.handicaps = (e.target as HTMLInputElement).checked; if (!this.handicaps) for (const m of room.members) if (m.target) g.send({ t: 'host', a: 'memberTarget', id: m.id, target: 0 }); this.sig.delete('game'); this.render(); } }),
        'Individual win requirements (handicaps): give each player or bot their own points to win'),
      canAdd && h('div', { class: 'row' }, h('span', { class: 'small-note' }, 'Add bot:'), ...(['easy', 'medium', 'hard'] as Difficulty[]).map(d => h('button', { class: 'btn small', onclick: () => g.send({ t: 'host', a: 'addBot', difficulty: d }) }, `+ ${d}`))),
      h('h3', {}, host ? 'Choose a map' : `Map: ${MAP_LIST.find(m => m.id === room.mapId)?.name}`),
      this.mapPicker(room.mapId, id => g.send({ t: 'host', a: 'map', mapId: id }), !host),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('label', { class: 'field' }, 'Points to win', h('select', { class: 'input', disabled: !host, 'aria-label': 'Points to win', onchange: (e: Event) => g.send({ t: 'host', a: 'target', target: Number((e.target as HTMLSelectElement).value) }) },
          // "Off" is only offered while the round limit is on: one of the two must always stay active
          h('option', { value: 0, selected: room.target === 0, disabled: room.roundLimit === 0 }, room.roundLimit === 0 ? 'Off (turn on a round limit first)' : 'Off'),
          ...Array.from({ length: MATCH.maxTarget - MATCH.minTarget + 1 }, (_, i) => MATCH.minTarget + i).map(n => h('option', { value: n, selected: n === room.target }, String(n))))),
        h('label', { class: 'field' }, 'Round limit', h('select', { class: 'input', disabled: !host, 'aria-label': 'Round limit', onchange: (e: Event) => g.send({ t: 'host', a: 'rounds', rounds: Number((e.target as HTMLSelectElement).value) }) },
          h('option', { value: 0, selected: room.roundLimit === 0, disabled: room.target === 0 }, room.target === 0 ? 'Off (turn on points to win first)' : 'Off'),
          ...Array.from({ length: MATCH.maxRounds - MATCH.minRounds + 1 }, (_, i) => MATCH.minRounds + i).map(n => h('option', { value: n, selected: n === room.roundLimit }, `${n} rounds`)))),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn', onclick: () => this.leave() }, 'Leave'),
        !host && h('button', { class: `btn ${g.me?.ready ? '' : 'primary'}`, onclick: () => g.send({ t: 'ready', ready: !g.me?.ready }) }, g.me?.ready ? 'Not ready' : 'Ready up'),
        host && h('button', { class: 'btn primary', onclick: () => { unlockAudio(); g.send({ t: 'host', a: 'start' }); } }, 'Start match'),
      ),
      h('p', { class: 'small-note' }, practice ? 'Solo practice: no competitive bonuses.' : '2–6 competitors (bots count). New players can join between matches; anyone joining mid-match spectates until the next one.'),
    ));
  }

  private draft(): Child {
    const g = this.g;
    const mine = g.myCard;
    const spectator = !!g.me?.spectator;
    const cards = g.cards.map(c => {
      const def = getItem(c.item);
      const cv = h('canvas', { width: 240, height: 180 });
      drawCardPreview(cv, c.item, 0.5);
      if (def.kind === 'shuttle' || def.kind === 'wheel') moverCards.add({ canvas: cv, item: c.item });
      const takenBy = c.by ? g.member(c.by) : null;
      const btn = h('button', { class: `icard ${c.by === g.you ? 'mine' : ''}`, disabled: !!c.by || !!mine || spectator, onclick: () => { sfx.click(); g.send({ t: 'claim', round: g.round, card: c.id }); }, 'aria-label': `Claim ${def.name}` },
        cv,
        h('div', { class: `cat ${def.group}` }, `${def.category} · ${def.group}`),
        h('div', { class: 'nm' }, def.name),
        h('div', { class: 'desc' }, def.desc),
        h('div', { class: 'rot' }, def.rotationNote),
      );
      if (takenBy) btn.append(h('div', { class: 'taken', style: `color:${PLAYER_COLORS[takenBy.color % PLAYER_COLORS.length]}` }, c.by === g.you ? 'YOURS' : 'TAKEN', h('span', {}, takenBy.name)));
      return btn;
    });
    return h('div', { class: 'draft' },
      h('h2', {}, `Round ${g.round}${g.roundLimit ? '/' + g.roundLimit : ''} · Draft · ${g.goalText()}`),
      g.cards.length > 0 && g.room?.members.some(m => m.bot && !m.spectator) && h('div', { class: `stage ${g.draftStage}`, 'data-stage': g.draftStage }, g.draftStage === 'humans' ? 'Players choosing' : 'AI choosing'),
      h('div', { class: 'sub' }, spectator ? 'Spectating this match.' : mine ? `You picked ${getItem(mine.item).name}. ${g.draftStage === 'humans' ? 'Waiting for the other players…' : 'The AI is choosing from what is left…'}` : 'Pick one item. Each card can be claimed by exactly one player.', g.demolition ? ' A bomb is guaranteed this round: the course looked blocked.' : '', g.courseOpen ? '' : ' No full route to the flag yet: everyone gets a building card to choose. Build the crossing!'),
      h('div', { class: 'cards' }, ...cards),
    );
  }

  private buildBar(): Child {
    const g = this.g;
    const item = g.myItem();
    if (g.me?.spectator || !item) return h('div', { class: 'buildbar' }, h('div', { class: 'info' }, h('b', {}, 'Build phase'), h('span', {}, 'Watching the others build.')));
    const def = getItem(item);
    if (g.rehearsal) return h('div', { class: 'buildbar' }, h('div', { class: 'info' }, h('b', {}, 'Rehearsal (not scored)'), h('span', {}, 'Test the current course. The build timer keeps running.')), h('button', { class: 'btn primary', onclick: () => g.stopRehearsal() }, 'Back to building (Esc)'));
    if (g.placedThisRound) return h('div', { class: 'buildbar' }, h('div', { class: 'info' }, h('b', {}, `${def.name} placed`), h('span', {}, 'Waiting for everyone else to place.')), h('button', { class: 'btn', onclick: () => g.startRehearsal() }, 'Rehearse'));
    const chk = g.check;
    const status = g.awaitingPlace ? h('span', { class: 'valid ok' }, 'Placing…') : chk?.ok ? h('span', { class: 'valid ok' }, def.kind === 'bomb' ? `Removes ${(chk.targets?.length ?? 0) + (chk.dependents?.length ?? 0)} item(s)` : def.kind === 'wire' ? `Valid · ${chk.wireLen} segment${chk.wireLen === 1 ? '' : 's'}${chk.trimmed ? ` (${chk.trimmed} trimmed)` : ''}` : 'Valid spot') : h('span', { class: 'valid bad' }, chk?.reason ?? 'Move the cursor onto the course');
    const kb = (a: keyof typeof settings.binds) => h('kbd', {}, keyLabel(settings.binds[a][0]));
    return h('div', { class: 'buildbar' },
      h('div', { class: 'info' }, h('b', {}, def.name + (def.variants ? ` · ${def.variants[g.variant]}` : '')), h('span', {}, buildTip(def.kind, def.rotationNote))),
      status,
      def.rotatable && h('button', { class: 'btn small', onclick: () => g.rotate(1) }, 'Rotate'),
      def.variants && h('button', { class: 'btn small', onclick: () => g.flip() }, def.kind === 'wheel' ? 'Flip spin' : def.kind === 'planemaker' ? 'Flip side' : 'Flip facing'),
      h('button', { class: 'btn small', onclick: () => this.onZoom() }, 'Zoom'),
      h('button', { class: 'btn small', onclick: () => g.startRehearsal() }, 'Rehearse'),
      h('button', { class: 'btn primary', disabled: g.awaitingPlace, onclick: () => g.confirmPlace() }, def.kind === 'bomb' ? 'Detonate' : 'Place'),
      touchSupported()
        ? h('div', { class: 'keys' }, 'Drag on the course to aim, then tap ', def.kind === 'bomb' ? 'Detonate' : 'Place', '. Zoom for precision.')
        : h('div', { class: 'keys' }, 'Click / ', kb('confirm'), ' place · right-click / ', kb('rotate'), ' rotate', def.variants ? ' · ' : '', def.variants ? kb('flip') : '', def.variants ? ' flip' : '', ' · arrows move'),
    );
  }
  onZoom: () => void = () => {};

  private results(): Child {
    const g = this.g;
    const r = g.results!;
    const solo = !r.competitive;
    const body = r.rows.map(row => {
      const m = g.member(row.pid);
      const status = row.status === 'finished' ? `Finished ${row.time!.toFixed(2)}s` : row.status === 'dead' ? (row.cause === 'fall' ? 'Fell' : row.killer ? `Eliminated by ${g.member(row.killer)?.name ?? 'a trap'}` : 'Eliminated') : row.status === 'timeout' ? 'Out of time' : 'Absent';
      const tr = h('tr', { class: row.pid === g.you ? 'me' : '' },
        h('td', { style: `color:${PLAYER_COLORS[(m?.color ?? 0) % PLAYER_COLORS.length]}` }, m?.name ?? row.pid),
        h('td', {}, status),
        h('td', { class: 'num' }, fmtPts(row.base)),
        h('td', { class: 'num' }, solo ? '–' : fmtPts(row.first)),
        h('td', { class: 'num' }, solo ? '–' : fmtPts(row.sole)),
        h('td', { class: 'num' }, solo ? '–' : fmtPts(row.trap)),
        h('td', { class: 'num' }, fmtPts(row.coins)),
        h('td', { class: 'num' }, solo ? '–' : fmtPts(row.comeback ?? 0)),
        h('td', { class: 'num total' }, `+${fmtPts(row.total)}`),
        h('td', { class: 'num total' }, fmtPts(row.matchTotal)),
      );
      return tr;
    });
    return h('div', { class: 'screen' }, h('div', { class: 'card wide' },
      h('h2', {}, `Round ${g.round}${g.roundLimit ? '/' + g.roundLimit : ''} results · ${g.goalText()}`),
      solo && h('p', {}, 'Solo practice: first, sole-finisher and trap bonuses are disabled.'),
      h('div', { class: 'results-wrap' }, h('table', { class: 'results' },
        h('tr', {}, ...['Player', 'Result', 'Finish', 'First', 'Sole', 'Traps', 'Coins', 'Comeback', 'Round', 'Match'].map(t => h('th', {}, t))),
        ...body)),
      h('p', { class: 'small-note', 'data-next': '1' }, g.roundLimit > 0 && g.round >= g.roundLimit ? 'That was the final round: the winner is up next.' : `Next round soon. Built items stay on the course.${g.target > 0 ? ` First to ${g.targets[g.you] ?? g.target} wins.` : ''}${g.roundLimit > 0 ? ` Most points after round ${g.roundLimit} wins.` : ''}`),
    ));
  }

  private matchEndPanel(): Child {
    const g = this.g;
    const me = g.matchEnd!;
    const room = g.room!;
    const names = me.winners.map(id => g.member(id)?.name ?? id);
    const rows = me.order.map((id, i) => {
      const m = g.member(id); const t = me.tally[id];
      return h('tr', { class: id === g.you ? 'me' : '' }, h('td', {}, `${i + 1}.`), h('td', { style: `color:${PLAYER_COLORS[(m?.color ?? 0) % PLAYER_COLORS.length]}` }, m?.name ?? id), h('td', { class: 'num total' }, fmtPts(t?.score ?? 0)), h('td', { class: 'num' }, String(t?.finishes ?? 0)), h('td', { class: 'num' }, t?.finishes ? `${t.finishTime.toFixed(2)}s` : '–'));
    });
    const host = g.isHost;
    const voted = g.votes.includes(g.you);
    return h('div', { class: 'screen' }, h('div', { class: 'card wide' },
      h('h2', {}, me.reason === 'rounds' ? `Match over · ${me.roundLimit} rounds played` : `Match over · first to ${me.target}`),
      h('div', { class: 'winner-dance' }, ...me.winners.map((id, i) => { const m = g.member(id); return skinCanvas(m?.skin ?? 0, PLAYER_COLORS[(m?.color ?? 0) % PLAYER_COLORS.length], 90, 105, 'celebrate', [1, 9, 3, 7][i % 4]); })),
      h('div', { class: 'winner' }, names.length > 1 ? `Shared victory: ${names.join(' & ')}` : `${names[0] ?? 'Nobody'} wins!`,
        h('span', { class: 'small-note' }, me.reason === 'rounds' ? ` ${fmtPts(me.tally[me.winners[0]]?.score ?? 0)} points after the round limit (${me.roundLimit})` : ` ${fmtPts(me.tally[me.winners[0]]?.score ?? 0)} points after round ${me.round} (target ${me.targets[me.winners[0]] ?? me.target})`)),
      h('div', { class: 'results-wrap' }, h('table', { class: 'results' }, h('tr', {}, ...['#', 'Player', 'Score', 'Finishes', 'Total time'].map(t => h('th', {}, t))), ...rows)),
      host && h('h3', {}, 'Next map'),
      host && this.mapPicker(room.mapId, id => g.send({ t: 'host', a: 'map', mapId: id })),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn', onclick: () => this.leave() }, 'Leave'),
        h('div', { class: 'grow' }),
        !host && h('button', { class: `btn ${voted ? '' : 'primary'}`, onclick: () => g.send({ t: 'vote', rematch: !voted }) }, voted ? 'Vote cast · undo' : 'Vote rematch'),
        h('span', { class: 'small-note' }, `${g.votes.length} vote(s)`),
        host && h('button', { class: 'btn', onclick: () => g.send({ t: 'host', a: 'lobby' }) }, 'Back to lobby'),
        host && h('button', { class: 'btn primary', onclick: () => g.send({ t: 'host', a: 'rematch', mapId: room.mapId }) }, 'Rematch'),
      ),
    ));
  }

  private pauseMenu(): Child {
    const g = this.g;
    const local = g.isPractice;
    return h('div', { class: 'screen' }, h('div', { class: 'card' },
      h('h2', {}, local ? 'Paused' : 'Menu'),
      !local && h('p', {}, 'The match keeps running for everyone while this menu is open.'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn primary', onclick: () => this.setPaused(false) }, 'Resume'),
        local && g.phase === 'race' && h('button', { class: 'btn', onclick: () => { this.setPaused(false); this.onPracticeRetry(); } }, 'Restart race'),
        h('button', { class: 'btn', onclick: () => { this.settingsReturn = 'game'; this.paused = false; this.go('settings'); } }, 'Settings'),
        h('button', { class: 'btn', onclick: () => { this.paused = false; this.go('howto'); } }, 'How to play'),
        h('button', { class: 'btn pink', onclick: () => this.leave() }, 'Leave match'),
      )));
  }

  setPaused(p: boolean) {
    this.paused = p;
    const t = this.g.transport;
    if (t && t.kind === 'local') (t as unknown as { paused: boolean }).paused = p;
    this.render();
  }

  // ======================================================== HUD (updated every frame, cheap)
  private hudEls: Record<string, HTMLElement> | null = null;
  private emoteEls: { btn: HTMLElement; wheel: HTMLElement; slices: HTMLElement[]; hub: HTMLElement; pointer: HTMLElement } | null = null;
  /** emote wheel state; `viaKey` means it closes (and plays) when the emote key is released */
  emoteWheel = { open: false, sel: 0, viaKey: false };
  canEmote(): boolean {
    const g = this.g;
    return (g.phase === 'countdown' || g.phase === 'race' || g.phase === 'results') && !!g.race && !g.me?.spectator && !this.paused;
  }
  openEmoteWheel(viaKey: boolean) { if (!this.canEmote()) return; this.emoteWheel.open = true; this.emoteWheel.viaKey = viaKey; }
  closeEmoteWheel(play: boolean) {
    if (!this.emoteWheel.open) return;
    this.emoteWheel.open = false;
    if (play) this.g.emote(this.emoteWheel.sel);
  }
  scrollEmote(dir: number) { const n = EMOTES.length; this.emoteWheel.sel = (((this.emoteWheel.sel + dir) % n) + n) % n; }
  private updateHud() {
    const g = this.g;
    const show = g.phase !== 'lobby' && !!g.room;
    if (!show) { this.once('hud', 'none', () => null); this.hudEls = null; return; }
    if (this.sig.get('hud') !== 'hud') {
      this.sig.set('hud', 'hud');
      const top = h('div', { class: 'hud-top' }, h('div', { class: 'chip', 'data-k': 'round' }), h('div', { class: 'chip timer', 'data-k': 'timer' }), h('div', { class: 'chip', 'data-k': 'score' }));
      const els = { round: top.children[0] as HTMLElement, timer: top.children[1] as HTMLElement, score: top.children[2] as HTMLElement, standings: h('div', { class: 'standings' }), left: h('div', { class: 'hud-left' }), banner: h('div', { class: 'banner hidden' }), count: h('div', { class: 'big-count hidden' }), spect: h('div', { class: 'spectate hidden' }), dev: h('div', { class: 'dev hidden' }), menuBtn: h('button', { class: 'btn small menu-btn', onclick: () => this.setPaused(true), 'aria-label': 'Menu' }, '☰') };
      top.append(els.menuBtn);
      // emote wheel: hold the emote key (or tap the button), scroll the mouse wheel or point at a slice, release to play
      const n = EMOTES.length;
      const slices = EMOTES.map((em, i) => {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        return h('button', { class: 'slice', role: 'menuitem', title: em.name, style: `left:${160 + Math.cos(a) * 118}px;top:${160 + Math.sin(a) * 118}px`, onclick: () => { this.emoteWheel.sel = i; this.closeEmoteWheel(true); }, onpointerenter: () => { this.emoteWheel.sel = i; } },
          skinCanvas(settings.skin, PLAYER_COLORS[(this.g.me?.color ?? 0) % PLAYER_COLORS.length], 34, 40, 'idle', i), h('span', {}, em.name));
      });
      const hub = h('div', { class: 'hub' });
      const pointer = h('div', { class: 'pointer' });
      const wheel = h('div', { class: 'emote-wheel hidden', role: 'menu', 'aria-label': 'Emote wheel' }, pointer, ...slices, hub);
      const emoteBtn = h('button', { class: 'btn small emote-toggle', 'aria-label': 'Emotes', title: `Emotes (hold ${keyLabel(settings.binds.emote[0])})`, onclick: () => (this.emoteWheel.open ? this.closeEmoteWheel(false) : this.openEmoteWheel(false)) }, '☺ Emote');
      this.emoteEls = { btn: emoteBtn, wheel, slices, hub, pointer };
      this.layers.hud.replaceChildren(top, els.standings, els.left, els.banner, els.count, els.spect, els.dev);
      if (this.emoteEls) this.layers.hud.append(this.emoteEls.btn, this.emoteEls.wheel);
      this.hudEls = els;
    }
    const e = this.hudEls!;
    // emotes are for when characters are on screen: countdown, race and the results that follow
    const canEmote = this.canEmote();
    if (!canEmote) this.emoteWheel.open = false;
    if (this.emoteEls) {
      const el = this.emoteEls, w = this.emoteWheel;
      el.btn.classList.toggle('hidden', !canEmote);
      el.wheel.classList.toggle('hidden', !w.open);
      if (w.open) {
        el.slices.forEach((sl, i) => sl.classList.toggle('sel', i === w.sel));
        const em = EMOTES[w.sel];
        if (el.hub.dataset.k !== em.id) { el.hub.dataset.k = em.id; el.hub.replaceChildren(em.name, h('small', {}, w.viaKey ? 'scroll · release to play' : 'tap to play')); }
        el.pointer.style.transform = `rotate(${(w.sel / EMOTES.length) * 360 + 180}deg)`;
      }
    }
    const left = g.timeLeft / 1000;
    const phaseName = { draft: 'Draft', build: 'Build', countdown: 'Get ready', race: 'Race', results: 'Results', matchEnd: 'Match over', lobby: '' }[g.phase];
    if (g.sandbox) {
      e.round.textContent = `Sandbox · ${g.world?.map.name ?? ''}`;
      e.timer.classList.add('hidden');
      e.score.textContent = `Flags ${g.sandbox.finishes} · Respawns ${g.sandbox.deaths}`;
      e.standings.classList.add('hidden'); e.count.classList.add('hidden'); e.spect.classList.add('hidden');
      const fx = g.world?.map.fx, tk = g.sandbox.sim.tick;
      let hz = '';
      if (fx?.tsunami && !g.sandbox.placing) { const tin = tsunamiIn(fx, tk); hz = tin === null ? 'TSUNAMI! Stay above the water!' : tin <= fx.tsunami.warn ? `TSUNAMI INCOMING in ${Math.ceil(tin)}!` : ''; }
      if (fx?.gusts && !g.sandbox.placing) { const gin = gustIn(g.world!.map, tk); hz = gin === null ? 'SANDSTORM! Brace yourself!' : gin <= fx.gusts.warn ? `Sandstorm incoming in ${Math.ceil(gin)}…` : ''; }
      e.banner.textContent = hz; e.banner.classList.toggle('hidden', !hz); e.banner.classList.toggle('danger', !!hz);
      return;
    }
    e.standings.classList.remove('hidden');
    e.round.textContent = `Round ${g.round}${g.roundLimit ? '/' + g.roundLimit : ''} · ${phaseName}${g.target > 0 ? ` · first to ${g.targets[g.you] ?? g.target}` : ''}`;
    const showTimer = g.phase !== 'matchEnd';
    e.timer.textContent = showTimer ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : '';
    e.timer.classList.toggle('low', left < 10 && g.phase !== 'results');
    e.timer.classList.toggle('hidden', !showTimer);
    const myScore = g.tally[g.you]?.score ?? 0;
    e.score.textContent = g.isPractice ? `Finishes ${g.tally[g.you]?.finishes ?? 0} · Score ${fmtPts(myScore)}` : `Score ${fmtPts(myScore)}`;
    // standings
    const room = g.room!;
    const sim = g.race;
    const order = [...room.members.filter(m => !m.spectator)].sort((a, b) => (g.tally[b.id]?.score ?? 0) - (g.tally[a.id]?.score ?? 0));
    const sk = JSON.stringify(order.map(m => [m.id, g.tally[m.id]?.score, sim?.player(m.id)?.status, m.connected]));
    if (e.standings.dataset.k !== sk) {
      e.standings.dataset.k = sk;
      e.standings.replaceChildren(...order.map(m => {
        const st = sim?.player(m.id)?.status;
        const icon = st === 'finished' ? 'FIN' : st === 'dead' ? 'OUT' : st === 'timeout' ? 'TIME' : st === 'racing' ? '▶' : '';
        return h('div', { class: `standing ${m.id === g.you ? 'me' : ''}`, style: `--c:${PLAYER_COLORS[m.color % PLAYER_COLORS.length]}` }, h('span', { class: 'nm' }, m.name), h('span', { class: 'st' }, (m.connected ? '' : 'OFFLINE ') + icon), h('b', {}, fmtPts(g.tally[m.id]?.score ?? 0)));
      }));
    }
    // effects, coins, connection
    const p = sim?.player(g.you);
    const effects: [string, number, number][] = p ? [['Speed', p.effects.speed, POWER.speedDur], ['Jump', p.effects.jump, POWER.jumpDur], ['Shield', p.effects.shield, POWER.shieldDur]] : [];
    const slow = sim && sim.slowTicks > 0 ? sim.slowTicks / 60 : 0;
    const coins = sim ? sim.coins.filter(c => c.carrier === g.you && c.state === 'carried').length : 0;
    const lk = JSON.stringify([effects.map(x => x[1] > 0 ? Math.ceil(x[1] * 4) : 0), Math.ceil(slow * 4), coins, g.status, Math.round((g.transport?.stats.median ?? 0) / 5)]);
    if (e.left.dataset.k !== lk) {
      e.left.dataset.k = lk;
      const kids: Node[] = [];
      const fx = effects.filter(x => x[1] > 0).map(([n, v, max]) => h('div', { class: 'effect' }, `${n} ${v.toFixed(1)}s`, h('div', { class: 'bar', style: `width:${Math.min(100, (v / max) * 100)}%` })));
      if (slow > 0) fx.push(h('div', { class: 'effect' }, `Traps slowed ${slow.toFixed(1)}s`));
      if (fx.length) kids.push(h('div', { class: 'effects' }, ...fx));
      if (coins) kids.push(h('div', { class: 'chip' }, `Carrying ${coins} coin${coins > 1 ? 's' : ''} · bank at the flag`));
      const conn = g.status === 'online' ? `● ${Math.round(g.transport?.stats.median || g.transport?.rtt || 0)} ms ping` : g.status === 'local' ? '● Practice (local)' : '● Connection lost: reconnecting…';
      kids.push(h('div', { class: `conn ${g.status === 'online' || g.status === 'local' ? '' : 'bad'}` }, conn));
      e.left.replaceChildren(...kids);
    }
    // banner
    let banner = '';
    let danger = false;
    // map hazard warnings take priority while racing
    const fx = g.world?.map.fx;
    const lsim = g.localSim() ?? g.race;
    const htick = lsim ? (g.localSim() ? lsim.tick : g.renderTick()) : 0;
    const racingNow = (g.phase === 'race' && !!g.race) || !!g.localSim();
    let hazard = '';
    if (fx && racingNow) {
      if (fx.tsunami) { const tin = tsunamiIn(fx, htick); if (tin === null) hazard = 'TSUNAMI! Stay above the water!'; else if (tin <= fx.tsunami.warn) hazard = `TSUNAMI INCOMING in ${Math.ceil(tin)}: climb above the canopy line!`; }
      if (fx.gusts) { const gin = gustIn(g.world!.map, htick); if (gin === null) hazard = 'SANDSTORM! Brace yourself!'; else if (gin <= fx.gusts.warn) hazard = `Sandstorm incoming in ${Math.ceil(gin)}…`; }
    }
    if (g.status === 'lost' || g.status === 'connecting') { banner = 'Connection lost. Reconnecting… your avatar is still in the race.'; danger = true; }
    else if (hazard) { banner = hazard; danger = true; }
    else if (g.me?.spectator) banner = 'Spectating: you will join the next match.';
    else if (g.phase === 'race' && p && p.status === 'dead') banner = `Eliminated. Spectating until the next round.`;
    else if (g.phase === 'race' && p && p.status === 'finished') banner = `Finished! ${(p.finishTick / 60).toFixed(2)}s · spectating`;
    else if (g.phase === 'build' && g.rehearsal) banner = 'Rehearsal: practice run, nothing here counts.';
    else if (g.phase === 'build' && !g.courseOpen && g.world?.map.buildRequired) banner = 'No full route to the flag yet: build a way over the obstacle.';
    else if (g.phase === 'build' && window.innerHeight > 520) { const n = g.room!.members.filter(m => !m.spectator).length; banner = `${n} player${n === 1 ? '' : 's'} building · ${Math.ceil(left)}s left`; }
    e.banner.textContent = banner;
    e.banner.classList.toggle('hidden', !banner);
    e.banner.classList.toggle('danger', danger);
    // countdown
    const cd = g.phase === 'countdown' ? String(Math.max(1, Math.ceil(left))) : g.phase === 'race' && g.race && g.timeLeft > ((g.race.opts.maxTicks / 60) * 1000 - 700) ? 'GO!' : '';
    e.count.textContent = cd;
    e.count.classList.toggle('hidden', !cd);
    // spectator controls
    const spectating = g.phase === 'race' && !g.pred && sim && sim.players.some(x => x.status === 'racing');
    if (spectating) {
      const target = g.spectateTarget();
      const nm = target ? g.member(target)?.name ?? '' : '';
      if (e.spect.dataset.k !== nm) {
        e.spect.dataset.k = nm;
        e.spect.replaceChildren(h('button', { class: 'btn small', onclick: () => { g.spectateIdx--; } }, '◀'), h('div', { class: 'chip' }, `Watching ${nm}`), h('button', { class: 'btn small', onclick: () => { g.spectateIdx++; } }, '▶'));
      }
    }
    e.spect.classList.toggle('hidden', !spectating);
    if (settings.devOverlay) {
      e.dev.classList.remove('hidden');
      e.dev.textContent = `tick ${sim?.tick ?? 0} est ${g.serverTickNow().toFixed(0)}\nrtt last ${Math.round(g.transport?.rtt ?? 0)} med ${Math.round(g.transport?.stats.median ?? 0)} p95 ${Math.round(g.transport?.stats.p95 ?? 0)} jit ${(g.transport?.stats.jitter ?? 0).toFixed(1)}ms n=${g.transport?.stats.samples.length ?? 0} to=${g.transport?.stats.timeouts ?? 0} region ${g.transport?.stats.region || '?'}\nsnaps/s ${g.stats.snapsPerSec}\ncorr ${g.stats.lastCorr.toFixed(1)}px pending ${g.pending.length}\nworld v${g.world?.version ?? 0} objs ${g.world?.objects.size ?? 0}`;
    } else e.dev.classList.add('hidden');
  }

  private renderToasts() {
    const g = this.g;
    const key = JSON.stringify(g.toasts.map(t => [t.msg, t.until]));
    this.once('toasts', key, () => h('div', { class: 'toasts' }, ...g.toasts.map(t => h('div', { class: `toast ${t.kind}` }, t.msg))));
  }
}

/** Fullscreen + landscape lock where the browser allows it (Android Chrome); iOS ignores both, which is fine. */
export async function goFullscreen() {
  try {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    if (!document.fullscreenElement) await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o?.lock?.('landscape').catch(() => {});
  } catch { /* not supported: carry on in the browser */ }
}
