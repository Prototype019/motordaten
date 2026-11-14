'use strict';
/**
 * ListApp - the frame of a Motordaten head-unit app: one widget screen (a status line <prefix>Status, a
 * button <prefix>Run, a list <prefix>List whose rows read "label: value"), its tile, and telling the
 * platform when the app is in front.
 *
 * A subclass implements run() (the button; once at start), may implement stop(), bind(rhmi) and
 * visibilityChanged(visible), and calls show(status, rows), showButton(on), useEntryState(name).
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE). Copied into each app's src/ by tools/gen.js;
 * edit shared/screen.js.
 */
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');

const logger = logging.getSDKLogger();

/* The start reasons (OnlineApp startReason / visibility data) that mean the user opened the app. */
const OPENED_BY_USER = new Set(['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND']);
/* One press arrives twice (as the button's action and as a user event): the second within this is dropped. */
const DOUBLE_PRESS_MS = 400;

const warn = (what) => (err) => logger.warn(`${what}: ${err && err.message}`);

class ListApp extends OnlineApp {
    /* screen: { root: the widget state's name, prefix: its components' prefix } */
    constructor(screen) {
        super();
        this._frame = {
            screen,
            parts: {},              // Status, Run, List: the components
            shown: new Map(),       // what the HMI has: "<part>|<row>|<cell>" or "<part>|visible" -> value
            status: '',
            rows: [],
            resizing: false,
            front: false,           // the app is in front
            started: false,         // the platform has been told the app is up
            ending: null,
            pressedAt: 0,
            tile: null,             // the entry point's uuid
            entry: null             // the state the tile opens
        };
        this.on('initialized', () => this._start().catch(warn('start')));
        this.on('shutdown', (reason) => this._end(reason));
        this.on('error', warn('OnlineApp'));
        this.on('entryPointExecute', (uuid) => this._openTile(uuid));
    }

    /* ---- for the subclass ---- */

    run() {}
    stop() {}
    bind() {}
    visibilityChanged() {}

    isVisible() {
        return this._frame.front;
    }

    entryState() {
        return this._frame.entry;
    }

    /* The status line and the list's rows ([label, value]); rows left out keep theirs. */
    show(status, rows) {
        this._frame.status = status;
        if (rows) {
            this._frame.rows = rows;
        }
        this._paint();
    }

    /* The button shown or hidden. */
    showButton(on) {
        this._setVisible('Run', on);
    }

    /* The tile opens state name from now on; the app in front moves there now. */
    useEntryState(name) {
        const f = this._frame;
        const rhmi = this.rhmiApplication;
        const state = rhmi && rhmi.getByName(name);
        if (!state || !f.tile || f.entry === name) {
            return;
        }
        const before = f.entry;
        f.entry = name;
        logger.info(`entry state ${name}`);
        Promise.resolve(rhmi.mapEntryState(f.tile, state))
            .then(() => {
                if (!f.front) {
                    return undefined;
                }
                return Promise.resolve(rhmi.openState(name)).then(() => (before ? rhmi.closeState(before) : undefined));
            })
            .catch(warn(`entry state ${name}`));
    }

    /* ---- start, tile, front ---- */

    _start() {
        const f = this._frame;
        const rhmi = this.rhmiApplication;
        logger.info(`${this.getAppId()} starting`);
        if (!rhmi) {
            return Promise.resolve(this.initialized());
        }
        const root = rhmi.getByName(f.screen.root);
        if (!root) {
            return Promise.reject(new Error(`no state ${f.screen.root} in the description`));
        }
        for (const part of ['Status', 'Run', 'List']) {
            f.parts[part] = rhmi.getByName(f.screen.prefix + part) || null;
            if (!f.parts[part]) {
                logger.warn(`no component ${f.screen.prefix}${part}`);
            }
        }
        this._listenForPresses(rhmi);
        // the HMI restarted: it has nothing of ours any more
        rhmi.on('restoreHmi', () => { f.shown.clear(); this._paint(); });
        // the HMI's application stack: ours on top (ROOT_APP) while the app is in front
        rhmi.on('applicationStackChanged', (stack) => {
            if (stack && typeof stack === 'object' && Object.keys(stack).length) {
                this._front('ROOT_APP' in stack);
            }
        });
        this.bind(rhmi);
        const reason = (this.getVisibilityData && (this.getVisibilityData() || {}).reason) || this.startReason;
        const openedByUser = OPENED_BY_USER.has(reason);
        return this._registerTile(rhmi, root)
            .then(() => this.initialized())
            .then(() => {
                f.started = true;
                this._paint();
                if (openedByUser || f.front) {
                    // in front before the platform could be told: tell it now
                    f.front = false;
                    this._front(true);
                }
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                if (last) {
                    this._openTile(last);
                }
                setImmediate(() => this.run());
            });
    }

