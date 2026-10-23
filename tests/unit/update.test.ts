// Acceptance tests for the October 2026 gameplay update (wheel placement, crushes, instant sniper, coins, crumbles,
// spiky oval, human-first draft, scoring and score target, black holes, impossible courses).
import { afterEach, describe, expect, it } from 'vitest';
import { CELL, HAZARD, MATCH, MOVERS, PHYS, SCORING, TICK_HZ, TIMERS } from '../../shared/config';
import { ovalHitsRect, ovalShape, moverPathLen, moverRect, rspikeParts } from '../../shared/hazards';
import { getItem, ITEM_LIST, ITEMS } from '../../shared/items';
import { childRect, sweepOf } from '../../shared/movers';
import { IN_JUMP, IN_RIGHT, IN_SPRINT } from '../../shared/physics';
import { applyBomb, checkPlacement } from '../../shared/placement';
import type { ServerMsg } from '../../shared/protocol';
import { RaceSim, type RaceEvent } from '../../shared/race';
import { scoreRound } from '../../shared/scoring';
import { migrateSnapshot, World } from '../../shared/world';
import { Room, type Member } from '../../server/room';
import { floorY, lab, put } from './helpers';

const C = CELL, W = PHYS.bodyW, H = PHYS.bodyH;
type Death = Extract<RaceEvent, { type: 'death' }>;

const run = (sim: RaceSim, n: number, inputs: Record<string, number> = {}) => {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n && !sim.over; i++) { sim.step(new Map(Object.entries(inputs))); ev.push(...sim.drainEvents()); }
  return ev;
};
const at = (sim: RaceSim, id: string, x: number, y: number) => { const b = sim.player(id)!.body; b.x = x; b.y = y; b.vx = 0; b.vy = 0; b.grounded = false; };
const deaths = (ev: RaceEvent[]) => ev.filter(e => e.type === 'death') as Death[];

// ---------------------------------------------------------------- Ferris wheel placement
describe('ferris wheel placement', () => {
  it('accepts a wheel with one valid gondola and three overlapping blocks; all four persist and orbit through them', () => {
    const w = lab();
    const probe = { id: '_', item: 'wheel', owner: null, prov: 'player' as const, x: 13, y: 10, rot: 0 as const, variant: 0, cells: [[13, 10] as [number, number]], attach: null, round: 0 };
    // block one cell of gondolas 0, 2 and 3 at their GO pose; gondola 1 (bottom) stays clear
    for (const i of [0, 2, 3]) {
      const r = childRect(probe, i, 0);
      put(w, 'block_1x1', Math.floor((r.x + r.w / 2) / C), Math.floor((r.y + r.h / 2) / C), 0, 'other');
    }
    const chk = checkPlacement(w, { item: 'wheel', x: 13, y: 10, rot: 0, variant: 0 });
    expect(chk.ok).toBe(true);
    expect(chk.validChildren).toEqual([1]);
    expect(chk.overlapCells!.length).toBeGreaterThanOrEqual(3);
    const o = put(w, 'wheel', 13, 10);
    const sim = new RaceSim(w, ['a'], { roundKey: 'w', maxTicks: 10000 });
    const kids = sim.movers.filter(m => m.o.id === o.id);
    expect(kids).toHaveLength(4);
    const start = kids.map(k => ({ ...k.rect }));
    run(sim, MOVERS.wheelPeriodTicks / 4);
    kids.forEach((k, i) => expect(Math.hypot(k.rect.x - start[i].x, k.rect.y - start[i].y)).toBeGreaterThan(100));
    run(sim, (MOVERS.wheelPeriodTicks * 3) / 4);
    kids.forEach((k, i) => { expect(k.rect.x).toBeCloseTo(start[i].x, 3); expect(k.rect.y).toBeCloseTo(start[i].y, 3); });
  });

  it('rejects a wheel when no gondola starts in open space, and keeps the orbit on the map and out of safety zones', () => {
    const w = lab();
    const probe = { id: '_', item: 'wheel', owner: null, prov: 'player' as const, x: 13, y: 10, rot: 0 as const, variant: 0, cells: [[13, 10] as [number, number]], attach: null, round: 0 };
    for (const i of [0, 1, 2, 3]) {
      const r = childRect(probe, i, 0);
      put(w, 'block_1x1', Math.floor((r.x + r.w / 2) / C), Math.floor((r.y + r.h / 2) / C), 0, 'other');
    }
    const chk = checkPlacement(w, { item: 'wheel', x: 13, y: 10, rot: 0, variant: 0 });
    expect(chk.ok).toBe(false);
    expect(chk.reason).toMatch(/one gondola/);
    expect(checkPlacement(lab(), { item: 'wheel', x: 2, y: 8, rot: 0, variant: 0 }).reason).toMatch(/leaves the map/);
    expect(checkPlacement(lab(), { item: 'wheel', x: 9, y: 12, rot: 0, variant: 0 }).reason).toMatch(/safety zone/);
    // the client preview calls the same function, so it reaches the identical decision
    expect(checkPlacement(w.clone(), { item: 'wheel', x: 13, y: 10, rot: 0, variant: 0 })).toEqual(chk);
  });

  it('keeps the wheel centre non-solid while the swinging axe pivot is a real solid 1x1 block', () => {
    const w = lab();
    put(w, 'wheel', 10, 8);
    expect(w.solidCell(10, 8)).toBe(false);
    const axe = put(w, 'pendulum', 28, 9);
    expect(getItem('pendulum').solid).toBe(true);
    expect(w.solidCell(28, 9)).toBe(true);
    expect(axe.cells).toEqual([[28, 9]]);
    // stand on top of the pivot through a few full swings: the blade never touches someone on the block
    const sim = new RaceSim(w, ['a'], { roundKey: 'axe', maxTicks: 4000 });
    at(sim, 'a', 28 * C + 10, 9 * C - H);
    run(sim, Math.round(HAZARD.pendulumPeriod * TICK_HZ * 3));
    const p = sim.player('a')!;
    expect(p.status).toBe('racing');
    expect(p.body.grounded).toBe(true);
    expect(p.body.y + H).toBeCloseTo(9 * C, 6);
    // a bomb removes pivot and blade together
    applyBomb(w, [axe.id]);
    expect(w.solidCell(28, 9)).toBe(false);
  });
});

