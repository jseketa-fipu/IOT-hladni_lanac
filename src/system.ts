// The electrical side of project/diagram.json, without any drawing: which pins are
// connected, what drives each net, which LEDs are lit, what a GPIO input reads, and
// which part models (DS18B20, microSD, DS1307) are attached to which Pico pins.
// No DOM: runs in Node (tests) and in the browser (src/circuit.ts draws on top of it).
//
// Nets
//   Strong connections (wires, the two legs of each button side, a pressed button, all
//   Pico GND pins) are merged with union-find into nets. Resistors are NOT merged: they
//   are "weak" edges between nets. A resistor conducts for an LED's current path and acts
//   as a pull-up/pull-down for a GPIO input, but a net that reaches 3V3 only through a
//   resistor is not "3V3" (so a pull-up never powers a part or overrides a driven pin).
//   Drivers: Pico GND = low; 3V3, VSYS, VBUS = high (only while a board is attached,
//   i.e. powered); a GPIO in output mode = its level.
//   LED: lit when its anode reaches a high driver and its cathode a low driver
//   (directly or through resistors). No current limits or forward voltages are modelled.
//   GPIO input: a strong driver on its net wins (e.g. a pressed button to GND), else a
//   driver reached through resistors (pull-up/down), else the pin's own pull (high
//   when floating, like before). Buttons change the topology; nets are recomputed only
//   on press/release, not on every pin edge.
//
// Part models, attached in attach(board) when their wiring is valid:
//   wokwi-ds18b20      pins GND, DQ, VCC; attrs.temperature (deg C)
//                      DQ: any GPIO, with a pull-up resistor to 3V3/VSYS/VBUS
//   wokwi-microsd-card pins CD, DO, GND, SCK, VCC, DI, CS
//                      DO/SCK/DI on one SPI controller with the RP2040 pin muxing:
//                      GPn -> SPI (n>>3)&1, role n%4: 0 RX (DO), 2 SCK, 3 TX (DI); CS any GPIO
//   wokwi-ds1307       pins GND, 5V, SDA, SCL, SQW
//                      5V on VBUS/VSYS (a DS1307 on 3.3 V stays in battery backup mode
//                      and does not answer); GPn -> I2C (n>>1)&1, even = SDA, odd = SCL
//   Power pins must be wired (strongly) to a supply and GND. A miswired or unpowered part
//   is not attached; `warnings` says why, e.g.
//   "sd1: DO must connect to an SPI RX pin (GP0/4/16/20 for SPI0)".
//   GPIOs wired to an attached part (DQ, SDA, SCL, SPI pins, CS) belong to its model: the
//   generic input logic never writes them (the DS18B20 and I2C models drive those inputs).
//   One SD card per SPI controller and one DS1307 per I2C controller (the models own the
//   peripheral's callbacks); a second one gets a warning.
//
// Public API
//   new CircuitSystem(diagram, board | null, options?)  board: attach right away
//   attach(board) / detach()      create / remove the part models (attach before board.start())
//   board                         the attached board or null
//   leds: Map<id, boolean>        LED part id -> lit
//   press(id) / release(id) / isPressed(id)   pushbuttons
//   sensors: Map<id, DS18B20>     live models while attached (empty before attach)
//   sdCards: Map<id, SDCard>      "
//   rtcs: Map<id, DS1307>         "
//   sensorIds / cardIds / rtcIds  every part of that type in the diagram, attached or not
//   warnings: string[]            wiring problems found in the diagram (computed once)
//   pinsOf(id)                    resolved GPIOs of a part, e.g. { DQ: 15 } (valid parts only)
//   onChange(listener) -> unsubscribe   listener(change) on 'leds' | 'buttons' | 'devices' |
//                                 'settings' | 'card' (with the card's id) events
//   Settings that work before attach (initial conditions) and while running:
//     temperature(id) / setTemperature(id, c)       DS18B20, clamped to -55..125
//     sensorConnected(id) / setSensorConnected(id, on)
//     cardInserted(id) / setCardInserted(id, on)
//     cardFiles(id)        files on the card (live, or as left by the last run)
//     eraseCard(id)        format the card again
//     rtcTime(id) / setRtcTime(id, date)   DS1307 clock (UTC fields = clock fields)
//   Card contents and RTC time persist across detach/attach (a new Run): the card keeps
//   its files like a real card, and the battery-backed RTC keeps counting in real time
//   while the board is off. Options give fixed starting values for tests.

