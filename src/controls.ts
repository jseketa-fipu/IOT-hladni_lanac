// The "Parts" panel next to the circuit: one card per simulated part, generated from the
// parts in diagram.json, to set what the sensors see and look at what the program wrote.
//   DS18B20  temperature slider (-20..40 C) + number box (-55..125 C), "connected"
//   microSD  "inserted", erase, live file list with view / download
//   DS1307   current RTC date/time, set it, jump to 23:58:00 (daily summary at midnight)
// Everything goes through CircuitSystem's settings, so it works before Run (initial
// conditions) and while running. Wiring warnings are listed at the top.

import type { FatFile } from './devices/fat.js';
import { reportedTemperature } from './devices/ds18b20.js';
import type { CircuitSystem } from './system.js';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) => {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  el.append(...children);
  return el;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-17 23:58:00" from a Date whose UTC fields are the clock fields. */
const rtcText = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
/** 4.5 -> '4.5', 8.05 -> '8.05', 8.0625 -> '8.06': the user's number, without float noise. */
const trimmed = (t: number) => String(Number(t.toFixed(2)));

const sizeText = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** Shows one file of an SD card in a dialog and keeps it current while the program writes. */
export class FileViewer {
  private current: { system: CircuitSystem; card: string; name: string } | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly title: HTMLElement,
    private readonly body: HTMLElement,
    download: HTMLButtonElement,
  ) {
    dialog.addEventListener('close', () => (this.current = null));
    download.onclick = () => {
      const file = this.file();
      if (file) downloadFile(file);
    };
  }

  open(system: CircuitSystem, card: string, name: string) {
    this.current = { system, card, name };
    this.title.textContent = `${card}: ${name}`;
    this.refresh(true);
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Re-read the open file (after the card changed); stays scrolled to the end if it was there. */
  refresh(toEnd = false) {
    const file = this.file();
    if (!this.current) return;
    const atEnd = toEnd || this.body.scrollTop + this.body.clientHeight >= this.body.scrollHeight - 4;
    this.body.textContent = file ? new TextDecoder().decode(file.data) : '(file no longer on the card)';
    if (atEnd) this.body.scrollTop = this.body.scrollHeight;
  }

  isShowing(system: CircuitSystem, card: string) {
    return this.current?.system === system && this.current.card === card;
  }

  private file(): FatFile | undefined {
    if (!this.current) return;
    const { system, card, name } = this.current;
    return safeFiles(system, card)?.find((f) => f.name === name);
  }
}

function downloadFile(file: FatFile) {
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: 'text/plain' }));
  const a = h('a', { href: url, download: file.name.split('/').pop()! });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The card's files, or null while the FAT is half written (try again on the next refresh). */
function safeFiles(system: CircuitSystem, card: string): FatFile[] | null {
  try {
    return system.cardFiles(card);
  } catch {
    return null;
  }
}

export class Controls {
  private readonly timers: number[] = [];
  private readonly unsubscribe: () => void;
  private readonly sync: (() => void)[] = [];
  private readonly dirtyCards = new Set<string>();
  private readonly cardLists = new Map<string, (files: FatFile[]) => void>();

  constructor(
    private readonly container: HTMLElement,
    private readonly system: CircuitSystem,
    private readonly viewer: FileViewer,
  ) {
    this.render();
    this.unsubscribe = system.onChange((c) => {
      if (c.kind === 'card') this.dirtyCards.add(c.id);
      if (c.kind === 'devices') {
        for (const id of system.cardIds) this.dirtyCards.add(id);
        this.sync.forEach((s) => s());
      }
      if (c.kind === 'settings') this.sync.forEach((s) => s());
    });
    // The card writes block by block: refresh the file lists at most twice a second.
    this.timers.push(
      window.setInterval(() => {
        for (const id of this.dirtyCards) {
          const files = safeFiles(system, id);
          if (!files) continue;
          this.dirtyCards.delete(id);
          this.cardLists.get(id)?.(files);
          if (this.viewer.isShowing(system, id)) this.viewer.refresh();
        }
      }, 500),
    );
  }

