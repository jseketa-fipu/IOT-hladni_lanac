// microSD card (SPI) + FAT16: real MicroPython mounts it with micropython-lib's
// sdcard.py, writes and reads files; the host reads the same files back.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatFat16, listFiles, type BlockStore } from '../src/devices/fat.js';
import { SDCard } from '../src/devices/sdcard.js';
import { ROOT, bootBoard } from './helpers.js';

const SDCARD_PY = { name: 'sdcard.py', content: readFileSync(join(ROOT, 'project', 'sdcard.py'), 'utf8') };

const MAIN = `
import os, sdcard
from machine import Pin, SPI

def mount():
    spi = SPI(0, sck=Pin(2), mosi=Pin(3), miso=Pin(4))
    sd = sdcard.SDCard(spi, Pin(5))
    os.mount(sd, '/sd')
    return sd

sd = mount()
print('SECTORS', sd.sectors)

lines = ['vrijeme,temperatura']
for i in range(300):
    lines.append('2026-11-25 10:%02d:%02d,%.2f' % (i // 60, i % 60, 4.0 + (i % 17) * 0.13))

# append mode across several open/close cycles
for start in range(0, len(lines), 40):
    with open('/sd/mjerenja.csv', 'a') as f:
        for line in lines[start:start + 40]:
            f.write(line + '\\n')
expected = ''.join(l + '\\n' for l in lines)

with open('/sd/mjerenja.csv') as f:
    got = f.read()
print('CSV_MATCH', got == expected, len(got))
import hashlib, binascii
print('CSV_SHA256', binascii.hexlify(hashlib.sha256(got.encode()).digest()).decode())

# a file bigger than 4 KB in one write / one read: multi-block CMD25 / CMD18
big = bytes((i * 7 + 3) & 0xFF for i in range(9000))
with open('/sd/big.bin', 'wb') as f:
    f.write(big)
buf = bytearray(9000)
with open('/sd/big.bin', 'rb') as f:
    n = f.readinto(buf)  # one large read: FatFs reads whole sectors straight into buf
print('BIG_MATCH', n == 9000 and buf == big)

print('LISTDIR', sorted(os.listdir('/sd')))
st = os.statvfs('/sd')
print('STATVFS', st[0], st[2], st[3])

# remount with a new SDCard object
os.umount('/sd')
sd = mount()
with open('/sd/mjerenja.csv') as f:
    print('REMOUNT_MATCH', f.read() == expected)
os.umount('/sd')
print('DONE')
`;

function value(output: string, key: string): string {
  const m = output.match(new RegExp(`${key} (.*)`));
  assert.ok(m, `${key} not printed. Output:\n${output}`);
  return m[1].trim();
}

test('MicroPython mounts the SD card, writes and reads files; host reads them back', async () => {
  const board = await bootBoard([SDCARD_PY, { name: 'main.py', content: MAIN }]);
  const card = new SDCard(board, { spi: 0, csGpio: 5 });
  board.runUntil(() => /DONE|Traceback/.test(board.output), 120000, 10);
  const out = board.output;
  assert.ok(out.includes('DONE'), `program did not finish:\n${out}`);

  assert.equal(value(out, 'SECTORS'), String(64 * 2048));
  assert.match(value(out, 'CSV_MATCH'), /^True \d+$/);
  assert.equal(value(out, 'BIG_MATCH'), 'True');
  assert.equal(value(out, 'LISTDIR'), "['big.bin', 'mjerenja.csv']");
  assert.equal(value(out, 'REMOUNT_MATCH'), 'True');
  const [bsize, blocks, bfree] = value(out, 'STATVFS').split(' ').map(Number);
  assert.equal(bsize, 2048); // 4 sectors per cluster on a 64 MB card
  assert.ok(blocks > 30000 && blocks < 33000, `blocks=${blocks}`);
  assert.ok(bfree < blocks && bfree > blocks - 20, `bfree=${bfree}`);

  // multi-block paths were really used
  assert.ok(card.stats.cmd25 > 0, `cmd25=${card.stats.cmd25}`);
  assert.ok(card.stats.cmd18 > 0, `cmd18=${card.stats.cmd18}`);
  assert.ok(card.stats.cmd24 > 0 && card.stats.cmd17 > 0);

  // host side
  const csvLen = Number(value(out, 'CSV_MATCH').split(' ')[1]);
  const files = card.files();
  assert.deepEqual(
    files.map((f) => f.name).sort(),
    ['big.bin', 'mjerenja.csv'],
  );
  const csv = files.find((f) => f.name === 'mjerenja.csv')!;
  assert.equal(csv.size, csvLen);
  const text = card.readText('mjerenja.csv')!;
  // byte for byte what MicroPython wrote (and read back as equal to what it meant to write)
  assert.equal(createHash('sha256').update(csv.data).digest('hex'), value(out, 'CSV_SHA256'));
  assert.equal(createHash('sha256').update(text).digest('hex'), value(out, 'CSV_SHA256'));
  const lines = text.split('\n');
  assert.equal(lines[0], 'vrijeme,temperatura');
  assert.equal(lines.length, 302); // header + 300 + trailing ''
  assert.equal(lines[1], '2026-11-25 10:00:00,4.00');
  assert.equal(lines[300], '2026-11-25 10:04:59,5.30');
  const big = files.find((f) => f.name === 'big.bin')!;
  assert.equal(big.size, 9000);
  assert.ok(big.data.every((b, i) => b === ((i * 7 + 3) & 0xff)));
  assert.equal(card.readText('nope.txt'), null);

  // reset() erases the card
  card.reset();
  assert.deepEqual(card.files(), []);
  card.detach();
});

