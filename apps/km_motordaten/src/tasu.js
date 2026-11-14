'use strict';
/**
 * A read-only diagnostic link to the engine unit (DME, address 0x12) through
 * the head unit's diagnostic gateway: the SOME/IP service InternalTasu, used
 * the way cauliflowermossgrape/idrive7-apps (MIT, kit/runtime/diag.js)
 * describes it:
 *
 *   request: method sendTasuRequest{ sourceAddress 0xF2, targetAddress,
 *            serviceID, subroutineID 0, udsDataLength, udsData (the bytes
 *            after the service id), deadlockTime 0 } -> a transport verdict;
 *            a busy verdict is retried (BUSY_RETRIES, BUSY_MS x 1, 2, ...)
 *   reply  : event sendTasuResponse{ udsResponse, errorCode }; the frame has a
 *            9-byte header, [6] = the answering unit, the UDS reply from [9].
 *            Every app on the unit gets every frame, so only a reply from the
 *            DME that echoes this request (or refuses this service) counts;
 *            transport errors of other requests are not ours.
 *
 * Only ReadDataByIdentifier (22, one 2-byte identifier) and OBD-II 01 / 09
 * (one PID) to the DME pass request(); everything else is refused here,
 * before anything reaches the car. One request at a time, at least GAP_MS
 * apart. Proxy building, init and every call run from a fresh setImmediate
 * tick, as the SDK does (the native binding can deadlock inline), each
 * under a time limit.
 */
const EventEmitter = require('events');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF2;
/* Tester addresses a request may come from (the head unit's own is 0xF2; ENET testers use 0xF4, 0xF1). */
const TESTERS = Object.freeze([0xF2, 0xF4, 0xF1]);
const DME = 0x12;
const GAP_MS = 25;
const OPEN_MS = 15000;
const CALL_MS = 8000;
const PENDING_MS = 10000;
const HARD_MS = 30000;
const BUSY_RETRIES = 4;
const BUSY_MS = 100;

/* Service -> length of its request data. Nothing else is sent. */
const ALLOWED = Object.freeze({ 0x22: 2, 0x01: 1, 0x09: 1 });

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
        !Array.isArray(data) || data.length !== ALLOWED[sid] || !data.every(isByte)) {
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
     * One read from the DME: resolves with its UDS reply (an array) or null
     * when none came; throws when refused (here or by the transport).
     */
    request(sid, data, timeoutMs) {
        let bytes;
        try {
            bytes = checkRead(sid, data);
        } catch (e) {
            return Promise.reject(e);
        }
        const run = () => this._request(sid, bytes, timeoutMs || 2500);
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => undefined);
        return p;
    }

    _send(sid, data) {
        const proxy = this._proxy();
        const params = { sourceAddress: this.tester, targetAddress: DME, serviceID: sid, subroutineID: 0,
            udsDataLength: data.length, udsData: Buffer.from(data), deadlockTime: 0 };
        const attempt = (n) => timeout(tick(() => proxy.sendTasuRequest(params)), CALL_MS, 'sendTasuRequest')
            .then((r) => {
                const verdict = verdictOf(r);
                let raw;
                try { raw = JSON.stringify(r); } catch (e) { raw = String(r); }
                this.lastVerdict = `${verdict} ${raw === undefined ? '' : raw.slice(0, 60)}`;
                if (/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) && n < BUSY_RETRIES) {
                    this.busy++;
                    return sleep(BUSY_MS * (n + 1)).then(() => attempt(n + 1));
                }
                return verdict;
            });
        return attempt(0);
    }

    _request(sid, data, timeoutMs) {
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
                if (f.ecu !== DME) {
                    return;
                }
                const u = f.uds;
                if (u[0] === 0x7F && u[1] === sid && u[2] === 0x78) {      // response pending
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(null), PENDING_MS);
                    return;
                }
                const ours = (u[0] === sid + 0x40 && data.every((b, i) => u[i + 1] === b)) || (u[0] === 0x7F && u[1] === sid);
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
            this._send(sid, data)
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

module.exports = { Tasu, ALLOWED, DME, IFACE, INSTANCE, TESTERS, checkRead };
