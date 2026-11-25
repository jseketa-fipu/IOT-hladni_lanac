# Testovi logike nadzora hladnog lanca (project/hladni_lanac.py) u CPythonu.
# Pokretanje: npm run test:py
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "project"))

from hladni_lanac import (  # noqa: E402
    ALARM,
    ODBROJAVANJE,
    U_RASPONU,
    ZAGLAVLJE_CSV,
    NadzorAlarma,
    Sazetak,
    Tipkalo,
    dan_uptime,
    format_datum,
    format_datum_vrijeme,
    format_trajanje,
    format_uptime,
    redak_csv,
    redak_mjerenja,
    u_rasponu,
    valjano_ocitanje,
)

T_MIN = 2.0
T_MAX = 8.0
KASNJENJE = 120000
KORAK = 10000


def nadzor_alarma(razlika=None):
    return NadzorAlarma(T_MIN, T_MAX, KASNJENJE, razlika)


def pokreni(temperature, korak_ms=KORAK, pocetak_ms=0, nadzor=None):
    """Vrati (nadzor, [(stanje, poruke), ...]) za niz mjerenja u razmacima od korak_ms."""
    nadzor = nadzor or nadzor_alarma()
    rezultati = []
    for i, temp in enumerate(temperature):
        stanje = nadzor.provjeri(temp, pocetak_ms + i * korak_ms)
        rezultati.append((stanje, list(nadzor.poruke)))
    return nadzor, rezultati


# ticks_ms na MicroPythonu: brojac od 30 bita koji se prelije
TICKS_PERIOD = 1 << 30


def ticks_add(t, d):
    return (t + d) % TICKS_PERIOD


