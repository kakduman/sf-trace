/**
 * Collects the short-trip work's before-and-after runs into server/beta3/reference/short-trip-results.json
 * for the article and METHOD: experiment.ts runs (Muni routes, BART exits, miles per boarding, changes of
 * vehicle, residents' shares), diag-length.ts (mode by distance, Muni by market, the cost of a short
 * trip), diag-hills.ts, and od-checks.ts riders (the Snapshot's purposes).
 * Run: npx tsx server/beta3/pipeline/short-trip-results.ts <before experiment.json> <before diag-length.json>
 *   <after experiment.json> <after diag-length.json> <after od-checks.json> <after diag-hills.json> [calibration log]
 */
import fs from 'node:fs';
import { REFERENCE } from './paths';
import { residentLinkedShares } from './resident-targets';

const [bx, bl, ax, al, aod, ah, clog] = process.argv.slice(2);
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
type Exp = {
  muni: { r: number; pctRmse: number; model: number; observed: number; within25: number };
  groups: Record<string, [number, number]>;
  bart: { r: number; pctRmse: number; total: number };
  tripMiles: { bus: number; metro: number };
  residentShares: Record<string, number>;
  transitTrips: number;
  transfers: Record<string, unknown>;
  routes: { route: string; obs: number; mod: number }[];
};
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
  linkedTransitTrips: Math.round(e.transitTrips),
  residentShares: e.residentShares,
});
// the share of Muni boardings after another vehicle, as experiment.ts traces it (transfers.ts)
const afterVehicle = (e: Exp) => {
  const m = (e.transfers as unknown as { groups?: { muni?: { boardings: number; after: number } } }).groups?.muni;
  return m ? m.after / m.boardings : null;
};
const before = read(bx), after = read(ax), lenB = read(bl), lenA = read(al);
const od = aod ? read(aod) : null, hills = ah ? read(ah) : null;
const ntd = read(`${REFERENCE}/ntd-trip-length.json`).agencies.muni;
const nhts = read(`${REFERENCE}/nhts-transit-length.json`);
const pick = (L: Record<string, unknown>, k: string) => (L.modeByDistance as Record<string, unknown>)[k];
// the calibration's last school fit and youth fit, from its log
const fit = (() => {
  if (!clog || !fs.existsSync(clog)) return null;
  const lines = fs.readFileSync(clog, 'utf8').split('\n').filter((l) => l.startsWith('iter '));
  const last = lines[lines.length - 1] ?? '';
  const school = /school and college ([\d.]+)\/([\d.]+)% of Muni → const ([-\d.]+)/.exec(lines.filter((l) => /school and college/.test(l)).pop() ?? '');
  const youth = /youth sr ([\d.]+)\/([\d.]+) transit ([\d.]+)\/([\d.]+)/.exec(last);
  return {
    school: school ? { model: Number(school[1]) / 100, target: Number(school[2]) / 100, constant: Number(school[3]) } : null,
    youthTransit: youth ? { model: Number(youth[3]) / 100, bats: Number(youth[4]) / 100 } : null,
  };
})();
// shares of Muni's boardings by market group (diag-length.ts, each market assigned alone): school and
// college tours' legs from and to home, hotel visitors, and residents' trips of every kind
const muniShares = (L: { muniByMarket?: Record<string, { muni: number }> }) => {
  const m = L.muniByMarket ?? {};
  const tot = Object.values(m).reduce((a, v) => a + v.muni, 0);
  const sum = (f: (k: string) => boolean) => Object.entries(m).filter(([k]) => f(k)).reduce((a, [, v]) => a + v.muni, 0) / tot;
  return {
    muniBoardings: Math.round(tot),
    schoolCollegeDirect: sum((k) => /^resident (school|univ)/.test(k)),
    hotelVisitors: sum((k) => k === 'visitor'),
    residents: sum((k) => k.startsWith('resident ')),
  };
};
// the Snapshot's riders living outside the Bay Area, light rail and buses weighted by the counted
// boardings on the subway lines and the T and on the buses (as calibrate.ts weights the school share)
const outsideBayArea = (() => {
  const snap = read(`${REFERENCE}/od-validation.json`).snapshot;
  const lr = snap['SFMTA (Muni) -- Light Rail'].home_county['Outside Bay Area'], bus = snap['SFMTA (Muni) -- Local Bus'].home_county['Outside Bay Area'];
  const g = (after as Exp).groups;
  const rail = g.subway[0] + g.T[0], b = g.bus[0];
  return (lr * rail + bus * b) / (rail + b);
})();
const out = {
  description: "The short-trip work (October 2026): before, the calibrated model with the transfer fix (work-local/xfers: calafter bundle, experiment 'after'); after, the model with the four fixes on its own 6+6-iteration weekday calibration. Experiment runs: 2 passes from the base run's crowding. Mode by distance: residents' trips inside the city with one end at home (direct legs), by road miles; NHTS: nhts-transit-length.json. Muni by market: each market assigned alone at the base crowding (diag-length.ts).",
  generated: new Date().toISOString().slice(0, 10),
  target: residentLinkedShares(read(`${REFERENCE}/sf-mode-by-area.json`)),
  snapshotOutsideBayArea: outsideBayArea,
  ntd: { busMilesPerBoarding: ntd.busMBplusTB.avgTripMiles, metroMilesPerBoarding: ntd.byMode.LR.avgTripMiles },
  before: { ...run(before), muniAfterVehicle: afterVehicle(before) },
  after: { ...run(after), muniAfterVehicle: afterVehicle(after) },
  bandsMi: lenA.bandsMi,
  homeBased: { before: pick(lenB, 'homeBased'), after: pick(lenA, 'homeBased'), nhts: nhts.homeBased.byBand },
  zeroCar: { before: pick(lenB, 'car0'), after: pick(lenA, 'car0'), nhts: nhts.zeroCar.byBand },
  transitBySeg: { before: lenB.transitBySeg, after: lenA.transitBySeg, nhtsZeroCarShareOfTransit: nhts.segments.zeroCar.shareOfTransitTrips },
  muniByMarket: { before: lenB.muniByMarket, after: lenA.muniByMarket },
  muniShares: { before: muniShares(lenB), after: muniShares(lenA) },
  middayCost: lenB.middayCost,
  hills,
  fit,
  snapshot: od?.riders ? { purposeMuniLightRail: od.riders.purposeMuniLightRail, purposeMuniBus: od.riders.purposeMuniBus, residentShare: od.riders.residentShare } : null,
};
fs.writeFileSync(`${REFERENCE}/short-trip-results.json`, JSON.stringify(out, null, 1));
console.log(`written ${REFERENCE}/short-trip-results.json`);
