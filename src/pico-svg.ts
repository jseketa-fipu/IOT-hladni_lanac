// Drawing and pin map of the Raspberry Pi Pico / Pico W, USB at the top.
// Pin names follow Wokwi's diagram.json ("GP16", "GND.5", "3V3", ...).

export const PICO_WIDTH = 96;
export const PICO_HEIGHT = 214;
const PITCH = 9.6; // 2.54 mm
const FIRST_Y = 18;
const LEFT_X = 6;
const RIGHT_X = PICO_WIDTH - 6;

// Physical pins 1..40. 1-20 run down the left edge, 21-40 run up the right edge.
const PHYSICAL = [
  'GP0', 'GP1', 'GND.1', 'GP2', 'GP3', 'GP4', 'GP5', 'GND.2', 'GP6', 'GP7',
  'GP8', 'GP9', 'GND.3', 'GP10', 'GP11', 'GP12', 'GP13', 'GND.4', 'GP14', 'GP15',
  'GP16', 'GP17', 'GND.5', 'GP18', 'GP19', 'GP20', 'GP21', 'GND.6', 'GP22', 'RUN',
  'GP26', 'GP27', 'GND.7', 'GP28', 'ADC_VREF', '3V3', '3V3_EN', 'GND.8', 'VSYS', 'VBUS',
];

export interface PinPos {
  name: string;
  x: number;
  y: number;
  side: 'left' | 'right';
}

export const PICO_PINS: PinPos[] = PHYSICAL.map((name, i) =>
  i < 20
    ? { name, x: LEFT_X, y: FIRST_Y + i * PITCH, side: 'left' }
    : { name, x: RIGHT_X, y: FIRST_Y + (39 - i) * PITCH, side: 'right' },
);

const shortLabel = (name: string) => name.replace(/\.\d+$/, '').replace('ADC_VREF', 'VREF');

export function picoSvg(wireless: boolean): string {
  const pads = PICO_PINS.map((p) => {
    const ground = p.name.startsWith('GND');
    const labelX = p.side === 'left' ? p.x + 7 : p.x - 7;
    const anchor = p.side === 'left' ? 'start' : 'end';
    return `
      <rect x="${p.x - 4.2}" y="${p.y - 3.4}" width="8.4" height="6.8" rx="1.2" fill="#d7b65a"/>
      <circle cx="${p.x}" cy="${p.y}" r="1.9" fill="#20402c"/>
      <text x="${labelX}" y="${p.y + 1.9}" text-anchor="${anchor}" class="pico-label${ground ? ' gnd' : ''}">${shortLabel(p.name)}</text>`;
  }).join('');

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${PICO_WIDTH}" height="${PICO_HEIGHT}" viewBox="0 0 ${PICO_WIDTH} ${PICO_HEIGHT}">
    <rect x="0.5" y="4" width="${PICO_WIDTH - 1}" height="${PICO_HEIGHT - 4.5}" rx="4" fill="#1f6b3a" stroke="#174f2b"/>
    <rect x="${PICO_WIDTH / 2 - 13}" y="0" width="26" height="15" rx="2" fill="#c9ccd1" stroke="#8f949b"/>
    <rect x="${PICO_WIDTH / 2 - 10}" y="3" width="20" height="5" rx="1" fill="#9da2a9"/>
    <rect x="${PICO_WIDTH / 2 - 15}" y="${PICO_HEIGHT / 2 - 10}" width="30" height="30" rx="2" fill="#2b2b2b"/>
    <text x="${PICO_WIDTH / 2}" y="${PICO_HEIGHT / 2 + 7}" text-anchor="middle" class="pico-chip">RP2040</text>
    ${wireless ? `<rect x="${PICO_WIDTH / 2 - 14}" y="${PICO_HEIGHT - 44}" width="28" height="22" rx="2" fill="#b8bcc2" stroke="#8f949b"/>` : ''}
    <text x="${PICO_WIDTH / 2}" y="${PICO_HEIGHT / 2 - 18}" text-anchor="middle" class="pico-name">${wireless ? 'Pico W' : 'Pico'}</text>
    ${pads}
  </svg>`;
}
