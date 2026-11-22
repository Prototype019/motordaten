'use strict';
/**
 * The HUD app's screens as drawing calls, in Motordaten's look (its src/dash.js: colours, the tab rail,
 * buttons, switches), laid out for the iDrive 8 app area: 2880 x 764 logical px at scale 1.
 *
 * Page 'main' (Live): left, the HUD as it is now (src/hud_draw.js, the same drawing, larger) above a stand-in
 *   for BMW's own bar; right, where it stands in words, oil and coolant against their ready values, what the
 *   HUD shows (Warmfahren / Immer / Aus) and "Im HUD testen".
 * Page 'values' (Werte): every value as a card in one row, the first ones (up to three) shown in the HUD; held
 *   and dragged a card takes another place (in the HUD or out of it), tapped it goes in or out (src/drawn.js drag:
 *   DRAG_PAGE, tempCellBoxes, tempSlotAt; extra.order / extra.count the settings' order and count).
 * Page 'display' (Anzeige): what, where and how large, with a small HUD beside it; its button Ausrichten opens
 * Page 'align' (under Anzeige): the HUD shows the alignment picture while it is open; slant, aside and height taken
 *   back (settings ALIGN), each with − and +.
 * Page 'ready' (Bereit): which temperatures count, from where; when oil, coolant and engine speed turn red.
 * Page 'status': the cluster renderer and where the values come from; its button opens
 * Page 'github' (under Status): the app's logs into the driver's own GitHub repository, set up by scanning QR
 *   codes (src/github_logs.js; extra.github is its state(): phase off, code, install, pick, ready, sending).
 *
 * draw(rec, page, v, cfg, ui, extra) records one frame into a kit_record Recorder (or a kit_canvas Canvas):
 * v { oil, coolant, view (what the HUD shows, src/warmup.js), words { title, text }, source, testing,
 * rows (the renderer's status rows) }, cfg the settings (src/settings.js), ui { focus, pressed }.
 * targets(page) lists the page's pressable boxes in controller order: { id, x, y, w, h, label }.
 * tempCellBoxes / tempSlotAt / DRAG_PAGE: the value cards' drag (src/drawn.js).
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const S = require('./settings.js');
const V = require('./values.js');
const hud = require('./hud_draw.js');
const qr = require('./qr.js');
const clock = require('./clock.js');

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
    { id: 'tab:values', page: 'values', label: 'Werte' },
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
    { key: 'mode', label: 'Was', text: 'Warmfahren: bis alles bereit ist. Werte: wie gewählt.' },
    { key: 'pos', label: 'Wo', text: 'Im Feld über BMWs Leiste' },
    { key: 'size', label: 'Wie groß', text: 'Groß: ein Viertel größer' },
    { key: 'refresh', label: 'Gerade halten', text: 'Kippt BMW das Bild (nach Bremsen), kurz neu ans HUD' }
].map((r, i) => Object.assign(r, { y: 196 + i * 128 }));
const DISPLAY_TARGETS = [].concat(...DISPLAY_ROWS.map((r) => segments(r.key, ROW_X, r.y, ROW_W, BTN)))
    .concat([{ id: 'page:align', x: W - PAD - 360, y: 64, w: 360, h: 84, label: 'Ausrichten' }]);

/* Ausrichten: a row per correction, − and + at the right; Standard and Zurück at the top. */
const ALIGN_ROW_H = 132;
const ALIGN_TOP = 196;
const ALIGN_TARGETS = [].concat(...S.ALIGN.map((key, i) => {
    const y = ALIGN_TOP + i * ALIGN_ROW_H + 14;
    return [{ id: `dec:${key}`, x: 1500 - 2 * 88 - 24, y, w: 88, h: 88, label: '−' },
        { id: `inc:${key}`, x: 1500 - 88, y, w: 88, h: 88, label: '+' }];
})).concat([{ id: 'align:defaults', x: W - PAD - 300 - 24 - 300, y: 64, w: 300, h: 84, label: 'Standard' },
    { id: 'page:display', x: W - PAD - 300, y: 64, w: 300, h: 84, label: 'Zurück' }]);
