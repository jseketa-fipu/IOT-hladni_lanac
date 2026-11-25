// npm run sim: run the real project (project/*.py + project/diagram.json, real MicroPython,
// all part models) from the command line, in fast-forward, following a timeline of
// actions. Prints the serial output live with simulated timestamps, then a summary.
//
//   npm run sim -- --for 3m --temp 10
//   npm run sim -- --temp 5 --at 30s temp=10 --at 3m30s temp=5 --at 4m press --for 5m
//   npm run sim -- --rtc "2026-11-25 23:58:00" --for 4m
//   npm run sim -- scenario.json [more flags]
//
// A scenario file is JSON with the same options as the flags (see USAGE below); it is
// turned into flags, so flags given after it add to it / override it.
// Times on the timeline are simulated time since power-on. Exit code: 0 ok, 1 an
// --expect / --expect-led / --until check failed, 2 bad command line.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CircuitSystem } from '../src/system.js';
import { DEFAULT_RTC_START, bootBoard, projectDiagram, projectFiles } from '../test/helpers.js';

const USAGE = `Usage: npm run sim -- [scenario.json] [options]

Runs project/*.py with project/diagram.json on the simulated Pico (fast-forward).

Initial conditions (before power-on):
  --temp <C> | <id>=<C>     DS18B20 temperature (default: diagram attrs.temperature)
  --rtc "YYYY-MM-DD HH:MM:SS"   DS1307 start time (default 2026-11-17 10:00:00)
  --sd in|out               microSD card inserted (default in)
  --sensor on|off           DS18B20 connected (default on)
  --firmware picow|pico     MicroPython build (default picow)

Timeline:
  --at <time> <action> [<action>...]   do actions at a simulated time, e.g. --at 30s temp=10
  Actions:  temp=<C>  temp:<id>=<C>   sensor=off|on   sd=out|in
            press  press:<button>  (300 ms)    hold:<button>=<duration>  hold=<duration>
            rtc="YYYY-MM-DD HH:MM:SS"   send="text"  (serial input; \\r \\n \\x03 escapes)

Run and checks:
  --for <duration>          total simulated time (default: last action + 30s, at least 1m)
  --until "<text>"          stop as soon as text is printed (fails if it never is)
  --expect "<text>"         fail (exit 1) if text was never printed; repeatable
  --expect-led <id>=on|off  fail if the LED is not in that state at the end; repeatable
  --quiet                   print only the summary
  --sd-dump <dir>           copy the SD card's files into a folder at the end
  --realtime                pace at real time instead of fast-forward
  -h, --help                this text

Durations: 500ms, 90s, 3m, 3m30s, 1h (a bare number is seconds).
Scenario file (JSON): { "temp": 5, "rtc": "...", "sd": "in", "sensor": "on", "firmware": "picow",
  "for": "5m", "until": "...", "expect": ["..."], "expectLed": { "led1": "off" },
  "timeline": [ { "at": "30s", "do": "temp=10" }, { "at": "4m", "do": ["press"] } ] }`;

/** Shown after a command-line error (the full text is --help). */
const SHORT_USAGE = `Usage: npm run sim -- [scenario.json] [--temp C] [--rtc "YYYY-MM-DD HH:MM:SS"] [--sd in|out]
         [--at <time> <action>...] [--for <time>] [--until text] [--expect text]
         [--expect-led id=on|off] [--quiet] [--sd-dump dir] [--realtime]
Run "npm run sim -- --help" for all options and actions.`;

class UsageError extends Error {}

// ---------------------------------------------------------------- parsing helpers

/** "3m30s" -> 210000 ms. */
function parseDuration(text: string): number {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let ms = 0;
  const rest = text.replace(/(\d+(?:\.\d+)?)(ms|h|m|s)/g, (_, n: string, unit: string) => {
    ms += Number(n) * units[unit];
    return '';
  });
  if (rest !== '' || text === '') throw new UsageError(`bad duration "${text}" (use e.g. 500ms, 90s, 3m30s, 1h)`);
  return ms;
}

