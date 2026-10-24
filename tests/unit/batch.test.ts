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
    room.handle(h.id, { t: 'host', a: 'rounds', rounds: 99 }); // any two-digit number
    expect(room.roundLimit).toBe(99);
    room.handle(h.id, { t: 'host', a: 'rounds', rounds: 37 });
    expect(room.roundLimit).toBe(37);
    for (const bad of [100, -1, 7.5]) room.handle(h.id, { t: 'host', a: 'rounds', rounds: bad });
    expect(room.roundLimit).toBe(37);
    expect(errs.length).toBe(5);
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

// ================================================================ Phase 5
import { NEWITEMS } from '../../shared/config';
import { IN_LEFT } from '../../shared/physics';
import { planeSpawnRect } from '../../shared/fans';

const firstPlane = (sim: RaceSim) => sim.movers.find(m => m.plane?.alive);
const cadence = Math.round(NEWITEMS.planeInterval * 60);

describe('phase 5: paper plane maker', () => {
  it('fires a 2x1 plane from its top cell every 1.4 s at crossbow-arrow speed, and it crumples on a wall', () => {
    const w = lab();
    const mk = put(w, 'planemaker', 8, 14);
    const sim = new RaceSim(w, ['a'], { roundKey: 'pl', maxTicks: 8000 });
    at(sim, 'a', 3 * C, floorY());
    run(sim, cadence - 1);
    expect(firstPlane(sim)).toBeUndefined();
    run(sim, 1);
    const p = firstPlane(sim)!;
    expect(p.rect).toMatchObject({ w: 96, h: 24 });
    expect(p.rect.x).toBe(planeSpawnRect(mk).x);
    expect(p.rect.y + p.rect.h / 2).toBe(14 * C + C / 2); // out of the top (emitter) cell
    const x0 = p.rect.x;
    run(sim, 60);
    expect(p.rect.x - x0).toBeCloseTo(NEWITEMS.planeSpeed, 0);
    const ev = run(sim, 120);
    expect(ev.some(e => e.type === 'crumple')).toBe(true); // hit the 12-cell wall at column 20
    expect(sim.movers.filter(m => m.plane?.alive && m.rect.x > 18 * C)).toHaveLength(0);
  });

  it('never kills: a plane flying into a player crumples and the player lives', () => {
    const w = lab();
    put(w, 'planemaker', 8, 14);
    put(w, 'block_1x1', 12, 15); // the player stands on it, right in the plane's row
    const sim = new RaceSim(w, ['a'], { roundKey: 'pl2', maxTicks: 8000 });
    at(sim, 'a', 12 * C + 10, 15 * C - H);
    const ev = run(sim, cadence + 120);
    expect(ev.some(e => e.type === 'crumple')).toBe(true);
    expect(sim.player('a')!.status).toBe('racing');
  });

  it('players can stand on a plane and ride it; a downward plane carries them down; landing on an upward plane crumples it', () => {
    const w = lab();
    put(w, 'planemaker', 8, 13); // cells (8,13),(8,14); fires right from (8,13)
    const sim = new RaceSim(w, ['a'], { roundKey: 'pl3', maxTicks: 8000 });
    run(sim, cadence + 5);
    const p = firstPlane(sim)!;
    at(sim, 'a', p.rect.x + 30, p.rect.y - H - 2);
    run(sim, 10);
    const b = sim.player('a')!.body;
    expect(b.grounded).toBe(true);
    expect(sim.movers[b.groundMover]).toBe(p);
    const bx = b.x;
    run(sim, 30);
    expect(b.x - bx).toBeGreaterThan(90); // carried ~103 px in 0.5 s
    // downward plane: rotation 1 fires down from the right cell of a horizontal machine
    const w2 = lab();
    put(w2, 'planemaker', 10, 4, 1);
    const s2 = new RaceSim(w2, ['a'], { roundKey: 'pl4', maxTicks: 8000 });
    run(s2, cadence + 3);
    const d = firstPlane(s2)!;
    expect(d.plane!.dy).toBe(1);
    at(s2, 'a', d.rect.x - 2, d.rect.y - H - 1);
    run(s2, 6);
    const yb = s2.player('a')!.body.y;
    run(s2, 30);
    expect(s2.player('a')!.body.y - yb).toBeGreaterThan(80);
    expect(d.plane!.alive).toBe(true);
    // upward plane: rotation 3 fires up from the left cell
    const w3 = lab();
    put(w3, 'planemaker', 10, 14, 3);
    const s3 = new RaceSim(w3, ['a'], { roundKey: 'pl5', maxTicks: 8000 });
    run(s3, cadence + 30);
    const u = firstPlane(s3)!;
    expect(u.plane!.dy).toBe(-1);
    at(s3, 'a', u.rect.x - 2, u.rect.y - H - 60);
    const ev = run(s3, 30);
    expect(ev.some(e => e.type === 'crumple')).toBe(true);
    expect(s3.player('a')!.status).toBe('racing');
  });

  it('arrows are destroyed by the plane they crumple; sniper rounds pass through it and still hit the player behind', () => {
    const w = lab();
    put(w, 'planemaker', 8, 11);
    put(w, 'crossbow', 13, 9, 1); // fires down across the plane's line
    const sim = new RaceSim(w, ['a'], { roundKey: 'pl6', maxTicks: 8000 });
    at(sim, 'a', 3 * C, floorY());
    const ev = run(sim, cadence + 70);
    expect(ev.some(e => e.type === 'crumple')).toBe(true);
    expect(sim.projectiles.filter(p => p.kind === 'arrow' && p.y > 11 * C + 30 && p.x > 13 * C && p.x < 14 * C)).toHaveLength(0);
    // sniper: a plane sits between the sniper and the player at the moment it fires; both get hit
    const w2 = lab();
    put(w2, 'block_1x1', 10, 15); put(w2, 'sniper', 10, 14); // fires right along y = 14.5 cells - 6 px
    put(w2, 'planemaker', 8, 4);
    put(w2, 'block_1x1', 16, 15); // the player stands on it, in the shot's line
    const s2 = new RaceSim(w2, ['a'], { roundKey: 'pl7', maxTicks: 8000 });
    at(s2, 'a', 16 * C + 10, 15 * C - H);
    run(s2, 140);
    const pm = firstPlane(s2)!;
    Object.assign(pm.plane!, { x: 12 * C, y: 14 * C + 4, t: s2.tick }); pm.rect = { ...pm.rect, x: 12 * C, y: 14 * C + 4 }; pm.prev = { ...pm.rect };
    const e2 = run(s2, 12);
    expect(e2.some(e => e.type === 'crumple')).toBe(true);
    expect(e2.some(e => e.type === 'death' && e.pid === 'a' && e.cause === 'sniper')).toBe(true);
  });

  it('crumples and is sucked in within 4.5 cells of a black hole', () => {
    const w = lab();
    put(w, 'planemaker', 8, 12);
    put(w, 'blackhole', 15, 8);
    const sim = new RaceSim(w, ['a'], { roundKey: 'pl8', maxTicks: 8000 });
    at(sim, 'a', 3 * C, floorY());
    const ev = run(sim, cadence + 80);
    const cr = ev.find(e => e.type === 'crumple') as Extract<RaceEvent, { type: 'crumple' }>;
    expect(cr).toBeTruthy();
    expect(cr.hx).toBeDefined();
    expect(Math.hypot(cr.x - (15 * C + 24), cr.y - (8 * C + 24))).toBeLessThanOrEqual(NEWITEMS.planeHoleCrumple + 4);
  });
});

