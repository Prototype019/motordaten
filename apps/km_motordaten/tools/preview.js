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

const SCENES = {
    cold: { rpm: 1180, rpmPeak: 1218, oil: 24, coolant: 37, intake: 8, charge: 12, boost: 0, boostTarget: 0, boostPeak: 0,
        oilPress: 5.6, oilPressPeak: 5.6, voltage: 14.4 },
    pull: { rpm: 6650, rpmPeak: 6950, oil: 104, coolant: 92, intake: 16, charge: 38, boost: 1.94, boostTarget: 1.98, boostPeak: 2.04,
        oilPress: 4.9, oilPressPeak: 5.9, voltage: 14.2 },
    nodme: { rpm: 860, rpmPeak: 860, oil: null, coolant: null, intake: null, charge: null, boost: null, boostTarget: null,
        boostPeak: null, oilPress: null, oilPressPeak: null, voltage: null,
        status: 'Motorsteuergerät antwortet nicht. Zündung einschalten.', statusErr: true }
};

const out = path.join(__dirname, '..', '..', '..', 'docs', 'design', 'preview');
fs.mkdirSync(out, { recursive: true });
Object.keys(SCENES).forEach((name) => {
    const rec = new Recorder(dash.W, dash.H);
    dash.draw(rec, SCENES[name], { focus: name === 'pull' });
    const cv = new Canvas(dash.W, dash.H);
    play(rec.words(), cv);
    fs.writeFileSync(path.join(out, `${name}.png`), cv.png());
    console.log(`${name}.png: ${rec.words().length} words`);
});
