# Motordaten

Eigene Fahrzeugdaten-Apps für BMW iDrive 8 (MGU), installiert über den
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Was sie tut |
|---|---|
| **Motordaten** (`km_motordaten`) | Drehzahl, Öl- und Kühlmitteltemperatur aus den Fahrzeugsignalen. |
| **Daten-Test** (`km_datentest`) | Liest den Dienst-Katalog der Headunit und zeigt, welche Fahrzeugsignale und Diagnose-Dienste es gibt. Ruft nichts im Auto auf. |
| **Diagnose-Test** (`km_diagtest`) | Fragt die DME über das Diagnose-Gateway der Headunit: DME-Typ, unterstützte OBD-II-Werte, BMW-Werte (Öl, Ansaugluft, Ladedruck, Öldruck …). Nur lesend. |

Jede App zeigt oben eine Statuszeile, worauf sie wartet oder was fehlschlug.

Auf iDrive 8 lehnt die Headunit eine App ab, deren Manifest einen Dienst
nennt, den sie nicht hat. Deshalb sind die Tests getrennt: Fehlt das
Diagnose-Gateway, scheitert nur der Diagnose-Test; der Daten-Test zeigt warum.

## Installieren

Im Store: **Settings → Add source** → `Prototype019/motordaten`, Kanal
**Branch main**. Dann die Apps installieren und die Headunit neu starten
(auf iDrive 8 wird eine Installation erst nach dem Neustart aktiv).
Mit Zündung an öffnen.

## Nur lesend

Der Diagnose-Test schickt ausschließlich an die DME (0x12):
`22 <ID>` (ReadDataByIdentifier) und OBD-II `01` / `09` mit einer PID.
Alles andere lehnt `src/tasu.js` ab, bevor es das Gateway erreicht: keine
Sitzungswechsel, kein Löschen, kein Schreiben, keine Routinen. Eine Anfrage
nach der anderen, mindestens 25 ms Abstand.

## Entwickeln

```sh
node tools/gen.js                              # alle apps/*/package/ aus apps/*/spec.js
node tools/make_icon.js <id> [r,g,b]           # Kachel-Icon
(cd apps/<id> && node tools/test_app.js)       # App auf einer simulierten Headunit
```

`shared/screen.js` (Listen-Bildschirm) kopiert `tools/gen.js` in die Apps.
Die Headunit baut die Apps selbst (`mgu-app.json`, `"build": "unit"`) und
setzt BMWs oap-sdk aus einer vorhandenen BMW-App ein. Das SDK gehört nie in
dieses Repository.

## Lizenz

GPL-3.0-or-later. Aufbau und Paketformat folgen der Store-App aus
[mgu-store](https://github.com/robertnisipeanu/mgu-store) (GPL-3.0).
Diagnose-Transport, Signal- und Werte-Umrechnungen (DME8FF_R-Tabelle,
SGBD-Index) folgen [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT).
