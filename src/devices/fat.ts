// FAT16 "superfloppy" volumes (no partition table) over a 512-byte block store:
// a formatter that MicroPython's VfsFat (FatFs) mounts as is, and a reader so the
// host (page or tests) can list and read back the files MicroPython wrote.
// Pure functions, no Node APIs: this runs in the browser too.

export const SECTOR = 512;

/** Anything that stores 512-byte blocks by LBA. Unwritten blocks read as zeros. */
export interface BlockStore {
  read(lba: number): Uint8Array;
  write(lba: number, data: Uint8Array): void;
}

export interface FatFile {
  /** Path relative to the root, e.g. "mjerenja.csv" or "logs/day1.txt". */
  name: string;
  size: number;
  data: Uint8Array;
}

const ROOT_ENTRIES = 512;
const RESERVED = 1;
const NUM_FATS = 2;
const MIN_FAT16_CLUSTERS = 4086; // FatFs: more than 4085 clusters, else it is FAT12
const MAX_FAT16_CLUSTERS = 65524; // FatFs: at most 65525 - 1 usable clusters
const MAX_SECTORS_PER_CLUSTER = 128;

interface Layout {
  sectorsPerCluster: number;
  fatSectors: number;
  clusters: number;
}

function layoutFor(sectors: number): Layout | null {
  const rootSectors = (ROOT_ENTRIES * 32) / SECTOR;
  const candidates: Layout[] = [];
  for (let spc = 1; spc <= MAX_SECTORS_PER_CLUSTER; spc *= 2) {
    // A FAT big enough for every cluster that could exist (slight overestimate is fine).
    const maxClusters = Math.floor((sectors - RESERVED - rootSectors) / spc);
    const fatSectors = Math.ceil(((maxClusters + 2) * 2) / SECTOR);
    const clusters = Math.floor((sectors - RESERVED - NUM_FATS * fatSectors - rootSectors) / spc);
    if (clusters >= MIN_FAT16_CLUSTERS && clusters <= MAX_FAT16_CLUSTERS) {
      candidates.push({ sectorsPerCluster: spc, fatSectors, clusters });
    }
  }
  // Prefer a cluster count well away from the FAT16 upper limit (like Windows does),
  // falling back to the smallest valid cluster size.
  return candidates.find((c) => c.clusters < 0x8000) ?? candidates[0] ?? null;
}

/** Whether `sectors` blocks can hold a FAT16 volume (about 2.1 MB to 4 GB). */
export function fat16Supported(sectors: number): boolean {
  return layoutFor(sectors) !== null;
}

function ascii(buf: Uint8Array, offset: number, text: string, length: number) {
  for (let i = 0; i < length; i++) buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0x20;
}

/**
 * Write an empty FAT16 volume over `sectors` blocks: boot sector at LBA 0 (no partition
 * table), 2 FATs, 512 root entries, volume label `label`. Only the blocks that hold
 * something are written, so a sparse store stays small. Blocks the store has never seen
 * must read as zeros (empty FAT, empty directory). Throws if FAT16 cannot fit `sectors`
 * (fewer than ~4.1 MB or more than ~4 GB).
 */
