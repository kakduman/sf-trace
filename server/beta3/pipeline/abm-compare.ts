/**
 * The person-level choices against the aggregate tour rates: two experiment.ts results (each after
 * a 4-iteration recalibration of its own bundle) side by side, written to
 * server/beta3/reference/abm-fit.json for the article.
 * Demand's time comes from two check-split.ts logs run back to back in one slot (the experiments ran
 * under different loads).
 * Run: npx tsx server/beta3/pipeline/abm-compare.ts aggregate.json abm.json split-off.log split-abm.log
 */
import fs from 'node:fs';
import { REFERENCE } from './paths';

type Exp = {
  label: string;
  seconds: Record<string, number>;
  muni: { r: number; pctRmse: number; within25: number; model: number; observed: number };
  groups: Record<string, [number, number]>;
  bart: { r: number; pctRmse: number; total: number };
  caltrain: { obs: number; mod: number };
  residentShares: Record<string, number>;
  residentTrips?: number;
  regional: { outsideEntries: { r: number; pctRmse: number; total: number } };
  ferry: { r: number; total: number };
  tripMiles: { bus: number; metro: number };
  passes: number;
};

const [a, b] = process.argv.slice(2, 4).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as Exp);
/** computeDemand's seconds and the slowest of the four parts (a browser worker's share) */
const timing = (f: string | undefined) => {
  if (!f) return null;
  const t = fs.readFileSync(f, 'utf8');
  return { whole: Number(/computeDemand: ([\d.]+) s/.exec(t)![1]), part: Math.max(...[...t.matchAll(/part \d of 4: ([\d.]+) s/g)].map((m) => Number(m[1]))) };
};
const pick = (e: Exp) => ({
  muni: { r: e.muni.r, pctRmse: e.muni.pctRmse, within25: e.muni.within25, total: e.muni.model / e.muni.observed },
  subway: e.groups.subway[1] / e.groups.subway[0],
  T: e.groups.T[1] / e.groups.T[0],
  buses: e.groups.bus[1] / e.groups.bus[0],
  bartCityExits: { r: e.bart.r, pctRmse: e.bart.pctRmse, total: e.bart.total },
  bartOutsideEntries: { r: e.regional.outsideEntries.r, pctRmse: e.regional.outsideEntries.pctRmse, total: e.regional.outsideEntries.total },
  caltrain: e.caltrain.mod / e.caltrain.obs,
  ferry: { r: e.ferry.r, total: e.ferry.total },
  milesPerBoarding: e.tripMiles,
  residentTrips: e.residentTrips ?? null,
  residentTransitShare: e.residentShares.transit,
});
const out = {
  description: 'Fit of the model with the person-level choices (abm) against the aggregate tour rates (aggregate), each recalibrated for 4 iterations (calibrate.ts; the person-level constants by abm-calibrate.ts), from experiment.ts runs (2 passes from the saved base run\'s crowding).',
  aggregate: { ...pick(a), demandSeconds: timing(process.argv[4]) },
  abm: { ...pick(b), demandSeconds: timing(process.argv[5]) },
};
fs.writeFileSync(`${REFERENCE}/abm-fit.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
