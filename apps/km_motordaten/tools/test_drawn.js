'use strict';
/**
 * src/drawn.js against a fake renderer: layer mode at its answer, shown
 * only while the host state is visible and focused, the whole area claimed,
 * frames on show and on new values, taps on targets (and elsewhere: none),
 * the controller through proxy buttons, the settings page, gliding bars,
 * the list screen when the renderer has no layer mode, and the atlases a
 * frame's text needs going out before the frame.
 *
 *   node tools/test_drawn.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const { Drawn } = require('../src/drawn.js');
const dash = require('../src/dash.js');
const Limits = require('../src/limits.js');
const spec = require('../spec.js');

const log = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeGpu() {
    const g = new EventEmitter();
    Object.assign(g, { calls: [], frames: 0, waiting: false, visible: false,
        connect() {}, close() {}, mode(m) { g.calls.push(['mode', m]); }, place(p) { g.calls.push(['place', p]); },
        claim(r) { g.calls.push(['claim', r]); }, show(on) { g.visible = on; g.calls.push(['show', on]); },
        frame(rec) { assert.ok(rec.words().length > 100); g.frames++; } });
    return g;
}
const center = (t) => [t.x + t.w / 2, t.y + t.h / 2];

(async () => {
    // every target of every page has a proxy button
    assert.ok(dash.targets('settings').length <= spec.PROXIES && dash.targets('main').length <= spec.PROXIES);

    const g = fakeGpu();
    const d = new Drawn('km_motordaten', log, g);
    d.setLimits(Limits.defaults());
    const modes = [];
    d.on('mode', (m) => modes.push(m));
    g.emit('ready', { w: 2880, h: 960 }, { modes: ['layer'], appArea: { x: 0, y: 76, w: 2880, h: 764 } });
    assert.deepStrictEqual(modes, ['layer']);
    assert.deepStrictEqual(g.calls.find((c) => c[0] === 'place')[1], { x: 0, y: 76, w: 2880, h: 764, scale: 1, ox: 0, oy: 0 });
    assert.strictEqual(g.visible, false, 'hidden until the host state shows');

    d.hostVisible(true);
    assert.strictEqual(g.visible, true);
    assert.deepStrictEqual(g.calls.filter((c) => c[0] === 'claim').pop()[1], [{ x: 0, y: 0, w: dash.W, h: dash.H }],
        'the whole area: no touch reaches the HMI under the layer');
    const f0 = g.frames;
    d.set({ rpm: 3000, oil: 90, boost: 1.2 });
    assert.ok(g.frames > f0, 'new values drawn');

    // the bars glide: a jump is not drawn at once, but reached after a few frames
    d.set({ rpm: 6000, oil: 90, boost: 1.2 });
    assert.ok(d.bars.rpm < 6000 && d.bars.rpm >= 3000, `gliding: ${d.bars.rpm}`);
    for (let i = 0; i < 120 && d.dirty; i++) {
        await wait(16);
        g.emit('tick');
    }
    assert.strictEqual(d.bars.rpm, 6000, 'arrived');

    d.hostFocus(false);
    assert.strictEqual(g.visible, false, 'a popup over it hides the layer');
    d.hostFocus(true);
    assert.strictEqual(g.visible, true);

    const actions = [];
    d.on('action', (id) => actions.push(id));
    const reset = dash.targets('main').find((t) => t.id === 'reset');
    g.emit('touch', 'down', ...center(reset));
    assert.strictEqual(d.ui.pressed, 'reset', 'pressed while held');
    g.emit('touch', 'up', ...center(reset));
    assert.deepStrictEqual(actions, ['reset'], 'tap on the button');
    g.emit('touch', 'down', 10, 10);
    g.emit('touch', 'up', 10, 10);
    assert.deepStrictEqual(actions, ['reset'], 'tap elsewhere: nothing');
    g.emit('touch', 'down', ...center(reset));
    g.emit('touch', 'move', 10, 10);
    g.emit('touch', 'up', 10, 10);
    assert.deepStrictEqual(actions, ['reset'], 'dragged off: nothing');

    // the controller: proxy i is target i
    d.proxyFocus(1, true);
    assert.strictEqual(d.ui.focus, 'settings');
    d.proxyPress(1);
    assert.deepStrictEqual(actions, ['reset', 'settings']);

    // the settings page: its targets for touch and proxies
    const told = [];
    d.on('targets', (t) => told.push(t.length));
    d.setPage('settings');
    assert.deepStrictEqual(told, [dash.targets('settings').length]);
    const inc = dash.targets('settings').find((t) => t.id === 'inc:oilReady');
    g.emit('touch', 'down', ...center(inc));
    g.emit('touch', 'up', ...center(inc));
    assert.strictEqual(actions.pop(), 'inc:oilReady');
    d.proxyPress(dash.targets('settings').findIndex((t) => t.id === 'done'));
    assert.strictEqual(actions.pop(), 'done');

    d.hostVisible(false);
    assert.strictEqual(g.visible, false);
    assert.deepStrictEqual(g.calls.filter((c) => c[0] === 'claim').pop()[1], []);

    // limits: stepped on their range, saved and read back
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    process.env.KM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'km-lim-'));
    let lim = Limits.load();
    assert.deepStrictEqual(lim, Limits.defaults());
    lim = Limits.stepped(lim, 'oilReady', 1);
    lim = Limits.stepped(lim, 'oilPressMin', -1);
    for (let i = 0; i < 50; i++) lim = Limits.stepped(lim, 'rpmRed', 1);
    assert.strictEqual(lim.oilReady, 75);
    assert.strictEqual(lim.oilPressMin, 0.9);
    assert.strictEqual(lim.rpmRed, 7600, 'held at its maximum');
    Limits.save(lim);
    assert.deepStrictEqual(Limits.load(), lim);
    fs.writeFileSync(path.join(process.env.KM_DATA_DIR, 'limits.json'), '{"oilReady": 1000, "rpmRed": "x"}');
    assert.strictEqual(Limits.load().oilReady, 100, 'a saved value out of range is clamped');
    assert.strictEqual(Limits.load().rpmRed, 6400, 'one that is no number is the default');

    // no layer mode: the list stays
    const other = new Drawn('km_motordaten', log, fakeGpu());
    const m2 = [];
    other.on('mode', (m) => m2.push(m));
    other._ready(null);
    assert.deepStrictEqual(m2, [null]);
    other.hostVisible(true);
    assert.strictEqual(other.isShown(), false);

    // the real client gets the kit, so it uploads the glyph atlases text needs, before the frame
    const real = new Drawn('km_motordaten', log);
    assert.ok(real.gpu.kit && typeof real.gpu.kit.atlasById === 'function', 'client has the kit');
    const sent = [];
    Object.assign(real.gpu, { ready: true, native: true, placement: { scale: 1 }, _write: (b) => { sent.push(b.readUInt32LE(0)); return true; } });
    real.mode = 'layer';
    real.setLimits(Limits.defaults());
    real.hostVisible(true);
    assert.ok(sent.indexOf(4) >= 0, 'ATLAS sent');
    assert.ok(sent.indexOf(4) < sent.lastIndexOf(7), 'before the FRAME');
    real.hostVisible(false);
    real.close();

    [d, other].forEach((x) => clearInterval(x.keepalive));
    console.log(`test_drawn: ok, ${g.frames} frames`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
