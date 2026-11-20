'use strict';
/**
 * The HUD app's settings, kept in its data folder (data/hud.json beside javascript/; KM_DATA_DIR in the tests).
 *
 * CHOICES: one of a few words each (mode, pos, size). ITEMS: numbers with a range and a step, and on/off
 * switches (toggle). A value read back that is not allowed is the default.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const fs = require('fs');
const path = require('path');

const CHOICES = Object.freeze({
    // warm: until every temperature switched on is reached, then nothing; always: the oil all the time; off: nothing
    mode: { def: 'warm', all: ['warm', 'always', 'off'], words: { warm: 'Warmfahren', always: 'Immer', off: 'Aus' } },
    pos: { def: 'center', all: ['left', 'center', 'right'], words: { left: 'Links', center: 'Mitte', right: 'Rechts' } },
    size: { def: 'normal', all: ['normal', 'large'], words: { normal: 'Normal', large: 'Groß' } }
});

const ITEMS = Object.freeze([
    { key: 'oilReadyOn', def: 1, min: 0, max: 1, step: 1, toggle: true },
    { key: 'oilReady', label: 'Öltemperatur', short: 'Öl', unit: '°C', def: 80, min: 50, max: 110, step: 5 },
    { key: 'coolantReadyOn', def: 1, min: 0, max: 1, step: 1, toggle: true },
    { key: 'coolantReady', label: 'Kühlmittel', short: 'Kühlmittel', unit: '°C', def: 70, min: 40, max: 100, step: 5 },
    { key: 'oilMax', label: 'Öl zu heiß ab', unit: '°C', def: 130, min: 110, max: 150, step: 5 }
]);

/* The temperatures that can count for "ready": the value, its threshold, its switch. */
const READY = Object.freeze([
    { value: 'oil', at: 'oilReady', on: 'oilReadyOn', label: 'Öltemperatur', short: 'Öl' },
    { value: 'coolant', at: 'coolantReady', on: 'coolantReadyOn', label: 'Kühlmittel', short: 'Kühlmittel' }
]);

function dataDir() {
    return process.env.KM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}
function file() {
    return path.join(dataDir(), 'hud.json');
}

function defaults() {
    const out = {};
    Object.keys(CHOICES).forEach((k) => { out[k] = CHOICES[k].def; });
    ITEMS.forEach((it) => { out[it.key] = it.def; });
    return out;
}

function onStep(it, v) {
    const n = Math.round((Math.min(it.max, Math.max(it.min, v)) - it.min) / it.step);
    return it.min + n * it.step;
}

/* Any object as settings: every key there, every value allowed. */
function clean(s) {
    const out = defaults();
    s = s || {};
    Object.keys(CHOICES).forEach((k) => { if (CHOICES[k].all.indexOf(s[k]) >= 0) out[k] = s[k]; });
    ITEMS.forEach((it) => { if (typeof s[it.key] === 'number' && isFinite(s[it.key])) out[it.key] = onStep(it, s[it.key]); });
    return out;
}

function load() {
    try {
        return clean(JSON.parse(fs.readFileSync(file(), 'utf8')));
    } catch (e) {
        return defaults();
    }
}

function save(s) {
    try {
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify(clean(s)));
        return true;
    } catch (e) {
        return false;
    }
}

/* s with key set to word (a choice), a step up or down (a number), or flipped (a switch); unknown: s. */
function chosen(s, key, word) {
    return CHOICES[key] && CHOICES[key].all.indexOf(word) >= 0 ? Object.assign({}, s, { [key]: word }) : s;
}
function stepped(s, key, dir) {
    const it = ITEMS.find((x) => x.key === key && !x.toggle);
    return it ? Object.assign({}, s, { [key]: onStep(it, s[key] + dir * it.step) }) : s;
}
function toggled(s, key) {
    const it = ITEMS.find((x) => x.key === key && x.toggle);
    return it ? Object.assign({}, s, { [key]: s[key] ? 0 : 1 }) : s;
}

/* Ready for full load for v { oil, coolant }: { on, ready, items [{ short, value, at, reached }] }. */
function readiness(s, v) {
    const items = READY.filter((r) => s[r.on]).map((r) => {
        const value = typeof v[r.value] === 'number' && isFinite(v[r.value]) ? v[r.value] : null;
        return { key: r.value, short: r.short, value, at: s[r.at], reached: value !== null && value >= s[r.at] };
    });
    return { on: items.length > 0, ready: items.length > 0 && items.every((i) => i.reached), items };
}

module.exports = { CHOICES, ITEMS, READY, defaults, clean, load, save, chosen, stepped, toggled, readiness, file };
