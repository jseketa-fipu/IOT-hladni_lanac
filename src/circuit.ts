// Draws project/diagram.json (Wokwi's format) and lets you interact with it: click the
// button, watch the LED. All electrical behaviour (nets, LEDs, inputs, part models) lives
// in CircuitSystem (src/system.ts); this file only renders it and forwards mouse input.
//
// Parts: the Pico (src/pico-svg.ts), a DS18B20 drawn here (TO-92, @wokwi/elements has
// none), and wokwi-led, wokwi-resistor, wokwi-pushbutton, wokwi-microsd-card and
// wokwi-ds1307 from @wokwi/elements. Wokwi's "rotate" (90/180/270) is supported; a
// part whose wiring CircuitSystem rejected gets a warning outline and its reason as tooltip.

import '@wokwi/elements/dist/esm/ds1307-element.js';
import { reportedTemperature } from './devices/ds18b20.js';
import '@wokwi/elements/dist/esm/led-element.js';
import '@wokwi/elements/dist/esm/microsd-card-element.js';
import '@wokwi/elements/dist/esm/pushbutton-element.js';
import '@wokwi/elements/dist/esm/resistor-element.js';
import type { Board } from './board.js';
import { PICO_HEIGHT, PICO_PINS, PICO_WIDTH, picoSvg } from './pico-svg.js';
import { BOARD_TYPES, CircuitSystem, type Diagram, type DiagramPart, type SystemOptions } from './system.js';

export type { Diagram } from './system.js';

interface Pin {
  name: string;
  x: number;
  y: number;
}

type PartElement = HTMLElement & { pinInfo?: Pin[]; value?: unknown; pressed?: boolean; updateComplete?: Promise<unknown> };

interface PlacedPart {
  part: DiagramPart;
  el: PartElement;
  /** Pin positions in the part's own (unrotated) coordinates. */
  pins: Pin[];
}

const WOKWI_TAGS: Record<string, string> = {
  'wokwi-led': 'wokwi-led',
  'wokwi-resistor': 'wokwi-resistor',
  'wokwi-pushbutton': 'wokwi-pushbutton',
  'wokwi-microsd-card': 'wokwi-microsd-card',
  'wokwi-ds1307': 'wokwi-ds1307',
};
const MARGIN = 28;
/** Parts with settings in the Parts panel (clicking them in the circuit selects their card). */
const SETTABLE = new Set(['wokwi-ds18b20', 'wokwi-microsd-card', 'wokwi-ds1307']);

