'use strict';
/**
 * Daten-Test: reads the head unit's SOME/IP interface database (the file
 * MainApp builds every app's permissions from) and shows which vehicle
 * signals and diagnostic services this head unit has: each interface, its
 * instance, and per field whether it can be read (getter) and subscribed
 * (notifier), per method and event whether it is there. It names no vehicle
 * interface in its own manifest and calls nothing, so it installs and runs
 * on any head unit.
 */
const fs = require('fs');
const { ListApp, logger } = require('./screen.js');

const CATALOGS = (process.env.KM_CATALOG ? [process.env.KM_CATALOG] : []).concat([
    '/etc/oap/someip/someip-interfaces.json',
    '/usr/share/oap/someip/someip-interfaces.json'
]);

/* What our apps want, by interface: fields, methods and events. */
const WANTED = [
    { label: 'CDS', iface: 'de.bmw.infotainment.vehicle.CDS',
        fields: ['statusEngineSpeed2', 'statusEngineTemperature', 'statusEngineStatus', 'statusBattery2'] },
    { label: 'CDS2', iface: 'de.bmw.infotainment.vehicle.CDS2',
        fields: ['statusInjectionVolume', 'statusLongitudinalAccelerationMassCenter', 'statusLateralAccelerationMassCenter'] },
    { label: 'FES', iface: 'de.bmw.infotainment.drivingexcitement.FES',
        fields: ['statusSwitchDriveDynamicSport2', 'statusActualValueTorque2', 'statusVehicleDynamicEngine'] },
    { label: 'Vehicle2', iface: 'de.bmw.infotainment.vehicle.Vehicle2', fields: ['statusCarSpeed2', 'statusOilDipstick2'] },
    { label: 'Fahrzeuginfo', iface: 'de.bmw.infrastructure.VehicleInformation', fields: ['statusGearboxDrive', 'DataPowerTrain2'] },
    { label: 'Umgebung', iface: 'de.bmw.infrastructure.EnvironmentalInformation', fields: ['ExteriorTemperature'] },
    { label: 'Kombi', iface: 'de.bmw.infotainment.KombiIF', fields: ['statusRangeTankStatus'] },
    { label: 'Pedal', iface: 'de.bmw.powertrain.AcceleratorPedal', fields: ['AngleAcceleratorPedal'] },
    { label: 'Diagnose TASU', iface: 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu',
        methods: ['sendTasuRequest'], events: ['sendTasuResponse'] }
];

/* Other interfaces worth knowing about: diagnostics under another name. */
const SEARCH = /tasu|diag|uds|obd/i;
const SEARCH_MAX = 8;

function readCatalog() {
    const tried = [];
    for (const file of CATALOGS) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (e) {
            tried.push(`${file}: ${e.code || e.message}`);
            continue;
        }
        return { file, size: text.length, db: JSON.parse(text) };
    }
    throw new Error(tried.join('; '));
}

function fieldState(fd) {
    if (!fd) {
        return 'fehlt';
    }
    const get = !!fd.getter;
    const evt = !!fd.notifier;
    return get && evt ? 'lesen + abo' : get ? 'nur lesen' : evt ? 'nur abo' : 'da, ohne Zugriff';
}

/* The rows for one database: [left, right]. */
function check(cat) {
    const ifs = cat.db.interfaces || {};
    const inst = cat.db.instanceIDs || {};
    const rows = [['Katalog', `${cat.file.split('/').pop()} · ${Math.round(cat.size / 1024)} kB · ${Object.keys(ifs).length} Dienste`]];
    WANTED.forEach((w) => {
        const i = ifs[w.iface];
        if (!i) {
            rows.push([w.label, 'FEHLT']);
            return;
        }
        const instances = inst[w.iface];
        rows.push([w.label, `da · Instanz ${instances === undefined ? '?' : JSON.stringify(instances)}`]);
        (w.fields || []).forEach((f) => rows.push([`  ${f}`, fieldState((i.fields || {})[f])]));
        (w.methods || []).forEach((m) => rows.push([`  ${m}()`, (i.methods || {})[m] ? 'da' : 'fehlt']));
        (w.events || []).forEach((e) => rows.push([`  ${e} (Event)`, (i.events || {})[e] ? 'da' : 'fehlt']));
    });
    const found = Object.keys(ifs).filter((n) => SEARCH.test(n) && !WANTED.some((w) => w.iface === n));
    found.slice(0, SEARCH_MAX).forEach((n) => rows.push(['Weitere', n]));
    if (found.length > SEARCH_MAX) {
        rows.push(['Weitere', `+${found.length - SEARCH_MAX} mehr`]);
    }
    return rows;
}

class Datentest extends ListApp {
    constructor() {
        super({ root: 'ST_OnlineApps_Datentest', prefix: 'dt' });
    }

    run() {
        this.show('Lese Dienst-Katalog …', []);
        // let the status line reach the screen before the parse blocks the process
        setTimeout(() => {
            try {
                const cat = readCatalog();
                const rows = check(cat);
                logger.info(`catalog ${cat.file}: ${rows.map((r) => r.join('=')).join(' | ')}`);
                this.show('', rows);
            } catch (e) {
                const status = `Katalog nicht lesbar: ${e.message}`;
                logger.error(status);
                this.show(status);
            }
        }, 200);
    }
}

const app = new Datentest();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`datentest failed to start: ${err && err.message}`);
});

module.exports = { check, fieldState, WANTED };
