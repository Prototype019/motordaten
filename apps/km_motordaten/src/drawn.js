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
 * - Pages 'main', 'logs', 'log' and 'settings' (setPage; setExtra for what they show). Their pressable targets
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
const PRESS_SHOW_MS = 150;
const GLIDE_MS = 90;
const WHOLE = Object.freeze({ x: 0, y: 0, w: dash.W, h: dash.H });
/* A hide the HMI asks for (state hidden or unfocused) waits this long: it reports both for a moment
 * while it re-lays out the state (a page change, the controller moving), and the layer gone for that
 * moment shows the proxy list under it. Showing is at once. */
const HIDE_SETTLE_MS = 800;
/* The controller's dial counter (FrontCCU frontRotaryEncoderOperation): 0xffff is invalid, a jump past
 * DIAL_MAX_STEP detents a stale sample. */
const DIAL_INVALID = 0xffff;
const DIAL_MAX_STEP = 24;
const TRACE_KEEP = 10;

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
        this.extra = {};            // what the pages show besides the values: recording, logs, log, channel, confirmDelete
        this.bars = { rpm: null, boost: null };   // the bars as drawn, gliding to the values
        this.ui = { focus: null, pressed: null };
        this.touchOn = null;        // the target a touch went down on
        this.hostShown = false;
        this.hostFocused = true;
        this.closedHide = false;
        this.single = false;        // one proxy only: the dial comes from FrontCCU (ccu), the push from that proxy
        this.knob = DIAL_INVALID;
        this.trace = [];            // the last visibility events, for the Grenzwerte page and the log
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
        this.gpu.on('state', (st) => this._note(`render ${st.onScreen ? 'sichtbar' : 'weg'}${st.front ? '' : ' (andere App vorn)'}`));
        this.gpu.on('closed', () => {
            this._note('render geschlossen (Touch außerhalb)');
            // the renderer hid the layer because a touch reached the HMI (outside the app area, or a tap the
            // divert missed). Shown again at once while the host state is still there: the list under it
            // never stays; when the HMI leaves the app, the host state's hide or the renderer's foreground
            // gate (another app in front) keeps the layer away.
            this.closedHide = true;
            this._update();
            setImmediate(() => { this.closedHide = false; this._update(); });
        });
    }

    connect() {
        this.gpu.connect();
    }

    close() {
        clearInterval(this.keepalive);
        clearTimeout(this.hideTimer);
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

    /* The host state shown or hidden. Shown counts as focused too: coming back from another app the HMI
     * reports the state visible again but not always its focus. */
    hostVisible(on) {
        this._note(on ? 'HMI sichtbar' : 'HMI versteckt');
        this.hostShown = on;
        if (on) {
            this.hostFocused = true;
        }
        this._update();
    }

    hostFocus(on) {
        this._note(on ? 'HMI Fokus' : 'HMI Fokus weg');
        this.hostFocused = on;
        this._update();
    }

    /* The controller's focus on proxy button i. */
    proxyFocus(i, on) {
        if (on) {
            this._hostIsHere();
        }
        if (this.single) {
            return;                 // the focus is the dial's (ccu)
        }
        const t = dash.targets(this.page, this.extra)[i];
        if (on && t) {
            this.ui.focus = t.id;
        } else if (!on && t && this.ui.focus === t.id) {
            this.ui.focus = null;
        }
        this.invalidate();
    }

    proxyPress(i) {
        this._note(`Taste ${i}`);
        this._hostIsHere();
        const ts = dash.targets(this.page, this.extra);
        if (this.single) {
            const t = ts.find((x) => x.id === this.ui.focus);
            if (t) {
                this._press(t.id);
            } else if (ts.length) {
                this.ui.focus = ts[0].id;   // nothing focused yet: the push shows where the focus is
                this.invalidate();
            }
            return;
        }
        const t = ts[i];
        if (t) {
            this.ui.focus = t.id;
            this._press(t.id);
        }
    }

    /* A proxy of the host state has the focus or a press: the state is on screen and focused, whatever
     * the HMI reported before (so a list left showing goes back under the layer at the next touch of it). */
    _hostIsHere() {
        if (!this.hostShown || !this.hostFocused) {
            this.hostShown = true;
            this.hostFocused = true;
            this._update();
        }
    }

    /* One proxy only (the dial read from FrontCCU), or one per target. */
    setSingle(on) {
        if (on === this.single) {
            return;
        }
        this.single = on;
        this._note(on ? 'Controller direkt' : 'Controller über Liste');
        this._targetsChanged(true);
    }

    /**
     * A FrontCCU.statusRotaryEncoderState sample. A turn of the dial while shown moves the focus over the
     * page's targets in their order (single mode). 'dial' is emitted on every real turn, so the app learns
     * that FrontCCU reports the dial (0: its first valid sample).
     */
    ccu(s) {
        const op = s && s.frontRotaryEncoderOperation;
        const knob = typeof op === 'number' && op !== DIAL_INVALID ? op : DIAL_INVALID;
        const last = this.knob;
        if (knob === DIAL_INVALID) {
            return;
        }
        this.knob = knob;
        if (last === DIAL_INVALID) {
            this.emit('dial', 0);       // FrontCCU reports the dial's counter: one proxy from now
            return;
        }
        const steps = ((knob - last + 0x18000) % 0x10000) - 0x8000;
        if (steps === 0 || Math.abs(steps) > DIAL_MAX_STEP) {
            return;
        }
        this.emit('dial', steps);
        if (!this.single || !this.on_) {
            return;
        }
        const ts = dash.targets(this.page, this.extra);
        if (!ts.length) {
            return;
        }
        const at = ts.findIndex((t) => t.id === this.ui.focus);
        const to = at < 0 ? 0 : Math.max(0, Math.min(ts.length - 1, at + steps));
        this.ui.focus = ts[to].id;
        this.invalidate();
    }

    _note(what) {
        const d = new Date();
        const t = `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
        this.trace.push(`${t} ${what}`);
        if (this.trace.length > TRACE_KEEP) {
            this.trace.shift();
        }
        this.log.info(`screen: ${what}`);
        if (this.page === 'settings') {
            this.invalidate();
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
        this._targetsChanged(true);
        this.invalidate();
    }

    /* What the pages show besides the values (merged in); the app hears when the targets change. */
    setExtra(extra) {
        this.extra = Object.assign({}, this.extra, extra);
        this._targetsChanged(false);
        this.invalidate();
    }

    _targetsChanged(always) {
        const ts = dash.targets(this.page, this.extra);
        const key = ts.map((t) => `${t.id}=${t.label}`).join('|');
        if (always || key !== this._targetsKey) {
            this._targetsKey = key;
            this.emit('targets', ts);
        }
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
        if (on) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        } else if (this.on_ && this.mode === 'layer' && !this.closedHide) {
            // hidden or unfocused: only if it stays so
            if (!this.hideTimer) {
                this.hideTimer = setTimeout(() => {
                    this.hideTimer = null;
                    this._apply(this._shouldShow());
                }, HIDE_SETTLE_MS);
            }
            return;
        }
        this._apply(on);
    }

    _apply(on) {
        if (on === this.on_) {
            return;
        }
        this.on_ = on;
        this._note(on ? 'Grafik an' : 'Grafik aus');
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
        dash.draw(this.rec, this.page, v, this.limits, this.ui, this.page === 'settings' ? Object.assign({ trace: this.trace }, this.extra) : this.extra);
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
        const t = dash.targets(this.page, this.extra).find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
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
