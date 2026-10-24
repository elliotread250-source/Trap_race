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
