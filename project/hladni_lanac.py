# Logika nadzora hladnog lanca, bez ovisnosti o sklopovlju.
# Isti se kod izvodi u MicroPythonu na Picu (uvozi ga main.py) i u CPythonu
# u testovima (test/python/test_hladni_lanac.py). Zato ovdje nema importa
# machine/time i nema f-stringova: samo str.format i osnovni Python.
#
# Vrijeme se svugdje predaje kao broj milisekundi (time.ticks_ms() na Picu).
# Razlika dvaju trenutaka racuna se funkcijom `razlika(novije, starije)`;
# main.py predaje time.ticks_diff, koji ispravno radi i kad se brojac
# milisekundi prelije preko maksimuma. Bez nje se koristi obicno oduzimanje.

U_RASPONU = "U_RASPONU"
ODBROJAVANJE = "ODBROJAVANJE"
ALARM = "ALARM"

ZAGLAVLJE_CSV = "datum_vrijeme,temperatura_c,stanje"
ZAGLAVLJE_SAZETKA = "datum,broj_mjerenja,min_c,max_c,prosjek_c,izvan_raspona_s,broj_alarma,neuspjela_ocitanja"

# DS18B20 nakon ukljucenja (ili preranog citanja) vraca tocno 85,0 C.
TEMP_UKLJUCENJA = 85.0
SENZOR_MIN = -55.0
SENZOR_MAX = 125.0

MS_U_DANU = 86400000


def _oduzmi(novije, starije):
    return novije - starije


# ---------- ocitanja i raspon ----------

def valjano_ocitanje(temp):
    """Vrati temperaturu kao float ili None ako je ocitanje nemoguce.

    Odbacuje None, tocno 85,0 C (vrijednost nakon ukljucenja senzora) i sve
    izvan mjernog raspona senzora (-55 do 125 C), da jedno lazno ocitanje ne
    pokrene odbrojavanje alarma.
    """
    if temp is None:
        return None
    try:
        temp = float(temp)
    except (TypeError, ValueError):
        return None
    if temp != temp:  # NaN
        return None
    if temp == TEMP_UKLJUCENJA:
        return None
    if temp < SENZOR_MIN or temp > SENZOR_MAX:
        return None
    return temp


def u_rasponu(temp, t_min, t_max):
    """Granice su ukljucene: 2,0 i 8,0 C su u rasponu."""
    return t_min <= temp <= t_max


# ---------- oblikovanje teksta ----------

def format_trajanje(ms):
    """120000 -> '2 min 0 s'; 3725000 -> '1 h 2 min 5 s'."""
    s = int(ms) // 1000
    if s < 0:
        s = 0
    sati = s // 3600
    minute = (s % 3600) // 60
    sekunde = s % 60
    if sati:
        return "{} h {} min {} s".format(sati, minute, sekunde)
    return "{} min {} s".format(minute, sekunde)


def format_datum_vrijeme(dt):
    """(godina, mjesec, dan, dan_u_tjednu, sat, minuta, sekunda) -> '2026-11-17 14:05:30'."""
    return "{:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}".format(dt[0], dt[1], dt[2], dt[4], dt[5], dt[6])


def format_datum(dt):
    """Kljuc dana za sazetak iz RTC-a: '2026-11-17'."""
    return "{:04d}-{:02d}-{:02d}".format(dt[0], dt[1], dt[2])


