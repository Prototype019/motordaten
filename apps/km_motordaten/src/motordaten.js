'use strict';
/**
 * Motordaten: the engine's live values on one iDrive 8 screen (drawn by
 * mgu-render through src/drawn.js, else a list).
 *
 * Read-only through the head unit's diagnostic gateway as tester 0xF4
 * (src/tasu.js; identifiers of src/decode.js; docs/g87-s58.md):
 * - every round, one request to the DME for up to 8 identifiers (FAST):
 *   engine speed, torque at the clutch, boost and its target, oil pressure,
 *   air mass and relative filling (for the power);
 * - every SLOW_EVERY rounds (and each round until known): the DME's intake
 *   air, ambient pressure, exhaust temperature after the catalyst, oil, coolant
 *   and charge air (recorded only), the gearbox's (EGS) transmission oil, the
 *   supply voltage (OBD 42).
 * Power in PS from the measured air mass (airPowerPs), or the DME's torque x the
 * engine speed where that gives more; the torque shown is that power's. On the
 * overrun (negative torque) both show 0.
 * Rounds follow each other as fast as the gateway takes them, at least
 * CYCLE_MS apart; a busy gateway doubles the pause (up to MAX_CYCLE_MS),
 * answers bring it back. Only while the screen is in front.
 * From the car's own signals (CDS): engine speed between rounds, and oil
 * and coolant temperature while the DME does not answer.
 *
 * Engine speed, boost and oil pressure keep their peaks; the button resets
 * them. Boost and oil pressure show above ambient. The status line says
 * what is missing.
 */
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { ListApp, logger } = require('./screen.js');
const { Tasu, TESTERS, EGS, NO_CLEAR } = require('./tasu.js');
const D = require('./decode.js');
const { Drawn } = require('./drawn.js');
const Limits = require('./limits.js');
const Logbook = require('./logbook.js');
const Usb = require('./usb.js');
const Diag = require('./diag.js');

/* An error nobody caught: noted (diag.log) and the app goes on, the screen staying up instead of the
 * manager restarting the app. */
process.on('uncaughtException', (e) => {
    logger.error(`uncaught: ${e && e.stack}`);
    Diag.note(`Fehler abgefangen: ${String(e && e.stack).split('\n').slice(0, 4).join(' | ')}`);
});
process.on('unhandledRejection', (e) => {
    logger.warn(`unhandled rejection: ${e && e.message}`);
    Diag.note(`Promise abgelehnt: ${e && e.message}`);
});
const Faults = require('./faults.js');
const clock = require('./clock.js');
const { DtcTexts } = require('./dtctext.js');

/* Whether FrontCCU has reported a turn of the dial on this unit (data/controller.json): then the drawn
 * screens take the dial from it from the start. dialKnown(true) keeps that. */
/* The power (PS) the measured air mass makes at this load, or null (see AIR_KW_PER_KGH). */
function airPowerPs(air, load) {
    if (!isNum(air) || !isNum(load) || air <= 0) {
        return null;
    }
    const share = Math.max(0, Math.min(1, (load - LOAD_NONE) / (LOAD_FULL - LOAD_NONE)));
    return air * AIR_KW_PER_KGH * BRAKE_EFFICIENCY * share * PS_PER_KW;
}

function dialKnown(set) {
    const dir = process.env.KM_DATA_DIR || require('path').join(__dirname, '..', '..', 'data');
    const file = require('path').join(dir, 'controller.json');
    if (set) {
        try {
            require('fs').mkdirSync(dir);
        } catch (e) { /* there */ }
        try {
            require('fs').writeFileSync(file, JSON.stringify({ dial: true }));
        } catch (e) {
            logger.warn(`controller.json: ${e.message}`);
        }
        return true;
    }
    try {
        return JSON.parse(require('fs').readFileSync(file, 'utf8')).dial === true;
    } catch (e) {
        return false;
    }
}

const TEXTS_FIRST_MS = 20000;      // the fault texts: looked for this long after the start ...
const TEXTS_EVERY_MS = 300000;     // ... and again this often while some are missing (only with internet)
const IF_KOMBI = 'de.bmw.infotainment.KombiIF';
const IF_FRONTCCU = 'de.bmw.infotainment.controlelements.FrontCCU';
const FAULT_MASK = 0x0D;     // failing now, pending, confirmed
const FAULT_WAIT_MS = 2000;  // a unit's answer to its fault memory read
const PROXIES = 48;            // the host state's proxy buttons (spec.js PROXIES; test_drawn checks)

const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
const LIST = 'ST_OnlineApps_Motordaten';
const LAYER = 'ST_OnlineApps_MotordatenLayer';
const RPM_INVALID = 65535;
const TEMP_INVALID = 255;
const ENGINE_STOPPED_RPM = 200;
const CYCLE_MS = 90;           // at least this long per round
const MAX_CYCLE_MS = 1000;     // the longest pause a busy gateway gets
const SLOW_EVERY = 12;         // the slow values every this many rounds
const REOPEN_MS = 10000;       // a failed gateway is tried again after this long (while shown)
const LIVE_TIMEOUT_MS = 700;   // a live read waits this long for its answer (it comes in ~30 ms): a lost one costs little
const GAP_NOTE_MS = 1500;      // no values from the DME this long: noted (diag.log)
const HOLD_MS = 4000;          // a value missing an answer keeps its last one this long (the gateway drops some)
const RPM_FRESH_MS = 400;      // the DME's engine speed counts this long; the car's signal after it

