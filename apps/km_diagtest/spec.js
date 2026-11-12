'use strict';
/* Diagnose-Test: package and screen description (tools/gen.js). Its manifest
 * names the diagnostic gateway service; a head unit without it refuses the
 * install (Daten-Test shows whether it has it). */
module.exports = {
    description: 'Diagnose-Test: DME-Typ, OBD-II- und BMW-Werte lesen (nur lesend)',
    loggingId: 'KMDG',
    icon: 'diagtest_icon.png',
    titleSid: 'SID_DG_TITLE',
    uuids: {
        application: '688b4f56-c87c-42d5-9c08-92bedfdabce1',
        strings: '0d35b12e-c307-4787-ad8d-cab45547ecbe',
        resources: 'e1ef0a5e-a976-4d4d-a579-e0b09d1ec13f',
        entry: 'b1ffcaf4-4624-4e22-8c3b-48147817c658'
    },
    texts: {
        SID_TEMP_EMPTY: '',
        SID_DG_TITLE: 'Diagnose-Test',
        SID_DG_RUN: 'Erneut testen'
    },
    states: [{
        id: 1, name: 'ST_OnlineApps_Diagtest', titleId: 10, title: 'SID_DG_TITLE',
        components: [
            { id: 20, kind: 'label', name: 'dgStatus', text: '' },
            { id: 21, kind: 'button', name: 'dgRun', text: 'SID_DG_RUN' },
            { id: 22, kind: 'row', name: 'dgList', text: '' }
        ]
    }],
    proxies: {
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': {
            instances: 'SystemFunctionsInternalTasuInst1',
            methods: ['sendTasuRequest'],
            broadcasts: ['sendTasuResponse']
        }
    }
};
