// Bots racing an unmodified (or given) course with seeded variety. npx tsx scripts/bot-race.ts [difficulty] [seeds]
import { World } from '../shared/world';
import { NavGraph } from '../shared/nav';
import { RaceSim } from '../shared/race';
import { BotRacer } from '../server/bots';
import { MAP_LIST } from '../shared/maps';
import type { Difficulty } from '../shared/config';

const diff = (process.argv[2] ?? 'medium') as Difficulty;
const seeds = Number(process.argv[3] ?? 4);
const only = process.argv[4];
for (const m of MAP_LIST) {
  if (only && m.id !== only) continue;
  let fin = 0, total = 0, stuck = 0; const times: number[] = []; const causes: Record<string, number> = {};
  for (let s = 0; s < seeds; s++) {
    const w = new World(m.id);
    const nav = new NavGraph(w);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const sim = new RaceSim(w, ids, { roundKey: 'k' + s, maxTicks: 90 * 60 });
    const bots = ids.map((id, i) => new BotRacer(id, diff, 1000 * s + i));
    while (!sim.over) {
      const inp = new Map<string, number>();
      for (const b of bots) inp.set(b.id, b.think(sim, nav));
      sim.step(inp);
    }
    for (const p of sim.players) { total++; if (p.status === 'finished') { fin++; times.push(p.finishTick / 60); } else causes[p.status + ':' + p.cause] = (causes[p.status + ':' + p.cause] ?? 0) + 1; }
    for (const b of bots) stuck += b.stuckCount;
  }
  times.sort((a, b) => a - b);
  console.log(`${m.id} [${diff}] finished ${fin}/${total} (${Math.round(100 * fin / total)}%) median ${times[Math.floor(times.length / 2)]?.toFixed(1)}s range ${times[0]?.toFixed(1)}-${times[times.length - 1]?.toFixed(1)}s stuck=${stuck} fails=${JSON.stringify(causes)}`);
}
