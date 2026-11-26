// End-to-end scenarios, part 4: the daily summary at midnight, and faults
// (sensor unplugged, no SD card, card pulled out while running).
// Run alone: node --import tsx --test test/scenario-day-faults.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addSeconds, csvRow, Run, utc } from './scenario-helpers.js';

const HEADER = 'datum_vrijeme,temperatura_c,stanje';
const SUMMARY_HEADER = 'datum,broj_mjerenja,min_c,max_c,prosjek_c,izvan_raspona_s,broj_alarma,neuspjela_ocitanja';

function pressButton(run: Run) {
  const from = run.lines.length;
  run.system.press('btn1');
  run.board.runFor(300);
  run.system.release('btn1');
  run.board.runFor(500);
  return run.lines.slice(from).map((l) => l.text).filter((t) => !t.startsWith('[MJERENJE]'));
}

describe('scenario: daily summary', () => {
  test('across midnight: exact summary of the day printed and written to sazetak.csv; the new day starts fresh', async () => {
    // Readings at 23:55:01, :11, ... -> 30 readings on 2026-11-17 (up to 23:59:51).
    // Readings 1-6 at 5 C, from reading 7 (23:56:01) on 10 C; alarm at reading 20 (23:58:11).
    // Day: min 5, max 10, average (6*5 + 24*10) / 30 = 9.00, 24 readings out of range
    // (each counts the 10 s before it) = 240 s, 1 alarm, 0 failed readings.
    const run = await Run.boot({ temperatures: { temp1: 5 }, rtcTime: utc(2026, 11, 17, 23, 55, 0) });
    run.waitMeasurements(6);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(33);

    const ms = run.measurements();
    assert.equal(ms[0].time, '2026-11-17 23:55:01');
    ms.forEach((m, i) => assert.equal(m.time, addSeconds(ms[0].time, 10 * i)));
    assert.equal(ms[29].time, '2026-11-17 23:59:51');
    assert.equal(ms[30].time, '2026-11-18 00:00:01');
    assert.equal(ms[19].state, 'ALARM');
    assert.deepEqual(run.find('[ALARM] ').map((l) => l.text), [
      '[ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s',
    ]);

    const daily = run.find('[DNEVNI SAZETAK]');
    assert.deepEqual(daily.map((l) => l.text), [
      '[DNEVNI SAZETAK] 2026-11-17: mjerenja 30, min 5.00 C, max 10.00 C, prosjek 9.00 C, izvan raspona 4 min 0 s, alarma 1, neuspjelih 0',
    ]);
    // printed when the first reading of the new day is taken, before its row
    const idx = run.lines.findIndex((l) => l.text.startsWith('[DNEVNI SAZETAK]'));
    assert.match(run.lines[idx + 1].text, /^\[MJERENJE\] 2026-11-18 00:00:01 \| 10\.00 C \| ALARM$/);
    assert.equal(run.card('sazetak.csv'), `${SUMMARY_HEADER}\n2026-11-17,30,5.00,10.00,9.00,240,1,0\n`);
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');

    // The new day: 3 readings so far, all 10 C in the ongoing alarm (it is not counted again).
    const lines = pressButton(run);
    assert.deepEqual(lines.slice(0, 3), [
      '[TIPKALO] pritisak',
      '[POTVRDA] alarm potvrden, LED ugasena do novog prekoracenja',
      '[SAZETAK] 2026-11-18: mjerenja 3, min 10.00 C, max 10.00 C, prosjek 10.00 C, izvan raspona 0 min 30 s, alarma 0, neuspjelih 0',
    ]);
    assert.equal(run.led, false);
    run.noTraceback();
  });
});

