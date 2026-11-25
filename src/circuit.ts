// Draws project/diagram.json (Wokwi's format) and simulates the wiring:
// which net each pin is on, what drives it, whether an LED lights up,
// and what a GPIO input reads when a button is pressed.

import '@wokwi/elements/dist/esm/led-element.js';
import '@wokwi/elements/dist/esm/pushbutton-element.js';
import '@wokwi/elements/dist/esm/resistor-element.js';
import { GPIOPinState } from 'rp2040js';
import type { Board } from './board.js';
import { PICO_HEIGHT, PICO_PINS, PICO_WIDTH, picoSvg } from './pico-svg.js';

export interface DiagramPart {
  type: string;
  id: string;
  top: number;
  left: number;
  attrs?: Record<string, string>;
}
/** [from "part:pin", to "part:pin", color, waypoints like "h-19.2" / "v48"] */
export type DiagramConnection = [string, string, string, string[]?];
export interface Diagram {
  parts: DiagramPart[];
  connections: DiagramConnection[];
}

interface Pin {
  name: string;
  x: number;
  y: number;
}

interface PlacedPart {
  part: DiagramPart;
  el: HTMLElement & { pinInfo?: Pin[]; value?: unknown; pressed?: boolean };
  pins: Pin[];
}

const BOARD_TYPES = new Set(['board-pi-pico', 'board-pi-pico-w']);
const MARGIN = 28;

export class Circuit {
  private parts = new Map<string, PlacedPart>();
  private boardId = '';
  private board: Board | null = null;
  private unlisten: (() => void)[] = [];
  private pressed = new Set<string>();

  constructor(
    private readonly stage: HTMLElement,
    private readonly diagram: Diagram,
  ) {
    this.render();
    new ResizeObserver(() => this.fit()).observe(stage);
  }

  get supported() {
    return [...this.parts.values()].map((p) => p.part.type);
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
      placed.el.style.left = `${part.left}px`;
      placed.el.style.top = `${part.top}px`;
      placed.el.classList.add('part');
      placed.el.title = `${part.id} (${part.type})`;
      world.append(placed.el);
      this.parts.set(part.id, placed);
    }

