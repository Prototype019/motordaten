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
const V = require('./values.js');

const CHOICES = Object.freeze({
    // warm: until every temperature switched on is reached, then nothing; values: the chosen values all the time
    // (cold ones blue, hot ones red); off: nothing
    mode: { def: 'warm', all: ['warm', 'values', 'off'], words: { warm: 'Warmfahren', values: 'Werte', off: 'Aus' } },
    pos: { def: 'center', all: ['left', 'center', 'right'], words: { left: 'Links', center: 'Mitte', right: 'Rechts' } },
    size: { def: 'normal', all: ['normal', 'large'], words: { normal: 'Normal', large: 'Groß' } }
});

const ITEMS = Object.freeze([
    { key: 'oilReadyOn', def: 1, min: 0, max: 1, step: 1, toggle: true },
    { key: 'oilReady', label: 'Öltemperatur', short: 'Öl', unit: '°C', def: 80, min: 50, max: 110, step: 5 },
    { key: 'coolantReadyOn', def: 1, min: 0, max: 1, step: 1, toggle: true },
    { key: 'coolantReady', label: 'Kühlmittel', short: 'Kühlmittel', unit: '°C', def: 70, min: 40, max: 100, step: 5 },
    { key: 'oilMax', label: 'Öl zu heiß ab', unit: '°C', def: 130, min: 110, max: 150, step: 5 },
    { key: 'coolantMax', label: 'Kühlmittel zu heiß ab', unit: '°C', def: 115, min: 100, max: 125, step: 1 },
    { key: 'rpmMax', label: 'Drehzahl rot ab', unit: 'U/min', def: 6400, min: 4000, max: 7600, step: 100 },
    // how many of the order's first values the HUD shows (Werte)
    { key: 'count', def: 1, min: 1, max: V.MAX_SHOWN, step: 1 }
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

/* order as a valid order: every value once, unknown ones dropped, missing ones appended. */
function cleanOrder(order) {
    const seen = (Array.isArray(order) ? order : []).filter((k, i, all) => V.KEYS.indexOf(k) >= 0 && all.indexOf(k) === i);
    return seen.concat(V.KEYS.filter((k) => seen.indexOf(k) < 0));
}

function defaults() {
    const out = { order: V.KEYS.slice() };
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
    if (s.mode === 'always') s = Object.assign({}, s, { mode: 'values' });      // 0.3.0's word
    Object.keys(CHOICES).forEach((k) => { if (CHOICES[k].all.indexOf(s[k]) >= 0) out[k] = s[k]; });
    out.order = cleanOrder(s.order);
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

/* Saves whole or not at all (a temp file renamed over it); false when it could not. */
function save(s) {
    try {
        fs.mkdirSync(dataDir());           // one level (Node 8 on the car has no recursive mkdir)
    } catch (e) {
        /* there */
    }
    try {
        const tmp = `${file()}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(clean(s)));
        fs.renameSync(tmp, file());
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

/* The values the HUD shows (Werte): the order's first count. */
function shown(s) {
    return cleanOrder(s.order).slice(0, s.count);
}

/*
 * A value tapped: out of the HUD when in it, else in at the end of the shown ones (the last one out when full).
 * A value dragged to index of order (the new order with it there): in the HUD when it landed among the shown ones
 * (one more shown if there is room, else the last one out), out when it landed after them.
 */
function tapped(s, key) {
    const order = cleanOrder(s.order);
    const i = order.indexOf(key);
    if (i < 0) return s;
    order.splice(i, 1);
    if (i < s.count) {
        if (s.count <= 1) return s;                     // the last one stays: Aus is the mode's job
        order.splice(s.count - 1, 0, key);
        return Object.assign({}, s, { order, count: s.count - 1 });
    }
    const count = Math.min(V.MAX_SHOWN, s.count + 1);
    order.splice(count - 1, 0, key);
    return Object.assign({}, s, { order, count });
}
function dropped(s, order, key) {
    const before = cleanOrder(s.order);
    const was = before.indexOf(key) < s.count;
    order = cleanOrder(order);
    const now = order.indexOf(key);
    let count = s.count;
    if (!was && now < s.count) {
        // in: one more shown while there is room; full, the one pushed past the shown ones is out
        count = Math.min(V.MAX_SHOWN, s.count + 1);
    } else if (was && now >= s.count) {
        if (s.count <= 1) return s;                      // the last one stays
        count = s.count - 1;
    }
    return Object.assign({}, s, { order, count });
}

/* Ready for full load for v { oil, coolant }: { on, ready, items [{ short, value, at, reached }] }. */
function readiness(s, v) {
    const items = READY.filter((r) => s[r.on]).map((r) => {
        const value = typeof v[r.value] === 'number' && isFinite(v[r.value]) ? v[r.value] : null;
        return { key: r.value, short: r.short, value, at: s[r.at], reached: value !== null && value >= s[r.at] };
    });
    return { on: items.length > 0, ready: items.length > 0 && items.every((i) => i.reached), items };
}

module.exports = { CHOICES, ITEMS, READY, defaults, clean, cleanOrder, load, save, chosen, stepped, toggled, readiness, shown, tapped, dropped, file };
