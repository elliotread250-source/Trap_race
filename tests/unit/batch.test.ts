// Acceptance tests for the October 2026 batch update: controls, item changes, scoring rules, new items, sandbox and maps.
import { describe, expect, it } from 'vitest';
import { CELL, PHYS, SKIN_COUNT, TIMERS } from '../../shared/config';
import { IN_DOWN, IN_JUMP } from '../../shared/physics';
import type { ServerMsg } from '../../shared/protocol';
import { RaceSim, type RaceEvent } from '../../shared/race';
import { Room } from '../../server/room';
import { floorY, lab, put } from './helpers';

const C = CELL, W = PHYS.bodyW, H = PHYS.bodyH;

export const run = (sim: RaceSim, n: number, inputs: Record<string, number> = {}) => {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n && !sim.over; i++) { sim.step(new Map(Object.entries(inputs))); ev.push(...sim.drainEvents()); }
  return ev;
};
export const at = (sim: RaceSim, id: string, x: number, y: number) => { const b = sim.player(id)!.body; b.x = x; b.y = y; b.vx = 0; b.vy = 0; b.grounded = false; };

// ================================================================ Phase 1
describe('phase 1: controls and small fixes', () => {
  it('drops through a one-way platform with Down alone, and Down + Jump still drops instead of jumping', () => {
    for (const bits of [IN_DOWN, IN_DOWN | IN_JUMP]) {
      const w = lab();
      put(w, 'oneway', 8, 12);
      const sim = new RaceSim(w, ['a'], { roundKey: 'ow', maxTicks: 4000 });
      at(sim, 'a', 8 * C + 10, 12 * C - H);
      run(sim, 20);
      expect(sim.player('a')!.body.y).toBeCloseTo(12 * C - H, 3); // standing on it
      run(sim, 3, { a: bits });
      run(sim, 60);
      expect(sim.player('a')!.body.y).toBeCloseTo(floorY(), 3); // fell through to the floor
    }
  });

  it('does not drop through a solid floor when pressing Down', () => {
    const w = lab();
    const sim = new RaceSim(w, ['a'], { roundKey: 'ow2', maxTicks: 4000 });
    at(sim, 'a', 8 * C, floorY());
    run(sim, 40, { a: IN_DOWN });
    expect(sim.player('a')!.body.y).toBeCloseTo(floorY(), 3);
  });

  it('never auto-places an item whose owner ran out of build time', () => {
    const msgs: ServerMsg[] = [];
    const prev = { ...TIMERS };
    try {
      TIMERS.buildMs = 400; TIMERS.draftMs = 400;
      const room = new Room('AUTO', 'online', (_id, m) => msgs.push(m), 7);
      const me = room.addHuman('Idle', 0) as { id: string };
      room.addBot('easy');
      room.startMatch();
      const m = room.match!;
      // pick a construction card for the idle human, then never place it
      for (let i = 0; i < 2000 && m.phase !== 'build'; i++) { if (!m.cardOf.has(me.id)) { const c = m.pool.find(k => !k.by && m.isBot(me.id) === false); if (c) m.claim(me.id, c.id, m.round); } room.tick(); }
      for (let i = 0; i < 2000 && m.phase === 'build'; i++) room.tick();
      const placedByMe = msgs.filter(x => x.t === 'placed' && x.by === me.id);
      expect(placedByMe).toHaveLength(0);
      expect(msgs.some(x => x.t === 'skip' && x.pid === me.id)).toBe(true);
    } finally { Object.assign(TIMERS, prev); }
  });

  it('offers sixteen skins and accepts every one of them', () => {
    expect(SKIN_COUNT).toBe(16);
    const room = new Room('SKIN', 'online', () => {}, 1);
    const m = room.addHuman('S', 15) as { skin: number };
    expect(m.skin).toBe(15);
  });

  it('keeps the barbed wire hitbox exactly the same thin strip', async () => {
    const { wireStripPx } = await import('../../shared/world');
    expect(wireStripPx(3, 4, 0)).toEqual({ x: 3 * C, y: 4 * C + C - 11, w: C, h: 11 });
    void W;
  });
});

// ================================================================ Phase 2
import { HAZARD, MOVERS } from '../../shared/config';
import { childRect } from '../../shared/movers';
import { applyBomb, checkPlacement } from '../../shared/placement';
import { IN_RIGHT } from '../../shared/physics';