const ALIGN_TEXT = {
    tilt: 'bis die senkrechte Linie senkrecht steht (+ kippt nach links)',
    shiftX: 'bis die Linie über der Mitte von BMWs Leiste steht (+ nach rechts)',
    height: 'bis der Kreis rund ist',
    width: 'bis der Rahmen links und rechts ganz zu sehen ist'
};

/* Bereit: per temperature its switch and its ready value; then where oil, coolant and engine speed turn red. */
const READY_ROW_H = 104;
const READY_TOP = 200;
const CTRL = 84;
const STEP_RIGHT = W - PAD;
const READY_ROWS = S.READY.map((r) => ({ kind: 'ready', r, key: r.at, label: r.label }))
    .concat([{ kind: 'max', key: 'oilMax', label: 'Öl zu heiß', note: 'das Öl rot im HUD, in jeder Anzeige außer Aus' },
        { kind: 'max', key: 'coolantMax', label: 'Kühlmittel zu heiß', note: 'rot, wenn es unter „Werte“ im HUD steht' },
        { kind: 'max', key: 'rpmMax', label: 'Drehzahl rot', note: 'rot, wenn sie unter „Werte“ im HUD steht' }])
    .map((row, i) => Object.assign(row, { y: READY_TOP + i * READY_ROW_H }));
function readyTargets() {
    const out = [];
    READY_ROWS.forEach((row) => {
        const y = row.y + (READY_ROW_H - CTRL) / 2 - 6;
        if (row.kind === 'ready') out.push({ id: `toggle:${row.r.on}`, x: X0, y, w: 200, h: CTRL, label: '' });
        out.push({ id: `dec:${row.key}`, x: STEP_RIGHT - 2 * CTRL - 24, y, w: CTRL, h: CTRL, label: '−' });
        out.push({ id: `inc:${row.key}`, x: STEP_RIGHT - CTRL, y, w: CTRL, h: CTRL, label: '+' });
    });
    out.push({ id: 'defaults', x: W - PAD - 300, y: 64, w: 300, h: 84, label: 'Standard' });
    return out;
}
const READY_TARGETS = readyTargets();

/* Werte: one card per value in one row, in the settings' order; the first count are in the HUD. */
const DRAG_PAGE = 'values';
const CELL = { y: 200, h: 236, gap: 20 };
CELL.w = Math.floor((W - PAD - X0 - CELL.gap * (V.KEYS.length - 1)) / V.KEYS.length);
const CELL_STEP = CELL.w + CELL.gap;
function tempCellBoxes(cfg) {
    return S.cleanOrder(cfg && cfg.order).map((key, i) => ({ key, x: X0 + i * CELL_STEP, y: CELL.y, w: CELL.w, h: CELL.h }));
}
/* Where a card dragged to x lands: its place in the row. */
function tempSlotAt(x) {
    return Math.max(0, Math.min(V.KEYS.length - 1, Math.round((x - X0) / CELL_STEP)));
}
const SHOW_VALUES = { id: 'choose:mode:values', key: 'mode', word: 'values', x: X0, y: 650, w: 460, h: 84, label: 'Werte anzeigen' };
function valuesTargets(extra) {
    const cells = tempCellBoxes({ order: extra && extra.order }).map((b) => Object.assign({ id: `cell:${b.key}`, drag: true,
        label: V.byKey(b.key).label }, b));
    return extra && extra.mode !== 'values' ? cells.concat([SHOW_VALUES]) : cells;
}

const STATUS_TARGETS = [{ id: 'reconnect', x: W - PAD - 420, y: 64, w: 420, h: 84, label: 'Neu verbinden' },
    { id: 'page:github', x: W - PAD - 420 - 24 - 420, y: 64, w: 420, h: 84, label: 'Logs an GitHub' }];

