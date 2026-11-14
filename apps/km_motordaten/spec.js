'use strict';
/* Motordaten: package and screen description (tools/gen.js). */
module.exports = {
    description: 'Motordaten: Temperaturen, Ladedruck, Öldruck und Drehzahl der DME live',
    loggingId: 'KMMD',
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
        /* The host state of the drawn screen (src/drawn.js): the renderer draws over it while it is open;
         * its one button stands for the reset button under the controller. */
        id: 2, name: 'ST_OnlineApps_MotordatenLayer', titleId: 11, title: 'SID_MD_TITLE',
        components: [
            { id: 30, kind: 'button', name: 'mdLayerP0', text: 'SID_MD_RESET' }
        ]
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