/* One DME request each round: [key, DID], at most 8. */
const FAST = [['rpm', 0x4807], ['torque', 0x5891], ['boostAbs', 0x4205], ['boostTargetAbs', 0x4AB0],
    ['oilPressAbs', 0x4436], ['airMass', 0x4ABC], ['load', 0x5813]];
/* What the engine does, read only while recording (for the logs, not shown live): every other round the
 * first, every ENGINE2_EVERY rounds the second (DIDs read over ENET on the G87, docs/g87-s58.md). */
const ENGINE = [['lambda', 0x5889], ['lambdaTarget', 0x5816], ['rail', 0x5658], ['railTarget', 0x56C1],
    ['fuelLowAbs', 0x58F3], ['ignition', 0x59FA], ['pedal', 0x480B]];
/* The knock control, live every other round: its mean retard and each cylinder's ignition angle (the cylinder
 * it takes back sits below the others; the DME has no retard per cylinder). */
const CYLINDER_DIDS = [0x4A49, 0x4A4A, 0x4A4C, 0x4A4D, 0x4A4E, 0x4A4F];
const KNOCK = [['knock', 0x554C]].concat(CYLINDER_DIDS.map((id, i) => [`ign${i + 1}`, id]));
const ENGINE2 = [['throttle', 0x4600], ['fuelFlow', 0x4521], ['fuelTemp', 0x4AD5]];
const ENGINE2_EVERY = 6;

/* The battery, with the slow ones: its charge (a valid one is 0-100 %). */
const BATTERY = [['battSoc', 0x5425]];

/* One DME request every SLOW_EVERY rounds: slow to change. */
const SLOW = [['intake', 0x580F], ['ambient', 0x4201], ['exhaust', 0x582F], ['oil', 0x4402], ['coolant', 0x4300],
    ['charge', 0x59D4]];
const PS_PER_KW = 1.35962;
/*
 * Power from the air the engine burns, not from the DME's torque: a tune (MHD) keeps reporting about the stock
 * torque to the gearbox while the engine makes more, but the air mass is measured. Burned fuel is the air over
 * the stoichiometric ratio (richer than lambda 1 burns no more), its heat value 11.94 kWh/kg, and a turbo petrol
 * engine at full load turns BRAKE_EFFICIENCY of it into power: kW = air (kg/h) / 14.7 x 11.94 x 0.315
 * = air x 0.256 (the rule of thumb of 1.25 PS per g/s of air). At part load the throttle and the pumping losses
 * take more, so the efficiency counts in full only from LOAD_FULL relative filling and not at all below
 * LOAD_NONE; where the DME's own torque gives more (part load, where no tune masks it), that one stands.
 */
const AIR_KW_PER_KGH = 11.94 / 14.7;
const BRAKE_EFFICIENCY = 0.315;
const LOAD_NONE = 10;
const LOAD_FULL = 70;

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isTrue = (raw) => raw === true || raw === 'true' || raw === 1 || raw === '1';
const fmt = (v, unit, d) => (isNum(v) ? `${v.toFixed(d)} ${unit}` : '–');
const withPeak = (v, peak, unit, d) => (isNum(v) ? `${v.toFixed(d)} ${unit}${isNum(peak) ? ` · max ${peak.toFixed(d)}` : ''}` : '–');

class Motordaten extends ListApp {
    constructor() {
        super({ root: LIST, prefix: 'md' });
        this._tasu = new Tasu(logger);
        this._dme = {};             // key -> value (null: no answer)
        this._at = {};              // key -> when it last answered
        this._cds = {};             // rpm, oil, coolant from the car's signals
        this._peak = {};
        this._gateway = 'wait';     // wait | open | failed
        this._gatewayError = '';
        this._lastOpen = 0;
        this._polling = false;
        this._round = 0;
        this._cycle = CYCLE_MS;
        this._emptyRounds = 0;
        this._testerIdx = 0;
        this._stopped = false;
        this._started = false;
        this._drawn = null;
        this._limits = Limits.load();
        this._texts = new DtcTexts(logger);
        this._recording = null;     // a Logbook.Recording while recording
        this._summaries = new Map(); // recording name -> its summary (files do not change once written)
        this._logs = [];
        this._v = {};
        this._proxies = [];
        this._timer = setInterval(() => this._render(), 1000);
    }

    /* The button: peaks start again. Also run once after start. */
    run() {
        if (!this._started) {
            this._started = true;
            this._subscribe();
            this._startDrawn();
        }
        this._peak = {};
        this._render();
    }

    stop() {
        this._stopped = true;
        clearInterval(this._timer);
        clearInterval(this._ticker);
        clearTimeout(this._textsTimer);
        if (this._recording) {
            this._stopRecording();
        }
        if (this._drawn) {
            this._drawn.close();
        }
    }

    visibilityChanged(visible) {
        if (visible) {
            this._poll();
            // the app in front again with the drawn screen as its entry state: the layer shows, whichever
            // way the app was opened (its tile, another app, the HMI's history)
            if (this._drawn && this._drawn.mode === 'layer' && this.entryState() === LAYER) {
                this._drawn.hostVisible(true);
                if (this._hostTold) {
                    this._hostTold();
                }
            }
        }
    }

