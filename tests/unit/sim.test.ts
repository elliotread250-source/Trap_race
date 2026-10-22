import { describe, expect, it } from 'vitest';
import { CELL, HAZARD, PHYS, TICK_HZ } from '../../shared/config';
import { IN_JUMP, IN_LEFT, IN_RIGHT, newBody, staticEnv, stepBody } from '../../shared/physics';
import { RaceSim, type RaceEvent } from '../../shared/race';
import { rankMatch, scoreRound } from '../../shared/scoring';
import { makeObject } from '../../shared/placement';
import { World } from '../../shared/world';
import { floorY, lab, put } from './helpers';

const steps = (sim: RaceSim, n: number, inputs: Record<string, number> = {}) => {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n && !sim.over; i++) { sim.step(new Map(Object.entries(inputs))); ev.push(...sim.drainEvents()); }
  return ev;
};
const place = (sim: RaceSim, id: string, cx: number, rowFloor = 16) => { const p = sim.player(id)!; p.body.x = cx * CELL + 10; p.body.y = floorY(rowFloor); p.body.vx = 0; p.body.vy = 0; p.body.grounded = true; };

describe('movement', () => {
  it('wall slides at the capped speed only while falling in contact', () => {
    const w = lab(), env = staticEnv(w);
    const b = newBody(20 * CELL - PHYS.bodyW, 6 * CELL);
    b.vy = 400;
    let slid = false;
    for (let i = 0; i < 20; i++) { stepBody(b, IN_RIGHT, env); if (b.wallSliding) { slid = true; expect(b.vy).toBeLessThanOrEqual(PHYS.wallSlideMax + 1e-6); } }
    expect(slid).toBe(true);
    // rising beside the wall does not slide
    const r = newBody(20 * CELL - PHYS.bodyW, 10 * CELL); r.vy = -400;
    stepBody(r, IN_RIGHT, env); stepBody(r, IN_RIGHT, env);
    expect(r.wallSliding).toBe(false);
  });

  it('wall jump launches up and away, and unlimited same-wall jumps climb a 12-cell wall', () => {
    const w = lab(), env = staticEnv(w);
    const b = newBody(17 * CELL, floorY());
    for (let i = 0; i < 3; i++) stepBody(b, 0, env);
    let hold = 0, rel = 0, jumps = 0, top = false;
    for (let t = 0; t < 900 && !top; t++) {
      let inp = IN_RIGHT;
      if (hold > 0) { inp |= IN_JUMP; hold--; if (!hold) rel = 1; } else if (rel) rel--;
      else if (b.wallDir === 1 || t === 20) { inp |= IN_JUMP; hold = 16; }
      const before = b.vx;
      stepBody(b, inp, env);
      if (b.wallJumped) { jumps++; expect(b.vx).toBeLessThan(0); expect(b.vy).toBeLessThan(0); void before; }
      if (b.grounded && b.y + PHYS.bodyH <= 4 * CELL + 0.5) top = true;
    }
    expect(jumps).toBeGreaterThanOrEqual(5);
    expect(top).toBe(true);
  });

  it('cannot repeat a wall jump by holding the button against one contact', () => {
    const w = lab(), env = staticEnv(w);
    const b = newBody(20 * CELL - PHYS.bodyW, 8 * CELL); b.vy = 50;
    stepBody(b, IN_RIGHT, env);
    let n = 0;
    for (let i = 0; i < 30; i++) { stepBody(b, IN_RIGHT | IN_JUMP, env); if (b.wallJumped) n++; }
    expect(n).toBe(1);
  });

  it('gives every player the same hitbox and movement (skins are cosmetic)', () => {
    const sim = new RaceSim(lab(), ['a', 'b', 'c'], { roundKey: 'k', maxTicks: 600 });
    steps(sim, 30, { a: IN_RIGHT, b: IN_RIGHT, c: IN_RIGHT });
    const xs = sim.players.map(p => p.body.x - p.spawn.x);
    expect(new Set(xs.map(x => x.toFixed(6))).size).toBe(1);
  });
});

