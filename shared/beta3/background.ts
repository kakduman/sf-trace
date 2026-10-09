/**
 * Background riders: people on BART and Caltrain whose trips have no end in San Francisco (Palo Alto
 * to San Jose, Oakland to Berkeley, the East Bay to SFO through the city). The demand model does not
 * carry them, but they fill the same trains. Their loads are fixed inputs, by line, hop, period, and
 * day type (BLine.bg, built by server/beta3/pipeline/background.ts from the operators' station-to-
 * station data, less the trips the model itself carries between the same stations). They add to the
 * loads that set crowding and to the loads reported, never to boardings, demand, or the calibration
 * targets. In a scenario they respond to the service only: a pattern's background riders change with
 * its trips by TCRP Report 95's frequency elasticity (+0.5), so twice the trains carry 41% more of
 * them, each train less full; a pattern removed hands its riders to the patterns still serving the
 * same stations, by their trips, scaled the same way by the change in trips between those stations.
 */
import { periodService, type NetLine } from './net';
import type { Bundle, DayType, TPeriod } from './types';

/** TCRP Report 95, ch. 9: ridership elasticity with respect to service frequency, central value */
export const BACKGROUND_FREQ_ELASTICITY = 0.5;

/** Background load on each hop of each of a period's lines (in `lines` order), or null if none. */
export function backgroundLoads(bundle: Bundle, lines: NetLine[], p: TPeriod, day: DayType = 'wkd'): Float32Array[] | null {
  const H = bundle.header;
  if (!H.lines.some((l) => l.bg?.[day]?.[p])) return null;
  const out = lines.map((l) => new Float32Array(Math.max(0, l.stops.length - 1)));
  const bySrc = new Map<number, number>();
  lines.forEach((l, i) => l.src >= 0 && bySrc.set(l.src, i));
  /** riders `v` from stop a to stop b along net line i (every hop between them), if it serves a then b */
  const put = (i: number, a: number, b: number, v: number) => {
    const s = lines[i].stops;
    const ka = s.indexOf(a);
    if (ka < 0) return false;
    const kb = s.indexOf(b, ka + 1);
    if (kb < 0) return false;
    for (let k = ka; k < kb; k++) out[i][k] += v;
    return true;
  };
  const E = BACKGROUND_FREQ_ELASTICITY;
  const baseTrips = H.lines.map((l) => periodService(l, p, day)?.trips ?? 0);
  const serves = (stops: number[], a: number, b: number) => { const ka = stops.indexOf(a); return ka >= 0 && stops.indexOf(b, ka + 1) >= 0; };
  H.lines.forEach((bl, src) => {
    const bg = bl.bg?.[day]?.[p];
    if (!bg) return;
    const own = bySrc.get(src);
    const f = own !== undefined && baseTrips[src] > 0 ? (lines[own].trips / baseTrips[src]) ** E : 1;
    for (let k = 0; k < bg.length; k++) {
      const v = bg[k];
      if (!v) continue;
      const a = bl.stops[k], b = bl.stops[k + 1];
      // the pattern as the scenario runs it (stops added, extended, more or fewer trains)
      if (own !== undefined && put(own, a, b, v * f)) continue;
      // removed, not running this period, or no longer serving both stops: the other patterns of the
      // operator that serve a then b share the riders by their trips, scaled by the change in the
      // trips between a and b
      const cand = lines.map((l, i) => i).filter((i) => i !== own && lines[i].feed === bl.feed && serves(lines[i].stops, a, b));
      const t = cand.reduce((s, i) => s + lines[i].trips, 0);
      const t0 = H.lines.reduce((s, l, i) => s + (l.feed === bl.feed && serves(l.stops, a, b) ? baseTrips[i] : 0), 0);
      const g = t0 > 0 ? Math.min(1, t / t0) ** E : 1;
      if (t > 0) for (const i of cand) put(i, a, b, (v * g * lines[i].trips) / t);
    }
  });
  return out;
}