    this.stage.replaceChildren(world);
    this.drawWires(wires);
    this.fit();
  }

  private createPart(part: DiagramPart): PlacedPart | null {
    const attrs = part.attrs ?? {};
    if (BOARD_TYPES.has(part.type)) {
      this.boardId = part.id;
      const el = document.createElement('div');
      el.innerHTML = picoSvg(part.type.endsWith('-w'));
      el.style.width = `${PICO_WIDTH}px`;
      el.style.height = `${PICO_HEIGHT}px`;
      return { part, el, pins: PICO_PINS };
    }
    const tag = { 'wokwi-led': 'wokwi-led', 'wokwi-resistor': 'wokwi-resistor', 'wokwi-pushbutton': 'wokwi-pushbutton' }[
      part.type
    ];
    if (!tag) {
      console.warn(`diagram.json: part type ${part.type} is not supported yet`);
      return null;
    }
    const el = document.createElement(tag) as PlacedPart['el'];
    if (attrs.color) el.setAttribute('color', attrs.color);
    if (attrs.value) el.setAttribute('value', attrs.value);
    if (attrs.flip === '1') el.setAttribute('flip', '');
    if (attrs.label) el.setAttribute('label', attrs.label);
    if (part.type === 'wokwi-pushbutton') {
      el.addEventListener('button-press', () => this.setPressed(part.id, true));
      el.addEventListener('button-release', () => this.setPressed(part.id, false));
    }
    return { part, el, pins: el.pinInfo ?? [] };
  }

  private pinPos(ref: string): { x: number; y: number } | null {
    const [id, name] = ref.split(':');
    const placed = this.parts.get(id);
    const pin = placed?.pins.find((p) => p.name === name);
    if (!placed || !pin) return null;
    return { x: placed.part.left + pin.x, y: placed.part.top + pin.y };
  }

  private drawWires(svg: SVGSVGElement) {
    const dots: string[] = [];
    const paths: string[] = [];
    for (const [from, to, color, waypoints = []] of this.diagram.connections) {
      const a = this.pinPos(from);
      const b = this.pinPos(to);
      if (!a || !b) continue; // e.g. the virtual $serialMonitor
      const pts = [a];
      let { x, y } = a;
      for (const w of waypoints) {
        const n = Number(w.slice(1));
        if (Number.isNaN(n)) continue;
        if (w[0] === 'h') x += n;
        else if (w[0] === 'v') y += n;
        pts.push({ x, y });
      }
      pts.push({ x: b.x, y }, b); // finish horizontally, then vertically
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
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
      grow(part.left, part.top);
      grow(part.left + el.offsetWidth, part.top + el.offsetHeight);
    }
    const w = maxX - minX + 2 * MARGIN;
    const h = maxY - minY + 2 * MARGIN;
    const scale = Math.min(this.stage.clientWidth / w, this.stage.clientHeight / h, 3);
    const offX = (this.stage.clientWidth - (maxX - minX) * scale) / 2 - minX * scale;
    const offY = (this.stage.clientHeight - (maxY - minY) * scale) / 2 - minY * scale;
    world.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`;
  }

  // ---------- electrical behaviour ----------

  attach(board: Board) {
    this.detach();
    this.board = board;
    for (const ref of this.boardPinsInUse()) {
      const gp = gpioIndex(ref);
      if (gp !== null) this.unlisten.push(board.pin(gp).addListener(() => this.update()));
    }
    this.update();
  }

  detach() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    this.board = null;
    this.update();
  }

  private setPressed(id: string, down: boolean) {
    if (down) this.pressed.add(id);
    else this.pressed.delete(id);
    this.update();
  }

  private boardPinsInUse() {
    const prefix = `${this.boardId}:`;
    const refs = new Set<string>();
    for (const [a, b] of this.diagram.connections) {
      if (a.startsWith(prefix)) refs.add(a.slice(prefix.length));
      if (b.startsWith(prefix)) refs.add(b.slice(prefix.length));
    }
    return refs;
  }

  /** Group connected pins into nets (union-find); resistors conduct, buttons only when pressed. */
  private nets() {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      const p = parent.get(x)!;
      if (p === x) return x;
      const r = find(p);
      parent.set(x, r);
      return r;
    };
    const join = (a: string, b: string) => parent.set(find(a), find(b));

    for (const [a, b] of this.diagram.connections) join(a, b);
    for (const { part } of this.parts.values()) {
      const id = part.id;
      if (part.type === 'wokwi-resistor') join(`${id}:1`, `${id}:2`);
      if (part.type === 'wokwi-pushbutton') {
        join(`${id}:1.l`, `${id}:1.r`);
        join(`${id}:2.l`, `${id}:2.r`);
        if (this.pressed.has(id)) join(`${id}:1.l`, `${id}:2.l`);
      }
    }
    // All GND pins of the board are one net, as are the 3V3 pins.
    for (const p of PICO_PINS) {
      if (p.name.startsWith('GND')) join(`${this.boardId}:${p.name}`, `${this.boardId}:GND`);
    }
    return find;
  }

  /** What drives a net: 'high', 'low' or null (floating). */
  private driver(net: string, find: (x: string) => string): 'high' | 'low' | null {
    const board = this.board;
    for (const p of PICO_PINS) {
      const ref = `${this.boardId}:${p.name}`;
      if (find(ref) !== net) continue;
      if (p.name.startsWith('GND')) return 'low';
      if (p.name === '3V3' || p.name === 'VSYS' || p.name === 'VBUS') return board ? 'high' : null;
      const gp = gpioIndex(p.name);
      if (board && gp !== null) {
        const state = board.pin(gp).value;
        if (state === GPIOPinState.High) return 'high';
        if (state === GPIOPinState.Low) return 'low';
      }
    }
    return null;
  }

  private update() {
    const find = this.nets();
    const board = this.board;

    for (const { part, el } of this.parts.values()) {
      if (part.type === 'wokwi-led') {
        const lit =
          !!board &&
          this.driver(find(`${part.id}:A`), find) === 'high' &&
          this.driver(find(`${part.id}:C`), find) === 'low';
        el.value = lit;
      }
    }

    if (!board) return;
    for (const ref of this.boardPinsInUse()) {
      const gp = gpioIndex(ref);
      if (gp === null) continue;
      const pin = board.pin(gp);
      const state = pin.value;
      if (state === GPIOPinState.High || state === GPIOPinState.Low) continue; // an output
      // Look for something else driving this pin's net.
      const net = find(`${this.boardId}:${ref}`);
      let level: boolean | null = null;
      for (const p of PICO_PINS) {
        if (p.name === ref || find(`${this.boardId}:${p.name}`) !== net) continue;
        if (p.name.startsWith('GND')) level = false;
        else if (p.name === '3V3') level = true;
      }
      const value = level ?? state !== GPIOPinState.InputPullDown;
      if (pin.inputValue !== value) pin.setInputValue(value);
    }
  }
}

function gpioIndex(name: string): number | null {
  const m = /^GP(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}
