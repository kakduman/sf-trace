/**
 * The bridge test: demand with its car-ownership and income segments from the raked ACS margins
 * (as calibrated), from the synthetic population's households, and from its persons. One demand pass
 * each on the same skims, compared citywide, by segment, and zone by zone. If the population is
 * consistent with the zone data the first two agree closely; the third shows what splitting each kind
 * of resident by the households they live in changes.
 *
 * Run: BETA3_SF_BUNDLE=<bundle with the population> npx tsx server/beta3/pipeline/synpop-bridge.ts [--json out.json]
 */
import fs from 'node:fs';
import { SYNPOP, computeDemand, prepare, type DemandResult, type SynpopMode } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { MODES, SEGMENTS, INCOME_CLASS_NAMES } from '../../../shared/beta3/params';
import { loadBundle } from './run-base';

const share = (r: Record<string, number> | undefined, m = 'transit') => {
  if (!r) return NaN;
  const t = Object.values(r).reduce((a, v) => a + v, 0);
  return t > 0 ? r[m] / t : 0;
};
function fit(a: ArrayLike<number>, b: ArrayLike<number>, w?: ArrayLike<number>) {
  // weighted r and RMSE of a against b
  let W = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = w ? w[i] : 1;
    W += x;
    ma += x * a[i];
    mb += x * b[i];
  }
  ma /= W;
  mb /= W;
  let c = 0, va = 0, vb = 0, se = 0;
  for (let i = 0; i < a.length; i++) {
    const x = w ? w[i] : 1;
    c += x * (a[i] - ma) * (b[i] - mb);
    va += x * (a[i] - ma) ** 2;
    vb += x * (b[i] - mb) ** 2;
    se += x * (a[i] - b[i]) ** 2;
  }
  return { r: c / Math.sqrt(va * vb), rmse: Math.sqrt(se / W), pctRmse: (100 * Math.sqrt(se / W)) / mb };
}

