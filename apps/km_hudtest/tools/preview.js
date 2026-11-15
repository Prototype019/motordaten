'use strict';
/**
 * Draws what the HUD gets (src/hud_draw.js) for a few oil temperatures, as
 * docs/design/preview/hudtest_hud_<scene>.png: the HUD's 353 x 203 on a dark
 * road (the HUD shows light only), its edge outlined, above a stand-in for
 * BMW's speed bar.
 *
 *   node apps/km_hudtest/tools/preview.js
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require('../src/kit_canvas.js');
const draw = require('../src/hud_draw.js');

const OUT = path.join(__dirname, '..', '..', '..', 'docs', 'design', 'preview');
const SCENES = { kalt: { oil: 38 }, warm: { oil: 96 }, heiss: { oil: 134 }, keine_daten: { oil: null } };

function hudScene(v) {
    const pad = 40;
    const c = new Canvas(draw.HUD.w + 2 * pad, draw.HUD.h + 2 * pad + 50);
    c.gradientRect(0, 0, c.w, c.h, [[0, [34, 40, 52]], [1, [16, 18, 22]]]);
    c.blit(draw.drawHud(v), pad, pad);
    c.strokeRoundRect(pad, pad, draw.HUD.w, draw.HUD.h, 6, 1, [255, 255, 255, 50]);
    c.text('128 km/h   ·   Tempolimit 130', c.w / 2, pad + draw.HUD.h + 38, 24, [180, 190, 200], { align: 'center' });
    return c;
}

fs.mkdirSync(OUT, { recursive: true });
Object.keys(SCENES).forEach((name) => {
    fs.writeFileSync(path.join(OUT, `hudtest_hud_${name}.png`), hudScene(SCENES[name]).png(9));
});
console.log(`preview: ${Object.keys(SCENES).length} pictures in ${path.relative(process.cwd(), OUT)}`);
