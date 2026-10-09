/**
 * Caltrain loads on each stretch of the corridor between consecutive stations, by direction and
 * period: observed (the estimated station-to-station journeys of reference/regional-od.json, each
 * carried over every stretch between its stations) against the model's loads, which include the
 * background riders with no end in the city. Also the seats and places offered (scheduled trains ×
 * capacity) and the load in the busiest hour (the period's load × LOAD_SPREAD).
 */
import { periodService } from '../../../shared/beta3/net';
import { LOAD_SPREAD } from '../../../shared/beta3/params';
import type { Bundle, DayType, RunResult, TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { readRegional, regionalStops, type RegionalRef } from './station-od';

export interface CaltrainSegment {
  dir: 'NB' | 'SB';
  period: TPeriod;
  a: string;
  b: string;
  observed: number;
  /** all modeled riders, background included */
  model: number;
  background: number;
  /** places (seated + standing) offered over the period */
  capacity: number;
  seats: number;
}

export function caltrainSegments(b: Bundle, r: Pick<RunResult, 'lines'>, day: DayType = 'wkd', ref: RegionalRef = readRegional()): CaltrainSegment[] {
  const H = b.header;
  const st = regionalStops(b, ref).caltrain;
  // the corridor: reference stations served by a pattern that day, north to south
  const served = new Set(H.lines.filter((l) => l.feed === 'caltrain' && TPERIODS.some((p) => periodService(l, p, day))).flatMap((l) => l.stops));
  const corr = st.names.map((name, i) => ({ name, stop: st.stops[i], ref: i })).filter((x) => x.stop >= 0 && served.has(x.stop));
  const pos = new Map(corr.map((x, k) => [x.stop, k]));
  const nS = corr.length - 1;
  const zero = () => ({ obs: new Float64Array(nS), mod: new Float64Array(nS), bg: new Float64Array(nS), cap: new Float64Array(nS), seats: new Float64Array(nS) });
  const acc = {} as Record<string, ReturnType<typeof zero>>;
  for (const d of ['NB', 'SB']) for (const p of TPERIODS) acc[`${d}${p}`] = zero();
  // observed: each journey over every stretch between its stations
  for (const p of TPERIODS) {
    const M = ref.caltrain.od[day][p];
    for (let i = 0; i < corr.length; i++)
      for (let j = 0; j < corr.length; j++) {
        if (i === j) continue;
        const v = M[corr[i].ref][corr[j].ref];
        if (!v) continue;
        const A = acc[`${i < j ? 'SB' : 'NB'}${p}`];
        for (let k = Math.min(i, j); k < Math.max(i, j); k++) A.obs[k] += v;
      }
  }
  // model: each hop's load over the stretches it spans
  for (const lr of r.lines) {
    if (lr.line < 0) continue;
    const l = H.lines[lr.line];
    if (l.feed !== 'caltrain') continue;
    const stops = lr.stops ?? l.stops;
    for (const p of TPERIODS) {
      const L = lr.loads[p];
      if (!L) continue;
      const s = periodService(l, p, day);
      const bg = l.bg?.[day]?.[p];
      for (let k = 0; k + 1 < stops.length; k++) {
        const ka = pos.get(stops[k]), kb = pos.get(stops[k + 1]);
        if (ka === undefined || kb === undefined) continue;
        const A = acc[`${ka < kb ? 'SB' : 'NB'}${p}`];
        for (let q = Math.min(ka, kb); q < Math.max(ka, kb); q++) {
          A.mod[q] += L[k] ?? 0;
          if (bg && !lr.stops) A.bg[q] += bg[k] ?? 0;
          if (s) (A.cap[q] += s.trips * l.cap), (A.seats[q] += s.trips * l.seats);
        }
      }
    }
  }
  const out: CaltrainSegment[] = [];
  for (const d of ['NB', 'SB'] as const)
    for (const p of TPERIODS) {
      const A = acc[`${d}${p}`];
      for (let k = 0; k < nS; k++) out.push({ dir: d, period: p, a: corr[k].name, b: corr[k + 1].name, observed: Math.round(A.obs[k]), model: Math.round(A.mod[k]), background: Math.round(A.bg[k]), capacity: Math.round(A.cap[k]), seats: Math.round(A.seats[k]) });
    }
  return out;
}

/** the busiest stretch of each direction and peak: load in the busiest hour against seats and places */
export function caltrainPeaks(segs: CaltrainSegment[]) {
  return (['AM', 'PM'] as TPeriod[]).flatMap((p) =>
    (['NB', 'SB'] as const).map((dir) => {
      const s = segs.filter((x) => x.dir === dir && x.period === p);
      const top = s.reduce((a, x) => (x.model > a.model ? x : a), s[0]);
      const topObs = s.reduce((a, x) => (x.observed > a.observed ? x : a), s[0]);
      const k = LOAD_SPREAD[p];
      return {
        dir, period: p,
        stretch: `${top.a}–${top.b}`, model: top.model, background: top.background, modelWithoutBackground: top.model - top.background,
        loadPerSeat: +((top.model * k) / Math.max(1, top.seats)).toFixed(3), loadPerSeatWithoutBackground: +(((top.model - top.background) * k) / Math.max(1, top.seats)).toFixed(3),
        observedStretch: `${topObs.a}–${topObs.b}`, observed: topObs.observed, observedPerSeat: +((topObs.observed * k) / Math.max(1, topObs.seats)).toFixed(3),
      };
    }),
  );
}
