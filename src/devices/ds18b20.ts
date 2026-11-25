// DS18B20 1-Wire digital thermometer, modelled from the bus line's point of view.
//
// The firmware talks to it through MicroPython's own `onewire` / `ds18x20` modules,
// which bit-bang the DQ pin in open-drain mode: "low" = pin driven low (output enabled),
// "high" = pin released (input; the 4.7k pull-up makes the line read high). This model
// watches the master's pin transitions with their simulated timestamps and answers by
// pulling the line low exactly like the real chip:
//
//   reset     master low >= 300 us  -> presence pulse: low from 30 us to 150 us after release
//   write     master low < 30 us = 1, otherwise 0 (the chip samples ~15-30 us into the slot)
//   read      master falling edge -> if the bit to send is 0, hold the line low for 30 us
//
// ROM commands: F0 SEARCH ROM, 33 READ ROM, 55 MATCH ROM, CC SKIP ROM, EC ALARM SEARCH.
// Function commands: 44 CONVERT T, BE READ SCRATCHPAD, 4E WRITE SCRATCHPAD,
// 48 COPY SCRATCHPAD, B8 RECALL E2, B4 READ POWER SUPPLY (externally powered -> 1).
//
// Line ownership: the DS18B20 model is the authority for its DQ pin's input value.
// Whenever the master or any attached sensor changes the line, the model recomputes it
// as "low if the master drives low or any sensor pulls low, else high" and writes it with
// pin.setInputValue(). Other code (e.g. a circuit/net simulation) must not set that pin's
// input value while a sensor is attached; anything it writes is overwritten at the next
// line change. Several DS18B20 on the same pin share one bus object (wired-AND), so
// search ROM finds all of them.

import { type GPIOPin, GPIOPinState } from 'rp2040js';
import type { Board } from '../board.js';
import { crc8 } from './onewire-crc.js';

const US = 1000; // ns per microsecond

const RESET_MIN_NS = 300 * US;
const WRITE_ONE_MAX_NS = 30 * US;
const PRESENCE_DELAY_NS = 30 * US;
const PRESENCE_LENGTH_NS = 120 * US;
const READ_ZERO_HOLD_NS = 30 * US;
const COPY_TIME_NS = 10e6; // EEPROM write, 10 ms max

/** Conversion time in ns for resolution codes 0..3 (9..12 bit). */
const CONVERSION_NS = [93.75e6, 187.5e6, 375e6, 750e6];

export interface DS18B20Options {
  /** Initial temperature in deg C (default 20). */
  temperature?: number;
  /** 6-byte serial number (ROM bytes 1..6). Default: a fresh one per instance. */
  serial?: number[];
}

type Phase =
  | { kind: 'idle' } // deselected or no reset yet: ignore everything until the next reset
  | { kind: 'rx'; count: number; value: number; got: number; done: (value: number) => void }
  | { kind: 'tx'; bits: number[]; index: number; done: () => void }
  | { kind: 'status'; bit: () => number }; // every read slot returns bit()

/** All sensors sharing one pin, and the line level they produce together. */
class OneWireBus {
  readonly devices = new Set<DS18B20>();
  masterLow: boolean;
  private readonly unsubscribe: () => void;

  constructor(readonly pin: GPIOPin) {
    this.masterLow = pin.value === GPIOPinState.Low;
    this.unsubscribe = pin.addListener((state) => {
      const low = state === GPIOPinState.Low;
      if (low === this.masterLow) return;
      this.masterLow = low;
      for (const d of this.devices) {
        if (low) d.masterFell();
        else d.masterRose();
      }
      this.update();
    });
  }

  update() {
    let low = this.masterLow;
    for (const d of this.devices) if (d.pulling) low = true;
    this.pin.setInputValue(!low);
  }

  dispose() {
    this.unsubscribe();
    buses.delete(this.pin);
  }
}

const buses = new Map<GPIOPin, OneWireBus>();
let nextSerial = 1;

export class DS18B20 {
  /** 64-bit ROM code: family 0x28, 6-byte serial, CRC8. Byte 0 is sent first, LSB first. */
  readonly rom: Uint8Array;

  /** True while this sensor is pulling DQ low. Read by the bus. */
  pulling = false;

  private temp: number;
  private present = true;
  private readonly bus: OneWireBus;
  private readonly clock: Board['sim']['clock'];
  private phase: Phase = { kind: 'idle' };
  private fallNs = 0;

  // Scratchpad registers and EEPROM.
  private tempRaw = 0x0550; // 85.0 C power-on value
  private th = 0x4b;
  private tl = 0x46;
  private config = 0x7f; // 12-bit
  private eeprom = { th: 0x4b, tl: 0x46, config: 0x7f };
  private alarmFlag = false;
  private converting = false;
  private copyDoneNs = 0;

  private lineStep: 'none' | 'presence-wait' | 'presence-low' | 'read-low' = 'none';
  private readonly lineAlarm;
  private readonly convAlarm;
  private detached = false;