  dispose() {
    this.timers.forEach((t) => clearInterval(t));
    this.unsubscribe();
  }

  private render() {
    const s = this.system;
    const cards: HTMLElement[] = [];
    if (s.warnings.length) {
      cards.push(
        h(
          'div',
          { class: 'warnings', role: 'alert' },
          h('strong', {}, 'Not simulated (wiring):'),
          h('ul', {}, ...s.warnings.map((w) => h('li', {}, w))),
        ),
      );
    }
    for (const id of s.sensorIds) cards.push(this.sensorCard(id));
    for (const id of s.rtcIds) cards.push(this.rtcCard(id));
    for (const id of s.cardIds) cards.push(this.sdCard(id));
    if (!cards.length) cards.push(h('p', { class: 'muted' }, 'No DS18B20, microSD or DS1307 in diagram.json.'));
    this.container.replaceChildren(...cards);
    for (const id of s.cardIds) this.dirtyCards.add(id);
  }

  private head(id: string, kind: string, where: string) {
    const ok = !!this.system.pinsOf(id);
    return h(
      'header',
      {},
      h('span', { class: 'part-id' }, id),
      h('span', { class: 'part-kind' }, kind),
      h('span', { class: ok ? 'part-pins' : 'part-pins bad', title: ok ? '' : 'Not simulated: see the warning above' }, ok ? where : 'not wired'),
    );
  }

  private sensorCard(id: string) {
    const s = this.system;
    const pins = s.pinsOf(id);
    const slider = h('input', { type: 'range', min: '-20', max: '40', step: '0.1', ariaLabel: `${id} temperature` });
    const number = h('input', { type: 'number', min: '-55', max: '125', step: '0.1', class: 'num', ariaLabel: `${id} temperature in °C` });
    const connected = h('input', { type: 'checkbox' });
    const reports = h('div', { class: 'muted small' });
    slider.dataset.sensor = id;
    number.dataset.sensor = id;
    const show = () => {
      const t = s.temperature(id);
      if (document.activeElement !== number) number.value = trimmed(t);
      if (document.activeElement !== slider) slider.value = String(t);
      connected.checked = s.sensorConnected(id);
      // The chip measures in 1/16 C steps: say so when that changes the number (8.04 -> 8.06).
      const r = reportedTemperature(t);
      reports.textContent = r.toFixed(2) === t.toFixed(2) ? '' : `sensor reports ${r.toFixed(2)} °C (it measures in 1/16 °C steps)`;
    };
    slider.addEventListener('input', () => s.setTemperature(id, Number(slider.value)));
    number.addEventListener('change', () => {
      const v = Number(number.value);
      if (number.value !== '' && Number.isFinite(v)) s.setTemperature(id, v);
      number.value = trimmed(s.temperature(id));
    });
    connected.addEventListener('change', () => s.setSensorConnected(id, connected.checked));
    this.sync.push(show);
    show();
    return h(
      'section',
      { class: 'part-card' },
      this.head(id, 'DS18B20', pins ? `GP${pins.DQ}` : ''),
      h('div', { class: 'temp-row' }, slider, h('label', { class: 'num-wrap' }, number, h('span', {}, '°C'))),
      reports,
      h('label', { class: 'check' }, connected, ' connected'),
    );
  }