/* Logs an GitHub: Zurück at the top; the rest follows the phase (extra.github, src/github_logs.js state()). */
const GH_BACK = { id: 'page:status', x: W - PAD - 300, y: 64, w: 300, h: 84, label: 'Zurück' };
const GH_TOP = 200;
const GH_MAX_REPOS = 5;
const GH_PICK = { w: 1100, h: 96, stepY: 120, gap: 50 };
const qrCache = { text: null, q: null };
function qrOf(text) {
    if (qrCache.text !== text) {
        qrCache.q = qr.encode(text);
        qrCache.text = text;
    }
    return qrCache.q;
}
/* The QR square: modules at an integer size (at least 6 px), a quiet zone of 4 modules, inside the page. */
function qrBox(text) {
    const q = qrOf(text);
    const m = Math.max(6, Math.floor((H - GH_TOP - 24) / (q.size + 8)));
    const side = (q.size + 8) * m;
    return { x: X0, y: GH_TOP, m, side, size: q.size };
}
const qrRight = (text) => qrBox(text).x + qrBox(text).side + 90;
function githubTargets(st) {
    const out = [GH_BACK];
    const phase = st && st.phase;
    if (phase === 'code' || phase === 'install') {
        const x = st.qr ? qrRight(st.qr) : X0;
        out.push({ id: 'gh:cancel', x, y: 640, w: 360, h: 84, label: 'Abbrechen' });
    } else if (phase === 'pick') {
        (st.repos || []).slice(0, GH_MAX_REPOS).forEach((name, i) => out.push({ id: `gh:choose:${name}`,
            x: X0 + (i % 2) * (GH_PICK.w + GH_PICK.gap), y: 230 + Math.floor(i / 2) * GH_PICK.stepY, w: GH_PICK.w, h: GH_PICK.h, label: name }));
    } else if (phase === 'ready') {
        out.push({ id: 'gh:send', x: X0, y: 330, w: 600, h: 120, label: 'Logs senden' },
            { id: 'gh:disconnect', x: X0, y: 600, w: 360, h: 84, label: 'Trennen' });
    } else if (phase === 'sending') {
        // nothing to press while it goes
    } else {
        out.push({ id: 'gh:connect', x: X0, y: 380, w: 480, h: 112, label: 'Verbinden' });
    }
    return out;
}

function targets(page, extra) {
    const own = page === 'values' ? valuesTargets(extra) : page === 'display' ? DISPLAY_TARGETS : page === 'align' ? ALIGN_TARGETS
        : page === 'ready' ? READY_TARGETS
        : page === 'status' ? STATUS_TARGETS : page === 'github' ? githubTargets(extra && extra.github) : MAIN_TARGETS;
    return TABS.concat(own);
}

/* ---- pieces, as on Motordaten's screens ---- */

function rail(rec, page, ui) {
    rec.fillRect(0, 0, RAIL, H, '#0C1117');
    rec.fillRect(RAIL - 2, 0, 2, H, C.line);
    const current = page === 'align' ? 'display' : page === 'github' ? 'status' : page;
    TABS.forEach((t) => {
        const on = t.page === current;
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
        rec.fillRect(X0, r.y + BTN + 18, ROW_X + ROW_W - X0, 2, C.line);
    });
    DISPLAY_TARGETS.forEach((t) => button(rec, Object.assign({}, t, { on: t.key ? cfg[t.key] === t.word : false }), ui));
    // beside the rows: how it would look (the test's warm-up look when the HUD shows nothing now)
    const sample = v.view || { mode: 'warm', label: 'Öl', value: 47 };
    rec.text(v.view ? 'So sieht es jetzt aus' : 'Beispiel', 2450, 236, 28, C.dim, { font: 'label', align: 'center' });
    hudMirror(rec, 2450 - hud.HUD.w / 2, 300, 1, cfg.mode === 'off' ? null : sample, cfg);
}

function alignPage(rec, v, cfg, ui) {
    title(rec, 'Ausrichten', 'Das HUD stellt das Bild schräg und versetzt. Solange diese Seite offen ist, zeigt es ein Raster: so einstellen, dass es gerade sitzt.');
    S.ALIGN.forEach((key, i) => {
        const it = S.ITEMS.find((x) => x.key === key);
        const y = ALIGN_TOP + i * ALIGN_ROW_H;
        rec.text(it.label, X0, y + 60, 40, C.text, { font: 'label' });
        rec.text(ALIGN_TEXT[key], X0, y + 98, 26, C.dim, { font: 'label' });
        const val = String(cfg[key]);          // (the number font has no plus sign; the line under says which way)
        valueUnit(rec, val, it.unit, 1500 - 2 * 88 - 56, y + 74, 50, cfg[key] !== it.def ? C.ice : C.text, 26, 'right');
        rec.fillRect(X0, y + ALIGN_ROW_H - 12, 1500 - X0, 2, C.line);
    });
    ALIGN_TARGETS.forEach((t) => {
        const step = t.id.indexOf('dec:') === 0 || t.id.indexOf('inc:') === 0;
        button(rec, t, ui, { size: step ? 52 : 32 });
    });
    // beside: what the HUD shows meanwhile, as it should look once set
    rec.text('Im HUD jetzt: das Raster', 2200, 236, 28, C.dim, { font: 'label', align: 'center' });
    hudMirror(rec, 2200 - hud.HUD.w * 1.3 / 2, 290, 1.3, { mode: 'grid' }, cfg);
    rec.text('Gerade Linien, runder Kreis, mittig über der Leiste: fertig.', 2200, 690, 28, C.dim, { font: 'label', align: 'center' });
}

