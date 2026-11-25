// npm run sim (scripts/sim.ts) run as a child process, the way a person runs it:
// exit codes, the live timestamped output, the summary and the checks.
// Run alone: node --import tsx --test test/sim-cli.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ROOT } from './helpers.js';

function sim(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'sim.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('npm run sim', () => {
  test('scenario file: alarm after 2 min, button summary, checks pass, SD dump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-sim-cli-'));
    try {
      const scenario = join(dir, 'alarm.json');
      writeFileSync(scenario, JSON.stringify({
        temp: 5,
        for: '2m50s',
        timeline: [{ at: '10s', do: 'temp=10' }, { at: '2m40s', do: ['press'] }],
        expect: ['[ALARM] temperatura 10.00 C', '[SAZETAK]'],
        expectLed: { led1: 'off' }, // the press acknowledges the alarm
      }));
      const { code, out, err } = sim(scenario, '--sd-dump', join(dir, 'card'));
      assert.equal(code, 0, `exit code, stdout:\n${out}\nstderr:\n${err}`);
      assert.doesNotMatch(out, /\x1b\[/, 'no colours when stdout is not a TTY');
      // Live output: each line starts with the simulated time; actions are logged.
      assert.match(out, /^00:00:01\.\d{3} {2}\[MJERENJE\] 2026-11-17 10:00:01 \| 5\.00 C \| U_RASPONU$/m);
      assert.match(out, /^00:00:10\.000 {2}>> temp=10$/m);
      assert.match(out, /^00:02:\d\d\.\d{3} {2}\[ALARM\] temperatura 10\.00 C/m);
      assert.match(out, /^00:02:40\.000 {2}>> press$/m);
      // Summary.
      assert.match(out, /simulated 2 min 50 s in /);
      assert.match(out, /LEDs: led1 off/);
      assert.match(out, /alarm messages \(1\):\n {2}\[ALARM\] temperatura 10\.00 C/);
      assert.match(out, /hladnjaca\.csv {2}\d+ B\n.*,10\.00,ALARM/);
      assert.match(out, /all checks passed/);
      const csv = readFileSync(join(dir, 'card', 'hladnjaca.csv'), 'utf8');
      assert.match(csv, /^datum_vrijeme,temperatura_c,stanje\n2026-11-17 10:00:01,5\.00,U_RASPONU\n/);
      assert.match(csv, /,10\.00,ALARM\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed checks exit 1 and say what was missing', () => {
    const { code, out } = sim('--sd', 'out', '--for', '5s', '--quiet', '--expect', 'kartica montirana', '--expect-led', 'led1=on');
    assert.equal(code, 1, out);
    assert.doesNotMatch(out, /\[START\]/, '--quiet prints only the summary');
    assert.match(out, /SD sd1 \(not inserted\): no files/);
    assert.match(out, /FAIL\n {2}expected "kartica montirana" in the output, it was never printed\n {2}expected led1 on, it is off/);
  });

  test('--until stops early; a missing --until text fails', () => {
    const hit = sim('--quiet', '--temp', '-3', '--until', '| -3.00 C', '--for', '1m');
    assert.equal(hit.code, 0, hit.out);
    assert.match(hit.out, /simulated 1\.\d s in .*, stopped at "\| -3\.00 C"/);
    const miss = sim('--quiet', '--until', 'nikad', '--for', '3s');
    assert.equal(miss.code, 1, miss.out);
    assert.match(miss.out, /--until "nikad" was not printed within 3\.0 s/);
  });

  test('command-line mistakes exit 2 with a short usage, before booting', () => {
    for (const [args, message] of [
      [['--bogus'], 'unknown option --bogus'],
      [['--at', '30s', 'jump'], 'unknown action "jump"'],
      [['--at', '3x', 'temp=1'], 'bad duration "3x"'],
      [['--at', '1m', 'press:nope'], '"press:nope": no pushbutton "nope" in diagram.json (have: btn1)'],
      [['--rtc', '25.11.2026'], 'bad RTC time "25.11.2026"'],
    ] as [string[], string][]) {
      const { code, out, err } = sim(...args);
      assert.equal(code, 2, `${args.join(' ')}: ${err}`);
      assert.equal(out, '', `${args.join(' ')} must not start the simulation`);
      assert.ok(err.includes(`sim: ${message}`), `${args.join(' ')}: ${err}`);
      assert.match(err, /Usage: npm run sim --/);
    }
  });
});
