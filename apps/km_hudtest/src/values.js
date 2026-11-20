'use strict';
/**
 * The values the HUD can show, in the order the settings start with: where each comes from, its words, its
 * format and its colour against the settings (src/settings.js).
 *
 * src: 'cds' the car's own signal (free: nothing on the diagnostic gateway); 'dme' / 'egs' / 'obd' a read
 * through the gateway (src/tasu.js, read-only), asked only while the HUD shows the value.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const VALUES = Object.freeze([
    { key: 'oil', label: 'Öl', hud: 'ÖL', unit: '°C', d: 0, src: 'cds' },
    { key: 'coolant', label: 'Kühlmittel', hud: 'WASSER', unit: '°C', d: 0, src: 'cds' },
    { key: 'rpm', label: 'Drehzahl', hud: 'DREHZAHL', unit: 'U/min', d: 0, src: 'cds', thousands: true },
    { key: 'boost', label: 'Ladedruck', hud: 'LADEDRUCK', unit: 'bar', d: 2, src: 'dme' },
    { key: 'oilPress', label: 'Öldruck', hud: 'ÖLDRUCK', unit: 'bar', d: 1, src: 'dme' },
    { key: 'intake', label: 'Ansaugluft', hud: 'ANSAUGLUFT', unit: '°C', d: 0, src: 'dme' },
    { key: 'gearbox', label: 'Getriebeöl', hud: 'GETRIEBE', unit: '°C', d: 0, src: 'egs' },
    { key: 'voltage', label: 'Bordnetz', hud: 'BORDNETZ', unit: 'V', d: 1, src: 'obd' }
]);
const KEYS = Object.freeze(VALUES.map((x) => x.key));
const MAX_SHOWN = 3;

const isNum = (v) => typeof v === 'number' && isFinite(v);
const byKey = (key) => VALUES.find((x) => x.key === key);

/* "96", "1,85", "3.450", "–" */
function text(key, v) {
    const it = byKey(key);
    if (!it || !isNum(v)) return '–';
    const s = v.toFixed(it.d).replace('.', ',');
    return it.thousands ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : s.replace(/^-(0(,0+)?)$/, '$1');
}

/* cold (still under its ready value, while it counts), hot (at or over its limit), or normal. */
function tone(key, v, s) {
    if (!isNum(v)) return 'none';
    if (key === 'oil') return v >= s.oilMax ? 'hot' : s.oilReadyOn && v < s.oilReady ? 'cold' : 'normal';
    if (key === 'coolant') return v >= s.coolantMax ? 'hot' : s.coolantReadyOn && v < s.coolantReady ? 'cold' : 'normal';
    if (key === 'rpm') return v >= s.rpmMax ? 'hot' : 'normal';
    return 'normal';
}

module.exports = { VALUES, KEYS, MAX_SHOWN, byKey, text, tone };