import { GPIOPinState } from 'rp2040js';
import type { Board } from './board.js';
import { DS1307 } from './devices/ds1307.js';
import { DS18B20 } from './devices/ds18b20.js';
import { type BlockStore, type FatFile, SECTOR, listFiles } from './devices/fat.js';
import { SDCard } from './devices/sdcard.js';
import { PICO_PINS } from './pico-svg.js';

export interface DiagramPart {
  type: string;
  id: string;
  top: number;
  left: number;
  /** Wokwi: rotation in degrees (0, 90, 180, 270). Only the drawing uses it. */
  rotate?: number;
  attrs?: Record<string, string>;
}
/** [from "part:pin", to "part:pin", color, waypoints like "h-19.2" / "v48"] */
export type DiagramConnection = [string, string, string, string[]?];
export interface Diagram {
  parts: DiagramPart[];
  connections: DiagramConnection[];
}

export interface SystemOptions {
  /** Initial temperature per DS18B20 part id, deg C (default: attrs.temperature, else 20). */
  temperatures?: Record<string, number>;
  /**
   * Initial DS1307 time (UTC fields = clock fields) for every RTC, or per part id.
   * It is fixed: the clock starts there at attach. Default: the host's local time.
   */
  rtcTime?: Date | Record<string, Date>;
  /** SD card size in MB (default 64). */
  sdSizeMB?: number;
}

export type SystemChange =
  | { kind: 'leds' | 'buttons' | 'devices' | 'settings' }
  | { kind: 'card'; id: string };

export const BOARD_TYPES = new Set(['board-pi-pico', 'board-pi-pico-w']);
const SUPPLY_PINS = new Set(['3V3', 'VSYS', 'VBUS']);
/** GPIOs that are on the Pico's header (23-25 and 29 are internal). */
const HEADER_GPIOS = PICO_PINS.map((p) => gpioIndex(p.name)).filter((n): n is number => n !== null).sort((a, b) => a - b);

type Level = 'high' | 'low';

interface NetInfo {
  gnd: boolean;
  /** Supply pins on this net (3V3, VSYS, VBUS). */
  supply: string[];
  gpios: number[];
}

interface SensorSettings {
  temperature: number;
  connected: boolean;
  serial: number[];
}
/** RTC time `ms` (UTC fields = clock fields) at host time `hostAt` (Date.now()); null hostAt = fixed. */
interface RtcSettings {
  ms: number;
  hostAt: number | null;
}

/** A card's blocks while no board is attached (same layout as SDCard.store.blocks). */
class SavedStore implements BlockStore {
  constructor(readonly blocks: Map<number, Uint8Array>) {}
  read(lba: number) {
    return this.blocks.get(lba)?.slice() ?? new Uint8Array(SECTOR);
  }
  write() {
    throw new Error('read only');
  }
}

export class CircuitSystem {
  readonly leds = new Map<string, boolean>();
  readonly sensors = new Map<string, DS18B20>();
  readonly sdCards = new Map<string, SDCard>();
  readonly rtcs = new Map<string, DS1307>();
  readonly sensorIds: string[] = [];
  readonly cardIds: string[] = [];
  readonly rtcIds: string[] = [];
  readonly warnings: string[] = [];

  private boardRef: Board | null = null;
  private boardId = '';
  private readonly partTypes = new Map<string, string>();
  private readonly pressed = new Set<string>();
  private readonly listeners = new Set<(change: SystemChange) => void>();
  private unlisten: (() => void)[] = [];