    _listenForPresses(rhmi) {
        const button = this._frame.parts.Run;
        if (!button) {
            return;
        }
        let id = null;
        try {
            id = Number(button.getId());
        } catch (e) { /* no id: the action alone */ }
        button.on('action', () => this._pressed());
        rhmi.on('userEvent', (ev) => {
            if (id !== null && ev && ev.eventType === 'ACTION' && Number(ev.sourceId) === id) {
                this._pressed();
            }
        });
    }

    _pressed() {
        const now = Date.now();
        if (now - this._frame.pressedAt >= DOUBLE_PRESS_MS) {
            this._frame.pressedAt = now;
            this.run();
        }
    }

    /* Our tile (the entry point the manager handed over that our description names), opening the root state. */
    _registerTile(rhmi, root) {
        const f = this._frame;
        const ours = new Set(((this.appDescription && this.appDescription.application.entryPoints) || []).map((d) => d.uuid));
        const tile = this.getEntryPoints().find((ep) => ours.has(ep.getDescription().uuid));
        if (!tile) {
            return Promise.reject(new Error('the manager handed over none of our entry points'));
        }
        const desc = tile.getDescription();
        f.tile = desc.uuid;
        f.entry = f.screen.root;
        return Promise.resolve(tile.init())
            .then(() => rhmi.mapEntryState(desc.uuid, root))
            .then(() => tile.setAvailability('ENABLED'))
            .then(() => logger.info(`tile ${desc.name} enabled`));
    }

    _openTile(uuid) {
        if (this._frame.ending || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._frame.shown.clear();
        this._paint();
        this._front(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid)).catch(warn('open entry state'));
    }

    /* The app came to the front or left it: the subclass hears it, the platform is told (once started). */
    _front(front) {
        const f = this._frame;
        if (f.ending || f.front === front) {
            return;
        }
        f.front = front;
        if (front) {
            f.shown.clear();
            this._paint();
        }
        try {
            this.visibilityChanged(front);
        } catch (e) {
            logger.warn(`visibilityChanged: ${e && e.message}`);
        }
        if (!f.started) {
            return;
        }
        const tell = front ? ['registerActive', 'registerHmiVisible'] : ['unregisterHmiVisible', 'registerInactive'];
        tell.filter((m) => typeof this[m] === 'function')
            .forEach((m) => Promise.resolve().then(() => this[m]()).catch(warn(m)));
    }

    _end(reason) {
        const f = this._frame;
        if (!f.ending) {
            logger.info(`${this.getAppId()} ending (${reason})`);
            try {
                this.stop();
            } catch (e) { /* ending anyway */ }
            f.ending = Promise.resolve()
                .then(() => this.destroyBundles().catch(() => undefined))
                .then(() => process.exit(0));
        }
        return f.ending;
    }

    /* ---- the widgets: only what changed goes to the HMI ---- */

    _paint() {
        const f = this._frame;
        this._setText('Status', 0, 'Text', f.status);
        this._setVisible('Status', !!f.status);
        this._paintRows(f.rows);
    }

    _setText(part, row, cell, value) {
        const f = this._frame;
        const comp = f.parts[part];
        const key = `${part}|${row}|${cell}`;
        if (comp && f.shown.get(key) !== value) {
            f.shown.set(key, value);
            Promise.resolve().then(() => comp.setValue(row, cell, value, 'Text')).catch(warn(`write ${key}`));
        }
    }

    _setVisible(part, on) {
        const f = this._frame;
        const comp = f.parts[part];
        const key = `${part}|visible`;
        if (comp && f.shown.get(key) !== on) {
            f.shown.set(key, on);
            Promise.resolve().then(() => comp.setProperty('Visible', on ? 1 : 0, 'UInt')).catch(warn(`visibility ${part}`));
        }
    }

    /* A new number of rows first (the cells wait for it), then each row's text. iDrive 8 shows no second
     * column on rows added at runtime, so label and value share the row's PrimaryText. */
    _paintRows(rows) {
        const f = this._frame;
        const list = f.parts.List;
        this._setVisible('List', rows.length > 0);
        if (!list || f.resizing) {
            return;
        }
        if (f.shown.get('List|count') !== rows.length) {
            for (const key of Array.from(f.shown.keys())) {
                if (key.indexOf('List|') === 0) {
                    f.shown.delete(key);
                }
            }
            f.shown.set('List|count', rows.length);
            f.resizing = true;
            Promise.resolve().then(() => list.setRowCount(rows.length)).catch(warn('row count'))
                .then(() => { f.resizing = false; this._paint(); });
            return;
        }
        rows.forEach(([label, value], i) => {
            const v = value === undefined || value === null ? '' : String(value);
            this._setText('List', i, 'PrimaryText', v ? `${label}: ${v}` : String(label));
        });
    }
}

module.exports = { ListApp, logger };
