'use strict';
/**
 * The HUD app's screens as drawing calls, in Motordaten's look (its src/dash.js: colours, the tab rail,
 * buttons, switches), laid out for the iDrive 8 app area: 2880 x 764 logical px at scale 1.
 *
 * Page 'main' (Live): left, the HUD as it is now (src/hud_draw.js, the same drawing, larger) above a stand-in
 *   for BMW's own bar; right, where it stands in words, oil and coolant against their ready values, what the
 *   HUD shows (Warmfahren / Immer / Aus) and "Im HUD testen".
 * Page 'display' (Anzeige): what, where and how large, with a small HUD beside it.
 * Page 'ready' (Bereit): which temperatures count, from where; when the oil is too hot.
 * Page 'status': the cluster renderer and where the values come from.
 *
 * draw(rec, page, v, cfg, ui, extra) records one frame into a kit_record Recorder (or a kit_canvas Canvas):
 * v { oil, coolant, view (what the HUD shows, src/warmup.js), words { title, text }, source, testing,
 * rows (the renderer's status rows) }, cfg the settings (src/settings.js), ui { focus, pressed }.
 * targets(page) lists the page's pressable boxes in controller order: { id, x, y, w, h, label }.
 * tempCellBoxes / tempSlotAt: none here (src/drawn.js asks every app's screens for them).
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const S = require('./settings.js');
const hud = require('./hud_draw.js');

const W = 2880;
const H = 764;
const C = {
    asphalt: '#10161D', line: '#2A3642', text: '#E9EEF2', dim: '#8394A4',
    cold: '#5FA8D9', ice: '#A9DCFF', limit: '#FF5B4F', ok: '#4FD18B', card: '#151D26', glass: '#070A0E'
};
const PAD = 96;
const RAIL = 200;
const X0 = RAIL + 60;
const BTN = 96;

const isNum = (v) => typeof v === 'number' && isFinite(v);

/* ---- pressable targets ---- */

const TABS = [
    { id: 'tab:main', page: 'main', label: 'Live' },
    { id: 'tab:display', page: 'display', label: 'Anzeige' },
    { id: 'tab:ready', page: 'ready', label: 'Bereit' },
    { id: 'tab:status', page: 'status', label: 'Status' }
].map((t, i) => Object.assign(t, { x: 0, y: 12 + i * 150, w: RAIL, h: 140 }));

/* A row of choices for one setting: id choose:<key>:<word>, side by side from x. */
function segments(key, x, y, w, h) {
    const all = S.CHOICES[key].all;
    const gap = 20;
    const bw = Math.floor((w - gap * (all.length - 1)) / all.length);
    return all.map((word, i) => ({ id: `choose:${key}:${word}`, key, word, x: x + i * (bw + gap), y, w: bw, h, label: S.CHOICES[key].words[word] }));
}

/* Live: the right column. */
const LIVE = { x: 1660, w: W - PAD - 1660 };
const MAIN_TARGETS = segments('mode', LIVE.x, 520, LIVE.w, BTN).concat([
    { id: 'test', x: LIVE.x, y: 642, w: 420, h: 84, label: 'Im HUD testen' }
]);

/* Anzeige: a row per choice. */
const ROW_X = 1060;
const ROW_W = 1000;
const DISPLAY_ROWS = [
    { key: 'mode', label: 'Was', text: 'Warmfahren: bis alles bereit ist. Immer: das Öl.' },
    { key: 'pos', label: 'Wo', text: 'Im Feld über BMWs Leiste' },
    { key: 'size', label: 'Wie groß', text: 'Groß: ein Viertel größer' }
].map((r, i) => Object.assign(r, { y: 210 + i * 170 }));
const DISPLAY_TARGETS = [].concat(...DISPLAY_ROWS.map((r) => segments(r.key, ROW_X, r.y, ROW_W, BTN)));

