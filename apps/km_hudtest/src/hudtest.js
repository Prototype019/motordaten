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
const IF_VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const IF_CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const IF_GUIDANCE = 'de.bmw.infotainment.navigation.guiding.Guidance';
/* The KOMBI now and then gives our picture only a part of the HUD (the renderer's log: "content 43204012: canvas
 * 353x203, rect 353x128@0,75") while it shows something of its own there, and the whole again afterwards; our
 * picture is not scaled into the part, so the two lie over each other. The renderer does not tell its clients, so
 * its log (readable by all) is followed: with less than the whole, our picture stays empty (the layer stays
 * offered: hidden, the KOMBI would stop telling). BMW's signals know nothing of a route in CarPlay; this may. */
const fs = require('fs');
const Probe = require('./probe.js');
const CR_LOG = process.env.KM_CR_LOG || '/var/opt/cluster-render/log/cluster-render.log';
const CR_HUD_CONTENT = '43204012';
const ROOM_MS = 400;
const IF_CARPLAY = 'de.bmw.infotainment.a4a.carplay.CarPlayManager';
const IF_AAUTO = 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager';
const IF_ROUTING = 'de.bmw.infotainment.navigation.routing.Routing';
const SPEED_FACTOR = 0.015625;   // statusCarSpeed2.speedVehicleCentreOfGravity -> km/h (65535 invalid)
const ACCEL_FACTOR = 0.002;      // statusLongitudinalAccelerationMassCenter -> m/s², offset ACCEL_OFFSET
const ACCEL_OFFSET = -65;
const SIGNAL_INVALID = 65535;
/* Handing the HUD picture over anew (settings refresh): BMW keeps a picture slanted until it comes anew. */
const BRAKE_MS2 = -3.5;          // braking harder than this (about a third of g): noted, to compare with
const MOVED_KMH = 10;            // a stop counts after the car went faster than this
const STOP_KMH = 1;
const STOP_MS = 1500;            // standing this long
const REFRESH_HIDE_MS = 4000;    // the picture away this long: the renderer gives the HUD back (linger 3 s), then offers anew
const REFRESH_GAP_MS = 20000;    // at most this often
const REFRESH_EVERY_MS = 5 * 60 * 1000;   // refresh 'timed': also this often while driving
/* BMW takes our picture off the HUD for its own (route guidance, lists) and on the G87 does not show it again by
 * itself afterwards: the renderer then says "parked" (offered, not shown) for good. Parked this long, the picture
 * is offered anew (away REFRESH_HIDE_MS, then back), as switching Anzeige off and on by hand does: after 5 s,
 * then 15, 30 and every 60 s for as long as BMW keeps its own content there. The car's log (22.11.2026): "released
 * by the cluster, still offered" and not back in 10 min; offered anew during route guidance it showed for 4 s and
 * was released again, so only a picture that stayed LOST_BACK_MS counts as back (the steps start over). */
