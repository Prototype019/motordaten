'use strict';
/**
 * Draws the apps' tile icons (140 x 140, transparent) as
 * apps/<id>/package/rhmiData/variantGroups/Common/images/<icon of its spec.js>: three leaning stripes (light blue,
 * dark blue, red) running into a heavy white M, and under it the app's word: SUITE (M Suite, km_motordaten) or
 * SUITE HUD with HUD in red (M Suite HUD, km_hudtest). Every shape is a distance field, so every edge is
 * anti-aliased; the letters are strokes on a 4 x 6 grid.
 *
 *   node tools/make_logo.js            both icons
 *   node tools/make_logo.js <file> 4   a sheet of both on a dark tile, 4 times as large (to look at)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const U = 140;
const WHITE = [236, 241, 246];
const LIGHT = [129, 196, 255];
const DARK = [22, 88, 142];
const RED = [231, 34, 46];
const LEAN = 0.42;      // how far the mark leans to the right per unit of height

const seg = (x, y, p, q) => {
    const vx = q[0] - p[0];
    const vy = q[1] - p[1];
    const t = Math.max(0, Math.min(1, ((x - p[0]) * vx + (y - p[1]) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(x - (p[0] + t * vx), y - (p[1] + t * vy));
};
const line = (x, y, pts) => {
    let d = 1e9;
    for (let k = 1; k < pts.length; k++) d = Math.min(d, seg(x, y, pts[k - 1], pts[k]));
    return d;
};
/* Signed distance to a polygon (negative inside). */
function poly(x, y, pts) {
    let d = 1e9;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        d = Math.min(d, seg(x, y, pts[j], pts[i]));
        if ((pts[i][1] > y) !== (pts[j][1] > y) && x < (pts[j][0] - pts[i][0]) * (y - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) inside = !inside;
    }
    return inside ? -d : d;
}
const box = (x, y, b) => {
    const qx = Math.abs(x - (b.x + b.w / 2)) - (b.w / 2 - b.r);
    const qy = Math.abs(y - (b.y + b.h / 2)) - (b.h / 2 - b.r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.r;
};

/* A leaning bar from x, w wide, between y and y + H; the heavy M in a box W x H with stems t thick. */
const bar = (x, y, w, H) => [[x, y + H], [x + w, y + H], [x + w + H * LEAN, y], [x + H * LEAN, y]];
function letterM(x, y, W, H, t) {
    const up = [[0, H], [0, 0], [t, 0], [W / 2, H * 0.56], [W - t, 0], [W, 0], [W, H], [W - t, H], [W - t, H * 0.44], [W / 2, H], [t, H * 0.44], [t, H]];
    return up.map((p) => [x + p[0] + (H - p[1]) * LEAN, y + p[1]]);
}

const GLYPH = {
    S: [[[4, 0.7], [3.2, 0], [0.8, 0], [0, 0.8], [0, 2.2], [0.8, 3], [3.2, 3], [4, 3.8], [4, 5.2], [3.2, 6], [0.8, 6], [0, 5.3]]],
    U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
    I: [[[0, 0], [0, 6]]],
    T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
    E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3.2, 3]]],
    H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
    D: [[[0, 0], [0, 6], [2.4, 6], [4, 4.4], [4, 1.6], [2.4, 0], [0, 0]]]
};
const glyphW = (ch) => (ch === 'I' ? 0 : ch === ' ' ? 2.2 : 4);
const textW = (str, h, gap) => str.split('').reduce((w, ch, i) => w + glyphW(ch) * h / 6 + (i ? gap : 0), 0);

