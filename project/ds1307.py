# DS1307 real-time clock driver (I2C, address 0x68). MIT licence, original code.
#
#   from machine import I2C, Pin
#   from ds1307 import DS1307
#   rtc = DS1307(I2C(0, sda=Pin(8), scl=Pin(9), freq=100000))
#   rtc.datetime()      # -> (year, month, day, weekday, hour, minute, second)
#   rtc.datetime((2026, 11, 25, 3, 23, 59, 50))   # set; also starts the clock
#
# weekday is 1-7 (the chip only counts it; Monday = 1 is the usual choice).


def _bcd(n):
    return (n // 10) << 4 | n % 10


def _dec(b):
    return (b >> 4) * 10 + (b & 0x0F)


class DS1307:
    def __init__(self, i2c, addr=0x68):
        self.i2c = i2c
        self.addr = addr

    def datetime(self, dt=None):
        """Read (no argument) or set the time as (year, month, day, weekday, hour, minute, second)."""
        if dt is None:
            r = self.i2c.readfrom_mem(self.addr, 0x00, 7)
            h = r[2]
            if h & 0x40:  # 12-hour mode: convert to 24 h
                hour = _dec(h & 0x1F) % 12 + (12 if h & 0x20 else 0)
            else:
                hour = _dec(h & 0x3F)
            return (2000 + _dec(r[6]), _dec(r[5] & 0x1F), _dec(r[4] & 0x3F), r[3] & 0x07,
                    hour, _dec(r[1] & 0x7F), _dec(r[0] & 0x7F))
        year, month, day, weekday, hour, minute, second = dt
        # Seconds written with bit 7 (CH) = 0, so the clock runs; hours in 24 h mode.
        self.i2c.writeto_mem(self.addr, 0x00, bytes((
            _bcd(second), _bcd(minute), _bcd(hour), weekday,
            _bcd(day), _bcd(month), _bcd(year % 100))))

    def halt(self, value=None):
        """Return whether the clock is halted (CH bit), or halt/start it with True/False."""
        sec = self.i2c.readfrom_mem(self.addr, 0x00, 1)[0]
        if value is None:
            return bool(sec & 0x80)
        sec = (sec | 0x80) if value else (sec & 0x7F)
        self.i2c.writeto_mem(self.addr, 0x00, bytes((sec,)))
