'use strict';
/**
 * The HUD app's parts without a head unit: src/settings.js (allowed values, kept and read back),
 * src/warmup.js (what the HUD shows when), src/hud_draw.js (every look, every place, inside the 353 x 203)
 * and src/dash.js (every page draws; its targets fit the screen, do not overlap, and are no more than the
 * host state's proxy buttons).
 *
 *   node apps/km_hudtest/tools/test_screens.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'km-hudscr-'));
const S = require('../src/settings.js');
const { Warmup, testView, TEST, TEST_STEP_MS, READY_SHOW_MS } = require('../src/warmup.js');
const hud = require('../src/hud_draw.js');
const dash = require('../src/dash.js');
const spec = require('../spec.js');
const { Recorder } = require('../src/kit_record.js');

/* ---- settings ---- */
const def = S.defaults();
assert.deepStrictEqual([def.mode, def.pos, def.size, def.oilReady, def.coolantReady, def.oilMax], ['warm', 'center', 'normal', 80, 70, 130]);
assert.deepStrictEqual(S.load(), def, 'nothing kept yet: the defaults');
assert.strictEqual(S.clean({ mode: 'blink', oilReady: 83, oilMax: 999 }).mode, 'warm', 'a word not allowed: the default');
assert.strictEqual(S.clean({ oilReady: 83 }).oilReady, 85, 'on its step');
assert.strictEqual(S.clean({ oilMax: 999 }).oilMax, 150, 'in its range');
let s = S.chosen(def, 'pos', 'right');
s = S.stepped(s, 'oilReady', -1);
s = S.toggled(s, 'coolantReadyOn');
assert.strictEqual(S.chosen(s, 'pos', 'up'), s, 'an unknown word changes nothing');
assert.strictEqual(S.stepped(s, 'coolantReadyOn', 1), s, 'a switch has no steps');
assert.ok(S.save(s));
assert.deepStrictEqual(S.load(), s, 'kept and read back');
// as on the car (Node 8): mkdir of a folder that is there throws, whatever the options; saved twice, the second wins
const realMkdir = fs.mkdirSync;
fs.mkdirSync = (dir) => { if (fs.existsSync(dir)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; } return realMkdir(dir); };
assert.ok(S.save(S.chosen(s, 'size', 'large')), 'saved with the folder there');
assert.strictEqual(S.load().size, 'large', 'and read back');
fs.mkdirSync = realMkdir;
assert.ok(!fs.readdirSync(path.dirname(S.file())).some((n) => /\.tmp$/.test(n)), 'no temp file left');
fs.writeFileSync(S.file(), '{ not json');
assert.deepStrictEqual(S.load(), def, 'a broken file: the defaults');

/* ---- what the HUD shows ---- */
let w = new Warmup();
assert.strictEqual(w.view({ oil: null, coolant: 50 }, def, 0), null, 'oil not known: nothing');
assert.deepStrictEqual(w.view({ oil: 47, coolant: 50 }, def, 0), { mode: 'warm', label: 'Öl', value: 47 });
assert.deepStrictEqual(w.view({ oil: 85, coolant: 60 }, def, 0), { mode: 'warm', label: 'Kühlmittel', value: 60 });
assert.strictEqual(w.view({ oil: 85 }, def, 1000).mode, 'ready', 'coolant not sent: it does not hold up ready');
assert.strictEqual(w.view({ oil: 85 }, def, 1000 + READY_SHOW_MS - 1).mode, 'ready');
assert.strictEqual(w.view({ oil: 85 }, def, 1000 + READY_SHOW_MS), null, 'Bereit shown, then nothing');
assert.strictEqual(w.view({ oil: 70 }, def, 9000), null, 'a little cooler: still nothing');
assert.strictEqual(w.view({ oil: 132 }, def, 9000).mode, 'hot', 'too hot: whatever else');
assert.strictEqual(w.view({ oil: 60 }, def, 9000).mode, 'warm', 'far under again: a cold start');
assert.strictEqual(new Warmup().view({ oil: 40 }, S.chosen(def, 'mode', 'off'), 0), null, 'off: nothing');
assert.strictEqual(new Warmup().view({ oil: 140 }, S.chosen(def, 'mode', 'off'), 0), null, 'off: not even hot');
// Werte: the chosen values with their tones; the oil red itself when shown, else the hot look over all
let vs = Object.assign(S.chosen(def, 'mode', 'values'), { order: ['oil', 'boost', 'coolant'], count: 3 });
assert.deepStrictEqual(new Warmup().view({ oil: 60, boost: 1.234, coolant: 120 }, vs, 0), { mode: 'values', items: [
    { key: 'oil', label: 'ÖL', text: '60', unit: '°C', tone: 'cold' },
    { key: 'boost', label: 'LADEDRUCK', text: '1,23', unit: 'bar', tone: 'normal' },
    { key: 'coolant', label: 'WASSER', text: '120', unit: '°C', tone: 'hot' }] });