const LOST_LADDER_MS = [5000, 15000, 30000, 60000];
const LOST_BACK_MS = 20000;
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
const HOLD_MS = 120000;   // the gateway is busy for 3-10 s now and then (the car's log): no dashes for that
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
        this._drive = { kmh: null, moved: false, stillSince: 0, brakeAt: 0, braking: false };
        this._refresh = { due: 0, why: '', until: 0, last: 0 };
        this._lost = { since: 0, tries: 0 };
        this._nav = false;              // BMW's route guidance on (guidanceState)
        this._navWord = '';
        this._room = { pos: -1, part: false, rest: '', timer: null };   // the renderer's log: read up to pos; part: less than the whole
        this._navSrc = { state: false, trips: false };
        this._navNoted = {};     // the picture offered but not shown: since when, offered anew how often
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
            // the renderer's own log too (readable by all): when the cluster moves or re-lays out the HUD's area
            files: () => Diag.files().map((name) => ({ name, file: require('path').join(Diag.dir(), name) }))
                .concat([{ name: 'cluster-render.log', file: '/var/opt/cluster-render/log/cluster-render.log' },
                    { name: Probe.FILE, file: require('path').join(Diag.dir(), Probe.FILE) }]),
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
            this._subscribeDrive();
            this._watchRoom();
            // which interfaces the car has (once per version, read only): to find a signal for a route in CarPlay
            setTimeout(() => {
                if (this._stopped) return;
                const own = require('path').join(__dirname, '..', '..', 'someipInterfaces');
                Probe.run(Diag.dir(), own, VERSION, (ran, n) => { if (ran) Diag.note(`Schnittstellen-Liste geschrieben (${n} Ordner)`); });
            }, 20000);
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
        clearInterval(this._room.timer);
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
        return [`M Suite HUD ${VERSION}`, `Laufzeit: ${Math.round(process.uptime() / 60)} min`,
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
        const place = `${h.targetState}|${h.isOn() ? 'an' : 'aus'}`;
        if (this._noted.place !== place) {
            if (h.targetState && this._noted.place !== undefined) Diag.note(`HUD-Platz: ${h.target || h.targetState}`);
            this._noted.place = place;
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
        // the speed may come only when it changes: a stop is also seen by the time standing
        const d = this._drive;
        if (d.moved && d.kmh !== null && d.kmh < STOP_KMH) this._speed(d.kmh, now);
        // Gerade halten: the picture away for a moment, so the HUD takes it anew (straight)
        const r = this._refresh;
        if (this._settings.refresh === 'timed' && d.moved && now - Math.max(r.last, this._hudSince || 0) >= REFRESH_EVERY_MS) {
            this._refreshDue('alle 5 min', now);
        }
        if (r.due && now >= r.due && view && this._hud.isOn() && now - r.last >= REFRESH_GAP_MS && this._settings.refresh !== 'off') {
            r.until = now + REFRESH_HIDE_MS;
            r.last = now;
            Diag.note(`HUD-Bild neu übergeben (${r.why})`);
            r.due = 0;
        } else if (r.due && now >= r.due) {
            r.due = 0;
        }
        // BMW's route guidance: the HUD is its own (grid: the alignment picture is asked for by hand, it shows)
        if (this._nav && view && view.mode !== 'grid') view = null;
        if (this._room.part && view && view.mode !== 'grid') view = { mode: 'blank' };
        // BMW took the picture and does not give the place back: offered anew
        const lost = this._lost;
        const state = this._hud.targetState;
        if (state === 'shown') {
            lost.since = 0;
            if (!lost.shownAt) lost.shownAt = now;
            if ((lost.tries || lost.noted) && now - lost.shownAt >= LOST_BACK_MS) {
                Diag.note('HUD: Bild wieder zu sehen');
                lost.tries = 0;
                lost.noted = false;
            }
        } else if (view && this._hud.isOn() && state === 'parked' && now >= r.until) {
            const wait = LOST_LADDER_MS[Math.min(lost.tries, LOST_LADDER_MS.length - 1)];
            lost.shownAt = 0;
            if (!lost.since) {
                lost.since = now;
            } else if (now - lost.since >= wait) {
                if (!lost.noted) Diag.note('HUD: BMW zeigt unser Bild nicht mehr (eigener Inhalt, z. B. Navigation)');
                lost.noted = true;
                lost.tries++;
                lost.since = 0;
                r.until = now + REFRESH_HIDE_MS;
                r.last = now;
                if (lost.tries <= 5 || lost.tries % 10 === 0) Diag.note(`HUD: Bild neu angeboten (${lost.tries}. Mal)`);
            }
        } else {
            lost.since = 0;
            lost.shownAt = 0;
        }
        if (now < r.until && view && view.mode !== 'grid') {
            view = null;
        }
        this._view = view;
        if (view) {
            // coming on: drawn at once, so the HUD never shows what it had before
            const on = this._hud.isOn();
            this._hud.update(Object.assign({}, view, { pos: this._settings.pos, size: this._settings.size,
                cal: S.correction(this._settings) }), !on);
            if (!on) {
                this._hud.show(true);
                this._hudSince = now;
            }
        } else if (this._hud.isOn()) {
            this._hud.show(false);
        }
        this._render();
    }

    /* ---- the car's speed and braking: when to hand the picture over anew ---- */

    _subscribeDrive() {
        const watch = (iface, attr, fn, instance, failed) => {
            let proxy;
            new Promise((resolve) => setImmediate(resolve))
                .then(() => someipBuilders.buildTypedProxy(iface, instance || '1'))
                .then((p) => { proxy = p; return proxy.init(); })
                .then(() => proxy.waitUntilAvailable())
                .then(() => proxy[attr].subscribe((v) => { if (!this._stopped) fn(v); }))
                .catch((e) => { logger.warn(`${attr}: ${e && e.message}`); if (failed) failed(e); });
        };
        // BMW's route guidance: while it guides, the HUD shows its arrows and our picture would lie over them
        const none = (what) => (e) => Diag.note(`Navigation: ${what} nicht verfügbar (${String(e && e.message).slice(0, 80)})`);
        watch(IF_GUIDANCE, 'guidanceState', (v) => this._guidance(v), 'Main_Instance', none('Zustand'));
        // on the G87 that stayed INACTIVE while BMW guided (22.11.2026): the route itself is read as well. A trip
        // marked active with segments counts as guiding; the destinations are only noted, to learn what they say
        // a route on the phone (CarPlay, Android Auto): BMW draws its turns on the HUD, its own guidance stays off
        const truth = (v) => { const x = v && typeof v === 'object' ? v.projectedGuidanceActive : v; return x === true || x === 1 || x === 'true'; };
        [['carplay', 'CarPlay', IF_CARPLAY, 'CarPlayManagerInst1'], ['aauto', 'Android Auto', IF_AAUTO, 'AndroidAutoProjectedManagerInst1']].forEach((p) => {
            watch(p[2], 'projectedGuidanceActive', (v) => {
                const on = truth(v);
                if (this._navNoted[p[0]] !== on) { this._navNoted[p[0]] = on; Diag.note(`Navigation: ${p[1]}-Route ${on ? 'läuft' : 'aus'}`); }
                this._navFrom(p[0], on);
            }, p[3], none(p[1]));
        });
        watch(IF_GUIDANCE, 'guidingProvider', (v) => {
            const w = String(v && typeof v === 'object' ? (v.guidingProvider !== undefined ? v.guidingProvider : v.name !== undefined ? v.name : v.value) : v);
            if (this._navNoted.provider !== w) { this._navNoted.provider = w; Diag.note(`Navigation: Quelle ${w.slice(0, 30)}`); }
        }, 'Main_Instance', none('Quelle'));
        watch(IF_ROUTING, 'currentTrips', (v) => this._trips(v), 'Main_Instance', none('Route'));
        ['finalDestinationInfo', 'nextDestinationInfo'].forEach((attr) => watch(IF_GUIDANCE, attr, (v) => {
            const d = v && v[attr] ? v[attr] : v;
            const dist = d && d.formattedDistance && d.formattedDistance.rawDistance;
            const text = `${attr === 'finalDestinationInfo' ? 'Ziel' : 'nächstes Ziel'}: ${isNum(dist) ? `${Math.round(dist)} m` : '–'}, Fahrzeit ${d && isNum(d.travelTime) ? d.travelTime : '–'}`;
            const k = `${attr}:${isNum(dist) ? (dist > 0 ? 'da' : 'null') : 'leer'}`;
            if (this._navNoted[attr] !== k) { this._navNoted[attr] = k; Diag.note(`Navigation: ${text}`); }
        }, 'Main_Instance', none(attr)));
        watch(IF_VEHICLE2, 'statusCarSpeed2', (v) => {
            const raw = v && v.speedVehicleCentreOfGravity;
            this._speed(isNum(raw) && raw !== SIGNAL_INVALID ? raw * SPEED_FACTOR : null, Date.now());
        });
        watch(IF_CDS2, 'statusLongitudinalAccelerationMassCenter', (v) => {
            const raw = v && v.longitudinalAccelerationCentreOfGravity;
            this._accel(isNum(raw) && raw !== SIGNAL_INVALID ? raw * ACCEL_FACTOR + ACCEL_OFFSET : null, Date.now());
        });
    }

    /* Follows the renderer's log for the part of the HUD the KOMBI gives our picture (CR_LOG above). */
    _watchRoom() {
        const r = this._room;
        const re = new RegExp(`content ${CR_HUD_CONTENT}: canvas (\\d+)x(\\d+), rect (\\d+)x(\\d+)@(-?\\d+),(-?\\d+)`);
        const read = () => {
            if (this._stopped) return;
            let fd = null;
            try {
                const size = fs.statSync(CR_LOG).size;
                if (r.pos < 0 || size < r.pos) { r.pos = Math.max(0, size - 16384); r.rest = ''; }   // first time, or a new file
                if (size > r.pos) {
                    const n = Math.min(size - r.pos, 65536);
                    const buf = Buffer.alloc(n);
                    fd = fs.openSync(CR_LOG, 'r');
                    fs.readSync(fd, buf, 0, n, size - n);
                    r.pos = size;
                    const text = r.rest + buf.toString('utf8');
                    const lines = text.split('\n');
                    r.rest = lines.pop();
                    let part = r.part;
                    lines.forEach((l) => {
                        const m = re.exec(l);
                        if (m) part = !(m[3] === m[1] && m[4] === m[2] && m[5] === '0' && m[6] === '0');
                        else if (l.indexOf(`content ${CR_HUD_CONTENT} offered`) >= 0 || l.indexOf(`content ${CR_HUD_CONTENT}: offer stopped`) >= 0) part = false;
                    });
                    if (part !== r.part) {
                        r.part = part;
                        Diag.note(part ? 'HUD: BMW zeigt etwas Eigenes im HUD – Werte aus' : 'HUD: Platz wieder frei – Werte an');
                        this._tick();
                    }
                }
            } catch (e) {
                if (!r.failed) { r.failed = true; Diag.note(`HUD: Renderer-Log nicht lesbar (${e && e.code})`); }
            }
            if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
        };
        r.timer = setInterval(read, ROOM_MS);
    }

    /* guidanceState: ACTIVE, INACTIVE or CALCULATING_ROUTE (a word, or an object naming one). Guiding or about to:
     * our picture off the HUD, and back when the guidance ends. Anything else is noted and changes nothing. */
    _guidance(v) {
        const word = String(v && typeof v === 'object' ? (v.guidanceState || v.name || v.value || JSON.stringify(v)) : v).toUpperCase();
        const on = word === 'ACTIVE' || word === 'CALCULATING_ROUTE' ? true : word === 'INACTIVE' ? false : null;
        if (word !== this._navWord) Diag.note(`Navigation: ${word.slice(0, 60)}${on === null ? ' (unbekannt, bleibt wie es war)' : on ? ' – HUD-Werte aus' : ''}`);
        this._navWord = word;
        if (on !== null) this._navFrom('state', on);
    }

    /* currentTrips: [{ active, tripDefinition: { tripSegment: [...] } }] (or wrapped under its name). */
    _trips(v) {
        const list = Array.isArray(v) ? v : (v && (v.currentTrips || v.trips)) || [];
        const active = (Array.isArray(list) ? list : []).filter((t) => t && t.active);
        const segs = active.reduce((n, t) => n + (((t.tripDefinition || {}).tripSegment || []).length || 0), 0);
        const k = `${Array.isArray(list) ? list.length : '?'} Routen, ${active.length} aktiv, ${segs} Abschnitte`;
        if (this._navNoted.trips !== k) { this._navNoted.trips = k; Diag.note(`Navigation: ${k}`); }
        // only noted: whether an active trip ends with the guidance is not known, and the HUD must not stay empty
    }

    /* Guiding when any of the signals says so. */
    _navFrom(src, on) {
        this._navSrc[src] = on;
        const nav = Object.keys(this._navSrc).some((k) => this._navSrc[k]);
        if (nav !== this._nav) {
            this._nav = nav;
            Diag.note(`Navigation: ${nav ? 'läuft, HUD-Werte aus' : 'aus, HUD-Werte an'}`);
            this._tick();
        }
    }

    _speed(kmh, now) {
        const d = this._drive;
        if (kmh === null) return;
        d.kmh = kmh;
        if (kmh > MOVED_KMH) {
            if (!d.moved) Diag.note('Fahrt: losgefahren');
            d.moved = true;
            d.stillSince = 0;
        } else if (kmh < STOP_KMH && d.moved) {
            d.stillSince = d.stillSince || now;
            if (now - d.stillSince >= STOP_MS) {
                d.moved = false;
                d.stillSince = 0;
                Diag.note('Fahrt: angehalten');
                this._refreshDue('Halt', now);
            }
        } else {
            d.stillSince = 0;
        }
    }

    _accel(ms2, now) {
        const d = this._drive;
        if (ms2 === null) return;
        if (ms2 <= BRAKE_MS2) {
            if (!d.braking) Diag.note(`Fahrt: starkes Bremsen (${ms2.toFixed(1)} m/s²)`);
            d.braking = true;
            d.brakeAt = now;
            // braking turned out not to be the cause: only noted (diag.log), to compare with when it slants
        } else if (d.braking && now - d.brakeAt > 1000) {
            d.braking = false;
        }
    }

    _refreshDue(why, at) {
        if (this._settings.refresh === 'off') return;
        this._refresh.due = Math.max(this._refresh.due, at);
        this._refresh.why = why;
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
