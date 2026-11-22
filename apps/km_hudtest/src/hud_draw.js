'use strict';
/**
 * What goes on the head-up display (src/warmup.js decides what), drawn for the cluster renderer's iDrive 8
 * target hud: 353 x 203, right above BMW's own speed bar. The HUD shows light only: transparent stays dark,
 * nothing is filled.
 *
 *   warm:  WARMFAHREN over the temperature still missing, blue
 *   ready: BEREIT over the oil
 *   hot:   the oil in red over ZU HEISS
 *   values: one to three values (src/values.js), each its label over its number and unit; blue while cold,
 *           red when hot. One: large; two or three: side by side.
 *
 *   grid:  the alignment picture (Ausrichten): a frame, the middle lines, a circle
 *
 * v also carries pos (left / center / right: where in the 353 px the block sits), size (normal / large) and cal
 * { tilt, shift, height, width } (settings correction()): the HUD sets the picture slanted, aside and flatter, so the
 * picture for the HUD is drawn the other way round (warp); the app's own screen shows it straight.
 * drawHud(v, c) draws into a Canvas (src/kit_canvas.js) for the HUD itself; drawHud(v, rec, { x, y, s })
 * draws the same into a Recorder at x, y, s times as large, for the app's own screen (nothing cleared).
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const { Canvas } = require('./kit_canvas.js');

/* Our picture: 352 x 200, not the target's whole 353 x 203. On the G87 the picture now and then showed sheared
 * about one pixel per row and wrapped at the sides, as a texture whose rows are read with the wrong width; an odd
 * width is the usual cause, so both sides are multiples of 8 (the layer sits at TARGET_AT in the target). */
const HUD = Object.freeze({ w: 352, h: 200 });
const TARGET_AT = Object.freeze({ x: 0, y: 1 });
const EDGE = 10;                // the block's distance from the side it sits at

const WHITE = [240, 244, 248, 255];
const DIM = [170, 182, 194, 255];
const ICE = [120, 196, 255, 255];
const RED = [255, 84, 72, 255];

const TONE = { cold: ICE, hot: RED, normal: WHITE, none: DIM };
/* values: per count the number's size, the label's, and the gap between columns */
const COLS = { 1: { big: 72, label: 24, gap: 0 }, 2: { big: 56, label: 20, gap: 28 }, 3: { big: 44, label: 17, gap: 18 } };

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
    if (v.mode === 'grid') drawGrid(c, o);
    else if (v.mode === 'values') drawValues(v, c, o);
    else drawLines(v, c, o);
    return at ? c : warp(c, v.cal);
}

/* The alignment picture: straight lines and a round circle show how the HUD sets the picture. */
function drawGrid(c, o) {
    const X = (x) => o.x + x * o.s;
    const Y = (y) => o.y + y * o.s;
    const w = 2 * o.s;
    c.strokeRoundRect(X(6), Y(6), (HUD.w - 12) * o.s, (HUD.h - 12) * o.s, 8 * o.s, w, ICE);
    c.line(X(HUD.w / 2), Y(6), X(HUD.w / 2), Y(HUD.h - 6), w, WHITE);
    c.line(X(6), Y(HUD.h / 2), X(HUD.w - 6), Y(HUD.h / 2), w, WHITE);
    c.arc(X(HUD.w / 2), Y(HUD.h / 2), 54 * o.s, 58 * o.s, 0, 360, WHITE);
    const t = 'AUSRICHTEN';
    c.text(t, X(HUD.w / 2) - c.textWidth(t, 16 * o.s) / 2, Y(30), 16 * o.s, ICE);
}

/*
 * The picture for the HUD drawn the other way round from how the HUD sets it: each row moved aside against the slant
 * (tilt degrees about the middle row), the whole moved by shift, taller by height % and narrower to width % about the
 * middle (sampled, rows and columns blended). Nothing to do: the canvas as it is.
 */
