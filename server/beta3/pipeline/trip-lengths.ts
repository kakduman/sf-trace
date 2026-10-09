/**
 * How far trips go: the NHTS 2017 targets of destination choice and stop placement, and one fitting
 * step, shared by calibrate.ts and experiment.ts (--refit).
 *
 * Each purpose's distance enters destination choice twice: a linear (or TM1 piecewise) term, fitted
 * to the mean length of the trips of up to 5 miles, and a log term (demand.ts nearTerm), fitted to the
 * share of trips of half a mile or less. Matching the two fits the shape of the distribution near home,
 * not just its middle; the bands are a check (diag-length.ts). Stops are placed the same way, by the
 * tour's mode.
 *
 * Why up to 5 miles: the NHTS's dense tracts are in Oakland and Berkeley as well as the city, and
 * beyond 5 miles a home in the city mostly has the bay and the city line, where an East Bay home has
 * more city. Trips of 5 to 12 miles are 24% of errand tours and 13% of social ones in the NHTS, and the
 * model, whose tours here stay in the city, cannot make them; fitted to the mean of all of them, the
 * linear term had to push trips away from home while the log term pulled them in (the linear term
 * went to its bound of zero and errands were still 28% short).
 *
 * Targets: home to the primary destination on weekday tours without a stop on the way out, residents
 * of dense tracts (10,000+ people per square mile) of the SF–Oakland metro, up to 12 road miles
 * (nhts_tours.py); the detour to a stop (the shorter of its two legs), by the tour's mode; trips not
 * from home (in-commuters' and visitors' here) from the NHTS's trips not based at home by the same
 * residents (nhts_transit_length.py, ends of any density). College tours (12 sampled with lengths) and
 * visitors' trips (not surveyed) keep assumed means of all their trips; stops on bike tours (36
 * sampled) have a mean only.
 */
import fs from 'node:fs';
import type { Calibration } from '../../../shared/beta3/types';
import { MODES, type Purpose } from '../../../shared/beta3/params';
import { REFERENCE } from './paths';

export interface LengthTargets {
  /** mean km by purpose (of the trips of up to 5 miles, for those in upTo5mi), and the share of trips of half a mile or less */
  meanKm: Partial<Record<Purpose, number>>;
  near: Partial<Record<Purpose, number>>;
  /** the same for the detour to a stop, by the tour's mode class (all means of trips of up to 5 miles) */
  stopKm: Record<string, number>;
  stopNear: Record<string, number>;
  /** the purposes whose mean is of their trips of up to 5 miles */
  upTo5mi: string[];
  /** NHTS sample behind each target */
  sample: Record<string, number>;
}

export function lengthTargets(): LengthTargets {
  const read = (f: string) => JSON.parse(fs.readFileSync(`${REFERENCE}/${f}`, 'utf8'));
  const tours = read('nhts-tours.json');
  const T = tours.byTourPurpose as Record<string, { meanPrimaryKmDenseUpTo5mi: number; primaryBandsDense: number[]; primarySampleDense: number }>;
  const M = tours.byTourMode as Record<string, { meanDetourLegKmDenseUpTo5mi: number; detourBandsDense: number[]; detourSampleDense: number }>;
  const nhb = read('nhts-transit-length.json').anyEnd.notHomeBased as { dist: number[]; sample: number[]; meanMiUpTo5: number };
  const meanKm: Partial<Record<Purpose, number>> = { univ: 5.0, visitor: 3.0, nhb: nhb.meanMiUpTo5 * 1.609344 };
  const near: Partial<Record<Purpose, number>> = { nhb: nhb.dist[0] };
  const sample: Record<string, number> = { nhb: nhb.sample.reduce((a, v) => a + v, 0) };
  const upTo5mi = ['nhb'];
  for (const p of ['shop', 'other', 'social'] as const) {
    meanKm[p] = T[p].meanPrimaryKmDenseUpTo5mi;
    near[p] = T[p].primaryBandsDense[0];
    sample[p] = T[p].primarySampleDense;
    upTo5mi.push(p);
  }
  // school tours: their lengths are fitted to SFUSD's elementary pupils (demand.ts fitStudents, on
  // TM1's school distance terms); the NHTS's is a check
  sample.school = T.school.primarySampleDense;
  const stopKm: Record<string, number> = {}, stopNear: Record<string, number> = {};
  for (const c of ['car', 'transit', 'walk', 'bike']) {
    stopKm[c] = M[c].meanDetourLegKmDenseUpTo5mi;
    if (c !== 'bike') stopNear[c] = M[c].detourBandsDense[0];
    sample[`stop:${c}`] = M[c].detourSampleDense;
  }
  return { meanKm, near, stopKm, stopNear, upTo5mi, sample };
}

const logit = (p: number) => Math.log(Math.min(0.99, Math.max(0.005, p)) / (1 - Math.min(0.99, Math.max(0.005, p))));

