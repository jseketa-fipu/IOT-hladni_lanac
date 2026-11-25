// Browser UI: loads firmware and project files from this site, runs the board,
// draws the circuit from diagram.json and wires up the serial monitor.

import { Board, type ProjectFile } from './board.js';
import { Circuit, type Diagram } from './circuit.js';
import { boardKindFromFirmware } from './fs.js';
import staticVersion from 'virtual:static-version';

const DIAGRAM = 'diagram.json';
// Survive dev-server live reloads: which tab/firmware was open and whether it was running.
const SESSION = { autorun: 'pico-sim:autorun', tab: 'pico-sim:tab', firmware: 'pico-sim:firmware' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const firmwareSelect = $<HTMLSelectElement>('firmware');
const runButton = $<HTMLButtonElement>('run');
const stopButton = $<HTMLButtonElement>('stop');
const statusText = $('status');
const tabs = $('tabs');
const editor = $<HTMLTextAreaElement>('editor');
const serialOut = $('serial');
const serialIn = $<HTMLInputElement>('serial-input');
const stage = $('circuit');

let files: ProjectFile[] = [];
let current = 0;
let board: Board | null = null;
let circuit: Circuit | null = null;
let circuitSource = '';
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
    names.map(async (name) => ({
      name,
      content: await (await fetch(`project/${name}`, { cache: 'no-cache' })).text(),
    })),
  );
  const byName = (name: string | null) => files.findIndex((f) => f.name === name);
  const saved = byName(sessionStorage.getItem(SESSION.tab));
  current = saved >= 0 ? saved : Math.max(0, byName('main.py'));
  renderTabs();
  drawCircuit();
}

/** (Re)draw the circuit when diagram.json changed. Returns false on invalid JSON. */
function drawCircuit(): boolean {
  const source = files.find((f) => f.name === DIAGRAM)?.content ?? '';
  if (circuit && source === circuitSource) return true;
  let diagram: Diagram;
  try {
    diagram = JSON.parse(source);
  } catch (e) {
    statusText.textContent = `${DIAGRAM}: ${(e as Error).message}`;
    return false;
  }
  circuit?.detach();
  circuit = new Circuit(stage, diagram);
  circuitSource = source;
  return true;
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
        sessionStorage.setItem(SESSION.tab, f.name);
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

function stop() {
  board?.stop();
  board = null;
  circuit?.detach();
  clearInterval(statusTimer);
  runButton.disabled = false;
  stopButton.disabled = true;
  serialIn.disabled = true;
  statusText.textContent = 'Stopped';
}

async function run() {
  stop();
  files[current].content = editor.value;
  if (!drawCircuit()) return;
  runButton.disabled = true;
  serialOut.textContent = '';
  serialOut.classList.remove('empty');
  statusText.textContent = 'Loading firmware…';

  try {
    const name = firmwareSelect.value;
    if (!firmwareCache.has(name)) firmwareCache.set(name, await fetchBytes(`firmware/${name}`));
    littlefsWasm ??= (await fetchBytes('littlefs.wasm')).buffer as ArrayBuffer;
    const boardFiles = files.filter((f) => f.name !== DIAGRAM);
    board = await Board.create(firmwareCache.get(name)!, boardKindFromFirmware(name), boardFiles, littlefsWasm);
  } catch (e) {
    statusText.textContent = `Error: ${(e as Error).message}`;
    runButton.disabled = false;
    return;
  }

  const b = board;
  b.onSerial = appendSerial;
  circuit!.attach(b);
  b.start();

  stopButton.disabled = false;
  serialIn.disabled = false;
  statusTimer = window.setInterval(() => {
    const simS = b.sim.clock.nanos / 1e9;
    statusText.textContent = `Running · ${simS.toFixed(1)} s simulated · ${Math.round(b.speed * 100)}% of real time`;
  }, 250);
}

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

const savedFirmware = sessionStorage.getItem(SESSION.firmware);
if (savedFirmware && [...firmwareSelect.options].some((o) => o.value === savedFirmware)) firmwareSelect.value = savedFirmware;
firmwareSelect.onchange = () => sessionStorage.setItem(SESSION.firmware, firmwareSelect.value);

if (__DEV__) {
  // Live reload from `npm run dev`: esbuild signals a rebuild (src/, project/ or public/ changed).
  // Edits made in the page editor are not saved to disk and are lost on reload.
  new EventSource('/esbuild').addEventListener('change', () => {
    sessionStorage.setItem(SESSION.autorun, board ? '1' : '');
    location.reload();
  });
  console.debug(`pico-sim dev build, static version ${staticVersion}`);
}

loadProject()
  .then(() => {
    if (__DEV__ && sessionStorage.getItem(SESSION.autorun) === '1') {
      sessionStorage.removeItem(SESSION.autorun);
      statusText.textContent = 'Reloaded after a file change, restarting…';
      run();
    }
  })
  .catch((e) => (statusText.textContent = `Could not load project: ${e.message}`));
