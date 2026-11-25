// Shared helpers for automated tests: boot real MicroPython with a set of files,
// in fast-forward mode (simulated time runs as fast as the host allows).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Board, type ProjectFile } from '../src/board.js';
import { boardKindFromFirmware } from '../src/fs.js';
import { CircuitSystem, type Diagram, type SystemOptions } from '../src/system.js';

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
  const image = join(ROOT, 'public', 'firmware', firmware);
  // The images are downloaded, not committed (npm run test:sim / sim / dev / build fetch them).
  if (!existsSync(image)) throw new Error(`firmware missing: ${image} (run npm run fetch-firmware)`);
  return Board.create(
    readFileSync(image),
    boardKindFromFirmware(firmware),
    files,
    readFileSync(join(ROOT, 'node_modules', 'littlefs', 'dist', 'littlefs.wasm')),
  );
}

/** project/diagram.json, parsed. */
export function projectDiagram(): Diagram {
  return JSON.parse(readFileSync(join(ROOT, 'project', 'diagram.json'), 'utf8'));
}

/** Fixed RTC start for scenario tests, so runs are reproducible (UTC fields = clock fields). */
export const DEFAULT_RTC_START = new Date(Date.UTC(2026, 10, 17, 10, 0, 0));

export interface BootSystemOptions extends SystemOptions {
  /** Replaces project/diagram.json (e.g. a deliberately miswired variant). */
  diagram?: Diagram;
  /** Replaces project/*.py. */
  files?: ProjectFile[];
  firmware?: string;
}

/**
 * The real project: MicroPython with project/*.py and the parts of project/diagram.json
 * attached through a CircuitSystem. Not started: drive it with board.runFor / runUntil.
 * The RTC starts at DEFAULT_RTC_START unless options.rtcTime says otherwise.
 */
export async function bootSystem(options: BootSystemOptions = {}): Promise<{ board: Board; system: CircuitSystem }> {
  const { diagram = projectDiagram(), files = projectFiles(), firmware = FIRMWARE, ...systemOptions } = options;
  const board = await bootBoard(files, firmware);
  const system = new CircuitSystem(diagram, board, { rtcTime: DEFAULT_RTC_START, ...systemOptions });
  return { board, system };
}