def format_uptime(ms):
    """Vrijeme od pokretanja kad nema RTC-a: 90000 -> '+00:01:30' (sati mogu prijeci 24)."""
    s = int(ms) // 1000
    return "+{:02d}:{:02d}:{:02d}".format(s // 3600, (s % 3600) // 60, s % 60)


def dan_uptime(ms):
    """Kljuc dana bez RTC-a: 'dan 1' za prvih 24 h od pokretanja, pa 'dan 2' ..."""
    return "dan {}".format(int(ms) // MS_U_DANU + 1)


# Rezultati promjena_dana()
ISTI_DAN = "isti"
NOVI_DAN = "novi"
DAN_UNATRAG = "unatrag"
DRUGA_VRSTA = "druga_vrsta"


def promjena_dana(trenutni, novi):
    """Usporedi kljuc dana sazetka s kljucem dana novog mjerenja.

    Kljucevi su '2026-11-17' (s RTC-a) ili 'dan 3' (bez RTC-a).
    NOVI_DAN     datum je otisao naprijed: zavrsi dan (sazetak) i pocni novi.
    DAN_UNATRAG  sat je vracen unatrag (npr. rucno namjesten): ne zatvaraj dan,
                 inace bi se isti datum pojavio dvaput u sazetak.csv.
    DRUGA_VRSTA  prijelaz izmedu RTC-a i vremena od pokretanja (RTC se izgubio
                 ili pronasao): isti dan se nastavlja pod novim kljucem.
    ISTI_DAN     nista se ne mijenja.
    """
    if novi == trenutni:
        return ISTI_DAN
    if not trenutni:
        return NOVI_DAN
    a_dan = trenutni.startswith("dan ")
    b_dan = novi.startswith("dan ")
    if a_dan != b_dan:
        return DRUGA_VRSTA
    if a_dan:  # 'dan 10' > 'dan 9' brojcano, ne kao tekst
        return NOVI_DAN if int(novi[4:]) > int(trenutni[4:]) else DAN_UNATRAG
    return NOVI_DAN if novi > trenutni else DAN_UNATRAG  # ISO datumi se ispravno usporeduju kao tekst


def opis_greske(e):
    """Tekst iznimke za poruku. Neke iznimke nemaju tekst (npr. onewire.OneWireError()
    kad se senzor ne javi), pa bi poruka bila '()'; tada se ispisuje ime tipa iznimke."""
    tekst = str(e)
    return tekst if tekst else type(e).__name__


def format_temp(temp):
    return "greska" if temp is None else "{:.2f}".format(temp)


def redak_csv(datum_vrijeme, temp, stanje):
    """Jedan redak CSV-a: '2026-11-17 14:05:30,5.00,U_RASPONU' ili '...,greska,U_RASPONU'."""
    return "{},{},{}".format(datum_vrijeme, format_temp(temp), stanje)


def redak_mjerenja(datum_vrijeme, temp, stanje):
    """Redak za serijski monitor: '[MJERENJE] 2026-11-17 14:05:30 | 5.00 C | U_RASPONU'."""
    t = "greska" if temp is None else "{:.2f} C".format(temp)
    return "[MJERENJE] {} | {} | {}".format(datum_vrijeme, t, stanje)


# ---------- alarm ----------

class NadzorAlarma:
    """Stanja U_RASPONU -> ODBROJAVANJE -> ALARM.

    ODBROJAVANJE pocinje prvim mjerenjem izvan raspona. ALARM se pali kad je
    temperatura neprekidno izvan raspona DULJE od kasnjenje_ms (strogo vece),
    mjereno od prvog mjerenja izvan raspona. Jedno mjerenje u rasponu ponistava
    odbrojavanje. Neuspjelo ocitanje (None) ne mijenja stanje.
    S mjerenjem svakih 10 s i kasnjenjem 2 min alarm se pali na 14. mjerenju izvan
    raspona: 130 s nakon prvog takvog mjerenja, odnosno 130-140 s nakon stvarne
    promjene temperature (dodatno kasnjenje 10-20 s preko 2 min).
    Poruke zadnjeg poziva provjeri() nalaze se u self.poruke.
    """

    def __init__(self, t_min, t_max, kasnjenje_ms, razlika=None):
        self.t_min = t_min
        self.t_max = t_max
        self.kasnjenje_ms = kasnjenje_ms
        self.razlika = razlika or _oduzmi
        self.stanje = U_RASPONU
        self.pocetak_ms = None  # prvo mjerenje izvan raspona
        self.potvrden = False  # alarm potvrden tipkalom
        self.poruke = []

    def provjeri(self, temp, sada_ms):
        self.poruke = []
        if temp is None:
            return self.stanje
        if u_rasponu(temp, self.t_min, self.t_max):
            if self.stanje == ALARM:
                self.poruke.append(
                    "[ALARM KRAJ] temperatura {:.2f} C ponovno u rasponu, ukupno izvan raspona {}".format(
                        temp, format_trajanje(self.razlika(sada_ms, self.pocetak_ms))
                    )
                )
            self.stanje = U_RASPONU
            self.pocetak_ms = None
            self.potvrden = False
            return self.stanje
        if self.pocetak_ms is None:
            self.pocetak_ms = sada_ms
        trajanje = self.razlika(sada_ms, self.pocetak_ms)
        if self.stanje == ALARM:
            return self.stanje
        if trajanje > self.kasnjenje_ms:
            self.stanje = ALARM
            self.poruke.append(
                "[ALARM] temperatura {:.2f} C izvan raspona {:.1f}-{:.1f} C vec {}".format(
                    temp, self.t_min, self.t_max, format_trajanje(trajanje)
                )
            )
        else:
            self.stanje = ODBROJAVANJE
        return self.stanje

    def potvrdi(self):
        """Potvrda alarma tipkalom: LED se gasi do novog prekoracenja. True ako je nesto potvrdeno."""
        if self.stanje == ALARM and not self.potvrden:
            self.potvrden = True
            return True
        return False

    def led_upaljena(self):
        return self.stanje == ALARM and not self.potvrden


# ---------- dnevni sazetak ----------

class Sazetak:
    """Sazetak jednog kalendarskog dana (kljuc: '2026-11-17' ili 'dan 1' bez RTC-a)."""

    def __init__(self, datum):
        self.prethodno_stanje = U_RASPONU  # prezivi reset, da alarm preko ponoci ne broji dvaput
        self.resetiraj(datum)

    def resetiraj(self, datum):
        self.datum = datum
        self.broj = 0
        self.minimum = None
        self.maksimum = None
        self.zbroj = 0.0
        self.izvan_ms = 0
        self.alarma = 0
        self.gresaka = 0

    def dodaj(self, temp, stanje, dt_ms):
        """temp = None za neuspjelo ocitanje; dt_ms = stvarni razmak od prethodnog mjerenja.

        Razmak se broji u vrijeme izvan raspona kad stanje ovog mjerenja nije U_RASPONU
        (i kod neuspjelog ocitanja, jer ono zadrzava prethodno stanje).
        Svaki prijelaz u ALARM broji se kao jedan alarm.
        """
        if temp is None:
            self.gresaka += 1
        else:
            self.broj += 1
            self.zbroj += temp
            if self.minimum is None or temp < self.minimum:
                self.minimum = temp
            if self.maksimum is None or temp > self.maksimum:
                self.maksimum = temp
        if stanje != U_RASPONU and dt_ms > 0:
            self.izvan_ms += dt_ms
        if stanje == ALARM and self.prethodno_stanje != ALARM:
            self.alarma += 1
        self.prethodno_stanje = stanje

    def prosjek(self):
        return self.zbroj / self.broj if self.broj else None

    def _opis(self):
        if self.broj:
            mm = "min {:.2f} C, max {:.2f} C, prosjek {:.2f} C".format(self.minimum, self.maksimum, self.prosjek())
        else:
            mm = "min -, max -, prosjek - (nema mjerenja)"
        return "{}: mjerenja {}, {}, izvan raspona {}, alarma {}, neuspjelih {}".format(
            self.datum, self.broj, mm, format_trajanje(self.izvan_ms), self.alarma, self.gresaka
        )

    def tekst(self):
        """Trenutni sazetak (na tipkalo)."""
        return "[SAZETAK] " + self._opis()

    def tekst_dnevni(self):
        """Zavrseni dan (pri promjeni datuma)."""
        return "[DNEVNI SAZETAK] " + self._opis()

    def redak(self):
        """Redak za /sd/sazetak.csv."""
        if not self.broj:
            return "{},0,,,,{},{},{}".format(self.datum, self.izvan_ms // 1000, self.alarma, self.gresaka)
        return "{},{},{:.2f},{:.2f},{:.2f},{},{},{}".format(
            self.datum, self.broj, self.minimum, self.maksimum, self.prosjek(),
            self.izvan_ms // 1000, self.alarma, self.gresaka
        )


# ---------- tipkalo ----------

class Tipkalo:
    """Prepoznaje pritisak (prijelaz 1 -> 0) uz debounce.

    Pritisak se prihvaca samo ako je ulaz prije toga bio stabilno 1 barem
    debounce_ms, pa titranje kontakata pri pritisku i pri otpustanju ne daje
    dodatne pritiske. azuriraj() vraca True jednom po pritisku.
    """

    def __init__(self, debounce_ms=200, pocetna_vrijednost=1, razlika=None):
        self.debounce_ms = debounce_ms
        self.razlika = razlika or _oduzmi
        self.zadnja_vrijednost = 1 if pocetna_vrijednost else 0
        self.zadnja_promjena = None

    def azuriraj(self, vrijednost, sada_ms):
        vrijednost = 1 if vrijednost else 0
        if vrijednost == self.zadnja_vrijednost:
            return False
        pritisak = False
        if vrijednost == 0:
            if self.zadnja_promjena is None or self.razlika(sada_ms, self.zadnja_promjena) >= self.debounce_ms:
                pritisak = True
        self.zadnja_vrijednost = vrijednost
        self.zadnja_promjena = sada_ms
        return pritisak
