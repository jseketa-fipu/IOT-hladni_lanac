// DS1307 real-time clock on I2C (address 0x68), driven by SIMULATED time.
//
// Registers (datasheet layout, BCD):
//   0x00 seconds (bit 7 = CH, clock halt)   0x04 date 1-31
//   0x01 minutes                            0x05 month 1-12
//   0x02 hours (bit 6 = 12h mode, bit 5 PM) 0x06 year 00-99 (= 2000-2099)
//   0x03 day of week 1-7                    0x07 control (stored, no square wave)
//   0x08-0x3F 56 bytes battery-backed RAM
// A write sets the register pointer with its first byte and writes the rest from there;
// a read returns bytes from the pointer. The pointer auto-increments and wraps 0x3F -> 0x00.
// Time registers written in a transaction take effect when it ends (STOP or repeated
// START) and restart the seconds count from that instant. Reads see a snapshot taken
// when the read starts, so a multi-byte read never tears across a second boundary.
//
// The clock is a JS Date whose UTC fields ARE the RTC fields (no time zones), counted
// from board.sim.clock.nanos, so fast-forward tests see time pass at simulated speed.
//
// Two transports reach the same device code:
//  * the RP2040 I2C peripheral (RPI2C callbacks): readfrom/writeto/readfrom_mem/...
//  * a pin-level (bit-banged) target on the SDA/SCL GPIOs. MicroPython's rp2 port sends
//    zero-length writes - which is what i2c.scan() does - by bit-banging the pins as
//    plain GPIO, so without this scan() would never see the device.
//
// Sharing the bus with other devices: implement `I2CTarget` and register it with
// `i2cBus(board, n, pins).add(target)`. The bus owns the RPI2C callbacks and the pin
// decoder and routes each transaction by address (unknown addresses are NACKed).
// Remove a target with `bus.remove(target)`; when the last one goes the bus restores the
// peripheral's previous callbacks and stops listening to the pins.

import { type GPIOPin, GPIOPinState, I2CMode, type RPI2C } from 'rp2040js';
import type { Board } from '../board.js';

// ---------------------------------------------------------------- generic I2C bus

/** One device on an I2C bus. Each method is called once per bus event. */
export interface I2CTarget {
  /** 7-bit address. */
  readonly address: number;
  /** Address matched (START + address byte). Return true to ACK. */
  connect(mode: I2CMode): boolean;
  /** Master wrote a byte. Return true to ACK. */
  write(value: number): boolean;
  /** Master reads a byte. */
  read(): number;
  /** Transaction ended: STOP, or a repeated START (a new connect() follows). */
  end(): void;
}

const FUNCTION_SIO = 5;
const R_TX_EMPTY = 1 << 4;

/**
 * Work around an rp2040js quirk: a NACK aborts and empties the TX FIFO but never raises
 * the (level-triggered on real hardware) TX_EMPTY interrupt. pico-sdk waits for TX_EMPTY
 * before it looks at the abort, so every NACK became ETIMEDOUT and left a stale abort flag
 * that failed the NEXT transfer with EIO. With TX_EMPTY raised, a NACK gives EIO
 * like on a real Pico and the next transfer is clean.
 */
function raiseTxEmpty(p: RPI2C) {
  (p as unknown as { setInterrupts(mask: number): void }).setInterrupts(R_TX_EMPTY);
}

/** Routes one RP2040 I2C bus (hardware peripheral + bit-banged pins) to its targets. */
export class I2CBus {
  private readonly targets = new Set<I2CTarget>();
  private current: I2CTarget | null = null;
  private saved: Pick<RPI2C, 'onStart' | 'onConnect' | 'onWriteByte' | 'onReadByte' | 'onStop'> | null = null;
  private unlisten: (() => void)[] = [];
  private readonly sda: GPIOPin;
  private readonly scl: GPIOPin;

  // Pin-level target state
  private sdaLevel = true;
  private sclLevel = true;
  private drivingLow = false;
  private phase: 'idle' | 'addr' | 'addrAck' | 'rx' | 'rxAck' | 'tx' | 'txAck' = 'idle';
  private bits = 0;
  private shift = 0;
  private reading = false;
  private acked = false;
  private masterAck = false;

  constructor(
    private readonly board: Board,
    readonly peripheral: RPI2C,
    pins: { sda: number; scl: number },
  ) {
    this.sda = board.pin(pins.sda);
    this.scl = board.pin(pins.scl);
  }