function warp(c, cal) {
    if (!cal || (!cal.tilt && !cal.shift && (!cal.height || cal.height === 100) && (!cal.width || cal.width === 100))) return c;
    const w = c.w;
    const h = c.h;
    const src = Buffer.from(c.d);
    const d = c.d;
    const k = Math.tan((cal.tilt || 0) * Math.PI / 180);
    const scale = 100 / (cal.height || 100);
    const wide = 100 / (cal.width || 100);
    const cx = w / 2;
    const cy = h / 2;
    const at = (x, y, ch) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[(y * w + x) * 4 + ch]);
    for (let y = 0; y < h; y++) {
        const sy = cy + (y + 0.5 - cy) * scale - 0.5;
        const y0 = Math.floor(sy);
        const fy = sy - y0;
        // + tilt leans the top to the left: rows above the middle come from further right
        const off = k * (cy - y - 0.5) - (cal.shift || 0);
        for (let x = 0; x < w; x++) {
            // narrower about the middle: each column from further out
            const sx = cx + (x + 0.5 + off - cx) * wide - 0.5;
            const x0 = Math.floor(sx);
            const fx = sx - x0;
            const i = (y * w + x) * 4;
            for (let ch = 0; ch < 4; ch++) {
                const top = at(x0, y0, ch) * (1 - fx) + at(x0 + 1, y0, ch) * fx;
                const bottom = at(x0, y0 + 1, ch) * (1 - fx) + at(x0 + 1, y0 + 1, ch) * fx;
                d[i + ch] = Math.round(top * (1 - fy) + bottom * fy);
            }
        }
    }
    return c;
}

/* The looks of one block of lines (warm, ready, hot). */
function drawLines(v, c, o) {
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

/* The values side by side: each column its label (small, dim) over its number and unit; the block placed by pos. */
function drawValues(v, c, o) {
    const items = (v.items || []).slice(0, 3);
    if (!items.length) return c;
    const k = v.size === 'large' ? (items.length === 1 ? 1.25 : 1.15) : 1;
    const L = COLS[items.length];
    const big = L.big * k;
    const lab = L.label * k;
    const cols = items.map((it) => {
        const nw = c.textWidth(it.text, big, { font: 'num' });
        const uw = it.unit ? c.textWidth(it.unit, lab, { font: 'label' }) + 4 * k : 0;
        const lw = c.textWidth(it.label, lab, { font: 'label' });
        return { it, nw, uw, w: Math.max(nw + uw, lw) };
    });
    // too wide for the HUD: everything a little smaller
    const room = HUD.w - 2 * EDGE;
    let total = cols.reduce((n, col) => n + col.w, 0) + L.gap * k * (cols.length - 1);
    const fit = total > room ? room / total : 1;
    total *= fit;
    let x = v.pos === 'left' ? EDGE : v.pos === 'right' ? HUD.w - EDGE - total : (HUD.w - total) / 2;
    const mid = 112;
    const base = mid + big * fit * 0.36 + lab * fit * 0.6;
    cols.forEach((col) => {
        const w = col.w * fit;
        const colour = TONE[col.it.tone] || WHITE;
        const lw = c.textWidth(col.it.label, lab * fit, { font: 'label' });
        c.text(col.it.label, o.x + (x + (w - lw) / 2) * o.s, o.y + (base - big * fit - lab * fit * 0.4) * o.s, lab * fit * o.s,
            col.it.tone === 'hot' ? RED : DIM, { font: 'label' });
        const left = x + (w - (col.nw + col.uw) * fit) / 2;
        c.text(col.it.text, o.x + left * o.s, o.y + base * o.s, big * fit * o.s, colour, { font: 'num' });
        if (col.it.unit) c.text(col.it.unit, o.x + (left + col.nw * fit + 4 * k * fit) * o.s, o.y + base * o.s, lab * fit * o.s, DIM, { font: 'label' });
        x += w + L.gap * k * fit;
    });
    return c;
}

/* What the HUD shows, as a key: drawn again only when it changes. */
function key(v) {
    if (!v || !v.mode) return '';
    const items = (v.items || []).map((i) => [i.key, i.text, i.tone].join(':')).join(',');
    const cal = v.cal ? [v.cal.tilt, v.cal.shift, v.cal.height, v.cal.width].join(',') : '';
    return [v.mode, v.label, deg(v.value), items, v.pos, v.size, cal].join('|');
}

module.exports = { HUD, drawHud, key, lines, warp, TARGET_AT };
