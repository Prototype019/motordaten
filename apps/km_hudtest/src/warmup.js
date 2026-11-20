'use strict';
/**
 * What the head-up display shows (src/hud_draw.js draws it), for the temperatures v { oil, coolant } and the
 * settings s (src/settings.js); null: nothing (BMW's own HUD as it is).
 *
 * - mode off: nothing.  Warm-up with the oil not known: nothing.
 * - hot (any mode but off): the oil at or over oilMax, in red, while it lasts (in values mode only when the
 *   oil is not one of the values shown: there it turns red itself).
 * - mode values: the chosen values (settings shown(), v holds them), each with its tone (cold / hot / normal).
 * - mode warm:
 *     warm:  the first temperature switched on that is still under its value (one not known does not hold
 *            it up: the car may not send it);
 *     ready: "Bereit" for READY_SHOW_MS once every one is there; then nothing, until the oil is AGAIN_BELOW
 *            under its value again (a cold start later in the same run of the app). No temperature switched
 *            on: nothing.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const S = require('./settings.js');
const V = require('./values.js');

const READY_SHOW_MS = 5000;
const AGAIN_BELOW = 15;

const isNum = (v) => typeof v === 'number' && isFinite(v);

class Warmup {
    constructor() {
        this.readyAt = 0;
        this.done = false;
    }

    view(v, s, now) {
        const oil = isNum(v.oil) ? v.oil : null;
        if (s.mode === 'off') return null;
        const shown = S.shown(s);
        const hot = oil !== null && oil >= s.oilMax;
        if (s.mode === 'values') {
            if (hot && shown.indexOf('oil') < 0) return { mode: 'hot', label: 'Öl', value: oil };
            return { mode: 'values', items: shown.map((key) => ({ key, label: V.byKey(key).hud, text: V.text(key, v[key]),
                unit: V.byKey(key).unit, tone: V.tone(key, v[key], s) })) };
        }
        if (oil === null) return null;
        if (hot) return { mode: 'hot', label: 'Öl', value: oil };
        const r = S.readiness(s, v);
        if (!r.on) return null;
        const missing = r.items.filter((i) => i.value !== null && !i.reached);
        if (this.done) {
            if (oil >= s.oilReady - AGAIN_BELOW) return null;
            this.done = false;
        }
        if (!missing.length) {
            if (!this.readyAt) this.readyAt = now;
            if (now - this.readyAt >= READY_SHOW_MS) {
                this.done = true;
                this.readyAt = 0;
                return null;
            }
            return { mode: 'ready', label: 'Öl', value: oil };
        }
        this.readyAt = 0;
        return { mode: 'warm', label: missing[0].short, value: missing[0].value };
    }

    /* Where it stands, in words for the screen: { title, text }. */
    words(view, s, v) {
        if (s.mode === 'off') return { title: 'HUD aus', text: 'Die App zeigt nichts im HUD.' };
        if (view && view.mode === 'values') {
            return { title: 'Werte im HUD', text: `${view.items.map((i) => V.byKey(i.key).label).join(', ')}. Ändern unter „Werte“.` };
        }
        if (!isNum(v.oil)) return { title: 'Warte auf Werte', text: 'Noch keine Öltemperatur vom Fahrzeug.' };
        if (!view) {
            const r = S.readiness(s, v);
            if (s.mode === 'warm' && !r.on) return { title: 'Nichts eingestellt', text: 'Unter „Bereit“ zählt keine Temperatur.' };
            return { title: 'Bereit', text: 'Motor warm. Das HUD ist frei für BMWs Anzeige.' };
        }
        if (view.mode === 'hot') return { title: 'Öl zu heiß', text: `Ab ${s.oilMax} °C zeigt das HUD die Öltemperatur in Rot.` };
        if (view.mode === 'ready') return { title: 'Bereit', text: 'Kurz im HUD, dann wird es frei.' };
        return { title: 'Warmfahren', text: `${view.label} noch unter ${view.label === 'Öl' ? s.oilReady : s.coolantReady} °C. Schonend fahren.` };
    }
}

/* The test in the HUD: each look for TEST_STEP_MS, from start. */
const TEST_STEP_MS = 3000;
const TEST = [
    { mode: 'warm', label: 'Öl', value: 47 },
    { mode: 'ready', label: 'Öl', value: 82 },
    { mode: 'hot', label: 'Öl', value: 133 }
];
function testView(start, now) {
    const i = Math.floor((now - start) / TEST_STEP_MS);
    return i >= 0 && i < TEST.length ? TEST[i] : null;
}

module.exports = { Warmup, READY_SHOW_MS, AGAIN_BELOW, TEST, TEST_STEP_MS, testView };
