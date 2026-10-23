import { describe, expect, it } from 'vitest';
import { rotateMask } from '../../shared/grid';
import { ITEM_LIST, getItem } from '../../shared/items';
import { MAP_LIST } from '../../shared/maps';
import { applyBomb, assessPlacement, checkPlacement } from '../../shared/placement';
import { TERRAIN_ID, World } from '../../shared/world';
import { lab, put } from './helpers';

const dims = (id: string, rot = 0) => {
  const m = rotateMask(getItem(id).mask, rot);
  return [Math.max(...m.map(c => c[0])) + 1, Math.max(...m.map(c => c[1])) + 1, m.length];
};

describe('exact construction shapes', () => {
  it('has every required block size and rotates rectangles correctly', () => {
    expect(dims('block_1x1')).toEqual([1, 1, 1]);
    expect(dims('block_1x2')).toEqual([1, 2, 2]);
    expect(dims('block_1x2', 1)).toEqual([2, 1, 2]);
    expect(dims('block_2x2')).toEqual([2, 2, 4]);
    expect(dims('block_2x3')).toEqual([2, 3, 6]);
    expect(dims('block_2x3', 1)).toEqual([3, 2, 6]);
    expect(dims('block_3x3')).toEqual([3, 3, 9]);
  });
  it('has planks one cell thick and 3, 5, 7 long, horizontal or upright', () => {
    for (const n of [3, 5, 7]) {
      expect(dims(`plank_${n}`)).toEqual([n, 1, n]);
      expect(dims(`plank_${n}`, 1)).toEqual([1, n, n]);
      expect(getItem(`plank_${n}`).solid).toBe(true);
    }
  });
  it('L block is five cells in a 3x3 box with a genuinely empty interior in all orientations', () => {
    for (let r = 0; r < 4; r++) {
      const m = rotateMask(getItem('l_block').mask, r);
      expect(m.length).toBe(5);
      expect(dims('l_block', r).slice(0, 2)).toEqual([3, 3]);
      expect(m.some(([x, y]) => x === 1 && y === 1)).toBe(false); // centre cell is empty
    }
    const w = lab();
    put(w, 'l_block', 5, 8, 0); // cells (5,8),(5,9),(5,10),(6,10),(7,10); interior (6,8),(6,9),(7,8),(7,9) empty
    expect(checkPlacement(w, { item: 'block_2x2', x: 6, y: 8, rot: 0, variant: 0 }).ok).toBe(true);
    expect(w.solidCell(6, 9)).toBe(false);
  });
});

describe('rotation rules', () => {
  it('every placeable item rotates except the sniper and the black hole', () => {
    for (const d of ITEM_LIST) {
      if (d.kind === 'sniper' || d.kind === 'blackhole') expect(d.rotatable).toBe(false);
      else expect(d.rotatable).toBe(true);
    }
  });
  it('the server rejects rotation requests for snipers and black holes', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'blackhole', x: 10, y: 10, rot: 1, variant: 0 }).reason).toMatch(/can't be rotated/);
    expect(checkPlacement(w, { item: 'sniper', x: 10, y: 15, rot: 2, variant: 0 }).reason).toMatch(/can't be rotated/);
    expect(checkPlacement(w, { item: 'blackhole', x: 10, y: 10, rot: 0, variant: 0 }).ok).toBe(true);
  });
});

