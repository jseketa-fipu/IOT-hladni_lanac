// DS1307 RTC model + project/ds1307.py driver, end to end on real MicroPython.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import type { Board } from '../src/board.js';
import { DS1307 } from '../src/devices/ds1307.js';
import { bootBoard, ROOT } from './helpers.js';

const MAIN = `
from machine import I2C, SoftI2C, Pin
import time
from ds1307 import DS1307
i2c = I2C(0, sda=Pin(8), scl=Pin(9), freq=100000)
rtc = DS1307(i2c)
def roll(t):
    rtc.datetime(t)
    time.sleep_ms(20000)
    return rtc.datetime()
def probe(addr):
    try:
        i2c.writeto(addr, b'\\x00')
        return 'acked'
    except OSError as e:
        return e.errno
print('ready')
`;

const utc = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));
/** The tuple MicroPython's driver returns for a Date (ISO weekday, as the model's setTime uses). */
const tuple = (d: Date) =>
  `(${d.getUTCFullYear()}, ${d.getUTCMonth() + 1}, ${d.getUTCDate()}, ${((d.getUTCDay() + 6) % 7) + 1}, ${d.getUTCHours()}, ${d.getUTCMinutes()}, ${d.getUTCSeconds()})`;

describe('DS1307 RTC', () => {
  let board: Board;
  let rtc: DS1307;
  const START = utc(2026, 11, 25, 12, 34, 56);

  /** Run a Python statement at the REPL, then print `expr`; returns what was printed. */
  function py(expr: string, maxMs = 5000, stmt = ''): string {
    const from = board.output.length;
    // Markers are built at run time so the REPL's echo of the line doesn't match.
    board.send(`${stmt ? stmt + '; ' : ''}print('<'+'<', ${expr}, '>'+'>')\r`);
    const re = /<< (.*?) >>/s;
    board.runUntil(() => re.test(board.output.slice(from)), maxMs, 2);
    const m = re.exec(board.output.slice(from));
    assert.ok(m, `no result for ${expr}; output: ${board.output.slice(from)}`);
    return m[1];
  }

  before(async () => {
    board = await bootBoard([
      { name: 'ds1307.py', content: readFileSync(join(ROOT, 'project', 'ds1307.py'), 'utf8') },
      { name: 'main.py', content: MAIN },
    ]);
    rtc = new DS1307(board, { i2c: 0, start: START });
    board.runUntilOutput('ready', 3000);
    assert.ok(board.runUntil(() => board.output.includes('>>> '), 1000), 'no REPL prompt after main.py');
  });

  test('reads the start time; it has advanced by the simulated boot time', () => {
    const got = py('rtc.datetime()');
    const now = rtc.now();
    assert.equal(got, tuple(now));
    assert.equal(now.getTime() - START.getTime(), Math.floor(board.simMs)); // started at sim t=0
    assert.ok(board.simMs < 3000);
    assert.match(got, /^\(2026, 11, 25, 3, 12, 34, 5[6-9]\)$/); // 25 Nov 2026 is a Wednesday
  });

  test('i2c.scan() finds only 0x68 (bit-banged probe)', () => {
    assert.equal(py('i2c.scan()'), '[104]');
  });

  test('time advances with simulated time across minute and hour boundaries', () => {
    const t0 = utc(2026, 11, 25, 10, 59, 0);
    rtc.setTime(t0);
    board.runFor(90000);
    assert.equal(rtc.now().getTime() - t0.getTime(), 90000);
    assert.equal(py('rtc.datetime()'), '(2026, 11, 25, 3, 11, 0, 30)');
  });

  test('time set from MicroPython rolls over day, month end and leap day', () => {
    assert.equal(py('roll((2026, 11, 25, 3, 23, 59, 50))', 25000), '(2026, 11, 26, 4, 0, 0, 10)');
    assert.equal(rtc.now().toISOString().slice(0, 19), '2026-11-26T00:00:10');
    assert.equal(py('roll((2026, 11, 30, 1, 23, 59, 50))', 25000), '(2026, 12, 1, 2, 0, 0, 10)');
    assert.equal(py('roll((2028, 2, 28, 1, 23, 59, 50))', 25000), '(2028, 2, 29, 2, 0, 0, 10)');
    assert.equal(py('roll((2027, 2, 28, 7, 23, 59, 50))', 25000), '(2027, 3, 1, 1, 0, 0, 10)');
    assert.equal(py('roll((2099, 12, 31, 4, 23, 59, 59))', 25000).slice(0, 13), '(2000, 1, 1, '); // 2-digit year wraps
  });

  test('other addresses are NACKed (EIO, as on a real Pico) and the next transfer still works', () => {
    assert.equal(py('probe(0x50)'), '5'); // MicroPython rp2 maps any NACK to EIO
    assert.match(py('rtc.datetime()'), /^\(20\d\d, /);
    assert.equal(py('probe(0x68)'), 'acked');
  });

  test('setTime() from the host is seen by MicroPython', () => {
    rtc.setTime(utc(2030, 6, 15, 8, 0, 0)); // a Saturday
    assert.equal(py('rtc.datetime()'), '(2030, 6, 15, 6, 8, 0, 0)');
  });

  test('RAM round-trips, pointer wraps 0x3F -> 0x00, control register is stored', () => {
    py("i2c.writeto_mem(0x68, 0x08, bytes(range(100, 156)))");
    assert.equal(py("list(i2c.readfrom_mem(0x68, 0x08, 56)) == list(range(100, 156))"), 'True');
    rtc.setTime(utc(2030, 6, 15, 8, 0, 42));
    assert.equal(py("list(i2c.readfrom_mem(0x68, 0x3E, 3))"), '[154, 155, 66]'); // 0x42 = BCD 42 s
    py("i2c.writeto_mem(0x68, 0x07, b'\\x10')");
    assert.equal(py("i2c.readfrom_mem(0x68, 0x07, 1)[0]"), '16');
    // RAM/control writes don't disturb the time.
    assert.equal(py('rtc.datetime()'), '(2030, 6, 15, 6, 8, 0, 42)');
  });

  test('CH (clock halt) freezes the clock, clearing it resumes', () => {
    rtc.setTime(utc(2026, 11, 25, 9, 0, 0));
    py('rtc.halt(True)');
    const frozen = py('rtc.datetime()');
    assert.equal(py('rtc.halt()'), 'True');
    board.runFor(10000);
    assert.equal(py('rtc.datetime()'), frozen);
    assert.equal(rtc.now().toISOString().slice(0, 19), '2026-11-25T09:00:00');
    py('rtc.halt(False)');
    assert.equal(py('rtc.halt()'), 'False');
    board.runFor(5000);
    assert.equal(py('rtc.datetime()'), '(2026, 11, 25, 3, 9, 0, 5)');
  });

  test('12-hour mode set by the program reads back in 12h format', () => {
    rtc.setTime(utc(2026, 11, 25, 9, 0, 0));
    py("i2c.writeto_mem(0x68, 0x02, b'\\x71')"); // 12h, PM, 11 -> 23:00
    assert.equal(py('hex(i2c.readfrom_mem(0x68, 0x02, 1)[0])'), '0x71');
    assert.equal(rtc.now().getUTCHours(), 23);
    assert.equal(py('rtc.datetime()[4]'), '23');
    py("i2c.writeto_mem(0x68, 0x02, b'\\x08')"); // back to 24h, 08
    assert.equal(py('hex(i2c.readfrom_mem(0x68, 0x02, 1)[0])'), '0x8');
  });

  test('bit-banged SoftI2C on the same pins reads and writes too', () => {
    py("'ok'", 5000, 's = SoftI2C(sda=Pin(8), scl=Pin(9), freq=100000)');
    rtc.setTime(utc(2026, 11, 25, 9, 15, 30));
    assert.equal(py('DS1307(s).datetime()'), '(2026, 11, 25, 3, 9, 15, 30)');
    py("s.writeto_mem(0x68, 0x10, b'\\xa5\\x5a')");
    assert.equal(py("list(i2c.readfrom_mem(0x68, 0x10, 2))"), '[165, 90]');
    assert.equal(py('s.scan()'), '[104]');
    // Back on the hardware peripheral afterwards.
    assert.equal(py("list(I2C(0, sda=Pin(8), scl=Pin(9)).readfrom_mem(0x68, 0x10, 2))"), '[165, 90]');
  });

  test('detach() removes the device from the bus', () => {
    rtc.detach();
    assert.equal(py('i2c.scan()'), '[]');
    // Default start: the host's local wall-clock fields, as UTC fields.
    const local = new Date();
    rtc = new DS1307(board, { i2c: 0 });
    const asUtc = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
    assert.ok(Math.abs(rtc.now().getTime() - asUtc) < 2000, `${rtc.now().toISOString()} vs local ${local}`);
    assert.equal(py('i2c.scan()'), '[104]');
  });
});
