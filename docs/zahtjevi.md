# Nadzor hladnog lanca – zahtjevi (izvorni + dodani)

Polazište je Lukin plan „Nadzor hladnog lanca – podjela zadataka” (16. 11. 2026), koji razrađuje temu 10 iz zadatka. Tekst plana ostao je nepromijenjen. Sve što smo dodali ili promijenili tijekom izrade i testiranja označeno je:

- **[DODANO]**: novi zahtjev, kojeg u izvornom planu nema.
- **[PROMIJENJENO]**: izvorni zahtjev se drukčije ostvaruje. ~~Precrtano~~ je izvorni tekst, a iza njega stoji novi s razlogom.
- Sve ostalo je izvorni tekst plana.

Kod je u repozitoriju https://github.com/jseketa-fipu/IOT-hladni_lanac (`project/main.py`, `project/hladni_lanac.py`), a simulator se otvara na https://jseketa-fipu.github.io/IOT-hladni_lanac/.

## Izvorni zadatak (tema 10, nastavnikove upute)

> Sustav nadzire temperaturu u hladnjači i bilježi sva prekoračenja.
> **Obavezno:** očitavanje DS18B20 svakih 10 s; zapis mjerenja u CSV datoteku na microSD kartici; alarm LED-om i porukom u serijskom monitoru ako temperatura bude izvan 2–8 °C dulje od 2 min.
> **Dodatno:** dnevni sažetak (min., max., prosjek, ukupno vrijeme izvan raspona).
> Opće upute: sustav prikazuje ili bilježi izmjerene podatke i reagira na barem jedan ulaz korisnika. Predaje se izvorni kod, shema spajanja, izvještaj (PDF, 3–5 str.), prezentacija (8–10 slajdova) i poveznica na projekt u simulatoru.

## Pregled

Sustav na Pico W u Wokwiju svakih 10 s mjeri temperaturu DS18B20 senzorom, zapisuje je u CSV na microSD karticu i pali LED s porukom ako je temperatura izvan 2–8 °C dulje od 2 min. Tipkalo je obavezni korisnički ulaz, a dnevni sažetak donosi višu ocjenu.

Predaje se: poveznica na Wokwi projekt, izvorni kod, shema spajanja, izvještaj (PDF, 3–5 str.) i prezentacija (8–10 slajdova).

**[DODANO]** Isti `main.py` radi i u vlastitom simulatoru (pico-sim) na GitHub Pages. Simulator pokreće pravi MicroPython firmware na emuliranom RP2040 čipu, ima modele svih dijelova i automatske testove, a kod se uređuje zajedno preko gita (vidi Zadatak 9).

| # | Zadatak | Vlasnik | Ovisi o |
| --- | --- | --- | --- |
| 1 | SD kartica i CSV zapis | Luka | — |
| 2 | Senzor DS18B20 | Luka | — |
| 3 | Logika alarma | Marko | — (testira se izmišljenim temperaturama) |
| 4 | LED i tipkalo | Marko | — |
| 5 | Dnevni sažetak | Luka | 3 |
| 6 | Glavna petlja | Luka | 1–5 |
| 7 | Testiranje | Zajedno | 6 |
| 8 | Predaja: shema, izvještaj, prezentacija | Zajedno | 7 |
| 9 | **[DODANO]** Simulator pico-sim i automatski testovi | Josip | 1–6 |

Svi moraju znati objasniti cijeli kod, ne samo svoj dio.

## Definicije pinova

Svi zadaci mogu se zasebno programirati pa na kraju spojiti u main.py.

**[DODANO]** Sva logika odluke (raspon, alarm, sažetak, tipkalo, oblik redaka) izdvojena je u `hladni_lanac.py`, bez `machine` i `time`. U `main.py` ostaje samo sklopovlje i raspored. *Zašto:* ista se logika izvodi na Picu i u običnom Pythonu na računalu, pa se može testirati u sekundi, bez simulatora.

**Pinovi**

| Dio | Pin dijela | Pin na Picu | Napomena |
| --- | --- | --- | --- |
| microSD | SCK / DI / DO / CS | GP2 / GP3 / GP4 / GP5 | VCC na 3V3(OUT), GND na GND, CD ostaje nespojen |
| DS18B20 | DQ | GP15 | otpornik 4,7 kΩ između DQ i 3V3; VCC na 3V3, GND na GND |
| LED | anoda | GP16 | preko otpornika 220 Ω, katoda na GND |
| Tipkalo | jedna strana | GP14 | druga strana na GND, u kodu `Pin.PULL_UP` |
| DS1307 RTC | SDA / SCL | GP8 / GP9 | I²C0; ~~VCC na 3V3~~ **[PROMIJENJENO]** 5V na VBUS; GND na GND |