function readyPage(rec, v, cfg, ui) {
    title(rec, 'Bereit', 'Warmfahren endet, sobald alle eingeschalteten Temperaturen ihren Wert erreicht haben.');
    READY_ROWS.forEach((row) => {
        const it = S.ITEMS.find((x) => x.key === row.key);
        const mid = row.y + READY_ROW_H / 2 - 6;
        let on = true;
        if (row.kind === 'ready') {
            on = !!cfg[row.r.on];
            toggleSwitch(rec, READY_TARGETS.find((t) => t.id === `toggle:${row.r.on}`), on, ui);
            rec.text(row.label, X0 + 200 + 48, mid + 15, 40, on ? C.text : C.dim, { font: 'label' });
            rec.text('bereit ab', STEP_RIGHT - 2 * CTRL - 330, mid + 11, 30, C.dim, { font: 'label' });
        } else {
            rec.text(row.label, X0, mid + 15, 40, C.text, { font: 'label' });
            rec.text(row.note, X0 + 448, mid + 11, 28, C.dim, { font: 'label' });
            rec.text('ab', STEP_RIGHT - 2 * CTRL - 330, mid + 11, 30, C.dim, { font: 'label' });
        }
        const val = it.key === 'rpmMax' ? String(cfg[it.key]).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : String(cfg[it.key]);
        valueUnit(rec, val, it.unit, STEP_RIGHT - 2 * CTRL - 56, mid + 18, 50, !on ? C.dim : cfg[it.key] !== it.def ? C.ice : C.text, 26, 'right');
        rec.fillRect(X0, row.y + READY_ROW_H - 4, STEP_RIGHT - X0, 2, C.line);
    });
    READY_TARGETS.filter((t) => t.id.indexOf('toggle:') !== 0).forEach((t) => {
        const step = t.id.indexOf('dec:') === 0 || t.id.indexOf('inc:') === 0;
        button(rec, t, ui, { size: step ? 48 : 32 });
    });
}

/* A value's card: its place in the HUD (or none), name, value now, where it comes from. */
function valueCard(rec, b, i, cfg, v, ui, lifted) {
    const it = V.byKey(b.key);
    const inHud = i < cfg.count;
    const id = `cell:${b.key}`;
    if (!lifted && ui && ui.focus === id) rec.strokeRoundRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16, 30, 5, C.ice);
    rec.roundRect(b.x, b.y, b.w, b.h, 24, lifted ? '#1E2935' : ui && ui.pressed === id ? C.line : inHud ? '#17283A' : C.card);
    rec.strokeRoundRect(b.x, b.y, b.w, b.h, 24, inHud || lifted ? 3 : 2, inHud || lifted ? C.cold : C.line);
    if (inHud) {
        rec.roundRect(b.x + 24, b.y + 22, 112, 40, 20, C.cold);
        rec.text(`HUD ${i + 1}`, b.x + 80, b.y + 51, 24, C.asphalt, { font: 'label', align: 'center' });
    } else {
        rec.text('nicht im HUD', b.x + 24, b.y + 51, 24, C.dim, { font: 'label' });
    }
    rec.text(it.label, b.x + 24, b.y + 112, 34, C.text, { font: 'label' });
    const val = v ? v[b.key] : null;
    const tone = V.tone(b.key, val, cfg);
    const colour = tone === 'hot' ? C.limit : tone === 'cold' ? C.cold : tone === 'none' ? C.dim : C.text;
    let size = 60;
    while (size > 36 && rec.textWidth(V.text(b.key, val), size, { font: 'num' }) + rec.textWidth(it.unit, 24, { font: 'label' }) + 10 > b.w - 48) size -= 4;
    valueUnit(rec, V.text(b.key, val), it.unit, b.x + 24, b.y + 180, size, colour, 24, 'left');
    rec.text(it.src === 'cds' ? 'Fahrzeugsignal' : 'Diagnose', b.x + 24, b.y + 218, 22, it.src === 'cds' ? C.dim : '#C9A35A', { font: 'label' });
}

