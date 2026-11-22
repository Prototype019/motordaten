'use strict';
/**
 * The app's own notebook of what went wrong, kept in its data folder (diag.log, the one before as diag.1.log)
 * and saved onto the USB stick with the recordings: an OAP app's log goes to the unit's DLT, which nobody
 * reads in the car. Lines are "<car's wall time> <text>", written every few seconds without blocking.
 */

const fs = require('fs');
const path = require('path');
const clock = require('./clock.js');

const FILE = 'diag.log';
const OLD = 'diag.1.log';
const MAX_BYTES = 512 * 1024;
const FLUSH_MS = 3000;

let pending = [];
let timer = null;
let writing = false;

function dir() {
    return process.env.KM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function stamp() {
    const d = clock.wall();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:` +
        `${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

function note(text) {
    pending.push(`${stamp()} ${text}`);
    if (pending.length > 2000) {
        pending = pending.slice(-2000);
    }
    if (!timer) {
        timer = setTimeout(flush, FLUSH_MS);
    }
}

/* Appends what is pending; a file past MAX_BYTES becomes diag.1.log. done() once written. */
function flush(done) {
    timer = null;
    if (writing || !pending.length) {
        if (done) {
            done();
        }
        return;
    }
    writing = true;
    const lines = pending;
    pending = [];
    const file = path.join(dir(), FILE);
    fs.stat(file, (e, st) => {
        const rotate = !e && st.size > MAX_BYTES;
        const go = () => fs.appendFile(file, `${lines.join('\n')}\n`, () => {
            writing = false;
            if (done) {
                done();
            }
        });
        if (rotate) {
            fs.rename(file, path.join(dir(), OLD), go);
        } else {
            fs.mkdir(dir(), () => go());
        }
    });
}

/* The notebook's files that are there, for the USB stick. */
function files() {
    return [OLD, FILE].filter((n) => fs.existsSync(path.join(dir(), n)));
}

module.exports = { note, flush, files, dir, FILE };