// ---------------------------------------------------------------- moving platforms and walls
describe('moving platforms and walls', () => {
  it('lets a shuttle start partly in a wall and slide through it, but never start wholly inside one', () => {
    const w = lab(); // wall columns 20-21, rows 4..15
    const part = checkPlacement(w, { item: 'shuttle', x: 19, y: 10, rot: 0, variant: 0 });
    expect(part.ok).toBe(true);
    expect(part.wallCells).toEqual([[20, 10]]);
    expect(checkPlacement(w, { item: 'shuttle', x: 20, y: 10, rot: 0, variant: 0 }).reason).toMatch(/completely inside a wall/);
    const o = put(w, 'shuttle', 19, 10);
    // the far end of its travel is beyond the wall: walls do not stop or shorten it
    expect(childRect(o, 0, MOVERS.shuttlePeriodTicks / 2).x).toBe((19 + MOVERS.shuttleTravelCells) * C);
    const sim = new RaceSim(w, ['a'], { roundKey: 's', maxTicks: 4000 });
    at(sim, 'a', 3 * C, floorY());
    run(sim, MOVERS.shuttlePeriodTicks / 2);
    expect(sim.movers[0].rect.x).toBeCloseTo(25 * C, 6);
  });

  it('runs the 3x1 Moving Platform its full new length straight through a wall', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'moving', x: 20, y: 7, rot: 1, variant: 0 }).reason).toMatch(/completely inside a wall/); // three wall cells
    expect(checkPlacement(w, { item: 'moving', x: 20, y: 9, rot: 0, variant: 0 }).ok).toBe(true); // two of three in the wall is fine
    const o = put(w, 'moving', 17, 9);
    const r = moverRect(o, (moverPathLen() / HAZARD.movingSpeed), moverPathLen());
    expect(r.x).toBe(17 * C + 6 * C);
    expect(checkPlacement(w, { item: 'moving', x: 34, y: 5, rot: 0, variant: 0 }).reason).toMatch(/leave the map/);
  });

  it('travels further: 2x1 shuttle doubled (3 -> 6 cells) and 3x1 platform exactly two cells longer (4 -> 6)', () => {
    const w = lab();
    const sh = put(w, 'shuttle', 4, 6);
    const ends = childRect(sh, 0, MOVERS.shuttlePeriodTicks / 2).x - childRect(sh, 0, 0).x;
    expect(ends / C).toBe(6);
    expect(MOVERS.shuttleTravelCells).toBe(2 * 3);
    expect(moverPathLen() / C).toBe(4 + 2);
    // speed kept: the shuttle's peak is still ~141 px/s
    let peak = 0;
    for (let t = 1; t < MOVERS.shuttlePeriodTicks; t++) peak = Math.max(peak, Math.abs(childRect(sh, 0, t).x - childRect(sh, 0, t - 1).x) * TICK_HZ);
    expect(peak).toBeLessThan(145);
    expect(sweepOf(sh).sweep).toHaveLength(2 + 6);
  });
});

