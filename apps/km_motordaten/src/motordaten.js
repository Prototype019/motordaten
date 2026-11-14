'use strict';
/**
 * Motordaten: the engine's live values on one iDrive 8 screen.
 *
 * - From the DME (address 0x12) through the head unit's diagnostic gateway,
 *   read-only (src/tasu.js, identifiers of src/decode.js; the G87's S58 DME
 *   is a DME8FF_R, docs/g87-s58.md): oil and coolant temperature, intake and
 *   charge air temperature, boost and boost target, oil pressure; ambient
 *   pressure and the supply voltage less often. Boost and oil pressure show
 *   above ambient. Asked one after another, only while the screen is in
 *   front.
 * - From the car's own signals (CDS): engine speed, and oil and coolant
 *   temperature while the DME does not answer.
 *
 * Engine speed, boost and oil pressure keep their peaks; the button resets
 * them. The status line says what is missing.
 */
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { ListApp, logger } = require('./screen.js');
const { Tasu } = require('./tasu.js');
const D = require('./decode.js');
const { Drawn } = require('./drawn.js');

const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
const LAYER = 'ST_OnlineApps_MotordatenLayer';
const isTrue = (raw) => raw === true || raw === 'true' || raw === 1 || raw === '1';
const RPM_INVALID = 65535;
const TEMP_INVALID = 255;
const ENGINE_STOPPED_RPM = 200;
const CYCLE_MS = 150;          // at least this long per round of questions
const SLOW_EVERY = 20;         // ambient pressure and voltage every this many rounds
const REOPEN_MS = 10000;       // a failed gateway is tried again after this long (while shown)

/* Asked every round: [key, DID]. */
const FAST = [['oil', 0x4402], ['coolant', 0x4300], ['intake', 0x580F], ['charge', 0x59D4],
    ['boostAbs', 0x4205], ['boostTargetAbs', 0x4AB0], ['oilPressAbs', 0x4436]];
/* Asked every SLOW_EVERY rounds. */
const SLOW = [['ambient', 0x4201]];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const fmt = (v, unit, d) => (isNum(v) ? `${v.toFixed(d)} ${unit}` : '–');
const withPeak = (v, peak, unit, d) => (isNum(v) ? `${v.toFixed(d)} ${unit}${isNum(peak) ? ` · max ${peak.toFixed(d)}` : ''}` : '–');

class Motordaten extends ListApp {
    constructor() {
        super({ root: 'ST_OnlineApps_Motordaten', prefix: 'md' });
        this._tasu = new Tasu(logger);
        this._dme = {};             // key -> value from the DME (null: no answer)
        this._cds = {};             // rpm, oil, coolant from the car's signals
        this._peak = {};
        this._gateway = 'wait';     // wait | open | failed
        this._gatewayError = '';
        this._lastOpen = 0;
        this._polling = false;
        this._round = 0;
        this._stopped = false;
        this._subscribed = false;
        this._drawn = null;
        this._timer = setInterval(() => this._render(), 500);
    }

    /* The button: peaks start again. Also run once after start. */
    run() {
        if (!this._subscribed) {
            this._subscribed = true;
            this._subscribe();
            this._startDrawn();
        }
        this._peak = {};
        this._render();
    }

    stop() {
        this._stopped = true;
        clearInterval(this._timer);
        if (this._drawn) {
            this._drawn.close();
        }
    }

    /* The drawn screen's host state and its proxy button. */
    bind(rhmi) {
        this._layerState = rhmi.getByName(LAYER);
        this._layerButton = rhmi.getByName('mdLayerP0');
        if (!this._layerState) {
            logger.warn(`${LAYER} missing: list screen only`);
            return;
        }
        this._layerState.on('visible', (ev) => this._drawn && this._drawn.hostVisible(isTrue(ev && ev.visible)));
        this._layerState.on('focus', (ev) => this._drawn && this._drawn.hostFocus(isTrue(ev && ev.focus)));
        if (this._layerButton) {
            this._layerButton.on('action', () => this._drawn && this._drawn.proxyPress());
            this._layerButton.on('focus', (ev) => this._drawn && this._drawn.proxyFocus(isTrue(ev && ev.value)));
        }
    }

    /* The renderer: its answer picks the screen the tile opens (drawn, else the list). */
    _startDrawn() {
        if (!this._layerState) {
            return;
        }
        this._drawn = new Drawn(this.getAppId(), logger);
        this._drawn.on('mode', (mode) => this.useEntryState(mode === 'layer' ? LAYER : 'ST_OnlineApps_Motordaten'));
        this._drawn.on('reset', () => this.run());
        this._drawn.connect();
    }

    visibilityChanged(visible) {
        if (visible) {
            this._poll();
        }
    }

    /* ---- the car's signals ---- */

