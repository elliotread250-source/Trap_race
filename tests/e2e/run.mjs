// Browser end-to-end checks with two independent browser contexts.
// Local: npm run build && node tests/e2e/run.mjs   (starts its own server with short timers)
// Remote: BASE=https://example.up.railway.app node tests/e2e/run.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const EXEC = process.env.CHROME ?? ((await import('node:fs')).existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : '/opt/pw-browsers/chromium');
let base = process.env.BASE;
let server;
if (!base) {
  const port = 18900 + Math.floor(Math.random() * 90);
  server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), RACE_MS: '12000', RESULTS_MS: '3000', BUILD_MS: '20000' }, stdio: 'inherit' });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
}
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
const state = p => p.page.evaluate(() => { const g = window.__trap.game; return { phase: g.phase, round: g.round, code: g.code, you: g.you, objs: g.world ? [...g.world.objects.values()].filter(o => o.prov === 'player').length : -1, status: g.status, tally: g.tally, results: g.results?.rows ?? null }; });
const waitPhase = async (p, phase, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await state(p); if (s.phase === phase) return s; await p.page.waitForTimeout(150); } throw new Error(`${p.name} never reached ${phase}`); };
async function draftPick(p) {
  await p.page.waitForSelector('.icard:not([disabled])', { timeout: 20000 });
  await p.page.click('.icard:not([disabled]) >> nth=0');
}
async function placeAnywhere(p) {
  await p.page.waitForSelector('.buildbar', { timeout: 20000 });
  for (let i = 0; i < 160; i++) {
    const x = 120 + (i * 97) % 1040, y = 150 + Math.floor(i / 11) * 29 % 420;
    await p.page.mouse.move(x, y);
    await p.page.waitForTimeout(25);
    if (await p.page.$('.valid.ok')) { await p.page.mouse.down(); await p.page.mouse.up(); await p.page.waitForTimeout(400); const s = await p.page.evaluate(() => window.__trap.game.placedThisRound); if (s) return true; }
  }
  return false;
}

try {
  // ---------- 1. arcade link and solo practice without an account
  const solo = await newPlayer('solo');
  await solo.page.goto(base);
  const hub = await solo.page.getAttribute('a[data-hub]', 'href');
  check('return-to-arcade link present', !!hub && hub.includes('arcade'), hub ?? '');
  await solo.page.click('text=Solo Practice');
  await solo.page.click('text=Start practice');
  await waitPhase(solo, 'draft', 10000);
  check('solo practice starts without an account', true);
  await solo.ctx.close();

  // ---------- 2. two independent browsers: create, join by code, full round
  const host = await newPlayer('host'), guest = await newPlayer('guest');
  await host.page.goto(base);
  await host.page.fill('input[aria-label="Your name"]', 'HostE2E');
  await host.page.click('text=Create Room');
  await host.page.waitForSelector('.code-box .code');
  const code = (await host.page.textContent('.code-box .code')).trim();
  check('room created with server code', /^[A-Z0-9]{5}$/.test(code), code);
  await guest.page.goto(`${base}/?room=${code}`);
  await guest.page.fill('input[aria-label="Your name"]', 'GuestE2E');
  await guest.page.click('button:has-text("Join")');
  await guest.page.waitForSelector('.player-row >> nth=1', { timeout: 10000 });
  check('guest joined via invite link', (await guest.page.$$('.player-row')).length === 2);
  await guest.page.click('text=Ready up');
  await host.page.waitForTimeout(400);
  await host.page.selectOption('select:near(:text("Rounds"))', '3').catch(() => {});
  await host.page.click('text=Start match');
  await Promise.all([waitPhase(host, 'draft'), waitPhase(guest, 'draft')]);
  await Promise.all([draftPick(host), draftPick(guest)]);
  await Promise.all([waitPhase(host, 'build'), waitPhase(guest, 'build')]);
  const [ph, pg] = await Promise.all([placeAnywhere(host), placeAnywhere(guest)]);
  check('both players placed their drafted item', ph && pg, `${ph} ${pg}`);
  await Promise.all([waitPhase(host, 'race', 30000), waitPhase(guest, 'race', 30000)]);
  // host runs right for a bit (server authoritative)
  await host.page.keyboard.down('KeyD');
  await host.page.waitForTimeout(900);
  await host.page.keyboard.up('KeyD');
  const fps = await host.page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); }; requestAnimationFrame(f); }));
  check('client renders during race', fps > 20, `${fps} fps (headless, software rendering)`);
  const hs = await waitPhase(host, 'results', 60000), gs = await waitPhase(guest, 'results', 60000);
  check('both clients see identical round results', JSON.stringify(hs.results) === JSON.stringify(gs.results), JSON.stringify(hs.results?.map(r => [r.pid, r.total])));
  const [h2, g2] = await Promise.all([waitPhase(host, 'draft', 30000), waitPhase(guest, 'draft', 30000)]);
  check('placed items persist into round 2 on both clients', h2.objs === g2.objs && h2.objs >= 1, `${h2.objs} / ${g2.objs}`);
  // reconnect: reload the guest page and keep the same identity
  const before = (await state(guest)).you;
  await guest.page.reload();
  await guest.page.waitForTimeout(2500);
  const after = await state(guest);
  check('refresh mid-match restores the same player', after.you === before && after.phase !== 'lobby', `${before} -> ${after.you} (${after.phase})`);
  await host.ctx.close(); await guest.ctx.close();

  // ---------- 3. human vs bots
  const solo2 = await newPlayer('vsbots');
  await solo2.page.goto(base);
  await solo2.page.click('text=Play Against AI');
  await solo2.page.click('text=Create match');
  await solo2.page.waitForSelector('text=Start match');
  const bots = await solo2.page.$$eval('.player-row', rows => rows.filter(r => r.textContent.includes('(bot)')).length);
  check('bots added to the lobby', bots >= 1, String(bots));
  await solo2.page.click('text=Start match');
  await waitPhase(solo2, 'draft');
  await draftPick(solo2);
  await waitPhase(solo2, 'build', 30000);
  await placeAnywhere(solo2);
  const r3 = await waitPhase(solo2, 'results', 90000);
  check('human vs bots round completes with bots in results', (r3.results ?? []).length >= 2, JSON.stringify(r3.results?.map(r => [r.pid, r.status, r.total])));
  await solo2.ctx.close();
} catch (e) {
  check('e2e flow', false, String(e));
}
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server?.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