describe('launchers and projectiles', () => {
  it('snipers fire exactly every 2.5 s of simulation time, pierce players and stop at blocks', () => {
    const w = lab();
    const s = put(w, 'sniper', 8, 15, 0, 'owner');
    put(w, 'plank_3', 17, 13, 1); // upright plank at x 17, rows 13-15
    const sim = new RaceSim(w, ['owner', 'a', 'b', 'c'], { roundKey: 'k', maxTicks: 2000 });
    place(sim, 'a', 11); place(sim, 'b', 14); place(sim, 'c', 18); place(sim, 'owner', 2);
    const ev = steps(sim, Math.round(HAZARD.sniperInterval * TICK_HZ) + 30);
    const fires = ev.filter(e => e.type === 'fire' && e.src === s.id);
    expect(fires[0].t).toBe(150);
    const deaths = ev.filter(e => e.type === 'death') as Extract<RaceEvent, { type: 'death' }>[];
    expect(deaths.map(d => d.pid).sort()).toEqual(['a', 'b']);
    expect(deaths.every(d => d.credit === 'owner')).toBe(true);
    expect(sim.player('c')!.status).toBe('racing'); // behind the plank
    const sim2 = new RaceSim(lab(), ['x'], { roundKey: 'k2', maxTicks: 2000 });
    void sim2;
    const w3 = lab(); put(w3, 'sniper', 8, 15, 0, 'o');
    const s3 = new RaceSim(w3, ['o'], { roundKey: 'k3', maxTicks: 2000 });
    s3.player('o')!.body.x = 2 * CELL; // stay home
    const e3 = steps(s3, 760).filter(e => e.type === 'fire').map(e => e.t);
    expect(e3).toEqual([150, 300, 450, 600, 750]);
  });

  it('cannonballs follow a gravity arc and stop at the first player', () => {
    const w = lab();
    put(w, 'cannon', 8, 10, 0, 'o');
    const sim = new RaceSim(w, ['o'], { roundKey: 'k', maxTicks: 2000 });
    place(sim, 'o', 3);
    steps(sim, 180);
    const vys: number[] = [];
    for (let i = 0; i < 20; i++) { steps(sim, 1); const p = sim.projectiles[0]; if (p) vys.push(p.vy); }
    expect(vys.length).toBeGreaterThan(5);
    for (let i = 1; i < vys.length; i++) expect(vys[i]).toBeGreaterThan(vys[i - 1]); // curving downward
    const vx = sim.projectiles[0]?.vx;
    expect(vx).toBeCloseTo(HAZARD.cannonMuzzleSpeed * Math.cos(Math.PI / 6), 3);
  });

  it('arrows fly straight at constant speed and break on the first player even with a shield', () => {
    const w = lab();
    const cb = put(w, 'crossbow', 8, 15, 0, 'o');
    const sim = new RaceSim(w, ['o', 'a', 'b'], { roundKey: 'k', maxTicks: 2000 });
    place(sim, 'o', 3); place(sim, 'a', 12); place(sim, 'b', 15);
    sim.player('a')!.effects.shield = 5;
    steps(sim, 120);
    const arrow = sim.projectiles.find(p => p.src === cb.id)!;
    const speed = Math.hypot(arrow.vx, arrow.vy);
    steps(sim, 3);
    expect(Math.hypot(arrow.vx, arrow.vy)).toBe(speed);
    expect(arrow.vy).toBe(0);
    steps(sim, 60);
    expect(sim.player('a')!.status).toBe('racing'); // shield absorbed it
    expect(sim.player('a')!.effects.shield).toBe(0);
    expect(sim.player('b')!.status).toBe('racing'); // the arrow broke on a, never reached b
    expect(sim.projectiles.some(p => p.id === arrow.id)).toBe(false);
  });

  it('fast projectiles cannot tunnel through a one-cell plank', () => {
    const w = lab();
    put(w, 'sniper', 8, 15, 0, 'o');
    put(w, 'block_1x1', 12, 15);
    const sim = new RaceSim(w, ['o', 'a'], { roundKey: 'k', maxTicks: 2000 });
    place(sim, 'o', 3); place(sim, 'a', 13);
    steps(sim, 200);
    expect(sim.player('a')!.status).toBe('racing');
  });
});

describe('black holes', () => {
  it('pull players in, kill at the core, credit the owner and respect solids', () => {
    const w = lab();
    put(w, 'blackhole', 12, 14, 0, 'o');
    const sim = new RaceSim(w, ['o', 'a'], { roundKey: 'k', maxTicks: 2000 });
    place(sim, 'o', 3);
    const a = sim.player('a')!; a.body.x = 12 * CELL + 10; a.body.y = 11 * CELL; a.body.grounded = false;
    const ev = steps(sim, 120);
    const d = ev.find(e => e.type === 'death' && e.pid === 'a') as Extract<RaceEvent, { type: 'death' }>;
    expect(d?.cause).toBe('blackhole');
    expect(d?.credit).toBe('o');
    // a wall between the hole and the player blocks the pull
    const w2 = lab();
    put(w2, 'blackhole', 24, 12, 0, 'o');
    const sim2 = new RaceSim(w2, ['p'], { roundKey: 'k2', maxTicks: 100 });
    const p = sim2.player('p')!; p.body.x = 19 * CELL - 30; p.body.y = 11 * CELL;
    expect(sim2.holePull(p.body, null)).toBeNull();
    // nothing pulls inside protected zones
    const s = w.spawnPx;
    const b = newBody(s.x + 20, s.y + 10);
    expect(sim.holePull(b, null)).toBeNull();
  });
});

