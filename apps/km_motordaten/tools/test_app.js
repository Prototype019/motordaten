'use strict';
/**
 * Runs src/motordaten.js on a fake head unit whose DME answers with the raw
 * replies read from the G87 M2 over ENET (docs/g87-s58.md, engine off), and
 * whose CDS signals give the engine speed; then with boost and a peak, the
 * peak reset, and hiding (no more questions) and showing again.
 *
 *   node tools/test_app.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const D = require('../src/decode.js');

const events = new EventEmitter();
const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
const bytes = (s) => s.split(' ').map((x) => parseInt(x, 16));

/* Measured on the car (engine off). */
const ANSWERS = {
    '22 44 02': '62 44 02 00 66', '22 43 00': '62 43 00 0C 4C', '22 58 0F': '62 58 0F 4B',
    '22 59 D4': '62 59 D4 2E AF', '22 42 05': '62 42 05 30 B7', '22 4A B0': '62 4A B0 61 80',
    '22 42 01': '62 42 01 61 84', '22 44 36': '62 44 36 03 ED', '01 42': '41 42 35 FC',
    '22 58 91': '62 58 91 00 07', '22 58 2F': '62 58 2F 17 E2', '22 4A BC': '62 4A BC 00 00', '22 58 13': '62 58 13 37',
    '22 54 25': '62 54 25 41', '22 55 4C': '62 55 4C 00', '22 4A 49': '62 4A 49 FF 38', '22 4A 4A': '62 4A 4A FF 38',
    '22 4A 4C': '62 4A 4C FF 38', '22 4A 4D': '62 4A 4D FF 38', '22 4A 4E': '62 4A 4E FF 38', '22 4A 4F': '62 4A 4F FF 38'
};
let asked = 0;
let silent = false;
const testers = new Set();
const keys = [];