/* Bereit: per temperature its switch and its value; then the oil's hot limit. */
const READY_ROW_H = 150;
const READY_TOP = 216;
const STEP_RIGHT = W - PAD;
function readyTargets() {
    const out = [];
    S.READY.forEach((r, i) => {
        const y = READY_TOP + i * READY_ROW_H;
        out.push({ id: `toggle:${r.on}`, x: X0, y: y + 10, w: 220, h: BTN, label: '' });
        out.push({ id: `dec:${r.at}`, x: STEP_RIGHT - 2 * BTN - 24, y: y + 10, w: BTN, h: BTN, label: '−' });
        out.push({ id: `inc:${r.at}`, x: STEP_RIGHT - BTN, y: y + 10, w: BTN, h: BTN, label: '+' });
    });
    const y = READY_TOP + 2 * READY_ROW_H;
    out.push({ id: 'dec:oilMax', x: STEP_RIGHT - 2 * BTN - 24, y: y + 10, w: BTN, h: BTN, label: '−' });
    out.push({ id: 'inc:oilMax', x: STEP_RIGHT - BTN, y: y + 10, w: BTN, h: BTN, label: '+' });
    out.push({ id: 'defaults', x: W - PAD - 300, y: 64, w: 300, h: 84, label: 'Standard' });
    return out;
}
const READY_TARGETS = readyTargets();

const STATUS_TARGETS = [{ id: 'reconnect', x: W - PAD - 420, y: 64, w: 420, h: 84, label: 'Neu verbinden' }];

function targets(page) {
    const own = page === 'display' ? DISPLAY_TARGETS : page === 'ready' ? READY_TARGETS : page === 'status' ? STATUS_TARGETS : MAIN_TARGETS;
    return TABS.concat(own);
}

/* ---- pieces, as on Motordaten's screens ---- */

function rail(rec, page, ui) {
    rec.fillRect(0, 0, RAIL, H, '#0C1117');
    rec.fillRect(RAIL - 2, 0, 2, H, C.line);
    TABS.forEach((t) => {
        const on = t.page === page;
        if (ui && ui.pressed === t.id) rec.fillRect(t.x, t.y, t.w, t.h, C.line);
        if (on) rec.fillRect(0, t.y + 24, 8, t.h - 48, C.ice);
        if (ui && ui.focus === t.id) rec.strokeRoundRect(t.x + 10, t.y + 6, t.w - 20, t.h - 12, 14, 4, C.ice);
        rec.text(t.label, RAIL / 2, t.y + t.h / 2 + 12, 32, on ? C.text : C.dim, { font: 'label', align: 'center' });
    });
}

/* A button; on: filled (the chosen one of a row), danger: red. */
function button(rec, t, ui, opts) {
    const r = t.h / 2;
    if (ui && ui.focus === t.id) rec.strokeRoundRect(t.x - 8, t.y - 8, t.w + 16, t.h + 16, r + 8, 5, C.ice);
    if (ui && ui.pressed === t.id) rec.roundRect(t.x, t.y, t.w, t.h, r, C.line);
    if (t.on) rec.roundRect(t.x, t.y, t.w, t.h, r, C.cold);
    rec.strokeRoundRect(t.x, t.y, t.w, t.h, r, 3, t.on ? C.cold : opts && opts.primary ? C.text : C.line);
    const size = (opts && opts.size) || 32;
    rec.text(t.label, t.x + t.w / 2, t.y + t.h / 2 + size * 0.36, size, t.on ? C.asphalt : C.text, { font: 'label', align: 'center' });
}

function toggleSwitch(rec, sw, on, ui) {
    if (ui && ui.focus === sw.id) rec.strokeRoundRect(sw.x - 8, sw.y - 8, sw.w + 16, sw.h + 16, sw.h / 2 + 8, 5, C.ice);
    rec.roundRect(sw.x, sw.y, sw.w, sw.h, sw.h / 2, on ? C.ice : C.line);
    const knob = sw.h - 16;
    rec.roundRect(on ? sw.x + sw.w - knob - 8 : sw.x + 8, sw.y + 8, knob, knob, knob / 2, on ? C.asphalt : C.dim);
    rec.text(on ? 'Ein' : 'Aus', on ? sw.x + 36 : sw.x + sw.w - 36, sw.y + sw.h / 2 + 11, 30, on ? C.asphalt : C.dim,
        { font: 'label', align: on ? 'left' : 'right' });
}

function valueUnit(rec, text, unit, x, y, size, color, unitSize, align) {
    const gap = Math.round(size * 0.07);
    const uw = rec.textWidth(unit, unitSize, { font: 'label' });
    const vw = rec.textWidth(text, size, { font: 'num' });
    const left = align === 'right' ? x - uw - gap - vw : x;
    rec.text(text, left, y, size, color, { font: 'num' });
    rec.text(unit, left + vw + gap, y, unitSize, C.dim, { font: 'label' });
}

function title(rec, text, sub) {
    rec.text(text, X0, 120, 56, C.text, { font: 'label' });
    if (sub) rec.text(sub, X0, 166, 30, C.dim, { font: 'label' });
}

