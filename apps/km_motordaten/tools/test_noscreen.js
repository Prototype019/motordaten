'use strict';
/**
 * Motordaten started without screens (as the head unit may start an app by itself: package.json mguAppStartType
 * autostart): it runs all the same without an error, follows the engine from the car's signal, reads nothing from
 * the DME in the background, and at the engine start notes that it has no tile to open instead of failing.
 *
 *   node apps/km_motordaten/tools/test_noscreen.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-md-noscreen-'));
process.env.KM_DATA_DIR = dir;

const cds = new EventEmitter();
function cdsProxy() {
    const f = (n) => ({ subscribe: (cb) => { cds.on(n, cb); return Promise.resolve(); } });
    return { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        statusEngineSpeed2: f('rpm'), statusEngineTemperature: f('t') };
}
let requests = 0;
const tasu = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    sendTasuResponse: { subscribe: () => Promise.resolve() },
    sendTasuRequest: () => { requests++; return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' }); } });
const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'), require('../package/rhmiData/application.json'), {
    'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu,
    'de.bmw.infotainment.vehicle.CDS': cdsProxy
});
const realExit = process.exit;
process.exit = () => {};
let app = null;
const { ListApp } = require('../src/screen.js');
const start = ListApp.prototype.start;
// the platform made no screens for this start
ListApp.prototype.start = function () { app = this; this.rhmiApplication = null; return start.apply(this, arguments); };
require('../src/motordaten.js');

const diag = () => new Promise((resolve) => require('../src/diag.js').flush(() => {
    try { resolve(fs.readFileSync(path.join(dir, 'diag.log'), 'utf8')); } catch (e) { resolve(''); }
}));

(async () => {
    assert.strictEqual(require('../package/package.json').mguAppStartType, 'autostart', 'starts with the head unit');
    await unit.wait(1500);
    assert.ok(app && app._started, 'runs without screens');
    cds.emit('t', { temperatureEngineOilDrive: 40 + 48, temperatureEngineDrive: 50 + 48 });
    cds.emit('rpm', { actualValueRPMEngineCrankshaft: 0 });
    await unit.wait(200);
    cds.emit('rpm', { actualValueRPMEngineCrankshaft: 900 * 4 });
    await unit.wait(4000);
    assert.strictEqual(app._engineOn, true, 'follows the engine');
    assert.ok(!unit.opened, 'nothing to open');
    assert.strictEqual(requests, 0, 'no DME requests in the background');
    const log = await diag();
    assert.ok(/Läuft: ohne Bildschirme, Kachel fehlt/.test(log), 'the start noted: ' + log);
    assert.ok(/Motorstart: keine Kachel/.test(log), 'the engine start noted');
    assert.ok(!/Fehler abgefangen|Promise abgelehnt/.test(log), 'no error: ' + log);
    console.log('test_noscreen (motordaten): ok');
    realExit(0);
})().catch((e) => { console.error(e); realExit(1); });