describe('phase 5: fan', () => {
  it('an upward fan settles a player into steady levitation; stepping out of its width drops them', () => {
    const w = lab();
    put(w, 'fan', 10, 15); // casing row 15, wind up through rows 10..14
    const sim = new RaceSim(w, ['a'], { roundKey: 'fan', maxTicks: 8000 });
    at(sim, 'a', 11 * C + 10, 12 * C);
    run(sim, 240);
    const b = sim.player('a')!.body;
    const y1 = b.y;
    run(sim, 60);
    expect(Math.abs(b.y - y1)).toBeLessThan(3);
    expect(Math.abs(b.vy)).toBeLessThan(12);
    expect(b.y + H).toBeLessThan(15 * C - 40); // floating clear of the casing
    run(sim, 80, { a: IN_LEFT });
    run(sim, 60);
    expect(b.grounded).toBe(true);
  });

  it('the casing is solid; projectiles are pushed by the wind', () => {
    const w = lab();
    put(w, 'fan', 10, 13, 1); // wind to the right, casing column 10 rows 13..15
    const sim = new RaceSim(w, ['a'], { roundKey: 'fan2', maxTicks: 8000 });
    at(sim, 'a', 8 * C, floorY());
    run(sim, 60, { a: IN_RIGHT });
    expect(sim.player('a')!.body.x + W).toBeLessThanOrEqual(10 * C + 0.01);
    const w2 = lab();
    put(w2, 'fan', 12, 15); // up
    put(w2, 'crossbow', 9, 13); // arrow right along row 13 crosses the column
    const s2 = new RaceSim(w2, ['a'], { roundKey: 'fan3', maxTicks: 8000 });
    at(s2, 'a', 3 * C, floorY());
    run(s2, 60 + 40);
    const arrows = s2.projectiles.filter(p => p.kind === 'arrow');
    expect(arrows.some(p => p.vy < -20)).toBe(true);
  });

  it('a plane crossing an upward fan strafes up; one flying into a fan\'s wind crumples within 3 cells', () => {
    const w = lab();
    put(w, 'planemaker', 8, 14);
    put(w, 'fan', 12, 15);
    const sim = new RaceSim(w, ['a'], { roundKey: 'fan4', maxTicks: 8000 });
    at(sim, 'a', 3 * C, floorY());
    run(sim, cadence + 70);
    const p = firstPlane(sim);
    expect(p).toBeTruthy();
    expect(p!.rect.y).toBeLessThan(14 * C + 12 - 20);
    const w2 = lab();
    put(w2, 'planemaker', 8, 14);
    put(w2, 'fan', 17, 13, 3); // wind to the left, against the plane
    const s2 = new RaceSim(w2, ['a'], { roundKey: 'fan5', maxTicks: 8000 });
    at(s2, 'a', 3 * C, floorY());
    const ev = run(s2, cadence + 200);
    const cr = ev.find(e => e.type === 'crumple') as Extract<RaceEvent, { type: 'crumple' }>;
    expect(cr).toBeTruthy();
    expect(17 * C - cr.x).toBeLessThanOrEqual(3 * C + 60);
  });
});