**[PROMIJENJENO] DS1307 se napaja s VBUS (5 V), ne s 3V3.** Wokwijev DS1307 modul ima priključak 5V, a pravi DS1307 treba 4,5–5,5 V. *Zašto:* na 3,3 V pravi čip ne radi pouzdano. Kad se tako spoji kao na shemi, mora se uskladiti i tablica spojeva u izvještaju.

**[DODANO] Tipkalo se spaja dijagonalno:** `btn1:2.r` na GP14 i `btn1:1.l` na GND. Wokwijevo tipkalo ima dva para nožica, 1.l–1.r i 2.l–2.r, koji su iznutra uvijek spojeni. Pritisak spaja par 1 s parom 2. *Zašto:* ako su obje žice na istom paru, GP14 je trajno na GND i pritisak se nikad ne prepozna. „Druga strana” iz tablice znači drugi par nožica.

**Konstante** (na vrhu `main.py`)

```python
INTERVAL_MJERENJA_MS = 10_000     # 10 s
T_MIN = 2.0                       # °C
T_MAX = 8.0                       # °C
ALARM_KASNJENJE_MS = 120_000      # 2 min
CSV_PUTANJA = "/sd/hladnjaca.csv"
```

**[DODANO]** konstante:

```python
SAZETAK_PUTANJA = "/sd/sazetak.csv"
PRETVORBA_MS = 750                # DS18B20 treba do 750 ms za mjerenje
DEBOUNCE_MS = 200
ZADNJIH_REDAKA = 10               # koliko redaka CSV-a ispisuje tipkalo
PAUZA_PETLJE_MS = 10
```

**Imena funkcija** (svatko piše svoje, glavna petlja ih samo poziva)

```python
# Luka
init_sd()                          # montira karticu, po potrebi piše zaglavlje
zapisi_csv(datum_vrijeme, temp, stanje)
ispisi_csv()
init_rtc()
trenutno_vrijeme()                 # vraća tekst, npr. "2026-11-17 14:05:30"
init_senzor()
procitaj_temp()                    # vraća float u °C ili None ako očitanje ne uspije
azuriraj_sazetak(temp, stanje, dt_ms)   # stanje = rezultat provjeri_alarm
ispisi_sazetak()
resetiraj_sazetak()

# Marko
provjeri_alarm(temp, sada_ms)      # vraća stanje: "U_RASPONU", "ODBROJAVANJE" ili "ALARM"
postavi_led(upaljena)
tipkalo_pritisnuto()               # True samo jednom po pritisku
```

**[PROMIJENJENO] Potpisi u kodu:**

- ~~`resetiraj_sazetak()`~~ je `resetiraj_sazetak(datum)`. *Zašto:* sažetak mora znati kojem danu pripada, da bi se dan mogao zatvoriti i zapisati pod svojim datumom.
- `init_sd(tiho=False)`. *Zašto:* kad kartice nema, ponovno se traži prije svakog mjerenja (`tiho=True`), a neuspjeh se ne ispisuje svakih 10 s.
- `ispisi_csv(n=10)`. *Zašto:* tipkalo ispisuje zadnjih 10 redaka. `ispisi_csv(None)` ispisuje cijelu datoteku (Zadatak 4).

**[DODANO] Funkcije koje plan nema:**

```python
pokreni_mjerenje()                 # pokreće pretvorbu DS18B20; čita se 750 ms kasnije
zavrsi_dan(novi_datum)             # ispis [DNEVNI SAZETAK], redak u sazetak.csv, reset
procitaj_vrijeme(od_pokretanja_ms) # (datum_vrijeme, kljuc_dana), s RTC-a ili bez njega
uptime_ms()                        # ms od pokretanja, preživi preljev ticks_ms
obradi_mjerenje(temp, zakazano_ms) # cijeli redoslijed jednog mjerenja
obradi_tipkalo()                   # potvrda alarma, sažetak, zadnji retci CSV-a
```

U `hladni_lanac.py` su: `NadzorAlarma`, `Sazetak`, `Tipkalo`, `valjano_ocitanje`, `promjena_dana` i funkcije za oblik teksta (`redak_csv`, `redak_mjerenja`, `format_trajanje`…).

**Sučelje:** `provjeri_alarm` vraća stanje, a glavna petlja to isto stanje predaje u `zapisi_csv`, `postavi_led` i `azuriraj_sazetak`. Raspon 2–8 °C provjerava se samo na jednom mjestu, pa se CSV, LED i sažetak ne mogu razići.

