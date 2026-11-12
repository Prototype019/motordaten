'use strict';
/* Motordaten: package and screen description (tools/gen.js). */
module.exports = {
    description: 'Motordaten: Drehzahl und Temperaturen',
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
        SID_MD_RPM: 'Drehzahl',
        SID_MD_OIL: 'Öltemperatur',
        SID_MD_COOLANT: 'Kühlmitteltemperatur'
    },
    states: [{
        id: 1, name: 'ST_OnlineApps_Motordaten', titleId: 10, title: 'SID_MD_TITLE',
        components: [
            { id: 20, kind: 'label', name: 'mdStatus', text: '' },
            { id: 21, kind: 'row', name: 'mdRpm', text: 'SID_MD_RPM' },
            { id: 22, kind: 'row', name: 'mdOil', text: 'SID_MD_OIL' },
            { id: 23, kind: 'row', name: 'mdCoolant', text: 'SID_MD_COOLANT' }
        ]
    }],
    proxies: {
        'de.bmw.infotainment.vehicle.CDS': { instances: '1', attributes: { statusEngineSpeed2: 's', statusEngineTemperature: 's' } }
    }
};
