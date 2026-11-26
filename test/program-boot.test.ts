// The cold-chain program (project/main.py + project/hladni_lanac.py) on real MicroPython.
// Run alone: node --import tsx --test test/program-boot.test.ts
//
// 1. Missing hardware: sdcard.py / ds1307.py stubs that raise OSError and no DS18B20 on GP15.
//    The program must start, report what is missing, log "greska" every 10 s and react to the button.
// 2. Scripted hardware: a RAM-backed FAT "SD card", a fake DS1307 starting at 23:58:00 and a
//    ds18x20.py override (files in / shadow the frozen module) returning a fixed temperature
//    sequence. Exercises alarm, LED, acknowledge, CSV and the daily summary at midnight.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectFile } from '../src/board.js';
import { bootBoard, ROOT } from './helpers.js';

// Our own files only: other agents put the real sdcard.py / ds1307.py into project/.
const program = (): ProjectFile[] =>
  ['main.py', 'hladni_lanac.py'].map((name) => ({
    name,
    content: readFileSync(join(ROOT, 'project', name), 'utf8'),
  }));

const SD_FAILS = `
class SDCard:
    def __init__(self, spi, cs):
        raise OSError("no SD card")
`;
const RTC_FAILS = `
class DS1307:
    def __init__(self, i2c, addr=0x68):
        raise OSError(5)
`;

const SD_RAM = `
import os
class SDCard:
    def __init__(self, spi, cs):
        self.n = 128
        self.data = bytearray(self.n * 512)
        os.VfsFat.mkfs(self)
    def readblocks(self, b, buf):
        buf[:] = self.data[b * 512:b * 512 + len(buf)]
    def writeblocks(self, b, buf):
        self.data[b * 512:b * 512 + len(buf)] = buf
    def ioctl(self, op, arg):
        if op == 4:
            return self.n
        if op == 5:
            return 512
        return 0
`;
const RTC_FAKE = `
import time
_T0 = time.mktime((2026, 11, 17, 23, 58, 0, 0, 0))
_START = time.ticks_ms()
class DS1307:
    def __init__(self, i2c, addr=0x68):
        pass
    def datetime(self, dt=None):
        t = time.localtime(_T0 + time.ticks_diff(time.ticks_ms(), _START) // 1000)
        return (t[0], t[1], t[2], t[6] + 1, t[3], t[4], t[5])
`;
// Reading k (0-based): 5, 5, 85 (rejected), 10 x16 (readings 3..18), then 5.
const DS_FAKE = `
_TEMPS = [5.0, 5.0, 85.0] + [10.0] * 16
_n = 0
class DS18X20:
    def __init__(self, ow):
        pass
    def scan(self):
        return [bytearray(b"\\x28\\x01\\x02\\x03\\x04\\x05\\x06\\x07")]
    def convert_temp(self):
        pass
    def read_temp(self, rom):
        global _n
        t = _TEMPS[_n] if _n < len(_TEMPS) else 5.0
        _n += 1
        return t
`;

function pressButton(board: Awaited<ReturnType<typeof bootBoard>>, holdMs = 300) {
  board.pin(14).setInputValue(false);
  board.runFor(holdMs);
  board.pin(14).setInputValue(true);
}

test('cold-chain program runs with SD, RTC and sensor missing', async () => {
  const board = await bootBoard([
    ...program(),
    { name: 'sdcard.py', content: SD_FAILS },
    { name: 'ds1307.py', content: RTC_FAILS },
  ]);
  let ledHigh = 0;
  board.pin(16).addListener((s) => {
    if (s === 1) ledHigh++;
  });

  board.runUntilOutput('[START] Nadzor hladnog lanca', 3000);
  board.runFor(45_000);
  const out = () => board.output;
  assert.match(out(), /\[START\] raspon 2\.0 - 8\.0 C, mjerenje svakih 10 s, alarm nakon 120 s izvan raspona/);
  assert.match(out(), /\[SD\] kartica nije dostupna \(no SD card\), mjerenja se ne zapisuju dok se ne umetne/);
  assert.match(out(), /\[RTC\] sat nije dostupan \(.*\), koristim vrijeme od pokretanja/);
  assert.match(out(), /\[SENZOR\] DS18B20 nije pronaden na GP15/);

  // Button: one press -> exactly one summary + CSV notice, nothing while held.
  const before = out().length;
  board.pin(14).setInputValue(false);
  board.runFor(150);
  const whileHeld = out().slice(before);
  board.runFor(150);
  board.pin(14).setInputValue(true);
  board.runFor(500);
  const afterPress = out().slice(before);
  assert.equal((afterPress.match(/\[TIPKALO\] pritisak/g) ?? []).length, 1, afterPress);
  assert.equal((afterPress.match(/\[SAZETAK\] /g) ?? []).length, 1, afterPress);
  assert.match(afterPress, /\[SAZETAK\] dan 1: mjerenja 0, min -, max -, prosjek - \(nema mjerenja\), izvan raspona 0 min 0 s, alarma 0, neuspjelih 5/);
  assert.match(afterPress, /\[CSV\] kartica nije dostupna, nema zapisa/);
  assert.equal((whileHeld.match(/\[TIPKALO\]/g) ?? []).length, 1); // printed on the edge itself

  board.runFor(20_000);
  const all = out();
  const rows = [...all.matchAll(/\[MJERENJE\] \+(\d\d):(\d\d):(\d\d) \| greska \| U_RASPONU/g)].map(
    (m) => +m[1] * 3600 + +m[2] * 60 + +m[3],
  );
  assert.ok(rows.length >= 6, `rows=${rows.length}`);
  rows.forEach((s, i) => assert.equal(s, i * 10));
  assert.ok(!all.includes('Traceback'), all);
  assert.ok(!all.includes('>>> '), 'program must not fall back to the REPL');
  assert.equal(ledHigh, 0);
});