describe('grid and occupancy', () => {
  it('rejects off-grid requests', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'block_1x1', x: 10.5, y: 10, rot: 0, variant: 0 }).ok).toBe(false);
  });
  it('no two footprints overlap, including non-solid coins, traps and pickups', () => {
    const w = lab();
    put(w, 'coin', 10, 10);
    for (const item of ['coin', 'crossbow', 'blackhole', 'block_1x1', 'power_speed', 'spikes'])
      expect(checkPlacement(w, { item, x: 10, y: 10, rot: 0, variant: 0 }).ok).toBe(false);
    // touching boundaries is fine
    expect(checkPlacement(w, { item: 'block_1x1', x: 11, y: 10, rot: 0, variant: 0 }).ok).toBe(true);
    // black hole embedded in a block is illegal
    put(w, 'block_2x2', 14, 8);
    expect(checkPlacement(w, { item: 'blackhole', x: 15, y: 9, rot: 0, variant: 0 }).reason).toMatch(/Overlaps/);
  });
  it('rotation revalidates occupancy', () => {
    const w = lab();
    put(w, 'block_1x1', 12, 10);
    expect(checkPlacement(w, { item: 'plank_3', x: 10, y: 11, rot: 0, variant: 0 }).ok).toBe(true);
    expect(checkPlacement(w, { item: 'plank_3', x: 12, y: 8, rot: 1, variant: 0 }).ok).toBe(false); // upright overlaps the block
  });
  it('protects the start and finish zones', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'block_1x1', x: 3, y: 14, rot: 0, variant: 0 }).reason).toBe('Inside start safety zone');
    expect(checkPlacement(w, { item: 'block_1x1', x: 36, y: 14, rot: 0, variant: 0 }).reason).toBe('Inside finish safety zone');
  });
  it('accepts a legal placement that seals the last route: the route check is advisory only', () => {
    const w = lab();
    // the lab wall is climbable by wall jumps; sealing the gap above it blocks every route
    const req = { item: 'plank_3', x: 20, y: 1, rot: 1, variant: 0 };
    expect(checkPlacement(w, req).ok).toBe(true);
    const a = assessPlacement(w, req, null);
    expect(a.check.ok).toBe(true);
    expect(a.blocksRoute).toBe(true); // bots can see it, nothing refuses it
  });
});

describe('tripod sniper support', () => {
  it('needs a full solid top face directly below', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'sniper', x: 10, y: 15, rot: 0, variant: 0 }).ok).toBe(true); // on the floor
    expect(checkPlacement(w, { item: 'sniper', x: 10, y: 10, rot: 0, variant: 0 }).reason).toMatch(/top of a solid/); // mid air
    expect(checkPlacement(w, { item: 'sniper', x: 19, y: 10, rot: 0, variant: 0 }).reason).toMatch(/top of a solid/); // beside the wall
    put(w, 'plank_5', 6, 9);
    expect(checkPlacement(w, { item: 'sniper', x: 7, y: 10, rot: 0, variant: 0 }).reason).toMatch(/top of a solid/); // under a ceiling
    expect(checkPlacement(w, { item: 'sniper', x: 7, y: 8, rot: 0, variant: 0 }).ok).toBe(true); // on top of the plank
    put(w, 'spiky_oval', 12, 12);
    expect(checkPlacement(w, { item: 'sniper', x: 12, y: 11, rot: 0, variant: 0 }).ok).toBe(false); // on a non-solid trap
    put(w, 'moving', 26, 10);
    expect(checkPlacement(w, { item: 'sniper', x: 26, y: 9, rot: 0, variant: 0 }).ok).toBe(false); // moving supports are not allowed
  });
});

