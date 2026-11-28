'use strict';
/**
 * The car's M setups (de.bmw.infotainment.misc.MDrive), seen on the G87 on 28.11.2026:
 *   statusMDriveThree.statusMDrive3DrivingMode  the M Mode now: FAHRMODUS_1 Road, FAHRMODUS_2 Sport, FAHRMODUS_3 Track
 *   controlDisplayMSystems.controlDisplayCID    M1_AKTIV / M1_NICHT_AKTIV / M2_AKTIV / M2_NICHT_AKTIV on a press
 *   mDriveThree (get, set)                      an M setup's part with the driving mode: setupMDrive3Index picks
 *                                               the setup (KONFIGURATION_1 = M1, KONFIGURATION_2 = M2)
 * BMW's own menu on the G87 does not offer the M Mode in M1/M2; the car knows it all the same (its messages say
 * "M1 Track nur im Stand aktivierbar"). This writes the driving mode into one setup, for a test, and nothing else:
 * every other part of the setup is sent as KEINE_AENDERUNG. Only at a standstill (the car's speed known and 0).
 *
 *   const m = new MDrive({ proxy, note, now });
 *   m.status(v) / m.display(v) / m.speed(kmh)   the car's reports
 *   m.write('m1', 'sport') -> Promise           the setup's driving mode; 'none' = KEINE_AENDERUNG (as from the factory)
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */

const SETUP = Object.freeze({ m1: 'KONFIGURATION_1', m2: 'KONFIGURATION_2' });
const DRIVING = Object.freeze({ none: 'KEINE_AENDERUNG', road: 'FAHRMODUS_1', sport: 'FAHRMODUS_2', track: 'FAHRMODUS_3' });
const WORD = Object.freeze({ FAHRMODUS_1: 'Road', FAHRMODUS_2: 'Sport', FAHRMODUS_3: 'Track', KEINE_AENDERUNG: 'keine Änderung' });
// the other parts of mDriveThree: left as they are
const REST = Object.freeze(['setupMDrive3Sound', 'setupMDrive3MSA', 'setupMDrive3ASR', 'setupMDrive3BrakePedal',
    'setupMDrive3MControlPlusTraction', 'setupMDrive3MControlPlusBrakeBalance']);
const STILL_KMH = 1;        // at most this fast counts as standing
const SPEED_MAX_AGE_MS = 5000;
const TIMEOUT_MS = 5000;

/* The value for mDriveThree: the setup, its driving mode, everything else unchanged. */
function value(setup, mode) {
    if (!SETUP[setup]) throw new Error(`unbekanntes Setup ${setup}`);
    if (!DRIVING[mode]) throw new Error(`unbekannter Fahrmodus ${mode}`);
    if (mode === 'track') throw new Error('Track wird nicht geschrieben');
    const v = { setupMDrive3Index: SETUP[setup], setupMDrive3DrivingMode: DRIVING[mode] };
    REST.forEach((k) => { v[k] = 'KEINE_AENDERUNG'; });
    return v;
}

const word = (raw) => WORD[raw] || (raw === undefined || raw === null ? '–' : String(raw));
const short = (v) => { let t; try { t = JSON.stringify(v); } catch (e) { t = String(v); } return String(t).slice(0, 300); };

class MDrive {
    constructor(o) {
        this._proxy = o.proxy || null;      // MDrive proxy (setter and getter of mDriveThree), null while not there
        this._note = o.note || (() => {});
        this._now = o.now || Date.now;
        this._changed = o.changed || (() => {});
        this.mode = null;                   // the M Mode now (FAHRMODUS_n)
        this.cid = null;                    // the last M1/M2 message
        this._kmh = null;
        this._kmhAt = 0;
        this.busy = false;
        this.result = null;                 // { ok, text, at }
    }

    setProxy(p) { this._proxy = p; this._changed(); }

    status(v) {
        const m = v && v.statusMDrive3DrivingMode;
        if (m && m !== this.mode) { this.mode = m; this._note(`M: Fahrmodus jetzt ${word(m)}`); this._changed(); }
    }

    display(v) {
        const c = v && v.controlDisplayCID;
        if (c && c !== 'KEINE_TAFEL_ANZEIGEN' && c !== this.cid) { this.cid = c; this._note(`M: ${c}`); }
    }

    speed(kmh) { this._kmh = kmh; this._kmhAt = this._now(); }

    /* Why writing is not allowed now, or null. */
    blocked() {
        if (!this._proxy) return 'MDrive im Auto nicht erreichbar';
        if (this.busy) return 'läuft noch';
        if (this._kmh === null || this._now() - this._kmhAt > SPEED_MAX_AGE_MS) return 'Tempo unbekannt – nur im Stand';
        if (this._kmh > STILL_KMH) return 'nur im Stand';
        return null;
    }

    write(setup, mode) {
        const why = this.blocked();
        const done = (ok, text) => {
            this.busy = false;
            this.result = { ok, text, at: this._now() };
            this._note(`M-Test: ${text}`);
            this._changed();
            return ok;
        };
        let v;
        try { v = value(setup, mode); } catch (e) { return Promise.resolve(done(false, e.message)); }
        if (why) return Promise.resolve(done(false, `nicht geschrieben: ${why}`));
        this.busy = true;
        this._changed();
        const p = this._proxy;
        const read = (what) => Promise.resolve()
            .then(() => p.mDriveThree.getValue(TIMEOUT_MS))
            .then((r) => this._note(`M-Test: mDriveThree ${what}: ${short(r)}`))
            .catch((e) => this._note(`M-Test: mDriveThree ${what} nicht lesbar (${String(e && e.message).slice(0, 120)})`));
        return read('vorher')
            .then(() => { this._note(`M-Test: schreibe ${short(v)}`); return p.mDriveThree.setValue(v, TIMEOUT_MS); })
            .then((r) => read('nachher').then(() => done(true, `${setup.toUpperCase()} = ${word(DRIVING[mode])} geschrieben${r !== undefined ? ` (Antwort ${short(r).slice(0, 80)})` : ''}`)))
            .catch((e) => done(false, `abgelehnt: ${String(e && e.message).slice(0, 160)}`));
    }
}

module.exports = { MDrive, value, word, SETUP, DRIVING };
