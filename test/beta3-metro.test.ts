import { describe, expect, it } from 'vitest';
import { DEMAND_OPTS, commuteDaysByClass } from '../shared/beta3/demand';
import { COMMUTE_DAYS_BY_INCOME } from '../shared/beta3/params';

describe('beta3 commute days by income', () => {
  const zones = [
    { workers: 1000, wfh: 0.2 },
    { workers: 500, wfh: 0 },
  ];
  // zone 0: a quarter of its employed in households under $100,000; zone 1: all of them
  const share = (_k: 'employed', s: number, c: number, o: number) => (s !== 1 ? 0 : o === 0 ? (c === 0 ? 0.25 : 0.75) : c === 0 ? 1 : 0);
  it("keeps the city's mean and the ratio of BATS Table 46", () => {
    const f = commuteDaysByClass(zones, share);
    // commuters: zone 0 800 (200 under $100,000), zone 1 500 (all under)
    const w = [700 / 1300, 600 / 1300];
    expect(w[0] * f[0] + w[1] * f[1]).toBeCloseTo(1, 9);
    expect(f[0] / f[1]).toBeCloseTo(COMMUTE_DAYS_BY_INCOME[0] / COMMUTE_DAYS_BY_INCOME[1], 9);
    expect(f[0]).toBeGreaterThan(1);
  });
  it('is one rate for all when switched off', () => {
    DEMAND_OPTS.commuteDaysByIncome = false;
    try {
      expect(commuteDaysByClass(zones, share)).toEqual([1, 1]);
    } finally {
      DEMAND_OPTS.commuteDaysByIncome = true;
    }
  });
});

describe('beta3 household size by PUMA', () => {
  it("puts more of a southeast zone's people in households without a car than the city's rates do", async () => {
    const { prepare } = await import('../shared/beta3/demand');
    const { HH_VEH_INC_SEED } = await import('../shared/beta3/params');
    const rows = HH_VEH_INC_SEED.map((r) => r.reduce((a, v) => a + v, 0));
    const cols = HH_VEH_INC_SEED[0].map((_, k) => HH_VEH_INC_SEED.reduce((a, r) => a + r[k], 0));
    const hh = rows.reduce((a, v) => a + v, 0);
    // a block group in tract 023400 (Bayview, PUMA 07507) and one with no id
    const zone = (id?: string) => ({ id, hh, hhVeh: rows, hhInc: cols, pop: 2 * hh, jobs: 0, jobsBy: new Array(21).fill(0), hotelRooms: 0, attractions: 0, areaType: 3, density: 20000, densityIndex: 10, schools: 0, universities: 0, college: 0 });
    const p = prepare({ header: { zones: [zone('060750234001'), zone()], ext: [] }, a: {} } as never);
    const car0 = (i: number) => p.segPeople.persons[0].reduce((a, c) => a + c[i], 0);
    // 07507: households without a car hold 1.52 times the city's persons, those with two or more 1.22 times
    expect(car0(0)).toBeGreaterThan(car0(1) * 1.15);
    for (const i of [0, 1]) expect([0, 1, 2].reduce((a, s) => a + p.segPeople.persons[s].reduce((x, c) => x + c[i], 0), 0)).toBeCloseTo(1, 6);
  });
});

describe('beta3 hotel visitors', () => {
  it("weights SF Planning's hotel door surveys by the rooms in each place type", async () => {
    const { visitorTarget, readVisitorRef, rowShares } = await import('../server/beta3/pipeline/visitor-target');
    const ref = readVisitorRef();
    // all rooms downtown: place type 1's shares without the shuttles (5.9% transit of 98.2%)
    const t = visitorTarget([{ nhood: 'Tenderloin', hotelRooms: 100 }], ref).target;
    expect(t.transit).toBeCloseTo(0.059 / 0.982, 3);
    expect(t.sr).toBeCloseTo((0.078 + 0.044) / 0.982, 3);
    expect(Object.values(t).reduce((a, v) => a + (v ?? 0), 0)).toBeCloseTo(1, 9);
    // half the rooms in place type 2 (Marina)
    const h = visitorTarget([{ nhood: 'Tenderloin', hotelRooms: 50 }, { nhood: 'Marina', hotelRooms: 50 }], ref).target;
    expect(h.transit).toBeCloseTo(0.5 * rowShares(ref.hotelDoorSurvey.byPlaceType['1']).transit! + 0.5 * rowShares(ref.hotelDoorSurvey.byPlaceType['2']).transit!, 9);
  });
});

describe("beta3 the Snapshot's trip purposes", () => {
  it('gives a stop leg its stop purpose three times in four, or its tour purpose in the tour reading', async () => {
    const { purposeMix } = await import('../server/beta3/pipeline/od-checks');
    const trip = purposeMix('resident stop legs', { work: 3, shop: 1 });
    expect(trip.Work).toBeCloseTo(0.25 * 0.75, 9);
    expect(Object.values(trip).reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
    const tour = purposeMix('resident stop legs', { work: 3, shop: 1 }, 'tour');
    expect(tour.Work).toBeCloseTo(0.75, 9);
    // a work subtour's leg back to work is a work trip
    expect(purposeMix('resident subtours', {}).Work).toBeCloseTo(0.5, 9);
    expect(purposeMix('resident work return', {})).toEqual({ Work: 1 });
  });
});

describe('beta3 Metro rides in the 2006-07 counts', () => {
  it('places every row, so each line has a ride length from its loads', async () => {
    const { tepMetro } = await import('../server/beta3/pipeline/diag-metro');
    const t = tepMetro();
    for (const r of ['J', 'KT', 'L', 'M', 'N']) {
      expect(t[r].miPerBoarding).toBeGreaterThan(1.5);
      expect(t[r].miPerBoarding).toBeLessThan(4);
      expect(t[r].onByDistance.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
    }
  });
});

describe('beta3 article: the Metro, visitor, and work-trip section', () => {
  it('renders from metro-results.json with every number filled in', async () => {
    const { metroWork } = await import('../client/beta3/paper/sections/metro');
    const html = metroWork();
    expect(html.length).toBeGreaterThan(1000);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
    if (process.env.PRINT_SECTION) console.log(html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '));
  });
});
