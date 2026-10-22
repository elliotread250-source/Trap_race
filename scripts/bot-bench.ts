// Headless benchmark: seeded matches of bots only (plus one idle spectator-like human slot is not used).
// Reports finish rates, stuck incidents and validation cost per map. npx tsx scripts/bot-bench.ts [rounds] [difficulty]
import { Room } from '../server/room';
import { MAP_LIST } from '../shared/maps';
import type { Difficulty } from '../shared/config';

const rounds = Number(process.argv[2] ?? 3);
const diff = (process.argv[3] ?? 'medium') as Difficulty;
const maps = process.argv[4] ? [process.argv[4]] : MAP_LIST.map(m => m.id);
for (const mapId of maps) {
  const t0 = Date.now();
  const room = new Room('BENCH', 'online', () => {}, 12345);
  const host = room.addHuman('Host', 0);
  if ('error' in host) throw new Error(host.error);
  for (let i = 0; i < 4; i++) room.addBot(diff);
  room.mapId = mapId; room.rounds = rounds;
  // the human slot is a bot too for benchmarking: swap it out
  room.members = room.members.filter(m => m.bot);
  room.members.push({ ...host, connected: true });
  room.startMatch();
  // remove the idle human from the roster's effect: mark disconnected so they are eliminated after the grace window
  const match = room.match!;
  const human = host.id;
  let finishes = 0, races = 0, botRaces = 0, stuck = 0, raceTicks = 0;
  const perRound: string[] = [];
  let guard = 0;
  while (room.phase !== 'matchEnd' && guard++ < 60 * 60 * 30) {
    // the human never claims or places; the match's timeouts handle them
    room.tick();
    if (match.phase === 'race' && match.race) raceTicks++;
    if (match.phase === 'results' && match.results.length > races) {
      races = match.results.length;
      const rows = match.results[races - 1].filter(r => r.pid !== human);
      const f = rows.filter(r => r.time !== null).length;
      finishes += f; botRaces += rows.length;
      for (const b of match.bots.values()) stuck += b.stuckCount;
      perRound.push(`${f}/${rows.length}` + (rows.filter(r=>r.time!==null).length? '(' + rows.filter(r=>r.time!==null).map(r=>r.time!.toFixed(1)).join(',') + 's)' : '') + ` objs=${match.world.playerObjectCount()}`);
    }
  }
  void human;
  console.log(`${mapId} [${diff}] rounds=${races} botFinish=${finishes}/${botRaces} (${(100 * finishes / Math.max(1, botRaces)).toFixed(0)}%) stuckEvents=${stuck} validations=${match.stats.validations} avgMs=${(match.stats.validationMs / Math.max(1, match.stats.validations)).toFixed(0)} maxMs=${match.stats.maxValidationMs} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('   ' + perRound.join(' | '));
}
