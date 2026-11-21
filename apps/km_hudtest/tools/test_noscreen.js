'use strict';
/**
 * The HUD app started without screens (as the head unit may start an app by itself: package.json
 * mguAppStartType autostart): it runs all the same, reads the car's signal and draws on the HUD.
 *
 *   node apps/km_hudtest/tools/test_noscreen.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-noscreen-'));
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

server.listen(process.env.KM_CR_SOCKET, () => {
    const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'), require('../package/rhmiData/application.json'), {
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu, 'de.bmw.infotainment.vehicle.CDS': cdsProxy });
    const realExit = process.exit;
    process.exit = () => {};
    let app = null;
    const { ListApp } = require('../src/screen.js');
    const start = ListApp.prototype.start;
    // the platform made no screens for this start
    ListApp.prototype.start = function () { app = this; this.rhmiApplication = null; return start.apply(this, arguments); };
    require('../src/hudtest.js');
    (async () => {
        assert.strictEqual(require('../package/package.json').mguAppStartType, 'autostart', 'the HUD app starts with the head unit');
        await unit.wait(1200);
        assert.ok(app && app._started, 'run without screens');
        assert.strictEqual(app._drawn, null, 'no drawn screens');
        cds.emit('t', { temperatureEngineOilDrive: 40 + 48, temperatureEngineDrive: 50 + 48 });
        await unit.wait(1500);
        assert.strictEqual(service.layers.length, 1, 'the HUD layer made');
        assert.ok(service.frames >= 1, 'drawn');
        const vis = service.sets.filter((x) => 'visible' in x);
        assert.strictEqual(vis[vis.length - 1].visible, 1, 'shown while warming up');
        console.log('test_noscreen: ok');
        realExit(0);
    })().catch((e) => { console.error(e); realExit(1); });
});