  // Topology (recomputed on press/release)
  private find: (ref: string) => string = (r) => r;
  private netInfo = new Map<string, NetInfo>();
  /** Resistor edges between strong nets: net -> neighbour nets. */
  private weak = new Map<string, string[]>();

  // Devices: resolved pins of every valid part, and the GPIOs they own.
  private readonly pins = new Map<string, Record<string, number>>();
  private readonly owned = new Set<number>();
  /** GPIOs the generic logic watches and drives (wired to something, not owned). */
  private generic: number[] = [];

  // Settings that outlive a run.
  private readonly sensorSettings = new Map<string, SensorSettings>();
  private readonly inserted = new Map<string, boolean>();
  private readonly savedCards = new Map<string, Map<number, Uint8Array>>();
  private readonly rtcSettings = new Map<string, RtcSettings | null>();

  constructor(
    private readonly diagram: Diagram,
    board: Board | null = null,
    private readonly options: SystemOptions = {},
  ) {
    for (const part of diagram.parts) {
      this.partTypes.set(part.id, part.type);
      if (BOARD_TYPES.has(part.type)) this.boardId = part.id;
      if (part.type === 'wokwi-led') this.leds.set(part.id, false);
    }
    if (!this.boardId) this.warnings.push('diagram.json has no Pico (board-pi-pico-w or board-pi-pico)');
    this.rebuildNets();
    this.resolveDevices();
    const used = new Set<number>();
    for (const [, info] of this.netInfo) for (const gp of info.gpios) used.add(gp);
    this.generic = [...used].filter((gp) => !this.owned.has(gp)).sort((a, b) => a - b);
    if (board) this.attach(board);
  }

  get board() {
    return this.boardRef;
  }

  onChange(listener: (change: SystemChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: SystemChange) {
    for (const l of this.listeners) l(change);
  }

  /** Resolved GPIOs of a validly wired part, e.g. { DQ: 15 } or { SCK: 2, DI: 3, DO: 4, CS: 5, spi: 0 }. */
  pinsOf(id: string): Readonly<Record<string, number>> | undefined {
    return this.pins.get(id);
  }

  // ---------------------------------------------------------------- board

  attach(board: Board) {
    this.detach();
    this.boardRef = board;
    for (const gp of this.generic) this.unlisten.push(board.pin(gp).addListener(() => this.update()));

    for (const id of this.sensorIds) {
      const pins = this.pins.get(id);
      if (!pins) continue;
      const s = this.sensorSettings.get(id)!;
      const sensor = new DS18B20(board, pins.DQ, { temperature: s.temperature, serial: s.serial });
      sensor.connected = s.connected;
      this.sensors.set(id, sensor);
    }
    for (const id of this.cardIds) {
      const pins = this.pins.get(id);
      if (!pins) continue;
      const card = new SDCard(board, { spi: pins.spi as 0 | 1, csGpio: pins.CS, sizeMB: this.options.sdSizeMB });
      const saved = this.savedCards.get(id);
      if (saved) {
        card.store.blocks.clear();
        for (const [lba, data] of saved) card.store.blocks.set(lba, data);
      }
      card.inserted = this.inserted.get(id) ?? true;
      card.onWrite = () => this.emit({ kind: 'card', id });
      this.sdCards.set(id, card);
    }
    for (const id of this.rtcIds) {
      const pins = this.pins.get(id);
      if (!pins) continue;
      const rtc = new DS1307(board, { i2c: pins.i2c as 0 | 1, pins: { sda: pins.SDA, scl: pins.SCL } });
      const start = this.storedRtcTime(id);
      if (start) rtc.setTime(start);
      this.rtcs.set(id, rtc);
    }
    this.update();
    this.emit({ kind: 'devices' });
  }

  detach() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    for (const [id, sensor] of this.sensors) {
      sensor.detach();
      this.sensorSettings.get(id)!.temperature = sensor.temperature;
    }
    for (const [id, card] of this.sdCards) {
      card.detach();
      this.savedCards.set(id, new Map(card.store.blocks));
    }
    for (const [id, rtc] of this.rtcs) {
      // Battery backed: keeps counting in real time while the board is off.
      this.rtcSettings.set(id, { ms: rtc.now().getTime(), hostAt: Date.now() });
      rtc.detach();
    }
    const had = this.boardRef !== null;
    this.sensors.clear();
    this.sdCards.clear();
    this.rtcs.clear();
    this.boardRef = null;
    this.update();
    if (had) this.emit({ kind: 'devices' });
  }

