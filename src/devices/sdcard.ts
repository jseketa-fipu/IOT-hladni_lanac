// A microSD card in SPI mode (SDHC, CSD v2, block addressing) wired to one of the
// RP2040's SPI controllers, with CS on a plain GPIO. Written against micropython-lib's
// sdcard.py (project/sdcard.py), so MicroPython can os.mount() it as a FAT volume.
// The card comes formatted as FAT16; the host reads files back with files()/readText().
//
// SPI is full duplex: the byte the card returns while the Pico clocks out byte N was
// decided before byte N arrived. The model keeps an output queue: each transmitted byte
// first takes the next queued MISO byte (0xFF when empty), then is processed, which may
// queue the response (so every response starts on the byte after the command).
// Each byte takes 8 SPI clock periods of simulated time, like the real bus, so DMA
// transfers keep TX and RX in step.

import { GPIOPinState } from 'rp2040js';
import type { Board } from '../board.js';
import { type BlockStore, type FatFile, SECTOR, formatFat16, listFiles } from './fat.js';

export interface SDCardOptions {
  /** SPI controller: 0 (SCK GP2, MOSI GP3, MISO GP4 in the group's wiring) or 1. */
  spi: 0 | 1;
  /** GPIO used as chip select (driven by sdcard.py; card is selected while it is low). */
  csGpio: number;
  /** Card size in MB, 3 to 4000 (FAT16 range). Default 64. */
  sizeMB?: number;
}

const TOKEN_DATA = 0xfe;
const TOKEN_MULTI_WRITE = 0xfc;
const TOKEN_STOP_TRAN = 0xfd;
const DATA_ACCEPTED = 0xe5;

const R1_IDLE = 0x01;
const R1_ILLEGAL = 0x04;
const R1_ADDRESS_ERROR = 0x20;
const R1_PARAMETER_ERROR = 0x40;

type Mode =
  | { kind: 'command' } // listening for commands
  | { kind: 'readMulti'; lba: number } // CMD18: streaming blocks until CMD12
  | { kind: 'writeWait'; lba: number; multi: boolean } // CMD24/25: waiting for a data token
  | { kind: 'writeData'; lba: number; multi: boolean; buf: Uint8Array; pos: number }; // receiving data + 2 CRC bytes

function crc7(bytes: ArrayLike<number>, n: number): number {
  let crc = 0;
  for (let i = 0; i < n; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = ((crc << 1) ^ (0x12 * (crc >> 7))) & 0xff;
  }
  return crc;
}

/** Sparse 512-byte block storage: only blocks that hold non-zero data cost memory. */
class SparseStore implements BlockStore {
  readonly blocks = new Map<number, Uint8Array>();
  read(lba: number): Uint8Array {
    const b = this.blocks.get(lba);
    return b ? b.slice() : new Uint8Array(SECTOR);
  }
  write(lba: number, data: Uint8Array) {
    if (data.every((x) => x === 0)) this.blocks.delete(lba);
    else this.blocks.set(lba, data.slice(0, SECTOR));
  }
}

export class SDCard {
  /** Number of 512-byte sectors. */
  readonly sectors: number;
  /** The card's contents, block by block (unwritten blocks read as zeros). */
  readonly store = new SparseStore();
  /** Count of data commands served, to see which paths the driver used. */
  readonly stats = { cmd17: 0, cmd18: 0, cmd24: 0, cmd25: 0, blocksRead: 0, blocksWritten: 0 };
  /** Called after every block written by the Pico (e.g. to refresh a file view). */
  onWrite: (lba: number) => void = () => {};

  private readonly spi;
  private readonly unlisten: () => void;
  private readonly alarm;
  private pendingRx = 0xff;
  private inFlight = false;
  private present = true;
  private selected: boolean;
  private out: number[] = [];
  private outPos = 0;
  private cmd: number[] = [];
  private mode: Mode = { kind: 'command' };
  private idle = true; // SPI idle state until ACMD41 completes initialisation
  private appCmd = false;

  constructor(
    private readonly board: Board,
    options: SDCardOptions,
  ) {
    const sizeMB = options.sizeMB ?? 64;
    if (!Number.isInteger(sizeMB) || sizeMB < 3 || sizeMB > 4000) {
      throw new Error(`SD card size must be a whole number of MB from 3 to 4000, not ${sizeMB}`);
    }
    this.sectors = sizeMB * 2048; // a multiple of 1024 sectors, as CSD v2's C_SIZE needs
    formatFat16(this.store, this.sectors);

    const cs = board.pin(options.csGpio);
    this.selected = cs.value === GPIOPinState.Low;
    this.unlisten = cs.addListener((state) => {
      const selected = state === GPIOPinState.Low;
      if (selected === this.selected) return;
      this.selected = selected;
      if (!selected) this.deselect();
    });

    this.spi = board.mcu.spi[options.spi];
    this.alarm = board.sim.clock.createAlarm(() => {
      this.inFlight = false;
      this.spi.completeTransmit(this.pendingRx);
    });
    this.spi.onTransmit = (value) => {
      this.pendingRx = this.transfer(value & 0xff);
      this.inFlight = true;
      const hz = this.spi.clockFrequency;
      this.alarm.schedule(hz > 0 ? (8 * 1e9) / hz : 1000);
    };
  }

