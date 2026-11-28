'use strict';
/**
 * shared/mdrive.js: the M-Tasten test writes one M setup's driving mode, only at a standstill, never Track,
 * everything else as KEINE_AENDERUNG; a refusal by the car is noted.   node tools/test_mdrive.js
 */
const assert = require('assert');
const { MDrive, value } = require('../shared/mdrive.js');

let t = 1000;
const notes = [];
const sets = [];
let refuse = false;
const proxy = {
    mDriveThree: {
        getValue: () => Promise.resolve({ setupMDrive3Index: 'KEINE_KONFIGURATION' }),
        setValue: (v) => { sets.push(v); return refuse ? Promise.reject(new Error('E_ACCESS')) : Promise.resolve(); }
    }
};

(async () => {
    // the value: M1, Sport, the rest unchanged
    const v = value('m1', 'sport');
    assert.strictEqual(v.setupMDrive3Index, 'KONFIGURATION_1');
    assert.strictEqual(v.setupMDrive3DrivingMode, 'FAHRMODUS_2');
    Object.keys(v).filter((k) => !/Index|DrivingMode/.test(k)).forEach((k) => assert.strictEqual(v[k], 'KEINE_AENDERUNG', k));
    assert.strictEqual(value('m2', 'none').setupMDrive3DrivingMode, 'KEINE_AENDERUNG');
    assert.throws(() => value('m1', 'track'), /Track/);

    const m = new MDrive({ note: (s) => notes.push(s), now: () => t });
    // no MDrive, no speed, moving, old speed: nothing written
    assert.strictEqual(await m.write('m1', 'sport'), false);
    m.setProxy(proxy);
    assert.strictEqual(await m.write('m1', 'sport'), false);
    assert.ok(/Tempo unbekannt/.test(m.result.text));
    m.speed(30);
    assert.strictEqual(await m.write('m1', 'sport'), false);
    assert.ok(/nur im Stand/.test(m.result.text));
    m.speed(0);
    t += 6000;
    assert.strictEqual(await m.write('m1', 'sport'), false, 'speed too old');
    assert.strictEqual(await m.write('m1', 'track'), false, 'never Track');
    assert.strictEqual(sets.length, 0, 'nothing sent so far');

    // standing: written once, read before and after
    m.speed(0);
    assert.strictEqual(await m.write('m1', 'sport'), true);
    assert.strictEqual(sets.length, 1);
    assert.deepStrictEqual(sets[0], v);
    assert.ok(notes.some((n) => /vorher/.test(n)) && notes.some((n) => /nachher/.test(n)));
    assert.ok(/M1 = Sport geschrieben/.test(m.result.text), m.result.text);

    // back to the factory state; the car refusing is noted
    refuse = true;
    assert.strictEqual(await m.write('m1', 'none'), false);
    assert.ok(/abgelehnt: E_ACCESS/.test(m.result.text), m.result.text);
    assert.strictEqual(sets[1].setupMDrive3DrivingMode, 'KEINE_AENDERUNG');

    // the reports
    m.status({ statusMDrive3DrivingMode: 'FAHRMODUS_3' });
    assert.strictEqual(m.mode, 'FAHRMODUS_3');
    m.display({ controlDisplayCID: 'M1_AKTIV' });
    assert.ok(notes.some((n) => /M1_AKTIV/.test(n)));
    console.log('test_mdrive: ok');
})().catch((e) => { console.error(e); process.exit(1); });
