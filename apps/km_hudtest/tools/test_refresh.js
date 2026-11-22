'use strict';
/**
 * Gerade halten (settings refresh): the G87's HUD keeps our picture slanted after harder braking until it is handed
 * over anew. From the car's speed (Vehicle2) and braking (CDS2) signals: a moment after harder braking and at a stop
 * after driving, the picture goes away for REFRESH_HIDE_MS (the renderer gives the HUD back) and comes again; at most
 * every REFRESH_GAP_MS; never with the setting off; noted in diag.log.
 *
 *   node apps/km_hudtest/tools/test_refresh.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-refresh-'));
process.env.KM_CR_SOCKET = path.join(dir, 'render.sock');
process.env.KM_DATA_DIR = dir;

const service = { layers: [], sets: [], frames: 0 };
const send = (sock, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(5);
    head.writeUInt32LE(body.length + 1, 0);
    head[4] = 0x4a;
    sock.write(Buffer.concat([head, body]));
};
const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) break;
            const type = buf[4];
            const body = buf.slice(5, 4 + len);
            buf = buf.slice(4 + len);
            if (type !== 0x4a) { service.frames++; continue; }
            const m = JSON.parse(body.toString());
            if (m.op === 'hello') send(sock, { ev: 'hello', proto: 1, backend: 'id8', targets: 'hud:353x203' });
            if (m.op === 'layer') service.layers.push(m);
            if (m.op === 'set') service.sets.push(m);
        }
    });
});

const cds = new EventEmitter();
const cdsProxy = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    statusEngineTemperature: { subscribe: (cb) => { cds.on('t', cb); return Promise.resolve(); } },
    statusEngineSpeed2: { subscribe: () => Promise.resolve() } });
const tasu = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    sendTasuResponse: { subscribe: () => Promise.resolve() }, sendTasuRequest: () => Promise.resolve({ TasuErrorEnum: 'NO_ERROR' }) });


const veh = new EventEmitter();
const vehProxy = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    statusCarSpeed2: { subscribe: (cb) => { veh.on('speed', cb); return Promise.resolve(); } } });
const cds2Proxy = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    statusLongitudinalAccelerationMassCenter: { subscribe: (cb) => { veh.on('accel', cb); return Promise.resolve(); } } });
const kmh = (v) => veh.emit('speed', { speedVehicleCentreOfGravity: Math.round(v / 0.015625) });
const ms2 = (a) => veh.emit('accel', { longitudinalAccelerationCentreOfGravity: Math.round((a + 65) / 0.002) });

server.listen(process.env.KM_CR_SOCKET, () => {
    const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'), require('../package/rhmiData/application.json'), {
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu, 'de.bmw.infotainment.vehicle.CDS': cdsProxy,
        'de.bmw.infotainment.vehicle.Vehicle2': vehProxy, 'de.bmw.infotainment.vehicle.CDS2': cds2Proxy });
    const realExit = process.exit;
    process.exit = () => {};
    let app = null;
    const { ListApp } = require('../src/screen.js');
    const start = ListApp.prototype.start;
    ListApp.prototype.start = function () { app = this; return start.apply(this, arguments); };
    require('../src/hudtest.js');
    const visible = () => { const v = service.sets.filter((x) => 'visible' in x); return v.length ? v[v.length - 1].visible : null; };
    const hides = () => service.sets.filter((x) => x.visible === 0).length;
    (async () => {
        await unit.wait(1200);
        assert.ok(app && app._started);
        assert.strictEqual(app._settings.refresh, 'auto', 'on by default');
        cds.emit('t', { temperatureEngineOilDrive: 40 + 48, temperatureEngineDrive: 50 + 48 });
        await unit.wait(1200);
        assert.strictEqual(visible(), 1, 'shown (warming up)');
        const before = hides();
        // driving, then braking hard: a moment after, the picture away and back
        kmh(50); ms2(-0.5);
        await unit.wait(300);
        ms2(-6); await unit.wait(200); ms2(-1);
        await unit.wait(2000);
        assert.strictEqual(hides(), before, 'not while braking');
        await unit.wait(1500);
        assert.strictEqual(visible(), 0, 'away a moment after the braking');
        await unit.wait(4500);
        assert.strictEqual(visible(), 1, 'back');
        // a stop right after: not again within REFRESH_GAP_MS
        kmh(0);
        await unit.wait(2500);
        assert.strictEqual(hides(), before + 1, 'not twice within 20 s');
        // later, the next stop after driving: again
        app._refresh.last -= 20000;
        kmh(40); await unit.wait(200); kmh(0);
        await unit.wait(2500);
        assert.strictEqual(visible(), 0, 'away at the stop');
        await unit.wait(4500);
        assert.strictEqual(visible(), 1, 'back');
        // setting off: nothing
        app._refresh.last -= 20000;
        app._set(Object.assign({}, app._settings, { refresh: 'off' }));
        const n = hides();
        kmh(40); await unit.wait(200); ms2(-6); await unit.wait(200); ms2(0); kmh(0);
        await unit.wait(5000);
        assert.strictEqual(hides(), n, 'off: never');
        await new Promise((r) => require('../src/diag.js').flush(r));
        const log = fs.readFileSync(path.join(dir, 'diag.log'), 'utf8');
        assert.ok(/starkes Bremsen \(-6\.0/.test(log) && /neu übergeben \(Bremsen\)/.test(log) && /neu übergeben \(Halt\)/.test(log), log);
        console.log('test_refresh: ok');
        realExit(0);
    })().catch((e) => { console.error(e); realExit(1); });
});
