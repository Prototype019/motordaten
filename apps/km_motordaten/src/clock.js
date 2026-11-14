'use strict';
/**
 * The car's clock. The head unit's system time is UTC; the time the HMI
 * shows is the instrument cluster's display time (KombiIF
 * statusShowTimeDate), in the time zone and summer time set in the car.
 * Its offset from UTC is taken from that, in quarter hours, the way the
 * MGU Store does (store_view.js setClusterTime, GPL-3.0).
 *
 * wall(ms) is a Date whose UTC fields read the car's wall clock: show and
 * name times with getUTCHours() etc. Before the cluster tells, the offset
 * is 0 (UTC).
 */

const DAY_MS = 86400000;
const QUARTER_MS = 900000;
const CLUSTER_UNFILLED = 15;

let offsetMin = 0;
let known = false;

/* The cluster's display time: the offset from it. Returns whether it changed. */
function setCluster(show, now) {
    const status = show && show.statusDisplayClockTimeDate;
    if (status === CLUSTER_UNFILLED || typeof status !== 'number' || status % 2 !== 1 ||
        !(show.displayHour < 24) || !(show.displayMinute < 60)) {
        return false;
    }
    const sec = show.displaySecond < 60 ? show.displaySecond : 0;
    const t = now === undefined ? Date.now() : now;
    const diff = ((((show.displayHour * 60 + show.displayMinute) * 60 + sec) * 1000 - t) % DAY_MS + DAY_MS) % DAY_MS;
    let offset = (Math.round(diff / QUARTER_MS) * 15) % 1440;
    if (offset > 720) {
        offset -= 1440;            // west of UTC
    }
    const changed = offset !== offsetMin || !known;
    offsetMin = offset;
    known = true;
    return changed;
}

function wall(ms) {
    return new Date((ms === undefined ? Date.now() : ms) + offsetMin * 60000);
}

module.exports = { setCluster, wall, offset: () => offsetMin, known: () => known };