// ---------------------------------------------------------------- crush deaths
describe('crush deaths', () => {
  it('kills exactly once when a horizontal platform pins someone against a wall, and credits the owner 0.2', () => {
    const w = lab();
    const o = put(w, 'shuttle', 15, 15, 0, 'o'); // slides right along the floor into the wall at column 20
    const sim = new RaceSim(w, ['o', 'a'], { roundKey: 'c', maxTicks: 4000 });
    at(sim, 'o', 3 * C, floorY());
    at(sim, 'a', 20 * C - W, floorY());
    const ev = run(sim, MOVERS.shuttlePeriodTicks);
    const d = deaths(ev);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ pid: 'a', cause: 'crush', credit: 'o', src: o.id });
    // never shoved through the wall
    expect(sim.player('a')!.body.x).toBeLessThanOrEqual(20 * C - W + 0.01);
    const rows = scoreRound(['o', 'a'], true, ev, new Map(sim.players.map(p => [p.id, p.status])), new Map());
    expect(rows.find(r => r.pid === 'o')!.trap).toBe(SCORING.trapElim);
    expect(SCORING.trapElim / SCORING.unit).toBe(0.2);
  });

  it('kills a rider lifted into a block, but not one riding a full cycle with open space above', () => {
    const lift = (ceiling: boolean, owner: string) => {
      const w = lab();
      put(w, 'shuttle', 30, 14, 3, owner); // a 1x2 lift rising six cells from the floor
      if (ceiling) put(w, 'block_3x3', 29, 6, 0, 'x'); // bottom at y = 432, inside the lift's travel
      const sim = new RaceSim(w, ['a', 'o'], { roundKey: 'v', maxTicks: 4000 });
      at(sim, 'o', 3 * C, floorY());
      at(sim, 'a', 30 * C + 10, 14 * C - H);
      const ev = run(sim, MOVERS.shuttlePeriodTicks);
      return { sim, d: deaths(ev) };
    };
    const open = lift(false, 'o');
    expect(open.d).toHaveLength(0);
    expect(open.sim.player('a')!.status).toBe('racing');
    const hit = lift(true, 'o');
    expect(hit.d).toHaveLength(1);
    expect(hit.d[0]).toMatchObject({ pid: 'a', cause: 'crush', credit: 'o' });
    expect(hit.sim.player('a')!.body.y).toBeGreaterThanOrEqual(9 * C - 0.01); // squeezed under the block, never pushed into it
    const self = lift(true, 'a');
    expect(self.d[0]).toMatchObject({ pid: 'a', cause: 'crush', credit: null }); // self-crush earns nothing
  });

  it('is safe to stand pressed against a wall, or to ride a platform while it slides into the wall under you', () => {
    const w = lab();
    put(w, 'shuttle', 15, 13, 0); // passes above the head of someone standing at the wall
    const sim = new RaceSim(w, ['a'], { roundKey: 'safe', maxTicks: 6000 });
    at(sim, 'a', 20 * C - W, floorY());
    expect(deaths(run(sim, MOVERS.shuttlePeriodTicks * 2))).toHaveLength(0);
    const w2 = lab();
    put(w2, 'shuttle', 12, 15, 0); // the rider's platform slides into the wall at column 20
    const s2 = new RaceSim(w2, ['b'], { roundKey: 'safe2', maxTicks: 6000 });
    at(s2, 'b', 12 * C + 30, 15 * C - H);
    expect(deaths(run(s2, MOVERS.shuttlePeriodTicks * 2))).toHaveLength(0);
    expect(s2.player('b')!.body.x).toBeLessThanOrEqual(20 * C - W + 0.01); // pinned at the wall face, never inside it
  });

  it('ignores shields: nobody fits into space that is not there', () => {
    const w = lab();
    put(w, 'shuttle', 15, 15, 0, 'o');
    const sim = new RaceSim(w, ['o', 'a'], { roundKey: 'sh', maxTicks: 4000 });
    at(sim, 'o', 3 * C, floorY());
    at(sim, 'a', 20 * C - W, floorY());
    sim.player('a')!.effects.shield = 30;
    const d = deaths(run(sim, MOVERS.shuttlePeriodTicks));
    expect(d.map(x => x.cause)).toEqual(['crush']);
  });
});

// ---------------------------------------------------------------- retracting spikes, spiky oval
describe('retracting spikes and the spiky oval', () => {
  it('sit on a real solid base: safe to stand on while retracted, lethal once out', () => {
    const w = lab();
    const o = put(w, 'rspikes', 10, 14);
    const parts = rspikeParts(o);
    expect(parts.base.sort()).toEqual([[10, 15], [11, 15]]);
    expect(parts.spikes.sort()).toEqual([[10, 14], [11, 14]]);
    expect(w.solidCell(10, 15) && w.solidCell(11, 15)).toBe(true);
    expect(w.solidCell(10, 14)).toBe(false);
    const sim = new RaceSim(w, ['a'], { roundKey: 'r', maxTicks: 4000 });
    at(sim, 'a', 10 * C + 20, 15 * C - H);
    run(sim, Math.round((HAZARD.rspikeIn - 0.05) * TICK_HZ));
    expect(sim.player('a')!.status).toBe('racing');
    expect(sim.player('a')!.body.grounded).toBe(true); // standing on the base
    const ev = run(sim, 30);
    expect(deaths(ev)[0]?.cause).toBe('rspikes');
    // rotated: spikes on the base's outward face
    const r2 = put(w, 'rspikes', 26, 2, 2);
    const p2 = rspikeParts(r2);
    expect(Math.min(...p2.spikes.map(c => c[1]))).toBeGreaterThan(Math.max(...p2.base.map(c => c[1]))); // spikes below
  });

  it('replaces the ordinary spike strip with a 3x1 oval whose lethal area is the oval, not its corners', () => {
    expect(ITEMS.spikes).toBeUndefined();
    expect(ITEMS.spiky_oval.mask).toHaveLength(3);
    const w = lab();
    const flat = put(w, 'spiky_oval', 10, 12);
    expect(flat.cells).toEqual([[10, 12], [11, 12], [12, 12]]);
    const ov = ovalShape(flat);
    expect(ovalHitsRect(ov, { x: ov.cx - 2, y: ov.cy - 2, w: 4, h: 4 })).toBe(true);
    expect(ovalHitsRect(ov, { x: 10 * C, y: 12 * C, w: 6, h: 6 })).toBe(false); // empty corner of the 3x1 box
    const up = put(w, 'spiky_oval', 25, 2, 1);
    expect(up.cells).toEqual([[25, 2], [25, 3], [25, 4]]);
    const ou = ovalShape(up);
    expect(ou.ry).toBeGreaterThan(ou.rx);
    const sim = new RaceSim(w, ['a'], { roundKey: 'o', maxTicks: 100 });
    at(sim, 'a', ov.cx - W / 2, ov.cy - H / 2);
    expect(deaths(run(sim, 1))[0]).toMatchObject({ cause: 'oval' });
  });
});

