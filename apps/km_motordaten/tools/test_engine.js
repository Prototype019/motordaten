'use strict';
/**
 * What the engine does, for the recordings: the DME's replies read over ENET
 * on the G87 (engine off) decoded, one multi-identifier reply walked, the
 * logbook reading recordings made before these fields, the log page's new
 * charts and the list page's "Alle löschen" with its confirmation.
 *
 *   node tools/test_engine.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.KM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kmeng-'));
const D = require('../src/decode.js');
const Logbook = require('../src/logbook.js');
const dash = require('../src/dash.js');
const { Recorder } = require('../src/kit_record.js');

const bytes = (s) => s.split(' ').map((x) => parseInt(x, 16));
const v = (id, reply) => D.didNumber(D.didById(id), bytes(reply));
const near = (a, b, e) => assert.ok(Math.abs(a - b) < (e || 1e-6), `${a} ~ ${b}`);

// single replies, as the car gave them
assert.strictEqual(v(0x5889, '62 58 89 FF FF'), null, 'lambda invalid with the engine off');
near(v(0x5889, '62 58 89 10 00'), 1.0);
near(v(0x5658, '62 56 58 2E 57'), 237.26, 0.01);          // rail pressure, bar
near(v(0x58F3, '62 58 F3 10 24'), 4.132, 0.001);          // fuel low pressure abs., bar
near(v(0x554C, '62 55 4C 00'), 0);
near(v(0x554C, '62 55 4C 08'), 3);                        // 3 °KW taken back
near(v(0x59FA, '62 59 FA D8'), -30);                      // s8: -40 x 0.75
near(v(0x4AD5, '62 4A D5 6D'), 33.75);
near(v(0x5813, '62 58 13 37'), 41.25);
near(v(0x4600, '62 46 00 12 69'), 36.8, 0.05);

// one request for the eight, the DME leaving lambda out
const ids = [0x5889, 0x5816, 0x5658, 0x56C1, 0x58F3, 0x554C, 0x59FA, 0x480B].map(D.didById);
const got = D.didNumbers(ids, bytes('62 58 16 0F 00 56 58 2E 57 56 C1 00 00 58 F3 10 24 55 4C 00 59 FA D8 48 0B 00 00'));
assert.strictEqual(got[0x5889], undefined);
near(got[0x5816], 0.9375);
near(got[0x59FA], -30);
near(got[0x480B], 0);

// a recording made before these fields still reads; a new one has them
const dir = path.join(process.env.KM_DATA_DIR, 'logs');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '20261101-100000.csv'), 't,rpm,torque,power,boost,boostTarget,oilPress,oil,coolant,intake,charge,gearbox,exhaust,voltage\n0,900,,,,,,,,,,,,13.8\n100,1000,,,,,,,,,,,,13.9\n');
const old = Logbook.load('20261101-100000.csv');
assert.deepStrictEqual(old.series.rpm, [900, 1000]);
assert.deepStrictEqual(old.series.lambda, [null, null]);
assert.strictEqual(Logbook.summary('20261101-100000.csv').peak.voltage, 13.9);
fs.writeFileSync(path.join(dir, '20261102-100000.csv'), `t,${Logbook.FIELDS.join(',')}\n` +
    `0,${Logbook.FIELDS.map((f) => (f === 'lambda' ? 0.86 : f === 'rail' ? 350 : f === 'knock' ? 1.5 : '')).join(',')}\n`);
const neu = Logbook.load('20261102-100000.csv');
assert.deepStrictEqual([neu.series.lambda[0], neu.series.rail[0], neu.series.knock[0]], [0.86, 350, 1.5]);

// the log page: seven charts, each drawn
const chans = dash.targets('log', {}).filter((t) => t.id.indexOf('chan:') === 0);
assert.deepStrictEqual(chans.map((t) => t.id), ['chan:rpm', 'chan:boost', 'chan:temps', 'chan:oil', 'chan:mix', 'chan:fuel', 'chan:load']);
assert.ok(chans[6].x + chans[6].w <= dash.W - 96, 'the buttons fit');
['mix', 'fuel', 'load'].forEach((c) => dash.draw(new Recorder(dash.W, dash.H), 'log', {}, {}, null, { log: neu, channel: c }));

// the list page: "Alle löschen", then its confirmation; only with recordings
const logs = Logbook.list().map((r) => Logbook.summary(r.name));
assert.ok(dash.targets('logs', { logs }).some((t) => t.id === 'deleteAll' && t.label === 'Alle löschen'));
assert.ok(dash.targets('logs', { logs, confirmDeleteAll: true }).some((t) => t.id === 'deleteAll!' && t.danger));
assert.ok(!dash.targets('logs', { logs: [] }).some((t) => /deleteAll/.test(t.id)));
dash.draw(new Recorder(dash.W, dash.H), 'logs', {}, {}, null, { logs, confirmDeleteAll: true });
// onto a USB stick: the first mounted under /media, into Motordaten/, each file whole
(async () => {
    const Usb = require('../src/usb.js');
    const media = fs.mkdtempSync(path.join(os.tmpdir(), 'kmmedia-'));
    const stick = path.join(media, 'MY STICK');
    fs.mkdirSync(stick);
    const mounts = path.join(media, 'mounts');
    fs.writeFileSync(mounts, `proc /proc proc rw 0 0\n/dev/sda1 ${media}/MY\\040STICK vfat rw 0 0\n`);
    assert.deepStrictEqual(Usb.sticks(mounts, media), [stick]);
    const names = Logbook.list().map((r) => r.name);
    const seen = [];
    const r = await Usb.exportLogs(Logbook.dir(), names, { mounts, root: media, progress: (n, of) => seen.push(`${n}/${of}`) });
    assert.deepStrictEqual(r, { stick: 'MY STICK', count: 2 });
    assert.deepStrictEqual(seen, ['1/2', '2/2']);
    names.forEach((n) => assert.strictEqual(fs.readFileSync(path.join(stick, 'Motordaten', n), 'utf8'),
        fs.readFileSync(path.join(Logbook.dir(), n), 'utf8')));
    await Usb.exportLogs(Logbook.dir(), names, { mounts, root: media });       // again: the folder is there
    await assert.rejects(Usb.exportLogs(Logbook.dir(), names, { mounts: path.join(media, 'none'), root: media }), /Kein USB-Stick/);
    fs.readdirSync(path.join(stick, 'Motordaten')).forEach((n) => fs.unlinkSync(path.join(stick, 'Motordaten', n)));
    fs.rmdirSync(path.join(stick, 'Motordaten'));
    fs.chmodSync(stick, 0o555);
    if (process.getuid && process.getuid() !== 0) {
        await assert.rejects(Usb.exportLogs(Logbook.dir(), names, { mounts, root: media }), /Nicht gespeichert \(0 von 2\): der Stick lässt die App nicht schreiben/);
    }
    fs.chmodSync(stick, 0o755);
    assert.ok(dash.targets('logs', { logs }).some((t) => t.id === 'usb'));
    dash.draw(new Recorder(dash.W, dash.H), 'logs', {}, {}, null, { logs, usb: { text: 'x', error: true } });

    Logbook.removeAll('20261102-100000.csv');
assert.deepStrictEqual(Logbook.list().map((r) => r.name), ['20261102-100000.csv'], 'the running one stays');
Logbook.removeAll();
assert.strictEqual(Logbook.list().length, 0);

console.log('test_engine: ok');
})().catch((e) => { console.error(e); process.exit(1); });
