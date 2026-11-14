'use strict';
/**
 * The recordings onto a USB stick: every CSV of the logbook into the folder Motordaten on the first stick
 * mounted (the head unit mounts a stick directly under /media). Copied one file after the other without
 * blocking the screen, each written to the stick before the next (fsync), so the stick can come out when the
 * page says done.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */

const fs = require('fs');
const path = require('path');

const FOLDER = 'Motordaten';

/* The mount points directly under root (default /media) in the mount table (default /proc/mounts), whose
 * second field writes a space, tab, newline or backslash as a backslash and three octal digits. */
function sticks(mountsFile, root) {
    const parent = path.resolve(root || '/media');
    let table;
    try {
        table = fs.readFileSync(mountsFile || '/proc/mounts', 'utf8');
    } catch (e) {
        return [];
    }
    const found = new Set();
    for (const line of table.split('\n')) {
        const field = line.split(' ')[1];
        if (!field) {
            continue;
        }
        const where = field.replace(/\\(\d{3})/g, (all, oct) => String.fromCharCode(parseInt(oct, 8)));
        if (path.dirname(where) === parent) {
            found.add(where);
        }
    }
    return Array.from(found).sort();
}

const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));

/* One file onto the stick, flushed to it. */
function copy(from, to) {
    return call(fs.readFile, from).then((data) => call(fs.open, to, 'w').then((fd) => call(fs.write, fd, data, 0, data.length, 0)
        .then(() => call(fs.fsync, fd))
        .then(() => call(fs.close, fd), (err) => call(fs.close, fd).then(() => { throw err; }, () => { throw err; }))));
}

/**
 * Copies names (from dir) into <stick>/Motordaten. progress(done, of) after each file. Resolves to
 * { stick: its label, count }; rejects with a message for the screen.
 */
function exportLogs(dir, names, opts) {
    const o = opts || {};
    const found = sticks(o.mounts, o.root);
    if (!found.length) {
        return Promise.reject(new Error('Kein USB-Stick gefunden. Stick einstecken und kurz warten.'));
    }
    const stick = found[0];
    const target = path.join(stick, FOLDER);
    let done = 0;
    return call(fs.mkdir, target).catch((err) => {
        if (err.code !== 'EEXIST') {
            throw err;
        }
    }).then(() => names.reduce((p, name) => p.then(() => copy(path.join(dir, name), path.join(target, name))).then(() => {
        done++;
        if (o.progress) {
            o.progress(done, names.length);
        }
    }), Promise.resolve())).then(() => ({ stick: path.basename(stick), count: done }), (err) => {
        const why = err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') ?
            'der Stick lässt die App nicht schreiben' : err && err.code === 'ENOSPC' ? 'der Stick ist voll' : (err && err.message) || String(err);
        throw new Error(`Nicht gespeichert (${done} von ${names.length}): ${why}.`);
    });
}

module.exports = { sticks, exportLogs, FOLDER };
