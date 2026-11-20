'use strict';
/**
 * The HUD on the Mac: src/hudtest.js unchanged on a fake head unit (tools/fake_unit.js), a DME
 * whose oil warms up on a drive (cold, warming, warm, too hot, back), and a fake cluster-render
 * on a local socket that speaks its protocol (PROTOCOL.md) as the iDrive 8 service does and keeps
 * what the app sends to the hud target. A browser shows it live: the HUD's 353 x 203 over a dark
 * road, projected (black is nothing, as in the car), a stand-in for BMW's own speed bar under it,
 * the app's list as the iDrive screen shows it, and the app's button.
 *
 *   node apps/km_hudtest/tools/emulator.js [port]   (default http://localhost:8788)
 *
 * The oil comes as in the car: from the car's signal (CDS statusEngineTemperature, sent on change,
 * raw - 48 = °C); the page's button takes the signal away (255) to try the DME fallback.
 * BMW's own bar under the area is drawn as measured on the G87's HUD (emulator.html).
 */
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8788;
const CYCLE_S = 48;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'km-hudemu-'));
const SOCK = path.join(work, 'render.sock');
process.env.KM_CR_SOCKET = SOCK;
process.env.KM_DATA_DIR = work;     // the app's settings (hud.json) live for this run only

const D = require(path.join(APP, 'src/decode.js'));
const { Canvas } = require(path.join(APP, 'src/kit_canvas.js'));

/* ---- the drive: oil (°C) and speed (km/h) at t seconds ---- */
const lerp = (a, b, f) => a + (b - a) * Math.max(0, Math.min(1, f));
const PHASES = [[8, 'Kaltstart'], [26, 'Warmfahren'], [34, 'Warm'], [42, 'Volllast, Öl zu heiß'], [48, 'Abkühlen']];
function drive(t) {
    if (t < 8) return { oil: 24, speed: lerp(0, 30, t / 8) };
    if (t < 26) return { oil: lerp(24, 96, (t - 8) / 18), speed: lerp(30, 100, (t - 8) / 18) };
    if (t < 34) return { oil: 96 + Math.sin(t) * 0.6, speed: 128 };
    if (t < 42) return { oil: lerp(96, 136, (t - 34) / 6), speed: lerp(128, 210, (t - 34) / 8) };
    return { oil: lerp(136, 104, (t - 42) / 6), speed: lerp(210, 130, (t - 42) / 6) };
}
/* Everything else from the drive: engine speed with gear changes, boost on the pulls, the rest steady. */
function car(t) {
    const d = drive(t);
    const pull = t >= 34 && t < 42;
    const rpm = d.speed < 2 ? 850 : 1500 + ((d.speed * 55) % 3200) + (pull ? 1800 : 0);
    return Object.assign(d, {
        rpm: Math.min(7200, rpm), coolant: Math.min(92, d.oil + 18), boost: pull ? 1.6 + 0.3 * Math.sin(t * 3) : 0.1 + d.speed / 600,
        oilPress: 1.2 + rpm / 2400, intake: 24 + d.speed / 40, gearbox: Math.min(92, d.oil - 4), voltage: 14.1 + 0.1 * Math.sin(t)
    });
}
/* A value as the unit's bytes (src/decode.js scaling). */
function encode(id, value) {
    const d = D.didById(id);
    const n = { u8: 1, s8: 1, u16: 2, s16: 2 }[d.t] || 1;
    let raw = Math.round((value - d.o) / d.k);
    raw = Math.max(0, Math.min(Math.pow(2, 8 * n) - 1, raw));
    const out = [id >> 8, id & 0xFF];
    for (let i = n - 1; i >= 0; i--) out.push((raw >> (8 * i)) & 0xFF);
    return out;
}

/* ---- the fake cluster-render ---- */
let cdsOn = true;
const emu = { asked: 0 };
let app = null;
const screen = { page: 'main', pressed: null };
const service = { conns: 0, backend: 'id8', layer: null, image: null, visible: true, frames: 0, refused: [] };

function send(sock, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = 0x4a;
    body.copy(m, 5);
    sock.write(m);
}

/* A frame message: the whole image (no rects) or its rects' rows one after another. */
function applyFrame(body) {
    const ref = body.readUInt32LE(0);
    const n = body.readUInt16LE(12);
    const l = service.layer;
    if (!l || l.ref !== ref) return;
    let off = 14 + n * 8;
    if (!n) {
        body.copy(service.image, 0, off, off + service.image.length);
    } else {
        for (let i = 0; i < n; i++) {
            const r = 14 + i * 8;
            const x = body.readUInt16LE(r), y = body.readUInt16LE(r + 2), w = body.readUInt16LE(r + 4), h = body.readUInt16LE(r + 6);
            for (let row = 0; row < h; row++) {
                body.copy(service.image, ((y + row) * l.iw + x) * 4, off, off + w * 4);
                off += w * 4;
            }
        }
    }
    service.frames++;
}

