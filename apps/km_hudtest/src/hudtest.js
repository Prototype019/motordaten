'use strict';
/**
 * HUD-Test: the oil temperature on the head-up display of the G87 (iDrive 8),
 * through cluster-render (src/hud_link.js).
 *
 * Read-only. The oil temperature comes from the car's own signal (CDS
 * statusEngineTemperature, temperatureEngineOilDrive - what the other HUD apps for the
 * MGU use too), so the HUD app puts nothing on the diagnostic gateway that Motordaten
 * uses. Only while that signal has no value (none yet, or 255) does it fall back to one
 * 22 request to the DME every POLL_MS (5822, src/decode.js, docs/g87-s58.md), as tester
 * 0xF4 through the head unit's gateway (src/tasu.js). Nothing is written to any unit.
 *
 * Reads while the HUD is on, in front or not (the point of a HUD); the button
 * turns the HUD off (BMW's own content comes back) and on. The list shows what
 * the renderer says: connection, iDrive generation, the layer's and the HUD's
 * state, and anything it refused.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const { ListApp, logger } = require('./screen.js');
const { Tasu } = require('./tasu.js');
const D = require('./decode.js');
const { HudLink } = require('./hud_link.js');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const ROOT = 'ST_OnlineApps_HudTest';
const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
/* CDS temperatures: raw - 48 = °C, 255 = no value (as src/motordaten.js). */
const TEMP_INVALID = 255;
/* At start, how long the signal gets for its first value. */
const CDS_FIRST_MS = 3000;
const POLL_MS = 1000;
const TIMEOUT_MS = 1500;
const REOPEN_MS = 5000;
/* [key, DID]: the oil temperature. */
const ASK = [['oil', 0x5822]];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const fmt = (v, u, d) => (isNum(v) ? `${v.toFixed(d).replace('.', ',')} ${u}` : '–');

class HudTest extends ListApp {
    constructor() {
        super({ root: ROOT, prefix: 'ht' });
        this._tasu = new Tasu(logger);
        this._hud = new HudLink();
        this._v = {};
        this._gateway = 'wait';         // wait | open | failed
        this._gatewayError = '';
        this._lastOpen = 0;
        this._answers = 0;
        this._cds = 'wartet';           // wartet | verbunden | fehlt: <why>
        this._cdsOil = null;
        this._cdsAt = 0;                // when the signal last had a value
        this._cdsCount = 0;
        this._started = false;
        this._startedAt = 0;
        this._stopped = false;
        this._poll = null;
        this._hud.on('change', () => this._render());
        this._timer = setInterval(() => this._render(), 1000);
    }

    /* Once at start: the HUD on. Then the button: off / on. */
    run() {
        if (!this._started) {
            this._started = true;
            this._startedAt = Date.now();
            this._hud.start();
            this._subscribe();
            this._loop();
        } else {
            this._hud.on(!this._hud.isOn());
            // off: what was read goes, so switching on never shows an old value
            if (!this._hud.isOn()) {
                this._v = {};
                this._send();
            }
            if (this._hud.isOn() && !this._poll) {
                this._loop();
            }
        }
        this._render();
    }

    stop() {
        this._stopped = true;
        clearInterval(this._timer);
        clearTimeout(this._poll);
        this._poll = null;
        this._hud.stop();
    }

