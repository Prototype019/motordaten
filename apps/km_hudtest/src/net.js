'use strict';
/**
 * Internet for the app through the Store's uplink (mgu-uplink, the phone's connection): the app's package says
 * "mguInternet": true, the uplink lets the app's uid out while it is online and writes its lease beside the app
 * (data/uplink.json, also /run/mgu-uplink/lease.json): {interface, ip, prefix, router, dns[], ...}, present only
 * while online. The unit's own resolver has no internet, so names are resolved through the lease's DNS servers.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');

const TIMEOUT_MS = 30000;

/* The uplink's lease while online, else null. */
function lease(dir) {
    for (const f of [path.join(dir, 'uplink.json'), '/run/mgu-uplink/lease.json']) {
        try {
            const l = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (l && l.ip) {
                return l;
            }
        } catch (e) { /* not there */ }
    }
    return null;
}

function resolve(host, l) {
    return new Promise((ok, fail) => {
        const servers = ((l && l.dns) || []).filter(Boolean);
        if (dns.Resolver && servers.length) {
            const r = new dns.Resolver();
            r.setServers(servers);
            r.resolve4(host, (err, ips) => (err || !ips || !ips.length ? fail(err || new Error('kein DNS')) : ok(ips[0])));
        } else {
            dns.lookup(host, 4, (err, ip) => (err ? fail(err) : ok(ip)));
        }
    });
}

/**
 * One HTTPS request: {method, host, path, headers, body} -> {status, body (text)}. Rejects on no answer within
 * TIMEOUT_MS or a broken connection; any HTTP status resolves.
 */
function request(o, l) {
    return resolve(o.host, l).then((ip) => new Promise((ok, fail) => {
        const body = o.body === undefined || o.body === null ? null : Buffer.from(o.body);
        const headers = Object.assign({}, o.headers || {});
        if (body) {
            headers['Content-Length'] = body.length;
        }
        let done = false;
        const req = https.request({
            method: o.method || 'GET', host: o.host, path: o.path, servername: o.host, headers,
            lookup: (h, opts, cb) => (opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4))
        }, (res) => {
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => { done = true; ok({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }); });
            res.on('error', (e) => { done = true; fail(e); });
        });
        req.setTimeout(TIMEOUT_MS, () => req.abort());
        req.on('error', (e) => (done ? undefined : fail(e)));
        if (body) {
            req.write(body);
        }
        req.end();
    }));
}

module.exports = { lease, resolve, request };