    /* The drawn screen's host state and its proxy button. */
    bind(rhmi) {
        this._layerState = rhmi.getByName(LAYER);
        if (!this._layerState) {
            logger.warn(`${LAYER} missing: list screen only`);
            return;
        }
        // Both states carry the layer: the host state, and the list state should the HMI show it (its history,
        // a start before the renderer answered); the list state holds no values while the layer is there.
        const host = { list: { v: false, f: true }, layer: { v: false, f: true } };
        let told = { v: null, f: null };
        const tell = () => {
            const d = this._drawn;
            if (!d) {
                return;
            }
            const v = host.list.v || host.layer.v;
            const f = (host.list.v && host.list.f) || (host.layer.v && host.layer.f);
            if (v !== told.v) {
                d.hostVisible(v);
            }
            if (!v || f !== told.f) {
                d.hostFocus(f);
            }
            told = { v, f };
        };
        const watch = (state, key) => {
            state.on('visible', (ev) => {
                host[key].v = isTrue(ev && ev.visible);
                if (host[key].v) {
                    host[key].f = true;
                }
                tell();
            });
            state.on('focus', (ev) => { host[key].f = isTrue(ev && ev.focus); tell(); });
        };
        watch(this._layerState, 'layer');
        const listState = rhmi.getByName(LIST);
        if (listState) {
            watch(listState, 'list');
        }
        this._hostTold = () => { told = { v: null, f: null }; };
        for (let i = 0; i < PROXIES; i++) {
            const b = rhmi.getByName(`mdLayerP${i}`);
            this._proxies.push(b);
            if (b) {
                b.on('action', () => this._drawn && this._drawn.proxyPress(i));
                b.on('focus', (ev) => this._drawn && this._drawn.proxyFocus(i, isTrue(ev && ev.value)));
            }
        }
    }

    /* The proxy buttons follow the drawn page's targets: one shown per target, with its words. */
    _proxiesFor(targets) {
        const BLANK = ' ';
        // the dial read from FrontCCU: one proxy holds the HMI's focus and takes the push, the list under the
        // layer is a single empty row; else one proxy per target
        const single = this._drawn && this._drawn.single;
        this._proxies.forEach((b, i) => {
            if (!b) {
                return;
            }
            const t = single ? (i === 0 ? targets[0] : undefined) : targets[i];
            Promise.resolve()
                .then(() => b.setProperty('Visible', t ? 1 : 0, 'UInt'))
                // no text: the list under the layer, should the HMI show it for a moment, stays empty
                .then(() => (t ? b.setValue(0, 'PrimaryText', BLANK, 'Text') : undefined))
                .catch((err) => logger.warn(`proxy ${i}: ${err && err.message}`));
        });
    }

    /* A press on the drawn screens: the tabs, the main page's buttons, the limits, the logbook. */
    _action(id) {
        const d = this._drawn;
        if (id.indexOf('tab:') === 0) {
            const page = id.slice(4);
            d.setExtra({ confirmDeleteAll: false, usb: null });
            if (page === 'logs') {
                this._showLogs();
            }
            d.setPage(page);
            if (page === 'faults' && !d.extra.faults) {
                this._readFaults();
            }
        } else if (id === 'faults:read') {
            this._readFaults();
        } else if (id.indexOf('unit:') === 0) {
            d.setExtra({ unit: Number(id.slice(5)) });
            d.setPage('faultunit');
        } else if (id === 'faults:back') {
            d.setPage('faults');
        } else if (id === 'faults:clear') {
            const why = this._clearBlocked();
            d.setExtra({ faults: Object.assign({}, d.extra.faults, why ? { note: why, warn: true, confirmClear: false } :
                { note: null, warn: false, confirmClear: true }) });
        } else if (id === 'faults:clear!') {
            this._clearFaults();
        } else if (id === 'record') {
            this._toggleRecording();
        } else if (id === 'reset') {
            this.run();
        } else if (id === 'menu:limits' || id === 'menu:ready') {
            d.setPage(id.slice(5));
        } else if (id === 'settings:back') {
            d.setPage('settings');
        } else if (id.indexOf('toggle:') === 0) {
            this._setLimits(Limits.toggled(this._limits, id.slice(7)));
        } else if (id === 'defaults') {
            // the page's own settings back to the defaults
            this._setLimits(Limits.reset(this._limits, d.page === 'ready' ? 'ready' : 'limits'));
        } else if (/^(dec|inc):/.test(id)) {
            this._setLimits(Limits.stepped(this._limits, id.slice(4), id.indexOf('inc:') === 0 ? 1 : -1));
        } else if (id.indexOf('open:') === 0) {
            const r = this._logs[Number(id.slice(5))];
            if (r) {
                d.setExtra({ log: Logbook.load(r.name), logName: r.name, channel: 'rpm', confirmDelete: false });
                d.setPage('log');
            }
        } else if (id.indexOf('chan:') === 0) {
            d.setExtra({ channel: id.slice(5), confirmDelete: false });
        } else if (id === 'delete') {
            d.setExtra({ confirmDelete: true });
        } else if (id === 'delete!') {
            Logbook.remove(d.extra.logName);
            this._summaries.delete(d.extra.logName);
            this._showLogs();
            d.setExtra({ log: null, logName: null, confirmDelete: false });
            d.setPage('logs');
        } else if (id === 'usb') {
            this._exportUsb();
        } else if (id === 'deleteAll') {
            d.setExtra({ confirmDeleteAll: true });
        } else if (id === 'deleteAll!') {
            Logbook.removeAll(this._recording && this._recording.name);
            this._summaries.clear();
            d.setExtra({ confirmDeleteAll: false });
            this._showLogs();
        } else if (id === 'back') {
            d.setExtra({ confirmDelete: false });
            this._showLogs();
            d.setPage('logs');
        }
    }

