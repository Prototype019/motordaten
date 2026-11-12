'use strict';
/* Daten-Test: package and screen description (tools/gen.js). Its manifest
 * names only the platform proxies, so it installs on any head unit. */
module.exports = {
    description: 'Daten-Test: welche Fahrzeugsignale und Diagnose-Dienste diese Headunit hat',
    loggingId: 'KMDT',
    memoryKB: 196608,
    icon: 'datentest_icon.png',
    titleSid: 'SID_DT_TITLE',
    uuids: {
        application: '2b24c558-848d-411a-9468-11e9398be015',
        strings: 'f394d45d-473d-44c5-a20f-6e884dee7a94',
        resources: '31e477b8-2a5d-4684-b884-f6d375674853',
        entry: 'c9db7f14-ab98-4745-a03a-5c9aed1cd4b9'
    },
    texts: {
        SID_TEMP_EMPTY: '',
        SID_DT_TITLE: 'Daten-Test',
        SID_DT_RUN: 'Erneut prüfen'
    },
    states: [{
        id: 1, name: 'ST_OnlineApps_Datentest', titleId: 10, title: 'SID_DT_TITLE',
        components: [
            { id: 20, kind: 'label', name: 'dtStatus', text: '' },
            { id: 21, kind: 'button', name: 'dtRun', text: 'SID_DT_RUN' },
            { id: 22, kind: 'row', name: 'dtList', text: '' }
        ]
    }],
    proxies: {}
};
