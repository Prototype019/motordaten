# Motordaten

Eigene Fahrzeugdaten-Apps für BMW iDrive 8 (MGU), installiert über den
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Was sie tut |
|---|---|
| **M Suite** (`km_motordaten`, früher „Motordaten“) | Eigene gezeichnete Oberfläche über `mgu-render`. Live aus Motor und Getriebe über das Diagnose-Gateway der Headunit, nur lesend, etwa 10-mal pro Sekunde: Drehzahl, Ladedruck mit Soll, Leistung aus der gemessenen Luftmasse und Drehmoment, Öldruck, Öl-, Kühlmittel-, Ansaugluft-, Getriebeöl- und Abgastemperatur mit Temperaturbalken, Klopfregelung mit Zylinder, Bordnetz. Bereit-Anzeige für Volllast. Aufzeichnungen mit Diagrammen (auch Lambda, Raildruck, Klopfen je Zylinder) und USB-Export, Fehlerspeicher aller Steuergeräte mit Klartext. Einstellungen als Liste: Fahrzeug (Grenzwerte, Bereit für Volllast, MHD-Tuning) und App (beim ersten Motorstart einer Fahrt von selbst öffnen, Reihenfolge der Temperaturen zurücksetzen, Logs an GitHub). |
| **M Suite HUD** (`km_hudtest`, früher „HUD“) | Warmfahren und Werte im Head-up-Display, über den Cluster renderer von `robertnisipeanu/idrive-apps` (der Store installiert ihn mit). Warmfahren: Öl bzw. Kühlmittel in Blau, bis alles bereit ist, dann kurz „Bereit“ und das HUD ist wieder frei; Öl zu heiß in Rot. Werte: bis zu drei frei gewählte Werte nebeneinander (Öl, Kühlmittel, Drehzahl, Ladedruck, Öldruck, Ansaugluft, Getriebeöl, Bordnetz), Reihenfolge per Ziehen. Position und Größe einstellbar, „Im HUD testen“. Startet mit der Headunit (`mguAppStartType: autostart`), das HUD kommt also ohne die App zu öffnen; läuft auch, wenn die Headunit sie ohne Bildschirm startet. Eigene Oberfläche im Motordaten-Look (Live, Werte, Anzeige, Bereit, Status). Nur lesend: Öl, Kühlmittel und Drehzahl aus dem Fahrzeugsignal (CDS); die übrigen über die Diagnose, nur solange sie im HUD stehen, einmal pro Sekunde. |

Jede App zeigt oben eine Statuszeile, worauf sie wartet oder was fehlschlug.


## Installieren

Im Store: **Settings → Add source** → `Prototype019/motordaten`, Kanal
**Branch main**. Dann die Apps installieren und die Headunit neu starten
(auf iDrive 8 wird eine Installation erst nach dem Neustart aktiv).
Mit Zündung an öffnen.

Von selbst öffnen (Motordaten › Einstellungen › App): beim ersten Motorstart einer Fahrt (Motor vorher mindestens drei
Minuten aus; Start-Stopp öffnet nicht erneut). Motordaten startet dafür mit der Headunit (`mguAppStartType: autostart`,
seit 0.27.0, nachdem die HUD-App gezeigt hat, dass das im G87 geht). Im Hintergrund liest die App nur das Fahrzeugsignal,
nichts über die Diagnose. Ins Protokoll (diag.log) kommt bei jedem Start, ob die Headunit Bildschirme und Kachel mitgab.

Logs an GitHub (Motordaten › Einstellungen › App oder Reiter Logs; HUD › Status): die Protokolle der App ins eigene
GitHub-Repository, über das Internet des Handys (Store-Uplink). Einmal einrichten mit zwei QR-Codes: „Verbinden“
zeigt einen Code für github.com/login/device, danach die GitHub-App „Motordaten Logs“ auf dem gewünschten Repository
installieren. Dann reicht „Logs senden“: je Druck eine Datei `<app>/<Datum_Uhrzeit>.log`. Die App darf nur in die
Repositories schreiben, auf denen der Nutzer sie installiert hat; kein Passwort und kein Schlüssel im Code, der
Zugang bleibt im Datenordner der App im Auto (`shared/github_logs.js`, `shared/qr.js`).

