// `npm run test:watch`: reruns tests whenever you save a file.
//   test/*.test.ts changed   -> only that test file
//   test/python or project/*.py changed -> Python logic tests, then simulation tests
//   src/ or project/diagram.json changed -> simulation tests
// Press Enter to rerun everything, Ctrl+C to quit.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

const SIM = ['--import', 'tsx', '--test', '--test-reporter=spec'];
let running = null;
let pending = null;
let timer = null;

function steps(changed) {
  const testFile = [...changed].find((f) => /^test[\\/][^\\/]+\.test\.ts$/.test(f));
  if (changed.size === 1 && testFile) return [['node', [...SIM, testFile]]];
  const py = [...changed].some((f) => f.endsWith('.py'));
  const all = ['node', [...SIM, 'test/**/*.test.ts']];
  return py ? [['node', ['scripts/test-python.mjs']], all] : [all];
}

function run(changed) {
  if (running) {
    pending = new Set([...(pending ?? []), ...changed]);
    running.kill();
    return;
  }
  const queue = steps(changed);
  console.clear();
  console.log(`\x1b[36m▶ ${changed.size ? [...changed].join(', ') : 'all tests'}\x1b[0m\n`);
  const started = Date.now();
  const next = (ok) => {
    const step = queue.shift();
    if (pending) {
      // A newer change arrived while running: start over with it.
      running = null;
      const again = pending;
      pending = null;
      run(again);
      return;
    }
    if (!step || !ok) {
      running = null;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(ok ? `\n\x1b[32m✔ all passed (${secs} s)\x1b[0m` : `\n\x1b[31m✖ failed (${secs} s)\x1b[0m`);
      console.log('\x1b[2mwatching src/, project/, test/ … Enter = rerun all, Ctrl+C = quit\x1b[0m');
      return;
    }
    running = spawn(step[0], step[1], { stdio: 'inherit', shell: false });
    running.on('exit', (code) => next(code === 0));
  };
  next(true);
}

let changed = new Set();
const onChange = (dir) => (_event, file) => {
  const name = String(file ?? '');
  // Only real source files: skip folders, editor temp/backup files, caches and probes.
  if (!/\.(ts|mjs|py|json)$/.test(name) || /__pycache__|_probe|\.tmp|~$/.test(name)) return;
  changed.add(`${dir}/${String(file).replace(/\\/g, '/')}`);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const batch = changed;
    changed = new Set();
    run(batch);
  }, 200);
};

for (const dir of ['src', 'project', 'test']) watch(dir, { recursive: true }, onChange(dir));
process.stdin.on('data', () => run(new Set()));
run(new Set());