describe('barbed wire', () => {
  it('attaches to top, right, bottom and left block edges', () => {
    const w = lab();
    put(w, 'block_3x3', 8, 6); // cells x 8..10, y 6..8
    expect(checkPlacement(w, { item: 'wire_3', x: 8, y: 5, rot: 0, variant: 0 }).wireLen).toBe(3); // top
    expect(checkPlacement(w, { item: 'wire_3', x: 11, y: 6, rot: 1, variant: 0 }).wireLen).toBe(3); // right face, runs down
    expect(checkPlacement(w, { item: 'wire_3', x: 10, y: 9, rot: 2, variant: 0 }).wireLen).toBe(3); // bottom, runs left
    expect(checkPlacement(w, { item: 'wire_3', x: 7, y: 8, rot: 3, variant: 0 }).wireLen).toBe(3); // left face, runs up
  });
  it('length 3 on a one-cell edge survives as exactly 1 segment, on a two-cell edge as 2, never wrapping corners', () => {
    const w = lab();
    put(w, 'block_1x1', 8, 6);
    const one = checkPlacement(w, { item: 'wire_3', x: 8, y: 5, rot: 0, variant: 0 });
    expect(one.ok).toBe(true); expect(one.cells).toEqual([[8, 5]]); expect(one.trimmed).toBe(2);
    put(w, 'block_2x2', 14, 6);
    const two = checkPlacement(w, { item: 'wire_3', x: 14, y: 5, rot: 0, variant: 0 });
    expect(two.cells).toEqual([[14, 5], [15, 5]]);
    // an adjacent separate block is not bridged onto
    put(w, 'block_1x1', 9, 6);
    const sep = checkPlacement(w, { item: 'wire_3', x: 8, y: 5, rot: 0, variant: 0 });
    expect(sep.cells).toEqual([[8, 5]]);
  });
  it('rejects wire with zero supported segments and overlapping wire', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'wire_1', x: 10, y: 8, rot: 0, variant: 0 }).ok).toBe(false);
    put(w, 'wire_2', 10, 15, 0);
    expect(checkPlacement(w, { item: 'wire_1', x: 11, y: 15, rot: 0, variant: 0 }).ok).toBe(false);
  });
});

describe('bombs', () => {
  it('have exact 1x1, 2x2 and 3x3 footprints', () => {
    const w = lab();
    const xs = [8, 12, 26];
    for (const x of xs) put(w, 'block_1x1', x, 10);
    [1, 2, 3].forEach((n, i) => expect(checkPlacement(w, { item: `bomb_${n}`, x: xs[i], y: 10, rot: 0, variant: 0 }).cells.length).toBe(n * n));
  });
  it('remove whole player objects plus dependents and never map terrain or map wire', () => {
    const w = new World('rooftop');
    const block = put(w, 'block_3x3', 14, 12);
    const sniper = put(w, 'sniper', 15, 11, 0, 'p2');
    const wire = put(w, 'wire_1', 14, 11, 0, 'p3');
    const c = checkPlacement(w, { item: 'bomb_1', x: 16, y: 14, rot: 0, variant: 0 }); // touches one corner cell of the block
    expect(c.ok).toBe(true);
    expect(c.targets).toEqual([block.id]);
    expect(new Set(c.dependents)).toEqual(new Set([sniper.id, wire.id]));
    const terrainBefore = w.terrain.slice();
    const mapWires = [...w.objects.values()].filter(o => o.prov === 'map').map(o => o.id);
    applyBomb(w, [...c.targets!, ...c.dependents!]);
    expect(w.objects.has(block.id) || w.objects.has(sniper.id) || w.objects.has(wire.id)).toBe(false);
    expect(w.terrain).toEqual(terrainBefore);
    for (const id of mapWires) expect(w.objects.has(id)).toBe(true);
  });
  it('report "No removable items" over permanent terrain or map wire', () => {
    const w = new World('rooftop');
    expect(checkPlacement(w, { item: 'bomb_3', x: 14, y: 21, rot: 0, variant: 0 }).reason).toMatch(/No removable/);
    const mw = [...w.objects.values()].find(o => o.prov === 'map')!;
    expect(checkPlacement(w, { item: 'bomb_1', x: mw.cells[0][0], y: mw.cells[0][1], rot: 0, variant: 0 }).reason).toMatch(/No removable/);
    expect(w.occAt(1, 25)).toBe(TERRAIN_ID);
  });
});

describe('maps', () => {
  it('ship four maps whose only authored traps are barbed wire', () => {
    expect(MAP_LIST.length).toBeGreaterThanOrEqual(4);
    for (const m of MAP_LIST) {
      const w = new World(m.id);
      for (const o of w.objects.values()) { expect(o.prov).toBe('map'); expect(getItem(o.item).kind).toBe('wire'); }
      expect(w.objects.size).toBeGreaterThan(0);
    }
  });
});
