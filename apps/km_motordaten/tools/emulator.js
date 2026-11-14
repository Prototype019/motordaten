'use strict';
/**
 * The app as it runs in the car, on the Mac: src/motordaten.js unchanged on a fake head unit (tools/fake_unit.js),
 * a fake mgu-render (layer mode, ticks, touch) and a DME, gearbox and OBD that answer every identifier asked with
 * a drive: cold idle, warming up, a full-load pull (a tune reporting the stock torque), then the knock control
 * taking back cylinder 5. The frames the app sends are played into a canvas and saved as PNGs at set moments;
 * touches on the screen open the settings.
 *
 *   node tools/emulator.js [out dir]      (default docs/design/emulator)
 *   node tools/emulator.js --live [port]  the screen live in a browser (default http://localhost:8787): the drive
 *                                         in a loop, a click is a touch
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const APP = path.join(__dirname, '..');
const LIVE = process.argv.indexOf('--live') >= 0;
const PORT = Number(process.argv[process.argv.indexOf('--live') + 1]) || 8787;
const OUT = path.resolve((!LIVE && process.argv[2]) || path.join(APP, '..', '..', 'docs', 'design', 'emulator'));
const CYCLE_S = 36;         // the drive's length; live, it starts over
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'km-emu-'));
const SOCK = path.join(work, 'render.sock');
process.env.MGU_RENDERD_SOCKET = SOCK;
process.env.KM_DATA_DIR = path.join(work, 'data');
fs.mkdirSync(process.env.KM_DATA_DIR);
fs.mkdirSync(OUT, { recursive: true });

const D = require(path.join(APP, 'src/decode.js'));
const { play } = require(path.join(APP, 'src/kit_record.js'));
const { Canvas } = require(path.join(APP, 'src/kit_canvas.js'));
const Limits = require(path.join(APP, 'src/limits.js'));
// the gearbox counts for "ready" too, as one would set it
Limits.save(Object.assign(Limits.defaults(), { gearboxReadyOn: 1, gearboxReady: 60 }));

/* ---- the drive: the car's values (physical units) at t seconds ---- */
const AMBIENT = 1.013;     // bar
const lerp = (a, b, f) => a + (b - a) * Math.max(0, Math.min(1, f));
function car(t) {
    const s = { ambient: AMBIENT, angles: [12, 12, 12, 12, 12, 12], knock: 0, torque: 6 };
    if (t < 9) {             // cold idle
        Object.assign(s, { rpm: 880 + 20 * Math.sin(t * 3), oil: 24, coolant: 37, gearbox: 22, intake: 9, charge: 14, exhaust: 330,
            boost: 0, target: 0, oilPress: 5.6, air: 42, load: 18, voltage: 14.4 });
    } else if (t < 18) {     // warming up, part load
        const f = (t - 9) / 9;
        Object.assign(s, { rpm: 2300 + 200 * Math.sin(t), oil: lerp(60, 86, f), coolant: lerp(55, 66, f), gearbox: lerp(32, 44, f), intake: 14,
            charge: 24, exhaust: 520, boost: 0.15, target: 0.2, oilPress: 3.9, air: 210, load: 36, voltage: 14.2, torque: 180 });
    } else if (t < 28) {     // a pull through third gear: the tune reports about stock torque
        const f = (t - 18) / 8;
        Object.assign(s, { rpm: lerp(3000, 6950, f), oil: 104, coolant: 92, gearbox: 86, intake: 18, charge: 41, exhaust: lerp(700, 905, f),
            boost: lerp(1.2, 1.94, f * 2), target: 1.98, oilPress: 4.9, air: lerp(1100, 2000, f), load: lerp(120, 165, f), voltage: 14.2,
            torque: 545 });
        s.knock = f > 0.6 ? 0.75 : 0;
        if (f > 0.6) s.angles[2] -= 2.2;
    } else {                 // the knock control taking back cylinder 5
        Object.assign(s, { rpm: 5200, oil: 108, coolant: 95, gearbox: 92, intake: 21, charge: 46, exhaust: 860, boost: 1.85, target: 1.9,
            oilPress: 4.6, air: 1700, load: 150, voltage: 14.1, torque: 540, knock: 4.5 });
        s.angles[4] -= 4.5;
    }
    return s;
}
/* identifier -> physical value at t */
function valueOf(id, t) {
    const s = car(t);
    const abs = (rel) => s.ambient + rel;
    switch (id) {
    case 0x4807: return s.rpm;
    case 0x5891: return s.torque;
    case 0x4205: case 0x57C1: return abs(s.boost);
    case 0x4AB0: return abs(s.target);
    case 0x4436: return abs(s.oilPress);
    case 0x4ABC: return s.air;
    case 0x5813: return s.load;
    case 0x4201: return s.ambient * 1000;
    case 0x580F: return s.intake;
    case 0x582F: return s.exhaust;
    case 0x4402: return s.oil;
    case 0x4300: return s.coolant;
    case 0x59D4: return s.charge;
    case 0x554C: return s.knock;
    case 0x4A49: case 0x4A4A: case 0x4A4C: case 0x4A4D: case 0x4A4E: case 0x4A4F:
        return s.angles[[0x4A49, 0x4A4A, 0x4A4C, 0x4A4D, 0x4A4E, 0x4A4F].indexOf(id)];
    case 0x6000: return s.gearbox;
    case 0x5425: return t < 9 ? 65 : 66;
    default: return null;
    }
}
function encode(did, v) {
    // held in the identifier's range, as the DME does (it never wraps)
    const lim = { u8: [0, 255], s8: [-128, 127], u16: [0, 65535], s16: [-32768, 32767] }[did.t];
    const raw = Math.max(lim[0], Math.min(lim[1], Math.round((v - did.o) / did.k)));
    if (did.t === 'u8' || did.t === 's8') return [raw & 0xFF];
    return [(raw >> 8) & 0xFF, raw & 0xFF];
}

