// Plays a race with artificial latency (?lag=ms each way) and reports prediction corrections.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const lag = Number(process.env.LAG ?? 65);
const port = 18990;
const server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), RACE_MS: '15000' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? ((await import('node:fs')).existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : '/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${base}/?lag=${lag}`);
await page.click('text=Play Against AI');
await page.click('text=Create match');
await page.click('text=Start match');
const phase = () => page.evaluate(() => window.__trap.game.phase);
while (await phase() !== 'draft') await page.waitForTimeout(100);
await page.click('.icard:not([disabled]) >> nth=0');
while (await phase() !== 'race') await page.waitForTimeout(100);
const corr = [];
const keys = ['KeyD', 'Space', 'ShiftLeft'];
for (let i = 0; i < 40; i++) {
  if (i % 8 === 0) await page.keyboard.down('KeyD');
  if (i % 8 === 3) await page.keyboard.down('Space');
  if (i % 8 === 5) await page.keyboard.up('Space');
  if (i % 8 === 7) await page.keyboard.up('KeyD');
  await page.waitForTimeout(100);
  corr.push(await page.evaluate(() => ({ c: window.__trap.game.stats.lastCorr, rtt: window.__trap.game.transport.rtt, st: window.__trap.game.race?.player(window.__trap.game.you)?.status })));
}
for (const k of keys) await page.keyboard.up(k);
const cs = corr.map(c => c.c).sort((a, b) => a - b);
console.log(`lag ${lag}ms each way, measured rtt ~${Math.round(corr[corr.length - 1].rtt)}ms; correction px median ${cs[Math.floor(cs.length / 2)].toFixed(2)} p90 ${cs[Math.floor(cs.length * 0.9)].toFixed(2)} max ${cs[cs.length - 1].toFixed(2)}; status ${corr[corr.length - 1].st}`);
await browser.close();
server.kill();
