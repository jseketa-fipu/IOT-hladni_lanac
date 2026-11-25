# pico-sim

A Raspberry Pi Pico (W) running real MicroPython, simulated in the browser and
served as a static site from GitHub Pages. Proof of concept for replacing Wokwi
in the cold-chain assignment, so the whole group can work through one Git repo.

## How it works

- **CPU and chip**: [rp2040js](https://github.com/wokwi/rp2040js) emulates the RP2040
  instruction by instruction, plus its GPIO, timers, UART, SPI, I²C, PIO and USB.
- **Firmware**: the official MicroPython `.uf2` from micropython.org is loaded into
  emulated flash, so your code runs in real MicroPython.
- **Your files**: everything in `project/` is packed into a LittleFS image
  ([littlefs-wasm](https://github.com/wokwi/littlefs-wasm)) and placed where MicroPython
  mounts its filesystem. On start, MicroPython runs `main.py` by itself, like in Wokwi.
- **Parts**: `src/main.ts` connects the LED (GP16) and button (GP14 to GND) to the
  emulated pins. The serial monitor is MicroPython's USB serial (REPL included).
- **Timing**: an execution loop keeps simulated time in step with real time
  (rp2040js on its own runs flat out and skips over sleeps). When the program sleeps,
  the CPU waits (WFE) and the clock jumps to the next timer alarm, so an idle board costs
  almost nothing and runs at 1.0x real time.
- **USB serial fix**: rp2040js's emulated USB host answers every receive request
  immediately, with an empty packet if it has nothing to send. MicroPython re-arms at once,
  which caused ~35,000 USB interrupts per second and held the board at ~20 % speed.
  `Board` holds those requests until there is input, like a real host does.

## Working on it

```sh
npm install
npm run dev        # http://localhost:8080 — rebuilds on src/ changes
npm test           # headless: boots MicroPython in Node, checks main.py output and LED blink
npm run typecheck
node test/browser.mjs   # with `npm run dev` running: clicks through the page in headless Chrome
```

`npm run build` writes the site to `dist/`. Pushing to `main` deploys it via
`.github/workflows/pages.yml` (enable it once: Settings → Pages → Source: GitHub Actions).

Group workflow: edit `project/main.py` (and friends) in the repo, push, and the
Pages link runs the new version. The editor on the page is for quick local
experiments only; it doesn't save anywhere.

## Layout

| Path | What |
|---|---|
| `project/` | The MicroPython program that runs on the board |
| `src/board.ts` | Board: firmware loading, real-time execution loop, USB serial |
| `src/fs.ts` | Builds the LittleFS image with the project files |
| `src/main.ts` | Page UI: editor, LED, button, serial monitor |
| `src/bootrom.ts` | RP2040 boot ROM (from the rp2040js demo) |
| `public/` | Static page; firmware is downloaded into `public/firmware/` |
| `test/` | Headless Node test and headless Chrome smoke test |

## Known limitations (proof of concept)

- **Writes to flash don't persist**: files are written once at start. A program can't
  save files to the internal filesystem (the microSD card part will be separate anyway).
- **Pico W**: the firmware boots and runs, but the wireless chip isn't emulated, so no
  Wi-Fi, and `Pin("LED")` (the onboard LED, wired through the wireless chip) won't work.
- **Not yet built**: DS18B20 (1-Wire), microSD card (SPI), a wiring file like Wokwi's
  `diagram.json`.

## Licenses of bundled pieces

rp2040js: MIT · RP2040 boot ROM: BSD-3-Clause (Raspberry Pi) · MicroPython: MIT ·
littlefs: BSD-3-Clause · littlefs-wasm: ISC.