async function main() {
  const b = loadBundle();
  if (!b.a.popZoneStart) throw new Error('the bundle has no synthetic population (synpop-bundle.ts)');
  const calib = b.header.calibration!;
  const ex = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const lot = new Float32Array(b.header.stops.length);
  for (const [st, v] of Object.entries(calib.lotPrice ?? {})) lot[Number(st)] = v;
  const sk: Record<string, unknown> = {};
  console.time('skims');
  for (const p of SKIM_PERIODS) sk[p] = await ex.skim(p, undefined, lot.some((v) => v > 0) ? lot : undefined);
  console.timeEnd('skims');
  const NZ = b.header.zones.length;
  const runs: Partial<Record<SynpopMode, { d: DemandResult; prep: ReturnType<typeof prepare>; sec: number }>> = {};
  for (const mode of ['off', 'households', 'persons'] as SynpopMode[]) {
    SYNPOP.mode = mode;
    const t0 = Date.now();
    const prep = prepare(b);
    const d = computeDemand(b, prep, sk as never, calib, 'wkd', 1, undefined, { events: 1 });
    runs[mode] = { d, prep, sec: (Date.now() - t0) / 1000 };
    console.log(`${mode}: ${runs[mode]!.sec.toFixed(1)} s, segments from ${prep.segSource}`);
  }
  const base = runs.off!;
  const tot = (r: Record<string, number> | undefined) => (r ? Object.values(r).reduce((a, v) => a + v, 0) : NaN);
  const out: Record<string, unknown> = {};
  // inputs: the city's households and commuters by segment
  const city = (t: Float32Array[][], w?: (i: number) => number) => {
    const v = SEGMENTS.map((_, s) => t[s].reduce((a, arr) => a + arr.reduce((x, y, i) => x + y * (w ? w(i) : 1), 0), 0));
    const T = v.reduce((a, x) => a + x, 0);
    return Object.fromEntries(SEGMENTS.map((s, k) => [s, +(100 * v[k] / T).toFixed(2)]));
  };
  const hh = (i: number) => b.header.zones[i].hh;
  const wk = (i: number) => b.header.zones[i].workers;
  out.inputs = Object.fromEntries(Object.entries(runs).map(([m, r]) => [m, {
    households: city(r.prep.segInc, hh),
    commuters: city(r.prep.workShare, wk),
    residents: city(r.prep.people.pop),
    youth: city(r.prep.people.youth),
    seniors: city(r.prep.people.senior),
  }]));
  const segInputFit = fit(Array.from({ length: 3 * NZ }, (_, k) => runs.households!.prep.seg[k % 3][Math.floor(k / 3)]), Array.from({ length: 3 * NZ }, (_, k) => base.prep.seg[k % 3][Math.floor(k / 3)]), Array.from({ length: 3 * NZ }, (_, k) => hh(Math.floor(k / 3))));
  out.zoneCarShareFit = { households: { r: +segInputFit.r.toFixed(4), rmsePts: +(100 * segInputFit.rmse).toFixed(2) } };
  // results
  out.results = Object.fromEntries(Object.entries(runs).map(([m, r]) => {
    const d = r.d;
    return [m, {
      residentTrips: Math.round(tot(d.residentTrips)),
      residentModeShares: Object.fromEntries(MODES.map((x) => [x, +(100 * share(d.residentTrips as never, x)).toFixed(2)])),
      transitTripsAll: Math.round(d.trips.transit),
      commuteTransitBySegment: Object.fromEntries(SEGMENTS.map((s) => [s, +(100 * share(d.workBySeg[s] as never)).toFixed(2)])),
      commuteTripsBySegment: Object.fromEntries(SEGMENTS.map((s) => [s, Math.round(tot(d.workBySeg[s] as never))])),
      nonworkTransitBySegment: Object.fromEntries(SEGMENTS.map((s) => [s, +(100 * share(d.nonworkBySeg[s] as never)).toFixed(2)])),
      transitByIncome: Object.fromEntries(INCOME_CLASS_NAMES.map((n, k) => [n, +(100 * share(d.byIncome[k] as never)).toFixed(2)])),
      youthTransit: +(100 * share(d.youthTrips as never)).toFixed(2),
      vkt: Math.round(d.vkt),
      seconds: +r.sec.toFixed(1),
    }];
  }));
  // zone by zone, against the calibrated (off) run
  const zone = (r: DemandResult) => ({
    transitShare: r.zoneTransitShare,
    workTransit: Float64Array.from(r.zoneWork, (w, i) => (w > 0 ? r.zoneWorkTransit[i] / w : 0)),
  });
  const z0 = zone(base.d);
  const transitFrom = (r: DemandResult) => {
    const v = new Float64Array(NZ), Z = b.header.zones.length + b.header.ext.length;
    for (const p of Object.keys(r.transitOD)) {
      const od = r.transitOD[p as keyof typeof r.transitOD];
      const n = Math.round(Math.sqrt(od.length));
      for (let o = 0; o < NZ; o++) for (let d = 0; d < Math.min(n, Z); d++) v[o] += od[o * n + d];
    }
    return v;
  };
  const tf0 = transitFrom(base.d);
  out.zones = Object.fromEntries((['households', 'persons'] as SynpopMode[]).map((m) => {
    const r = runs[m]!.d, z = zone(r);
    const pop = Float64Array.from(b.header.zones, (q) => q.pop), wk2 = Float64Array.from(b.header.zones, (q) => q.workers);
    const f1 = fit(z.transitShare, z0.transitShare, pop), f2 = fit(z.workTransit, z0.workTransit, wk2), f3 = fit(transitFrom(r), tf0);
    return [m, {
      transitShareByHomeZone: { r: +f1.r.toFixed(4), rmsePts: +(100 * f1.rmse).toFixed(2) },
      commuteTransitShareByHomeZone: { r: +f2.r.toFixed(4), rmsePts: +(100 * f2.rmse).toFixed(2) },
      transitTripsFromZone: { r: +f3.r.toFixed(4), pctRmse: +f3.pctRmse.toFixed(2) },
    }];
  }));
  console.log(JSON.stringify(out, null, 1));
  const jf = process.argv.indexOf('--json');
  if (jf > 0) fs.writeFileSync(process.argv[jf + 1], JSON.stringify(out, null, 1) + '\n');
}

main();
