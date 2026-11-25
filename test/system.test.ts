// CircuitSystem: the wiring of diagram.json (nets, LEDs, buttons, pull resistors) and the
// part models it attaches, with the real project on real MicroPython.
// Run alone: node --import tsx --test test/system.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GPIOPinState } from 'rp2040js';
import { CircuitSystem, type Diagram } from '../src/system.js';
import { bootBoard, bootSystem, projectDiagram, projectFiles } from './helpers.js';

const utc = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));

/** A copy of the diagram with every wire end at `from` moved to `to` ("" removes those wires). */
function rewire(from: string, to: string, diagram = projectDiagram()): Diagram {
  const copy: Diagram = structuredClone(diagram);
  copy.connections = copy.connections
    .filter(([a, b]) => to !== '' || (a !== from && b !== from))
    .map(([a, b, c, w]) => [a === from ? to : a, b === from ? to : b, c, w]);
  return copy;
}

/** A copy of the diagram with the wire ends at `x` and `y` exchanged. */
function swap(x: string, y: string, diagram = projectDiagram()): Diagram {
  const copy: Diagram = structuredClone(diagram);
  const other = (r: string) => (r === x ? y : r === y ? x : r);
  copy.connections = copy.connections.map(([a, b, c, w]) => [other(a), other(b), c, w]);
  return copy;
}

function withoutPart(id: string, diagram = projectDiagram()): Diagram {
  return {
    parts: diagram.parts.filter((p) => p.id !== id),
    connections: diagram.connections.filter(([a, b]) => !a.startsWith(`${id}:`) && !b.startsWith(`${id}:`)),
  };
}

/** The project diagram without the DS18B20's 4.7k pull-up (DQ and VCC wired straight to GP15 and 3V3). */
function withoutPullUp(): Diagram {
  const d = withoutPart('r2');
  d.connections.push(['temp1:DQ', 'pico:GP15', 'orange', []], ['temp1:VCC', 'pico:3V3', 'red', []]);
  return d;
}

function press(board: { runFor(ms: number): void }, system: CircuitSystem, id = 'btn1', holdMs = 300) {
  system.press(id);
  board.runFor(holdMs);
  system.release(id);
}