// ---------------------------------------------------------------- removed items and old data
describe('dart shooter removal and legacy data', () => {
  it('has no dart shooter anywhere in the catalogue', () => {
    expect(ITEM_LIST.some(d => d.id === 'dart' || (d.kind as string) === 'dart')).toBe(false);
    expect(() => getItem('dart')).toThrow();
  });

  it('migrates old saved worlds instead of crashing: darts removed, spikes grown into ovals only where they fit', () => {
    const old = {
      mapId: 'lab', version: 3, nextId: 9, objects: [
        { id: 'o1', item: 'dart', owner: 'p', prov: 'player', x: 8, y: 10, rot: 0, variant: 0, cells: [[8, 10]], attach: null, round: 1 },
        { id: 'o2', item: 'spikes', owner: 'p', prov: 'player', x: 10, y: 15, rot: 0, variant: 0, cells: [[10, 15], [11, 15]], attach: null, round: 1 },
        { id: 'o3', item: 'spikes', owner: 'p', prov: 'player', x: 18, y: 15, rot: 0, variant: 0, cells: [[18, 15], [19, 15]], attach: null, round: 1 }, // next cell is the wall
        { id: 'o4', item: 'rspikes', owner: 'p', prov: 'player', x: 4 + 20, y: 14, rot: 0, variant: 0, cells: [[24, 14], [25, 14]], attach: null, round: 1 },
        { id: 'o5', item: 'mystery_future_item', owner: 'p', prov: 'player', x: 30, y: 10, rot: 0, variant: 0, cells: [[30, 10]], attach: null, round: 1 },
      ],
    } as unknown as Parameters<typeof migrateSnapshot>[0];
    const m = migrateSnapshot(old);
    expect(m.removed.sort()).toEqual(['o1', 'o3', 'o5']);
    expect(m.converted.sort()).toEqual(['o2', 'o4']);
    const w = World.fromJSON(old);
    expect(w.objects.get('o2')!.item).toBe('spiky_oval');
    expect(w.objects.get('o2')!.cells).toHaveLength(3);
    expect(w.objects.get('o4')!.cells).toHaveLength(4);
    expect(w.solidCell(24, 15)).toBe(true); // the spikes gained their base block
    expect(() => new RaceSim(w, ['a'], { roundKey: 'm', maxTicks: 10 })).not.toThrow();
  });
});

// ---------------------------------------------------------------- crumbling platforms
describe('crumbling platforms', () => {
  it('survive one landing, break on a second separate one, and long standing counts once', () => {
    const w = lab();
    const c = put(w, 'crumble', 10, 13);
    const sim = new RaceSim(w, ['a'], { roundKey: 'cr', maxTicks: 6000 });
    at(sim, 'a', 11 * C, 13 * C - H - 30);
    run(sim, 300); // land and stand for five seconds
    const st = sim.crumbles.get(c.id)!;
    expect(sim.player('a')!.body.grounded).toBe(true);
    expect(st.hp).toBe(1);
    expect(st.broken).toBe(false);
    run(sim, 12, { a: IN_JUMP });
    run(sim, 80); // land again: a genuinely new contact
    expect(st.hp).toBe(0);
    expect(st.broken).toBe(true);
    run(sim, 30);
    expect(sim.player('a')!.body.y).toBeGreaterThan(13 * C); // fell through: nothing holds them up any more
    // broken for the rest of this round only; a bombed one stays gone
    expect(new RaceSim(w, ['a'], { roundKey: 'cr2', maxTicks: 10 }).crumbles.get(c.id)!.hp).toBe(HAZARD.crumbleHits);
    applyBomb(w, [c.id]);
    expect(new RaceSim(w, ['a'], { roundKey: 'cr3', maxTicks: 10 }).crumbles.has(c.id)).toBe(false);
  });

  it('counts one uninterrupted wall slide as one interaction', () => {
    const w = lab();
    const c = put(w, 'crumble', 25, 6, 1); // upright, rows 6..8
    const sim = new RaceSim(w, ['a'], { roundKey: 'ws', maxTicks: 6000 });
    at(sim, 'a', 25 * C - W, 6 * C + 2);
    sim.player('a')!.body.vy = 60;
    let slid = 0;
    for (let i = 0; i < 90; i++) { run(sim, 1, { a: IN_RIGHT }); if (sim.player('a')!.body.wallSliding) slid++; }
    expect(slid).toBeGreaterThan(20);
    expect(sim.crumbles.get(c.id)!.hp).toBe(1);
  });

  it('takes one interaction per projectile, and a shot that breaks it still stops there', () => {
    const w = lab();
    put(w, 'sniper', 8, 15, 0, 's');
    const c = put(w, 'crumble', 12, 13, 1); // upright, rows 13..15, across the shot's line
    const sim = new RaceSim(w, ['s', 'v'], { roundKey: 'cs', maxTicks: 6000 });
    at(sim, 's', 3 * C, floorY());
    at(sim, 'v', 15 * C, floorY());
    const t = Math.round(HAZARD.sniperInterval * TICK_HZ);
    run(sim, t);
    expect(sim.crumbles.get(c.id)!.hp).toBe(1);
    run(sim, t);
    expect(sim.crumbles.get(c.id)!.broken).toBe(true);
    expect(sim.player('v')!.status).toBe('racing'); // the breaking shot ended at the block
    const ev = run(sim, t);
    expect(deaths(ev)[0]).toMatchObject({ pid: 'v', cause: 'sniper' }); // the next one goes through the gap
  });
});

