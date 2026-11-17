'use strict';
/**
 * MHD's exhaust flap in src/motordaten.js on a fake head unit whose DME echoes 2F 02 nn as MHD does:
 * nothing goes out while the setting is off (its default); the button goes Auto -> Auf -> Zu -> Auto;
 * Zu is handed to the DME (2F 02 00) above 4,000 rpm and closed again under 3,500; a flap held shut
 * keeps the rounds going while the app is hidden; switching the setting off hands a held flap back.
 *
 *   node tools/test_flap.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const D = require('../src/decode.js');

// the settings (limits.json) in a folder of its own: the flap's switch starts off
process.env.KM_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'km-flap-'));

const events = new EventEmitter();
const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
const bytes = (s) => s.split(' ').map((x) => parseInt(x, 16));

const ANSWERS = {
    '22 44 02': '62 44 02 00 66', '22 43 00': '62 43 00 0C 4C', '22 44 36': '62 44 36 03 ED', '22 42 01': '62 42 01 61 84',
    '2F 02 00': '6F 02 00', '2F 02 01': '6F 02 01', '2F 02 02': '6F 02 02'
};
let asked = 0;
const writes = [];
const DELAY = {};                 // ms a reply takes, by request

function tasuProxy() {
    return {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        sendTasuResponse: { subscribe: (cb) => { events.on('r', cb); return Promise.resolve(); } },
        sendTasuRequest: (p) => {
            asked++;
            const req = Array.from(p.udsData);
            const key = [p.serviceID].concat(req).map((x) => D.hex(x)).join(' ');
            if (p.serviceID !== 0x22 && p.serviceID !== 0x01 && p.serviceID !== 0x19) {
                writes.push(`${key} -> ${D.hex(p.targetAddress)}`);
            }
            let a = ANSWERS[key];
            if (p.serviceID === 0x22 && req.length > 2) {
                let body = [];
                for (let i = 0; i < req.length; i += 2) {
                    const one = ANSWERS[`22 ${D.hex(req[i])} ${D.hex(req[i + 1])}`];
                    if (one) body = body.concat(bytes(one).slice(1));
                }
                a = body.length ? ['62'].concat(body.map((x) => D.hex(x))).join(' ') : undefined;
            }
            if (a) setTimeout(() => events.emit('r', frame(0x12, bytes(a))), DELAY[key] || 2);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        }
    };
}
const cds = {};
function cdsProxy() {
    const field = (n) => ({ subscribe: (cb) => { cds[n] = cb; return Promise.resolve(); } });
    return { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        statusEngineSpeed2: field('rpm'), statusEngineTemperature: field('temps') };
}

const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'),
    require('../package/rhmiData/application.json'), {
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasuProxy,
        'de.bmw.infotainment.vehicle.CDS': cdsProxy
    });
const realExit = process.exit;
process.exit = () => {};
const { Tasu } = require('../src/tasu.js');
const orig = Tasu.prototype.request;
Tasu.prototype.request = function (sid, data) { return orig.call(this, sid, data, 100); };
// the app itself, to press its buttons as the drawn screens would (_action)
let app = null;
const { ListApp } = require('../src/screen.js');
const start = ListApp.prototype.start;
ListApp.prototype.start = function () { app = this; return start.apply(this, arguments); };
require('../src/motordaten.js');

const rpm = (n) => cds.rpm({ actualValueRPMEngineCrankshaft: n * 4 });

(async () => {
    await unit.wait(1500);
    assert.ok(app, 'the app');
    rpm(900);
    await unit.wait(500);

    // off (the default): no button, nothing sent
    assert.strictEqual(app._limits.mhdFlapOn, 0);
    app._action('flap');
    await unit.wait(300);
    assert.deepStrictEqual(writes, [], 'nothing while switched off');

    // on: Auto -> Auf -> Zu -> Auto
    app._action('toggle:mhdFlapOn');
    assert.strictEqual(app._limits.mhdFlapOn, 1);
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'OPEN');
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'CLOSED');
    assert.deepStrictEqual(writes, ['2F 02 01 -> 12', '2F 02 02 -> 12']);

    // Zu above 4,000 rpm: to the DME; back under 3,500: shut again; between: as it is
    rpm(4500);
    await unit.wait(500);
    assert.strictEqual(writes[writes.length - 1], '2F 02 00 -> 12');
    assert.ok(app._flap.paused && app._flap.state === 'CLOSED');
    rpm(3800);
    await unit.wait(500);
    assert.strictEqual(writes.length, 3, 'between the limits: nothing');
    rpm(3000);
    await unit.wait(500);
    assert.strictEqual(writes[writes.length - 1], '2F 02 02 -> 12');
    assert.ok(!app._flap.paused);

    // hidden with the flap shut: the rounds go on (the limit needs the engine speed)
    unit.rhmi.emit('applicationStackChanged', { SOME_OTHER_APP: 1 });
    await unit.wait(400);
    const before = asked;
    await unit.wait(800);
    assert.ok(asked > before, 'still asking while hidden with the flap shut');
    rpm(4600);
    await unit.wait(500);
    assert.strictEqual(writes[writes.length - 1], '2F 02 00 -> 12', 'the limit works while hidden');
    rpm(900);
    await unit.wait(500);
    unit.rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
    await unit.wait(400);

    // the press after Zu: Auto
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'AUTO');
    assert.strictEqual(writes[writes.length - 1], '2F 02 00 -> 12');

    // switched off while it holds the flap open: handed back to the DME
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'OPEN');
    const n = writes.length;
    app._action('toggle:mhdFlapOn');
    await unit.wait(400);
    assert.strictEqual(writes.length, n + 1);
    assert.strictEqual(writes[n], '2F 02 00 -> 12');
    assert.strictEqual(app._flap.state, 'AUTO');

    // an untuned DME: no echo, the state stays
    app._action('toggle:mhdFlapOn');
    ANSWERS['2F 02 01'] = '7F 2F 31';
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'AUTO');

    ANSWERS['2F 02 01'] = '6F 02 01';
    await unit.wait(1200);                                   // past the retry pause

    // switched off while a command is on its way: once its echo comes, the flap goes back to the DME
    DELAY['2F 02 01'] = 1000;                                // the DME echoes Auf after a second
    app._action('flap');                                     // Auto -> Auf, on its way
    await unit.wait(150);
    assert.ok(app._flap.busy);
    const m = writes.length;
    app._action('toggle:mhdFlapOn');                         // off while busy: nothing can go out yet
    assert.strictEqual(writes.length, m);
    await unit.wait(1800);
    delete DELAY['2F 02 01'];
    assert.strictEqual(app._limits.mhdFlapOn, 0);
    assert.deepStrictEqual(writes.slice(m), ['2F 02 00 -> 12'], 'handed back after the echo');
    assert.strictEqual(app._flap.state, 'AUTO');

    // Zu with no engine speed (the signal gone, the DME silent): handed to the DME after 2 s, shut again once known
    app._action('toggle:mhdFlapOn');
    app._action('flap');
    await unit.wait(400);
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'CLOSED');
    assert.ok(!app._flap.paused);
    cds.rpm({ actualValueRPMEngineCrankshaft: 65535 });      // no value
    await unit.wait(1200);
    assert.ok(!app._flap.paused, 'not at once');
    await unit.wait(1800);
    assert.ok(app._flap.paused, 'handed to the DME without an engine speed');
    assert.strictEqual(writes[writes.length - 1], '2F 02 00 -> 12');
    rpm(900);
    await unit.wait(500);
    assert.ok(!app._flap.paused);
    assert.strictEqual(writes[writes.length - 1], '2F 02 02 -> 12');

    // switched off while the DME no longer answers: a few tries to hand it back, then given up (no endless sending)
    app._action('flap');                                     // Zu -> Auto
    await unit.wait(400);
    app._action('flap');                                     // Auto -> Auf
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'OPEN');
    const back = ANSWERS['2F 02 00'];
    delete ANSWERS['2F 02 00'];
    const g = writes.length;
    app._action('toggle:mhdFlapOn');
    await unit.wait(18000);
    const tries = writes.slice(g).length;
    assert.ok(tries >= 3 && tries <= 5, `tries: ${tries}`);
    assert.strictEqual(app._flap.state, 'AUTO', 'given up');
    await unit.wait(4000);
    assert.strictEqual(writes.length - g, tries, 'and then nothing more');
    ANSWERS['2F 02 00'] = back;
    app._action('toggle:mhdFlapOn');
    app._action('flap');
    await unit.wait(400);
    app._action('flap');
    await unit.wait(400);
    assert.strictEqual(app._flap.state, 'CLOSED');

    // the app stopped with the flap held: back to the DME
    const k = writes.length;
    app.stop();
    await unit.wait(300);
    assert.deepStrictEqual(writes.slice(k), ['2F 02 00 -> 12']);

    // never anything but the flap's three commands to the DME
    assert.ok(writes.every((w) => /^2F 02 0[012] -> 12$/.test(w)), writes.join(', '));
    console.log(`test_flap: ok (${writes.length} commands)`);
    realExit(0);
})().catch((e) => { console.error(e, writes, unit.log.slice(-8)); realExit(1); });
