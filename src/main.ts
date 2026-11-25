// Browser UI: loads firmware and project files from this site, runs the board,
// draws the circuit from diagram.json with its parts panel and wires up the serial monitor.

import { Board, type ProjectFile } from './board.js';
import { Circuit, type Diagram } from './circuit.js';
import { Controls, FileViewer } from './controls.js';
import { boardKindFromFirmware } from './fs.js';
import staticVersion from 'virtual:static-version';

const DIAGRAM = 'diagram.json';
// Survive dev-server live reloads: which tab/firmware was open and whether it was running.
const SESSION = { autorun: 'pico-sim:autorun', tab: 'pico-sim:tab', firmware: 'pico-sim:firmware', speed: 'pico-sim:speed' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const firmwareSelect = $<HTMLSelectElement>('firmware');
const speedSelect = $<HTMLSelectElement>('speed');
const runButton = $<HTMLButtonElement>('run');
const stopButton = $<HTMLButtonElement>('stop');
const statusText = $('status');
const tabs = $('tabs');
const editor = $<HTMLTextAreaElement>('editor');
const serialOut = $('serial');
const serialIn = $<HTMLInputElement>('serial-input');
const serialFollow = $<HTMLInputElement>('serial-follow');
const stage = $('circuit');
const controlsPanel = $('controls');
const viewer = new FileViewer(
  $<HTMLDialogElement>('file-view'),
  $('file-view-title'),
  $('file-view-body'),
  $<HTMLButtonElement>('file-view-download'),
);

let files: ProjectFile[] = [];
let current = 0;
let board: Board | null = null;
let circuit: Circuit | null = null;
let controls: Controls | null = null;
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

/**
 * (Re)draw the circuit and its parts panel when diagram.json changed. Returns false on invalid JSON.
 * An unchanged diagram keeps its CircuitSystem, so part settings and card files survive a new Run.
 */
function drawCircuit(): boolean {
  const source = files.find((f) => f.name === DIAGRAM)?.content ?? '';
  if (circuit && source === circuitSource) return true;
  let diagram: Diagram;
  try {
    diagram = JSON.parse(source);
  } catch (e) {
    setStatus(`${DIAGRAM}: ${(e as Error).message}`, 'error');
    return false;
  }
  circuit?.dispose();
  controls?.dispose();
  circuit = null;
  controls = null;
  try {
    circuit = new Circuit(stage, diagram);
    controls = new Controls(controlsPanel, circuit.system, viewer);
  } catch (e) {
    setStatus(`${DIAGRAM}: ${(e as Error).message}`, 'error');
    return false;
  }
  circuitSource = source;
  for (const w of circuit.system.warnings) console.warn(`diagram.json: ${w}`);
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
  serialOut.textContent += text.replace(/\r\n/g, '\n');
  if (serialOut.textContent!.length > 200_000) serialOut.textContent = serialOut.textContent!.slice(-100_000);
  if (serialFollow.checked) serialOut.scrollTop = serialOut.scrollHeight;
}

/** Header status text; `state` colours the dot in front of it (see .status in style.css). */
function setStatus(text: string, state: 'idle' | 'busy' | 'running' | 'error' = 'idle') {
  statusText.textContent = text;
  statusText.dataset.state = state;
}

// Scrolling up to read turns auto-scroll off; scrolling back to the end turns it on again.
serialOut.addEventListener('scroll', () => {
  serialFollow.checked = serialOut.scrollTop + serialOut.clientHeight >= serialOut.scrollHeight - 4;
});
serialFollow.onchange = () => {
  if (serialFollow.checked) serialOut.scrollTop = serialOut.scrollHeight;
};
$('serial-clear').onclick = () => {
  if (!serialOut.classList.contains('empty')) serialOut.textContent = '';
};
$('serial-copy').onclick = async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  const text = serialOut.classList.contains('empty') ? '' : (serialOut.textContent ?? '');
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => (button.textContent = 'Copy'), 1200);
};