describe('phase 2: changes to existing items', () => {
  it('ferris wheel: accepted when one gondola is clear of walls even if it overlaps a non-solid item; pivot may sit in a wall', () => {
    const w = lab();
    const probe = { id: '_', item: 'wheel', owner: null, prov: 'player' as const, x: 13, y: 10, rot: 0 as const, variant: 0, cells: [[13, 10] as [number, number]], attach: null, round: 0 };
    for (const i of [0, 2, 3]) { const r = childRect(probe, i, 0); put(w, 'block_1x1', Math.floor((r.x + r.w / 2) / C), Math.floor((r.y + r.h / 2) / C), 0, 'other'); }
    const r1 = childRect(probe, 1, 0);
    put(w, 'coin', Math.floor((r1.x + 10) / C), Math.floor((r1.y + r1.h / 2) / C), 0, 'other'); // a coin under the free gondola
    const chk = checkPlacement(w, { item: 'wheel', x: 13, y: 10, rot: 0, variant: 0 });
    expect(chk.ok).toBe(true);
    expect(chk.validChildren).toEqual([1]);
    // pivot inside the 12-cell wall (columns 20-21, rows 4..15): the side gondolas reach open air
    expect(checkPlacement(lab(), { item: 'wheel', x: 20, y: 9, rot: 0, variant: 0 }).ok).toBe(true);
  });

  it('saw rails take no grid squares: they go through blocks, blocks go on them, same-kind overlap is refused, bombs still remove them', () => {
    const w = lab();
    const b = put(w, 'block_1x1', 9, 10);
    const saw = put(w, 'saw', 8, 10); // rail 8..11 through the block
    expect(saw.cells.map(c => c.join(','))).toContain('9,10');
    expect(w.occAt(8, 10)).toBe('');
    put(w, 'spiky_oval', 10, 10); // built over the rail
    expect(checkPlacement(w, { item: 'saw', x: 6, y: 10, rot: 0, variant: 0 }).reason).toMatch(/Overlaps another Saw Rail/);
    expect(checkPlacement(w, { item: 'saw', x: 18, y: 10, rot: 0, variant: 0 }).reason).toMatch(/terrain/); // into the wall
    const bomb = checkPlacement(w, { item: 'bomb_1', x: 11, y: 10, rot: 0, variant: 0 });
    expect(bomb.ok).toBe(true);
    expect(bomb.targets).toContain(saw.id);
    applyBomb(w, [...bomb.targets!, ...bomb.dependents!]);
    expect(w.objects.has(saw.id)).toBe(false);
    expect(w.objects.has(b.id)).toBe(true);
  });

  it('the saw blade still kills where it passes through a block', () => {
    const w = lab();
    put(w, 'block_1x1', 9, 15);
    put(w, 'saw', 8, 15);
    const sim = new RaceSim(w, ['a'], { roundKey: 'saw', maxTicks: 4000 });
    at(sim, 'a', 11 * C + 10, floorY());
    const ev = run(sim, Math.round(HAZARD.sawPeriod * 60));
    expect(ev.some(e => e.type === 'death' && e.cause === 'saw')).toBe(true);
  });

  it('a crumbling platform that breaks loses every one of its cells at once', () => {
    const w = lab();
    const c = put(w, 'crumble', 10, 13);
    const sim = new RaceSim(w, ['a'], { roundKey: 'cr', maxTicks: 4000 });
    for (let k = 0; k < HAZARD.crumbleHits; k++) { at(sim, 'a', 10 * C + 4, 11 * C); run(sim, 40); }
    expect(sim.crumbles.get(c.id)!.broken).toBe(true);
    for (const [x, y] of c.cells) expect(sim.isSolid(x, y)).toBe(false);
  });

  it('the shuttle block travels 9 cells', () => {
    expect(MOVERS.shuttleTravelCells).toBe(9);
    const sh = put(lab(), 'shuttle', 3, 6);
    expect((childRect(sh, 0, MOVERS.shuttlePeriodTicks / 2).x - childRect(sh, 0, 0).x) / C).toBe(9);
  });

  it('barbed wire bolts onto a shuttle, rides with it through a wall and kills where it is, not where it started', () => {
    const w = lab();
    const sh = put(w, 'shuttle', 15, 12); // 2x1 at 15-16, slides 9 right through the wall at 20-21
    const wire = put(w, 'wire_2', 15, 11, 0); // on its top face
    expect(wire.attach).toBe(sh.id);
    expect(wire.cells).toHaveLength(2);
    expect(checkPlacement(w, { item: 'wire_1', x: 17, y: 12, rot: 3, variant: 0 }).ok).toBe(false); // occupied? no: right face is free, but rot 3 needs the block to its right
    const sim = new RaceSim(w, ['a'], { roundKey: 'mw', maxTicks: 4000 });
    expect(sim.moverWires).toHaveLength(1);
    const half = MOVERS.shuttlePeriodTicks / 2;
    run(sim, half);
    const strips = sim.moverWireRects(sim.moverWires[0], sim.moverWires[0].m.rect);
    expect(strips[0].x).toBeCloseTo((15 + 9) * C, 3); // through the wall and out the other side
    // standing at the starting spot is now safe; standing under the moved wire is not
    at(sim, 'a', 15 * C + 8, 11 * C + 20);
    run(sim, 1);
    expect(sim.player('a')!.status).toBe('racing');
    const sim2 = new RaceSim(w, ['a'], { roundKey: 'mw2', maxTicks: 4000 });
    run(sim2, half);
    at(sim2, 'a', 24 * C + 10, 11 * C + 10);
    const ev = run(sim2, 2);
    expect(ev.some(e => e.type === 'death' && e.cause === 'wire' && e.credit === 'p1')).toBe(true); // p1 owns the wire, 'a' is the victim
    // bombing the shuttle removes the wire with it
    const bomb = checkPlacement(w, { item: 'bomb_1', x: 15, y: 12, rot: 0, variant: 0 });
    expect(bomb.dependents).toContain(wire.id);
  });

  it('barbed wire rides a 3x1 moving platform; Ferris wheels still refuse attachments', () => {
    const w = lab();
    const mp = put(w, 'moving', 8, 12);
    const wire = put(w, 'wire_3', 8, 13, 2); // underneath
    expect(wire.attach).toBe(mp.id);
    const sim = new RaceSim(w, ['a'], { roundKey: 'mp', maxTicks: 4000 });
    run(sim, 60);
    const r = sim.moverWireRects(sim.moverWires[0], sim.moverWires[0].m.rect)[0];
    expect(r.x).toBeGreaterThan(8 * C + 40);
    const w2 = lab();
    put(w2, 'wheel', 13, 8);
    const g = childRect(w2.objects.get([...w2.objects.keys()].pop()!)!, 1, 0);
    void g;
    expect(checkPlacement(w2, { item: 'wire_1', x: 13, y: 7, rot: 0, variant: 0 }).ok).toBe(false);
  });

  it('players can stand on a crossbow (and run off it)', () => {
    const w = lab();
    put(w, 'crossbow', 10, 13);
    const sim = new RaceSim(w, ['a'], { roundKey: 'xb', maxTicks: 4000 });
    at(sim, 'a', 10 * C + 10, 12 * C);
    run(sim, 40);
    const b = sim.player('a')!.body;
    expect(b.grounded).toBe(true);
    expect(b.y).toBeCloseTo(13 * C - H, 3);
    run(sim, 30, { a: IN_RIGHT });
    expect(sim.player('a')!.status).toBe('racing');
  });
});

