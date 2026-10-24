// Room membership and the server-owned match phase machine. No Node or DOM APIs: solo practice runs this in the browser.
import { EMOTE, MATCH, PROTOCOL_VERSION, SCORING, TICK_HZ, TIMERS, SNAPSHOT_EVERY_TICKS, NET, type Difficulty } from '../shared/config';
import { getItem, ITEM_LIST, type DraftGroup } from '../shared/items';
import { MAP_LIST, MAPS, selectableMap } from '../shared/maps';
import { baseNav, NavGraph } from '../shared/nav';
import { applyBomb, applyPlacement, checkPlacement, makeObject, regionForCells, type PlaceRequest } from '../shared/placement';
import { parseClientMsg, sanitizeName, type Card, type ClientMsg, type DraftStage, type MemberInfo, type Phase, type RoomInfo, type ServerMsg } from '../shared/protocol';
import type { Rect } from '../shared/grid';
import { RaceSim, type PlayerStatus, type RaceEvent } from '../shared/race';
import { Rng, hashString } from '../shared/rng';
import { applyRound, rankMatch, scoreRound, type PlayerTally, type RoundRow } from '../shared/scoring';
import { World } from '../shared/world';
import { BotRacer, botBridgeCandidates, botPickCard, botPlacementCandidates, randomCandidates } from './bots';

/** Construction cards that can bridge a build-required gap on their own or in pairs (checked on The Great Oak). */
export const BRIDGING = new Set(['plank_3', 'plank_5', 'plank_7', 'block_2x2', 'block_2x3', 'block_3x3', 'l_block', 'stairs', 'spring', 'shuttle', 'wheel']);

