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
 * A tab rail on the left on every page: Live, Logs, Grenzwerte.
 * Page 'settings': the limits (src/limits.js), each with - and +, and
 *   Standard.
 * Page 'logs': the recordings (src/logbook.js) with date, duration, peaks.
 * Page 'log': one recording's curves by channel group, Löschen (twice), Zurück.
 *
 * draw(rec, page, v, cfg, ui, extra) records one frame into a kit_record Recorder
 * (or a kit_canvas Canvas): v the values (null: none; rpmBar / boostBar the
 * bars as they glide), cfg the limits, ui { focus: the focused target's id,
 * pressed: the pressed one's }, extra { recording: { ms }, logs, log, channel,
 * confirmDelete }. targets(page, extra) lists the page's pressable boxes in
 * controller order: { id, x, y, w, h, label }.
 */
const L = require('./limits.js');

const W = 2880;
const H = 764;
const C = {
    asphalt: '#10161D', line: '#2A3642', text: '#E9EEF2', dim: '#8394A4',
    cold: '#5FA8D9', ice: '#A9DCFF', limit: '#FF5B4F', redzone: '#FF5B4F59'
};
const PAD = 96;
const RAIL = 200;             // the tab rail on the left
const X0 = RAIL + 60;          // where page content starts
const RPM_MAX = 7700;
const OIL_MAX = 130;
const OIL_PRESS_RPM = 1500;    // the oil pressure warning counts above this engine speed
const COL = { left: { x: X0, w: 600 }, mid: { x: 980, w: 1076 }, right: { x: 2176, w: 608 } };

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

/* The main page's buttons, side by side at the bottom of the right column. The recording button's words
 * follow the recording (mainTargets). */
const BW = 292;
const BH = 84;
function mainTargets(extra) {
    const x = COL.right.x;
    const rec = extra && extra.recording;
    const t = rec ? Math.floor(rec.ms / 1000) : 0;
    const time = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    return [
        { id: 'record', x, y: 650, w: BW, h: BH, label: rec ? `Stopp ${time}` : 'Aufnehmen', live: !!rec },
        { id: 'reset', x: x + BW + 24, y: 650, w: BW, h: BH, label: 'Reset' }
    ];
}

/* The tabs, on every page: first in controller order. */
const TABS = [
    { id: 'tab:main', page: 'main', label: 'Live' },
    { id: 'tab:logs', page: 'logs', label: 'Logs' },
    { id: 'tab:settings', page: 'settings', label: 'Grenzwerte' }
].map((t, i) => Object.assign(t, { x: 0, y: 24 + i * 176, w: RAIL, h: 160 }));

const ROW_H = 120;
const SET_TOP = 196;
const SET_COLS = [{ x: X0, w: 1200 }, { x: X0 + 1288, w: 1236 }];
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
    out.push({ id: 'defaults', x: SET_COLS[1].x + SET_COLS[1].w - 300, y: 650, w: 300, h: 92, label: 'Standard' });
    return out;
}
const SETTINGS_TARGETS = settingsTargets();

/* ---- the logs pages ---- */

const two = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d ? `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}` : '');
const duration = (ms) => { const t = Math.round((ms || 0) / 1000); return `${Math.floor(t / 60)}:${two(t % 60)}`; };

const LOG_ROWS = 8;            // recordings on the list page (2 columns of 4)
const LOG_COLS = [{ x: X0, w: 1200 }, { x: X0 + 1288, w: 1236 }];
const BACK = { id: 'back', x: W - PAD - 300, y: 660, w: 300, h: BH, label: 'Zurück' };
const CHANNELS = [
    { id: 'rpm', label: 'Drehzahl & Leistung' },
    { id: 'boost', label: 'Ladedruck' },
    { id: 'temps', label: 'Temperaturen' },
    { id: 'oil', label: 'Öldruck' }
];

function logsTargets(extra) {
    const logs = (extra && extra.logs) || [];
    const out = logs.slice(0, LOG_ROWS).map((r, i) => {
        const col = LOG_COLS[i < 4 ? 0 : 1];
        return { id: `open:${i}`, x: col.x, y: 196 + (i % 4) * 112, w: col.w, h: 100, label: dateText(r.start) };
    });
    return out;
}

function logTargets(extra) {
    const out = CHANNELS.map((c, i) => ({ id: `chan:${c.id}`, x: X0 + i * 420, y: 150, w: 396, h: 72, label: c.label }));
    const confirm = extra && extra.confirmDelete;
    out.push({ id: confirm ? 'delete!' : 'delete', x: W - PAD - 300 - 24 - (confirm ? 360 : 300), y: 660,
        w: confirm ? 360 : 300, h: BH, label: confirm ? 'Wirklich löschen' : 'Löschen', danger: confirm });
    out.push(BACK);
    return out;
}

