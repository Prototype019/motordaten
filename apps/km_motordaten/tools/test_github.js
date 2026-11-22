'use strict';
/**
 * The Logs an GitHub page (src/dash.js githubPage, src/motordaten.js _githubAction) on a fake head unit: every phase
 * draws, its targets lie on the screen without overlapping and within the proxy buttons, every character is in the
 * font, the way there (Einstellungen › App, the Logs tab) and back, and each button reaches shared/github_logs.js.
 *
 *   node tools/test_github.js
 */
const assert = require('assert');
const EventEmitter = require('events');

process.env.KM_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'km-gh-page-'));
const cds = new EventEmitter();
function cdsProxy() {
    const f = (n) => ({ subscribe: (cb) => { cds.on(n, cb); return Promise.resolve(); } });
    return { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(), statusEngineSpeed2: f('rpm'), statusEngineTemperature: f('t') };
}
const tasu = () => ({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
    sendTasuResponse: { subscribe: () => Promise.resolve() }, sendTasuRequest: () => Promise.resolve({ TasuErrorEnum: 'NO_ERROR' }) });
const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'), require('../package/rhmiData/application.json'), {
    'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': tasu, 'de.bmw.infotainment.vehicle.CDS': cdsProxy });
const realExit = process.exit;
process.exit = () => {};
let app = null;
const { ListApp } = require('../src/screen.js');
const start = ListApp.prototype.start;
ListApp.prototype.start = function () { app = this; return start.apply(this, arguments); };
require('../src/motordaten.js');
const dash = require('../src/dash.js');
const spec = require('../spec.js');
const { Recorder } = require('../src/kit_record.js');
const fonts = require('../src/kit_fonts.js');

// every string drawn in the label font has its glyphs
function checkGlyphs(page, extra) {
    const rec = new Recorder(dash.W, dash.H);
    const realText = rec.text.bind(rec);
    rec.text = (str, x, y, size, c, opts) => {
        const f = fonts.get((opts && opts.font) || 'label', size);
        for (const ch of String(str)) assert.ok(f.glyphs[ch.codePointAt(0)], `glyph "${ch}" in "${str}"`);
        return realText(str, x, y, size, c, opts);
    };
    dash.draw(rec, page, {}, require('../src/limits.js').defaults(), { focus: null }, extra);
}

const PH = { online: true, error: null, qr: null, code: null, repo: null, repos: [], sent: null };
const PHASES = {
    off: { phase: 'off' }, offline: { phase: 'off', online: false, error: 'Keine Verbindung ins Internet' },
    code: { phase: 'code', qr: 'https://github.com/login/device', code: 'WDJB-MJHT' },
    install: { phase: 'install', qr: 'https://github.com/apps/motordaten-logs/installations/new', error: 'Kein Repository freigegeben: bitte neu verbinden' },
    pick: { phase: 'pick', repos: ['a/b1', 'a/b2', 'a/b3', 'a/b4', 'a/b5', 'a/b6'] },
    ready: { phase: 'ready', repo: 'fahrer/motordaten-logs', sent: { at: Date.now(), path: 'x' } },
    readyErr: { phase: 'ready', repo: 'fahrer/motordaten-logs', error: 'Kein Zugriff aufs Repository: GitHub-Zugang dort installiert?' },
    sending: { phase: 'sending', repo: 'fahrer/motordaten-logs' }
};

(async () => {
    await unit.wait(1500);
    assert.ok(app && app._drawn, 'drawn screens');
    Object.keys(PHASES).forEach((k) => {
        const extra = { github: Object.assign({}, PH, PHASES[k]) };
        const ts = dash.targets('github', extra);
        assert.ok(ts.length <= spec.PROXIES, `${k}: within the proxy buttons`);
        ts.forEach((t, i) => {
            assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= dash.W && t.y + t.h <= dash.H, `${k}: ${t.id} on the screen`);
            ts.slice(i + 1).forEach((u) => assert.ok(t.x + t.w <= u.x || u.x + u.w <= t.x || t.y + t.h <= u.y || u.y + u.h <= t.y,
                `${k}: ${t.id} and ${u.id} apart`));
        });
        checkGlyphs('github', extra);
    });
    assert.strictEqual(dash.targets('github', { github: Object.assign({}, PH, PHASES.pick) }).filter((t) => /^gh:pick:/.test(t.id)).length, 5, 'five at most');
    ['app', 'logs'].forEach((p) => checkGlyphs(p, {}));

    // a fake GithubLogs behind the page
    const calls = [];
    const fake = new EventEmitter();
    let st = Object.assign({}, PH, { phase: 'off' });
    Object.assign(fake, { state: () => st, connect: () => calls.push('connect'), cancel: () => calls.push('cancel'),
        disconnect: () => calls.push('disconnect'), choose: (n) => calls.push(`choose ${n}`),
        send: () => { calls.push('send'); return Promise.resolve(true); } });
    app._gh = fake;
    fake.on('change', () => app._githubShown());

    // from Einstellungen › App there and back
    app._action('menu:app');
    assert.ok(dash.targets('app').some((t) => t.id === 'page:github'));
    app._action('page:github');
    assert.strictEqual(app._drawn.page, 'github');
    assert.strictEqual(app._drawn.extra.github.phase, 'off');
    app._action('gh:connect');
    st = Object.assign({}, PH, PHASES.code);
    fake.emit('change');
    assert.strictEqual(app._drawn.extra.github.code, 'WDJB-MJHT', 'the page follows the flow');
    app._action('gh:cancel');
    st = Object.assign({}, PH, PHASES.pick);
    fake.emit('change');
    app._action('gh:pick:1');
    st = Object.assign({}, PH, PHASES.ready);
    fake.emit('change');
    app._action('gh:send');
    await unit.wait(4000);
    app._action('gh:disconnect');
    assert.deepStrictEqual(calls, ['connect', 'cancel', 'choose a/b2', 'send', 'disconnect']);
    app._action('github:back');
    assert.strictEqual(app._drawn.page, 'app', 'back where it came from');
    // from the Logs tab
    app._action('tab:logs');
    assert.ok(dash.targets('logs', app._drawn.extra).some((t) => t.id === 'page:github'), 'on the Logs tab');
    app._action('page:github');
    app._action('github:back');
    assert.strictEqual(app._drawn.page, 'logs');
    // the send was noted
    await new Promise((r) => require('../src/diag.js').flush(r));
    const log = require('fs').readFileSync(require('path').join(process.env.KM_DATA_DIR, 'diag.log'), 'utf8');
    assert.ok(/Logs an GitHub gesendet/.test(log), log);
    console.log('test_github (motordaten): ok');
    realExit(0);
})().catch((e) => { console.error(e); realExit(1); });