  add(target: I2CTarget) {
    if (this.targets.size === 0) this.install();
    this.targets.add(target);
  }

  remove(target: I2CTarget) {
    if (!this.targets.delete(target)) return;
    if (this.current === target) this.current = null;
    if (this.targets.size === 0) this.uninstall();
  }

  private find(address: number) {
    for (const t of this.targets) if (t.address === address) return t;
    return null;
  }

  private endCurrent() {
    const t = this.current;
    this.current = null;
    t?.end();
  }

  private install() {
    const p = this.peripheral;
    this.saved = { onStart: p.onStart, onConnect: p.onConnect, onWriteByte: p.onWriteByte, onReadByte: p.onReadByte, onStop: p.onStop };
    p.onStart = () => {
      this.endCurrent(); // repeated START ends the previous transfer
      p.completeStart();
    };
    p.onConnect = (address, mode) => {
      const t = this.find(address);
      const ack = !!t && t.connect(mode);
      this.current = ack ? t : null;
      p.completeConnect(ack);
      if (!ack) raiseTxEmpty(p);
    };
    p.onWriteByte = (value) => {
      const ack = this.current ? this.current.write(value) : false;
      p.completeWrite(ack);
      if (!ack) raiseTxEmpty(p);
    };
    p.onReadByte = () => p.completeRead(this.current ? this.current.read() & 0xff : 0xff);
    p.onStop = () => {
      this.endCurrent();
      p.completeStop();
    };

    this.sdaLevel = this.lineLevel(this.sda);
    this.sclLevel = this.lineLevel(this.scl);
    this.unlisten = [this.sda.addListener(this.onPins), this.scl.addListener(this.onPins)];
  }

  private uninstall() {
    if (this.saved) Object.assign(this.peripheral, this.saved);
    this.saved = null;
    for (const u of this.unlisten) u();
    this.unlisten = [];
    this.resetPins();
  }

  // ---------- pin-level (bit-banged) target ----------

  /** Open-drain line with pull-up: low only when the MCU drives it low (or we do, for SDA). */
  private lineLevel(pin: GPIOPin) {
    return pin.value !== GPIOPinState.Low && !(pin === this.sda && this.drivingLow);
  }

  private driveSda(low: boolean) {
    if (this.drivingLow === low) return;
    this.drivingLow = low;
    this.sdaLevel = this.lineLevel(this.sda);
    this.sda.setInputValue(this.sdaLevel);
  }

  private resetPins() {
    if (this.phase !== 'idle') this.endCurrent(); // a bit-banged transfer cut short
    this.phase = 'idle';
    this.driveSda(false);
    this.sda.setInputValue(true);
  }

  private onPins = () => {
    if (this.sda.functionSelect !== FUNCTION_SIO || this.scl.functionSelect !== FUNCTION_SIO) {
      // Pins handed back to the I2C peripheral (or elsewhere): forget any bit-bang state.
      if (this.phase !== 'idle' || this.drivingLow) this.resetPins();
      this.sdaLevel = this.sclLevel = true;
      return;
    }
    const sda = this.lineLevel(this.sda);
    const scl = this.lineLevel(this.scl);
    const sdaChanged = sda !== this.sdaLevel;
    const sclChanged = scl !== this.sclLevel;
    this.sdaLevel = sda;
    this.sclLevel = scl;
    // What the MCU reads back on SDA (SCL is never stretched: its input stays high).
    this.sda.setInputValue(sda);

    if (sdaChanged && scl && !sclChanged) {
      if (!sda) this.startCondition();
      else this.stopCondition();
      return;
    }
    if (sclChanged) {
      if (scl) this.sclRise(sda);
      else this.sclFall();
    }
  };

  private startCondition() {
    if (this.phase !== 'idle') this.endCurrent(); // repeated START
    this.driveSda(false);
    this.phase = 'addr';
    this.bits = 0;
    this.shift = 0;
  }

  private stopCondition() {
    this.driveSda(false);
    this.endCurrent();
    this.phase = 'idle';
  }

  private sclRise(sda: boolean) {
    switch (this.phase) {
      case 'addr':
      case 'rx':
        if (this.bits < 8) {
          this.shift = ((this.shift << 1) | (sda ? 1 : 0)) & 0xff;
          this.bits++;
        }
        break;
      case 'txAck':
        this.masterAck = !sda;
        break;
    }
  }