    /* Every unit's fault memory, read only (19 02 to all units at once); the page shows it as it comes. */
    _readFaults() {
        const d = this._drawn;
        if (!d || (d.extra.faults && d.extra.faults.reading)) {
            return;
        }
        // every unit in turn, so the page shows each one as it is read
        const scan = Faults.addresses().map((addr) => ({ addr, name: Faults.unitName(addr), state: 'wait', entries: [] }));
        const show = (more) => d.setExtra({ faults: Object.assign({ reading: true, scan: scan.slice() }, more) });
        show({ progress: 0 });
        const tester = this._tasu.tester;
        const open = this._gateway === 'open' ? Promise.resolve() : this._tasu.open().then(() => { this._gateway = 'open'; });
        let probe = '';
        open
            .then(() => this._faultTester())
            .then((p) => {
                probe = p.note;
                this._tasu.useTester(p.tester);
                return scan.reduce((chain, unit, k) => chain.then(() => {
                    unit.state = 'read';
                    show({ progress: k + 1 });
                    return this._faultsOfUnit(unit);
                }), Promise.resolve());
            })
            .then(() => {
                this._tasu.useTester(tester);
                const entries = [].concat(...scan.map((u) => u.entries));
                const read = scan.filter((u) => u.state === 'ok' || u.state === 'faults').length;
                const refused = scan.filter((u) => u.state === 'refused');
                const nrcs = Array.from(new Set(refused.map((u) => u.nrc)));
                logger.info(`faults: read ${read}, refused ${refused.length} (${nrcs.map((n) => n.toString(16)).join(',')}), ${probe}; ` +
                    entries.map((e) => `${e.ecu.toString(16)}:${e.code}/${e.status}`).join(' '));
                const note = this._afterClear ? `${this._afterClear}${entries.length ? `Noch ${entries.length} Einträge.` : 'Keine Einträge mehr.'}` : null;
                this._afterClear = null;
                d.setExtra({ faults: { scan, units: read, refused: refused.length, nrcs, probe, entries, at: clock.wall(), note } });
                this._annotateFaults();
                this._syncTexts(Array.from(new Set(entries.map((e) => e.ecu))));
            }, (e) => {
                this._tasu.useTester(tester);
                d.setExtra({ faults: { scan, error: (e && e.message) || String(e) } });
            });
    }

    /* One unit's fault memory into its tile: a unit silent, refusing or failing is asked once more
     * (a slow unit, a busy gateway); a transport error shows as one, not as silence. */
    _faultsOfUnit(unit, again) {
        return this._tasu.faultsOf(unit.addr, FAULT_MASK, FAULT_WAIT_MS).then((u) => {
            if (u && u[0] === 0x59) {
                unit.entries = Faults.parse(new Map([[unit.addr, u]])).entries;
                unit.state = unit.entries.length ? 'faults' : 'ok';
                return undefined;
            }
            unit.state = u && u[0] === 0x7F ? 'refused' : 'none';
            unit.nrc = u && u[0] === 0x7F ? u[2] : undefined;
            return again ? undefined : this._faultsOfUnit(unit, true);
        }, (e) => {
            unit.state = 'error';
            unit.error = (e && e.message) || String(e);
            return again ? undefined : new Promise((r) => setTimeout(r, 300)).then(() => this._faultsOfUnit(unit, true));
        });
    }

    /* The tester address the gateway lets read the fault memory: each tried on the DME until one gets a
     * fault reply; else the first. { tester, note } (what each answered, for the log). */
    _faultTester() {
        const tried = [];
        const next = (k) => {
            if (k >= TESTERS.length) {
                return { tester: TESTERS[0], note: tried.join(' ') };
            }
            this._tasu.useTester(TESTERS[k]);
            return this._tasu.faultsOf(0x12, FAULT_MASK).then((u) => {
                tried.push(`${TESTERS[k].toString(16)}:${u ? u.slice(0, 3).map((b) => b.toString(16)).join('') : '-'}`);
                return u && u[0] === 0x59 ? { tester: TESTERS[k], note: tried.join(' ') } : next(k + 1);
            }, () => next(k + 1));
        };
        return next(0);
    }

    /* Why the fault memory may not be cleared now, or null: only with the engine off (its speed measured
     * as 0 just now) and the ignition on (the units answer). */
    _clearBlocked() {
        const fresh = Date.now() - (this._at.rpm || 0) < 3000;
        const rpm = fresh ? this._dme.rpm : this._cds.rpm;
        if (!isNum(rpm)) {
            return 'Löschen nur bei Zündung an: keine Drehzahl vom Motor.';
        }
        if (rpm >= ENGINE_STOPPED_RPM) {
            return 'Löschen nur bei Motor aus. Motor abstellen, Zündung an lassen.';
        }
        return null;
    }

    /* The fault texts on the entries shown, and how many units' tables are here. */
    _annotateFaults() {
        const d = this._drawn;
        const f = d && d.extra.faults;
        if (!f || !f.scan) {
            return;
        }
        f.scan.forEach((u) => u.entries.forEach((e) => { e.text = this._texts.text(e.ecu, e.code); }));
        const c = this._texts.count();
        d.setExtra({ faults: Object.assign({}, f, { texts: c }) });
    }