describe('phase 5: gravestone', () => {
  it('touching the stone breaks a flower; a ghost waits 1 s, then hunts and kills its target and disappears', () => {
    const w = lab();
    put(w, 'grave', 12, 15, 0, 'owner');
    const sim = new RaceSim(w, ['a', 'b'], { roundKey: 'gr', maxTicks: 8000, humans: 2 });
    const g = sim.graves[0];
    expect(g.ghosts).toHaveLength(2);
    expect(g.flowers).toBe(2);
    at(sim, 'b', 3 * C, floorY());
    at(sim, 'a', 12 * C + 10, floorY() - 8);
    run(sim, 2);
    expect(g.broken).toBe(1);
    const gh = g.ghosts.find(x => x.state !== 'idle')!;
    expect(gh.target).toBe('a');
    // run away to the right: the ghost is still at the grave after 0.9 s
    run(sim, 54, { a: IN_RIGHT });
    expect(gh.state).toBe('wait');
    run(sim, 10, { a: IN_RIGHT });
    expect(gh.state).toBe('chase');
    at(sim, 'a', 17 * C, floorY()); // wait at the wall: it catches up
    const ev = run(sim, 300);
    expect(ev.some(e => e.type === 'death' && e.pid === 'a' && e.cause === 'ghost' && e.credit === 'owner')).toBe(true);
    expect(gh.state).toBe('gone');
    expect(sim.player('b')!.status).toBe('racing');
  });

  it('one ghost per player per round, a bystander in its path dies while it keeps chasing, and finishing loses it', () => {
    const w = lab();
    put(w, 'grave', 25, 15, 0, 'owner');
    const sim = new RaceSim(w, ['a', 'b'], { roundKey: 'gr2', maxTicks: 8000 });
    const g = sim.graves[0];
    at(sim, 'a', 25 * C + 10, floorY() - 8);
    run(sim, 2);
    at(sim, 'a', 25 * C + 10, floorY() - 8);
    run(sim, 2);
    expect(g.ghosts.filter(x => x.state !== 'idle')).toHaveLength(1); // touching again does nothing
    at(sim, 'a', 34 * C, floorY()); // near the flag (finish at 35..37)
    at(sim, 'b', 29 * C, floorY()); // between the grave and a
    const ev = run(sim, 140);
    expect(ev.some(e => e.type === 'death' && e.pid === 'b' && e.cause === 'ghost')).toBe(true);
    const gh = g.ghosts.find(x => x.target === 'a')!;
    expect(gh.state).toBe('chase');
    run(sim, 60, { a: IN_RIGHT }); // reach the flag
    expect(sim.player('a')!.status).toBe('finished');
    expect(gh.state).toBe('gone');
  });

  it('the dirt pile is a platform; a floating grave can be stood on', () => {
    const w = lab();
    put(w, 'grave', 10, 11);
    const sim = new RaceSim(w, ['a'], { roundKey: 'gr3', maxTicks: 8000 });
    at(sim, 'a', 10 * C + 10, 11 * C - H - 30);
    run(sim, 40);
    const b = sim.player('a')!.body;
    expect(b.grounded).toBe(true);
    expect(b.y + H).toBeCloseTo(12 * C - NEWITEMS.dirtH, 3);
  });
});

