// Boots MicroPython in Node, uploads project/, and checks the program really runs.
// Usage: npx tsx test/headless.ts [--firmware RPI_PICO_W-20231227-v1.22.0.uf2] [--seconds 4]
import { readFileSync, readdirSync } from 'node:fs';
import { Board } from '../src/board.js';
import { boardKindFromFirmware } from '../src/fs.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const firmwareName = arg('--firmware', 'RPI_PICO-20231227-v1.22.0.uf2');
const seconds = Number(arg('--seconds', '4'));

const files = readdirSync('project').map((name) => ({ name, content: readFileSync(`project/${name}`, 'utf8') }));
const board = await Board.create(
  readFileSync(`public/firmware/${firmwareName}`),
  boardKindFromFirmware(firmwareName),
  files,
  readFileSync('node_modules/littlefs/dist/littlefs.wasm'),
);
board.onSerial = (t) => process.stdout.write(t);

// Count real toggles only (Low <-> High), not the Input -> Output setup transitions.
let ledToggles = 0;
board.pin(16).addListener((state, old) => {
  if ((state === 0 || state === 1) && (old === 0 || old === 1)) ledToggles++;
});

const fail = (msg: string) => {
  console.error(`\nFAIL (${firmwareName}): ${msg}`);
  process.exit(1);
};

const t0 = performance.now();
board.start();
try {
  await board.waitFor('main.py is running', 30000);
} catch (e) {
  fail((e as Error).message);
}
console.log(`\n[boot took ${((performance.now() - t0) / 1000).toFixed(1)} s]`);

// Press the button half way through.
setTimeout(() => board.pin(14).setInputValue(false), (seconds * 1000) / 2);
setTimeout(() => board.pin(14).setInputValue(true), (seconds * 1000) / 2 + 300);

setTimeout(() => {
  board.stop();
  const simS = board.sim.clock.nanos / 1e9;
  console.log(`\n[simulated ${simS.toFixed(1)} s, LED toggled ${ledToggles}x, speed ~${board.speed.toFixed(2)}x]`);
  // main.py toggles every 500 ms of simulated time.
  const expected = Math.floor(simS / 0.5); // first toggle at t=0 is a setup Low->High
  if (ledToggles < expected - 1 || ledToggles > expected + 2) fail(`expected ~${expected} LED toggles`);
  console.log(`PASS (${firmwareName})`);
  process.exit(0);
}, seconds * 1000);
