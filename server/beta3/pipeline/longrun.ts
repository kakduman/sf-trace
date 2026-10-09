/**
 * Long-run test of car ownership: a scenario run as the app runs it (one pass from the base run's
 * crowding), short run (car ownership as the ACS has it) and long run (households choose their cars
 * again at the scenario's accessibility, DemandContext.carOwnership), against the base. Reports the
 * change in cars and in households without a car, near the scenario's new stations and citywide, the
 * arc elasticity of cars with respect to the transit accessibility term and to jobs reachable by
 * transit in 45 minutes, and what the long run adds to transit trips and driving.
 *
 * Scenarios: geary (the app's "A Geary subway": light rail in a tunnel from the Transit Center to
 * Ocean Beach at the 38R's stops, every 4 minutes at peak, 32 km/h with stops), nochange.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/longrun.ts [geary|nochange] [--json out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { AO_ALTS, AO_F, AO_STRIDE, aoAccess, aoDensity, aoProbabilities, type AoAccess } from '../../../shared/beta3/autoown';
import type { TrnSkim, TrnSkims } from '../../../shared/beta3/demand';
import type { Bundle, Calibration, Edit, Scenario, TPeriod } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

/** the app's Geary subway (client/beta3/scenario.ts, examples): straight legs × 1.15, 32 km/h */
function gearySubway(b: Bundle): Edit {
  const H = b.header;
  const want = ['Transit Center', 'Market St & Montgomery', 'Geary St & Powell', 'Van Ness', 'Fillmore', 'Divisadero', 'Arguello', 'Park Presidio', '25th Ave', '33rd Ave', '48th Ave'];
  // the 38R's main pattern: its most frequent
  const pats = H.lines.map((l, i) => [l, i] as const).filter(([l]) => l.feed === 'muni' && l.route === '38R');
  const trips = (l: (typeof H.lines)[number]) => Object.values(l.periods).reduce((a, p) => a + (p?.trips ?? 0), 0);
  const pat = pats.sort((x, y) => trips(y[0]) - trips(x[0]) || y[0].stops.length - x[0].stops.length)[0][0];
  const stops: number[] = [];
  for (const w of want) {
    const i = pat.stops.find((s) => H.stops[s].name.includes(w));
    if (i !== undefined && !stops.includes(i)) stops.push(i);
  }
  const M_LAT = 110_950, M_LON = 111_320 * Math.cos((37.78 * Math.PI) / 180);
  const path: number[] = [], stopAt: number[] = [], hops: number[] = [];
  stops.forEach((s, k) => {
    const st = H.stops[s];
    path.push(+st.lat.toFixed(5), +st.lon.toFixed(5));
    stopAt.push(k);
    if (k > 0) {
      const a = H.stops[stops[k - 1]];
      const m = Math.hypot((st.lat - a.lat) * M_LAT, (st.lon - a.lon) * M_LON) * 1.15;
      hops.push(Math.max(30, Math.round(m / (32 / 3.6))));
    }
  });
  console.log(`Geary subway: ${stops.length} stations (${stops.map((s) => H.stops[s].name).join('; ')}), ${(hops.reduce((a, h) => a + h, 0) / 60).toFixed(1)} min end to end`);
  return { kind: 'newLine', id: 'subway-geary', name: 'Geary subway', mode: 'lightrail', color: '#c2410c', stops: stops.map((stop) => ({ stop })), path, stopAt, headway: { AM: 4, MD: 6, PM: 4, NT: 10 }, hops, bothDirections: true };
}