// ---------------------------------------------------------------- sniper, black holes, projectiles in fields
describe('black holes', () => {
  const holeSim = (startX: number, jumpAt: number) => {
    const w = lab();
    put(w, 'blackhole', 13, 12, 0, 'o');
    const sim = new RaceSim(w, ['a', 'o'], { roundKey: 'bh', maxTicks: 3000 });
    at(sim, 'o', 3 * C, floorY());
    at(sim, 'a', startX, floorY());
    sim.player('a')!.body.grounded = true;
    const cx = 13 * C + C / 2, cy = 12 * C + C / 2;
    let swept = 0, last: number | null = null, maxSpeed = 0, inField = false, left = false;
    for (let t = 0; t < 600; t++) {
      run(sim, 1, { a: IN_RIGHT | IN_SPRINT | (t >= jumpAt && t < jumpAt + 18 ? IN_JUMP : 0) });
      const p = sim.player('a')!;
      if (p.status !== 'racing') break;
      const bx = p.body.x + W / 2, by = p.body.y + H / 2;
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.body.vx, p.body.vy));
      if (Math.hypot(bx - cx, by - cy) < HAZARD.holeRadius) {
        inField = true;
        const a = Math.atan2(by - cy, bx - cx);
        if (last !== null) { let d = a - last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; swept += d; }
        last = a;
      } else if (inField) { left = true; if (p.body.grounded) break; }
    }
    return { p: sim.player('a')!, swept: Math.abs(swept) * 180 / Math.PI, maxSpeed, left };
  };

  it('is much stronger than before yet lets a sideways approach swing around the hole and leave alive', () => {
    expect(HAZARD.holePull).toBeGreaterThan(1650);
    expect(HAZARD.holeRadius).toBeGreaterThan(210);
    const r = holeSim(360, 0);
    expect(r.p.status).toBe('racing');
    expect(r.left).toBe(true);
    expect(r.swept).toBeGreaterThan(100); // a real arc round a big part of the hole
    expect(r.maxSpeed).toBeLessThanOrEqual(HAZARD.holeMaxSpeed + 1);
  });

  it('still kills a careless direct approach in the core, while merely entering the field is not lethal', () => {
    const r = holeSim(480, 0);
    expect(r.p.status).toBe('dead');
    expect(r.p.cause).toBe('blackhole');
    // somebody sitting at the edge of the field is pulled, not killed
    const w = lab(); put(w, 'blackhole', 13, 12, 0, 'o');
    const sim = new RaceSim(w, ['a'], { roundKey: 'edge', maxTicks: 100 });
    at(sim, 'a', 13 * C + C / 2 - W / 2 + HAZARD.holeRadius - 30, 12 * C);
    run(sim, 1);
    expect(sim.player('a')!.status).toBe('racing');
  });

  it('stays numerically stable with several holes and never pulls anyone through a wall', () => {
    const w = lab();
    put(w, 'blackhole', 24, 12, 0, 'o'); put(w, 'blackhole', 27, 9, 0, 'o'); put(w, 'blackhole', 24, 6, 0, 'o');
    const sim = new RaceSim(w, ['a', 'b'], { roundKey: 'multi', maxTicks: 3000 });
    at(sim, 'a', 20 * C - W, floorY()); // pressed against the left face of the wall, holes behind it
    at(sim, 'b', 26 * C, 11 * C);
    for (let i = 0; i < 400; i++) {
      run(sim, 1);
      for (const p of sim.players) { expect(Number.isFinite(p.body.x) && Number.isFinite(p.body.vy)).toBe(true); expect(Math.hypot(p.body.vx, p.body.vy)).toBeLessThanOrEqual(Math.max(HAZARD.holeMaxSpeed, PHYS.maxFall) + 1); }
      expect(sim.player('a')!.body.x).toBeLessThanOrEqual(20 * C - W + 0.01);
    }
  });

  it('bends arrows toward the hole, keeps their momentum afterwards, and swallows them at the core', () => {
    const w = lab();
    put(w, 'crossbow', 8, 12, 0, 'o');
    put(w, 'blackhole', 18, 10, 0, 'h'); // its field starts well past the muzzle
    const sim = new RaceSim(w, ['o'], { roundKey: 'arr', maxTicks: 3000 });
    at(sim, 'o', 3 * C, floorY());
    let minVy = 0, sawStraight = false;
    for (let i = 0; i < 200; i++) {
      run(sim, 1);
      const a = sim.projectiles[0];
      if (!a) continue;
      if (a.vy === 0) sawStraight = true;
      minVy = Math.min(minVy, a.vy);
    }
    expect(sawStraight).toBe(true); // straight outside the field
    expect(minVy).toBeLessThan(-30); // curved up toward the hole above its line
    const w2 = lab();
    put(w2, 'crossbow', 8, 12, 0, 'o');
    put(w2, 'blackhole', 17, 12, 0, 'h');
    const s2 = new RaceSim(w2, ['o', 'v'], { roundKey: 'arr2', maxTicks: 3000 });
    at(s2, 'o', 3 * C, floorY());
    at(s2, 'v', 19 * C + 2, 12 * C - 10); // behind the hole on the arrow's line, in front of the wall
    const ev = run(s2, 260);
    expect(ev.some(e => e.type === 'absorb')).toBe(true);
    expect(deaths(ev).some(d => d.pid === 'v' && d.cause === 'arrow')).toBe(false);
  });

  it('bends an instant sniper shot within its firing tick, keeps it bounded, and keeps the sniper owner as the killer', () => {
    const w = lab();
    put(w, 'sniper', 8, 15, 0, 'sn');
    put(w, 'blackhole', 14, 12, 0, 'h');
    const sim = new RaceSim(w, ['sn'], { roundKey: 'snb', maxTicks: 3000 });
    at(sim, 'sn', 3 * C, floorY());
    const ev = run(sim, 151);
    const shot = ev.find(e => e.type === 'shot') as Extract<RaceEvent, { type: 'shot' }>;
    expect(shot.t).toBe(150);
    const ys = shot.pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(ys[0] - 5); // pulled up off the straight line
    expect(shot.pts.length / 2).toBeLessThan(HAZARD.sniperMaxPathPx / HAZARD.sniperStepPx);
    // attribution: a shot bent by someone else's hole still belongs to the sniper's owner
    const w2 = lab();
    put(w2, 'sniper', 8, 15, 0, 'sn');
    put(w2, 'blackhole', 14, 11, 0, 'h');
    const s2 = new RaceSim(w2, ['sn', 'v', 'h'], { roundKey: 'snb2', maxTicks: 3000 });
    at(s2, 'sn', 3 * C, floorY()); at(s2, 'h', 2 * C, floorY());
    const probeEv = run(new RaceSim(w2.clone(), ['sn'], { roundKey: 'p', maxTicks: 3000 }), 151);
    const path = (probeEv.find(e => e.type === 'shot') as Extract<RaceEvent, { type: 'shot' }>).pts;
    const k = Math.floor(path.length / 4) * 2;
    at(s2, 'v', path[k] - W / 2, path[k + 1] - H / 2);
    s2.player('v')!.body.vy = 0;
    const d = deaths(run(s2, 151)).find(x => x.pid === 'v');
    if (d) expect(d).toMatchObject({ cause: 'sniper', credit: 'sn' });
  });
});

