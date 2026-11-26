# Nadzor hladnog lanca (Internet stvari, tema 10) - Raspberry Pi Pico W, MicroPython.
#
# Svakih 10 s mjeri temperaturu DS18B20 senzorom, zapisuje je u CSV na microSD
# kartici i pali LED s porukom ako je temperatura izvan 2-8 C dulje od 2 min.
# Tipkalo ispisuje trenutni sazetak i zadnje retke CSV-a (i potvrduje alarm).
# Dnevni sazetak (min, max, prosjek, vrijeme izvan raspona) ispisuje se i
# zapisuje u /sd/sazetak.csv kad se datum na RTC-u promijeni.
#
# Ovdje je samo sklopovlje i raspored; sva logika odluke (raspon, alarm,
# sazetak, oblik redaka) je u hladni_lanac.py, koji se testira i na racunalu.
#
# Pinovi: LED GP16 (220 ohm), tipkalo GP14 na GND (PULL_UP), DS18B20 DQ GP15
# (4,7k na 3V3), microSD SPI0 SCK GP2 / DI GP3 / DO GP4 / CS GP5, DS1307 I2C0
# SDA GP8 / SCL GP9.

from machine import Pin, SPI, I2C
import os
import time

import hladni_lanac as hl

# ---------- konstante ----------
INTERVAL_MJERENJA_MS = 10_000     # 10 s
T_MIN = 2.0                       # C
T_MAX = 8.0                       # C
ALARM_KASNJENJE_MS = 120_000      # 2 min
CSV_PUTANJA = "/sd/hladnjaca.csv"
SAZETAK_PUTANJA = "/sd/sazetak.csv"
PRETVORBA_MS = 750                # DS18B20 treba do 750 ms za mjerenje
DEBOUNCE_MS = 200
ZADNJIH_REDAKA = 10               # koliko redaka CSV-a ispisuje tipkalo
PAUZA_PETLJE_MS = 10

# ---------- LED i tipkalo ----------
led = Pin(16, Pin.OUT, value=0)
tipkalo = Pin(14, Pin.IN, Pin.PULL_UP)
_tipkalo = hl.Tipkalo(DEBOUNCE_MS, tipkalo.value(), time.ticks_diff)


def postavi_led(upaljena):
    led.value(1 if upaljena else 0)


def tipkalo_pritisnuto():
    """True samo jednom po pritisku (prijelaz 1 -> 0, debounce 200 ms)."""
    return _tipkalo.azuriraj(tipkalo.value(), time.ticks_ms())


# ---------- vrijeme od pokretanja ----------
_start_ms = time.ticks_ms()
_uptime_ms = 0
_uptime_zadnji = _start_ms


def uptime_ms():
    """Milisekunde od pokretanja programa; zbraja ticks_diff pa prezivi preljev brojaca."""
    global _uptime_ms, _uptime_zadnji
    sada = time.ticks_ms()
    _uptime_ms += time.ticks_diff(sada, _uptime_zadnji)
    _uptime_zadnji = sada
    return _uptime_ms


# ---------- RTC (DS1307) ----------
rtc = None


def init_rtc():
    global rtc
    try:
        import ds1307
        i2c = I2C(0, sda=Pin(8), scl=Pin(9), freq=100_000)
        sat = ds1307.DS1307(i2c)
        dt = sat.datetime()  # proba citanja: bez odgovora na I2C ovdje pada
        rtc = sat
        print("[RTC] sat: {}".format(hl.format_datum_vrijeme(dt)))
    except Exception as e:
        rtc = None
        print("[RTC] sat nije dostupan ({}), koristim vrijeme od pokretanja (+HH:MM:SS)".format(hl.opis_greske(e)))


