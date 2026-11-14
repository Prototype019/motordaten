'use strict';
/**
 * The unit's build check (the MGU Store's tools/oap_link.js link(), GPL-3.0): every require in the
 * app's modules must name one of them ('./x.js' as listed in mgu-app.json), an sdk name of
 * mgu-app.json, or a Node builtin; anything else and the unit refuses the package ("nothing changed").
 *
 *   node tools/test_build.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const builtins = require('module').builtinModules;

const root = path.join(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(root, 'mgu-app.json'), 'utf8'));
const names = app.modules.map((f) => `./${path.basename(f)}`);
const bad = [];
app.modules.forEach((f) => {
    const source = fs.readFileSync(path.join(root, f), 'utf8');
    const re = /require\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        const name = m[1];
        if (names.indexOf(name) < 0 && app.sdk.indexOf(name) < 0 && builtins.indexOf(name) < 0) {
            bad.push(`${f} requires "${name}"`);
        }
    }
});
// every module in src is listed (a module left out is missing on the unit)
fs.readdirSync(path.join(root, 'src')).filter((n) => /\.js$/.test(n)).forEach((n) => {
    assert.ok(app.modules.indexOf(`src/${n}`) >= 0, `src/${n} not in mgu-app.json modules`);
});
assert.deepStrictEqual(bad, [], 'requires the unit refuses');
console.log(`test_build: ok, ${app.modules.length} modules`);