test('empty slot: SDCard() raises OSError and the program continues', async () => {
  const main = `
import sdcard
from machine import Pin, SPI
spi = SPI(0, sck=Pin(2), mosi=Pin(3), miso=Pin(4))
try:
    sd = sdcard.SDCard(spi, Pin(5))
    print('MOUNTED')
except OSError as e:
    print('NO_CARD', e)
print('CONTINUES')
`;
  const board = await bootBoard([SDCARD_PY, { name: 'main.py', content: main }]);
  const card = new SDCard(board, { spi: 0, csGpio: 5 });
  card.inserted = false;
  board.runUntilOutput('CONTINUES', 30000);
  assert.match(board.output, /NO_CARD no SD card/);
  assert.ok(!board.output.includes('MOUNTED'));
});

test('host-side FAT reader: long names, lowercase flags, subdirectories', async () => {
  // MicroPython writes these; the reader must return them as written.
  const main = `
import os, sdcard
from machine import Pin, SPI
os.mount(sdcard.SDCard(SPI(0, sck=Pin(2), mosi=Pin(3), miso=Pin(4)), Pin(5)), '/sd')
os.mkdir('/sd/logs')
with open('/sd/logs/Dnevnik mjerenja 2026.txt', 'w') as f:
    f.write('dugo ime')
with open('/sd/README.TXT', 'w') as f:
    f.write('VELIKA')
with open('/sd/a.csv', 'w') as f:
    f.write('x')
os.umount('/sd')
print('DONE')
`;
  const board = await bootBoard([SDCARD_PY, { name: 'main.py', content: main }]);
  const card = new SDCard(board, { spi: 0, csGpio: 5, sizeMB: 16 });
  board.runUntil(() => /DONE|Traceback/.test(board.output), 60000, 10);
  assert.ok(board.output.includes('DONE'), board.output);
  const byName = new Map(card.files().map((f) => [f.name, new TextDecoder().decode(f.data)]));
  assert.equal(byName.get('logs/Dnevnik mjerenja 2026.txt'), 'dugo ime');
  assert.equal(byName.get('README.TXT'), 'VELIKA');
  assert.equal(byName.get('a.csv'), 'x');
  assert.equal(byName.size, 3);
});

test('formatFat16 picks valid FAT16 geometry and rejects sizes it cannot hold', () => {
  const blocks = new Map<number, Uint8Array>();
  const store: BlockStore = {
    read: (lba) => blocks.get(lba)?.slice() ?? new Uint8Array(512),
    write: (lba, d) => void blocks.set(lba, d.slice()),
  };
  for (const mb of [3, 16, 64, 512, 2048]) {
    blocks.clear();
    formatFat16(store, mb * 2048);
    const boot = store.read(0);
    assert.equal(boot[510], 0x55);
    assert.equal(boot[511], 0xaa);
    assert.deepEqual(listFiles(store), []);
  }
  assert.throws(() => formatFat16(store, 2048)); // 1 MB: too small for FAT16
});

for (const sizeMB of [3, 4000]) {
  test(`MicroPython mounts a ${sizeMB} MB card and the host reads the file`, async () => {
    const main = `
import os, sdcard
from machine import Pin, SPI
sd = sdcard.SDCard(SPI(0, sck=Pin(2), mosi=Pin(3), miso=Pin(4)), Pin(5))
os.mount(sd, '/sd')
with open('/sd/t.txt', 'w') as f:
    f.write('velicina ${sizeMB}')
st = os.statvfs('/sd')
print('INFO', sd.sectors, st[0], st[2])
os.umount('/sd')
print('DONE')
`;
    const board = await bootBoard([SDCARD_PY, { name: 'main.py', content: main }]);
    const card = new SDCard(board, { spi: 0, csGpio: 5, sizeMB });
    board.runUntil(() => /DONE|Traceback/.test(board.output), 120000, 10);
    assert.ok(board.output.includes('DONE'), board.output);
    const [sectors, bsize, blocks] = value(board.output, 'INFO').split(' ').map(Number);
    assert.equal(sectors, sizeMB * 2048);
    assert.ok(blocks > 4085 && blocks < 65525 && Math.abs(blocks * bsize - sizeMB * 2 ** 20) < 0.02 * sizeMB * 2 ** 20);
    assert.equal(card.readText('t.txt'), `velicina ${sizeMB}`);
  });
}