assert.strictEqual(new Warmup().view({ oil: 140 }, vs, 0).items[0].tone, 'hot', 'shown: red there');
assert.strictEqual(new Warmup().view({}, vs, 0).items[1].text, '–', 'not known yet: a dash, still shown');
assert.strictEqual(new Warmup().view({ oil: 140 }, Object.assign({}, vs, { order: ['boost'], count: 1 }), 0).mode, 'hot',
    'not shown: the hot look');
assert.strictEqual(S.clean({ mode: 'always' }).mode, 'values', '0.3.0 kept "always"');
assert.strictEqual(new Warmup().words(new Warmup().view({ oil: 60 }, vs, 0), vs, { oil: 60 }).title, 'Werte im HUD');

// choosing the values: tap in and out, drag in, out and around; never none, never more than three
let c = S.defaults();
assert.deepStrictEqual(S.shown(c), ['oil']);
assert.strictEqual(S.tapped(c, 'oil'), c, 'the last one stays');
c = S.tapped(c, 'boost');
assert.deepStrictEqual(S.shown(c), ['oil', 'boost']);
c = S.tapped(c, 'rpm');
c = S.tapped(c, 'voltage');
assert.deepStrictEqual(S.shown(c), ['oil', 'boost', 'voltage'], 'full: the last one out for the new one');
c = S.tapped(c, 'oil');
assert.deepStrictEqual(S.shown(c), ['boost', 'voltage']);
const move = (st, key, to) => { const o = S.cleanOrder(st.order).filter((k) => k !== key); o.splice(to, 0, key); return S.dropped(st, o, key); };
c = move(c, 'intake', 0);
assert.deepStrictEqual(S.shown(c), ['intake', 'boost', 'voltage'], 'dragged in at the front');
c = move(c, 'intake', 6);
assert.deepStrictEqual(S.shown(c), ['boost', 'voltage'], 'dragged out');
c = move(c, 'voltage', 0);
assert.deepStrictEqual(S.shown(c), ['voltage', 'boost'], 'reordered inside');
c = move(c, 'boost', 5);
c = move(c, 'voltage', 5);
assert.deepStrictEqual(S.shown(c).length, 1, 'the last one cannot be dragged out');
assert.deepStrictEqual(S.cleanOrder(['x', 'oil', 'oil']).length, 8, 'every value once');
const none = Object.assign({}, def, { oilReadyOn: 0, coolantReadyOn: 0 });
assert.strictEqual(new Warmup().view({ oil: 40 }, none, 0), null, 'nothing counts: nothing');
assert.strictEqual(new Warmup().words(null, none, { oil: 40 }).title, 'Nichts eingestellt');
assert.strictEqual(new Warmup().words(null, def, {}).title, 'Warte auf Werte');
TEST.forEach((t, i) => assert.deepStrictEqual(testView(100, 100 + i * TEST_STEP_MS), t));
assert.strictEqual(testView(100, 100 + TEST.length * TEST_STEP_MS), null, 'the test ends');

