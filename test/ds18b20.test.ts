// DS18B20 model driven by real MicroPython's onewire / ds18x20 modules on GP15.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board } from '../src/board.js';
import { DS18B20 } from '../src/devices/ds18b20.js';
import { crc8 } from '../src/devices/onewire-crc.js';
import { bootBoard } from './helpers.js';

// main.py defines helpers and returns to the REPL; the test calls them one line at a time.
// Every helper prints a single line starting with "=> " (never typed, so the REPL echo
// of the command can't be mistaken for the answer).
const MAIN = `
import onewire, ds18x20, time
from machine import Pin
ow = onewire.OneWire(Pin(15))
ds = ds18x20.DS18X20(ow)

def hx(b):
    return ''.join('%02x' % x for x in b)

def out(*a):
    print('=>', *a)

def scan():
    try:
        out(' '.join(hx(r) for r in ds.scan()) or 'none')
    except Exception as e:
        out('ERR', type(e).__name__)

def temp(rom, convert=True, wait=750):
    try:
        if convert:
            ds.convert_temp()
            time.sleep_ms(wait)
        out(repr(ds.read_temp(bytes.fromhex(rom))))
    except Exception as e:
        out('ERR', type(e).__name__)

def busy():
    ds.convert_temp()
    a = ow.readbit()
    time.sleep_ms(700)
    b = ow.readbit()
    time.sleep_ms(60)
    c = ow.readbit()
    out(a, b, c)

def readrom():
    ow.reset(True)
    ow.writebyte(0x33)
    b = bytearray(8)
    ow.readinto(b)
    out(hx(b))

def romcrc():
    out(' '.join(str(ow.crc8(r)) for r in ds.scan()))

def power():
    ow.reset(True)
    ow.writebyte(0xCC)
    ow.writebyte(0xB4)
    out(ow.readbit())

def scratch(rom):
    out(hx(ds.read_scratch(bytes.fromhex(rom))))

def setcfg(rom, th, tl, cfg):
    ow.reset(True)
    ow.select_rom(bytes.fromhex(rom))
    ow.writebyte(0x4E)
    ow.write(bytes([th, tl, cfg]))
    out('ok')

print('READY')
`;

async function boot(): Promise<Board> {
  const board = await bootBoard([{ name: 'main.py', content: MAIN }]);
  // main.py prints READY and ends; MicroPython then shows the REPL prompt.
  assert.ok(board.runUntil(() => /READY[\s\S]*>>> /.test(board.output), 5000, 5), board.output);
  return board;
}