  constructor(board: Board, gpio: number, options: DS18B20Options = {}) {
    const serial = options.serial ?? defaultSerial();
    if (serial.length !== 6) throw new Error('DS18B20 serial must be 6 bytes');
    const rom = new Uint8Array(8);
    rom[0] = 0x28;
    for (let i = 0; i < 6; i++) rom[1 + i] = serial[i] & 0xff;
    rom[7] = crc8(rom, 7);
    this.rom = rom;
    this.temp = clampTemp(options.temperature ?? 20);

    this.clock = board.sim.clock;
    this.lineAlarm = this.clock.createAlarm(() => this.onLineAlarm());
    this.convAlarm = this.clock.createAlarm(() => this.finishConversion());

    const pin = board.pin(gpio);
    let bus = buses.get(pin);
    if (!bus) {
      bus = new OneWireBus(pin);
      buses.set(pin, bus);
    }
    this.bus = bus;
    bus.devices.add(this);
    bus.update();
  }

  /** Temperature in deg C the sensor measures at its next conversion (clamped to -55..125). */
  get temperature() {
    return this.temp;
  }
  set temperature(value: number) {
    this.temp = clampTemp(value);
  }

  /**
   * false: behaves like an absent sensor (no presence pulse, never pulls the line).
   * Unplugging cuts the sensor's power, so plugging it back in is a power-on: the
   * scratchpad returns to 85.0 C and TH/TL/config are reloaded from EEPROM, like the real chip.
   */
  get connected() {
    return this.present;
  }
  set connected(value: boolean) {
    if (value === this.present || this.detached) return;
    this.present = value;
    this.lineAlarm.cancel();
    this.convAlarm.cancel();
    this.converting = false;
    this.lineStep = 'none';
    this.phase = { kind: 'idle' };
    this.pulling = false;
    if (value) this.powerOn();
    this.bus.update();
  }

  private powerOn() {
    this.tempRaw = 0x0550; // 85.0 C
    this.th = this.eeprom.th;
    this.tl = this.eeprom.tl;
    this.config = this.eeprom.config;
    this.alarmFlag = false;
  }

  /** Remove the sensor from the pin. If it was the last one, the line is left idle (high). */
  detach() {
    if (this.detached) return;
    this.detached = true;
    this.lineAlarm.cancel();
    this.convAlarm.cancel();
    this.pulling = false;
    this.bus.devices.delete(this);
    this.bus.update();
    if (this.bus.devices.size === 0) this.bus.dispose();
  }

  // ---------- line events (called by the bus) ----------

  /** @internal */
  masterFell() {
    if (!this.present) return;
    this.fallNs = this.clock.nanos;
    if (this.lineStep === 'read-low') {
      this.lineAlarm.cancel();
      this.lineStep = 'none';
      this.pulling = false;
    }
    if (this.lineStep !== 'none') return; // presence pulse in progress
    const phase = this.phase;
    let bit = 1;
    if (phase.kind === 'tx') {
      // The phase moves on at the end of the slot (masterRose), not here: the rising
      // edge of this read slot must not be taken for a write slot of the next phase.
      bit = phase.bits[phase.index++];
    } else if (phase.kind === 'status') {
      bit = phase.bit();
    } else {
      return;
    }
    if (bit === 0) {
      this.pulling = true;
      this.lineStep = 'read-low';
      this.lineAlarm.schedule(READ_ZERO_HOLD_NS);
    }
  }

  /** @internal */
  masterRose() {
    if (!this.present) return;
    const lowNs = this.clock.nanos - this.fallNs;
    if (lowNs >= RESET_MIN_NS) {
      this.reset();
      return;
    }
    if (this.lineStep === 'presence-wait' || this.lineStep === 'presence-low') return;
    const phase = this.phase;
    if (phase.kind === 'tx' && phase.index >= phase.bits.length) {
      phase.done();
      return;
    }
    if (phase.kind !== 'rx') return;
    const bit = lowNs < WRITE_ONE_MAX_NS ? 1 : 0;
    phase.value |= bit << phase.got;
    phase.got++;
    if (phase.got >= phase.count) phase.done(phase.value);
  }

  private onLineAlarm() {
    switch (this.lineStep) {
      case 'presence-wait':
        this.pulling = true;
        this.lineStep = 'presence-low';
        this.lineAlarm.schedule(PRESENCE_LENGTH_NS);
        break;
      case 'presence-low':
      case 'read-low':
        this.pulling = false;
        this.lineStep = 'none';
        break;
    }
    this.bus.update();
  }

  // ---------- protocol ----------

  private reset() {
    this.lineAlarm.cancel();
    this.pulling = false;
    this.lineStep = 'presence-wait';
    this.lineAlarm.schedule(PRESENCE_DELAY_NS);
    this.receive(8, (cmd) => this.romCommand(cmd));
  }

  private receive(count: number, done: (value: number) => void) {
    this.phase = { kind: 'rx', count, value: 0, got: 0, done };
  }