export function randomToken(bytes = 18): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(len = 5): string {
  const a = new Uint8Array(len);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export const SKIN_COUNT = 8;
const BOT_NAMES = ['Bolt', 'Pip', 'Juno', 'Rex', 'Mika', 'Ozzy', 'Tess', 'Kiko', 'Vex', 'Nori'];

export interface Member {
  id: string; name: string; skin: number; color: number; bot: boolean; difficulty?: Difficulty;
  ready: boolean; connected: boolean; token: string; spectator: boolean; leftAt: number;
}

interface InputState { queue: number[]; last: number; lastSeq: number }

export type Deliver = (memberId: string, msg: ServerMsg) => void;

export class Room {
  readonly code: string;
  readonly mode: 'online' | 'practice';
  members: Member[] = [];
  hostId = '';
  mapId = 'rooftop';
  /** score to win, whole points; locked while a match runs */
  target = MATCH.defaultTarget;
  match: Match | null = null;
  phase: Phase = 'lobby';
  timeMs = 0; // room clock: advances only when the host loop ticks (practice pause stops it)
  emptySince = -1;
  lastActivity = 0;
  closed = false;
  votes = new Set<string>();
  private lastEmote = new Map<string, number>();
  private seq = 1;
  private deliver: Deliver;
  seed: number;

  constructor(code: string, mode: 'online' | 'practice', deliver: Deliver, seed?: number) {
    this.code = code;
    this.mode = mode;
    this.deliver = deliver;
    this.seed = seed ?? hashString(code + ':' + Date.now());
  }

  // ---------- membership
  addHuman(name: string, skin: number): Member | { error: string } {
    if (this.mode === 'practice' && this.members.length >= 1) return { error: 'Practice rooms are single player' };
    const competitors = this.members.filter(m => !m.spectator).length;
    const live = this.phase !== 'lobby';
    if (!live && competitors >= MATCH.maxPlayers) return { error: 'Room is full (6 players max)' };
    if (live && this.members.length >= MATCH.maxPlayers + 4) return { error: 'Room is full' };
    const m: Member = {
      id: `p${this.seq++}`, name: sanitizeName(name), skin: clampSkin(skin), color: this.freeColor(), bot: false,
      ready: false, connected: true, token: randomToken(), spectator: live, leftAt: -1,
    };
    this.members.push(m);
    if (!this.hostId || !this.member(this.hostId)?.connected) this.hostId = m.id;
    this.touch();
    return m;
  }

  addBot(difficulty: Difficulty): Member | { error: string } {
    if (this.phase !== 'lobby') return { error: 'Bots can only be added in the lobby' };
    if (this.mode === 'practice') return { error: 'Solo practice has no bots. Use Play Against AI instead' };
    if (this.members.filter(m => !m.spectator).length >= MATCH.maxPlayers) return { error: 'Room is full (6 players max)' };
    const used = new Set(this.members.map(m => m.name));
    const name = BOT_NAMES.find(n => !used.has(`${n} (bot)`)) ?? 'Bot';
    const m: Member = {
      id: `b${this.seq++}`, name: `${name} (bot)`, skin: (this.members.length * 3 + 1) % SKIN_COUNT, color: this.freeColor(), bot: true, difficulty,
      ready: true, connected: true, token: '', spectator: false, leftAt: -1,
    };
    this.members.push(m);
    this.touch();
    return m;
  }

  private freeColor(): number {
    const used = new Set(this.members.map(m => m.color));
    for (let i = 0; i < 10; i++) if (!used.has(i)) return i;
    return 0;
  }

  member(id: string) { return this.members.find(m => m.id === id); }
  humans() { return this.members.filter(m => !m.bot); }
  touch() { this.lastActivity = this.timeMs; }

  setConnected(id: string, connected: boolean) {
    const m = this.member(id);
    if (!m) return;
    m.connected = connected;
    m.leftAt = connected ? -1 : this.timeMs;
    this.match?.onConnection(id, connected);
    if (!connected && this.hostId === id) this.transferHost();
    if (connected && !this.member(this.hostId)?.connected) this.hostId = id;
    this.broadcastRoom();
  }

  removeMember(id: string) {
    const i = this.members.findIndex(m => m.id === id);
    if (i < 0) return;
    const m = this.members[i];
    if (this.match && this.match.roster.includes(id)) {
      // keep them in the running match so leaving never grants immunity; they are simply disconnected
      m.connected = false; m.leftAt = this.timeMs;
      this.match.onConnection(id, false);
    } else this.members.splice(i, 1);
    if (this.hostId === id) this.transferHost();
    this.broadcastRoom();
  }

  private transferHost() {
    const next = this.members.find(m => !m.bot && m.connected && m.id !== this.hostId);
    if (next) this.hostId = next.id;
  }

  info(forId: string): RoomInfo {
    return {
      code: this.code, mode: this.mode, mapId: this.mapId, target: this.target, phase: this.phase, round: this.match?.round ?? 0, youId: forId,
      inviteable: this.mode === 'online',
      members: this.members.map<MemberInfo>(m => ({
        id: m.id, name: m.name, skin: m.skin, color: m.color, bot: m.bot, difficulty: m.difficulty, ready: m.ready,
        connected: m.connected, host: m.id === this.hostId, spectator: m.spectator,
      })),
    };
  }

  send(id: string, msg: ServerMsg) { const m = this.member(id); if (m && !m.bot && m.connected) this.deliver(id, msg); }
  broadcast(msg: ServerMsg) { for (const m of this.members) if (!m.bot && m.connected) this.deliver(m.id, msg); }
  broadcastRoom() { for (const m of this.members) if (!m.bot && m.connected) this.deliver(m.id, { t: 'room', room: this.info(m.id) }); }

  /** Everything a (re)connecting client needs before normal updates resume. */
  sendFullState(id: string) {
    this.send(id, { t: 'room', room: this.info(id) });
    this.match?.sendState(id);
  }

  // ---------- client messages
  handle(id: string, raw: unknown) {
    const msg = parseClientMsg(raw);
    const m = this.member(id);
    if (!msg || !m) return;
    this.touch();
    const isHost = id === this.hostId;
    switch (msg.t) {
      case 'ready': if (this.phase === 'lobby') { m.ready = msg.ready; this.broadcastRoom(); } break;
      case 'profile': m.name = sanitizeName(msg.name); m.skin = clampSkin(msg.skin); this.broadcastRoom(); break;
      case 'host': if (isHost) this.hostAction(id, msg); else this.send(id, { t: 'error', code: 'host', msg: 'Only the host can do that' }); break;
      case 'claim': this.match?.claim(id, msg.card, msg.round); break;
      case 'place': this.match?.place(id, { item: '', x: msg.x, y: msg.y, rot: msg.rot, variant: msg.variant }, msg.round); break;
      case 'in': this.match?.input(id, msg.round, msg.s, msg.b); break;
      case 'vote':
        if (this.phase === 'matchEnd') { if (msg.rematch) this.votes.add(id); else this.votes.delete(id); this.broadcast({ t: 'votes', votes: [...this.votes] }); this.maybeRematchByVote(); }
        break;
      case 'emote': {
        // cosmetic only: never touches the simulation; rate-limited so it can't be used to spam the room
        const last = this.lastEmote.get(id) ?? -Infinity;
        if (this.timeMs - last < EMOTE.cooldownMs || this.phase === 'lobby') break;
        this.lastEmote.set(id, this.timeMs);
        this.broadcast({ t: 'emote', pid: id, e: msg.e });
        break;
      }
      case 'leave': this.removeMember(id); break;
      default: break;
    }
  }

  private hostAction(id: string, msg: Extract<ClientMsg, { t: 'host' }>) {
    const err = (s: string) => this.send(id, { t: 'error', code: 'host', msg: s });
    switch (msg.a) {
      case 'map': if (this.phase === 'lobby' || this.phase === 'matchEnd') { if (selectableMap(msg.mapId)) { this.mapId = msg.mapId; this.broadcastRoom(); } } break;
      case 'target': {
        if (!Number.isInteger(msg.target) || msg.target < MATCH.minTarget || msg.target > MATCH.maxTarget) { err(`Score to win must be a whole number from ${MATCH.minTarget} to ${MATCH.maxTarget}`); break; }
        if (this.phase !== 'lobby' && this.phase !== 'matchEnd') { err('The score to win is locked while a match is running'); break; }
        this.target = msg.target; this.broadcastRoom();
        break;
      }
      case 'addBot': { const r = this.addBot(msg.difficulty); if ('error' in r) err(r.error); else this.broadcastRoom(); break; }
      case 'removeBot': { const i = this.members.findIndex(m => m.id === msg.id && m.bot); if (i >= 0 && this.phase === 'lobby') { this.members.splice(i, 1); this.broadcastRoom(); } break; }
      case 'botDiff': { const b = this.members.find(m => m.id === msg.id && m.bot); if (b && this.phase === 'lobby') { b.difficulty = msg.difficulty; this.broadcastRoom(); } break; }
      case 'start': { const e = this.canStart(); if (e) err(e); else this.startMatch(); break; }
      case 'lobby': this.toLobby(); break;
      case 'rematch': if (this.phase === 'matchEnd') { if (msg.mapId && selectableMap(msg.mapId)) this.mapId = msg.mapId; this.startMatch(); } break;
    }
  }

  canStart(): string | null {
    if (this.phase !== 'lobby') return 'A match is already running';
    const comp = this.members.filter(m => !m.spectator && (m.bot || m.connected));
    if (this.mode === 'practice') return comp.length === 1 ? null : 'Practice needs exactly one player';
    if (comp.length < MATCH.minPlayers) return 'Add a bot or wait for another player (2 needed)';
    if (comp.length > MATCH.maxPlayers) return 'Too many players';
    const notReady = comp.filter(m => !m.bot && !m.ready && m.id !== this.hostId);
    if (notReady.length) return `Waiting for ${notReady.map(m => m.name).join(', ')} to ready up`;
    return null;
  }

  startMatch() {
    // anyone who left for good is dropped; late joiners become competitors now
    this.members = this.members.filter(m => m.bot || m.connected);
    for (const m of this.members) { m.spectator = false; }
    const roster = this.members.filter(m => !m.spectator).slice(0, MATCH.maxPlayers).map(m => m.id);
    for (const m of this.members) if (!roster.includes(m.id)) m.spectator = true;
    this.votes.clear();
    this.match?.dispose();
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.match = new Match(this, roster, this.mapId, this.target, this.seed);
    this.broadcastRoom();
    this.match.begin();
  }

  toLobby() {
    this.match?.dispose();
    this.match = null;
    this.phase = 'lobby';
    this.votes.clear();
    for (const m of this.members) { m.spectator = false; if (!m.bot) m.ready = false; }
    this.members = this.members.filter(m => m.bot || m.connected);
    this.broadcastRoom();
    this.broadcast({ t: 'phase', phase: 'lobby', round: 0, target: this.target, endsIn: 0, mapId: this.mapId, competitive: false, tally: {} });
  }

  private maybeRematchByVote() {
    const humans = this.members.filter(m => !m.bot && m.connected);
    if (humans.length && humans.every(h => this.votes.has(h.id))) {
      const i = MAP_LIST.findIndex(m => m.id === this.mapId);
      this.mapId = MAP_LIST[(i + 1) % MAP_LIST.length].id; // a rematch vote rotates to the next map
      this.startMatch();
    }
  }

  /** One 60 Hz tick of room time. */
  tick() {
    this.timeMs += 1000 / TICK_HZ;
    this.match?.tick();
    // lobby cleanup: drop humans who never came back
    if (this.phase === 'lobby' || this.phase === 'matchEnd') {
      const gone = this.members.filter(m => !m.bot && !m.connected && m.leftAt >= 0 && this.timeMs - m.leftAt > TIMERS.lobbyDisconnectRemoveMs);
      if (gone.length) { this.members = this.members.filter(m => !gone.includes(m)); if (gone.some(g => g.id === this.hostId)) this.transferHost(); this.broadcastRoom(); }
    }
    const anyone = this.members.some(m => !m.bot && m.connected);
    if (!anyone) { if (this.emptySince < 0) this.emptySince = this.timeMs; }
    else this.emptySince = -1;
    if (this.emptySince >= 0 && this.timeMs - this.emptySince > TIMERS.emptyRoomExpireMs) this.close();
    if (this.timeMs - this.lastActivity > TIMERS.idleLobbyExpireMs && this.phase === 'lobby') this.close();
  }

  close() { this.closed = true; this.match?.dispose(); this.match = null; }
}

function clampSkin(s: number) { return Math.max(0, Math.min(SKIN_COUNT - 1, Math.floor(s) || 0)); }

// ======================================================================= Match

export class Match {
  readonly room: Room;
  readonly roster: string[];
  /** score to win in whole points, and the same in tenths (scores are integer tenths) */
  readonly target: number;
  readonly targetTenths: number;
  readonly competitive: boolean;
  world: World;
  nav: NavGraph;
  rng: Rng;
  round = 0;
  phase: Phase = 'draft';
  deadline = 0;
  pool: Card[] = [];
  cardOf = new Map<string, string>(); // pid -> card id
  /** humans choose first; bots are held back by the server until every human has chosen or timed out */
  draftStage: DraftStage = 'humans';
  done = new Set<string>(); // placed or skipped this round
  needDemolition = false;
  /** a full route to the flag exists on the current course. Advisory: it shapes the draft and the scouting timer, never blocks a placement. */
  courseOpen = true;
  tally = new Map<string, PlayerTally>();
  results: RoundRow[][] = [];
  race: RaceSim | null = null;
  roundKey = '';
  inputs = new Map<string, InputState>();
  bots = new Map<string, BotRacer>();
  botTimers = new Map<string, number>();
  private allEvents: RaceEvent[] = [];
  private startStatuses = new Map<string, PlayerStatus>();
  private navDirty: Rect[] = [];
  /** set once a player reaches the score to win; scoring and gameplay are frozen after it */
  matchResult: { order: string[]; winners: string[]; rows: RoundRow[] } | null = null;
  disposed = false;
  stats = { validations: 0, validationMs: 0, maxValidationMs: 0 };

  constructor(room: Room, roster: string[], mapId: string, target: number, seed: number) {
    this.room = room;
    this.roster = roster;
    this.target = target;
    this.targetTenths = target * SCORING.unit;
    this.competitive = roster.length >= 2;
    this.world = new World(mapId); // a new match always starts from the clean base map
    this.nav = NavGraph.fromBase(baseNav(mapId), this.world); // shared clean-map graph, derived from as the course changes
    this.rng = new Rng(seed);
    for (const id of roster) this.tally.set(id, { score: 0, finishes: 0, finishTime: 0 });
  }

  get now() { return this.room.timeMs; }
  isBot(id: string) { return !!this.room.member(id)?.bot; }

  begin() { this.startDraft(); }
  dispose() { this.disposed = true; this.race = null; this.bots.clear(); }

  private setPhase(p: Phase, ms: number) {
    this.phase = p;
    this.room.phase = p;
    this.deadline = this.now + ms;
    this.room.broadcast(this.phaseMsg());
  }
  private phaseMsg(): ServerMsg {
    return { t: 'phase', phase: this.phase, round: this.round, target: this.target, endsIn: Math.max(0, Math.round(this.deadline - this.now)), mapId: this.world.map.id, competitive: this.competitive, tally: Object.fromEntries(this.tally) };
  }
  private draftMsg(): ServerMsg { return { t: 'draft', cards: this.pool, demolition: this.needDemolition, open: this.courseOpen, stage: this.draftStage }; }

  sendState(id: string) {
    const r = this.room;
    r.send(id, this.phaseMsg());
    r.send(id, { t: 'world', world: this.world.toJSON() });
    if (this.phase === 'draft' || this.phase === 'build') r.send(id, this.draftMsg());
    if (this.race && (this.phase === 'race' || this.phase === 'countdown')) {
      r.send(id, { t: 'raceStart', ids: this.race.players.map(p => p.id), roundKey: this.roundKey, maxTicks: this.race.opts.maxTicks });
      r.send(id, { t: 'snap', s: this.race.snapshot(this.acks()), ev: [] });
    }
    if (this.phase === 'results' && this.results.length) r.send(id, { t: 'results', round: this.round, rows: this.results[this.results.length - 1], competitive: this.competitive });
    if (this.phase === 'matchEnd') this.sendMatchEnd(id);
  }

  // ---------------- route graph (advisory: bots plan with it, the draft mix reads it; no placement is ever refused because of it)
  private refreshNav() {
    if (!this.navDirty.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of this.navDirty) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    this.navDirty = [];
    this.nav = NavGraph.derive(this.nav, this.world, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  // ---------------- draft
  private startDraft() {
    this.round++;
    this.cardOf.clear();
    this.done.clear();
    this.refreshNav();
    this.courseOpen = this.nav.reach(false).finish;
    this.pool = this.makePool();
    this.draftStage = this.roster.some(id => !this.isBot(id)) ? 'humans' : 'ai';
    this.room.broadcast({ t: 'world', world: this.world.toJSON() });
    this.setPhase('draft', TIMERS.draftMs);
    this.botTimers.clear();
    if (this.draftStage === 'ai') this.beginAiStage(); else this.room.broadcast(this.draftMsg());
  }

  /** Test hook (browser tests only, set from TEST_POOL): round r's draft offers exactly forcePool[(r - 1) % length]. */
  static forcePool: string[][] | null = null;

  makePool(): Card[] {
    if (Match.forcePool) return Match.forcePool[(this.round - 1) % Match.forcePool.length].map((item, i) => ({ id: `r${this.round}c${i}`, item, by: null }));
    const n = Math.max(MATCH.minPool, Math.min(MATCH.maxPool, this.roster.length + 2 + this.rng.int(0, 1)));
    const groups: DraftGroup[] = [];
    // bombs are the normal tool for reopening a blocked course; an unfinished build-required course also guarantees construction
    const blocked = !this.courseOpen;
    const mustBuild = blocked && !!this.world.map.buildRequired;
    const bombDue = blocked || this.needDemolition || this.round % 3 === 0 || this.rng.chance(0.2);
    if (bombDue) groups.push('demolition');
    if (mustBuild) for (let i = 0; i < Math.min(n - 2, this.roster.length); i++) groups.push('construction');
    groups.push('construction', 'hazard');
    while (groups.length < n) {
      const g = this.rng.weighted<DraftGroup>(['construction', 'hazard', 'utility'], g => (g === 'construction' ? 0.42 : g === 'hazard' ? 0.4 : 0.18))!;
      groups.push(g);
    }
    const used = new Map<string, number>();
    const cards: Card[] = groups.slice(0, n).map((g, i) => {
      // while a build-required course is unfinished, the building cards are the ones that can actually bridge gaps
      const options = ITEM_LIST.filter(d => d.group === g && (!mustBuild || g !== 'construction' || i >= this.roster.length || BRIDGING.has(d.id)));
      // prefer variety: repeated item types are allowed but weighted down
      const def = this.rng.weighted(options, d => d.weight / (1 + 3 * (used.get(d.id) ?? 0)))!;
      used.set(def.id, (used.get(def.id) ?? 0) + 1);
      return { id: `r${this.round}c${i}`, item: def.id, by: null };
    });
    return this.rng.shuffle(cards);
  }

  claim(pid: string, cardId: string, round: number) {
    const fail = (msg: string) => this.room.send(pid, { t: 'claimFail', card: cardId, msg });
    if (this.phase !== 'draft' || round !== this.round) return fail('The draft is closed');
    if (!this.roster.includes(pid)) return fail('Spectators can’t draft');
    if (this.isBot(pid) && this.draftStage !== 'ai') return fail('Humans choose first'); // enforced here, not just in the UI
    if (this.cardOf.has(pid)) return fail('You already picked an item this round');
    const card = this.pool.find(c => c.id === cardId);
    if (!card) return fail('That card is not in this draft');
    if (card.by) return fail(`Too slow! ${this.room.member(card.by)?.name ?? 'Someone'} took it`);
    // atomic: first valid claim wins, the card is now unavailable to everyone
    card.by = pid;
    this.cardOf.set(pid, card.id);
    this.room.broadcast({ t: 'claimed', card: card.id, by: pid });
    this.advanceDraft();
  }

  /** Moves the draft along: humans done -> reserve cards for absent humans -> release the bots -> build. */
  private advanceDraft() {
    if (this.phase !== 'draft') return;
    if (this.roster.every(id => this.cardOf.has(id))) { this.startBuild(); return; }
    if (this.draftStage !== 'humans') return;
    const waiting = this.roster.filter(id => !this.isBot(id) && !this.cardOf.has(id) && this.room.member(id)?.connected);
    if (waiting.length === 0) this.endHumanStage();
  }

  /** Humans who are disconnected or out of time get the usual seeded random pick before any bot may choose. */
  private endHumanStage() {
    for (const id of this.roster) if (!this.isBot(id)) this.autoPick(id);
    if (this.phase !== 'draft') return;
    if (this.roster.every(id => this.cardOf.has(id))) { this.startBuild(); return; }
    this.beginAiStage();
  }

  private autoPick(id: string) {
    if (this.cardOf.has(id)) return;
    const open = this.pool.filter(c => !c.by);
    if (!open.length) return;
    const c = this.rng.pick(open);
    c.by = id; this.cardOf.set(id, c.id);
    this.room.broadcast({ t: 'claimed', card: c.id, by: id });
  }

  private beginAiStage() {
    this.draftStage = 'ai';
    this.deadline = this.now + TIMERS.aiDraftMs;
    this.room.broadcast(this.phaseMsg());
    this.room.broadcast(this.draftMsg());
    this.botTimers.clear();
    for (const id of this.roster) if (this.isBot(id) && !this.cardOf.has(id)) this.botTimers.set(id, this.now + this.rng.range(...TIMERS.botDraftDelayMs));
  }

  private finishDraft() {
    // deadline: give every player without a card a seeded random unclaimed one (humans were already served before the bots)
    for (const id of this.roster) {
      if (this.cardOf.has(id)) continue;
      if (this.isBot(id) && this.draftStage !== 'ai') continue;
      this.autoPick(id);
    }
    this.startBuild();
  }

  // ---------------- build
  private startBuild() {
    this.setPhase('build', TIMERS.buildMs);
    this.room.broadcast(this.draftMsg());
    this.botTimers.clear();
    for (const id of this.roster) if (this.isBot(id)) this.botTimers.set(id, this.now + this.rng.range(...TIMERS.botBuildDelayMs));
  }

  itemOf(pid: string): string | null {
    const cid = this.cardOf.get(pid);
    return cid ? this.pool.find(c => c.id === cid)?.item ?? null : null;
  }

  place(pid: string, req: PlaceRequest, round: number): boolean {
    const fail = (msg: string) => { this.room.send(pid, { t: 'placeFail', msg }); return false; };
    if (this.phase !== 'build' || round !== this.round) return fail('Building is closed');
    if (this.done.has(pid)) return fail('You already placed your item this round');
    const item = this.itemOf(pid);
    if (!item) return fail('You have no item this round');
    const r: PlaceRequest = { ...req, item };
    const t0 = Date.now();
    // Ordinary rules only (grid, bounds, ownership, occupancy, support, moving-item exceptions). Whether the course stays
    // finishable is deliberately not a condition: a legal placement can make the course impossible.
    const check = checkPlacement(this.world, r);
    const ms = Date.now() - t0;
    this.stats.validations++; this.stats.validationMs += ms; this.stats.maxValidationMs = Math.max(this.stats.maxValidationMs, ms);
    if (!check.ok) return fail(check.reason ?? 'Can’t place that there');
    const def = getItem(item);
    if (def.kind === 'bomb') {
      const removed = applyBomb(this.world, [...check.targets!, ...check.dependents!]);
      if (!removed.length) return fail('Nothing left to remove there');
      if (check.region) this.navDirty.push(check.region);
      this.done.add(pid);
      this.room.broadcast({ t: 'removed', ids: removed, by: pid, cells: check.cells.map(c => [c[0], c[1]]), version: this.world.version });
    } else {
      const obj = makeObject(this.world, r, check, pid, this.round);
      applyPlacement(this.world, obj);
      this.navDirty.push(check.region ?? regionForCells(check.cells, 48));
      this.done.add(pid);
      this.room.broadcast({ t: 'placed', obj, by: pid, version: this.world.version });
      if (check.trimmed) this.room.send(pid, { t: 'notice', msg: `Barbed wire trimmed to ${check.wireLen} segment${check.wireLen === 1 ? '' : 's'}: the edge is shorter than the wire` });
    }
    if (this.roster.every(id => this.done.has(id))) this.startCountdown();
    return true;
  }

  private finishBuild() {
    for (const id of this.roster) {
      if (this.done.has(id)) continue;
      const item = this.itemOf(id);
      if (!item) { this.done.add(id); continue; }
      const def = getItem(item);
      const name = this.room.member(id)?.name ?? 'Player';
      if (def.group === 'hazard' || def.group === 'demolition') {
        this.done.add(id);
        this.room.broadcast({ t: 'skip', pid: id, msg: `${name} ran out of time: ${def.name} was not placed` });
        continue;
      }
      // simple safe items get a legal fallback spot
      let ok = false;
      for (const req of randomCandidates(this.world, def, this.rng, 4)) {
        const check = checkPlacement(this.world, req);
        if (!check.ok) continue;
        const obj = makeObject(this.world, req, check, id, this.round);
        applyPlacement(this.world, obj);
        this.navDirty.push(check.region ?? regionForCells(check.cells, 48));
        this.room.broadcast({ t: 'placed', obj, by: id, version: this.world.version });
        this.room.broadcast({ t: 'notice', msg: `${name} ran out of time: ${def.name} auto-placed` });
        ok = true;
        break;
      }
      if (!ok) this.room.broadcast({ t: 'skip', pid: id, msg: `${name} ran out of time and no legal spot was found` });
      this.done.add(id);
    }
    this.startCountdown();
  }

  // ---------------- race
  private startCountdown() {
    this.roundKey = `${this.room.code}:${this.round}:${this.rng.int(0, 1e9)}`;
    this.refreshNav();
    this.courseOpen = this.nav.reach(false).finish;
    // A build-required course nobody has bridged yet gets a short scouting run instead of a full race nobody can win.
    // A course the players themselves sealed keeps the full timer: the route search is conservative, not a proof.
    // Large maps scale the base race length (90 s by default) by their measured need; test hooks shorten both together.
    const fullS = (TIMERS.raceMs / 1000) * ((this.world.map.raceS ?? 90) / 90);
    const raceS = this.courseOpen || !this.world.map.buildRequired ? fullS : Math.min(TIMERS.scoutS, fullS);
    this.race = new RaceSim(this.world, this.roster, { roundKey: this.roundKey, maxTicks: Math.round(raceS * TICK_HZ) });
    for (const id of this.roster) {
      const m = this.room.member(id);
      if (m && !m.connected) this.race.setConnected(id, false);
    }
    this.inputs.clear();
    for (const id of this.roster) this.inputs.set(id, { queue: [], last: 0, lastSeq: 0 });
    this.bots.clear();
    for (const id of this.roster) {
      const m = this.room.member(id);
      if (m?.bot) this.bots.set(id, new BotRacer(id, m.difficulty ?? 'medium', hashString(this.roundKey + id)));
    }
    this.allEvents = [];
    this.setPhase('countdown', TIMERS.countdownMs);
    this.room.broadcast({ t: 'raceStart', ids: this.roster, roundKey: this.roundKey, maxTicks: this.race.opts.maxTicks });
    this.room.broadcast({ t: 'snap', s: this.race.snapshot(this.acks()), ev: [] });
  }

  input(pid: string, round: number, seq: number, bits: number[]) {
    if (round !== this.round || (this.phase !== 'race' && this.phase !== 'countdown')) return; // stale or previous-round inputs
    const st = this.inputs.get(pid);
    if (!st || this.phase !== 'race') return;
    // seq is the number of the first input in this batch; drop anything we've already queued
    for (let i = 0; i < bits.length; i++) {
      const s = seq + i;
      if (s <= st.lastSeq) continue;
      st.queue.push(bits[i] & 31);
      st.lastSeq = s;
    }
    while (st.queue.length > NET.inputQueueMax) st.queue.shift();
  }

  private acks(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [id, st] of this.inputs) m.set(id, st.lastSeq - st.queue.length);
    return m;
  }

  onConnection(id: string, connected: boolean) {
    const st = this.inputs.get(id);
    if (st && !connected) { st.queue = []; st.last = 0; } // never keep running on held keys
    this.race?.setConnected(id, connected);
    if (connected) this.sendState(id);
    else if (this.phase === 'draft') this.advanceDraft(); // a human who dropped must not hold the bots (or the draft) up
  }

  /** Rows for the current race as if it ended now. The sole-finisher bonus is only included once nobody is still racing. */
  private liveRows(): RoundRow[] {
    const race = this.race!;
    const statuses = new Map<string, PlayerStatus>(race.players.map(p => [p.id, p.status]));
    const known = race.players.every(p => p.status !== 'racing');
    return scoreRound(this.roster, this.competitive, this.allEvents, statuses, this.tally, known);
  }

  private stepRace() {
    const race = this.race!;
    const inputs = new Map<string, number>();
    for (const [id, st] of this.inputs) {
      if (st.queue.length) st.last = st.queue.shift()!;
      inputs.set(id, st.last);
    }
    for (const [id, bot] of this.bots) inputs.set(id, bot.think(race, this.nav));
    race.step(inputs);
    const ev = race.drainEvents();
    this.allEvents.push(...ev);
    // One authoritative scoring transaction per tick: everything that happened this tick is scored together, then the
    // score target is checked. Players who cross it on the same tick share the win.
    const scoring = ev.some(e => e.type === 'finish' || e.type === 'bank' || (e.type === 'death' && e.credit)) || race.over;
    if (scoring) {
      const rows = this.liveRows();
      const winners = rows.filter(r => r.matchTotal >= this.targetTenths).map(r => r.pid);
      if (winners.length) {
        race.over = true; // freeze gameplay: nothing steps or scores after the winning tick
        this.room.broadcast({ t: 'snap', s: race.snapshot(this.acks()), ev: ev.filter(e => e.type !== 'jump') });
        this.endByTarget(rows, winners);
        return;
      }
    }
    if (race.tick % SNAPSHOT_EVERY_TICKS === 0 || ev.some(e => e.type !== 'jump' && e.type !== 'fire') || race.over) {
      this.room.broadcast({ t: 'snap', s: race.snapshot(this.acks()), ev: ev.filter(e => e.type !== 'jump') });
    }
    if (race.over) this.endRace();
  }

  private bankRound(rows: RoundRow[]) {
    applyRound(rows, this.tally);
    for (const r of rows) r.matchTotal = this.tally.get(r.pid)!.score;
    this.results.push(rows);
    // a coin carried to the flag is spent for the rest of the match
    if (this.race) for (const c of this.race.coins) if (c.state === 'banked') this.world.consumeCoin(c.id);
  }

  private endRace() {
    const race = this.race!;
    const rows = this.liveRows();
    this.bankRound(rows);
    const finishers = rows.filter(r => r.time !== null).length;
    this.refreshNav();
    const open = this.nav.reach(false).finish;
    // nobody finished, or the route search says the course is shut: guarantee a bomb in the next draft (see makePool)
    this.needDemolition = !open || (this.competitive && finishers === 0);
    this.setPhase('results', TIMERS.resultsMs);
    this.room.broadcast({ t: 'results', round: this.round, rows, competitive: this.competitive });
    void race;
  }

  /** Somebody reached the score to win: end the match now, exactly once. */
  private endByTarget(rows: RoundRow[], winners: string[]) {
    if (this.matchResult) return;
    this.bankRound(rows);
    const { order } = rankMatch(this.roster, this.tally);
    this.matchResult = { order, winners, rows };
    this.phase = 'matchEnd';
    this.race = null;
    this.setPhase('matchEnd', 0);
    for (const m of this.room.members) if (!m.bot && m.connected) this.sendMatchEnd(m.id);
  }

  private sendMatchEnd(id: string) {
    const r = this.matchResult;
    if (!r) return;
    this.room.send(id, { t: 'matchEnd', order: r.order, winners: r.winners, tally: Object.fromEntries(this.tally), votes: [...this.room.votes], target: this.target, rows: r.rows, round: this.round });
  }

  // ---------------- clock
  tick() {
    if (this.disposed) return;
    const now = this.now;
    switch (this.phase) {
      case 'draft':
        if (this.draftStage === 'humans') {
          // the humans' clock; bots do nothing until it ends or every human has picked
          if (now >= this.deadline) { this.endHumanStage(); }
          break;
        }
        for (const [id, at] of this.botTimers) {
          if (now < at || this.cardOf.has(id)) continue;
          this.botTimers.delete(id);
          const m = this.room.member(id)!;
          const card = botPickCard(this.pool, m.difficulty ?? 'medium', this.rng, this.needDemolition, this.world.playerObjectCount(), !this.courseOpen);
          if (card) this.claim(id, card.id, this.round);
          if (this.phase !== 'draft') return;
        }
        if (now >= this.deadline) this.finishDraft();
        break;
      case 'build':
        for (const [id, at] of this.botTimers) {
          if (now < at || this.done.has(id)) continue;
          this.botTimers.delete(id);
          this.botBuild(id);
          if (this.phase !== 'build') return;
        }
        if (now >= this.deadline) this.finishBuild();
        break;
      case 'countdown':
        if (now >= this.deadline) { this.setPhase('race', (this.race!.opts.maxTicks / TICK_HZ) * 1000); }
        break;
      case 'race':
        this.stepRace();
        break;
      case 'results':
        if (now >= this.deadline) this.startDraft(); // no round limit: the match goes on until somebody reaches the score to win
        break;
      default: break;
    }
  }

  private botBuild(id: string) {
    const item = this.itemOf(id);
    if (!item) { this.done.add(id); return; }
    const def = getItem(item);
    const m = this.room.member(id)!;
    this.refreshNav();
    // on an unfinished course a bot with a building piece helps bridge it: the spot that gets players furthest wins
    const cands = !this.courseOpen && def.group === 'construction'
      ? botBridgeCandidates(this.world, this.nav, def, this.rng, 5)
      : botPlacementCandidates(this.world, this.nav, def, m.difficulty ?? 'medium', this.rng, 4);
    for (const req of cands) {
      if (this.placeQuiet(id, req)) return;
    }
    // nothing near the route worked: try anywhere legal, then give up visibly
    for (const req of randomCandidates(this.world, def, this.rng, 3)) if (this.placeQuiet(id, req)) return;
    this.done.add(id);
    this.room.broadcast({ t: 'skip', pid: id, msg: `${m.name} couldn’t find a spot for ${def.name}` });
    if (this.roster.every(r => this.done.has(r))) this.startCountdown();
  }

  /** Solo practice only: restart the current race instantly. Never available in competitive rooms. */
  practiceRetry() {
    if (this.room.mode !== 'practice') return;
    if (this.phase === 'race' || this.phase === 'countdown') this.startCountdown();
  }

  private placeQuiet(id: string, req: PlaceRequest): boolean { return this.place(id, req, this.round); }
}

export const SERVER_VERSION = PROTOCOL_VERSION;
