'use strict';
/**
 * The fault memory: the read-only guard for 19 (only 02 <mask>, nothing
 * that clears or writes), faults() collecting every unit's reply to one
 * request to all units (a pending one waits, other services' frames and
 * transport errors don't count), and Faults.parse with the replies the
 * G87 gave over ENET (docs/g87-s58.md).
 *
 *   node tools/test_faults.js
 */
const assert = require('assert');
require('../../../tools/fake_unit.js').install(require('../spec.js'), require('../package/rhmiData/application.json'));
const { Tasu, ALL } = require('../src/tasu.js');
const Faults = require('../src/faults.js');
const dash = require('../src/dash.js');
const spec = require('../spec.js');

const log = { info() {}, warn() {}, error() {} };
const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });

(async () => {
    const sent = [];
    const t = new Tasu(log);
    t._setProxy({
        sendTasuRequest: (p) => {
            sent.push({ target: p.targetAddress, req: [p.serviceID].concat(Array.from(p.udsData)) });
            setTimeout(() => {
                t._onResponse(frame(0x12, [0x59, 0x02, 0xFF]));
                t._onResponse(frame(0x40, [0x62, 0xF1, 0x90, 1, 2]));             // another service: ignored
                t._onResponse({ udsResponse: [], errorCode: 'OTHER' });            // a transport error: ignored
                t._onResponse(frame(0x5D, [0x7F, 0x19, 0x78]));                    // pending ...
            }, 5);
            setTimeout(() => t._onResponse(frame(0x5D, [0x59, 0x02, 0xFF, 0x80, 0x0A, 0xBF, 0x2F])), 60);   // ... then its answer
            setTimeout(() => t._onResponse(frame(0x18, [0x59, 0x02, 0xFF])), 80);
            return Promise.resolve({ TasuErrorEnum: 'REQUEST_PENDING' });
        }
    });

    const replies = await t.faults(0x0D, 150, 3000);
    assert.deepStrictEqual(sent, [{ target: ALL, req: [0x19, 0x02, 0x0D] }], 'one request, to all units');
    assert.deepStrictEqual(Array.from(replies.keys()).sort(), [0x12, 0x18, 0x5D]);
    const f = Faults.parse(replies);
    assert.strictEqual(f.units, 3);
    assert.deepStrictEqual(f.entries, [{ ecu: 0x5D, unit: 'Fahrerassistenz-Kamera', code: '800ABF', status: 0x2F, state: 'aktiv' }]);

    // the guard: only reading the fault memory
    for (const [sid, data] of [[0x19, [0x04, 0x0D]], [0x19, [0x02]], [0x14, [0xFF, 0xFF]], [0x31, [1, 2]], [0x2E, [0x44, 0x02]]]) {
        await assert.rejects(t.request(sid, data), /nur lesen/, `${sid} ${data}`);
    }
    await assert.rejects(t.request(0x22, [0xF1, 0x90], 100, 0x40), /nicht erlaubt/, 'single reads: DME and gearbox only');
    assert.strictEqual(sent.length, 1, 'nothing refused reached the gateway');

    // clearing: one unit at a time, never the head unit, never all at once; request() never clears
    const t2 = new Tasu(log);
    const asked = [];
    t2._setProxy({ sendTasuRequest: (p) => {
        asked.push({ target: p.targetAddress, req: [p.serviceID].concat(Array.from(p.udsData)) });
        setTimeout(() => t2._onResponse(frame(p.targetAddress, [0x54])), 5);
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } });
    assert.deepStrictEqual(await t2.clearFaults(0x5D), [0x54]);
    assert.deepStrictEqual(asked, [{ target: 0x5D, req: [0x14, 0xFF, 0xFF, 0xFF] }]);
    await assert.rejects(t2.clearFaults(0x63), /nicht erlaubt/, 'not the head unit');
    await assert.rejects(t2.clearFaults(ALL), /nicht erlaubt/, 'not all at once');
    await assert.rejects(t2.clearFaults(0x100), /nicht erlaubt/);
    await assert.rejects(t2.request(0x14, [0xFF, 0xFF, 0xFF]), /nur lesen/, 'request() does not clear');
    assert.strictEqual(asked.length, 1);

    // status words, sorting: active first
    assert.strictEqual(Faults.stateOf(0x08), 'gespeichert');
    assert.strictEqual(Faults.stateOf(0x04), 'vorläufig');
    const many = Faults.parse(new Map([[0x12, [0x59, 0x02, 0xFF, 0x1F, 0x2A, 0x01, 0x28]], [0x60, [0x59, 0x02, 0xFF, 0x00, 0x00, 0x01, 0x09]]]));
    assert.deepStrictEqual(many.entries.map((e) => e.state), ['aktiv', 'gespeichert']);
    assert.strictEqual(Faults.unitName(0x99), 'Steuergerät 0x99');

    // the pages have a proxy button for every target
    ['logs', 'faults'].forEach((p) => assert.ok(dash.targets(p, { logs: new Array(20).fill({ start: new Date(), peak: {} }) }).length <= spec.PROXIES));

    console.log(`test_faults: ok, ${f.units} units`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