/* The page's pressable targets in controller order: the tabs, then the page's own. */
function targets(page, extra) {
    let own = mainTargets(extra);
    if (page === 'settings') {
        own = SETTINGS_TARGETS;
    } else if (page === 'logs') {
        own = logsTargets(extra);
    } else if (page === 'log') {
        own = logTargets(extra);
    }
    return TABS.concat(own);
}

/* The tab rail: the page's tab marked (the log page belongs to Logs). */
function rail(rec, page, ui) {
    rec.fillRect(0, 0, RAIL, H, '#0C1117');
    rec.fillRect(RAIL - 2, 0, 2, H, C.line);
    const current = page === 'log' ? 'logs' : page;
    TABS.forEach((t) => {
        const on = t.page === current;
        if (ui && ui.pressed === t.id) {
            rec.fillRect(t.x, t.y, t.w, t.h, C.line);
        }
        if (on) {
            rec.fillRect(0, t.y + 24, 8, t.h - 48, C.ice);
        }
        if (ui && ui.focus === t.id) {
            rec.strokeRoundRect(t.x + 10, t.y + 6, t.w - 20, t.h - 12, 14, 4, C.ice);
        }
        rec.text(t.label, RAIL / 2, t.y + t.h / 2 + 12, 32, on ? C.text : C.dim, { font: 'label', align: 'center' });
    });
}

function button(rec, t, ui, opts) {
    const r = t.h / 2;
    const live = t.live || t.danger;
    if (ui && ui.focus === t.id) {
        rec.strokeRoundRect(t.x - 8, t.y - 8, t.w + 16, t.h + 16, r + 8, 5, C.ice);
    }
    if (ui && ui.pressed === t.id) {
        rec.roundRect(t.x, t.y, t.w, t.h, r, C.line);
    }
    if (live) {
        rec.roundRect(t.x, t.y, t.w, t.h, r, C.limit);
    }
    rec.strokeRoundRect(t.x, t.y, t.w, t.h, r, 3, live ? C.limit : opts && opts.primary ? C.text : C.line);
    const size = (opts && opts.size) || 32;
    rec.text(t.label, t.x + t.w / 2, t.y + t.h / 2 + size * 0.36, size, live ? C.asphalt : C.text, { font: 'label', align: 'center' });
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
    const x = X0;
    const w = 2224 - X0;
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
        const cx = x + i * 268;
        const lw = rec.text(c[0], cx, 630, 28, c[4] === C.ice ? C.ice : C.dim, { font: 'label' });
        if (isNum(c[3]) && c[3] > 0) {
            rec.text(`max ${Math.round(c[3])}`, cx + lw + 12, 630, 26, C.ice, { font: 'scale' });
        }
        valueUnit(rec, c[1], c[2], cx, 702, 54, c[4], 26, 'left');
    });
}

function health(rec, v, cfg, ui, extra) {
    const { x } = COL.right;
    rec.text('Öldruck', x, 262, 34, C.dim, { font: 'label' });
    const low = isNum(v.oilPress) && isNum(v.rpm) && v.rpm > OIL_PRESS_RPM && v.oilPress < cfg.oilPressMin;
    valueUnit(rec, isNum(v.oilPress) ? de(v.oilPress, 1) : '–', 'bar', x, 352, 96, low ? C.limit : C.text, 32, 'left');
    if (isNum(v.oilPressPeak)) {
        rec.text(`Spitze ${de(v.oilPressPeak, 1)} bar`, x, 394, 30, C.ice, { font: 'scale' });
    }
    const cells = [
        ['Getriebeöl', isNum(v.gearbox) ? String(Math.round(v.gearbox)) : '–', '°C', isNum(v.gearbox) && v.gearbox >= cfg.gearboxMax],
        ['Abgas', isNum(v.exhaust) ? String(Math.round(v.exhaust)) : '–', '°C', isNum(v.exhaust) && v.exhaust >= cfg.exhaustMax],
        ['Bordnetz', isNum(v.voltage) ? de(v.voltage, 1) : '–', 'V', false]
    ];
    cells.forEach((c, i) => {
        const cx = x + i * 216;
        rec.text(c[0], cx, 452, 28, C.dim, { font: 'label' });
        valueUnit(rec, c[1], c[2], cx, 516, 54, c[3] ? C.limit : C.text, 26, 'left');
    });
    mainTargets(extra).forEach((t) => button(rec, t, ui, { size: 28 }));
}

/* ---- the settings page ---- */