/* ---- the HUD's picture: every look, every place and size, inside the area, something drawn ---- */
const item = (key, text, unit, tone) => ({ key, label: require('../src/values.js').byKey(key).hud, text, unit, tone });
const looks = [{ mode: 'warm', label: 'Kühlmittel', value: 62 }, { mode: 'ready', label: 'Öl', value: 82 },
    { mode: 'hot', label: 'Öl', value: 133 },
    { mode: 'values', items: [item('oil', '96', '°C', 'normal')] },
    { mode: 'values', items: [item('oil', '58', '°C', 'cold'), item('rpm', '6.450', 'U/min', 'hot')] },
    { mode: 'values', items: [item('intake', '31', '°C', 'normal'), item('rpm', '7.600', 'U/min', 'hot'), item('gearbox', '120', '°C', 'normal')] }];
looks.forEach((look) => S.CHOICES.pos.all.forEach((pos) => S.CHOICES.size.all.forEach((size) => {
    const c = hud.drawHud(Object.assign({ pos, size }, look));
    let x0 = Infinity;
    let x1 = -1;
    let y0 = Infinity;
    let y1 = -1;
    for (let y = 0; y < c.h; y++) {
        for (let x = 0; x < c.w; x++) {
            if (c.d[(y * c.w + x) * 4 + 3] > 0) {
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
        }
    }
    const what = `${look.mode}${look.items ? look.items.length : ''} ${pos} ${size}`;
    assert.ok(x1 >= 0, `${what}: something drawn`);
    assert.ok(x0 >= 2 && x1 <= hud.HUD.w - 3 && y0 >= 2 && y1 <= hud.HUD.h - 3, `${what}: inside (${x0}-${x1}, ${y0}-${y1})`);
    if (pos === 'left') assert.ok(x0 < 40, `${what}: at the left`);
    if (pos === 'right') assert.ok(x1 > hud.HUD.w - 40, `${what}: at the right`);
})));
assert.notStrictEqual(hud.key({ mode: 'warm', value: 40, pos: 'left' }), hud.key({ mode: 'warm', value: 40, pos: 'right' }), 'a move draws again');

/* ---- the screens ---- */
const extra = { order: S.cleanOrder(), count: 1, mode: 'warm' };
['main', 'values', 'display', 'ready', 'status'].forEach((page) => {
    const v = { oil: 47, coolant: 58, rpm: 3450, boost: 1.2, view: looks[0], words: { title: 'T', text: 't' }, rows: [['a', 'b']] };
    dash.draw(new Recorder(dash.W, dash.H), page, v, def, { focus: null }, extra);
    dash.draw(new Recorder(dash.W, dash.H), page, {}, def, null, extra);
    const ts = dash.targets(page, extra);
    assert.ok(ts.length <= spec.PROXIES, `${page}: ${ts.length} targets, ${spec.PROXIES} proxies`);
    assert.strictEqual(new Set(ts.map((t) => t.id)).size, ts.length, `${page}: every id once`);
    ts.forEach((t) => {
        assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= dash.W && t.y + t.h <= dash.H, `${page} ${t.id} on the screen`);
        assert.ok(t.h >= 84 || t.page, `${page} ${t.id}: large enough to press (${t.h})`);
        assert.ok(t.w >= 84, `${page} ${t.id}: wide enough to press (${t.w})`);
    });
    for (let i = 0; i < ts.length; i++) {
        for (let j = i + 1; j < ts.length; j++) {
            const a = ts[i];
            const b = ts[j];
            const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
            assert.ok(apart, `${page}: ${a.id} and ${b.id} overlap`);
        }
    }
    // every choice, switch and step on the page does something the settings know
    ts.filter((t) => /^(choose|toggle|dec|inc):/.test(t.id)).forEach((t) => {
        const p = t.id.split(':');
        const after = p[0] === 'choose' ? S.chosen(def, p[1], p[2]) : p[0] === 'toggle' ? S.toggled(def, p[1])
            : S.stepped(def, p[1], p[0] === 'inc' ? 1 : -1);
        if (p[0] === 'choose' && def[p[1]] === p[2]) {
            assert.deepStrictEqual(after, def, `${t.id}: already chosen`);
        } else {
            assert.notDeepStrictEqual(after, def, `${t.id} changes something`);
        }
    });
});

