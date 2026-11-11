'use strict';
/**
 * Motordaten: engine speed, oil and coolant temperature on one iDrive 8
 * widget screen (tools/gen.js). Values come from the CDS interface over
 * SOME/IP; the status line at the top shows what the app is waiting for or
 * what failed, so a test in the car needs no log.
 */
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const logger = logging.getSDKLogger();

const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
const ROOT = 'ST_OnlineApps_Motordaten';
const RENDER_MS = 250;
const COMPONENTS = ['mdStatus', 'mdRpm', 'mdOil', 'mdCoolant'];

/* Raw CDS values to real units; null for the invalid marker or no value. */
const RPM_INVALID = 65535;
const TEMP_INVALID = 255;
const ENGINE_STOPPED_RPM = 200;
function rpmOf(raw) {
    if (typeof raw !== 'number' || raw === RPM_INVALID) {
        return null;
    }
    const rpm = raw * 0.25;
    return rpm < ENGINE_STOPPED_RPM ? 0 : rpm;
}
function tempOf(raw) {
    return typeof raw !== 'number' || raw === TEMP_INVALID ? null : raw - 48;
}

const fmt = (v, unit) => (v === null || v === undefined ? '–' : `${Math.round(v)} ${unit}`);

class Motordaten extends OnlineApp {
    constructor() {
        super();
        this._components = {};
        this._written = {};
        this._data = { rpm: null, oil: null, coolant: null };
        this._status = 'Warte auf Fahrzeugdaten …';
        this._timer = null;
        this._shutdownPromise = null;
        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
    }

    _appInitialized() {
        logger.info(`motordaten ${this.getAppId()} starting`);
        if (!this.rhmiApplication) {
            return this.initialized();
        }
        return this._setupRhmi()
            .then(() => this._registerEntryPoint())
            .then(() => this.initialized())
            .then(() => {
                this._subscribe();
                this._timer = setInterval(() => this._render(), RENDER_MS);
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._open(last) : undefined;
            });
    }

    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._root = rhmi.getByName(ROOT);
        if (!this._root) {
            return Promise.reject(new Error(`uiDescription has no ${ROOT}`));
        }
        COMPONENTS.forEach((n) => {
            this._components[n] = rhmi.getByName(n);
            if (!this._components[n]) {
                logger.warn(`component ${n} missing`);
            }
        });
        rhmi.on('restoreHmi', () => {
            this._written = {};
            this._render();
        });
        return Promise.resolve();
    }

    _registerEntryPoint() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const d = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(d.uuid, this._root))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${d.name} ENABLED`));
    }

    _open(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._written = {};
        this._render();
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- vehicle data ---- */

    _subscribe() {
        let proxy;
        someipBuilders.buildTypedProxy(IF_CDS, '1')
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => Promise.all([
                proxy.statusEngineSpeed2.subscribe((v) => this._onRpm(v)),
                proxy.statusEngineTemperature.subscribe((v) => this._onTemps(v))
            ]))
            .then(() => {
                logger.info('CDS subscribed');
                this._status = 'Verbunden – Zündung an für Werte';
                this._render();
            })
            .catch((err) => {
                const msg = (err && err.message) || String(err);
                logger.error(`CDS unavailable: ${msg}`);
                this._status = `Fehler CDS: ${msg}`;
                this._render();
            });
    }

    _onRpm(v) {
        this._data.rpm = rpmOf(v && v.actualValueRPMEngineCrankshaft);
        this._status = '';
    }

    _onTemps(v) {
        this._data.oil = tempOf(v && v.temperatureEngineOilDrive);
        this._data.coolant = tempOf(v && v.temperatureEngineDrive);
        this._status = '';
    }

    /* ---- screen ---- */

    _render() {
        this._label('mdStatus', this._status);
        this._value('mdRpm', fmt(this._data.rpm, 'U/min'));
        this._value('mdOil', fmt(this._data.oil, '°C'));
        this._value('mdCoolant', fmt(this._data.coolant, '°C'));
    }

    _write(name, cell, value) {
        const comp = this._components[name];
        const key = `${name}.${cell}`;
        if (!comp || this._written[key] === value) {
            return;
        }
        this._written[key] = value;
        Promise.resolve(comp.setValue(0, cell, value, 'Text'))
            .catch((err) => logger.warn(`write ${key} failed: ${err && err.message}`));
    }

    _label(name, text) {
        this._write(name, 'Text', text);
        const comp = this._components[name];
        const key = `${name}.visible`;
        if (comp && this._written[key] !== !!text) {
            this._written[key] = !!text;
            Promise.resolve(comp.setProperty('Visible', text ? 1 : 0, 'UInt'))
                .catch((err) => logger.warn(`visibility ${name} failed: ${err && err.message}`));
        }
    }

    _value(name, text) {
        this._write(name, 'FrequencyText', text);
    }

    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`motordaten shutting down (${reason})`);
        clearInterval(this._timer);
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch(() => undefined))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new Motordaten();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`motordaten failed to start: ${err && err.message}`);
});
