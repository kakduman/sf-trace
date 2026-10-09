import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { residentLinkedShares, residentLinkedTrips } from '../server/beta3/pipeline/resident-targets';
import { LENGTH_BANDS_MI, lengthBand } from '../shared/beta3/demand';

const ref = (f: string) => JSON.parse(fs.readFileSync(`${__dirname}/../server/beta3/reference/${f}`, 'utf8'));

describe('beta3 residents\' targets', () => {
  it('takes linked shares from the BATS dashboard, adults and under-18s weighted by their trips', () => {
    const s = residentLinkedShares(ref('sf-mode-by-area.json'));
    const sum = Object.values(s).reduce((a, v) => a + (v ?? 0), 0);
    expect(sum).toBeCloseTo(1, 9);
    // adults 13.8% and under-18s 10.4% of all trips; OTHER and school buses left out of the denominator
    expect(s.transit).toBeGreaterThan(0.135);
    expect(s.transit).toBeLessThan(0.14);
    expect(s.walk).toBeGreaterThan(0.33);
    expect(s.walk).toBeLessThan(0.35);
  });
  it('counts linked trips as the unlinked car trips over the linked car share', () => {
    const t36 = { weightedTrips: 1000, sharesPercent: { Car: 40, Carshare: 1 } };
    expect(residentLinkedTrips(t36, { da: 0.3, sr: 0.2, walk: 0.5 })).toBeCloseTo(820, 9);
  });
});

describe('beta3 length bands', () => {
  it('puts a distance in the first band it does not exceed', () => {
    expect(lengthBand(0)).toBe(0);
    expect(lengthBand(0.5)).toBe(0);
    expect(lengthBand(0.51)).toBe(1);
    expect(lengthBand(2.5)).toBe(4);
    expect(lengthBand(40)).toBe(LENGTH_BANDS_MI.length - 1);
  });
});

describe('beta3 people by car segment', () => {
  it("splits a zone with the city's households into the city's people, not its households", async () => {
    const { prepare } = await import('../shared/beta3/demand');
    const { HH_VEH_INC_SEED } = await import('../shared/beta3/params');
    const rows = HH_VEH_INC_SEED.map((r) => r.reduce((a, v) => a + v, 0));
    const cols = HH_VEH_INC_SEED[0].map((_, k) => HH_VEH_INC_SEED.reduce((a, r) => a + r[k], 0));
    const hh = rows.reduce((a, v) => a + v, 0);
    const zone = { hh, hhVeh: rows, hhInc: cols, pop: 2 * hh, jobs: 0, jobsBy: new Array(21).fill(0), hotelRooms: 0, attractions: 0, areaType: 3, density: 20000, densityIndex: 10, schools: 0, universities: 0, college: 0 };
    const p = prepare({ header: { zones: [zone], ext: [] }, a: {} } as never);
    const seg = (kind: 'persons' | 'employed' | 'age65plus', s: number) => p.segPeople[kind][s].reduce((a, c) => a + c[0], 0);
    for (const kind of ['persons', 'employed', 'age65plus'] as const) expect([0, 1, 2].reduce((a, s) => a + seg(kind, s), 0)).toBeCloseTo(1, 6);
    // ACS 2024 PUMS: households without a car are 32.6% of households, 24.0% of residents, 23.8% of the employed
    expect(p.seg[0][0]).toBeCloseTo(0.326, 2);
    expect(seg('persons', 0)).toBeCloseTo(0.24, 2);
    expect(seg('employed', 0)).toBeCloseTo(0.238, 2);
    expect(seg('persons', 2)).toBeCloseTo(0.364, 2);
  });
});