**[PROMIJENJENO]** LED ne dobiva samo stanje, nego `nadzor.led_upaljena()`, što znači „ALARM i još nije potvrđen tipkalom”. *Zašto:* potvrda alarma (Zadatak 4) gasi LED, a stanje u CSV-u ostaje `ALARM`.

**Rad u Wokwiju:** Wokwi nema zajedničko uređivanje. Luka je vlasnik glavnog projekta, Marko radi u svojoj kopiji (Save a copy) i šalje gotove funkcije koje se lijepe u `main.py`.

**[DODANO]** U pico-simu kod je u git repozitoriju, pa svatko radi na svom računalu i promjene se spajaju gitom. Isti `main.py` i `diagram.json` mogu se zalijepiti natrag u Wokwi.

## Zadatak 1: SD kartica i CSV zapis (Luka)

- **Montiranje kartice preko SPI-ja** – SPI0 na GP2–GP5, driver `sdcard.py`, kartica montirana na `/sd`. *Zašto:* zadatak traži trajni zapis mjerenja, a bez montiranja MicroPython ne vidi karticu kao mapu.
- **Zaglavlje samo ako datoteka ne postoji** – `datum_vrijeme,temperatura_c,stanje`. *Zašto:* inače se zaglavlje ponavlja usred podataka pri svakom pokretanju i CSV se ne može čisto otvoriti u Excelu.
- **Jedan redak po mjerenju** – datum i vrijeme s RTC-a, temperatura na 2 decimale i stanje alarma. *Zašto:* iz zapisa se mora moći rekonstruirati što se događalo, kao kod stvarnih zapisivača hladnog lanca, i to je dokaz za izvještaj.
- **Dodavanje na kraj i zatvaranje datoteke** – način `"a"` i `with open(...)`. *Zašto:* `"w"` briše stare podatke, a nezatvorena datoteka može izgubiti zadnji zapis.
- **Oznaka greške kad mjerenje izostane** – `greska` umjesto temperature. *Zašto:* rupa u podacima mora biti vidljiva, a ne skrivena.
- **Ispis CSV-a u serijski monitor** – funkcija `ispisi_csv()`, poziva se na tipkalo. *Zašto:* kartica u Wokwiju se pri novom pokretanju simulacije prazni, pa je ovo način da se podaci izvuku.
- **Rad bez kartice ako zakaže** – `try/except OSError` oko montiranja i zapisa. *Zašto:* nadzor i alarm važniji su od zapisa, pa kvar kartice ne smije zaustaviti program.
- **[DODANO] Kartica umetnuta kasnije ili vraćena nakon vađenja** – pri grešci zapisa kartica se odmontira, a prije svakog mjerenja ponovno se pokušava montirati, tiho. Poruka o grešci ispisuje se jednom. *Zašto:* prije je jedna greška (npr. kartica na trenutak ispala) zaustavljala zapis do kraja rada, bez ikakvog upozorenja nakon prve poruke. Kartica umetnuta tek nakon pokretanja nije se nikad koristila.
- **[DODANO] Broj redaka i čitanje samo kraja datoteke** – broj redaka mjerenja broji se jednom pri pokretanju. `ispisi_csv()` čita samo zadnjih ~1 KB datoteke. *Zašto:* u danu ima 8640 mjerenja, a čitanje cijele datoteke na svaki pritisak blokiralo bi petlju i trošilo RAM.
- **[DODANO] Cijela datoteka preko REPL-a** – Ctrl+C u serijskom monitoru, pa `ispisi_csv(None)`. Datoteka se ispisuje redak po redak. *Zašto:* u Wokwiju je to jedini način da se izvuku svi podaci.

**DS1307 RTC** – spojen na I²C0 (GP8/GP9), driver `ds1307.py` dodan u projekt kao i `sdcard.py` jer ga MicroPython nema ugrađenog, funkcije `init_rtc()` i `trenutno_vrijeme()`. *Zašto:* CSV tada ima stvarni datum i vrijeme kao pravi zapisivač hladnog lanca, a dnevni sažetak radi se po kalendarskom danu.

- **[DODANO] Rad bez RTC-a** – ako se sat ne javi pri pokretanju (probno čitanje u `init_rtc()`) ili prestane raditi tijekom rada, vrijeme je od pokretanja: `+HH:MM:SS`. Ključ dana je `dan 1`, `dan 2`… (svakih 24 h). *Zašto:* zapis i sažetak rade i bez sata, a iz oznake se vidi da vrijeme nije stvarno.

## Zadatak 2: Senzor DS18B20 (Luka)

