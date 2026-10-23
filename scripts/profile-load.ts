// Server cost of a busy six-player race: five bots plus one idle human slot on Under the Mountain with Ferris wheels,
// shuttles, black holes, crossbows and snipers. Reports per-tick simulation time and snapshot size.
// npx tsx scripts/profile-load.ts [mapId] [ticks]
import { SNAPSHOT_EVERY_TICKS } from '../shared/config';
import { baseNav, NavGraph } from '../shared/nav';
import { applyPlacement, checkPlacement, makeObject } from '../shared/placement';
import { RaceSim } from '../shared/race';
import { Rng } from '../shared/rng';
import { World } from '../shared/world';
import { BotRacer } from '../server/bots';

const mapId = process.argv[2] ?? 'mountain';
const ticks = Number(process.argv[3] ?? 3600);
const w = new World(mapId);
const rng = new Rng(3);
const want: [string, number][] = [['wheel', 3], ['shuttle', 4], ['moving', 2], ['blackhole', 3], ['crossbow', 4], ['sniper', 3], ['cannon', 2], ['crumble', 3]];
for (const [item, n] of want) {
  let placed = 0;
  for (let i = 0; i < 20000 && placed < n; i++) {
    const req = { item, x: rng.int(2, w.w - 3), y: rng.int(2, w.h - 3), rot: item === 'sniper' || item === 'blackhole' ? 0 : rng.int(0, 3), variant: rng.int(0, 1) };
    const c = checkPlacement(w, req);
    if (!c.ok) continue;
    applyPlacement(w, makeObject(w, req, c, `b${placed % 5}`, 1));
    placed++;
  }
}
const nav = NavGraph.fromBase(baseNav(mapId), w);
const ids = ['h', 'b1', 'b2', 'b3', 'b4', 'b5'];
const sim = new RaceSim(w, ids, { roundKey: 'p', maxTicks: ticks + 10 });
const bots = ids.slice(1).map((id, i) => new BotRacer(id, i % 2 ? 'hard' : 'medium', 100 + i));
const times: number[] = [];
let bytes = 0, snaps = 0, maxProj = 0;
for (let t = 0; t < ticks && !sim.over; t++) {
  const t0 = performance.now();
  const inputs = new Map<string, number>([['h', 0]]);
  for (const b of bots) inputs.set(b.id, b.think(sim, nav));
  sim.step(inputs);
  sim.drainEvents();
  if (sim.tick % SNAPSHOT_EVERY_TICKS === 0) { bytes += JSON.stringify({ t: 'snap', s: sim.snapshot(), ev: [] }).length; snaps++; }
  times.push(performance.now() - t0);
  maxProj = Math.max(maxProj, sim.projectiles.length);
}
times.sort((a, b) => a - b);
const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(3);
console.log(JSON.stringify({ mapId, objects: w.objects.size, movers: sim.movers.length, ticks: times.length, tickMsP50: +p(0.5), tickMsP95: +p(0.95), tickMsP99: +p(0.99), tickMsMax: +p(1), snapshotBytesAvg: Math.round(bytes / snaps), snapshotKBps: +((bytes / snaps) * (60 / SNAPSHOT_EVERY_TICKS) / 1024).toFixed(1), maxProjectiles: maxProj }));