// DS18B20 in a TO-92 package, seen from the flat (printed) side; legs GND, DQ, VCC
// 2.54 mm (9.6 px) apart, like Wokwi's part. Pins are at the leg ends.
const DS18B20_WIDTH = 28;
const DS18B20_HEIGHT = 58;
const DS18B20_PINS: Pin[] = [
  { name: 'GND', x: 4.4, y: 57 },
  { name: 'DQ', x: 14, y: 57 },
  { name: 'VCC', x: 23.6, y: 57 },
];
const DS18B20_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${DS18B20_WIDTH}" height="${DS18B20_HEIGHT}" viewBox="0 0 ${DS18B20_WIDTH} ${DS18B20_HEIGHT}">
    ${DS18B20_PINS.map((p) => `<path d="M${14 + (p.x - 14) * 0.45} 24 L${p.x} 31 V${p.y}" fill="none" stroke="#b9bec5" stroke-width="1.6" stroke-linecap="round"/>`).join('')}
    <path class="ds18b20-body" d="M2 26 V10 A12 10 0 0 1 26 10 V26 Z" fill="#232323" stroke="#0e0e0e" stroke-width="0.6"/>
    <text x="14" y="15" text-anchor="middle" class="ds18b20-name">DS18B20</text>
    ${DS18B20_PINS.map((p) => `<text x="${p.x + (14 - p.x) * 0.25}" y="23" text-anchor="middle" class="ds18b20-pin">${p.name}</text>`).join('')}
  </svg>`;

export class Circuit {
  readonly system: CircuitSystem;
  private parts = new Map<string, PlacedPart>();
  private readonly resize: ResizeObserver;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly stage: HTMLElement,
    private readonly diagram: Diagram,
    options: SystemOptions = {},
  ) {
    this.system = new CircuitSystem(diagram, null, options);
    this.render();
    this.unsubscribe = this.system.onChange((c) => {
      if (c.kind === 'leds' || c.kind === 'devices') this.showLeds();
      if (c.kind === 'settings' || c.kind === 'devices') this.showTemperatures();
    });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(stage);
  }

  /** Power the parts from `board` (call before board.start()). */
  attach(board: Board) {
    this.system.attach(board);
  }

  detach() {
    this.system.detach();
  }

  /** Detach and stop reacting to the page (before drawing a new diagram). */
  dispose() {
    this.system.detach();
    this.unsubscribe();
    this.resize.disconnect();
  }

  // ---------- drawing ----------

  private render() {
    const world = document.createElement('div');
    world.className = 'world';
    const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wires.classList.add('wires');
    world.append(wires);

    for (const part of this.diagram.parts) {
      const placed = this.createPart(part);
      if (!placed) continue;
      const { el } = placed;
      el.style.left = `${part.left}px`;
      el.style.top = `${part.top}px`;
      if (part.rotate) el.style.transform = `rotate(${part.rotate}deg)`;
      el.classList.add('part');
      el.dataset.part = part.id;
      const problems = this.system.warnings.filter((w) => w.startsWith(`${part.id}:`));
      el.title = [`${part.id} (${part.type})`, ...problems].join('\n');
      if (problems.length) el.classList.add('part-warn');
      this.addAffordance(part, el, problems.length > 0);
      world.append(el);
      this.parts.set(part.id, placed);
    }

    this.stage.replaceChildren(world);
    // Wokwi elements render asynchronously; sizes (for rotation and zoom) are known after that.
    const ready = [...this.parts.values()].map((p) => p.el.updateComplete ?? Promise.resolve());
    Promise.all(ready).then(() => {
      this.drawWires(wires);
      this.fit();
    });
    this.showLeds();
    this.showTemperatures();
  }

  /**
   * Make it visible what can be clicked: the pushbutton is pressed with the mouse; a sensor,
   * card or clock opens its settings in the Parts panel (the page listens for 'part-select').
   */
  private addAffordance(part: DiagramPart, el: PartElement, miswired: boolean) {
    if (part.type === 'wokwi-pushbutton') {
      el.classList.add('pressable');
      if (!miswired) el.title = `${part.id}: click and hold to press`;
      return;
    }
    if (!SETTABLE.has(part.type)) return;
    el.classList.add('selectable');
    if (!miswired) el.title = `${part.id}: click to change it in the Parts panel`;
    el.addEventListener('click', () =>
      this.stage.dispatchEvent(new CustomEvent('part-select', { detail: part.id, bubbles: true })),
    );
    if (part.type === 'wokwi-ds18b20') {
      // The temperature the sensor sees, shown above it and kept in sync with the Parts panel.
      const tag = document.createElement('span');
      tag.className = 'temp-tag';
      el.append(tag);
    }
  }

  private showTemperatures() {
    for (const id of this.system.sensorIds) {
      const tag = this.parts.get(id)?.el.querySelector('.temp-tag');
      if (!tag) continue;
      const on = this.system.sensorConnected(id);
      // What the sensor reports (1/16 C steps), same digits as the serial monitor.
      tag.textContent = on ? `${reportedTemperature(this.system.temperature(id)).toFixed(2)} °C` : 'unplugged';
      tag.classList.toggle('off', !on);
    }
  }

  private createPart(part: DiagramPart): PlacedPart | null {
    const attrs = part.attrs ?? {};
    if (BOARD_TYPES.has(part.type)) {
      const el = document.createElement('div');
      el.innerHTML = picoSvg(part.type.endsWith('-w'));
      el.style.width = `${PICO_WIDTH}px`;
      el.style.height = `${PICO_HEIGHT}px`;
      return { part, el, pins: PICO_PINS };
    }
    if (part.type === 'wokwi-ds18b20') {
      const el = document.createElement('div');
      el.innerHTML = DS18B20_SVG;
      el.style.width = `${DS18B20_WIDTH}px`;
      el.style.height = `${DS18B20_HEIGHT}px`;
      return { part, el, pins: DS18B20_PINS };
    }
    const tag = WOKWI_TAGS[part.type];
    if (!tag) {
      console.warn(`diagram.json: part type ${part.type} is not supported yet`);
      return null;
    }
    const el = document.createElement(tag) as PartElement;
    if (attrs.color) el.setAttribute('color', attrs.color);
    if (attrs.value) el.setAttribute('value', attrs.value);
    if (attrs.flip === '1') el.setAttribute('flip', '');
    if (attrs.label) el.setAttribute('label', attrs.label);
    if (part.type === 'wokwi-pushbutton') {
      el.addEventListener('button-press', () => this.system.press(part.id));
      el.addEventListener('button-release', () => this.system.release(part.id));
    }
    return { part, el, pins: el.pinInfo ?? [] };
  }

  private showLeds() {
    for (const [id, lit] of this.system.leds) {
      const el = this.parts.get(id)?.el;
      if (el) el.value = lit;
    }
  }

  /** A pin's position in diagram coordinates, with the part's rotation applied. */
  private pinPos(ref: string): { x: number; y: number } | null {
    const [id, name] = ref.split(':');
    const placed = this.parts.get(id);
    const pin = placed?.pins.find((p) => p.name === name);
    if (!placed || !pin) return null;
    const { x, y } = rotatePoint(pin, placed.el, placed.part.rotate ?? 0);
    return { x: placed.part.left + x, y: placed.part.top + y };
  }

  private drawWires(svg: SVGSVGElement) {
    const dots: string[] = [];
    const paths: string[] = [];
    for (const [from, to, color, waypoints = []] of this.diagram.connections) {
      const a = this.pinPos(from);
      const b = this.pinPos(to);
      if (!a || !b) continue; // e.g. the virtual $serialMonitor
      const d = wirePoints(a, b, waypoints)
        .map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ');
      const stroke = color && color !== '' ? color : '#888';
      paths.push(`<path d="${d}" class="wire-shadow"/><path d="${d}" class="wire" stroke="${stroke}"/>`);
      dots.push(`<circle cx="${a.x}" cy="${a.y}" r="2.2" class="wire-end"/>`, `<circle cx="${b.x}" cy="${b.y}" r="2.2" class="wire-end"/>`);
    }
    svg.innerHTML = paths.join('') + dots.join('');
  }

  /** Scale the diagram to fit the stage, like Wokwi's "zoom to fit". */
  fit() {
    const world = this.stage.querySelector<HTMLElement>('.world');
    if (!world || !this.parts.size) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    for (const { part, el } of this.parts.values()) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      for (const corner of [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }]) {
        const p = rotatePoint(corner, el, part.rotate ?? 0);
        grow(part.left + p.x, part.top + p.y);
      }
    }
    // Wires may run outside the parts (waypoints): include them.
    for (const [from, to, , waypoints = []] of this.diagram.connections) {
      const a = this.pinPos(from);
      const b = this.pinPos(to);
      if (a && b) for (const p of wirePoints(a, b, waypoints)) grow(p.x, p.y);
    }
    const w = maxX - minX + 2 * MARGIN;
    const h = maxY - minY + 2 * MARGIN;
    // Narrow screens size the stage from the diagram's shape (style.css), so it isn't a
    // tall box with a small drawing in the middle.
    this.stage.style.setProperty('--diagram-aspect', (w / h).toFixed(3));
    const scale = Math.min(this.stage.clientWidth / w, this.stage.clientHeight / h, 3);
    const offX = (this.stage.clientWidth - (maxX - minX) * scale) / 2 - minX * scale;
    const offY = (this.stage.clientHeight - (maxY - minY) * scale) / 2 - minY * scale;
    world.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`;
  }
}

/** Wokwi's wire routing: waypoints "h<dx>" / "v<dy>" from the start, then horizontally, then vertically to the end. */
export function wirePoints(a: { x: number; y: number }, b: { x: number; y: number }, waypoints: string[]) {
  const pts = [a];
  let { x, y } = a;
  for (const w of waypoints) {
    const n = Number(w.slice(1));
    if (Number.isNaN(n)) continue;
    if (w[0] === 'h') x += n;
    else if (w[0] === 'v') y += n;
    pts.push({ x, y });
  }
  pts.push({ x: b.x, y }, b);
  return pts;
}

/** Rotate a point of an element by `deg` (clockwise) around the element's centre, as CSS rotate() does. */
function rotatePoint(p: { x: number; y: number }, el: HTMLElement, deg: number) {
  if (!deg) return p;
  const cx = el.offsetWidth / 2;
  const cy = el.offsetHeight / 2;
  const r = (deg * Math.PI) / 180;
  const cos = Math.round(Math.cos(r) * 1e6) / 1e6;
  const sin = Math.round(Math.sin(r) * 1e6) / 1e6;
  return { x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos };
}