def procitaj_vrijeme(od_pokretanja_ms):
    """Vrati (datum_vrijeme, kljuc_dana). Bez RTC-a: ('+00:01:30', 'dan 1')."""
    global rtc
    if rtc is not None:
        try:
            dt = rtc.datetime()
            return hl.format_datum_vrijeme(dt), hl.format_datum(dt)
        except Exception as e:
            rtc = None
            print("[RTC] greska citanja ({}), prelazim na vrijeme od pokretanja".format(hl.opis_greske(e)))
    return hl.format_uptime(od_pokretanja_ms), hl.dan_uptime(od_pokretanja_ms)


def trenutno_vrijeme():
    """Tekst npr. '2026-11-17 14:05:30' (ili '+00:01:30' bez RTC-a)."""
    return procitaj_vrijeme(uptime_ms())[0]


# ---------- microSD i CSV ----------
sd_ok = False
broj_redaka = 0          # redaka mjerenja u CSV-u (bez zaglavlja), broji se jednom pri pokretanju
_sd_greska_ispisana = False


def _postoji(putanja):
    try:
        os.stat(putanja)
        return True
    except OSError:
        return False


def _dodaj_redak(putanja, zaglavlje, redak):
    """Doda redak na kraj datoteke; zaglavlje samo ako je datoteka nova. Vrati True ako je zapisano."""
    global _sd_greska_ispisana
    if not sd_ok:
        return False
    try:
        nova = not _postoji(putanja)
        with open(putanja, "a") as f:
            if nova:
                f.write(zaglavlje + "\n")
            f.write(redak + "\n")
        _sd_greska_ispisana = False
        return True
    except OSError as e:
        if not _sd_greska_ispisana:
            print("[SD] greska pri zapisu u {} ({}), karticu trazim pri svakom mjerenju".format(
                putanja, hl.opis_greske(e)))
            _sd_greska_ispisana = True
        _odbaci_karticu()
        return False


def _odbaci_karticu():
    """Kartica je izvadena ili ne radi: odmontiraj je da se kasnije moze ponovno montirati."""
    global sd_ok
    sd_ok = False
    try:
        os.umount("/sd")
    except OSError:
        pass


def init_sd(tiho=False):
    """Montira karticu na /sd i po potrebi napise zaglavlje CSV-a.

    Poziva se pri pokretanju i, dok kartice nema, prije svakog mjerenja (tiho=True:
    neuspjeh se ne ispisuje svakih 10 s), pa kartica umetnuta kasnije ili vracena
    nakon vadenja opet prima zapise.
    """
    global sd_ok, broj_redaka, _sd_greska_ispisana
    try:
        import sdcard
        spi = SPI(0, baudrate=1_000_000, sck=Pin(2), mosi=Pin(3), miso=Pin(4))
        kartica = sdcard.SDCard(spi, Pin(5, Pin.OUT, value=1))
        os.mount(kartica, "/sd")
    except Exception as e:
        sd_ok = False
        if not tiho:
            print("[SD] kartica nije dostupna ({}), mjerenja se ne zapisuju dok se ne umetne".format(
                hl.opis_greske(e)))
        return
    sd_ok = True
    _sd_greska_ispisana = False
    print("[SD] kartica montirana na /sd")
    try:
        if _postoji(CSV_PUTANJA):
            n = 0
            with open(CSV_PUTANJA, "r") as f:
                for _ in f:
                    n += 1
            broj_redaka = max(0, n - 1)
            print("[SD] {} postoji, {} redaka mjerenja".format(CSV_PUTANJA, broj_redaka))
        else:
            with open(CSV_PUTANJA, "a") as f:
                f.write(hl.ZAGLAVLJE_CSV + "\n")
            broj_redaka = 0
            print("[SD] nova datoteka {}, zapisano zaglavlje".format(CSV_PUTANJA))
    except OSError as e:
        sd_ok = False
        print("[SD] greska pri pristupu {} ({}), mjerenja se ne zapisuju".format(CSV_PUTANJA, hl.opis_greske(e)))