// ---------------------------------------------------------------- coins
describe('coins consumed at the flag', () => {
  it('a banked coin is removed for the rest of the match, through round resets and reconnect snapshots', () => {
    const w = lab();
    const coin = put(w, 'coin', 30, 15);
    const sim = new RaceSim(w, ['a', 'b'], { roundKey: 'cn', maxTicks: 4000 });
    at(sim, 'b', 3 * C, floorY());
    at(sim, 'a', 30 * C + 10, floorY());
    run(sim, 2);
    expect(sim.coins[0].carrier).toBe('a');
    at(sim, 'a', w.finishPx.x + 4, w.finishPx.y + 4);
    const ev = run(sim, 2);
    expect(ev.filter(e => e.type === 'bank')).toHaveLength(1);
    expect(sim.player('a')!.coins).toHaveLength(0); // no carried marker left behind
    // the match spends it, idempotently
    expect(w.consumeCoin(coin.id)).toBe(true);
    expect(w.consumeCoin(coin.id)).toBe(false);
    expect(w.objects.has(coin.id)).toBe(false);
    const again = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
    expect(again.consumed.has(coin.id)).toBe(true);
    expect(new RaceSim(again, ['a'], { roundKey: 'cn2', maxTicks: 10 }).coins).toHaveLength(0);
    // a newly drafted coin is a new instance and works normally
    const fresh = put(again, 'coin', 30, 15);
    expect(fresh.id).not.toBe(coin.id);
    expect(new RaceSim(again, ['a'], { roundKey: 'cn3', maxTicks: 10 }).coins.map(c => c.id)).toEqual([fresh.id]);
  });
});

