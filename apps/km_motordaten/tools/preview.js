'use strict';
/**
 * Draws the screen (src/dash.js) the way the renderer gets it - recorded
 * draw calls, played back into a software canvas - for each scene, as
 * docs/design/preview/<scene>.png (2880 x 764). Run after node tools/gen.js.
 *
 *   node tools/preview.js
 */
const fs = require('fs');
const path = require('path');
const { Recorder, play } = require('../src/kit_record.js');
const { Canvas } = require('../src/kit_canvas.js');
const dash = require('../src/dash.js');
const Limits = require('../src/limits.js');
const os = require('os');
process.env.KM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'km-prev-'));
const Logbook = require('../src/logbook.js');

/* A recording to show: a cold start, warming up, then a pull through the gears. */
function sampleLog() {
    const t0 = Date.UTC(2026, 10, 14, 10, 42, 0);
    const r = new Logbook.Recording(t0);
    for (let t = 0; t < 6 * 60000; t += 100) {
        const s = t / 1000;
        const pull = s > 300 && s < 330;
        const rpm = pull ? 2500 + ((s - 300) % 10) * 450 : 750 + 40 * Math.sin(s / 3);
        const boost = pull ? Math.min(1.9, ((s - 300) % 10) * 0.35) : 0;
        r.sample({ rpm, torque: pull ? 400 + boost * 80 : 6, power: pull ? rpm * (400 + boost * 80) / 9549 * 1.36 : 0.5,
            boost, boostTarget: pull ? Math.min(1.95, boost + 0.05) : 0, oilPress: 1.9 + rpm / 2500, oil: 25 + s / 5,
            coolant: 40 + s / 6, intake: 12, charge: pull ? 30 + (s - 300) : 25, gearbox: 22 + s / 10, exhaust: 330 + (pull ? 400 : 0),
            voltage: 14.2,
            // the engine under the pull: richer, rail pressure up, a little knock control at the top
            lambda: pull ? Math.max(0.82, 1 - boost * 0.09) : 1 + 0.01 * Math.sin(s), lambdaTarget: pull ? Math.max(0.8, 1 - boost * 0.1) : 1,
            rail: pull ? 200 + boost * 75 : 60, railTarget: pull ? 200 + boost * 76 : 60, fuelLow: pull ? 5.6 : 5.9,
            knock: pull && (s - 300) % 10 > 7 ? 1.5 : 0, ignition: pull ? 8 - boost * 3 : 12, pedal: pull ? 100 : 4,
            load: pull ? 60 + boost * 40 : 18, battSoc: 78 + s / 90, battCurrent: s < 60 ? 30 - s / 2 : 4, battVoltage: 14.3,
            // Max Cooling from the pull on: the target drops, fan and thermostat go up
            coolTarget: s > 300 ? 80 : 105, fanDuty: s > 300 ? 100 : 20, thermostat: s > 300 ? 100 : 35, pumpTarget: s > 300 ? 255 : 120, pumpPct: s > 300 ? 100 : 47, fan: s > 300 ? 100 : 20, pumpChargePct: s > 300 ? 100 : 40,
            // cylinder 3 taken back a little at the top of each pull
            knockCyl1: 0, knockCyl2: pull ? 0.3 : 0, knockCyl3: pull && (s - 300) % 10 > 6 ? 2.5 : 0, knockCyl4: 0, knockCyl5: pull ? 0.4 : 0,
            knockCyl6: 0 }, t0 + t);
    }
    r.stop();
    return r.name;
}

const SCENES = {
    cold: { rpm: 1180, rpmPeak: 1218, oil: 24, coolant: 37, intake: 8, charge: 12, boost: 0, boostTarget: 0, boostPeak: 0,
        oilPress: 5.6, oilPressPeak: 5.6, voltage: 14.4, gearbox: 22, exhaust: 338, torque: 4, power: 0.4, knock: 0 },
    pull: { battSoc: 82, battVoltage: 14.2, battCurrent: 6, knock: 2.6, knockCyl: 3, rpm: 6650, rpmPeak: 6950, oil: 104, coolant: 92, intake: 16, charge: 38, boost: 1.94, boostTarget: 1.98, boostPeak: 2.04,
        oilPress: 4.9, oilPressPeak: 5.9, voltage: 14.2, gearbox: 86, exhaust: 912, torque: 548, power: 506,
        torquePeak: 560, powerPeak: 512 },
    nodme: { rpm: 860, rpmPeak: 860, oil: null, coolant: null, intake: null, charge: null, boost: null, boostTarget: null,
        boostPeak: null, oilPress: null, oilPressPeak: null, voltage: null,
        status: 'Motorsteuergerät antwortet nicht. Zündung einschalten.', statusErr: true }
};