describe('wiring checks (no board needed)', () => {
  test('the project diagram is wired correctly', () => {
    const system = new CircuitSystem(projectDiagram(), null);
    assert.deepEqual(system.warnings, []);
    assert.deepEqual(system.sensorIds, ['temp1']);
    assert.deepEqual(system.cardIds, ['sd1']);
    assert.deepEqual(system.rtcIds, ['rtc1']);
    assert.deepEqual(system.pinsOf('temp1'), { DQ: 15 });
    assert.deepEqual(system.pinsOf('sd1'), { SCK: 2, DI: 3, DO: 4, CS: 5, spi: 0 });
    assert.deepEqual(system.pinsOf('rtc1'), { SDA: 8, SCL: 9, i2c: 0 });
  });

  const cases: [string, Diagram, string][] = [
    ['SD DO on a non-RX pin', rewire('pico:GP4', 'pico:GP6'), 'sd1: DO must connect to an SPI RX pin (GP0/4/16/20 for SPI0)'],
    ['SD DI and DO swapped', swap('pico:GP3', 'pico:GP4'), 'sd1: DI must connect to an SPI TX pin (GP3/7/19 for SPI0)'],
    ['SD pins split over SPI0 and SPI1', rewire('pico:GP4', 'pico:GP12'), 'sd1: DO must connect to an SPI RX pin (GP0/4/16/20 for SPI0)'],
    ['SD VCC not wired', rewire('sd1:VCC', ''), 'sd1: VCC must connect to 3V3 or VSYS or VBUS'],
    ['SD GND not wired', rewire('sd1:GND', ''), 'sd1: GND must connect to a GND pin of the Pico'],
    ['SD CS not wired', rewire('sd1:CS', ''), 'sd1: CS is not connected to a GPIO'],
    ['RTC on 3V3', rewire('pico:VBUS', 'pico:3V3'), 'rtc1: 5V must connect to VBUS or VSYS (the DS1307 needs 5 V; on 3V3 it stays in battery backup mode and does not answer)'],
    ['RTC SDA/SCL swapped', swap('pico:GP8', 'pico:GP9'), 'rtc1: SDA must connect to an I2C SDA pin (GP0/4/8/12/16/20/28 for I2C0, GP2/6/10/14/18/22/26 for I2C1)'],
    ['RTC SCL on the other I2C', rewire('pico:GP9', 'pico:GP11'), 'rtc1: SCL must connect to an I2C SCL pin (GP1/5/9/13/17/21 for I2C0, like SDA)'],
    ['DS18B20 without pull-up', withoutPullUp(), 'temp1: DQ needs a pull-up resistor (4.7 kΩ) to 3V3'],
    ['DS18B20 parasite power', { ...withoutPart('r2'), connections: [...withoutPart('r2').connections, ['temp1:DQ', 'pico:GP15', '', []], ['temp1:VCC', 'pico:GND.6', '', []]] }, 'temp1: parasite power (VCC on GND) is not supported'],
    // One GPIO, two roles: the later part (diagram order sd1, rtc1, temp1) is not attached.
    ['SD CS on the DS18B20 DQ pin', rewire('pico:GP5', 'pico:GP15'), 'temp1: DQ (GP15) is already used by sd1 CS'],
    ['SD CS on the SD DI pin', rewire('pico:GP5', 'pico:GP3'), 'sd1: CS (GP3) is already used by sd1 DI'],
    ['DS18B20 DQ on the SD DO pin', rewire('pico:GP15', 'pico:GP4'), 'temp1: DQ (GP4) is already used by sd1 DO'],
    ['SD CS on the button pin', rewire('pico:GP5', 'pico:GP14'), 'btn1: GP14 belongs to sd1 CS, so btn1 on it is ignored'],
    ['typo in a button wire', rewire('btn1:2.r', 'btn1:2.x'), 'connection 19 (btn1:2.x - pico:GP14): btn1 has no pin "2.x"'],
    ['DS18B20 DQ on two GPIOs', { ...projectDiagram(), connections: [...projectDiagram().connections, ['temp1:DQ', 'pico:GP13', 'orange', []]] }, 'temp1: DQ is connected to several GPIOs (GP13, GP15)'],
  ];
  for (const [name, diagram, warning] of cases) {
    test(name, () => {
      const system = new CircuitSystem(diagram, null);
      assert.deepEqual(system.warnings, [warning]);
    });
  }

  test('wire ends with an unknown pin or part are named', () => {
    assert.deepEqual(new CircuitSystem(rewire('pico:GP5', 'pico:GP99'), null).warnings, [
      'connection 5 (sd1:CS - pico:GP99): pico has no pin "GP99"',
      'sd1: CS is not connected to a GPIO',
    ]);
    assert.deepEqual(new CircuitSystem(rewire('sd1:CS', 'sdX:CS'), null).warnings, [
      'connection 5 (sdX:CS - pico:GP5): there is no part "sdX"',
      'sd1: CS is not connected to a GPIO',
    ]);
  });

  test("Wokwi's virtual $serialMonitor wires are not typos", () => {
    const d = projectDiagram();
    d.connections.push(['pico:GP0', '$serialMonitor:RX', '', []], ['pico:GP1', '$serialMonitor:TX', '', []]);
    assert.deepEqual(new CircuitSystem(d, null).warnings, []);
  });

  test('a part on a GPIO that is already taken is not attached', () => {
    const system = new CircuitSystem(rewire('pico:GP5', 'pico:GP15'), null);
    assert.deepEqual(system.pinsOf('sd1'), { SCK: 2, DI: 3, DO: 4, CS: 15, spi: 0 });
    assert.equal(system.pinsOf('temp1'), undefined);
  });

  test('a pull-up resistor is not a power wire', () => {
    // DS18B20 VCC fed through a resistor (r9) only; the DQ pull-up r2 still goes to 3V3.
    const d = rewire('temp1:VCC', '');
    d.parts.push({ type: 'wokwi-resistor', id: 'r9', top: 0, left: 0 });
    d.connections.push(['r2:2', 'pico:3V3', 'red', []], ['temp1:VCC', 'r9:1', 'red', []], ['r9:2', 'pico:3V3', 'red', []]);
    const system = new CircuitSystem(d, null);
    assert.deepEqual(system.warnings, ['temp1: VCC must connect to 3V3 or VSYS or VBUS']);
  });
});

