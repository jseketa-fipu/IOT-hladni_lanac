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

const BOOT_PY = ['# added by pico-sim: wait for the serial monitor', 'import time', 'time.sleep_ms(50)', ''].join('\n');

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
  /** Simulated seconds per real second actually achieved (smoothed). 1 = real time. */
  speed = 0;
  private scale = 1;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private realStartMs = 0;
  private simStartNs = 0;
  private lastTickMs = 0;
  private txQueue: number[] = [];
  private pendingRead: { endpoint: number; size: number } | null = null;
  private cdcRead!: (endpoint: number, size: number) => void;
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

    // rp2040js's emulated host answers every OUT-endpoint read at once, with an empty
    // packet when it has nothing to send. MicroPython re-arms the endpoint immediately,
    // so idle serial turns into ~35,000 USB interrupts per second and the CPU never
    // gets to sleep. A real host stays silent (NAKs) until it has data: do the same.
    const usb = this.mcu.usbCtrl;
    this.cdcRead = usb.onEndpointRead!;
    usb.onEndpointRead = (endpoint, size) => {
      if (this.cdc.txFIFO.itemCount === 0) {
        this.pendingRead = { endpoint, size };
      } else {
        this.cdcRead(endpoint, size);
      }
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
    // MicroPython drops prints made before the USB serial link is up (~18 ms after boot),
    // like a real Pico with no terminal attached. Wokwi shows them all, so give the
    // emulated host time to connect before main.py runs, unless the project has a boot.py.
    const withBoot = files.some((f) => f.name === 'boot.py')
      ? files
      : [{ name: 'boot.py', content: BOOT_PY }, ...files];
    await writeFilesystem(board.mcu.flash, kind, withBoot, littlefsWasm);
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
    this.speed = this.scale; // assume on target until measured otherwise
    this.lastTickMs = 0;
    this.tick();
  }

  /**
   * Requested speed while running in real time: 1 = real time, 10 = ten simulated
   * seconds per real second. The program and simulated time are unaffected; only how
   * fast simulated time passes on screen. If the host can't keep up, `speed` shows
   * what is actually achieved.
   */
  get timeScale() {
    return this.scale;
  }
  set timeScale(value: number) {
    if (!(value > 0)) throw new Error('timeScale must be > 0');
    // Re-anchor so the change applies from now on, without a jump in simulated time.
    this.realStartMs = performance.now();
    this.simStartNs = this.sim.clock.nanos;
    this.scale = value;
    this.speed = value;
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
    if (this.pendingRead && fifo.itemCount > 0) {
      const { endpoint, size } = this.pendingRead;
      this.pendingRead = null;
      this.cdcRead(endpoint, size);
    }
  }

  /**
   * Run the CPU until simulated time catches up with real time.
   * rp2040js on its own runs as fast as possible and jumps over sleeps,
   * so without this a sleep_ms(500) would pass instantly.
   * The emulator manages ~20 MIPS in V8; when the program sleeps, the core waits
   * (WFE) and the clock jumps straight to the next timer alarm.
   */
  private tick = () => {
    if (!this.running) return;
    const clock = this.sim.clock;
    const now = performance.now();
    const budgetEnd = now + 15; // keep the page responsive
    const targetNs = this.simStartNs + (now - this.realStartMs) * 1e6 * this.scale;
    const sliceStartNs = clock.nanos;

    while (this.running && clock.nanos < targetNs) {
      this.advance(targetNs, 20000);
      if (performance.now() > budgetEnd) break;
    }

    // If emulation is slower than requested, don't try to catch up forever:
    // let simulated time fall behind and report the achieved speed instead.
    if (targetNs - clock.nanos > 100e6 * this.scale) {
      this.realStartMs = now;
      this.simStartNs = clock.nanos;
    }
    if (this.lastTickMs) {
      const wallMs = now - this.lastTickMs;
      const simMs = (clock.nanos - sliceStartNs) / 1e6;
      // Smooth over about half a second of wall time, however often ticks run.
      const alpha = 1 - Math.exp(-wallMs / 500);
      if (wallMs > 0) this.speed += alpha * (simMs / wallMs - this.speed);
    }
    this.lastTickMs = now;

    this.timer = setTimeout(this.tick, 4);
  };

  /** Execute up to `maxSteps` instructions/idle jumps without passing `targetNs`. */
  private advance(targetNs: number, maxSteps: number) {
    const { core } = this.mcu;
    const clock = this.sim.clock;
    this.flushTx();
    for (let i = 0; i < maxSteps && clock.nanos < targetNs; i++) {
      if (core.waiting) {
        const next = clock.nanosToNextAlarm;
        const remaining = targetNs - clock.nanos;
        clock.tick(next > 0 ? Math.min(next, remaining) : remaining);
      } else {
        clock.tick(core.executeInstruction() * CYCLE_NS);
      }
    }
  }

  // ---------- fast-forward API for automated tests (no real-time pacing) ----------

  /** Simulated time in milliseconds since power-on. */
  get simMs() {
    return this.sim.clock.nanos / 1e6;
  }

  /** Everything MicroPython has printed so far. */
  get output() {
    return this.received;
  }

  /** Run as fast as the host allows for `ms` of simulated time. Don't mix with start(). */
  runFor(ms: number) {
    const target = this.sim.clock.nanos + ms * 1e6;
    while (this.sim.clock.nanos < target) this.advance(target, 50000);
  }

  /**
   * Run until `done()` is true (checked every `stepMs` of simulated time) or `maxMs` passes.
   * Returns whether the condition was met.
   */
  runUntil(done: () => boolean, maxMs: number, stepMs = 1): boolean {
    const end = this.sim.clock.nanos + maxMs * 1e6;
    while (!done()) {
      if (this.sim.clock.nanos >= end) return false;
      this.runFor(stepMs);
    }
    return true;
  }

  /** Run until `text` appears in the output after the current point; throws on timeout. */
  runUntilOutput(text: string, maxMs: number): void {
    const from = this.received.length;
    if (!this.runUntil(() => this.received.indexOf(text, from) >= 0, maxMs, 5)) {
      throw new Error(`"${text}" not printed within ${maxMs} ms of simulated time`);
    }
  }
}