// ================================================================ Phase 3
import { MATCH, SCORING } from '../../shared/config';
import { rankMatch, scoreRound, type PlayerTally } from '../../shared/scoring';

const fin = (pid: string, tick: number): RaceEvent => ({ id: `f:${pid}`, t: tick, type: 'finish', pid, tick });
const st = (m: Record<string, string>) => new Map(Object.entries(m)) as Map<string, 'finished' | 'dead'>;

describe('phase 3: scoring, rules and game settings', () => {
  it('a coin is worth exactly 1 point', () => { expect(SCORING.coin).toBe(SCORING.unit); });

  it('a sole finisher gets the sole bonus but not the first-finisher bonus; two finishers: first only', () => {
    const one = scoreRound(['a', 'b'], true, [fin('a', 100)], st({ a: 'finished', b: 'dead' }), new Map());
    expect(one[0]).toMatchObject({ base: 10, first: 0, sole: SCORING.soleFinisher, total: 10 + SCORING.soleFinisher });
    const two = scoreRound(['a', 'b'], true, [fin('a', 100), fin('b', 200)], st({ a: 'finished', b: 'finished' }), new Map());
    expect(two[0]).toMatchObject({ first: SCORING.firstFinisher, sole: 0 });
    expect(two[1]).toMatchObject({ first: 0, sole: 0 });
  });

  it('pays the comeback point only to finishers on a 4+ round miss streak', () => {
    const rows = scoreRound(['a', 'b', 'c'], true, [fin('a', 100), fin('b', 120)], st({ a: 'finished', b: 'finished', c: 'dead' }), new Map(), true, new Set(['a', 'c']));
    expect(rows.find(r => r.pid === 'a')!.comeback).toBe(SCORING.comeback);
    expect(rows.find(r => r.pid === 'b')!.comeback).toBe(0);
    expect(rows.find(r => r.pid === 'c')!.comeback).toBe(0); // eligible but did not finish
  });

  it('tracks the miss streak per player and resets it on a finish', () => {
    const room = new Room('CMB', 'online', () => {}, 3);
    const h = room.addHuman('H', 0) as { id: string };
    room.addBot('easy');
    room.startMatch();
    const m = room.match!;
    const bank = (m as unknown as { bankRound(r: unknown[]): void }).bankRound.bind(m);
    const row = (pid: string, finished: boolean) => ({ pid, status: finished ? 'finished' : 'dead', time: finished ? 10 : null, base: 0, first: 0, sole: 0, trap: 0, coins: 0, comeback: 0, total: 0, matchTotal: 0 });
    for (let i = 0; i < 4; i++) bank([row(h.id, false)]);
    expect(m.missStreak.get(h.id)).toBe(4);
    bank([row(h.id, true)]);
    expect(m.missStreak.get(h.id)).toBe(0);
  });

  it('round limit and points to win can each be off but never both; ranges are validated', () => {
    const errs: string[] = [];
    const room = new Room('RL', 'online', (_i, msg) => { if (msg.t === 'error') errs.push(msg.msg); }, 1);
    const h = room.addHuman('H', 0) as { id: string };
    room.handle(h.id, { t: 'host', a: 'target', target: 0 }); // round limit is off: refused
    expect(room.target).toBe(MATCH.defaultTarget);
    room.handle(h.id, { t: 'host', a: 'rounds', rounds: 8 });
    expect(room.roundLimit).toBe(8);
    room.handle(h.id, { t: 'host', a: 'target', target: 0 });
    expect(room.target).toBe(0);
    room.handle(h.id, { t: 'host', a: 'rounds', rounds: 0 }); // would leave both off
    expect(room.roundLimit).toBe(8);
    room.handle(h.id, { t: 'host', a: 'rounds', rounds: 2 });
    expect(room.roundLimit).toBe(8);
    expect(errs.length).toBe(3);
  });

  it('ends after the round limit with the most points winning; ties break on finishes, then shared', () => {
    const tally = new Map<string, PlayerTally>([['a', { score: 30, finishes: 3, finishTime: 40 }], ['b', { score: 30, finishes: 2, finishTime: 20 }], ['c', { score: 10, finishes: 1, finishTime: 9 }]]);
    expect(rankMatch(['a', 'b', 'c'], tally).winners).toEqual(['a']);
    tally.set('b', { score: 30, finishes: 3, finishTime: 40 });
    expect(rankMatch(['a', 'b', 'c'], tally).winners.sort()).toEqual(['a', 'b']);
    // a real match with a 3-round limit and no points target finishes on its own
    const prev = { ...TIMERS };
    try {
      Object.assign(TIMERS, { draftMs: 300, buildMs: 300, raceMs: 1500, resultsMs: 300, countdownMs: 100 });
      const msgs: ServerMsg[] = [];
      const room = new Room('RL2', 'online', (_i, m) => msgs.push(m), 5);
      const h = room.addHuman('H', 0) as { id: string };
      room.addBot('easy');
      room.handle(h.id, { t: 'host', a: 'rounds', rounds: 3 });
      room.handle(h.id, { t: 'host', a: 'target', target: 0 });
      room.startMatch();
      for (let i = 0; i < 60 * 120 && room.phase !== 'matchEnd'; i++) room.tick();
      expect(room.phase).toBe('matchEnd');
      expect(room.match!.round).toBe(3);
      const end = msgs.find(m => m.t === 'matchEnd') as Extract<ServerMsg, { t: 'matchEnd' }>;
      expect(end.reason).toBe('rounds');
      expect(end.winners.length).toBeGreaterThan(0);
    } finally { Object.assign(TIMERS, prev); }
  });

  it('individual win requirements: each player (bots included) wins at their own target', () => {
    const room = new Room('HC', 'online', () => {}, 2);
    const h = room.addHuman('H', 0) as { id: string };
    const b = room.addBot('hard') as { id: string };
    room.handle(h.id, { t: 'host', a: 'memberTarget', id: b.id, target: 15 });
    room.handle(h.id, { t: 'host', a: 'memberTarget', id: h.id, target: 5 });
    expect(room.member(b.id)!.target).toBe(15);
    room.startMatch();
    expect(room.match!.targets.get(b.id)).toBe(15);
    expect(room.match!.targets.get(h.id)).toBe(5);
    // ranking by share of their own requirement: 5/5 beats 10/15
    const tally = new Map<string, PlayerTally>([[h.id, { score: 50, finishes: 5, finishTime: 50 }], [b.id, { score: 100, finishes: 9, finishTime: 50 }]]);
    expect(rankMatch([h.id, b.id], tally, new Map([[h.id, 50], [b.id, 150]])).winners).toEqual([h.id]);
  });
});
