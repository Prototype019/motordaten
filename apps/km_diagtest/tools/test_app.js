'use strict';
/**
 * Runs src/diagtest.js on a fake head unit whose diagnostic gateway answers
 * like a DME8FF_R engine unit, and checks the rows it shows, the decoding
 * and that nothing but reads reaches the gateway.
 *
 *   node tools/test_app.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const D = require('../src/decode.js');

const sent = [];
const events = new EventEmitter();

/* A frame as the gateway sends it: 9-byte header, [6] = the answering unit. */
const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });

const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const DME_ANSWERS = {
    '22 F1 50': [0x62, 0xF1, 0x50, 0x0F, 0x24, 0x22],
    '22 44 02': [0x62, 0x44, 0x02].concat(be16(Math.round((98 + 48) / 0.75))),          // 98 °C
    '22 58 0F': [0x62, 0x58, 0x0F, Math.round((35 + 48) / 0.75)],                        // ~35 °C
    '22 42 05': [0x62, 0x42, 0x05].concat(be16(Math.round(2100 / 0.078125))),           // 2.10 bar
    '22 43 00': [0x7F, 0x22, 0x31],                                                      // not there
    '01 00': [0x41, 0x00, 0x18, 0x3B, 0x80, 0x11],                                       // 04 05 0B 0C 0D 0F 10 11 ...
    '01 0F': [0x41, 0x0F, 75],                                                           // 35 °C
    '01 42': [0x41, 0x42].concat(be16(14200))                                            // 14.20 V
};

function tasuProxy() {
    return {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        sendTasuResponse: { subscribe: (cb) => { events.on('r', cb); return Promise.resolve(); } },
        sendTasuRequest: (p) => {
            const req = [p.serviceID].concat(Array.from(p.udsData));
            const key = req.map((x) => D.hex(x)).join(' ');
            sent.push({ target: p.targetAddress, key });
            setTimeout(() => {
                if (key === '22 58 0F') {
                    events.emit('r', frame(0x12, [0x7F, 0x22, 0x78]));                     // pending first
                }
                events.emit('r', frame(0x40, [0x62, 0x44, 0x02, 0, 0]));                   // another unit: ignored
                const a = DME_ANSWERS[key];
                if (a) {
                    setTimeout(() => events.emit('r', frame(0x12, a)), 5);
                }
            }, 5);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        }
    };
}

const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'),
    require('../package/rhmiData/application.json'),
    { 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasuProxy });
const realExit = process.exit;
process.exit = () => {};

/* Short "no answer" waits for the test. */
const { Tasu } = require('../src/tasu.js');
const orig = Tasu.prototype.request;
Tasu.prototype.request = function (sid, data) { return orig.call(this, sid, data, 150); };

require('../src/diagtest.js');