describe('nets on real MicroPython', () => {
  // GP10: pull-down resistor to GND, internal pull-up -> the resistor wins (reads 0).
  // GP11: pull-up resistor to 3V3, internal pull-down -> reads 1.
  // GP12: wired to nothing but a resistor to a floating pin -> internal pull decides.
  // GP17 drives LED2 through r2; GP18 drives low with a pull-up on its net: LED3 (anode on
  // 3V3 through r4, cathode on GP18 through r5) lights only while GP18 is low.
  const DIAGRAM: Diagram = {
    parts: [
      { type: 'board-pi-pico-w', id: 'pico', top: 0, left: 0 },
      { type: 'wokwi-resistor', id: 'r1', top: 0, left: 0 },
      { type: 'wokwi-resistor', id: 'r2', top: 0, left: 0 },
      { type: 'wokwi-resistor', id: 'r3', top: 0, left: 0 },
      { type: 'wokwi-resistor', id: 'r4', top: 0, left: 0 },
      { type: 'wokwi-resistor', id: 'r5', top: 0, left: 0 },
      { type: 'wokwi-resistor', id: 'r6', top: 0, left: 0 },
      { type: 'wokwi-led', id: 'led2', top: 0, left: 0 },
      { type: 'wokwi-led', id: 'led3', top: 0, left: 0 },
      { type: 'wokwi-pushbutton', id: 'btn', top: 0, left: 0 },
    ],
    connections: [
      ['pico:GP10', 'r1:1', '', []],
      ['r1:2', 'pico:GND.3', '', []],
      ['pico:GP11', 'r3:1', '', []],
      ['r3:2', 'pico:3V3', '', []],
      ['pico:GP12', 'r6:1', '', []],
      ['pico:GP17', 'r2:1', '', []],
      ['r2:2', 'led2:A', '', []],
      ['led2:C', 'pico:GND.5', '', []],
      ['pico:3V3', 'r4:1', '', []],
      ['r4:2', 'led3:A', '', []],
      ['led3:C', 'r5:1', '', []],
      ['r5:2', 'pico:GP18', '', []],
      // button between GP11 and GND: pressed, the wire beats the pull-up resistor
      ['btn:1.l', 'pico:GP11', '', []],
      ['btn:2.l', 'pico:GND.6', '', []],
    ],
  };
  const MAIN = `
from machine import Pin
a = Pin(10, Pin.IN, Pin.PULL_UP)
b = Pin(11, Pin.IN, Pin.PULL_DOWN)
c = Pin(12, Pin.IN, Pin.PULL_DOWN)
d = Pin(12, Pin.IN, Pin.PULL_UP)
led2 = Pin(17, Pin.OUT, value=0)
gp18 = Pin(18, Pin.OUT, value=1)
def show():
    print('=>', a.value(), b.value(), Pin(12, Pin.IN, Pin.PULL_DOWN).value(), Pin(12, Pin.IN, Pin.PULL_UP).value())
show()
`;

  test('pull resistors, buttons and LED current paths', async () => {
    const board = await bootBoard([{ name: 'main.py', content: MAIN }]);
    const system = new CircuitSystem(DIAGRAM, board);
    board.runUntilOutput('=> ', 3000);
    board.runFor(100);
    assert.match(board.output, /=> 0 1 0 1/);
    assert.equal(system.leds.get('led2'), false);
    assert.equal(system.leds.get('led3'), false, 'GP18 high: no current through LED3');

    const ask = (cmd: string) => {
      const from = board.output.length;
      board.send(`${cmd}\r`);
      board.runFor(200);
      return board.output.slice(from);
    };
    board.send('\x03');
    board.runUntilOutput('>>> ', 2000);
    ask('led2.value(1); gp18.value(0)');
    assert.equal(system.leds.get('led2'), true, 'GP17 high -> r2 -> LED2 -> GND');
    assert.equal(system.leds.get('led3'), true, '3V3 -> r4 -> LED3 -> r5 -> GP18 low');

    system.press('btn');
    assert.match(ask('show()'), /=> 0 0 0 1/, 'pressed button pulls GP11 to GND despite the pull-up');
    system.release('btn');
    assert.match(ask('show()'), /=> 0 1 0 1/);

    system.detach();
    assert.equal(system.leds.get('led2'), false, 'no board, no power');
  });
});

