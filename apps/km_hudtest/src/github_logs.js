'use strict';
/**
 * The app's logs into the driver's own GitHub repository, over the phone's internet (shared/net.js), set up by
 * scanning a QR code in the car: nothing to type in the car, no password or key in this code.
 *
 * How: a GitHub App ("Motordaten Logs", CLIENT_ID below; the client id is public, the device flow needs no
 * secret) with the one permission Contents: read and write.
 *   1. Verbinden: the device flow (github.com/login/device): the screen shows a QR code to that page and the
 *      code to confirm there; the app asks GitHub every few seconds until the driver confirmed.
 *   2. The driver installs the GitHub App on the repository the logs go to (QR code to its install page;
 *      skipped when done before). The app's access reaches only the repositories it is installed on.
 *   3. Logs senden: one file per send, <app>/<date time>.log in that repository (GitHub's contents API).
 * The access (and its refresh, GitHub's tokens of an app last 8 hours, the refresh 6 months) stays in the app's
 * data folder (github.json, only the app may read it) until "Trennen".
 *
 * Phases (state().phase): off, code (QR to the device page), install (QR to the install page), pick (more
 * than one repository: the driver chooses), ready, sending. state().error says in words what went wrong.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const net = require('./net.js');

const CLIENT_ID = 'Iv23liPLACEHOLDER';          // set once the GitHub App exists
const SLUG = 'motordaten-logs';
const DEVICE_URL = 'https://github.com/login/device';
const INSTALL_URL = `https://github.com/apps/${SLUG}/installations/new`;
const FILE = 'github.json';
const UA = 'motordaten-car-app';
const INSTALL_WAIT_MS = 15 * 60 * 1000;
const INSTALL_POLL_MS = 5000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 512 * 1024;              // per log file, its end

const form = (o) => Object.keys(o).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k])}`).join('&');
const json = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

/* Plain words for what went wrong. */
function say(e) {
    const m = String((e && e.message) || e || '');
    if (/EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|kein DNS|ENOTFOUND|EAI_AGAIN/i.test(m)) {
        return 'Keine Verbindung ins Internet';
    }
    return m || 'Unbekannter Fehler';
}

class GithubLogs extends EventEmitter {
    /**
     * o.dir: the app's data folder (github.json, the uplink's lease); o.app: the folder name in the repository;
     * o.files(): [{name, file}] the logs to send (missing ones are skipped); o.header(): lines on top of the file;
     * o.request / o.lease / o.now / o.wait: for tests.
     */
    constructor(o) {
        super();
        this.dir = o.dir;
        this.app = o.app;
        this.files = o.files || (() => []);
        this.header = o.header || (() => '');
        this._request = o.request || net.request;
        this._lease = o.lease || (() => net.lease(this.dir));
        this.now = o.now || (() => new Date());
        this._wait = o.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.phase = 'off';
        this.error = null;
        this.code = null;           // {user, url, expires}
        this.repos = [];            // while picking: ['owner/name', ...]
        this.sent = null;           // {at, path}
        this._run = 0;              // a newer flow ends an older one
        this.auth = this._load();
        if (this.auth && this.auth.access) {
            this.phase = this.auth.repo ? 'ready' : 'off';
        }
    }

    online() { return !!this._lease(); }

    state() {
        const qr = this.phase === 'code' ? DEVICE_URL : this.phase === 'install' ? INSTALL_URL : null;
        return {
            phase: this.phase, error: this.error, online: this.online(), qr,
            code: this.phase === 'code' && this.code ? this.code.user : null,
            repo: this.auth && this.auth.repo ? this.auth.repo : null,
            repos: this.phase === 'pick' ? this.repos.slice() : [],
            sent: this.sent
        };
    }

    _set(phase, error) {
        this.phase = phase;
        this.error = error || null;
        this.emit('change', this.state());
    }

    /* ---- the access, kept in the data folder ---- */
    _load() {
        try {
            const a = JSON.parse(fs.readFileSync(path.join(this.dir, FILE), 'utf8'));
            return a && typeof a === 'object' ? a : null;
        } catch (e) {
            return null;
        }
    }

