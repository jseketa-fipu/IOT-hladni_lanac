// Smoke test of the real page in headless Chrome: Run, see serial output, LED blink, button press.
// Usage: node test/browser.mjs [url]   (start `npm run dev` first)
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:8080/';
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(url, { waitUntil: 'networkidle0' });
await page.click('#run');
await page.waitForFunction(() => document.querySelector('#serial').textContent.includes('main.py is running'), { timeout: 30000 });

const ledStates = new Set();
for (let i = 0; i < 40; i++) {
  ledStates.add(await page.$eval('#led', (el) => el.classList.contains('on')));
  await new Promise((r) => setTimeout(r, 150));
}

const btn = await page.$('#button');
const box = await btn.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 600));
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#serial').textContent.includes('button released'), { timeout: 15000 });

await page.screenshot({ path: process.env.SHOT ?? 'test/screenshot.png' });
const serial = await page.$eval('#serial', (el) => el.textContent);
const status = await page.$eval('#status', (el) => el.textContent);
await browser.close();

console.log(serial.trim().split('\n').slice(-6).join('\n'));
console.log('status:', status);
const ok = ledStates.size === 2 && errors.length === 0;
console.log(ok ? 'PASS' : `FAIL leds=${[...ledStates]} errors=${errors.join(' | ')}`);
process.exit(ok ? 0 : 1);
