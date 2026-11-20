'use strict';
/**
 * The HUD app's screens through src/drawn.js against a fake renderer, as the finger reaches them in the car:
 * tabs, a tap on a value card (an action), a card held and dragged on the Werte page ('order' with the new
 * order and its key), a hold elsewhere lifting nothing, and the controller's proxy buttons for every target.
 *
 *   node apps/km_hudtest/tools/test_drawn.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const { Drawn } = require('../src/drawn.js');
const dash = require('../src/dash.js');
const S = require('../src/settings.js');
const spec = require('../spec.js');

const log = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeGpu() {
    const g = new EventEmitter();
    Object.assign(g, { calls: [], frames: 0, visible: false,
        connect() {}, close() {}, mode(m) { g.calls.push(['mode', m]); }, place(p) { g.calls.push(['place', p]); },
        claim(r) { g.calls.push(['claim', r]); }, show(on) { g.visible = on; }, frame(rec) { assert.ok(rec.words().length > 100); g.frames++; } });
    return g;
}
const center = (t) => [t.x + t.w / 2, t.y + t.h / 2];

(async () => {
    assert.strictEqual(spec.PROXIES, Number(/const PROXIES = (\d+)/.exec(require('fs').readFileSync(require.resolve('../src/hudtest.js'), 'utf8'))[1]),
        'hudtest.js knows the proxy count');
    const g = fakeGpu();
    const d = new Drawn('km_hudtest', log, g);
    const cfg = S.defaults();
    d.setLimits(cfg);
    d.setExtra({ order: S.cleanOrder(cfg.order), count: cfg.count, mode: cfg.mode });
    g.emit('ready', { w: 2880, h: 960 }, { modes: ['layer'], appArea: { x: 0, y: 76, w: 2880, h: 764 } });
    d.hostVisible(true);
    d.set({ oil: 50, coolant: 60 });
    assert.ok(g.frames > 0, 'drawn');
    const actions = [];
    const orders = [];
    d.on('action', (id) => actions.push(id));
    d.on('order', (o, key) => orders.push([o, key]));
    const touch = (phase, x, y) => g.emit('touch', phase, x, y);

    // the tab
    const tab = dash.targets('main').find((t) => t.id === 'tab:values');
    touch('down', ...center(tab));
    touch('up', ...center(tab));
    assert.deepStrictEqual(actions, ['tab:values']);
    d.setPage('values');
    const targets = dash.targets('values', d.extra);
    assert.ok(targets.length <= spec.PROXIES);

    // a tap on a card: its action
    const boost = targets.find((t) => t.id === 'cell:boost');
    touch('down', ...center(boost));
    touch('up', ...center(boost));
    assert.strictEqual(actions.pop(), 'cell:boost', 'tapped');

    // held, then dragged to the front: lifted, no press, the order with boost first
    touch('down', ...center(boost));
    await wait(500);
    assert.strictEqual(d.ui.drag && d.ui.drag.key, 'boost', 'held: lifted');
    assert.strictEqual(d.ui.pressed, null, 'lifted: no press shown');
    const first = targets.find((t) => t.id === 'cell:oil');
    touch('move', center(first)[0] - 40, center(first)[1]);
    touch('up', center(first)[0] - 40, center(first)[1]);
    assert.strictEqual(actions.length, 1, 'a drag is no tap');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0][1], 'boost');
    assert.deepStrictEqual(orders[0][0].slice(0, 2), ['boost', 'oil'], 'dropped at the front');
    assert.deepStrictEqual(S.shown(S.dropped(cfg, orders[0][0], orders[0][1])), ['boost', 'oil'], 'in the HUD now, with the oil');

    // held on the page but not on a card: nothing lifts
    touch('down', 1500, 700);
    await wait(500);
    assert.ok(!d.ui.drag, 'no card there');
    touch('up', 1500, 700);

    // other pages: no drag
    d.setPage('ready');
    const sw = dash.targets('ready').find((t) => t.id === 'toggle:oilReadyOn');
    touch('down', ...center(sw));
    await wait(500);
    assert.ok(!d.ui.drag, 'nothing drags on Bereit');
    touch('up', ...center(sw));
    assert.strictEqual(actions.pop(), 'toggle:oilReadyOn', 'a held switch is still a press');

    // the controller: a proxy per target, pressing the focused one
    d.setPage('values');
    const idx = dash.targets('values', d.extra).findIndex((t) => t.id === 'cell:rpm');
    d.proxyFocus(idx, true);
    assert.strictEqual(d.ui.focus, 'cell:rpm');
    d.proxyPress(idx);
    assert.strictEqual(actions.pop(), 'cell:rpm', 'the controller presses a card');

    console.log(`test_drawn: ok, ${g.frames} frames`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