describe('coins', () => {
  it('award nothing on pickup, drop at the death spot, can be banked by someone else, and reset next round', () => {
    const w = lab();
    const coin = put(w, 'coin', 10, 15);
    put(w, 'spikes', 13, 15, 0, 'trapper');
    const sim = new RaceSim(w, ['a', 'b', 'trapper'], { roundKey: 'k', maxTicks: 4000 });
    place(sim, 'a', 9); place(sim, 'b', 3); place(sim, 'trapper', 2);
    let ev = steps(sim, 60, { a: IN_RIGHT });
    expect(ev.some(e => e.type === 'coin' && e.action === 'pickup' && e.pid === 'a')).toBe(true);
    expect(sim.player('a')!.status).toBe('dead');
    const c = sim.coins.find(k => k.id === coin.id)!;
    expect(c.state).toBe('dropped');
    const death = ev.find(e => e.type === 'death')! as Extract<RaceEvent, { type: 'death' }>;
    expect(Math.abs(c.x - death.x)).toBeLessThan(1e-6); // exactly where the carrier died, not snapped
    expect(c.ox).toBe(10 * CELL + CELL / 2); // origin untouched
    // b walks to the coin and banks it at the flag
    const bb = sim.player("b")!; bb.body.x = c.x - PHYS.bodyW / 2; bb.body.y = c.y - 5 - PHYS.bodyH; // touch the coin from above, clear of the spikes
    ev = steps(sim, 2);
    expect(c.carrier).toBe('b');
    bb.body.x = w.finishPx.x + 4; bb.body.y = w.finishPx.y + 4;
    ev = ev.concat(steps(sim, 2));
    const all = [...ev];
    const rows = scoreRound(['a', 'b', 'trapper'], true, [...all, ...sim.events, death], new Map(sim.players.map(p => [p.id, p.status])), new Map());
    const rb = rows.find(r => r.pid === 'b')!;
    expect(rb.coins).toBe(1);
    expect(rows.find(r => r.pid === 'a')!.coins).toBe(0);
    // next round: a fresh race returns the coin to its origin
    const next = new RaceSim(w, ['a'], { roundKey: 'k2', maxTicks: 100 });
    const nc = next.coins.find(k => k.id === coin.id)!;
    expect(nc.state).toBe('origin');
    expect([nc.x, nc.y]).toEqual([nc.ox, nc.oy]);
    expect(next.coins.filter(k => k.id === coin.id).length).toBe(1);
  });

  it('gives a contested coin to exactly one player and loses coins dropped by a fall', () => {
    const w = lab();
    const coin = put(w, 'coin', 10, 15);
    const sim = new RaceSim(w, ['a', 'b'], { roundKey: 'k', maxTicks: 4000 });
    place(sim, 'a', 10); place(sim, 'b', 10);
    steps(sim, 1);
    const c = sim.coins.find(k => k.id === coin.id)!;
    expect(c.state).toBe('carried');
    expect(sim.players.filter(p => p.coins.includes(coin.id)).length).toBe(1);
    const carrier = sim.player(c.carrier!)!;
    carrier.body.y = (w.h + 3) * CELL;
    steps(sim, 1);
    expect(c.state).toBe('lost');
  });
});