function settings(rec, cfg, ui) {
    rec.text('Grenzwerte', X0, 120, 56, C.text, { font: 'label' });
    rec.text('Ab diesen Werten färbt sich die Anzeige rot. Das Ölband wird weiß, sobald das Öl bereit ist.', X0, 166, 30, C.dim,
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


function logsPage(rec, ui, extra) {
    const logs = (extra && extra.logs) || [];
    rec.text('Aufzeichnungen', X0, 120, 56, C.text, { font: 'label' });
    rec.text(logs.length ? `${logs.length} gespeichert, die neueste zuerst. Es bleiben die letzten 20.` :
        'Noch keine Aufzeichnung. Starte eine mit Aufnehmen im Reiter Live.', X0, 166, 30, C.dim, { font: 'label' });
    logsTargets(extra).forEach((t, i) => {
        const r = logs[i];
        if (ui && ui.focus === t.id) {
            rec.strokeRoundRect(t.x - 8, t.y - 4, t.w + 16, t.h + 8, 16, 5, C.ice);
        }
        if (ui && ui.pressed === t.id) {
            rec.roundRect(t.x, t.y, t.w, t.h, 12, C.line);
        }
        rec.fillRect(t.x, t.y + t.h + 4, t.w, 2, C.line);
        rec.text(dateText(r.start), t.x + 8, t.y + 46, 36, C.text, { font: 'label' });
        rec.text(`Dauer ${duration(r.duration)}`, t.x + 8, t.y + 86, 28, C.dim, { font: 'label' });
        // the engine speed over the recording, small
        const sp = r.spark || [];
        const sx = t.x + 380;
        const sw = 300;
        const pts = [];
        sp.forEach((y, k) => { if (isNum(y)) pts.push([sx + sw * k / Math.max(1, sp.length - 1), t.y + 84 - 64 * clamp(y / RPM_MAX, 0, 1)]); });
        if (pts.length > 1) {
            rec.fillRect(sx, t.y + 84, sw, 2, C.line);
            rec.polyline(pts, 3, C.dim);
        }
        const p = r.peak || {};
        const peaks = [isNum(p.rpm) ? `${thousands(p.rpm)} U/min` : null, isNum(p.boost) ? `${de(Math.max(0, p.boost), 2)} bar` : null,
            isNum(p.power) ? `${Math.round(p.power)} PS` : null].filter(Boolean).join('    ');
        rec.text(peaks, t.x + t.w - 8, t.y + 62, 34, C.ice, { font: 'scale', align: 'right' });
    });
}

/* The charts of the log page, by channel group. Each has a left axis and maybe a right one; a curve
 * belongs to one of them. An axis runs from 0 (or below, for a value that went below) to a round
 * number at least its floor, so small values stay small instead of filling the chart.
 *   axes: { left: { unit, d, floor }, right: { ... } }
 *   curves: [field, colour, axis, legend] */
const GROUPS = {
    rpm: { axes: { left: { unit: 'U/min', d: 0, floor: 8000, color: C.text }, right: { unit: 'PS', d: 0, floor: 100, color: C.cold } },
        curves: [['rpm', C.text, 'left', 'Drehzahl'], ['power', C.cold, 'right', 'Leistung']] },
    boost: { axes: { left: { unit: 'bar', d: 1, floor: 0.5, color: C.text } },
        curves: [['boost', C.text, 'left', 'Ladedruck'], ['boostTarget', C.dim, 'left', 'Soll']] },
    temps: { axes: { left: { unit: '°C', d: 0, floor: 100, color: C.text } },
        curves: [['oil', C.text, 'left', 'Öl'], ['coolant', C.ice, 'left', 'Kühlmittel'], ['charge', C.cold, 'left', 'Ladeluft'],
            ['gearbox', C.dim, 'left', 'Getriebe']] },
    oil: { axes: { left: { unit: 'bar', d: 1, floor: 2, color: C.text }, right: { unit: 'U/min', d: 0, floor: 8000, color: C.dim } },
        curves: [['oilPress', C.text, 'left', 'Öldruck'], ['rpm', C.dim, 'right', 'Drehzahl']] }
};

/* The smallest round number (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^n) at least v: its quarters stay round too. */
function niceUp(v) {
    if (!(v > 0)) {
        return 1;
    }
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (m * p >= v - 1e-9) {
            return m * p;
        }
    }
    return 10 * p;
}

const axisText = (v, d) => (d ? de(v, d) : thousands(v));

function logPage(rec, ui, extra) {
    const log = extra && extra.log;
    const chan = (extra && extra.channel) || 'rpm';
    rec.text(log ? `${dateText(log.start)} · ${duration(log.duration)}` : 'Aufzeichnung', X0, 110, 48, C.text, { font: 'label' });
    logTargets(extra).forEach((t) => {
        const on = t.id === `chan:${chan}`;
        button(rec, t, ui, { size: 28, primary: on });
    });
    const group = GROUPS[chan];
    const box = { x: X0 + 110, y: 300, w: W - PAD - X0 - 110 - (group.axes.right ? 120 : 0), h: 270 };
    rec.roundRect(box.x, box.y, box.w, box.h, 8, '#141C25');
    if (!log || !log.t.length) {
        rec.text('Keine Werte in dieser Aufzeichnung.', box.x + 40, box.y + 80, 34, C.dim, { font: 'label' });
        return;
    }
    const span = Math.max(1, log.t[log.t.length - 1]);

    // each axis: 0 (or the lowest value) to a round number covering its curves, at least its floor
    const scale = {};
    Object.keys(group.axes).forEach((name) => {
        const ax = group.axes[name];
        let hi = 0;
        let lo = 0;
        group.curves.filter((c) => c[2] === name).forEach((c) => (log.series[c[0]] || []).forEach((y) => {
            if (isNum(y)) { hi = Math.max(hi, y); lo = Math.min(lo, y); }
        }));
        const top = niceUp(Math.max(hi, ax.floor));
        const bottom = lo < 0 ? -niceUp(-lo) : 0;
        scale[name] = { lo: bottom, hi: top };
    });
    const yOf = (name, v) => {
        const sc = scale[name];
        return box.y + box.h - (box.h) * clamp((v - sc.lo) / (sc.hi - sc.lo), 0, 1);
    };

    // grid and axis labels: four steps; each axis in its curve's colour, its unit above it
    for (let k = 0; k <= 4; k++) {
        const gy = box.y + box.h - box.h * k / 4;
        rec.fillRect(box.x, gy, box.w, 1, C.line);
        Object.keys(group.axes).forEach((name) => {
            const ax = group.axes[name];
            const sc = scale[name];
            const val = sc.lo + (sc.hi - sc.lo) * k / 4;
            const right = name === 'right';
            rec.text(axisText(val, ax.d), right ? box.x + box.w + 16 : box.x - 16, gy + 9, 26, ax.color,
                { font: 'scale', align: right ? 'left' : 'right' });
        });
    }
    Object.keys(group.axes).forEach((name) => {
        const ax = group.axes[name];
        const right = name === 'right';
        rec.text(ax.unit, right ? box.x + box.w + 16 : box.x - 16, box.y - 36, 26, ax.color,
            { font: 'label', align: right ? 'left' : 'right' });
    });
    const minute = 60000;
    const every = span > 20 * minute ? 5 * minute : span > 5 * minute ? minute : span > minute ? 15000 : 5000;
    for (let tm = every; tm < span; tm += every) {
        const gx = box.x + box.w * tm / span;
        rec.fillRect(gx, box.y, 1, box.h, C.line);
        if (box.w * (span - tm) / span > 60) {
            rec.text(duration(tm), gx, box.y + box.h + 34, 26, C.dim, { font: 'scale', align: 'center' });
        }
    }
    rec.text('0:00', box.x, box.y + box.h + 34, 26, C.dim, { font: 'scale' });
    rec.text(duration(span), box.x + box.w, box.y + box.h + 34, 26, C.dim, { font: 'scale', align: 'right' });

    // the curves, broken where a value is missing; the legend names each with its peak and unit
    let lx = X0;
    group.curves.forEach((c) => {
        const ys = log.series[c[0]] || [];
        let seg = [];
        const flush = () => { if (seg.length > 1) rec.polyline(seg, 3, c[1]); seg = []; };
        ys.forEach((y, i) => {
            if (!isNum(y)) { flush(); return; }
            seg.push([box.x + box.w * log.t[i] / span, yOf(c[2], y)]);
        });
        flush();
        const ax = group.axes[c[2]];
        const peak = ys.reduce((m, y) => (isNum(y) && (m === null || y > m) ? y : m), null);
        const text = `${c[3]}  max ${peak === null ? '–' : axisText(peak, ax.d === 0 ? 0 : Math.max(ax.d, 1))} ${ax.unit}`;
        rec.fillRect(lx, 666, 28, 6, c[1]);
        lx += 40 + rec.text(text, lx + 40, 680, 28, C.text, { font: 'scale' }) + 56;
    });
}

function draw(rec, page, v, cfg, ui, extra) {
    rec.clear(C.asphalt);
    rail(rec, page, ui);
    if (page === 'settings') {
        settings(rec, cfg, ui);
        return rec;
    }
    if (page === 'logs') {
        logsPage(rec, ui, extra);
        return rec;
    }
    if (page === 'log') {
        logPage(rec, ui, extra);
        return rec;
    }
    rpmBand(rec, v, cfg);
    readiness(rec, v, cfg);
    power(rec, v, cfg);
    health(rec, v, cfg, ui, extra);
    if (v.status) {
        rec.text(v.status, X0, 752, 30, v.statusErr ? C.limit : C.dim, { font: 'label' });
    }
    return rec;
}

module.exports = { draw, targets, W, H, C };
