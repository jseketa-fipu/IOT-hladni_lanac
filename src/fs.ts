// Builds the LittleFS image MicroPython mounts at "/" and copies it into flash.
// rp2040js doesn't emulate flash writes well enough for MicroPython to format
// its own storage, so project files are placed in flash before boot (Wokwi does the same).

import createLittleFS from 'littlefs';
import type { ProjectFile } from './board.js';

const BLOCK_SIZE = 4096;
const FLASH_SIZE = 2 * 1024 * 1024;

/** Size of the filesystem at the end of flash, from MicroPython's mpconfigboard.h. */
export const FS_BYTES = {
  RPI_PICO: 1408 * 1024,
  RPI_PICO_W: 848 * 1024,
} as const;
export type BoardKind = keyof typeof FS_BYTES;

export function boardKindFromFirmware(name: string): BoardKind {
  return name.startsWith('RPI_PICO_W') ? 'RPI_PICO_W' : 'RPI_PICO';
}

export async function writeFilesystem(
  flash: Uint8Array,
  kind: BoardKind,
  files: ProjectFile[],
  wasmBinary: ArrayBuffer | Uint8Array,
) {
  const fsBytes = FS_BYTES[kind];
  const blockCount = fsBytes / BLOCK_SIZE;
  const image = new Uint8Array(fsBytes).fill(0xff);

  const lfs = await createLittleFS({ wasmBinary });
  const heap = () => lfs.HEAPU8 as Uint8Array;

  const read = lfs.addFunction((_cfg: number, block: number, off: number, buf: number, size: number) => {
    const start = block * BLOCK_SIZE + off;
    heap().set(image.subarray(start, start + size), buf);
    return 0;
  }, 'iiiiii');
  const prog = lfs.addFunction((_cfg: number, block: number, off: number, buf: number, size: number) => {
    image.set(heap().subarray(buf, buf + size), block * BLOCK_SIZE + off);
    return 0;
  }, 'iiiiii');
  const erase = lfs.addFunction((_cfg: number, block: number) => {
    image.fill(0xff, block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE);
    return 0;
  }, 'iii');
  const sync = lfs.addFunction(() => 0, 'ii');

  // The wasm build exports no malloc, so file contents go in as a string (copied to the stack).
  const writeFile = lfs.cwrap('lfs_write_file', null, ['number', 'string', 'string', 'number']);
  const config = lfs._new_lfs_config(read, prog, erase, sync, blockCount, BLOCK_SIZE);
  const fs = lfs._new_lfs();
  check(lfs._lfs_format(fs, config), 'format');
  check(lfs._lfs_mount(fs, config), 'mount');

  const encoder = new TextEncoder();
  for (const file of files) {
    writeFile(fs, file.name, file.content, encoder.encode(file.content).length);
  }

  check(lfs._lfs_unmount(fs), 'unmount');
  lfs._free(fs);
  lfs._free(config);

  flash.set(image, FLASH_SIZE - fsBytes);
}

function check(result: number, op: string) {
  if (result < 0) throw new Error(`littlefs ${op} failed: ${result}`);
}
