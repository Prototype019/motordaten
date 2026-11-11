# Motordaten

Eigene Fahrzeugdaten-App für BMW iDrive 8 (MGU), installiert über den
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

**Version 0.1.0 (Test):** ein Bildschirm mit Drehzahl, Öl- und
Kühlmitteltemperatur. Die Zeile oben zeigt, worauf die App wartet oder was
fehlgeschlagen ist.

## Installieren

Im Store: **Settings → Add source** → `Prototype019/motordaten`, Kanal
**Branch main**. Dann **Motordaten** installieren und die Headunit neu
starten (auf iDrive 8 wird eine Installation erst nach dem Neustart aktiv).

## Entwickeln

```sh
cd apps/km_motordaten
node tools/gen.js         # package/: package.json, rhmiData (UI, Texte)
node tools/make_icon.js   # Kachel-Icon
node tools/test_app.js    # App gegen ein simuliertes oap-sdk
```

Die Headunit baut die App selbst (`mgu-app.json`, `"build": "unit"`) und
setzt BMWs oap-sdk aus einer vorhandenen BMW-App ein. Das SDK gehört nie in
dieses Repository.

## Lizenz

GPL-3.0-or-later. Aufbau und Paketformat folgen der Store-App aus
[mgu-store](https://github.com/robertnisipeanu/mgu-store) (GPL-3.0); die
Umrechnung der CDS-Werte folgt [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT).
