// The simulator itself: MicroPython boots, runs main.py, keeps time, takes serial input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootBoard } from './helpers.js';

const BLINK = `
from machine import Pin
import time
led = Pin(16, Pin.OUT)
print("ready")
while True:
    led.toggle()
    time.sleep_ms(500)
`;

for (const firmware of ['RPI_PICO-20231227-v1.22.0.uf2', 'RPI_PICO_W-20231227-v1.22.0.uf2']) {
  test(`boots and runs main.py (${firmware})`, async () => {
    const board = await bootBoard([{ name: 'main.py', content: BLINK }], firmware);
    let toggles = 0;
    board.pin(16).addListener((s, o) => {
      if ((s === 0 || s === 1) && (o === 0 || o === 1)) toggles++;
    });
    board.runUntilOutput('ready', 2000);
    const t0 = board.simMs;
    board.runFor(5000);
    assert.ok(board.simMs - t0 >= 5000);
    // 500 ms period: ~10 toggles in 5 s of simulated time.
    assert.ok(toggles >= 9 && toggles <= 11, `toggles=${toggles}`);
    // Serial input reaches the REPL.
    board.send('\x03');
    board.runUntilOutput('>>> ', 1000);
    board.send('print(6*7)\r');
    board.runUntilOutput('42', 1000);
  });
}
