#!/usr/bin/env python3
"""Bakes the glyph atlases Motordaten draws its renderer screen with
(shared/font_label.js, font_num.js, font_scale.js) from Barlow and Barlow
Semi Condensed, SIL Open Font License 1.1 (shared/OFL-Barlow.txt). The
renderer has no font rasteriser: an app uploads each atlas once (8-bit
alpha) and draws text as glyph quads. Format and method as the MGU Store's
tools/bake_fonts.py (GPL-3.0).

    .venv/bin/python tools/fonts/bake.py

Each module: { family, sizes: [{ size, ascent, descent, atlasW, atlasH, key,
alpha: base64(zlib(alpha bytes)), glyphs: { code: [x, y, w, h, ox, oy, adv] } }] }.
Sizes in device px (the screen draws at scale 1); kit_fonts.js picks the
smallest at least the size asked and scales it down.
"""
import base64, json, os, zlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'shared')
TEXT = ''.join(chr(c) for c in range(32, 127)) + 'ÄÖÜäöüß°–…·×−„“'
DIGITS = '0123456789,.-– '
# face: (file, sizes, charset)
FACES = {
    'label': ('Barlow-Medium.ttf', [26, 32, 38, 46], TEXT),
    'scale': ('BarlowSemiCondensed-Medium.ttf', [26, 32, 40], TEXT),
    'num': ('BarlowSemiCondensed-SemiBold.ttf', [40, 54, 72, 100, 136, 170, 196], DIGITS),
}
PAD = 2
MAXW = 1024


def bake(face, path, size, text):
    f = ImageFont.truetype(path, size)
    ascent, descent = f.getmetrics()
    boxes = []
    for ch in text:
        l, t, r, b = f.getbbox(ch, anchor='ls')
        boxes.append((ch, l, t, max(0, r - l), max(0, b - t), f.getlength(ch)))
    x = y = PAD
    row = 0
    placed = []
    for ch, l, t, w, h, adv in boxes:
        if x + w + PAD > MAXW:
            x, y, row = PAD, y + row + PAD, 0
        placed.append((ch, x, y, l, t, w, h, adv))
        x += w + PAD
        row = max(row, h)
    width = MAXW if y > PAD else min(MAXW, x + PAD)
    height = y + row + PAD
    img = Image.new('L', (width, height), 0)
    d = ImageDraw.Draw(img)
    glyphs = {}
    for ch, gx, gy, l, t, w, h, adv in placed:
        if w and h:
            d.text((gx - l, gy - t), ch, font=f, fill=255, anchor='ls')
        glyphs[str(ord(ch))] = [gx, gy, w, h, l, t, round(adv, 3)]
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': width, 'atlasH': height,
            'key': 'kmmd-%s@%d' % (face, size),
            'alpha': base64.b64encode(zlib.compress(img.tobytes(), 9)).decode('ascii'), 'glyphs': glyphs}


def main():
    for face, (file, sizes, text) in FACES.items():
        path = os.path.join(HERE, 'src', file)
        fam = {'family': face, 'sizes': [bake(face, path, s, text) for s in sizes]}
        out = os.path.join(OUT, 'font_%s.js' % face)
        with open(out, 'w') as o:
            o.write('/* %s glyph atlases, baked by tools/fonts/bake.py from %s.\n'
                    ' * Copyright 2017 The Barlow Project Authors. SIL Open Font License 1.1: shared/OFL-Barlow.txt */\n'
                    "'use strict';\nmodule.exports = %s;\n" % (face, file, json.dumps(fam, separators=(',', ':'))))
        print('%s: %d kB, atlases %s' % (os.path.relpath(out), os.path.getsize(out) // 1024,
                                          ' '.join('%dx%d' % (s['atlasW'], s['atlasH']) for s in fam['sizes'])))


if __name__ == '__main__':
    main()
