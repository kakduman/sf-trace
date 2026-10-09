/**
 * Where the commute trips are: the model's commuters at work on a weekday (residents and
 * in-commuters), their trips by mode, transit trips and Muni boardings by market and period, and the
 * Muni riders' purposes against MTC's Snapshot read as surveyed (od-checks.ts riders). The checks
 * against counts and surveys are in commute-checks.json (reference) and the article.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-commutes.ts [out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { prepare } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { MODES } from '../../../shared/beta3/params';
import { TPERIODS } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';
import { modelState, readOdRef, riders } from './od-checks';

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, v) => a + v, 0);

async function main() {
  const t0 = Date.now();
  const b = loadBundle();
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const st = await modelState(b, b.header.calibration!, prepare(b), base.finalCrowd);
  const d = st.demand;
  // residents' commutes (both legs, by the mode of the trip to work) and in-commuters'
  const resWork: Record<string, number> = Object.fromEntries(MODES.map((m) => [m, 0]));
  for (const [s, r] of Object.entries(d.workBySeg)) if (s !== 'ext') for (const m of MODES) resWork[m] += r[m];
  const extWork = d.workBySeg.ext ?? {};
  const out = Object.values(d.workOut).reduce((a, r) => a + sum(r), 0);
  const transitByMarket: Record<string, Record<string, number>> = {};
  for (const [k, byP] of Object.entries(st.markets)) {
    if (k.startsWith('work ')) continue;
    const e: Record<string, number> = {};
    for (const p of TPERIODS) e[p] = byP[p] ? byP[p].reduce((a, v) => a + v, 0) : 0;
    transitByMarket[k] = e;
  }
  const r = await riders(st, readOdRef());
  const res = {
    commuters: {
      residentTrips: sum(resWork),
      residentsAtWork: sum(resWork) / 2,
      residentsAtWorkOutside: out / 2,
      residentTransitShare: resWork.transit / sum(resWork),
      inCommuterTrips: sum(extWork),
      inCommutersAtWork: sum(extWork) / 2,
      inCommuterTransitShare: (extWork.transit ?? 0) / Math.max(1, sum(extWork)),
      shuttleTrips: d.shuttleTrips,
    },
    byPurpose: d.byPurpose,
    residentTrips: d.residentTrips,
    stopTransitByPurpose: d.stopTransitByPurpose,
    stopLegModes: d.stopLegModes,
    transitByMarket,
    riders: r,
  };
  const f = process.argv[2] ?? '/tmp/diag-commutes.json';
  fs.writeFileSync(f, JSON.stringify(res, null, 1));
  const c = res.commuters, k = (x: number) => `${(x / 1000).toFixed(1)}k`;
  console.log(`residents at work ${k(c.residentsAtWork)} (outside the city ${k(c.residentsAtWorkOutside)}), by transit ${(100 * c.residentTransitShare).toFixed(1)}%; in-commuters at work ${k(c.inCommutersAtWork)}, by transit ${(100 * c.inCommuterTransitShare).toFixed(1)}%`);
  const mk = r.boardingsByMarket;
  console.log(`Muni boardings by market: ${Object.entries(mk).sort((a, x) => x[1].lightRail + x[1].bus - a[1].lightRail - a[1].bus).map(([m, v]) => `${m} ${k(v.lightRail + v.bus)}`).join(', ')}`);
  for (const [n, rows] of [['bus', r.purposeMuniBus], ['light rail', r.purposeMuniLightRail]] as const)
    console.log(`${n} purposes (Snapshot / all day by trip / by tour / surveyed periods by trip / by tour): ${rows.map((x) => `${x.purpose} ${(100 * x.observed).toFixed(1)}/${(100 * x.model).toFixed(1)}/${(100 * x.modelByTour).toFixed(1)}/${(100 * x.modelSurveyed).toFixed(1)}/${(100 * x.modelSurveyedByTour).toFixed(1)}`).join('; ')}`);
  console.log(`written ${f} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
main();