  private sclFall() {
    switch (this.phase) {
      case 'addr':
        if (this.bits < 8) return;
        {
          const address = this.shift >> 1;
          this.reading = !!(this.shift & 1);
          const t = this.find(address);
          this.acked = !!t && t.connect(this.reading ? I2CMode.Read : I2CMode.Write);
          this.current = this.acked ? t : null;
          this.phase = 'addrAck';
          this.driveSda(this.acked);
        }
        return;
      case 'rx':
        if (this.bits < 8) return;
        this.acked = this.current ? this.current.write(this.shift) : false;
        this.phase = 'rxAck';
        this.driveSda(this.acked);
        return;
      case 'addrAck':
      case 'rxAck':
        // End of the ACK clock: release SDA, then send or receive the next byte.
        this.driveSda(false);
        if (!this.acked) {
          this.phase = 'idle';
          this.endCurrent();
        } else if (this.reading) {
          this.loadTx();
        } else {
          this.phase = 'rx';
          this.bits = 0;
          this.shift = 0;
        }
        return;
      case 'tx':
        this.bits++;
        if (this.bits < 8) {
          this.driveSda(!((this.shift << this.bits) & 0x80));
        } else {
          this.driveSda(false);
          this.phase = 'txAck';
          this.masterAck = false;
        }
        return;
      case 'txAck':
        if (this.masterAck) {
          this.loadTx();
        } else {
          this.phase = 'idle'; // master NACKed: it will send STOP
        }
        return;
    }
  }

  private loadTx() {
    this.shift = this.current ? this.current.read() & 0xff : 0xff;
    this.bits = 0;
    this.phase = 'tx';
    this.driveSda(!(this.shift & 0x80));
  }
}

const buses = new WeakMap<RPI2C, I2CBus>();

/**
 * The shared router for I2C bus `n` of `board`. Pins are the SDA/SCL GPIOs used for the
 * bit-banged path (default GP8/GP9 for bus 0, the group plan; GP6/GP7 for bus 1).
 * The first caller's pins win.
 */
export function i2cBus(board: Board, n: 0 | 1, pins?: { sda: number; scl: number }): I2CBus {
  const peripheral = board.mcu.i2c[n];
  let bus = buses.get(peripheral);
  if (!bus) {
    bus = new I2CBus(board, peripheral, pins ?? (n === 0 ? { sda: 8, scl: 9 } : { sda: 6, scl: 7 }));
    buses.set(peripheral, bus);
  }
  return bus;
}

// ---------------------------------------------------------------- DS1307

const DAY_MS = 86400000;
const bcd = (n: number) => ((Math.floor(n / 10) << 4) | n % 10) & 0xff;
const unbcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);

export interface DS1307Options {
  /** Which RP2040 I2C peripheral the chip is wired to. */
  i2c: 0 | 1;
  /**
   * Initial RTC time: a Date whose UTC fields are the clock fields.
   * Default: the host's current local time, its local fields copied into UTC fields.
   */
  start?: Date;
  /** GPIOs for the bit-banged path (i2c.scan()). Default GP8/GP9 on bus 0, GP6/GP7 on bus 1. */
  pins?: { sda: number; scl: number };
}

/**
 * DS1307 RTC at address 0x68.
 * Day of week: setTime() and the default start set it ISO-style (Monday = 1 ... Sunday = 7);
 * a program may write any 1-7 value, which then advances by one at each midnight.
 * Power-up state: clock running (CH = 0), control register 0x03, RAM all zero.
 */
export class DS1307 implements I2CTarget {
  readonly address = 0x68;

  private readonly bus: I2CBus;
  private epochMs: number; // RTC time (UTC fields) at `baseNs`
  private baseNs: number;
  private halted = false;
  private mode12 = false;
  private dowOffset = 0; // weekday = ((dayNumber + dowOffset) mod 7) + 1
  private control = 0x03;
  private readonly ram = new Uint8Array(56);

  // Transaction state
  private pointer = 0;
  private firstWrite = false;
  private snapshot: Uint8Array = new Uint8Array(7);
  private timeDirty = false;

