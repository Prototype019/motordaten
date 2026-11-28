'use strict';
/**
 * Opening by itself at the engine start (Einstellungen › Start, src/motordaten.js _engineWatch / _autoOpen) on a
 * fake head unit with the car's engine speed signal: the first start opens the app (its tile's entry state), a
 * restart soon after (auto start-stop) does not, a start after the engine was off for AUTO_OPEN_OFF_MS does
 * again; not when the app is in front already, nor with the setting off.
 *
 *   node tools/test_start.js
 */
const assert = require('assert');
const EventEmitter = require('events');

process.env.KM_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'km-start-'));
const cds = new EventEmitter();
function cdsProxy() {
    const f = (n) => ({ subscribe: (cb) => { cds.on(n, cb); return Promise.resolve(); } });
    return { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        statusEngineSpeed2: f('rpm'), statusEngineTemperature: f('t') };
}
const tasu = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    sendTasuResponse: { subscribe: () => Promise.resolve() }, sendTasuRequest: () => Promise.resolve({ TasuErrorEnum: 'NO_ERROR' }) });
const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'), require('../package/rhmiData/application.json'), {
    'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu,
    'de.bmw.infotainment.vehicle.CDS': cdsProxy
});
const realExit = process.exit;
process.exit = () => {};
let app = null;
const { ListApp } = require('../src/screen.js');
const start = ListApp.prototype.start;
ListApp.prototype.start = function () { app = this; return start.apply(this, arguments); };
require('../src/motordaten.js');

let clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;
const rpm = (n) => cds.emit('rpm', { actualValueRPMEngineCrankshaft: n * 4 });
const away = () => unit.rhmi.emit('applicationStackChanged', { SOME_OTHER_APP: 1 });

(async () => {
    // started with the head unit, so it is running when the engine starts (the HUD app showed autostart works)
    assert.strictEqual(require('../package/package.json').mguAppStartType, 'autostart', 'starts with the head unit');
    await unit.wait(1500);
    assert.ok(app);
    assert.strictEqual(app._limits.autoOpenOn, 1, 'on by default');
    away();                                 // the app not in front (as after the head unit started it)
    await unit.wait(100);
    unit.opened = undefined;

    // ignition on, then the engine starts: the app opens
    rpm(0);
    rpm(850);
    await unit.wait(100);
    assert.strictEqual(unit.opened, unit.uuid, 'opened at the start');

    // the auto start-stop: off at the lights, on again a minute later: nothing
    away();
    await unit.wait(100);
    unit.opened = undefined;
    rpm(0);
    clock += 60 * 1000;
    rpm(900);
    await unit.wait(100);
    assert.strictEqual(unit.opened, undefined, 'a restart soon after: not again');

    // parked for ten minutes, a new drive: opens again
    rpm(0);
    clock += 10 * 60 * 1000;
    rpm(870);
    await unit.wait(100);
    assert.strictEqual(unit.opened, unit.uuid, 'a new drive: again');

    // in front already: nothing to open
    unit.opened = undefined;
    unit.rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
    await unit.wait(100);
    rpm(0);
    clock += 10 * 60 * 1000;
    rpm(870);
    await unit.wait(100);
    assert.strictEqual(unit.opened, undefined, 'in front: nothing');

    // switched off: never
    away();
    await unit.wait(100);
    app._action('toggle:autoOpenOn');
    assert.strictEqual(app._limits.autoOpenOn, 0);
    rpm(0);
    clock += 10 * 60 * 1000;
    rpm(870);
    await unit.wait(100);
    assert.strictEqual(unit.opened, undefined, 'off: never');
    // no value (65535) changes nothing
    cds.emit('rpm', { actualValueRPMEngineCrankshaft: 65535 });
    assert.strictEqual(app._engineOn, true);

    // the App page: its targets, and the temperature cells' order back to the start
    const dash = require('../src/dash.js');
    assert.deepStrictEqual(dash.targets('app').slice(5).map((t) => t.id), ['toggle:autoOpenOn', 'order:reset', 'page:github', 'settings:back']);
    app._setLimits(Object.assign({}, app._limits, { tempOrder: ['gearbox', 'intake', 'coolant'] }));
    app._action('order:reset');
    assert.deepStrictEqual(app._limits.tempOrder, ['coolant', 'intake', 'gearbox'], 'order back to the start');
    // the settings list: every row on the screen, each with a summary, none overlapping
    const rows = dash.targets('settings').filter((t) => /^menu:/.test(t.id));
    rows.forEach((r, i) => {
        assert.ok(r.y + r.h <= dash.H && r.h >= 84, `${r.id} on the screen, large enough`);
        if (i) assert.ok(r.y >= rows[i - 1].y + rows[i - 1].h, `${r.id} under the one before`);
    });
    dash.draw(new (require('../src/kit_record.js').Recorder)(dash.W, dash.H), 'settings', {}, app._limits, null, {});
    dash.draw(new (require('../src/kit_record.js').Recorder)(dash.W, dash.H), 'app', {}, app._limits, null, {});
    // M-Tasten: opened from the menu, a press keeps the choice; the car's side is not connected, nothing is sent
    app._action('menu:mkeys');
    app._action('pick:m1Mode:2');
    app._action('pick:m2Mode:1');
    assert.strictEqual(app._limits.m1Mode, 2);
    assert.strictEqual(app._limits.m2Mode, 1);
    assert.deepStrictEqual(app._mmode._pick(), {}, 'switched off: nothing for either button');
    app._action('toggle:mkeysOn');
    assert.deepStrictEqual(app._mmode._pick(), { m1: 'sport', m2: 'road' });
    app._action('toggle:mkeysOn');
    app._action('pick:m1Mode:0');
    app._action('pick:m2Mode:0');
    // the M test without MDrive in the car (the fake has none): refused with a word, nothing sent
    app._action('mkeys:test');
    setImmediate(() => assert.ok(app._mdrive.result && /nicht erreichbar/.test(app._mdrive.result.text), 'M test refused without MDrive'));
    app._action('settings:back');

    // the app (re)started mid-drive, the engine running at its first value: not over the navigation
    const realUptime = process.uptime;
    app._engineOn = undefined;
    app._limits.autoOpenOn = 1;
    away();
    await unit.wait(100);
    unit.opened = undefined;
    process.uptime = () => 600;
    rpm(2500);
    await unit.wait(100);
    assert.strictEqual(unit.opened, undefined, 'restarted mid-drive: not opened');
    // ... but with the head unit just up and the engine already running: opened
    app._engineOn = undefined;
    process.uptime = () => 20;
    rpm(900);
    await unit.wait(100);
    assert.strictEqual(unit.opened, unit.uuid, 'head unit just up: opened');
    process.uptime = realUptime;

    Date.now = realNow;
    console.log('test_start: ok');
    realExit(0);
})().catch((e) => { console.error(e); realExit(1); });