function valuesPage(rec, v, cfg, ui, extra) {
    title(rec, 'Werte im HUD', 'Halten und ziehen: an eine andere Stelle, ins HUD oder heraus. Tippen: ins HUD oder heraus. Bis zu drei.');
    const boxes = tempCellBoxes(cfg);
    const drag = ui && ui.drag;
    if (drag) {
        // the others make room where the lifted one would land
        const rest = boxes.filter((b) => b.key !== drag.key).map((b) => b.key);
        rest.splice(tempSlotAt(drag.x - drag.dx), 0, drag.key);
        rest.forEach((key, i) => {
            if (key !== drag.key) valueCard(rec, { key, x: X0 + i * CELL_STEP, y: CELL.y, w: CELL.w, h: CELL.h }, i, cfg, v, ui);
        });
        const at = Math.max(X0 - 40, Math.min(W - PAD - CELL.w + 40, drag.x - drag.dx));
        valueCard(rec, { key: drag.key, x: at, y: CELL.y - 16, w: CELL.w, h: CELL.h }, rest.indexOf(drag.key), cfg, v, ui, true);
    } else {
        boxes.forEach((b, i) => valueCard(rec, b, i, cfg, v, ui));
    }
    // the line between what the HUD shows and the rest
    const edge = X0 + cfg.count * CELL_STEP - CELL.gap / 2;
    rec.fillRect(edge - 2, CELL.y - 24, 4, CELL.h + 48, C.ice);
    // below: what it means, and the HUD with these values
    const lines = cfg.mode === 'values'
        ? ['Das HUD zeigt die Werte mit „HUD“-Marke, in dieser Reihenfolge.', 'Blau: noch kalt. Rot: zu heiß oder zu hoch (Grenzen unter „Bereit“).']
        : ['Diese Werte zeigt das HUD in der Anzeige „Werte“.', `Jetzt steht die Anzeige auf „${S.CHOICES.mode.words[cfg.mode]}“.`];
    lines.push('Diagnose-Werte fragt die App einmal pro Sekunde beim Motor an, nur solange sie im HUD stehen.');
    lines.forEach((l, i) => rec.text(l, X0, 520 + i * 42, 28, i === 2 ? '#C9A35A' : C.dim, { font: 'label' }));
    if (cfg.mode !== 'values') button(rec, SHOW_VALUES, ui);
    const shown = S.shown(cfg).map((key) => ({ key, label: V.byKey(key).hud, text: V.text(key, v[key]), unit: V.byKey(key).unit,
        tone: V.tone(key, v[key], cfg) }));
    hudMirror(rec, 2440 - hud.HUD.w * 0.86 / 2, 494, 0.86, { mode: 'values', items: shown }, cfg);
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

/* Text cut to fit width w (…). */
function fit(rec, text, size, w) {
    let t = String(text);
    if (rec.textWidth(t, size, { font: 'label' }) <= w) return t;
    while (t.length > 1 && rec.textWidth(`${t}…`, size, { font: 'label' }) > w) t = t.slice(0, -1);
    return `${t}…`;
}

/* The QR code: black modules on a white square (quiet zone included), runs of dark modules as one bar. */
function drawQr(rec, box, text) {
    const q = qrOf(text);
    const pad = 4 * box.m;
    rec.fillRect(box.x, box.y, box.side, box.side, '#FFFFFF');
    for (let y = 0; y < q.size; y++) {
        for (let x = 0; x < q.size; x++) {
            if (!q.dark(x, y)) continue;
            let n = 1;
            while (x + n < q.size && q.dark(x + n, y)) n++;
            rec.fillRect(box.x + pad + x * box.m, box.y + pad + y * box.m, n * box.m, box.m, '#000000');
            x += n - 1;
        }
    }
}

function githubPage(rec, v, cfg, ui, extra) {
    const st = (extra && extra.github) || { phase: 'off', online: true };
    const phase = st.phase;
    const ts = githubTargets(st);
    title(rec, 'Logs an GitHub', phase === 'pick' ? 'Welches Repository?' : 'Die Logs der App in dein eigenes GitHub schicken.');
    const btn = (id, opts) => { const t = ts.find((k) => k.id === id); if (t) button(rec, t, ui, opts); };
    button(rec, GH_BACK, ui);
    const sideText = (rx, lines, y0, size) => lines.forEach((l, i) => rec.text(l, rx, y0 + i * (size + 18), size, C.text, { font: 'label' }));
    let errorAt = { x: X0, y: 720 };
    if (phase === 'code' || phase === 'install') {
        const box = qrBox(st.qr);
        drawQr(rec, box, st.qr);
        const rx = qrRight(st.qr);
        if (phase === 'code') {
            rec.text('Dein Code', rx, 250, 30, C.dim, { font: 'label' });
            rec.text(st.code || '', rx, 380, 130, C.ice, { font: 'label' });
            sideText(rx, ['1. QR-Code scannen', '2. Code eingeben', '3. Bestätigen'], 450, 40);
        } else {
            rec.text('Fast fertig', rx, 300, 56, C.text, { font: 'label' });
            sideText(rx, ['Repository für die Logs auswählen', 'und auf Installieren tippen'], 380, 40);
        }
        btn('gh:cancel');
        errorAt = { x: rx, y: 610 };
    } else if (phase === 'pick') {
        ts.filter((t) => t.id.indexOf('gh:choose:') === 0).forEach((t) => button(rec, Object.assign({}, t, { label: fit(rec, t.label, 36, t.w - 60) }), ui, { size: 36 }));
        errorAt = { x: X0, y: 700 };
    } else if (phase === 'ready' || phase === 'sending') {
        rec.text(fit(rec, `Verbunden mit ${st.repo || ''}`, 56, W - PAD - X0), X0, 290, 56, C.text, { font: 'label' });
        if (phase === 'ready') {
            btn('gh:send', { primary: true, size: 48 });
            if (st.sent) {
                const d = clock.wall(st.sent.at);
                const p = (n) => String(n).padStart(2, '0');
                rec.text(`Gesendet ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, X0 + 600 + 60, 330 + 60 + 15, 44, C.ok, { font: 'label' });
            }
            btn('gh:disconnect');
        } else {
            rec.text('Wird gesendet …', X0, 400, 56, C.ice, { font: 'label' });
        }
        errorAt = { x: X0, y: 540 };
    } else {
        rec.text('Deine Logs landen in deinem eigenen GitHub.', X0, 270, 48, C.text, { font: 'label' });
        rec.text('Einmal mit dem Handy verbinden.', X0, 336, 48, C.text, { font: 'label' });
        btn('gh:connect', { primary: true, size: 44 });
        if (st.online === false) rec.text('Kein Internet – ist das Handy verbunden?', X0, 560, 36, C.limit, { font: 'label' });
        errorAt = { x: X0, y: 640 };
    }
    if (st.error) rec.text(fit(rec, st.error, 32, W - PAD - errorAt.x), errorAt.x, errorAt.y, 32, C.limit, { font: 'label' });
}

function draw(rec, page, v, cfg, ui, extra) {
    v = v || {};
    cfg = S.clean(cfg || S.defaults());
    rec.clear(C.asphalt);
    rail(rec, page, ui);
    if (page === 'values') valuesPage(rec, v, cfg, ui, extra);
    else if (page === 'display') displayPage(rec, v, cfg, ui);
    else if (page === 'align') alignPage(rec, v, cfg, ui);
    else if (page === 'ready') readyPage(rec, v, cfg, ui);
    else if (page === 'status') statusPage(rec, v, cfg, ui);
    else if (page === 'github') githubPage(rec, v, cfg, ui, extra);
    else mainPage(rec, v, cfg, ui);
    return rec;
}

module.exports = { draw, targets, tempCellBoxes, tempSlotAt, DRAG_PAGE, W, H, C, TABS, qrBox };
