// Route check and bot completion on the batch-update maps (Tropical Island, Magma Works, Orbital Lab, Sandstorm Dunes).
// npx tsx scripts/bot-race-new-maps.ts [seeds] [maps...]
import { World } from '../shared/world';
import { NavGraph } from '../shared/nav';
import { RaceSim } from '../shared/race';
import { BotRacer } from '../server/bots';
import type { Difficulty } from '../shared/config';

const seeds = Number(process.argv[2] ?? 2);
const maps = process.argv.length > 3 ? process.argv.slice(3) : ['tropical', 'magma', 'orbital', 'dunes'];
for (const mapId of maps) {
  const w = new World(mapId);
  const nav = new NavGraph(w);
  const t0 = Date.now();
  const r = nav.reach(false);
  console.log(`${mapId}: route to flag ${r.finish ? 'FOUND' : 'MISSING'} (${r.visited.size} spots, ${Date.now() - t0} ms)`);
  for (const diff of ['easy', 'medium', 'hard'] as Difficulty[]) {
    let fin = 0, total = 0; const times: number[] = []; const fails: Record<string, number> = {};
    for (let s = 0; s < seeds; s++) {
      const ids = ['a', 'b', 'c', 'd'];
      const sim = new RaceSim(w.clone(), ids, { roundKey: 'k' + s, maxTicks: 120 * 60 });
      const bots = ids.map((id, i) => new BotRacer(id, diff, 100 * s + i));
      while (!sim.over) { const m = new Map<string, number>(); for (const b of bots) m.set(b.id, b.think(sim, nav)); sim.step(m); }
      for (const p of sim.players) { total++; if (p.status === 'finished') { fin++; times.push(p.finishTick / 60); } else fails[p.status + ':' + p.cause] = (fails[p.status + ':' + p.cause] ?? 0) + 1; }
    }
    times.sort((a, b) => a - b);
    console.log(`  [${diff}] finished ${fin}/${total}, median ${times[Math.floor(times.length / 2)]?.toFixed(1)}s ${JSON.stringify(fails)}`);
  }
}