describe('scoring', () => {
  const ev = (list: [string, string, number][]) => list.map(([type, pid, tick], i) => (type === 'finish' ? { id: `r:finish:${pid}`, t: tick, type: 'finish', pid, tick } : { id: `r:death:${pid}:${i}`, t: tick, type: 'death', pid, credit: null, cause: 'fall', src: null, x: 0, y: 0 })) as RaceEvent[];
  const st = (m: Record<string, string>) => new Map(Object.entries(m)) as Map<string, 'finished'>;
  it('matches the examples: first + finish, sole finisher gets 3', () => {
    const r = scoreRound(['alex', 'bailey'], true, ev([['finish', 'alex', 100], ['finish', 'bailey', 200]]), st({ alex: 'finished', bailey: 'finished' }), new Map());
    expect(r.find(x => x.pid === 'alex')!.total).toBe(2);
    expect(r.find(x => x.pid === 'bailey')!.total).toBe(1);
    const s = scoreRound(['alex', 'bailey'], true, ev([['finish', 'alex', 100]]), st({ alex: 'finished', bailey: 'dead' }), new Map());
    expect(s.find(x => x.pid === 'alex')!.total).toBe(3);
  });
  it('gives tied first finishers the bonus each and nobody finish points when nobody finishes', () => {
    const r = scoreRound(['a', 'b', 'c'], true, ev([['finish', 'a', 100], ['finish', 'b', 100], ['finish', 'c', 140]]), st({}), new Map());
    expect(r.map(x => x.first)).toEqual([1, 1, 0]);
    const z = scoreRound(['a', 'b'], true, [], st({}), new Map());
    expect(z.every(x => x.total === 0)).toBe(true);
  });
  it('solo practice awards no first, sole or trap bonuses', () => {
    const r = scoreRound(['me'], false, ev([['finish', 'me', 50]]), st({ me: 'finished' }), new Map());
    expect(r[0]).toMatchObject({ base: 1, first: 0, sole: 0, trap: 0 });
  });
  it('credits trap eliminations once per victim, caps at 3, never for self or the map', () => {
    const deaths: RaceEvent[] = ['b', 'c', 'd', 'e'].map(v => ({ id: `r:death:${v}`, t: 1, type: 'death', pid: v, credit: 'a', cause: 'spikes', src: 'o1', x: 0, y: 0 }));
    deaths.push({ id: 'r:death:a', t: 2, type: 'death', pid: 'a', credit: null, cause: 'spikes', src: 'o1', x: 0, y: 0 });
    deaths.push(deaths[0]); // duplicate callback
    const r = scoreRound(['a', 'b', 'c', 'd', 'e'], true, deaths, st({}), new Map());
    expect(r.find(x => x.pid === 'a')!.trap).toBe(3);
    expect(r.filter(x => x.pid !== 'a').every(x => x.trap === 0)).toBe(true);
  });
  it('breaks ties by finishes, then lower total finish time, else shared victory', () => {
    const t = new Map([['a', { score: 5, finishes: 3, finishTime: 40 }], ['b', { score: 5, finishes: 3, finishTime: 38 }], ['c', { score: 5, finishes: 2, finishTime: 10 }]]);
    expect(rankMatch(['a', 'b', 'c'], t).winners).toEqual(['b']);
    const u = new Map([['a', { score: 4, finishes: 2, finishTime: 30 }], ['b', { score: 4, finishes: 2, finishTime: 30 }]]);
    expect(rankMatch(['a', 'b'], u).winners.sort()).toEqual(['a', 'b']);
  });
});

describe('deterministic race rules', () => {
  it('a lethal contact on the same tick as reaching the flag wins (eliminated, no finish)', () => {
    const w = lab();
    // inject a spike strip touching the finish (placement rules would refuse this; it tests the tie rule only)
    const req = { item: 'spikes', x: 35, y: 15, rot: 0 as const, variant: 0 };
    const o = makeObject(w, req, { ok: true, cells: [[35, 15], [36, 15]], support: null }, 'z', 1);
    w.objects.set(o.id, o); w.rebuild();
    const sim = new RaceSim(w, ['a', 'z'], { roundKey: 'k', maxTicks: 100 });
    place(sim, 'z', 3);
    const a = sim.player('a')!; a.body.x = 35 * CELL + 6; a.body.y = floorY();
    const ev = steps(sim, 1);
    expect(ev.some(e => e.type === 'finish')).toBe(false);
    expect(a.status).toBe('dead');
  });
  it('disconnect clears inputs and eliminates after the grace window without immunity', () => {
    const sim = new RaceSim(lab(), ['a', 'b'], { roundKey: 'k', maxTicks: 4000 });
    sim.setConnected('a', false);
    const x0 = sim.player('a')!.body.x;
    steps(sim, 60, { a: IN_RIGHT });
    expect(sim.player('a')!.body.x).toBe(x0); // held input ignored
    steps(sim, 20 * TICK_HZ);
    expect(sim.player('a')!.status).toBe('dead');
    expect(sim.player('a')!.cause).toBe('disconnect');
  });
  it('is deterministic for the same inputs', () => {
    const run = () => { const s = new RaceSim(new World('rooftop'), ['a'], { roundKey: 'k', maxTicks: 600 }); steps(s, 300, { a: IN_RIGHT | IN_JUMP }); return s.player('a')!.body.x; };
    expect(run()).toBe(run());
    void IN_LEFT;
  });
});
