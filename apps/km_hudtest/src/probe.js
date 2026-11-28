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

const WORDS = /carplay|car_play|smartphone|projection|iap|mane|manoeu|guid|navi|rout|turn|hud|headup|cluster|kombi|instrument|mmode|m_mode|msetup|m_setup|mdrive|m_drive|drivingmode|driving_mode|drivemode|drive_mode|dynamic|experience|sport|chassis/i;
const ROOTS = ['/opt', '/usr/share', '/usr/lib', '/etc', '/var/opt', '/var/lib', '/app', '/apps', '/data', '/mnt', '/home'];
const MARK = 'de_bmw_infotainment_vehicle_CDS.json';
const MAX_DIRS = 6000;
const DEPTH = 7;
const FILE = 'interfaces.txt';
// the car's one catalog of every interface (fields, methods, events, types)
const CATALOG = process.env.KM_SOMEIP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
const CATALOG_MAX = 60 * 1024 * 1024;
const CATALOG_OUT = 150 * 1024;
// members that have to do with the M buttons and the M Mode (ROAD, SPORT, TRACK)
const M_WORDS = /(^|[^a-z])[mM](_?[mM]ode|_?[sS]etup|Drive|Sport|Config)|MMode|[dD]rivingExperience|[dD]riv(e|ing)Mode|(^|[^A-Z0-9])[mM][12](?![0-9a-z])/;

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
            files.filter((n) => WORDS.test(n)).slice(0, 140).forEach((n) => {
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
        raw(lines, own);
        catalog(lines);
        lines.push('', `${dirs} Ordner durchsucht, ${found.length} mit Schnittstellen${queue.length ? ' (abgebrochen: zu viele Ordner)' : ''}`);
        try {
            fs.writeFileSync(out, lines.join('\n') + '\n');
        } catch (e) { /* no room */ }
        if (done) done(true, found.length);
    };
    setTimeout(step, 0);
}

/* The access the installer gave this app (its acl, its MDrive config) and the unit's SOME/IP security files, read
 * only: why the M setups (MDrive.mDriveThree, service 46367 = 0xb51f) were refused (28.11.2026). Small files whole,
 * large ones by their start and the lines that name MDrive. */
const RAW_MAX = 24000;
const RAW_HIT = /46367|b51f|MDrive|mDrive|"uid"|"gid"|policies|allow|deny|oap/i;
function raw(lines, own) {
    const files = ['acl.json', 'acl', 'de_bmw_infotainment_misc_MDrive.json', 'de_bmw_infotainment_vehicle_Vehicle2.json']
        .map((n) => path.join(own, n));
    try {
        fs.readdirSync('/etc/vsomeip').filter((n) => /security|whitelist|acl|std|app/i.test(n)).forEach((n) => files.push(path.join('/etc/vsomeip', n)));
    } catch (e) { /* not there */ }
    lines.push('', '== Rechte (roh)');
    files.forEach((f) => {
        let t;
        try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (!/acl$/.test(f)) lines.push(`-- ${f}: nicht lesbar (${e.code})`); return; }
        let out = t;
        if (t.length > RAW_MAX) {
            const hits = t.split('\n').filter((l) => RAW_HIT.test(l)).join('\n');
            out = `${t.slice(0, 3000)}\n… (${t.length} Zeichen, Zeilen mit MDrive/46367/uid:)\n${hits.slice(0, RAW_MAX - 3000)}`;
        }
        lines.push(`-- ${f} (${t.length} Zeichen)`, out);
    });
    mainappCatalogs(lines);
}

/* The installer that refused the M setups was MainApp-21 (/usr/lib/oap-mainapp21): its own interface catalogs, if it
 * has any, and in each the MDrive entry with its fields' getter / notifier / setter. A short walk (time-capped). */
function mainappCatalogs(lines) {
    const until = Date.now() + 400;
    const queue = [];
    try { fs.readdirSync('/usr/lib').filter((n) => /^oap-mainapp/.test(n)).forEach((n) => queue.push({ d: path.join('/usr/lib', n), n: 0 })); } catch (e) { /* none */ }
    const hits = [];
    let dirs = 0;
    while (queue.length && dirs < 3000 && Date.now() < until) {
        const q = queue.shift();
        let list;
        try { list = fs.readdirSync(q.d); } catch (e) { continue; }
        dirs++;
        list.forEach((name) => {
            const p = path.join(q.d, name);
            let st;
            try { st = fs.lstatSync(p); } catch (e) { return; }
            if (st.isDirectory() && q.n < 7 && name !== 'preinstalled_apps') queue.push({ d: p, n: q.n + 1 });
            else if (st.isFile() && /(interface|someip|acl).*\.(json|js)$/i.test(name)) hits.push({ p, size: st.size });
        });
    }
    lines.push('', `== MainApp-Kataloge (${dirs} Ordner${queue.length ? ', abgebrochen' : ''})`);
    hits.slice(0, 60).forEach((h) => {
        let note = '';
        if (/\.json$/.test(h.p) && h.size < CATALOG_MAX) {
            try {
                const j = JSON.parse(fs.readFileSync(h.p, 'utf8'));
                const ifs = j.interfaces || j;
                const md = ifs && ifs['de.bmw.infotainment.misc.MDrive'];
                if (md) {
                    const f = md.fields || md.attributes || {};
                    note = ` MDrive: ${Object.keys(f).map((k) => `${k}[${(f[k].getter ? 'g' : '') + (f[k].notifier ? 'n' : '') + (f[k].setter ? 's' : '')}]`).join(', ')}`.slice(0, 2500);
                } else note = ' (ohne MDrive)';
            } catch (e) { note = ' (kein JSON)'; }
        }
        lines.push(`* ${h.p} (${h.size} B)${note}`);
    });
}

