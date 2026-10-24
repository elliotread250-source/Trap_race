// Browser check for emotes and the new character animations. npm run build && node tests/e2e/emotes.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const EXEC = process.env.CHROME ?? ((await import('node:fs')).existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : '/opt/pw-browsers/chromium');
const SHOTS = process.env.SHOTS ?? 'test-results/emotes';
mkdirSync(SHOTS, { recursive: true });
const port = 18700 + Math.floor(Math.random() * 90);
const server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), DRAFT_MS: '2500', BUILD_MS: '2500', RACE_MS: '30000' }, stdio: 'inherit' });
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
  await page.click('text=Skins');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/skins.png` });
  await page.click('text=Done');
  await page.click('text=Play Against AI');
  await page.click('text=Create match');
  await page.click('text=Start match');
  await page.waitForFunction(() => window.__trap.game.phase === 'countdown', null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/countdown-ready.png` });
  check('emote button shows once characters are on screen', await page.isVisible('.emote-toggle'));
  await page.waitForFunction(() => window.__trap.game.phase === 'race', null, { timeout: 10000 });
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(200);
  check('digit keys no longer trigger emotes', (await page.evaluate(() => { const g = window.__trap.game; return g.emotes.get(g.you)?.e ?? null; })) === null);
  // hold G: the emote wheel opens; scroll the mouse wheel one notch to Dance; release G to play it
  await page.mouse.move(640, 360);
  await page.keyboard.down('KeyG');
  await page.waitForTimeout(150);
  check('holding G opens the emote wheel', await page.isVisible('.emote-wheel'));
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/wheel.png` });
  await page.keyboard.up('KeyG');
  await page.waitForTimeout(250);
  const mine = await page.evaluate(() => { const g = window.__trap.game; return g.emotes.get(g.you)?.e ?? null; });
  check('scrolling one notch and releasing G plays Dance', mine === 1, String(mine));
  check('the wheel closes on release', !(await page.isVisible('.emote-wheel')));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/dance.png` });
  await page.waitForTimeout(1200);
  await page.click('.emote-toggle');
  check('the emote wheel lists all ten emotes', (await page.$$('.emote-wheel .slice')).length === 10);
  await page.click('.emote-wheel .slice:has-text("Heart")');
  await page.waitForTimeout(300);
  const heart = await page.evaluate(() => { const g = window.__trap.game; return g.emotes.get(g.you)?.e ?? null; });
  check('tapping Heart on the wheel plays it', heart === 7, String(heart));
  await page.screenshot({ path: `${SHOTS}/heart.png` });
  // moving cancels the emote
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(400); await page.keyboard.up('ArrowRight');
  const cancelled = await page.evaluate(() => { const g = window.__trap.game; g.activeEmote(g.you, Math.abs(g.pred?.vx ?? 0) > 20); return !g.emotes.has(g.you); });
  check('running cancels the emote', cancelled);
  await ctx.close();
} catch (e) {
  check('emote e2e flow', false, String(e));
}
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