net.createServer((sock) => {
    service.conns++;
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
            if (type === 0x46) {
                applyFrame(body);
                continue;
            }
            const m = JSON.parse(body.toString('utf8'));
            if (m.op === 'hello') {
                send(sock, { ev: 'hello', proto: 1, backend: service.backend,
                    targets: 'map:874x749,hud:353x203,guide:702x213,widget:2240x896,popup:2240x896' });
            } else if (m.op === 'layer' && m.target === 'hud' && m.kind === 'image') {
                service.layer = m;
                service.image = Buffer.alloc(m.iw * m.ih * 4);
                service.visible = m.visible !== 0;
                send(sock, { ev: 'layer', ref: m.ref, state: service.visible ? 'shown' : 'hidden', reason: '' });
                send(sock, { ev: 'target', target: 'hud', state: service.visible ? 'shown' : 'idle', holder: '', reason: '' });
            } else if (m.op === 'set' && service.layer && m.ref === service.layer.ref && 'visible' in m) {
                service.visible = m.visible !== 0;
                send(sock, { ev: 'layer', ref: m.ref, state: service.visible ? 'shown' : 'hidden', reason: '' });
                send(sock, { ev: 'target', target: 'hud', state: service.visible ? 'shown' : 'lingering', holder: '', reason: '' });
            } else {
                service.refused.push(m.op);
                send(sock, { ev: 'error', op: m.op, ref: m.ref || 0, reason: 'not in the emulator' });
            }
        }
    });
}).listen(SOCK, start);

const dash = require(path.join(APP, 'src/dash.js'));
const REC = require(path.join(APP, 'src/kit_record.js'));
/* The app's drawn screen, as mgu-render would show it. */
function screenPng() {
    const rec = new REC.Recorder(dash.W, dash.H);
    const st = app ? app._settings : null;
    dash.draw(rec, screen.page, app ? app.screenValues() : {}, st, { pressed: screen.pressed },
        st ? { order: st.order, count: st.count, mode: st.mode } : {});
    const c = new Canvas(dash.W, dash.H);
    REC.play(rec.words(), c);
    return c.png();
}

function hudPng() {
    const l = service.layer;
    if (!l || !service.visible) return new Canvas(353, 203).png();
    const c = new Canvas(l.iw, l.ih);
    service.image.copy(Buffer.from(c.d.buffer, c.d.byteOffset, c.d.length));
    return c.png();
}

function start() {
    const t0 = Date.now();
    const now = () => ((Date.now() - t0) / 1000) % CYCLE_S;
    const ev = new EventEmitter();
    const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
    const tasu = () => ({
        init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        sendTasuResponse: { subscribe: (cb) => { ev.on('r', cb); return Promise.resolve(); } },
        sendTasuRequest: (p) => {
            const req = Array.from(p.udsData);
            const c = car(now());
            const ambient = 1013;
            const VALUE = { 0x5822: c.oil, 0x4205: (c.boost + ambient / 1000), 0x4201: ambient, 0x4436: c.oilPress + ambient / 1000,
                0x580F: c.intake, 0x6000: c.gearbox };
            let body = [0x7F, p.serviceID, 0x31];
            if (p.serviceID === 0x22) {
                body = [0x62];
                for (let i = 0; i + 1 < req.length; i += 2) {
                    const id = (req[i] << 8) | req[i + 1];
                    if (VALUE[id] !== undefined) body = body.concat(encode(id, VALUE[id]));
                }
            } else if (p.serviceID === 0x01 && req[0] === 0x42) {
                const mv = Math.round(c.voltage * 1000);
                body = [0x41, 0x42, mv >> 8, mv & 0xFF];
            }
            emu.asked++;
            setTimeout(() => ev.emit('r', frame(p.targetAddress, body)), 25);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        }
    });
    // the car's signal: sent when the whole degree changes, 255 while switched off
    const cdsEv = new EventEmitter();
    let lastRaw = null;
    setInterval(() => {
        const raw = cdsOn ? Math.max(0, Math.min(254, Math.round(car(now()).oil) + 48)) : 255;
        if (raw === lastRaw) return;
        lastRaw = raw;
        // the coolant ahead of the oil while warming up, as on the car
        const oil = car(now()).oil;
        const coolant = cdsOn ? Math.round(Math.min(92, oil + 18)) + 48 : 255;
        cdsEv.emit('t', { temperatureEngineOilDrive: raw, temperatureEngineDrive: coolant });
    }, 250);
    const cds = () => ({
        init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        statusEngineTemperature: { subscribe: (cb) => { cdsEv.on('t', cb); return Promise.resolve(); } },
        statusEngineSpeed2: { subscribe: (cb) => { cdsEv.on('rpm', cb); return Promise.resolve(); } }
    });
    // the engine speed, ten times a second as the car sends it
    setInterval(() => cdsEv.emit('rpm', { actualValueRPMEngineCrankshaft: cdsOn ? Math.round(car(now()).rpm * 4) : 65535 }), 100);
    const unit = require(path.join(APP, '../../tools/fake_unit.js')).install(require(path.join(APP, 'spec.js')),
        require(path.join(APP, 'package/rhmiData/application.json')),
        { 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu, 'de.bmw.infotainment.vehicle.CDS': cds });
    process.exit = () => {};
    // the app itself: its screens drawn here (no mgu-render on the Mac), its buttons pressed by clicks
    const { ListApp } = require(path.join(APP, 'src/screen.js'));
    const startApp = ListApp.prototype.start;
    ListApp.prototype.start = function () { app = this; return startApp.apply(this, arguments); };
    require(path.join(APP, 'src/hudtest.js'));
    serve(unit, now);
}

