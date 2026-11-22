'use strict';
/**
 * shared/mmode.js: which M Mode a press of M1 / M2 brings.   node tools/test_mmode.js
 */
const assert = require('assert');
const { MMode } = require('../shared/mmode.js');

let pick = { m1: 'sport', m2: 'road' };
let t = 0;
const sent = [];
const notes = [];
const mk = () => new MMode({ pick: () => pick, send: (m) => sent.push(m), note: (x) => notes.push(x), now: () => t });

// what is on when the app starts is not a press
let m = mk();
m.mode('road');
assert.strictEqual(m.setup('m1'), false);
assert.deepStrictEqual(sent, []);

// M2 pressed: Road wanted, Road is on -> nothing; M1 pressed: Sport
t += 5000; m.setup('m2');
assert.deepStrictEqual(sent, []);
t += 5000; assert.strictEqual(m.setup('m1'), true);
assert.deepStrictEqual(sent, ['sport']);
assert.ok(/M1 gedrückt, schalte auf Sport/.test(notes[0]), notes[0]);
m.mode('sport');

// the same setup reported again: no second command; the setup off: nothing
t += 5000; m.setup('m1'); m.setup(null);
assert.deepStrictEqual(sent, ['sport']);

// the driver picks Track by hand: it stays; the next press of M2 brings Road
m.mode('track');
t += 5000; m.setup('m2');
assert.deepStrictEqual(sent, ['sport', 'road']);
m.mode('road');

// a bouncing report within a second: one command only
m.setup(null); m.mode('sport'); t += 100; m.setup('m2');
assert.deepStrictEqual(sent, ['sport', 'road']);

// "Nichts" picked, an unknown word, an unknown setup: nothing
pick = { m1: 'none', m2: 'quatsch' };
t += 5000; m.setup(null); m.setup('m1'); m.setup('m2'); m.setup('m3');
assert.deepStrictEqual(sent, ['sport', 'road']);

// Track can be picked; a failing send is noted, not thrown
pick = { m1: 'track', m2: 'none' };
t += 5000; m.setup(null); m.setup('m1');
assert.deepStrictEqual(sent, ['sport', 'road', 'track']);
m = new MMode({ pick: () => ({ m1: 'sport' }), send: () => { throw new Error('zu'); }, note: (x) => notes.push(x), now: () => t });
m.setup(null);
assert.strictEqual(m.setup('m1'), false);
assert.ok(/ging nicht raus/.test(notes[notes.length - 1]));
console.log('test_mmode: ok');
