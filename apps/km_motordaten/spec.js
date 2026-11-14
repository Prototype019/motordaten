'use strict';
/* Motordaten: package and screen description (tools/gen.js). */
/* Proxy buttons of the drawn screens' host state. */
const PROXIES = 24;

module.exports = {
    PROXIES,
    description: 'Motordaten: Temperaturen, Ladedruck, Öldruck und Drehzahl der DME live',
    loggingId: 'KMMD',
    diskBytes: 67108864,        // the logbook: up to 20 recordings of 30 min
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
        SID_MD_TITLE: 'Motordaten',
        SID_MD_RESET: 'Spitzenwerte zurücksetzen'
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
         * (src/dash.js targets: the settings page has the most, 18). */
        id: 2, name: 'ST_OnlineApps_MotordatenLayer', titleId: 11, title: 'SID_MD_TITLE',
        components: Array.from({ length: PROXIES }, (x, i) => ({ id: 30 + i, kind: 'button', name: `mdLayerP${i}`, text: '' }))
    }],
    proxies: {
        'de.bmw.infotainment.vehicle.CDS': { instances: '1', attributes: { statusEngineSpeed2: 's', statusEngineTemperature: 's' } },
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': {
            instances: 'SystemFunctionsInternalTasuInst1',
            methods: ['sendTasuRequest'],
            broadcasts: ['sendTasuResponse']
        }
    }
};