  private send(bytesOrBits: { bytes?: ArrayLike<number>; bits?: number[] }, done: () => void) {
    let bits = bytesOrBits.bits ?? [];
    if (bytesOrBits.bytes) {
      bits = [];
      for (let i = 0; i < bytesOrBits.bytes.length; i++) {
        for (let b = 0; b < 8; b++) bits.push((bytesOrBits.bytes[i] >> b) & 1);
      }
    }
    this.phase = { kind: 'tx', bits, index: 0, done };
  }

  private idle() {
    this.phase = { kind: 'idle' };
  }

  private romCommand(cmd: number) {
    switch (cmd) {
      case 0xf0: // SEARCH ROM
        this.searchBit(0);
        break;
      case 0xec: // ALARM SEARCH: only sensors with the alarm flag set take part
        if (this.alarmFlag) this.searchBit(0);
        else this.idle();
        break;
      case 0x33: // READ ROM
        this.send({ bytes: this.rom }, () => this.receive(8, (c) => this.functionCommand(c)));
        break;
      case 0x55: // MATCH ROM
        this.matchByte(0);
        break;
      case 0xcc: // SKIP ROM
        this.receive(8, (c) => this.functionCommand(c));
        break;
      default:
        this.idle();
    }
  }

  private matchByte(i: number) {
    this.receive(8, (v) => {
      if (v !== this.rom[i]) return this.idle();
      if (i === 7) this.receive(8, (c) => this.functionCommand(c));
      else this.matchByte(i + 1);
    });
  }

  private searchBit(i: number) {
    const bit = (this.rom[i >> 3] >> (i & 7)) & 1;
    this.send({ bits: [bit, bit ^ 1] }, () =>
      this.receive(1, (dir) => {
        if (dir !== bit) return this.idle();
        if (i === 63) this.receive(8, (c) => this.functionCommand(c));
        else this.searchBit(i + 1);
      }),
    );
  }

  private functionCommand(cmd: number) {
    switch (cmd) {
      case 0x44: // CONVERT T
        this.startConversion();
        this.phase = { kind: 'status', bit: () => (this.converting ? 0 : 1) };
        break;
      case 0xbe: // READ SCRATCHPAD (the master may stop early with a reset)
        this.send({ bytes: this.scratchpad() }, () => (this.phase = { kind: 'status', bit: () => 1 }));
        break;
      case 0x4e: // WRITE SCRATCHPAD: TH, TL, config
        this.receive(8, (th) => {
          this.th = th;
          this.receive(8, (tl) => {
            this.tl = tl;
            this.receive(8, (cfg) => {
              this.config = (cfg & 0x60) | 0x1f;
              this.idle();
            });
          });
        });
        break;
      case 0x48: // COPY SCRATCHPAD to EEPROM
        this.eeprom = { th: this.th, tl: this.tl, config: this.config };
        this.copyDoneNs = this.clock.nanos + COPY_TIME_NS;
        this.phase = { kind: 'status', bit: () => (this.clock.nanos >= this.copyDoneNs ? 1 : 0) };
        break;
      case 0xb8: // RECALL E2
        this.th = this.eeprom.th;
        this.tl = this.eeprom.tl;
        this.config = this.eeprom.config;
        this.phase = { kind: 'status', bit: () => 1 };
        break;
      case 0xb4: // READ POWER SUPPLY: externally powered
        this.phase = { kind: 'status', bit: () => 1 };
        break;
      default:
        this.idle();
    }
  }

  private get resolutionCode() {
    return (this.config >> 5) & 3;
  }

  private startConversion() {
    this.converting = true;
    this.convAlarm.schedule(CONVERSION_NS[this.resolutionCode]);
  }

  private finishConversion() {
    this.converting = false;
    // Quantise to the configured resolution (12 bit = 1/16 C, 9 bit = 1/2 C);
    // undefined low bits at lower resolutions read as 0.
    const step = 1 << (3 - this.resolutionCode);
    const sixteenths = Math.round((this.temp * 16) / step) * step;
    this.tempRaw = sixteenths & 0xffff;
    const whole = sixteenths >> 4; // bits 11..4, floor for negatives like the chip
    this.alarmFlag = whole >= toInt8(this.th) || whole <= toInt8(this.tl);
  }

  private scratchpad() {
    const s = new Uint8Array(9);
    s[0] = this.tempRaw & 0xff;
    s[1] = (this.tempRaw >> 8) & 0xff;
    s[2] = this.th;
    s[3] = this.tl;
    s[4] = this.config;
    s[5] = 0xff;
    s[6] = 0x0c;
    s[7] = 0x10;
    s[8] = crc8(s, 8);
    return s;
  }
}

function clampTemp(t: number) {
  if (!Number.isFinite(t)) throw new Error(`Invalid DS18B20 temperature: ${t}`);
  return Math.min(125, Math.max(-55, t));
}

function toInt8(v: number) {
  return v & 0x80 ? v - 0x100 : v;
}

function defaultSerial() {
  const n = nextSerial++;
  return [n & 0xff, (n >> 8) & 0xff, 0x5e, 0x1d, 0x00, 0x00];
}