// the Werte page: a card per value, each a drag target, in the settings' order; the drag's slots
const cards = dash.targets('values', extra).filter((t) => t.drag);
assert.deepStrictEqual(cards.map((t) => t.id.slice(5)), S.cleanOrder(), 'every value a card, in order');
assert.strictEqual(dash.DRAG_PAGE, 'values');
assert.deepStrictEqual(dash.tempCellBoxes(def).map((b) => b.key), S.cleanOrder());
cards.forEach((t, i) => assert.strictEqual(dash.tempSlotAt(t.x + 5), i, `${t.id}: its own slot`));
assert.strictEqual(dash.tempSlotAt(-500), 0);
assert.strictEqual(dash.tempSlotAt(99999), cards.length - 1);
assert.ok(dash.targets('values', Object.assign({}, extra, { mode: 'values' })).every((t) => t.id !== 'choose:mode:values'),
    'Werte anzeigen only while another mode is on');
// a card lifted and moved draws
dash.draw(new Recorder(dash.W, dash.H), 'values', { oil: 50 }, def, { drag: { key: 'boost', x: 900, dx: 40 } }, extra);

// Ausrichten: the correction from the settings, the picture drawn the other way round
assert.deepStrictEqual(S.correction(def), { tilt: 0, shift: 0, height: 100, width: 100 });
const plain = hud.drawHud({ mode: 'grid' });
assert.strictEqual(hud.warp(plain, S.correction(def)), plain, 'nothing to correct: as it is');
const alpha = (c, x, y) => c.d[(y * c.w + x) * 4 + 3];
const column = (c, y) => { let best = -1; let bx = -1; for (let x = 100; x < 253; x++) { if (alpha(c, x, y) > best) { best = alpha(c, x, y); bx = x; } } return bx; };
const straight = hud.drawHud({ mode: 'grid' });
assert.ok(Math.abs(column(straight, 40) - column(straight, 160)) <= 1, 'the middle line upright');
const tilted = hud.drawHud({ mode: 'grid', cal: { tilt: 30, shift: 0, height: 100 } });
assert.ok(column(tilted, 40) < column(tilted, 160) - 40, '+ tilt leans the top to the left');
const moved = hud.drawHud({ mode: 'grid', cal: { tilt: 0, shift: 20, height: 100 } });
assert.strictEqual(column(moved, 100), column(straight, 100) + 20, '+ shift moves right');
assert.notStrictEqual(hud.key({ mode: 'warm', value: 50, cal: { tilt: 10, shift: 0, height: 100 } }),
    hud.key({ mode: 'warm', value: 50, cal: { tilt: 12, shift: 0, height: 100 } }), 'a new correction draws again');
const st = S.stepped(S.stepped(def, 'tilt', 1), 'height', 1);
assert.deepStrictEqual(S.correction(st), { tilt: 1, shift: 0, height: 105, width: 100 });
const span = (c) => { let a = 999; let b = -1; for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (alpha(c, x, y) > 40) { a = Math.min(a, x); b = Math.max(b, x); } return [a, b]; };
const full = span(hud.drawHud({ mode: 'grid' }));
const narrow = span(hud.drawHud({ mode: 'grid', cal: { tilt: 0, shift: 0, height: 100, width: 70 } }));
assert.ok(narrow[0] > full[0] + 40 && narrow[1] < full[1] - 40, `narrower about the middle: ${full} -> ${narrow}`);
assert.ok(Math.abs((narrow[0] + narrow[1]) / 2 - (full[0] + full[1]) / 2) <= 2, 'still in the middle');
assert.strictEqual(S.clean({ tilt: 99 }).tilt, 45, 'in its range');
['align'].forEach((page) => {
    dash.draw(new Recorder(dash.W, dash.H), page, {}, st, null, extra);
    const ts = dash.targets(page, extra);
    assert.ok(ts.length <= spec.PROXIES);
    assert.ok(ts.some((t) => t.id === 'inc:tilt') && ts.some((t) => t.id === 'page:display') && ts.some((t) => t.id === 'align:defaults'));
});
assert.ok(dash.targets('display', extra).some((t) => t.id === 'page:align'), 'Anzeige opens Ausrichten');

console.log('test_screens: ok');