describe('scenario: faults', () => {
  test('sensor unplugged mid-run: greska rows every 10 s, one error line, no alarm; plugged back in -> readings resume', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(2);
    run.system.setSensorConnected('temp1', false);
    run.waitMeasurements(5); // readings 3-5 fail
    run.system.setTemperature('temp1', 6);
    run.system.setSensorConnected('temp1', true);
    run.waitMeasurements(7);

    const ms = run.measurements();
    assert.deepEqual(
      ms.map((m) => `${m.temp ?? 'greska'} ${m.state}`),
      ['5.00 U_RASPONU', '5.00 U_RASPONU', 'greska U_RASPONU', 'greska U_RASPONU', 'greska U_RASPONU', '6.00 U_RASPONU', '6.00 U_RASPONU'],
    );
    ms.forEach((m, i) => assert.equal(m.time, addSeconds(ms[0].time, 10 * i)));
    const errors = run.find('[SENZOR] greska');
    assert.equal(errors.length, 1, 'the same error is printed once, not every 10 s');
    assert.match(errors[0].text, /^\[SENZOR\] greska ocitanja: pretvorba nije uspjela \(OneWireError\)$/);
    assert.deepEqual(run.find('[SENZOR] ocitanje').map((l) => l.text), ['[SENZOR] ocitanje ponovno uspijeva']);
    assert.ok(!run.text().includes('nemoguca'), 'no impossible value after reconnecting');
    assert.deepEqual(run.find('[ALARM'), []);
    assert.deepEqual(run.ledLog.map((l) => l.on), [false]);
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.map(csvRow)].join('\n') + '\n');

    const lines = pressButton(run);
    assert.equal(
      lines[1],
      '[SAZETAK] 2026-11-17: mjerenja 4, min 5.00 C, max 6.00 C, prosjek 5.50 C, izvan raspona 0 min 0 s, alarma 0, neuspjelih 3',
    );
    run.noTraceback();
  });

  test('power glitch during a conversion: the 85 C power-on value is rejected, never logged', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(2);
    // The next conversion starts ~750 ms before the next reading, i.e. ~9.25 s after this one.
    const lastRead = run.find('[MJERENJE]').at(-1)!.ms;
    run.board.runFor(lastRead + 9_250 + 200 - run.board.simMs); // now inside that conversion
    run.system.setSensorConnected('temp1', false); // a few ms without power...
    run.board.runFor(5);
    run.system.setSensorConnected('temp1', true); // ...restarts the chip: scratchpad = 85.0 C
    run.waitMeasurements(4);

    const ms = run.measurements();
    assert.deepEqual(
      ms.map((m) => `${m.temp ?? 'greska'} ${m.state}`),
      ['5.00 U_RASPONU', '5.00 U_RASPONU', 'greska U_RASPONU', '5.00 U_RASPONU'],
    );
    assert.deepEqual(run.find('[SENZOR] greska').map((l) => l.text), ['[SENZOR] greska ocitanja: nemoguca vrijednost 85.0']);
    assert.ok(!run.card('hladnjaca.csv')!.includes('85.00'), '85 C never reaches the CSV');
    assert.deepEqual(run.find('[ALARM'), []);
    run.noTraceback();
  });

  test('no SD card at boot: clear message, monitoring and alarm still work', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.system.setCardInserted('sd1', false); // before the program runs
    run.waitStarted();
    const sd = run.find('[SD]');
    assert.equal(sd.length, 1);
    assert.equal(sd[0].text, '[SD] kartica nije dostupna (no SD card), mjerenja se ne zapisuju dok se ne umetne');

    run.waitMeasurements(1);
    run.system.setTemperature('temp1', 10);
    run.waitMeasurements(15);
    assert.deepEqual(run.measurements().map((m) => m.state), [
      'U_RASPONU', ...Array(13).fill('ODBROJAVANJE'), 'ALARM',
    ]);
    assert.deepEqual(run.find('[ALARM] ').map((l) => l.text), [
      '[ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s',
    ]);
    assert.equal(run.led, true);
    assert.equal(run.find('[SD]').length, 1, 'no write errors repeated every 10 s');

    const lines = pressButton(run);
    assert.equal(lines.at(-1), '[CSV] kartica nije dostupna, nema zapisa');
    run.system.setCardInserted('sd1', true);
    assert.equal(run.card('hladnjaca.csv'), null, 'nothing was written');
    run.noTraceback();
  });

  test('SD card pulled out mid-run and put back: one error message, logging resumes', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.waitMeasurements(2);
    const before = run.measurements();
    run.system.setCardInserted('sd1', false);
    run.waitMeasurements(5); // reading 3 fails to write; 4 and 5 are taken while the card is out

    const errors = run.find('[SD] greska');
    assert.equal(errors.length, 1, 'the error is printed once, not every 10 s');
    assert.equal(errors[0].text, '[SD] greska pri zapisu u /sd/hladnjaca.csv ([Errno 5] EIO), karticu trazim pri svakom mjerenju');
    assert.deepEqual(run.measurements().map((m) => m.temp), ['5.00', '5.00', '5.00', '5.00', '5.00']);

    run.system.setCardInserted('sd1', true);
    run.waitMeasurements(7);
    const ms = run.measurements();
    // The card is found again at the next measurement and that reading is written.
    const mounts = run.find('[SD] kartica montirana');
    assert.equal(mounts.length, 2, 'mounted at start and again after reinsertion');
    assert.deepEqual(run.find('[SD] /sd/hladnjaca.csv postoji').map((l) => l.text), ['[SD] /sd/hladnjaca.csv postoji, 2 redaka mjerenja']);
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...before.map(csvRow), ...ms.slice(5).map(csvRow)].join('\n') + '\n');
    assert.equal(run.find('[SD] greska').length, 1, 'no new errors after reinsertion');
    run.noTraceback();
  });

  test('sensor plugged in only after power-on: its first reading is already valid (not 85 C)', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.system.setSensorConnected('temp1', false);
    run.waitMeasurements(2);
    run.system.setSensorConnected('temp1', true);
    run.waitMeasurements(4);

    assert.deepEqual(run.measurements().map((m) => m.temp ?? 'greska'), ['greska', 'greska', '5.00', '5.00']);
    assert.ok(!run.text().includes('nemoguca'), 'searching for the new sensor must not cut the 750 ms conversion short');
    run.noTraceback();
  });

  test('clock set back across midnight: each date gets one summary row, with a warning', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 }, rtcTime: new Date(Date.UTC(2026, 10, 17, 23, 59, 30)) });
    run.waitMeasurements(4); // 23:59:31, :41, :51, then 00:00:01 closes the 17th
    run.system.setRtcTime('rtc1', new Date(Date.UTC(2026, 10, 17, 23, 58, 0))); // e.g. "Jump to 23:58" pressed again
    run.waitMeasurements(4 + 14); // runs past midnight a second time

    assert.deepEqual(run.find('[DNEVNI SAZETAK]').map((l) => l.text.slice(0, 28)), ['[DNEVNI SAZETAK] 2026-11-17:']);
    assert.deepEqual(run.find('[RTC] sat je vracen').map((l) => l.text), [
      '[RTC] sat je vracen unatrag (2026-11-17), dnevni sazetak i dalje vodi dan 2026-11-18',
    ]);
    const rows = run.card('sazetak.csv')!.trim().split('\n').slice(1);
    assert.deepEqual(rows.map((r) => r.split(',')[0]), ['2026-11-17'], 'no duplicate day rows');
    run.noTraceback();
  });

  test('SD card inserted only after power-on: logging starts from the next measurement', async () => {
    const run = await Run.boot({ temperatures: { temp1: 5 } });
    run.system.setCardInserted('sd1', false);
    run.waitMeasurements(2);
    run.system.setCardInserted('sd1', true);
    run.waitMeasurements(4);

    const ms = run.measurements();
    assert.deepEqual(run.find('[SD]').map((l) => l.text), [
      '[SD] kartica nije dostupna (no SD card), mjerenja se ne zapisuju dok se ne umetne',
      '[SD] kartica montirana na /sd',
      '[SD] nova datoteka /sd/hladnjaca.csv, zapisano zaglavlje',
    ]);
    assert.equal(run.card('hladnjaca.csv'), [HEADER, ...ms.slice(2).map(csvRow)].join('\n') + '\n');
    run.noTraceback();
  });
});