const out = path.join(__dirname, '..', '..', '..', 'docs', 'design', 'preview');
fs.mkdirSync(out, { recursive: true });
SCENES.settings = {};
SCENES.records = {};
SCENES.mhd = {};
SCENES.app = {};
SCENES.warming = Object.assign({}, SCENES.cold, { rpm: 2400, rpmPeak: 3100, oil: 86, coolant: 64, gearbox: 41, exhaust: 520 });
SCENES.limits = {};
SCENES.ready = {};
SCENES.warnings = { battSoc: 41, battVoltage: 12.1, battCurrent: -18, knock: 4.5, knockCyl: 5, rpm: 6900, rpmPeak: 7050, oil: 128, coolant: 118, intake: 31, charge: 64, boost: 1.62, boostTarget: 1.9, boostPeak: 2.02,
    oilPress: 0.8, oilPressPeak: 5.9, voltage: 14.1, gearbox: 125, exhaust: 950, torque: 470, power: 455, torquePeak: 560, powerPeak: 520 };
const logName = sampleLog();
const summary = Logbook.summary(logName);
const EXTRA = {
    pull: { recording: { ms: 83000 }, cooling: { state: 'ON' } },
    records: { maxima: { trip: { rpm: 6950, power: 692, torque: 812, boost: 2.04, oilPress: 5.9, oil: 108, coolant: 96, gearbox: 92, intake: 21,
        charge: 46, exhaust: 912, knock: 1.5 }, rec: { rpm: { v: 7180, at: Date.UTC(2026, 10, 9, 15, 0) }, power: { v: 692, at: Date.UTC(2026, 10, 14, 17, 0) },
        torque: { v: 845, at: Date.UTC(2026, 10, 9, 15, 0) }, boost: { v: 2.11, at: Date.UTC(2026, 10, 9, 15, 0) }, oilPress: { v: 6.2, at: Date.UTC(2026, 10, 1, 9, 0) },
        oil: { v: 121, at: Date.UTC(2026, 10, 9, 15, 0) }, coolant: { v: 104, at: Date.UTC(2026, 10, 9, 15, 0) }, gearbox: { v: 99, at: Date.UTC(2026, 10, 9, 15, 0) },
        intake: { v: 31, at: Date.UTC(2026, 10, 3, 12, 0) }, charge: { v: 58, at: Date.UTC(2026, 10, 9, 15, 0) }, exhaust: { v: 948, at: Date.UTC(2026, 10, 9, 15, 0) },
        knock: { v: 3.4, at: Date.UTC(2026, 10, 9, 15, 0) } } } },
    warming: { cooling: { confirm: true } },
    logsusb: { usb: { text: '2 Aufzeichnungen auf „KEVIN“ im Ordner Motordaten gespeichert. Der Stick kann raus.' }, logs: [summary] },
    logs: { logs: [summary, Object.assign({}, summary, { start: new Date(Date.UTC(2026, 10, 13, 18, 5)) })] },
    log: { log: Logbook.load(logName), channel: 'rpm' },
    logboost: { log: Logbook.load(logName), channel: 'boost', confirmDelete: true },
    logmix: { log: Logbook.load(logName), channel: 'mix' },
    logfuel: { log: Logbook.load(logName), channel: 'fuel' },
    logload: { log: Logbook.load(logName), channel: 'load' },
    logknock: { log: Logbook.load(logName), channel: 'knock' },
    logbattery: { log: Logbook.load(logName), channel: 'battery' },
    logcooling: { log: Logbook.load(logName), channel: 'cooling' }
};
const Faults = require('../src/faults.js');
/* A scan of every unit as the G87 answered over ENET (one entry in the camera); progress stops at k. */
function scanUpTo(k) {
    const answered = [0x01, 0x06, 0x08, 0x0F, 0x10, 0x12, 0x18, 0x21, 0x29, 0x2A, 0x2C, 0x30, 0x37, 0x39, 0x40, 0x43, 0x44,
        0x56, 0x5D, 0x5E, 0x60, 0x61, 0x63, 0x67, 0x6D, 0x6E, 0x76, 0x78];
    return Faults.addresses().map((addr, i) => {
        const u = { addr, name: Faults.unitName(addr), state: 'wait', entries: [] };
        if (i < k) {
            u.state = answered.indexOf(addr) < 0 ? 'none' : addr === 0x5D ? 'faults' : 'ok';
            if (addr === 0x5D) u.entries = [{ ecu: 0x5D, unit: u.name, code: '800ABF', status: 0x2F, state: 'aktiv' }];
        } else if (i === k) {
            u.state = 'read';
        }
        return u;
    });
}
const done = scanUpTo(99);
EXTRA.faults = { faults: { scan: done, units: 28, entries: done[done.findIndex((u) => u.addr === 0x5D)].entries, at: new Date(Date.UTC(2026, 10, 14, 11, 2)) } };
EXTRA.faultsread = { faults: { reading: true, scan: scanUpTo(14), progress: 15 } };
EXTRA.faultsclear = { faults: Object.assign({}, EXTRA.faults.faults, { confirmClear: true }) };
/* the unit page with made-up fault texts (the real ones come from the car's own download, not the repo) */
const camera = { addr: 0x5D, name: Faults.unitName(0x5D), state: 'faults', entries: [
    { ecu: 0x5D, code: '800ABF', status: 0x2F, state: 'aktiv', text: 'Beispieltext: Kamerasicht eingeschränkt, Scheibe vor der Kamera prüfen' },
    { ecu: 0x5D, code: '800AC4', status: 0x28, state: 'gespeichert', text: null },
    { ecu: 0x5D, code: '800AD0', status: 0x08, state: 'gespeichert' }] };
