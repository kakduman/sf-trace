/**
 * Shared micromobility in a model run, against the counts: trips by vehicle, time of day, Bay Wheels
 * trips by neighborhood pair (the trip data, bikeshare.ts), rides to and from stations against Bay
 * Wheels' arrivals at stations and BART's 2024 Station Profile Study. experiment.ts prints it; run
 * directly, it writes the article's figures from an experiment's JSON:
 *
 * Run: npx tsx server/beta3/pipeline/micromob-validate.ts work-local/mm/after.json [work-local/mm/beforecal.json]
 *      (writes client/beta3/model/micromobility.json; BETA3_SF_BUNDLE: the bundle the run used)
 */
import fs from 'node:fs';
import { MICRO, MICRO_TYPES, microData, microSettingsOf } from '../../../shared/beta3/micromobility';
import type { TransitNet } from '../../../shared/beta3/net';
import type { DemandResult } from '../../../shared/beta3/demand';
import type { Bundle, Scenario, TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { PERIOD_BOUNDS } from '../../../shared/beta3/periods';
import { BUNDLE, REFERENCE } from './paths';
import { ACCESS_STATIONS, BAY_WHEELS, DOWNTOWN_STATIONS, MICRO_TARGETS, hills as hillFit, microAccess } from './micromob-diag';
import { loadBundle } from './run-base';

function stats(pairs: { obs: number; mod: number }[]) {
  const n = pairs.length, mo = pairs.reduce((a, p) => a + p.obs, 0) / n, mm = pairs.reduce((a, p) => a + p.mod, 0) / n;
  let cov = 0, vo = 0, vm = 0, se = 0;
  for (const p of pairs) {
    cov += (p.obs - mo) * (p.mod - mm);
    vo += (p.obs - mo) ** 2;
    vm += (p.mod - mm) ** 2;
    se += (p.mod - p.obs) ** 2;
  }
  return { n, r: cov / Math.sqrt(vo * vm), pctRmse: (100 * Math.sqrt(se / n)) / mo, total: mm / mo };
}

/** the observed Bay Wheels hours folded into the model's periods */
const obsPeriods = () => {
  const h = BAY_WHEELS.weekday.byHour as number[];
  const inP = (hr: number, [a, b]: [number, number]) => (a < b ? hr >= a && hr < b : hr >= a || hr < b);
  const out: Record<string, number> = { AM: 0, MD: 0, PM: 0, NT: 0 };
  h.forEach((v, hr) => {
    const p = inP(hr, PERIOD_BOUNDS.AM) ? 'AM' : inP(hr, PERIOD_BOUNDS.MD) ? 'MD' : inP(hr, PERIOD_BOUNDS.PM) ? 'PM' : 'NT';
    out[p] += v;
  });
  const t = Object.values(out).reduce((a, v) => a + v, 0);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / t]));
};

