'use strict';
/**
 * Runs src/datentest.js on a fake head unit with a small interface database
 * and checks the rows it shows; then with no database at all.
 *
 *   node tools/test_app.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'km-dt-')), 'someip-interfaces.json');
fs.writeFileSync(CAT, JSON.stringify({
    interfaces: {
        'de.bmw.infotainment.vehicle.CDS': { fields: {
            statusEngineSpeed2: { getter: 1, notifier: 2 }, statusEngineTemperature: { notifier: 3 } } },
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': {
            methods: { sendTasuRequest: {} }, events: { sendTasuResponse: {} } },
        'com.harman.diagnostics.Other': {}
    },
    instanceIDs: { 'de.bmw.infotainment.vehicle.CDS': '1',
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': 'SystemFunctionsInternalTasuInst1' }
}));
process.env.KM_CATALOG = CAT;

const unit = require('../../../tools/fake_unit.js').install(require('../spec.js'),
    require('../package/rhmiData/application.json'));
const realExit = process.exit;
process.exit = () => {};
require('../src/datentest.js');

(async () => {
    await unit.wait(400);
    assert.strictEqual(unit.opened, unit.uuid, 'entry state opened');
    const rows = unit.rows('dtList');
    const get = (l) => (rows.find((r) => r[0] === l) || [])[1];
    assert.ok(/3 Dienste/.test(get('Katalog')), get('Katalog'));
    assert.strictEqual(get('CDS'), 'da · Instanz "1"');
    assert.strictEqual(get('  statusEngineSpeed2'), 'lesen + abo');
    assert.strictEqual(get('  statusEngineTemperature'), 'nur abo');
    assert.strictEqual(get('  statusEngineStatus'), 'fehlt');
    assert.strictEqual(get('FES'), 'FEHLT');
    assert.strictEqual(get('Diagnose TASU'), 'da · Instanz "SystemFunctionsInternalTasuInst1"');
    assert.strictEqual(get('  sendTasuRequest()'), 'da');
    assert.strictEqual(get('  sendTasuResponse (Event)'), 'da');
    assert.strictEqual(get('Weitere'), 'com.harman.diagnostics.Other');
    assert.strictEqual(unit.props['dtStatus.Visible'], 0, 'status hidden when done');

    // no database: the status line says so
    fs.unlinkSync(CAT);
    unit.press('dtRun');
    await unit.wait(400);
    assert.ok(/Katalog nicht lesbar/.test(unit.text('dtStatus')), unit.text('dtStatus'));
    assert.strictEqual(unit.props['dtStatus.Visible'], 1);

    console.log(`test_app (datentest): ok, ${rows.length} rows`);
    realExit(0);
})().catch((e) => { console.error(e, unit.log); realExit(1); });