- **Spajanje s otpornikom od 4,7 kΩ** – DQ na GP15, otpornik između DQ i 3V3. *Zašto:* 1-Wire linija treba pull-up otpornik, bez njega se senzor ne pronalazi.
- **Pronalazak senzora pri pokretanju** – `ds.scan()`, poruka ako je popis prazan. *Zašto:* greška u spajanju vidi se odmah, umjesto da program tiho radi bez podataka.
- **Očitanje u °C uz čekanje pretvorbe** – `convert_temp()`, pa nakon najmanje 750 ms `read_temp()`. *Zašto:* senzoru treba do 750 ms za mjerenje; prerano čitanje vraća staru vrijednost ili 85 °C.
- **Odbacivanje nemogućih vrijednosti** – npr. točno 85,0 °C ili vrijednost izvan raspona senzora (−55 do 125 °C). *Zašto:* jedno lažno očitanje ne smije pokrenuti odbrojavanje alarma.
- **`None` pri neuspjelom očitanju** – `try/except` oko čitanja. *Zašto:* glavna petlja nastavlja rad i zna da je mjerenje izostalo.
- **Čekanje bez blokiranja (poželjno)** – zapamtiti trenutak pokretanja pretvorbe i pročitati kad prođe 750 ms. *Zašto:* tipkalo ostaje responzivno i tijekom mjerenja.
- **[DODANO] Senzor priključen nakon pokretanja** – ako ga `scan()` ne nađe, traži se ponovno pri svakom mjerenju. *Zašto:* labav spoj ili senzor priključen kasnije ne smije trajno ugasiti mjerenje.
- **[DODANO] Početak pretvorbe bilježi se tek nakon `convert_temp()`** – a ne prije traženja senzora. *Zašto:* traženje tek priključenog senzora traje nekoliko ms, pa se čitalo prerano i prvo mjerenje bilo je 85 °C (odbačeno).
- **[DODANO] Poruka o grešci senzora jednom, i poruka o oporavku** – ista greška ne ponavlja se svakih 10 s, a kad očitanje ponovno uspije, ispisuje se `[SENZOR] ocitanje ponovno uspijeva`. Odbacuje se i NaN. Iznimka bez teksta (npr. `OneWireError()`) ispisuje se imenom tipa, a ne kao `()`. *Zašto:* monitor ostaje čitljiv, a iz zapisa se vidi i kad je kvar počeo i kad je prestao.
- **[DODANO] Razlučivost 1/16 °C** – senzor vraća temperaturu u koracima od 0,0625 °C, pa postavljenih 8,04 °C očita kao 8,06 °C, što je već izvan raspona. *Zašto:* granični testovi (8,0 °C i blizu njega) moraju koristiti vrijednosti na tom koraku. Simulator prikazuje vrijednost koju će senzor stvarno javiti.

## Zadatak 3: Logika alarma (Marko)

- **Provjera raspona 2–8 °C, granice uključene** – `T_MIN <= temp <= T_MAX`. *Zašto:* 2–8 °C je uobičajen raspon za čuvanje lijekova i cjepiva, a jasno definirane granice izbjegavaju nesporazum pri testiranju.
- **Tri stanja** – U\_RASPONU, ODBROJAVANJE i ALARM. *Zašto:* zasebno stanje odbrojavanja sprečava lažne alarme pri kratkim promjenama, npr. kad se otvore vrata hladnjače.
- **Pamćenje početka prekoračenja** – vrijeme računati s `time.ticks_diff`. *Zašto:* kriterij je trajanje, a ne broj očitanja; `ticks_diff` ispravno radi i kad brojač milisekundi prijeđe preko maksimuma.
- **Poništavanje odbrojavanja pri povratku u raspon** *Zašto:* alarm se pali samo za neprekidno prekoračenje dulje od 2 min.
- **Alarm: LED i jedna poruka** – poruka s temperaturom i trajanjem, označena npr. `[ALARM]`. *Zašto:* obavijest je i vizualna i zapisana, a ne ponavlja se svakih 10 s da ne zatrpa monitor.
- **Gašenje alarma i poruka o povratku** – s ukupnim trajanjem prekoračenja. *Zašto:* u hladnom lancu je bitno koliko je dugo roba bila izvan raspona.
- **Neuspjelo očitanje ne mijenja stanje** *Zašto:* izostalo mjerenje nije dokaz da je temperatura u redu.
- **Testiranje izmišljenim temperaturama** – niz poziva s poznatim vrijednostima i vremenima. *Zašto:* logika se može provjeriti prije nego senzor i ostatak sustava rade.
- **[DODANO] „Dulje od 2 min” znači strogo više od 120 s, mjereno od prvog mjerenja izvan raspona.** Uz mjerenje svakih 10 s alarm se pali na 14. mjerenju izvan raspona: 130 s nakon prvog takvog mjerenja, odnosno 130–140 s nakon stvarne promjene temperature. *Zašto:* mjerenje točno na 120 s još nije „dulje od” 2 min. Prekoračenje od 2 min 5 s između dva mjerenja program vidi kao 120 s i ne alarmira. To je ograničenje uzorkovanja od 10 s i ide u izvještaj.
- **[DODANO] Vrijeme se računa iz planiranih trenutaka mjerenja** (`zakazano_ms`, točno svakih 10 s), a ne iz trenutka kad petlja stigne do mjerenja. *Zašto:* kašnjenje petlje (npr. dok se ispisuje CSV) ne smije pomaknuti trenutak alarma ni trajanje u poruci.
- **[DODANO] Senzor iskopčan tijekom alarma** – alarm i LED ostaju upaljeni. *Zašto:* to je posljedica pravila „neuspjelo očitanje ne mijenja stanje”, provjereno u simulatoru.

