'use strict';
/**
 * Runs src/motordaten.js against a fake oap-sdk: start, entry point, CDS
 * values, and checks what the screen gets written.
 *
 *   node tools/test_app.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const spec = require('../spec.js');

const writes = {};
const props = {};
const subs = {};
let opened = null;

const names = new Set();
spec.states.forEach((s) => { names.add(s.name); s.components.forEach((c) => names.add(c.name)); });

function component(name) {
    return {
        setValue: (row, cell, value) => { writes[`${name}.${cell}`] = value; return Promise.resolve(); },
        setProperty: (p, v) => { props[`${name}.${p}`] = v; return Promise.resolve(); }
    };
}

const rhmi = Object.assign(new EventEmitter(), {
    getByName: (n) => (names.has(n) ? component(n) : null),
    mapEntryState: () => Promise.resolve(),
    openEntryState: (uuid) => { opened = uuid; return Promise.resolve(); }
});

const appJson = require('../package/rhmiData/application.json');
const UUID = appJson.application.entryPoints[0].uuid;

class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this.rhmiApplication = rhmi;
        this.appDescription = appJson;
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    initialized() { return Promise.resolve(); }
    getAppId() { return 'km_motordaten'; }
    getEntryPoints() {
        return [{ getDescription: () => ({ uuid: UUID, name: 'km_motordaten' }), init: () => Promise.resolve(),
            setAvailability: () => Promise.resolve() }];
    }
    getLastExecutedEntryPointUuid() { return UUID; }
    destroyBundles() { return Promise.resolve(); }
}

const field = (n) => ({ subscribe: (cb) => { subs[n] = cb; return Promise.resolve(); } });
const fakes = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => ({ info() {}, warn() {}, error: (m) => console.error(m) }) },
    'oap-sdk/src/someip/someipBuilders': {
        buildTypedProxy: (iface) => {
            assert.strictEqual(iface, 'de.bmw.infotainment.vehicle.CDS');
            return Promise.resolve({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
                statusEngineSpeed2: field('rpm'), statusEngineTemperature: field('temps') });
        }
    }
};
const load = Module._load;
Module._load = function (req, ...rest) {
    return Object.prototype.hasOwnProperty.call(fakes, req) ? fakes[req] : load.call(this, req, ...rest);
};

const realExit = process.exit;
process.exit = () => {};
require(path.join(__dirname, '..', 'src', 'motordaten.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await wait(50);
    assert.strictEqual(opened, UUID, 'entry state opened');
    assert.ok(subs.rpm && subs.temps, 'CDS subscribed');
    assert.strictEqual(writes['mdStatus.Text'], 'Verbunden – Zündung an für Werte');
    assert.strictEqual(writes['mdRpm.FrequencyText'], '–');

    subs.rpm({ actualValueRPMEngineCrankshaft: 3500 * 4 });
    subs.temps({ temperatureEngineOilDrive: 98 + 48, temperatureEngineDrive: 90 + 48 });
    await wait(300);
    assert.strictEqual(writes['mdRpm.FrequencyText'], '3500 U/min');
    assert.strictEqual(writes['mdOil.FrequencyText'], '98 °C');
    assert.strictEqual(writes['mdCoolant.FrequencyText'], '90 °C');
    assert.strictEqual(props['mdStatus.Visible'], 0, 'status hidden once data flows');

    subs.rpm({ actualValueRPMEngineCrankshaft: 65535 });
    subs.temps({ temperatureEngineOilDrive: 255, temperatureEngineDrive: 255 });
    await wait(300);
    assert.strictEqual(writes['mdRpm.FrequencyText'], '–', 'invalid rpm');
    assert.strictEqual(writes['mdOil.FrequencyText'], '–', 'invalid temp');

    console.log('test_app: ok');
    realExit(0);
})().catch((e) => { console.error(e); realExit(1); });