    _save() {
        const file = path.join(this.dir, FILE);
        try {
            if (!this.auth) {
                fs.unlinkSync(file);
                return;
            }
            try { fs.mkdirSync(this.dir); } catch (e) { /* there */ }
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.auth), { mode: 0o600 });
            fs.renameSync(tmp, file);
        } catch (e) { /* not kept: connected until the app restarts */ }
    }

    /* ---- talking to GitHub ---- */
    _call(host, method, p, body, headers) {
        const l = this._lease();
        if (!l) {
            return Promise.reject(new Error('Kein Internet: Handy verbunden?'));
        }
        return this._request({ method, host, path: p, body, headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers) }, l)
            .then((r) => ({ status: r.status, data: json(r.body) }));
    }

    _oauth(params) {
        return this._call('github.com', 'POST', '/login/' + (params.grant_type ? 'oauth/access_token' : 'device/code'),
            form(Object.assign({ client_id: CLIENT_ID }, params)), { 'Content-Type': 'application/x-www-form-urlencoded' });
    }

    _api(method, p, body) {
        return this._fresh().then(() => this._call('api.github.com', method, p, body ? JSON.stringify(body) : null, {
            Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.auth.access}`,
            'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
        })).then((r) => {
            if (r.status === 401) {
                this.auth = null;
                this._save();
                throw Object.assign(new Error('Verbindung zu GitHub abgelaufen: bitte neu verbinden'), { gone: true });
            }
            return r;
        });
    }

    _keep(t) {
        const at = Date.now();
        this.auth = Object.assign({}, this.auth, {
            access: t.access_token,
            accessUntil: t.expires_in ? at + t.expires_in * 1000 : null,
            refresh: t.refresh_token || null,
            refreshUntil: t.refresh_token_expires_in ? at + t.refresh_token_expires_in * 1000 : null
        });
        this._save();
    }

    /* A new access shortly before the old one ends (GitHub's app tokens last 8 hours). */
    _fresh() {
        const a = this.auth;
        if (!a || !a.access) {
            return Promise.reject(Object.assign(new Error('Nicht mit GitHub verbunden'), { gone: true }));
        }
        if (!a.accessUntil || Date.now() < a.accessUntil - REFRESH_EARLY_MS || !a.refresh) {
            return Promise.resolve();
        }
        return this._oauth({ grant_type: 'refresh_token', refresh_token: a.refresh }).then((r) => {
            if (r.data && r.data.access_token) {
                this._keep(r.data);
                return;
            }
            this.auth = null;
            this._save();
            throw Object.assign(new Error('Verbindung zu GitHub abgelaufen: bitte neu verbinden'), { gone: true });
        });
    }

    /* ---- 1. connect: the device flow ---- */
    connect() {
        const run = ++this._run;
        this.code = null;
        this.repos = [];
        if (this.auth && this.auth.access && !this.auth.repo) {
            // confirmed on the phone before, the repository not yet chosen: on from there
            this._set('install');
            return this._findRepo(run);
        }
        this._set('code');
        return this._oauth({}).then((r) => {
            const d = r.data || {};
            if (!d.device_code) {
                throw new Error(d.error === 'device_flow_disabled' ? 'Am GitHub-Zugang ist „Device Flow“ aus'
                    : `GitHub lehnt ab (${d.error || r.status})`);
            }
            this.code = { user: d.user_code, url: d.verification_uri || DEVICE_URL, expires: Date.now() + (d.expires_in || 900) * 1000 };
            this.emit('change', this.state());
            return this._poll(run, d.device_code, Math.max(5, d.interval || 5));
        }).then((token) => {
            if (run !== this._run) return undefined;
            this._keep(token);
            return this._findRepo(run);
        }).catch((e) => {
            if (run === this._run) this._set('off', say(e));
        });
    }

    _poll(run, device, interval) {
        if (run !== this._run) return Promise.reject(new Error('abgebrochen'));
        if (Date.now() > this.code.expires) return Promise.reject(new Error('Code abgelaufen: bitte neu verbinden'));
        return this._wait(interval * 1000).then(() => (run === this._run ? this._oauth({
            device_code: device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        }) : Promise.reject(new Error('abgebrochen')))).then((r) => {
            const d = r.data || {};
            if (d.access_token) return d;
            if (d.error === 'authorization_pending') return this._poll(run, device, interval);
            if (d.error === 'slow_down') return this._poll(run, device, d.interval || interval + 5);
            if (d.error === 'expired_token') throw new Error('Code abgelaufen: bitte neu verbinden');
            if (d.error === 'access_denied') throw new Error('Am Handy abgelehnt');
            throw new Error(`GitHub lehnt ab (${d.error || r.status})`);
        }, (e) => {
            // the phone's connection may drop for a moment: keep asking until the code ends
            if (run !== this._run || /abgebrochen/.test(e.message)) throw e;
            return this._poll(run, device, interval);
        });
    }

    /* ---- 2. the repository: where the GitHub App is installed ---- */
    _repos() {
        return this._api('GET', '/user/installations?per_page=100').then((r) => {
            const inst = (r.data && r.data.installations) || [];
            return inst.reduce((p, i) => p.then((all) => this._api('GET', `/user/installations/${i.id}/repositories?per_page=100`)
                .then((rr) => all.concat(((rr.data && rr.data.repositories) || []).map((x) => x.full_name)))), Promise.resolve([]));
        });
    }

    _findRepo(run) {
        const until = Date.now() + INSTALL_WAIT_MS;
        const look = () => this._repos().then((repos) => {
            if (run !== this._run) return undefined;
            if (repos.length === 1) return this.choose(repos[0]);
            if (repos.length > 1) {
                this.repos = repos;
                this._set('pick');
                return undefined;
            }
            if (this.phase !== 'install') this._set('install');
            if (Date.now() > until) throw new Error('Kein Repository freigegeben: bitte neu verbinden');
            return this._wait(INSTALL_POLL_MS).then(look);
        });
        return look().catch((e) => {
            if (run === this._run) this._set(this.auth && this.auth.access && !e.gone ? 'install' : 'off', say(e));
        });
    }

    /* The driver chose (or there was just one). */
    choose(full) {
        const m = /^([^/]+)\/([^/]+)$/.exec(String(full || ''));
        if (!m || !this.auth) return;
        this.auth = Object.assign({}, this.auth, { repo: full });
        this._save();
        this.repos = [];
        this._set('ready');
    }

    /* Stops a flow under way (Zurück). */
    cancel() {
        this._run++;
        this.code = null;
        this.repos = [];
        this._set(this.auth && this.auth.access && this.auth.repo ? 'ready' : 'off');
    }

    /* Forgets the access (Trennen); the GitHub App stays installed. */
    disconnect() {
        this._run++;
        this.auth = null;
        this._save();
        this.sent = null;
        this._set('off');
    }

    /* ---- 3. send ---- */
    _content() {
        const d = this.now();
        const parts = [this.header() || ''];
        this.files().forEach((f) => {
            let text;
            try {
                const st = fs.statSync(f.file);
                const fd = fs.openSync(f.file, 'r');
                const len = Math.min(st.size, MAX_FILE_BYTES);
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, st.size - len);
                fs.closeSync(fd);
                text = (st.size > len ? '[… gekürzt]\n' : '') + buf.toString('utf8');
            } catch (e) {
                text = '(nicht vorhanden)';
            }
            parts.push(`===== ${f.name} =====\n${text}`);
        });
        return { at: d, text: parts.join('\n\n') };
    }

    send() {
        if (this.phase === 'sending') return Promise.resolve(false);
        if (!this.auth || !this.auth.repo) {
            this._set('off', 'Nicht mit GitHub verbunden');
            return Promise.resolve(false);
        }
        this._set('sending');
        const c = this._content();
        const p = (n) => String(n).padStart(2, '0');
        const d = c.at;
        const stamp = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
        const file = `${this.app}/${stamp}.log`;
        return this._api('PUT', `/repos/${this.auth.repo}/contents/${file}`, {
            message: `Logs ${this.app} ${stamp}`, content: Buffer.from(c.text, 'utf8').toString('base64')
        }).then((r) => {
            if (r.status !== 201 && r.status !== 200) {
                const why = r.status === 404 || r.status === 403 ? 'Kein Zugriff aufs Repository: GitHub-Zugang dort installiert?'
                    : `GitHub lehnt ab (${r.status})`;
                throw new Error(why);
            }
            this.sent = { at: Date.now(), path: file };
            this._set('ready');
            return true;
        }).catch((e) => {
            this._set(this.auth && this.auth.repo ? 'ready' : 'off', say(e));
            return false;
        });
    }
}

module.exports = { GithubLogs, CLIENT_ID, SLUG, DEVICE_URL, INSTALL_URL };