## Zadatak 4: LED i tipkalo (Marko)

- **LED na GP16 preko otpornika od 220 Ω** – funkcija `postavi_led(upaljena)`. *Zašto:* otpornik ograničava struju kroz LED, a LED je lokalni pokazatelj alarma.
- **Tipkalo na GP14 s internim pull-upom** – `Pin(14, Pin.IN, Pin.PULL_UP)`, druga strana na GND. *Zašto:* bez pull-upa ulaz „pluta” i daje nasumične pritiske.
- **Prepoznavanje trenutka pritiska** – prijelaz s 1 na 0, ne držanje. *Zašto:* petlja se vrti stotinama puta u sekundi, pa bi se jedan pritisak pročitao kao mnogo njih.
- **Debounce oko 200 ms** *Zašto:* mehanički kontakti kratko „titraju”, pa jedan pritisak izgleda kao više.
- **Akcija na pritisak** – ispis trenutnog sažetka i CSV-a. *Zašto:* opće upute traže reakciju na barem jedan korisnički ulaz, a ovo daje pregled bez čekanja kraja dana.
- **Po želji: potvrda alarma** – npr. pritisak tijekom alarma gasi LED dok se ne pojavi novo prekoračenje. *Zašto:* tako rade stvarni sustavi, osoblje potvrdi da je primijetilo problem.
- **[PROMIJENJENO] Debounce:** Markova verzija imala je 30 ms. U kodu je 200 ms, kao u planu (`DEBOUNCE_MS`). Pritisak se prihvaća samo ako je ulaz prije toga bio stabilno 1 barem 200 ms, pa se filtrira titranje i pri pritisku i pri otpuštanju. *Zašto:* plan traži oko 200 ms, a titranje mehaničkih tipki može trajati i dulje od 30 ms.
- **[PROMIJENJENO] Akcija na pritisak:** ispisuje se sažetak i ~~CSV~~ zadnjih 10 redaka CSV-a. *Zašto:* cijeli CSV ima 8640 redaka na dan i ispis bi minutama blokirao petlju (i mjerenje). Cijela datoteka dobiva se preko REPL-a (Zadatak 1).
- **[DODANO] Potvrda alarma je ostvarena** – pritisak tijekom alarma ispisuje `[POTVRDA] alarm potvrden, LED ugasena do novog prekoracenja`, pa sažetak i CSV. Stanje u CSV-u ostaje `ALARM`. Nova poruka i LED dolaze tek nakon povratka u raspon i novog prekoračenja.

## Zadatak 5: Dnevni sažetak (Luka)

