'use strict';
/**
 * The HUD app's pictures for docs/design/preview/: what the HUD gets (src/hud_draw.js) in each look, on a dark
 * road above a stand-in for BMW's bar (hud_look_<name>.png), and the app's own screens (src/dash.js) as
 * mgu-render shows them (hud_screen_<page>.png).
 *
 *   node apps/km_hudtest/tools/preview.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'km-hudprev-'));
const { Canvas } = require('../src/kit_canvas.js');
const REC = require('../src/kit_record.js');
const draw = require('../src/hud_draw.js');
const dash = require('../src/dash.js');
const S = require('../src/settings.js');
const V = require('../src/values.js');
const { Warmup } = require('../src/warmup.js');

const OUT = path.join(__dirname, '..', '..', '..', 'docs', 'design', 'preview');
const item = (key, value, s) => ({ key, label: V.byKey(key).hud, text: V.text(key, value), unit: V.byKey(key).unit, tone: V.tone(key, value, s) });
const def = S.defaults();
const LOOKS = {
    warmfahren: { mode: 'warm', label: 'Öl', value: 47 },
    bereit: { mode: 'ready', label: 'Öl', value: 82 },
    zu_heiss: { mode: 'hot', label: 'Öl', value: 134 },
    werte_eins: { mode: 'values', items: [item('oil', 96, def)] },
    werte_temperaturen: { mode: 'values', items: [item('oil', 95, def), item('gearbox', 80, def), item('intake', 30, def)] },
    werte_zwei: { mode: 'values', items: [item('oil', 105, def), item('gearbox', 100, def)] },
    werte_drei: { mode: 'values', items: [item('boost', 1.85, def), item('oil', 58, def), item('rpm', 6550, def)] }
};

function hudScene(v) {
    const pad = 40;
    const c = new Canvas(draw.HUD.w + 2 * pad, draw.HUD.h + 2 * pad + 50);
    c.gradientRect(0, 0, c.w, c.h, [[0, [34, 40, 52]], [1, [16, 18, 22]]]);
    c.blit(draw.drawHud(v), pad, pad);
    c.strokeRoundRect(pad, pad, draw.HUD.w, draw.HUD.h, 6, 1, [255, 255, 255, 50]);
    c.roundRect(pad - 20, pad + draw.HUD.h, draw.HUD.w + 40, 44, 4, [45, 91, 136, 220]);
    c.text('BMW', c.w / 2, pad + draw.HUD.h + 30, 18, [200, 214, 228], { align: 'center' });
    return c;
}

fs.mkdirSync(OUT, { recursive: true });
Object.keys(LOOKS).forEach((name) => {
    fs.writeFileSync(path.join(OUT, `hud_look_${name}.png`), hudScene(LOOKS[name]).png(9));
    fs.writeFileSync(path.join(OUT, `hud_look_${name}_gross.png`), hudScene(Object.assign({ size: 'large' }, LOOKS[name])).png(9));
});

// the screens: a car warming up with three values chosen
const cfg = Object.assign(S.defaults(), { order: ['boost', 'oil', 'rpm', 'coolant', 'oilPress', 'intake', 'gearbox', 'voltage'], count: 3 });
const v = { oil: 58, coolant: 74, rpm: 3450, boost: 1.85, oilPress: 3.2, intake: 31, gearbox: 61, voltage: 14.2 };
const w = new Warmup();
v.view = w.view(v, cfg, 0);
v.words = w.words(v.view, cfg, v);
v.rows = [['Renderer', 'verbunden (id8)'], ['Renderer sagt', '–'], ['Ziele des Renderers', 'map:874x749, hud:353x203'], ['HUD', 'angezeigt'],
    ['HUD-Platz', 'angezeigt, hält: wir'], ['Bilder ans HUD', '42'], ['Abgelehnt', '–'], ['Quelle', 'Fahrzeugsignal'],
    ['Fahrzeugsignal', 'verbunden, 318 Werte'], ['DME-Antworten', '0']];
const extra = { order: cfg.order, count: cfg.count, mode: cfg.mode };
['main', 'values', 'display', 'ready', 'status'].forEach((page) => {
    const rec = new REC.Recorder(dash.W, dash.H);
    dash.draw(rec, page, v, cfg, { focus: null }, extra);
    const c = new Canvas(dash.W, dash.H);
    REC.play(rec.words(), c);
    fs.writeFileSync(path.join(OUT, `hud_screen_${page}.png`), c.png(9));
});
// Logs an GitHub: each phase
const GH = require('../src/github_logs.js');
const ghBase = { error: null, online: true, qr: null, code: null, repo: null, repos: [], sent: null };
const GITHUB = {
    off: { phase: 'off' },
    code: { phase: 'code', qr: GH.DEVICE_URL, code: 'WDJB-MJHT' },
    install: { phase: 'install', qr: GH.INSTALL_URL },
    pick: { phase: 'pick', repos: ['kevin/g31-logs', 'kevin/auto-notizen', 'kevin/werkstatt'] },
    ready: { phase: 'ready', repo: 'kevin/g31-logs', sent: { at: Date.UTC(2026, 10, 22, 14, 32), path: 'km_hudtest/x.log' } }
};
Object.keys(GITHUB).forEach((name) => {
    const rec = new REC.Recorder(dash.W, dash.H);
    dash.draw(rec, 'github', v, cfg, { focus: null }, Object.assign({}, extra, { github: Object.assign({}, ghBase, GITHUB[name]) }));
    const c = new Canvas(dash.W, dash.H);
    REC.play(rec.words(), c);
    fs.writeFileSync(path.join(OUT, `hud_screen_github_${name}.png`), c.png(9));
});
console.log(`preview: ${Object.keys(LOOKS).length + 5 + Object.keys(GITHUB).length} pictures in ${path.relative(process.cwd(), OUT)}`);
