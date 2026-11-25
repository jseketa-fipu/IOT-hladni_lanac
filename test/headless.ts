// Boots the real project (project/*.py + the parts of project/diagram.json) in Node at
// real-time speed, prints the serial output for N seconds and checks the program runs:
// startup message, at least one measurement with a temperature, real-time pacing, and
// that serial input still reaches the REPL afterwards.
// Usage: npx tsx test/headless.ts [--firmware RPI_PICO_W-20231227-v1.22.0.uf2] [--seconds 12] [--temp 5.5]
import { bootSystem } from './helpers.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const firmwareName = arg('--firmware', 'RPI_PICO_W-20231227-v1.22.0.uf2');
const seconds = Number(arg('--seconds', '12'));
const temp = Number(arg('--temp', '5.5'));

const { board, system } = await bootSystem({ firmware: firmwareName, temperatures: { temp1: temp } });
if (system.warnings.length) console.log(`[diagram warnings: ${system.warnings.join('; ')}]`);
board.onSerial = (t) => process.stdout.write(t);

const fail = (msg: string) => {
  console.error(`\nFAIL (${firmwareName}): ${msg}`);
  process.exit(1);
};

const t0 = performance.now();
board.start();
try {
  await board.waitFor('[START] Nadzor hladnog lanca', 30000);
} catch (e) {
  fail((e as Error).message);
}
console.log(`\n[boot took ${((performance.now() - t0) / 1000).toFixed(1)} s]`);

setTimeout(async () => {
  const out = board.output;
  // Serial input still reaches MicroPython: interrupt main.py and use the REPL.
  const answer = board.waitFor('42', 5000);
  board.send('\x03');
  await board.waitFor('>>> ', 5000).catch(() => fail('no REPL prompt after Ctrl+C'));
  board.send('print(6*7)\r');
  await answer.catch(() => fail('REPL did not answer'));
  board.stop();

  const simS = board.sim.clock.nanos / 1e9;
  const rows = [...out.matchAll(/\[MJERENJE\] .* \| (-?\d+\.\d\d) C \| /g)].map((m) => Number(m[1]));
  console.log(`\n[simulated ${simS.toFixed(1)} s, ${rows.length} measurements, speed ~${board.speed.toFixed(2)}x]`);
  if (out.includes('Traceback')) fail('the program raised an exception');
  if (!rows.length) fail('no [MJERENJE] line with a temperature');
  if (rows.some((t) => t !== temp)) fail(`measured ${rows.join(', ')}, the sensor was set to ${temp}`);
  if (board.speed < 0.9) fail(`too slow: ${board.speed.toFixed(2)}x real time`);
  console.log(`PASS (${firmwareName})`);
  process.exit(0);
}, seconds * 1000);
