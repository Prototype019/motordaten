'use strict';
/**
 * Runs src/hudtest.js on a fake head unit (tools/fake_unit.js) whose DME
 * answers with replies read from the G87 over ENET (docs/g87-s58.md), against
 * a fake cluster-render on a local socket that speaks its protocol
 * (PROTOCOL.md: u32 length, type, body; J and F messages) the way the
 * iDrive 8 service answers: hello with backend id8 and its targets, the
 * layer shown.
 *
 * Checks: one image layer on hud (353 x 203), its pixels sent whole, the
 * list's rows; a new value -> new pixels, the same -> none; the button hides
 * the layer and stops asking the DME, again shows it; the service going away
 * -> reconnect, the layer made again and sent whole; only 22 requests for the
 * oil temperature, to the DME.
 *
 * HT_CDS=1: with the car's signal (CDS) the oil comes from it and the DME is never asked;
 * it is sent only on a change, so a quiet signal keeps its value; 255 (no value) -> the DME.
 *
 *   node apps/km_hudtest/tools/test_app.js
 *   HT_CDS=1 node apps/km_hudtest/tools/test_app.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const D = require('../src/decode.js');
const draw = require('../src/hud_draw.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-hudtest-'));
const SOCK = path.join(dir, 'render.sock');
process.env.KM_CR_SOCKET = SOCK;

/* ---- the fake cluster-render ---- */
const service = { conns: 0, hellos: 0, layers: [], sets: [], frames: [], sockets: [] };

function send(sock, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = 0x4a;
    body.copy(m, 5);
    sock.write(m);
}

const server = net.createServer((sock) => {
    service.conns++;
    service.sockets.push(sock);
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
            if (type === 0x4a) {
                const m = JSON.parse(body.toString('utf8'));
                if (m.op === 'hello') {
                    service.hellos++;
                    assert.strictEqual(m.proto, 1);
                    send(sock, { ev: 'hello', proto: 1, backend: 'id8',
                        targets: 'map:874x749,hud:353x203,guide:702x213,widget:2240x896,popup:2240x896' });
                } else if (m.op === 'layer') {
                    service.layers.push(m);
                    send(sock, { ev: 'layer', ref: m.ref, state: 'shown', reason: '' });
                    send(sock, { ev: 'target', target: m.target, state: 'shown', holder: '', reason: '' });
                } else if (m.op === 'set') {
                    service.sets.push(m);
                } else {
                    throw new Error(`unexpected op ${m.op}`);
                }
            } else if (type === 0x46) {
                const ref = body.readUInt32LE(0);
                const rects = body.readUInt16LE(12);
                service.frames.push({ ref, rects, bytes: body.length - 14 - rects * 8 });
            } else {
                throw new Error(`unexpected message type ${type}`);
            }
        }
    });
});

/* ---- the fake DME ---- */
const events = new EventEmitter();
const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
const bytes = (s) => s.split(' ').map((x) => parseInt(x, 16));
/* Measured on the car (engine off): oil 29 °C. */
const ANSWERS = { '58 22': '58 22 59' };
let asked = 0;
const services = new Set();

function tasuProxy() {
    return {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        sendTasuResponse: { subscribe: (cb) => { events.on('r', cb); return Promise.resolve(); } },
        sendTasuRequest: (p) => {
            asked++;
            services.add(p.serviceID);
            assert.strictEqual(p.targetAddress, 0x12, 'only the DME');
            const req = Array.from(p.udsData);
            assert.deepStrictEqual(req, [0x58, 0x22], 'only the oil temperature');
            let body = [];
            for (let i = 0; i < req.length; i += 2) {
                const one = ANSWERS[`${D.hex(req[i])} ${D.hex(req[i + 1])}`];
                if (one) body = body.concat(bytes(one));
            }
            setTimeout(() => events.emit('r', frame(0x12, [0x62].concat(body))), 2);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        }
    };
}

/* ---- the car's signal (HT_CDS=1): CDS statusEngineTemperature, raw - 48 = °C ---- */
const CDS = process.env.HT_CDS === '1';
const cdsEvents = new EventEmitter();
function cdsProxy() {
    return {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        statusEngineTemperature: { subscribe: (cb) => { cdsEvents.on('t', cb); return Promise.resolve(); } }
    };
}
const cdsOil = (c) => cdsEvents.emit('t', { temperatureEngineOilDrive: c + 48, temperatureEngineDrive: 255 });

const spec = require('../spec.js');
const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package', 'rhmiData', 'application.json'), 'utf8'));
const fakes = { 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasuProxy };
if (CDS) fakes['de.bmw.infotainment.vehicle.CDS'] = cdsProxy;
const unit = require('../../../tools/fake_unit.js').install(spec, appJson, fakes);

const row = (label) => (unit.rows('htList').find((r) => r[0] === label) || [])[1];
const framesOf = (ref) => service.frames.filter((f) => f.ref === ref);

