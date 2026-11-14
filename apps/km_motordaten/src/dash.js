'use strict';
/**
 * The Motordaten screens as drawing calls (docs/design/motordaten.html, laid
 * out for the iDrive 8 app area: 2880 x 764 logical px at scale 1).
 *
 * Page 'main':
 *   engine speed band across the top, the number and its peak at the right;
 *   readiness (oil temperature band, then coolant, intake and charge air),
 *   power (boost with its target and peak, power and torque), health (oil pressure with its
 *   peak; transmission oil, exhaust and supply voltage; the buttons).
 * Page 'settings': the limits (src/limits.js), each with - and +, and
 *   Standard and Fertig.
 *
 * draw(rec, page, v, cfg, ui) records one frame into a kit_record Recorder
 * (or a kit_canvas Canvas): v the values (null: none; rpmBar / boostBar the
 * bars as they glide), cfg the limits, ui { focus: the focused target's id,
 * pressed: the pressed one's }. targets(page) lists the page's pressable
 * boxes in controller order: { id, x, y, w, h }.
 */
const L = require('./limits.js');

const W = 2880;
const H = 764;
const C = {
    asphalt: '#10161D', line: '#2A3642', text: '#E9EEF2', dim: '#8394A4',
    cold: '#5FA8D9', ice: '#A9DCFF', limit: '#FF5B4F', redzone: '#FF5B4F59'
};
const PAD = 96;
const RPM_MAX = 7700;
const OIL_MAX = 130;
const OIL_PRESS_RPM = 1500;    // the oil pressure warning counts above this engine speed
const COL = { left: { x: PAD, w: 660 }, mid: { x: 876, w: 1180 }, right: { x: 2176, w: 608 } };

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

/* ---- pressable targets ---- */

const MAIN_TARGETS = [
    { id: 'reset', x: COL.right.x, y: 650, w: 336, h: 92, label: 'Spitzen zurücksetzen' },
    { id: 'settings', x: COL.right.x + 360, y: 650, w: 248, h: 92, label: 'Einstellungen' }
];

const ROW_H = 120;
const SET_TOP = 196;
const SET_COLS = [{ x: PAD, w: 1300 }, { x: PAD + 1388, w: 1300 }];
const BTN = 96;

function settingsTargets() {
    const out = [];
    L.ITEMS.forEach((it, i) => {
        const col = SET_COLS[i < 4 ? 0 : 1];
        const y = SET_TOP + (i % 4) * ROW_H;
        const right = col.x + col.w;
        out.push({ id: `dec:${it.key}`, x: right - 2 * BTN - 24, y: y + 6, w: BTN, h: BTN, label: '−' });
        out.push({ id: `inc:${it.key}`, x: right - BTN, y: y + 6, w: BTN, h: BTN, label: '+' });
    });
    out.push({ id: 'defaults', x: SET_COLS[1].x + SET_COLS[1].w - 2 * 300 - 24, y: 650, w: 300, h: 92, label: 'Standard' });
    out.push({ id: 'done', x: SET_COLS[1].x + SET_COLS[1].w - 300, y: 650, w: 300, h: 92, label: 'Fertig' });
    return out;
}
const SETTINGS_TARGETS = settingsTargets();

function targets(page) {
    return page === 'settings' ? SETTINGS_TARGETS : MAIN_TARGETS;
}