HUD und Navigation (ab 0.5.11): Solange eine Zielführung läuft, bleiben unsere Werte aus dem HUD; endet sie, kommen sie wieder. Gelesen wird nur: BMWs Navigation (Guidance guidanceState ACTIVE) und die Route auf dem Handy (CarPlayManager / AndroidAutoProjectedManager projectedGuidanceActive). Bei einer CarPlay-Route bleibt guidanceState auf INACTIVE (im G87 am 22.11.2026 gesehen, andere App-Autoren beschreiben dasselbe). Im Log steht, was ankommt („Navigation: …“); data/interfaces.txt listet einmal je Version die Schnittstellen des Autos.

HUD kommt von selbst zurück (ab 0.5.4): Nimmt BMW unser Bild für eigenen Inhalt weg (Navigation, Listen) und zeigt es danach nicht wieder (der Renderer meldet dann dauerhaft „angeboten, nicht gezeigt“), bietet die App es neu an: nach 5 s, dann 15, 30 und alle 60 s, bis es wieder zu sehen ist.

HUD „Gerade halten“ (Anzeige): Das G87-HUD legt unser Bild ab und zu schräg (Ursache unbekannt, das Kombi meldet nichts) und behält das, bis das Bild neu übergeben wird. Die App liest dafür das Tempo (Vehicle2 statusCarSpeed2), nur lesend, und übergibt das Bild auf Wunsch neu: „Bei jedem Halt“ nach der Fahrt (etwa 4 s weg, höchstens alle 20 s), „Halt + alle 5 min“ auch während der Fahrt. Seit 0.5.3 steht das auf „Aus“ (das Bild ist seit 352x200 gerade, und das Neu-Übergeben nimmt die Anzeige bei jedem Halt kurz weg). Starkes Bremsen (CDS2) wird nur protokolliert.

