#!/usr/bin/env python3
"""Share pictures (docs/share/*.png, 1600x900) from the app's own screens. Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
    .venv/bin/python tools/share_images.py "$PWD"
"""
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
R = sys.argv[1]
F = os.path.join(R, 'tools/fonts/src')
bold = lambda s: ImageFont.truetype(os.path.join(F, 'BarlowSemiCondensed-SemiBold.ttf'), s)
med = lambda s: ImageFont.truetype(os.path.join(F, 'Barlow-Medium.ttf'), s)
W, H = 1600, 900
BG, TEXT, DIM, ICE, RED = (10, 14, 19), (233, 238, 242), (131, 148, 164), (169, 220, 255), (255, 91, 79)
shots = [
    ('preview/share-live.png', 'Motordaten', 'Live-Werte direkt aus der Motorsteuerung · BMW iDrive 8', '1-live.png'),
    ('emulator/2-warmfahren.png', 'Warmfahren', 'Öl, Kühlmittel und Getriebe: grün sobald bereit für Volllast', '2-warmfahren.png'),
    ('preview/share-klopfen.png', 'Klopfregelung', 'Wie viel Zündung zurückgenommen wird, und auf welchem Zylinder', '3-klopfen.png'),
    ('preview/logmix.png', 'Aufzeichnungen', 'Lambda, Raildruck, Klopfen je Zylinder, Ladedruck, Temperaturen', '4-logs.png'),
    ('preview/faults.png', 'Fehlerspeicher', 'Alle Steuergeräte live lesen, mit Klartext je Fehler', '5-fehler.png'),
    ('emulator/6-bereit.png', 'Alles einstellbar', 'Grenzwerte und Bereit-Temperaturen selbst festlegen', '6-einstellungen.png'),
]
for src, title, sub, out in shots:
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    # a soft cold-to-red glow under the screen, the app's own heat language
    glow = Image.new('RGB', (W, H), BG)
    gd = ImageDraw.Draw(glow)
    gd.ellipse((180, 420, 820, 860), fill=(30, 60, 90)); gd.ellipse((780, 420, 1420, 860), fill=(80, 30, 28))
    img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(140)), 0.55)
    d = ImageDraw.Draw(img)
    d.text((80, 70), title, font=bold(84), fill=TEXT)
    d.text((82, 172), sub, font=med(34), fill=DIM)
    d.rectangle((80, 236, 160, 242), fill=ICE); d.rectangle((166, 236, 210, 242), fill=RED)
    shot = Image.open(os.path.join(R, 'docs/design', src)).convert('RGB')
    sw = W - 160; sh = round(shot.height * sw / shot.width)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    y = 300
    bez = Image.new('RGB', (sw + 28, sh + 28), (0, 0, 0))
    img.paste(bez, (66, y - 14)); img.paste(shot, (80, y))
    d.text((80, H - 70), 'BMW G87 M2 · S58 · MGU Store App', font=med(26), fill=(90, 104, 118))
    img.save(os.path.join(R, 'docs/share', out), optimize=True)
    print(out)
