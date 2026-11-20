'use strict';
/**
 * HUD: the warm-up and the oil temperature on the head-up display of the G87 (iDrive 8), through
 * cluster-render (src/hud_link.js), with its own screens in Motordaten's look (src/dash.js, drawn by
 * mgu-render through src/drawn.js; the list screen where no renderer answers).
 *
 * What the HUD shows: src/warmup.js, from the settings (src/settings.js: Warmfahren / Immer / Aus, where, how
 * large, which temperatures count for ready). "Im HUD testen" shows each look for a few seconds.
 *
 * Read-only. Oil and coolant come from the car's own signal (CDS statusEngineTemperature), so nothing goes
 * on the diagnostic gateway that Motordaten uses. Only while the signal has no oil value (none yet, or 255)
 * does it fall back to one 22 request to the DME every POLL_MS (5822, src/decode.js), as tester 0xF4
 * through the head unit's gateway (src/tasu.js). Nothing is written to any unit. It keeps reading while
 * the app is not in front: that is what a HUD is for.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const { ListApp, logger } = require('./screen.js');
const { Tasu } = require('./tasu.js');
const D = require('./decode.js');
const { HudLink } = require('./hud_link.js');
const { Drawn } = require('./drawn.js');
const S = require('./settings.js');
const { Warmup, testView, TEST, TEST_STEP_MS } = require('./warmup.js');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const LIST = 'ST_OnlineApps_HudTest';
const LAYER = 'ST_OnlineApps_HudTestLayer';
const PROXIES = 24;             // the host state's proxy buttons (spec.js PROXIES)
const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
/* CDS temperatures: raw - 48 = °C, 255 = no value (as Motordaten). */
const TEMP_INVALID = 255;
/* At start, how long the signal gets for its first value before the DME is asked. */
const CDS_FIRST_MS = 3000;
const POLL_MS = 1000;
const TIMEOUT_MS = 1500;
const REOPEN_MS = 5000;
const ASK = [['oil', 0x5822]];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isTrue = (raw) => raw === true || raw === 'true' || raw === 1 || raw === '1';
const fmt = (v, u, d) => (isNum(v) ? `${v.toFixed(d).replace('.', ',')} ${u}` : '–');

class HudApp extends ListApp {
    constructor() {
        super({ root: LIST, prefix: 'ht' });
        this._tasu = new Tasu(logger);
        this._hud = new HudLink();
        this._settings = S.load();
        this._warmup = new Warmup();
        this._view = null;              // what the HUD shows now (src/warmup.js)
        this._test = 0;                 // when "Im HUD testen" started (0: not testing)
        this._v = {};                   // oil, coolant
        this._gateway = 'wait';         // wait | open | failed
        this._gatewayError = '';
        this._lastOpen = 0;
        this._answers = 0;
        this._cds = 'wartet';           // wartet | verbunden | fehlt: <why>
        this._cdsOil = null;
        this._cdsCount = 0;
        this._started = false;
        this._startedAt = 0;
        this._stopped = false;
        this._poll = null;
        this._drawn = null;
        this._layerState = null;
        this._proxies = [];
        this._hud.on('change', () => this._render());
        this._timer = setInterval(() => this._tick(), 500);
    }

    /* Once at start: the link, the signal, the rounds, the screens. Then the list screen's button: Aus / back. */
    run() {
        if (!this._started) {
            this._started = true;
            this._startedAt = Date.now();
            this._hud.on(false);
            this._hud.start();
            this._subscribe();
            this._loop();
            this._startDrawn();
        } else {
            this._choose('mode', this._settings.mode === 'off' ? S.defaults().mode : 'off');
        }
        this._tick();
    }

    stop() {
        this._stopped = true;
        clearInterval(this._timer);
        clearTimeout(this._poll);
        this._poll = null;
        this._hud.stop();
        if (this._drawn) this._drawn.close();
    }

    visibilityChanged(visible) {
        if (visible && this._drawn && this._drawn.mode === 'layer' && this.entryState() === LAYER) {
            this._drawn.hostVisible(true);
            if (this._hostTold) this._hostTold();
        }
    }

    /* ---- the drawn screens (as Motordaten: a host state whose proxy buttons stand for the page's targets) ---- */

    bind(rhmi) {
        this._layerState = rhmi.getByName(LAYER);
        if (!this._layerState) {
            logger.warn(`${LAYER} missing: list screen only`);
            return;
        }
        const host = { list: { v: false, f: true }, layer: { v: false, f: true } };
        let told = { v: null, f: null };
        const tell = () => {
            const d = this._drawn;
            if (!d) return;
            const v = host.list.v || host.layer.v;
            const f = (host.list.v && host.list.f) || (host.layer.v && host.layer.f);
            if (v !== told.v) d.hostVisible(v);
            if (!v || f !== told.f) d.hostFocus(f);
            told = { v, f };
        };
        const watch = (state, key) => {
            state.on('visible', (ev) => {
                host[key].v = isTrue(ev && ev.visible);
                if (host[key].v) host[key].f = true;
                tell();
            });
            state.on('focus', (ev) => { host[key].f = isTrue(ev && ev.focus); tell(); });
        };
        watch(this._layerState, 'layer');
        const listState = rhmi.getByName(LIST);
        if (listState) watch(listState, 'list');
        this._hostTold = () => { told = { v: null, f: null }; };
        for (let i = 0; i < PROXIES; i++) {
            const b = rhmi.getByName(`htLayerP${i}`);
            this._proxies.push(b);
            if (b) {
                b.on('action', () => this._drawn && this._drawn.proxyPress(i));
                b.on('focus', (ev) => this._drawn && this._drawn.proxyFocus(i, isTrue(ev && ev.value)));
            }
        }
    }