/**
 * One step toward the targets: the linear coefficient by the log ratio of target to model mean
 * (gain `meanGain`; 1.5 times that for stops), the log coefficient by the log odds ratio of the near
 * shares (gain `nearGain`, 0.7 times that for stops; between a destination half a mile away and one
 * three miles away the log term differs by about 1.8, so a gain of 0.5 closes most of the gap in one
 * step). Returns a line for the log.
 */
export function fitLengths(
  calib: Calibration,
  d: { meanKm: Record<string, number>; kmBands: Record<string, number[]> },
  T: LengthTargets,
  meanGain: number,
  nearGain = 0.5,
): string {
  calib.distLogCoef ??= {};
  calib.stopDistCoefs ??= {};
  calib.stopLogCoefs ??= {};
  const parts: string[] = [];
  for (const [p, km] of Object.entries(T.meanKm) as [Purpose, number][]) {
    const m = d.meanKm[T.upTo5mi.includes(p) ? `${p}<5mi` : p];
    if (!m) continue;
    // trips too long (m > km) → a stronger pull toward nearby places
    calib.distCoef[p] = Math.min(0, (calib.distCoef[p] ?? 0) + meanGain * Math.log(km / m));
    const t = T.near[p], s = d.kmBands[p]?.[0];
    if (t !== undefined && s !== undefined) calib.distLogCoef[p] = Math.max(-3, Math.min(0.5, (calib.distLogCoef[p] ?? 0) - nearGain * (logit(t) - logit(s))));
    parts.push(`${p} ${m.toFixed(2)}/${km.toFixed(2)} km${t !== undefined && s !== undefined ? ` ≤½mi ${(100 * s).toFixed(0)}/${(100 * t).toFixed(0)}%` : ''}`);
  }
  for (const [c, km] of Object.entries(T.stopKm)) {
    const m = d.meanKm[`stop:${c}<5mi`];
    if (!m) continue;
    // stops move less per step: with the near pull and the linear decay both weak, a car tour's stops
    // spread over the city and back
    calib.stopDistCoefs[c] = Math.max(-5, Math.min(0, (calib.stopDistCoefs[c] ?? calib.stopDistCoef ?? -0.45) + 1.5 * meanGain * Math.log(km / m)));
    const t = T.stopNear[c], s = d.kmBands[`stop:${c}`]?.[0];
    if (t !== undefined && s !== undefined) calib.stopLogCoefs[c] = Math.max(-3, Math.min(0.5, (calib.stopLogCoefs[c] ?? 0) - 0.7 * nearGain * (logit(t) - logit(s))));
    parts.push(`stop:${c} ${m.toFixed(2)}/${km.toFixed(2)} km${t !== undefined && s !== undefined ? ` ≤½mi ${(100 * s).toFixed(0)}/${(100 * t).toFixed(0)}%` : ''}`);
  }
  return parts.join(', ');
}

/**
 * One step of walking's time weight (Calibration.walkTimeFactor) toward how fast walking falls off
 * with distance: the log odds of walking a trip of 1 to 2 road miles from or to home, less those of
 * walking one of half a mile or less (NHTS 2017: `target.mid` and `target.near`), from the direct legs
 * of residents' tours (demand lengthBands, [band × 6 + mode]; band 0 is up to ½ mile, bands 2 and 3
 * 1–1½ and 1½–2 miles). The walk constants set how much residents walk; this sets the slope, so the two
 * don't chase the same error (fitted to the share at 1 to 2 miles itself, the factor and the
 * constants moved together and the calibration swung between 27% and 39% of trips walked). A mile and
 * a half each way at TM1's weights moves walking's utility by about 2.5 per unit of the factor's log,
 * less at half a mile, hence the step. Returns a line for the log.
 */
export function fitWalkTime(calib: Calibration, lengthBands: Record<string, Float64Array>, target: { near: number; mid: number }, damp = 1): string {
  const NM = MODES.length, W = MODES.indexOf('walk');
  const near = new Float64Array(NM), mid = new Float64Array(NM);
  for (const [k, a] of Object.entries(lengthBands))
    if (k.startsWith('resident work') || k.startsWith('resident home-based'))
      for (let m = 0; m < NM; m++) (near[m] += a[m]), (mid[m] += a[2 * NM + m] + a[3 * NM + m]);
  const sum = (t: Float64Array) => t.reduce((a, v) => a + v, 0);
  if (!(sum(near) > 0) || !(sum(mid) > 0)) return 'walked by distance: no trips';
  const w0 = near[W] / sum(near), w = mid[W] / sum(mid);
  const gap = logit(w) - logit(w0) - (logit(target.mid) - logit(target.near));
  calib.walkTimeFactor = Math.max(0.5, Math.min(5, (calib.walkTimeFactor ?? 1) * Math.exp((damp * gap) / 2.5)));
  calib.walkFit = [w, target.mid];
  calib.walkFitNear = [w0, target.near];
  return `walked at ½ mi or less ${(100 * w0).toFixed(1)}/${(100 * target.near).toFixed(1)}%, at 1–2 mi ${(100 * w).toFixed(1)}/${(100 * target.mid).toFixed(1)}% → walk time ×${calib.walkTimeFactor.toFixed(2)}`;
}