function serve(unit, now) {
    const page = fs.readFileSync(path.join(__dirname, 'emulator.html'), 'utf8');
    http.createServer((req, res) => {
        if (req.url.indexOf('/hud.png') === 0) {
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            res.end(hudPng());
        } else if (req.url.indexOf('/state') === 0) {
            const t = now();
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({
                phase: (PHASES.find((p) => t < p[0]) || PHASES[PHASES.length - 1])[1],
                speed: Math.round(car(t).speed), limit: car(t).speed <= 60 ? 50 : 130, cds: cdsOn,
                oil: Math.round(car(t).oil), t: Math.round(t),
                status: unit.text('htStatus') || '', rows: unit.rows('htList'), asked: emu.asked,
                frames: service.frames, conns: service.conns, refused: service.refused
            }));
        } else if (req.url.indexOf('/screen.png') === 0) {
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            res.end(screenPng());
        } else if (req.url.indexOf('/tap') === 0) {
            const q = new URL(req.url, 'http://x').searchParams;
            const x = Number(q.get('x')) * dash.W;
            const y = Number(q.get('y')) * dash.H;
            const st = app && app._settings;
            const t = dash.targets(screen.page, st ? { order: st.order, count: st.count, mode: st.mode } : {}).find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
            if (t && app) {
                if (t.id.indexOf('tab:') === 0) screen.page = t.id.slice(4);
                else app._action(t.id);
                screen.pressed = t.id;
                setTimeout(() => { screen.pressed = null; }, 150);
            }
            res.end(t ? t.id : '');
        } else if (req.url.indexOf('/drag') === 0) {
            // a card held and moved on the Werte page: as src/drawn.js would report it ('order', order, key)
            const q = new URL(req.url, 'http://x').searchParams;
            const x0 = Number(q.get('x0')) * dash.W;
            const y0 = Number(q.get('y0')) * dash.H;
            const x1 = Number(q.get('x1')) * dash.W;
            const S = require(path.join(APP, 'src/settings.js'));
            const cell = screen.page === dash.DRAG_PAGE && app &&
                dash.tempCellBoxes(app._settings).find((b) => x0 >= b.x && x0 <= b.x + b.w && y0 >= b.y && y0 <= b.y + b.h);
            if (cell) {
                const order = dash.tempCellBoxes(app._settings).map((b) => b.key).filter((k) => k !== cell.key);
                order.splice(dash.tempSlotAt(x1 - (x0 - cell.x)), 0, cell.key);
                app._set(S.dropped(app._settings, order, cell.key));
            }
            res.end(cell ? cell.key : '');
        } else if (req.url.indexOf('/cds') === 0) {
            cdsOn = !cdsOn;
            res.end('ok');
        } else if (req.url.indexOf('/press') === 0) {
            unit.press('htRun');
            res.end('ok');
        } else {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(page);
        }
    }).listen(PORT, '127.0.0.1', () => console.log(`HUD-Emulator: http://localhost:${PORT}`));
}