/** "2026-11-25 23:58:00" -> Date whose UTC fields are the clock fields. */
function parseRtc(text: string): Date {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/.exec(text.trim());
  if (!m) throw new UsageError(`bad RTC time "${text}" (use "YYYY-MM-DD HH:MM:SS")`);
  const [y, mo, d, h, mi, s = '0'] = m.slice(1).map((v) => v ?? '0');
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  // Reject 2026-02-30 and friends (Date would roll them over) and years the DS1307 can't hold.
  if (date.getUTCDate() !== +d || date.getUTCHours() !== +h || +mi > 59 || +s > 59) throw new UsageError(`bad RTC time "${text}"`);
  if (+y < 2000 || +y > 2099) throw new UsageError(`RTC time "${text}": the DS1307 holds years 2000-2099`);
  return date;
}

function parseTemp(text: string): number {
  const c = Number(text);
  if (text.trim() === '' || !Number.isFinite(c)) throw new UsageError(`bad temperature "${text}"`);
  return c;
}

function onOff(text: string, on: string, off: string, what: string): boolean {
  if (text === on) return true;
  if (text === off) return false;
  throw new UsageError(`${what} must be ${on} or ${off}, got "${text}"`);
}

/** "send" text: turn \r \n \t \xNN escapes into characters. */
function unescape(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|r|n|t|\\)/g, (_, e: string) =>
    e === 'r' ? '\r' : e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : String.fromCharCode(parseInt(e.slice(1), 16)));
}

// ---------------------------------------------------------------- actions

interface Action {
  /** As typed, for the log. */
  text: string;
  name: string;
  /** Part id, or undefined = the default / all parts of that type. */
  id?: string;
  value?: string;
}

const ACTIONS = ['temp', 'sensor', 'sd', 'press', 'hold', 'rtc', 'send'];

function parseAction(text: string): Action {
  const m = /^([a-z]+)(?::([\w-]+))?(?:=([\s\S]*))?$/.exec(text);
  if (!m || !ACTIONS.includes(m[1])) {
    throw new UsageError(`unknown action "${text}" (actions: temp=, sensor=, sd=, press, hold:<id>=, rtc=, send=)`);
  }
  const [, name, id, raw] = m;
  // Shells usually strip the quotes of rtc="..." / send="...", but a scenario file may keep them.
  const value = raw?.replace(/^"([\s\S]*)"$/, '$1');
  const needsValue = name !== 'press';
  if (needsValue && value === undefined) throw new UsageError(`action "${text}" needs a value, e.g. ${name}=...`);
  if (!needsValue && value !== undefined) throw new UsageError(`action "${text}" takes no value (press or press:<button>)`);
  // Validate values now so a typo fails before a long run.
  if (name === 'temp') parseTemp(value!);
  if (name === 'sensor') onOff(value!, 'on', 'off', 'sensor');
  if (name === 'sd') onOff(value!, 'in', 'out', 'sd');
  if (name === 'hold') parseDuration(value!);
  if (name === 'rtc') parseRtc(value!);
  return { text, name, id, value };
}

// ---------------------------------------------------------------- command line

interface Options {
  firmware: string;
  rtc?: Date;
  initial: Action[];
  timeline: { at: number; action: Action }[];
  forMs?: number;
  until?: string;
  expect: string[];
  expectLed: [string, boolean][];
  quiet: boolean;
  sdDump?: string;
  realtime: boolean;
}

const FIRMWARES: Record<string, string> = {
  picow: 'RPI_PICO_W-20231227-v1.22.0.uf2',
  pico: 'RPI_PICO-20231227-v1.22.0.uf2',
};

