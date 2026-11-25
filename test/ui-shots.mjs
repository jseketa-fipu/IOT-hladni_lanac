// Visual check of the page (not part of npm test): screenshots at 1280x800 and 1920x1080,
// light and dark, before Run and while running at 10 C. Fails on any page error.
// Usage: node test/ui-shots.mjs [url] [outdir] [prefix]   (start `npm run dev` first)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:8080/';
const out = process.argv[3] ?? tmpdir();
const prefix = process.argv[4] ?? 'ui';
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sizes = [
  [1280, 800],
  [1920, 1080],
];

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const errors = [];
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`${scheme}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${scheme}: ${m.text()}`));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('input[type=range][data-sensor="temp1"]', { timeout: 10000 });
    for (const [w, hgt] of sizes) {
      await page.setViewport({ width: w, height: hgt });
      await new Promise((r) => setTimeout(r, 700)); // past the 0.5 s file-list refresh
      await page.screenshot({ path: join(out, `${prefix}-${w}-${scheme}-idle.png`) });
    }
    await page.setViewport({ width: 1280, height: 800 });
    // 10 C before Run, then run until the alarm.
    await page.$eval('input[type=range][data-sensor="temp1"]', (el) => {
      el.value = '10';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#run');
    await page.waitForFunction(() => document.querySelector('#serial').textContent.includes('[MJERENJE]'), { timeout: 40000 });
    await new Promise((r) => setTimeout(r, 2500));
    for (const [w, hgt] of sizes) {
      await page.setViewport({ width: w, height: hgt });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: join(out, `${prefix}-${w}-${scheme}-run.png`) });
    }
    await page.click('#stop');
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(errors.length ? `FAIL\n${errors.join('\n')}` : 'PASS: no page errors');
process.exit(errors.length ? 1 : 0);
