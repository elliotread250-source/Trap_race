// Bot completion times on the large maps (and the rebuilt Rooftop), used to set their race timers.
// The Great Oak needs building before anyone can finish, so it is raced after one upright Plank 5 on the branch tip.
// npx tsx scripts/bot-race-large.ts [seeds]
import { World } from '../shared/world';
import { baseNav, NavGraph } from '../shared/nav';
import { RaceSim } from '../shared/race';
import { BotRacer } from '../server/bots';
import { applyPlacement, checkPlacement, makeObject } from '../shared/placement';
import type { Difficulty } from '../shared/config';

const seeds = Number(process.argv[2] ?? 3);
const setups: [string, string, [string, number, number, number][]][] = [
  ['mountain', 'Under the Mountain (empty)', []],
  ['oak', 'The Great Oak (one Plank 5 on the branch)', [['plank_5', 38, 20, 1]]],
  ['rooftop', 'Rooftop Run (empty)', []],
];
for (const [mapId, label, items] of setups) {
  for (const diff of ['easy', 'medium', 'hard'] as Difficulty[]) {
    let fin = 0, total = 0; const times: number[] = []; const fails: Record<string, number> = {};
    for (let s = 0; s < seeds; s++) {
      const w = new World(mapId);
      for (const [item, x, y, rot] of items) { const req = { item, x, y, rot, variant: 0 }; applyPlacement(w, makeObject(w, req, checkPlacement(w, req), 'p', 1)); }
      const nav = items.length ? new NavGraph(w) : NavGraph.fromBase(baseNav(mapId), w);
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      const sim = new RaceSim(w, ids, { roundKey: 'k' + s, maxTicks: 150 * 60 });
      const bots = ids.map((id, i) => new BotRacer(id, diff, 100 * s + i));
      while (!sim.over) { const m = new Map<string, number>(); for (const b of bots) m.set(b.id, b.think(sim, nav)); sim.step(m); }
      for (const p of sim.players) { total++; if (p.status === 'finished') { fin++; times.push(p.finishTick / 60); } else fails[p.status + ':' + p.cause] = (fails[p.status + ':' + p.cause] ?? 0) + 1; }
    }
    times.sort((a, b) => a - b);
    console.log(`${label} [${diff}] finished ${fin}/${total}, median ${times[Math.floor(times.length / 2)]?.toFixed(1)}s, slowest ${times[times.length - 1]?.toFixed(1)}s ${JSON.stringify(fails)}`);
  }
}