function tasuProxy() {
    return {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        sendTasuResponse: { subscribe: (cb) => { events.on('r', cb); return Promise.resolve(); } },
        sendTasuRequest: (p) => {
            asked++;
            if (silent) {
                testers.add(p.sourceAddress);
                return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });     // the gateway drops it
            }
            const req = Array.from(p.udsData);
            const key = [p.serviceID].concat(req).map((x) => D.hex(x)).join(' ');
            keys.push(key);
            let a = ANSWERS[key];
            if (p.serviceID === 0x22 && req.length > 2) {
                // several identifiers: the DME answers those it has, one after the other, in one reply
                let body = [];
                for (let i = 0; i < req.length; i += 2) {
                    const one = ANSWERS[`22 ${D.hex(req[i])} ${D.hex(req[i + 1])}`];
                    if (one) {
                        body = body.concat(bytes(one).slice(1));
                    }
                }
                a = body.length ? ['62'].concat(body.map((x) => D.hex(x))).join(' ') : undefined;
            }
            if (a) {
                setTimeout(() => events.emit('r', frame(0x12, bytes(a))), 2);
            }
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
require('../src/motordaten.js');

const get = (l) => (unit.rows('mdList').find((r) => r[0] === l) || [])[1];

(async () => {
    await unit.wait(1500);
    assert.strictEqual(unit.opened, unit.uuid, 'entry state opened');
    assert.ok(cds.rpm, 'CDS subscribed');
    cds.rpm({ actualValueRPMEngineCrankshaft: 864 * 4 });
    await unit.wait(700);
    assert.strictEqual(get('Drehzahl'), '864 U/min · max 864');
    assert.strictEqual(get('Öltemperatur'), '29 °C');
    assert.strictEqual(get('Kühlmittel'), '42 °C');
    assert.strictEqual(get('Ansaugluft'), '8 °C');
    assert.strictEqual(get('Ladeluft'), undefined, 'charge air only in the recordings');
    assert.strictEqual(get('Ladedruck'), '-0.00 bar · max -0.00');
    assert.strictEqual(get('Öldruck'), '0.03 bar · max 0.03');
    assert.strictEqual(get('Bordspannung'), '13.8 V');
    assert.strictEqual(unit.props['mdStatus.Visible'], 0, 'no status while answers come');
    assert.deepStrictEqual(unit.status.slice(0, 2), ['registerActive', 'registerHmiVisible']);

    // boost under load: 2.10 bar above ambient, then back; the peak stays
    ANSWERS['22 42 05'] = `62 42 05 ${D.hex(Math.round(3075 / 0.078125) >> 8)} ${D.hex(Math.round(3075 / 0.078125) & 0xFF)}`;
    await unit.wait(500);
    assert.ok(/^2\.10 bar · max 2\.10$/.test(get('Ladedruck')), get('Ladedruck'));
    ANSWERS['22 42 05'] = '62 42 05 30 B7';
    cds.rpm({ actualValueRPMEngineCrankshaft: 6500 * 4 });
    await unit.wait(500);
    cds.rpm({ actualValueRPMEngineCrankshaft: 900 * 4 });
    await unit.wait(500);
    assert.ok(/^-0\.00 bar · max 2\.10$/.test(get('Ladedruck')), get('Ladedruck'));
    assert.strictEqual(get('Drehzahl'), '900 U/min · max 6500');

    // overrun: negative torque at the clutch shows as 0, and so does the power
    ANSWERS['22 58 91'] = '62 58 91 FF 38';          // -100 Nm
    await unit.wait(500);
    assert.ok(/^0 Nm/.test(get('Drehmoment')), get('Drehmoment'));
    assert.ok(/^0 PS/.test(get('Leistung')), get('Leistung'));
    ANSWERS['22 58 91'] = '62 58 91 00 07';

    // the DME silent for 3 s while driving: the tester that worked stays, the values are back at once after
    silent = true;
    await unit.wait(3000);
    silent = false;
    assert.deepStrictEqual(Array.from(testers), [0xF4], 'no switching away from the tester that answered');
    const t0 = Date.now();
    while (get('Öltemperatur') !== '29 °C' && Date.now() - t0 < 3000) {
        await unit.wait(50);
    }
    assert.ok(Date.now() - t0 < 1200, `values back after ${Date.now() - t0} ms`);

    // a tuned engine at full load: the DME reports the stock torque (masked), the air mass says what it makes
    ANSWERS['22 58 91'] = '62 58 91 03 E8';          // 500 Nm reported
    ANSWERS['22 4A BC'] = '62 4A BC 4E 20';          // 2000 kg/h of air
    ANSWERS['22 58 13'] = '62 58 13 C8';             // 150 % relative filling
    cds.rpm({ actualValueRPMEngineCrankshaft: 6500 * 4 });
    await unit.wait(500);
    const ps = Number(/^(\d+) PS/.exec(get('Leistung'))[1]);
    const nm = Number(/^(\d+) Nm/.exec(get('Drehmoment'))[1]);
    assert.ok(ps >= 690 && ps <= 702, `power from the air: ${get('Leistung')}`);
    assert.ok(nm >= 745 && nm <= 760, `torque from that power: ${get('Drehmoment')}`);
    // part load: the DME's own torque stands
    ANSWERS['22 58 91'] = '62 58 91 01 90';          // 200 Nm
    ANSWERS['22 4A BC'] = '62 4A BC 07 D0';          // 200 kg/h
    ANSWERS['22 58 13'] = '62 58 13 32';             // 37.5 %
    cds.rpm({ actualValueRPMEngineCrankshaft: 2500 * 4 });
    await unit.wait(500);
    assert.ok(/^200 Nm/.test(get('Drehmoment')), get('Drehmoment'));
    ANSWERS['22 58 91'] = '62 58 91 00 07';
    ANSWERS['22 4A BC'] = '62 4A BC 00 00';
    ANSWERS['22 58 13'] = '62 58 13 37';
    cds.rpm({ actualValueRPMEngineCrankshaft: 900 * 4 });
    await unit.wait(300);

    // the button resets the peaks
    unit.press('mdRun');
    await unit.wait(600);
    assert.strictEqual(get('Drehzahl'), '900 U/min · max 900');

    // hidden: no more questions to the DME; shown again: they go on
    unit.rhmi.emit('applicationStackChanged', { SOME_OTHER_APP: 1 });
    await unit.wait(400);
    const before = asked;
    await unit.wait(600);
    assert.strictEqual(asked, before, 'no questions while hidden');
    assert.deepStrictEqual(unit.status.slice(-2), ['unregisterHmiVisible', 'registerInactive']);
    unit.rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
    await unit.wait(400);
    assert.ok(asked > before, 'questions again when shown');

    // what the engine does is read only while recording
    assert.ok(!keys.some((k) => / 58 89| 56 58| 4A D5/.test(k)), 'no engine values asked without a recording');

    console.log(`test_app (motordaten): ok, ${asked} questions`);
    realExit(0);
})().catch((e) => { console.error(e, unit.log.slice(-8), unit.rows('mdList')); realExit(1); });