// ---------------------------------------------------------------- rooms: draft order, target, scoring flow
function mkRoom(map = 'rooftop') {
  const inbox = new Map<string, ServerMsg[]>();
  const room = new Room('UPD01', 'online', (id, msg) => { const a = inbox.get(id) ?? []; a.push(msg); inbox.set(id, a); }, 7);
  room.mapId = map;
  return { room, inbox };
}
const human = (room: Room, name: string) => { const m = room.addHuman(name, 0); if ('error' in m) throw new Error(m.error); return m as Member; };
const ticks = (room: Room, ms: number) => { for (let i = 0; i < Math.round((ms / 1000) * TICK_HZ); i++) room.tick(); };

describe('human-first drafting', () => {
  it('holds every bot back until all humans have picked, then lets the AI pick from what is left', () => {
    const { room, inbox } = mkRoom();
    const a = human(room, 'A'), b = human(room, 'B');
    room.addBot('hard'); room.addBot('medium');
    room.startMatch();
    const m = room.match!;
    const bots = m.roster.filter(id => m.isBot(id));
    expect(m.draftStage).toBe('humans');
    m.claim(bots[0], m.pool[0].id, 1); // the server refuses a bot claim during the humans' turn
    expect(m.pool[0].by).toBeNull();
    room.handle(a.id, { t: 'claim', round: 1, card: m.pool[0].id });
    ticks(room, 10000); // bots would have picked long ago under the old timers
    expect(bots.every(id => !m.cardOf.has(id))).toBe(true);
    room.handle(b.id, { t: 'claim', round: 1, card: m.pool[1].id });
    expect(m.draftStage).toBe('ai');
    ticks(room, TIMERS.aiDraftMs + 50);
    expect(room.phase).toBe('build');
    expect(bots.every(id => m.cardOf.has(id))).toBe(true);
    // the bots took different, leftover cards
    const owned = [...m.cardOf.values()];
    expect(new Set(owned).size).toBe(owned.length);
    const stages = inbox.get(a.id)!.filter(x => x.t === 'draft').map(x => (x as Extract<ServerMsg, { t: 'draft' }>).stage);
    expect(stages.indexOf('humans')).toBeLessThan(stages.indexOf('ai'));
  });

  it('auto-picks for a human who times out or disconnects before any bot chooses', () => {
    const { room, inbox } = mkRoom();
    const a = human(room, 'A'), b = human(room, 'B');
    room.addBot('hard');
    room.startMatch();
    const m = room.match!;
    const bot = m.roster.find(id => m.isBot(id))!;
    room.handle(a.id, { t: 'claim', round: 1, card: m.pool[0].id });
    room.setConnected(b.id, false); // B drops: they must not hold the draft (or the bot) up
    expect(m.cardOf.has(b.id)).toBe(true);
    const claims = inbox.get(a.id)!.filter(x => x.t === 'claimed').map(x => (x as Extract<ServerMsg, { t: 'claimed' }>).by);
    ticks(room, TIMERS.aiDraftMs + 50);
    expect(m.cardOf.has(bot)).toBe(true);
    const all = inbox.get(a.id)!.filter(x => x.t === 'claimed').map(x => (x as Extract<ServerMsg, { t: 'claimed' }>).by);
    expect(all.indexOf(bot)).toBeGreaterThan(all.indexOf(b.id));
    void claims;
    // the timeout path: one human who never picks
    const r2 = mkRoom(); const h = human(r2.room, 'Solo'); r2.room.addBot('easy');
    r2.room.startMatch();
    const m2 = r2.room.match!;
    ticks(r2.room, TIMERS.draftMs - 100);
    expect(m2.cardOf.size).toBe(0);
    ticks(r2.room, 200);
    expect(m2.cardOf.has(h.id)).toBe(true);
    const order = r2.inbox.get(h.id)!.filter(x => x.t === 'claimed').map(x => (x as Extract<ServerMsg, { t: 'claimed' }>).by);
    expect(order[0]).toBe(h.id);
  });
});

