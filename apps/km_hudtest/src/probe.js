'use strict';
/**
 * Which of the car's interfaces there are (read only, once per app version): the head unit keeps one JSON file per
 * SOME/IP interface (the SDK reads <app>/../someipInterfaces/<name with _>.json for a proxy). To find a signal
 * nobody documented (a route in CarPlay, what the HUD shows), the folders that hold such files are listed into
 * data/interfaces.txt, which goes out with the logs: every folder found, every interface whose name fits WORDS
 * with its attributes and broadcasts, and the names of all others. Bounded: MAX_DIRS folders, DEPTH deep, done in
 * slices so nothing else waits.
 */
const fs = require('fs');
const path = require('path');

const WORDS = /carplay|car_play|smartphone|projection|iap|mane|manoeu|guid|navi|rout|turn|hud|headup|cluster|kombi|instrument/i;
const ROOTS = ['/opt', '/usr/share', '/usr/lib', '/etc', '/var/opt', '/var/lib', '/app', '/apps', '/data', '/mnt', '/home'];
const MARK = 'de_bmw_infotainment_vehicle_CDS.json';
const MAX_DIRS = 6000;
const DEPTH = 7;
const FILE = 'interfaces.txt';

function names(o) {
    if (Array.isArray(o)) return o.map((x) => (x && (x.name || x.id)) || String(x)).slice(0, 60);
    return o && typeof o === 'object' ? Object.keys(o).slice(0, 60) : [];
}

/* dir: the app's data folder; own: the app's own interface folder (always listed); version: once per version. */
function run(dir, own, version, done) {
    const out = path.join(dir, FILE);
    const head = `Schnittstellen im Auto, gelesen von ${version}`;
    try {
        if (fs.readFileSync(out, 'utf8').split('\n')[0] === head) return done && done(false);
    } catch (e) { /* not yet */ }
    const lines = [head];
    const queue = [own].concat(ROOTS).map((d) => ({ d, n: 0 }));
    const seen = {};
    let dirs = 0;
    const found = [];
    const step = () => {
        const until = Date.now() + 8;
        while (queue.length && dirs < MAX_DIRS && Date.now() < until) {
            const q = queue.shift();
            let list;
            try {
                const real = fs.realpathSync(q.d);
                if (seen[real]) continue;
                seen[real] = true;
                list = fs.readdirSync(real);
                q.d = real;
            } catch (e) { continue; }
            dirs++;
            if (list.indexOf(MARK) >= 0 || q.d === own || /someip/i.test(path.basename(q.d))) found.push({ d: q.d, list });
            if (q.n >= DEPTH) continue;
            list.slice(0, 400).forEach((name) => {
                if (name[0] === '.' || /^(proc|sys|dev|node_modules)$/.test(name)) return;
                const p = path.join(q.d, name);
                try {
                    if (fs.lstatSync(p).isDirectory()) queue.push({ d: p, n: q.n + 1 });
                } catch (e) { /* gone */ }
            });
        }
        if (queue.length && dirs < MAX_DIRS) return setTimeout(step, 20);
        found.forEach((f) => {
            const files = f.list.filter((n) => /\.json$/.test(n));
            lines.push('', `== ${f.d} (${files.length} Dateien)`);
            files.filter((n) => WORDS.test(n)).slice(0, 80).forEach((n) => {
                let text = '';
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(f.d, n), 'utf8'));
                    text = ['attributes', 'broadcasts', 'methods'].map((k) => `${k}: ${names(j[k]).join(', ') || '-'}`).join(' | ');
                    if (!j.attributes && !j.broadcasts && !j.methods) text = `keys: ${Object.keys(j).slice(0, 20).join(', ')}`;
                } catch (e) { text = `nicht lesbar (${e.code || 'kein JSON'})`; }
                lines.push(`* ${n}: ${text}`.slice(0, 1500));
            });
            lines.push(`alle: ${files.map((n) => n.replace(/\.json$/, '')).join(' ')}`.slice(0, 20000));
        });
        lines.push('', `${dirs} Ordner durchsucht, ${found.length} mit Schnittstellen${queue.length ? ' (abgebrochen: zu viele Ordner)' : ''}`);
        try {
            fs.writeFileSync(out, lines.join('\n') + '\n');
        } catch (e) { /* no room */ }
        if (done) done(true, found.length);
    };
    setTimeout(step, 0);
}

module.exports = { run, FILE };