/** A scenario file turned into the equivalent flags. */
function scenarioArgs(path: string): string[] {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read scenario ${path}: ${(e as Error).message}`);
  }
  const args: string[] = [];
  const known = ['temp', 'rtc', 'sd', 'sensor', 'firmware', 'for', 'until', 'expect', 'expectLed', 'timeline', 'quiet', 'realtime', 'sdDump'];
  for (const key of Object.keys(s)) if (!known.includes(key)) throw new UsageError(`${path}: unknown key "${key}" (known: ${known.join(', ')})`);
  for (const key of ['temp', 'rtc', 'sd', 'sensor', 'firmware', 'for', 'until']) {
    if (s[key] !== undefined) args.push(`--${key}`, String(s[key]));
  }
  if (s.sdDump !== undefined) args.push('--sd-dump', String(s.sdDump));
  if (s.quiet) args.push('--quiet');
  if (s.realtime) args.push('--realtime');
  for (const text of [s.expect ?? []].flat()) args.push('--expect', String(text));
  for (const [id, state] of Object.entries((s.expectLed ?? {}) as Record<string, string>)) args.push('--expect-led', `${id}=${state}`);
  for (const step of (s.timeline ?? []) as { at?: unknown; do?: unknown }[]) {
    if (step.at === undefined || step.do === undefined) throw new UsageError(`${path}: each timeline step needs "at" and "do"`);
    args.push('--at', String(step.at), ...[step.do].flat().map(String));
  }
  return args;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { firmware: FIRMWARES.picow, initial: [], timeline: [], expect: [], expectLed: [], quiet: false, realtime: false };
  if (argv[0] && !argv[0].startsWith('-')) argv = [...scenarioArgs(argv[0]), ...argv.slice(1)];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
      case '--temp': {
        const v = value();
        o.initial.push(parseAction(v.includes('=') ? `temp:${v}` : `temp=${v}`));
        break;
      }
      case '--rtc':
        o.rtc = parseRtc(value());
        break;
      case '--sd':
        o.initial.push(parseAction(`sd=${value()}`));
        break;
      case '--sensor':
        o.initial.push(parseAction(`sensor=${value()}`));
        break;
      case '--firmware': {
        const v = value();
        o.firmware = FIRMWARES[v.toLowerCase().replace(/[^a-z]/g, '')] ?? v;
        if (!o.firmware.endsWith('.uf2')) throw new UsageError(`--firmware must be picow or pico, got "${v}"`);
        break;
      }
      case '--at': {
        const at = parseDuration(value());
        const start = i;
        while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o.timeline.push({ at, action: parseAction(argv[++i]) });
        if (i === start) throw new UsageError(`--at ${argv[i]} needs at least one action, e.g. --at 30s temp=10`);
        break;
      }
      case '--for':
        o.forMs = parseDuration(value());
        break;
      case '--until':
        o.until = value();
        break;
      case '--expect':
        o.expect.push(value());
        break;
      case '--expect-led': {
        const v = value();
        const m = /^([\w-]+)=(on|off)$/.exec(v);
        if (!m) throw new UsageError(`--expect-led needs <id>=on|off, got "${v}"`);
        o.expectLed.push([m[1], m[2] === 'on']);
        break;
      }
      case '--quiet':
        o.quiet = true;
        break;
      case '--sd-dump':
        o.sdDump = value();
        break;
      case '--realtime':
        o.realtime = true;
        break;
      default:
        throw new UsageError(flag.startsWith('-') ? `unknown option ${flag}` : `unexpected "${flag}" (actions go after --at <time>)`);
    }
  }
  return o;
}

// ---------------------------------------------------------------- output

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const red = paint('1;31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const bold = paint('1');

/** Simulated ms -> "00:03:30.012". */
function stamp(ms: number): string {
  const total = Math.floor(ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(total % 1000, 3)}`;
}

