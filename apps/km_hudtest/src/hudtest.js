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
const { Tasu, EGS } = require('./tasu.js');
const D = require('./decode.js');
const { HudLink } = require('./hud_link.js');
const { Drawn } = require('./drawn.js');
const S = require('./settings.js');
const V = require('./values.js');
const { Warmup, testView, TEST, TEST_STEP_MS } = require('./warmup.js');
const Diag = require('./diag.js');
const { GithubLogs } = require('./github_logs.js');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const LIST = 'ST_OnlineApps_HudTest';
const LAYER = 'ST_OnlineApps_HudTestLayer';
const PROXIES = 24;             // the host state's proxy buttons (spec.js PROXIES)
const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
/* CDS temperatures: raw - 48 = °C, 255 = no value; engine speed raw * 0.25, 65535 = no value (as Motordaten). */
const TEMP_INVALID = 255;
const RPM_INVALID = 65535;
const ENGINE_STOPPED_RPM = 200;
/* At start, how long the signal gets for its first value before the DME is asked. */
const CDS_FIRST_MS = 3000;
/* One round through the gateway every POLL_MS at most, only for what the HUD needs from it (src/values.js src). */
const POLL_MS = 1000;
const TIMEOUT_MS = 1500;
const REOPEN_MS = 5000;
/* A value read through the gateway keeps its last reading this long when an answer is missing. */
const HOLD_MS = 4000;
/* The DME's identifiers per value; boost and oil pressure come absolute, the ambient pressure (hPa) is taken off. */
const DME_DIDS = { oil: [0x5822], boost: [0x4205, 0x4201], oilPress: [0x4436, 0x4201], intake: [0x580F] };