    /* Loads the fault texts not here yet when the Store has internet (the units with faults first). */
    _syncTexts(first) {
        clearTimeout(this._textsTimer);
        this._textsTimer = null;
        return this._texts.sync(first).then((n) => {
            if (n) {
                this._annotateFaults();
            }
        }, (e) => logger.warn(`fault texts: ${e && e.message}`)).then(() => {
            if (!this._stopped && !this._texts.complete()) {
                this._textsTimer = setTimeout(() => this._syncTexts(), TEXTS_EVERY_MS);
            }
        });
    }

    /* Clears the units that have entries, one after the other (never the head unit), then reads again. */
    _clearFaults() {
        const d = this._drawn;
        const f = d.extra.faults || {};
        const why = this._clearBlocked();
        if (why) {
            d.setExtra({ faults: Object.assign({}, f, { note: why, warn: true, confirmClear: false }) });
            return;
        }
        const units = Array.from(new Set((f.entries || []).map((e) => e.ecu)));
        const skipped = units.filter((u) => NO_CLEAR.indexOf(u) >= 0);
        const todo = units.filter((u) => NO_CLEAR.indexOf(u) < 0);
        d.setExtra({ faults: Object.assign({}, f, { clearing: true, confirmClear: false, note: null, warn: false }) });
        let cleared = 0;
        let failed = 0;
        todo.reduce((p, u) => p.then(() => this._tasu.clearFaults(u)
            .then((r) => { if (r && r[0] === 0x54) cleared++; else failed++; }, () => { failed++; })), Promise.resolve())
            .then(() => {
                logger.info(`faults cleared in ${cleared} units, ${failed} failed, skipped ${skipped.join(',')}`);
                const parts = [`Gelöscht in ${cleared} ${cleared === 1 ? 'Steuergerät' : 'Steuergeräten'}`];
                if (failed) parts.push(`${failed} ohne Bestätigung`);
                if (skipped.length) parts.push('Headunit ausgelassen');
                this._afterClear = `${parts.join(', ')}. `;
                d.setExtra({ faults: { reading: false } });
                this._readFaults();
            });
    }

    /* The logbook's list for the Logs tab (summaries read once per recording). */
    /* Every recording onto the USB stick (Motordaten/), the page telling how far it is and how it ended. */
    _exportUsb() {
        const d = this._drawn;
        if (this._exporting) {
            return;
        }
        const names = Logbook.list().map((r) => r.name);
        if (!names.length) {
            return;
        }
        this._exporting = true;
        d.setExtra({ confirmDeleteAll: false, usb: { text: 'Speichere auf USB …' } });
        Usb.exportLogs(Logbook.dir(), names, {
            progress: (n, of) => d.setExtra({ usb: { text: `Speichere auf USB … ${n} von ${of}` } })
        }).then((r) => new Promise((resolve) => Diag.flush(resolve))
            // the app's notebook beside them (what went wrong, for a look on the computer)
            .then(() => Usb.exportLogs(Diag.dir(), Diag.files()).catch(() => null))
            .then(() => r)).then((r) => {
            logger.info(`usb: ${r.count} recordings onto ${r.stick}`);
            d.setExtra({ usb: { text: `${r.count} ${r.count === 1 ? 'Aufzeichnung' : 'Aufzeichnungen'} auf „${r.stick}“ im Ordner ${Usb.FOLDER} gespeichert. Der Stick kann raus.` } });
        }, (e) => {
            logger.warn(`usb: ${e.message}`);
            d.setExtra({ usb: { text: e.message, error: true } });
        }).then(() => { this._exporting = false; });
    }

    _showLogs() {
        const list = Logbook.list();
        this._logs = list.map((r) => {
            if (!this._summaries.has(r.name) || (this._recording && this._recording.name === r.name)) {
                this._summaries.set(r.name, Logbook.summary(r.name));
            }
            return this._summaries.get(r.name);
        }).filter(Boolean);
        if (this._drawn) {
            this._drawn.setExtra({ logs: this._logs });
        }
    }

    _toggleRecording() {
        if (this._recording) {
            this._stopRecording();
            return;
        }
        try {
            this._recording = new Logbook.Recording();
            // the engine's values are read only while recording: none left from an earlier one
            ENGINE.concat(ENGINE2).forEach((kv) => { this._dme[kv[0]] = null; this._at[kv[0]] = 0; });
            logger.info(`recording ${this._recording.name}`);
        } catch (e) {
            logger.warn(`recording not started: ${e && e.message}`);
            this._recording = null;
        }
        this._poll();
        this._recordingShown();
    }

    _stopRecording() {
        const r = this._recording;
        this._recording = null;
        if (r) {
            r.stop();
            logger.info(`recording ${r.name} stopped: ${r.rows} samples`);
        }
        this._recordingShown();
    }

    /* The recording button's words follow the recording, a second at a time. */
    _recordingShown() {
        if (this._drawn) {
            this._drawn.setExtra({ recording: this._recording ? { ms: Date.now() - this._recording.started } : null });
        }
    }

    /* Each round's values into the recording; a full one stops. */
    _sample() {
        if (!this._recording) {
            return;
        }
        if (!this._recording.sample(this._v)) {
            this._stopRecording();
            return;
        }
        const s = Math.floor((Date.now() - this._recording.started) / 1000);
        if (s !== this._recShownS) {
            this._recShownS = s;
            this._recordingShown();
        }
    }

