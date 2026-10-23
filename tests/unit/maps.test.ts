import { describe, expect, it } from 'vitest';
import { CELL } from '../../shared/config';
import { MAP_LIST, getMap, selectableMap } from '../../shared/maps';
import { baseNav, NavGraph, type NavEdge } from '../../shared/nav';
import { assessPlacement, checkPlacement, makeObject, applyPlacement, progressOf } from '../../shared/placement';
import { RaceSim } from '../../shared/race';
import { World } from '../../shared/world';
import { BotRacer } from '../../server/bots';
import { put } from './helpers';

const STANDARD_W = 64; // every pre-existing map measured 64 x 26 cells (3072 x 1248 px)
const routeS = (g: NavGraph) => {
  let best = Infinity;
  for (const s of g.spawnNodes().slice(0, 2)) { const r = g.route(s); if (r) best = Math.min(best, r.reduce((a: number, e: NavEdge) => a + e.frames, 0) / 60); }
  return best;
};
/** Air connectivity (no physics): can open cells link spawn to flag without passing through `blocked` cells? */
function airConnected(mapId: string, blocked: (x: number, y: number) => boolean): boolean {
  const w = new World(mapId), m = w.map;
  const open = (x: number, y: number) => w.inBounds(x, y) && w.terrainAt(x, y) !== 1 && w.terrainAt(x, y) !== 2 && !blocked(x, y);
  const seen = new Set<number>(), q: [number, number][] = [[m.spawn.x, m.spawn.y]];
  seen.add(m.spawn.y * w.w + m.spawn.x);
  while (q.length) {
    const [x, y] = q.pop()!;
    if (x >= m.finish.x && x < m.finish.x + m.finish.w && y >= m.finish.y && y < m.finish.y + m.finish.h) return true;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const k = ny * w.w + nx;
      if (!seen.has(k) && open(nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return false;
}

describe('map sizes and layout', () => {
  it('both new maps are measurably larger than the standard maps and list their size', () => {
    for (const id of ['oak', 'mountain']) {
      const m = getMap(id);
      expect(m.w).toBeGreaterThanOrEqual(STANDARD_W * 1.5);
      expect(m.build.w * m.build.h).toBeGreaterThan(62 * 25 * 2); // playable build space, not just background
      expect(m.size).toBe('large');
      expect((m.finish.x - m.spawn.x) / m.w).toBeGreaterThan(0.85); // flag at the far end, not over the start
    }
  });

  it('every selectable map runs left to right with the flag far from spawn; test arenas are never selectable', () => {
    for (const m of MAP_LIST) expect(m.finish.x - m.spawn.x).toBeGreaterThan(m.w * 0.75);
    expect(selectableMap('lab')).toBe(false);
    expect(selectableMap('lab_wheel')).toBe(false);
    expect(selectableMap('oak')).toBe(true);
  });

  it('only barbed wire is authored as a map trap on every map', () => {
    for (const m of MAP_LIST) {
      const w = new World(m.id);
      for (const o of w.objects.values()) expect(o.item.startsWith('wire_')).toBe(true);
    }
  });
});

describe('the old Rooftop skip is gone', () => {
  it('the upright planks that turned the loop into a 5 s shaft climb no longer shorten the route meaningfully', () => {
    const w = new World('rooftop');
    const base = routeS(NavGraph.fromBase(baseNav('rooftop'), w));
    for (const [x, y] of [[2, 2], [2, 9], [2, 12], [3, 13]]) {
      const t = new World('rooftop');
      const c = checkPlacement(t, { item: 'plank_7', x, y, rot: 1, variant: 0 });
      if (!c.ok) continue;
      applyPlacement(t, makeObject(t, { item: 'plank_7', x, y, rot: 1, variant: 0 }, c, 'p', 1));
      expect(routeS(new NavGraph(t))).toBeGreaterThan(base * 0.85);
    }
  }, 60000);

  it('a shaft against the left world wall next to spawn gives no whole-map skip on any map (unlimited wall jumps)', () => {
    for (const m of MAP_LIST) {
      const w = new World(m.id);
      // two stacked upright plank 7s one cell off the left wall: a 14-cell zig-zag shaft straight up from the start
      let ok = 0;
      for (const y of [m.spawn.y - 11, m.spawn.y - 4]) {
        const req = { item: 'plank_7', x: 2, y, rot: 1, variant: 0 };
        const c = checkPlacement(w, req);
        if (c.ok) { applyPlacement(w, makeObject(w, req, c, 'p', 1)); ok++; }
      }
      const g = new NavGraph(w);
      const s = routeS(g);
      const base = routeS(NavGraph.fromBase(baseNav(m.id), new World(m.id)));
      if (m.buildRequired) expect(s).toBe(Infinity); // the shaft gets you high near the start, the oak still stands in the way
      else expect(s).toBeGreaterThan(base * 0.8);
      void ok;
    }
  }, 120000);
});

describe('under the mountain', () => {
  it('the rock above the cave is continuous and fused to the top of the world: no roof route and no seam', () => {
    const m = getMap('mountain');
    const w = new World('mountain');
    for (let x = 41; x < 81; x++) for (let y = 0; y < 3; y++) expect(w.terrainAt(x, y)).toBe(1);
    // block the cave interior: no open-air path is left from the start to the flag
    const cave = m.materials!.filter(z => z.m === 'cave');
    const inCave = (x: number, y: number) => cave.some(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
    expect(airConnected('mountain', inCave)).toBe(false);
    expect(airConnected('mountain', () => false)).toBe(true);
  });

  it('is traversable on the empty course and its exit is far from its entrance', () => {
    const g = NavGraph.fromBase(baseNav('mountain'), new World('mountain'));
    expect(g.reach(false).finish).toBe(true);
    const r = g.route(g.spawnNodes()[0])!;
    const xs = r.flatMap(e => Array.from({ length: e.frames }, (_, i) => e.path[i * 2] / CELL));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(90);
  });
});

describe('the great oak', () => {
  it('cannot be crossed without building, even with unlimited wall jumps, and the only open-air way on is over the canopy', () => {
    const g = NavGraph.fromBase(baseNav('oak'), new World('oak'));
    expect(g.reach(false).finish).toBe(false);
    expect(airConnected('oak', (_x, y) => y <= 9)).toBe(false); // no gap under or through the tree
  });

  it('opens with one ordinary piece of several kinds, or with two small ones', () => {
    const opens = (items: [string, number, number, number][]) => {
      const w = new World('oak');
      let nav = NavGraph.fromBase(baseNav('oak'), w);
      for (const [item, x, y, rot] of items) {
        const { check, nav: g } = assessPlacement(w, { item, x, y, rot, variant: 0 }, nav);
        expect(check.ok, `${item}: ${check.reason}`).toBe(true);
        applyPlacement(w, makeObject(w, { item, x, y, rot, variant: 0 }, check, 'p', 1));
        nav = g!;
      }
      return nav.reach(false).finish;
    };
    expect(opens([['plank_7', 38, 18, 1]])).toBe(true);
    expect(opens([['plank_5', 38, 20, 1]])).toBe(true);
    expect(opens([['spring', 38, 24, 0]])).toBe(true);
    expect(opens([['shuttle', 38, 23, 3]])).toBe(true);
    expect(opens([['block_2x3', 37, 22, 0], ['block_2x2', 38, 20, 0]])).toBe(true);
  }, 60000);

  it('accepts partial building and also a piece that cuts players off (advisory only), while ordinary rules still apply', () => {
    const w = new World('oak');
    const nav = NavGraph.fromBase(baseNav('oak'), w);
    const before = progressOf(w, nav.reach(false).visited);
    const partial = assessPlacement(w, { item: 'plank_3', x: 38, y: 22, rot: 1, variant: 0 }, nav);
    expect(partial.check.ok).toBe(true);
    expect(partial.cutsProgress).toBe(false);
    const cut = assessPlacement(w, { item: 'block_3x3', x: 26, y: 30, rot: 0, variant: 0 }, nav);
    expect(cut.check.ok).toBe(true); // legal even though it shuts players off
    expect(cut.cutsProgress).toBe(true);
    // bounds, overlap and spawn protection still apply
    expect(checkPlacement(w, { item: 'block_1x1', x: 3, y: 30, rot: 0, variant: 0 }).reason).toMatch(/start safety zone/);
    expect(checkPlacement(w, { item: 'block_1x1', x: 51, y: 25, rot: 0, variant: 0 }).reason).toMatch(/terrain/);
    expect(before.stage).toBe(1);
  }, 60000);
});

describe('bots on moving platforms', () => {
  it('bots board, ride and leave a shuttle and a ferris wheel to cross pits they cannot jump, using normal physics', () => {
    for (const [map, item, x, y] of [['lab_gap', 'shuttle', 17, 14], ['lab_wheel', 'wheel', 22, 15]] as const) {
      const w = new World(map);
      put(w, item, x, y, 0);
      const nav = new NavGraph(w);
      const ids = ['a', 'b', 'c', 'd'];
      const sim = new RaceSim(w, ids, { roundKey: 'bots', maxTicks: 60 * 60 });
      const bots = ids.map((id, i) => new BotRacer(id, 'medium', 40 + i));
      let rode = 0;
      while (!sim.over) {
        const m = new Map<string, number>();
        for (const b of bots) m.set(b.id, b.think(sim, nav));
        sim.step(m);
        for (const p of sim.players) if (p.body.grounded && p.body.groundMover >= 0) rode++;
      }
      const fin = sim.players.filter(p => p.status === 'finished').length;
      expect(fin, map).toBeGreaterThanOrEqual(3);
      expect(rode).toBeGreaterThan(60);
    }
  }, 60000);
});