/* The app's version, read from the package beside the app (the unit builds only from app modules). */
const VERSION = (() => {
    try {
        return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8')).version;
    } catch (e) {
        return '?';
    }
})();

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
        this._v = {};                   // oil, coolant, rpm (the car's signal); boost, oilPress, intake, gearbox, voltage
        this._at = {};                  // when each value read through the gateway last came
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
        this._lastMode = null;           // the mode before Aus (the list button brings it back)
        this._page = 'main';             // the drawn page open (Ausrichten shows the alignment picture)
        this._layerState = null;
        this._proxies = [];
        this._noted = { link: null, diag: null };      // what the notebook (diag.log) last heard of the link and the reads
        this._gh = new GithubLogs({
            dir: Diag.dir(), app: 'km_hudtest',
            files: () => Diag.files().map((name) => ({ name, file: require('path').join(Diag.dir(), name) })),
            header: () => this._ghHeader()
        });
        this._gh.on('change', () => this._ghChanged());
        this._hud.on('change', () => this._render());
        this._timer = setInterval(() => this._tick(), 500);
    }

    /* Once at start: the link, the signal, the rounds, the screens. Then the list screen's button: Aus / back. */
    run() {
        if (!this._started) {
            this._started = true;
            Diag.note(`Läuft: ${this.rhmiApplication ? 'mit Bildschirmen' : 'ohne Bildschirme'}, ` +
                `Kachel ${this._frame && this._frame.tile ? 'da' : 'fehlt'}, ${this.isVisible() ? 'vorne' : 'im Hintergrund'}`);
            this._startedAt = Date.now();
            this._hud.show(false);
            this._hud.start();
            this._subscribe();
            this._loop();
            this._startDrawn();
        } else {
            // Aus, and back to what it was before
            this._choose('mode', this._settings.mode === 'off' ? (this._lastMode || S.defaults().mode) : 'off');
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
        this._ghChanged();
        this._drawn.on('mode', (mode) => this.useEntryState(mode === 'layer' ? LAYER : LIST));
        this._drawn.on('action', (id) => this._action(id));
        this._drawn.on('targets', (targets) => this._proxiesFor(targets));
        // a value card dragged to another place on the Werte page
        this._drawn.on('order', (order, key) => this._set(S.dropped(this._settings, order, key)));
        this._extra();
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
        if (id.indexOf('tab:') === 0 || id.indexOf('page:') === 0) {
            this._page = id.slice(id.indexOf(':') + 1);
            if (d) d.setPage(this._page);
        } else if (id === 'align:defaults') {
            const def = S.defaults();
            const back = {};
            S.ALIGN.forEach((k) => { back[k] = def[k]; });
            this._set(Object.assign({}, this._settings, back));
        } else if (id.indexOf('cell:') === 0) {
            // the controller's focus stays on the place it was pressed at (its proxy button), not on the card
            // that moved away from it
            const before = d ? require('./dash.js').targets(d.page, d.extra).findIndex((t) => t.id === id) : -1;
            this._set(S.tapped(this._settings, id.slice(5)));
            if (d && before >= 0 && d.ui.focus === id) {
                const t = require('./dash.js').targets(d.page, d.extra)[before];
                d.ui.focus = t ? t.id : null;
                d.invalidate();
            }
        } else if (id.indexOf('choose:') === 0) {
            const parts = id.split(':');
            this._choose(parts[1], parts[2]);
        } else if (id.indexOf('toggle:') === 0) {
            this._set(S.toggled(this._settings, id.slice(7)));
        } else if (/^(dec|inc):/.test(id)) {
            this._set(S.stepped(this._settings, id.slice(4), id.indexOf('inc:') === 0 ? 1 : -1));
        } else if (id === 'defaults') {
            // the page's numbers and switches back; what, where, how large and the chosen values stay
            const keep = { order: this._settings.order, count: this._settings.count };
            Object.keys(S.CHOICES).forEach((k) => { keep[k] = this._settings[k]; });
            this._set(Object.assign(S.defaults(), keep));
        } else if (id === 'test') {
            this._test = this._test ? 0 : Date.now();
            logger.info(this._test ? 'HUD test started' : 'HUD test stopped');
        } else if (id.indexOf('gh:') === 0) {
            this._github(id.slice(3));
        } else if (id === 'reconnect') {
            this._hud.stop();
            this._hud.start();
        }
        this._tick();
    }

    /* The page Logs an GitHub: its buttons (src/github_logs.js; connect never waited for, it may take minutes). */
    _github(what) {
        const gh = this._gh;
        if (what === 'connect') {
            gh.connect();
        } else if (what === 'cancel') {
            gh.cancel();
        } else if (what.indexOf('choose:') === 0) {
            gh.choose(what.slice(7));
        } else if (what === 'send') {
            // the notebook written out first, so the send has the newest lines
            Diag.note('Logs an GitHub: Senden');
            Diag.flush(() => gh.send());
        } else if (what === 'disconnect') {
            gh.disconnect();
        }
    }

    _ghChanged() {
        if (this._drawn) this._drawn.setExtra({ github: this._gh.state() });
    }

    /* The lines on top of the file sent to GitHub. */
    _ghHeader() {
        const s = this._settings;
        const m = process.memoryUsage();
        return [`HUD ${VERSION}`, `Laufzeit: ${Math.round(process.uptime() / 60)} min`,
            `Speicher: ${Math.round(m.rss / 1048576)} MB (Heap ${Math.round(m.heapUsed / 1048576)} MB)`,
            `Anzeige: ${S.CHOICES.mode.words[s.mode]}; Werte im HUD: ${S.shown(s).join(', ')}`,
            `Ausrichtung: Neigung ${s.tilt}, Versatz ${s.shiftX}, Höhe ${s.height}, Breite ${s.width}`].join('\n');
    }

    /* What the notebook hears of the renderer link and the diagnosis reads: only when it changes. */
    _noteStates() {
        const h = this._hud;
        const link = `${h.conn}${h.backend ? ` (${h.backend})` : ''}`;
        const why = (h.why() || '').replace(/seit \d+ s/, 'seit einer Weile');
        const linkKey = `${link}|${why}`;
        if (this._noted.link !== linkKey) {
            const first = this._noted.link === null;
            this._noted.link = linkKey;
            if (!first || h.conn !== 'aus') Diag.note(`HUD-Verbindung: ${link}${why ? `: ${why}` : ''}`);
        }
        const diagKey = this._needs().length ? `${this._gateway}|${this._gatewayError}` : 'nicht gebraucht';
        if (this._noted.diag !== diagKey) {
            const before = this._noted.diag;
            this._noted.diag = diagKey;
            const bad = this._gateway === 'failed' || !!this._gatewayError;
            if (bad) Diag.note(`Diagnose: ${this._gateway === 'failed' ? 'Gateway nicht geöffnet' : 'Motor'}: ${this._gatewayError || '-'}`);
            else if (before && /\|./.test(before)) Diag.note('Diagnose: wieder in Ordnung');
        }
    }

    _choose(key, word) {
        // the mode before Aus, however Aus was chosen
        if (key === 'mode' && word === 'off' && this._settings.mode !== 'off') this._lastMode = this._settings.mode;
        this._set(S.chosen(this._settings, key, word));
    }

    _set(s) {
        if (s.mode !== this._settings.mode) Diag.note(`Anzeige: ${S.CHOICES.mode.words[s.mode]}`);
        this._settings = s;
        if (!S.save(s)) logger.warn('settings not saved');
        if (this._drawn) {
            this._drawn.setLimits(s);
            this._extra();
        }
        this._tick();
    }

    /* What the Werte page's targets follow: the order, how many are shown, the mode. */
    _extra() {
        const s = this._settings;
        this._drawn.setExtra({ order: S.cleanOrder(s.order), count: s.count, mode: s.mode });
    }

    /* ---- what the HUD shows ---- */

    /* Every half second and on every change: what the HUD shows, and the screens. */
    _tick() {
        if (this._page === 'github') this._ghChanged();      // the phone's internet comes and goes
        if (this._stopped) return;
        const now = Date.now();
        let view = this._warmup.view(this._v, this._settings, now);
        // Ausrichten open (and the app in front): the alignment picture, whatever else
        if (this._page === 'align' && this.isVisible()) {
            view = { mode: 'grid' };
        } else if (this._test) {
            const t = testView(this._test, now);
            if (t) {
                view = t;
            } else {
                this._test = 0;
            }
        }
        this._view = view;
        if (view) {
            // coming on: drawn at once, so the HUD never shows what it had before
            const on = this._hud.isOn();
            this._hud.update(Object.assign({}, view, { pos: this._settings.pos, size: this._settings.size,
                cal: S.correction(this._settings) }), !on);
            if (!on) this._hud.show(true);
        } else if (this._hud.isOn()) {
            this._hud.show(false);
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
            // the engine speed on its own: a car without it still gets its temperatures
            .then(() => Promise.resolve().then(() => proxy.statusEngineSpeed2.subscribe((v) => {
                if (this._stopped) return;
                const raw = v && v.actualValueRPMEngineCrankshaft;
                const rpm = isNum(raw) && raw !== RPM_INVALID ? raw * 0.25 : null;
                this._v.rpm = rpm !== null && rpm < ENGINE_STOPPED_RPM ? 0 : rpm;
                // the HUD's numbers follow at its own pace (src/hud_link.js draws at most every 250 ms)
                if (this._view && this._view.mode === 'values') this._tick();
            })).catch((e) => logger.warn(`engine speed: ${e && e.message}`)))
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

    /* What the HUD needs through the gateway now: the oil when the signal has none (warm-up or shown), and the
     * gateway values shown under Werte. */
    _needs() {
        const s = this._settings;
        if (s.mode === 'off') return [];
        const out = s.mode === 'values' ? S.shown(s).filter((k) => V.byKey(k).src !== 'cds') : [];
        // the oil when the signal has none: warming up, shown, or for the hot warning in Werte
        if (!this._cdsFresh()) out.unshift('oil');
        return out;
    }

    _ask() {
        const needs = this._needs();
        // nothing needed: the gateway stays free for Motordaten
        if (!needs.length) return Promise.resolve();
        if (!/^fehlt/.test(this._cds) && Date.now() - this._startedAt < CDS_FIRST_MS) return Promise.resolve();
        if (this._gateway !== 'open') {
            if (this._gateway === 'failed' && Date.now() - this._lastOpen < REOPEN_MS) return Promise.resolve();
            this._lastOpen = Date.now();
            return this._tasu.open()
                .then(() => { this._gateway = 'open'; this._gatewayError = ''; return this._read(needs); },
                    (e) => { this._gateway = 'failed'; this._gatewayError = e.message; this._render(); });
        }
        return this._read(needs);
    }

    /* One request to the DME for what it holds, then the gearbox and the supply voltage if wanted. */
    _read(needs) {
        const dids = [];
        needs.forEach((k) => (DME_DIDS[k] || []).forEach((id) => { if (dids.indexOf(id) < 0) dids.push(id); }));
        let p = Promise.resolve();
        if (dids.length) {
            p = p.then(() => this._tasu.request(0x22, [].concat(...dids.map((id) => [id >> 8, id & 0xFF])), TIMEOUT_MS)).then((u) => {
                const got = D.didNumbers(dids.map((id) => D.didById(id)), u) || {};
                const ambient = isNum(got[0x4201]) ? got[0x4201] / 1000 : null;          // hPa -> bar
                const above = (abs) => (isNum(abs) && ambient !== null ? abs - ambient : null);
                if (needs.indexOf('oil') >= 0 && !this._cdsFresh()) this._keep('oil', got[0x5822]);
                if (needs.indexOf('boost') >= 0) this._keep('boost', above(got[0x4205]));
                if (needs.indexOf('oilPress') >= 0) this._keep('oilPress', above(got[0x4436]));
                if (needs.indexOf('intake') >= 0) this._keep('intake', got[0x580F]);
                this._answer(u, Object.keys(got).length);
            }, (e) => { needs.forEach((k) => { if (DME_DIDS[k]) this._keep(k, null); }); this._gatewayError = e.message; });
        }
        if (needs.indexOf('gearbox') >= 0) {
            p = p.then(() => this._tasu.request(0x22, [0x60, 0x00], TIMEOUT_MS, EGS))
                .then((u) => { this._keep('gearbox', D.didNumber(D.didById(0x6000), u)); this._answer(u, 1); },
                    (e) => { this._keep('gearbox', null); this._gatewayError = e.message; });
        }
        if (needs.indexOf('voltage') >= 0) {
            p = p.then(() => this._tasu.request(0x01, [0x42], TIMEOUT_MS))
                .then((u) => { this._keep('voltage', D.obdNumber(D.pidById(0x42), u)); this._answer(u, 1); },
                    (e) => { this._keep('voltage', null); this._gatewayError = e.message; });
        }
        return p.then(() => this._tick());
    }

    /* An answer: counted, or its refusal kept for the status line. */
    _answer(u, n) {
        if (!u) {
            this._gatewayError = 'keine Antwort';
        } else if (u[0] === 0x7F) {
            this._gatewayError = D.NRC[u[2]] || D.hex(u[2]);
        } else if (n) {
            this._gatewayError = '';
            this._answers++;
        }
    }

    /* A new value, or none: then the last one stays for HOLD_MS. */
    _keep(key, value) {
        const now = Date.now();
        if (isNum(value)) {
            this._v[key] = value;
            this._at[key] = now;
        } else if (!(now - (this._at[key] || 0) < HOLD_MS)) {
            this._v[key] = null;
        }
    }

    /* ---- the screens ---- */

    _status() {
        const h = this._hud;
        if (!h.installed() && h.conn !== 'verbunden') return 'Cluster renderer fehlt: HUD im Store neu installieren (bringt ihn mit), dann Neustart';
        if (h.conn !== 'verbunden') return h.why() || `Renderer: ${h.conn}`;
        if (h.backend && h.backend !== 'id8') return `Renderer läuft als ${h.backend}, erwartet id8`;
        if (this._needs().length) {
            if (this._gateway === 'failed') return `Diagnose: ${this._gatewayError}`;
            if (this._gatewayError) return `Motor antwortet nicht: ${this._gatewayError}`;
        }
        return '';
    }

    _source() {
        const gw = this._needs().filter((k) => k !== 'oil');
        const oil = this._cdsFresh() ? 'Fahrzeugsignal' : this._gateway === 'wait' ? '–' : 'Öl über Diagnose (Signal fehlt)';
        return gw.length ? `${oil}; Diagnose: ${gw.map((k) => V.byKey(k).label).join(', ')}` : oil;
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
        return Object.assign({}, this._v, { view: this._view, words, testing: !!this._test, source: this._source(), rows });
    }

    _render() {
        this._noteStates();
        const sv = this.screenValues();
        const words = sv.words;
        const rows = sv.rows;
        if (this._drawn) this._drawn.set(sv);
        // the list screen (no drawn screens): where it stands first, iDrive 8 does not show the status line
        const stand = `${words.title}${words.text ? ` – ${words.text}` : ''}`;
        this.show(stand, [['Stand', stand], ['Öl', fmt(this._v.oil, '°C', 0)], ['Kühlmittel', fmt(this._v.coolant, '°C', 0)],
            ['Anzeige', S.CHOICES.mode.words[this._settings.mode]],
            ['Im HUD', S.shown(this._settings).map((k) => `${V.byKey(k).label} ${V.text(k, this._v[k])}`).join(', ')]].concat(rows));
    }
}

/* An error nobody caught: noted (diag.log) and the app goes on. */
process.on('uncaughtException', (e) => {
    logger.error(`uncaught: ${e && e.stack}`);
    Diag.note(`Fehler abgefangen: ${String(e && e.stack).split('\n').slice(0, 4).join(' | ')}`);
});
process.on('unhandledRejection', (e) => {
    logger.warn(`unhandled rejection: ${e && e.message}`);
    Diag.note(`Promise abgelehnt: ${e && e.message}`);
});

Diag.note(`Start ${VERSION}`);
// memory once a minute in the notebook: MainApp ends an app past its memoryThresholdKB
setInterval(() => {
    const m = process.memoryUsage();
    Diag.note(`Speicher ${Math.round(m.rss / 1048576)} MB (Heap ${Math.round(m.heapUsed / 1048576)} MB)`);
}, 60000).unref();

const app = new HudApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`hud failed to start: ${err && err.message}`);
});