class SkimKeeper extends LocalExecutor {
  first = {} as TrnSkims;
  async skim(p: TPeriod, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<TrnSkim> {
    const s = await super.skim(p, crowd, lot);
    this.first[p] ??= s;
    return s;
  }
}

async function main() {
  const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'geary';
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration as Calibration;
  if (!calib.autoOwn || !b.a.aoClass) throw new Error('run calibrate-autoown.ts first');
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const edits: Edit[] = which === 'geary' ? [gearySubway(b)] : [];
  const prep = prepare(b);
  const run = async (longRun: boolean, ed = edits) => {
    const sc: Scenario = { name: which, edits: ed, context: longRun ? { carOwnership: true } : undefined };
    const ex = new SkimKeeper(b, sc, calib);
    const t0 = Date.now();
    const r = await runModel(b, sc, calib, ex, { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice }, prep);
    return { r, sk: ex.first, sec: (Date.now() - t0) / 1000 };
  };
  // the reference: today's network, run the same way (the saved base's totals can come from older code)
  const ref = await run(false, []);
  const short = await run(false);
  const long = await run(true);
  console.log(`runs: short ${short.sec.toFixed(0)} s, long ${long.sec.toFixed(0)} s`);

  // car ownership by zone: the observed households moved by the model's ratio (as demand does)
  const classes = b.a.aoClass as Float32Array;
  const NZ = H.zones.length;
  const density = aoDensity(b);
  const ao = calib.autoOwn;
  const nh = (z: number) => ao.nhood[H.zones[z].nhood];
  const baseAcc: AoAccess = { auto: Float32Array.from(ao.base.auto), transit: Float32Array.from(ao.base.transit), walk: Float32Array.from(ao.base.walk), savings: Float32Array.from(ao.base.savings) };
  const scenAcc = aoAccess(b, long.sk);
  const zoneCars = (acc: AoAccess) => {
    const p = aoProbabilities(classes, acc, density, ao.asc, nh);
    const cars = new Float64Array(NZ), none = new Float64Array(NZ), hh = new Float64Array(NZ);
    for (let i = 0; i < classes.length / AO_STRIDE; i++) {
      const z = classes[i * AO_STRIDE], w = classes[i * AO_STRIDE + AO_F.hh];
      hh[z] += w;
      none[z] += w * p[i * AO_ALTS];
      for (let a = 1; a < AO_ALTS; a++) cars[z] += w * a * p[i * AO_ALTS + a];
    }
    return { cars, none, hh };
  };
  const m0 = zoneCars(baseAcc), m1 = zoneCars(scenAcc);
  // observed cars per zone: B25044's households by 0/1/2+ cars, the 2+ at the city's mean cars among
  // them (B25044's 2, 3, and 4+, 4+ counted as 4)
  const sh = ao.fit!.city.map((x) => x[1]);
  const perTwo = (2 * sh[2] + 3 * sh[3] + 4 * sh[4]) / (sh[2] + sh[3] + sh[4]);
  const obsCars = H.zones.map((z) => z.hhVeh[1] + perTwo * z.hhVeh[2]);
  // zones near the new stations (within 800 m)
  const edit = edits[0] as Extract<Edit, { kind: 'newLine' }> | undefined;
  const st = edit ? edit.stops.map((s) => ('stop' in s ? H.stops[s.stop] : null)).filter((s) => s) : [];
  const near = H.zones.map((z) => st.some((s) => Math.hypot(s!.x - z.x, s!.y - z.y) <= 800));
  const agg = (sel: (i: number) => boolean) => {
    let c0 = 0, c1 = 0, n0 = 0, n1 = 0, hh = 0, a0 = 0, a1 = 0, j0 = 0, j1 = 0;
    for (let i = 0; i < NZ; i++) {
      if (!sel(i) || !(m0.hh[i] > 0)) continue;
      const w = H.zones[i].hh;
      // the observed zone's cars, moved by the model's ratio
      c0 += obsCars[i];
      c1 += obsCars[i] * (m1.cars[i] / Math.max(1e-9, m0.cars[i]));
      n0 += H.zones[i].hhVeh[0];
      n1 += H.zones[i].hhVeh[0] * (m1.none[i] / Math.max(1e-9, m0.none[i]));
      hh += w;
      a0 += w * baseAcc.transit[i];
      a1 += w * scenAcc.transit[i];
      j0 += w * base.zoneJobs45[i];
      j1 += w * short.r.zoneJobs45[i];
    }
    return { hh, cars0: c0, cars1: c1, carsPct: 100 * (c1 / c0 - 1), noCarPct: 100 * (n1 / n0 - 1), accessGain: (a1 - a0) / hh, jobs45Pct: 100 * (j1 / j0 - 1), elastAccess: Math.log(c1 / c0) / ((a1 - a0) / hh), elastJobs45: Math.log(c1 / c0) / Math.log(j1 / j0) };
  };
  const city = agg(() => true), corridor = agg((i) => near[i]);
  const f = (x: number, d = 2) => x.toFixed(d);
  for (const [k, v] of [['within 800 m of a new station', corridor], ['citywide', city]] as const)
    console.log(`${k}: ${Math.round(v.hh).toLocaleString()} households; transit accessibility +${f(v.accessGain, 3)} (ln of retail jobs reached), jobs within 45 min by transit ${f(v.jobs45Pct, 1)}%; cars ${Math.round(v.cars0).toLocaleString()} → ${Math.round(v.cars1).toLocaleString()} (${f(v.carsPct)}%), households without a car ${f(v.noCarPct)}%; elasticity of cars to the accessibility term ${f(v.elastAccess, 3)}, to jobs reachable in 45 min ${f(v.elastJobs45, 3)}`);
  const sum = (r: typeof short.r) => ({ transit: r.summary.transitTrips, vkt: r.summary.vkt, geary: r.lines.filter((l) => l.line < 0).reduce((a, l) => a + Object.values(l.boardings).reduce((x, y) => x + y, 0), 0) });
  const s0 = { transit: ref.r.summary.transitTrips, vkt: ref.r.summary.vkt }, s1 = sum(short.r), s2 = sum(long.r);
  const seg = long.r.demand.carOwn.hhBySeg, seg0 = short.r.demand.carOwn.hhBySeg;
  console.log(`households by cars 0/1/2+: short run ${seg0.map((v) => Math.round(v)).join('/')}, long run ${seg.map((v) => Math.round(v)).join('/')} (${seg.map((v, k) => `${f(100 * (v / seg0[k] - 1))}%`).join('/')}); model cars ${f(100 * (long.r.demand.carOwn.cars / long.r.demand.carOwn.carsBase - 1))}%`);
  console.log(`linked transit trips: base ${Math.round(s0.transit).toLocaleString()}, short run ${Math.round(s1.transit).toLocaleString()} (+${Math.round(s1.transit - s0.transit).toLocaleString()}), long run ${Math.round(s2.transit).toLocaleString()} (+${Math.round(s2.transit - s0.transit).toLocaleString()}); new line boardings ${Math.round(s1.geary).toLocaleString()} → ${Math.round(s2.geary).toLocaleString()}; VKT ${f(100 * (s1.vkt / s0.vkt - 1))}% short, ${f(100 * (s2.vkt / s0.vkt - 1))}% long`);
  const jf = arg('--json', '');
  if (jf) fs.writeFileSync(jf, JSON.stringify({ scenario: which, runSec: { short: short.sec, long: long.sec }, corridor, city, hhBySeg: { short: seg0, long: seg }, transit: { base: s0.transit, short: s1.transit, long: s2.transit }, newLine: { short: s1.geary, long: s2.geary }, vkt: { base: s0.vkt, short: s1.vkt, long: s2.vkt } }, null, 1));
}

main();