export function microReport(b: Bundle, scenario: Scenario, r: { demand: DemandResult; nets: Record<TPeriod, TransitNet> }, vols: Record<TPeriod, Float64Array>) {
  const m = r.demand.micro;
  const x = microData(b, microSettingsOf(scenario));
  if (!m || !x) return null;
  const acc = microAccess(b, scenario, r.nets, vols);
  const T = MICRO_TARGETS;
  const station = MICRO_TYPES.map((_, k) => acc.access[k] + acc.egress[k]);
  const total = MICRO_TYPES.map((_, k) => m.trips[k] + station[k]);
  const bw = total[0] + total[1];
  // time of day: Bay Wheels trips by period (mode choice's and the station rides)
  const P = TPERIODS;
  const accBy = (p: TPeriod) => {
    // station rides in each period come from the assignment's own periods
    const net = r.nets[p], v = vols[p];
    let s = 0;
    if (net?.mmLink && v) for (let j = 0; j < net.mmLink.length; j++) s += v[net.mmLink[j]] * net.mmShare![j];
    return s;
  };
  const modBy = P.map((p, q) => m.byPeriod[0][q] + m.byPeriod[1][q] + m.byPeriod[2][q] + accBy(p));
  const modT = modBy.reduce((a, v) => a + v, 0);
  const tod = { model: Object.fromEntries(P.map((p, q) => [p, modBy[q] / modT])), observed: obsPeriods() };
  // Bay Wheels trips by neighborhood pair: mode choice's (station rides go between a zone and a
  // station, mostly downtown, and are left out of both sides: observed trips near stations are kept, so
  // the comparison is of everything else)
  const NH = x.nhoods.length;
  const obs = new Float64Array(NH * NH);
  const names = BAY_WHEELS.byNeighborhood.neighborhoods as string[];
  const idx = names.map((n) => x.nhoods.indexOf(n));
  for (const [i, j, v] of BAY_WHEELS.byNeighborhood.od as [number, number, number][]) if (idx[i] >= 0 && idx[j] >= 0) obs[idx[i] * NH + idx[j]] += v;
  const sObs = obs.reduce((a, v) => a + v, 0), sMod = m.od.reduce((a, v) => a + v, 0);
  // compared as shares, so the level (fitted) does not enter
  const pairs = [...obs].map((o, k) => ({ obs: o / sObs, mod: m.od[k] / sMod })).filter((p) => p.obs > 0 || p.mod > 0);
  const odFit = stats(pairs);
  const big = pairs.filter((p) => p.obs * sObs >= 20);
  const odFitBig = stats(big);
  // by neighborhood: trips starting or ending there (share of the city's), model / observed
  const ends = (M: Float64Array, s: number) => x.nhoods.map((_, i) => { let v = 0; for (let j = 0; j < NH; j++) v += M[i * NH + j] + M[j * NH + i]; return v / (2 * s); });
  const eO = ends(obs, sObs), eM = ends(m.od, sMod);
  // each neighborhood's hills: the mean climb on Bay Wheels-length rides (1–4 km) leaving its zones
  const NZ = b.header.zones.length;
  const climb = new Float64Array(NH), cn = new Float64Array(NH);
  for (let o = 0; o < NZ; o++)
    for (let d = 0; d < NZ; d++) {
      const mtr = x.bikeM[o * NZ + d];
      if (mtr < 1000 || mtr > 4000) continue;
      climb[x.nh[o]] += x.bikeUp[o * NZ + d] / 10;
      cn[x.nh[o]]++;
    }
  const byNhood = x.nhoods.map((n, i) => ({ name: n, obs: eO[i], mod: eM[i], ratio: eO[i] > 0 ? eM[i] / eO[i] : null, climbM: cn[i] ? climb[i] / cn[i] : null })).sort((a, c) => c.obs - a.obs);
  const nhFit = stats(byNhood.map((n) => ({ obs: n.obs, mod: n.mod })));
  // does the model's error follow the hills? correlation of log(model/observed) with the climb, over
  // neighborhoods with 50+ observed trip ends a weekday
  const rows = byNhood.filter((n) => n.obs * sObs >= 50 && n.mod > 0 && n.climbM !== null);
  const hills = stats(rows.map((n) => ({ obs: n.climbM!, mod: Math.log(n.ratio!) })));
  // the slopes of the model's log error on the climb, own and shared bikes (micromob-diag.ts hills)
  const hillSlopes = hillFit(b, m, r.demand.zoneWork);
  const group = (re: RegExp) => {
    const g = byNhood.filter((n) => re.test(n.name));
    const o = g.reduce((a, n) => a + n.obs, 0), mo = g.reduce((a, n) => a + n.mod, 0);
    return { neighborhoods: g.map((n) => n.name), obs: o, mod: mo, ratio: mo / o };
  };
  const areas = {
    downtown: group(/^(Financial District\/South Beach|South of Market|Tenderloin|Chinatown)$/),
    waterfront: group(/^(Marina|North Beach|Russian Hill|Financial District\/South Beach|Mission Bay)$/),
    hills: group(/^(Twin Peaks|Noe Valley|Glen Park|Diamond Heights|Bernal Heights|Potrero Hill|Haight Ashbury|Pacific Heights|Nob Hill|Russian Hill|Inner Sunset|West of Twin Peaks)$/),
    flatEast: group(/^(Mission|South of Market|Mission Bay|Hayes Valley|Financial District\/South Beach|Western Addition)$/),
  };
  // rides to BART against the 2024 Station Profile Study (home-origin entries; bike includes own bikes,
  // electric scooter includes owned ones), at the city's stations
  const prof = JSON.parse(fs.readFileSync(`${REFERENCE}/bart-station-access-2024.json`, 'utf8')).stations as { station: string; homeOriginEntries: number; bike: number; scooter: number }[];
  const key = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const bart = acc.byPlace
    .filter((p) => p.kinds.includes('bart') && p.bart.fromZones > 0)
    .map((p) => {
      const pr = prof.find((s) => key(s.station) === key(p.name));
      const sh = (k: number) => p.bart.access[k] / p.bart.fromZones;
      return { name: p.name, model: { bayWheels: sh(0) + sh(1), scooter: sh(2), riders: p.bart.fromZones }, profile: pr ? { bike: pr.bike, scooter: pr.scooter, homeOriginEntries: pr.homeOriginEntries } : null };
    });
  const obsNear = (BAY_WHEELS.nearStations.stations as { name: string; startsAM: number; endsAM: number; starts: number; ends: number }[]);
  const stations = acc.byPlace.map((p) => {
    const o = obsNear.find((s) => s.name === p.name);
    return { name: p.name, kinds: p.kinds, model: { accessAM: p.accessAM, egressAM: p.egressAM, access: p.access, egress: p.egress }, bayWheelsDocked: o ? { endsAM: o.endsAM, startsAM: o.startsAM, ends: o.ends, starts: o.starts } : null };
  });
  // mean trip length of Bay Wheels trips (mode choice's), against rides between two stations
  const obsKm = BAY_WHEELS.weekday.meanRouteKmBetweenStations as Record<string, number>;
  const tripKm = { model: { classic: m.km[0] / m.trips[0], ebike: m.km[1] / m.trips[1], scooter: m.km[2] / m.trips[2] }, observed: { classic: obsKm.classic_bike, ebike: obsKm.electric_bike } };
  const k = (v: number) => `${(v / 1000).toFixed(1)}k`;
  const pcs = (v: number) => `${(100 * v).toFixed(1)}%`;
  const lines = [
    `shared: Bay Wheels ${k(bw)} / ${k(T.bayWheels)} (mode choice ${k(m.trips[0] + m.trips[1])}, station rides ${k(station[0] + station[1])}; e-bike ${pcs(total[1] / bw)} / ${pcs(T.ebikeShare)}), scooters ${k(total[2])} / ${k(T.scooter)} (station rides ${k(station[2])}); residents' shared trips ${k(m.resident.reduce((a, v) => a + v, 0))}`,
    `mean km (model / rides between stations): classic ${tripKm.model.classic.toFixed(2)}/${tripKm.observed.classic.toFixed(2)}, e-bike ${tripKm.model.ebike.toFixed(2)}/${tripKm.observed.ebike.toFixed(2)}, scooter ${tripKm.model.scooter.toFixed(2)}`,
    `shared by period (model / Bay Wheels): ${P.map((p) => `${p} ${pcs(tod.model[p])}/${pcs(tod.observed[p])}`).join(' ')}`,
    `Bay Wheels by neighborhood pair: r ${odFit.r.toFixed(3)} (pairs with 20+ trips: r ${odFitBig.r.toFixed(3)}, n ${odFitBig.n}); by neighborhood r ${nhFit.r.toFixed(3)}; error vs climb r ${hills.r.toFixed(2)}; log error per 10 m climbed: own bike ${(10 * hillSlopes.own.slope).toFixed(3)} (r ${hillSlopes.own.r.toFixed(2)}), classic ${(10 * hillSlopes.classic.slope).toFixed(3)} (r ${hillSlopes.classic.r.toFixed(2)}), e-bike ${(10 * hillSlopes.ebike.slope).toFixed(3)} (r ${hillSlopes.ebike.r.toFixed(2)}) | downtown ×${areas.downtown.ratio.toFixed(2)}, waterfront ×${areas.waterfront.ratio.toFixed(2)}, hills ×${areas.hills.ratio.toFixed(2)}, flat east ×${areas.flatEast.ratio.toFixed(2)}`,
    `rides to stations AM (Bay Wheels to the 4 BART stations outside downtown) ${Math.round(acc.bayWheelsAccessAM)} / ${Math.round(T.accessAM)}, from the 4 downtown ${Math.round(acc.bayWheelsEgressAM)} / ${Math.round(T.egressAM)}; at BART (model Bay Wheels+scooter / profile bike+scooter): ${bart.map((s) => `${s.name.split(' ')[0]} ${pcs(s.model.bayWheels + s.model.scooter)}/${s.profile ? pcs(s.profile.bike + s.profile.scooter) : '–'}`).join(' ')}`,
  ];
  return {
    lines,
    targets: T,
    trips: { mode: m.trips, station, total, residents: m.resident, byPurpose: m.byPurpose },
    tod,
    tripKm,
    od: { ...odFit, big: odFitBig, byNeighborhood: nhFit, hills, hillSlopes, areas, neighborhoods: byNhood },
    access: { bayWheelsAM: acc.bayWheelsAccessAM, bayWheelsEgressAM: acc.bayWheelsEgressAM, downtownStations: DOWNTOWN_STATIONS, accessStations: ACCESS_STATIONS, totalAccess: acc.access, totalEgress: acc.egress, bart, stations },
    params: { speed: MICRO.speed, price: MICRO.price, riders: MICRO.riders, fleet: MICRO.fleet, nest: MICRO.nest, reachMin: MICRO.reachMin },
  };
}
export type MicroReport = NonNullable<ReturnType<typeof microReport>>;