test('cold-chain scenario: alarm, acknowledge, CSV and daily summary (scripted hardware)', async () => {
  const board = await bootBoard([
    ...program(),
    { name: 'sdcard.py', content: SD_RAM },
    { name: 'ds1307.py', content: RTC_FAKE },
    { name: 'ds18x20.py', content: DS_FAKE },
  ]);
  const led: [number, number][] = [];
  board.pin(16).addListener((s) => {
    if (s === 0 || s === 1) led.push([board.simMs, s]);
  });

  board.runUntilOutput('[START] tipkalo', 3000);
  const t0 = board.simMs;
  board.runUntilOutput('[ALARM] ', 200_000);
  const alarmAt = board.simMs - t0;
  board.runFor(5000);
  assert.deepEqual(led.at(-1)?.[1], 1, 'LED on during alarm');
  pressButton(board);
  board.runFor(500);
  assert.deepEqual(led.at(-1)?.[1], 0, 'LED off after acknowledge');
  board.runUntilOutput('[ALARM KRAJ]', 60_000);
  board.runFor(15_000);
  pressButton(board);
  board.runFor(1000);

  const out = board.output;
  assert.ok(!out.includes('Traceback'), out);
  assert.match(out, /\[SD\] kartica montirana na \/sd/);
  assert.match(out, /\[SD\] nova datoteka \/sd\/hladnjaca\.csv, zapisano zaglavlje/);
  assert.match(out, /\[RTC\] sat: 2026-11-17 23:58:00/);
  assert.match(out, /\[SENZOR\] pronaden DS18B20 \(2801020304050607\)/);
  assert.match(out, /\[MJERENJE\] 2026-11-17 23:58:00 \| 5\.00 C \| U_RASPONU/);
  assert.match(out, /\[SENZOR\] greska ocitanja: nemoguca vrijednost 85\.0/);
  assert.match(out, /\[MJERENJE\] 2026-11-17 23:58:20 \| greska \| U_RASPONU/);
  assert.match(out, /\[MJERENJE\] 2026-11-17 23:58:30 \| 10\.00 C \| ODBROJAVANJE/);
  // First 10 C reading at 30 s; alarm on the reading 130 s later (strictly > 120 s).
  assert.match(out, /\[ALARM\] temperatura 10\.00 C izvan raspona 2\.0-8\.0 C vec 2 min 10 s/);
  assert.ok(alarmAt > 160_000 && alarmAt < 161_500, `alarm at ${alarmAt} ms`);
  assert.match(out, /\[POTVRDA\] alarm potvrden, LED ugasena do novog prekoracenja/);
  assert.match(out, /\[ALARM KRAJ\] temperatura 5\.00 C ponovno u rasponu, ukupno izvan raspona 2 min 40 s/);
  // Midnight: readings 0..11 belong to 2026-11-17 (11 valid, one rejected 85.0).
  assert.match(
    out,
    /\[DNEVNI SAZETAK\] 2026-11-17: mjerenja 11, min 5\.00 C, max 10\.00 C, prosjek 9\.09 C, izvan raspona 1 min 30 s, alarma 0, neuspjelih 1/,
  );
  assert.match(out, /\[MJERENJE\] 2026-11-18 00:00:00 \| 10\.00 C \| ODBROJAVANJE/);
  assert.match(out, /\[SAZETAK\] 2026-11-18: mjerenja \d+, min 5\.00 C, max 10\.00 C, prosjek [\d.]+ C, izvan raspona 1 min 10 s, alarma 1, neuspjelih 0/);
  assert.match(out, /\[CSV\] --- \/sd\/hladnjaca\.csv: zadnjih 10 od \d+ redaka ---\r?\ndatum_vrijeme,temperatura_c,stanje\r?\n/);
  assert.match(out, /2026-11-18 00:01:20,5\.00,U_RASPONU/);
  // LED: on exactly once (alarm), off after acknowledge, never on again.
  assert.deepEqual(led.map(([, s]) => s).filter((s, i, a) => i === 0 || s !== a[i - 1]).slice(-3), [0, 1, 0]);

  // The files on the "card", read back through the REPL.
  board.send('\x03');
  board.runUntilOutput('>>> ', 2000);
  const from = board.output.length;
  board.send("print(open('/sd/hladnjaca.csv').read()); print(open('/sd/sazetak.csv').read())\r");
  board.runUntilOutput('datum,broj_mjerenja', 3000);
  board.runFor(500);
  const files = board.output.slice(from);
  assert.match(files, /datum_vrijeme,temperatura_c,stanje\r?\n2026-11-17 23:58:00,5\.00,U_RASPONU\r?\n2026-11-17 23:58:10,5\.00,U_RASPONU\r?\n2026-11-17 23:58:20,greska,U_RASPONU\r?\n/);
  assert.equal((files.match(/datum_vrijeme,temperatura_c,stanje/g) ?? []).length, 1);
  assert.match(files, /2026-11-18 00:00:40,10\.00,ALARM/);
  assert.match(files, /datum,broj_mjerenja,min_c,max_c,prosjek_c,izvan_raspona_s,broj_alarma,neuspjela_ocitanja\r?\n2026-11-17,11,5\.00,10\.00,9\.09,90,0,1/);
});