EXTRA.faultunit = { unit: 0x5D, faults: Object.assign({}, EXTRA.faults.faults, { scan: [camera], texts: { have: 25, of: 26 } }) };
SCENES.faultsclear = {};
SCENES.faultsread = {};
SCENES.faultunit = {};
SCENES.faults = {};
SCENES.faultsread = {};
SCENES.logs = {};
SCENES.log = {};
SCENES.logboost = {};
SCENES.logsusb = {};
SCENES.logmix = {};
SCENES.logfuel = {};
SCENES.logload = {};
SCENES.logknock = {};
SCENES.logbattery = {};
SCENES.logcooling = {};
// the DME silent for a moment: the last values dimmed
SCENES.stale = Object.assign({}, SCENES.pull, { stale: true, status: 'Motorsteuerung antwortet gerade nicht – die letzten Werte bleiben stehen' });
// Logs an GitHub, its phases (the code and repository names made up)
const GH = { online: true, error: null, qr: null, code: null, repo: null, repos: [], sent: null };
EXTRA.github_off = { github: Object.assign({}, GH, { phase: 'off' }) };
EXTRA.github_offline = { github: Object.assign({}, GH, { phase: 'off', online: false }) };
EXTRA.github_code = { github: Object.assign({}, GH, { phase: 'code', qr: 'https://github.com/login/device', code: 'WDJB-MJHT' }) };
EXTRA.github_install = { github: Object.assign({}, GH, { phase: 'install', qr: 'https://github.com/apps/motordaten-logs/installations/new' }) };
EXTRA.github_pick = { github: Object.assign({}, GH, { phase: 'pick', repos: ['fahrer/motordaten-logs', 'fahrer/notizen', 'fahrer/website'] }) };
EXTRA.github_ready = { github: Object.assign({}, GH, { phase: 'ready', repo: 'fahrer/motordaten-logs',
    sent: { at: Date.UTC(2026, 10, 22, 9, 5), path: 'km_motordaten/2026-11-22_09-05-07.log' } }) };
Object.keys(EXTRA).filter((n) => /^github_/.test(n)).forEach((n) => { SCENES[n] = {}; });
Object.keys(SCENES).forEach((name) => {
    const rec = new Recorder(dash.W, dash.H);
    const page = /^github_/.test(name) ? 'github' : name === 'settings' || name === 'limits' || name === 'ready' || name === 'mhd' || name === 'app' || name === 'records' ? name : /^logs/.test(name) ? 'logs' : /^log/.test(name) ? 'log' : name === 'faultunit' ? 'faultunit' : /^faults/.test(name) ? 'faults' : 'main';
    const cfg = /^(settings|limits|ready|mhd|app)$/.test(name) ? Object.assign(Limits.defaults(), { rpmRed: 6800, gearboxReadyOn: 1, gearboxReady: 60 }) :
        name === 'cold' || name === 'pull' || name === 'warming' ? Object.assign(Limits.defaults(), { gearboxReadyOn: 1 }) : Limits.defaults();
    if (name === 'warnings') cfg.oilMax = 125;
    dash.draw(rec, page, SCENES[name], cfg, { focus: name === 'pull' ? 'reset' : name === 'limits' ? 'inc:oilMax' : name === 'ready' ? 'toggle:gearboxReadyOn' : null },
        EXTRA[name] || {});
    const cv = new Canvas(dash.W, dash.H);
    play(rec.words(), cv);
    fs.writeFileSync(path.join(out, `${name}.png`), cv.png());
    console.log(`${name}.png: ${rec.words().length} words`);
});
