'use strict';
/**
 * QR codes for the screen (a link the phone opens): byte mode, error correction level M, versions 1 to 6
 * (up to 106 bytes, enough for a link). Written for this app after ISO/IEC 18004; no version information
 * is needed below version 7.
 *
 *   const q = qr.encode('https://github.com/login/device');
 *   q.size; q.dark(x, y)  // true for a dark module
 */

// per version (index 1..6), level M: total codewords, error correction codewords per block, blocks
const VERSIONS = [null,
    { total: 26, ec: 10, blocks: 1, align: [] },
    { total: 44, ec: 16, blocks: 1, align: [6, 18] },
    { total: 70, ec: 26, blocks: 1, align: [6, 22] },
    { total: 100, ec: 18, blocks: 2, align: [6, 26] },
    { total: 134, ec: 24, blocks: 2, align: [6, 30] },
    { total: 172, ec: 16, blocks: 4, align: [6, 34] }];
const FORMAT_M = 0; // the two bits for level M

/* ---- Reed-Solomon over GF(256), polynomial 0x11D ---- */
function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}
function divisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < r.length; j++) {
            r[j] = mul(r[j], root);
            if (j + 1 < r.length) r[j] ^= r[j + 1];
        }
        root = mul(root, 0x02);
    }
    return r;
}
function remainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) {
        const f = b ^ r.shift();
        r.push(0);
        div.forEach((c, i) => { r[i] ^= mul(c, f); });
    }
    return r;
}

/* ---- the codewords: mode, length, bytes, terminator, padding; then per block error correction, interleaved ---- */
function codewords(bytes, v) {
    const spec = VERSIONS[v];
    const dataLen = spec.total - spec.ec * spec.blocks;
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);
    put(bytes.length, 8);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, dataLen * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xEC; data.length < dataLen; pad ^= 0xEC ^ 0x11) data.push(pad);
    const per = dataLen / spec.blocks;     // equal blocks for versions 1..6 at level M
    const div = divisor(spec.ec);
    const blocks = [];
    for (let b = 0; b < spec.blocks; b++) {
        const d = data.slice(b * per, (b + 1) * per);
        blocks.push({ d, e: remainder(d, div) });
    }
    const out = [];
    for (let i = 0; i < per; i++) blocks.forEach((b) => out.push(b.d[i]));
    for (let i = 0; i < spec.ec; i++) blocks.forEach((b) => out.push(b.e[i]));
    return out;
}

/* ---- the matrix ---- */
function build(v, words, mask) {
    const size = v * 4 + 17;
    const m = [];
    const fn = [];
    for (let y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
            }
        }
    });
    const al = VERSIONS[v].align;
    al.forEach((ay, i) => al.forEach((ax, j) => {
        const corner = (i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0);
        if (corner) return;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }));
    formatBits(set, size, mask);           // reserves the format areas (redrawn with the mask below)
    // the data, zig-zag from the bottom right, two columns at a time
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const up = ((right + 1) & 2) === 0;
                const y = up ? size - 1 - vert : vert;
                if (!fn[y][x] && i < words.length * 8) {
                    m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
                    i++;
                }
            }
        }
    }
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
        }
    }
    return m;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
];

function formatBits(set, size, mask) {
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
}

/* The usual penalty, to pick the mask that scans best. */
function penalty(m) {
    const size = m.length;
    let p = 0;
    const lines = [];
    for (let y = 0; y < size; y++) lines.push(m[y]);
    for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]));
    const finder = [true, false, true, true, true, false, true];
    lines.forEach((l) => {
        let run = 1;
        for (let i = 1; i <= l.length; i++) {
            if (i < l.length && l[i] === l[i - 1]) { run++; continue; }
            if (run >= 5) p += 3 + run - 5;
            run = 1;
        }
        for (let i = 0; i + 7 <= l.length; i++) {
            if (!finder.every((d, k) => l[i + k] === d)) continue;
            const light = (a, b) => { for (let k = a; k < b; k++) { if (k >= 0 && k < l.length && l[k]) return false; } return true; };
            if (light(i - 4, i) || light(i + 7, i + 11)) p += 40;
        }
    });
    let dark = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (m[y][x]) dark++;
            if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
        }
    }
    const total = size * size;
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return p;
}

function encode(text) {
    const bytes = Array.from(Buffer.from(String(text), 'utf8'));
    let v = 1;
    while (v <= 6 && bytes.length > VERSIONS[v].total - VERSIONS[v].ec * VERSIONS[v].blocks - 2) v++;
    if (v > 6) throw new Error('QR: zu lang');
    const words = codewords(bytes, v);
    let best = null;
    let bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        const m = build(v, words, mask);
        const p = penalty(m);
        if (p < bestP) { best = m; bestP = p; }
    }
    return { version: v, size: best.length, dark: (x, y) => best[y][x] };
}

module.exports = { encode };