(async () => {
    for (let i = 0; i < 100 && !(unit.rows('dgList').some((r) => r[0] === 'Rohdaten 1. Antwort' && r[1] !== '…')); i++) {
        await unit.wait(100);
    }
    const rows = unit.rows('dgList');
    const get = (l) => (rows.find((r) => r[0] === l) || [])[1];
    assert.strictEqual(get('Diagnose-Dienst'), 'offen');
    assert.strictEqual(get('DME-Typ (SGBD)'), '0F2422 = DME8FF_R (Tester F4)');
    assert.ok(/^NO_ERROR /.test(get('Gateway-Antwort')), get('Gateway-Antwort'));
    assert.ok(/^\d+ · 1 Arg: \{udsResponse,errorCode\}$/.test(get('Antwort-Ereignisse')), get('Antwort-Ereignisse'));
    assert.ok(/^\d+ PIDs, davon: 05 0F 0B 0C 04 11$/.test(get('OBD unterstützt')), get('OBD unterstützt'));
    assert.strictEqual(get('BMW 4402 Öl nach Filter'), '98 °C');
    assert.strictEqual(get('BMW 580F Ansaugluft'), '35 °C');
    assert.strictEqual(get('BMW 4205 Ladedruck abs.'), '2.10 bar');
    assert.strictEqual(get('BMW 4300 Kühlmittel'), 'nein: gibt es nicht');
    assert.strictEqual(get('BMW 5822 Öltemperatur'), 'keine Antwort');
    assert.strictEqual(get('OBD 0F Ansaugluft'), '35 °C');
    assert.strictEqual(get('OBD 42 Bordspannung'), '14.20 V');
    assert.ok(get('Rohdaten 1. Antwort').startsWith('00 00 00 00 00 00'));
    assert.strictEqual(unit.props['dgStatus.Visible'], 0, 'status hidden when answers came');

    assert.deepStrictEqual(unit.status, ['registerActive', 'registerHmiVisible'], 'reported in front');

    // only reads, only to the DME
    assert.ok(sent.length > 20);
    sent.forEach((s) => {
        assert.strictEqual(s.target, 0x12);
        assert.ok(/^(22 .. ..|01 ..)$/.test(s.key), s.key);
    });

    // the guard refuses anything else before it reaches the gateway
    const t = new Tasu({ info() {}, warn() {}, error() {} });
    t._setProxy(tasuProxy());
    const n = sent.length;
    for (const [sid, data] of [[0x14, [0xFF, 0xFF, 0xFF]], [0x2E, [0x44, 0x02]], [0x31, [1, 2, 3]], [0x10, [0x03]], [0x22, [0xF1]], [0x22, [0xF1, 256]], ['34', [0x22]], [34.5, [1, 2]]]) {
        await assert.rejects(t.request(sid, data), /nur lesen/);
    }
    assert.strictEqual(sent.length, n, 'nothing refused reached the gateway');

    // busy verdicts are retried; another request's transport error does not end ours
    let calls = 0;
    const t2 = new Tasu({ info() {}, warn() {}, error() {} });
    t2._setProxy({
        sendTasuRequest: () => {
            calls++;
            if (calls <= 2) {
                return Promise.resolve({ TasuErrorEnum: 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' });
            }
            setTimeout(() => {
                t2._onResponse({ udsResponse: [], errorCode: 'SOME_OTHER_APPS_ERROR' });
                t2._onResponse(frame(0x12, [0x62, 0x58, 0x0F, 111]));
            }, 5);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        }
    });
    const r2 = await t2.request(0x22, [0x58, 0x0F], 500);
    assert.deepStrictEqual(r2, [0x62, 0x58, 0x0F, 111]);
    assert.strictEqual(calls, 3);
    assert.strictEqual(t2.busy, 2);

    // a DME that answers only tester F4: the probe finds it and keeps it
    const t3 = new Tasu({ info() {}, warn() {}, error() {} });
    const seen = [];
    t3._setProxy({ sendTasuRequest: (p) => {
        seen.push(p.sourceAddress);
        if (p.sourceAddress === 0xF4) {
            setTimeout(() => t3._onResponse(frame(0x12, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xE8])), 2);
        }
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } });
    t3.useTester(0xF2);
    assert.strictEqual(await t3.request(0x22, [0xF1, 0x50], 80), null);
    t3.useTester(0xF4);
    assert.deepStrictEqual(await t3.request(0x22, [0xF1, 0x50], 80), [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xE8]);
    assert.deepStrictEqual(seen, [0xF2, 0xF4]);
    assert.throws(() => t3.useTester(0x10), /not allowed/);

    // decoding edge cases
    assert.deepStrictEqual(D.supported(0x20, [0x41, 0x20, 0x80, 0, 0, 0x01]), [0x21, 0x40]);
    assert.strictEqual(D.didValue(D.DIDS.find((d) => d.id === 0x4425), [0x62, 0x44, 0x25, 0xFF, 0x9C]), '-10 °C');

    console.log(`test_app (diagtest): ok, ${rows.length} rows, ${sent.length} requests`);
    realExit(0);
})().catch((e) => { console.error(e, unit.log.slice(-10)); realExit(1); });