describe('the cold-chain project with all parts', () => {
  test('alarm, LED, button acknowledge, daily summary at midnight, CSV files on the card', async () => {
    const { board, system } = await bootSystem({ temperatures: { temp1: 5 }, rtcTime: utc(2026, 11, 17, 23, 58, 0) });
    assert.deepEqual(system.warnings, []);
    board.runUntilOutput('[START] tipkalo', 5000);
    board.runUntilOutput('[MJERENJE]', 3000);
    assert.match(board.output, /\[SD\] kartica montirana na \/sd/);
    assert.match(board.output, /\[RTC\] sat: 2026-11-17 23:58:00/);
    assert.match(board.output, /\[SENZOR\] pronaden DS18B20 \(2801005e1d0000be\)/);
    assert.match(board.output, /\[MJERENJE\] 2026-11-17 23:58:0\d \| 5\.00 C \| U_RASPONU/);

    system.setTemperature('temp1', 10);
    board.runUntilOutput('[ALARM] ', 150_000);
    board.runFor(100);
    assert.equal(system.leds.get('led1'), true, 'LED lit during the alarm');
    assert.match(board.output, /\[DNEVNI SAZETAK\] 2026-11-17: mjerenja \d+, min 5\.00 C, max 10\.00 C/);
    assert.match(board.output, /\[MJERENJE\] 2026-11-18 00:00:0\d \| 10\.00 C \| ODBROJAVANJE/);

    // The button acknowledges; readings on GP15 keep working while GP14 changes
    // (the DS18B20 model owns GP15, the generic input logic must not touch it).
    let from = board.output.length;
    press(board, system);
    board.runFor(500);
    assert.match(board.output.slice(from), /\[POTVRDA\] alarm potvrden/);
    assert.equal(system.leds.get('led1'), false, 'LED off after acknowledge');
    from = board.output.length;
    for (let i = 0; i < 3; i++) {
      press(board, system, 'btn1', 250);
      board.runFor(4000);
    }
    const during = board.output.slice(from);
    assert.equal((during.match(/\[MJERENJE\] \S+ \S+ \| 10\.00 C \| ALARM/g) ?? []).length >= 1, true, during);
    assert.ok(!during.includes('greska'), during);

    system.setTemperature('temp1', 5);
    board.runUntilOutput('[ALARM KRAJ]', 30_000);
    assert.ok(!board.output.includes('Traceback'), board.output);

    const card = system.sdCards.get('sd1')!;
    const csv = card.readText('hladnjaca.csv')!;
    assert.match(csv, /^datum_vrijeme,temperatura_c,stanje\n2026-11-17 23:58:0\d,5\.00,U_RASPONU\n/);
    assert.match(csv, /\n2026-11-18 00:0\d:\d\d,10\.00,ALARM\n/);
    assert.match(card.readText('sazetak.csv')!, /^datum,broj_mjerenja,.*\n2026-11-17,\d+,5\.00,10\.00,/);
    assert.deepEqual(system.cardFiles('sd1').map((f) => f.name).sort(), ['hladnjaca.csv', 'sazetak.csv']);
  });

  test('the generic pin logic never overwrites the DS18B20 line (DQ is owned by the model)', async () => {
    const { board, system } = await bootSystem();
    board.runUntilOutput('[RTC] sat', 5000);
    const sensor = system.sensors.get('temp1')!;
    const dq = board.pin(15);
    // Stop while the sensor holds the line low (presence pulse or a 0 bit), the master released.
    const sensorOnly = () => sensor.pulling && dq.value !== GPIOPinState.Low;
    assert.ok(board.runUntil(sensorOnly, 2000, 0.005), 'sensor never held DQ low on its own');
    assert.equal(dq.inputValue, false);
    system.press('btn1'); // recomputes every generic input; GP15's net has a pull-up to 3V3
    assert.equal(dq.inputValue, false, 'button press must not release the DS18B20 line');
    system.release('btn1');
    assert.equal(dq.inputValue, false);
  });

  test('the card keeps its files across runs; pulling it out is reported', async () => {
    const { board, system } = await bootSystem();
    board.runUntilOutput('[START] tipkalo', 5000);
    board.runFor(12_000); // two measurements
    system.detach();
    assert.equal(system.sdCards.size, 0);
    assert.match(system.cardFiles('sd1').find((f) => f.name === 'hladnjaca.csv') ? 'ok' : '', /ok/, 'files readable after Stop');

    const board2 = await bootBoard(projectFiles());
    system.attach(board2);
    board2.runUntilOutput('[START] tipkalo', 5000);
    assert.match(board2.output, /\[SD\] \/sd\/hladnjaca\.csv postoji, 2 redaka mjerenja/);

    system.setCardInserted('sd1', false);
    board2.runUntilOutput('[SD] greska pri zapisu', 15_000);
    system.setCardInserted('sd1', true);
    assert.ok(!board2.output.includes('Traceback'), board2.output);
  });

  test('settings made before attach are the initial conditions', async () => {
    const system = new CircuitSystem(projectDiagram(), null);
    system.setTemperature('temp1', -18.5);
    system.setRtcTime('rtc1', utc(2030, 1, 2, 3, 4, 5));
    assert.equal(system.temperature('temp1'), -18.5);
    const board = await bootBoard(projectFiles());
    system.attach(board);
    board.runUntilOutput('[MJERENJE]', 8000);
    board.runFor(50);
    assert.match(board.output, /\[RTC\] sat: 2030-01-02 03:04:0\d/);
    assert.match(board.output, /\[MJERENJE\] 2030-01-02 03:04:\d\d \| -18\.50 C \| ODBROJAVANJE/);
  });

  test('a disconnected sensor is reported and comes back', async () => {
    const { board, system } = await bootSystem();
    system.setSensorConnected('temp1', false);
    board.runUntilOutput('[START] tipkalo', 5000);
    assert.match(board.output, /\[SENZOR\] DS18B20 nije pronaden na GP15/);
    system.setSensorConnected('temp1', true);
    board.runUntilOutput('[SENZOR] pronaden DS18B20', 15_000);
    board.runUntilOutput('| 4.50 C |', 15_000);
  });

  test('miswired parts are not attached and the program says so', async () => {
    const diagram = rewire('pico:GP4', 'pico:GP6', withoutPullUp());
    const { board, system } = await bootSystem({ diagram });
    assert.deepEqual([...system.warnings].sort(), [
      'sd1: DO must connect to an SPI RX pin (GP0/4/16/20 for SPI0)',
      'temp1: DQ needs a pull-up resistor (4.7 kΩ) to 3V3',
    ]);
    assert.equal(system.sensors.size, 0);
    assert.equal(system.sdCards.size, 0);
    assert.equal(system.rtcs.size, 1);
    board.runUntilOutput('[START] tipkalo', 5000);
    assert.match(board.output, /\[SD\] kartica nije dostupna/);
    assert.match(board.output, /\[SENZOR\] DS18B20 nije pronaden na GP15/);
    assert.match(board.output, /\[RTC\] sat: 2026-11-17 10:00:00/);
  });
});
