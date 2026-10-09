import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commuteSplit } from '../server/beta3/pipeline/build';
import { applyCommuteSplit } from '../server/beta3/pipeline/commute-acs2024';
import { SNAPSHOT_PERIODS, purposeMix } from '../server/beta3/pipeline/od-checks';

const acs = JSON.parse(fs.readFileSync('server/beta3/reference/acs-commute.json', 'utf8'));

describe('beta3 commutes on the ACS 2024 1-year tables', () => {
  it('derives in-commuters and residents leaving the city from the same year', () => {
    const a = acs.acs1yr2024;
    const r = a.residentsByPlaceOfWork_B08130;
    // residents: within the county (working from home counted there) and outside it add up to all workers
    expect(r.workedInSFCounty + r.workedOutsideSFCounty).toBe(r.totalWorkers16plus);
    expect(r.commutersInSF).toBe(r.workedInSFCounty - r.workedFromHome);
    expect(r.outShareOfCommuters).toBeCloseTo(r.commutersOutsideSF / (r.commutersOutsideSF + r.commutersInSF), 4);
    // the city's workplaces: residents commuting within it plus in-commuters plus those at home
    expect(a.inCommuters.total + r.commutersInSF + r.workedFromHome).toBe(a.workersAtSFWorkplaces_B08604.total);
    const m = a.inCommuters.modes;
    expect(m.da + m.sr + m.transit + m.walk + m.other).toBe(a.inCommuters.total);
    // the workplace table's total by mode is B08604's
    expect(Object.values(a.workplaceModes_B08406 as Record<string, number>).reduce((s, v) => s + v, 0) + r.workedFromHome).toBe(a.workersAtSFWorkplaces_B08604.total);
    const s = commuteSplit(acs);
    expect(s.inCommuters).toBe(267641);
    expect(s.outTarget).toBeCloseTo(0.2824, 4);
    // more of both than the pooled 2020–24 tables gave
    expect(s.inCommuters).toBeGreaterThan(acs.workersWorkingInSF_B08604.totalWorkersAtSFWorkplaces - acs.residentsPlaceOfWork_B08007.workedInSFCounty.count);
  });

  it('puts an existing bundle on the split exactly, and only once', () => {
    const NZ = 3;
    const a = {
      flowW: Int32Array.from([0, 1, 3, 4, 2]),
      flowN: Float32Array.from([40, 30, 10, 10, 10]),
      inN: Float32Array.from([5, 15]),
    };
    applyCommuteSplit(a, NZ, 0.3, 50);
    const fn = a.flowN, out = fn[2] + fn[3], all = fn.reduce((s, v) => s + v, 0);
    expect(out / all).toBeCloseTo(0.3, 6);
    // flows within the city keep their values; outside ones keep their proportions
    expect([fn[0], fn[1], fn[4]]).toEqual([40, 30, 10]);
    expect(fn[2] / fn[3]).toBeCloseTo(1, 6);
    expect(a.inN.reduce((s, v) => s + v, 0)).toBeCloseTo(50, 4);
    expect(a.inN[1] / a.inN[0]).toBeCloseTo(3, 6);
    const again = Float32Array.from(fn);
    applyCommuteSplit(a, NZ, 0.3, 50);
    for (let i = 0; i < fn.length; i++) expect(a.flowN[i]).toBeCloseTo(again[i], 4);
  });
});

describe('beta3 Muni riders read as surveyed', () => {
  it('leaves out the night, which the Snapshot did not survey', () => {
    expect([...SNAPSHOT_PERIODS]).toEqual(['AM', 'MD', 'PM']);
  });
  it('gives stop legs on the way to work the tour purpose only in the tour reading', () => {
    const tours = { work: 1 };
    const trip = purposeMix('resident stop legs', tours, 'trip');
    const tour = purposeMix('resident stop legs', tours, 'tour');
    expect(tour.Work).toBeCloseTo(1, 9);
    expect(trip.Work).toBeCloseTo(0.25, 9);
    expect(Object.values(trip).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
  });
});

describe('beta3 article: commute trips', () => {
  it('renders from commutes-results.json without missing numbers', async () => {
    const { commutesWork } = await import('../client/beta3/paper/sections/commutes');
    const h = commutesWork();
    expect(h).toContain('267,641');
    expect(h).not.toMatch(/NaN|undefined|Infinity/);
    if (process.env.SHOW_SECTION) console.log(h.replace(/<[^>]+>/g, ''));
  });
});