  constructor(
    private readonly board: Board,
    options: DS1307Options,
  ) {
    let start = options.start;
    if (!start) {
      const d = new Date();
      start = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()));
    }
    this.epochMs = 0;
    this.baseNs = 0;
    this.setTime(start);
    this.bus = i2cBus(board, options.i2c, options.pins);
    this.bus.add(this);
  }

  /** Current RTC time (UTC fields = clock fields), including milliseconds. */
  now(): Date {
    return new Date(this.nowMs());
  }

  /** Set the clock from the host; it keeps running (or stays halted) from this instant. */
  setTime(date: Date): void {
    const ms = date.getTime();
    if (Number.isNaN(ms)) throw new RangeError('DS1307.setTime: invalid Date');
    const year = date.getUTCFullYear();
    if (year < 2000 || year > 2099) throw new RangeError(`DS1307 holds years 2000-2099, got ${year}`);
    this.epochMs = ms;
    this.baseNs = this.board.sim.clock.nanos;
    const isoDow = ((date.getUTCDay() + 6) % 7) + 1;
    this.setWeekday(ms, isoDow);
  }

  /** Disconnect from the bus. */
  detach(): void {
    this.bus.remove(this);
  }

  // ---------- time keeping ----------

  private nowMs() {
    if (this.halted) return this.epochMs;
    const ms = this.epochMs + Math.floor((this.board.sim.clock.nanos - this.baseNs) / 1e6);
    const d = new Date(ms);
    if (d.getUTCFullYear() <= 2099) return ms;
    // The chip's two-digit year wraps 99 -> 00: carry on from 2000, keeping the weekday.
    const dow = this.weekday(ms);
    d.setUTCFullYear(d.getUTCFullYear() - 100);
    this.epochMs -= ms - d.getTime();
    this.setWeekday(d.getTime(), dow);
    return d.getTime();
  }

  private setWeekday(ms: number, dow: number) {
    const day = Math.floor(ms / DAY_MS);
    this.dowOffset = (((dow - 1 - day) % 7) + 7) % 7;
  }

  private weekday(ms: number) {
    return ((((Math.floor(ms / DAY_MS) + this.dowOffset) % 7) + 7) % 7) + 1;
  }

  private timeRegisters(): Uint8Array {
    const ms = this.nowMs();
    const d = new Date(ms);
    const h = d.getUTCHours();
    const hours = this.mode12 ? 0x40 | (h >= 12 ? 0x20 : 0) | bcd(h % 12 || 12) : bcd(h);
    return Uint8Array.of(
      (this.halted ? 0x80 : 0) | bcd(d.getUTCSeconds()),
      bcd(d.getUTCMinutes()),
      hours,
      this.weekday(ms),
      bcd(d.getUTCDate()),
      bcd(d.getUTCMonth() + 1),
      bcd(d.getUTCFullYear() - 2000),
    );
  }

  /** Apply time registers written by the program: count restarts now. */
  private commitTime() {
    const r = this.snapshot;
    const hr = r[2];
    let hour: number;
    if (hr & 0x40) {
      this.mode12 = true;
      hour = (unbcd(hr & 0x1f) % 12) + (hr & 0x20 ? 12 : 0);
    } else {
      this.mode12 = false;
      hour = unbcd(hr & 0x3f);
    }
    // Out-of-range values (e.g. 31 February) roll over, as Date.UTC does.
    const ms = Date.UTC(2000 + unbcd(r[6]), unbcd(r[5] & 0x1f) - 1, unbcd(r[4] & 0x3f), hour, unbcd(r[1] & 0x7f), unbcd(r[0] & 0x7f));
    this.epochMs = ms;
    this.baseNs = this.board.sim.clock.nanos;
    this.halted = !!(r[0] & 0x80);
    this.setWeekday(ms, (r[3] & 0x07) || 1);
  }

  // ---------- I2CTarget ----------

  connect(mode: I2CMode): boolean {
    this.snapshot = this.timeRegisters();
    this.timeDirty = false;
    this.firstWrite = mode === I2CMode.Write;
    return true;
  }

  write(value: number): boolean {
    if (this.firstWrite) {
      this.firstWrite = false;
      this.pointer = value & 0x3f;
      return true;
    }
    const p = this.pointer;
    if (p < 7) {
      this.snapshot[p] = value;
      this.timeDirty = true;
    } else if (p === 7) {
      this.control = value & 0x93;
    } else {
      this.ram[p - 8] = value;
    }
    this.pointer = (p + 1) & 0x3f;
    return true;
  }

  read(): number {
    const p = this.pointer;
    this.pointer = (p + 1) & 0x3f;
    if (p < 7) return this.snapshot[p];
    if (p === 7) return this.control;
    return this.ram[p - 8];
  }

  end(): void {
    if (this.timeDirty) this.commitTime();
    this.timeDirty = false;
    this.firstWrite = false;
  }
}
