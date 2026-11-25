# Proof-of-concept program for pico-sim.
# Pins follow the group plan: LED on GP16, button on GP14 (to GND, pull-up).
from machine import Pin
import time

led = Pin(16, Pin.OUT)
button = Pin(14, Pin.IN, Pin.PULL_UP)

print("pico-sim POC: main.py is running")

last_button = button.value()
next_blink = time.ticks_ms()
blinks = 0

while True:
    now = time.ticks_ms()
    if time.ticks_diff(now, next_blink) >= 0:
        next_blink = time.ticks_add(next_blink, 500)
        led.toggle()
        blinks += 1
        if blinks % 4 == 0:
            print("blink", blinks, "at", now, "ms")

    state = button.value()
    if state != last_button:
        last_button = state
        print("button", "pressed" if state == 0 else "released")

    time.sleep_ms(10)