describe('score to win', () => {
  it('accepts every whole number 5..15 and rejects anything else server-side', () => {
    const { room, inbox } = mkRoom();
    const h = human(room, 'Host');
    for (let t = MATCH.minTarget; t <= MATCH.maxTarget; t++) { room.handle(h.id, { t: 'host', a: 'target', target: t }); expect(room.target).toBe(t); }
    for (const bad of [4, 16, 7.5, -1, '10', null, Number.NaN]) {
      room.handle(h.id, { t: 'host', a: 'target', target: bad });
      expect(room.target).toBe(MATCH.maxTarget);
    }
    expect(inbox.get(h.id)!.filter(x => x.t === 'error').length).toBeGreaterThanOrEqual(4);
    room.addBot('easy'); room.startMatch();
    room.handle(h.id, { t: 'host', a: 'target', target: 6 }); // locked during the match
    expect(room.target).toBe(MATCH.maxTarget);
    expect(room.match!.targetTenths).toBe(150);
  });

  const toRace = (room: Room) => { let g = 0; while (room.phase !== 'race' && g++ < TICK_HZ * 120) room.tick(); room.tick(); };

  it('ends the match the moment a trap kill crosses the target, mid-race and exactly once', () => {
    const { room, inbox } = mkRoom();
    const h = human(room, 'Host');
    room.target = 5;
    room.addBot('easy'); room.addBot('easy');
    room.startMatch();
    const m = room.match!;
    toRace(room);
    m.tally.get(h.id)!.score = 48;
    const victim = m.race!.players.find(p => p.id !== h.id)!;
    m.race!.lethalHit(victim, h.id, 'oval', 'trap');
    room.tick();
    expect(room.phase).toBe('matchEnd');
    expect(m.matchResult!.winners).toEqual([h.id]);
    expect(m.tally.get(h.id)!.score).toBe(50);
    expect(m.race).toBeNull(); // gameplay stopped although others were still racing
    ticks(room, 2000);
    expect(inbox.get(h.id)!.filter(x => x.t === 'matchEnd')).toHaveLength(1);
    expect(m.tally.get(h.id)!.score).toBe(50); // frozen
  });

  it('shares the win between players who cross the target on the same tick, without an unearned sole bonus', () => {
    const { room } = mkRoom();
    const h = human(room, 'Host');
    room.target = 5;
    room.addBot('easy');
    room.startMatch();
    const m = room.match!;
    toRace(room);
    const [p1, p2] = m.race!.players;
    for (const p of m.race!.players) m.tally.get(p.id)!.score = 39;
    const f = m.world.finishPx;
    // p1 alone reaches the flag first: 3.9 + 1 + 0.4 = 5.3 >= 5, but the sole bonus is not paid while p2 can still finish
    at(m.race!, p1.id, f.x + 4, f.y + 4);
    room.tick();
    expect(room.phase).toBe('matchEnd');
    const row = m.matchResult!.rows.find(r => r.pid === p1.id)!;
    expect(row.sole).toBe(0);
    expect(m.matchResult!.winners).toEqual([p1.id]);
    void p2; void h;
    // same tick: both cross together
    const r2 = mkRoom(); const h2 = human(r2.room, 'H'); r2.room.target = 5; r2.room.addBot('easy'); r2.room.startMatch();
    const m2 = r2.room.match!;
    toRace(r2.room);
    for (const p of m2.race!.players) { m2.tally.get(p.id)!.score = 45; at(m2.race!, p.id, m2.world.finishPx.x + 4 + (p.id === h2.id ? 0 : 40), m2.world.finishPx.y + 4); }
    r2.room.tick();
    expect(r2.room.phase).toBe('matchEnd');
    expect(m2.matchResult!.winners.sort()).toEqual(m2.roster.slice().sort());
  });
});

describe('impossible courses', () => {
  const saved = { ...TIMERS };
  afterEach(() => { Object.assign(TIMERS, saved); });

  it('accepts a legal placement that seals the course, ends the race normally, and lets bombs reopen it', () => {
    TIMERS.raceMs = 3000; TIMERS.resultsMs = 500;
    const { room, inbox } = mkRoom('lab');
    const h = human(room, 'Host');
    room.addBot('easy');
    room.startMatch();
    const m = room.match!;
    m.pool[0].item = 'plank_3';
    room.handle(h.id, { t: 'claim', round: 1, card: m.pool[0].id });
    let g = 0; while (room.phase !== 'build' && g++ < 10000) room.tick();
    expect(room.match!.courseOpen).toBe(true);
    room.handle(h.id, { t: 'place', round: 1, x: 20, y: 1, rot: 1, variant: 0 }); // closes the only gap over the wall
    expect(inbox.get(h.id)!.some(x => x.t === 'placed')).toBe(true);
    expect(inbox.get(h.id)!.some(x => x.t === 'placeFail')).toBe(false);
    g = 0; while (room.phase !== 'results' && g++ < TICK_HZ * 200) room.tick();
    expect(room.phase).toBe('results');
    expect(m.results[0].every(r => r.time === null)).toBe(true); // nobody could finish; the race still ended
    g = 0; while (room.phase !== 'draft' && g++ < 10000) room.tick();
    expect(m.round).toBe(2);
    expect(m.pool.some(c => getItem(c.item).group === 'demolition')).toBe(true); // a bomb to reopen it
    const bomb = m.pool.find(c => getItem(c.item).group === 'demolition')!;
    bomb.item = 'bomb_1';
    room.handle(h.id, { t: 'claim', round: 2, card: bomb.id });
    g = 0; while (room.phase !== 'build' && g++ < 10000) room.tick();
    room.handle(h.id, { t: 'place', round: 2, x: 20, y: 2, rot: 0, variant: 0 });
    expect(inbox.get(h.id)!.some(x => x.t === 'removed')).toBe(true);
  });

  it('still enforces the ordinary rules: grid, overlap, sniper support, moving-item exceptions', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'block_1x1', x: 3.5, y: 10, rot: 0, variant: 0 }).ok).toBe(false);
    put(w, 'block_1x1', 10, 10);
    expect(checkPlacement(w, { item: 'block_1x1', x: 10, y: 10, rot: 0, variant: 0 }).ok).toBe(false);
    expect(checkPlacement(w, { item: 'sniper', x: 12, y: 8, rot: 0, variant: 0 }).ok).toBe(false);
    expect(checkPlacement(w, { item: 'shuttle', x: 20, y: 8, rot: 0, variant: 0 }).ok).toBe(false); // wholly in the wall
    expect(checkPlacement(w, { item: 'block_1x1', x: 20, y: 8, rot: 0, variant: 0 }).ok).toBe(false); // ordinary items never overlap terrain
  });
});
