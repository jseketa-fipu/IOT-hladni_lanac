// End-to-end scenarios, part 1: measuring and logging without alarms.
// The real program (project/*.py) on the full circuit of project/diagram.json, fast-forwarded.
// Run alone: node --import tsx --test test/scenario-measuring.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addSeconds, csvRow, Run, withoutPart } from './scenario-helpers.js';

const HEADER = 'datum_vrijeme,temperatura_c,stanje';

describe('scenario: measuring and logging', () => {
  test('normal operation at 5.0 C: banner, first reading at once, then every 10 s, CSV rows, LED off', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitStarted();
    run.waitMeasurements(1);
    const first = run.measurements()[0];
    // Run to 60.5 s after the first reading: readings at 0, 10, ..., 60 s -> exactly 7.
    run.board.runFor(first.ms + 60_500 - run.board.simMs);

    const texts = run.lines.map((l) => l.text);
    assert.deepEqual(texts.slice(0, 7), [
      '[START] Nadzor hladnog lanca',
      '[START] raspon 2.0 - 8.0 C, mjerenje svakih 10 s, alarm nakon 120 s izvan raspona',
      '[SD] kartica montirana na /sd',
      '[SD] nova datoteka /sd/hladnjaca.csv, zapisano zaglavlje',
      '[RTC] sat: 2026-11-17 10:00:00',
      '[SENZOR] pronaden DS18B20 (2801005e1d0000be)',
      '[START] tipkalo (GP14): sazetak i zadnji retci CSV-a, tijekom alarma i potvrda alarma',
    ]);

    // First reading right after start-up: one conversion (750 ms) later, not after 10 s.
    const ready = run.find('[START] tipkalo')[0].ms;
    assert.ok(first.ms - ready < 1000, `first reading ${first.ms - ready} ms after start-up`);
    assert.ok(first.time >= '2026-11-17 10:00:00' && first.time <= '2026-11-17 10:00:02', first.time);

    const ms = run.measurements();
    assert.equal(ms.length, 7, run.text());
    ms.forEach((m, i) => {
      assert.equal(m.time, addSeconds(first.time, 10 * i), 'RTC time steps of exactly 10 s');
      assert.equal(m.temp, '5.00');
      assert.equal(m.state, 'U_RASPONU');
      if (i > 0) {
        const gap = m.ms - ms[i - 1].ms;
        assert.ok(Math.abs(gap - 10_000) <= 1000, `interval ${gap} ms`);
      }
    });

    // The CSV: header once, then one row per reading with the same time, 5.00, U_RASPONU.
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');
    assert.equal(run.card('sazetak.csv'), null, 'no daily summary on the first day');


    assert.deepEqual(run.ledLog.map((l) => l.on), [false], 'LED never lit');
    run.noTraceback();
  });

  test('power-on value: the 85.0 C in a fresh DS18B20 scratchpad is never read or logged', async () => {
    // The model starts with 85.0 C in its scratchpad, like the real chip. The program must
    // start a conversion and wait for it before the first read, so the first row is 5.00.
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(3);
    assert.deepEqual(run.measurements().map((m) => m.temp), ['5.00', '5.00', '5.00']);
    assert.ok(!run.text().includes('85'), run.text());
    assert.ok(!run.text().includes('[SENZOR] greska'), 'not even a rejected 85.0 reading');
    assert.ok(!run.card('hladnjaca.csv')!.includes('85'));
    run.noTraceback();
  });

  test('short excursion: 10 C for 60 s then 5 C -> countdown rows, no alarm, LED never on', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(2);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(8); // readings 3..8 at 10 C (60 s)
    run.system.setTemperature('temp1', 5);
    run.waitMeasurements(11);

    const ms = run.measurements();
    assert.deepEqual(
      ms.map((m) => `${m.temp} ${m.state}`),
      [
        '5.00 U_RASPONU',
        '5.00 U_RASPONU',
        ...Array(6).fill('10.00 ODBROJAVANJE'),
        '5.00 U_RASPONU',
        '5.00 U_RASPONU',
        '5.00 U_RASPONU',
      ],
    );
    assert.deepEqual(run.find('[ALARM'), [], 'no [ALARM] or [ALARM KRAJ]');
    assert.deepEqual(run.ledLog.map((l) => l.on), [false], 'LED never lit');
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');
    run.noTraceback();
  });

  test('range limits: 2.0 and 8.0 are in range, 8.0625 and 1.9375 are not', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    const plan = [2.0, 8.0, 8.0625, 5, 1.9375, 5];
    run.waitMeasurements(1);
    plan.forEach((t, i) => {
      run.system.setTemperature('temp1', t);
      run.waitMeasurements(i + 2);
    });
    const ms = run.measurements();
    assert.deepEqual(
      ms.map((m) => m.state),
      ['U_RASPONU', 'U_RASPONU', 'U_RASPONU', 'ODBROJAVANJE', 'U_RASPONU', 'ODBROJAVANJE', 'U_RASPONU'],
    );
    assert.deepEqual(
      ms.map((m) => Number(m.temp)),
      [5, 2, 8, 8.06, 5, 1.94, 5],
    );
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');
    run.noTraceback();
  });

  test('no RTC in the circuit: uptime timestamps +HH:MM:SS, still logs', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 }, diagram: withoutPart('rtc1') });
    run.waitStarted();
    run.waitMeasurements(4);
    assert.equal(run.find('[RTC]').length, 1);
    assert.equal(
      run.find('[RTC]')[0].text,
      '[RTC] sat nije dostupan ([Errno 110] ETIMEDOUT), koristim vrijeme od pokretanja (+HH:MM:SS)',
    );
    const ms = run.measurements();
    assert.ok(['+00:00:00', '+00:00:01'].includes(ms[0].time), ms[0].time);
    const s0 = Number(ms[0].time.slice(-2));
    assert.deepEqual(
      ms.map((m) => m.time),
      [0, 10, 20, 30].map((d) => `+00:00:${String(s0 + d).padStart(2, '0')}`),
    );
    assert.ok(ms.every((m) => m.temp === '5.00' && m.state === 'U_RASPONU'));
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');
    run.noTraceback();
  });
});