- **Minimum i maksimum** *Zašto:* pokazuju najgori slučaj u danu, što je prvo što se gleda kod provjere hladnog lanca.
- **Prosjek** – zbroj podijeljen brojem uspješnih mjerenja. *Zašto:* daje opći dojam kako je hladnjača radila.
- **Ukupno vrijeme izvan raspona** – zbroj stvarnih razmaka između mjerenja (`dt_ms`) za mjerenja kojima stanje nije `U_RASPONU`, ispis u minutama i sekundama. *Zašto:* o tom podatku ovisi odluka je li roba još upotrebljiva.
- **Broj alarma u danu** – broji se svaki prijelaz stanja u `ALARM`. *Zašto:* pokazuje koliko je bilo ozbiljnih događaja.
- **Preskočena neuspjela očitanja i „nema mjerenja”** *Zašto:* prosjek ostaje točan i nema dijeljenja s nulom.
- **Ispis na kraju dana i reset** – `ispisi_sazetak()` pa `resetiraj_sazetak()`. *Zašto:* svaki dan dobiva vlastiti izvještaj.
- **Test kraja dana** – sat na RTC-u postaviti na 23:58 i pričekati ponoć. *Zašto:* 24 sata nije realno čekati u simulatoru.
- **Po želji: zapis u `/sd/sazetak.csv`** *Zašto:* sažeci ostaju zapisani uz mjerenja.
- **[PROMIJENJENO] Kraj dana:** ~~`ispisi_sazetak()` pa `resetiraj_sazetak()`~~ `zavrsi_dan(novi_datum)` ispisuje `[DNEVNI SAZETAK]`, zapisuje redak u `/sd/sazetak.csv` i poziva `resetiraj_sazetak(novi_datum)`. `ispisi_sazetak()` ostaje za tipkalo i ispisuje `[SAZETAK]` za tekući dan. *Zašto:* iz monitora se vidi razlika između završenog dana i međustanja.
- **[DODANO] Broj neuspjelih očitanja u sažetku.** Zapis u `sazetak.csv` je ostvaren, sa stupcima `datum,broj_mjerenja,min_c,max_c,prosjek_c,izvan_raspona_s,broj_alarma,neuspjela_ocitanja`. *Zašto:* dan s mnogo izostalih mjerenja nije pouzdan, iako min/max izgledaju dobro.
- **[DODANO] Prvo mjerenje broji se kao da je prethodno bilo 10 s ranije.** *Zašto:* vrijeme izvan raspona u sažetku tada je jednako trajanju u poruci `[ALARM KRAJ]`, i kad je temperatura izvan raspona već pri pokretanju.
- **[DODANO] Alarm preko ponoći broji se jednom** – prethodno stanje preživi reset dana. *Zašto:* inače bi isti alarm bio u sažetku dva dana.
- **[DODANO] Sat vraćen unatrag** (ručno namješten, ili DS1307 prijeđe iz 2099. u 2000.) – dan se ne zatvara. Jednom se ispisuje `[RTC] sat je vracen unatrag (…), dnevni sazetak i dalje vodi dan …`, a mjerenja se dodaju tekućem danu. Dan se zatvara tek kad datum ode naprijed. *Zašto:* prije se isti datum pojavio dvaput u `sazetak.csv`.
- **[DODANO] RTC izgubljen ili pronađen tijekom rada** – prijelaz između datuma s RTC-a i `dan N` ne zatvara dan. *Zašto:* gubitak sata nije kraj dana, a prije je davao lažni dnevni sažetak.

**Kraj dana prema RTC-u** – sažetak se ispisuje i resetira kad se datum na RTC-u promijeni. *Zašto:* sažetak pokriva stvarni kalendarski dan.

## Zadatak 6: Glavna petlja (Luka)

- **Konstante na vrhu datoteke** – interval, granice, kašnjenje alarma, putanja CSV-a. *Zašto:* za test se vrijednosti mijenjaju na jednom mjestu.
- **Inicijalizacija i početna poruka** – kartica, RTC, senzor, sažetak, ispis granica 2–8 °C. *Zašto:* odmah se vidi je li sustav ispravno pokrenut.
- **Prvo mjerenje odmah** *Zašto:* ne čeka se 10 s na prvi podatak.
- **Mjerenje svakih 10 s bez `sleep(10)`** – usporedba vremena s `ticks_diff`. *Zašto:* petlja ostaje slobodna za tipkalo i kraj dana.
- **Redoslijed za svako mjerenje** – očitanje, alarm, LED, CSV, sažetak, ispis jednog retka. *Zašto:* CSV bilježi stanje nakon provjere alarma, pa zapis, LED i ispis uvijek govore isto.
- **Provjera tipkala u svakom prolazu** *Zašto:* kratki pritisci se ne propuštaju.
- **Provjera kraja dana** – usporedba datuma s RTC-a s datumom prethodnog mjerenja. *Zašto:* sažetak se ispisuje i resetira u ponoć.
- **Kratka pauza na kraju prolaza** – `time.sleep_ms(10)`. *Zašto:* petlja ne troši procesor bez potrebe.
- **[PROMIJENJENO] Redoslijed:** očitanje, **kraj dana**, **ponovno traženje kartice ako je nema**, alarm, LED, CSV, sažetak, ispis retka. *Zašto:* mjerenje u 00:00:05 pripada novom danu, pa se stari dan zatvara prije nego mu se doda. Kartica vraćena u međuvremenu prima već to mjerenje.
- **[DODANO] Raspored bez gomilanja** – trenutci mjerenja su točno svakih 10 s (`ticks_add`). Ako petlja jako zakasni, propuštena mjerenja se ne sustižu, nego se raspored nastavlja od sada. *Zašto:* nakon dugog zastoja ne smije doći niz mjerenja jedno za drugim.
- **[DODANO] Vrijeme od pokretanja zbraja `ticks_diff`** – `uptime_ms()`. *Zašto:* `ticks_ms()` se nakon nekoliko dana prelije, a oznake `+HH:MM:SS` i `dan N` (bez RTC-a) moraju ostati točne.
- **[DODANO] Početna poruka** sadrži i interval, kašnjenje alarma i što radi tipkalo. Ctrl+C i ponovno pokretanje (soft reset) ne dupliciraju zaglavlje CSV-a.

