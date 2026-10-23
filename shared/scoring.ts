// Server-side scoring in integer tenths of a point. Idempotent: rows are computed from the round's unique events, never accumulated from callbacks.
import { SCORING, TICK_HZ } from './config';
import type { PlayerStatus, RaceEvent } from './race';

export interface RoundRow {
  pid: string;
  status: PlayerStatus | 'absent';
  time: number | null; // seconds, finishers only
  base: number;
  first: number;
  sole: number;
  trap: number;
  coins: number;
  total: number;
  matchTotal: number;
  cause?: string;
  killer?: string | null;
}

export interface PlayerTally { score: number; finishes: number; finishTime: number }

/**
 * @param roster participants at round start (decides competitiveness, never changes mid-round)
 * @param competitive true when the round started with 2+ competitors (bots count)
 * @param outcomeKnown nobody is still racing, so the sole-finisher bonus can be decided. Callers scoring mid-race pass false.
 */
export function scoreRound(roster: string[], competitive: boolean, events: RaceEvent[], statuses: Map<string, PlayerStatus>, prev: Map<string, PlayerTally>, outcomeKnown = true): RoundRow[] {
  const inRoster = new Set(roster);
  const seen = new Set<string>();
  const unique = events.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const finishTick = new Map<string, number>();
  for (const e of unique) if (e.type === 'finish' && inRoster.has(e.pid) && !finishTick.has(e.pid)) finishTick.set(e.pid, e.tick);
  const earliest = finishTick.size ? Math.min(...finishTick.values()) : -1;
  const trapPts = new Map<string, number>();
  const victims = new Set<string>();
  if (competitive) {
    for (const e of unique) {
      if (e.type !== 'death' || !e.credit || e.credit === e.pid || victims.has(e.pid)) continue;
      if (!inRoster.has(e.credit) || !inRoster.has(e.pid)) continue;
      victims.add(e.pid);
      trapPts.set(e.credit, Math.min(SCORING.trapCapElimsPerRound * SCORING.trapElim, (trapPts.get(e.credit) ?? 0) + SCORING.trapElim));
    }
  }
  const coinPts = new Map<string, number>();
  const banked = new Set<string>();
  for (const e of unique) {
    if (e.type !== 'bank' || banked.has(e.coin) || !finishTick.has(e.pid)) continue;
    banked.add(e.coin);
    coinPts.set(e.pid, (coinPts.get(e.pid) ?? 0) + SCORING.coin);
  }
  const deaths = new Map<string, Extract<RaceEvent, { type: 'death' }>>();
  for (const e of unique) if (e.type === 'death' && !deaths.has(e.pid)) deaths.set(e.pid, e);
  return roster.map(pid => {
    const ft = finishTick.get(pid);
    const fin = ft !== undefined;
    const base = fin ? SCORING.finish : 0;
    const first = competitive && fin && ft === earliest ? SCORING.firstFinisher : 0;
    // the sole bonus is only earned once the round is decided: nobody else can still finish
    const sole = competitive && outcomeKnown && fin && finishTick.size === 1 ? SCORING.soleFinisher : 0;
    const trap = trapPts.get(pid) ?? 0;
    const coins = coinPts.get(pid) ?? 0;
    const total = base + first + sole + trap + coins;
    const before = prev.get(pid)?.score ?? 0;
    const d = deaths.get(pid);
    return {
      pid, status: statuses.get(pid) ?? 'absent', time: fin ? ft! / TICK_HZ : null,
      base, first, sole, trap, coins, total, matchTotal: before + total, cause: d?.cause, killer: d?.credit ?? null,
    };
  });
}

export function applyRound(rows: RoundRow[], tally: Map<string, PlayerTally>) {
  for (const r of rows) {
    const t = tally.get(r.pid) ?? { score: 0, finishes: 0, finishTime: 0 };
    t.score += r.total;
    if (r.time !== null) { t.finishes++; t.finishTime += r.time; }
    tally.set(r.pid, t);
  }
}

/** Highest score, then most finishes, then lowest cumulative finish time; still equal means a shared win. */
export function rankMatch(ids: string[], tally: Map<string, PlayerTally>): { order: string[]; winners: string[] } {
  const get = (id: string) => tally.get(id) ?? { score: 0, finishes: 0, finishTime: 0 };
  const cmp = (a: string, b: string) => {
    const A = get(a), B = get(b);
    if (B.score !== A.score) return B.score - A.score;
    if (B.finishes !== A.finishes) return B.finishes - A.finishes;
    if (A.finishes > 0 && Math.abs(A.finishTime - B.finishTime) > 1e-9) return A.finishTime - B.finishTime;
    return 0;
  };
  const order = [...ids].sort(cmp);
  const winners = order.length ? order.filter(id => cmp(id, order[0]) === 0) : [];
  return { order, winners };
}
