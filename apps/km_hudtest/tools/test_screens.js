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
assert.deepStrictEqual(new Warmup().view({ oil: 60 }, S.chosen(def, 'mode', 'always'), 0), { mode: 'oil', label: 'Öl', value: 60, cold: true });
assert.strictEqual(new Warmup().view({ oil: 96 }, S.chosen(def, 'mode', 'always'), 0).cold, false);
const none = Object.assign({}, def, { oilReadyOn: 0, coolantReadyOn: 0 });
assert.strictEqual(new Warmup().view({ oil: 40 }, none, 0), null, 'nothing counts: nothing');
assert.strictEqual(new Warmup().words(null, none, { oil: 40 }).title, 'Nichts eingestellt');
assert.strictEqual(new Warmup().words(null, def, {}).title, 'Warte auf Werte');
TEST.forEach((t, i) => assert.deepStrictEqual(testView(100, 100 + i * TEST_STEP_MS), t));
assert.strictEqual(testView(100, 100 + TEST.length * TEST_STEP_MS), null, 'the test ends');

/* ---- the HUD's picture: every look, every place and size, inside the area, something drawn ---- */
const looks = [{ mode: 'warm', label: 'Kühlmittel', value: 62 }, { mode: 'ready', label: 'Öl', value: 82 },
    { mode: 'hot', label: 'Öl', value: 133 }, { mode: 'oil', label: 'Öl', value: 96, cold: false }];
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
    const what = `${look.mode} ${pos} ${size}`;
    assert.ok(x1 >= 0, `${what}: something drawn`);
    assert.ok(x0 >= 2 && x1 <= hud.HUD.w - 3 && y0 >= 2 && y1 <= hud.HUD.h - 3, `${what}: inside (${x0}-${x1}, ${y0}-${y1})`);
    if (pos === 'left') assert.ok(x0 < 40, `${what}: at the left`);
    if (pos === 'right') assert.ok(x1 > hud.HUD.w - 40, `${what}: at the right`);
})));
assert.notStrictEqual(hud.key({ mode: 'warm', value: 40, pos: 'left' }), hud.key({ mode: 'warm', value: 40, pos: 'right' }), 'a move draws again');

/* ---- the screens ---- */
['main', 'display', 'ready', 'status'].forEach((page) => {
    const v = { oil: 47, coolant: 58, view: looks[0], words: { title: 'T', text: 't' }, rows: [['a', 'b']] };
    dash.draw(new Recorder(dash.W, dash.H), page, v, def, { focus: null });
    dash.draw(new Recorder(dash.W, dash.H), page, {}, def, null);
    const ts = dash.targets(page);
    assert.ok(ts.length <= spec.PROXIES, `${page}: ${ts.length} targets, ${spec.PROXIES} proxies`);
    assert.strictEqual(new Set(ts.map((t) => t.id)).size, ts.length, `${page}: every id once`);
    ts.forEach((t) => {
        assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= dash.W && t.y + t.h <= dash.H, `${page} ${t.id} on the screen`);
        assert.ok(t.h >= 84 || t.page, `${page} ${t.id}: large enough to press (${t.h})`);
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

console.log('test_screens: ok');
