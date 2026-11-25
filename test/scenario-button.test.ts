// End-to-end scenarios, part 3: the button on GP14 (summary + CSV tail, alarm acknowledge).
// Run alone: node --import tsx --test test/scenario-button.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { csvRow, Run } from './scenario-helpers.js';

const HEADER = 'datum_vrijeme,temperatura_c,stanje';

/**
 * Contact bounce: toggle the button every `stepMs` for `spanMs`, ending in `final`
 * (pressed or released). Starts with the edge towards `final`.
 */
function bounce(run: Run, final: boolean, spanMs: number, stepMs: number) {
  let down = final;
  for (let t = 0; t < spanMs; t += stepMs) {
    if (down) run.system.press('btn1');
    else run.system.release('btn1');
    run.board.runFor(stepMs);
    down = !down;
  }
  if (final) run.system.press('btn1');
  else run.system.release('btn1');
}

/** Press with bounce, hold, release with bounce, then let the program print. Returns the new lines. */
function press(run: Run, { holdMs = 300, bounceMs = 0, stepMs = 0.7 } = {}) {
  const from = run.lines.length;
  bounce(run, true, bounceMs, stepMs);
  run.board.runFor(holdMs);
  bounce(run, false, bounceMs, stepMs);
  run.board.runFor(500);
  return run.lines.slice(from).map((l) => l.text).filter((t) => !t.startsWith('[MJERENJE]'));
}

/** The lines one press prints while there is no alarm: summary, then the CSV tail from the card. */
function expectedReport(run: Run, summary: string) {
  const rows = run.card('hladnjaca.csv')!.trimEnd().split('\n').slice(1);
  const tail = rows.slice(-10);
  return [
    '[TIPKALO] pritisak',
    summary,
    `[CSV] --- /sd/hladnjaca.csv: zadnjih ${tail.length} od ${rows.length} redaka ---`,
    HEADER,
    ...tail,
    '[CSV] --- kraj ---',
  ];
}

const summary5 = (n: number) =>
  `[SAZETAK] 2026-11-17: mjerenja ${n}, min 5.00 C, max 5.00 C, prosjek 5.00 C, izvan raspona 0 min 0 s, alarma 0, neuspjelih 0`;

describe('scenario: button', () => {
  test('idle press: exactly one summary + CSV tail per press, with contact bounce, and no repeat while held', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(3);

    // Each press right after a reading, so the report it prints is the card as it is now.
    // Clean press.
    let expected = expectedReport(run, summary5(3));
    assert.deepEqual(press(run), expected);
    // Bounce within 5 ms on press and on release (toggles every 0.7 ms).
    run.waitMeasurements(4);
    expected = expectedReport(run, summary5(4));
    assert.deepEqual(press(run, { bounceMs: 5, stepMs: 0.7 }), expected);
    // Longer bounce (40 ms, toggles every 4 ms) so the 10 ms poll really sees the bounces.
    run.waitMeasurements(5);
    expected = expectedReport(run, summary5(5));
    assert.deepEqual(press(run, { bounceMs: 40, stepMs: 4 }), expected);
    // Holding for 5 s gives one press, not a repeat.
    run.waitMeasurements(6);
    expected = expectedReport(run, summary5(6));
    assert.deepEqual(press(run, { holdMs: 5000, bounceMs: 40, stepMs: 4 }), expected);

    // More than 10 rows: only the last 10 are printed, the count says how many there are.
    run.waitMeasurements(13);
    expected = expectedReport(run, summary5(13));
    const lines = press(run);
    assert.equal(lines[2], '[CSV] --- /sd/hladnjaca.csv: zadnjih 10 od 13 redaka ---');
    assert.deepEqual(lines, expected);
    assert.deepEqual(lines.slice(4, 14), run.measurements().slice(3).map(csvRow));

    assert.deepEqual(run.ledLog.map((l) => l.on), [false], 'the button never lights the LED');
    run.noTraceback();
  });

  test('acknowledge during an alarm: LED off with a message, alarm stays logged; a new excursion alarms again', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(1);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(15); // reading 15 (130 s out of range) is the alarm
    assert.equal(run.led, true);

    const ack = press(run);
    assert.deepEqual(ack.slice(0, 3), [
      '[TIPKALO] pritisak',
      '[POTVRDA] alarm potvrden, LED ugasena do novog prekoracenja',
      '[SAZETAK] 2026-11-17: mjerenja 15, min 5.00 C, max 10.00 C, prosjek 9.67 C, izvan raspona 2 min 20 s, alarma 1, neuspjelih 0',
    ]);
    assert.equal(run.led, false, 'LED off after acknowledge');

    // Still out of range: rows keep saying ALARM, LED stays off, a second press acknowledges nothing.
    run.waitMeasurements(17);
    assert.deepEqual(run.measurements().slice(14).map((m) => m.state), ['ALARM', 'ALARM', 'ALARM']);
    assert.equal(run.led, false);
    const again = press(run);
    assert.equal(again[0], '[TIPKALO] pritisak');
    assert.ok(!again.some((t) => t.startsWith('[POTVRDA]')), again.join('\n'));
    assert.match(run.card('hladnjaca.csv')!, /,10\.00,ALARM\n.*,10\.00,ALARM\n.*,10\.00,ALARM\n$/);

    // Recovery, then a new excursion: a second alarm lights the LED again.
    run.system.setTemperature('temp1', 5);
    run.waitMeasurements(18);
    assert.deepEqual(run.find('[ALARM KRAJ]').map((l) => l.text), [
      '[ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 2 min 40 s',
    ]);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(32); // readings 19..32 at 10 C, the 14th is the alarm
    assert.deepEqual(run.find('[ALARM] ').map((l) => l.text), [
      '[ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s',
      '[ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s',
    ]);
    assert.equal(run.led, true, 'LED on for the new alarm');
    assert.deepEqual(run.ledLog.map((l) => l.on), [false, true, false, true]);
    run.noTraceback();
  });

  test('the whole CSV from the REPL: Ctrl+C, then ispisi_csv(None) prints every row of the card', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(13); // more rows than the button's tail of 10
    run.board.send('\x03'); // Ctrl+C stops the program; the REPL keeps main.py's globals
    run.board.runUntilOutput('>>> ', 2000);
    const from = run.lines.length;
    run.board.send('ispisi_csv(None)\r');
    run.board.runUntilOutput('[CSV] --- kraj ---', 5000);
    run.board.runFor(50);
    const printed = run.lines.slice(from).map((l) => l.text);
    const file = run.card('hladnjaca.csv')!.trimEnd().split('\n');
    assert.equal(file.length, 14); // header + 13 rows
    assert.deepEqual(printed, ['>>> ispisi_csv(None)', '[CSV] --- /sd/hladnjaca.csv: cijela datoteka ---', ...file, '[CSV] --- kraj ---']);
  });
});
