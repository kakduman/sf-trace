import { REF } from '../data';
import { nearTrips } from './neartrips';
import { cite, fx, nw, pc } from '../doc';

/**
 * Short trips: whether residents' transit trips are too long, the trips next to home, and whether the
 * model's hills deter too little walking (reference/short-trip-results.json: the NHTS 2017 bands, and
 * the climb of each counted route against its error).
 */
export function shortTrips(): string {
  const S = REF.shortTrips as unknown as ShortTrips;
  const hb = S.homeBased, h = S.hills;
  const run = hb?.after ?? hb?.before;
  if (!run || !hb.nhts || !h?.thirds?.length) return '';
  // band indices: ≤0.5, ≤1, ≤1.5, ≤2, ≤3, ≤5, ≤8, >8 road miles
  const upTo2 = (d: number[]) => d[0] + d[1] + d[2] + d[3];
  return `<p>Residents' trips from home by transit are not too long: ${pc(upTo2(run.transitDist), 0)} of them are 2 road miles or shorter in the model, against ${pc(upTo2(hb.nhts.transitDist), 0)} in the NHTS 2017 dense tracts ${cite('nhts2017')}. ${nearTrips()} Walking times follow Tobler's function on every street ${cite('tobler')}. If hills deterred too little walking, the routes that climb most would be short of riders; across the ${nw(h.routes.length)} counted routes with 1,500 or more boardings, a route's climb per kilometer is unrelated to its error (r = ${fx(h.correlation, 2)} with the log of model over count), and the steepest third carry ${fx(h.thirds[0].modelOverCount, 2)} times their counts against ${fx(h.thirds[2].modelOverCount, 2)} for the flattest third.</p>`;
}

interface Band { dist: number[]; transitDist: number[] }
interface ShortTrips {
  homeBased: { before?: Band; after?: Band; nhts: Band };
  hills: { routes: unknown[]; correlation: number; thirds: { modelOverCount: number }[] };
}
