/**
 * Collects the Metro, visitor, work-trip, and southeast-route work's runs before and after into
 * server/beta3/reference/metro-results.json for the article and METHOD: experiment.ts (Muni routes,
 * BART exits, miles per boarding, changes of vehicle), od-checks.ts (purposes, home county, CTPP
 * workplace transit shares), diag-metro.ts (Metro rides by stop, 2006–07 counts, BART in the city), and
 * diag-routes.ts (who rides the low routes), with the NTD's light-rail history.
 * Run: npx tsx server/beta3/pipeline/metro-results.ts <dir with exp0, od0, metro0, routes0, areas0 and exp1, od1, metro1, routes1, areas1 .json> [calibration log]
 */
import fs from 'node:fs';
import { REFERENCE } from './paths';
import { tepMetro } from './diag-metro';

const [dir, clog] = process.argv.slice(2);
const read = (f: string) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
const has = (f: string) => fs.existsSync(`${dir}/${f}`);
type Exp = {
  muni: { r: number; pctRmse: number; model: number; observed: number; within25: number };
  groups: Record<string, [number, number]>;
  bart: { r: number; pctRmse: number; total: number };
  tripMiles: { bus: number; metro: number };
  transitTrips: number;
  transfers: { groups?: { muni?: { boardings: number; after: number } } };
  routes: { route: string; obs: number; mod: number }[];
  residentShares: Record<string, number>;
};
const FOCUS = ['T', '14', '14R', '49', '8', '8AX', '8BX', '9', '9R', '15', '44', '54', '38', '38R', '5', '5R', 'N', 'J', 'K', 'L', 'M'];
/** %RMSE of the routes with the model's total scaled to the counts' (the pattern without the level) */
const scaledRmse = (rs: { obs: number; mod: number }[]) => {
  const k = rs.reduce((a, r) => a + r.obs, 0) / rs.reduce((a, r) => a + r.mod, 0);
  const mo = rs.reduce((a, r) => a + r.obs, 0) / rs.length;
  return (100 * Math.sqrt(rs.reduce((a, r) => a + (k * r.mod - r.obs) ** 2, 0) / rs.length)) / mo;
};
const run = (e: Exp) => ({
  muniRoutes: { r: e.muni.r, pctRmse: e.muni.pctRmse, pctRmseScaled: scaledRmse(e.routes), model: Math.round(e.muni.model), observed: e.muni.observed, within25: e.muni.within25 },
  groups: Object.fromEntries(Object.entries(e.groups).map(([k, [o, m]]) => [k, { observed: o, model: Math.round(m) }])),
  bartCityExits: { r: e.bart.r, pctRmse: e.bart.pctRmse, total: e.bart.total },
  tripMiles: e.tripMiles,
  muniAfterVehicle: e.transfers.groups?.muni ? e.transfers.groups.muni.after / e.transfers.groups.muni.boardings : null,
  linkedTransitTrips: Math.round(e.transitTrips),
  residentTransit: e.residentShares.transit,
  routes: Object.fromEntries(FOCUS.map((r) => [r, (() => { const x = e.routes.find((y) => y.route === r); return x ? { observed: x.obs, model: Math.round(x.mod) } : null; })()])),
});
type Od = {
  riders: { purposeMuniLightRail: { purpose: string; observed: number; model: number; modelByTour: number }[]; purposeMuniBus: { purpose: string; observed: number; model: number; modelByTour: number }[]; residentShare: Record<string, { model: number; observed?: number }>; boardingsByMarket: Record<string, { lightRail: number; bus: number; t: number }> };
  commute: { totalTransitShare: { observed: number; model: number }; byDistrict: { district: string; observedTransitShare: number; modelTransitShare: number; observedShareOfCommuters: number; modelShareOfCommuters: number }[] } | null;
};
const riders = (o: Od) => {
  const m = o.riders.boardingsByMarket;
  const tot = Object.values(m).reduce((a, v) => a + v.lightRail + v.bus + v.t, 0);
  const share = (f: (k: string) => boolean) => Object.entries(m).filter(([k]) => f(k)).reduce((a, [, v]) => a + v.lightRail + v.bus + v.t, 0) / tot;
  return {
    purposeLightRail: o.riders.purposeMuniLightRail,
    purposeBus: o.riders.purposeMuniBus,
    residentShare: o.riders.residentShare,
    // shares of Muni's boardings (the markets assigned one by one; sightseeing rides not included)
    hotelVisitors: share((k) => k === 'visitor'),
    airTravelers: share((k) => k === 'airport'),
    inCommuters: share((k) => k === 'in-commuters'),
    regionalVisitors: share((k) => k === 'regional'),
    notFromHomeNonResidents: share((k) => k === 'nhb'),
    muniBoardings: Math.round(tot),
  };
};
const snap = JSON.parse(fs.readFileSync(`${REFERENCE}/od-validation.json`, 'utf8')).snapshot;
const nonSfBayArea = (op: string) => Object.entries(snap[op].home_county as Record<string, number>).filter(([c]) => c !== 'San Francisco' && c !== 'Outside Bay Area').reduce((a, [, v]) => a + v, 0);
const ntdHist = fs.existsSync(`${REFERENCE}/ntd-trip-length.json`) ? JSON.parse(fs.readFileSync(`${REFERENCE}/ntd-trip-length.json`, 'utf8')).agencies.muni : null;
const visitorLine = clog && fs.existsSync(clog) ? fs.readFileSync(clog, 'utf8').split('\n').find((l) => l.startsWith("hotel visitors' target")) ?? null : null;
const side = (k: '0' | '1') => ({
  ...(has(`exp${k}.json`) ? run(read(`exp${k}.json`)) : {}),
  riders: has(`od${k}.json`) ? riders(read(`od${k}.json`)) : null,
  commute: has(`od${k}.json`) ? (read(`od${k}.json`) as Od).commute : null,
  metro: has(`metro${k}.json`) ? (({ tep2006: _t, ...m }) => m)(read(`metro${k}.json`)) : null,
  routeGroups: has(`routes${k}.json`) ? read(`routes${k}.json`) : null,
  areas: has(`areas${k}.json`) ? read(`areas${k}.json`).rows : null,
});
const out = {
  description: "The Metro, visitor, work-trip, and southeast-route work (October 2026). Before: the short-trip model on its own calibration (work-local/short cal2 bundle). After: this work's changes on a 6-iteration weekday calibration from it. Experiment runs: 2 passes from the base run's crowding. Riders by market: each market assigned alone at the base crowding (od-checks.ts). Metro rides by stop and the 2006–07 counts: diag-metro.ts (straight lines between stops). Route groups: diag-routes.ts.",
  generated: new Date().toISOString().slice(0, 10),
  ntd: {
    busMilesPerBoarding: ntdHist?.busMBplusTB.avgTripMiles,
    metroMilesPerBoarding: ntdHist?.byMode.LR.avgTripMiles,
    lightRailHistory: ntdHist?.lightRailHistory ?? null,
  },
  snapshot: {
    outsideBayArea: { lightRail: snap['SFMTA (Muni) -- Light Rail'].home_county['Outside Bay Area'], bus: snap['SFMTA (Muni) -- Local Bus'].home_county['Outside Bay Area'] },
    otherBayAreaCounties: { lightRail: nonSfBayArea('SFMTA (Muni) -- Light Rail'), bus: nonSfBayArea('SFMTA (Muni) -- Local Bus') },
  },
  visitorTarget: visitorLine
    ? {
        shares: Object.fromEntries([...visitorLine.matchAll(/\b(da|sr|walk|tnc|bike|transit) ([\d.]+)/g)].map((m) => [m[1], Number(m[2]) / 100])),
        roomsByPlaceType: Object.fromEntries([...visitorLine.matchAll(/(\d): (\d+)%/g)].map((m) => [m[1], Number(m[2]) / 100])),
      }
    : null,
  tep2006: tepMetro(),
  tep2006MiPerBoarding: (() => {
    const t = Object.values(tepMetro());
    return t.reduce((a, v) => a + v.boardings * v.miPerBoarding, 0) / t.reduce((a, v) => a + v.boardings, 0);
  })(),
  before: side('0'),
  after: side('1'),
};
fs.writeFileSync(`${REFERENCE}/metro-results.json`, JSON.stringify(out, null, 1));
console.log(`written ${REFERENCE}/metro-results.json`);