export function formatFat16(store: BlockStore, sectors: number, label = 'PICO-SIM', volumeId = 0x50494353) {
  const layout = layoutFor(sectors);
  if (!layout) throw new Error(`FAT16 cannot format ${sectors} sectors (${(sectors * SECTOR) / 2 ** 20} MB)`);
  const { sectorsPerCluster, fatSectors } = layout;
  const rootSectors = (ROOT_ENTRIES * 32) / SECTOR;

  const boot = new Uint8Array(SECTOR);
  const v = new DataView(boot.buffer);
  boot.set([0xeb, 0x3c, 0x90], 0); // jump
  ascii(boot, 3, 'MSDOS5.0', 8);
  v.setUint16(11, SECTOR, true); // bytes per sector
  boot[13] = sectorsPerCluster;
  v.setUint16(14, RESERVED, true);
  boot[16] = NUM_FATS;
  v.setUint16(17, ROOT_ENTRIES, true);
  v.setUint16(19, sectors < 0x10000 ? sectors : 0, true); // total sectors (16-bit)
  boot[21] = 0xf8; // media: fixed disk
  v.setUint16(22, fatSectors, true);
  v.setUint16(24, 63, true); // sectors per track
  v.setUint16(26, 255, true); // heads
  v.setUint32(28, 0, true); // hidden sectors: none, no partition table
  v.setUint32(32, sectors < 0x10000 ? 0 : sectors, true); // total sectors (32-bit)
  boot[36] = 0x80; // drive number
  boot[38] = 0x29; // extended boot signature
  v.setUint32(39, volumeId, true);
  ascii(boot, 43, label.toUpperCase().slice(0, 11), 11);
  ascii(boot, 54, 'FAT16', 8);
  boot[510] = 0x55;
  boot[511] = 0xaa;

  const zero = new Uint8Array(SECTOR);
  store.write(0, boot);
  // Clear everything the volume's metadata uses (in case the store held something else).
  for (let s = RESERVED; s < RESERVED + NUM_FATS * fatSectors + rootSectors; s++) store.write(s, zero);

  const fat0 = new Uint8Array(SECTOR);
  fat0.set([0xf8, 0xff, 0xff, 0xff]); // FAT[0] = media, FAT[1] = clean shutdown / no errors
  for (let f = 0; f < NUM_FATS; f++) store.write(RESERVED + f * fatSectors, fat0);

  const root = new Uint8Array(SECTOR);
  ascii(root, 0, label.toUpperCase().slice(0, 11), 11);
  root[11] = 0x08; // volume label entry
  store.write(RESERVED + NUM_FATS * fatSectors, root);
}

interface Volume {
  store: BlockStore;
  spc: number;
  fatStart: number;
  rootStart: number;
  rootSectors: number;
  dataStart: number;
  clusters: number;
}

function openVolume(store: BlockStore): Volume | null {
  const boot = store.read(0);
  if (boot[510] !== 0x55 || boot[511] !== 0xaa) return null;
  const v = new DataView(boot.buffer, boot.byteOffset, SECTOR);
  const bps = v.getUint16(11, true);
  const spc = boot[13];
  const rsvd = v.getUint16(14, true);
  const nfats = boot[16];
  const rootEntries = v.getUint16(17, true);
  const total = v.getUint16(19, true) || v.getUint32(32, true);
  const fatSectors = v.getUint16(22, true);
  if (bps !== SECTOR || !spc || !rsvd || !nfats || !rootEntries || !fatSectors) return null; // not FAT12/16
  const fatStart = rsvd;
  const rootStart = fatStart + nfats * fatSectors;
  const rootSectors = Math.ceil((rootEntries * 32) / SECTOR);
  const dataStart = rootStart + rootSectors;
  const clusters = Math.floor((total - dataStart) / spc);
  if (clusters < MIN_FAT16_CLUSTERS || clusters > MAX_FAT16_CLUSTERS) return null; // FAT12 or FAT32
  return { store, spc, fatStart, rootStart, rootSectors, dataStart, clusters };
}

function fatEntry(vol: Volume, cluster: number): number {
  const offset = cluster * 2;
  const sector = vol.store.read(vol.fatStart + Math.floor(offset / SECTOR));
  const i = offset % SECTOR;
  return sector[i] | (sector[i + 1] << 8);
}

/** Sectors of a cluster chain, in order (stops on a bad link, a loop or end of chain). */
function chainSectors(vol: Volume, first: number, maxBytes = Infinity): number[] {
  const sectors: number[] = [];
  const seen = new Set<number>();
  let cluster = first;
  while (cluster >= 2 && cluster < vol.clusters + 2 && !seen.has(cluster) && sectors.length * SECTOR < maxBytes) {
    seen.add(cluster);
    const lba = vol.dataStart + (cluster - 2) * vol.spc;
    for (let i = 0; i < vol.spc; i++) sectors.push(lba + i);
    cluster = fatEntry(vol, cluster);
  }
  return sectors;
}

