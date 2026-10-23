// Phone and tablet checks in Chromium emulation with real touch events (CDP), incl. multi-touch run + jump.
// npm run build && node tests/e2e/mobile.mjs [screenshot-dir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const S = process.argv[2] ?? 'test-results/mobile';
mkdirSync(S, { recursive: true });
const port = 18960;
const server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
const b = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const out = {};
// portrait: menu works, gameplay asks to rotate
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}`); await p.waitForTimeout(400);
  await p.screenshot({ path: `${S}/n-portrait-menu.png` });
  await p.tap('text=Solo Practice'); await p.tap('text=Start practice');
  await p.waitForSelector('.rotate', { timeout: 5000 }).then(() => out.rotatePrompt = true, () => out.rotatePrompt = false);
  await p.screenshot({ path: `${S}/n-portrait-game.png` });
  await ctx.close();
}
for (const [name, vp] of [['phone-landscape', { width: 844, height: 390 }], ['tablet', { width: 1024, height: 768 }]]) {
  const ctx = await b.newContext({ viewport: vp, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const cdp = await ctx.newCDPSession(p);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await p.goto(`http://127.0.0.1:${port}`);
  await p.tap('text=Solo Practice'); await p.tap('text=Start practice');
  await p.waitForSelector('.icard'); await p.waitForTimeout(300);
  await p.screenshot({ path: `${S}/n-${name}-draft.png` });
  await p.tap('.icard >> nth=0');
  await p.waitForSelector('.buildbar'); await p.waitForTimeout(300);
  // tap to aim, then drag to nudge, until valid
  let valid = false;
  for (let i = 0; i < 30 && !valid; i++) {
    const x = 60 + (i * 71) % (vp.width - 120), y = 40 + Math.floor(i / 5) * 23 % (vp.height - 140);
    await touch('touchStart', x, y); await touch('touchEnd'); await p.waitForTimeout(60);
    valid = !!(await p.$('.valid.ok'));
  }
  const c0 = await p.evaluate(() => ({ ...window.__trap.game.cursor }));
  await touch('touchStart', 300, 150); for (let k = 1; k <= 6; k++) await touch('touchMove', 300 + k * 6, 150); await touch('touchEnd'); await p.waitForTimeout(100);
  const c1 = await p.evaluate(() => ({ ...window.__trap.game.cursor }));
  out[name + '_dragMovedCursor'] = c1.x !== c0.x;
  for (let i = 0; i < 20 && !(await p.$('.valid.ok')); i++) { await touch('touchStart', 300, 150); await touch('touchMove', 300 + (i % 2 ? 40 : -40), 150 - 20); await touch('touchEnd'); await p.waitForTimeout(60); }
  // the random drags can leave the preview somewhere illegal: tap around until a valid spot is found (as a player would)
  for (let i = 0; i < 80 && !(await p.$('.valid.ok')); i++) {
    const x = 40 + (i * 89) % (vp.width - 80), y = 60 + ((i * 47) % Math.max(60, vp.height - 200));
    await touch('touchStart', x, y); await touch('touchEnd'); await p.waitForTimeout(40);
  }
  await p.screenshot({ path: `${S}/n-${name}-build.png` });
  out[name + '_item'] = await p.evaluate(() => window.__trap.game.myItem());
  await p.tap('.buildbar button:has-text("Place"), .buildbar button:has-text("Detonate")');
  await p.waitForTimeout(900);
  out[name + '_placed'] = await p.evaluate(() => window.__trap.game.placedThisRound);
  if (!out[name + '_placed']) out[name + '_why'] = await p.evaluate(() => ({ check: window.__trap.game.check?.reason, toasts: window.__trap.game.toasts.map(t => t.msg) }));
  while ((await p.evaluate(() => window.__trap.game.phase)) !== 'race') await p.waitForTimeout(150);
  await p.waitForTimeout(400);
  out[name + '_touchButtons'] = await p.$$eval('.tbtn', els => els.map(e => e.textContent));
  const x0 = await p.evaluate(() => window.__trap.game.pred.x);
  const btn = async (label, down) => { const bb = await (await p.$(`.tbtn[aria-label="${label}"]`)).boundingBox(); return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }; };
  const R = await btn('right'), J = await btn('jump');
  // hold RIGHT with one finger and tap JUMP with a second finger (multi-touch)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: R.x, y: R.y, id: 1 }] });
  await p.waitForTimeout(400);
  const y0 = await p.evaluate(() => window.__trap.game.pred.y);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: R.x, y: R.y, id: 1 }, { x: J.x, y: J.y, id: 2 }] });
  await p.waitForTimeout(200);
  const yJump = await p.evaluate(() => window.__trap.game.pred.y);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: R.x, y: R.y, id: 1 }] });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${S}/n-${name}-race.png` });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const x1 = await p.evaluate(() => window.__trap.game.pred?.x ?? 0);
  out[name + '_movedRightPx'] = Math.round(x1 - x0);
  out[name + '_jumpedPx'] = Math.round(y0 - yJump);
  out[name + '_errors'] = errs;
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await b.close();
server.kill();
const ok = out.rotatePrompt && ['phone-landscape', 'tablet'].every(n => out[n + '_placed'] && out[n + '_touchButtons'].length === 5 && out[n + '_movedRightPx'] > 50 && out[n + '_jumpedPx'] > 30 && !out[n + '_errors'].length);
console.log(ok ? 'MOBILE PASS' : 'MOBILE FAIL');
process.exit(ok ? 0 : 1);