## Zadatak 7: Testiranje (zajedno)

- **Normalan rad (5 °C)** – očekivano: redak svakih 10 s, LED ugašena. *Zašto:* provjerava osnovno mjerenje i zapis.
- **Kratko prekoračenje (10 °C 1 min, pa 5 °C)** – očekivano: bez alarma. *Zašto:* dokazuje da nema lažnih alarma.
- **Dugo prekoračenje iznad (10 °C dulje od 2 min)** – očekivano: ~~alarm nakon 2:00–2:10 min~~ **[PROMIJENJENO]** alarm 2:10–2:20 min nakon promjene temperature, odnosno točno 130 s nakon prvog mjerenja izvan raspona (Zadatak 3). *Zašto:* glavni zahtjev zadatka; zabilježiti točno vrijeme do alarma.
- **Dugo prekoračenje ispod (0 °C dulje od 2 min)** – očekivano: alarm. *Zašto:* prehladno je jednako problem kao pretoplo, npr. smrzavanje cjepiva.
- **Prijelaz s iznad na ispod raspona** – očekivano: alarm, jer je temperatura neprekidno izvan raspona. *Zašto:* provjerava rubni slučaj logike.
- **Povratak nakon alarma** – očekivano: LED ugašena, poruka s trajanjem. *Zašto:* alarm se mora i ugasiti, ne samo upaliti.
- **Granice 2,0 i 8,0 °C** – očekivano: u rasponu. *Zašto:* ovdje se najčešće javljaju greške s `<` i `<=`.
- **Tipkalo** – očekivano: jedan ispis po pritisku. *Zašto:* provjerava debounce i obavezni korisnički ulaz.
- **Dnevni sažetak uz RTC postavljen na 23:58** – očekivano: vrijednosti se poklapaju s ručnim izračunom. *Zašto:* potvrđuje dodatni zahtjev za višu ocjenu.
- **Snimka serijskog monitora za svaki scenarij** *Zašto:* izvještaj traži rezultate testiranja, a snimke su dokaz.

**[DODANO] Automatski testovi** (svi se pokreću s `npm test`, i na GitHubu pri svakoj promjeni):

- **Logika (45 testova, Python na računalu, ispod sekunde)** – `test/python/test_hladni_lanac.py` testira `hladni_lanac.py`: raspon i granice, alarm (130 s, poništavanje, prijelaz iznad/ispod, `None`, preljev `ticks`), sažetak, debounce, promjenu dana i oblik redaka. Ovo je Markov „test izmišljenim temperaturama”, ali kao trajni test.
- **Simulacija (78 testova, pravi MicroPython na emuliranom Picu, oko minute)** – cijeli `main.py` s modelima senzora, kartice i sata, ubrzano. Svi ručni scenariji iz popisa gore postoje i kao automatski test.
- **Preglednik (9 provjera)** – stranica simulatora: pokretanje, klizač temperature, tipkalo, LED, pregled CSV-a s kartice i alarm na 10× brzini.

**[DODANO] Dodatni scenariji** (rubni slučajevi; automatski test, osim onih označenih „ručno”, koji su provjereni s `npm run sim`):

- Kartica izvađena tijekom rada pa vraćena. Očekivano: jedna poruka o grešci, zapis se nastavlja od sljedećeg mjerenja.
- Kartica umetnuta tek nakon pokretanja. Očekivano: koristi se od sljedećeg mjerenja.
- Bez kartice. Očekivano: poruka, mjerenje i alarm rade, a tipkalo javlja da nema zapisa.
- Senzor priključen tek nakon pokretanja. Očekivano: prvo mjerenje je ispravno, a ne 85 °C.
- Senzor iskopčan tijekom alarma (ručno). Očekivano: alarm ostaje, redak je `greska`.
- Kratki pad napajanja senzora tijekom pretvorbe. Očekivano: 85 °C se odbacuje.
- Sat vraćen unatrag preko ponoći. Očekivano: jedno upozorenje `[RTC]`, nema dvostrukog sažetka.
- Bez RTC-a. Očekivano: oznake `+HH:MM:SS` i `dan 1`.
- Vrlo kratki pritisci (30 ms), i baš u trenutku mjerenja (ručno). Očekivano: svaki se broji jednom.
- Potvrda alarma tipkalom. Očekivano: LED se gasi, a novo prekoračenje je ponovno pali.
- Ctrl+C i soft reset (ručno). Očekivano: čisto ponovno pokretanje, bez drugog zaglavlja CSV-a.
- 8,04 °C. Očekivano: senzor javlja 8,06 °C, što je izvan raspona (razlučivost 1/16 °C).