  /** false = slot empty: the card never answers (MISO stays high) and sdcard.SDCard() raises OSError. */
  get inserted() {
    return this.present;
  }
  set inserted(value: boolean) {
    if (value === this.present) return;
    this.present = value;
    this.powerOn(); // pulled out or pushed in: either way the card starts from power-up
  }

  /** Every file on the card, with contents ("dir/name" for files in subdirectories). */
  files(): FatFile[] {
    return listFiles(this.store);
  }

  /** A file's contents as UTF-8 text, or null if there is no such file. Name match ignores case as a fallback. */
  readText(name: string): string | null {
    const files = this.files();
    const file =
      files.find((f) => f.name === name) ?? files.find((f) => f.name.toLowerCase() === name.toLowerCase());
    return file ? new TextDecoder().decode(file.data) : null;
  }

  /** Erase the card and format it again (empty FAT16 volume), back to power-up state. */
  reset() {
    this.store.blocks.clear();
    formatFat16(this.store, this.sectors);
    this.powerOn();
  }

  /** Disconnect from the board: stop listening to CS and answering on SPI. */
  detach() {
    this.unlisten();
    this.alarm.cancel();
    const spi = this.spi;
    spi.onTransmit = () => spi.completeTransmit(0);
    if (this.inFlight) {
      // finish the byte on the wire, or the SPI controller would stay busy forever
      this.inFlight = false;
      spi.completeTransmit(0xff);
    }
  }

  // ---------- SPI protocol ----------

  private powerOn() {
    this.idle = true;
    this.appCmd = false;
    this.mode = { kind: 'command' };
    this.cmd = [];
    this.clearOut();
  }

  private deselect() {
    // A half-sent command is lost; a pending write (CMD24 -> data) survives CS toggles.
    this.cmd = [];
    this.clearOut();
    if (this.mode.kind === 'readMulti') this.mode = { kind: 'command' };
  }

  private clearOut() {
    this.out = [];
    this.outPos = 0;
  }

  private queue(...bytes: number[]) {
    for (const b of bytes) this.out.push(b);
  }

  private queueBlock(lba: number) {
    this.queue(TOKEN_DATA, ...this.store.read(lba), 0xff, 0xff); // CRC16 is not checked by the driver
    this.stats.blocksRead++;
  }

  private nextOut(): number {
    if (this.outPos >= this.out.length) {
      this.clearOut();
      const m = this.mode;
      if (m.kind === 'readMulti' && m.lba < this.sectors) {
        this.queueBlock(m.lba++);
      } else {
        return 0xff;
      }
    }
    return this.out[this.outPos++];
  }

  /** One full-duplex byte: returns MISO for this MOSI byte. */
  private transfer(mosi: number): number {
    if (!this.present || !this.selected) return 0xff;
    const miso = this.nextOut();
    this.receive(mosi);
    return miso;
  }

  private receive(b: number) {
    const m = this.mode;
    if (m.kind === 'writeData') {
      if (m.pos < SECTOR) m.buf[m.pos] = b;
      m.pos++;
      if (m.pos === SECTOR + 2) {
        // data and both CRC bytes in: store, answer "data accepted" on the very next byte
        this.store.write(m.lba, m.buf);
        this.stats.blocksWritten++;
        this.onWrite(m.lba);
        this.queue(DATA_ACCEPTED);
        this.mode = m.multi ? { kind: 'writeWait', lba: m.lba + 1, multi: true } : { kind: 'command' };
      }
      return;
    }
    if (m.kind === 'writeWait' && this.cmd.length === 0) {
      if (b === (m.multi ? TOKEN_MULTI_WRITE : TOKEN_DATA)) {
        if (m.lba >= this.sectors) {
          this.queue(0x0d); // write error data response; stay waiting
          return;
        }
        this.mode = { kind: 'writeData', lba: m.lba, multi: m.multi, buf: new Uint8Array(SECTOR), pos: 0 };
        return;
      }
      if (m.multi && b === TOKEN_STOP_TRAN) {
        this.queue(0xff, 0x00); // one byte, then busy for a byte while "programming"
        this.mode = { kind: 'command' };
        return;
      }
      if ((b & 0xc0) !== 0x40) return; // 0xFF filler while waiting for the token
      // a command instead of data: abandon the write and handle it
      this.mode = { kind: 'command' };
    }

    if (this.cmd.length === 0 && (b & 0xc0) !== 0x40) return; // not a command start bit pattern
    this.cmd.push(b);
    if (this.cmd.length < 6) return;
    const [c0, a3, a2, a1, a0] = this.cmd;
    this.cmd = [];
    this.command(c0 & 0x3f, ((a3 << 24) | (a2 << 16) | (a1 << 8) | a0) >>> 0);
  }