    _setLimits(limits) {
        this._limits = limits;
        try {
            Limits.save(limits);
        } catch (e) {
            logger.warn(`limits not saved: ${e && e.message}`);
        }
        if (this._drawn) {
            this._drawn.setLimits(limits);
        }
    }

    /* The renderer: its answer picks the screen the tile opens (drawn, else the list). */
    _startDrawn() {
        if (!this._layerState) {
            return;
        }
        this._drawn = new Drawn(this.getAppId(), logger);
        this._drawn.setLimits(this._limits);
        this._drawn.setSingle(dialKnown());
        this._drawn.on('dial', (steps) => {
            // FrontCCU reports the dial: one proxy, the list under the layer a single empty row; kept once it
            // has seen a turn
            if (steps && !this._dialSeen) {
                this._dialSeen = true;
                dialKnown(true);
            }
            if (!this._drawn.single) {
                logger.info('FrontCCU reports the dial: one proxy from now on');
                this._drawn.setSingle(true);
            }
        });
        this._textsTimer = setTimeout(() => this._syncTexts(), TEXTS_FIRST_MS);
        this._drawn.on('mode', (mode) => this.useEntryState(mode === 'layer' ? LAYER : LIST));
        this._drawn.on('action', (id) => this._action(id));
        this._drawn.on('targets', (targets) => this._proxiesFor(targets));
        this._proxiesFor(require('./dash.js').targets('main'));
        this._drawn.connect();
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
                    this._render();
                }),
                proxy.statusEngineTemperature.subscribe((v) => {
                    const t = (raw) => (isNum(raw) && raw !== TEMP_INVALID ? raw - 48 : null);
                    this._cds.oil = t(v && v.temperatureEngineOilDrive);
                    this._cds.coolant = t(v && v.temperatureEngineDrive);
                })
            ]))
            .then(() => logger.info('CDS subscribed'))
            .catch((err) => logger.warn(`CDS unavailable: ${err && err.message}`));
        // the controller's dial, for the drawn screens (src/drawn.js ccu)
        let ccu;
        new Promise((resolve) => setImmediate(resolve))
            .then(() => someipBuilders.buildTypedProxy(IF_FRONTCCU, '1'))
            .then((p) => { ccu = p; return ccu.init(); })
            .then(() => ccu.waitUntilAvailable())
            .then(() => ccu.statusRotaryEncoderState.subscribe((st) => this._drawn && this._drawn.ccu(st)))
            .then(() => logger.info('FrontCCU subscribed'))
            .catch((err) => logger.warn(`FrontCCU unavailable: ${err && err.message}`));
        // the car's clock (its time zone and summer time) from the instrument cluster's display time
        let kombi;
        new Promise((resolve) => setImmediate(resolve))
            .then(() => someipBuilders.buildTypedProxy(IF_KOMBI, '1'))
            .then((p) => { kombi = p; return kombi.init(); })
            .then(() => kombi.waitUntilAvailable())
            .then(() => {
                const show = (v) => {
                    if (clock.setCluster(v)) {
                        logger.info(`clock: UTC${clock.offset() >= 0 ? '+' : ''}${clock.offset() / 60} h`);
                    }
                };
                return Promise.resolve(kombi.statusShowTimeDate.subscribe(show))
                    .then(() => kombi.statusShowTimeDate.getValue())
                    .then(show);
            })
            .catch((err) => logger.warn(`cluster clock unavailable: ${err && err.message}`));
    }

    /* ---- the DME and the gearbox ---- */

    _poll() {
        if (this._polling || this._stopped) {
            return;
        }
        this._polling = true;
        // the screen and the recording go on at their own pace, whatever a round waits for
        clearInterval(this._ticker);
        this._ticker = setInterval(() => { this._render(); this._sample(); }, 100);
        const next = () => {
            if (this._stopped || !(this.isVisible() || this._recording)) {
                this._polling = false;
                clearInterval(this._ticker);
                return;
            }
            const started = Date.now();
            this._ask()
                .catch((e) => logger.warn(`round: ${e && e.message}`))
                .then(() => {
                    this._render();
                    this._sample();
                    setTimeout(next, Math.max(0, this._cycle - (Date.now() - started)));
                });
        };
        next();
    }

    /* One round: the gateway opened if needed, then FAST in one request, and every SLOW_EVERY rounds the slow ones. */
    _ask() {
        // the fault scan has the gateway to itself
        if (this._drawn && this._drawn.extra.faults && this._drawn.extra.faults.reading) {
            return new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (this._gateway !== 'open') {
            if (this._gateway === 'failed' && Date.now() - this._lastOpen < REOPEN_MS) {
                return new Promise((resolve) => setTimeout(resolve, 500));
            }
            this._lastOpen = Date.now();
            return this._tasu.open()
                .then(() => { this._gateway = 'open'; this._gatewayError = ''; },
                    (e) => { this._gateway = 'failed'; this._gatewayError = e.message; });
        }
        const slow = this._round % SLOW_EVERY === 0 || !isNum(this._dme.ambient) || !isNum(this._dme.gearbox);
        this._round++;
        const busyBefore = this._tasu.busy;
        const rec = !!this._recording;
        const round = this._round;
        let fast = 0;
        // a round whose FAST got nothing ends there: the next one asks FAST again at once instead of
        // waiting out more requests behind it
        const more = (fn) => () => (fast ? fn() : undefined);
        return this._read(FAST)
            .then((n) => { fast = n; this._gap(n); })
            .then(more(() => (round % 2 === 0 ? this._read(KNOCK) : undefined)))
            .then(more(() => (rec && round % 2 === 1 ? this._read(ENGINE) : undefined)))
            .then(more(() => (rec && round % ENGINE2_EVERY === 3 ? this._read(ENGINE2) : undefined)))
            .then(more(() => (slow ? this._read(BATTERY) : undefined)))
            .then(more(() => (slow ? this._read(SLOW)
                .then(() => this._tasu.request(0x22, [0x60, 0x00], LIVE_TIMEOUT_MS, EGS))
                .then((u) => this._keep('gearbox', D.didNumber(D.didById(0x6000), u)), () => this._keep('gearbox', null))
                .then(() => this._tasu.request(0x01, [0x42], LIVE_TIMEOUT_MS))
                .then((u) => this._keep('voltage', D.obdNumber(D.pidById(0x42), u)), () => this._keep('voltage', null)) : undefined)))
            .then(() => {
                this._pace(this._tasu.busy > busyBefore);
                this._checkTester();
            });
    }

    /* Several DME identifiers in one request: [key, DID]. */
    _read(list) {
        const dids = list.map((kv) => D.didById(kv[1]));
        const data = [].concat(...list.map((kv) => [kv[1] >> 8, kv[1] & 0xFF]));
        return this._tasu.request(0x22, data, LIVE_TIMEOUT_MS)
            .then((u) => {
                const got = D.didNumbers(dids, u) || {};
                list.forEach((kv) => this._keep(kv[0], got[kv[1]]));
                if (u && u[0] === 0x7F) {
                    this._gatewayError = `DME: ${D.NRC[u[2]] || D.hex(u[2])}`;
                    Diag.note(`DME lehnt ab (${list.map((kv) => kv[0]).join(',')}): ${this._gatewayError}`);
                }
                return list.filter((kv) => isNum(got[kv[1]])).length;
            }, (e) => {
                list.forEach((kv) => this._keep(kv[0], null));
                this._gatewayError = e.message;
                Diag.note(`Anfrage ${list[0][0]}…: ${e.message}`);
                return 0;
            });
    }

    /* A gap in the DME's answers: noted when it starts and how long it lasted. */
    _gap(n) {
        const now = Date.now();
        if (n) {
            if (this._gapFrom && now - this._gapFrom >= GAP_NOTE_MS) {
                Diag.note(`DME wieder da nach ${((now - this._gapFrom) / 1000).toFixed(1)} s (Pause ${this._cycle} ms)`);
            }
            this._gapFrom = 0;
            this._gapNoted = false;
        } else {
            this._gapFrom = this._gapFrom || now;
            if (!this._gapNoted && now - this._gapFrom >= GAP_NOTE_MS) {
                this._gapNoted = true;
                Diag.note(`DME antwortet nicht seit ${((now - this._gapFrom) / 1000).toFixed(1)} s: ${this._gatewayError || '-'}`);
            }
        }
    }

    /* A busy gateway gets twice the pause, a round without one brings it back down. */
    _pace(busy) {
        this._cycle = busy ? Math.min(MAX_CYCLE_MS, this._cycle * 2) : Math.max(CYCLE_MS, Math.round(this._cycle * 0.8));
    }

    /* A new value, or none: then the last one stays for HOLD_MS. */
    _keep(key, v) {
        const now = Date.now();
        if (isNum(v)) {
            this._dme[key] = v;
            this._at[key] = now;
        } else if (!(now - (this._at[key] || 0) < HOLD_MS)) {
            this._dme[key] = null;
        }
    }

    /* Two rounds without a single answer: ask as the next tester address (the DME may answer only some). */
    _checkTester() {
        const any = FAST.some((kv) => isNum(this._dme[kv[0]]));
        if (any) {
            this._answered = true;          // this tester works: kept through any gap that follows
        }
        this._emptyRounds = any ? 0 : this._emptyRounds + 1;
        if (this._emptyRounds >= 2 && !this._answered) {
            this._emptyRounds = 0;
            this._testerIdx = (this._testerIdx + 1) % TESTERS.length;
            this._tasu.useTester(TESTERS[this._testerIdx]);
            logger.info(`no answers: tester ${TESTERS[this._testerIdx].toString(16)}`);
            Diag.note(`keine Antwort: Tester ${TESTERS[this._testerIdx].toString(16)}`);
        }
    }

    /* ---- screen ---- */

    _peakOf(key, v) {
        if (isNum(v)) {
            this._peak[key] = isNum(this._peak[key]) ? Math.max(this._peak[key], v) : v;
        }
        return this._peak[key];
    }

    /* The engine speed: the DME's while fresh, else the car's signal. */
    _rpm() {
        const dme = this._dme.rpm;
        if (isNum(dme) && Date.now() - (this._at.rpm || 0) < RPM_FRESH_MS) {
            return dme < ENGINE_STOPPED_RPM ? 0 : dme;
        }
        return isNum(this._cds.rpm) ? this._cds.rpm : (isNum(dme) ? dme : null);
    }

    _render() {
        const m = this._dme;
        const ambient = isNum(m.ambient) ? m.ambient / 1000 : null;      // hPa -> bar
        const above = (abs) => (isNum(abs) && ambient !== null ? abs - ambient : null);
        const pick = (a, b) => (isNum(a) ? a : (isNum(b) ? b : null));
        const v = {
            rpm: this._rpm(), oil: pick(m.oil, this._cds.oil), coolant: pick(m.coolant, this._cds.coolant),
            intake: m.intake, charge: m.charge, boost: above(m.boostAbs), boostTarget: above(m.boostTargetAbs),
            oilPress: above(m.oilPressAbs), gearbox: m.gearbox, exhaust: m.exhaust, voltage: m.voltage,
            // only while recording (ENGINE): for the logs
            lambda: m.lambda, lambdaTarget: m.lambdaTarget, rail: m.rail, railTarget: m.railTarget,
            fuelLow: above(m.fuelLowAbs), knock: m.knock, ignition: m.ignition, pedal: m.pedal, load: m.load,
            airMass: m.airMass, throttle: m.throttle, fuelFlow: m.fuelFlow, fuelTemp: m.fuelTemp,
            // the battery: its charge only when it reads as one (0-100 %), its sensor's voltage before the OBD one
            battSoc: isNum(m.battSoc) && m.battSoc >= 0 && m.battSoc <= 100 ? m.battSoc : null,
            battCurrent: m.battCurrent, battTemp: m.battTemp, battVoltage: isNum(m.battVoltage) && m.battVoltage > 5 ? m.battVoltage : null
        };
        // each cylinder's ignition below the earliest one: what the knock control takes back there
        const angles = CYLINDER_DIDS.map((id, i) => m[`ign${i + 1}`]);
        // only with the engine running: standing, the DME reports angles that say nothing (cylinder 3 apart)
        if (angles.every(isNum) && isNum(v.rpm) && v.rpm > 600) {
            const top = Math.max.apply(null, angles);
            angles.forEach((a, i) => { v[`knockCyl${i + 1}`] = top - a; });
            const worst = angles.indexOf(Math.min.apply(null, angles));
            v.knockCyl = top - angles[worst] > 0.4 ? worst + 1 : null;
        }
        // on the overrun the DME reports the engine's drag as negative torque: shown as 0
        const rpm = isNum(v.rpm) ? Math.max(0, v.rpm) : null;
        const dmeTorque = isNum(m.torque) ? Math.max(0, m.torque) : null;
        const dmePower = dmeTorque !== null && rpm !== null ? dmeTorque * rpm / 9549 * PS_PER_KW : null;
        const airPower = airPowerPs(m.airMass, m.load);
        if (airPower !== null && (dmePower === null || airPower > dmePower) && rpm !== null && rpm > 500) {
            v.power = airPower;
            v.torque = airPower / PS_PER_KW * 9549 / rpm;
        } else {
            v.torque = dmeTorque;
            v.power = dmePower;
        }
        v.rpmPeak = this._peakOf('rpm', v.rpm);
        v.torquePeak = this._peakOf('torque', v.torque);
        v.powerPeak = this._peakOf('power', v.power);
        v.boostPeak = this._peakOf('boost', v.boost);
        v.oilPressPeak = this._peakOf('oilPress', v.oilPress);
        let status = '';
        if (this._gateway === 'failed') {
            status = `DME nicht erreichbar: ${this._gatewayError}`;
        } else if (this._gateway === 'open' && this._round > 2 && FAST.every((kv) => !isNum(m[kv[0]]))) {
            status = `Keine Antwort der DME – Zündung an?${this._gatewayError ? ` (${this._gatewayError})` : ''}`;
        }
        v.status = status;
        this._v = v;
        v.statusErr = this._gateway === 'failed';
        if (this._drawn && this._drawn.isShown()) {
            this._drawn.set(v);
            return;
        }
        if (this._drawn) {
            this._drawn.set(v);
        }
        if (this._layerState && (!this._drawn || this._drawn.mode !== null)) {
            // the drawn screen (or the renderer not answered yet): the list state stays empty under it
            this.show('', []);
            this.showButton(false);
            return;
        }
        this.showButton(true);
        this.show(status, [
            ['Drehzahl', withPeak(v.rpm, v.rpmPeak, 'U/min', 0)],
            ['Öltemperatur', fmt(v.oil, '°C', 0)],
            ['Kühlmittel', fmt(v.coolant, '°C', 0)],
            ['Ansaugluft', fmt(v.intake, '°C', 0)],
            ['Ladedruck', withPeak(v.boost, v.boostPeak, 'bar', 2)],
            ['Ladedruck Soll', fmt(v.boostTarget, 'bar', 2)],
            ['Öldruck', withPeak(v.oilPress, v.oilPressPeak, 'bar', 2)],
            ['Leistung', withPeak(v.power, v.powerPeak, 'PS', 0)],
            ['Drehmoment', withPeak(v.torque, v.torquePeak, 'Nm', 0)],
            ['Getriebeöl', fmt(v.gearbox, '°C', 0)],
            ['Abgas', fmt(v.exhaust, '°C', 0)],
            ['Bordspannung', fmt(v.voltage, 'V', 1)]
        ]);
    }
}

// the version from the package beside the app (read, not required: the unit builds only from app modules)
Diag.note(`Start ${(() => {
    try {
        return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8')).version;
    } catch (e) {
        return '?';
    }
})()}`);
// memory once a minute in the notebook: MainApp ends an app past its memoryThresholdKB
setInterval(() => {
    const m = process.memoryUsage();
    Diag.note(`Speicher ${Math.round(m.rss / 1048576)} MB (Heap ${Math.round(m.heapUsed / 1048576)} MB)`);
}, 60000).unref();
const app = new Motordaten();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`motordaten failed to start: ${err && err.message}`);
});
