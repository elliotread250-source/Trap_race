// Print a map as ASCII with its navigation reach, for designing and reviewing levels: npx tsx scripts/map-ascii.ts rooftop
import { World } from '../shared/world';
import { NavGraph, FINISH } from '../shared/nav';
import { getItem } from '../shared/items';

const id = process.argv[2] ?? 'rooftop';
const w = new World(id);
const g = new NavGraph(w);
const r = g.reach(true);
const route = g.route(g.spawnNodes()[0]);
const onRoute = new Set(route?.map(e => e.from) ?? []);
const rows: string[] = [];
for (let y = 0; y < w.h; y++) {
  let s = '';
  for (let x = 0; x < w.w; x++) {
    const t = w.terrainAt(x, y);
    const occ = w.occAt(x, y);
    let ch = '.';
    if (t === 1) ch = '#'; else if (t === 2) ch = '~'; else if (t === 3) ch = '-';
    else if (occ && occ !== 'terrain') { const o = w.objects.get(occ)!; ch = getItem(o.item).kind === 'wire' ? 'w' : 'o'; }
    const key = y * w.w + x;
    if (ch === '.' && onRoute.has(key)) ch = '*';
    else if (ch === '.' && r.visited.has(key)) ch = ':';
    const m = w.map;
    if (ch === '.' && x >= m.spawn.x && x < m.spawn.x + m.spawn.w && y >= m.spawn.y && y < m.spawn.y + m.spawn.h) ch = 'S';
    if (ch === '.' && x >= m.finish.x && x < m.finish.x + m.finish.w && y >= m.finish.y && y < m.finish.y + m.finish.h) ch = 'F';
    s += ch;
  }
  rows.push(String(y).padStart(2) + ' ' + s);
}
console.log('   ' + Array.from({ length: w.w }, (_, i) => (i % 10 === 0 ? String(i / 10 % 10) : ' ')).join(''));
console.log(rows.join('\n'));
const frames = route?.reduce((a, e) => a + e.frames, 0) ?? 0;
console.log(`${id}: finish reachable=${r.finish} nodes=${r.visited.size} route=${route ? route.length + ' edges, ' + (frames / 60).toFixed(1) + 's from rest' : 'NONE'} kinds=${route?.map(e => e.kind[0]).join('')}`);
void FINISH;