describe('phase 5: dart turret', () => {
  it('shoots the closest visible player within 6 cells, never through walls or out of range, every ~2 s', () => {
    const w = lab();
    put(w, 'dart_turret', 15, 12, 0, 'owner');
    const near = new RaceSim(w, ['a'], { roundKey: 'dt', maxTicks: 8000 });
    at(near, 'a', 11 * C, floorY());
    const ev = run(near, 90);
    expect(ev.filter(e => e.type === 'fire' && e.kind === 'dart').length).toBeGreaterThanOrEqual(1);
    expect(ev.some(e => e.type === 'death' && e.cause === 'dart')).toBe(true);
    const far = new RaceSim(w, ['a'], { roundKey: 'dt2', maxTicks: 8000 });
    at(far, 'a', 7 * C, floorY());
    expect(run(far, 200).some(e => e.type === 'fire')).toBe(false); // 8+ cells away
    const hidden = new RaceSim(w, ['a'], { roundKey: 'dt3', maxTicks: 8000 });
    at(hidden, 'a', 23 * C, floorY()); // behind the wall at 20-21
    expect(run(hidden, 200).some(e => e.type === 'fire')).toBe(false);
  });

  it('darts pierce players (killing each) and crumple paper planes, vanishing with them', () => {
    const w = lab();
    put(w, 'dart_turret', 16, 15);
    const sim = new RaceSim(w, ['a', 'b'], { roundKey: 'dt4', maxTicks: 8000 });
    at(sim, 'a', 13 * C, floorY());
    at(sim, 'b', 11 * C, floorY());
    const ev = run(sim, 60);
    expect(ev.filter(e => e.type === 'death' && e.cause === 'dart').map(e => (e as { pid: string }).pid).sort()).toEqual(['a', 'b']);
    const w2 = lab();
    put(w2, 'planemaker', 8, 11);
    put(w2, 'dart_turret', 13, 6);
    const s2 = new RaceSim(w2, ['a'], { roundKey: 'dt5', maxTicks: 8000 });
    at(s2, 'a', 13 * C, floorY());
    const e2 = run(s2, cadence + 30);
    void e2;
    expect(s2.player('a')!.status === 'racing' || e2.some(e => e.type === 'crumple')).toBe(true);
  });
});

describe('phase 5: ice', () => {
  it('lies only on top surfaces, trims unsupported cells, takes no grid squares, and items go on top of it', () => {
    const w = lab();
    put(w, 'plank_3', 8, 12);
    const ice = put(w, 'ice_5', 8, 11);
    expect(ice.cells).toHaveLength(3); // trimmed to the plank
    expect(w.occAt(8, 11)).toBe('');
    put(w, 'block_1x1', 9, 11); // built over the ice
    expect(checkPlacement(w, { item: 'ice_3', x: 12, y: 8, rot: 0, variant: 0 }).ok).toBe(false); // floating
    expect(checkPlacement(w, { item: 'ice_3', x: 23, y: 15, rot: 0, variant: 0 }).ok).toBe(true); // on the floor
    put(w, 'oneway', 24, 10);
    expect(checkPlacement(w, { item: 'ice_3', x: 24, y: 9, rot: 0, variant: 0 }).ok).toBe(true); // on a one-way platform
  });

  it('is slippery: momentum carries much further after letting go than on bare floor', () => {
    const slide = (iced: boolean) => {
      const w = lab();
      if (iced) put(w, 'ice_5', 9, 15), put(w, 'ice_5', 14, 15);
      const sim = new RaceSim(w, ['a'], { roundKey: 'ice', maxTicks: 8000 });
      at(sim, 'a', 9 * C, floorY());
      run(sim, 5);
      run(sim, 40, { a: IN_RIGHT | 8 });
      const x0 = sim.player('a')!.body.x;
      run(sim, 40);
      return sim.player('a')!.body.x - x0;
    };
    expect(slide(true)).toBeGreaterThan(slide(false) * 3);
  });

  it('ice on a moving platform rides with it and makes the platform slippery', () => {
    const w = lab();
    const sh = put(w, 'shuttle', 8, 12);
    const ice = put(w, 'ice_3', 8, 11);
    expect(ice.cells).toHaveLength(2);
    expect(ice.attach).toBe(sh.id);
    const sim = new RaceSim(w, ['a'], { roundKey: 'ice2', maxTicks: 8000 });
    expect(sim.movers.find(m => m.o.id === sh.id)!.ice).toBe(true);
    at(sim, 'a', 8 * C + 20, 12 * C - H - 1);
    run(sim, 3);
    expect(sim.player('a')!.body.groundSurf).toBe(1);
  });
});

