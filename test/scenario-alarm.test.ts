// End-to-end scenarios, part 2: excursions long enough to raise the alarm.
// Rule (project/main.py + hladni_lanac.py): alarm when the temperature has been out of
// 2.0-8.0 C for MORE than 120 s, counted from the first out-of-range reading. With a
// reading every 10 s that is the reading 130 s after the first one ("vec 2 min 10 s").
// Run alone: node --import tsx --test test/scenario-alarm.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addSeconds, csvRow, Run } from './scenario-helpers.js';

const HEADER = 'datum_vrijeme,temperatura_c,stanje';

/** Readings in range, then `out` readings out of range, then `back` readings in range. */
function expectExcursion(run: Run, inBefore: number, temps: string[], back: number) {
  const ms = run.measurements();
  const expected = [
    ...Array(inBefore).fill('5.00 U_RASPONU'),
    // 13 readings counting down (0..120 s out of range), the 14th (130 s) is the alarm
    ...temps.map((t, i) => `${t} ${i < 13 ? 'ODBROJAVANJE' : 'ALARM'}`),
    ...Array(back).fill('5.00 U_RASPONU'),
  ];
  assert.deepEqual(ms.map((m) => `${m.temp} ${m.state}`), expected);
  ms.forEach((m, i) => assert.equal(m.time, addSeconds(ms[0].time, 10 * i)));
  assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');
  return ms;
}

/** The alarm fired once, on the reading 130 s after the first out-of-range one; LED followed. */
function expectOneAlarm(run: Run, firstOut: number, message: string) {
  const ms = run.measurements();
  const alarms = run.find('[ALARM] ');
  assert.deepEqual(alarms.map((l) => l.text), [message]);
  const alarmReading = ms[firstOut + 13];
  assert.equal(alarmReading.state, 'ALARM');
  assert.equal(alarmReading.time, addSeconds(ms[firstOut].time, 130));
  const delay = alarms[0].ms - ms[firstOut].ms;
  assert.ok(delay > 120_000 && delay <= 130_500, `alarm ${delay} ms after the first out-of-range reading`);
  // LED: off until the alarm, on at the alarm (same loop pass), off again at recovery.
  assert.equal(run.ledLog[0].on, false);
  assert.equal(run.ledLog[1]?.on, true, JSON.stringify(run.ledLog));
  assert.ok(Math.abs(run.ledLog[1].ms - alarms[0].ms) < 50, 'LED lit together with the alarm message');
}

describe('scenario: alarm', () => {
  test('long excursion high: 10 C for 200 s -> one alarm at +130 s, LED on; back to 5 C -> recovery, LED off', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(2);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(16); // 14 readings at 10 C: the last is the alarm
    assert.equal(run.led, true, 'LED on during the alarm');
    run.waitMeasurements(22); // 20 readings at 10 C (0..190 s)
    assert.equal(run.led, true, 'LED stays on');
    run.system.setTemperature('temp1', 5);
    run.waitMeasurements(24);

    const ms = expectExcursion(run, 2, Array(20).fill('10.00'), 2);
    expectOneAlarm(run, 2, '[ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s');
    // Recovery on the reading 200 s after the first out-of-range one.
    const end = run.find('[ALARM KRAJ]');
    assert.deepEqual(end.map((l) => l.text), [
      '[ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 3 min 20 s',
    ]);
    assert.equal(run.led, false, 'LED off after recovery');
    assert.deepEqual(run.ledLog.map((l) => l.on), [false, true, false]);
    assert.ok(Math.abs(run.ledLog[2].ms - end[0].ms) < 50);
    assert.equal(ms[22].state, 'U_RASPONU');
    run.noTraceback();
  });

  test('long excursion low: 0 C for 3 min -> alarm, recovery after 3 min 0 s', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(1);
    run.system.setTemperature('temp1', 0);
    run.waitMeasurements(19); // 18 readings at 0 C (0..170 s)
    run.system.setTemperature('temp1', 5);
    run.waitMeasurements(20);

    expectExcursion(run, 1, Array(18).fill('0.00'), 1);
    expectOneAlarm(run, 1, '[ALARM] temperatura 0.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s');
    assert.deepEqual(run.find('[ALARM KRAJ]').map((l) => l.text), [
      '[ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 3 min 0 s',
    ]);
    assert.deepEqual(run.ledLog.map((l) => l.on), [false, true, false]);
    run.noTraceback();
  });

  test('too warm then too cold without returning to range is one excursion -> alarm', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(1);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(8); // 7 readings at 10 C (0..60 s)
    run.system.setTemperature('temp1', 0);
    run.waitMeasurements(15); // 7 readings at 0 C (70..130 s): the last is the alarm
    run.board.runFor(100);

    expectExcursion(run, 1, [...Array(7).fill('10.00'), ...Array(7).fill('0.00')], 0);
    expectOneAlarm(run, 1, '[ALARM] temperatura 0.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s');
    assert.equal(run.led, true);
    run.noTraceback();
  });

  test('already too warm at power-on: the summary counts the same out-of-range time as [ALARM KRAJ]', async () => {
    // 17 readings at 10 C (0..160 s after the first), then back to 5 C on the 18th (170 s).
    const run = await Run.boot({ temperatures: { temp1: 10 } });
    run.waitMeasurements(17);
    run.system.setTemperature('temp1', 5);
    run.waitMeasurements(18);
    run.system.press('btn1');
    run.board.runFor(300);
    run.system.release('btn1');
    run.board.runFor(500);

    assert.deepEqual(run.find('[ALARM KRAJ]').map((l) => l.text), [
      '[ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 2 min 50 s',
    ]);
    // Before the fix the first reading counted 0 s here, giving "2 min 40 s".
    assert.deepEqual(run.find('[SAZETAK]').map((l) => l.text), [
      '[SAZETAK] 2026-11-17: mjerenja 18, min 5.00 C, max 10.00 C, prosjek 9.72 C, izvan raspona 2 min 50 s, alarma 1, neuspjelih 0',
    ]);
    run.noTraceback();
  });
});