## Zadatak 8: Predaja

- **Poveznica na Wokwi projekt** – dijeljena tako da je otvara i neprijavljen korisnik. *Zašto:* nastavnik mora moći pokrenuti simulaciju.
- **Izvorni kod s komentarima** *Zašto:* olakšava ocjenjivanje i obranu.
- **Shema spajanja** – snimka iz Wokwija i tablica spojeva. *Zašto:* provjerava se je li sklop ispravno spojen.
- **Izvještaj (PDF, 3–5 str.)** – uvod, sklop, rad sustava, rezultati testiranja, ograničenja, zaključak. *Zašto:* obavezni dio predaje; ograničenja (kašnjenje alarma do 10 s, kartica u Wokwiju se pri svakom pokretanju prazni) pokazuju da razumijete sustav.
- **Prezentacija (8–10 slajdova)** – problem, komponente, shema, tok programa, logika alarma, rezultati, demo. *Zašto:* obavezni dio predaje i podloga za izlaganje.
- **Obojica znaju objasniti cijeli kod** *Zašto:* na obrani se može pitati bilo koga o bilo kojem dijelu.
- **[PROMIJENJENO] Ograničenja u izvještaju:** ~~kašnjenje alarma do 10 s~~ alarm dolazi 10–20 s nakon 2 min (130–140 s od promjene temperature). Dodati i: prekoračenje kraće od ~2 min 10 s može proći bez alarma zbog uzorkovanja od 10 s; razlučivost senzora je 1/16 °C; mjerenja dok kartice nema nisu na kartici (ispisana su u monitoru).
- **[DODANO] Poveznica na pico-sim i repozitorij** uz Wokwi: https://jseketa-fipu.github.io/IOT-hladni_lanac/ i https://github.com/jseketa-fipu/IOT-hladni_lanac. *Zašto:* ondje se mogu pokrenuti i automatski testovi, a kartica čuva datoteke između pokretanja i može se preuzeti.
- **[DODANO] Rezultati automatskih testova u izvještaju** – broj testova i popis scenarija iz Zadatka 7. *Zašto:* to su ponovljivi rezultati testiranja, a ne samo snimke zaslona.

## Zadatak 9: Simulator pico-sim i automatski testovi (Josip) [DODANO]

Cijeli zadatak je dodan. Plan ga nema.

- **Vlastiti simulator u pregledniku** – rp2040js (Wokwijev emulator RP2040 čipa, otvoren kod) i službeni MicroPython 1.22 za Pico W, kao u Wokwiju. Stranica je na GitHub Pages. *Zašto:* Wokwi nema zajedničko uređivanje ni automatske testove.
- **Modeli dijelova** – DS18B20 (1-Wire, pretvorba 750 ms, 85 °C nakon uključenja, koraci od 1/16 °C, CRC), microSD (SPI, FAT), DS1307 (I²C, broji simulirano vrijeme, godine 2000–2099). Shema se crta iz istog `diagram.json` formata kao u Wokwiju, a krivo spojen dio se označi. *Zašto:* program se testira protiv ponašanja pravih čipova, uključujući njihove greške.
- **Ploča „Parts”** – temperatura (klizač ili broj), iskopčavanje senzora, vađenje kartice, pregled i preuzimanje datoteka s kartice, namještanje sata i „skok na 23:58”. *Zašto:* svaki scenarij iz Zadatka 7 izvodi se klikom.
- **Brzina 1×, 5×, 10×, 20×, Max** – program se ponaša jednako, samo se kraće čeka (alarm na 10× za ~13 s). *Zašto:* test od 2 min i ponoć ne traže stvarno čekanje.
- **Rad na računalu** – `npm run dev` (stranica s automatskim osvježavanjem pri spremanju `main.py`), `npm run test:watch` (testovi pri svakom spremanju), `npm run sim` (pokretanje u terminalu, ubrzano, s provjerama). *Zašto:* promjena koda se odmah vidi i provjeri.
- **CI na GitHubu** – svaka promjena pokreće sve testove prije objave stranice. *Zašto:* pokvarena verzija ne može na stranicu.
- **Popravak u emulatoru prijavljen autorima** – rp2040js je na prazno USB čitanje odgovarao ~35 000 prekida u sekundi, pa je simulacija bila 5× sporija od stvarnog vremena. U pico-simu je zaobiđeno, a popravak je poslan autorima wokwi/rp2040js: issue #162 i PR #163 (još nije prihvaćen).
