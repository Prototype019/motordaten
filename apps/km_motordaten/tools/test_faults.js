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

    // MHD Max Cooling: exactly 2F 03 01 / 2F 03 00, to the DME only; accepted on the DME's echo
    const t4 = new Tasu(log);
    const sent4 = [];
    let answer4 = (req) => [0x6F].concat(req.slice(1));
    t4._setProxy({ sendTasuRequest: (p) => {
        const req = [p.serviceID].concat(Array.from(p.udsData));
        sent4.push({ target: p.targetAddress, req });
        setTimeout(() => t4._onResponse(frame(p.targetAddress, answer4(req))), 3);
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } });
    assert.strictEqual(await t4.maxCooling(true), true);
    assert.strictEqual(await t4.maxCooling(false), true);
    assert.deepStrictEqual(sent4, [{ target: 0x12, req: [0x2F, 0x03, 0x01] }, { target: 0x12, req: [0x2F, 0x03, 0x00] }]);
    answer4 = () => [0x7F, 0x2F, 0x31];                                    // an untuned DME refuses it
    assert.strictEqual(await t4.maxCooling(true), false);
    await assert.rejects(t4.request(0x2F, [0x03, 0x01]), /nur lesen/, 'request() never writes');

    // MHD's exhaust flap is gone (28.11.2026): no way to it, request() refuses 2F 02 as every other write
    assert.strictEqual(t4.exhaustFlap, undefined, 'no flap command');
    await assert.rejects(t4.request(0x2F, [0x02, 0x01]), /nur lesen/, 'request() never moves the flap');

    // status words, sorting: active first
    assert.strictEqual(Faults.stateOf(0x08), 'gespeichert');
    assert.strictEqual(Faults.stateOf(0x04), 'vorläufig');
    const many = Faults.parse(new Map([[0x12, [0x59, 0x02, 0xFF, 0x1F, 0x2A, 0x01, 0x28]], [0x60, [0x59, 0x02, 0xFF, 0x00, 0x00, 0x01, 0x09]]]));
    assert.deepStrictEqual(many.entries.map((e) => e.state), ['aktiv', 'gespeichert']);
    assert.strictEqual(Faults.unitName(0x99), 'Steuergerät 0x99');

    // one unit at a time: 19 02 to that unit; never to all through faultsOf
    const t3 = new Tasu(log);
    const asked3 = [];
    t3._setProxy({ sendTasuRequest: (p) => {
        asked3.push(p.targetAddress);
        setTimeout(() => t3._onResponse(frame(p.targetAddress, [0x59, 0x02, 0xFF])), 3);
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } });
    assert.deepStrictEqual(await t3.faultsOf(0x30, 0x0D), [0x59, 0x02, 0xFF]);
    await assert.rejects(t3.faultsOf(ALL, 0x0D), /nicht erlaubt/);
    assert.deepStrictEqual(asked3, [0x30]);
    assert.ok(Faults.addresses().length >= 28 && Faults.addresses().indexOf(0x5D) >= 0);

    // every unit with faults: still no more targets than proxy buttons
    const scan = Faults.addresses().map((addr) => ({ addr, name: Faults.unitName(addr), state: 'faults', entries: [{}] }));
    const ts = dash.targets('faults', { faults: { scan, entries: [{}] } });
    assert.ok(ts.length <= spec.PROXIES, `${ts.length} targets`);
    assert.ok(ts.some((t) => t.id === 'unit:93') && ts.some((t) => t.id === 'faults:clear'));

    // the pages have a proxy button for every target
    ['logs', 'faults'].forEach((p) => assert.ok(dash.targets(p, { logs: new Array(20).fill({ start: new Date(), peak: {} }) }).length <= spec.PROXIES));

    // fault texts: the FORTTEXTE table of a documentation page, kept in the data folder
    const { DtcTexts, TableReader } = require('../src/dtctext.js');
    const page = '# X\n### FARTTEXTE\n| 0x01 | nein |\n### FORTTEXTE\n\nDimensions: 2\n\n| ORT | ORTTEXT |\n| --- | --- |\n' +
        '| 0x021200 | Energiesparmode aktiv | 0 |\n| 0x80ABF | Kamera: Sicht eingeschränkt – Café | 1 |\n### NEXT\n| 0x999999 | nein |\n';
    const r = new TableReader();
    page.match(/[\s\S]{1,7}/g).forEach((c) => r.feed(c));
    assert.deepStrictEqual(r.end(), { '021200': 'Energiesparmode aktiv', '080ABF': 'Kamera: Sicht eingeschränkt ? Cafe' });
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kmtx-'));
    const tx = new DtcTexts(log, dir);
    assert.strictEqual(tx.text(0x12, '021200'), undefined, 'no table yet');
    assert.strictEqual(tx.text(0x78, '000001'), null, 'climate: not documented');
    assert.strictEqual(await tx.sync([0x12]), 0, 'no internet: nothing');
    const docs = [];
    assert.strictEqual(await tx.sync([0x40], (doc) => { docs.push(doc); return Promise.resolve(doc === 'BDC_G05' ? { '024008': 'Codierung' } : {}); }), 1);
    assert.strictEqual(docs[0], 'BDC_G05', 'the units with faults first');
    assert.strictEqual(docs.length, 26);
    const again = new DtcTexts(log, dir);
    assert.strictEqual(again.text(0x40, '24008'), 'Codierung', 'kept without internet');
    assert.strictEqual(again.text(0x40, '000001'), null);
    assert.deepStrictEqual(again.count(), { have: 1, of: 26 });

    // the unit page with a text, without one, and not loaded yet
    const unitScan = [{ addr: 0x40, name: 'Karosserie (BDC)', state: 'faults', entries: [
        { ecu: 0x40, code: '024008', status: 9, state: 'gespeichert', text: 'Codierung: '.repeat(30) },
        { ecu: 0x40, code: '024009', status: 9, state: 'gespeichert', text: null },
        { ecu: 0x40, code: '02400A', status: 9, state: 'aktiv' }] }];
    dash.draw(new (require('../src/kit_record.js').Recorder)(dash.W, dash.H), 'faultunit', {}, {}, null, { unit: 0x40, faults: { scan: unitScan, texts: { have: 1, of: 26 } } });

    console.log(`test_faults: ok, ${f.units} units`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