M-Tasten (Einstellungen › M-Tasten, ab 0.29.5): Beim G87 lässt sich der M Mode (Road / Sport / Track) nicht auf M1 und M2 speichern. Auf der Seite schaltet man die Funktion ein (ab Werk aus; ohne M-Tasten passiert auch eingeschaltet nichts, weil nur ein gemeldeter Tastendruck zählt) und wählt je Taste, welchen M Mode ein Druck einstellen soll (Nichts: wie ab Werk). **Noch nicht aktiv**: die Auswahl wird gespeichert, geschaltet wird noch nichts – welche Schnittstelle im Auto die M-Tasten meldet und den M Mode annimmt, ist noch nicht bekannt. Die HUD-App (ab 0.5.13) durchsucht dafür den Katalog des Autos (`/etc/oap/someip/someip-interfaces.json`, nur lesend) und legt das Ergebnis als `interfaces.txt` zu den Logs. Die Entscheidung („nur ein Tastendruck zählt, ein Befehl je Druck, von Hand gewählter Mode bleibt") steht in `shared/mmode.js` (`node tools/test_mmode.js`).

Gefunden am 28.11.2026 (HUD 0.6.2, nur mitgelesen): Schnittstelle `de.bmw.infotainment.misc.MDrive`. `statusMDriveThree.statusMDrive3DrivingMode` ist der M Mode (`FAHRMODUS_1` Road, `_2` Sport, `_3` Track), `controlDisplayMSystems.controlDisplayCID` meldet `M1_AKTIV`/`M2_AKTIV` beim Drücken. `mDriveThree` (lesen und setzen) trägt pro M-Setup (`setupMDrive3Index` `KONFIGURATION_1` = M1) einen Fahrmodus. **Test ab M Suite 0.31.0**: Knopf „Test: M1 = Sport" schreibt nur diesen Fahrmodus ins M1-Setup (alles andere `KEINE_AENDERUNG`, nie Track, nur im Stand), „Zurücksetzen" schreibt `KEINE_AENDERUNG` (wie ab Werk). Vorher und nachher wird gelesen, alles steht im Log (`shared/mdrive.js`, `node tools/test_mdrive.js`).

### HUD

1. Im Store **HUD** installieren (bringt den **Cluster renderer** von `robertnisipeanu/idrive-apps` mit), Headunit neu starten, App öffnen.
2. **Live**: was gerade im HUD steht, Öl und Kühlmittel, Anzeige Warmfahren / Werte / Aus, „Im HUD testen“ (zeigt jede Ansicht ein paar Sekunden).
3. **Werte**: halten und ziehen ändert die Reihenfolge und was im HUD steht, tippen nimmt einen Wert hinein oder heraus (bis zu drei).
4. **Anzeige**: was, wo (links / Mitte / rechts) und wie groß. **Ausrichten** (Knopf oben): das HUD des G87 stellt unser Bild schräg (etwa 30°) und flacher; solange die Seite offen ist, zeigt das HUD ein Raster – Neigung, Versatz, Höhe und Breite einstellen, bis Linien gerade, der Kreis rund und der Rahmen ganz zu sehen ist. **Bereit**: welche Temperaturen fürs Warmfahren zählen, ab wann Öl, Kühlmittel und Drehzahl rot werden.
5. **Status › Logs an GitHub**: die Protokolle der HUD-App ins eigene GitHub schicken (Verbinden mit zwei QR-Codes, dann „Logs senden“).

Werte über die Diagnose (Ladedruck, Öldruck, Ansaugluft, Getriebeöl, Bordnetz) fragt die App beim Motor bzw. Getriebe an, solange sie im HUD stehen. Läuft gleichzeitig Motordaten, teilen sich beide die Diagnose-Leitung; wer keine Aussetzer in Motordaten will, nimmt im HUD nur Werte aus dem Fahrzeugsignal.

Vorschau: `docs/design/preview/hud_look_*.png` und `hud_screen_*.png` (`node apps/km_hudtest/tools/preview.js`).

## Lesen und Löschen

Motordaten liest über das Diagnose-Gateway der Headunit, als Tester 0xF4:
`22 <ID>` (ReadDataByIdentifier, bis zu 8 Kennungen), OBD-II `01` / `09` mit einer PID und den
Fehlerspeicher `19 02` (auch an alle Steuergeräte gleichzeitig); Einzelanfragen nur an DME und Getriebe.
Änderungen im Auto gibt es drei: MHD Max Cooling (`2F 03 01` / `2F 03 00` an die DME, nur wenn in den Einstellungen
eingeschaltet, an nur bei laufendem Motor), die MHD-Abgasklappe (`2F 02 00` Auto / `01` Auf / `02` Zu an die DME, nur wenn
in den Einstellungen eingeschaltet, anfangs aus; „Zu“ gibt über 4.000 U/min an die DME ab und schließt unter 3.500 U/min
wieder) und Fehler löschen (`14 FF FF FF`): nur auf Wunsch mit Rückfrage, nur bei Motor aus
und Zündung an, je Steuergerät einzeln, nie die Headunit.
Alles andere lehnt `shared/tasu.js` ab, bevor es das Gateway erreicht: keine
Sitzungswechsel, kein Löschen, kein Schreiben, keine Routinen. Eine Anfrage
nach der anderen, mindestens 25 ms Abstand.

## Entwickeln

```sh
node tools/gen.js                              # alle apps/*/package/ aus apps/*/spec.js
node tools/make_icon.js <id> [r,g,b]           # Kachel-Icon
(cd apps/<id> && node tools/test_app.js)       # App auf einer simulierten Headunit
node apps/km_motordaten/tools/emulator.js --live   # die echte App im Browser, mit simulierter Fahrt
node apps/km_hudtest/tools/emulator.js             # HUD-App im Browser (http://localhost:8788): HUD, App zum Klicken und Ziehen, eine Fahrt im Kreis
```

`shared/` (Listen-Bildschirm, Diagnose-Link, Werte-Tabellen) kopiert `tools/gen.js` in die Apps.
`tools/enet/live.py` zeigt dieselben DME-Werte live am Mac über ein ENET-Kabel.
Die Headunit baut die Apps selbst (`mgu-app.json`, `"build": "unit"`) und
setzt BMWs oap-sdk aus einer vorhandenen BMW-App ein. Das SDK gehört nie in
dieses Repository.

## Lizenz

Copyright (c) 2026 Prototype019. Alle Rechte vorbehalten: installieren und im
eigenen Auto benutzen ja, kopieren, ändern oder weitergeben nein (siehe
[LICENSE](LICENSE)). Ausgenommen sind die Grafik-Bausteine
`shared/kit_record.js`, `kit_canvas.js` und `mgu_render_client.js` (MIT,
cauliflowermossgrape / IterioDev, `shared/LICENSE-kit.txt`), der Renderer-Client
`apps/km_hudtest/src/cluster_render_client.js` (MPL-2.0, Robert Nisipeanu,
`apps/km_hudtest/MPL-2.0.txt`) und die Schrift
Barlow (SIL OFL 1.1, `shared/OFL-Barlow.txt`). Die Kennungen und Umrechnungen
der Motorsteuerung stammen aus der DME8FF_R-Tabelle und dem SGBD-Index von
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT) und
eigenen ENET-Messungen (`docs/g87-s58.md`).
