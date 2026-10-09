import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle } from '../shared/beta3/bundle';
import { TRIP_MIX, computeDemand, prepare, type TrnSkims } from '../shared/beta3/demand';
import { TRIP_SWITCH_STOP } from '../shared/beta3/params';
import { eraShift, shiftShare } from '../server/beta3/pipeline/od-checks';

const era = JSON.parse(fs.readFileSync('server/beta3/reference/acs-commute-era.json', 'utf8'));

describe('beta3 CTPP on the model year', () => {
  it("moves the CTPP's period to 2024 by the city's change in the ACS workplace share", () => {
    const w = era.byWorkplace;
    // the shares are the counts' (commuters: workers less those working at home)
    for (const v of Object.values(w) as { workers: number; transit: number; workedFromHome: number; transitShare: number }[]) expect(v.transitShare).toBeCloseTo(v.transit / (v.workers - v.workedFromHome), 4);
    const s = eraShift(era);
    expect(s).toBeLessThan(0);
    // the city's own 2017–2021 share lands on 2024's
    expect(shiftShare(w['2017-2021 5-year'].transitShare, s)).toBeCloseTo(w['2024 1-year'].transitShare, 9);
    // a shift keeps shares inside (0, 1) and keeps their order
    expect(shiftShare(0.575, s)).toBeLessThan(0.575);
    expect(shiftShare(0.575, s)).toBeGreaterThan(shiftShare(0.4, s));
    expect(shiftShare(0, s)).toBe(0);
    expect(eraShift(null)).toBe(0);
  });
});

describe('beta3 stop legs of transit tours', () => {
  it('have constants of their own that leave the trip back alone', () => {
    expect(TRIP_SWITCH_STOP).toContain('transit');
    const nhts = JSON.parse(fs.readFileSync('server/beta3/reference/nhts-tripmode.json', 'utf8')).byTourMode.transit;
    // the NHTS's transit tours come home by transit far more often than they ride to their stops
    expect(nhts.returnLeg.transit).toBeGreaterThan(0.8);
    expect(nhts.stopLegs.transit).toBeLessThan(0.3);
    const b = decodeBundle(zlib.gunzipSync(fs.readFileSync('client/beta3/model/sf.bin.gz')));
    const prep = prepare(b);
    const { NZ, ZT } = prep;
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
    TRIP_MIX.on = true;
    try {
      const pooled = computeDemand(b, prep, sk, { ...calib, tripSwitchStop: undefined });
      // the stop legs' own constants, at first the trip back's
      const same = computeDemand(b, prep, sk, { ...calib, tripSwitchStop: { ...calib.tripSwitch } });
      expect(same.tripMixStop.transit.transit).toBeCloseTo(pooled.tripMixStop.transit.transit, 9);
      // walking a transit tour's stop legs made more likely moves them, not the trips back
      const ts = calib.tripSwitch ?? {};
      const walked = computeDemand(b, prep, sk, { ...calib, tripSwitchStop: { ...ts, 'transit>walk': (ts['transit>walk'] ?? 0) + 2 } });
      expect(walked.tripMixStop.transit.walk).toBeGreaterThan(pooled.tripMixStop.transit.walk + 0.05);
      for (const m of ['transit', 'walk', 'tnc', 'sr'] as const) expect(walked.tripMixBack.transit[m]).toBeCloseTo(pooled.tripMixBack.transit[m], 9);
    } finally {
      TRIP_MIX.on = false;
    }
  }, 600_000);
});
