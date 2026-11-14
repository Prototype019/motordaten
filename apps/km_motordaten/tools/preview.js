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
    const t0 = new Date(2026, 10, 14, 10, 42, 0).getTime();
    const r = new Logbook.Recording(t0);
    for (let t = 0; t < 6 * 60000; t += 100) {
        const s = t / 1000;
        const pull = s > 300 && s < 330;
        const rpm = pull ? 2500 + ((s - 300) % 10) * 450 : 750 + 40 * Math.sin(s / 3);
        const boost = pull ? Math.min(1.9, ((s - 300) % 10) * 0.35) : 0;
        r.sample({ rpm, torque: pull ? 400 + boost * 80 : 6, power: pull ? rpm * (400 + boost * 80) / 9549 * 1.36 : 0.5,
            boost, boostTarget: pull ? Math.min(1.95, boost + 0.05) : 0, oilPress: 1.9 + rpm / 2500, oil: 25 + s / 5,
            coolant: 40 + s / 6, intake: 12, charge: pull ? 30 + (s - 300) : 25, gearbox: 22 + s / 10, exhaust: 330 + (pull ? 400 : 0),
            voltage: 14.2 }, t0 + t);
    }
    r.stop();
    return r.name;
}

const SCENES = {
    cold: { rpm: 1180, rpmPeak: 1218, oil: 24, coolant: 37, intake: 8, charge: 12, boost: 0, boostTarget: 0, boostPeak: 0,
        oilPress: 5.6, oilPressPeak: 5.6, voltage: 14.4, gearbox: 22, exhaust: 338, torque: 4, power: 0.4 },
    pull: { rpm: 6650, rpmPeak: 6950, oil: 104, coolant: 92, intake: 16, charge: 38, boost: 1.94, boostTarget: 1.98, boostPeak: 2.04,
        oilPress: 4.9, oilPressPeak: 5.9, voltage: 14.2, gearbox: 86, exhaust: 912, torque: 548, power: 506,
        torquePeak: 560, powerPeak: 512 },
    nodme: { rpm: 860, rpmPeak: 860, oil: null, coolant: null, intake: null, charge: null, boost: null, boostTarget: null,
        boostPeak: null, oilPress: null, oilPressPeak: null, voltage: null,
        status: 'Motorsteuergerät antwortet nicht. Zündung einschalten.', statusErr: true }
};

const out = path.join(__dirname, '..', '..', '..', 'docs', 'design', 'preview');
fs.mkdirSync(out, { recursive: true });
SCENES.settings = {};
const logName = sampleLog();
const summary = Logbook.summary(logName);
const EXTRA = {
    pull: { recording: { ms: 83000 } },
    logs: { logs: [summary, Object.assign({}, summary, { start: new Date(2026, 10, 13, 18, 5) })] },
    log: { log: Logbook.load(logName), channel: 'rpm' },
    logboost: { log: Logbook.load(logName), channel: 'boost', confirmDelete: true }
};
SCENES.logs = {};
SCENES.log = {};
SCENES.logboost = {};
Object.keys(SCENES).forEach((name) => {
    const rec = new Recorder(dash.W, dash.H);
    const page = name === 'settings' ? 'settings' : name === 'logs' ? 'logs' : /^log/.test(name) ? 'log' : 'main';
    const cfg = name === 'settings' ? Object.assign(Limits.defaults(), { rpmRed: 6800, oilReady: 80 }) : Limits.defaults();
    dash.draw(rec, page, SCENES[name], cfg, { focus: name === 'pull' ? 'reset' : name === 'settings' ? 'inc:oilReady' : null },
        EXTRA[name] || {});
    const cv = new Canvas(dash.W, dash.H);
    play(rec.words(), cv);
    fs.writeFileSync(path.join(out, `${name}.png`), cv.png());
    console.log(`${name}.png: ${rec.words().length} words`);
});