/* ---- the fake mgu-render: layer mode, ticks; frames kept, touch sent ---- */
let lastFrame = null;
let client = null;
const msg = (type, payload) => { const h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(payload.length, 4); return Buffer.concat([h, payload]); };
net.createServer((c) => {
    client = c;
    let buf = Buffer.alloc(0);
    let tick = null;
    let n = 0;
    c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
            const type = buf.readUInt32LE(0);
            const len = buf.readUInt32LE(4);
            if (buf.length < 8 + len) break;
            const p = Buffer.from(buf.slice(8, 8 + len));
            buf = buf.slice(8 + len);
            if (type === 7) lastFrame = new Uint32Array(p.buffer, p.byteOffset, p.length / 4).slice();
            if (type === 1 && !tick) {
                const x = Buffer.alloc(52);
                x.writeUInt32LE(1, 0); x.writeUInt32LE(1, 4); x.writeUInt32LE(1 | 4 | 8, 8);
                [0, 76, 2880, 764].forEach((v, i) => x.writeInt32LE(v, 28 + i * 4));
                x.writeUInt32LE(2048, 44); x.writeUInt32LE(60000, 48);
                const r = Buffer.alloc(12); r.writeUInt32LE(1, 0); r.writeUInt32LE(2880, 4); r.writeUInt32LE(960, 8);
                c.write(msg(0x4d520101, x)); c.write(msg(101, r));
                tick = setInterval(() => { const q = Buffer.alloc(8); q.writeUInt32LE(n++, 0); c.write(msg(102, q)); }, 33);
            }
        }
    });
    c.on('close', () => clearInterval(tick));
    c.on('error', () => {});
}).listen(SOCK, run);

