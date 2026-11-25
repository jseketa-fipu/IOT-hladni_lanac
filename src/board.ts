// A simulated Raspberry Pi Pico running real MicroPython firmware.
// Works in the browser and in Node (used by the headless test).

import { ConsoleLogger, GPIOPin, LogLevel, Simulator, USBCDC } from 'rp2040js';
import { bootromB1 } from './bootrom.js';
import { type BoardKind, writeFilesystem } from './fs.js';

const FLASH_START = 0x10000000;
const UF2_MAGIC0 = 0x0a324655;
const UF2_MAGIC1 = 0x9e5d5157;
const UF2_FLAG_NOT_MAIN_FLASH = 0x1;
const CYCLE_NS = 1e9 / 125e6; // 125 MHz, like the real Pico

export interface ProjectFile {
  name: string;
  content: string;
}

/** Copy every UF2 block into the emulated flash. */
export function loadUF2(image: Uint8Array, flash: Uint8Array) {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  for (let off = 0; off + 512 <= image.length; off += 512) {
    if (view.getUint32(off, true) !== UF2_MAGIC0 || view.getUint32(off + 4, true) !== UF2_MAGIC1) {
      throw new Error(`Not a UF2 block at offset ${off}`);
    }
    const flags = view.getUint32(off + 8, true);
    if (flags & UF2_FLAG_NOT_MAIN_FLASH) continue;
    const address = view.getUint32(off + 12, true);
    const size = view.getUint32(off + 16, true);
    flash.set(image.subarray(off + 32, off + 32 + size), address - FLASH_START);
  }
}

export class Board {
  readonly sim = new Simulator();
  readonly mcu = this.sim.rp2040;
  readonly cdc: USBCDC;

  /** Called with every chunk of text MicroPython prints over USB serial. */
  onSerial: (text: string) => void = () => {};
  /** Simulated seconds per real second (smoothed). 1 = real time. */
  speed = 0;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private realStartMs = 0;
  private simStartNs = 0;
  private lastTickMs = 0;
  private txQueue: number[] = [];
  private decoder = new TextDecoder();
  private received = '';
  private waiters: { text: string; from: number; resolve: () => void }[] = [];
  private connectedResolve!: () => void;
  readonly connected = new Promise<void>((r) => (this.connectedResolve = r));

  constructor(firmware: Uint8Array) {
    this.mcu.loadBootrom(bootromB1);
    this.mcu.logger = new ConsoleLogger(LogLevel.Error);
    loadUF2(firmware, this.mcu.flash);

    this.cdc = new USBCDC(this.mcu.usbCtrl);
    this.cdc.onDeviceConnected = () => this.connectedResolve();
    this.cdc.onSerialData = (bytes) => {
      const text = this.decoder.decode(bytes, { stream: true });
      this.received += text;
      this.onSerial(text);
      this.waiters = this.waiters.filter((w) => {
        if (this.received.indexOf(w.text, w.from) < 0) return true;
        w.resolve();
        return false;
      });
    };

    // Nothing is wired to the inputs yet: let them read high, as a pull-up would.
    for (const pin of this.mcu.gpio) pin.setInputValue(true);
    this.mcu.core.PC = FLASH_START;
  }

  /**
   * Flash MicroPython and the project files, ready to start.
   * On start MicroPython mounts the filesystem and runs main.py, like Wokwi's play button.
   */
  static async create(firmware: Uint8Array, kind: BoardKind, files: ProjectFile[], littlefsWasm: ArrayBuffer | Uint8Array) {
    const board = new Board(firmware);
    await writeFilesystem(board.mcu.flash, kind, files, littlefsWasm);
    return board;
  }

  pin(n: number): GPIOPin {
    return this.mcu.gpio[n];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.realStartMs = performance.now();
    this.simStartNs = this.sim.clock.nanos;
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queue bytes for the board's USB serial input. */
  send(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (const b of bytes) this.txQueue.push(b);
  }

  /** Resolve once `text` appears in serial output after the current point. */
  waitFor(text: string, timeoutMs = 20000): Promise<void> {
    const from = this.received.length;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for ${JSON.stringify(text)}`)), timeoutMs);
      this.waiters.push({ text, from, resolve: () => (clearTimeout(t), resolve()) });
    });
  }

  private flushTx() {
    const fifo = this.cdc.txFIFO;
    while (this.txQueue.length && !fifo.full) this.cdc.sendSerialByte(this.txQueue.shift()!);
  }

  /**
   * Run the CPU until simulated time catches up with real time.
   * rp2040js on its own runs as fast as possible and jumps over sleeps,
   * so without this a sleep_ms(500) would pass instantly.
   * The emulator manages ~20 MIPS in V8 and MicroPython busy-waits while sleeping,
   * so in practice the board runs at ~0.2x real time; simulated time stays exact.
   */
  private tick = () => {
    if (!this.running) return;
    const { core } = this.mcu;
    const clock = this.sim.clock;
    const now = performance.now();
    const budgetEnd = now + 15; // keep the page responsive
    let targetNs = this.simStartNs + (now - this.realStartMs) * 1e6;
    const sliceStartNs = clock.nanos;

    while (this.running && clock.nanos < targetNs) {
      this.flushTx();
      for (let i = 0; i < 20000 && clock.nanos < targetNs; i++) {
        if (core.waiting) {
          const next = clock.nanosToNextAlarm;
          const remaining = targetNs - clock.nanos;
          clock.tick(next > 0 ? Math.min(next, remaining) : remaining);
        } else {
          clock.tick(core.executeInstruction() * CYCLE_NS);
        }
      }
      if (performance.now() > budgetEnd) break;
    }

    // If emulation is slower than real time, don't try to catch up forever:
    // let simulated time fall behind and report the speed instead.
    const lagNs = targetNs - clock.nanos;
    if (lagNs > 100e6) {
      this.realStartMs += lagNs / 1e6;
      targetNs = clock.nanos;
    }
    if (this.lastTickMs) {
      const wallMs = now - this.lastTickMs;
      const simMs = (clock.nanos - sliceStartNs) / 1e6;
      if (wallMs > 0) this.speed = 0.9 * this.speed + 0.1 * (simMs / wallMs);
    }
    this.lastTickMs = now;

    this.timer = setTimeout(this.tick, 4);
  };
}
