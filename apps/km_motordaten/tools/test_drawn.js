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
const SETTLE = 850;

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
    const many = { logs: new Array(30).fill({ start: new Date(), peak: {} }), confirmDelete: true, recording: { ms: 1 } };
    ['main', 'settings', 'logs', 'log'].forEach((p) => assert.ok(dash.targets(p, many).length <= spec.PROXIES, p));
    assert.strictEqual(spec.PROXIES, Number(/const PROXIES = (\d+)/.exec(require('fs').readFileSync(require.resolve('../src/motordaten.js'), 'utf8'))[1]),
        'motordaten.js knows the proxy count');

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
    assert.strictEqual(g.visible, true, 'a moment unfocused: still shown');
    await wait(SETTLE);
    assert.strictEqual(g.visible, false, 'a popup over it hides the layer');
    d.hostFocus(true);
    assert.strictEqual(g.visible, true);

    // back from another app: the HMI says hidden and unfocused, then only visible again
    d.hostFocus(false);
    d.hostVisible(false);
    await wait(SETTLE);
    assert.strictEqual(g.visible, false);
    d.hostVisible(true);
    assert.strictEqual(g.visible, true, 'visible again counts as focused');
    // a proxy getting the focus means the state has it
    d.hostFocus(false);
    await wait(SETTLE);
    assert.strictEqual(g.visible, false);
    d.proxyFocus(0, true);
    assert.strictEqual(g.visible, true, 'a focused proxy shows the layer');

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

    // the controller: proxy i is target i; the tabs come first
    const main = dash.targets('main', d.extra).map((t) => t.id);
    assert.deepStrictEqual(main, ['tab:main', 'tab:logs', 'tab:faults', 'tab:settings', 'record', 'reset']);
    d.proxyFocus(3, true);
    assert.strictEqual(d.ui.focus, 'tab:settings');
    d.proxyPress(3);
    assert.deepStrictEqual(actions, ['reset', 'tab:settings']);
    // a tab by touch too
    const logsTab = dash.targets('main', d.extra)[1];
    g.emit('touch', 'down', ...center(logsTab));
    g.emit('touch', 'up', ...center(logsTab));
    assert.strictEqual(actions.pop(), 'tab:logs');

    // the dial from FrontCCU: heard in list mode (the app then switches), moving the focus in single mode
    const dials = [];
    d.on('dial', (n) => dials.push(n));
    d.ccu({ frontRotaryEncoderOperation: 100 });
    d.ccu({ frontRotaryEncoderOperation: 101 });
    assert.deepStrictEqual(dials, [0, 1], 'the first sample, then a turn');
    const before = d.ui.focus;
    d.ccu({ frontRotaryEncoderOperation: 102 });
    assert.strictEqual(d.ui.focus, before, 'list mode: the HMI moves the focus, not the dial');
    let proxyTold = null;
    d.once('targets', (t) => { proxyTold = t; });
    d.setSingle(true);
    assert.ok(proxyTold, 'the app hears to set its proxies again');
    d.ui.focus = null;
    d.ccu({ frontRotaryEncoderOperation: 103 });
    assert.strictEqual(d.ui.focus, 'tab:main', 'first turn: the first target');
    d.ccu({ frontRotaryEncoderOperation: 106 });
    assert.strictEqual(d.ui.focus, 'tab:settings', 'three detents on');
    d.ccu({ frontRotaryEncoderOperation: 0xffff });
    d.ccu({ frontRotaryEncoderOperation: 104 });
    assert.strictEqual(d.ui.focus, 'tab:logs', 'an invalid sample in between is skipped');
    d.ccu({ frontRotaryEncoderOperation: 104 + 500 });
    assert.strictEqual(d.ui.focus, 'tab:logs', 'a jump is a stale sample');
    d.ccu({ frontRotaryEncoderOperation: 104 + 500 + 9 });
    assert.strictEqual(d.ui.focus, 'reset', 'stops at the last target');
    d.proxyFocus(2, true);
    assert.strictEqual(d.ui.focus, 'reset', 'single: the proxy focus does not move it');
    d.proxyPress(0);
    assert.strictEqual(actions.pop(), 'reset', 'the push presses what the dial chose');
    d.ui.focus = null;
    d.proxyPress(0);
    assert.strictEqual(d.ui.focus, 'tab:main', 'a push with nothing focused shows the focus');
    // a press on the list left showing brings the layer back
    d.hostFocus(false);
    d.hostVisible(false);
    await wait(SETTLE);
    assert.strictEqual(g.visible, false);
    d.proxyPress(0);
    assert.strictEqual(g.visible, true, 'a press on a proxy shows the layer');
    assert.ok(d.trace.length > 0 && d.trace.some((t) => /HMI versteckt/.test(t)), 'the trace keeps what happened');
    d.setSingle(false);
    d.ui.focus = null;

    // the renderer closed the layer (a touch reached the HMI): back at once while the host state is there
    assert.strictEqual(g.visible, true);
    g.emit('closed');
    assert.strictEqual(g.visible, false);
    await wait(5);
    assert.strictEqual(g.visible, true, 'shown again at once');

    // the renderer restarts (its connection drops): no list screen, reconnect soon, the layer back when it answers
    const modesHeard = [];
    d.on('mode', (m) => modesHeard.push(m));
    let reconnected = 0;
    g.retry = setTimeout(() => {}, 3000);
    g.connect = () => { reconnected++; };
    g.emit('close');
    assert.strictEqual(d.mode, 'layer', 'still the layer screen');
    await wait(400);
    assert.strictEqual(reconnected, 1, 'reconnected at once, not after 3 s');
    const claimsBefore = g.calls.filter((c) => c[0] === 'claim').length;
    const framesBefore = g.frames;
    g.emit('ready', { w: 2880, h: 960 }, { modes: ['layer'], appArea: { x: 0, y: 76, w: 2880, h: 764 } });
    await wait(5);
    g.emit('tick');
    assert.ok(g.calls.filter((c) => c[0] === 'claim').length > claimsBefore, 'claims again');
    assert.ok(g.frames > framesBefore, 'drawn again');
    assert.strictEqual(g.visible, true);
    assert.deepStrictEqual(modesHeard, [], 'never the list screen');
    assert.ok(d.trace.some((t) => /getrennt/.test(t)));

    // recording: the button's words follow it, and the app hears the new label
    let heard = null;
    d.on('targets', (t) => { heard = t; });
    d.setExtra({ recording: { ms: 83000 } });
    assert.strictEqual(heard.find((t) => t.id === 'record').label, 'Stopp 1:23');
    d.setExtra({ recording: null });
    assert.strictEqual(heard.find((t) => t.id === 'record').label, 'Aufnehmen');

    // the settings page: its targets for touch and proxies
    const told = [];
    d.on('targets', (t) => told.push(t.length));
    d.setPage('settings');
    assert.deepStrictEqual(told, [dash.targets('settings', d.extra).length]);
    const inc = dash.targets('settings').find((t) => t.id === 'inc:oilReady');
    g.emit('touch', 'down', ...center(inc));
    g.emit('touch', 'up', ...center(inc));
    assert.strictEqual(actions.pop(), 'inc:oilReady');
    d.proxyPress(dash.targets('settings', d.extra).findIndex((t) => t.id === 'defaults'));
    assert.strictEqual(actions.pop(), 'defaults');

    // a page change makes the HMI report hidden and unfocused for a moment: the layer stays
    d.hostVisible(false);
    d.hostFocus(false);
    await wait(100);
    d.hostVisible(true);
    await wait(SETTLE);
    assert.strictEqual(g.visible, true, 'a blink of the host state does not show the list');

    d.hostVisible(false);
    await wait(SETTLE);
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

    // the logbook: a recording sampled at most every 100 ms, read back for the list and the curves
    const Logbook = require('../src/logbook.js');
    const t0 = Date.UTC(2026, 10, 14, 10, 42, 0);
    const r = new Logbook.Recording(t0);
    for (let t = 0; t < 2000; t += 50) {
        r.sample({ rpm: 800 + t, boost: t / 2000, oil: 30 }, t0 + t);
    }
    assert.strictEqual(r.rows, 20, 'every 100 ms');
    r.stop();
    const list = Logbook.list();
    assert.strictEqual(list[0].name, '20261114-104200.csv');
    const sum = Logbook.summary(list[0].name);
    assert.strictEqual(sum.samples, 20);
    assert.strictEqual(sum.duration, 1900);
    assert.strictEqual(sum.peak.rpm, 2700);
    assert.strictEqual(sum.peak.torque, null, 'a field never given has no peak');
    assert.ok(sum.spark.length > 0);
    const loaded = Logbook.load(list[0].name);
    assert.strictEqual(loaded.series.oil[0], 30);
    assert.strictEqual(loaded.t.length, 20);
    // a full recording stops; an empty one leaves no file; only the newest 20 stay; names are checked
    const full = new Logbook.Recording(t0 + 60000);
    assert.strictEqual(full.sample({ rpm: 1 }, t0 + 60000 + Logbook.MAX_MS), false);
    full.stop();
    assert.strictEqual(Logbook.list().length, 1, 'the empty one is gone');
    for (let k = 0; k < 22; k++) {
        const x = new Logbook.Recording(t0 + 3600000 + k * 1000);
        x.sample({ rpm: k }, t0 + 3600000 + k * 1000);
        x.stop();
    }
    assert.strictEqual(Logbook.list().length, 20);
    Logbook.remove('../limits.json');
    assert.ok(fs.existsSync(path.join(process.env.KM_DATA_DIR, 'limits.json')), 'only recordings are removed');

    // the car's clock: the cluster shows 11:07 while UTC is 10:07 -> recordings named and shown at 11:07
    const clock = require('../src/clock.js');
    const utc = Date.UTC(2026, 10, 14, 10, 7, 30);
    assert.strictEqual(clock.setCluster({ statusDisplayClockTimeDate: 1, displayHour: 11, displayMinute: 7, displaySecond: 30 }, utc), true);
    assert.strictEqual(clock.offset(), 60);
    assert.strictEqual(clock.wall(utc).getUTCHours(), 11);
    assert.strictEqual(clock.setCluster({ statusDisplayClockTimeDate: 15 }, utc), false, 'unfilled: kept');
    assert.strictEqual(clock.setCluster({ statusDisplayClockTimeDate: 1, displayHour: 4, displayMinute: 7, displaySecond: 30 }, utc), true);
    assert.strictEqual(clock.offset(), -360, 'west of UTC');
    clock.setCluster({ statusDisplayClockTimeDate: 1, displayHour: 11, displayMinute: 7, displaySecond: 30 }, utc);
    const rc = new Logbook.Recording(utc);
    rc.sample({ rpm: 1 }, utc);
    assert.strictEqual(rc.name, '20261114-110730.csv');
    rc.stop();

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
    real.close();

    [d, other].forEach((x) => clearInterval(x.keepalive));
    console.log(`test_drawn: ok, ${g.frames} frames`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
