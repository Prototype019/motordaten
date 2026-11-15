'use strict';
/**
 * HUD-Test: one image layer on the head-up display through cluster-render
 * (robertnisipeanu/idrive-apps, installed from the Store as "Cluster renderer"),
 * through its Node client (src/cluster_render_client.js, MPL-2.0, unchanged):
 * the target hud, all of its 353 x 203.
 *
 * Nothing here talks to the car's units: it only draws what update() gets.
 * Drawn at most every DRAW_MS, and only when what is shown changes. on(false)
 * hides the layer, so the renderer releases the HUD and BMW's own content is
 * back; on(true) shows it again.
 *
 * Events: 'change' whenever anything rows() shows changed.
 *
 * Copyright (c) 2026 Prototype019. All rights reserved (LICENSE).
 */
const EventEmitter = require('events');
const fs = require('fs');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client.js');
const draw = require('./hud_draw.js');

const DRAW_MS = 250;
/* Layer states (PROTOCOL.md "layer") in German, for the list. */
const LAYER_DE = { shown: 'angezeigt', waiting: 'wartet auf den Platz', suspended: 'verdeckt', stalled: 'hängt',
    hidden: 'ausgeblendet', error: 'Fehler' };
/* Target states (PROTOCOL.md "target"). On iDrive 8 "parked" is offered, until the cluster shows it. */
const TARGET_DE = { idle: 'frei', acquiring: 'wird angefragt', parked: 'angeboten, nicht gezeigt', shown: 'angezeigt',
    lingering: 'läuft aus', waiting: 'wartet', unavailable: 'nicht verfügbar' };

const pixelsOf = (c) => Buffer.from(c.d.buffer, c.d.byteOffset, c.d.length);

class HudLink extends EventEmitter {
    /* opts: socketPath (the service's socket), Client (a ClusterRender class) */
    constructor(opts) {
        super();
        opts = opts || {};
        // KM_CR_SOCKET: the tests' fake service (tools/test_app.js)
        this._path = opts.socketPath || process.env.KM_CR_SOCKET || DEFAULT_PATH;
        this._Client = opts.Client || ClusterRender;
        this._cr = null;
        this._on = true;
        this._values = { oil: null };
        this._shownKey = null;
        this._lastDraw = 0;
        this._drawTimer = null;
        this._canvas = null;
        this.ref = 0;
        this.conn = 'aus';                  // aus, verbinde, verbunden, getrennt
        this.backend = null;                // id7 / id8, from the service's hello
        this.targets = null;                // the service's targets with sizes: "map:874x749,hud:353x203,..."
        this.layer = 'noch nicht';
        this.target = '';
        this.refused = '';
        this.frames = 0;
    }

    /* Whether the service's socket is there (cluster-render installed and its socket up). */
    installed() {
        try {
            fs.statSync(this._path);
            return true;
        } catch (e) {
            return false;
        }
    }

    start() {
        if (this._cr) return;
        const cr = new this._Client('km_hudtest', this._path);
        this._cr = cr;
        this.conn = 'verbinde';
        this.ref = cr.image({ target: 'hud', klass: 'overlay', x: 0, y: 0, w: draw.HUD.w, h: draw.HUD.h,
            iw: draw.HUD.w, ih: draw.HUD.h, fps: 5, visible: this._on ? 1 : 0 });
        cr.on('ready', () => {
            this.conn = 'verbunden';
            this.backend = cr.backend || null;
            this.targets = cr.targets || null;
            // after every (re)connect the client sends the image whole again; draw now anyway
            this._shownKey = null;
            this._draw(true);
            this.emit('change');
        });
        cr.on('disconnected', () => {
            this.conn = 'getrennt';
            this.emit('change');
        });
        cr.on('layer', (ref, state, reason) => {
            if (ref !== this.ref) return;
            this.layer = (LAYER_DE[state] || state) + (reason ? ` (${reason})` : '');
            this.emit('change');
        });
        cr.on('target', (t, state, holder, reason) => {
            if (t !== 'hud') return;
            this.target = [TARGET_DE[state] || state, holder ? `hält: ${holder}` : '', reason || ''].filter(Boolean).join(', ');
            this.emit('change');
        });
        cr.on('refused', (op, ref, reason) => {
            this.refused = `${op}${ref ? ` ${ref === this.ref ? 'HUD' : ref}` : ''}: ${reason}`;
            this.emit('change');
        });
        cr.connect();
        this._draw(true);
    }

    stop() {
        clearTimeout(this._drawTimer);
        this._drawTimer = null;
        if (this._cr) {
            this._cr.close();
            this._cr = null;
        }
        this.conn = 'aus';
        this.emit('change');
    }

    /* The HUD shown (true) or hidden (false). */
    on(show) {
        this._on = !!show;
        if (this._cr) this._cr.set(this.ref, { visible: this._on ? 1 : 0 });
        this.emit('change');
    }

    isOn() {
        return this._on;
    }

    /* New values: { oil }. */
    update(v) {
        Object.assign(this._values, v);
        this._draw(false);
    }

    /* Drawn again when what shows changed, at most every DRAW_MS. */
    _draw(now) {
        if (!this._cr) return;
        const wait = DRAW_MS - (Date.now() - this._lastDraw);
        if (!now && wait > 0) {
            if (!this._drawTimer) {
                this._drawTimer = setTimeout(() => { this._drawTimer = null; this._draw(true); }, wait);
            }
            return;
        }
        this._lastDraw = Date.now();
        const v = this._values;
        const key = [draw.num(v.oil, 0), draw.oilColour(v.oil).join()].join('|');
        if (key === this._shownKey) return;
        this._canvas = draw.drawHud(v, this._canvas);
        if (this._cr.pixels(this.ref, null, pixelsOf(this._canvas))) {
            this._shownKey = key;
            this.frames++;
        }
    }

    /* The list's rows: [label, value]. */
    rows() {
        return [
            ['Renderer', this.conn + (this.backend ? ` (${this.backend})` : '')],
            ['Ziele des Renderers', String(this.targets || '–').replace(/,/g, ', ')],
            ['HUD', this._on ? this.layer : 'aus'],
            ['HUD-Platz', this.target || '–'],
            ['Bilder gesendet', String(this.frames)],
            ['Abgelehnt', this.refused || '–']
        ];
    }
}

module.exports = { HudLink, DRAW_MS };
