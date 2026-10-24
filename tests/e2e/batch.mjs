// Two-browser checks for the batch update: new items, death effects and maps stay in sync across clients, the round
// limit setting syncs, and the sandbox offers every item. npm run build && node tests/e2e/batch.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const EXEC = process.env.CHROME ?? ((await import('node:fs')).existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : '/opt/pw-browsers/chromium');
const port = 19300 + Math.floor(Math.random() * 90);
const server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), DRAFT_MS: '15000', BUILD_MS: '20000', RACE_MS: '40000', RESULTS_MS: '3000', TEST_POOL: 'planemaker,grave|dart_turret,fan' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const errors = [];
async function newPlayer(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  return { ctx, page, name };
}
const phase = p => p.page.evaluate(() => window.__trap.game.phase);
const waitPhase = async (p, ph, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await phase(p) === ph) return; await p.page.waitForTimeout(150); } throw new Error(`${p.name} never reached ${ph}`); };
const placeIn = (p, x0, x1, y0, y1) => p.page.evaluate(async ([x0, x1, y0, y1]) => {
  const g = window.__trap.game;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { g.setCursor(x, y); if (g.check?.ok) { g.confirmPlace(); for (let i = 0; i < 60 && !g.placedThisRound; i++) await new Promise(r => setTimeout(r, 100)); return g.placedThisRound ? `ok@${x},${y}` : 'no confirm'; } }
  return 'no spot';
}, [x0, x1, y0, y1]);
const planePoses = p => p.page.evaluate(() => {
  const g = window.__trap.game, out = {};
  for (const sn of g.snaps) out[sn.s.tick] = (sn.s.pl ?? []).map(pl => [pl[0], pl[1], pl[2]]);
  return out;
});
try {
  const host = await newPlayer('host'), guest = await newPlayer('guest');
  for (const p of [host, guest]) await p.page.addInitScript(() => { window.__deaths = []; });
  await host.page.goto(base);
  await host.page.fill('input[aria-label="Your name"]', 'HostB');
  await host.page.click('text=Create Room');
  await host.page.waitForSelector('.code-box .code');
  const code = (await host.page.textContent('.code-box .code')).trim();
  await host.page.click('.map-tile:has-text("Tropical Island")');
  await guest.page.goto(`${base}/?room=${code}`);
  await guest.page.fill('input[aria-label="Your name"]', 'GuestB');
  await guest.page.click('button:has-text("Join")');
  await guest.page.waitForSelector('.player-row >> nth=1', { timeout: 10000 });
  await guest.page.click('text=Ready up');
  // the round limit is a typed field: switch it on, then type any two-digit number
  await host.page.check('input[aria-label="Round limit on"]');
  await host.page.waitForTimeout(400);
  await host.page.fill('input[aria-label="Round limit"]', '47');
  await host.page.press('input[aria-label="Round limit"]', 'Enter');
  await guest.page.waitForTimeout(500);
  check('host types a two-digit round limit (47) and the guest sees it', await guest.page.evaluate(() => window.__trap.game.room.roundLimit) === 47);
  await host.page.fill('input[aria-label="Round limit"]', '3');
  await host.page.press('input[aria-label="Round limit"]', 'Enter');
  await guest.page.waitForTimeout(500);
  check('a one-digit round limit works too', await guest.page.evaluate(() => window.__trap.game.room.roundLimit) === 3);
  for (const p of [host, guest]) await p.page.evaluate(() => { const g = window.__trap.game, prev = g.onEvent; g.onEvent = e => { if (e.type === 'death') window.__deaths.push([e.pid, e.cause, e.t]); prev(e); }; });
  await host.page.click('text=Start match');
  await Promise.all([waitPhase(host, 'draft'), waitPhase(guest, 'draft')]);
  check('both clients are on Tropical Island', (await guest.page.evaluate(() => window.__trap.game.world.map.id)) === 'tropical');
  const cards = await host.page.textContent('.cards');
  check('the new items appear in the draft', cards.includes('Paper Plane Maker') && cards.includes('Gravestone'), cards.slice(0, 100));
  await host.page.click('.icard:has-text("Paper Plane Maker")');
  await guest.page.waitForTimeout(300);
  await guest.page.click('.icard:has-text("Gravestone")');
  await Promise.all([waitPhase(host, 'build'), waitPhase(guest, 'build')]);
  const ph = await placeIn(host, 24, 30, 33, 36), pg = await placeIn(guest, 36, 44, 37, 37);
  check('plane maker and gravestone placed through the server', ph.startsWith('ok') && pg.startsWith('ok'), `${ph} / ${pg}`);
  await Promise.all([waitPhase(host, 'race', 40000), waitPhase(guest, 'race', 40000)]);
  await host.page.waitForTimeout(4000);
  const [a, b] = await Promise.all([planePoses(host), planePoses(guest)]);
  const common = Object.keys(a).filter(t => b[t] && a[t].length);
  check('both clients see the same paper planes at the same server ticks', common.length > 0 && common.every(t => JSON.stringify(a[t]) === JSON.stringify(b[t])), `${common.length} shared ticks with planes`);
  const gs = await Promise.all([host, guest].map(p => p.page.evaluate(() => { const s = window.__trap.game.race.graves[0]; return s ? { flowers: s.flowers, ghosts: s.ghosts.length, states: s.ghosts.map(x => x.state).join(',') } : null; })));
  check('gravestone flowers and ghosts agree (2 humans: 2 flowers, 2 ghosts)', JSON.stringify(gs[0]) === JSON.stringify(gs[1]) && gs[0]?.flowers === 2 && gs[0]?.ghosts === 2, JSON.stringify(gs));
  // nobody moves, so the tsunami at 15 s drowns both players: both clients must log the same deaths and causes
  await host.page.waitForTimeout(13000);
  const ds = await Promise.all([host, guest].map(p => p.page.evaluate(() => window.__deaths.map(d => `${d[0]}:${d[1]}`).sort().join(','))));
  check('both clients play the same death effects (tsunami)', ds[0] === ds[1] && ds[0].includes('tsunami'), JSON.stringify(ds));
  const ts = await Promise.all([host, guest].map(p => p.page.evaluate(() => window.__trap.game.world.map.fx.tsunami.start)));
  check('both clients share the same tsunami timing', ts[0] === ts[1] && ts[0] === 15);
  await host.ctx.close(); await guest.ctx.close();
  // sandbox: every item is in the M menu and placing works
  const solo = await newPlayer('sandbox');
  await solo.page.goto(base);
  await solo.page.click('text=Sandbox');
  await solo.page.click('.map-tile:has-text("Magma Works")');
  await solo.page.click('text=Start sandbox');
  await solo.page.waitForTimeout(800);
  await solo.page.keyboard.press('KeyM');
  await solo.page.waitForTimeout(400);
  const n = await solo.page.$$eval('.sb-item', els => els.length);
  check('the sandbox M menu lists every item (43)', n === 43, String(n));
  await solo.page.click('.sb-item[data-item="fan"]');
  const placed = await solo.page.evaluate(() => { const g = window.__trap.game; for (let y = 20; y < 31; y++) for (let x = 2; x < 12; x++) { g.setCursor(x, y); if (g.check?.ok) { g.confirmPlace(); return [...g.world.objects.values()].some(o => o.item === 'fan'); } } return false; });
  check('sandbox places an item instantly', placed);
  await solo.ctx.close();
} catch (e) { check('batch e2e flow', false, String(e)); }
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
