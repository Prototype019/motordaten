# Motordaten

Eigene Fahrzeugdaten-Apps für BMW iDrive 8 (MGU), installiert über den
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Was sie tut |
|---|---|
| **Motordaten** (`km_motordaten`) | Eigene gezeichnete Oberfläche über `mgu-render`. Live aus Motor und Getriebe über das Diagnose-Gateway der Headunit, nur lesend, etwa 10-mal pro Sekunde: Drehzahl, Ladedruck mit Soll, Leistung aus der gemessenen Luftmasse und Drehmoment, Öldruck, Öl-, Kühlmittel-, Ansaugluft-, Getriebeöl- und Abgastemperatur mit Temperaturbalken, Klopfregelung mit Zylinder, Bordnetz. Bereit-Anzeige für Volllast. Aufzeichnungen mit Diagrammen (auch Lambda, Raildruck, Klopfen je Zylinder) und USB-Export, Fehlerspeicher aller Steuergeräte mit Klartext, alle Grenzwerte einstellbar. |

Jede App zeigt oben eine Statuszeile, worauf sie wartet oder was fehlschlug.


## Installieren

Im Store: **Settings → Add source** → `Prototype019/motordaten`, Kanal
**Branch main**. Dann die Apps installieren und die Headunit neu starten
(auf iDrive 8 wird eine Installation erst nach dem Neustart aktiv).
Mit Zündung an öffnen.

## Lesen und Löschen

Motordaten liest über das Diagnose-Gateway der Headunit, als Tester 0xF4:
`22 <ID>` (ReadDataByIdentifier, bis zu 8 Kennungen), OBD-II `01` / `09` mit einer PID und den
Fehlerspeicher `19 02` (auch an alle Steuergeräte gleichzeitig); Einzelanfragen nur an DME und Getriebe.
Die einzige Änderung im Auto ist Fehler löschen (`14 FF FF FF`): nur auf Wunsch mit Rückfrage, nur bei Motor aus
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
cauliflowermossgrape / IterioDev, `shared/LICENSE-kit.txt`) und die Schrift
Barlow (SIL OFL 1.1, `shared/OFL-Barlow.txt`). Die Kennungen und Umrechnungen
der Motorsteuerung stammen aus der DME8FF_R-Tabelle und dem SGBD-Index von
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT) und
eigenen ENET-Messungen (`docs/g87-s58.md`).
