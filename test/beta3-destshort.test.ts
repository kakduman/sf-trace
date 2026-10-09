import { describe, expect, it } from 'vitest';
import { NEAR_KM_FLOOR, nearTerm } from '../shared/beta3/demand';
import { fitLengths, fitWalkTime, lengthTargets } from '../server/beta3/pipeline/trip-lengths';
import type { Calibration } from '../shared/beta3/types';

const calib0 = (): Calibration => ({ asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0.3, outShare: 0.05, airportTrips: 30000, iterations: 0, report: [] });

describe('beta3 trip-length targets', () => {
  it('reads the NHTS shares of trips of half a mile or less from the tours and trips not from home', () => {
    const T = lengthTargets();
    // dense tracts of the SF–Oakland metro: social tours 34% within half a mile, shopping and errands 18%
    expect(T.near.social).toBeGreaterThan(0.3);
    expect(T.near.social).toBeLessThan(0.38);
    expect(T.near.shop).toBeGreaterThan(0.15);
    expect(T.near.other).toBeGreaterThan(0.15);
    // trips not from home are the shortest (36%); stops on walking tours nearly all next door
    expect(T.near.nhb).toBeGreaterThan(0.33);
    expect(T.stopNear.walk).toBeGreaterThan(0.7);
    // the purposes without a usable sample have a mean only
    expect(T.near.univ).toBeUndefined();
    expect(T.stopNear.bike).toBeUndefined();
    // means of the trips of up to 5 miles, except the assumed ones
    expect(T.meanKm.shop).toBeGreaterThan(2);
    expect(T.meanKm.shop).toBeLessThan(3);
    expect(T.upTo5mi).toContain('social');
    expect(T.upTo5mi).not.toContain('univ');
    // school tours' lengths are fitted to SFUSD (fitStudents), not here
    expect(T.meanKm.school).toBeUndefined();
  });
});

describe('beta3 near term', () => {
  it('is the log of km, floored at a block', () => {
    expect(nearTerm(1)).toBe(0);
    expect(nearTerm(Math.E)).toBeCloseTo(1, 12);
    expect(nearTerm(0)).toBe(Math.log(NEAR_KM_FLOOR));
    expect(nearTerm(0.01)).toBe(nearTerm(NEAR_KM_FLOOR));
  });
});

describe('beta3 fitting trip lengths', () => {
  const T = lengthTargets();
  const bands = (near: number) => [near, ...new Array(7).fill((1 - near) / 7), 0];
  it('pulls toward nearby places when too few trips are short, and lets go when too many are', () => {
    const c = calib0();
    const meanKm = Object.fromEntries(['shop', 'other', 'social', 'school', 'nhb'].map((p) => [`${p}<5mi`, T.meanKm[p as 'shop']!]));
    fitLengths(c, { meanKm, kmBands: { shop: bands(0.07), social: bands(0.5) } }, T, 0.12);
    expect(c.distLogCoef!.shop!).toBeLessThan(0);
    expect(c.distLogCoef!.social!).toBeGreaterThan(0);
    // means on target: the linear terms don't move
    expect(c.distCoef.shop).toBeCloseTo(0, 12);
    // no near share in the model (no trips tallied): the log term is left alone
    expect(c.distLogCoef!.other).toBeUndefined();
  });
  it('steps the linear term by the mean and stops by their detours', () => {
    const c = calib0();
    c.distCoef.shop = -0.2;
    // the mean of all trips does not count where the target is of trips of up to 5 miles
    fitLengths(c, { meanKm: { shop: 9, 'shop<5mi': 2 * T.meanKm.shop!, 'stop:walk<5mi': T.stopKm.walk / 2 }, kmBands: { 'stop:walk': bands(0.9) } }, T, 0.12);
    // trips twice too long: a stronger pull toward nearby places; never a push away
    expect(c.distCoef.shop!).toBeCloseTo(-0.2 - 0.12 * Math.log(2), 12);
    // walking tours' stops too near: a weaker linear decay and a weaker near pull
    expect(c.stopDistCoefs!.walk).toBeGreaterThan(-0.45);
    expect(c.stopLogCoefs!.walk).toBeGreaterThan(0);
    const c2 = calib0();
    c2.distCoef.shop = -0.01;
    fitLengths(c2, { meanKm: { 'shop<5mi': T.meanKm.shop! / 3 }, kmBands: {} }, T, 0.12);
    expect(c2.distCoef.shop).toBe(0);
  });
});

describe('beta3 walking against distance', () => {
  it('weighs walking more when walking falls off too slowly from half a mile to 1 to 2 miles', () => {
    // bands × modes (da sr tnc transit walk bike): within half a mile 80% walked, at 1 to 2 miles half
    const a = new Float64Array(8 * 6);
    (a[4] = 80), (a[0] = 20);
    for (const k of [2, 3]) (a[k * 6 + 4] = 50), (a[k * 6 + 0] = 50);
    const c = calib0();
    // a key that isn't a direct leg from home does not count
    const line = fitWalkTime(c, { 'resident home-based car1': a, 'resident subtours': Float64Array.from(a).fill(7) }, { near: 0.87, mid: 0.17 });
    expect(c.walkFit![0]).toBeCloseTo(0.5, 12);
    expect(c.walkFitNear![0]).toBeCloseTo(0.8, 12);
    expect(c.walkTimeFactor!).toBeGreaterThan(1);
    expect(line).toMatch(/1–2 mi 50\.0\/17\.0%/);
    // the same fall-off at another level of walking: no change (the constants' job)
    const f = c.walkTimeFactor!;
    fitWalkTime(c, { 'resident work car0': a }, { near: 0.8, mid: 0.5 });
    expect(c.walkTimeFactor).toBeCloseTo(f, 12);
  });
});