  // ---------------------------------------------------------------- buttons

  press(id: string) {
    this.setPressed(id, true);
  }

  release(id: string) {
    this.setPressed(id, false);
  }

  isPressed(id: string) {
    return this.pressed.has(id);
  }

  private setPressed(id: string, down: boolean) {
    if (this.partTypes.get(id) !== 'wokwi-pushbutton') throw new Error(`${id} is not a pushbutton in diagram.json`);
    if (down === this.pressed.has(id)) return;
    if (down) this.pressed.add(id);
    else this.pressed.delete(id);
    this.rebuildNets();
    this.update();
    this.emit({ kind: 'buttons' });
  }

  // ---------------------------------------------------------------- settings

  temperature(id: string): number {
    return this.sensors.get(id)?.temperature ?? this.sensorSetting(id).temperature;
  }

  setTemperature(id: string, celsius: number) {
    const s = this.sensorSetting(id);
    s.temperature = Math.min(125, Math.max(-55, celsius));
    const sensor = this.sensors.get(id);
    if (sensor) sensor.temperature = s.temperature;
    this.emit({ kind: 'settings' });
  }

  sensorConnected(id: string): boolean {
    return this.sensorSetting(id).connected;
  }

  setSensorConnected(id: string, on: boolean) {
    this.sensorSetting(id).connected = on;
    const sensor = this.sensors.get(id);
    if (sensor) sensor.connected = on;
    this.emit({ kind: 'settings' });
  }

  cardInserted(id: string): boolean {
    this.checkType(id, 'wokwi-microsd-card');
    return this.inserted.get(id) ?? true;
  }

  setCardInserted(id: string, on: boolean) {
    this.checkType(id, 'wokwi-microsd-card');
    this.inserted.set(id, on);
    const card = this.sdCards.get(id);
    if (card) card.inserted = on;
    this.emit({ kind: 'settings' });
  }

  /** The card's files: live while attached, else as the last run left them (empty if never used). */
  cardFiles(id: string): FatFile[] {
    this.checkType(id, 'wokwi-microsd-card');
    const card = this.sdCards.get(id);
    if (card) return card.files();
    const saved = this.savedCards.get(id);
    return saved ? listFiles(new SavedStore(saved)) : [];
  }

  /** Format the card again (all files gone). */
  eraseCard(id: string) {
    this.checkType(id, 'wokwi-microsd-card');
    this.savedCards.delete(id);
    this.sdCards.get(id)?.reset();
    this.emit({ kind: 'card', id });
  }

  /** Current RTC time (UTC fields = clock fields). Before attach: what it will start at. */
  rtcTime(id: string): Date {
    const live = this.rtcs.get(id);
    if (live) return live.now();
    return this.storedRtcTime(id) ?? hostLocalAsUtc();
  }