/* One touch phase (1 down, 2 move, 3 up) at x, y, as the renderer passes the display's touch on. */
function touchPhase(phase, x, y) {
    const p = Buffer.alloc(12);
    p.writeUInt32LE(phase, 0); p.writeFloatLE(x, 4); p.writeFloatLE(y, 8);
    client.write(msg(105, p));
}
function touch(x, y) {
    touchPhase(1, x, y);
    setTimeout(() => touchPhase(3, x, y), 60);
}

function shot(name) {
    if (!lastFrame) { console.log(`${name}: no frame yet`); return; }
    const cv = new Canvas(2880, 764);
    play(lastFrame, cv);
    fs.writeFileSync(path.join(OUT, `${name}.png`), cv.png());
    console.log(`${name}.png`);
}

const PHASES = [[9, 'Kalt im Leerlauf'], [18, 'Warmfahren, Teillast'], [28, 'Vollgas im 3. Gang'], [CYCLE_S, 'Klopfregelung nimmt Zylinder 5 zurück']];

/* Live: the last frame as PNG, a page that shows it and turns clicks into touches. */
function serve(now) {
    const http = require('http');
    let png = null;
    let pngOf = null;
    const page = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Motordaten Emulator</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#06090c;color:#8394a4;font:15px -apple-system,system-ui,sans-serif}
.wrap{max-width:1600px;margin:0 auto;padding:16px}.bezel{background:#000;border-radius:18px;padding:18px 18px 22px;box-shadow:0 0 0 1px #1c242c}
img{display:block;width:100%;height:auto;border-radius:6px;cursor:pointer;background:#10161d}
.bar{display:flex;justify-content:space-between;gap:12px;margin-top:12px;flex-wrap:wrap}b{color:#e9eef2;font-weight:600}</style></head>
<body><div class="wrap"><div class="bezel"><img id="s" alt="Bildschirm der App" width="2880" height="764"></div>
<div class="bar"><span>Simulierte Fahrt: <b id="p">…</b></span><span>Klick = Tippen · gedrückt halten und ziehen = Finger ziehen</span></div></div>
<script>const s=document.getElementById('s'),p=document.getElementById('p');let busy=false;
async function tick(){if(busy)return;busy=true;try{const r=await fetch('/frame.png?'+Date.now());const b=await r.blob();const u=URL.createObjectURL(b);
s.onload=()=>URL.revokeObjectURL(u);s.src=u;p.textContent=decodeURIComponent(r.headers.get('x-phase')||'');}catch(e){}busy=false;}
setInterval(tick,200);tick();
// the mouse as a finger: pressed, moved and let go, held as long as the button is
const at=(e)=>{const r=s.getBoundingClientRect();return 'x='+Math.round((e.clientX-r.left)/r.width*2880)+'&y='+Math.round((e.clientY-r.top)/r.height*764);};
let down=false,last=0;s.draggable=false;
s.addEventListener('pointerdown',(e)=>{e.preventDefault();down=true;s.setPointerCapture(e.pointerId);fetch('/touch?p=1&'+at(e),{method:'POST'});});
s.addEventListener('pointermove',(e)=>{if(!down)return;const n=Date.now();if(n-last<40)return;last=n;fetch('/touch?p=2&'+at(e),{method:'POST'});});
s.addEventListener('pointerup',(e)=>{if(!down)return;down=false;fetch('/touch?p=3&'+at(e),{method:'POST'});});
</script></body></html>`;
    http.createServer((req, res) => {
        if (req.url.indexOf('/frame.png') === 0) {
            if (lastFrame && pngOf !== lastFrame) {
                const cv = new Canvas(2880, 764);
                play(lastFrame, cv);
                png = cv.png();
                pngOf = lastFrame;
            }
            const t = now();
            const phase = (PHASES.find((ph) => t < ph[0]) || PHASES[PHASES.length - 1])[1];
            res.writeHead(png ? 200 : 503, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-phase': encodeURIComponent(phase) });
            res.end(png || '');
        } else if (req.url.indexOf('/touch') === 0) {
            const q = new URL(req.url, 'http://x').searchParams;
            if (client) touchPhase(Number(q.get('p')) || 1, Number(q.get('x')), Number(q.get('y')));
            if (client && !q.get('p')) setTimeout(() => touchPhase(3, Number(q.get('x')), Number(q.get('y'))), 60);
            res.end('ok');
        } else {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(page);
        }
    }).listen(PORT, '127.0.0.1', () => console.log(`live: http://localhost:${PORT}`));
}

function run() {
    const t0 = Date.now();
    const now = () => (LIVE ? ((Date.now() - t0) / 1000) % CYCLE_S : (Date.now() - t0) / 1000);
    const ev = new EventEmitter();
    const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
    const tasu = () => ({
        init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        sendTasuResponse: { subscribe: (cb) => { ev.on('r', cb); return Promise.resolve(); } },
        sendTasuRequest: (p) => {
            const req = Array.from(p.udsData);
            let body = null;
            if (p.serviceID === 0x22) {
                body = [0x62];
                for (let i = 0; i + 1 < req.length; i += 2) {
                    const id = (req[i] << 8) | req[i + 1];
                    const did = D.didById(id);
                    const v = valueOf(id, now());
                    if (did && v !== null) body = body.concat([req[i], req[i + 1]], encode(did, v));
                }
                if (body.length === 1) body = [0x7F, 0x22, 0x31];
            } else if (p.serviceID === 0x01 && req[0] === 0x42) {
                const mv = Math.round(car(now()).voltage * 1000);
                body = [0x41, 0x42, mv >> 8, mv & 0xFF];
            } else if (p.serviceID === 0x19) {
                body = [0x59, 0x02, 0xFF];
            }
            if (body) setTimeout(() => ev.emit('r', frame(p.targetAddress, body)), 25);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        }
    });
    const cds = {};
    const cdsProxy = () => {
        const f = (n) => ({ subscribe: (cb) => { cds[n] = cb; return Promise.resolve(); } });
        return { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(), statusEngineSpeed2: f('rpm'), statusEngineTemperature: f('t') };
    };
    const unit = require(path.join(APP, '../../tools/fake_unit.js')).install(require(path.join(APP, 'spec.js')),
        require(path.join(APP, 'package/rhmiData/application.json')), {
            'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu,
            'de.bmw.infotainment.vehicle.CDS': cdsProxy
        });
    const exit = process.exit;
    process.exit = () => {};
    require(path.join(APP, 'src/motordaten.js'));
    setInterval(() => cds.rpm && cds.rpm({ actualValueRPMEngineCrankshaft: Math.round(car(now()).rpm * 4) }), 40);
    setTimeout(() => {
        unit.rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        const host = unit.comps.ST_OnlineApps_MotordatenLayer;
        if (host) { host.emit('visible', { visible: true }); host.emit('focus', { focus: true }); }
    }, 2000);
    if (LIVE) {
        serve(now);
        return;
    }
    const at = (s, fn) => setTimeout(fn, s * 1000);
    at(7.5, () => shot('1-kalt'));
    at(16.5, () => shot('2-warmfahren'));
    at(26.5, () => shot('3-vollgas'));
    at(32, () => shot('4-klopfen'));
    at(32.5, () => touch(100, 16 + 3 * 184 + 84));        // the tab Einstellungen
    at(33.5, () => shot('5-einstellungen'));
    at(34, () => touch(260 + 1288 + 600, 370));           // the card Bereit für Volllast
    at(35, () => shot('6-bereit'));
    at(35.5, () => touch(2880 - 96 - 150, 106));          // Zurück
    at(36, () => touch(260 + 600, 370));                  // the card Grenzwerte
    at(37, () => shot('7-grenzwerte'));
    at(37.5, () => { console.log(`saved in ${OUT}`); exit(0); });
}
