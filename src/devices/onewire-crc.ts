// Dallas/Maxim 1-Wire CRC8 (polynomial x^8 + x^5 + x^4 + 1, i.e. 0x31, processed
// LSB first, so the reflected constant 0x8C is used). The same CRC that
// MicroPython's onewire.crc8() computes; a buffer that ends with its own CRC gives 0.
export function crc8(data: ArrayLike<number>, length = data.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    let byte = data[i] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      const mix = (crc ^ byte) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      byte >>= 1;
    }
  }
  return crc;
}
