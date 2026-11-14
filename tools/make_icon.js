'use strict';
/**
 * Draws an app's tile icon (140 x 140, transparent) as
 * apps/<id>/package/rhmiData/variantGroups/Common/images/<icon of its spec.js>:
 * the Drehzahlbogen - a 270° arc open at the bottom with round ends, its
 * last stretch red (the red zone), a needle and a hub. Shapes are drawn as
 * distance fields, so every edge is anti-aliased. The needle's colour tells
 * the apps apart (Motordaten: ice blue).
 *
 *   node tools/make_icon.js <id> [needle colour as r,g,b]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ID = process.argv[2];
if (!ID) {
    throw new Error('usage: node tools/make_icon.js <id> [r,g,b]');
}
const APP = path.join(__dirname, '..', 'apps', ID);
const OUT = path.join(APP, 'package', 'rhmiData', 'variantGroups', 'Common', 'images', require(path.join(APP, 'spec.js')).icon);

const S = 140;
const WHITE = [233, 238, 242];
const RED = [255, 91, 79];
const NEEDLE = process.argv[3] ? process.argv[3].split(',').map(Number) : [169, 220, 255];

const C = { x: 70, y: 70 };
const R = 52;                  // arc radius
const ARC_W = 12;              // arc stroke
const DEG = Math.PI / 180;
// angles in the screen's sense (0 = right, clockwise): the arc runs from 135° over the top to 45°
const ARC_FROM = 135 * DEG;
const ARC_SPAN = 270 * DEG;
const RED_FROM = (360 + 16.3) * DEG;   // the red zone: its last 28.7°

const px = new Float32Array(S * S * 4);

function blend(i, c, a) {
    if (a <= 0) {
        return;
    }
    const da = px[i + 3];
    const oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) {
        px[i + k] = (c[k] * a + px[i + k] * da * (1 - a)) / (oa || 1);
    }
    px[i + 3] = oa;
}

/* Distance from (x, y) to the arc from a0 over span (round ends at both). */
function arcDist(x, y, a0, span) {
    const dx = x - C.x;
    const dy = y - C.y;
    let a = Math.atan2(dy, dx);
    let rel = (a - a0) % (2 * Math.PI);
    if (rel < 0) {
        rel += 2 * Math.PI;
    }
    if (rel <= span) {
        return Math.abs(Math.hypot(dx, dy) - R);
    }
    const end = (t) => Math.hypot(x - (C.x + R * Math.cos(t)), y - (C.y + R * Math.sin(t)));
    a = a0 + span;
    return Math.min(end(a0), end(a));
}

/* Distance from (x, y) to the segment p-q. */
function segDist(x, y, p, q) {
    const vx = q[0] - p[0];
    const vy = q[1] - p[1];
    const t = Math.max(0, Math.min(1, ((x - p[0]) * vx + (y - p[1]) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(x - (p[0] + t * vx), y - (p[1] + t * vy));
}

const cover = (d, halfWidth) => Math.max(0, Math.min(1, halfWidth - d + 0.5));

for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const cx = x + 0.5;
        const cy = y + 0.5;
        blend(i, WHITE, cover(arcDist(cx, cy, ARC_FROM, RED_FROM - ARC_FROM), ARC_W / 2));
        blend(i, RED, cover(arcDist(cx, cy, RED_FROM, ARC_FROM + ARC_SPAN - RED_FROM), ARC_W / 2));
        blend(i, NEEDLE, cover(segDist(cx, cy, [70, 70], [104, 46]), 4.5));
        blend(i, WHITE, cover(Math.hypot(cx - C.x, cy - C.y), 10));
    }
}

function crc32(buf) {
    let c = ~0;
    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) {
            c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
        }
    }
    return (~c) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const o = y * (S * 4 + 1) + 1 + x * 4;
        raw[o] = Math.round(px[i]);
        raw[o + 1] = Math.round(px[i + 1]);
        raw[o + 2] = Math.round(px[i + 2]);
        raw[o + 3] = Math.round(px[i + 3] * 255);
    }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
