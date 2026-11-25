// Shared helpers for the end-to-end scenario tests (test/scenario-*.test.ts): the real
// program on the full simulated circuit, fast-forwarded, with every serial line and every
// LED change recorded with its simulated time.
//
// Synchronise on output, never on raw time offsets: e.g. `run.waitMeasurements(6)` and
// then `system.setTemperature(...)`. The DS18B20 model latches its temperature when a
// conversion starts/ends, which is ~9 s after a [MJERENJE] line is printed, so a change
// made right after the Nth line lands in reading N+1.
import assert from 'node:assert/strict';
import type { Board } from '../src/board.js';
import type { CircuitSystem, Diagram } from '../src/system.js';
import { type BootSystemOptions, bootSystem, projectDiagram } from './helpers.js';

export const utc = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, s));

/** A copy of the project diagram without part `id` and its wires (copy of the one in system.test.ts). */
export function withoutPart(id: string, diagram = projectDiagram()): Diagram {
  return {
    parts: diagram.parts.filter((p) => p.id !== id),
    connections: diagram.connections.filter(([a, b]) => !a.startsWith(`${id}:`) && !b.startsWith(`${id}:`)),
  };
}

export interface Line {
  /** Simulated ms when the line arrived over USB serial. */
  ms: number;
  text: string;
}

/** One parsed "[MJERENJE] <time> | <t> C | <state>" line. */
export interface Measurement {
  ms: number;
  time: string;
  /** null for "greska" */
  temp: string | null;
  state: string;
}

const MEASUREMENT = /^\[MJERENJE\] (.+?) \| (?:(-?\d+\.\d\d) C|greska) \| (U_RASPONU|ODBROJAVANJE|ALARM)$/;

export class Run {
  readonly lines: Line[] = [];
  /** Every LED change of led1 with its simulated time (starts with the state at boot). */
  readonly ledLog: { ms: number; on: boolean }[] = [];
  private partial = '';

  constructor(
    readonly board: Board,
    readonly system: CircuitSystem,
  ) {
    board.onSerial = (text) => {
      this.partial += text.replace(/\r/g, '');
      let nl: number;
      while ((nl = this.partial.indexOf('\n')) >= 0) {
        this.lines.push({ ms: board.simMs, text: this.partial.slice(0, nl) });
        this.partial = this.partial.slice(nl + 1);
      }
    };
    this.ledLog.push({ ms: board.simMs, on: system.leds.get('led1') ?? false });
    system.onChange((c) => {
      if (c.kind !== 'leds') return;
      const on = system.leds.get('led1') ?? false;
      if (on !== this.ledLog[this.ledLog.length - 1].on) this.ledLog.push({ ms: board.simMs, on });
    });
  }

  static async boot(options: BootSystemOptions = {}): Promise<Run> {
    const { board, system } = await bootSystem(options);
    return new Run(board, system);
  }

  get led(): boolean {
    return this.system.leds.get('led1') ?? false;
  }

  /** Text lines starting with `prefix` (e.g. "[ALARM] "), in order. */
  find(prefix: string, fromLine = 0): Line[] {
    return this.lines.slice(fromLine).filter((l) => l.text.startsWith(prefix));
  }

  measurements(fromLine = 0): Measurement[] {
    return this.find('[MJERENJE]', fromLine).map((l) => {
      const m = MEASUREMENT.exec(l.text);
      assert.ok(m, `unexpected measurement line: ${JSON.stringify(l.text)}`);
      return { ms: l.ms, time: m[1], temp: m[2] ?? null, state: m[3] };
    });
  }

  /** Run until the program has printed `n` measurement lines in total. */
  waitMeasurements(n: number, maxMs = n * 10_000 + 10_000) {
    const ok = this.board.runUntil(() => this.find('[MJERENJE]').length >= n, maxMs, 5);
    assert.ok(ok, `only ${this.find('[MJERENJE]').length} of ${n} measurements within ${maxMs} ms\n${this.text()}`);
    this.board.runFor(20); // let the rest of that loop pass finish
  }

  /** Run until the boot banner is complete (all init messages printed). */
  waitStarted() {
    this.board.runUntilOutput('[START] tipkalo', 10_000);
  }

  /** Card file as text, or null when it does not exist. */
  card(name: string): string | null {
    const f = this.system.cardFiles('sd1').find((x) => x.name === name);
    return f ? new TextDecoder().decode(f.data) : null;
  }

  /** All output as text (for assertion messages). */
  text() {
    return this.board.output;
  }

  noTraceback() {
    assert.ok(!this.board.output.includes('Traceback'), this.board.output);
  }
}

/** '2026-11-17 10:00:01' + seconds, in the same format (UTC fields = clock fields). */
export function addSeconds(time: string, s: number): string {
  const d = new Date(time.replace(' ', 'T') + 'Z');
  d.setUTCSeconds(d.getUTCSeconds() + s);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** The program's CSV row for a measurement line. */
export function csvRow(m: Measurement): string {
  return `${m.time},${m.temp ?? 'greska'},${m.state}`;
}
