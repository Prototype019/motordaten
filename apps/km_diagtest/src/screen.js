'use strict';
/**
 * ListApp: an OnlineApp with one iDrive 8 widget screen (tools/gen.js):
 * a status line (label <prefix>Status), a button (<prefix>Run) and a list
 * (<prefix>List, one row per [label, value] pair, shown as "label: value"). The app calls
 * this.show(status, rows); a press on the button calls this.run() (also run
 * once at start). The screen is written only where a cell changed.
 *
 * It reports the app active and visible to MainApp while its screen is in
 * front, as the MGU Store does (registerActive / registerHmiVisible).
 *
 * Copied into each app's src/ by tools/gen.js; edit shared/screen.js.
 */
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');

const logger = logging.getSDKLogger();
const PRESS_DEDUPE_MS = 400;  // the HMI reports a press as an action and as a userEvent
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];

class ListApp extends OnlineApp {
    constructor(screen) {
        super();
        this._mdScreen = screen;          // { root: state name, prefix: component prefix }
        this._mdStatus = '';
        this._mdRows = [];
        this._mdComponents = {};
        this._mdWritten = {};
        this._mdSizing = false;
        this._mdLastPress = 0;
        this._mdVisible = false;
        this._mdReady = false;
        this._mdShutdownPromise = null;
        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._mdOpen(uuid));
    }

    /* Subclasses: the work behind the button (also run once at start). */
    run() {}

    /* Subclasses: called once before the process ends. */
    stop() {}

    /* Subclasses: more of the description to bind (states, components), before the tile is registered. */
    bind() {}

    /* The tile opens state name from now on; shown now, it moves there. */
    useEntryState(name) {
        const state = this.rhmiApplication && this.rhmiApplication.getByName(name);
        if (!state || !this._mdEntryUuid || this._mdEntryState === name) {
            return;
        }
        const was = this._mdEntryState;
        this._mdEntryState = name;
        logger.info(`entry state ${name}`);
        Promise.resolve()
            .then(() => this.rhmiApplication.mapEntryState(this._mdEntryUuid, state))
            .then(() => (this._mdVisible ? this.rhmiApplication.openState(name) : undefined))
            .then(() => (this._mdVisible && was ? this.rhmiApplication.closeState(was) : undefined))
            .catch((err) => logger.warn(`entry state ${name}: ${err && err.message}`));
    }

    /* The state the tile opens. */
    entryState() {
        return this._mdEntryState;
    }

    /* Subclasses: the screen came to the front (true) or left it (false). */
    visibilityChanged() {}

    isVisible() {
        return this._mdVisible;
    }

    show(status, rows) {
        this._mdStatus = status;
        if (rows) {
            this._mdRows = rows;
        }
        this._mdRender();
    }

    _appInitialized() {
        logger.info(`${this.getAppId()} starting`);
        if (!this.rhmiApplication) {
            return this.initialized();
        }
        const rhmi = this.rhmiApplication;
        const p = this._mdScreen.prefix;
        this._mdRoot = rhmi.getByName(this._mdScreen.root);
        if (!this._mdRoot) {
            return Promise.reject(new Error(`uiDescription has no ${this._mdScreen.root}`));
        }
        ['Status', 'Run', 'List'].forEach((n) => {
            this._mdComponents[n] = rhmi.getByName(p + n);
            if (!this._mdComponents[n]) {
                logger.warn(`component ${p}${n} missing`);
            }
        });
        const run = this._mdComponents.Run;
        if (run) {
            run.on('action', () => this._mdPress());
            let id = null;
            try { id = Number(run.getId()); } catch (e) { id = null; }
            rhmi.on('userEvent', (ev) => {
                if (id !== null && ev && ev.eventType === 'ACTION' && Number(ev.sourceId) === id) {
                    this._mdPress();
                }
            });
        }
        rhmi.on('restoreHmi', () => {
            this._mdWritten = {};
            this._mdRender();
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (keys.length) {
                this._mdSetVisible(Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP'));
            }
        });
        this.bind(rhmi);
        const foreground = this._mdStartedForeground();
        return this._mdRegisterEntryPoint()
            .then(() => this.initialized())
            .then(() => {
                this._mdReady = true;
                this._mdRender();
                if (foreground || this._mdVisible) {
                    // shown before the reports could go out: report it now
                    this._mdVisible = false;
                    this._mdSetVisible(true);
                }
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                if (last) {
                    this._mdOpen(last);
                }
                setImmediate(() => this.run());
            });
    }

    _mdStartedForeground() {
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.indexOf(reason) >= 0;
    }

    _mdRegisterEntryPoint() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const d = ours.getDescription();
        this._mdEntryUuid = d.uuid;
        this._mdEntryState = this._mdScreen.root;
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(d.uuid, this._mdRoot))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${d.name} ENABLED`));
    }

    _mdOpen(uuid) {
        if (this._mdShutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._mdWritten = {};
        this._mdRender();
        this._mdSetVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* Tells MainApp the app is (no longer) in front. */
    _mdSetVisible(visible) {
        if (this._mdShutdownPromise || this._mdVisible === visible) {
            return;
        }
        this._mdVisible = visible;
        if (visible) {
            this._mdWritten = {};
            this._mdRender();
        }
        try { this.visibilityChanged(visible); } catch (e) { logger.warn(`visibilityChanged: ${e && e.message}`); }
        if (!this._mdReady) {
            return;
        }
        const call = (name) => {
            if (typeof this[name] !== 'function') {
                return;
            }
            Promise.resolve()
                .then(() => this[name]())
                .catch((err) => logger.warn(`${name} failed: ${err && err.message}`));
        };
        (visible ? ['registerActive', 'registerHmiVisible'] : ['unregisterHmiVisible', 'registerInactive']).forEach(call);
    }

    _mdPress() {
        const now = Date.now();
        if (now - this._mdLastPress < PRESS_DEDUPE_MS) {
            return;
        }
        this._mdLastPress = now;
        this.run();
    }

    /* ---- screen ---- */

    _mdRender() {
        this._mdLabel(this._mdStatus);
        this._mdList(this._mdRows);
    }

    _mdWrite(name, cell, value, row) {
        const comp = this._mdComponents[name];
        const key = `${name}.${row}.${cell}`;
        if (!comp || this._mdWritten[key] === value) {
            return;
        }
        this._mdWritten[key] = value;
        Promise.resolve()
            .then(() => comp.setValue(row, cell, value, 'Text'))
            .catch((err) => logger.warn(`write ${key} failed: ${err && err.message}`));
    }

    _mdShow(name, on) {
        const comp = this._mdComponents[name];
        const key = `${name}.visible`;
        if (!comp || this._mdWritten[key] === on) {
            return;
        }
        this._mdWritten[key] = on;
        Promise.resolve()
            .then(() => comp.setProperty('Visible', on ? 1 : 0, 'UInt'))
            .catch((err) => logger.warn(`visibility ${name} failed: ${err && err.message}`));
    }

    _mdLabel(text) {
        this._mdWrite('Status', 'Text', text, 0);
        this._mdShow('Status', !!text);
    }

    /* The row count is set first; cells written past it would grow the list
     * under a count still being set, so they wait for it. Apps set their
     * rows once (with placeholders) and fill them, so the count rarely changes. */
    _mdList(rows) {
        const comp = this._mdComponents.List;
        this._mdShow('List', rows.length > 0);
        if (!comp || this._mdSizing) {
            return;
        }
        if (this._mdWritten['List.rows'] !== rows.length) {
            Object.keys(this._mdWritten).filter((k) => k.indexOf('List.') === 0).forEach((k) => delete this._mdWritten[k]);
            this._mdWritten['List.rows'] = rows.length;
            this._mdSizing = true;
            Promise.resolve()
                .then(() => comp.setRowCount(rows.length))
                .catch((err) => logger.warn(`row count failed: ${err && err.message}`))
                .then(() => {
                    this._mdSizing = false;
                    this._mdRender();
                });
            return;
        }
        // iDrive 8 does not show FrequencyText on rows added at runtime: label and value share the row's text
        rows.forEach((r, i) => {
            const value = r[1] === undefined || r[1] === null ? '' : String(r[1]);
            this._mdWrite('List', 'PrimaryText', value ? `${r[0]}: ${value}` : String(r[0]), i);
        });
    }

    _handleShutdown(reason) {
        if (this._mdShutdownPromise) {
            return this._mdShutdownPromise;
        }
        logger.info(`${this.getAppId()} shutting down (${reason})`);
        try { this.stop(); } catch (e) { /* ending anyway */ }
        this._mdShutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch(() => undefined))
            .then(() => process.exit(0));
        return this._mdShutdownPromise;
    }
}

module.exports = { ListApp, logger };