    _startDrawn() {
        if (!this._layerState) return;
        this._drawn = new Drawn(this.getAppId(), logger);
        this._drawn.setLimits(this._settings);
        this._drawn.on('mode', (mode) => this.useEntryState(mode === 'layer' ? LAYER : LIST));
        this._drawn.on('action', (id) => this._action(id));
        this._drawn.on('targets', (targets) => this._proxiesFor(targets));
        this._proxiesFor(require('./dash.js').targets('main'));
        this._drawn.connect();
    }

    /* The proxy buttons follow the page's targets: one shown per target, no words (the layer covers them). */
    _proxiesFor(targets) {
        this._proxies.forEach((b, i) => {
            if (!b) return;
            const t = targets[i];
            Promise.resolve()
                .then(() => b.setProperty('Visible', t ? 1 : 0, 'UInt'))
                .then(() => (t ? b.setValue(0, 'PrimaryText', ' ', 'Text') : undefined))
                .catch((err) => logger.warn(`proxy ${i}: ${err && err.message}`));
        });
    }

    /* A press on the drawn screens. */
    _action(id) {
        const d = this._drawn;
        if (id.indexOf('tab:') === 0) {
            if (d) d.setPage(id.slice(4));
        } else if (id.indexOf('choose:') === 0) {
            const parts = id.split(':');
            this._choose(parts[1], parts[2]);
        } else if (id.indexOf('toggle:') === 0) {
            this._set(S.toggled(this._settings, id.slice(7)));
        } else if (/^(dec|inc):/.test(id)) {
            this._set(S.stepped(this._settings, id.slice(4), id.indexOf('inc:') === 0 ? 1 : -1));
        } else if (id === 'defaults') {
            // the page's numbers and switches back; what, where and how large stay
            const keep = {};
            Object.keys(S.CHOICES).forEach((k) => { keep[k] = this._settings[k]; });
            this._set(Object.assign(S.defaults(), keep));
        } else if (id === 'test') {
            this._test = this._test ? 0 : Date.now();
            logger.info(this._test ? 'HUD test started' : 'HUD test stopped');
        } else if (id === 'reconnect') {
            this._hud.stop();
            this._hud.start();
        }
        this._tick();
    }

    _choose(key, word) {
        this._set(S.chosen(this._settings, key, word));
    }

    _set(s) {
        this._settings = s;
        if (!S.save(s)) logger.warn('settings not saved');
        if (this._drawn) this._drawn.setLimits(s);
        this._tick();
    }

    /* ---- what the HUD shows ---- */

    /* Every half second and on every change: what the HUD shows, and the screens. */
    _tick() {
        if (this._stopped) return;
        const now = Date.now();
        let view = this._warmup.view(this._v, this._settings, now);
        if (this._test) {
            const t = testView(this._test, now);
            if (t) {
                view = t;
            } else {
                this._test = 0;
            }
        }
        this._view = view;
        if (view) {
            this._hud.update(Object.assign({}, view, { pos: this._settings.pos, size: this._settings.size }));
            if (!this._hud.isOn()) this._hud.on(true);
        } else if (this._hud.isOn()) {
            this._hud.on(false);
        }
        this._render();
    }

    /* ---- the values ---- */

