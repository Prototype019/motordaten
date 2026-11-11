'use strict';
/**
 * Draws the tile icon (140 x 140, transparent): a gauge arc with a needle.
 *
 *   node tools/make_icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 140;
const OUT = path.join(__dirname, '..', 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'motordaten_icon.png');
const px = Buffer.alloc(S * S * 4);

function blend(x, y, c, a) {
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) {
        return;
    }
    const i = (y * S + x) * 4;
    const da = px[i + 3] / 255;
    const oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) {
        px[i + k] = Math.round((c[k] * a + px[i + k] * da * (1 - a)) / (oa || 1));
    }
    px[i + 3] = Math.round(oa * 255);
}

const WHITE = [255, 255, 255];
const RED = [230, 40, 40];
const cx = 70, cy = 76;
const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;

for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const r = Math.hypot(dx, dy);
        let a = Math.atan2(dy, dx);
        if (a < START - Math.PI * 2 + SWEEP && a < 0) {
            a += Math.PI * 2;
        }
        let t = (a - START) / SWEEP;
        if (t < 0) {
            t += 2 * Math.PI / SWEEP;
        }
        const ring = Math.max(0, Math.min(1, 1 - Math.abs(r - 54) + 5));
        if (t >= 0 && t <= 1 && ring > 0) {
            blend(x, y, t > 0.78 ? RED : WHITE, ring);
        }
    }
}
// needle at about 60 %
const na = START + SWEEP * 0.6;
for (let s = 0; s <= 46; s += 0.25) {
    const x = cx + Math.cos(na) * s, y = cy + Math.sin(na) * s;
    for (let oy = -3; oy <= 3; oy++) {
        for (let ox = -3; ox <= 3; ox++) {
            const d = Math.hypot(ox, oy);
            blend(Math.round(x + ox), Math.round(y + oy), RED, Math.max(0, Math.min(1, 3.5 - d)));
        }
    }
}
for (let y = -9; y <= 9; y++) {
    for (let x = -9; x <= 9; x++) {
        blend(cx + x, cy + y, WHITE, Math.max(0, Math.min(1, 9.5 - Math.hypot(x, y))));
    }
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td));
    return Buffer.concat([len, td, crc]);
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
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
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
