// Smoke test of the real page in headless Chrome, with the full cold-chain circuit:
// Run, set the DS18B20 with its slider, see a measurement at that temperature, press the
// button and see the summary, open the CSV from the SD card panel. Fails on any page error.
// Usage: node test/browser.mjs [url]   (start `npm run dev` first)
// Env: CHROME (path to Chrome), SHOT (screenshot path, default: system temp dir).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:8080/';
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shot = process.env.SHOT ?? join(tmpdir(), 'pico-sim-browser.png');
const TEMP = 6.5; // on the DS18B20's 1/16 C grid, so it prints exactly "6.50 C"

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const serial = () => page.$eval('#serial', (el) => el.textContent);
const waitSerial = (text, timeout) =>
  page.waitForFunction((t) => document.querySelector('#serial').textContent.includes(t), { timeout }, text);
const steps = [];
const step = async (name, fn) => {
  try {
    await fn();
    steps.push(`ok   ${name}`);
  } catch (e) {
    steps.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    throw e;
  }
};

let ok = false;
try {
  await page.goto(url, { waitUntil: 'load' });
  await step('parts panel lists the DS18B20, DS1307 and SD card', async () => {
    await page.waitForSelector('input[type=range][data-sensor="temp1"]', { timeout: 10000 });
    await page.waitForSelector('input[type=checkbox][data-card="sd1"]');
    await page.waitForSelector('.rtc-time');
    if (await page.$('.warnings')) {
      throw new Error(`wiring warnings shown: ${await page.$eval('.warnings', (el) => el.textContent)}`);
    }
  });

  await step('Run boots the program', async () => {
    await page.click('#run');
    await waitSerial('[START] tipkalo', 30000);
    await waitSerial('[MJERENJE]', 15000);
  });

  await step(`slider to ${TEMP} C -> measurement line with ${TEMP.toFixed(2)} C`, async () => {
    await page.$eval(
      'input[type=range][data-sensor="temp1"]',
      (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      TEMP,
    );
    const shown = await page.$eval('input[type=number][data-sensor="temp1"]', (el) => el.value);
    if (Number(shown) !== TEMP) throw new Error(`number box shows ${shown}`);
    await waitSerial(`| ${TEMP.toFixed(2)} C | U_RASPONU`, 15000);
  });

  await step('button press -> summary and CSV tail', async () => {
    const box = await (await page.$('wokwi-pushbutton')).boundingBox();
    // The cap sits in the middle of the part; hold longer than the 200 ms debounce.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 400));
    await page.mouse.up();
    await waitSerial('[TIPKALO] pritisak', 5000);
    await waitSerial('[SAZETAK] ', 5000);
    await waitSerial('[CSV] --- kraj ---', 5000);
    const out = await serial();
    if (!new RegExp(`\\[SAZETAK\\] .*max ${TEMP.toFixed(2)} C`).test(out)) throw new Error('summary does not show the new maximum');
  });

  await step('LED stays off while in range', async () => {
    if (await page.$eval('wokwi-led', (el) => !!el.value)) throw new Error('LED is lit');
  });

  await step('SD panel lists hladnjaca.csv and "view" shows it', async () => {
    await page.waitForFunction(() => document.querySelector('.file-list').textContent.includes('hladnjaca.csv'), { timeout: 5000 });
    const row = await page.$$eval('.file', (rows) => rows.findIndex((r) => r.textContent.includes('hladnjaca.csv')));
    const viewButtons = await page.$$('.file .file-actions button:first-child');
    await viewButtons[row].click();
    await page.waitForFunction(() => document.querySelector('#file-view').open, { timeout: 2000 });
    const text = await page.$eval('#file-view-body', (el) => el.textContent);
    if (!text.startsWith('datum_vrijeme,temperatura_c,stanje\n')) throw new Error(`viewer shows ${JSON.stringify(text.slice(0, 60))}`);
    if (!text.includes(`,${TEMP.toFixed(2)},U_RASPONU`)) throw new Error('viewer misses the new row');
    await page.screenshot({ path: shot });
    await page.keyboard.press('Escape');
  });

  await step('Ctrl+Enter twice at once -> one program running, and Stop silences it', async () => {
    // Both run() calls overlap (the second lands while the first awaits Board.create).
    // A leftover first board would print a second banner, find no parts ("nije dostupna")
    // and keep printing after Stop.
    await page.evaluate(() => {
      const editor = document.querySelector('#editor');
      for (let i = 0; i < 2; i++) editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await waitSerial('[MJERENJE]', 30000);
    await new Promise((r) => setTimeout(r, 1500));
    const text = await serial();
    const banners = text.split('[START] Nadzor hladnog lanca').length - 1;
    if (banners !== 1) throw new Error(`${banners} start banners`);
    if (/nije dostupna|nije pronaden/.test(text)) throw new Error('a second board without parts is running');
    await page.click('#stop');
    const stopped = (await serial()).length;
    await new Promise((r) => setTimeout(r, 11000)); // longer than one 10 s measurement interval
    const later = (await serial()).length;
    if (later !== stopped) throw new Error(`serial output grew after Stop (${stopped} -> ${later} chars)`);
  });

  await step('8.04 C typed -> badge shows what the sensor reports (8.06 C) and the panel explains it', async () => {
    await page.$eval('input[type=number][data-sensor="temp1"]', (el) => {
      el.value = '8.04';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 200));
    const shown = await page.evaluate(() => ({
      box: document.querySelector('input[type=number][data-sensor="temp1"]').value,
      badge: [...document.querySelectorAll('#circuit *')].map((e) => e.textContent?.trim() ?? '').find((t) => /°C$/.test(t) && t.length < 12),
      note: document.querySelector('input[type=number][data-sensor="temp1"]').closest('section').textContent,
    }));
    if (shown.box !== '8.04' || shown.badge !== '8.06 °C' || !shown.note.includes('sensor reports 8.06 °C')) {
      throw new Error(JSON.stringify(shown));
    }
  });

  await step('speed 10x, 10 C -> alarm after 2 min 10 s simulated, LED lit, within 40 s real time', async () => {
    await page.select('#speed', '10');
    await page.$eval('input[type=range][data-sensor="temp1"]', (el) => {
      el.value = '10';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#run');
    await waitSerial('[ALARM] temperatura 10.00 C', 40000);
    await new Promise((r) => setTimeout(r, 500));
    if (!(await page.$eval('wokwi-led', (el) => !!el.value))) throw new Error('LED not lit during the alarm');
    const status = await page.$eval('#status', (el) => el.textContent);
    if (!status.includes('10× real time')) throw new Error(`status: ${status}`);
    await page.click('#stop');
    await page.select('#speed', '1');
  });

  ok = errors.length === 0;
} catch {
  ok = false;
}

const out = await serial().catch(() => '');
const status = await page.$eval('#status', (el) => el.textContent).catch(() => '');
await browser.close();

console.log(out.trim().split('\n').slice(-8).join('\n'));
console.log('status:', status);
console.log(steps.join('\n'));
console.log('screenshot:', shot);
if (errors.length) console.log('page errors:', errors.join(' | '));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
