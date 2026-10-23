// Two independent browsers on Under the Mountain with the new moving platforms: placement, agreement on motion,
// reconnection and demolition. npm run build && node tests/e2e/movers.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const EXEC = process.env.CHROME ?? (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : '/opt/pw-browsers/chromium');
const port = 18700 + Math.floor(Math.random() * 90);
const server = spawn('node', ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(port), RACE_MS: '14000', RESULTS_MS: '2500', BUILD_MS: '25000', TEST_POOL: 'shuttle,wheel|bomb_3,coin' }, stdio: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const errors = [];
async function newPlayer(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  return { ctx, page, name };
}
const phaseOf = p => p.page.evaluate(() => window.__trap.game.phase);
const waitPhase = async (p, phase, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await phaseOf(p) === phase) return; await p.page.waitForTimeout(120); } throw new Error(`${p.name} never reached ${phase}`); };
const movingObjs = p => p.page.evaluate(() => JSON.stringify([...window.__trap.game.world.objects.values()].filter(o => o.item === 'shuttle' || o.item === 'wheel').sort((a, b) => a.id < b.id ? -1 : 1)));
async function placeAt(p, x, y, rot = 0) {
  return p.page.evaluate(async ([x, y, rot]) => {
    const g = window.__trap.game;
    g.rot = rot; g.setCursor(x, y);
    if (!g.check?.ok) return `preview says: ${g.check?.reason}`;
    g.confirmPlace();
    for (let i = 0; i < 60 && !g.placedThisRound; i++) await new Promise(r => setTimeout(r, 100));
    return g.placedThisRound ? 'ok' : 'server did not confirm';
  }, [x, y, rot]);
}
async function placeFirstValid(p) {
  return p.page.evaluate(async () => {
    const g = window.__trap.game;
    for (let y = 20; y < 30; y++) for (let x = 3; x < 30; x++) { g.setCursor(x, y); if (g.check?.ok) { g.confirmPlace(); for (let i = 0; i < 60 && !g.placedThisRound; i++) await new Promise(r => setTimeout(r, 100)); return g.placedThisRound; } }
    return false;
  });
}
/** Mover rects each client derives for the ticks of its buffered snapshots. */
const moverPoses = p => p.page.evaluate(() => {
  const g = window.__trap.game; const out = {};
  for (const sn of g.snaps) out[sn.s.tick] = g.race.movers.map(m => { const r = g.moverRectAt(m, sn.s.tick); return [m.id, r.x, r.y]; });
  return out;
});