/* The shapes of one icon, in 140 units: each (x, y, k) -> [colour, cover 0..1] or null; k: pixels per unit. */
function shapes(words) {
    const out = [];
    const aa = (d, k) => Math.max(0, Math.min(1, 0.5 - d * k));
    const fill = (pts, col) => out.push((x, y, k) => { const d = poly(x, y, pts); return d < 1 ? [col, aa(d, k)] : null; });
    const text = (str, x, y, h, w, col, gap) => {
        str.split('').forEach((ch) => {
            (GLYPH[ch] || []).forEach((g) => {
                const p = g.map((q) => [x + q[0] * h / 6, y + q[1] * h / 6]);
                out.push((px, py, k) => { const d = line(px, py, p) - w / 2; return d < 1 ? [col, aa(d, k)] : null; });
            });
            x += glyphW(ch) * h / 6 + gap;
        });
        return x;
    };
    const H = 56;
    const ws = 11;
    const mw = 62;
    const x0 = 70 - (3 * ws + mw + H * LEAN) / 2;
    const y0 = words.length > 1 ? 26 : 30;
    [LIGHT, DARK, RED].forEach((c, i) => fill(bar(x0 + i * ws, y0, ws, H), c));
    fill(letterM(x0 + 3 * ws, y0, mw, H, 17), WHITE);
    if (words.length > 1) {
        const total = textW(words.join(' '), 13, 5);
        const x = text(words[0], 70 - total / 2, 99, 13, 3.3, WHITE, 5);
        text(words[1], x + 2.2 * 13 / 6 + 5, 99, 13, 3.3, RED, 5);
    } else {
        text(words[0], 70 - textW(words[0], 15, 6.5) / 2, 101, 15, 3.8, WHITE, 6.5);
    }
    return out;
}

/* w x h pixels (RGBA floats), the shapes drawn k times as large with their origin at ox, oy (pixels). */
function paint(px, w, list, k, ox, oy, size) {
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = ((oy + y) * w + ox + x) * 4;
            list.forEach((s) => {
                const r = s((x + 0.5) / k, (y + 0.5) / k, k);
                if (!r || r[1] <= 0) return;
                const a = r[1];
                const da = px[i + 3];
                const oa = a + da * (1 - a);
                for (let c = 0; c < 3; c++) px[i + c] = (r[0][c] * a + px[i + c] * da * (1 - a)) / (oa || 1);
                px[i + 3] = oa;
            });
        }
    }
}

function png(px, w, h) {
    const crcT = [];
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[i] = c >>> 0; }
    const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (t, d) => {
        const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t), d]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([l, td, c]);
    };
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const o = y * (w * 4 + 1) + 1 + x * 4;
            for (let c = 0; c < 3; c++) raw[o + c] = Math.round(px[i + c]);
            raw[o + 3] = Math.round(px[i + 3] * 255);
        }
    }
    const ih = Buffer.alloc(13);
    ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const APPS = [['km_motordaten', ['SUITE']], ['km_hudtest', ['SUITE', 'HUD']]];
if (process.argv[2]) {
    // the sheet: both on the dark tile they sit on in the car
    const k = Number(process.argv[3]) || 4;
    const cell = 200 * k;
    const px = new Float32Array(cell * 2 * cell * 4);
    APPS.forEach((a, n) => {
        // the tile is the car's, not the icon's (the icon is transparent): here only to look at, in the menu's grey-blue
        const tile = (x, y, kk) => { const d = box(x, y, { x: -16, y: -16, w: 172, h: 172, r: 30 }); return d < 1 ? [[52, 62, 78], Math.max(0, Math.min(1, 0.5 - d * kk))] : null; };
        const list = [tile].concat(shapes(a[1])).map((f) => (x, y, kk) => f(x - 30, y - 30, kk));
        paint(px, cell * 2, list, k, n * cell, 0, cell);
    });
    fs.writeFileSync(process.argv[2], png(px, cell * 2, cell));
} else {
    APPS.forEach((a) => {
        const app = path.join(__dirname, '..', 'apps', a[0]);
        const out = path.join(app, 'package', 'rhmiData', 'variantGroups', 'Common', 'images', require(path.join(app, 'spec.js')).icon);
        const px = new Float32Array(U * U * 4);
        paint(px, U, shapes(a[1]), 1, 0, 0, U);
        fs.writeFileSync(out, png(px, U, U));
        console.log(out);
    });
}
