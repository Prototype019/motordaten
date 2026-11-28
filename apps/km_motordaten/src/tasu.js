'use strict';
/**
 * A read-only diagnostic link to the engine unit (DME, 0x12) and the gearbox (EGS, 0x18) through
 * the head unit's diagnostic gateway: the SOME/IP service InternalTasu, used
 * the way cauliflowermossgrape/idrive7-apps (MIT, kit/runtime/diag.js)
 * describes it:
 *
 *   request: method sendTasuRequest{ sourceAddress (TESTER), targetAddress,
 *            serviceID, subroutineID 0, udsDataLength, udsData (the bytes
 *            after the service id), deadlockTime 0 } -> a transport verdict;
 *            a busy verdict is retried (BUSY_RETRIES, BUSY_MS x 1, 2, ...)
 *   reply  : event sendTasuResponse{ udsResponse, errorCode }; the frame has a
 *            9-byte header, [6] = the answering unit, the UDS reply from [9].
 *            Every app on the unit gets every frame, so only a reply from the
 *            DME that echoes this request (or refuses this service) counts;
 *            transport errors of other requests are not ours.
 *
 * Only ReadDataByIdentifier (22, up to 8 identifiers of 2 bytes), OBD-II 01 / 09
 * (one PID) and the fault memory by status mask (19 02) to the DME or the EGS
 * pass request(), and 19 02 to all units at once through faults(); the
 * changes allowed are clearing one unit's fault memory through clearFaults()
 * (14 FF FF FF, never the head unit, never all at once) and, to the DME only,
 * MHD's Max Cooling (maxCooling: 2F 03 00/01). MHD's exhaust flap (2F 02) is not allowed
 * since 28.11.2026: its 2F 02 00 set MHD's own flap setting for good. Everything else is
 * refused here, before anything reaches the car. One request at a time, at least GAP_MS
 * apart. Proxy building, init and every call run from a fresh setImmediate
 * tick, as the SDK does (the native binding can deadlock inline), each
 * under a time limit.
 */
const EventEmitter = require('events');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF4;
/* Tester addresses a request may come from, the one to try first first: on the G87's iDrive 8 the DME
 * answers 0xF4 (an ENET tester's), while the gateway refuses 0xF2 (7F 31 25; docs/g87-s58.md). */
const TESTERS = Object.freeze([0xF4, 0xF2, 0xF1]);
const DME = 0x12;
const EGS = 0x18;
/* The units a request may go to. */
const UNITS = Object.freeze([DME, EGS]);
const GAP_MS = 25;
const OPEN_MS = 15000;
const CALL_MS = 8000;
const PENDING_MS = 10000;
const HARD_MS = 30000;
const BUSY_RETRIES = 4;
const BUSY_MS = 200;

/* Service -> length of its request data. Nothing else is sent. */
/* Service -> the lengths its request data may have. 22 takes up to 8 identifiers of 2 bytes in one
 * request (the DME answers them in one reply, docs/g87-s58.md). Nothing else is sent. */
const ALLOWED = Object.freeze({ 0x22: Object.freeze([2, 4, 6, 8, 10, 12, 14, 16]), 0x01: Object.freeze([1]), 0x09: Object.freeze([1]),
    0x19: Object.freeze([2]) });
/* The address every unit answers (a functional request), and the one request that may go to it:
 * the fault memory by status mask (19 02 <mask>). */
const ALL = 0xDF;
const FAULTS = 0x02;
/* Units whose fault memory clearFaults() leaves alone: the head unit this app runs on (clearing it may
 * restart it). */
const NO_CLEAR = Object.freeze([0x63]);

function toBytes(b) {
    if (!b) {
        return [];
    }
    if (Buffer.isBuffer(b) || b instanceof Uint8Array || Array.isArray(b)) {
        return Array.prototype.slice.call(b);
    }
    if (b.data) {
        return toBytes(b.data);
    }
    if (typeof b === 'object' && typeof b.length === 'number') {
        return Array.prototype.slice.call(b);
    }
    return [];
}

const tick = (fn) => new Promise((resolve, reject) => setImmediate(() => {
    try {
        Promise.resolve(fn()).then(resolve, reject);
    } catch (e) {
        reject(e);
    }
}));

