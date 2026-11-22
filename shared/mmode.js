'use strict';
/**
 * M1 / M2 button -> M Mode (ROAD, SPORT, TRACK): the G87's M setups do not hold the M Mode, so the driver picks
 * here which mode a press of M1 and of M2 brings. Only the decision lives here; the two ends are given:
 *
 *   const m = new MMode({ pick: () => ({ m1: 'sport', m2: 'road' }), send: (mode) => ..., note: (text) => ... });
 *   m.setup('m1' | 'm2' | null);        // the car: which M setup is on (null: none)
 *   m.mode('road' | 'sport' | 'track'); // the car: the M Mode now
 *
 * Rules: only a change to M1 or M2 counts (a press), never what is on when the app starts; one command per press
 * and none when the mode is already the wanted one; nothing when a setup goes off; a mode the driver picks with
 * the M Mode button stays until the next press. send() is the only way out to the car.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const MODES = Object.freeze(['road', 'sport', 'track']);
const WORDS = Object.freeze({ none: 'Nichts', road: 'Road', sport: 'Sport', track: 'Track' });
const GAP_MS = 1000;   // never two commands closer than this (a bouncing report)

class MMode {
    constructor(o) {
        this._pick = o.pick;
        this._send = o.send;
        this._note = o.note || (() => {});
        this._now = o.now || Date.now;
        this._setup = undefined;   // undefined: not heard from the car yet
        this._mode = null;
        this._last = 0;
    }

    mode(m) {
        this._mode = MODES.indexOf(m) >= 0 ? m : null;
    }

    setup(which) {
        const s = which === 'm1' || which === 'm2' ? which : null;
        const first = this._setup === undefined;
        const was = this._setup;
        this._setup = s;
        if (first || s === was || !s) return false;
        const want = (this._pick() || {})[s];
        if (MODES.indexOf(want) < 0) return false;
        if (want === this._mode) return false;
        const now = this._now();
        if (now - this._last < GAP_MS) return false;
        this._last = now;
        this._note(`M Mode: ${s.toUpperCase()} gedrückt, schalte auf ${WORDS[want]}`);
        try {
            this._send(want);
        } catch (e) {
            this._note(`M Mode: Befehl ging nicht raus (${e.message})`);
            return false;
        }
        return true;
    }
}

module.exports = { MMode, MODES, WORDS };
