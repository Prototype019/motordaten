'use strict';
/**
 * Diagnose-Test: asks the engine unit (DME) through the head unit's
 * diagnostic gateway, read-only (src/tasu.js), and shows on screen:
 *   1. whether the gateway service opens,
 *   2. the DME's type (SGBD index, 22 F1 50),
 *   3. which OBD-II PIDs it supports (01 00 / 20 / 40 / 60),
 *   4. the BMW values (22 <DID>) and OBD-II values (01 <PID>) of src/decode.js.
 * Every row is there from the start ("…") and fills in as the answers come.
 * "Erneut testen" runs it again.
 */
const { ListApp, logger } = require('./screen.js');
const { Tasu } = require('./tasu.js');
const D = require('./decode.js');

const STEPS = [{ key: 'open', label: 'Diagnose-Dienst' }, { key: 'type', label: 'DME-Typ (SGBD)' },
    { key: 'obd', label: 'OBD unterstützt' }]
    .concat(D.DIDS.map((did) => ({ key: 'did', did, label: `BMW ${D.hex(did.id, 4)} ${did.name}` })))
    .concat(D.OBD.map((pid) => ({ key: 'pid', pid, label: `OBD ${D.hex(pid.pid)} ${pid.name}` })))
    .concat([{ key: 'raw', label: 'Rohdaten 1. Antwort' }]);

class Diagtest extends ListApp {
    constructor() {
        super({ root: 'ST_OnlineApps_Diagtest', prefix: 'dg' });
        this._tasu = new Tasu(logger);
        this._running = false;
        this._results = [];
    }

    run() {
        if (this._running) {
            return;
        }
        this._running = true;
        this._results = STEPS.map(() => '…');
        this._show('Öffne Diagnose-Dienst … (Zündung an?)');
        this._go()
            .catch((e) => this._show(`Abbruch: ${e.message}`))
            .then(() => {
                this._running = false;
                logger.info(`diagtest: ${STEPS.map((s, i) => `${s.label}=${this._results[i]}`).join(' | ')}`);
            });
    }

    _show(status) {
        this.show(status, STEPS.map((s, i) => [s.label, this._results[i]]));
    }

    _put(i, value) {
        this._results[i] = value;
        this._show(this._mdStatus);
    }

    _go() {
        return this._tasu.open()
            .then(() => this._put(0, 'offen'), (e) => {
                this._put(0, `FEHLER: ${e.message}`);
                throw new Error('Diagnose-Dienst nicht verfügbar');
            })
            .then(() => STEPS.reduce((p, s, i) => p.then(() => this._step(s, i)), Promise.resolve()))
            .then(() => this._show(this._tasu.dmeFrames ? '' : 'Keine Antwort der DME – Zündung an?'));
    }

    _step(s, i) {
        switch (s.key) {
        case 'type':
            return this._read(i, 0x22, [0xF1, 0x50], (u) => {
                const t = D.dmeType(u);
                if (!t) {
                    return u[0] === 0x7F ? `nein: ${D.NRC[u[2]] || D.hex(u[2])}` : null;
                }
                return `${t.index} = ${t.type || 'unbekannt'}`;
            });
        case 'obd':
            return this._obdSupport(i);
        case 'did':
            return this._read(i, 0x22, [s.did.id >> 8, s.did.id & 0xFF], (u) => D.didValue(s.did, u));
        case 'pid':
            return this._read(i, 0x01, [s.pid.pid], (u) => D.obdValue(s.pid, u));
        case 'raw':
            this._put(i, this._tasu.firstFrame || 'keine');
            return Promise.resolve();
        default:
            return Promise.resolve();
        }
    }

    _read(i, sid, data, decode) {
        this._show(`Frage: ${STEPS[i].label} …`);
        return this._tasu.request(sid, data)
            .then((u) => this._put(i, u ? (decode(u) || `? ${D.hexBytes(u.slice(0, 8))}`) : 'keine Antwort'),
                (e) => this._put(i, `FEHLER: ${e.message}`));
    }

    _obdSupport(i) {
        this._show(`Frage: ${STEPS[i].label} …`);
        const all = [];
        return [0x00, 0x20, 0x40, 0x60].reduce((p, base) => p.then(() => this._tasu.request(0x01, [base])
            .then((u) => {
                const s = u && D.supported(base, u);
                if (s) {
                    all.push.apply(all, s);
                }
            }, () => undefined)), Promise.resolve())
            .then(() => {
                const have = D.OBD.map((p) => p.pid).filter((p) => all.indexOf(p) >= 0).map((p) => D.hex(p));
                this._put(i, all.length ? `${all.length} PIDs, davon: ${have.join(' ') || 'keine'}` : 'keine Antwort');
            });
    }
}

const app = new Diagtest();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`diagtest failed to start: ${err && err.message}`);
});
