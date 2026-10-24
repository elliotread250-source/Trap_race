// Browser checks for the gameplay update: human-first drafting against the AI, the score-to-win setting, the Ferris
// wheel preview, and screenshots of the new item art. npm run build && node tests/e2e/update.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const EXEC = process.env.CHROME ?? ((await import('node:fs')).existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : '/opt/pw-browsers/chromium');
const SHOTS = process.env.SHOTS ?? 'test-results/update';
mkdirSync(SHOTS, { recursive: true });
const port = 18800 + Math.floor(Math.random() * 90);
const server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), TEST_POOL: 'wheel,spiky_oval,rspikes,crumble,pendulum' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await page.click('text=Play Against AI');
  await page.click('text=Create match');
  await page.waitForSelector('text=Start match');
  // every whole score 5..15, plus Off (0), which stays disabled until a round limit is set
  const opts = await page.$$eval('select[aria-label="Points to win"] option', os => os.map(o => [Number(o.value), o.disabled]));
  check('lobby offers every score to win from 5 to 15 (and a disabled Off)', JSON.stringify(opts.map(o => o[0])) === JSON.stringify([0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) && opts[0][1] === true, JSON.stringify(opts));
  // a forged out-of-range value is refused by the server
  await page.evaluate(() => window.__trap.game.send({ t: 'host', a: 'target', target: 99 }));
  await page.waitForTimeout(400);
  check('the server rejects a forged score to win', await page.evaluate(() => window.__trap.game.room.target) === 10);
  await page.click('text=Start match');
  await page.waitForSelector('.draft .stage', { timeout: 10000 });
  check('draft opens with "Players choosing"', (await page.textContent('.draft .stage')).includes('Players choosing'));
  await page.waitForTimeout(4000);
  const botPicks = await page.evaluate(() => { const g = window.__trap.game; return g.cards.filter(c => c.by && c.by !== g.you).length; });
  check('no AI player has picked while the human is still choosing', botPicks === 0, String(botPicks));
  await page.screenshot({ path: `${SHOTS}/draft-humans.png` });
  await page.click('.icard:has-text("Ferris Wheel")');
  await page.waitForTimeout(300);
  const stage2 = await page.evaluate(() => window.__trap.game.draftStage);
  check('after the human picks, the AI chooses', stage2 === 'ai' || (await page.evaluate(() => window.__trap.game.phase)) === 'build', stage2);
  await page.waitForFunction(() => window.__trap.game.phase === 'build', null, { timeout: 15000 });
  const owners = await page.evaluate(() => { const g = window.__trap.game; return g.cards.filter(c => c.by).map(c => c.by); });
  check('every bot then got a different leftover card', new Set(owners).size === owners.length && owners.length >= 2, JSON.stringify(owners));
  // wheel preview with one gondola in open space and others inside terrain
  const prev = await page.evaluate(() => {
    const g = window.__trap.game, w = g.world, b = w.map.build;
    for (let y = b.y + 3; y < b.y + b.h - 3; y++) for (let x = b.x + 4; x < b.x + b.w - 4; x++) {
      g.setCursor(x, y);
      const c = g.check;
      if (c?.ok && c.validChildren.length >= 1 && c.validChildren.length < 4 && c.overlapCells.length) return { x, y, valid: c.validChildren, overlap: c.overlapCells.length };
    }
    return null;
  });
  check('the wheel preview accepts a spot where only some gondolas start in open space', !!prev, JSON.stringify(prev));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/wheel-preview.png` });
  // art: drop one of each new item into the client's own world (visual only) and frame them
  await page.evaluate(() => {
    const g = window.__trap.game, w = g.world;
    const add = (item, x, y, rot, cells) => { const id = 'v' + item + x; w.objects.set(id, { id, item, owner: g.you, prov: 'player', x, y, rot, variant: 0, cells, attach: null, round: 1 }); };
    const fy = 13;
    add('spiky_oval', 8, fy, 0, [[8, fy], [9, fy], [10, fy]]);
    add('rspikes', 12, fy - 1, 0, [[12, fy - 1], [13, fy - 1], [12, fy], [13, fy]]);
    add('pendulum', 16, fy - 4, 0, [[16, fy - 4]]);
    add('crumble', 18, fy, 0, [[18, fy], [19, fy], [20, fy]]);
    add('spiky_oval', 22, fy - 2, 1, [[22, fy - 2], [22, fy - 1], [22, fy]]);
    w.rebuild();
    g.cursor = { x: 14, y: fy - 2 };
    window.__trap.renderer.buildZoom = 2.6;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/items.png` });
  await ctx.close();
} catch (e) {
  check('update e2e flow', false, String(e));
}
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
