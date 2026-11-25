// Downloads the official MicroPython firmware images into public/firmware.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://micropython.org/resources/firmware/';
const IMAGES = ['RPI_PICO-20231227-v1.22.0.uf2', 'RPI_PICO_W-20231227-v1.22.0.uf2'];
const DIR = new URL('../public/firmware/', import.meta.url);

mkdirSync(DIR, { recursive: true });
for (const name of IMAGES) {
  const target = new URL(name, DIR);
  if (existsSync(target)) continue;
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  writeFileSync(target, new Uint8Array(await res.arrayBuffer()));
  console.log('downloaded', name);
}
