#!/usr/bin/env python3
"""Glyph atlases for Motordaten's drawn screens (shared/font_label.js, font_scale.js, font_num.js), from Barlow and
Barlow Semi Condensed (SIL Open Font License 1.1, shared/OFL-Barlow.txt). The renderer draws text as quads out of an
8-bit alpha atlas the app uploads once; shared/kit_fonts.js reads these modules.

    .venv/bin/python tools/fonts/bake.py

A module: { family, sizes: [{ size, ascent, descent, atlasW, atlasH, key, alpha: base64 of zlib of the alpha bytes,
glyphs: { "<code>": [x, y, w, h, left, top, advance] } }] }, left/top from the pen on the baseline.

Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
"""
import base64
import json
import os
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.normpath(os.path.join(HERE, '..', '..', 'shared'))
WORDS = ''.join(map(chr, range(0x20, 0x7f))) + 'ÄÖÜäöüß°–…·×−„“'
NUMBERS = '0123456789,.-– '
FACES = [  # family, font file, sizes (device px), characters
    ('label', 'Barlow-Medium.ttf', (26, 32, 38, 46), WORDS),
    ('scale', 'BarlowSemiCondensed-Medium.ttf', (26, 32, 40), WORDS),
    ('num', 'BarlowSemiCondensed-SemiBold.ttf', (40, 54, 72, 100, 136, 170, 196), NUMBERS),
]
GAP = 2          # px between glyphs, so filtering never bleeds into a neighbour
WIDTH = 1024     # the widest atlas


def atlas(family, font_file, size, chars):
    font = ImageFont.truetype(font_file, size)
    ascent, descent = font.getmetrics()
    cells = []
    for ch in chars:
        left, top, right, bottom = font.getbbox(ch, anchor='ls')
        cells.append({'ch': ch, 'left': left, 'top': top, 'w': max(0, right - left), 'h': max(0, bottom - top),
                      'adv': round(font.getlength(ch), 3)})
    # shelves, tallest glyphs first: rows fill evenly and the atlas stays low
    order = sorted(cells, key=lambda c: -c['h'])
    x, y, shelf, used = GAP, GAP, 0, 0
    for c in order:
        if x + c['w'] + GAP > WIDTH:
            x, y, shelf = GAP, y + shelf + GAP, 0
        c['x'], c['y'] = x, y
        x += c['w'] + GAP
        shelf = max(shelf, c['h'])
        used = max(used, x)
    w, h = (WIDTH if y > GAP else used + GAP), y + shelf + GAP
    image = Image.new('L', (w, h), 0)
    pen = ImageDraw.Draw(image)
    for c in cells:
        if c['w'] and c['h']:
            pen.text((c['x'] - c['left'], c['y'] - c['top']), c['ch'], font=font, fill=255, anchor='ls')
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': w, 'atlasH': h, 'key': 'kmmd-%s@%d' % (family, size),
            'alpha': base64.b64encode(zlib.compress(image.tobytes(), 9)).decode('ascii'),
            'glyphs': {str(ord(c['ch'])): [c['x'], c['y'], c['w'], c['h'], c['left'], c['top'], c['adv']] for c in cells}}


def main():
    for family, font_file, sizes, chars in FACES:
        source = os.path.join(HERE, 'src', font_file)
        module = {'family': family, 'sizes': [atlas(family, source, s, chars) for s in sizes]}
        target = os.path.join(SHARED, 'font_%s.js' % family)
        with open(target, 'w') as out:
            out.write('/* %s glyph atlases, baked by tools/fonts/bake.py from %s.\n'
                      ' * Copyright 2017 The Barlow Project Authors. SIL Open Font License 1.1: shared/OFL-Barlow.txt */\n'
                      "'use strict';\nmodule.exports = %s;\n" % (family, font_file, json.dumps(module, separators=(',', ':'))))
        print('%s: %d kB, %s' % (os.path.relpath(target), os.path.getsize(target) // 1024,
                                 ' '.join('%dx%d' % (s['atlasW'], s['atlasH']) for s in module['sizes'])))


if __name__ == '__main__':
    main()