  setRtcTime(id: string, date: Date) {
    this.checkType(id, 'wokwi-ds1307');
    const rtc = this.rtcs.get(id);
    if (rtc) rtc.setTime(date); // throws RangeError outside 2000-2099
    else if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2099) {
      throw new RangeError(`DS1307 holds years 2000-2099, got ${date.getUTCFullYear()}`);
    }
    this.rtcSettings.set(id, { ms: date.getTime(), hostAt: Date.now() });
    this.emit({ kind: 'settings' });
  }

  private storedRtcTime(id: string): Date | null {
    const s = this.rtcSettings.get(id);
    if (!s) return null;
    return new Date(s.hostAt === null ? s.ms : s.ms + (Date.now() - s.hostAt));
  }

  private sensorSetting(id: string): SensorSettings {
    this.checkType(id, 'wokwi-ds18b20');
    return this.sensorSettings.get(id)!;
  }

  private checkType(id: string, type: string) {
    if (this.partTypes.get(id) !== type) throw new Error(`${id} is not a ${type} in diagram.json`);
  }

  // ---------------------------------------------------------------- nets

  private rebuildNets() {
    const parent = new Map<string, string>();
    const nodes = new Set<string>(); // every pin something is wired to
    const find = (x: string): string => {
      let root = x;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      // path compression
      while (x !== root) {
        const next = parent.get(x) ?? root;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const join = (a: string, b: string) => {
      nodes.add(a);
      nodes.add(b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const [a, b] of this.diagram.connections) join(a, b);
    const resistors: [string, string][] = [];
    for (const part of this.diagram.parts) {
      const id = part.id;
      if (part.type === 'wokwi-resistor') resistors.push([`${id}:1`, `${id}:2`]);
      if (part.type === 'wokwi-pushbutton') {
        join(`${id}:1.l`, `${id}:1.r`);
        join(`${id}:2.l`, `${id}:2.r`);
        if (this.pressed.has(id)) join(`${id}:1.l`, `${id}:2.l`);
      }
    }
    const b = this.boardId;
    for (const p of PICO_PINS) if (p.name.startsWith('GND')) join(`${b}:${p.name}`, `${b}:GND`);
    this.find = find;

    this.netInfo = new Map();
    const info = (net: string) => {
      let i = this.netInfo.get(net);
      if (!i) this.netInfo.set(net, (i = { gnd: false, supply: [], gpios: [] }));
      return i;
    };
    if (b) {
      for (const p of PICO_PINS) {
        const ref = `${b}:${p.name}`;
        // Only pins that something is wired to (or GND, which is always one net).
        if (!nodes.has(ref)) continue;
        const i = info(find(ref));
        const gp = gpioIndex(p.name);
        if (p.name.startsWith('GND')) i.gnd = true;
        else if (SUPPLY_PINS.has(p.name)) i.supply.push(p.name);
        else if (gp !== null) i.gpios.push(gp);
      }
    }

    this.weak = new Map();
    for (const [x, y] of resistors) {
      const nx = find(x);
      const ny = find(y);
      if (nx === ny) continue;
      this.weak.set(nx, [...(this.weak.get(nx) ?? []), ny]);
      this.weak.set(ny, [...(this.weak.get(ny) ?? []), nx]);
    }
  }

  /** What drives a net directly (no resistors): a level, 'short' for high + low, or null. */
  private strongLevel(net: string, exceptGpio = -1): Level | 'short' | null {
    const board = this.boardRef;
    const i = this.netInfo.get(net);
    if (!i || !board) return null;
    let high = i.supply.length > 0;
    let low = i.gnd;
    for (const gp of i.gpios) {
      if (gp === exceptGpio) continue;
      const v = board.pin(gp).value;
      if (v === GPIOPinState.High) high = true;
      else if (v === GPIOPinState.Low) low = true;
    }
    if (high && low) return 'short';
    return high ? 'high' : low ? 'low' : null;
  }

  /** The level a net is pulled to through resistors (chains allowed), or null if none / conflicting. */
  private weakLevel(net: string): Level | null {
    const seen = new Set([net]);
    let frontier = [net];
    const found = new Set<Level>();
    while (frontier.length) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const nb of this.weak.get(n) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const level = this.strongLevel(nb);
          if (level === 'short') return null;
          if (level) found.add(level);
          else next.push(nb); // undriven: keep following the resistor chain
        }
      }
      frontier = next;
    }
    return found.size === 1 ? [...found][0] : null;
  }

  private level(ref: string): Level | null {
    const net = this.find(ref);
    const strong = this.strongLevel(net);
    if (strong === 'short') return null;
    return strong ?? this.weakLevel(net);
  }

  /** Recompute LEDs and generic GPIO inputs from the current pin states. */
  private update() {
    const board = this.boardRef;
    let ledsChanged = false;
    for (const [id, was] of this.leds) {
      const lit = !!board && this.level(`${id}:A`) === 'high' && this.level(`${id}:C`) === 'low';
      if (lit !== was) {
        this.leds.set(id, lit);
        ledsChanged = true;
      }
    }

    if (board) {
      for (const gp of this.generic) {
        const pin = board.pin(gp);
        const state = pin.value;
        if (state === GPIOPinState.High || state === GPIOPinState.Low) continue; // an output
        const net = this.find(`${this.boardId}:GP${gp}`);
        const strong = this.strongLevel(net, gp);
        const level = strong === 'short' ? 'low' : (strong ?? this.weakLevel(net));
        const value = level ? level === 'high' : state !== GPIOPinState.InputPullDown;
        if (pin.inputValue !== value) pin.setInputValue(value);
      }
    }
    if (ledsChanged) this.emit({ kind: 'leds' });
  }

  // ---------------------------------------------------------------- devices

  /** Validate the wiring of every part model and record its GPIOs (no board needed). */
  private resolveDevices() {
    const spiTaken = new Map<number, string>();
    const i2cTaken = new Map<number, string>();
    let sensorIndex = 0;
    for (const part of this.diagram.parts) {
      const { id, type } = part;
      if (type === 'wokwi-ds18b20') {
        this.sensorIds.push(id);
        const attr = Number(part.attrs?.temperature);
        const initial = this.options.temperatures?.[id] ?? (Number.isFinite(attr) && part.attrs?.temperature ? attr : 20);
        sensorIndex++;
        this.sensorSettings.set(id, {
          temperature: Math.min(125, Math.max(-55, initial)),
          connected: true,
          // Fixed per part, so the ROM code is the same on every Run.
          serial: [sensorIndex & 0xff, 0x00, 0x5e, 0x1d, 0x00, 0x00],
        });
        this.resolve(id, () => {
          this.needGnd(id);
          this.needSupply(id, 'VCC', ['3V3', 'VSYS', 'VBUS'], 'parasite power (VCC on GND) is not supported');
          const dq = this.oneGpio(id, 'DQ');
          const net = this.find(`${id}:DQ`);
          const pulledUp = (this.weak.get(net) ?? []).some((nb) => (this.netInfo.get(nb)?.supply.length ?? 0) > 0);
          if (!pulledUp) throw new WiringError(`${id}: DQ needs a pull-up resistor (4.7 kΩ) to 3V3`);
          return { DQ: dq };
        });
      } else if (type === 'wokwi-microsd-card') {
        this.cardIds.push(id);
        this.resolve(id, () => {
          this.needGnd(id);
          this.needSupply(id, 'VCC', ['3V3', 'VSYS', 'VBUS']);
          const sck = this.oneGpio(id, 'SCK');
          const di = this.oneGpio(id, 'DI');
          const dout = this.oneGpio(id, 'DO');
          const cs = this.oneGpio(id, 'CS');
          // The controller is the one SCK is on, if SCK is an SCK pin at all.
          const spi = sck % 4 === 2 ? spiOf(sck) : spiOf(dout);
          const role = (name: string, gp: number, want: number, what: string) => {
            if (gp % 4 !== want || spiOf(gp) !== spi) {
              const list = HEADER_GPIOS.filter((n) => n % 4 === want && spiOf(n) === spi).join('/');
              throw new WiringError(`${id}: ${name} must connect to an SPI ${what} pin (GP${list} for SPI${spi})`);
            }
          };
          role('SCK', sck, 2, 'SCK');
          role('DI', di, 3, 'TX');
          role('DO', dout, 0, 'RX');
          if (spiTaken.has(spi)) throw new WiringError(`${id}: SPI${spi} already has an SD card (${spiTaken.get(spi)})`);
          spiTaken.set(spi, id);
          return { SCK: sck, DI: di, DO: dout, CS: cs, spi };
        });
      } else if (type === 'wokwi-ds1307') {
        this.rtcIds.push(id);
        const opt = this.options.rtcTime;
        const start = opt instanceof Date ? opt : opt?.[id];
        this.rtcSettings.set(id, start ? { ms: start.getTime(), hostAt: null } : null);
        this.resolve(id, () => {
          this.needGnd(id);
          this.needSupply(
            id,
            '5V',
            ['VBUS', 'VSYS'],
            undefined,
            'the DS1307 needs 5 V; on 3V3 it stays in battery backup mode and does not answer',
          );
          const sda = this.oneGpio(id, 'SDA');
          const scl = this.oneGpio(id, 'SCL');
          const i2c = i2cOf(sda);
          const pinsFor = (odd: number, bus: number) =>
            HEADER_GPIOS.filter((n) => n % 2 === odd && i2cOf(n) === bus).join('/');
          if (sda % 2 !== 0) {
            throw new WiringError(`${id}: SDA must connect to an I2C SDA pin (GP${pinsFor(0, 0)} for I2C0, GP${pinsFor(0, 1)} for I2C1)`);
          }
          if (scl % 2 !== 1 || i2cOf(scl) !== i2c) {
            throw new WiringError(`${id}: SCL must connect to an I2C SCL pin (GP${pinsFor(1, i2c)} for I2C${i2c}, like SDA)`);
          }
          if (i2cTaken.has(i2c)) throw new WiringError(`${id}: I2C${i2c} already has a DS1307 (${i2cTaken.get(i2c)})`);
          i2cTaken.set(i2c, id);
          return { SDA: sda, SCL: scl, i2c };
        });
      }
    }
  }

  private resolve(id: string, check: () => Record<string, number>) {
    if (!this.boardId) return;
    try {
      const pins = check();
      this.pins.set(id, pins);
      for (const [name, gp] of Object.entries(pins)) if (name !== 'spi' && name !== 'i2c') this.owned.add(gp);
    } catch (e) {
      if (!(e instanceof WiringError)) throw e;
      this.warnings.push(e.message);
    }
  }

  private needGnd(id: string) {
    if (!this.netInfo.get(this.find(`${id}:GND`))?.gnd) throw new WiringError(`${id}: GND must connect to a GND pin of the Pico`);
  }

  private needSupply(id: string, pin: string, allowed: string[], onGnd?: string, otherwise?: string) {
    const i = this.netInfo.get(this.find(`${id}:${pin}`));
    if (i?.gnd) throw new WiringError(`${id}: ${onGnd ?? `${pin} is wired to GND`}`);
    if (i?.supply.some((s) => allowed.includes(s))) return;
    const why = i?.supply.length && otherwise ? ` (${otherwise})` : '';
    throw new WiringError(`${id}: ${pin} must connect to ${allowed.join(' or ')}${why}`);
  }

  /** The single Pico GPIO a part pin is wired to (no resistors in between). */
  private oneGpio(id: string, pin: string): number {
    const i = this.netInfo.get(this.find(`${id}:${pin}`));
    if (i?.gnd || i?.supply.length) throw new WiringError(`${id}: ${pin} is wired to ${i.gnd ? 'GND' : i.supply[0]}, not to a GPIO`);
    const gpios = i?.gpios ?? [];
    if (gpios.length === 0) throw new WiringError(`${id}: ${pin} is not connected to a GPIO`);
    if (gpios.length > 1) throw new WiringError(`${id}: ${pin} is connected to several GPIOs (${gpios.map((g) => `GP${g}`).join(', ')})`);
    return gpios[0];
  }
}

class WiringError extends Error {}

export function gpioIndex(name: string): number | null {
  const m = /^GP(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** RP2040 pin muxing: the SPI controller a GPIO belongs to. */
const spiOf = (gp: number) => (gp >> 3) & 1;
/** RP2040 pin muxing: the I2C controller a GPIO belongs to. */
const i2cOf = (gp: number) => (gp >> 1) & 1;

/** The host's local time with its local fields copied into UTC fields (the DS1307's default). */
function hostLocalAsUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}
