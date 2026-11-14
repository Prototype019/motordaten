'use strict';
/**
 * The Motordaten screen as drawing calls (docs/design/motordaten.html, laid
 * out for the iDrive 8 app area: 2880 x 764 logical px at scale 1).
 *
 *   engine speed band across the top, the number and its peak at the right;
 *   readiness (oil temperature band, then coolant, intake and charge air),
 *   power (boost with its target and peak), health (oil pressure with its
 *   peak, supply voltage, the reset button).
 *
 * draw(rec, v, ui) records one frame into a kit_record Recorder (or a
 * kit_canvas Canvas): v the values (null: none), ui { focus } the reset
 * button's controller focus. RESET is the button's box (touch claims).
 */
const W = 2880;
const H = 764;
const C = {
    asphalt: '#10161D', line: '#2A3642', text: '#E9EEF2', dim: '#8394A4',
    cold: '#5FA8D9', ice: '#A9DCFF', limit: '#FF5B4F', redzone: '#FF5B4F59'
};
const PAD = 96;
const RPM_MAX = 7700;
const RPM_RED = 6400;
const OIL_MAX = 130;
const OIL_READY = 70;
const BOOST_MAX = 2.5;
const COL = { left: { x: PAD, w: 660 }, mid: { x: 876, w: 1180 }, right: { x: 2176, w: 608 } };
const RESET = { x: COL.right.x, y: 618, w: COL.right.w, h: 96 };

const isNum = (v) => typeof v === 'number' && isFinite(v);
const de = (v, d) => v.toFixed(d).replace('.', ',');
const thousands = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hex(rgb) {
    return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}
function mix(a, b, t) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const x = p(a);
    const y = p(b);
    return hex(x.map((c, i) => c + (y[i] - c) * t));
}

/* A value and its unit on one baseline; align 'left' or 'right' (right: the unit's end at x). */
function valueUnit(rec, text, unit, x, y, size, color, unitSize, align) {
    const gap = Math.round(size * 0.07);
    const uw = rec.textWidth(unit, unitSize, { font: 'label' });
    const vw = rec.textWidth(text, size, { font: 'num' });
    const left = align === 'right' ? x - uw - gap - vw : x;
    rec.text(text, left, y, size, color, { font: 'num' });
    rec.text(unit, left + vw + gap, y, unitSize, C.dim, { font: 'label' });
}

function rpmBand(rec, v) {
    const x = PAD;
    const w = 2144;
    const y = 60;
    const h = 44;
    rec.roundRect(x, y, w, h, 4, C.line);
    rec.fillRect(x + w * RPM_RED / RPM_MAX, y, w * (RPM_MAX - RPM_RED) / RPM_MAX, h, C.redzone);
    if (isNum(v.rpm)) {
        rec.fillRect(x, y, w * clamp(v.rpm, 0, RPM_MAX) / RPM_MAX, h, C.text);
    }
    if (isNum(v.rpmPeak) && v.rpmPeak > 0) {
        rec.fillRect(x + w * clamp(v.rpmPeak, 0, RPM_MAX) / RPM_MAX - 3, y - 8, 6, h + 16, C.ice);
    }
    for (let k = 0; k <= 7; k++) {
        rec.text(String(k), x + w * k * 1000 / RPM_MAX, 146, 28, C.dim, { font: 'scale', align: k ? 'center' : 'left' });
    }
    const rpmColor = isNum(v.rpm) && v.rpm > RPM_RED ? C.limit : C.text;
    valueUnit(rec, isNum(v.rpm) ? thousands(v.rpm) : '–', 'U/min', W - PAD, 128, 124, rpmColor, 32, 'right');
    if (isNum(v.rpmPeak) && v.rpmPeak > 0) {
        rec.text(`Spitze ${thousands(v.rpmPeak)}`, W - PAD, 176, 30, C.ice, { font: 'scale', align: 'right' });
    }
}

function readiness(rec, v) {
    const { x, w } = COL.left;
    rec.text('Öltemperatur', x, 262, 34, C.dim, { font: 'label' });
    const oil = v.oil;
    const ready = isNum(oil) && oil >= OIL_READY;
    const t = isNum(oil) ? clamp((oil - 20) / (OIL_READY - 20), 0, 1) : 0;
    const color = !isNum(oil) ? C.dim : ready ? C.text : mix(C.cold, C.text, t * 0.6);
    valueUnit(rec, isNum(oil) ? String(Math.round(oil)) : '–', '°C', x, 420, 160, color, 36, 'left');

    const by = 448;
    const bh = 52;
    rec.roundRect(x, by, w, bh, 8, C.line);
    if (isNum(oil) && oil > 0) {
        rec.roundRect(x, by, Math.max(bh, w * clamp(oil, 0, OIL_MAX) / OIL_MAX), bh, 8, color);
    }
    const mx = x + w * OIL_READY / OIL_MAX;
    rec.fillRect(mx - 3, by - 12, 6, bh + 24, C.text);
    rec.text(String(OIL_READY), mx, by - 20, 26, C.dim, { font: 'scale', align: 'center' });
    const note = !isNum(oil) ? '' : ready ? 'Bereit für Volllast' : `Noch ${Math.ceil(OIL_READY - oil)} °C bis bereit`;
    rec.text(note, x, 552, 34, ready ? C.text : C.cold, { font: 'label' });

    const cells = [['Kühlmittel', v.coolant], ['Ansaugluft', v.intake], ['Ladeluft', v.charge]];
    cells.forEach((c, i) => {
        const cx = x + i * 236;
        rec.text(c[0], cx, 630, 28, C.dim, { font: 'label' });
        valueUnit(rec, isNum(c[1]) ? String(Math.round(c[1])) : '–', '°C', cx, 702, 54, C.text, 26, 'left');
    });
}