def ticks_diff(a, b):
    return ((a - b + TICKS_PERIOD // 2) % TICKS_PERIOD) - TICKS_PERIOD // 2


class Ocitanje(unittest.TestCase):
    def test_normalna_vrijednost(self):
        self.assertEqual(valjano_ocitanje(5.0625), 5.0625)
        self.assertEqual(valjano_ocitanje(-55.0), -55.0)
        self.assertEqual(valjano_ocitanje(125.0), 125.0)

    def test_85_je_vrijednost_ukljucenja(self):
        self.assertIsNone(valjano_ocitanje(85.0))
        self.assertEqual(valjano_ocitanje(84.9375), 84.9375)

    def test_izvan_raspona_senzora(self):
        self.assertIsNone(valjano_ocitanje(-55.5))
        self.assertIsNone(valjano_ocitanje(125.5))
        self.assertIsNone(valjano_ocitanje(None))
        self.assertIsNone(valjano_ocitanje(float("nan")))


class Raspon(unittest.TestCase):
    def test_granice_su_u_rasponu(self):
        self.assertTrue(u_rasponu(2.0, T_MIN, T_MAX))
        self.assertTrue(u_rasponu(8.0, T_MIN, T_MAX))
        self.assertFalse(u_rasponu(1.99, T_MIN, T_MAX))
        self.assertFalse(u_rasponu(8.01, T_MIN, T_MAX))


class Alarm(unittest.TestCase):
    def test_nema_alarma_u_rasponu(self):
        nadzor, rezultati = pokreni([5.0] * 30)
        self.assertTrue(all(s == U_RASPONU for s, _ in rezultati))
        self.assertFalse(nadzor.led_upaljena())

    def test_prvo_izvan_raspona_je_odbrojavanje(self):
        _, rezultati = pokreni([5.0, 9.0])
        self.assertEqual(rezultati[1], (ODBROJAVANJE, []))

    def test_tocno_dvije_minute_nije_alarm(self):
        # 13 mjerenja: od prvog do zadnjeg tocno 120 s
        nadzor, rezultati = pokreni([9.0] * 13)
        self.assertEqual(rezultati[-1][0], ODBROJAVANJE)
        self.assertFalse(nadzor.led_upaljena())

    def test_alarm_na_mjerenju_130_s_nakon_prvog_izvan(self):
        nadzor, rezultati = pokreni([9.0] * 14)
        stanje, poruke = rezultati[-1]
        self.assertEqual(stanje, ALARM)
        self.assertTrue(nadzor.led_upaljena())
        self.assertEqual(poruke, ["[ALARM] temperatura 9.00 C izvan raspona 2.0-8.0 C vec 2 min 10 s"])

    def test_preniska_temperatura_je_alarm(self):
        _, rezultati = pokreni([0.0] * 14)
        self.assertEqual(rezultati[-1][0], ALARM)

    def test_poruka_alarma_samo_jednom(self):
        _, rezultati = pokreni([9.0] * 30)
        self.assertEqual(sum(len(p) for _, p in rezultati), 1)

    def test_povratak_u_raspon_gasi_alarm(self):
        nadzor, rezultati = pokreni([9.0] * 14 + [5.0])
        stanje, poruke = rezultati[-1]
        self.assertEqual(stanje, U_RASPONU)
        self.assertFalse(nadzor.led_upaljena())
        self.assertEqual(poruke, ["[ALARM KRAJ] temperatura 5.00 C ponovno u rasponu, ukupno izvan raspona 2 min 20 s"])

    def test_kratko_prekoracenje_bez_alarma(self):
        # 10 C 1 min pa 5 C, vise puta
        _, rezultati = pokreni(([10.0] * 6 + [5.0]) * 5)
        self.assertNotIn(ALARM, [s for s, _ in rezultati])
        self.assertFalse(any(p for _, p in rezultati))

    def test_jedno_mjerenje_u_rasponu_ponistava_odbrojavanje(self):
        _, rezultati = pokreni([9.0] * 13 + [5.0] + [9.0] * 13)
        self.assertNotIn(ALARM, [s for s, _ in rezultati])

    def test_prijelaz_s_visoke_na_nisku_je_isti_dogadaj(self):
        _, rezultati = pokreni([10.0] * 7 + [0.0] * 7)
        self.assertEqual(rezultati[-1][0], ALARM)

    def test_neuspjelo_ocitanje_ne_mijenja_stanje(self):
        nadzor, rezultati = pokreni([9.0, None, None])
        self.assertEqual([s for s, _ in rezultati], [ODBROJAVANJE, ODBROJAVANJE, ODBROJAVANJE])
        nadzor, rezultati = pokreni([9.0] * 14 + [None])
        self.assertEqual(rezultati[-1], (ALARM, []))
        nadzor, rezultati = pokreni([None, 5.0, None])
        self.assertEqual([s for s, _ in rezultati], [U_RASPONU] * 3)

    def test_neuspjelo_ocitanje_ne_ponistava_odbrojavanje(self):
        _, rezultati = pokreni([9.0] * 6 + [None] + [9.0] * 7)
        self.assertEqual(rezultati[-1][0], ALARM)

    def test_preljev_ticks_ms(self):
        # Odbrojavanje pocinje tik prije preljeva brojaca od 30 bita.
        nadzor = nadzor_alarma(ticks_diff)
        t = TICKS_PERIOD - 50000
        stanja = []
        for _ in range(14):
            stanja.append(nadzor.provjeri(9.0, t))
            t = ticks_add(t, KORAK)
        self.assertEqual(stanja[12], ODBROJAVANJE)
        self.assertEqual(stanja[13], ALARM)
        self.assertIn("vec 2 min 10 s", nadzor.poruke[0])
        nadzor.provjeri(5.0, t)
        self.assertIn("ukupno izvan raspona 2 min 20 s", nadzor.poruke[0])


class Potvrda(unittest.TestCase):
    def test_potvrda_gasi_led_do_novog_prekoracenja(self):
        nadzor, _ = pokreni([9.0] * 14)
        self.assertTrue(nadzor.led_upaljena())
        self.assertTrue(nadzor.potvrdi())
        self.assertFalse(nadzor.led_upaljena())
        self.assertFalse(nadzor.potvrdi())  # vec potvrdeno
        # alarm traje dalje, LED ostaje ugasena
        nadzor.provjeri(9.0, 14 * KORAK)
        self.assertEqual(nadzor.stanje, ALARM)
        self.assertFalse(nadzor.led_upaljena())
        # povratak u raspon pa novo prekoracenje -> LED opet svijetli
        pokreni([5.0] + [9.0] * 14, pocetak_ms=15 * KORAK, nadzor=nadzor)
        self.assertEqual(nadzor.stanje, ALARM)
        self.assertTrue(nadzor.led_upaljena())

    def test_bez_alarma_nema_potvrde(self):
        nadzor, _ = pokreni([9.0] * 5)
        self.assertFalse(nadzor.potvrdi())


class DnevniSazetak(unittest.TestCase):
    def test_min_max_prosjek(self):
        s = Sazetak("2026-11-17")
        for t in [4.0, 6.0, 5.0]:
            s.dodaj(t, U_RASPONU, KORAK)
        self.assertEqual((s.minimum, s.maksimum, s.broj), (4.0, 6.0, 3))
        self.assertAlmostEqual(s.prosjek(), 5.0)

    def test_vrijeme_izvan_raspona_prati_stvarne_razmake(self):
        s = Sazetak("d")
        s.dodaj(5.0, U_RASPONU, 0)
        s.dodaj(9.0, ODBROJAVANJE, 35000)
        s.dodaj(9.0, ODBROJAVANJE, 10000)
        s.dodaj(5.0, U_RASPONU, 10000)
        self.assertEqual(s.izvan_ms, 45000)

    def test_neuspjelo_ocitanje_broji_se_kao_greska(self):
        s = Sazetak("d")
        s.dodaj(5.0, U_RASPONU, 0)
        s.dodaj(None, U_RASPONU, KORAK)
        s.dodaj(None, ODBROJAVANJE, KORAK)
        self.assertEqual((s.broj, s.gresaka), (1, 2))
        self.assertAlmostEqual(s.prosjek(), 5.0)
        self.assertEqual(s.izvan_ms, KORAK)

    def test_broj_alarma_broji_prijelaze(self):
        s = Sazetak("d")
        for st in [U_RASPONU, ODBROJAVANJE, ALARM, ALARM, U_RASPONU, ODBROJAVANJE, ALARM]:
            s.dodaj(9.0, st, KORAK)
        self.assertEqual(s.alarma, 2)

    def test_alarm_preko_ponoci_ne_broji_se_ponovno(self):
        s = Sazetak("2026-11-17")
        s.dodaj(9.0, ALARM, KORAK)
        s.resetiraj("2026-11-18")
        s.dodaj(9.0, ALARM, KORAK)
        self.assertEqual(s.alarma, 0)
        self.assertEqual(s.izvan_ms, KORAK)

    def test_tekst_i_redak(self):
        s = Sazetak("2026-11-17")
        s.dodaj(4.0, U_RASPONU, 0)
        s.dodaj(9.0, ODBROJAVANJE, KORAK)
        s.dodaj(None, ODBROJAVANJE, KORAK)
        self.assertEqual(
            s.tekst(),
            "[SAZETAK] 2026-11-17: mjerenja 2, min 4.00 C, max 9.00 C, prosjek 6.50 C, "
            "izvan raspona 0 min 20 s, alarma 0, neuspjelih 1",
        )
        self.assertTrue(s.tekst_dnevni().startswith("[DNEVNI SAZETAK] 2026-11-17: mjerenja 2,"))
        self.assertEqual(s.redak(), "2026-11-17,2,4.00,9.00,6.50,20,0,1")

    def test_dan_bez_mjerenja(self):
        s = Sazetak("dan 3")
        s.dodaj(None, U_RASPONU, KORAK)
        self.assertEqual(s.redak(), "dan 3,0,,,,0,0,1")
        self.assertIn("nema mjerenja", s.tekst())
        self.assertIsNone(s.prosjek())

    def test_resetiraj(self):
        s = Sazetak("a")
        s.dodaj(3.0, ALARM, KORAK)
        s.resetiraj("b")
        self.assertEqual((s.datum, s.broj, s.izvan_ms, s.alarma, s.gresaka, s.minimum), ("b", 0, 0, 0, 0, None))

    def test_scenarij_kroz_alarm_i_sazetak(self):
        # 5 C, pa 10 C 3 min, pa 5 C: jedan alarm, izvan raspona 180 s
        nadzor = nadzor_alarma()
        s = Sazetak("d")
        temps = [5.0] + [10.0] * 18 + [5.0, 5.0]
        prethodno = None
        for i, t in enumerate(temps):
            sada = i * KORAK
            stanje = nadzor.provjeri(t, sada)
            s.dodaj(t, stanje, 0 if prethodno is None else sada - prethodno)
            prethodno = sada
        self.assertEqual(s.alarma, 1)
        self.assertEqual(s.izvan_ms, 180000)
        self.assertEqual((s.minimum, s.maksimum), (5.0, 10.0))


class Oblikovanje(unittest.TestCase):
    DT = (2026, 11, 17, 2, 14, 5, 30)

    def test_datum_vrijeme(self):
        self.assertEqual(format_datum_vrijeme(self.DT), "2026-11-17 14:05:30")
        self.assertEqual(format_datum(self.DT), "2026-11-17")

    def test_uptime(self):
        self.assertEqual(format_uptime(0), "+00:00:00")
        self.assertEqual(format_uptime(90000), "+00:01:30")
        self.assertEqual(format_uptime(25 * 3600000 + 999), "+25:00:00")
        self.assertEqual(dan_uptime(0), "dan 1")
        self.assertEqual(dan_uptime(86400000), "dan 2")

    def test_trajanje(self):
        self.assertEqual(format_trajanje(0), "0 min 0 s")
        self.assertEqual(format_trajanje(130000), "2 min 10 s")
        self.assertEqual(format_trajanje(3725000), "1 h 2 min 5 s")

    def test_redak_csv(self):
        self.assertEqual(ZAGLAVLJE_CSV, "datum_vrijeme,temperatura_c,stanje")
        self.assertEqual(redak_csv("2026-11-17 14:05:30", 5.0, U_RASPONU), "2026-11-17 14:05:30,5.00,U_RASPONU")
        self.assertEqual(redak_csv("+00:00:10", None, ODBROJAVANJE), "+00:00:10,greska,ODBROJAVANJE")

    def test_redak_mjerenja(self):
        self.assertEqual(redak_mjerenja("+00:00:10", 4.5, U_RASPONU), "[MJERENJE] +00:00:10 | 4.50 C | U_RASPONU")
        self.assertEqual(redak_mjerenja("+00:00:10", None, U_RASPONU), "[MJERENJE] +00:00:10 | greska | U_RASPONU")


class TipkaloTest(unittest.TestCase):
    def test_jedan_pritisak_jednom(self):
        t = Tipkalo(200)
        self.assertFalse(t.azuriraj(1, 0))
        self.assertTrue(t.azuriraj(0, 1000))
        self.assertFalse(t.azuriraj(0, 1010))  # drzanje
        self.assertFalse(t.azuriraj(1, 1300))  # otpustanje

    def test_titranje_pri_pritisku_i_otpustanju(self):
        t = Tipkalo(200)
        pritisci = 0
        # pritisak s titranjem, drzanje 300 ms, otpustanje s titranjem
        for v, ms in [(0, 1000), (1, 1002), (0, 1004), (1, 1006), (0, 1008),
                      (1, 1300), (0, 1302), (1, 1304), (0, 1306), (1, 1310)]:
            pritisci += t.azuriraj(v, ms)
        self.assertEqual(pritisci, 1)

    def test_dva_odvojena_pritiska(self):
        t = Tipkalo(200)
        self.assertTrue(t.azuriraj(0, 1000))
        t.azuriraj(1, 1300)
        self.assertTrue(t.azuriraj(0, 1600))

    def test_preljev(self):
        t = Tipkalo(200, 1, ticks_diff)
        t.azuriraj(0, TICKS_PERIOD - 1000)
        t.azuriraj(1, TICKS_PERIOD - 700)
        self.assertTrue(t.azuriraj(0, 100))

    def test_drzano_pri_pokretanju(self):
        t = Tipkalo(200, 0)
        self.assertFalse(t.azuriraj(0, 0))
        t.azuriraj(1, 100)
        self.assertTrue(t.azuriraj(0, 400))


if __name__ == "__main__":
    unittest.main()
