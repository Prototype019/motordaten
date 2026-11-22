# Motordaten

Eigene Fahrzeugdaten-Apps für BMW iDrive 8 (MGU), installiert über den
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Was sie tut |
|---|---|
| **Motordaten** (`km_motordaten`) | Eigene gezeichnete Oberfläche über `mgu-render`. Live aus Motor und Getriebe über das Diagnose-Gateway der Headunit, nur lesend, etwa 10-mal pro Sekunde: Drehzahl, Ladedruck mit Soll, Leistung aus der gemessenen Luftmasse und Drehmoment, Öldruck, Öl-, Kühlmittel-, Ansaugluft-, Getriebeöl- und Abgastemperatur mit Temperaturbalken, Klopfregelung mit Zylinder, Bordnetz. Bereit-Anzeige für Volllast. Aufzeichnungen mit Diagrammen (auch Lambda, Raildruck, Klopfen je Zylinder) und USB-Export, Fehlerspeicher aller Steuergeräte mit Klartext. Einstellungen als Liste: Fahrzeug (Grenzwerte, Bereit für Volllast, MHD-Tuning) und App (beim ersten Motorstart einer Fahrt von selbst öffnen, Reihenfolge der Temperaturen zurücksetzen). |
| **HUD** (`km_hudtest`) | Warmfahren und Werte im Head-up-Display, über den Cluster renderer von `robertnisipeanu/idrive-apps` (der Store installiert ihn mit). Warmfahren: Öl bzw. Kühlmittel in Blau, bis alles bereit ist, dann kurz „Bereit“ und das HUD ist wieder frei; Öl zu heiß in Rot. Werte: bis zu drei frei gewählte Werte nebeneinander (Öl, Kühlmittel, Drehzahl, Ladedruck, Öldruck, Ansaugluft, Getriebeöl, Bordnetz), Reihenfolge per Ziehen. Position und Größe einstellbar, „Im HUD testen“. Startet mit der Headunit (`mguAppStartType: autostart`), das HUD kommt also ohne die App zu öffnen; läuft auch, wenn die Headunit sie ohne Bildschirm startet. Eigene Oberfläche im Motordaten-Look (Live, Werte, Anzeige, Bereit, Status). Nur lesend: Öl, Kühlmittel und Drehzahl aus dem Fahrzeugsignal (CDS); die übrigen über die Diagnose, nur solange sie im HUD stehen, einmal pro Sekunde. |

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

### HUD

1. Im Store **HUD** installieren (bringt den **Cluster renderer** von `robertnisipeanu/idrive-apps` mit), Headunit neu starten, App öffnen.
2. **Live**: was gerade im HUD steht, Öl und Kühlmittel, Anzeige Warmfahren / Werte / Aus, „Im HUD testen“ (zeigt jede Ansicht ein paar Sekunden).
3. **Werte**: halten und ziehen ändert die Reihenfolge und was im HUD steht, tippen nimmt einen Wert hinein oder heraus (bis zu drei).
4. **Anzeige**: was, wo (links / Mitte / rechts) und wie groß. **Ausrichten** (Knopf oben): das HUD des G87 stellt unser Bild schräg (etwa 30°) und flacher; solange die Seite offen ist, zeigt das HUD ein Raster – Neigung, Versatz, Höhe und Breite einstellen, bis Linien gerade, der Kreis rund und der Rahmen ganz zu sehen ist. **Bereit**: welche Temperaturen fürs Warmfahren zählen, ab wann Öl, Kühlmittel und Drehzahl rot werden.

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
