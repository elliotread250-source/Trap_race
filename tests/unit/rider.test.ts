// Ferris-wheel rider regression: the authoritative server sim and the client's predictor (client/src/predict.ts) run
// against each other over a simulated link with latency and jitter, at several render rates, through whole orbits.
import { describe, expect, it } from 'vitest';
import { MOVERS, NET, PHYS, SNAPSHOT_EVERY_TICKS } from '../../shared/config';
import { IN_JUMP } from '../../shared/physics';
import { RaceSim, type RaceSnapshot } from '../../shared/race';
import { Rng } from '../../shared/rng';
import { World } from '../../shared/world';
import { Predictor } from '../../client/src/predict';
import { lab, put } from './helpers';

interface LinkOpts { lagMs: number; jitterMs: number; fps: number; script: (seq: number) => number; staleEvery?: number; orbits?: number }

function ride(o: LinkOpts) {
  const w = lab();
  put(w, 'wheel', 13, 9);
  const server = new RaceSim(w, ['a'], { roundKey: 'r', maxTicks: 1e7 });
  const top = server.movers.findIndex(m => m.child === 3); // starts at the top of the wheel
  const r0 = server.movers[top].rect;
  const sb = server.players[0].body; sb.x = r0.x + 30; sb.y = r0.y - PHYS.bodyH;
  server.step(new Map([['a', 0]]));
  const mirror = new RaceSim(World.fromJSON(JSON.parse(JSON.stringify(w.toJSON()))), ['a'], { roundKey: 'r', maxTicks: 1e7 });
  const pr = new Predictor(mirror, 'a');
  const rng = new Rng(7);
  const q: { at: number; fn: () => void }[] = [];
  let now = 0, lastDown = 0, lastUp = 0;
  // a WebSocket is ordered: jitter bunches messages but never reorders them
  const down = (fn: () => void) => { lastDown = Math.max(lastDown, now + o.lagMs + rng.range(-o.jitterMs, o.jitterMs)); q.push({ at: lastDown, fn }); };
  const up = (fn: () => void) => { lastUp = Math.max(lastUp, now + o.lagMs + rng.range(-o.jitterMs, o.jitterMs)); q.push({ at: lastUp, fn }); };
  const st = { queue: [] as number[], last: 0, lastSeq: 0 }; // the server's input queue, as in Match
  let oldSnap: RaceSnapshot | null = null, snaps = 0;
  const onSnap = (s: RaceSnapshot) => {
    if (!pr.accept(s)) return;
    mirror.applySnapshot(s);
    if (!pr.pred) pr.pred = { ...server.players[0].body };
    pr.reconcile(s, s.players[0]);
  };
  const STEP = 1000 / 60;
  let sAcc = 0, cAcc = 0, fAcc = 0;
  let ridingFrames = 0, maxGap = 0, maxJump = 0, corrSum = 0, corrN = 0;
  let lastDrawn: { x: number; y: number } | null = null;
  const end = (MOVERS.wheelPeriodTicks * (o.orbits ?? 2) / 60) * 1000;
  for (now = 0; now < end; now += 0.5) {
    q.sort((a, b) => a.at - b.at);
    while (q.length && q[0].at <= now) q.shift()!.fn();
    sAcc += 0.5;
    while (sAcc >= STEP) {
      sAcc -= STEP;
      if (st.queue.length) st.last = st.queue.shift()!;
      server.step(new Map([['a', st.last]]));
      if (server.tick % SNAPSHOT_EVERY_TICKS === 0) {
        const snap = JSON.parse(JSON.stringify(server.snapshot(new Map([['a', st.lastSeq - st.queue.length]])))) as RaceSnapshot;
        down(() => onSnap(snap));
        snaps++;
        // a duplicated old snapshot arriving late must never rewind the prediction
        if (o.staleEvery && oldSnap && snaps % o.staleEvery === 0) { const stale = oldSnap; down(() => onSnap(stale)); }
        oldSnap = snap;
      }
    }
    fAcc += 0.5;
    if (fAcc >= 1000 / o.fps) {
      cAcc += fAcc; fAcc = 0;
      while (cAcc >= STEP && pr.pred) {
        cAcc -= STEP;
        pr.step(o.script(pr.seq + 1));
      }
      pr.decay(1000 / o.fps);
      const batch = pr.takeBatch(true);
      if (batch) up(() => { batch.b.forEach((b, i) => { const s = batch.s + i; if (s <= st.lastSeq) return; st.queue.push(b); st.lastSeq = s; }); while (st.queue.length > NET.inputQueueMax) st.queue.shift(); });
      // what the player sees: the drawn body against the gondola drawn at the render tick (the latest predicted tick)
      const d = pr.drawn();
      if (d && pr.pred) {
        const m = pr.predMovers(pr.tickForSeq(pr.seq))[top];
        if (pr.pred.grounded && pr.pred.groundMover === top) { ridingFrames++; maxGap = Math.max(maxGap, Math.abs(d.y + PHYS.bodyH - m.y)); }
        if (lastDrawn) maxJump = Math.max(maxJump, Math.hypot(d.x - lastDrawn.x - (m.x - pr.predMovers(pr.tickForSeq(pr.seq) - 1)[top].x), d.y - lastDrawn.y));
        lastDrawn = d;
      }
      corrSum += pr.stats.lastCorr; corrN++;
    }
  }
  return { server, pr, ridingFrames, maxGap, maxJump, avgCorr: corrSum / Math.max(1, corrN) };
}

describe('riding the ferris wheel over a real link', () => {
  for (const [lagMs, jitterMs, fps] of [[0, 0, 60], [40, 10, 60], [80, 25, 144], [80, 25, 30], [150, 40, 60]]) {
    it(`stays glued to the gondola for whole orbits at ${lagMs}±${jitterMs} ms, ${fps} fps`, () => {
      const r = ride({ lagMs, jitterMs, fps, script: () => 0 });
      expect(r.server.players[0].status).toBe('racing');
      expect(r.server.players[0].body.grounded).toBe(true);
      expect(r.ridingFrames).toBeGreaterThan(0.95 * (MOVERS.wheelPeriodTicks * 2) * (Math.min(fps, 60) / 60));
      expect(r.maxGap).toBeLessThan(0.01); // drawn feet exactly on the drawn gondola: no floating, sinking or shaking
      expect(r.maxJump).toBeLessThan(12); // no teleport relative to the platform between frames
    });
  }

  it('jumping straight up repeatedly lands back on the same gondola without snapping or flinging', () => {
    const r = ride({ lagMs: 80, jitterMs: 25, fps: 60, script: seq => ((seq % 100) < 12 ? IN_JUMP : 0) });
    const b = r.server.players[0].body;
    expect(r.server.players[0].status).toBe('racing');
    expect(Math.abs(b.vx)).toBeLessThan(1); // no inherited or accumulated platform speed
    expect(r.avgCorr).toBeLessThan(1.5);
    expect(r.maxGap).toBeLessThan(0.01);
  });

  it('ignores a late, older snapshot instead of rewinding the rider (the out-of-order case that used to throw them off)', () => {
    const r = ride({ lagMs: 80, jitterMs: 25, fps: 60, script: () => 0, staleEvery: 7 });
    expect(r.pr.stats.stale).toBeGreaterThan(10);
    expect(r.maxGap).toBeLessThan(0.01);
    expect(r.maxJump).toBeLessThan(12);
  });
});