try {
  const host = await newPlayer('host'), guest = await newPlayer('guest');
  await host.page.goto(base);
  await host.page.fill('input[aria-label="Your name"]', 'HostMv');
  await host.page.click('text=Create Room');
  await host.page.waitForSelector('.code-box .code');
  const code = (await host.page.textContent('.code-box .code')).trim();
  await host.page.click('.map-tile:has-text("Under the Mountain")');
  await guest.page.goto(`${base}/?room=${code}`);
  await guest.page.fill('input[aria-label="Your name"]', 'GuestMv');
  await guest.page.click('button:has-text("Join")');
  await guest.page.waitForSelector('.player-row >> nth=1', { timeout: 10000 });
  await guest.page.click('text=Ready up');
  await host.page.waitForTimeout(400);
  await host.page.click('text=Start match');
  await Promise.all([waitPhase(host, 'draft'), waitPhase(guest, 'draft')]);
  const mapId = await guest.page.evaluate(() => window.__trap.game.world.map.id);
  check('host picked Under the Mountain and the guest sees it', mapId === 'mountain', mapId);
  const cardsText = await host.page.textContent('.cards');
  check('both new item cards appear in the draft', cardsText.includes('Shuttle Block 2×1') && cardsText.includes('Ferris Wheel'), cardsText.slice(0, 120));
  await host.page.click('.icard:has-text("Shuttle Block")');
  await guest.page.waitForTimeout(300);
  await guest.page.click('.icard:has-text("Ferris Wheel")');
  await Promise.all([waitPhase(host, 'build'), waitPhase(guest, 'build')]);
  const blocked = await host.page.evaluate(() => { const g = window.__trap.game; g.setCursor(40, 29); return g.check?.reason ?? 'ok'; });
  check('a shuttle lane into rock is rejected in the preview', /terrain/.test(blocked), blocked);
  const ph = await placeAt(host, 46, 29, 0), pg = await placeAt(guest, 76, 18, 0);
  check('host placed a shuttle and guest a ferris wheel through the server', ph === 'ok' && pg === 'ok', `${ph} / ${pg}`);
  await host.page.waitForTimeout(500);
  const [oh, og] = await Promise.all([movingObjs(host), movingObjs(guest)]);
  check('both clients hold identical moving-platform definitions (anchor, rotation, motion)', oh === og && JSON.parse(oh).length === 2 && JSON.parse(oh).every(o => o.mv), oh.slice(0, 160));
  const laneClash = await host.page.evaluate(() => { const g = window.__trap.game; return g.world.reservedAt(48, 29) !== '' && g.world.reservedAt(79, 18) !== ''; });
  check('swept lanes are reserved on the client too', laneClash);
  await Promise.all([waitPhase(host, 'race', 40000), waitPhase(guest, 'race', 40000)]);
  await host.page.waitForTimeout(2500);
  const [ah, ag] = await Promise.all([moverPoses(host), moverPoses(guest)]);
  const common = Object.keys(ah).filter(t => ag[t]);
  const agree = common.length > 0 && common.every(t => JSON.stringify(ah[t]) === JSON.stringify(ag[t]));
  const ticks = common.map(Number).sort((a, b) => a - b);
  const moved = ticks.length > 1 && JSON.stringify(ah[ticks[0]]) !== JSON.stringify(ah[ticks[ticks.length - 1]]);
  check('both clients agree on every platform pose at shared server ticks, and the platforms move', agree && moved, `${common.length} shared ticks, 5 bodies (1 shuttle + 4 gondolas): ${ah[ticks[0]]?.length}`);
  // reconnect mid-race: same identity, same course, no extra items, no new life
  const before = await guest.page.evaluate(() => { const g = window.__trap.game; return { you: g.you, objs: g.world.objects.size, status: g.race.player(g.you).status }; });
  await guest.page.reload();
  await guest.page.waitForTimeout(3000);
  const after = await guest.page.evaluate(() => { const g = window.__trap.game; return { you: g.you, objs: g.world?.objects.size, status: g.race?.player(g.you)?.status, movers: g.race?.movers.length, phase: g.phase }; });
  check('reload mid-race restores identity, the same course and motion, without duplicating items', after.you === before.you && after.objs === before.objs && after.movers === 5 && (after.phase === 'race' || after.phase === 'results'), JSON.stringify({ before, after }));
  if (after.phase === 'race') {
    await guest.page.waitForTimeout(1200);
    const [h3, g3] = await Promise.all([moverPoses(host), moverPoses(guest)]);
    const c3 = Object.keys(h3).filter(t => g3[t]);
    check('the reconnected client sees the same platform phase as everyone else', c3.length > 0 && c3.every(t => JSON.stringify(h3[t]) === JSON.stringify(g3[t])), `${c3.length} shared ticks`);
  }
  await Promise.all([waitPhase(host, 'draft', 60000), waitPhase(guest, 'draft', 60000)]);
  // round 2: the host bombs the wheel by its pivot; the guest drops a coin
  await host.page.click('.icard:has-text("Bomb")');
  await guest.page.waitForTimeout(300);
  await guest.page.click('.icard:has-text("Coin")');
  await Promise.all([waitPhase(host, 'build'), waitPhase(guest, 'build')]);
  const preview = await host.page.evaluate(() => { const g = window.__trap.game; g.setCursor(75, 17); return { ok: g.check?.ok, targets: g.check?.targets }; });
  check('a bomb over the wheel pivot targets the whole assembly', preview.ok && preview.targets?.length === 1, JSON.stringify(preview));
  const bh = await placeAt(host, 75, 17, 0);
  const cg = await placeFirstValid(guest);
  check('bomb detonated and coin placed', bh === 'ok' && cg === true, `${bh} / ${cg}`);
  await host.page.waitForTimeout(600);
  const gone = await Promise.all([host, guest].map(p => p.page.evaluate(() => { const g = window.__trap.game; return { wheel: [...g.world.objects.values()].some(o => o.item === 'wheel'), lanes: g.world.reserved.filter(r => r).length, kin: g.world.kinematic.length }; })));
  check('the wheel, its reserved lane and its bodies are gone on both clients; the shuttle stays', gone.every(x => !x.wheel && x.kin === 1 && x.lanes === 5), JSON.stringify(gone));
  await Promise.all([waitPhase(host, 'race', 40000), waitPhase(guest, 'race', 40000)]);
  await host.page.waitForTimeout(800);
  const nm = await Promise.all([host, guest].map(p => p.page.evaluate(() => window.__trap.game.race.movers.length)));
  check('next race simulates only the remaining shuttle on both clients', nm.every(n => n === 1), nm.join(','));
  await host.ctx.close(); await guest.ctx.close();
} catch (e) {
  check('mover e2e flow', false, String(e));
}
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