/*
 * The HUD as the driver sees it, s times as large, its top left at x, y: the dark glass, the app's 353 x 203
 * outlined, what it shows, and under it a stand-in for BMW's own bar (559 x 67, measured on the G87's HUD).
 */
function hudMirror(rec, x, y, s, view, cfg) {
    const bw = 559 * s;
    const bx = x + (hud.HUD.w * s - bw) / 2;
    const by = y + hud.HUD.h * s;
    rec.roundRect(bx - 24, y - 24, bw + 48, hud.HUD.h * s + 67 * s + 48, 24, C.glass);
    rec.strokeRoundRect(x, y, hud.HUD.w * s, hud.HUD.h * s, 10, 2, C.line);
    if (view) {
        hud.drawHud(Object.assign({}, view, { pos: cfg.pos, size: cfg.size }), rec, { x, y, s });
    } else {
        rec.text('frei', x + hud.HUD.w * s / 2, y + hud.HUD.h * s / 2 + 12, 32 * Math.min(1, s / 2), C.dim, { font: 'label', align: 'center' });
    }
    // BMW's bar: dim, it is theirs (speed limit, speed)
    rec.roundRect(bx, by, bw, 67 * s, 6, '#1B2E43');
    rec.fillRect(bx, by, bw, 2 * s, '#2D4A66');
    rec.text('BMW', bx + bw / 2, by + 67 * s / 2 + 9 * Math.min(1, s / 2), 26 * Math.min(1, s / 2), '#7F98B2', { font: 'label', align: 'center' });
}

/* ---- pages ---- */

/* A temperature against its ready value: name, the value, "bereit ab". */
function tempCard(rec, x, y, w, label, value, at, on, hot) {
    rec.roundRect(x, y, w, 200, 24, C.card);
    rec.text(label, x + 36, y + 56, 32, C.dim, { font: 'label' });
    const reached = on && isNum(value) && value >= at;
    const color = !isNum(value) ? C.dim : hot ? C.limit : !on || reached ? C.text : C.cold;
    valueUnit(rec, isNum(value) ? String(Math.round(value)) : '–', '°C', x + 36, y + 160, 96, color, 32, 'left');
    const note = !on ? 'zählt nicht' : reached ? 'bereit' : `bereit ab ${at} °C`;
    rec.text(note, x + w - 36, y + 56, 28, reached ? C.ok : C.dim, { font: 'label', align: 'right' });
}

function mainPage(rec, v, cfg, ui) {
    // left: the HUD now
    rec.text('Im HUD', X0, 92, 32, C.dim, { font: 'label' });
    hudMirror(rec, X0 + 24 + (559 - 353) * 1.9 / 2, 150, 1.9, v.view, cfg);
    // right: where it stands, the values, what to show
    const words = v.words || { title: '', text: '' };
    rec.text(words.title, LIVE.x, 120, 56, v.view && v.view.mode === 'hot' ? C.limit : C.text, { font: 'label' });
    rec.text(words.text, LIVE.x, 166, 30, C.dim, { font: 'label' });
    const cw = (LIVE.w - 24) / 2;
    tempCard(rec, LIVE.x, 216, cw, 'Öl', v.oil, cfg.oilReady, !!cfg.oilReadyOn, isNum(v.oil) && v.oil >= cfg.oilMax);
    tempCard(rec, LIVE.x + cw + 24, 216, cw, 'Kühlmittel', v.coolant, cfg.coolantReady, !!cfg.coolantReadyOn, false);
    rec.text('Im HUD zeigen', LIVE.x, 494, 30, C.dim, { font: 'label' });
    MAIN_TARGETS.forEach((t) => {
        if (t.id === 'test') {
            button(rec, Object.assign({}, t, { label: v.testing ? 'Test läuft …' : t.label, on: !!v.testing }), ui);
        } else {
            button(rec, Object.assign({}, t, { on: cfg[t.key] === t.word }), ui);
        }
    });
    rec.text('Zeigt nacheinander Warmfahren, Bereit und Zu heiß.', LIVE.x + 456, 694, 28, C.dim, { font: 'label' });
}

