'use strict';
/**
 * The limits the screen shows values against, set on the settings page and
 * kept in the app's data folder (data/limits.json beside javascript/; the
 * folder KM_DATA_DIR names in the tests).
 *
 * ITEMS: key, label, unit, default, min, max, step, decimals. A value read
 * back is clamped to its range and put on its step; one that cannot be read
 * is the default.
 */
const fs = require('fs');
const path = require('path');

const ITEMS = Object.freeze([
    { key: 'rpmRed', label: 'Drehzahl rot ab', unit: 'U/min', def: 6400, min: 4000, max: 7600, step: 100, d: 0 },
    { key: 'oilReady', label: 'Öl bereit ab', unit: '°C', def: 70, min: 50, max: 100, step: 5, d: 0 },
    { key: 'oilMax', label: 'Öltemperatur-Warnung ab', unit: '°C', def: 130, min: 110, max: 150, step: 5, d: 0 },
    { key: 'boostMax', label: 'Ladedruck-Skala bis', unit: 'bar', def: 2.5, min: 1.5, max: 3.5, step: 0.5, d: 1 },
    { key: 'oilPressMin', label: 'Öldruck-Warnung unter', unit: 'bar', def: 1.0, min: 0.5, max: 2.5, step: 0.1, d: 1 },
    { key: 'coolantMax', label: 'Kühlmittel-Warnung ab', unit: '°C', def: 115, min: 100, max: 125, step: 1, d: 0 },
    { key: 'gearboxMax', label: 'Getriebeöl-Warnung ab', unit: '°C', def: 120, min: 90, max: 140, step: 5, d: 0 },
    { key: 'exhaustMax', label: 'Abgas-Warnung ab', unit: '°C', def: 900, min: 600, max: 1000, step: 25, d: 0 }
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

module.exports = { ITEMS, defaults, load, save, stepped, onStep };