    _subscribe() {
        let proxy;
        new Promise((resolve) => setImmediate(resolve))
            .then(() => someipBuilders.buildTypedProxy(IF_CDS, '1'))
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => proxy.statusEngineTemperature.subscribe((v) => {
                if (this._stopped) return;
                const t = (raw) => (isNum(raw) && raw !== TEMP_INVALID ? raw - 48 : null);
                this._cdsOil = t(v && v.temperatureEngineOilDrive);
                const coolant = t(v && v.temperatureEngineDrive);
                if (coolant !== null) this._v.coolant = coolant;
                if (this._cdsOil !== null) {
                    this._cdsCount++;
                    this._v.oil = this._cdsOil;
                }
                this._tick();
            }))
            .then(() => { this._cds = 'verbunden'; logger.info('CDS subscribed'); this._render(); })
            .catch((err) => { this._cds = `fehlt: ${err && err.message}`; logger.warn(`CDS unavailable: ${err && err.message}`); this._render(); });
    }

    /* Whether the signal's last oil value is a temperature (a signal is sent when it changes). */
    _cdsFresh() {
        return this._cdsOil !== null;
    }

    /* One round, then the next POLL_MS after it started. */
    _loop() {
        if (this._stopped) {
            this._poll = null;
            return;
        }
        const started = Date.now();
        this._poll = -1;
        this._ask().catch((e) => logger.warn(`round: ${e && e.message}`)).then(() => {
            if (this._stopped) return;
            this._poll = setTimeout(() => this._loop(), Math.max(0, POLL_MS - (Date.now() - started)));
        });
    }

    _ask() {
        // the signal has the value, or the HUD shows nothing anyway: the gateway stays free for Motordaten
        if (this._cdsFresh() || this._settings.mode === 'off') return Promise.resolve();
        if (!/^fehlt/.test(this._cds) && Date.now() - this._startedAt < CDS_FIRST_MS) return Promise.resolve();
        if (this._gateway !== 'open') {
            if (this._gateway === 'failed' && Date.now() - this._lastOpen < REOPEN_MS) return Promise.resolve();
            this._lastOpen = Date.now();
            return this._tasu.open()
                .then(() => { this._gateway = 'open'; this._gatewayError = ''; return this._read(); },
                    (e) => { this._gateway = 'failed'; this._gatewayError = e.message; this._render(); });
        }
        return this._read();
    }

    _read() {
        const dids = ASK.map((kv) => D.didById(kv[1]));
        const data = [].concat(...ASK.map((kv) => [kv[1] >> 8, kv[1] & 0xFF]));
        return this._tasu.request(0x22, data, TIMEOUT_MS).then((u) => {
            const got = D.didNumbers(dids, u) || {};
            if (this._cdsFresh()) return;           // the signal came meanwhile: it wins
            ASK.forEach((kv) => { this._v[kv[0]] = isNum(got[kv[1]]) ? got[kv[1]] : null; });
            if (!u) {
                this._gatewayError = 'keine Antwort';
            } else if (u[0] === 0x7F) {
                this._gatewayError = D.NRC[u[2]] || D.hex(u[2]);
            } else if (Object.keys(got).length) {
                this._gatewayError = '';
                this._answers++;
            }
            this._tick();
        }, (e) => {
            if (!this._cdsFresh()) ASK.forEach((kv) => { this._v[kv[0]] = null; });
            this._gatewayError = e.message;
            this._tick();
        });
    }

    /* ---- the screens ---- */

    _status() {
        const h = this._hud;
        if (!h.installed() && h.conn !== 'verbunden') return 'Cluster renderer fehlt: HUD im Store neu installieren (bringt ihn mit), dann Neustart';
        if (h.conn !== 'verbunden') return h.why() || `Renderer: ${h.conn}`;
        if (h.backend && h.backend !== 'id8') return `Renderer läuft als ${h.backend}, erwartet id8`;
        if (!this._cdsFresh() && this._settings.mode !== 'off') {
            if (this._gateway === 'failed') return `Diagnose: ${this._gatewayError}`;
            if (this._gatewayError) return `DME: ${this._gatewayError}`;
        }
        return '';
    }

    _source() {
        return this._cdsFresh() ? 'Fahrzeugsignal' : this._gateway === 'wait' ? '–' : 'DME (Signal fehlt)';
    }

    /* What the drawn screens show (src/dash.js draw's v). */
    screenValues() {
        const problem = this._status();
        const words = problem ? { title: 'HUD nicht erreichbar', text: problem } : this._warmup.words(this._view, this._settings, this._v);
        if (this._test && !problem) {
            const i = Math.min(TEST.length - 1, Math.floor((Date.now() - this._test) / TEST_STEP_MS));
            Object.assign(words, { title: 'Test im HUD', text: `${i + 1} von ${TEST.length}: so sieht es im HUD aus.` });
        }
        const rows = this._hud.rows().concat([
            ['Quelle', this._source()],
            ['Fahrzeugsignal', `${this._cds}, ${this._cdsCount} Werte`],
            ['DME-Antworten', String(this._answers)]
        ]);
        return { oil: this._v.oil, coolant: this._v.coolant, view: this._view, words, testing: !!this._test,
            source: this._source(), rows };
    }

    _render() {
        const sv = this.screenValues();
        const words = sv.words;
        const rows = sv.rows;
        if (this._drawn) this._drawn.set(sv);
        // the list screen (no drawn screens): where it stands first, iDrive 8 does not show the status line
        const stand = `${words.title}${words.text ? ` – ${words.text}` : ''}`;
        this.show(stand, [['Stand', stand], ['Öl', fmt(this._v.oil, '°C', 0)], ['Kühlmittel', fmt(this._v.coolant, '°C', 0)],
            ['Anzeige', S.CHOICES.mode.words[this._settings.mode]]].concat(rows));
    }
}

process.on('uncaughtException', (e) => logger.error(`uncaught: ${e && e.stack}`));
process.on('unhandledRejection', (e) => logger.warn(`unhandled rejection: ${e && e.message}`));

const app = new HudApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`hud failed to start: ${err && err.message}`);
});
