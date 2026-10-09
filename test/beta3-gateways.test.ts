import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle } from '../shared/beta3/bundle';
import { LINE_X, computeDemand, corridorOf, prepare, type TrnSkims } from '../shared/beta3/demand';
import type { Corridor } from '../shared/beta3/types';

describe('beta3 corridors at the city line', () => {
  it('places each outside zone on the corridor it drives in by', () => {
    expect(corridorOf({ id: 'SFO', county: 'San Mateo County' })).toBe('south');
    expect(corridorOf({ id: 'x', county: 'Santa Clara County' })).toBe('south');
    expect(corridorOf({ id: 'x', county: 'Marin County' })).toBe('north');
    expect(corridorOf({ id: 'x', county: 'Sonoma County' })).toBe('north');
    expect(corridorOf({ id: 'x', county: 'Alameda County' })).toBe('east');
    expect(corridorOf({ id: 'x', county: 'Sacramento County' })).toBe('east');
  });

  it("tallies the cars crossing the city line by market without changing demand", { timeout: 400_000 }, () => {
    const b = decodeBundle(zlib.gunzipSync(fs.readFileSync('client/beta3/model/sf.bin.gz')));
    const prep = prepare(b);
    const { NZ, NX, ZT } = prep;
    const dm = b.a.autoDm as Uint16Array;
    const skim = (extra: number) => {
      const n = ZT * ZT, g = new Float32Array(n).fill(Infinity), boards = new Float32Array(n), fare = new Float32Array(n), time = new Float32Array(n).fill(Infinity);
      for (let o = 0; o < NZ; o++)
        for (let d = 0; d < NZ; d++) {
          const km = dm[o * NZ + d] / 100, i = o * ZT + d;
          g[i] = 14 + 4 * km + extra;
          boards[i] = km > 3 ? 2 : 1;
          fare[i] = 2.85;
          time[i] = 10 + 3 * km + extra / 2;
        }
      return { g, boards, fare, time };
    };
    const sk = { AM: skim(0), MD: skim(4), PM: skim(0), NT: skim(16) } as TrnSkims;
    const calib = b.header.calibration!;
    const corr = b.header.ext.map(corridorOf);
    const byCorridor = (t: Float64Array) => {
      const o: Record<Corridor, number> = { north: 0, east: 0, south: 0 };
      for (let m = 0; m < 6; m++) for (let e = 0; e < NX; e++) o[corr[e]] += t[m * NX + e];
      return o;
    };
    // every car trip across the line on crossing 1
    const ZA = NZ + NX;
    LINE_X.paths = [0, 1, 2, 3].map(() => new Uint8Array(ZA * ZA).fill(1));
    LINE_X.n = 2;
    try {
      const a = computeDemand(b, prep, sk, calib);
      // regional visitors' trips across the line are all of their trips, on every corridor
      const reg = a.lineTrips.regional.reduce((x, v) => x + v, 0);
      const regAll = Object.values(a.byPurpose.regional).reduce((x, v) => x + v, 0);
      expect(reg).toBeCloseTo(regAll, 0);
      const C = byCorridor(a.lineTrips.regional);
      for (const c of ['north', 'east', 'south'] as Corridor[]) expect(C[c]).toBeGreaterThan(0);
      // the cars: on crossing 1 only, fewer than the car-mode person trips (carpools carry more than one)
      const V = a.lineVeh.regional;
      expect(V[0]).toBe(0);
      expect(V[2]).toBe(0);
      const T = a.lineTrips.regional;
      let car = 0, alone = 0;
      for (let e = 0; e < NX; e++) ((car += T[e] + T[NX + e] + T[2 * NX + e]), (alone += T[e] + T[2 * NX + e]));
      expect(V[1]).toBeLessThan(car);
      expect(V[1]).toBeGreaterThan(alone);
      // the tally changes nothing else
      LINE_X.paths = null;
      const z = computeDemand(b, prep, sk, calib);
      expect(z.trips).toEqual(a.trips);
      expect(z.vkt).toBe(a.vkt);
      expect(Object.keys(z.lineVeh)).toHaveLength(0);
    } finally {
      LINE_X.paths = null;
      LINE_X.n = 0;
    }
  });
});
