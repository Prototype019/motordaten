'use strict';
/**
 * The Motordaten screens as drawing calls (docs/design/motordaten.html, laid
 * out for the iDrive 8 app area: 2880 x 764 logical px at scale 1).
 *
 * Page 'main':
 *   engine speed band across the top, the number and its peak at the right;
 *   readiness (oil temperature band, then coolant, intake air and gearbox oil),
 *   power (boost with its target and peak, power and torque), health (oil pressure with its
 *   peak; transmission oil, exhaust and supply voltage; the buttons).
 * A tab rail on the left on every page: Live, Logs, Fehler, Grenzwerte.
 * Page 'settings': the limits (src/limits.js), each with - and +, and
 *   Standard.
 * Page 'logs': the recordings (src/logbook.js) with date, duration, peaks.
 * Page 'log': one recording's curves by channel group, Löschen (twice), Zurück.
 * Page 'faults' (tab Fehler): every unit's fault memory, read live one by one; 'faultunit' one unit's entries.
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
    cold: '#5FA8D9', ice: '#A9DCFF', limit: '#FF5B4F', redzone: '#FF5B4F59', ok: '#4FD18B'
};
const PAD = 96;
const RAIL = 200;             // the tab rail on the left
const X0 = RAIL + 60;          // where page content starts
const RPM_MAX = 7700;
const OIL_MAX = 150;
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
    { id: 'tab:faults', page: 'faults', label: 'Fehler' },
    { id: 'tab:settings', page: 'settings', label: 'Einstellungen' }
].map((t, i) => Object.assign(t, { x: 0, y: 16 + i * 184, w: RAIL, h: 168 }));

const ROW_H = 88;
const SET_ROWS = 6;           // limits per column
const SET_BTN = 76;
const SET_TOP = 196;
const SET_COLS = [{ x: X0, w: 1200 }, { x: X0 + 1288, w: 1236 }];
const BTN = 96;

const LIMIT_ITEMS = L.ITEMS.filter((it) => it.group === 'limits');
const BACK_SET = { id: 'settings:back', x: W - PAD - 300, y: 64, w: 300, h: 84, label: 'Zurück' };

/* The settings menu: one card per sub-page. */
const MENU = [
    { id: 'menu:limits', page: 'limits', label: 'Grenzwerte', text: 'Ab wann jeder Wert rot wird: Drehzahl, Temperaturen, Drücke, Klopfen, Ölstand, Bordnetz' },
    { id: 'menu:ready', page: 'ready', label: 'Bereit für Volllast', text: 'Welche Temperaturen erreicht sein müssen, bis die Live-Seite „Bereit“ zeigt' }
].map((m, i) => Object.assign(m, { x: X0 + i * 1288, y: 220, w: 1236, h: 300 }));

function settingsTargets() {
    const out = [];
    LIMIT_ITEMS.forEach((it, i) => {
        const col = SET_COLS[i < SET_ROWS ? 0 : 1];
        const y = SET_TOP + (i % SET_ROWS) * ROW_H;
        const right = col.x + col.w;
        out.push({ id: `dec:${it.key}`, x: right - 2 * SET_BTN - 24, y: y + 6, w: SET_BTN, h: SET_BTN, label: '−' });
        out.push({ id: `inc:${it.key}`, x: right - SET_BTN, y: y + 6, w: SET_BTN, h: SET_BTN, label: '+' });
    });
    out.push({ id: 'defaults', x: BACK_SET.x - 24 - 300, y: 64, w: 300, h: 84, label: 'Standard' });
    out.push(BACK_SET);
    return out;
}
const SETTINGS_TARGETS = settingsTargets();

/* The ready page: per temperature a row with its switch, then its threshold's − and +. */
const READY_ROW_H = 150;
function readyTargets() {
    const out = [];
    L.READY.forEach((r, i) => {
        const y = SET_TOP + 20 + i * READY_ROW_H;
        const right = SET_COLS[0].x + 1700;
        out.push({ id: `toggle:${r.on}`, x: X0, y: y + 10, w: 220, h: BTN, label: '' });
        out.push({ id: `dec:${r.at}`, x: right - 2 * BTN - 24, y: y + 10, w: BTN, h: BTN, label: '−' });
        out.push({ id: `inc:${r.at}`, x: right - BTN, y: y + 10, w: BTN, h: BTN, label: '+' });
    });
    out.push({ id: 'defaults', x: BACK_SET.x - 24 - 300, y: 64, w: 300, h: 84, label: 'Standard' });
    out.push(BACK_SET);
    return out;
}
const READY_TARGETS = readyTargets();

