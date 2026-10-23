// Server cost of a six-player race on a large map with several shuttles and ferris wheels, plus the placement checks
// that built it. npx tsx scripts/profile-movers.ts [mapId] [shuttles] [wheels]
import { World } from '../shared/world';
import { baseNav, NavGraph } from '../shared/nav';
import { RaceSim } from '../shared/race';
import { BotRacer } from '../server/bots';
import { applyPlacement, assessPlacement as validatePlacement, checkPlacement, makeObject } from '../shared/placement';
import { Rng } from '../shared/rng';

const mapId = process.argv[2] ?? 'mountain';
const nShuttle = Number(process.argv[3] ?? 6), nWheel = Number(process.argv[4] ?? 4);
const w = new World(mapId);
let nav = NavGraph.fromBase(baseNav(mapId), w);
const rng = new Rng(11);
const times: number[] = [];
if (mapId === 'oak') { const r = { item: 'plank_5', x: 38, y: 20, rot: 1, variant: 0 }; const v = validatePlacement(w, r, nav); applyPlacement(w, makeObject(w, r, v.check, 'p', 1)); nav = v.nav!; }
for (const [item, n] of [['shuttle', nShuttle], ['wheel', nWheel]] as const) {
  let placed = 0;
  for (let i = 0; i < 4000 && placed < n; i++) {
    const req = { item, x: rng.int(2, w.w - 3), y: rng.int(3, w.h - 4), rot: rng.int(0, 3), variant: rng.int(0, 1) };
    if (!checkPlacement(w, req).ok) continue;
    const t0 = performance.now();
    const { check, nav: g } = validatePlacement(w, req, nav);
    times.push(performance.now() - t0);
    if (!check.ok) continue;
    applyPlacement(w, makeObject(w, req, check, 'p', 1)); nav = g!; placed++;
  }
}
times.sort((a, b) => a - b);
console.log(`${mapId}: ${w.kinematic.length} moving items (${w.kinematic.filter(o => o.item === 'shuttle').length} shuttles, ${w.kinematic.filter(o => o.item === 'wheel').length} wheels); validations ${times.length}, median ${times[Math.floor(times.length / 2)].toFixed(0)} ms, p90 ${times[Math.floor(times.length * 0.9)].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`);
console.log(`route still open: ${nav.reach(false).finish}`);
const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const sim = new RaceSim(w, ids, { roundKey: 'prof', maxTicks: 120 * 60 });
const bots = ids.map((id, i) => new BotRacer(id, i % 2 ? 'medium' : 'hard', 500 + i));
const simMs: number[] = [], botMs: number[] = [];
let snapBytes = 0, snaps = 0;
while (!sim.over) {
  const t0 = performance.now();
  const m = new Map<string, number>();
  for (const b of bots) m.set(b.id, b.think(sim, nav));
  const t1 = performance.now();
  sim.step(m);
  const t2 = performance.now();
  botMs.push(t1 - t0); simMs.push(t2 - t1);
  if (sim.tick % 3 === 0) { snapBytes += JSON.stringify({ t: 'snap', s: sim.snapshot(), ev: [] }).length; snaps++; }
}
const stat = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return `mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)} ms, p99 ${s[Math.floor(s.length * 0.99)].toFixed(3)} ms, max ${s[s.length - 1].toFixed(1)} ms`; };
console.log(`race ${sim.tick} ticks, ${sim.movers.length} moving bodies, finished ${sim.players.filter(p => p.status === 'finished').length}/6`);
console.log(`  sim step: ${stat(simMs)}`);
console.log(`  six bots thinking: ${stat(botMs)}`);
console.log(`  snapshot ${(snapBytes / snaps / 1024).toFixed(2)} KB average at 20 Hz (moving platforms add nothing: poses come from the tick)`);