    _subscribe() {
        let proxy;
        new Promise((resolve) => setImmediate(resolve))
            .then(() => someipBuilders.buildTypedProxy(IF_CDS, '1'))
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => Promise.all([
                proxy.statusEngineSpeed2.subscribe((v) => {
                    const raw = v && v.actualValueRPMEngineCrankshaft;
                    const rpm = isNum(raw) && raw !== RPM_INVALID ? raw * 0.25 : null;
                    this._cds.rpm = rpm !== null && rpm < ENGINE_STOPPED_RPM ? 0 : rpm;
                }),
                proxy.statusEngineTemperature.subscribe((v) => {
                    const t = (raw) => (isNum(raw) && raw !== TEMP_INVALID ? raw - 48 : null);
                    this._cds.oil = t(v && v.temperatureEngineOilDrive);
                    this._cds.coolant = t(v && v.temperatureEngineDrive);
                })
            ]))
            .then(() => logger.info('CDS subscribed'))
            .catch((err) => logger.warn(`CDS unavailable: ${err && err.message}`));
    }

    /* ---- the DME ---- */

    _poll() {
        if (this._polling || this._stopped) {
            return;
        }
        this._polling = true;
        const next = () => {
            if (this._stopped || !this.isVisible()) {
                this._polling = false;
                return;
            }
            const started = Date.now();
            this._ask()
                .catch((e) => logger.warn(`round: ${e && e.message}`))
                .then(() => {
                    this._render();
                    setTimeout(next, Math.max(0, CYCLE_MS - (Date.now() - started)));
                });
        };
        next();
    }

    /* One round: opens the gateway if needed, then asks FAST (and SLOW every SLOW_EVERY rounds). */
    _ask() {
        if (this._gateway !== 'open') {
            if (this._gateway === 'failed' && Date.now() - this._lastOpen < REOPEN_MS) {
                return new Promise((resolve) => setTimeout(resolve, 500));
            }
            this._lastOpen = Date.now();
            return this._tasu.open()
                .then(() => { this._gateway = 'open'; this._gatewayError = ''; },
                    (e) => { this._gateway = 'failed'; this._gatewayError = e.message; });
        }
        const slow = this._round % SLOW_EVERY === 0;
        this._round++;
        const ask = FAST.concat(slow ? SLOW : []);
        return ask.reduce((p, kv) => p.then(() => this._tasu.request(0x22, [kv[1] >> 8, kv[1] & 0xFF])
            .then((u) => { this._dme[kv[0]] = D.didNumber(D.didById(kv[1]), u); },
                (e) => { this._dme[kv[0]] = null; this._gatewayError = e.message; })), Promise.resolve())
            .then(() => (slow ? this._tasu.request(0x01, [0x42])
                .then((u) => { this._dme.voltage = D.obdNumber(D.pidById(0x42), u); }, () => undefined) : undefined));
    }

    /* ---- screen ---- */

    _peakOf(key, v) {
        if (isNum(v)) {
            this._peak[key] = isNum(this._peak[key]) ? Math.max(this._peak[key], v) : v;
        }
        return this._peak[key];
    }

    _render() {
        const m = this._dme;
        const ambient = isNum(m.ambient) ? m.ambient / 1000 : null;      // hPa -> bar
        const above = (abs) => (isNum(abs) && ambient !== null ? abs - ambient : null);
        const pick = (a, b) => (isNum(a) ? a : (isNum(b) ? b : null));
        const rpm = pick(this._cds.rpm, null);
        const boost = above(m.boostAbs);
        const oilPress = above(m.oilPressAbs);
        const rows = [
            ['Drehzahl', withPeak(rpm, this._peakOf('rpm', rpm), 'U/min', 0)],
            ['Öltemperatur', fmt(pick(m.oil, this._cds.oil), '°C', 0)],
            ['Kühlmittel', fmt(pick(m.coolant, this._cds.coolant), '°C', 0)],
            ['Ansaugluft', fmt(m.intake, '°C', 0)],
            ['Ladeluft', fmt(m.charge, '°C', 0)],
            ['Ladedruck', withPeak(boost, this._peakOf('boost', boost), 'bar', 2)],
            ['Ladedruck Soll', fmt(above(m.boostTargetAbs), 'bar', 2)],
            ['Öldruck', withPeak(oilPress, this._peakOf('oilPress', oilPress), 'bar', 2)],
            ['Bordspannung', fmt(m.voltage, 'V', 1)]
        ];
        let status = '';
        if (this._gateway === 'failed') {
            status = `DME nicht erreichbar: ${this._gatewayError}`;
        } else if (this._gateway === 'open' && this._round > 2 && FAST.every((kv) => !isNum(m[kv[0]]))) {
            status = `Keine Antwort der DME – Zündung an?${this._gatewayError ? ` (${this._gatewayError})` : ''}`;
        }
        this.show(status, rows);
        if (this._drawn) {
            this._drawn.set({ rpm, rpmPeak: this._peak.rpm, oil: pick(m.oil, this._cds.oil),
                coolant: pick(m.coolant, this._cds.coolant), intake: m.intake, charge: m.charge,
                boost, boostTarget: above(m.boostTargetAbs), boostPeak: this._peak.boost,
                oilPress, oilPressPeak: this._peak.oilPress, voltage: m.voltage,
                status, statusErr: this._gateway === 'failed' });
        }
    }
}

const app = new Motordaten();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`motordaten failed to start: ${err && err.message}`);
});
