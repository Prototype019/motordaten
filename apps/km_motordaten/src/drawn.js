'use strict';
/**
 * The drawn screen: src/dash.js on the GPU through the renderer mgu-render
 * (installed by the MGU Store), in layer mode, as the Store draws its own
 * screens on iDrive 8.
 *
 * - connect(): at its answer, 'mode' is emitted with 'layer' (the renderer
 *   is there and offers layer mode) or null (the list screen stays).
 * - The layer shows while the host state is visible and has the HMI's
 *   focus (hostVisible / hostFocus); then the reset button's box is claimed
 *   for touch, and the app's frame is drawn on each renderer tick while
 *   something changed, and at least once a second (an app silent for 3 s
 *   is hidden).
 * - A tap on the reset button, or a press on the host state's proxy button
 *   (the controller), emits 'reset'. A touch outside the claim goes to the
 *   HMI, which closes the layer for a moment ('closed').
 */
const EventEmitter = require('events');
const { RenderClient } = require('./mgu_render_client.js');
const { Recorder } = require('./kit_record.js');
const dash = require('./dash.js');

const KEEPALIVE_MS = 1000;
const CLOSED_RESHOW_MS = 700;
const PRESS_SHOW_MS = 150;

class Drawn extends EventEmitter {
    /* gpu: the renderer client (a RenderClient for appId unless given, as in the tests). */
    constructor(appId, log, gpu) {
        super();
        this.log = log;
        this.gpu = gpu || new RenderClient(appId, log);
        this.rec = new Recorder(dash.W, dash.H);
        this.mode = undefined;      // undefined: no answer yet; null: no renderer
        this.values = {};
        this.ui = { focus: false, pressed: false };
        this.hostShown = false;
        this.hostFocused = true;
        this.closedHide = false;
        this.on_ = false;
        this.dirty = true;
        this.sentAt = 0;
        this.keepalive = null;
        this.gpu.on('ready', (screen, info) => this._ready(info));
        this.gpu.on('close', () => this._setMode(null));
        this.gpu.on('tick', () => {
            if (this.dirty) {
                this.render();
            }
        });
        this.gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        this.gpu.on('closed', () => {
            this.closedHide = true;
            this._update();
            setTimeout(() => { this.closedHide = false; this._update(); }, CLOSED_RESHOW_MS);
        });
    }

    connect() {
        this.gpu.connect();
    }

    close() {
        clearInterval(this.keepalive);
        this.gpu.removeAllListeners('close');
        this.gpu.close();
    }

    _ready(info) {
        let mode = null;
        if (info && info.modes && info.modes.indexOf('layer') >= 0 && info.appArea) {
            const a = info.appArea;
            const scale = Math.min(a.w / dash.W, a.h / dash.H);
            const ox = Math.round((a.w - dash.W * scale) / 2);
            const oy = Math.round((a.h - dash.H * scale) / 2);
            this.gpu.mode('layer');
            this.gpu.place({ x: a.x, y: a.y, w: a.w, h: a.h, scale, ox, oy });
            this.rec = new Recorder(dash.W, dash.H, { textScale: scale });
            mode = 'layer';
            this.log.info(`renderer: layer ${a.w}x${a.h} at ${a.x},${a.y}, scale ${scale.toFixed(3)}`);
        } else {
            this.log.info(`renderer: ${info ? 'no layer mode' : 'not there or not mgu-render/1'}; list screen`);
        }
        this._setMode(mode);
    }

    _setMode(mode) {
        if (mode === this.mode) {
            return;
        }
        this.mode = mode;
        this._update();
        this.emit('mode', mode);
    }

    hostVisible(on) {
        this.hostShown = on;
        this._update();
    }

    hostFocus(on) {
        this.hostFocused = on;
        this._update();
    }

    proxyFocus(on) {
        this.ui.focus = on;
        this.invalidate();
    }

    proxyPress() {
        this._pressed();
    }

    /* New values: drawn at the next tick. */
    set(values) {
        this.values = values;
        this.invalidate();
    }

    invalidate() {
        this.dirty = true;
        if (this.on_ && !this.gpu.waiting) {
            this.render();
        }
    }

    isShown() {
        return this.on_;
    }

    _shouldShow() {
        return this.mode === 'layer' && this.hostShown && this.hostFocused && !this.closedHide;
    }

    _update() {
        const on = this._shouldShow();
        if (on === this.on_) {
            return;
        }
        this.on_ = on;
        this.gpu.claim(on ? [dash.RESET] : []);
        if (on) {
            this.render();
        }
        this.gpu.show(on);
        clearInterval(this.keepalive);
        this.keepalive = on ? setInterval(() => {
            if (Date.now() - this.sentAt >= KEEPALIVE_MS) {
                this.render();
            }
        }, KEEPALIVE_MS) : null;
        this.emit('shown', on);
    }

    render() {
        if (!this.on_) {
            return;
        }
        this.dirty = false;
        this.rec.reset();
        dash.draw(this.rec, this.values, this.ui);
        try {
            this.gpu.frame(this.rec);
            this.sentAt = Date.now();
        } catch (e) {
            this.log.warn(`frame: ${e && e.message}`);
        }
    }

    _touch(phase, x, y) {
        const r = dash.RESET;
        const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
        if (phase === 'down' && inside) {
            this.ui.pressed = true;
            this.invalidate();
        } else if (phase === 'up') {
            const was = this.ui.pressed;
            this.ui.pressed = false;
            this.invalidate();
            if (was && inside) {
                this._pressed();
            }
        }
    }

    _pressed() {
        this.ui.pressed = true;
        this.invalidate();
        setTimeout(() => { this.ui.pressed = false; this.invalidate(); }, PRESS_SHOW_MS);
        this.emit('reset');
    }
}

module.exports = { Drawn };
