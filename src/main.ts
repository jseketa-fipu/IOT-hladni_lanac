// Browser UI: loads firmware and project files from this site, runs the board,
// and wires the LED, button and serial monitor.

import { Board, type ProjectFile } from './board.js';
import { boardKindFromFirmware } from './fs.js';

const LED_PIN = 16;
const BUTTON_PIN = 14;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const firmwareSelect = $<HTMLSelectElement>('firmware');
const runButton = $<HTMLButtonElement>('run');
const stopButton = $<HTMLButtonElement>('stop');
const statusText = $('status');
const tabs = $('tabs');
const editor = $<HTMLTextAreaElement>('editor');
const serialOut = $('serial');
const serialIn = $<HTMLInputElement>('serial-input');
const led = $('led');
const button = $<HTMLButtonElement>('button');

let files: ProjectFile[] = [];
let current = 0;
let board: Board | null = null;
let statusTimer = 0;
let littlefsWasm: ArrayBuffer | null = null;
const firmwareCache = new Map<string, Uint8Array>();

async function fetchBytes(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadProject() {
  const names: string[] = await (await fetch('project/files.json')).json();
  files = await Promise.all(
    names.map(async (name) => ({ name, content: await (await fetch(`project/${name}`)).text() })),
  );
  current = Math.max(0, files.findIndex((f) => f.name === 'main.py'));
  renderTabs();
}

function renderTabs() {
  tabs.replaceChildren(
    ...files.map((f, i) => {
      const tab = document.createElement('button');
      tab.textContent = f.name;
      tab.className = i === current ? 'tab active' : 'tab';
      tab.onclick = () => {
        files[current].content = editor.value;
        current = i;
        renderTabs();
      };
      return tab;
    }),
  );
  editor.value = files[current]?.content ?? '';
}

function appendSerial(text: string) {
  const atBottom = serialOut.scrollTop + serialOut.clientHeight >= serialOut.scrollHeight - 4;
  serialOut.textContent += text.replace(/\r\n/g, '\n');
  if (serialOut.textContent!.length > 200_000) serialOut.textContent = serialOut.textContent!.slice(-100_000);
  if (atBottom) serialOut.scrollTop = serialOut.scrollHeight;
}

function setLed(on: boolean) {
  led.classList.toggle('on', on);
}

function stop() {
  board?.stop();
  board = null;
  clearInterval(statusTimer);
  setLed(false);
  runButton.disabled = false;
  stopButton.disabled = true;
  serialIn.disabled = true;
  statusText.textContent = 'Stopped';
}

async function run() {
  stop();
  files[current].content = editor.value;
  runButton.disabled = true;
  serialOut.textContent = '';
  statusText.textContent = 'Loading firmware…';

  try {
    const name = firmwareSelect.value;
    if (!firmwareCache.has(name)) firmwareCache.set(name, await fetchBytes(`firmware/${name}`));
    littlefsWasm ??= (await fetchBytes('littlefs.wasm')).buffer as ArrayBuffer;
    board = await Board.create(firmwareCache.get(name)!, boardKindFromFirmware(name), files, littlefsWasm);
  } catch (e) {
    statusText.textContent = `Error: ${(e as Error).message}`;
    runButton.disabled = false;
    return;
  }

  const b = board;
  b.onSerial = appendSerial;
  b.pin(LED_PIN).addListener(() => setLed(b.pin(LED_PIN).outputValue && b.pin(LED_PIN).outputEnable));
  b.start();

  stopButton.disabled = false;
  serialIn.disabled = false;
  statusTimer = window.setInterval(() => {
    const simS = b.sim.clock.nanos / 1e9;
    statusText.textContent = `Running · ${simS.toFixed(1)} s simulated · ${Math.round(b.speed * 100)}% of real time`;
  }, 250);
}

function pressButton(down: boolean) {
  button.classList.toggle('down', down);
  board?.pin(BUTTON_PIN).setInputValue(!down); // to GND when pressed, pull-up otherwise
}

button.addEventListener('pointerdown', (e) => {
  button.setPointerCapture(e.pointerId);
  pressButton(true);
});
button.addEventListener('pointerup', () => pressButton(false));
button.addEventListener('pointercancel', () => pressButton(false));

serialIn.addEventListener('keydown', (e) => {
  if (!board) return;
  if (e.key === 'Enter') {
    board.send(serialIn.value + '\r');
    serialIn.value = '';
  } else if (e.key === 'c' && e.ctrlKey) {
    board.send('\x03');
    e.preventDefault();
  }
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    editor.setRangeText('    ', editor.selectionStart, editor.selectionEnd, 'end');
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
});

runButton.onclick = run;
stopButton.onclick = stop;

loadProject().catch((e) => (statusText.textContent = `Could not load project: ${e.message}`));
