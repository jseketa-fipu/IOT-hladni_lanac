# IOT – hladni lanac (pico-sim)

A Raspberry Pi Pico W running **real MicroPython**, simulated in your browser.
It's our alternative to Wokwi for the *Nadzor hladnog lanca* assignment: the whole
group works in one Git repo, and every push updates the live simulator.

**Open it:** https://jseketa-fipu.github.io/IOT-hladni_lanac/ and press **▶ Run**.

**Requirements:** [docs/zahtjevi.md](docs/zahtjevi.md) (in Croatian) is Luka's task plan with everything
we added or changed clearly marked **[DODANO]** / **[PROMIJENJENO]**.

---

## Contents

- [Quick start (your own computer)](#quick-start-your-own-computer)
- [Everyday workflow](#everyday-workflow)
- [Live reload](#live-reload)
- [Tests](#tests)
- [Command cheat sheet](#command-cheat-sheet)
- [Using the page](#using-the-page)
- [Changing the circuit](#changing-the-circuit)
- [Publishing](#publishing)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)

---

## Quick start (your own computer)

You need, once:

| Tool | Version | Check with |
|---|---|---|
| [Node.js](https://nodejs.org/) | 22 or newer | `node -v` |
| [Python](https://www.python.org/) | 3.10 or newer (only for the logic tests) | `python --version` |
| [Git](https://git-scm.com/) | any | `git --version` |

Then:

```sh
git clone https://github.com/jseketa-fipu/IOT-hladni_lanac.git
cd IOT-hladni_lanac
npm install
npm run dev
```

Open **http://localhost:8080** and press **▶ Run**. The first start downloads the
MicroPython firmware (about 2 MB) into `public/firmware/`; after that it works offline.

---

## Everyday workflow

The program that runs on the Pico lives in **`project/`**:

| File | What it is |
|---|---|
| `project/main.py` | The program: reads the sensor, logs to the SD card, drives the LED, handles the button |
| `project/hladni_lanac.py` | The decision logic (range check, alarm, daily summary), no hardware code |
| `project/diagram.json` | The wiring: which part is connected to which pin |
| `project/sdcard.py`, `project/ds1307.py` | Drivers for the SD card and the clock |

A good loop while you work:

1. Keep **`npm run dev`** running in one terminal and the page open in your browser.
2. Keep **`npm run test:watch`** running in a second terminal.
3. Edit a file in `project/` in your editor and save.
4. The page reloads and restarts the simulation with your change, and the tests rerun
   in the second terminal. The page restarts in a few seconds; a `.py` change reruns
   the whole test suite, which takes about a minute (single test files take seconds).
5. When you're happy, commit and push. GitHub runs the same tests and, if they
   pass, updates the live page.

> The code editor **on the page** is for quick experiments. It doesn't save to disk,
> and a live reload throws its changes away. Do real work in your own editor.

---

## Live reload

`npm run dev` watches three folders:

| You change… | What happens |
|---|---|
| `project/` (main.py, diagram.json, …) | Files are copied, the page reloads, and the simulation **restarts automatically** if it was running |
| `src/` (the simulator itself) | The page is rebuilt and reloads |
| `public/` (HTML, CSS) | Copied, page reloads |

The page remembers which tab you had open and which board you picked across reloads.

---

## Tests

There are three kinds, and they all run on your computer exactly as they do on GitHub.

### 1. Logic tests (Python, under a second)

`test/python/` tests `project/hladni_lanac.py` with plain CPython: range limits,
when the alarm fires, the daily summary maths, CSV formatting. No simulator involved.

```sh
npm run test:py
```

### 2. Simulation tests (real MicroPython, about a minute)

`test/*.test.ts` boot the **real MicroPython firmware** with the real project files
on the simulated Pico and parts, then act like a person in the lab: set the sensor
to 10 °C, wait three minutes, press the button, pull the SD card out. They check
the serial output, the LED and the CSV files on the card.

Simulated time runs as fast as your computer allows (minutes of simulated time take
seconds), so even "too warm for 2 minutes" scenarios are quick. The whole suite takes
about 1–1.5 minutes; a single file takes 5–60 seconds. The first run downloads the
MicroPython firmware into `public/firmware/` (needs internet once).

```sh
npm run test:sim                                  # all of them
node --import tsx --test test/sdcard.test.ts      # just one file
```

### 3. Browser check (optional)

Clicks through the real page in headless Chrome: Run, set the sensor to 6.5 °C with its
slider, wait for a measurement at 6.5 °C, press the button and check the summary, open the
CSV from the SD card panel. Any error on the page fails it.

```sh
npm run dev            # in one terminal
node test/browser.mjs  # in another
```

### Watch mode

```sh
npm run test:watch
```

Reruns tests every time you save, and only the ones that matter:

| You save… | It runs |
|---|---|
| a test file `test/xyz.test.ts` | just that file |
| any `.py` file | logic tests, then simulation tests |
| anything in `src/` or `diagram.json` | simulation tests |

At start-up and when you press **Enter** it runs everything (logic tests, then simulation
tests); **Ctrl+C** stops it.

---

## Command-line simulator (npm run sim)

Want to see what the program does when it gets warm for three minutes, without
waiting three minutes or writing a test? `npm run sim` boots the real project
(`project/*.py` + `project/diagram.json`, real MicroPython, all the parts) in your
terminal, fast-forwards through a timeline of things you do to it, prints the serial
output with the **simulated** time in front of each line, and ends with a summary:
LED states, alarm messages, the files on the SD card and their last lines.

Copy-paste checks for the assignment:

```sh
# 1. Normal operation: 5 °C, one minute, no alarm, LED off
npm run sim -- --temp 5 --for 1m --expect "U_RASPONU" --expect-led led1=off

# 2. Too warm for more than 2 minutes: alarm message and LED on
npm run sim -- --temp 10 --for 2m30s --expect "[ALARM]" --expect-led led1=on

# 3. Warm spell, back to normal, then the button prints the summary and the CSV tail
npm run sim -- --temp 5 --at 30s temp=10 --at 3m30s temp=5 --at 4m press --for 5m

# 4. Daily summary at midnight (the clock starts at 23:58)
npm run sim -- --rtc "2026-11-25 23:58:00" --for 3m --expect "[DNEVNI SAZETAK]"

# 5. No SD card: the program says so and keeps measuring
npm run sim -- --sd out --for 30s --expect "kartica nije dostupna"
```

What it looks like (example 3, middle part cut):

```text
00:00:00.670  [RTC] sat: 2026-11-17 10:00:00
00:00:00.694  [SENZOR] pronaden DS18B20 (2801005e1d0000be)
00:00:21.495  [MJERENJE] 2026-11-17 10:00:21 | 5.00 C | U_RASPONU
00:00:30.000  >> temp=10
00:00:31.490  [MJERENJE] 2026-11-17 10:00:31 | 10.00 C | ODBROJAVANJE
...
00:02:41.472  [ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s
...
00:03:30.000  >> temp=5
00:03:31.473  [ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 3 min 0 s
00:04:00.000  >> press
00:04:00.007  [TIPKALO] pritisak
00:04:00.008  [SAZETAK] 2026-11-17: mjerenja 24, min 5.00 C, max 10.00 C, prosjek 8.75 C, izvan raspona 3 min 0 s, alarma 1, neuspjelih 0
...

---- summary ----
simulated 5 min 0 s in 13.3 s wall time (22.5x)
RTC now: rtc1 2026-11-17 10:05:00
LEDs: led1 off
measurements: 30
alarm messages (2):
  [ALARM] temperatura 10.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s
  [ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 3 min 0 s
SD sd1 (inserted)
  hladnjaca.csv  1122 B
    2026-11-17 10:04:31,5.00,U_RASPONU
    2026-11-17 10:04:41,5.00,U_RASPONU
    2026-11-17 10:04:51,5.00,U_RASPONU
```

Lines starting with `>>` are your actions. In a terminal, alarms and errors are red and
summaries cyan; when the output goes to a file or pipe there are no colours.

**Things you can do on the timeline** (`--at <time> <action> [<action>...]`, times are
simulated time since power-on, e.g. `500ms`, `30s`, `3m30s`, `1h`):

| Action | Meaning |
|---|---|
| `temp=10` / `temp:temp1=4` | set the DS18B20 temperature (all sensors, or one by id) |
| `press` / `press:btn1` | press the button for 300 ms |
| `hold:btn1=2s` | hold the button down for a while |
| `sensor=off` / `sensor=on` | unplug / plug the sensor back in |
| `sd=out` / `sd=in` | pull the SD card out / put it back |
| `rtc="2026-11-25 23:58:00"` | set the DS1307 clock |
| `send="text"` | type into the serial input (`\r`, `\n`, `\x03` = Ctrl+C work) |

**Options:** `--temp`, `--rtc`, `--sd in|out`, `--sensor on|off` set the starting
conditions (the clock starts at 2026-11-17 10:00:00 unless you give `--rtc`, so runs
are repeatable). `--for` is the total time (default: last action + 30 s, at least
1 minute). `--until "text"` stops as soon as the text is printed. `--expect "text"`
(repeatable) and `--expect-led led1=on|off` turn the run into a check: it ends with
`all checks passed` or `FAIL` and exit code 1. `--quiet` prints only the summary,
`--sd-dump some-folder` copies the card's files out so you can open the CSV,
`--firmware pico` uses the plain Pico build, `--realtime` runs at real speed.
`npm run sim -- --help` lists everything.

**Longer scripts** go in a JSON file with the same options:

```json
{
  "temp": 5,
  "for": "5m",
  "timeline": [
    { "at": "30s", "do": "temp=10" },
    { "at": "3m", "do": "press" },
    { "at": "4m", "do": ["temp=5", "sd=out"] }
  ],
  "expect": ["[ALARM]", "[SAZETAK]", "[SD] greska pri zapisu"],
  "expectLed": { "led1": "off" }
}
```

```sh
npm run sim -- scenario.json            # flags after the file add to it
```

MicroPython starting up (the first simulated second) is the slow part, a few seconds
of wall time; after that, minutes of simulated time take seconds.

---

## Command cheat sheet

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (once, and after pulling changes to `package.json`) |
| `npm run dev` | Local simulator at http://localhost:8080 with live reload |
| `npm test` | All tests (logic + simulation), same as on GitHub |
| `npm run test:py` | Logic tests only |
| `npm run test:sim` | Simulation tests only |
| `npm run test:watch` | Rerun tests on every save |
| `npm run sim -- --temp 10 --for 3m` | Run the project in the terminal, fast-forwarded ([details](#command-line-simulator-npm-run-sim)) |
| `npm run typecheck` | Check the TypeScript of the simulator |
| `npm run build` | Build the site into `dist/` (what GitHub Pages serves) |

---

## Using the page

- **▶ Run / ■ Stop**: start or stop the Pico. Each Run is a fresh power-on.
- **Board**: Pico W or Pico, both with MicroPython 1.22 (the version Wokwi uses).
- **Speed**: how fast simulated time runs: 1× (real time), 5×, 10×, 20× or Max.
  The program behaves exactly the same at every speed; only the wait changes. The
  LED alarm needs the temperature out of range for **more than 2 minutes**: at 10×
  that's about 13 seconds instead. How fast it can go depends on your computer
  (typically 15–25×); if a speed can't be reached, the status bar says what it
  actually gets. You can change the speed while the program runs.
- **Circuit**: the wiring from `diagram.json`. Parts react live: the LED lights, and
  you can click the button. The status bar shows simulated time and speed
  (100 % means real time).
- **Parts** (right-hand panel): one card per part in `diagram.json`. Everything here
  works before **Run** (the conditions the program starts with) and while it runs.
  - **DS18B20**: temperature slider (−20 to 40 °C) and a box for any value from −55 to
    125 °C; untick *connected* to unplug the sensor. The real chip measures in 1/16 °C
    steps, so the badge in the circuit shows what it will report: type 8.04 and it reports
    **8.06**, which is already outside 2–8 °C. The panel points this out when it happens.
  - **DS1307 clock**: the clock's current date and time. Pick a new one and press **Set**,
    or **Jump to 23:58:00** to see the daily summary at midnight two minutes later.
    Like the real battery-backed chip, it keeps counting between runs, and it only holds
    the years 2000–2099. Setting it *back* (e.g. pressing Jump twice) doesn't close a day
    twice: the program prints a `[RTC]` warning and keeps adding to the current day.
  - **microSD**: untick *inserted* to pull the card out; tick it again and the program
    finds the card at the next measurement and carries on writing (readings taken while
    it was out are not on the card, but they were printed). The file list shows what the
    program wrote (size, and when it last changed); **view** opens a file, **download**
    saves it. The card keeps its files between runs, like a real card; **Erase** formats it.
    The button prints only the last 10 CSV rows. To get the whole file through the serial
    monitor instead (e.g. in Wokwi, which has no download), press **Ctrl+C** in the
    monitor and type `ispisi_csv(None)`.
  - If a part is wired wrongly (say, the card's DO on a pin that isn't an SPI RX pin),
    the panel says what's wrong, the part gets a red dashed outline in the circuit, and
    the program sees no part there, as on a real breadboard.
- **Serial monitor**: everything the program prints. Type into the box below it and
  press Enter to send text. **Ctrl+C** stops the program and gives you the MicroPython
  REPL (`>>>`), where you can try commands by hand.
- **Ctrl+Enter** in the editor runs the code.

---

## Changing the circuit

The wiring is in `project/diagram.json`, in the same format Wokwi uses:

```json
{ "type": "wokwi-led", "id": "led1", "top": 130, "left": 160, "attrs": { "color": "red" } }
```
```json
[ "pico:GP16", "r1:1", "green", [] ]
```

- `parts`: each part has a type, an id, and a position in pixels.
- `connections`: `[from, to, wire colour, waypoints]`. Waypoints like `"h20"` (go
  20 px right) or `"v-10"` (go 10 px up) shape the wire. Without them, the wire goes
  sideways first, then up or down.
- `"rotate": 90` (or 180, 270) on a part turns it clockwise, as in Wokwi.
- Pin names on the Pico: `GP0`–`GP28`, `GND.1`–`GND.8`, `3V3`, `VSYS`, `VBUS`.

The simulation follows the wiring, not the code: if the LED's leg isn't connected to
GND, it stays dark, just like on a real breadboard.

**Supported parts** and how they must be wired to work:

| Part (`type`) | Pins | Wiring rules |
|---|---|---|
| `wokwi-led` | `A`, `C` | Lit when the anode reaches a high pin and the cathode a low one (resistors in between are fine) |
| `wokwi-resistor` | `1`, `2` | Carries LED current; on a GPIO input it works as a pull-up or pull-down. It is not a wire: a part's VCC behind a resistor is not powered |
| `wokwi-pushbutton` | `1.l`, `1.r`, `2.l`, `2.r` | Pressed, it connects side 1 to side 2 |
| `wokwi-ds18b20` | `GND`, `DQ`, `VCC` | DQ on any GPIO, with a pull-up resistor (4.7 kΩ) from DQ to 3V3. VCC on 3V3 (or VSYS/VBUS); VCC on GND (parasite power) is not supported. `attrs.temperature` sets the starting temperature |
| `wokwi-microsd-card` | `CD`, `DO`, `GND`, `SCK`, `VCC`, `DI`, `CS` | SCK, DI and DO on one SPI controller with the right roles: SPI0 SCK GP2/6/18/22, DI (TX) GP3/7/19, DO (RX) GP0/4/16/20; SPI1 SCK GP10/14/26, DI GP11/15/27, DO GP8/12/28. CS on any GPIO. VCC on 3V3 (VSYS/VBUS are accepted too, but would damage a real card) |
| `wokwi-ds1307` | `GND`, `5V`, `SDA`, `SCL`, `SQW` | SDA and SCL on one I²C controller: I2C0 SDA GP0/4/8/12/16/20/28 with SCL GP1/5/9/13/17/21; I2C1 SDA GP2/6/10/14/18/22/26 with SCL GP3/7/11/15/19/27. 5V on VBUS or VSYS (on 3V3 the chip doesn't answer) |

Every part also needs its GND wired to a GND pin and its supply pin to a supply pin.
A GPIO can serve only one part pin: if two part pins land on the same GPIO, the later part
is not attached. A button or LED on a GPIO that a part uses does nothing in the simulator;
one wired straight to that GPIO gets a warning, one behind a resistor does not. A wire end
that names a part or pin that doesn't exist (a typo) is reported too. All of these show
up as warnings at the top of the Parts panel.

> **Real hardware:** many DS1307 modules have their own I²C pull-up resistors to the
> module's 5 V. On a real Pico that puts 5 V on GP8/GP9, which the RP2040 is not rated
> for. Remove those pull-ups (or use a module without them) and pull SDA/SCL up to 3V3.

Our project's wiring (`project/diagram.json`):

| Part | Pico pins |
|---|---|
| LED + 220 Ω | GP16 → 220 Ω → LED → GND |
| Button | GP14 and GND (the program uses the internal pull-up) |
| DS18B20 | DQ GP15, 4.7 kΩ from DQ to 3V3, VCC 3V3, GND |
| microSD (SPI0) | SCK GP2, DI GP3, DO GP4, CS GP5, VCC 3V3, GND |
| DS1307 (I2C0) | SDA GP8, SCL GP9, 5V VBUS, GND |

A few wires in the drawing cross. With these pins and the parts' fixed pin order it can't
be avoided: the card's pins (DO, GND, SCK, VCC, DI, CS) are in a different order than
GP2–GP5, and the clock's I²C pins sit on the far side of the Pico. Crossing wires are not
connected; only wire ends at the same pin are.

---

## Publishing

Every push to `main` runs `.github/workflows/pages.yml`: install, build, typecheck,
**all tests**, then deploy to GitHub Pages. If a test fails, the live page keeps the
previous version and the run is marked red on GitHub's *Actions* tab.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm run test:py` says *No Python interpreter found* | Install Python 3, or point to it: `PYTHON=/path/to/python npm run test:py` |
| Port 8080 is busy | Usually another `npm run dev` is still running; close it, or use another port: `PORT=8081 npm run dev` |
| Tests fail with *firmware missing* | Run `npm run fetch-firmware` once (needs internet); `npm run test:sim`, `sim`, `dev` and `build` do it for you |
| The page shows old code after a push | Hard-refresh: **Ctrl+F5** (GitHub Pages caches for a few minutes) |
| Nothing printed in the serial monitor | Check the status bar for an error; press **Ctrl+C** in the monitor to see if the REPL answers |
| Firmware download fails | Check the internet connection once; it's cached in `public/firmware/` afterwards |

---

## How it works

- **CPU and chip**: [rp2040js](https://github.com/wokwi/rp2040js) emulates the RP2040
  (the Pico's chip) instruction by instruction, with its GPIO, timers, SPI, I²C and USB.
- **Firmware**: the official MicroPython `.uf2` from micropython.org runs unmodified.
- **Your files**: `project/` is packed into a LittleFS image
  ([littlefs-wasm](https://github.com/wokwi/littlefs-wasm)) where MicroPython expects
  its filesystem, so `main.py` runs at power-on, like in Wokwi.
- **Parts**: drawn with Wokwi's open-source graphics
  ([@wokwi/elements](https://github.com/wokwi/wokwi-elements)) and simulated by our
  own models in `src/devices/`, which talk the real protocols (1-Wire, SPI, I²C) to
  the unmodified MicroPython drivers.
- **Timing**: simulated time is kept in step with real time in the browser. When the
  program sleeps, the clock jumps straight to the next timer event, so an idle Pico
  costs almost nothing. Tests skip the real-time pacing and run as fast as possible.
- **Serial**: MicroPython's USB serial. One fix was needed: rp2040js's emulated USB
  host answered every receive request at once with an empty packet, causing about
  35,000 interrupts a second and holding the board at about 20 % speed. Ours waits
  until there's input, like a real computer.

---

## Project layout

| Path | What |
|---|---|
| `project/` | The MicroPython program and the wiring (`diagram.json`) |
| `docs/zahtjevi.md` | Requirements: Luka's plan plus our additions and changes, marked |
| `src/board.ts` | The simulated Pico: firmware, timing, USB serial, fast-forward for tests |
| `src/devices/` | Part models: DS18B20, microSD card (+ FAT16), DS1307 clock |
| `src/system.ts` | The circuit's electrical side (no drawing): nets, LEDs, buttons, pull-ups, which part model sits on which pins, wiring checks. Used by the page and the tests |
| `src/circuit.ts` | Draws the circuit and passes mouse clicks to `system.ts` |
| `src/controls.ts` | The Parts panel: sensor, clock and SD card controls, file viewer |
| `src/main.ts` | The page: editor, Run/Stop, serial monitor, live reload |
| `src/fs.ts` | Packs `project/` into the Pico's flash |
| `test/` | Simulation tests (`*.test.ts`), Python logic tests (`python/`), browser check |
| `scripts/` | Build, dev server, test runners |
| `public/` | The static page (HTML, CSS); firmware is downloaded into `public/firmware/` |

---

## Known limitations

- **Pico W radio**: Wi-Fi isn't emulated, and `Pin("LED")` (the onboard LED, which is
  wired through the radio chip) doesn't work. Use an external LED, as this project does.
- **Internal flash is read-only while running**: the program can't save files to the
  Pico's own filesystem. Use the SD card, like the assignment asks.
- **Wokwi diagrams**: the format is the same, but the Pico drawing has a different size,
  so wire coordinates from a Wokwi `diagram.json` need adjusting. Parts other than the
  ones in the table under [Changing the circuit](#changing-the-circuit) are not drawn.
- **Electrical model**: on/off levels only. No voltages or currents: an LED without a
  resistor still lights, and a short (two outputs fighting) is not reported.

---

## Licenses of bundled pieces

rp2040js: MIT · RP2040 boot ROM: BSD-3-Clause (Raspberry Pi) · MicroPython: MIT ·
littlefs: BSD-3-Clause · littlefs-wasm: ISC · @wokwi/elements: MIT ·
sdcard.py (micropython-lib): MIT.