function power(rec, v) {
    const { x, w } = COL.mid;
    rec.text('Ladedruck', x, 262, 34, C.dim, { font: 'label' });
    const b = isNum(v.boost) ? Math.max(0, v.boost) : null;
    valueUnit(rec, b === null ? '–' : de(b, 2), 'bar', x, 440, 196, C.text, 38, 'left');
    const ty = 478;
    const th = 60;
    rec.roundRect(x, ty, w, th, 6, C.line);
    if (b !== null && b > 0) {
        rec.roundRect(x, ty, Math.max(12, w * clamp(b, 0, BOOST_MAX) / BOOST_MAX), th, 6, C.text);
    }
    if (isNum(v.boostTarget) && v.boostTarget > 0) {
        const sx = x + w * clamp(v.boostTarget, 0, BOOST_MAX) / BOOST_MAX;
        for (let yy = ty - 14; yy < ty + th + 14; yy += 14) {
            rec.fillRect(sx - 2, yy, 4, 8, C.dim);
        }
    }
    if (isNum(v.boostPeak) && v.boostPeak > 0) {
        rec.fillRect(x + w * clamp(v.boostPeak, 0, BOOST_MAX) / BOOST_MAX - 4, ty - 14, 8, th + 28, C.ice);
    }
    ['0', '0,5', '1,0', '1,5', '2,0', '2,5'].forEach((s, i) => {
        rec.text(s, x + w * i / 5, 590, 28, C.dim, { font: 'scale', align: i === 0 ? 'left' : i === 5 ? 'right' : 'center' });
    });
    const soll = isNum(v.boostTarget) ? `${de(Math.max(0, v.boostTarget), 2)} bar` : '–';
    const peak = isNum(v.boostPeak) ? `${de(Math.max(0, v.boostPeak), 2)} bar` : '–';
    let px = x;
    px += rec.text('Soll', px, 660, 32, C.dim, { font: 'label' }) + 12;
    px += rec.text(soll, px, 660, 40, C.text, { font: 'scale' }) + 72;
    px += rec.text('Spitze', px, 660, 32, C.ice, { font: 'label' }) + 12;
    rec.text(peak, px, 660, 40, C.ice, { font: 'scale' });
}

function health(rec, v, ui) {
    const { x, w } = COL.right;
    rec.text('Öldruck', x, 262, 34, C.dim, { font: 'label' });
    const low = isNum(v.oilPress) && isNum(v.rpm) && v.rpm > 1500 && v.oilPress < 1.0;
    valueUnit(rec, isNum(v.oilPress) ? de(v.oilPress, 1) : '–', 'bar', x, 362, 100, low ? C.limit : C.text, 32, 'left');
    if (isNum(v.oilPressPeak)) {
        rec.text(`Spitze ${de(v.oilPressPeak, 1)} bar`, x, 408, 30, C.ice, { font: 'scale' });
    }
    rec.text('Bordnetz', x, 472, 34, C.dim, { font: 'label' });
    valueUnit(rec, isNum(v.voltage) ? de(v.voltage, 1) : '–', 'V', x, 566, 100, C.text, 32, 'left');

    const r = RESET;
    if (ui && ui.focus) {
        rec.strokeRoundRect(r.x - 8, r.y - 8, r.w + 16, r.h + 16, r.h / 2 + 8, 5, C.ice);
    }
    if (ui && ui.pressed) {
        rec.roundRect(r.x, r.y, r.w, r.h, r.h / 2, C.line);
    }
    rec.strokeRoundRect(r.x, r.y, r.w, r.h, r.h / 2, 3, C.line);
    rec.text('Spitzen zurücksetzen', r.x + r.w / 2, r.y + 61, 36, C.text, { font: 'label', align: 'center' });
    void w;
}

function draw(rec, v, ui) {
    rec.clear(C.asphalt);
    rpmBand(rec, v);
    readiness(rec, v);
    power(rec, v);
    health(rec, v, ui);
    if (v.status) {
        rec.text(v.status, PAD, 752, 30, v.statusErr ? C.limit : C.dim, { font: 'label' });
    }
    return rec;
}

module.exports = { draw, W, H, RESET, C };
