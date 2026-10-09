import { REF } from '../data';
import { cite, pc } from '../doc';

/**
 * Trips next to home: the distance bands that were not fitted, and how residents' trips of 1 to 2
 * miles split among the modes, against the NHTS 2017 (reference/dest-short-results.json, the run with
 * the near terms and walking's time factor; dest-short-results.ts).
 */
export function nearTrips(): string {
  const R = REF.destShort as unknown as Results;
  if (!R.after || !R.nhts) return '';
  const A = R.after, N = R.nhts;
  // band indices: ≤0.5, ≤1, ≤1.5, ≤2, ≤3, ≤5, ≤8, >8 road miles
  const one2 = (d: number[]) => d[2] + d[3];
  const share12 = (r: Modes, k: 'walk' | 'transit') => (r[k][2] * r.dist[2] + r[k][3] * r.dist[3]) / (r.dist[2] + r.dist[3]);
  const carAt = (r: Modes, i: number) => (r.car ? r.car[i] : (r.da?.[i] ?? 0) + (r.sr?.[i] ?? 0));
  const car12 = (r: Modes) => (carAt(r, 2) * r.dist[2] + carAt(r, 3) * r.dist[3]) / (r.dist[2] + r.dist[3]);
  const hbN = N.homeBasedBothEndsDense, hb = A.homeBasedDirect;
  const sh = { n: N.tours.shop, a: A.tours.shop }, so = { n: N.tours.social, a: A.tours.social };
  if (!sh.n || !sh.a || !so.n || !so.a) return '';
  return `The near terms fit the NHTS 2017 shares of trips within half a mile of home; the bands beyond were not fitted, and ${pc(one2(sh.a.dist), 0)} of shopping tours and ${pc(one2(so.a.dist), 0)} of social ones go 1 to 2 miles, against ${pc(one2(sh.n.dist), 0)} and ${pc(one2(so.n.dist), 0)} in the survey ${cite('nhts2017')}. Of residents' trips of 1 to 2 miles from home, the model walks ${pc(share12(hb, 'walk'), 0)} (NHTS ${pc(share12(hbN, 'walk'), 0)}), drives ${pc(car12(hb), 0)} (${pc(car12(hbN), 0)}), and puts ${pc(share12(hb, 'transit'), 0)} on transit (${pc(share12(hbN, 'transit'), 0)}); the survey's dense tracts include Oakland's and Berkeley's, where transit at that distance is likely weaker, so the transit comparison is the weaker one.`;
}

type Modes = { dist: number[]; walk: number[]; transit: number[]; da?: number[]; sr?: number[]; car?: number[] };
interface Results {
  after: { homeBasedDirect: Modes; tours: Record<string, { dist: number[] }> };
  nhts: { homeBasedBothEndsDense: Modes; tours: Record<string, { dist: number[] }> };
}