def zapisi_csv(datum_vrijeme, temp, stanje):
    global broj_redaka
    if _dodaj_redak(CSV_PUTANJA, hl.ZAGLAVLJE_CSV, hl.redak_csv(datum_vrijeme, temp, stanje)):
        broj_redaka += 1


def ispisi_csv(n=ZADNJIH_REDAKA):
    """Ispise zaglavlje i zadnjih n redaka CSV-a (cita samo kraj datoteke).

    ispisi_csv(None) ispise cijelu datoteku, redak po redak (za prijenos podataka s
    kartice kad nema druge mogucnosti, npr. u Wokwiju): u serijskom monitoru Ctrl+C
    zaustavi program, pa u REPL-u upisati ispisi_csv(None).
    """
    if not sd_ok:
        print("[CSV] kartica nije dostupna, nema zapisa")
        return
    if n is None:
        _ispisi_cijeli_csv()
        return
    try:
        with open(CSV_PUTANJA, "rb") as f:
            velicina = f.seek(0, 2)
            od = max(0, velicina - 100 * (n + 1))
            f.seek(od)
            kraj = f.read().decode()
    except OSError as e:
        print("[CSV] greska pri citanju {} ({})".format(CSV_PUTANJA, hl.opis_greske(e)))
        return
    retci = [r for r in kraj.split("\n") if r]
    if od > 0 and retci:
        retci = retci[1:]  # prvi redak je mozda odrezan
    retci = [r for r in retci if r != hl.ZAGLAVLJE_CSV][-n:]
    print("[CSV] --- {}: zadnjih {} od {} redaka ---".format(CSV_PUTANJA, len(retci), broj_redaka))
    print(hl.ZAGLAVLJE_CSV)
    for r in retci:
        print(r)
    print("[CSV] --- kraj ---")


def _ispisi_cijeli_csv():
    print("[CSV] --- {}: cijela datoteka ---".format(CSV_PUTANJA))
    try:
        with open(CSV_PUTANJA) as f:
            for redak in f:   # redak po redak, bez ucitavanja cijele datoteke u RAM
                print(redak.rstrip("\n"))
    except OSError as e:
        print("[CSV] greska pri citanju {} ({})".format(CSV_PUTANJA, hl.opis_greske(e)))
        return
    print("[CSV] --- kraj ---")


# ---------- senzor DS18B20 ----------
ds = None
rom = None
_pretvorba_ok = False
_senzor_greska = None   # zadnja ispisana greska senzora (da se ne ponavlja svakih 10 s)


def _trazi_senzor():
    global rom
    try:
        romovi = ds.scan()
    except Exception:
        romovi = []
    if romovi:
        rom = romovi[0]
        print("[SENZOR] pronaden DS18B20 ({})".format("".join("{:02x}".format(b) for b in rom)))
        return True
    return False


def init_senzor():
    global ds
    try:
        import onewire
        import ds18x20
        ds = ds18x20.DS18X20(onewire.OneWire(Pin(15)))
    except Exception as e:
        ds = None
        print("[SENZOR] greska pri pokretanju 1-Wire ({})".format(hl.opis_greske(e)))
        return
    if not _trazi_senzor():
        print("[SENZOR] DS18B20 nije pronaden na GP15 (provjerite spoj i otpornik 4.7k), trazim ga pri svakom mjerenju")


def _greska_senzora(opis):
    global _senzor_greska
    if opis != _senzor_greska:
        print("[SENZOR] greska ocitanja: {}".format(opis))
        _senzor_greska = opis


def pokreni_mjerenje():
    """Pokrene pretvorbu temperature; rezultat se cita najranije 750 ms kasnije."""
    global _pretvorba_ok
    _pretvorba_ok = False
    if ds is None:
        return
    if rom is None and not _trazi_senzor():
        return
    try:
        ds.convert_temp()
        _pretvorba_ok = True
    except Exception as e:  # onewire.OneWireError nije OSError
        _greska_senzora("pretvorba nije uspjela ({})".format(hl.opis_greske(e)))