function readSectors(vol: Volume, sectors: number[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i * SECTOR < size && i < sectors.length; i++) {
    const block = vol.store.read(sectors[i]);
    out.set(block.subarray(0, Math.min(SECTOR, size - i * SECTOR)), i * SECTOR);
  }
  return out;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  cluster: number;
  size: number;
}

function sfnChecksum(entry: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + entry[i]) & 0xff;
  return sum;
}

function shortName(e: Uint8Array): string {
  const text = (from: number, to: number) =>
    String.fromCharCode(...e.subarray(from, to))
      .replace(/ +$/, '');
  let base = text(0, 8);
  if (e[0] === 0x05) base = 'å' + base.slice(1); // 0x05 stands for a leading 0xE5
  let ext = text(8, 11);
  // FatFs / Windows NT case flags: 0x08 = base name lower case, 0x10 = extension lower case.
  if (e[12] & 0x08) base = base.toLowerCase();
  if (e[12] & 0x10) ext = ext.toLowerCase();
  return ext ? `${base}.${ext}` : base;
}

function readDir(vol: Volume, sectors: number[]): DirEntry[] {
  const entries: DirEntry[] = [];
  let lfnParts: string[] = [];
  let lfnChecksum = -1;
  for (const lba of sectors) {
    const block = vol.store.read(lba);
    for (let off = 0; off < SECTOR; off += 32) {
      const e = block.subarray(off, off + 32);
      if (e[0] === 0x00) return entries; // end of directory
      if (e[0] === 0xe5) {
        lfnParts = [];
        continue; // deleted
      }
      const attr = e[11];
      if ((attr & 0x3f) === 0x0f) {
        // Long file name piece: 13 UTF-16 characters, pieces stored last first.
        const seq = e[0] & 0x1f;
        if (e[0] & 0x40) {
          lfnParts = [];
          lfnChecksum = e[13];
        }
        let piece = '';
        for (const [from, count] of [
          [1, 5],
          [14, 6],
          [28, 2],
        ]) {
          for (let k = 0; k < count; k++) {
            const c = e[from + 2 * k] | (e[from + 2 * k + 1] << 8);
            if (c === 0x0000 || c === 0xffff) break;
            piece += String.fromCharCode(c);
          }
        }
        lfnParts[seq - 1] = piece;
        continue;
      }
      const lfn = lfnParts.length && lfnChecksum === sfnChecksum(e) ? lfnParts.join('') : '';
      lfnParts = [];
      if (attr & 0x08) continue; // volume label
      const name = lfn || shortName(e);
      if (name === '.' || name === '..') continue;
      const v = new DataView(e.buffer, e.byteOffset, 32);
      entries.push({ name, isDir: !!(attr & 0x10), cluster: v.getUint16(26, true), size: v.getUint32(28, true) });
    }
  }
  return entries;
}

/**
 * Every file on a FAT16 volume, with its contents. Files in subdirectories come back
 * as "dir/name" (up to 4 levels deep). Returns [] if the store holds no FAT16 volume.
 */
export function listFiles(store: BlockStore): FatFile[] {
  const vol = openVolume(store);
  if (!vol) return [];
  const files: FatFile[] = [];
  const walk = (sectors: number[], prefix: string, depth: number) => {
    for (const entry of readDir(vol, sectors)) {
      if (entry.isDir) {
        if (depth < 4 && entry.cluster >= 2) walk(chainSectors(vol, entry.cluster), `${prefix}${entry.name}/`, depth + 1);
      } else {
        const data = readSectors(vol, chainSectors(vol, entry.cluster, entry.size), entry.size);
        files.push({ name: prefix + entry.name, size: entry.size, data });
      }
    }
  };
  const root = Array.from({ length: vol.rootSectors }, (_, i) => vol.rootStart + i);
  walk(root, '', 0);
  return files;
}
