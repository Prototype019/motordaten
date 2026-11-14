'use strict';
/**
 * The limits the screen shows values against, set on the settings page and
 * kept in the app's data folder (data/limits.json beside javascript/; the
 * folder KM_DATA_DIR names in the tests).
 *
 * ITEMS: key, label, unit, default, min, max, step, decimals, group: 'limits'
 * (where the screen turns red) or 'ready' (when the engine is ready for full
 * load: which temperatures count, as on/off items 0/1, and from where). A
 * value read back is clamped to its range and put on its step; one that
 * cannot be read is the default.
 */
const fs = require('fs');
const path = require('path');

const ITEMS = Object.freeze([
    { key: 'rpmRed', label: 'Drehzahl rot ab', unit: 'U/min', def: 6400, min: 4000, max: 7600, step: 100, d: 0 },
    { key: 'oilMax', label: 'Öltemperatur-Warnung ab', unit: '°C', def: 130, min: 110, max: 150, step: 5, d: 0 },
    { key: 'boostMax', label: 'Ladedruck-Skala bis', unit: 'bar', def: 2.5, min: 1.5, max: 3.5, step: 0.5, d: 1 },
    { key: 'oilPressMin', label: 'Öldruck-Warnung unter', unit: 'bar', def: 1.0, min: 0.5, max: 2.5, step: 0.1, d: 1 },
    { key: 'coolantMax', label: 'Kühlmittel-Warnung ab', unit: '°C', def: 115, min: 100, max: 125, step: 1, d: 0 },
    { key: 'gearboxMax', label: 'Getriebeöl-Warnung ab', unit: '°C', def: 120, min: 90, max: 140, step: 5, d: 0 },
    { key: 'exhaustMax', label: 'Abgas-Warnung ab', unit: '°C', def: 900, min: 600, max: 1000, step: 25, d: 0 },
    { key: 'knockMax', label: 'Klopf-Warnung ab', unit: '°KW', def: 3, min: 1, max: 8, step: 0.5, d: 1 },
    { key: 'oilLevelMin', label: 'Ölstand-Warnung unter', unit: 'l', def: 0.3, min: 0, max: 1, step: 0.1, d: 1 },
    // ready for full load: each temperature on or off, and the one it has to reach
    { key: 'oilReadyOn', group: 'ready', def: 1, min: 0, max: 1, step: 1, d: 0, toggle: true },
    { key: 'oilReady', group: 'ready', label: 'Öltemperatur', unit: '°C', def: 80, min: 50, max: 110, step: 5, d: 0 },
    { key: 'coolantReadyOn', group: 'ready', def: 1, min: 0, max: 1, step: 1, d: 0, toggle: true },
    { key: 'coolantReady', group: 'ready', label: 'Kühlmittel', unit: '°C', def: 70, min: 40, max: 100, step: 5, d: 0 },
    { key: 'gearboxReadyOn', group: 'ready', def: 0, min: 0, max: 1, step: 1, d: 0, toggle: true },
    { key: 'gearboxReady', group: 'ready', label: 'Getriebeöl', unit: '°C', def: 50, min: 30, max: 90, step: 5, d: 0 }
].map((it) => Object.assign({ group: 'limits' }, it)));

/* The temperatures that can count for "ready": the value's key, its threshold item, its on/off item. */
const READY = Object.freeze([
    { value: 'oil', at: 'oilReady', on: 'oilReadyOn', label: 'Öltemperatur', short: 'Öl' },
    { value: 'coolant', at: 'coolantReady', on: 'coolantReadyOn', label: 'Kühlmittel', short: 'Kühlmittel' },
    { value: 'gearbox', at: 'gearboxReady', on: 'gearboxReadyOn', label: 'Getriebeöl', short: 'Getriebe' }
]);

function dataDir() {
    return process.env.KM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function file() {
    return path.join(dataDir(), 'limits.json');
}

function onStep(item, v) {
    const n = Math.round((Math.min(item.max, Math.max(item.min, v)) - item.min) / item.step);
    return Number((item.min + n * item.step).toFixed(item.d + 2));
}

function defaults() {
    const out = {};
    ITEMS.forEach((it) => { out[it.key] = it.def; });
    return out;
}

/* The limits as saved, each on its range and step; the defaults where none is saved. */
function load() {
    const out = defaults();
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
    } catch (e) {
        /* none yet */
    }
    ITEMS.forEach((it) => {
        if (typeof saved[it.key] === 'number' && isFinite(saved[it.key])) {
            out[it.key] = onStep(it, saved[it.key]);
        }
    });
    return out;
}

/* Saves whole or not at all (a temp file renamed over it). */
function save(limits) {
    try {
        fs.mkdirSync(dataDir());           // one level (Node 8 on the car has no recursive mkdir)
    } catch (e) {
        /* there */
    }
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(limits));
    fs.renameSync(tmp, file());
}

/* limits with key moved by dir steps (-1 / +1), on its range. */
function stepped(limits, key, dir) {
    const it = ITEMS.find((x) => x.key === key);
    if (!it) {
        return limits;
    }
    return Object.assign({}, limits, { [key]: onStep(it, limits[key] + dir * it.step) });
}

/* limits with an on/off item switched. */
function toggled(limits, key) {
    const it = ITEMS.find((x) => x.key === key && x.toggle);
    return it ? Object.assign({}, limits, { [key]: limits[key] ? 0 : 1 }) : limits;
}

/* limits with one group's items back to their defaults. */
function reset(limits, group) {
    const out = Object.assign({}, limits);
    ITEMS.filter((it) => it.group === group).forEach((it) => { out[it.key] = it.def; });
    return out;
}

/*
 * Ready for full load for the values v: { on: whether any temperature counts, ready, items: each one switched on
 * { short, value, reached }, missing: those not reached { short, left } }.
 */
function readiness(limits, v) {
    const items = READY.filter((r) => limits[r.on]).map((r) => {
        const value = typeof v[r.value] === 'number' ? v[r.value] : null;
        return { short: r.short, value, reached: value !== null && value >= limits[r.at],
            left: value !== null ? Math.ceil(limits[r.at] - value) : null };
    });
    const missing = items.filter((i) => !i.reached).map((i) => ({ short: i.short, left: i.left }));
    return { on: items.length > 0, ready: items.length > 0 && !missing.length, items, missing };
}

module.exports = { ITEMS, READY, defaults, load, save, stepped, toggled, reset, readiness, onStep };