// A card that already holds a log from an earlier run: header + 40 rows (> 1100 bytes,
// so the button's tail read starts mid-file).
const SD_PREFILLED = SD_RAM.replace(
  '        os.VfsFat.mkfs(self)\n',
  `        os.VfsFat.mkfs(self)
        os.mount(os.VfsFat(self), "/pre")
        with open("/pre/hladnjaca.csv", "w") as f:
            f.write("datum_vrijeme,temperatura_c,stanje\\n")
            for i in range(40):
                f.write("2026-11-16 10:{:02d}:00,4.{:02d},U_RASPONU\\n".format(i, i))
        os.umount("/pre")
`,
);

test('cold-chain program appends to an existing CSV and dumps its tail', async () => {
  const board = await bootBoard([
    ...program(),
    { name: 'sdcard.py', content: SD_PREFILLED },
    { name: 'ds1307.py', content: RTC_FAKE },
    { name: 'ds18x20.py', content: DS_FAKE },
  ]);
  board.runUntilOutput('[START] tipkalo', 3000);
  assert.match(board.output, /\[SD\] \/sd\/hladnjaca\.csv postoji, 40 redaka mjerenja/);
  board.runFor(25_000); // readings at 0, 10, 20 s
  const from = board.output.length;
  pressButton(board);
  board.runFor(500);
  const dump = board.output.slice(from);
  assert.ok(!board.output.includes('Traceback'), board.output);
  const m = dump.match(/\[CSV\] --- \/sd\/hladnjaca\.csv: zadnjih 10 od 43 redaka ---\r?\n([\s\S]*?)\[CSV\] --- kraj ---/);
  assert.ok(m, dump);
  const rows = m[1].split(/\r?\n/).filter(Boolean);
  assert.deepEqual(rows, [
    'datum_vrijeme,temperatura_c,stanje',
    ...Array.from({ length: 7 }, (_, k) => `2026-11-16 10:${33 + k}:00,4.${33 + k},U_RASPONU`),
    '2026-11-17 23:58:00,5.00,U_RASPONU',
    '2026-11-17 23:58:10,5.00,U_RASPONU',
    '2026-11-17 23:58:20,greska,U_RASPONU',
  ]);

  board.send('\x03');
  board.runUntilOutput('>>> ', 2000);
  const f = board.output.length;
  board.send("print(open('/sd/hladnjaca.csv').read().count('datum_vrijeme'), 'HEADERS')\r");
  board.runUntil(() => /\n\d+ HEADERS/.test(board.output.slice(f)), 3000, 5); // skip the echoed command
  assert.match(board.output.slice(f), /\n1 HEADERS/);
});