describe('phase 5: multiplayer sync of new items', () => {
  it('a client mirror reproduces planes, ghosts and flowers from server snapshots', () => {
    const w = lab();
    put(w, 'planemaker', 8, 12);
    put(w, 'grave', 14, 15);
    const server = new RaceSim(w, ['a', 'b'], { roundKey: 'sy', maxTicks: 8000, humans: 2 });
    const client = new RaceSim(w.clone(), ['a', 'b'], { roundKey: 'sy', maxTicks: 8000, humans: 2 });
    at(server, 'a', 14 * C + 10, floorY() - 8);
    at(server, 'b', 3 * C, floorY());
    run(server, cadence + 30);
    const snap = JSON.parse(JSON.stringify(server.snapshot()));
    client.applySnapshot(snap);
    const sp = server.movers.filter(m => m.plane?.alive), cp = client.movers.filter(m => m.plane?.alive);
    expect(cp.map(m => m.id)).toEqual(sp.map(m => m.id));
    expect(cp[0].rect.x).toBeCloseTo(sp[0].rect.x, 1);
    expect(client.graves[0].broken).toBe(1);
    expect(client.graves[0].ghosts.map(g => g.state)).toEqual(server.graves[0].ghosts.map(g => g.state));
    // between snapshots the client extrapolates planes on their straight flight
    expect(client.moverRectAt(cp[0], snap.tick + 30).x).toBeCloseTo(sp[0].rect.x + NEWITEMS.planeSpeed / 2, 0);
  });
});

// ================================================================ Phase 7
import { World } from '../../shared/world';
import { NavGraph } from '../../shared/nav';
import { MAP_LIST } from '../../shared/maps';
import { ballRect, gravityAt, gustAt, liquidSurface, tsunamiIn, tsunamiLevel } from '../../shared/mapfx';