/* ---- the logs pages ---- */

const two = (n) => String(n).padStart(2, '0');
/* Dates here are wall-clock Dates (clock.js): read with getUTC... */
const dateText = (d) => (d ? `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : '');
const duration = (ms) => { const t = Math.round((ms || 0) / 1000); return `${Math.floor(t / 60)}:${two(t % 60)}`; };

const LOG_ROWS = 8;            // recordings on the list page (2 columns of 4)
const LOG_COLS = [{ x: X0, w: 1200 }, { x: X0 + 1288, w: 1236 }];
const BACK = { id: 'back', x: W - PAD - 300, y: 660, w: 300, h: BH, label: 'Zurück' };
const CHANNELS = [
    { id: 'rpm', label: 'Drehzahl & Leistung' },
    { id: 'boost', label: 'Ladedruck' },
    { id: 'temps', label: 'Temperaturen' },
    { id: 'oil', label: 'Öldruck' },
    { id: 'mix', label: 'Lambda & Klopfen' },
    { id: 'fuel', label: 'Kraftstoff' },
    { id: 'load', label: 'Last & Zündung' },
    { id: 'knock', label: 'Klopfen je Zyl.' }
];

const FAULT_ROWS = 8;

/* The fault page's grid: every unit a tile, 5 across. */
const GRID = { cols: 5, x: X0, y: 196, w: W - PAD - X0, rowH: 64, gap: 12 };
function tileBox(i) {
    const cw = (GRID.w - GRID.gap * (GRID.cols - 1)) / GRID.cols;
    return { x: GRID.x + (i % GRID.cols) * (cw + GRID.gap), y: GRID.y + Math.floor(i / GRID.cols) * GRID.rowH, w: cw, h: GRID.rowH - 10 };
}

function faultsTargets(extra) {
    const f = (extra && extra.faults) || {};
    const out = [];
    // the units with entries open their page
    (f.scan || []).forEach((u, i) => {
        if (u.state === 'faults') {
            out.push(Object.assign({ id: `unit:${u.addr}`, label: u.name }, tileBox(i)));
        }
    });
    out.push({ id: 'faults:read', x: W - PAD - 300, y: 668, w: 300, h: 80, label: 'Neu lesen' });
    if (f.entries && f.entries.length && !f.reading) {
        const confirm = !!f.confirmClear;
        out.push({ id: confirm ? 'faults:clear!' : 'faults:clear', x: W - PAD - 300 - 24 - 360, y: 668, w: 360, h: 80,
            label: confirm ? 'Wirklich löschen' : 'Fehler löschen', danger: confirm });
    }
    return out;
}

function faultUnitTargets() {
    return [{ id: 'faults:back', x: W - PAD - 300, y: 668, w: 300, h: 80, label: 'Zurück' }];
}

function logsTargets(extra) {
    const logs = (extra && extra.logs) || [];
    const out = logs.slice(0, LOG_ROWS).map((r, i) => {
        const col = LOG_COLS[i < 4 ? 0 : 1];
        return { id: `open:${i}`, x: col.x, y: 196 + (i % 4) * 112, w: col.w, h: 100, label: dateText(r.start) };
    });
    if (logs.length) {
        const sure = extra && extra.confirmDeleteAll;
        const w = sure ? 460 : 340;
        out.push({ id: sure ? 'deleteAll!' : 'deleteAll', x: W - PAD - w, y: 64, w, h: 84,
            label: sure ? 'Wirklich alle löschen' : 'Alle löschen', danger: sure });
        out.push({ id: 'usb', x: W - PAD - w - 24 - 380, y: 64, w: 380, h: 84, label: 'Auf USB speichern' });
    }
    return out;
}

function logTargets(extra) {
    const out = CHANNELS.map((c, i) => ({ id: `chan:${c.id}`, x: X0 + i * 315, y: 150, w: 299, h: 72, label: c.label }));
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
        own = MENU;
    } else if (page === 'limits') {
        own = SETTINGS_TARGETS;
    } else if (page === 'ready') {
        own = READY_TARGETS;
    } else if (page === 'logs') {
        own = logsTargets(extra);
    } else if (page === 'log') {
        own = logTargets(extra);
    } else if (page === 'faults') {
        own = faultsTargets(extra);
    } else if (page === 'faultunit') {
        own = faultUnitTargets();
    }
    return TABS.concat(own);
}

/* The tab rail: the page's tab marked (the log page belongs to Logs). */
function rail(rec, page, ui) {
    rec.fillRect(0, 0, RAIL, H, '#0C1117');
    rec.fillRect(RAIL - 2, 0, 2, H, C.line);
    const current = page === 'log' ? 'logs' : page === 'faultunit' ? 'faults' : page === 'limits' || page === 'ready' ? 'settings' : page;
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
        // the label at 32 px, smaller where it would not fit the rail
        let size = 32;
        while (size > 22 && rec.textWidth(t.label, size, { font: 'label' }) > RAIL - 28) {
            size -= 2;
        }
        rec.text(t.label, RAIL / 2, t.y + t.h / 2 + 12, size, on ? C.text : C.dim, { font: 'label', align: 'center' });
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
    return vw + gap + uw;
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

/*
 * A temperature as a strip of segments under its value, in the screen's heat language: lit segments blue
 * while cold, white once warm, all red at its limit; the stretch from the limit up is a dim red zone, as on
 * the engine speed's band, with a tick at the limit. r: { lo, hi, warm, limit } (limit null: none).
 */
const STRIP_SEGMENTS = 12;
function heatStrip(rec, x, y, w, h, value, r) {
    const gap = 5;
    const seg = (w - gap * (STRIP_SEGMENTS - 1)) / STRIP_SEGMENTS;
    const at = (t) => (t - r.lo) / (r.hi - r.lo);
    const lit = isNum(value) ? Math.round(clamp(at(value), 0, 1) * STRIP_SEGMENTS) : 0;
    const over = isNum(value) && r.limit !== null && value >= r.limit;
    const color = !isNum(value) ? C.dim : over ? C.limit : isNum(r.warm) && value < r.warm ? C.cold : C.text;
    for (let i = 0; i < STRIP_SEGMENTS; i++) {
        const sx = x + i * (seg + gap);
        const zone = r.limit !== null && (i + 0.5) / STRIP_SEGMENTS >= at(r.limit);
        rec.roundRect(sx, y, seg, h, 3, i < Math.max(lit, isNum(value) && value > r.lo ? 1 : 0) ? color : zone ? C.redzone : C.line);
    }
    if (r.limit !== null) {
        const lx = x + w * clamp(at(r.limit), 0, 1);
        rec.fillRect(lx - 2, y - 7, 4, h + 14, over ? C.limit : C.text);
    }
    return over;
}

/* The temperatures' strips: their scales and where they turn warm. */
const HEAT = {
    coolant: { lo: 0, hi: 130, warm: 70 },
    intake: { lo: -10, hi: 80, warm: null },
    gearbox: { lo: 0, hi: 140, warm: 60 },
    exhaust: { lo: 0, hi: 1000, warm: 300 }
};

/*
 * Ready for full load (Einstellungen › Bereit): with every temperature switched on at its value a solid white
 * pill "Bereit"; before, an outlined blue pill "Warmfahren" and what is still missing. Nothing when none
 * is switched on.
 */
function readyBadge(rec, x, y, v, cfg) {
    const r = L.readiness(cfg, v);
    if (!r.on) {
        return;
    }
    const h = 56;
    if (r.ready) {
        const w = rec.textWidth('Bereit', 32, { font: 'label' }) + 64;
        rec.roundRect(x, y, w, h, h / 2, C.text);
        rec.text('Bereit', x + w / 2, y + h / 2 + 12, 32, C.asphalt, { font: 'label', align: 'center' });
        return;
    }
    const w = rec.textWidth('Warmfahren', 28, { font: 'label' }) + 48;
    rec.strokeRoundRect(x, y, w, h, h / 2, 3, C.cold);
    rec.text('Warmfahren', x + w / 2, y + h / 2 + 10, 28, C.cold, { font: 'label', align: 'center' });
    // each temperature switched on by its name (the values are on the page): green once reached, red until then
    let ix = x + w + 26;
    const end = COL.mid.x - 40;
    r.items.forEach((it) => {
        const nw = rec.textWidth(it.short, 28, { font: 'label' });
        if (ix + nw > end) {
            return;
        }
        rec.text(it.short, ix, y + h / 2 + 10, 28, it.reached ? C.ok : C.limit, { font: 'label' });
        ix += nw + 30;
    });
}

function readiness(rec, v, cfg) {
    const { x, w } = COL.left;
    const readyAt = cfg.oilReady;
    rec.text('Öltemperatur', x, 262, 34, C.dim, { font: 'label' });
    const oil = v.oil;
    const ready = isNum(oil) && oil >= readyAt;
    const t = isNum(oil) ? clamp((oil - 20) / (readyAt - 20), 0, 1) : 0;
    const hot = isNum(oil) && oil >= cfg.oilMax;
    const color = !isNum(oil) ? C.dim : hot ? C.limit : ready ? C.text : mix(C.cold, C.text, t * 0.6);
    valueUnit(rec, isNum(oil) ? String(Math.round(oil)) : '–', '°C', x, 420, 160, color, 36, 'left');

    const by = 448;
    const bh = 52;
    rec.roundRect(x, by, w, bh, 8, C.line);
    // from the warning limit up: the red zone, as on the engine speed's band
    const zx = x + w * clamp(cfg.oilMax, 0, OIL_MAX) / OIL_MAX;
    if (zx < x + w) {
        rec.roundRect(zx, by, x + w - zx, bh, 8, C.redzone);
    }
    if (isNum(oil) && oil > 0) {
        rec.roundRect(x, by, Math.max(bh, w * clamp(oil, 0, OIL_MAX) / OIL_MAX), bh, 8, color);
    }
    // the warning limit marked, as on the other temperatures (no mark where it is ready)
    rec.fillRect(zx - 2, by - 12, 4, bh + 24, hot ? C.limit : C.text);
    readyBadge(rec, x, 520, v, cfg);

    const cells = [['Kühlmittel', v.coolant, Object.assign({}, HEAT.coolant, { limit: cfg.coolantMax, warm: cfg.coolantReady })],
        ['Ansaugluft', v.intake, Object.assign({}, HEAT.intake, { limit: cfg.intakeMax })], ['Getriebeöl', v.gearbox, Object.assign({}, HEAT.gearbox, { limit: cfg.gearboxMax, warm: cfg.gearboxReady })]];
    cells.forEach((c, i) => {
        const cx = x + i * 236;
        const hot = isNum(c[1]) && c[2].limit !== null && c[1] >= c[2].limit;
        rec.text(c[0], cx, 622, 28, hot ? C.limit : C.dim, { font: 'label' });
        valueUnit(rec, isNum(c[1]) ? String(Math.round(c[1])) : '–', '°C', cx, 690, 54, hot ? C.limit : C.text, 26, 'left');
        heatStrip(rec, cx, 712, 200, 20, c[1], c[2]);
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
    const low = isNum(v.oilPress) && isNum(v.rpm) && v.rpm > cfg.oilPressRpm && v.oilPress < cfg.oilPressMin;
    valueUnit(rec, isNum(v.oilPress) ? de(v.oilPress, 1) : '–', 'bar', x, 352, 96, low ? C.limit : C.text, 32, 'left');
    if (isNum(v.oilPressPeak)) {
        rec.text(`Spitze ${de(v.oilPressPeak, 1)} bar`, x, 394, 30, C.ice, { font: 'scale' });
    }
    const cells = [
        ['Abgas', isNum(v.exhaust) ? String(Math.round(v.exhaust)) : '–', '°C', isNum(v.exhaust) && v.exhaust >= cfg.exhaustMax],
        ['Bordnetz', isNum(v.voltage) ? de(v.voltage, 1) : '–', 'V', isNum(v.voltage) && v.voltage < cfg.voltageMin]
    ];
    cells.forEach((c, i) => {
        const cx = x + i * 216;
        rec.text(c[0], cx, 440, 28, c[3] ? C.limit : C.dim, { font: 'label' });
        valueUnit(rec, c[1], c[2], cx, 498, 50, c[3] ? C.limit : C.text, 26, 'left');
    });
    heatStrip(rec, x, 516, 184, 16, v.exhaust, Object.assign({ limit: cfg.exhaustMax }, HEAT.exhaust));

    // the knock control (its retard, red from the limit, with the cylinder it takes back most) and the oil level
    const knocking = isNum(v.knock) && v.knock >= cfg.knockMax;
    // the label names the cylinder taken back most while it takes back
    const cyl = v.knockCyl && isNum(v.knock) && v.knock > 0 ? `  Zyl. ${v.knockCyl}` : '';
    rec.text(`Klopfen${cyl}`, x, 574, 28, knocking ? C.limit : C.dim, { font: 'label' });
    valueUnit(rec, isNum(v.knock) ? de(Math.max(0, v.knock), 1) : '–', '°', x, 626, 44, knocking ? C.limit : C.text, 26, 'left');
    const oilLow = isNum(v.oilLevel) && v.oilLevel < cfg.oilLevelMin;
    rec.text('Ölstand', x + 216, 574, 28, oilLow ? C.limit : C.dim, { font: 'label' });
    valueUnit(rec, isNum(v.oilLevel) ? de(v.oilLevel, 1) : '–', 'l über Min.', x + 216, 626, 44, oilLow ? C.limit : C.text, 24, 'left');
    mainTargets(extra).forEach((t) => button(rec, t, ui, { size: 28 }));
}

/* ---- the settings page ---- */

/* The settings menu: a card per sub-page, with what it holds now. */
function settingsMenu(rec, cfg, ui) {
    rec.text('Einstellungen', X0, 120, 56, C.text, { font: 'label' });
    MENU.forEach((m) => {
        const focus = ui && ui.focus === m.id;
        rec.roundRect(m.x, m.y, m.w, m.h, 24, ui && ui.pressed === m.id ? C.line : '#151D26');
        rec.strokeRoundRect(m.x, m.y, m.w, m.h, 24, focus ? 5 : 2, focus ? C.ice : C.line);
        rec.text(m.label, m.x + 56, m.y + 104, 52, C.text, { font: 'label' });
        rec.text(m.text, m.x + 56, m.y + 160, 30, C.dim, { font: 'label' });
        let summary;
        if (m.page === 'limits') {
            const changed = LIMIT_ITEMS.filter((it) => cfg[it.key] !== it.def).length;
            summary = changed ? `${changed} geändert` : 'Standard';
        } else {
            const on = L.READY.filter((r) => cfg[r.on]);
            summary = on.length ? on.map((r) => `${r.short} ${cfg[r.at]}°`).join('   ') : 'Aus';
        }
        rec.text(summary, m.x + 56, m.y + m.h - 52, 34, C.ice, { font: 'label' });
        const cx = m.x + m.w - 72;
        const cy = m.y + m.h / 2;
        rec.polyline([[cx - 18, cy - 30], [cx + 12, cy], [cx - 18, cy + 30]], 6, C.dim);
    });
}

/* Ready for full load: per temperature its switch (on: it counts) and the temperature it has to reach. */
function readyPage(rec, cfg, ui) {
    rec.text('Bereit für Volllast', X0, 120, 56, C.text, { font: 'label' });
    rec.text('Die Live-Seite zeigt „Bereit“, sobald alle eingeschalteten Temperaturen ihren Wert erreicht haben.', X0, 166, 30, C.dim,
        { font: 'label' });
    L.READY.forEach((r, i) => {
        const y = SET_TOP + 20 + i * READY_ROW_H;
        const on = !!cfg[r.on];
        const sw = READY_TARGETS.find((t) => t.id === `toggle:${r.on}`);
        // the switch: a pill with its knob, ice when on
        const focus = ui && ui.focus === sw.id;
        if (focus) {
            rec.strokeRoundRect(sw.x - 8, sw.y - 8, sw.w + 16, sw.h + 16, sw.h / 2 + 8, 5, C.ice);
        }
        rec.roundRect(sw.x, sw.y, sw.w, sw.h, sw.h / 2, on ? C.ice : C.line);
        const knob = sw.h - 16;
        rec.roundRect(on ? sw.x + sw.w - knob - 8 : sw.x + 8, sw.y + 8, knob, knob, knob / 2, on ? C.asphalt : C.dim);
        rec.text(on ? 'Ein' : 'Aus', on ? sw.x + 36 : sw.x + sw.w - 36, sw.y + sw.h / 2 + 11, 30, on ? C.asphalt : C.dim,
            { font: 'label', align: on ? 'left' : 'right' });
        rec.text(r.label, sw.x + sw.w + 56, y + 76, 44, on ? C.text : C.dim, { font: 'label' });
        const it = L.ITEMS.find((x) => x.key === r.at);
        const right = SET_COLS[0].x + 1700;
        rec.text('bereit ab', right - 2 * BTN - 330, y + 76, 30, C.dim, { font: 'label' });
        valueUnit(rec, String(cfg[r.at]), it.unit, right - 2 * BTN - 56, y + 82, 54, !on ? C.dim : cfg[r.at] !== it.def ? C.ice : C.text, 28, 'right');
        rec.fillRect(X0, y + READY_ROW_H - 14, right - X0, 2, C.line);
    });
    READY_TARGETS.filter((t) => t.id.indexOf('toggle:') !== 0).forEach((t) => {
        const step = t.id.indexOf('dec:') === 0 || t.id.indexOf('inc:') === 0;
        button(rec, t, ui, { size: step ? 52 : 32 });
    });
}

function settings(rec, cfg, ui) {
    rec.text('Grenzwerte', X0, 120, 56, C.text, { font: 'label' });
    rec.text('Ab diesen Werten färbt sich die Anzeige rot.', X0, 166, 30, C.dim, { font: 'label' });
    LIMIT_ITEMS.forEach((it, i) => {
        const col = SET_COLS[i < SET_ROWS ? 0 : 1];
        const y = SET_TOP + (i % SET_ROWS) * ROW_H;
        rec.fillRect(col.x, y + ROW_H - 4, col.w, 2, C.line);
        rec.text(it.label, col.x, y + 54, 32, C.text, { font: 'label' });
        const changed = cfg[it.key] !== it.def;
        const value = it.d ? de(cfg[it.key], it.d) : String(cfg[it.key]);
        valueUnit(rec, value, it.unit, col.x + col.w - 2 * SET_BTN - 56, y + 58, 44, changed ? C.ice : C.text, 28, 'right');
    });
    SETTINGS_TARGETS.forEach((t) => {
        const step = t.id.indexOf('dec:') === 0 || t.id.indexOf('inc:') === 0;
        button(rec, t, ui, { size: step ? 44 : 32, primary: t.id === 'done' });
    });
}


const hexByte = (n) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
/* A refusal's code with its meaning (ISO 14229). */
const NRC_WORDS = { 0x11: 'Dienst nicht unterstützt', 0x12: 'nicht unterstützt', 0x13: 'falsche Länge', 0x22: 'Bedingungen nicht erfüllt',
    0x31: 'außerhalb des Bereichs', 0x33: 'gesperrt', 0x7E: 'nicht in dieser Sitzung', 0x7F: 'nicht in dieser Sitzung' };
const nrcText = (n) => `${hexByte(n)} ${NRC_WORDS[n] || ''}`.trim();

const STATE_COLOR = { aktiv: C.limit, gespeichert: C.ice, 'vorläufig': C.dim, Historie: C.dim };
/* A unit's tile: colour of its marker and words, by the state of its reading. */
const TILE = {
    wait: { color: C.line, text: '' },
    read: { color: C.ice, text: 'liest …' },
    ok: { color: C.text, text: 'OK' },
    faults: { color: C.limit, text: null },
    refused: { color: C.dim, text: 'abgelehnt' },
    none: { color: '#3A4652', text: 'keine Antwort' },
    error: { color: C.dim, text: 'Fehler beim Lesen' }
};

function faultsPage(rec, ui, extra) {
    const f = (extra && extra.faults) || {};
    const scan = f.scan || [];
    rec.text('Fehlerspeicher', X0, 120, 56, C.text, { font: 'label' });
    let note;
    if (f.clearing) {
        note = 'Lösche … bitte Zündung an lassen.';
    } else if (f.note) {
        note = f.note;
    } else if (f.reading) {
        note = `Lese Steuergerät ${f.progress || 0} von ${scan.length} … nur lesend.`;
    } else if (f.error) {
        note = `Lesen fehlgeschlagen: ${f.error}. Zündung an?`;
    } else if (f.units === 0 && f.refused) {
        note = `${f.refused} Steuergeräte erreicht, aber Fehler lesen abgelehnt (${(f.nrcs || []).map(nrcText).join(', ')}).`;
    } else if (f.units === 0) {
        note = 'Keine Antwort der Steuergeräte. Zündung an? Dann Neu lesen.';
    } else if (f.units === undefined) {
        note = 'Liest die Fehlerspeicher aller Steuergeräte, nur lesend.';
    } else {
        const withFaults = scan.filter((u) => u.state === 'faults').length;
        note = `${f.units} von ${scan.length} Steuergeräten gelesen${f.refused ? `, ${f.refused} abgelehnt` : ''}, ` +
            `${withFaults === 0 ? 'alle ohne Fehler' : withFaults === 1 ? '1 mit Fehlern' : `${withFaults} mit Fehlern`}` +
            (f.at ? ` · gelesen ${two(f.at.getUTCHours())}:${two(f.at.getUTCMinutes())}` : '');
    }
    rec.text(note, X0, 166, 30, f.error || f.warn || f.units === 0 ? C.limit : C.dim, { font: 'label' });

    scan.forEach((u, i) => {
        const b = tileBox(i);
        const look = TILE[u.state] || TILE.wait;
        const id = `unit:${u.addr}`;
        if (ui && ui.pressed === id) {
            rec.roundRect(b.x, b.y, b.w, b.h, 10, C.line);
        } else {
            rec.roundRect(b.x, b.y, b.w, b.h, 10, '#141C25');
        }
        if (ui && ui.focus === id) {
            rec.strokeRoundRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8, 12, 4, C.ice);
        }
        rec.roundRect(b.x, b.y, 8, b.h, 4, look.color);
        let words = look.text === null ? `${u.entries.length} Fehler` : look.text;
        if (u.state === 'refused' && typeof u.nrc === 'number') {
            words = `abgelehnt ${hexByte(u.nrc)}`;
        }
        const ww = words ? rec.textWidth(words, 26, { font: 'label' }) : 0;
        rec.clip(b.x, b.y, b.w - ww - 28, b.h);
        rec.text(u.name, b.x + 22, b.y + 36, 28, u.state === 'none' || u.state === 'wait' ? C.dim : C.text, { font: 'label' });
        rec.noclip();
        if (words) {
            rec.text(words, b.x + b.w - 14, b.y + 36, 26, u.state === 'faults' ? C.limit : u.state === 'ok' ? C.text : C.dim,
                { font: 'label', align: 'right' });
        }
    });
    faultsTargets(extra).filter((t) => t.id.indexOf('faults:') === 0).forEach((t) => button(rec, t, ui));
    if (f.confirmClear) {
        rec.text('Löscht die Einträge der roten Steuergeräte (nicht die Headunit). Nur bei Motor aus und Zündung an.',
            X0, 718, 28, C.dim, { font: 'label' });
    }
}

/* One unit's entries. */
/* s cut to width w with an ellipsis. */
function fit(rec, s, size, w) {
    if (rec.textWidth(s, size, { font: 'label' }) <= w) {
        return s;
    }
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rec.textWidth(s.slice(0, mid).trimRight() + '…', size, { font: 'label' }) <= w) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return s.slice(0, lo).trimRight() + '…';
}

function faultUnitPage(rec, ui, extra) {
    const f = (extra && extra.faults) || {};
    const u = (f.scan || []).find((x) => x.addr === (extra && extra.unit));
    rec.text(u ? u.name : 'Steuergerät', X0, 120, 56, C.text, { font: 'label' });
    const c = f.texts;
    const texts = c && c.have < c.of ? ` · Fehlertexte ${c.have} von ${c.of} Steuergeräten geladen, der Rest kommt mit Internet` : '';
    rec.text(u ? `Adresse 0x${u.addr.toString(16).toUpperCase().padStart(2, '0')} · ${u.entries.length} ${u.entries.length === 1 ? 'Eintrag' : 'Einträge'}${texts}` : '',
        X0, 166, 30, C.dim, { font: 'label' });
    ((u && u.entries) || []).slice(0, FAULT_ROWS).forEach((e, i) => {
        const col = LOG_COLS[i < 4 ? 0 : 1];
        const y = 196 + (i % 4) * 112;
        rec.fillRect(col.x, y + 104, col.w, 2, C.line);
        rec.text(`Code ${e.code}`, col.x + 8, y + 48, 36, C.text, { font: 'scale' });
        const color = STATE_COLOR[e.state] || C.dim;
        const w = rec.textWidth(e.state, 30, { font: 'label' }) + 40;
        // what it means: the unit's fault text (loaded once with internet), else why there is none
        const meaning = typeof e.text === 'string' ? e.text : e.text === null ? 'Kein Text zu diesem Code bekannt' :
            'Text noch nicht geladen – kommt, sobald der Store Internet hat';
        rec.text(fit(rec, meaning, 28, col.w - 16), col.x + 8, y + 88, 28, typeof e.text === 'string' ? C.text : C.dim, { font: 'label' });
        rec.strokeRoundRect(col.x + col.w - w - 8, y + 26, w, 52, 26, 3, color);
        rec.text(e.state, col.x + col.w - w / 2 - 8, y + 62, 30, color, { font: 'label', align: 'center' });
    });
    faultUnitTargets().forEach((t) => button(rec, t, ui));
}

function logsPage(rec, ui, extra) {
    const logs = (extra && extra.logs) || [];
    rec.text('Aufzeichnungen', X0, 120, 56, C.text, { font: 'label' });
    // the USB export's progress or outcome in place of the line under the title
    const usb = extra && extra.usb;
    rec.text(usb ? usb.text : logs.length ? `${logs.length} gespeichert, die neueste zuerst. Es bleiben die letzten 20.` :
        'Noch keine Aufzeichnung. Starte eine mit Aufnehmen im Reiter Live.', X0, 166, 30, usb && usb.error ? C.limit : usb ? C.ice : C.dim,
        { font: 'label' });
    logsTargets(extra).filter((t) => t.id.indexOf('deleteAll') === 0 || t.id === 'usb').forEach((t) => button(rec, t, ui));
    logsTargets(extra).filter((t) => t.id.indexOf('open:') === 0).forEach((t, i) => {
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
        curves: [['oilPress', C.text, 'left', 'Öldruck'], ['rpm', C.dim, 'right', 'Drehzahl']] },
    // what the engine does: the mixture (under 1 rich) and the knock control taking ignition back
    mix: { axes: { left: { unit: 'Lambda', bare: true, d: 2, floor: 1.3, from: 0.7, to: 1.3, color: C.text }, right: { unit: 'Grad', d: 0, floor: 4, color: C.limit } },
        curves: [['lambda', C.text, 'left', 'Lambda', 'min'], ['lambdaTarget', C.dim, 'left', 'Soll', 'min'], ['knock', C.limit, 'right', 'Zündung zurück']] },
    fuel: { axes: { left: { unit: 'bar', d: 0, floor: 200, color: C.text }, right: { unit: 'bar', d: 1, floor: 8, color: C.cold } },
        curves: [['rail', C.text, 'left', 'Raildruck'], ['railTarget', C.dim, 'left', 'Soll'], ['fuelLow', C.cold, 'right', 'Niederdruck (Pumpe)', 'min']] },
    load: { axes: { left: { unit: '%', d: 0, floor: 100, color: C.text }, right: { unit: 'Grad', d: 0, floor: 20, color: C.ice } },
        curves: [['pedal', C.dim, 'left', 'Pedal'], ['load', C.text, 'left', 'Last'], ['ignition', C.ice, 'right', 'Zündwinkel']] },
    // per cylinder: how far its ignition sits below the earliest one (what the knock control takes back there)
    knock: { axes: { left: { unit: 'Grad', d: 1, floor: 4, color: C.text } },
        curves: [['knockCyl1', C.text, 'left', 'Zyl. 1'], ['knockCyl2', C.ice, 'left', '2'], ['knockCyl3', C.cold, 'left', '3'],
            ['knockCyl4', C.ok, 'left', '4'], ['knockCyl5', '#E8B04B', 'left', '5'], ['knockCyl6', C.limit, 'left', '6'],
            ['knock', C.dim, 'left', 'Mittel']] }
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

/* The lowest value of an axis's curves in a recording (Infinity without one). */
function lowest(group, name, log) {
    let m = Infinity;
    group.curves.filter((c) => c[2] === name).forEach((c) => (log.series[c[0]] || []).forEach((y) => { if (isNum(y) && y < m) m = y; }));
    return m;
}

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
        // an axis with a 'to' (lambda) ends there while every value is below it: 1.0 on the middle line
        const top = isNum(ax.to) && hi <= ax.to ? ax.to : niceUp(Math.max(hi, ax.floor));
        // an axis with a 'from' (lambda) starts there while every value is above it
        const bottom = lo < 0 ? -niceUp(-lo) : isNum(ax.from) && lowest(group, name, log) >= ax.from ? ax.from : 0;
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
        const low = c[4] === 'min';
        const peak = ys.reduce((m, y) => (isNum(y) && (m === null || (low ? y < m : y > m)) ? y : m), null);
        const text = `${c[3]}  ${low ? 'min' : 'max'} ${peak === null ? '–' : axisText(peak, ax.d === 0 ? 0 : Math.max(ax.d, 1))}${ax.bare ? '' : ` ${ax.unit}`}`;
        rec.fillRect(lx, 666, 28, 6, c[1]);
        lx += 40 + rec.text(text, lx + 40, 680, 28, C.text, { font: 'scale' }) + 56;
    });
}

function draw(rec, page, v, cfg, ui, extra) {
    rec.clear(C.asphalt);
    rail(rec, page, ui);
    if (page === 'settings') {
        settingsMenu(rec, cfg, ui);
        return rec;
    }
    if (page === 'limits') {
        settings(rec, cfg, ui);
        return rec;
    }
    if (page === 'ready') {
        readyPage(rec, cfg, ui);
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
    if (page === 'faults') {
        faultsPage(rec, ui, extra);
        return rec;
    }
    if (page === 'faultunit') {
        faultUnitPage(rec, ui, extra);
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