/** Run one REPL line, return the text after "=> " on the answer line. */
function call(board: Board, line: string, maxMs = 5000): string {
  const from = board.output.length;
  board.send(line + '\r');
  let answer: string | null = null;
  const ok = board.runUntil(() => {
    const m = /=> ([^\r\n]*)\r?\n/.exec(board.output.slice(from));
    if (m) answer = m[1];
    return answer !== null;
  }, maxMs, 5);
  assert.ok(ok, `no answer to ${line}; output:\n${board.output.slice(from)}`);
  const at = from + board.output.slice(from).indexOf('=> ');
  assert.ok(board.runUntil(() => board.output.indexOf('>>> ', at) >= 0, 1000, 5), 'no prompt after answer');
  return answer!;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

test('DS18B20: scan, conversions, scratchpad, ROM commands', async () => {
  const board = await boot();
  const sensor = new DS18B20(board, 15, { temperature: 21.5, serial: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66] });
  const rom = hex(sensor.rom);
  assert.equal(sensor.rom[0], 0x28);
  assert.equal(crc8(sensor.rom), 0);

  // Search ROM finds exactly this sensor, and the firmware's own crc8 accepts its ROM.
  assert.equal(call(board, 'scan()'), rom);
  assert.equal(call(board, 'romcrc()'), '0');

  // Before any conversion the scratchpad holds the power-on value 85.0 C.
  assert.equal(call(board, `temp('${rom}', convert=False)`), '85.0');

  for (const t of [21.5, -10.5, 5.0625, 2.0, 8.0, 0, -0.0625, 125, -55, 85]) {
    sensor.temperature = t;
    assert.equal(Number(call(board, `temp('${rom}')`)), t, `temperature ${t}`);
  }

  // Quantised to 1/16 C (12-bit) and clamped to the sensor's range.
  sensor.temperature = 23.03;
  assert.equal(call(board, `temp('${rom}')`), '23.0');
  sensor.temperature = 200;
  assert.equal(sensor.temperature, 125);

  // The value is latched when a conversion completes: changing the temperature without
  // converting, or reading before 750 ms, still gives the previous measurement.
  sensor.temperature = 30;
  assert.equal(call(board, `temp('${rom}')`), '30.0');
  sensor.temperature = 40;
  assert.equal(call(board, `temp('${rom}', convert=False)`), '30.0');
  assert.equal(call(board, `temp('${rom}', wait=100)`), '30.0');
  board.runFor(700);
  assert.equal(call(board, `temp('${rom}', convert=False)`), '40.0');

  // Read slots after CONVERT T: 0 while converting (750 ms), 1 when done.
  assert.equal(call(board, 'busy()'), '0 0 1');

  // READ ROM and READ POWER SUPPLY.
  assert.equal(call(board, 'readrom()'), rom);
  assert.equal(call(board, 'power()'), '1');

  // Full scratchpad: temp 40.0 = 0x0280, TH 0x4B, TL 0x46, config 0x7F, FF 0C 10, CRC.
  const pad = call(board, `scratch('${rom}')`);
  assert.equal(pad.slice(0, 16), '80024b467fff0c10');
  assert.equal(crc8(Buffer.from(pad, 'hex')), 0);

  // WRITE SCRATCHPAD: 9-bit resolution -> 0.5 C steps, 93.75 ms conversion.
  assert.equal(call(board, `setcfg('${rom}', 0x50, 0x0A, 0x1F)`), 'ok');
  assert.equal(call(board, `scratch('${rom}')`).slice(4, 10), '500a1f');
  sensor.temperature = 5.0625;
  assert.equal(call(board, `temp('${rom}', wait=100)`), '5.0');
  sensor.temperature = 5.3;
  assert.equal(call(board, `temp('${rom}', wait=100)`), '5.5');
});

test('DS18B20: disconnected sensor is absent from the bus', async () => {
  const board = await boot();
  const sensor = new DS18B20(board, 15, { temperature: 12.25 });
  const rom = hex(sensor.rom);
  sensor.connected = false;
  assert.equal(call(board, 'scan()'), 'none');
  assert.equal(call(board, `temp('${rom}')`), 'ERR OneWireError');
  assert.equal(board.pin(15).inputValue, true, 'idle line reads high');
  sensor.connected = true;
  assert.equal(call(board, 'scan()'), rom);
  assert.equal(call(board, `temp('${rom}')`), '12.25');
  sensor.detach();
  assert.equal(call(board, 'scan()'), 'none');
});

test('DS18B20: two sensors on one pin are both found and read separately', async () => {
  const board = await boot();
  const a = new DS18B20(board, 15, { temperature: 18.75, serial: [0x01, 0x00, 0x00, 0x00, 0x00, 0x00] });
  // Serial differs from a's in several bits, so search ROM must branch more than once.
  const b = new DS18B20(board, 15, { temperature: -3.125, serial: [0x03, 0x80, 0x00, 0x7f, 0x00, 0x00] });
  const roms = call(board, 'scan()').split(' ').sort();
  assert.deepEqual(roms, [hex(a.rom), hex(b.rom)].sort());
  for (const r of roms) assert.equal(crc8(Buffer.from(r, 'hex')), 0);
  // One CONVERT T with SKIP ROM converts both; MATCH ROM selects each one.
  assert.equal(call(board, `temp('${hex(a.rom)}')`), '18.75');
  assert.equal(call(board, `temp('${hex(b.rom)}', convert=False)`), '-3.125');

  // Three sensors, default serials (distinct per instance).
  const c = new DS18B20(board, 15, { temperature: 50 });
  const roms3 = call(board, 'scan()').split(' ');
  assert.equal(roms3.length, 3);
  assert.ok(roms3.includes(hex(c.rom)));
  assert.equal(call(board, `temp('${hex(c.rom)}')`), '50.0');
});