function displayPage(rec, v, cfg, ui) {
    title(rec, 'Anzeige', 'Was im HUD steht, wo und wie groß.');
    DISPLAY_ROWS.forEach((r) => {
        rec.text(r.label, X0, r.y + 58, 44, C.text, { font: 'label' });
        rec.text(r.text, X0, r.y + 102, 28, C.dim, { font: 'label' });
        rec.fillRect(X0, r.y + BTN + 40, ROW_X + ROW_W - X0, 2, C.line);
    });
    DISPLAY_TARGETS.forEach((t) => button(rec, Object.assign({}, t, { on: cfg[t.key] === t.word }), ui));
    // beside the rows: how it would look (the test's warm-up look when the HUD shows nothing now)
    const sample = v.view || { mode: 'warm', label: 'Öl', value: 47 };
    rec.text(v.view ? 'So sieht es jetzt aus' : 'Beispiel', 2450, 236, 28, C.dim, { font: 'label', align: 'center' });
    hudMirror(rec, 2450 - hud.HUD.w / 2, 300, 1, cfg.mode === 'off' ? null : sample, cfg);
}

function readyPage(rec, v, cfg, ui) {
    title(rec, 'Bereit', 'Warmfahren endet, sobald alle eingeschalteten Temperaturen ihren Wert erreicht haben.');
    S.READY.forEach((r, i) => {
        const y = READY_TOP + i * READY_ROW_H;
        const on = !!cfg[r.on];
        toggleSwitch(rec, READY_TARGETS.find((t) => t.id === `toggle:${r.on}`), on, ui);
        rec.text(r.label, X0 + 220 + 56, y + 76, 44, on ? C.text : C.dim, { font: 'label' });
        const it = S.ITEMS.find((x) => x.key === r.at);
        rec.text('bereit ab', STEP_RIGHT - 2 * BTN - 330, y + 76, 30, C.dim, { font: 'label' });
        valueUnit(rec, String(cfg[r.at]), it.unit, STEP_RIGHT - 2 * BTN - 56, y + 82, 54, !on ? C.dim : cfg[r.at] !== it.def ? C.ice : C.text, 28, 'right');
        rec.fillRect(X0, y + READY_ROW_H - 14, STEP_RIGHT - X0, 2, C.line);
    });
    const y = READY_TOP + 2 * READY_ROW_H;
    const hot = S.ITEMS.find((x) => x.key === 'oilMax');
    rec.text('Öl zu heiß', X0, y + 76, 44, C.text, { font: 'label' });
    rec.text('dann zeigt das HUD das Öl in Rot, in jeder Anzeige außer Aus', X0 + 330, y + 74, 28, C.dim, { font: 'label' });
    rec.text('ab', STEP_RIGHT - 2 * BTN - 330, y + 76, 30, C.dim, { font: 'label' });
    valueUnit(rec, String(cfg.oilMax), '°C', STEP_RIGHT - 2 * BTN - 56, y + 82, 54, cfg.oilMax !== hot.def ? C.ice : C.text, 28, 'right');
    READY_TARGETS.filter((t) => t.id.indexOf('toggle:') !== 0).forEach((t) => {
        const step = t.id.indexOf('dec:') === 0 || t.id.indexOf('inc:') === 0;
        button(rec, t, ui, { size: step ? 52 : 32 });
    });
}

function statusPage(rec, v, cfg, ui) {
    title(rec, 'Status', 'Die Verbindung zum HUD und woher die Werte kommen.');
    const rows = (v.rows || []).slice(0, 10);
    const colW = (W - PAD - X0 - 60) / 2;
    rows.forEach((r, i) => {
        const x = X0 + (i < 5 ? 0 : colW + 60);
        const y = 220 + (i % 5) * 104;
        rec.text(r[0], x, y + 50, 30, C.dim, { font: 'label' });
        let text = String(r[1] == null ? '–' : r[1]);
        while (text.length > 4 && rec.textWidth(text, 36, { font: 'label' }) > colW - 380) text = text.slice(0, -2);
        if (text !== String(r[1] == null ? '–' : r[1])) text += '…';
        rec.text(text, x + 360, y + 50, 36, C.text, { font: 'label' });
        rec.fillRect(x, y + 84, colW, 2, C.line);
    });
    STATUS_TARGETS.forEach((t) => button(rec, t, ui));
}

function draw(rec, page, v, cfg, ui) {
    v = v || {};
    cfg = cfg || S.defaults();
    rec.clear(C.asphalt);
    rail(rec, page, ui);
    if (page === 'display') displayPage(rec, v, cfg, ui);
    else if (page === 'ready') readyPage(rec, v, cfg, ui);
    else if (page === 'status') statusPage(rec, v, cfg, ui);
    else mainPage(rec, v, cfg, ui);
    return rec;
}

const tempCellBoxes = () => [];
const tempSlotAt = () => 0;

module.exports = { draw, targets, tempCellBoxes, tempSlotAt, W, H, C, TABS };