  private command(index: number, arg: number) {
    // Every command ends what the card was sending (CMD12 stops a CMD18 stream).
    this.clearOut();
    this.mode = { kind: 'command' };
    const r1 = this.idle ? R1_IDLE : 0;
    const respond = (...bytes: number[]) => this.queue(0xff, ...bytes); // one byte of Ncr, then the response

    if (this.appCmd) {
      this.appCmd = false;
      if (index === 41) {
        // ACMD41: initialise. This SDHC card needs the host to support high capacity (HCS).
        if (arg & 0x40000000) this.idle = false;
        respond(this.idle ? R1_IDLE : 0);
      } else {
        respond(r1 | R1_ILLEGAL);
      }
      return;
    }

    const ready = !this.idle;
    switch (index) {
      case 0: // GO_IDLE_STATE
        this.powerOn();
        respond(R1_IDLE);
        return;
      case 8: // SEND_IF_COND: echo voltage range and check pattern
        respond(r1, 0x00, 0x00, (arg >> 8) & 0x0f, arg & 0xff);
        return;
      case 55: // APP_CMD
        this.appCmd = true;
        respond(r1);
        return;
      case 58: // READ_OCR: 3.2-3.4 V; bit 31 power-up done, bit 30 CCS (block addressing)
        respond(r1, ready ? 0xc0 : 0x40, 0xff, 0x80, 0x00);
        return;
      case 59: // CRC_ON_OFF
        respond(r1);
        return;
    }
    if (!ready) {
      respond(r1 | R1_ILLEGAL);
      return;
    }
    switch (index) {
      case 9: // SEND_CSD
        respond(0, TOKEN_DATA, ...this.csd(), 0xff, 0xff);
        return;
      case 10: // SEND_CID
        respond(0, TOKEN_DATA, ...this.cid(), 0xff, 0xff);
        return;
      case 12: // STOP_TRANSMISSION
        respond(0);
        return;
      case 13: // SEND_STATUS (R2)
        respond(0, 0);
        return;
      case 16: // SET_BLOCKLEN: SDHC blocks are always 512 bytes
        respond(arg === SECTOR ? 0 : R1_PARAMETER_ERROR);
        return;
      case 17: // READ_SINGLE_BLOCK (arg = LBA, block addressing)
        if (arg >= this.sectors) return respond(R1_ADDRESS_ERROR);
        this.stats.cmd17++;
        respond(0);
        this.queueBlock(arg); // data token right after R1: no wait for the driver
        return;
      case 18: // READ_MULTIPLE_BLOCK: blocks are queued as the host reads them
        if (arg >= this.sectors) return respond(R1_ADDRESS_ERROR);
        this.stats.cmd18++;
        respond(0);
        this.mode = { kind: 'readMulti', lba: arg };
        return;
      case 24: // WRITE_BLOCK
      case 25: // WRITE_MULTIPLE_BLOCK
        if (arg >= this.sectors) return respond(R1_ADDRESS_ERROR);
        this.stats[index === 24 ? 'cmd24' : 'cmd25']++;
        respond(0);
        this.mode = { kind: 'writeWait', lba: arg, multi: index === 25 };
        return;
      default:
        respond(R1_ILLEGAL);
    }
  }

  private csd(): number[] {
    const cSize = this.sectors / 1024 - 1; // capacity = (C_SIZE + 1) * 512 KB
    const csd = [
      0x40, // CSD structure 2.0
      0x0e, // TAAC
      0x00, // NSAC
      0x32, // TRAN_SPEED: 25 MHz
      0x5b, // CCC
      0x59, // CCC, READ_BL_LEN = 9 (512 bytes)
      0x00, // flags
      (cSize >> 16) & 0x3f,
      (cSize >> 8) & 0xff,
      cSize & 0xff,
      0x7f, // ERASE_BLK_EN, SECTOR_SIZE
      0x80, // SECTOR_SIZE, WP_GRP_SIZE
      0x0a, // R2W_FACTOR, WRITE_BL_LEN = 9
      0x40, // WRITE_BL_LEN, WRITE_BL_PARTIAL = 0
      0x00, // file format, write protect off
      0,
    ];
    csd[15] = (crc7(csd, 15) << 1) | 1;
    return csd;
  }

  private cid(): number[] {
    const cid = [0x00, 0x50, 0x53, 0x50, 0x49, 0x43, 0x4f, 0x53, 0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0x8a, 0];
    cid[15] = (crc7(cid, 15) << 1) | 1;
    return cid;
  }
}
