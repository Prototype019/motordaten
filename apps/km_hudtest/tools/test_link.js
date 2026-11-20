'use strict';
/**
 * Why the HUD link says no renderer (src/hud_link.js why()): a service that refuses
 * the car (answers only status: "not supported on this car ..."), one that takes the
 * connection and never answers, a socket file with nothing behind it, and a service
 * that answers hello (then nothing to explain, and images count only once it is there).
 *
 *   node apps/km_hudtest/tools/test_link.js
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { HudLink } = require('../src/hud_link.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-link-'));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const send = (sock, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(5);
    head.writeUInt32LE(body.length + 1, 0);
    head[4] = 0x4a;
    sock.write(Buffer.concat([head, body]));
};
/* A fake service: onMsg(sock, msg) for every JSON message. */
function service(name, onMsg) {
    const p = path.join(dir, name);
    const asked = [];
    const srv = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 5) {
                const len = buf.readUInt32LE(0);
                if (buf.length < 4 + len) break;
                if (buf[4] === 0x4a) { const m = JSON.parse(buf.slice(5, 4 + len).toString()); asked.push(m.op); onMsg(sock, m); }
                buf = buf.slice(4 + len);
            }
        });
        sock.on('error', () => {});
    });
    return new Promise((ok) => srv.listen(p, () => ok({ p, srv, asked })));
}

(async () => {
    // refuses the car: no hello, status answered
    const r = await service('refuse', (sock, m) => {
        if (m.op === 'status') send(sock, { ev: 'status', text: 'not supported on this car (head unit: no hwvariant)\nmore' });
    });
    let h = new HudLink({ socketPath: r.p });
    h.start();
    await wait(4500);
    assert.strictEqual(h.conn, 'verbinde');
    assert.ok(r.asked.indexOf('status') >= 0, 'asked for its status');
    assert.ok(/lehnt dieses Auto ab: not supported on this car \(head unit: no hwvariant\)$/.test(h.why()), h.why());
    assert.ok(h.rows().some((x) => x[0] === 'Renderer sagt' && /^not supported/.test(x[1])));
    assert.strictEqual(h.frames, 0, 'no image counted without a renderer');
    h.stop();
    r.srv.close();

    // takes the connection, never answers
    const s = await service('silent', () => {});
    h = new HudLink({ socketPath: s.p });
    h.start();
    await wait(1500);
    assert.ok(/^Renderer antwortet nicht \(Verbindung steht seit [12] s\)$/.test(h.why()), h.why());
    h.stop();
    s.srv.close();

    // a socket file with nothing behind it (the service's socket unit stopped)
    const dead = path.join(dir, 'dead');
    fs.writeFileSync(dead, '');
    h = new HudLink({ socketPath: dead });
    assert.ok(h.installed());
    h.start();
    await wait(800);
    assert.ok(h.sockError, 'the socket error is kept');
    assert.ok(/^Renderer( läuft nicht|: )/.test(h.why()), h.why());
    assert.ok(h.rows()[0][1].indexOf(`Socket: ${h.sockError}`) > 0, h.rows()[0][1]);
    h.stop();

    // a working service: nothing to explain, the images count
    const ok = await service('ok', (sock, m) => {
        if (m.op === 'hello') send(sock, { ev: 'hello', proto: 1, backend: 'id8', targets: 'hud:353x203' });
    });
    h = new HudLink({ socketPath: ok.p });
    h.start();
    await wait(400);
    assert.strictEqual(h.conn, 'verbunden');
    assert.strictEqual(h.why(), '');
    h.update({ oil: 90 });
    await wait(400);
    assert.ok(h.frames >= 1, `frames ${h.frames}`);
    assert.ok(ok.asked.indexOf('status') < 0, 'a working service is not asked');
    h.stop();
    ok.srv.close();

    console.log('test_link: ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