def procitaj_temp():
    """Vrati temperaturu u C ili None ako ocitanje ne uspije ili je nemoguce."""
    global _senzor_greska
    if ds is None:
        _greska_senzora("1-Wire nije pokrenut")
        return None
    if rom is None:
        _greska_senzora("senzor nije pronaden")
        return None
    if not _pretvorba_ok:
        return None
    try:
        sirovo = ds.read_temp(rom)
    except Exception as e:  # CRC greska ili senzor iskopcan
        _greska_senzora("citanje nije uspjelo ({})".format(hl.opis_greske(e)))
        return None
    temp = hl.valjano_ocitanje(sirovo)
    if temp is None:
        _greska_senzora("nemoguca vrijednost {}".format(sirovo))
        return None
    if _senzor_greska is not None:
        print("[SENZOR] ocitanje ponovno uspijeva")
        _senzor_greska = None
    return temp


# ---------- alarm ----------
nadzor = hl.NadzorAlarma(T_MIN, T_MAX, ALARM_KASNJENJE_MS, time.ticks_diff)


def provjeri_alarm(temp, sada_ms):
    """Vrati 'U_RASPONU', 'ODBROJAVANJE' ili 'ALARM' i ispise poruku alarma / povratka."""
    stanje = nadzor.provjeri(temp, sada_ms)
    for poruka in nadzor.poruke:
        print(poruka)
    return stanje


# ---------- dnevni sazetak ----------
sazetak = hl.Sazetak("")


def azuriraj_sazetak(temp, stanje, dt_ms):
    sazetak.dodaj(temp, stanje, dt_ms)


def ispisi_sazetak():
    print(sazetak.tekst())


def resetiraj_sazetak(datum):
    sazetak.resetiraj(datum)


def zavrsi_dan(novi_datum):
    """Promjena datuma: ispis i zapis dnevnog sazetka, pa reset za novi dan."""
    print(sazetak.tekst_dnevni())
    _dodaj_redak(SAZETAK_PUTANJA, hl.ZAGLAVLJE_SAZETKA, sazetak.redak())
    resetiraj_sazetak(novi_datum)


# ---------- jedno mjerenje ----------
_prethodno_mjerenje_ms = None
_mjerenje_od_pokretanja_ms = 0   # planirani trenutak mjerenja od pokretanja (za vrijeme bez RTC-a)
_zadnji_datum = None             # kljuc dana prethodnog mjerenja (poruka o satu vracenom unatrag samo jednom)


def obradi_mjerenje(temp, zakazano_ms):
    """Redoslijed: kraj dana, alarm, LED, CSV, sazetak, ispis retka.

    zakazano_ms je planirani trenutak mjerenja (tocno svakih 10 s), pa trajanje
    alarma, razmaci za sazetak i vrijeme bez RTC-a ne ovise o kasnjenju petlje.
    """
    global _prethodno_mjerenje_ms, _mjerenje_od_pokretanja_ms, _zadnji_datum
    if _prethodno_mjerenje_ms is None:
        # Prvo mjerenje: broji se kao da je prethodno bilo INTERVAL ranije, da vrijeme
        # izvan raspona u sazetku bude jednako onome u poruci [ALARM KRAJ] (koja broji od
        # prvog mjerenja izvan raspona) i kad je temperatura izvan raspona vec pri pokretanju.
        dt_ms = INTERVAL_MJERENJA_MS
        _mjerenje_od_pokretanja_ms = time.ticks_diff(zakazano_ms, _start_ms)
    else:
        dt_ms = time.ticks_diff(zakazano_ms, _prethodno_mjerenje_ms)
        # zbraja razmake, pa i nakon preljeva ticks_ms (~6 dana) vrijeme bez RTC-a ostaje tocno
        _mjerenje_od_pokretanja_ms += dt_ms
    _prethodno_mjerenje_ms = zakazano_ms

    datum_vrijeme, datum = procitaj_vrijeme(_mjerenje_od_pokretanja_ms)
    promjena = hl.promjena_dana(sazetak.datum, datum)
    if promjena == hl.NOVI_DAN:
        zavrsi_dan(datum)
    elif promjena == hl.DRUGA_VRSTA:
        sazetak.datum = datum   # RTC izgubljen ili pronaden: isti dan se nastavlja
    elif promjena == hl.DAN_UNATRAG and datum != _zadnji_datum:
        print("[RTC] sat je vracen unatrag ({}), dnevni sazetak i dalje vodi dan {}".format(datum, sazetak.datum))
    _zadnji_datum = datum

    if not sd_ok:
        init_sd(tiho=True)  # kartica umetnuta ili vracena u meduvremenu?

    stanje = provjeri_alarm(temp, zakazano_ms)
    postavi_led(nadzor.led_upaljena())
    zapisi_csv(datum_vrijeme, temp, stanje)
    azuriraj_sazetak(temp, stanje, dt_ms)
    print(hl.redak_mjerenja(datum_vrijeme, temp, stanje))