/* What a type is, short: an enum with its values, a struct with its members. */
function typ(db, ref, depth) {
    const d = db.datatypes && db.datatypes[ref];
    if (!d) return String(ref);
    if (d.type === 'enum') return `enum(${Object.keys(d.items || {}).slice(0, 24).map((k) => `${k}=${d.items[k]}`).join(',')})`;
    if (d.type === 'typedef') return depth > 3 ? 'typedef' : typ(db, d.dataRef || d.baseType, depth + 1);
    if (d.type === 'array') return depth > 3 ? '[]' : `[${typ(db, d.elementDataRef, depth + 1)}]`;
    if (d.type === 'struct') {
        if (depth > 1) return 'struct';
        let mem = [];
        for (let dd = d, i = 0; dd && i < 6; dd = dd.extends && db.datatypes[dd.extends], i++) mem = (dd.members || []).concat(mem);
        return `{${mem.slice(0, 30).map((m) => `${m.name}:${typ(db, m.dataRef, depth + 1)}`).join(', ')}}`;
    }
    return String(d.type);
}

/* The catalog's interfaces that fit WORDS or have a member fitting M_WORDS: those members with their types first. */
function catalog(lines) {
    let db;
    try {
        if (fs.statSync(CATALOG).size > CATALOG_MAX) return lines.push('', `== Katalog ${CATALOG}: zu groß`);
        db = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    } catch (e) {
        return lines.push('', `== Katalog ${CATALOG}: nicht lesbar (${e.code || 'kein JSON'})`);
    }
    const ifs = db.interfaces || {};
    const all = Object.keys(ifs);
    lines.push('', `== Katalog ${CATALOG} (${all.length} Schnittstellen)`);
    const exact = [];
    const rest = [];
    const mdrive = [];
    all.forEach((name) => {
        const i = ifs[name] || {};
        const inst = db.instanceIDs && db.instanceIDs[name];
        const fields = i.fields || {};
        const flag = (f) => (f.getter ? 'g' : '') + (f.notifier ? 'n' : '') + (f.setter ? 's' : '');
        const hits = [];
        // the M setups and M Mode (M1/M2 buttons): every field in full, to learn what each one holds
        if (/\.MDrive$/.test(name)) Object.keys(fields).forEach((k) => mdrive.push(`  MDrive ${k} [${flag(fields[k])}] = ${typ(db, fields[k].dataRef, 0)}`.slice(0, 3000)));
        Object.keys(fields).forEach((k) => {
            const t = typ(db, fields[k].dataRef, 0);
            // by its name, or by its values: a type that knows ROAD and TRACK is the M Mode whatever it is called
            if (M_WORDS.test(k) || (/ROAD/i.test(t) && /TRACK/i.test(t))) hits.push(`  M Feld ${name} . ${k} [${flag(fields[k])}] = ${t}`.slice(0, 900));
        });
        ['methods', 'events'].forEach((kind) => Object.keys(i[kind] || {}).filter((k) => M_WORDS.test(k)).forEach((k) => {
            const m = i[kind][k] || {};
            const args = (m.inputs || m.arguments || m.in || []);
            const a = Array.isArray(args) ? args.map((x) => `${x.name}:${typ(db, x.dataRef, 1)}`).join(', ') : '';
            hits.push(`  M ${kind === 'methods' ? 'Befehl' : 'Ereignis'} ${name} . ${k}(${a})`.slice(0, 900));
        }));
        if (hits.length) exact.push.apply(exact, hits);
        if (hits.length || WORDS.test(name)) {
            rest.push(`* ${name} (svc ${i.serviceId}, inst ${JSON.stringify(inst)}): Felder: ${Object.keys(fields).map((k) => `${k}[${flag(fields[k])}]`).join(', ') || '-'}`
                + ` | Befehle: ${Object.keys(i.methods || {}).join(', ') || '-'} | Ereignisse: ${Object.keys(i.events || {}).join(', ') || '-'}`);
        }
    });
    Object.keys(db.datatypes || {}).forEach((ref) => {
        const d = db.datatypes[ref];
        const keys = d && d.type === 'enum' ? Object.keys(d.items || {}).join(' ') : '';
        if (/ROAD/i.test(keys) && /TRACK/i.test(keys)) exact.push(`  M Typ ${ref} = ${typ(db, ref, 0)}`.slice(0, 900));
    });
    let room = CATALOG_OUT;
    mdrive.concat(exact).concat(rest.map((l) => l.slice(0, 2500))).forEach((l) => {
        if ((room -= l.length + 1) >= 0) lines.push(l);
    });
    if (room < 0) lines.push('(gekürzt)');
    lines.push(`alle: ${all.join(' ')}`.slice(0, 40000));
}

module.exports = { run, FILE };