function main() {
  const f = process.argv[2];
  if (!f) throw new Error('usage: micromob-validate.ts <experiment json>');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!j.micro) throw new Error(`${f} has no shared micromobility (run experiment.ts on a bundle with it)`);
  const { lines: _l, ...rest } = j.micro as MicroReport;
  void _l;
  // the calibrated constants, from the bundle the run used
  const b = loadBundle();
  // the same harness without shared vehicles, recalibrated alike (optional second file)
  const bf = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
  const sum = (x: typeof j) => ({ muni: { r: x.muni.r, pctRmse: x.muni.pctRmse, total: x.muni.total, model: x.muni.model, observed: x.muni.observed }, bart: { r: x.bart.r, total: x.bart.total, pctRmse: x.bart.pctRmse }, caltrain: { obs: x.caltrain.obs, mod: x.caltrain.mod }, residentShares: x.residentShares });
  const out = { label: j.label, compare: { without: bf ? sum(bf) : null, with: sum(j) }, calibration: b.header.calibration?.micro ?? null, muni: { r: j.muni.r, pctRmse: j.muni.pctRmse, total: j.muni.total }, bart: { r: j.bart.r, total: j.bart.total }, residentShares: j.residentShares, ...rest };
  fs.writeFileSync(`${BUNDLE}/micromobility.json`, JSON.stringify(out, null, 1));
  console.log(`wrote ${BUNDLE}/micromobility.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