    /* The car's oil temperature signal; every value goes to the HUD at once (it draws at most every DRAW_MS). */
    _subscribe() {
        let proxy;
        new Promise((resolve) => setImmediate(resolve))
            .then(() => someipBuilders.buildTypedProxy(IF_CDS, '1'))
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => proxy.statusEngineTemperature.subscribe((v) => {
                if (this._stopped) return;
                const raw = v && v.temperatureEngineOilDrive;
                this._cdsOil = isNum(raw) && raw !== TEMP_INVALID ? raw - 48 : null;
                if (this._cdsOil === null) return;
                this._cdsAt = Date.now();
                this._cdsCount++;
                if (this._hud.isOn()) {
                    this._v.oil = this._cdsOil;
                    this._send();
                }
            }))
            .then(() => { this._cds = 'verbunden'; logger.info('CDS subscribed'); this._render(); })
            .catch((err) => { this._cds = `fehlt: ${err && err.message}`; logger.warn(`CDS unavailable: ${err && err.message}`); this._render(); });
    }

    /* Whether the signal's last value is a temperature. Not by age: a signal is sent when it changes,
     * and a warm engine's oil can stay on one degree for minutes. 255 (no value) -> the DME. */
    _cdsFresh() {
        return this._cdsOil !== null;
    }

    /* One round, then the next POLL_MS after it started; stops while the HUD is off. */
    _loop() {
        if (this._stopped || !this._hud.isOn()) {
            this._poll = null;
            return;
        }
        const started = Date.now();
        this._poll = -1;            // a round is running
        this._ask().catch((e) => logger.warn(`round: ${e && e.message}`)).then(() => {
            if (this._stopped) return;
            this._poll = setTimeout(() => this._loop(), Math.max(0, POLL_MS - (Date.now() - started)));
        });
    }

    _ask() {
        // the signal has the value: the gateway stays free for Motordaten
        if (this._cdsFresh()) {
            if (this._v.oil !== this._cdsOil) {
                this._v.oil = this._cdsOil;
                this._send();
            }
            return Promise.resolve();
        }
        // at start the signal gets CDS_FIRST_MS for its first value before the DME is asked
        if (!/^fehlt/.test(this._cds) && Date.now() - this._startedAt < CDS_FIRST_MS) {
            return Promise.resolve();
        }
        if (this._gateway !== 'open') {
            if (this._gateway === 'failed' && Date.now() - this._lastOpen < REOPEN_MS) {
                return Promise.resolve();
            }
            this._lastOpen = Date.now();
            // opened: read at once, not a round later
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
            ASK.forEach((kv) => { this._v[kv[0]] = isNum(got[kv[1]]) ? got[kv[1]] : null; });
            if (!u) {
                this._gatewayError = 'keine Antwort';
            } else if (u[0] === 0x7F) {
                this._gatewayError = D.NRC[u[2]] || D.hex(u[2]);
            } else if (Object.keys(got).length) {
                this._gatewayError = '';
                this._answers++;
            }
            this._send();
        }, (e) => {
            ASK.forEach((kv) => { this._v[kv[0]] = null; });
            this._gatewayError = e.message;
            this._send();
        });
    }

    _send() {
        this._hud.update({ oil: this._v.oil });
        this._render();
    }

    _status() {
        const h = this._hud;
        if (!h.installed() && h.conn !== 'verbunden') {
            return 'Cluster renderer fehlt: im Store installieren (Quelle robertnisipeanu/idrive-apps), dann Neustart';
        }
        if (h.conn !== 'verbunden') return h.why() || `Renderer: ${h.conn}`;
        if (h.backend && h.backend !== 'id8') return `Renderer läuft als ${h.backend}, erwartet id8`;
        if (!this._cdsFresh()) {
            if (this._gateway === 'failed') return `Diagnose: ${this._gatewayError}`;
            if (this._gatewayError) return `DME: ${this._gatewayError}`;
        }
        if (!h.isOn()) return 'HUD aus (Taste: an)';
        return 'Läuft';
    }

    _render() {
        this.show(this._status(), this._hud.rows().concat([
            ['Öl', fmt(this._v.oil, '°C', 0)],
            ['Quelle', this._cdsFresh() ? 'Fahrzeugsignal' : (this._gateway === 'wait' ? '–' : 'DME (Signal fehlt)')],
            ['Fahrzeugsignal', `${this._cds}, ${this._cdsCount} Werte`],
            ['DME-Antworten', String(this._answers)]
        ]));
    }
}

process.on('uncaughtException', (e) => logger.error(`uncaught: ${e && e.stack}`));
process.on('unhandledRejection', (e) => logger.warn(`unhandled rejection: ${e && e.message}`));

const app = new HudTest();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`hudtest failed to start: ${err && err.message}`);
});