function button(rec, t, ui, opts) {
    const r = t.h / 2;
    if (ui && ui.focus === t.id) {
        rec.strokeRoundRect(t.x - 8, t.y - 8, t.w + 16, t.h + 16, r + 8, 5, C.ice);
    }
    if (ui && ui.pressed === t.id) {
        rec.roundRect(t.x, t.y, t.w, t.h, r, C.line);
    }
    rec.strokeRoundRect(t.x, t.y, t.w, t.h, r, 3, opts && opts.primary ? C.text : C.line);
    const size = (opts && opts.size) || 32;
    rec.text(t.label, t.x + t.w / 2, t.y + t.h / 2 + size * 0.36, size, C.text, { font: 'label', align: 'center' });
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

/* ---- the main page ---- */

function rpmBand(rec, v, cfg) {
    const x = PAD;
    const w = 2144;
    const y = 60;
    const h = 44;
    const red = cfg.rpmRed;
    rec.roundRect(x, y, w, h, 4, C.line);
    rec.fillRect(x + w * red / RPM_MAX, y, w * (RPM_MAX - red) / RPM_MAX, h, C.redzone);
    const bar = isNum(v.rpmBar) ? v.rpmBar : v.rpm;
    if (isNum(bar) && bar > 0) {
        rec.fillRect(x, y, w * clamp(bar, 0, RPM_MAX) / RPM_MAX, h, isNum(v.rpm) && v.rpm >= red ? C.limit : C.text);
    }
    if (isNum(v.rpmPeak) && v.rpmPeak > 0) {
        rec.fillRect(x + w * clamp(v.rpmPeak, 0, RPM_MAX) / RPM_MAX - 3, y - 8, 6, h + 16, C.ice);
    }
    for (let k = 0; k <= 7; k++) {
        rec.text(String(k), x + w * k * 1000 / RPM_MAX, 146, 28, C.dim, { font: 'scale', align: k ? 'center' : 'left' });
    }
    const rpmColor = isNum(v.rpm) && v.rpm >= red ? C.limit : C.text;
    valueUnit(rec, isNum(v.rpm) ? thousands(v.rpm) : '–', 'U/min', W - PAD, 128, 124, rpmColor, 32, 'right');
    if (isNum(v.rpmPeak) && v.rpmPeak > 0) {
        rec.text(`Spitze ${thousands(v.rpmPeak)}`, W - PAD, 176, 30, C.ice, { font: 'scale', align: 'right' });
    }
}

function readiness(rec, v, cfg) {
    const { x, w } = COL.left;
    const readyAt = cfg.oilReady;
    rec.text('Öltemperatur', x, 262, 34, C.dim, { font: 'label' });
    const oil = v.oil;
    const ready = isNum(oil) && oil >= readyAt;
    const t = isNum(oil) ? clamp((oil - 20) / (readyAt - 20), 0, 1) : 0;
    const color = !isNum(oil) ? C.dim : ready ? C.text : mix(C.cold, C.text, t * 0.6);
    valueUnit(rec, isNum(oil) ? String(Math.round(oil)) : '–', '°C', x, 420, 160, color, 36, 'left');

    const by = 448;
    const bh = 52;
    rec.roundRect(x, by, w, bh, 8, C.line);
    if (isNum(oil) && oil > 0) {
        rec.roundRect(x, by, Math.max(bh, w * clamp(oil, 0, OIL_MAX) / OIL_MAX), bh, 8, color);
    }
    const mx = x + w * readyAt / OIL_MAX;
    rec.fillRect(mx - 3, by - 12, 6, bh + 24, C.text);
    rec.text(String(readyAt), mx, by - 20, 26, C.dim, { font: 'scale', align: 'center' });
    const note = !isNum(oil) ? '' : ready ? 'Bereit für Volllast' : `Noch ${Math.ceil(readyAt - oil)} °C bis bereit`;
    rec.text(note, x, 552, 34, ready ? C.text : C.cold, { font: 'label' });

    const cells = [['Kühlmittel', v.coolant, cfg.coolantMax], ['Ansaugluft', v.intake, null], ['Ladeluft', v.charge, null]];
    cells.forEach((c, i) => {
        const cx = x + i * 236;
        const hot = isNum(c[1]) && c[2] !== null && c[1] >= c[2];
        rec.text(c[0], cx, 630, 28, C.dim, { font: 'label' });
        valueUnit(rec, isNum(c[1]) ? String(Math.round(c[1])) : '–', '°C', cx, 702, 54, hot ? C.limit : C.text, 26, 'left');
    });
}

function power(rec, v, cfg) {
    const { x, w } = COL.mid;
    const max = cfg.boostMax;
    rec.text('Ladedruck', x, 262, 34, C.dim, { font: 'label' });
    const b = isNum(v.boost) ? Math.max(0, v.boost) : null;
    valueUnit(rec, b === null ? '–' : de(b, 2), 'bar', x, 440, 196, C.text, 38, 'left');
    const ty = 478;
    const th = 60;
    rec.roundRect(x, ty, w, th, 6, C.line);
    const bar = isNum(v.boostBar) ? Math.max(0, v.boostBar) : b;
    if (bar !== null && bar > 0) {
        rec.roundRect(x, ty, Math.max(12, w * clamp(bar, 0, max) / max), th, 6, C.text);
    }
    if (isNum(v.boostTarget) && v.boostTarget > 0) {
        const sx = x + w * clamp(v.boostTarget, 0, max) / max;
        for (let yy = ty - 14; yy < ty + th + 14; yy += 14) {
            rec.fillRect(sx - 2, yy, 4, 8, C.dim);
        }
    }
    if (isNum(v.boostPeak) && v.boostPeak > 0) {
        rec.fillRect(x + w * clamp(v.boostPeak, 0, max) / max - 4, ty - 14, 8, th + 28, C.ice);
    }
    const steps = Math.round(max / 0.5);
    for (let i = 0; i <= steps; i++) {
        const s = i === 0 ? '0' : de(i * 0.5, 1);
        rec.text(s, x + w * i / steps, 590, 28, C.dim, { font: 'scale', align: i === 0 ? 'left' : i === steps ? 'right' : 'center' });
    }
    // the row under it, level with the temperatures on the left: target, peak, power, torque
    const cells = [
        ['Soll', isNum(v.boostTarget) ? de(Math.max(0, v.boostTarget), 2) : '–', 'bar', null, C.text],
        ['Spitze', isNum(v.boostPeak) ? de(Math.max(0, v.boostPeak), 2) : '–', 'bar', null, C.ice],
        ['Leistung', isNum(v.power) ? String(Math.round(Math.max(0, v.power))) : '–', 'PS', v.powerPeak, C.text],
        ['Drehmoment', isNum(v.torque) ? String(Math.round(v.torque)) : '–', 'Nm', v.torquePeak, C.text]
    ];
    cells.forEach((c, i) => {
        const cx = x + i * 296;
        const lw = rec.text(c[0], cx, 630, 28, c[4] === C.ice ? C.ice : C.dim, { font: 'label' });
        if (isNum(c[3]) && c[3] > 0) {
            rec.text(`max ${Math.round(c[3])}`, cx + lw + 12, 630, 26, C.ice, { font: 'scale' });
        }
        valueUnit(rec, c[1], c[2], cx, 702, 54, c[4], 26, 'left');
    });
}

function health(rec, v, cfg, ui) {
    const { x } = COL.right;
    rec.text('Öldruck', x, 262, 34, C.dim, { font: 'label' });
    const low = isNum(v.oilPress) && isNum(v.rpm) && v.rpm > OIL_PRESS_RPM && v.oilPress < cfg.oilPressMin;
    valueUnit(rec, isNum(v.oilPress) ? de(v.oilPress, 1) : '–', 'bar', x, 362, 100, low ? C.limit : C.text, 32, 'left');
    if (isNum(v.oilPressPeak)) {
        rec.text(`Spitze ${de(v.oilPressPeak, 1)} bar`, x, 408, 30, C.ice, { font: 'scale' });
    }
    const cells = [
        ['Getriebeöl', isNum(v.gearbox) ? String(Math.round(v.gearbox)) : '–', '°C', isNum(v.gearbox) && v.gearbox >= cfg.gearboxMax],
        ['Abgas', isNum(v.exhaust) ? String(Math.round(v.exhaust)) : '–', '°C', isNum(v.exhaust) && v.exhaust >= cfg.exhaustMax],
        ['Bordnetz', isNum(v.voltage) ? de(v.voltage, 1) : '–', 'V', false]
    ];
    cells.forEach((c, i) => {
        const cx = x + i * 216;
        rec.text(c[0], cx, 492, 28, C.dim, { font: 'label' });
        valueUnit(rec, c[1], c[2], cx, 566, 54, c[3] ? C.limit : C.text, 26, 'left');
    });
    MAIN_TARGETS.forEach((t) => button(rec, t, ui));
}

/* ---- the settings page ---- */

function settings(rec, cfg, ui) {
    rec.text('Grenzwerte', PAD, 120, 56, C.text, { font: 'label' });
    rec.text('Ab diesen Werten färbt sich die Anzeige rot. Das Ölband wird weiß, sobald das Öl bereit ist.', PAD, 166, 30, C.dim,
        { font: 'label' });
    L.ITEMS.forEach((it, i) => {
        const col = SET_COLS[i < 4 ? 0 : 1];
        const y = SET_TOP + (i % 4) * ROW_H;
        rec.fillRect(col.x, y + ROW_H - 6, col.w, 2, C.line);
        rec.text(it.label, col.x, y + 68, 38, C.text, { font: 'label' });
        const changed = cfg[it.key] !== it.def;
        const value = it.d ? de(cfg[it.key], it.d) : String(cfg[it.key]);
        valueUnit(rec, value, it.unit, col.x + col.w - 2 * BTN - 56, y + 74, 54, changed ? C.ice : C.text, 28, 'right');
    });
    SETTINGS_TARGETS.forEach((t) => {
        const step = t.id.indexOf('dec:') === 0 || t.id.indexOf('inc:') === 0;
        button(rec, t, ui, { size: step ? 52 : 32, primary: t.id === 'done' });
    });
}

function draw(rec, page, v, cfg, ui) {
    rec.clear(C.asphalt);
    if (page === 'settings') {
        settings(rec, cfg, ui);
        return rec;
    }
    rpmBand(rec, v, cfg);
    readiness(rec, v, cfg);
    power(rec, v, cfg);
    health(rec, v, cfg, ui);
    if (v.status) {
        rec.text(v.status, PAD, 752, 30, v.statusErr ? C.limit : C.dim, { font: 'label' });
    }
    return rec;
}

module.exports = { draw, targets, W, H, C };
