// Adversarial map audit: npx tsx scripts/map-audit.ts [mapId] [rounds] [stride]
// Measures each map, then searches for shortcuts the way a player would: one placed construction piece at a time,
// greedily keeping whichever piece shortens the best route the most (several "rounds" of accumulated blocks).
// It uses the same nav probes as the placement validator (sprint jumps, air steering, wall slides, unlimited same-wall
// climbs), so a "skip" here is a route the real physics can follow.
import { CELL } from '../shared/config';
import { MAP_LIST, getMap } from '../shared/maps';
import { NavGraph, type NavEdge } from '../shared/nav';
import { checkPlacement, makeObject, regionForCells } from '../shared/placement';
import { World } from '../shared/world';

const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2] : null;
const rounds = Number(process.argv[3] ?? 3);
const stride = Number(process.argv[4] ?? 1);
const PIECES: [string, number][] = [['plank_3', 0], ['plank_3', 1], ['plank_5', 0], ['plank_5', 1], ['plank_7', 0], ['plank_7', 1], ['block_2x2', 0], ['stairs', 0], ['stairs', 1]];

function routeSeconds(g: NavGraph): { s: number; route: NavEdge[] | null } {
  const starts = g.spawnNodes();
  let best: NavEdge[] | null = null, bestF = Infinity;
  for (const s of starts.slice(0, 2)) {
    const r = g.route(s);
    if (!r) continue;
    const f = r.reduce((a, e) => a + e.frames, 0);
    if (f < bestF) { bestF = f; best = r; }
  }
  return { s: bestF / 60, route: best };
}

/** Furthest progress stage the route visits, as the share of the spawn-to-flag x span it covers before finishing. */
function routeXSpan(route: NavEdge[] | null, w: World): number {
  if (!route) return 0;
  let minX = Infinity, maxX = -Infinity;
  for (const e of route) for (let i = 0; i < e.path.length; i += 2) { minX = Math.min(minX, e.path[i]); maxX = Math.max(maxX, e.path[i]); }
  return (maxX - minX) / (w.w * CELL);
}

for (const m of MAP_LIST) {
  if (only && m.id !== only) continue;
  const t0 = Date.now();
  let world = new World(m.id);
  let nav = new NavGraph(world);
  const base = routeSeconds(nav);
  const sx = m.spawn.x + m.spawn.w / 2, fx = m.finish.x + m.finish.w / 2, sy = m.spawn.y + m.spawn.h, fy = m.finish.y + m.finish.h;
  console.log(`\n== ${m.id} (${m.name}) ${m.w}x${m.h} cells = ${m.w * CELL}x${m.h * CELL}px, build ${m.build.w}x${m.build.h}`);
  console.log(`   spawn (${m.spawn.x},${m.spawn.y}) finish (${m.finish.x},${m.finish.y}); flag is ${Math.abs(fx - sx).toFixed(0)} cells across and ${(sy - fy).toFixed(0)} cells up from spawn`);
  console.log(`   empty course: best route ${base.s.toFixed(1)}s, ${base.route?.length ?? 0} edges, covers ${(routeXSpan(base.route, world) * 100).toFixed(0)}% of the map width`);
  const xs: number[] = [];
  for (let x = Math.max(1, m.spawn.x - 2); x <= Math.min(m.w - 2, m.spawn.x + 16); x += stride) xs.push(x);
  for (let x = Math.max(1, m.finish.x - 10); x <= Math.min(m.w - 2, m.finish.x + 10); x += stride) if (!xs.includes(x)) xs.push(x);
  let cur = base.s;
  for (let r = 1; r <= rounds; r++) {
    let best: { s: number; desc: string; w: World; g: NavGraph } | null = null;
    let tried = 0;
    for (const [item, rot] of PIECES) for (const x of xs) for (let y = 1; y < m.h - 1; y += stride) {
      const req = { item, x, y, rot, variant: 0 };
      const chk = checkPlacement(world, req);
      if (!chk.ok) continue;
      tried++;
      const test = world.clone();
      test.objects.set('_t', { ...makeObject(test, req, chk, 'audit', r), id: '_t' });
      test.rebuild();
      const g = NavGraph.derive(nav, test, regionForCells(chk.cells, CELL));
      const res = routeSeconds(g);
      if (res.route && res.s < (best?.s ?? cur - 0.05)) best = { s: res.s, desc: `${item} rot${rot} @${x},${y}`, w: test, g };
    }
    if (!best) { console.log(`   round ${r}: no single piece shortens the route (${tried} legal placements tried)`); break; }
    const pct = (100 * best.s) / base.s;
    console.log(`   round ${r}: ${best.desc} -> ${best.s.toFixed(1)}s (${pct.toFixed(0)}% of the empty-course time) [${tried} tried]${pct < 45 ? '  << SKIP' : ''}`);
    // keep the piece under a stable id for the next round
    const o = best.w.objects.get('_t')!;
    best.w.objects.delete('_t');
    o.id = best.w.allocId();
    best.w.objects.set(o.id, o);
    best.w.rebuild();
    world = best.w; nav = best.g; cur = best.s;
  }
  console.log(`   audit time ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
void getMap;