def obradi_tipkalo():
    print("[TIPKALO] pritisak")
    if nadzor.potvrdi():
        postavi_led(False)
        print("[POTVRDA] alarm potvrden, LED ugasena do novog prekoracenja")
    ispisi_sazetak()
    ispisi_csv()


# ---------- pokretanje ----------
def main():
    print("[START] Nadzor hladnog lanca")
    print("[START] raspon {:.1f} - {:.1f} C, mjerenje svakih {} s, alarm nakon {} s izvan raspona".format(
        T_MIN, T_MAX, INTERVAL_MJERENJA_MS // 1000, ALARM_KASNJENJE_MS // 1000))
    postavi_led(False)
    init_sd()
    init_rtc()
    init_senzor()
    resetiraj_sazetak(procitaj_vrijeme(uptime_ms())[1])
    print("[START] tipkalo (GP14): sazetak i zadnji retci CSV-a, tijekom alarma i potvrda alarma")

    sljedece_ms = time.ticks_ms()   # prvo mjerenje odmah
    zakazano_ms = sljedece_ms
    pretvorba_u_tijeku = False
    pretvorba_pocetak = 0

    while True:
        sada = time.ticks_ms()
        uptime_ms()

        # Pokretanje pretvorbe svakih 10 s (bez sleep(10): petlja stalno provjerava tipkalo).
        if not pretvorba_u_tijeku and time.ticks_diff(sada, sljedece_ms) >= 0:
            zakazano_ms = sljedece_ms
            sljedece_ms = time.ticks_add(sljedece_ms, INTERVAL_MJERENJA_MS)
            if time.ticks_diff(sada, sljedece_ms) >= 0:
                # petlja je jako zakasnila: ne sustizi propustena mjerenja
                sljedece_ms = time.ticks_add(sada, INTERVAL_MJERENJA_MS)
            pokreni_mjerenje()
            # vrijeme nakon poziva: trazenje tek prikljucenog senzora traje nekoliko ms, a
            # citanje prije isteka 750 ms vratilo bi 85 C umjesto izmjerene vrijednosti
            pretvorba_pocetak = time.ticks_ms()
            pretvorba_u_tijeku = True

        # Citanje rezultata najranije 750 ms nakon pokretanja pretvorbe.
        if pretvorba_u_tijeku and time.ticks_diff(sada, pretvorba_pocetak) >= PRETVORBA_MS:
            pretvorba_u_tijeku = False
            obradi_mjerenje(procitaj_temp(), zakazano_ms)

        if tipkalo_pritisnuto():
            obradi_tipkalo()

        time.sleep_ms(PAUZA_PETLJE_MS)


main()
