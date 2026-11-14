'use strict';
/**
 * The drawn screens: src/dash.js on the GPU through the renderer mgu-render
 * (installed by the MGU Store), in layer mode, as the Store draws its own
 * screens on iDrive 8.
 *
 * - connect(): at its answer, 'mode' is emitted with 'layer' (the renderer
 *   is there and offers layer mode) or null (the list screen stays).
 * - The layer shows while the host state is visible and has the HMI's
 *   focus (hostVisible / hostFocus); then its whole area is claimed for
 *   touch (a touch the HMI got would close the layer and show the list
 *   state under it), and a frame is drawn on each renderer tick while
 *   something changed, and at least once a second (an app silent for 3 s
 *   is hidden).
 * - Two pages, 'main' and 'settings' (setPage). Their pressable targets
 *   (dash.targets) answer a tap, and the controller through the host
 *   state's proxy buttons, one per target in order (proxyFocus /
 *   proxyPress); 'targets' tells the app which a page has. A press emits
 *   'action' with the target's id.
 * - The engine speed and boost bars glide to a new value over about
 *   GLIDE_MS (frames keep coming while they move); numbers show the value.
 */
const EventEmitter = require('events');
const { RenderClient } = require('./mgu_render_client.js');
const { Recorder } = require('./kit_record.js');
const dash = require('./dash.js');

const KEEPALIVE_MS = 1000;
const CLOSED_RESHOW_MS = 700;
const PRESS_SHOW_MS = 150;
const GLIDE_MS = 90;
const WHOLE = Object.freeze({ x: 0, y: 0, w: dash.W, h: dash.H });

class Drawn extends EventEmitter {
    /* gpu: the renderer client (a RenderClient for appId unless given, as in the tests). */
    constructor(appId, log, gpu) {
        super();
        this.log = log;
        // kit: the client uploads the glyph atlases, ramps and layers a frame uses from it (no kit: no text)
        this.gpu = gpu || new RenderClient(appId, log, { kit: require('./kit_record.js'), mode: 'layer' });
        this.rec = new Recorder(dash.W, dash.H);
        this.mode = undefined;      // undefined: no answer yet; null: no renderer
        this.page = 'main';
        this.values = {};
        this.limits = {};
        this.bars = { rpm: null, boost: null };   // the bars as drawn, gliding to the values
        this.ui = { focus: null, pressed: null };
        this.touchOn = null;        // the target a touch went down on
        this.hostShown = false;
        this.hostFocused = true;
        this.closedHide = false;
        this.on_ = false;
        this.dirty = true;
        this.sentAt = 0;
        this.lastFrame = 0;
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

    /* The controller's focus on proxy button i. */
    proxyFocus(i, on) {
        const t = dash.targets(this.page)[i];
        if (on && t) {
            this.ui.focus = t.id;
        } else if (!on && t && this.ui.focus === t.id) {
            this.ui.focus = null;
        }
        this.invalidate();
    }

    proxyPress(i) {
        const t = dash.targets(this.page)[i];
        if (t) {
            this.ui.focus = t.id;
            this._press(t.id);
        }
    }

    setPage(page) {
        if (page === this.page) {
            return;
        }
        this.page = page;
        this.ui.focus = null;
        this.ui.pressed = null;
        this.touchOn = null;
        this.emit('targets', dash.targets(page));
        this.invalidate();
    }

    /* New values: drawn at the next tick. */
    set(values) {
        this.values = values;
        this.invalidate();
    }

    setLimits(limits) {
        this.limits = limits;
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
        this.gpu.claim(on ? [WHOLE] : []);
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
        this.dirty = this._glide();
        this.rec.reset();
        const v = Object.assign({}, this.values, { rpmBar: this.bars.rpm, boostBar: this.bars.boost });
        dash.draw(this.rec, this.page, v, this.limits, this.ui);
        try {
            this.gpu.frame(this.rec);
            this.sentAt = Date.now();
        } catch (e) {
            this.log.warn(`frame: ${e && e.message}`);
        }
    }

    /* Moves the bars toward their values; true while one still moves. */
    _glide() {
        const now = Date.now();
        const dt = Math.min(100, now - (this.lastFrame || now));
        this.lastFrame = now;
        const k = 1 - Math.exp(-dt / GLIDE_MS);
        let moving = false;
        ['rpm', 'boost'].forEach((key) => {
            const to = this.values[key];
            const from = this.bars[key];
            if (typeof to !== 'number' || !isFinite(to)) {
                this.bars[key] = null;
            } else if (typeof from !== 'number' || Math.abs(to - from) < (key === 'rpm' ? 5 : 0.005)) {
                this.bars[key] = to;
            } else {
                this.bars[key] = from + (to - from) * k;
                moving = true;
            }
        });
        return moving;
    }

    _hit(x, y) {
        const t = dash.targets(this.page).find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        return t ? t.id : null;
    }

    _touch(phase, x, y) {
        const id = this._hit(x, y);
        if (phase === 'down') {
            this.touchOn = id;
            this.ui.pressed = id;
            this.invalidate();
        } else if (phase === 'move') {
            const pressed = id === this.touchOn ? id : null;
            if (pressed !== this.ui.pressed) {
                this.ui.pressed = pressed;
                this.invalidate();
            }
        } else if (phase === 'up') {
            const was = this.touchOn;
            this.touchOn = null;
            this.ui.pressed = null;
            this.invalidate();
            if (was && was === id) {
                this.emit('action', was);
            }
        }
    }

    _press(id) {
        this.ui.pressed = id;
        this.invalidate();
        setTimeout(() => { this.ui.pressed = null; this.invalidate(); }, PRESS_SHOW_MS);
        this.emit('action', id);
    }
}

module.exports = { Drawn };
