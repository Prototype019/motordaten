'use strict';
/* HUD: package and screen description (tools/gen.js). */
/* Proxy buttons of the drawn screens' host state (src/dash.js targets: the most on a page, Bereit: 5 tabs + 13). */
const PROXIES = 24;

module.exports = {
    PROXIES,
    description: 'M Suite HUD: Warmfahren und Werte im Head-up-Display',
    // started with the head unit (and again should it stop): the HUD shows without the app being opened first
    startType: 'autostart',
    loggingId: 'KMHT',
    diskBytes: 10485760,
    // Node 8 with the oap-sdk and SOME/IP, the drawn screens (fonts, the recorder) and the HUD's 353x203 canvas
    memoryKB: 163840,
    cpuLimit: 40,
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
        SID_HT_TITLE: 'M Suite HUD',
        SID_HT_RUN: 'Anzeige aus / an'
    },
    states: [{
        id: 1, name: 'ST_OnlineApps_HudTest', titleId: 10, title: 'SID_HT_TITLE',
        components: [
            { id: 20, kind: 'label', name: 'htStatus', text: '' },
            { id: 25, kind: 'button', name: 'htRun', text: 'SID_HT_RUN' },
            { id: 24, kind: 'row', name: 'htList', text: '' }
        ]
    }, {
        /* The host state of the drawn screens (src/drawn.js): the renderer draws over it while it is open;
         * its buttons stand for the drawn page's targets under the controller, one each, in order. */
        id: 2, name: 'ST_OnlineApps_HudTestLayer', titleId: 11, title: 'SID_HT_TITLE',
        components: Array.from({ length: PROXIES }, (x, i) => ({ id: 30 + i, kind: 'button', name: `htLayerP${i}`, text: '' }))
    }],
    proxies: {
        // engine speed, oil and coolant (statusEngineSpeed2, statusEngineTemperature: as Motordaten); the gateway for
        // the oil when the signal has none, and for the values shown under Werte that only the units have
        'de.bmw.infotainment.vehicle.CDS': { instances: '1', attributes: { statusEngineSpeed2: 's', statusEngineTemperature: 's' } },
        // the car's speed and braking (read only): when to hand the HUD picture over anew (settings refresh)
        'de.bmw.infotainment.vehicle.Vehicle2': { instances: '1', attributes: { statusCarSpeed2: 's' } },
        'de.bmw.infotainment.vehicle.CDS2': { instances: '1', attributes: { statusLongitudinalAccelerationMassCenter: 's' } },
        // route guidance on or off (read only): while BMW guides, the HUD is its own, our picture stays away
        // (on the G87 guidanceState stayed INACTIVE while guiding, 22.11.2026: the route's own signals are read too)
        'de.bmw.infotainment.navigation.guiding.Guidance': { instances: 'Main_Instance',
            attributes: { guidanceState: 's', guidingProvider: 's', finalDestinationInfo: 's', nextDestinationInfo: 's' } },
        // a route on the phone: guidanceState stays INACTIVE then (seen on the G87 and by other apps' authors);
        // the phone's projection says whether its turn-by-turn runs (projectedGuidanceActive, read only)
        'de.bmw.infotainment.a4a.carplay.CarPlayManager': { instances: 'CarPlayManagerInst1', attributes: { projectedGuidanceActive: 's' } },
        'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager': {
            instances: 'AndroidAutoProjectedManagerInst1', attributes: { projectedGuidanceActive: 's' } },
        'de.bmw.infotainment.navigation.routing.Routing': { instances: 'Main_Instance', attributes: { currentTrips: 's' } },
        'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': {
            instances: 'SystemFunctionsInternalTasuInst1',
            methods: ['sendTasuRequest'],
            broadcasts: ['sendTasuResponse']
        }
    }
};
