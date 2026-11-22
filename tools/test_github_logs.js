'use strict';
/**
 * shared/github_logs.js and shared/qr.js against a fake GitHub: the device flow (pending, slow down, a dropped
 * connection), the install wait, picking among repositories, sending (the file's path and content), the access
 * renewed before it ends, an access GitHub no longer takes, no internet, and the access kept across a restart.
 * On a Mac the QR codes are also read back with the system's barcode reader (Vision), as a phone would.
 *
 *   node tools/test_github_logs.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GithubLogs, DEVICE_URL, INSTALL_URL } = require('../shared/github_logs.js');
const qr = require('../shared/qr.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-gh-'));
fs.writeFileSync(path.join(dir, 'diag.log'), 'Zeile 1\nZeile 2\n');

// the fake GitHub
const gh = { pending: 2, slow: 1, drop: 1, installed: [], puts: [], tokens: 0, expiresIn: 28800, refreshes: 0, unauthorized: false };
function fake(o, lease) {
    assert.ok(lease && lease.ip, 'only with the uplink');
    assert.strictEqual(o.headers['User-Agent'], 'motordaten-car-app');
    const q = (s) => s.split('&').reduce((m, kv) => { const [k, v] = kv.split('='); m[k] = decodeURIComponent(v); return m; }, {});
    const ok = (status, body) => Promise.resolve({ status, body: JSON.stringify(body) });
    if (o.host === 'github.com' && o.path === '/login/device/code') {
        return ok(200, { device_code: 'dev1', user_code: 'WDJB-MJHT', verification_uri: DEVICE_URL, expires_in: 900, interval: 5 });
    }
    if (o.host === 'github.com' && o.path === '/login/oauth/access_token') {
        const b = q(o.body);
        if (b.grant_type === 'refresh_token') {
            gh.refreshes++;
            assert.strictEqual(b.refresh_token, 'ghr_1');
            return ok(200, { access_token: 'ghu_2', expires_in: gh.expiresIn, refresh_token: 'ghr_2', refresh_token_expires_in: 15897600 });
        }
        assert.strictEqual(b.device_code, 'dev1');
        if (gh.drop) { gh.drop--; return Promise.reject(new Error('ECONNRESET')); }
        if (gh.slow) { gh.slow--; return ok(200, { error: 'slow_down', interval: 10 }); }
        if (gh.pending) { gh.pending--; return ok(200, { error: 'authorization_pending' }); }
        gh.tokens++;
        return ok(200, { access_token: 'ghu_1', expires_in: gh.expiresIn, refresh_token: 'ghr_1', refresh_token_expires_in: 15897600 });
    }
    assert.strictEqual(o.host, 'api.github.com');
    if (gh.unauthorized) return ok(401, { message: 'Bad credentials' });
    assert.ok(/^Bearer ghu_/.test(o.headers.Authorization));
    if (o.path.startsWith('/user/installations?')) return ok(200, { installations: gh.installed.length ? [{ id: 7 }] : [] });
    if (o.path.startsWith('/user/installations/7/repositories')) return ok(200, { repositories: gh.installed.map((n) => ({ full_name: n })) });
    if (o.method === 'PUT') {
        gh.puts.push({ path: o.path, body: JSON.parse(o.body), auth: o.headers.Authorization });
        return ok(201, { content: {} });
    }
    return ok(404, {});
}

let online = true;
const waits = [];
const mk = () => new GithubLogs({
    dir, app: 'km_motordaten', request: fake, lease: () => (online ? { ip: '172.20.10.2', dns: ['172.20.10.1'] } : null),
    files: () => [{ name: 'diag.log', file: path.join(dir, 'diag.log') }, { name: 'diag.1.log', file: path.join(dir, 'diag.1.log') }],
    header: () => 'Motordaten 0.28.0',
    now: () => new Date(Date.UTC(2026, 10, 22, 9, 5, 7)),
    wait: (ms) => { waits.push(ms); return new Promise((r) => setImmediate(r)); }
});

(async () => {
    // QR codes: the two links fit and (on a Mac) read back
    [DEVICE_URL, INSTALL_URL].forEach((u) => assert.ok(qr.encode(u).size <= 41, `${u} small enough`));
    if (process.platform === 'darwin') readBack([DEVICE_URL, INSTALL_URL, 'https://github.com/x?y=1']);

    // no internet
    online = false;
    let g = mk();
    assert.strictEqual(g.state().phase, 'off');
    await g.connect();
    assert.strictEqual(g.state().phase, 'off');
    assert.ok(/Internet/.test(g.state().error), g.state().error);
    online = true;

    // connect: the code shows, GitHub says wait / slower, the line drops once, then the access comes
    const seen = [];
    g.on('change', (s) => seen.push(s.phase + (s.code ? ':' + s.code : '')));
    const flow = g.connect();
    for (let i = 0; i < 1000 && g.state().phase !== 'install'; i++) await new Promise((r) => setImmediate(r));
    assert.ok(seen.includes('code:WDJB-MJHT'), 'the code was shown: ' + seen);
    assert.ok(waits.includes(10000), 'slower after slow_down');
    assert.strictEqual(gh.tokens, 1);
    // nothing installed yet: the install QR, until the driver installs it on one repository
    assert.strictEqual(g.state().phase, 'install');
    assert.strictEqual(g.state().qr, INSTALL_URL);
    assert.strictEqual(seen.filter((p) => p === 'install').length, 1, 'install shown once while waiting');

    // the install wait goes on until cancelled (Zurück)
    g.cancel();
    await flow;
    assert.strictEqual(g.state().phase, 'off', 'cancelled without a repository');
    gh.installed = ['kevin/logs', 'kevin/other'];
    g = mk();
    gh.pending = 0; gh.slow = 0; gh.drop = 0;
    await g.connect();
    assert.strictEqual(gh.tokens, 1, 'confirmed before: no new code, on to the repository');
    assert.strictEqual(g.state().phase, 'pick');
    assert.deepStrictEqual(g.state().repos, ['kevin/logs', 'kevin/other']);
    g.choose('kevin/logs');
    assert.strictEqual(g.state().phase, 'ready');
    assert.strictEqual(g.state().repo, 'kevin/logs');
    const mode = fs.statSync(path.join(dir, 'github.json')).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'only the app reads its access');

    // send
    assert.strictEqual(await g.send(), true);
    const put = gh.puts[0];
    assert.strictEqual(put.path, '/repos/kevin/logs/contents/km_motordaten/2026-11-22_09-05-07.log');
    const text = Buffer.from(put.body.content, 'base64').toString('utf8');
    assert.ok(/^Motordaten 0\.28\.0/.test(text) && /===== diag\.log =====\nZeile 1\nZeile 2/.test(text) && /diag\.1\.log =====\n\(nicht vorhanden\)/.test(text), text);
    assert.ok(g.state().sent && g.state().sent.path.endsWith('.log'));

    // the access survives a restart of the app
    g = mk();
    assert.strictEqual(g.state().phase, 'ready');
    assert.strictEqual(g.state().repo, 'kevin/logs');

    // the access near its end: renewed first, the send with the new one
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'github.json'), 'utf8'));
    a.accessUntil = Date.now() + 60000;
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify(a));
    g = mk();
    assert.strictEqual(await g.send(), true);
    assert.strictEqual(gh.refreshes, 1);
    assert.strictEqual(gh.puts[1].auth, 'Bearer ghu_2');

    // GitHub no longer takes the access: off, with a word why
    gh.unauthorized = true;
    assert.strictEqual(await g.send(), false);
    assert.strictEqual(g.state().phase, 'off');
    assert.ok(/neu verbinden/.test(g.state().error), g.state().error);
    assert.ok(!fs.existsSync(path.join(dir, 'github.json')), 'forgotten');
    gh.unauthorized = false;

    // a long log is sent by its end only
    fs.writeFileSync(path.join(dir, 'diag.log'), 'x'.repeat(600 * 1024) + 'ENDE');
    gh.installed = ['kevin/logs'];
    g = mk();
    await g.connect();
    assert.strictEqual(g.state().phase, 'ready', 'one repository: taken at once');
    await g.send();
    const long = Buffer.from(gh.puts[gh.puts.length - 1].body.content, 'base64').toString('utf8');
    assert.ok(long.length < 530 * 1024 && /gekürzt/.test(long) && /ENDE/.test(long));

    // disconnect
    g.disconnect();
    assert.strictEqual(g.state().phase, 'off');
    assert.ok(!fs.existsSync(path.join(dir, 'github.json')));
    console.log('test_github_logs: ok');
})().catch((e) => { console.error(e); process.exit(1); });

/* Writes each code as a PNG and reads it with macOS Vision (swift); skipped without swift. */
function readBack(texts) {
    const { execFileSync } = require('child_process');
    const zlib = require('zlib');
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'km-qr-'));
    const crcT = [];
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[i] = c >>> 0; }
    const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const files = texts.map((s, i) => {
        const q = qr.encode(s);
        const sc = 6, n = (q.size + 8) * sc, row = n + 1, raw = Buffer.alloc(row * n, 255);
        for (let y = 0; y < n; y++) {
            raw[y * row] = 0;
            for (let x = 0; x < n; x++) {
                const mx = Math.floor(x / sc) - 4, my = Math.floor(y / sc) - 4;
                if (mx >= 0 && my >= 0 && mx < q.size && my < q.size && q.dark(mx, my)) raw[y * row + 1 + x] = 0;
            }
        }
        const ih = Buffer.alloc(13); ih.writeUInt32BE(n, 0); ih.writeUInt32BE(n, 4); ih[8] = 8; ih[9] = 0;
        const f = path.join(t, `q${i}.png`);
        fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
        return f;
    });
    const swift = path.join(t, 'read.swift');
    fs.writeFileSync(swift, 'import Foundation\nimport Vision\nimport AppKit\nfor p in CommandLine.arguments.dropFirst() {\n' +
        '  let img = NSImage(contentsOfFile: p)!\n  let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)!\n' +
        '  let r = VNDetectBarcodesRequest(); r.symbologies = [.qr]\n  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([r])\n' +
        '  print((r.results ?? []).compactMap { $0.payloadStringValue }.first ?? "NONE")\n}\n');
    let out;
    try {
        out = execFileSync('swift', [swift].concat(files), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000 });
    } catch (e) {
        console.log('test_github_logs: QR read-back skipped (no swift)');
        return;
    }
    assert.deepStrictEqual(out.trim().split('\n'), texts, 'QR codes read back');
}