const timeout = (p, ms, what) => {
    let t;
    return Promise.race([p, new Promise((resolve, reject) => {
        t = setTimeout(() => reject(new Error(`${what}: keine Antwort nach ${ms / 1000} s`)), ms);
    })]).then((v) => { clearTimeout(t); return v; }, (e) => { clearTimeout(t); throw e; });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isByte = (x) => Number.isInteger(x) && x >= 0 && x <= 0xFF;

/* Only the reads ALLOWED names, with whole bytes: a copy of the data, or an error. */
function checkRead(sid, data) {
    if (!Number.isInteger(sid) || !Object.prototype.hasOwnProperty.call(ALLOWED, sid) ||
        !Array.isArray(data) || ALLOWED[sid].indexOf(data.length) < 0 || !data.every(isByte) ||
        (sid === 0x19 && data[0] !== FAULTS)) {
        throw new Error(`nur lesen: Dienst ${sid} nicht erlaubt`);
    }
    return data.slice();
}

function verdictOf(r) {
    const v = r && typeof r === 'object' ?
        (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
    return v === undefined ? 'NO_ERROR' : String(v);
}

class Tasu extends EventEmitter {
    constructor(log) {
        super();
        this.log = log;
        this.firstFrame = null;     // hex of the first frame, to see its shape on screen
        this.events = 0;            // reply events of any kind
        this.firstEvent = null;     // the first event's shape: argument count, type, keys
        this.lastVerdict = null;    // what the last sendTasuRequest returned, as text
        this.tester = TESTER;
        this.dmeFrames = 0;         // frames from the DME
        this.busy = 0;              // busy verdicts retried
        this.refused = 0;           // requests given up on a busy gateway (live reads give up early)
        let proxy = null;
        /* The proxy stays in here: requests go through request() and its check only. */
        this._proxy = () => proxy;
        this._setProxy = (p) => { proxy = p; };
        this._chain = Promise.resolve();
        this._last = 0;
    }

    /* Builds the proxy and subscribes the reply event; resolves or throws with what failed. */
    open() {
        if (this._proxy()) {
            return Promise.resolve();
        }
        const self = this;
        let p;
        return timeout(tick(() => someipBuilders.buildTypedProxy(IFACE, INSTANCE))
            .then((proxy) => { p = proxy; return tick(() => p.init()); })
            .then(() => tick(() => p.waitUntilAvailable()))
            .then(() => {
                if (!p.sendTasuResponse || typeof p.sendTasuResponse.subscribe !== 'function') {
                    throw new Error(`Event sendTasuResponse fehlt (Proxy: ${Object.keys(p).slice(0, 8).join(',')})`);
                }
                if (typeof p.sendTasuRequest !== 'function') {
                    throw new Error('Methode sendTasuRequest fehlt');
                }
                return tick(() => p.sendTasuResponse.subscribe(function () {
                    self._noteEvent(Array.prototype.slice.call(arguments));
                    self._onResponse(arguments[0]);
                }));
            }), OPEN_MS, 'Diagnose-Dienst')
            .then(() => { this._setProxy(p); });
    }

    /* What a reply event looks like, for the screen: how many arguments, their types and keys. */
    _noteEvent(args) {
        this.events++;
        if (this.firstEvent) {
            return;
        }
        const shape = (a) => {
            if (a === null || a === undefined) {
                return String(a);
            }
            if (Buffer.isBuffer(a) || a instanceof Uint8Array) {
                return `bytes(${a.length})`;
            }
            if (Array.isArray(a)) {
                return `array(${a.length})`;
            }
            return typeof a === 'object' ? `{${Object.keys(a).slice(0, 6).join(',')}}` : `${typeof a}:${String(a).slice(0, 12)}`;
        };
        this.firstEvent = `${args.length} Arg: ${args.map(shape).join(' ')}`;
    }

    _onResponse(v) {
        const err = v && v.errorCode;
        const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
        if (!this.firstFrame) {
            this.firstFrame = b.slice(0, 16).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ') ||
                JSON.stringify(v).slice(0, 60);
        }
        if (err !== undefined && err !== 'NO_ERROR' && err !== 0) {
            this.log.info(`TASU error ${err}`);
            return;
        }
        if (b.length >= 10 && b[2] !== 0x7F) {
            if (b[6] === DME) {
                this.dmeFrames++;
            }
            this.emit('frame', { ecu: b[6], uds: b.slice(9) });
        }
    }

    /**
     * One read from a unit (UNITS; the DME unless given): resolves with its
     * UDS reply (an array) or null when none came; throws when refused (here
     * or by the transport).
     */
    request(sid, data, timeoutMs, unit, opts) {
        const target = unit === undefined ? DME : unit;
        if (UNITS.indexOf(target) < 0) {
            return Promise.reject(new Error(`nur lesen: Steuergerät ${target} nicht erlaubt`));
        }
        let bytes;
        try {
            bytes = checkRead(sid, data);
        } catch (e) {
            return Promise.reject(e);
        }
        // busyRetries: how often a busy verdict is tried again (BUSY_RETRIES; a live read that comes again
        // next round anyway gives up sooner, so the round after the gateway is free gets through at once)
        const retries = opts && typeof opts.busyRetries === 'number' ? opts.busyRetries : BUSY_RETRIES;
        const run = () => this._request(sid, bytes, timeoutMs || 2500, target, retries);
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => undefined);
        return p;
    }

    /**
     * The fault memory of every unit: 19 02 <mask> to all of them at once.
     * Resolves with Map(unit address -> its reply) once no reply came for
     * idleMs (a pending one waits longer), at most maxMs.
     */
    faults(mask, idleMs, maxMs) {
        let bytes;
        try {
            bytes = checkRead(0x19, [FAULTS, mask]);
        } catch (e) {
            return Promise.reject(e);
        }
        const run = () => this._collect(0x19, bytes, idleMs || 3000, maxMs || 20000);
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => undefined);
        return p;
    }

    /**
     * One unit's fault memory: 19 02 <mask> to that unit alone (any unit but
     * all at once). Resolves with its reply or null. For a gateway that does
     * not pass a request to all units on: the units asked one by one.
     */
    faultsOf(unit, mask, timeoutMs) {
        if (!Number.isInteger(unit) || unit < 0x01 || unit > 0xFE || unit === ALL) {
            return Promise.reject(new Error(`Steuergerät ${unit} nicht erlaubt`));
        }
        let bytes;
        try {
            bytes = checkRead(0x19, [FAULTS, mask]);
        } catch (e) {
            return Promise.reject(e);
        }
        const run = () => this._request(0x19, bytes, timeoutMs || 900, unit);
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => undefined);
        return p;
    }

    /**
     * Clears one unit's fault memory: 14 FF FF FF (all groups) to that unit
     * alone, never to all units at once and never to the head unit
     * (NO_CLEAR). The only request here that changes anything in the car;
     * request() refuses 14. Resolves with the unit's reply (54: cleared) or
     * null when none came.
     */
    clearFaults(unit) {
        if (!Number.isInteger(unit) || unit < 0x01 || unit > 0xFE || unit === ALL || NO_CLEAR.indexOf(unit) >= 0) {
            return Promise.reject(new Error(`Löschen bei Steuergerät ${unit} nicht erlaubt`));
        }
        const run = () => this._request(0x14, [0xFF, 0xFF, 0xFF], 8000, unit);
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => undefined);
        return p;
    }

    /**
     * MHD's Max Cooling in a DME that runs MHD's code: 2F 03 01 on, 2F 03 00 off, to the DME only (the commands of
     * cauliflowermossgrape/idrive7-apps' Live Adjustments, MIT, validated on an MG1 with MHD). Resolves to true when
     * the DME echoes it (6F 03 0x), false when it refuses (an untuned DME) or stays silent. Nothing else is
     * written; the caller lets On go only with the engine running.
     */
    maxCooling(on) {
        const data = [0x03, on ? 0x01 : 0x00];
        const run = () => this._request(0x2F, data, 2500, DME);
        const p = this._chain.then(run, run).then((u) => !!(u && u[0] === 0x6F && u[1] === 0x03 && u[2] === data[1]));
        this._chain = p.catch(() => undefined);
        return p;
    }

    _collect(sid, data, idleMs, maxMs) {
        if (!this._proxy()) {
            return Promise.reject(new Error('Diagnose-Dienst nicht offen'));
        }
        const self = this;
        return new Promise((resolve, reject) => {
            const replies = new Map();
            let idle = null;
            let done = false;
            const hard = setTimeout(() => finish(), maxMs);
            const kick = (ms) => { clearTimeout(idle); idle = setTimeout(() => finish(), ms); };
            const onFrame = (f) => {
                const u = f.uds;
                const answer = (u[0] === sid + 0x40 && u[1] === data[0]) || (u[0] === 0x7F && u[1] === sid);
                if (!answer) {
                    return;
                }
                const pending = u[0] === 0x7F && u[2] === 0x78;
                if (!pending || !replies.has(f.ecu)) {
                    replies.set(f.ecu, u);
                }
                kick(pending ? 10000 : idleMs);
            };
            function finish(err) {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(idle);
                clearTimeout(hard);
                self.removeListener('frame', onFrame);
                self._last = Date.now();
                if (err) {
                    reject(err);
                } else {
                    // a unit still pending at the end gave no answer
                    replies.forEach((u, ecu) => { if (u[0] === 0x7F && u[2] === 0x78) replies.delete(ecu); });
                    resolve(replies);
                }
            }
            this.on('frame', onFrame);
            this._send(sid, data, ALL)
                .then((verdict) => {
                    if (['NO_ERROR', 'REQUEST_PENDING', '0', '1'].indexOf(verdict) < 0) {
                        finish(new Error(`Gateway: ${verdict}`));
                    } else if (!idle) {
                        kick(idleMs + 2000);     // the first replies can take a moment
                    }
                })
                .catch((e) => finish(e));
        });
    }

    _send(sid, data, target, retries) {
        const proxy = this._proxy();
        const params = { sourceAddress: this.tester, targetAddress: target, serviceID: sid, subroutineID: 0,
            udsDataLength: data.length, udsData: Buffer.from(data), deadlockTime: 0 };
        const attempt = (n) => timeout(tick(() => proxy.sendTasuRequest(params)), CALL_MS, 'sendTasuRequest')
            .then((r) => {
                const verdict = verdictOf(r);
                let raw;
                try { raw = JSON.stringify(r); } catch (e) { raw = String(r); }
                this.lastVerdict = `${verdict} ${raw === undefined ? '' : raw.slice(0, 60)}`;
                const busy = /TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict);
                if (busy && n < (retries === undefined ? BUSY_RETRIES : retries)) {
                    this.busy++;
                    return sleep(BUSY_MS * (n + 1)).then(() => attempt(n + 1));
                }
                if (busy) {
                    this.refused++;
                }
                return verdict;
            });
        return attempt(0);
    }

    _request(sid, data, timeoutMs, target, retries) {
        if (!this._proxy()) {
            return Promise.reject(new Error('Diagnose-Dienst nicht offen'));
        }
        const wait = Math.max(0, this._last + GAP_MS - Date.now());
        const self = this;
        return sleep(wait).then(() => new Promise((resolve, reject) => {
            let timer = null;
            let done = false;
            const hard = setTimeout(() => finish(null), HARD_MS);
            const onFrame = (f) => {
                if (f.ecu !== target) {
                    return;
                }
                const u = f.uds;
                if (u[0] === 0x7F && u[1] === sid && u[2] === 0x78) {      // response pending
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(null), PENDING_MS);
                    return;
                }
                // 22: the reply starts with one of the identifiers asked (one the unit lacks is left out);
                // 01 / 09: it echoes the PID
                let echoed;
                if (sid === 0x14) {
                    echoed = true;          // 54: the clear's positive reply has no echo
                } else if (sid === 0x22) {
                    echoed = false;
                    for (let k = 0; k + 1 < data.length; k += 2) {
                        echoed = echoed || (u[1] === data[k] && u[2] === data[k + 1]);
                    }
                } else {
                    echoed = u[1] === data[0];
                }
                const ours = (u[0] === sid + 0x40 && echoed) || (u[0] === 0x7F && u[1] === sid);
                if (ours) {
                    finish(u);
                }
            };
            function finish(v, err) {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                clearTimeout(hard);
                self.removeListener('frame', onFrame);
                self._last = Date.now();
                if (err) {
                    reject(err);
                } else {
                    resolve(v);
                }
            }
            this.on('frame', onFrame);
            this._send(sid, data, target, retries)
                .then((verdict) => {
                    if (['NO_ERROR', 'REQUEST_PENDING', '0', '1'].indexOf(verdict) < 0) {
                        finish(null, new Error(`Gateway: ${verdict}`));
                        return;
                    }
                    if (!done && !timer) {
                        timer = setTimeout(() => finish(null), timeoutMs);
                    }
                })
                .catch((e) => finish(null, e));
        }));
    }
}

/* Asks from another tester address (one of TESTERS). */
Tasu.prototype.useTester = function (addr) {
    if (TESTERS.indexOf(addr) < 0) {
        throw new Error(`tester ${addr} not allowed`);
    }
    this.tester = addr;
};

module.exports = { Tasu, ALLOWED, DME, EGS, UNITS, ALL, NO_CLEAR, IFACE, INSTANCE, TESTERS, checkRead };
