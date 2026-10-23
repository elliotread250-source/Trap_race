import { describe, expect, it } from 'vitest';
import { CELL, MOVERS, PHYS } from '../../shared/config';
import { childRect, referenceRects, sweepOf, wheelAngle } from '../../shared/movers';
import { IN_JUMP, IN_LEFT, IN_RIGHT, IN_SPRINT, overlapsSolid, staticEnv } from '../../shared/physics';
import { applyBomb, checkPlacement } from '../../shared/placement';
import { RaceSim } from '../../shared/race';
import { lab, put } from './helpers';

const C = CELL, H = PHYS.bodyH, W = PHYS.bodyW;

function riderSim(world: ReturnType<typeof lab>) {
  return new RaceSim(world, ['a'], { roundKey: 't', maxTicks: 60 * 600 });
}
const stand = (sim: RaceSim, x: number, y: number) => { const b = sim.players[0].body; b.x = x; b.y = y; b.vx = 0; b.vy = 0; b.grounded = false; };
const step = (sim: RaceSim, bits = 0, n = 1) => { for (let i = 0; i < n; i++) sim.step(new Map([['a', bits]])); };

describe('shuttle block', () => {
  it('is exactly 2x1 cells, 1x2 after a quarter turn, and its lane follows the rotation', () => {
    const w = lab();
    const o = put(w, 'shuttle', 8, 10, 0);
    expect(childRect(o, 0, 0)).toEqual({ x: 8 * C, y: 10 * C, w: 2 * C, h: C });
    expect(sweepOf(o).sweep.map(c => c.join(','))).toEqual(Array.from({ length: 2 + MOVERS.shuttleTravelCells }, (_, i) => `${8 + i},10`));
    const v = put(w, 'shuttle', 26, 6, 1);
    expect(childRect(v, 0, 0)).toEqual({ x: 26 * C, y: 6 * C, w: C, h: 2 * C });
    expect(sweepOf(v).sweep.every(([x]) => x === 26)).toBe(true);
    expect(Math.max(...sweepOf(v).sweep.map(c => c[1]))).toBe(6 + 1 + MOVERS.shuttleTravelCells);
    const left = put(w, 'shuttle', 30, 10, 2);
    expect(childRect(left, 0, MOVERS.shuttlePeriodTicks / 2).x).toBe(30 * C - MOVERS.shuttleTravelCells * C);
  });

  it('reverses repeatedly and smoothly: no jumps between ticks, back at the start every period', () => {
    const w = lab();
    const o = put(w, 'shuttle', 8, 10, 0);
    let maxStep = 0, reversals = 0, lastDir = 0;
    for (let t = 1; t <= MOVERS.shuttlePeriodTicks * 5; t++) {
      const d = childRect(o, 0, t).x - childRect(o, 0, t - 1).x;
      maxStep = Math.max(maxStep, Math.abs(d));
      const dir = Math.sign(d);
      if (dir && lastDir && dir !== lastDir) reversals++;
      if (dir) lastDir = dir;
    }
    expect(reversals).toBeGreaterThanOrEqual(9);
    expect(maxStep).toBeLessThan(2.5); // peak ~141 px/s
    expect(childRect(o, 0, MOVERS.shuttlePeriodTicks * 7).x).toBe(8 * C);
    expect(childRect(o, 0, MOVERS.shuttlePeriodTicks / 2).x).toBe(8 * C + MOVERS.shuttleTravelCells * C);
  });

  it('carries a standing rider exactly, lets them walk, sprint, jump off and land again without slipping or boosts', () => {
    const w = lab();
    const o = put(w, 'shuttle', 8, 13, 0);
    const sim = riderSim(w);
    stand(sim, 8 * C + 30, 13 * C - H);
    step(sim);
    const b = sim.players[0].body;
    expect(b.grounded).toBe(true);
    let drift = 0;
    const rel0 = b.x - sim.movers[0].rect.x;
    for (let i = 0; i < MOVERS.shuttlePeriodTicks * 3; i++) {
      step(sim);
      expect(b.groundMover).toBe(0);
      expect(b.y + H).toBeCloseTo(sim.movers[0].rect.y, 6);
      drift = Math.max(drift, Math.abs(b.x - sim.movers[0].rect.x - rel0));
    }
    expect(drift).toBeLessThan(0.01);
    // jump straight up at the turnaround and land back on the same platform; no inherited velocity
    while (Math.abs(sim.movers[0].rect.x - sim.movers[0].prev.x) > 0.05 || sim.tick % MOVERS.shuttlePeriodTicks > 10) step(sim);
    step(sim, IN_JUMP, 10);
    expect(b.grounded).toBe(false);
    expect(Math.abs(b.vx)).toBeLessThan(1);
    // air-steer back over the platform (closed loop on its real position) and land on it again
    let landed = false;
    for (let i = 0; i < 90 && !landed; i++) {
      const m = sim.movers[0].rect;
      const err = m.x + m.w / 2 - (b.x + W / 2);
      step(sim, IN_JUMP | (err > 4 ? IN_RIGHT : err < -4 ? IN_LEFT : 0));
      landed = b.grounded && b.groundMover === 0;
    }
    expect(landed).toBe(true);
    // walk and sprint along it; speed never exceeds the normal caps relative to the world (no repeated boosts)
    let maxVx = 0;
    for (let i = 0; i < 40; i++) { step(sim, IN_RIGHT | IN_SPRINT); maxVx = Math.max(maxVx, Math.abs(b.vx)); }
    expect(maxVx).toBeLessThanOrEqual(PHYS.sprintSpeed + 0.001);
    void o;
  });

  it('reserves nothing: blocks can go in its path and it slides through them, but items still cannot overlap its starting body', () => {
    const w = lab();
    put(w, 'shuttle', 8, 10, 0);
    expect(checkPlacement(w, { item: 'block_1x1', x: 12, y: 10, rot: 0, variant: 0 }).ok).toBe(true); // in the lane, away from its start
    expect(checkPlacement(w, { item: 'block_1x1', x: 12, y: 9, rot: 0, variant: 0 }).ok).toBe(true); // no rider headroom rule
    expect(checkPlacement(w, { item: 'block_1x1', x: 9, y: 10, rot: 0, variant: 0 }).reason).toMatch(/Overlaps another solid object/); // its start body is an ordinary object
    expect(checkPlacement(w, { item: 'wire_1', x: 8, y: 9, rot: 0, variant: 0 }).ok).toBe(false);
    expect(checkPlacement(w, { item: 'wire_1', x: 8, y: 9, rot: 0, variant: 0 }).reason).toMatch(/moving platforms|path/);
    expect(checkPlacement(w, { item: 'sniper', x: 8, y: 9, rot: 0, variant: 0 }).ok).toBe(false);
    expect(checkPlacement(w, { item: 'shuttle', x: 5, y: 12, rot: 0, variant: 0 }).reason).toMatch(/safety zone/); // its route may not enter the start zone
    expect(checkPlacement(w, { item: 'shuttle', x: 34, y: 14, rot: 0, variant: 0 }).reason).toMatch(/leaves the map|safety zone/); // nor the map edge
  });
});

