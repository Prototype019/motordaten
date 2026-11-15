'use strict';
/**
 * HUD-Test: what goes on the head-up display, drawn into a Canvas
 * (src/kit_canvas.js) as RGBA for an image layer of the cluster renderer
 * (src/hud_link.js).
 *
 * The size is cluster-render's iDrive 8 target hud (its README, "iDrive 8"):
 * Ca_ComCenter_HUD, 353 x 203, all of it shown, above the speed bar. The HUD
 * shows light only: transparent stays dark, so nothing is filled.
 *
 * v: { oil } (°C), null when unknown.
 *
 * Minimal: the oil temperature alone, small label, one number.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const { Canvas } = require('./kit_canvas.js');

const HUD = Object.freeze({ w: 353, h: 203 });

const WHITE = [240, 244, 248, 255];
const DIM = [170, 182, 194, 255];
const ICE = [120, 196, 255, 255];
const RED = [255, 84, 72, 255];

/* Oil: blue while cold (full load not yet), red when too hot, white between. */
const OIL_COLD = 70;
const OIL_HOT = 130;

const isNum = (v) => typeof v === 'number' && isFinite(v);

function oilColour(t) {
    if (!isNum(t)) return DIM;
    return t < OIL_COLD ? ICE : t >= OIL_HOT ? RED : WHITE;
}

/* "92", "1,4", "–" */
function num(v, d) {
    return isNum(v) ? v.toFixed(d).replace('.', ',').replace(/^-(0(,0+)?)$/, '$1') : '–';
}

/* The HUD: "ÖL" and the oil temperature on one line, centred, nothing behind them. */
function drawHud(v, c) {
    c = c || new Canvas(HUD.w, HUD.h);
    c.clear([0, 0, 0, 0]);
    const text = num(v.oil, 0);
    const big = 64;
    const label = 'ÖL';
    const lw = c.textWidth(label, 26) + 12;
    const w = c.textWidth(text, big, { font: 'num' });
    const uw = c.textWidth('°C', 26) + 4;
    const left = (HUD.w - (lw + w + uw)) / 2;
    const base = HUD.h / 2 + big * 0.36;
    c.text(label, left, base, 26, DIM);
    c.text(text, left + lw, base, big, oilColour(v.oil), { font: 'num' });
    c.text('°C', left + lw + w + 4, base, 26, DIM);
    return c;
}

module.exports = { HUD, drawHud, num, oilColour };