  private rtcCard(id: string) {
    const s = this.system;
    const pins = s.pinsOf(id);
    const clock = h('div', { class: 'rtc-time' });
    const note = h('div', { class: 'muted small' });
    const input = h('input', { type: 'datetime-local', step: '1', ariaLabel: `${id} new date and time` });
    const set = h('button', { textContent: 'Set', type: 'button' });
    const jump = h('button', { textContent: 'Jump to 23:58:00', type: 'button', title: 'Two minutes before midnight: watch the daily summary' });
    const error = h('div', { class: 'error small' });
    const apply = (date: Date) => {
      try {
        s.setRtcTime(id, date);
        error.textContent = '';
      } catch (e) {
        error.textContent = (e as Error).message;
      }
      tick();
    };
    set.onclick = () => {
      // datetime-local gives "2026-11-17T23:58" or "...:00": read it as clock fields (UTC).
      const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(input.value);
      if (!m) {
        error.textContent = 'Pick a date and time first';
        return;
      }
      apply(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))));
    };
    jump.onclick = () => {
      const now = s.rtcTime(id);
      apply(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 58, 0)));
    };
    const tick = () => {
      const now = s.rtcTime(id);
      clock.textContent = rtcText(now);
      note.textContent = s.rtcs.has(id) ? 'running (simulated time)' : 'battery backed; the program reads it after Run';
      if (!input.value) input.value = rtcText(now).replace(' ', 'T');
    };
    this.timers.push(window.setInterval(tick, 250));
    tick();
    return h(
      'section',
      { class: 'part-card' },
      this.head(id, 'DS1307 clock', pins ? `I2C${pins.i2c} · GP${pins.SDA}/GP${pins.SCL}` : ''),
      clock,
      note,
      h('div', { class: 'row' }, input, set),
      h('div', { class: 'row' }, jump),
      error,
    );
  }

  private sdCard(id: string) {
    const s = this.system;
    const pins = s.pinsOf(id);
    const inserted = h('input', { type: 'checkbox' });
    inserted.dataset.card = id;
    inserted.addEventListener('change', () => s.setCardInserted(id, inserted.checked));
    const erase = h('button', { textContent: 'Erase', type: 'button', class: 'small-btn', title: 'Format the card: all files are deleted' });
    erase.onclick = () => {
      if (confirm(`Erase all files on ${id}?`)) s.eraseCard(id);
    };
    const list = h('div', { class: 'file-list' });
    list.dataset.card = id;
    this.sync.push(() => (inserted.checked = s.cardInserted(id)));
    inserted.checked = s.cardInserted(id);

    // "Updated": when this page saw the file change (RTC time if a clock runs, else simulated time).
    const seen = new Map<string, { sig: string; at: string }>();
    const stamp = () => {
      const rtc = s.rtcs.values().next().value;
      if (rtc) return rtcText(rtc.now()).slice(11);
      const board = s.board;
      return board ? `t+${(board.simMs / 1000).toFixed(0)} s` : '';
    };
    this.cardLists.set(id, (files) => {
      const rows = files.map((f) => {
        const sig = `${f.size}:${checksum(f.data)}`;
        const prev = seen.get(f.name);
        if (!prev) seen.set(f.name, { sig, at: s.board ? stamp() : '' });
        else if (prev.sig !== sig) seen.set(f.name, { sig, at: stamp() });
        const view = h('button', { textContent: 'view', type: 'button', class: 'small-btn' });
        view.onclick = () => this.viewer.open(s, id, f.name);
        const dl = h('button', { textContent: 'download', type: 'button', class: 'small-btn' });
        dl.onclick = () => downloadFile(f);
        return h(
          'div',
          { class: 'file' },
          h('span', { class: 'file-name', title: f.name }, f.name),
          h('span', { class: 'file-size' }, sizeText(f.size)),
          h('span', { class: 'file-time', title: 'Last change seen while running' }, seen.get(f.name)!.at || '–'),
          h('div', { class: 'file-actions' }, view, dl),
        );
      });
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'muted small' }, s.board ? 'No files yet' : 'Empty card (files appear after Run)')]));
    });

    return h(
      'section',
      { class: 'part-card' },
      this.head(id, 'microSD', pins ? `SPI${pins.spi} · CS GP${pins.CS}` : ''),
      h('div', { class: 'row spread' }, h('label', { class: 'check' }, inserted, ' inserted'), erase),
      list,
    );
  }
}

/** Cheap content fingerprint to notice changed files. */
function checksum(data: Uint8Array) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}
