'use strict';
/**
 * What goes on the head-up display (src/warmup.js decides what), drawn for the cluster renderer's iDrive 8
 * target hud: 353 x 203, right above BMW's own speed bar. The HUD shows light only: transparent stays dark,
 * nothing is filled.
 *
 *   warm:  WARMFAHREN over the temperature still missing, blue
 *   ready: BEREIT over the oil
 *   hot:   the oil in red over ZU HEISS
 *   oil:   the oil alone (blue while cold)
 *
 * v also carries pos (left / center / right: where in the 353 px the block sits) and size (normal / large).
 * drawHud(v, c) draws into a Canvas (src/kit_canvas.js) for the HUD itself; drawHud(v, rec, { x, y, s })
 * draws the same into a Recorder at x, y, s times as large, for the app's own screen (nothing cleared).
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const { Canvas } = require('./kit_canvas.js');

const HUD = Object.freeze({ w: 353, h: 203 });
const EDGE = 10;                // the block's distance from the side it sits at

const WHITE = [240, 244, 248, 255];
const DIM = [170, 182, 194, 255];
const ICE = [120, 196, 255, 255];
const RED = [255, 84, 72, 255];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const deg = (v) => (isNum(v) ? String(Math.round(v)) : '–');

/* The block's lines for v: [{ parts: [[text, size, colour, font]], base }], sizes at "normal". */
function lines(v) {
    const temp = (value, big, colour, labelColour) => [[String(v.label || 'Öl').toUpperCase(), 24, labelColour || DIM, 'label', 12],
        [deg(value), big, colour, 'num', 4], ['°C', 24, DIM, 'label', 0]];
    if (v.mode === 'ready') return [{ parts: [['BEREIT', 56, WHITE, 'label', 0]], base: 106 }, { parts: temp(v.value, 34, DIM), base: 160 }];
    if (v.mode === 'hot') return [{ parts: temp(v.value, 64, RED), base: 112 }, { parts: [['ZU HEISS', 26, RED, 'label', 0]], base: 160 }];
    if (v.mode === 'oil') return [{ parts: temp(v.value, 72, v.cold ? ICE : WHITE), base: 128 }];
    return [{ parts: [['WARMFAHREN', 24, ICE, 'label', 0]], base: 62 }, { parts: temp(v.value, 64, ICE), base: 140 }];
}

/* c: a Canvas, or a Recorder with at { x, y, s }. */
function drawHud(v, c, at) {
    if (!at) {
        c = c || new Canvas(HUD.w, HUD.h);
        c.clear([0, 0, 0, 0]);
    }
    if (!v || !v.mode) return c;
    const o = at || { x: 0, y: 0, s: 1 };
    const k = v.size === 'large' ? 1.25 : 1;
    const ls = lines(v);
    const width = (l) => l.parts.reduce((n, p) => n + c.textWidth(p[0], p[1] * k, { font: p[3] }) + p[4] * k, 0);
    const block = Math.max.apply(null, ls.map(width));
    // the block's middle line stays where it was at normal size: grown, it spreads up and down evenly
    const mid = (ls[0].base + ls[ls.length - 1].base) / 2;
    ls.forEach((l) => {
        const w = width(l);
        const left = v.pos === 'left' ? EDGE + (block - w) / 2 : v.pos === 'right' ? HUD.w - EDGE - block + (block - w) / 2 : (HUD.w - w) / 2;
        const base = mid + (l.base - mid) * k;
        let x = left;
        l.parts.forEach((p) => {
            c.text(p[0], o.x + x * o.s, o.y + base * o.s, p[1] * k * o.s, p[2], { font: p[3] });
            x += c.textWidth(p[0], p[1] * k, { font: p[3] }) + p[4] * k;
        });
    });
    return c;
}

/* What the HUD shows, as a key: drawn again only when it changes. */
function key(v) {
    return v && v.mode ? [v.mode, v.label, deg(v.value), v.cold ? 1 : 0, v.pos, v.size].join('|') : '';
}

module.exports = { HUD, drawHud, key, lines };
