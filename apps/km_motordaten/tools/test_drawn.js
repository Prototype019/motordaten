'use strict';
/**
 * src/drawn.js against a fake renderer: layer mode at its answer, shown
 * only while the host state is visible and focused, frames on show and
 * tick, the reset button by touch and by the controller, and the list
 * screen when the renderer has no layer mode.
 *
 *   node tools/test_drawn.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const { Drawn } = require('../src/drawn.js');
const dash = require('../src/dash.js');

const log = { info() {}, warn() {}, error() {} };

function fakeGpu() {
    const g = new EventEmitter();
    Object.assign(g, { calls: [], frames: 0, waiting: false, visible: false,
        connect() {}, close() {}, mode(m) { g.calls.push(['mode', m]); }, place(p) { g.calls.push(['place', p]); },
        claim(r) { g.calls.push(['claim', r]); }, show(on) { g.visible = on; g.calls.push(['show', on]); },
        frame(rec) { assert.ok(rec.words().length > 100); g.frames++; } });
    return g;
}

(async () => {
    const g = fakeGpu();
    const fresh = new Drawn('km_motordaten', log, g);

    const modes = [];
    fresh.on('mode', (m) => modes.push(m));
    g.emit('ready', { w: 2880, h: 960 }, { modes: ['layer'], appArea: { x: 0, y: 76, w: 2880, h: 764 } });
    assert.deepStrictEqual(modes, ['layer']);
    assert.deepStrictEqual(g.calls.find((c) => c[0] === 'place')[1], { x: 0, y: 76, w: 2880, h: 764, scale: 1, ox: 0, oy: 0 });
    assert.strictEqual(g.visible, false, 'hidden until the host state shows');

    fresh.hostVisible(true);
    assert.strictEqual(g.visible, true);
    assert.deepStrictEqual(g.calls.filter((c) => c[0] === 'claim').pop()[1], [dash.RESET]);
    const f0 = g.frames;
    assert.ok(f0 >= 1, 'a frame before it shows');

    fresh.set({ rpm: 3000, oil: 90 });
    assert.ok(g.frames > f0, 'new values drawn');

    fresh.hostFocus(false);
    assert.strictEqual(g.visible, false, 'a popup over it hides the layer');
    fresh.hostFocus(true);
    assert.strictEqual(g.visible, true);

    let resets = 0;
    fresh.on('reset', () => resets++);
    const r = dash.RESET;
    g.emit('touch', 'down', r.x + 10, r.y + 10);
    g.emit('touch', 'up', r.x + 10, r.y + 10);
    assert.strictEqual(resets, 1, 'tap on the button');
    g.emit('touch', 'down', 10, 10);
    g.emit('touch', 'up', 10, 10);
    assert.strictEqual(resets, 1, 'tap elsewhere');
    fresh.proxyPress();
    assert.strictEqual(resets, 2, 'controller press');

    fresh.hostVisible(false);
    assert.strictEqual(g.visible, false);
    assert.deepStrictEqual(g.calls.filter((c) => c[0] === 'claim').pop()[1], []);

    // no layer mode: the list stays
    const other = new Drawn('km_motordaten', log, fakeGpu());
    const m2 = [];
    other.on('mode', (m) => m2.push(m));
    other._ready(null);
    assert.deepStrictEqual(m2, [null]);
    other.hostVisible(true);
    assert.strictEqual(other.isShown(), false);

    // the real client gets the kit, so it uploads the glyph atlases text needs
    const real = new Drawn('km_motordaten', log);
    assert.ok(real.gpu.kit && typeof real.gpu.kit.atlasById === 'function', 'client has the kit');
    const rec = new (require('../src/kit_record.js').Recorder)(100, 100);
    rec.text('Öl 92', 0, 50, 30, '#fff', { font: 'label' });
    rec.text('1,94', 0, 90, 40, '#fff', { font: 'num' });
    assert.ok(rec.atlases.size >= 2, 'text records its atlases');
    rec.atlases.forEach((id) => assert.ok(real.gpu.kit.atlasById(id), `atlas ${id} found by the client`));
    // a frame sends the atlases its text uses before the FRAME message
    const sent = [];
    Object.assign(real.gpu, { ready: true, native: true, placement: { scale: 1 }, _write: (b) => { sent.push(b.readUInt32LE(0)); return true; } });
    real.mode = 'layer';
    real.hostVisible(true);
    assert.ok(sent.indexOf(4) >= 0, 'ATLAS sent');
    assert.ok(sent.indexOf(4) < sent.lastIndexOf(7), 'before the FRAME');
    real.hostVisible(false);
    real.close();

    [fresh, other].forEach((x) => clearInterval(x.keepalive));
    console.log(`test_drawn: ok, ${g.frames} frames`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