// Clicking a sensor, card or clock in the circuit brings up its card in the Parts panel.
stage.addEventListener('part-select', (e) => {
  const id = (e as CustomEvent<string>).detail;
  const card = [...controlsPanel.querySelectorAll<HTMLElement>('.part-card')].find(
    (c) => c.querySelector('.part-id')?.textContent === id,
  );
  if (!card) return;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.querySelector<HTMLElement>('input[type=number], input[type=datetime-local], input[type=checkbox]')?.focus({ preventScroll: true });
  card.classList.remove('flash');
  void card.offsetWidth; // restart the highlight animation
  card.classList.add('flash');
});

// Every run() and stop() starts a new "run": a run() that is still loading (awaiting the
// firmware or Board.create) checks this after each await and gives up if it has been
// superseded, so a quick second Run (Ctrl+Enter twice, live-reload autorun) or a Stop
// can never leave an orphaned board running in the background.
let runSeq = 0;

function stop() {
  runSeq++;
  board?.stop();
  board = null;
  circuit?.detach();
  clearInterval(statusTimer);
  runButton.disabled = false;
  stopButton.disabled = true;
  serialIn.disabled = true;
  setStatus('Stopped');
}

async function run() {
  stop();
  const token = runSeq;
  files[current].content = editor.value;
  if (!drawCircuit()) return;
  runButton.disabled = true;
  serialOut.textContent = '';
  serialOut.classList.remove('empty');
  serialFollow.checked = true;
  setStatus('Loading firmware…', 'busy');

  let b: Board;
  try {
    const name = firmwareSelect.value;
    if (!firmwareCache.has(name)) firmwareCache.set(name, await fetchBytes(`firmware/${name}`));
    littlefsWasm ??= (await fetchBytes('littlefs.wasm')).buffer as ArrayBuffer;
    const boardFiles = files.filter((f) => f.name !== DIAGRAM);
    b = await Board.create(firmwareCache.get(name)!, boardKindFromFirmware(name), boardFiles, littlefsWasm);
  } catch (e) {
    if (token !== runSeq) return; // superseded: the newer run owns the status
    setStatus(`Error: ${(e as Error).message}`, 'error');
    runButton.disabled = false;
    return;
  }
  if (token !== runSeq) return; // a newer run() or a stop() came in while loading; b was never started

  board = b;
  b.onSerial = appendSerial;
  circuit!.attach(b);
  b.timeScale = Number(speedSelect.value);
  b.start();

  stopButton.disabled = false;
  serialIn.disabled = false;
  statusTimer = window.setInterval(() => {
    const simS = b.sim.clock.nanos / 1e9;
    setStatus(`Running · ${formatSimTime(simS)} simulated · ${speedText(b)}`, 'running');
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

const savedSpeed = sessionStorage.getItem(SESSION.speed);
if (savedSpeed && [...speedSelect.options].some((o) => o.value === savedSpeed)) speedSelect.value = savedSpeed;
speedSelect.onchange = () => {
  sessionStorage.setItem(SESSION.speed, speedSelect.value);
  if (board) board.timeScale = Number(speedSelect.value); // applies at once, also while running
};

/** "42.3 s" below two minutes, "2 min 10 s" above. */
function formatSimTime(s: number) {
  if (s < 120) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.floor(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** At 1×: "100% of real time". Faster: the requested speed, plus what is achieved if it falls short. */
function speedText(b: Board) {
  const target = b.timeScale;
  if (target === 1) return `${Math.round(b.speed * 100)}% of real time`;
  const achieved = b.speed;
  // Booting MicroPython and finding the parts takes real CPU time; judge the speed after that.
  if (b.simMs < 3000) return target >= 1000 ? 'max speed, starting' : `${target}×, starting`;
  if (target >= 1000) return `max speed, ${achieved.toFixed(1)}× real time`;
  return achieved >= target * 0.9 ? `${target}× real time` : `${target}× requested, reaching ${achieved.toFixed(1)}×`;
}

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
      setStatus('Reloaded after a file change, restarting…', 'busy');
      run();
    }
  })
  .catch((e) => setStatus(`Could not load project: ${e.message}`, 'error'));
