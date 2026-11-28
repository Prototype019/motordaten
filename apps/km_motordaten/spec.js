'use strict';
/* Motordaten: package and screen description (tools/gen.js). */
/* Proxy buttons of the drawn screens' host state. */
const PROXIES = 48;

module.exports = {
    PROXIES,
    description: 'M Suite: Motordaten live, Maximalwerte, Logs, Fehlerspeicher, M-Tasten',
    loggingId: 'KMMD',
    // starts with the head unit (package.json mguAppStartType): at the engine start it is already running and
    // opens by itself (Einstellungen › App); in the background it reads nothing from the car but the CDS signal
    startType: 'autostart',
    diskBytes: 134217728,       // the logbook: up to 20 recordings of 30 min (~3 MB each), fault texts, diag.log
    // MainApp ends an app past these: Node 8 with the oap-sdk and SOME/IP, the drawn screens, the fault texts
    // and the logbook need more than the 64 MB / 20 % a list app gets (the idrive7-apps kit gives 192 MB / 60 %)
    memoryKB: 196608,
    cpuLimit: 60,
    icon: 'motordaten_icon.png',
    titleSid: 'SID_MD_TITLE',
    uuids: {
        application: 'da40fc2d-3f65-47c7-846b-4f8c438fe835',
        strings: 'a0ee1d78-27ba-4996-9355-df9bace162a4',
        resources: '1e3a9ac0-607b-4ad6-a2c1-6562b2965d03',
        entry: '3f2cb455-d92b-4ae5-8e24-fdd887f1a6d0'
    },
    texts: {
        SID_TEMP_EMPTY: '',
        SID_MD_TITLE: 'M Suite',
        SID_MD_RESET: 'Reset'
    },
    states: [{
        id: 1, name: 'ST_OnlineApps_Motordaten', titleId: 10, title: 'SID_MD_TITLE',
        components: [
            { id: 20, kind: 'label', name: 'mdStatus', text: '' },
            { id: 24, kind: 'row', name: 'mdList', text: '' },
            { id: 25, kind: 'button', name: 'mdRun', text: 'SID_MD_RESET' }
        ]
    }, {
        /* The host state of the drawn screens (src/drawn.js): the renderer draws over it while it is open;
         * its buttons stand for the drawn page's targets under the controller, one each, in order
         * (src/dash.js targets: the fault page with every unit failing has the most, 40). */
        id: 2, name: 'ST_OnlineApps_MotordatenLayer', titleId: 11, title: 'SID_MD_TITLE',
        components: Array.from({ length: PROXIES }, (x, i) => ({ id: 30 + i, kind: 'button', name: `mdLayerP${i}`, text: '' }))
    }],
    proxies: {
        'de.bmw.infotainment.vehicle.CDS': { instances: '1', attributes: { statusEngineSpeed2: 's', statusEngineTemperature: 's' } },
        // M setups and M Mode: the mode now and the M1/M2 messages (read); mDriveThree read only. With 'rw' (the
        // setter) the G87's installer refused the whole app (0.31.0, 28.11.2026): writing is not for this app
        'de.bmw.infotainment.misc.MDrive': { instances: '1', attributes: { statusMDriveThree: 's', controlDisplayMSystems: 's', mDriveThree: 'r' } },
        'de.bmw.infotainment.vehicle.Vehicle2': { instances: '1', attributes: { statusCarSpeed2: 's' } },
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': {
            instances: 'SystemFunctionsInternalTasuInst1',
            methods: ['sendTasuRequest'],
            broadcasts: ['sendTasuResponse']
        }
    }
};
