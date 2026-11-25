// Runs the CPython unit tests in test/python (logic of the MicroPython program).
import { spawnSync } from 'node:child_process';

const args = ['-m', 'unittest', 'discover', '-s', 'test/python', '-v'];
for (const python of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
  const r = spawnSync(python, args, { stdio: 'inherit' });
  if (r.error?.code === 'ENOENT') continue;
  process.exit(r.status ?? 1);
}
console.error('No Python interpreter found (set PYTHON=...)');
process.exit(1);
