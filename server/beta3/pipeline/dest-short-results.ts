/**
 * Collects the near-destination work's runs into server/beta3/reference/dest-short-results.json for
 * the article and METHOD: how far trips go by purpose and how far stops are out of the way (against
 * NHTS tours), residents' mode by distance (against the NHTS), and the experiment.ts scores (Muni
 * routes, miles per boarding, changes of vehicle, BART exits, residents' shares), before and after,
 * with the fitted distance and walking terms of the after bundle.
 * Run: BETA3_SF_BUNDLE=<after sf.bin.gz> npx tsx server/beta3/pipeline/dest-short-results.ts
 *   <before experiment.json> <before diag-length.json> <after experiment.json> <after diag-length.json> [calibration log]
 *   [exploration log: the near terms refitted in demand passes against the means of all trips up to 12 miles]
 *   [the first calibration's log, which oscillated at full steps]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { REFERENCE } from './paths';
import { lengthTargets } from './trip-lengths';

const [bx, bl, ax, al, clog, xlog, flog] = process.argv.slice(2);
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
type Exp = {
  muni: { r: number; pctRmse: number; model: number; observed: number };
  bart: { r: number; pctRmse: number; total: number };
  tripMiles: { bus: number; metro: number };
  residentShares: Record<string, number>;
  transitTrips: number;
  transfers: { groups?: { muni?: { boardings: number; after: number } } };
  routes: { route: string; obs: number; mod: number }[];
};
const scaledRmse = (rs: { obs: number; mod: number }[]) => {
  const k = rs.reduce((a, r) => a + r.obs, 0) / rs.reduce((a, r) => a + r.mod, 0);
  const mo = rs.reduce((a, r) => a + r.obs, 0) / rs.length;
  return (100 * Math.sqrt(rs.reduce((a, r) => a + (k * r.mod - r.obs) ** 2, 0) / rs.length)) / mo;
};
const run = (e: Exp) => ({
  muniRoutes: { r: e.muni.r, pctRmse: e.muni.pctRmse, pctRmseScaled: scaledRmse(e.routes), model: Math.round(e.muni.model), observed: e.muni.observed },
  bartCityExits: { r: e.bart.r, pctRmse: e.bart.pctRmse, total: e.bart.total },
  tripMiles: e.tripMiles,
  linkedTransitTrips: Math.round(e.transitTrips),
  residentShares: e.residentShares,
  muniAfterVehicle: e.transfers.groups?.muni ? e.transfers.groups.muni.after / e.transfers.groups.muni.boardings : null,
});
type Table = Record<string, number[]> & { trips: number };
const pickBands = (L: { modeByDistance: Record<string, Table>; tourLengths: Record<string, { model: number[]; intrazonal: number }> }) => {
  const M = L.modeByDistance;
  const t = (k: string) => (M[k] ? { trips: M[k].trips, dist: M[k].dist, walk: M[k].walk, transit: M[k].transit, da: M[k].da, sr: M[k].sr, tnc: M[k].tnc, bike: M[k].bike } : null);
  return {
    homeBasedDirect: t('homeBased'),
    homeBasedAll: t('homeBasedAll'),
    notHomeBasedAll: t('notHomeBasedAll'),
    allLegs: t('allLegs'),
    tours: Object.fromEntries(Object.entries(L.tourLengths).map(([k, v]) => [k, { dist: v.model, intrazonal: v.intrazonal }])),
  };
};
const before = read(bx), after = read(ax), lenB = read(bl), lenA = read(al);
const nhts = read(`${REFERENCE}/nhts-transit-length.json`);
const tours = read(`${REFERENCE}/nhts-tours.json`);
const T = lengthTargets();
const b = decodeBundle(zlib.gunzipSync(fs.readFileSync(process.env.BETA3_SF_BUNDLE ?? 'client/beta3/model/sf.bin.gz')));
const C = b.header.calibration!;
// the calibration's last fitted lengths, from its log
const lastLengths = clog && fs.existsSync(clog) ? (fs.readFileSync(clog, 'utf8').split('\n').filter((l) => l.startsWith('lengths: ')).pop() ?? null) : null;
// the exploration that fitted the means of all trips (up to 12 miles): its last fit line, mean km model/target
const exploration = (() => {
  if (!xlog || !fs.existsSync(xlog)) return null;
  const fits = fs.readFileSync(xlog, 'utf8').split('\n').filter((l) => /^\s+univ /.test(l));
  const last = fits[fits.length - 1] ?? '';
  const meanKm: Record<string, [number, number]> = {};
  for (const m of last.matchAll(/([\w:]+) ([\d.]+)\/([\d.]+) km/g)) meanKm[m[1]] = [Number(m[2]), Number(m[3])];
  const coef = (k: string) => {
    const l = fs.readFileSync(xlog, 'utf8').split('\n').find((x) => x.startsWith(`${k} `));
    return l ? JSON.parse(l.slice(k.length + 1)) : null;
  };
  return { passes: fits.length, meanKm, distCoef: coef('distCoef') };
})();
const nb = (k: string) => ({ dist: nhts[k].byBand.dist, walk: nhts[k].byBand.walk, transit: nhts[k].byBand.transit, car: nhts[k].byBand.car, tnc: nhts[k].byBand.tnc, bike: nhts[k].byBand.bike, sample: nhts[k].byBand.sample });
const ne = (k: string) => ({ dist: nhts.anyEnd[k].dist, walk: nhts.anyEnd[k].walk, transit: nhts.anyEnd[k].transit, car: nhts.anyEnd[k].car, tnc: nhts.anyEnd[k].tnc, bike: nhts.anyEnd[k].bike, sample: nhts.anyEnd[k].sample });
const out = {
  description: "The near-destination fixes (log-distance terms in destination choice and stop placement, fitted with the mean to each purpose's share of trips of half a mile or less; walking's time weight fitted to the walk share of trips of 1 to 2 miles): before and after, each on its own weekday calibration. Bands are road miles. Collected by server/beta3/pipeline/dest-short-results.ts from experiment.ts and diag-length.ts runs.",
  generated: new Date().toISOString().slice(0, 10),
  bandsMi: lenA.bandsMi,
  targets: { meanKm: T.meanKm, near: T.near, stopKm: T.stopKm, stopNear: T.stopNear, sample: T.sample },
  nhts: {
    homeBasedBothEndsDense: nb('homeBased'),
    homeBased: ne('homeBased'),
    notHomeBased: ne('notHomeBased'),
    all: ne('all'),
    tours: Object.fromEntries(['work', 'school', 'univ', 'shop', 'other', 'social'].map((p) => [p, { dist: tours.byTourPurpose[p].primaryBandsDense, sample: tours.byTourPurpose[p].primarySampleDense }])),
    stops: Object.fromEntries(['car', 'transit', 'walk', 'bike'].map((c) => [c, { dist: tours.byTourMode[c].detourBandsDense, sample: tours.byTourMode[c].detourSampleDense }])),
  },
  before: { ...run(before), ...pickBands(lenB) },
  after: { ...run(after), ...pickBands(lenA) },
  fitted: {
    distCoef: C.distCoef,
    distLogCoef: C.distLogCoef ?? null,
    stopDistCoefs: C.stopDistCoefs ?? null,
    stopLogCoefs: C.stopLogCoefs ?? null,
    walkTimeFactor: C.walkTimeFactor ?? null,
    walkFit: C.walkFit ?? null,
    lastLengths,
  },
  exploration,
  // residents' walk share by iteration in the first calibration (full steps on the non-work constants)
  firstRun: flog && fs.existsSync(flog)
    ? { walk: fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('iter ')).map((l) => Number(/ walk ([\d.]+)/.exec(l)?.[1] ?? NaN) / 100) }
    : null,
};
fs.writeFileSync(`${REFERENCE}/dest-short-results.json`, JSON.stringify(out, null, 1));
console.log(`wrote ${REFERENCE}/dest-short-results.json`);
