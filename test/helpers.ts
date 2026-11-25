// Shared helpers for automated tests: boot real MicroPython with a set of files,
// in fast-forward mode (simulated time runs as fast as the host allows).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Board, type ProjectFile } from '../src/board.js';
import { boardKindFromFirmware } from '../src/fs.js';

export const ROOT = join(import.meta.dirname, '..');
export const FIRMWARE = 'RPI_PICO_W-20231227-v1.22.0.uf2';

/** All MicroPython files of the real project (project/*.py). */
export function projectFiles(): ProjectFile[] {
  return readdirSync(join(ROOT, 'project'))
    .filter((name) => name.endsWith('.py'))
    .map((name) => ({ name, content: readFileSync(join(ROOT, 'project', name), 'utf8') }));
}

/** A board flashed with MicroPython and `files`, not started (use board.runFor / runUntil). */
export async function bootBoard(files: ProjectFile[], firmware = FIRMWARE): Promise<Board> {
  return Board.create(
    readFileSync(join(ROOT, 'public', 'firmware', firmware)),
    boardKindFromFirmware(firmware),
    files,
    readFileSync(join(ROOT, 'node_modules', 'littlefs', 'dist', 'littlefs.wasm')),
  );
}