/* With the signal: the oil from it, the DME never asked; the signal gone -> the DME, as without it. */
function cdsRun() {
    // sent once, as the car does when the value changes
    setTimeout(() => cdsOil(29), 500);
    return unit.wait(1500).then(() => {
        assert.strictEqual(service.layers.length, 1);
        assert.strictEqual(row('Öl'), '29 °C');
        assert.strictEqual(row('Quelle'), 'Fahrzeugsignal');
        assert.ok(/^verbunden, \d+ Werte$/.test(row('Fahrzeugsignal')), row('Fahrzeugsignal'));
        assert.ok(/^Läuft/.test(unit.text('htStatus')), unit.text('htStatus'));
        assert.strictEqual(asked, 0, 'the gateway left alone');
        cdsOil(96);
        return unit.wait(800);
    }).then(() => {
        assert.strictEqual(row('Öl'), '96 °C');
        assert.ok(framesOf(service.layers[0].ref).length >= 2, 'drawn again');
        // off and on: still only the signal
        unit.press('htRun');
        return unit.wait(600);
    }).then(() => {
        assert.strictEqual(row('HUD'), 'aus');
        unit.press('htRun');
        return unit.wait(1200);
    }).then(() => {
        assert.strictEqual(row('Öl'), '96 °C');
        assert.strictEqual(asked, 0, 'still the gateway left alone');
        // quiet for longer than the DME's round: the value stays, nothing asked
        return unit.wait(3000);
    }).then(() => {
        assert.strictEqual(row('Öl'), '96 °C');
        assert.strictEqual(asked, 0, 'a quiet signal keeps its value');
        // the signal has no value (255): the DME
        ANSWERS['58 22'] = '58 22 9C';
        cdsEvents.emit('t', { temperatureEngineOilDrive: 255, temperatureEngineDrive: 255 });
        return unit.wait(2500);
    }).then(() => {
        assert.ok(asked >= 1, 'the DME asked once the signal is gone');
        assert.deepStrictEqual(Array.from(services), [0x22], 'read only');
        assert.strictEqual(row('Quelle'), 'DME (Signal fehlt)');
        assert.strictEqual(row('Öl'), '96 °C');
    });
}

server.listen(SOCK, () => {
    require('../src/hudtest.js');
    if (CDS) {
        cdsRun().then(() => {
            console.log(`test_app (signal): ok (${asked} DME requests after the signal stopped, ${service.frames.length} pictures)`);
            process.exit(0);
        }, (e) => { console.error(e); process.exit(1); });
        return;
    }
    unit.wait(1500).then(() => {
        // one layer, on the HUD, at its size
        assert.strictEqual(service.layers.length, 1, `layers: ${JSON.stringify(service.layers)}`);
        const hud = service.layers[0];
        assert.strictEqual(hud.target, 'hud');
        assert.strictEqual(hud.kind, 'image');
        assert.deepStrictEqual([hud.x, hud.y, hud.w, hud.h, hud.iw, hud.ih], [0, 0, draw.HUD.w, draw.HUD.h, 353, 203]);
        // pixels sent whole
        assert.ok(framesOf(hud.ref).length >= 1);
        assert.strictEqual(framesOf(hud.ref)[0].bytes, 353 * 203 * 4);
        // the list
        assert.strictEqual(row('Renderer'), 'verbunden (id8)');
        assert.strictEqual(row('HUD'), 'angezeigt');
        assert.strictEqual(row('HUD-Platz'), 'angezeigt');
        assert.strictEqual(row('Öl'), '29 °C');
        assert.ok(/^Läuft/.test(unit.text('htStatus')), unit.text('htStatus'));
        assert.deepStrictEqual(Array.from(services), [0x22], 'read only');

        // the same values: no new pixels
        const n = service.frames.length;
        return unit.wait(2200).then(() => {
            assert.strictEqual(service.frames.length, n, 'nothing new to draw');
            // warm: new pixels
            ANSWERS['58 22'] = '58 22 9C';           // 96 °C
            return unit.wait(1500);
        }).then(() => {
            assert.ok(framesOf(hud.ref).length >= 2, 'drawn again');
            assert.strictEqual(row('Öl'), '96 °C');
            // the button: off -> hidden, the DME left alone
            unit.press('htRun');
            return unit.wait(600);
        }).then(() => {
            const off = service.sets.filter((s) => s.visible === 0).map((s) => s.ref);
            assert.deepStrictEqual(off, [hud.ref]);
            assert.strictEqual(row('HUD'), 'aus');
            const before = asked;
            return unit.wait(2200).then(() => assert.ok(asked <= before + 1, 'no questions while off'));
        }).then(() => {
            unit.press('htRun');
            return unit.wait(600);
        }).then(() => {
            assert.ok(service.sets.filter((s) => s.visible === 1).length >= 1, 'shown again');
            const before = asked;
            return unit.wait(2200).then(() => assert.ok(asked > before, 'asking again'));
        }).then(() => {
            // the service goes: the client comes back, makes both layers again, sends them whole
            const layersBefore = service.layers.length;
            service.sockets.forEach((s) => s.destroy());
            return unit.wait(1500).then(() => {
                assert.strictEqual(service.conns, 2);
                assert.strictEqual(service.hellos, 2);
                assert.strictEqual(service.layers.length, layersBefore + 1);
                const again = service.frames.filter((f) => f.rects === 0 && f.bytes === 353 * 203 * 4);
                assert.ok(again.length >= 2, 'the HUD sent whole again');
                assert.strictEqual(again[again.length - 1].ref, service.layers[service.layers.length - 1].ref);
                assert.strictEqual(row('Renderer'), 'verbunden (id8)');
            });
        });
    }).then(() => {
        console.log(`test_app: ok (${asked} DME requests, ${service.frames.length} pictures, ${service.conns} connections)`);
        process.exit(0);
    }, (e) => {
        console.error(e);
        process.exit(1);
    });
});
