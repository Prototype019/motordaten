'use strict';
/**
 * A fake head unit for the app tests: an oap-sdk with OnlineApp, logging and
 * someipBuilders, whose RHMI records what the app writes. Install it before
 * requiring an app's entry module:
 *
 *   const unit = require('../../../tools/fake_unit.js').install(spec, appJson, proxies);
 *   require('../src/<entry>.js');
 *   unit.rows('dtList')  -> [[left, right], ...] as written
 *
 * proxies: { iface: () => typed proxy } for buildTypedProxy.
 */
const Module = require('module');
const EventEmitter = require('events');

function install(spec, appJson, proxies) {
    const cells = {};       // name -> row -> cell -> value
    const counts = {};
    const props = {};
    const comps = {};
    const unit = { cells, counts, props, comps, opened: null, log: [], status: [] };

    const names = new Set();
    let id = 1000;
    spec.states.forEach((s) => { names.add(s.name); s.components.forEach((c) => names.add(c.name)); });

    const rhmi = Object.assign(new EventEmitter(), {
        getByName: (n) => {
            if (!names.has(n)) {
                return null;
            }
            if (!comps[n]) {
                const myId = id++;
                comps[n] = Object.assign(new EventEmitter(), {
                    getId: () => myId,
                    setValue: (row, cell, value) => {
                        cells[n] = cells[n] || {};
                        cells[n][row] = cells[n][row] || {};
                        cells[n][row][cell] = value;
                        return Promise.resolve();
                    },
                    setProperty: (p, v) => { props[`${n}.${p}`] = v; return Promise.resolve(); },
                    setRowCount: (c) => { counts[n] = c; return Promise.resolve(); }
                });
            }
            return comps[n];
        },
        mapEntryState: () => Promise.resolve(),
        openEntryState: (uuid) => { unit.opened = uuid; return Promise.resolve(); }
    });
    unit.rhmi = rhmi;
    const UUID = appJson.application.entryPoints[0].uuid;
    unit.uuid = UUID;

    class OnlineApp extends EventEmitter {
        constructor() {
            super();
            this.rhmiApplication = rhmi;
            this.appDescription = appJson;
        }
        start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
        initialized() { return Promise.resolve(); }
        getAppId() { return appJson.application.name; }
        getEntryPoints() {
            return [{ getDescription: () => ({ uuid: UUID, name: appJson.application.name }), init: () => Promise.resolve(),
                setAvailability: () => Promise.resolve() }];
        }
        getLastExecutedEntryPointUuid() { return UUID; }
        destroyBundles() { return Promise.resolve(); }
        registerActive() { unit.status.push('registerActive'); return Promise.resolve(); }
        registerHmiVisible() { unit.status.push('registerHmiVisible'); return Promise.resolve(); }
        unregisterHmiVisible() { unit.status.push('unregisterHmiVisible'); return Promise.resolve(); }
        registerInactive() { unit.status.push('registerInactive'); return Promise.resolve(); }
    }

    const logger = { info: (m) => unit.log.push(m), warn: (m) => unit.log.push(`WARN ${m}`), error: (m) => unit.log.push(`ERROR ${m}`) };
    const fakes = {
        'oap-sdk/src/core/OnlineApp.js': OnlineApp,
        'oap-sdk/src/logging/logging': { getSDKLogger: () => logger },
        'oap-sdk/src/someip/someipBuilders': {
            buildTypedProxy: (iface) => (proxies && proxies[iface] ?
                Promise.resolve(proxies[iface]()) : Promise.reject(new Error(`no fake for ${iface}`)))
        }
    };
    const load = Module._load;
    Module._load = function (req, ...rest) {
        return Object.prototype.hasOwnProperty.call(fakes, req) ? fakes[req] : load.call(this, req, ...rest);
    };

    unit.rows = (name) => {
        const n = counts[name] || 0;
        const out = [];
        for (let i = 0; i < n; i++) {
            const c = (cells[name] || {})[i] || {};
            const t = String(c.PrimaryText);
            const at = t.indexOf(': ');
            out.push(at < 0 ? [t, c.FrequencyText] : [t.slice(0, at), t.slice(at + 2)]);
        }
        return out;
    };
    unit.text = (name) => ((cells[name] || {})[0] || {}).Text;
    unit.press = (name) => comps[name].emit('action', {});
    unit.wait = (ms) => new Promise((r) => setTimeout(r, ms));
    return unit;
}

module.exports = { install };