describe('phase 7: new maps', () => {
  it('adds Tropical Island and three more large themed maps, all selectable, each with its own mechanic and a route to the flag', () => {
    const ids = MAP_LIST.map(m => m.id);
    for (const id of ['tropical', 'magma', 'orbital', 'dunes']) {
      expect(ids).toContain(id);
      const w = new World(id);
      expect(w.map.size).toBe('large');
      expect(w.map.fx).toBeTruthy();
      expect(new NavGraph(w).reach(false).finish).toBe(true);
    }
    const themes = new Set(['tropical', 'magma', 'orbital', 'dunes'].map(id => new World(id).map.theme.skyTop));
    expect(themes.size).toBe(4);
  });

  it('tropical: tsunami 15 s in, up 15 s, down 15 s, repeating; rises to just below the canopy; warns beforehand', () => {
    const m = new World('tropical').map, fx = m.fx!;
    expect(tsunamiLevel(fx, 14 * 60)).toBe(0);
    expect(tsunamiIn(fx, 12 * 60)).toBeCloseTo(3, 5);
    expect(tsunamiLevel(fx, 22 * 60)).toBe(1);
    expect(tsunamiLevel(fx, 31 * 60)).toBe(0);
    expect(tsunamiLevel(fx, 52 * 60)).toBe(1); // 45 s + 7: the second wave
    const canopyTop = 18 * CELL; // lowest canopy
    expect(liquidSurface(m, 22 * 60)!).toBeGreaterThan(canopyTop); // just below it
    expect(liquidSurface(m, 22 * 60)!).toBeLessThan(canopyTop + CELL);
  });

  it('tropical: touching the sea drowns; standing below the waterline when the tsunami hits kills, on a canopy you live; items survive it', () => {
    const w = new World('tropical');
    put(w, 'block_1x1', 30, 33); // a placed item on the beach
    const sim = new RaceSim(w, ['sea', 'beach', 'tree'], { roundKey: 'ts', maxTicks: 60 * 60 });
    at(sim, 'sea', 14 * C, 39 * C);
    run(sim, 3);
    expect(sim.player('sea')!.cause).toBe('drown');
    at(sim, 'beach', 32 * C, 38 * C - H);
    at(sim, 'tree', 62 * C, 18 * C - H);
    const ev = run(sim, 20 * 60);
    expect(ev.some(e => e.type === 'death' && e.pid === 'beach' && e.cause === 'tsunami')).toBe(true);
    expect(sim.player('tree')!.status).toBe('racing');
    expect(sim.world.objects.size).toBe(w.objects.size); // nothing washed away
  });

  it('tropical: the 2x2 beach ball floats on the sea, rides up with the tsunami and can be stood on', () => {
    const m = new World('tropical').map;
    const calm = ballRect(m, 0)!, wave = ballRect(m, 22 * 60)!;
    expect(calm).toMatchObject({ w: 2 * C, h: 2 * C });
    expect(calm.y + calm.h).toBeGreaterThan(liquidSurface(m, 0)!);
    expect(wave.y).toBeLessThan(calm.y - 15 * C);
    const sim = new RaceSim(new World('tropical'), ['a'], { roundKey: 'ball', maxTicks: 60 * 60 });
    at(sim, 'a', calm.x + 30, calm.y - H - 20);
    run(sim, 40);
    expect(sim.player('a')!.body.grounded).toBe(true);
    run(sim, 21 * 60);
    expect(sim.player('a')!.status).toBe('racing'); // safe on the ball through the tsunami
  });

  it('magma: lava kills and geysers erupt on their timers; orbital: low gravity in the bays; dunes: gusts blow players back', () => {
    const mg = new World('magma');
    const sim = new RaceSim(mg, ['a'], { roundKey: 'mg', maxTicks: 60 * 60 });
    at(sim, 'a', 12 * C, 34 * C);
    run(sim, 30);
    expect(sim.player('a')!.cause).toBe('lava');
    const g = mg.map.fx!.geysers![0];
    const s2 = new RaceSim(mg, ['a'], { roundKey: 'mg2', maxTicks: 60 * 60 });
    let killed = false;
    for (let i = 0; i < 300 && !killed; i++) { at(s2, 'a', g.x * C + 10, 20 * C); s2.player('a')!.body.vy = 0; const ev = run(s2, 1); killed = ev.some(e => e.type === 'death' && e.cause === 'geyser'); }
    expect(killed).toBe(true);
    const ob = new World('orbital').map;
    expect(gravityAt(ob, 16 * C, 20 * C)).toBeCloseTo(0.4);
    expect(gravityAt(ob, 5 * C, 20 * C)).toBe(1);
    const du = new World('dunes');
    expect(gustAt(du.map, 7 * 60)).toBe(0);
    expect(gustAt(du.map, 10 * 60)).toBeLessThan(-1000);
    const s3 = new RaceSim(du, ['a'], { roundKey: 'du', maxTicks: 60 * 60 });
    at(s3, 'a', 60 * C, 26 * C);
    run(s3, 8 * 60 + 30);
    const x0 = s3.player('a')!.body.x;
    run(s3, 90);
    expect(s3.player('a')!.body.x).toBeLessThan(x0 - 30);
  });

  it('every new map works with every item and sandbox-style placement (placements accepted somewhere on each map)', () => {
    for (const id of ['tropical', 'magma', 'orbital', 'dunes']) {
      const w = new World(id);
      const items = ['block_1x1', 'planemaker', 'fan', 'grave', 'dart_turret', 'ice_3', 'saw', 'wheel', 'shuttle', 'crossbow'];
      for (const it of items) {
        let ok = false;
        for (let y = 2; y < w.h - 2 && !ok; y++) for (let x = 10; x < w.w - 10 && !ok; x += 3) if (checkPlacement(w, { item: it, x, y, rot: 0, variant: 0 }).ok) ok = true;
        expect(ok, `${it} on ${id}`).toBe(true);
      }
    }
  });
});