function colourLine(line: string): string {
  if (line.includes('[ALARM KRAJ]')) return green(line);
  if (line.includes('[ALARM') || line.includes('Traceback') || /greska|nije dostup|nije pronaden/.test(line)) return red(line);
  if (line.includes('SAZETAK')) return cyan(line);
  return line;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${((ms % 60_000) / 1000).toFixed(0)} s`;
}

// ---------------------------------------------------------------- main

async function main() {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`sim: ${e.message}\n\n${SHORT_USAGE}`);
    process.exit(2);
  }

  const diagram = projectDiagram();
  const system = new CircuitSystem(diagram, null, { rtcTime: o.rtc ?? DEFAULT_RTC_START });
  const buttons = diagram.parts.filter((p) => p.type === 'wokwi-pushbutton').map((p) => p.id);

  // Which parts an action applies to: the named one, or every part of that kind.
  const targets = (a: Action, all: string[], kind: string): string[] => {
    if (a.id === undefined) {
      if (!all.length) throw new UsageError(`"${a.text}": the diagram has no ${kind}`);
      return a.name === 'press' || a.name === 'hold' ? [all[0]] : all;
    }
    if (!all.includes(a.id)) throw new UsageError(`"${a.text}": no ${kind} "${a.id}" in diagram.json (have: ${all.join(', ') || 'none'})`);
    return [a.id];
  };

  // Turn press / hold into press + release, and check every part id before booting.
  type Step = { at: number; label?: string; run: () => void };
  const steps: Step[] = [];
  const apply = (a: Action): (() => void) => {
    switch (a.name) {
      case 'temp': {
        const ids = targets(a, system.sensorIds, 'DS18B20');
        return () => ids.forEach((id) => system.setTemperature(id, parseTemp(a.value!)));
      }
      case 'sensor': {
        const ids = targets(a, system.sensorIds, 'DS18B20');
        return () => ids.forEach((id) => system.setSensorConnected(id, a.value === 'on'));
      }
      case 'sd': {
        const ids = targets(a, system.cardIds, 'microSD card');
        return () => ids.forEach((id) => system.setCardInserted(id, a.value === 'in'));
      }
      case 'rtc': {
        const ids = targets(a, system.rtcIds, 'DS1307');
        return () => ids.forEach((id) => system.setRtcTime(id, parseRtc(a.value!)));
      }
      case 'send':
        return () => system.board!.send(unescape(a.value!));
      default:
        throw new Error(a.name);
    }
  };
  try {
    for (const a of o.initial) apply(a)(); // settings before attach = initial conditions
    for (const { at, action: a } of o.timeline) {
      if (a.name === 'press' || a.name === 'hold') {
        const [id] = targets(a, buttons, 'pushbutton');
        const holdMs = a.name === 'hold' ? parseDuration(a.value!) : 300;
        steps.push({ at, label: a.text, run: () => system.press(id) });
        steps.push({ at: at + holdMs, run: () => system.release(id) });
      } else {
        steps.push({ at, label: a.text, run: apply(a) });
      }
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`sim: ${e.message}\n\n${SHORT_USAGE}`);
    process.exit(2);
  }
  steps.sort((x, y) => x.at - y.at); // stable: same-time actions keep their order
  const lastAt = steps.length ? steps[steps.length - 1].at : 0;
  const forMs = o.forMs ?? (o.until ? 10 * 60_000 : Math.max(60_000, lastAt + 30_000));
  const late = o.timeline.filter((t) => t.at >= forMs);
  if (late.length) {
    console.error(`sim: --at ${stamp(late[0].at)} ${late[0].action.text} is not before the end of the run (--for ${stamp(forMs)})\n\n${SHORT_USAGE}`);
    process.exit(2);
  }

  const board = await bootBoard(projectFiles(), o.firmware);
  system.attach(board);
  for (const w of system.warnings) console.log(yellow(`[diagram] ${w}`));

  // Live serial output, one timestamp per line (taken when the line starts).
  let line = '';
  let lineAt = 0;
  const flushLine = () => {
    if (!o.quiet) console.log(`${dim(stamp(lineAt))}  ${colourLine(line)}`);
    line = '';
  };
  board.onSerial = (text) => {
    for (const ch of text.replace(/\r/g, '')) {
      if (line === '' ) lineAt = board.simMs;
      if (ch === '\n') flushLine();
      else line += ch;
    }
  };
  const log = (text: string) => {
    if (!o.quiet) console.log(`${dim(stamp(board.simMs))}  ${yellow(`>> ${text}`)}`);
  };

  const wallStart = performance.now();
  const untilFound = () => o.until !== undefined && board.output.includes(o.until);
  const CHUNK_MS = 50;
  /** Run to simulated `target` ms; false if --until was printed first. */
  const runTo = async (target: number): Promise<boolean> => {
    while (board.simMs < target) {
      board.runFor(Math.min(CHUNK_MS, target - board.simMs));
      if (untilFound()) return false;
      if (o.realtime) {
        const ahead = board.simMs - (performance.now() - wallStart);
        if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
      }
    }
    return true;
  };

  let stoppedByUntil = false;
  for (const step of steps) {
    if (step.at > forMs) break;
    if (!(await runTo(step.at))) {
      stoppedByUntil = true;
      break;
    }
    if (step.label) log(step.label);
    step.run();
  }
  if (!stoppedByUntil) stoppedByUntil = !(await runTo(forMs));
  if (line) flushLine();
  const wallMs = performance.now() - wallStart;

  // ---------------------------------------------------------------- summary
  const out = board.output;
  const failures: string[] = [];
  const say = (s = '') => console.log(s);
  say();
  say(bold('---- summary ----'));
  say(`simulated ${formatDuration(board.simMs)} in ${formatDuration(wallMs)} wall time (${(board.simMs / wallMs).toFixed(1)}x)` +
    (stoppedByUntil ? `, stopped at "${o.until}"` : ''));
  if (o.until !== undefined && !stoppedByUntil) failures.push(`--until "${o.until}" was not printed within ${formatDuration(forMs)}`);
  say(`RTC now: ${system.rtcIds.map((id) => `${id} ${system.rtcTime(id).toISOString().slice(0, 19).replace('T', ' ')}`).join(', ') || 'none'}`);
  say(`LEDs: ${[...system.leds].map(([id, lit]) => `${id} ${lit ? red('ON') : 'off'}`).join(', ') || 'none'}`);

  const measurements = out.match(/\[MJERENJE\]/g)?.length ?? 0;
  say(`measurements: ${measurements}`);
  const alarms = out.split(/\r?\n/).filter((l) => l.includes('[ALARM'));
  say(alarms.length ? `alarm messages (${alarms.length}):` : 'alarm messages: none');
  for (const a of alarms) say(`  ${colourLine(a.trim())}`);
  if (out.includes('Traceback')) say(red('the program raised an exception (Traceback in the output)'));

  for (const id of system.cardIds) {
    const files = system.cardFiles(id);
    say(`SD ${id} (${system.cardInserted(id) ? 'inserted' : 'not inserted'})${files.length ? '' : ': no files'}`);
    for (const f of files) {
      say(`  ${f.name}  ${f.size} B`);
      if (f.name.toLowerCase().endsWith('.csv')) {
        const rows = new TextDecoder().decode(f.data).split(/\r?\n/).filter(Boolean);
        for (const r of rows.slice(-3)) say(dim(`    ${r}`));
      }
    }
    if (o.sdDump) {
      const dir = resolve(o.sdDump, system.cardIds.length > 1 ? id : '');
      for (const f of files) {
        const path = join(dir, f.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.data);
      }
      say(`  copied ${files.length} file(s) to ${dir}`);
    }
  }

  for (const text of o.expect) if (!out.includes(text)) failures.push(`expected "${text}" in the output, it was never printed`);
  for (const [id, on] of o.expectLed) {
    if (!system.leds.has(id)) failures.push(`--expect-led: no LED "${id}" in diagram.json`);
    else if (system.leds.get(id) !== on) failures.push(`expected ${id} ${on ? 'on' : 'off'}, it is ${on ? 'off' : 'on'}`);
  }
  if (o.expect.length || o.expectLed.length || o.until !== undefined) {
    say(failures.length ? red(`FAIL`) : green(`all checks passed`));
  }
  for (const f of failures) say(red(`  ${f}`));
  system.detach();
  process.exit(failures.length ? 1 : 0);
}

await main();
