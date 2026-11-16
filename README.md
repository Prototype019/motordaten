# Motordaten

Eigene Fahrzeugdaten-Apps für BMW iDrive 8 (MGU), installiert über den
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Was sie tut |
|---|---|
| **Motordaten** (`km_motordaten`) | Eigene gezeichnete Oberfläche über `mgu-render`. Live aus Motor und Getriebe über das Diagnose-Gateway der Headunit, nur lesend, etwa 10-mal pro Sekunde: Drehzahl, Ladedruck mit Soll, Leistung aus der gemessenen Luftmasse und Drehmoment, Öldruck, Öl-, Kühlmittel-, Ansaugluft-, Getriebeöl- und Abgastemperatur mit Temperaturbalken, Klopfregelung mit Zylinder, Bordnetz. Bereit-Anzeige für Volllast. Aufzeichnungen mit Diagrammen (auch Lambda, Raildruck, Klopfen je Zylinder) und USB-Export, Fehlerspeicher aller Steuergeräte mit Klartext, alle Grenzwerte einstellbar. |
| **HUD-Test** (`km_hudtest`) | Test: die Öltemperatur schlicht im Head-up-Display (blau bis 70 °C, rot ab 130 °C), über den Cluster renderer von `robertnisipeanu/idrive-apps`. Nur lesend: die Öltemperatur kommt aus dem Fahrzeugsignal (CDS), die Diagnose bleibt frei für Motordaten; nur wenn das Signal fehlt, fragt sie die DME (`22 58 22`, einmal pro Sekunde). Die Liste zeigt, was der Renderer meldet. |

Jede App zeigt oben eine Statuszeile, worauf sie wartet oder was fehlschlug.


## Installieren

Im Store: **Settings → Add source** → `Prototype019/motordaten`, Kanal
**Branch main**. Dann die Apps installieren und die Headunit neu starten
(auf iDrive 8 wird eine Installation erst nach dem Neustart aktiv).
Mit Zündung an öffnen.

### HUD-Test

1. Im Store den **Cluster renderer** installieren (Quelle `robertnisipeanu/idrive-apps`, im Store schon eingetragen).
2. **HUD-Test** installieren, Headunit neu starten, App öffnen.
3. Die Öltemperatur erscheint im HUD über der Tempoleiste.
4. Die Taste schaltet sie aus (BMWs eigene Anzeige kommt zurück) und wieder an.

Vorschau: `docs/design/preview/hudtest_hud_*.png` (`node apps/km_hudtest/tools/preview.js`).

## Lesen und Löschen

Motordaten liest über das Diagnose-Gateway der Headunit, als Tester 0xF4:
`22 <ID>` (ReadDataByIdentifier, bis zu 8 Kennungen), OBD-II `01` / `09` mit einer PID und den
Fehlerspeicher `19 02` (auch an alle Steuergeräte gleichzeitig); Einzelanfragen nur an DME und Getriebe.
Änderungen im Auto gibt es zwei: MHD Max Cooling (`2F 03 01` / `2F 03 00` an die DME, nur wenn in den Einstellungen
eingeschaltet, an nur bei laufendem Motor) und Fehler löschen (`14 FF FF FF`): nur auf Wunsch mit Rückfrage, nur bei Motor aus
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
node apps/km_hudtest/tools/emulator.js             # HUD-Test im Browser (http://localhost:8788), Öl wird warm gefahren
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
