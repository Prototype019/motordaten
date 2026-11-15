'use strict';
/* HUD-Test: package and screen description (tools/gen.js). */
module.exports = {
    description: 'HUD-Test: Öltemperatur im Head-up-Display (Test)',
    loggingId: 'KMHT',
    diskBytes: 10485760,
    // Node 8 with the oap-sdk and SOME/IP, one 353x203 RGBA canvas and the renderer client's copy of it
    memoryKB: 98304,
    cpuLimit: 30,
    icon: 'hudtest_icon.png',
    titleSid: 'SID_HT_TITLE',
    uuids: {
        application: 'ea1923f2-1d1f-42e7-83d1-eaa9a360289f',
        strings: '89526b48-750d-420f-9607-a5df1fe663a1',
        resources: 'ba164455-86c6-424e-ae96-ddefa34b36d0',
        entry: '9221f8a2-e08f-4872-a0b2-ca84aeb2be16'
    },
    texts: {
        SID_TEMP_EMPTY: '',
        SID_HT_TITLE: 'HUD-Test',
        SID_HT_RUN: 'HUD an / aus'
    },
    states: [{
        id: 1, name: 'ST_OnlineApps_HudTest', titleId: 10, title: 'SID_HT_TITLE',
        components: [
            { id: 20, kind: 'label', name: 'htStatus', text: '' },
            { id: 25, kind: 'button', name: 'htRun', text: 'SID_HT_RUN' },
            { id: 24, kind: 'row', name: 'htList', text: '' }
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
