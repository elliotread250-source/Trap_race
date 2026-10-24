// Typed network messages and server-side validation of everything a client sends.
import { EMOTES, type Difficulty } from './config';
import type { PlacedObject, WorldSnapshot } from './world';
import type { RaceEvent, RaceSnapshot } from './race';
import type { RoundRow, PlayerTally } from './scoring';

export type Phase = 'lobby' | 'draft' | 'build' | 'countdown' | 'race' | 'results' | 'matchEnd';
/** Drafting order: every human picks first, then the AI picks from what is left. */
export type DraftStage = 'humans' | 'ai';

export interface MemberInfo {
  id: string; name: string; skin: number; color: number; bot: boolean; difficulty?: Difficulty;
  ready: boolean; connected: boolean; host: boolean; spectator: boolean;
}

export interface Card { id: string; item: string; by: string | null }

export interface RoomInfo {
  code: string; mode: 'online' | 'practice'; mapId: string; /** score to win, whole points (5-15) */ target: number; members: MemberInfo[];
  phase: Phase; round: number; youId: string; inviteable: boolean;
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; skin: number; token?: string }
  | { t: 'create'; mode: 'online' | 'practice' | 'bots'; bots?: number; difficulty?: Difficulty; mapId?: string }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'ready'; ready: boolean }
  | { t: 'profile'; name: string; skin: number }
  | { t: 'host'; a: 'map'; mapId: string }
  | { t: 'host'; a: 'target'; target: number }
  | { t: 'host'; a: 'addBot'; difficulty: Difficulty }
  | { t: 'host'; a: 'removeBot'; id: string }
  | { t: 'host'; a: 'botDiff'; id: string; difficulty: Difficulty }
  | { t: 'host'; a: 'start' }
  | { t: 'host'; a: 'lobby' }
  | { t: 'host'; a: 'rematch'; mapId?: string }
  | { t: 'claim'; round: number; card: string }
  | { t: 'place'; round: number; x: number; y: number; rot: number; variant: number }
  | { t: 'in'; round: number; s: number; b: number[] }
  | { t: 'vote'; rematch: boolean }
  | { t: 'ping'; c: number }
  | { t: 'emote'; e: number };

export type ServerMsg =
  | { t: 'welcome'; you: string; token: string; code: string }
  | { t: 'room'; room: RoomInfo }
  | { t: 'error'; code: string; msg: string }
  | { t: 'phase'; phase: Phase; round: number; target: number; endsIn: number; mapId: string; competitive: boolean; tally: Record<string, PlayerTally> }
  | { t: 'world'; world: WorldSnapshot }
  | { t: 'draft'; cards: Card[]; demolition: boolean; open?: boolean; stage: DraftStage }
  | { t: 'claimed'; card: string; by: string }
  | { t: 'claimFail'; card: string; msg: string }
  | { t: 'placed'; obj: PlacedObject; by: string; version: number }
  | { t: 'removed'; ids: string[]; by: string; cells: [number, number][]; version: number }
  | { t: 'placeFail'; msg: string }
  | { t: 'skip'; pid: string; msg: string }
  | { t: 'raceStart'; ids: string[]; roundKey: string; maxTicks: number }
  | { t: 'snap'; s: RaceSnapshot; ev: RaceEvent[] }
  | { t: 'results'; round: number; rows: RoundRow[]; competitive: boolean }
  | { t: 'matchEnd'; order: string[]; winners: string[]; tally: Record<string, PlayerTally>; votes: string[]; target: number; rows: RoundRow[]; round: number }
  | { t: 'votes'; votes: string[] }
  | { t: 'notice'; msg: string }
  | { t: 'pong'; c: number; s: number; r?: string }
  | { t: 'emote'; pid: string; e: number };

const DIFFS = new Set(['easy', 'medium', 'hard']);
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Structural validation; anything unexpected is rejected rather than coerced. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'hello': return int(m.v, 0, 1e6) && str(m.name, 64) && int(m.skin, 0, 63) && (m.token === undefined || str(m.token, 128)) ? (m as ClientMsg) : null;
    case 'create': return (m.mode === 'online' || m.mode === 'practice' || m.mode === 'bots') && (m.bots === undefined || int(m.bots, 0, 5)) && (m.difficulty === undefined || DIFFS.has(m.difficulty as string)) && (m.mapId === undefined || str(m.mapId, 32)) ? (m as ClientMsg) : null;
    case 'join': return str(m.code, 12) ? (m as ClientMsg) : null;
    case 'leave': return m as ClientMsg;
    case 'ready': return typeof m.ready === 'boolean' ? (m as ClientMsg) : null;
    case 'profile': return str(m.name, 64) && int(m.skin, 0, 63) ? (m as ClientMsg) : null;
    case 'host':
      switch (m.a) {
        case 'map': return str(m.mapId, 32) ? (m as ClientMsg) : null;
        case 'target': return typeof m.target === 'number' ? (m as ClientMsg) : null; // range is enforced by the room, which answers with an error
        case 'addBot': return DIFFS.has(m.difficulty as string) ? (m as ClientMsg) : null;
        case 'removeBot': return str(m.id, 32) ? (m as ClientMsg) : null;
        case 'botDiff': return str(m.id, 32) && DIFFS.has(m.difficulty as string) ? (m as ClientMsg) : null;
        case 'start': case 'lobby': return m as ClientMsg;
        case 'rematch': return m.mapId === undefined || str(m.mapId, 32) ? (m as ClientMsg) : null;
        default: return null;
      }
    case 'claim': return int(m.round, 0, 999) && str(m.card, 32) ? (m as ClientMsg) : null;
    case 'place': return int(m.round, 0, 999) && int(m.x, -1000, 1000) && int(m.y, -1000, 1000) && int(m.rot, 0, 3) && int(m.variant, 0, 3) ? (m as ClientMsg) : null;
    case 'in': return int(m.round, 0, 999) && int(m.s, 0, 1e9) && Array.isArray(m.b) && m.b.length <= 30 && m.b.every(x => int(x, 0, 31)) ? (m as ClientMsg) : null;
    case 'vote': return typeof m.rematch === 'boolean' ? (m as ClientMsg) : null;
    case 'ping': return typeof m.c === 'number' ? (m as ClientMsg) : null;
    case 'emote': return int(m.e, 0, EMOTES.length - 1) ? (m as ClientMsg) : null;
    default: return null;
  }
}

export function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g'), '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}