describe('ferris wheel', () => {
  it('has exactly four 2x1 gondolas, 90 degrees apart at the configured radius, never touching each other', () => {
    const w = lab();
    const o = put(w, 'wheel', 10, 7, 0);
    const R = MOVERS.wheelRadiusCells * C;
    const pc = { x: 10 * C + C / 2, y: 7 * C + C / 2 };
    expect(referenceRects(o)).toHaveLength(4);
    for (let t = 0; t < MOVERS.wheelPeriodTicks; t += 7) {
      const rs = [0, 1, 2, 3].map(i => childRect(o, i, t));
      for (const r of rs) {
        expect(r.w).toBe(2 * C); expect(r.h).toBe(C);
        expect(Math.hypot(r.x + r.w / 2 - pc.x, r.y + r.h / 2 - pc.y)).toBeCloseTo(R, 2);
      }
      for (let i = 0; i < 4; i++) {
        const a = rs[i], b = rs[(i + 1) % 4];
        const ang = Math.atan2(b.y + b.h / 2 - pc.y, b.x + b.w / 2 - pc.x) - Math.atan2(a.y + a.h / 2 - pc.y, a.x + a.w / 2 - pc.x);
        expect(((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(Math.PI / 2, 2);
        for (let j = i + 1; j < 4; j++) {
          const c = rs[j];
          expect(a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y).toBe(false);
        }
      }
    }
    const up = put(w, 'wheel', 27, 8, 1);
    expect(childRect(up, 0, 0).w).toBe(C);
    expect(childRect(up, 0, 0).h).toBe(2 * C);
  });

  it('keeps the four phases locked together over a million ticks (positions come from ticks, not frame time)', () => {
    const w = lab();
    const o = put(w, 'wheel', 10, 7, 0);
    for (const t of [0, 1, 12345, 1_000_000, 1_000_000 + MOVERS.wheelPeriodTicks]) {
      for (let i = 0; i < 4; i++) {
        const d = wheelAngle(o, (i + 1) % 4, t) - wheelAngle(o, i, t);
        expect(((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(i === 3 ? (3 * Math.PI) / 2 * 0 + Math.PI / 2 : Math.PI / 2, 9);
      }
    }
    expect(childRect(o, 2, MOVERS.wheelPeriodTicks * 1000)).toEqual(childRect(o, 2, 0));
  });

  it('has a non-collidable pivot and centre: players pass through, items can use the open centre, the pivot is a handle', () => {
    const w = lab();
    put(w, 'wheel', 10, 7, 0);
    const env = staticEnv(w);
    expect(overlapsSolid(env, 10 * C + 10, 7 * C + 3)).toBe(false);
    expect(checkPlacement(w, { item: 'coin', x: 11, y: 7, rot: 0, variant: 0 }).ok).toBe(true); // inside the ring, off every path
    expect(checkPlacement(w, { item: 'coin', x: 10, y: 7, rot: 0, variant: 0 }).ok).toBe(false); // the pivot handle itself
    expect(checkPlacement(w, { item: 'block_1x1', x: 13, y: 7, rot: 0, variant: 0 }).ok).toBe(true); // a gondola's path is no longer reserved
    const sw = sweepOf(w.kinematic[0]);
    const lane = new Set(sw.sweep.map(c => c.join(',')));
    expect(lane.has('10,7')).toBe(false);
    expect(['11,7', '9,7', '10,6', '10,8'].some(k => lane.has(k))).toBe(false); // the cells beside the pivot stay open
    expect(lane.has('13,7')).toBe(true); // a gondola really passes here
    expect(checkPlacement(w, { item: 'coin', x: 6, y: 3, rot: 0, variant: 0 }).ok).toBe(true); // bounding-box corner, never swept
  });

  it('carries a rider around full laps without jitter, rotation of the body, flinging or snapping to the centre', () => {
    const w = lab();
    put(w, 'wheel', 10, 7, 0);
    const sim = riderSim(w);
    const top = sim.movers.findIndex(m => m.child === 3); // child 3 starts at 270 degrees: the top gondola
    const r0 = sim.movers[top].rect;
    stand(sim, r0.x + 30, r0.y - H);
    step(sim);
    const b = sim.players[0].body;
    const rel0 = b.x - sim.movers[top].rect.x;
    let drift = 0, off = 0;
    for (let i = 0; i < MOVERS.wheelPeriodTicks * 2; i++) {
      step(sim);
      if (!(b.grounded && b.groundMover === top)) off++;
      drift = Math.max(drift, Math.abs(b.x - sim.movers[top].rect.x - rel0), Math.abs(b.y + H - sim.movers[top].rect.y));
    }
    expect(off).toBe(0);
    expect(drift).toBeLessThan(0.01);
  });

  it('lets a second wheel overlap the first one’s orbit: nothing reserves a path', () => {
    const w = lab();
    put(w, 'wheel', 10, 7, 0);
    expect(checkPlacement(w, { item: 'wheel', x: 14, y: 7, rot: 0, variant: 0 }).ok).toBe(true);
    expect(checkPlacement(w, { item: 'wheel', x: 27, y: 8, rot: 0, variant: 1 }).ok).toBe(true);
  });
});

describe('projectiles and bombs against moving platforms', () => {
  it('rays hit the actual moving bodies and pass through the pivot and the open centre', () => {
    const w = lab();
    const o = put(w, 'wheel', 10, 7, 0);
    const sim = riderSim(w);
    const pc = { x: 10 * C + C / 2, y: 7 * C + C / 2 };
    expect(sim.rayHitT(pc.x - 60, pc.y - 60, pc.x + 60, pc.y + 60)).toBe(-1); // diagonal through the pivot at GO pose
    const g = childRect(o, 0, 0);
    expect(sim.rayHitT(g.x + g.w / 2, g.y - 100, g.x + g.w / 2, g.y + 100)).toBeGreaterThan(0);
  });

  it('a fast shot meeting a platform moving toward it does not tunnel (relative-motion sweep)', () => {
    const w = lab();
    put(w, 'shuttle', 8, 10, 0);
    const sim = riderSim(w);
    // advance to mid-stroke where the shuttle moves right at ~2.4 px/tick; a shot moving left starts just past its edge
    step(sim, 0, MOVERS.shuttlePeriodTicks / 4);
    const m = sim.movers[0];
    const x0 = m.prev.x + m.prev.w + 1; // was clear of the old pose, the platform caught up with it this tick
    expect(sim.rayHitT(x0, m.rect.y + 10, x0 - 0.5, m.rect.y + 10)).toBeGreaterThanOrEqual(0);
  });

  it('a bomb on the pivot or on a gondola at its GO pose removes the whole assembly; lane cells alone are not a hit', () => {
    const w = lab();
    const o = put(w, 'wheel', 10, 7, 0);
    expect(checkPlacement(w, { item: 'bomb_1', x: 10, y: 7, rot: 0, variant: 0 }).targets).toEqual([o.id]);
    const g = referenceRects(o)[0];
    const gx = Math.floor((g.x + g.w / 2) / C), gy = Math.floor((g.y + g.h / 2) / C);
    expect(checkPlacement(w, { item: 'bomb_1', x: gx, y: gy, rot: 0, variant: 0 }).targets).toEqual([o.id]);
    // a lane cell 45 degrees round the ring, where no gondola sits at GO
    expect(checkPlacement(w, { item: 'bomb_1', x: 12, y: 9, rot: 0, variant: 0 }).ok).toBe(false);
    applyBomb(w, [o.id]);
    expect(w.kinematic).toHaveLength(0);
    expect(new RaceSim(w, ['a'], { roundKey: 'x', maxTicks: 10 }).movers).toHaveLength(0);
  });

  it('placement accepts movers on an open course', () => {
    const w = lab();
    expect(checkPlacement(w, { item: 'shuttle', x: 8, y: 13, rot: 0, variant: 0 }).ok).toBe(true);
  });
});
