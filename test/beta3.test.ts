import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle } from '../shared/beta3/bundle';
import { buildNet, C_BOARDS, C_IVT, C_WAIT, EXT_BUS, EXT_DRIVE, NC, activityEnd, transitZones } from '../shared/beta3/net';
import { StrategySolver } from '../shared/beta3/strategy';
import { boardingAvailability, crowdMultiplier, lineVolumes, updateLotPrices } from '../shared/beta3/model';
import { CAPACITY, LOAD_HOURS, PARK_AND_RIDE, PATH, TRIP_SWITCH, TRIP_SWITCH_ASC, transferPenalty } from '../shared/beta3/params';
import { TOD, TRIP_MIX, computeDemand, demandPart, finishDemand, legWeights, tripSwitch, type TrnSkims } from '../shared/beta3/demand';
import { capacityFreq } from '../shared/beta3/net';
import type { BLine, BStop, Bundle, BundleHeader, ZoneAttrs } from '../shared/beta3/types';
import { AO_ALTS, AO_F, AO_STRIDE, TM1_AO, aoClassesFromHouseholds, aoProbabilities, aoZoneShares, type AoAccess, type AoHousehold } from '../shared/beta3/autoown';

/** a tiny city: zones at stops, lines given as [stops, minutes per hop, trips in the AM period] */
function toy(nStops: number, lines: [number[], number, number][], opts: { transfers?: [number, number, number][] } = {}): Bundle {
  const stops: BStop[] = Array.from({ length: nStops }, (_, i) => ({ id: `s${i}`, feed: 'test', name: `S${i}`, lat: 37.78, lon: -122.42 + i * 0.01, x: i * 1000, y: 0, station: false }));
  const zones = stops.map((s, i) => ({ id: `z${i}`, nhood: '', lat: s.lat, lon: s.lon, x: s.x, y: 0 }) as unknown as ZoneAttrs);
  const bl: BLine[] = lines.map(([st, min, trips], i) => ({
    id: `l${i}`, feed: 'test', agency: 'Test', route: `R${i}`, routeName: '', mode: 'bus', color: '#000', dir: 0, headsign: '', stops: st,
    periods: { AM: { trips, hops: st.slice(1).map(() => min * 60) } }, cap: 60, seats: 40, path: [], stopAt: [],
  }));
  const conn: number[] = [];
  stops.forEach((_, i) => conn.push(i, i, 0));
  const header = { version: 1, built: '', sources: [], zones, ext: [], stops, lines: bl, fares: { test: { board: 0, perKm: 0 } }, gateways: [], observed: {} as never, calibration: null } as unknown as Omit<BundleHeader, 'arrays'>;
  const bytes = encodeBundle(header, {
    connectors: Int32Array.from(conn),
    extConnectors: new Int32Array(0),
    transfers: Int32Array.from((opts.transfers ?? []).flat()),
  });
  return decodeBundle(bytes);
}
const today = { name: 't', edits: [] };

describe('beta3 bundle', () => {
  it('round-trips typed arrays at any offset', () => {
    const b = encodeBundle({ version: 1 } as never, { a: Float32Array.from([1.5, 2.5]), b: Uint16Array.from([7, 8, 9]), c: Int32Array.from([-3]) });
    // a Node Buffer view into a bigger pool must decode the same
    const pooled = Buffer.concat([Buffer.alloc(13), Buffer.from(b)]).subarray(13);
    const d = decodeBundle(pooled);
    expect([...(d.a.a as Float32Array)]).toEqual([1.5, 2.5]);
    expect([...(d.a.b as Uint16Array)]).toEqual([7, 8, 9]);
    expect([...(d.a.c as Int32Array)]).toEqual([-3]);
  });
});

describe('beta3 optimal strategies', () => {
  it('combines common lines in proportion to frequency (Spiess & Florian)', () => {
    // the classic split by frequency (PATH.lineSplit 'frequency'; the model uses 'information')
    const split = PATH.lineSplit;
    PATH.lineSplit = 'frequency';
    // two lines from stop 0 to 1: 10 min every 10 min, and 12 min every 10 min (AM is 240 min: 24 trips)
    const b = toy(2, [
      [[0, 1], 10, 24],
      [[0, 1], 12, 24],
    ]);
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(1);
    // wait: weight × ½ / F with F = 0.2 per min; ride: average of 10 and 12
    const expectWait = (PATH.waitWeight * 0.5) / 0.2;
    expect(s.u[0]).toBeCloseTo(expectWait + 11, 4);
    expect(s.C[0 * NC + C_WAIT]).toBeCloseTo(2.5, 4);
    expect(s.C[0 * NC + C_IVT]).toBeCloseTo(11, 4);
    expect(s.C[0 * NC + C_BOARDS]).toBeCloseTo(1, 6);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    const v = lineVolumes(net, s.linkVol);
    expect(v.on[0][0]).toBeCloseTo(50, 4);
    expect(v.on[1][0]).toBeCloseTo(50, 4);
    PATH.lineSplit = split;
  });

  it('with arrival information, favors the faster of two equally frequent lines', () => {
    // as above, informed riders (Gentile, Nguyen & Pallottino 2005): no worse than the frequency split,
    // and more of them on the faster line
    const split = PATH.lineSplit;
    PATH.lineSplit = 'information';
    const b = toy(2, [
      [[0, 1], 10, 24],
      [[0, 1], 12, 24],
    ]);
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(1);
    expect(s.u[0]).toBeLessThanOrEqual((PATH.waitWeight * 0.5) / 0.2 + 11 + 1e-9);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    const v = lineVolumes(net, s.linkVol);
    expect(v.on[0][0]).toBeGreaterThan(50);
    expect(v.on[0][0] + v.on[1][0]).toBeCloseTo(100, 4);
    PATH.lineSplit = split;
  });

  it('mixes informed riders with riders who take the first line, by PATH.informedShare', () => {
    const split = PATH.lineSplit, share = PATH.informedShare;
    PATH.lineSplit = 'information';
    const b = toy(2, [
      [[0, 1], 10, 24],
      [[0, 1], 12, 24],
    ]);
    const run = (a: number) => {
      PATH.informedShare = a;
      const net = buildNet(b, today, 'AM', null);
      const s = new StrategySolver(net);
      s.solve(1);
      s.resetVolumes();
      s.load((o) => (o === 0 ? 100 : 0));
      return { u: s.u[0], on: lineVolumes(net, s.linkVol).on[0][0] };
    };
    const none = run(0), all = run(1), half = run(0.5);
    // nobody informed: the optimal-strategy cost and frequency split
    expect(none.u).toBeCloseTo((PATH.waitWeight * 0.5) / 0.2 + 11, 4);
    expect(none.on).toBeCloseTo(50, 4);
    expect(half.u).toBeCloseTo((none.u + all.u) / 2, 6);
    expect(half.on).toBeCloseTo((none.on + all.on) / 2, 4);
    PATH.lineSplit = split;
    PATH.informedShare = share;
  });

  it('runs lines as observed: running times, trips run, and the cost of their spread', () => {
    const ops = PATH.observedOps, rr = PATH.reliabilityRatio;
    const b = toy(2, [[[0, 1], 10, 24]]);
    const l = b.header.lines[0];
    l.runFactor = { AM: 1.1 };
    l.delivered = { AM: 0.8 };
    l.rideSD = { AM: { a: 1, b: 0.1 } };
    PATH.observedOps = true;
    PATH.reliabilityRatio = 1.2;
    const net = buildNet(b, today, 'AM', null);
    // 19.2 of 24 trips: every 12.5 minutes; ride 11 minutes; spread 1 + 0.1 × 11 = 2.1 minutes
    expect(net.lines[0].freq).toBeCloseTo(0.08, 6);
    const s = new StrategySolver(net);
    s.solve(1);
    const wait = (PATH.waitWeight * 0.5) / 0.08;
    expect(s.u[0]).toBeCloseTo(wait + 11 + 1.2 * 2.1, 3);
    PATH.observedOps = false;
    PATH.reliabilityRatio = 0;
    const net0 = buildNet(b, today, 'AM', null);
    const s0 = new StrategySolver(net0);
    s0.solve(1);
    expect(s0.u[0]).toBeCloseTo((PATH.waitWeight * 0.5) / 0.1 + 10, 4);
    PATH.observedOps = ops;
    PATH.reliabilityRatio = rr;
  });

  it('leaves out a line too slow to be worth waiting for', () => {
    // 10 min every 10 min, versus 40 min every 10 min: waiting for either is not worth the slow ride
    const b = toy(2, [
      [[0, 1], 10, 24],
      [[0, 1], 40, 24],
    ]);
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(1);
    expect(s.u[0]).toBeCloseTo((PATH.waitWeight * 0.5) / 0.1 + 10, 4);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 10 : 0));
    const v = lineVolumes(net, s.linkVol);
    expect(v.on[0][0]).toBeCloseTo(10, 6);
    expect(v.on[1][0]).toBe(0);
  });

  it('counts a transfer and its penalty', () => {
    // 0→1 on one line, 1→2 on another
    const b = toy(3, [
      [[0, 1], 5, 24],
      [[1, 2], 5, 24],
    ]);
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(2);
    expect(s.C[0 * NC + C_BOARDS]).toBeCloseTo(2, 6);
    expect(s.u[0]).toBeCloseTo(2 * ((PATH.waitWeight * 0.5) / 0.1) + 10 + transferPenalty(null), 4);
    // and loads every rider on both lines
    s.resetVolumes();
    s.load((o) => (o === 0 ? 30 : 0));
    const v = lineVolumes(net, s.linkVol);
    expect(v.load[0][0]).toBeCloseTo(30, 6);
    expect(v.load[1][0]).toBeCloseTo(30, 6);
    expect(v.off[1][1]).toBeCloseTo(30, 6);
  });

  it('never lets a trip skip transit by walking zone to zone', () => {
    const b = toy(2, [[[0, 1], 5, 24]], { transfers: [[0, 1, 30]] });
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(1);
    expect(s.C[0 * NC + C_BOARDS]).toBeGreaterThanOrEqual(1);
  });

  it('applies scenario edits: removal and frequency', () => {
    const b = toy(2, [
      [[0, 1], 10, 24],
      [[0, 1], 12, 24],
    ]);
    const removed = buildNet(b, { name: 'x', edits: [{ kind: 'remove', route: 'R1', feed: 'test' }] }, 'AM', null);
    expect(removed.lines.length).toBe(1);
    const doubled = buildNet(b, { name: 'x', edits: [{ kind: 'frequency', route: 'R0', feed: 'test', factor: { AM: 2 } }] }, 'AM', null);
    expect(doubled.lines.find((l) => l.route === 'R0')!.trips).toBe(48);
  });
  it('puts the rail preference (PATH.railBonus) on bus rides in route choice only', () => {
    const b = toy(2, [[[0, 1], 10, 24]]);
    const alights = (n: ReturnType<typeof buildNet>) => [...n.type.keys()].filter((i) => n.type[i] === 2);
    const n0 = buildNet(b, today, 'AM', null);
    PATH.railBonus = 3.3;
    try {
      const n1 = buildNet(b, today, 'AM', null);
      for (const i of alights(n0)) {
        expect(n1.cost[i] - n0.cost[i]).toBeCloseTo(3.3, 5);
        // the components that mode choice reads are unchanged
        for (let k = 0; k < NC; k++) expect(n1.comp[i * NC + k]).toBe(n0.comp[i * NC + k]);
      }
    } finally {
      PATH.railBonus = 0;
    }
  });
});

describe('beta3 crowding', () => {
  it('is neutral when empty and grows past seated capacity', () => {
    expect(crowdMultiplier(0, 100, 50)).toBe(1);
    const half = crowdMultiplier(40, 100, 50);
    const full = crowdMultiplier(100, 100, 50);
    const over = crowdMultiplier(130, 100, 50);
    expect(half).toBeGreaterThanOrEqual(1);
    expect(full).toBeGreaterThan(half);
    expect(over).toBeGreaterThan(full);
  });
});

describe('beta3 capacity at boarding', () => {
  it('works out the chance of failing to board and the extra wait (Cepeda, Cominetti & Florian)', () => {
    // one hour holding the whole period, to check by hand
    const hours = LOAD_HOURS.AM;
    LOAD_HOURS.AM = [[1, 1]];
    try {
      // 100 places an hour, 60 riders already on board: room for 40
      expect(boardingAvailability(0, 60, 100, 'AM')).toEqual({ avail: 1, leftBehind: 0, overCap: 0 });
      // 20 want to board: (20/40)^β of them fail at the first vehicle, and wait a headway for the next
      const p = 0.5 ** CAPACITY.beta;
      const r = boardingAvailability(20, 60, 100, 'AM');
      expect(r.leftBehind).toBeCloseTo(20 * p, 6);
      expect(r.overCap).toBe(0);
      // expected extra headways 1/(1 − p) − 1, so availability 1 − p
      expect(r.avail).toBeCloseTo(1 - p, 6);
      // 50 want to board with room for 40: everyone fails as often as the floor allows, and 10 cannot fit
      const full = boardingAvailability(50, 60, 100, 'AM');
      expect(full.overCap).toBeCloseTo(10, 6);
      expect(full.avail).toBeCloseTo(CAPACITY.minAvail, 6);
      expect(full.leftBehind).toBeCloseTo(50 * (1 - CAPACITY.minAvail), 6);
      // a full vehicle arriving (through load at capacity) leaves everyone behind
      expect(boardingAvailability(5, 100, 100, 'AM').avail).toBeCloseTo(CAPACITY.minAvail, 6);
    } finally {
      LOAD_HOURS.AM = hours;
    }
    // over the real hours: the busiest hour binds first, and availability falls as the load rises
    const a = boardingAvailability(200, 400, 1000, 'AM').avail, b = boardingAvailability(200, 600, 1000, 'AM').avail;
    expect(a).toBeLessThanOrEqual(1);
    expect(b).toBeLessThan(a);
  });

  it('lowers the frequency a rider sees at a full stop, so riders move to the other line', () => {
    const b = toy(2, [
      [[0, 1], 10, 24],
      [[0, 1], 10, 24],
    ]);
    // line 0 boards half its riders at stop 0: one hop's crowding (1), then each stop's availability
    const crowd = [Float32Array.from([1, 0.5, 1]), Float32Array.from([1, 1, 1])];
    const split = PATH.lineSplit;
    PATH.lineSplit = 'frequency';
    try {
      const net = buildNet(b, today, 'AM', null, crowd);
      const s = new StrategySolver(net);
      s.solve(1);
      s.resetVolumes();
      s.load((o) => (o === 0 ? 100 : 0));
      const v = lineVolumes(net, s.linkVol);
      // line 0's wait: ½ headway + one more headway (1/0.5 − 1), so its frequency is a third
      const f0 = capacityFreq(0.1, 10, 0.5);
      expect(f0).toBeCloseTo(0.5 / 15, 6);
      expect(v.on[0][0]).toBeCloseTo((100 * f0) / (f0 + 0.1), 3);
      expect(v.on[0][0] + v.on[1][0]).toBeCloseTo(100, 4);
    } finally {
      PATH.lineSplit = split;
    }
    // with room everywhere the frequency is unchanged
    expect(capacityFreq(0.1, 10, 1)).toBe(0.1);
  });
});

import { effectiveFreq, C_FARE, LINK_ACCESS } from '../shared/beta3/net';
import { CLIPPER_NEXTGEN_SHARE, MUNI_FARE, MUNI_PASS_SHARE } from '../shared/beta3/params';
import { encodeResult, decodeResult } from '../shared/beta3/results';
import { bundleId } from '../shared/beta3/bundle';

/** like toy(), but on Muni (so the per-trip fare applies) and with optional extra access links */
function toyMuni(nStops: number, lines: [number[], number, number][], extraConn: [number, number, number][] = []) {
  const b = toy(nStops, lines);
  b.header.lines.forEach((l) => (l.feed = 'muni'));
  b.header.stops.forEach((s) => (s.feed = 'muni'));
  const conn = [...(b.a.connectors as Int32Array), ...extraConn.flat()];
  b.a.connectors = Int32Array.from(conn);
  return b;
}

describe('beta3 network details', () => {
  it('charges the Muni fare once per trip, transfers free', () => {
    const b = toyMuni(3, [
      [[0, 1], 5, 24],
      [[1, 2], 5, 24],
    ]);
    const s = new StrategySolver(buildNet(b, today, 'AM', null));
    s.solve(2);
    expect(s.C[0 * NC + C_BOARDS]).toBeCloseTo(2, 6);
    expect(s.C[0 * NC + C_FARE]).toBeCloseTo(MUNI_FARE * (1 - MUNI_PASS_SHARE), 6);
  });

  it('spreads a zone over its access stops with a logit on their cost', () => {
    // zone 0 can reach stop 0 (no walk) or stop 1 (a 5-minute walk); both lines go to stop 2
    const b = toyMuni(3, [
      [[0, 2], 10, 24],
      [[1, 2], 10, 24],
    ], [[0, 1, 300]]);
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(2);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    let near = 0, far = 0;
    for (let a = 0; a < net.nLinks; a++) {
      if (net.type[a] !== LINK_ACCESS || net.tail[a] !== 0) continue;
      if (net.head[a] === net.nZones + net.nStops + 0) near += s.linkVol[a];
      if (net.head[a] === net.nZones + net.nStops + 1) far += s.linkVol[a];
    }
    expect(near + far).toBeCloseTo(100, 6);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    // the zone's cost is no worse than its best stop's (access carries walking ×2 and the Muni fare in minutes)
    const fareMin = MUNI_FARE / PATH.votPerMin;
    const best = Math.min(s.u[net.nZones + net.nStops + 0] + fareMin, s.u[net.nZones + net.nStops + 1] + 2 * 5 + fareMin);
    expect(s.u[0]).toBeLessThanOrEqual(best + 1e-9);
  });

  it('counts long headways partly as timed arrivals', () => {
    expect(effectiveFreq(1 / 10)).toBeCloseTo(1 / 10, 9);
    // 60-minute headway → 15 + 0.5 × 45 = 37.5 effective
    expect(effectiveFreq(1 / 60)).toBeCloseTo(1 / 37.5, 9);
    expect(effectiveFreq(0)).toBe(0);
  });

  it('lengthens the wait on an unevenly spaced line, but not the planned part of a long headway', () => {
    // every 10 minutes, bunched (wait factor 1.4): waits as if every 14
    expect(effectiveFreq(1 / 10, 1.4)).toBeCloseTo(1 / 14, 9);
    // every 60 minutes: only the random-arrival part (the first 15) is stretched → 21 + 22.5
    expect(effectiveFreq(1 / 60, 1.4)).toBeCloseTo(1 / (15 * 1.4 + 0.5 * 45), 9);
  });

  it('numbers new stops the same in every period, running or not', () => {
    const b = toy(2, [[[0, 1], 10, 24]]);
    // zone block points, used to connect new stops to zones
    b.a.zonePtStart = Int32Array.from([0, 1, 2]);
    b.a.zonePtX = Float32Array.from([0, 1000]);
    b.a.zonePtY = Float32Array.from([0, 0]);
    b.a.zonePtW = Float32Array.from([1, 1]);
    const edit = {
      kind: 'newLine' as const, id: 'x', name: 'X', mode: 'bus' as const, color: '#000',
      stops: [{ lat: 37.78, lon: -122.42 }, { stop: 1 }, { lat: 37.781, lon: -122.41 }],
      path: [], stopAt: [], headway: { AM: 10, MD: 0, PM: 10, NT: 0 }, hops: [60, 60], bothDirections: false,
    };
    const am = buildNet(b, { name: 's', edits: [edit] }, 'AM', null);
    const md = buildNet(b, { name: 's', edits: [edit] }, 'MD', null);
    expect(am.newStops.length).toBe(2);
    expect(md.newStops.length).toBe(2);
    expect(md.lines.some((l) => l.newId === 'x')).toBe(false);
    expect(am.lines.find((l) => l.newId === 'x')!.stops).toEqual([2, 1, 3]);
  });
});

describe('beta3 results', () => {
  it('round-trips a result, crowding and its bundle fingerprint', () => {
    const r = {
      scenario: 'x', ms: 1, bundleId: 'b#1',
      summary: { trips: { da: 1, sr: 2, tnc: 0, transit: 3, walk: 4, bike: 0 }, residentTrips: { da: 1, sr: 2, tnc: 0, transit: 3, walk: 4, bike: 0 }, byPurpose: {}, boardings: { muni: 5 }, transitTrips: 3, vkt: 9, logsum: 1, opCost: 2, revenueHours: 3, avgTransitMin: 30 },
      lines: [{ line: 0, boardings: { AM: 1, MD: 2, PM: 3, NT: 4 }, loads: { AM: Float32Array.from([1, 2]), MD: Float32Array.from([3]), PM: new Float32Array(0), NT: new Float32Array(0) }, peakLoadFactor: 0.5, revenueHours: 1, passengerKm: 2 }],
      stopOn: Float32Array.from([1]), stopOff: Float32Array.from([2]), zoneTransitShare: Float32Array.from([0.1]), zoneJobs45: Float32Array.from([5]), zoneLogsum: Float32Array.from([-1]),
      finalCrowd: { AM: { 0: Float32Array.from([1.2]) }, MD: {}, PM: {}, NT: {} },
    };
    const d = decodeResult(encodeResult(r as never));
    expect(d.bundleId).toBe('b#1');
    expect([...d.lines[0].loads.AM]).toEqual([1, 2]);
    expect(d.finalCrowd!.AM[0][0]).toBeCloseTo(1.2, 5);
    expect(d.summary.transitTrips).toBe(3);
  });

  it('gives a different fingerprint when the calibration changes', () => {
    const a = bundleId({ built: 't', calibration: { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 1, outShare: 0, airportTrips: 0, iterations: 1, report: [] } });
    const c = bundleId({ built: 't', calibration: { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 2, outShare: 0, airportTrips: 0, iterations: 1, report: [] } });
    expect(a).not.toBe(c);
  });
});

import { scenarioLines, STOP_LOST_SEC } from '../shared/beta3/net';

describe('beta3 stop edits', () => {
  const b3 = () => {
    const b = toy(3, [[[0, 1, 2], 5, 24]]);
    b.a.zonePtStart = Int32Array.from([0, 1, 2, 3]);
    b.a.zonePtX = Float32Array.from([0, 1000, 2000]);
    b.a.zonePtY = Float32Array.from([0, 0, 0]);
    b.a.zonePtW = Float32Array.from([1, 1, 1]);
    return b;
  };
  it('removes a middle stop and saves its lost time', () => {
    const b = b3();
    const { lines } = scenarioLines(b, { name: 's', edits: [{ kind: 'removeStop', route: 'R0', feed: 'test', stop: 1 }] }, 'AM');
    expect(lines[0].stops).toEqual([0, 2]);
    expect(lines[0].hops).toEqual([600 - STOP_LOST_SEC]);
    // a terminus is never removed
    const t = scenarioLines(b, { name: 's', edits: [{ kind: 'removeStop', route: 'R0', feed: 'test', stop: 0 }] }, 'AM');
    expect(t.lines[0].stops).toEqual([0, 1, 2]);
  });
  it('inserts a stop between two consecutive stops, with access to nearby zones', () => {
    const b = b3();
    const edit = { kind: 'addStop' as const, id: 'a', route: 'R0', feed: 'test', between: [1, 2] as [number, number], lat: 37.78, lon: -122.4, name: 'Mid' };
    const { lines, newStops } = scenarioLines(b, { name: 's', edits: [edit] }, 'AM');
    expect(newStops.length).toBe(1);
    expect(lines[0].stops).toEqual([0, 1, 3, 2]);
    expect(lines[0].hops.length).toBe(3);
    expect(lines[0].hops[1] + lines[0].hops[2]).toBeCloseTo(300 + STOP_LOST_SEC, 6);
  });
});

describe('beta3 line extensions', () => {
  it('extends patterns ending at the terminus and prepends them for patterns starting there', () => {
    const b = toy(3, [
      [[0, 1], 5, 24],
      [[1, 0], 5, 24],
    ]);
    b.header.lines.forEach((l) => (l.route = 'R'));
    b.a.zonePtStart = Int32Array.from([0, 1, 2, 3]);
    b.a.zonePtX = Float32Array.from([0, 1000, 2000]);
    b.a.zonePtY = Float32Array.from([0, 0, 0]);
    b.a.zonePtW = Float32Array.from([1, 1, 1]);
    const edit = { kind: 'extend' as const, id: 'e', route: 'R', feed: 'test', from: 1, stops: [{ lat: 37.78, lon: -122.405 }, { stop: 2 }], hops: [60, 90] };
    const { lines, newStops } = scenarioLines(b, { name: 's', edits: [edit] }, 'AM');
    expect(newStops.length).toBe(1);
    expect(lines[0].stops).toEqual([0, 1, 3, 2]);
    expect(lines[0].hops).toEqual([300, 60, 90]);
    expect(lines[1].stops).toEqual([2, 3, 1, 0]);
    expect(lines[1].hops).toEqual([90, 60, 300]);
  });
});

describe('beta3 park-and-ride access', () => {
  it('charges a lot fee to drivers, on the way in', () => {
    // an outside zone 10 minutes' drive from stop 0, paying $2.00 of parking per leg; a line from stop 0 to stop 1
    const base = toy(2, [[[0, 1], 10, 12]]);
    const H = { ...base.header, ext: [{ id: 'x0', name: 'Outside', county: 'Test', lat: 37.7, lon: -122.3, x: -5000, y: 0, toSF: 1, fromSF: 0 }] } as unknown as Omit<BundleHeader, 'arrays'>;
    const b = decodeBundle(encodeBundle(H, { connectors: base.a.connectors as Int32Array, extConnectors: Int32Array.from([0, 0, 600, 200, 900, EXT_DRIVE]), transfers: new Int32Array(0) }));
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(1);
    const o = b.header.zones.length; // the outside zone's home end comes after the city's zones
    expect(s.C[o * NC + C_FARE]).toBeCloseTo(2, 6);
    // its cost: 2 × 10 minutes of access + the fee in minutes + wait and ride
    expect(s.u[o]).toBeGreaterThan(2 * 10 + 2 / PATH.votPerMin);
  });
  it("reaches an outside zone's activity end on foot or by bus, never by car", () => {
    // a drive record (10 minutes, $2 a leg) and a bus record (15 minutes) to stop 0
    const base = toy(2, [[[0, 1], 10, 12]]);
    const H = { ...base.header, ext: [{ id: 'x0', name: 'Outside', county: 'Test', lat: 37.7, lon: -122.3, x: -5000, y: 0, toSF: 1, fromSF: 0 }] } as unknown as Omit<BundleHeader, 'arrays'>;
    const b = decodeBundle(encodeBundle(H, { connectors: base.a.connectors as Int32Array, extConnectors: Int32Array.from([0, 0, 600, 200, 900, EXT_DRIVE, 0, 0, 900, 0, 900, EXT_BUS]), transfers: new Int32Array(0) }));
    const net = buildNet(b, today, 'AM', null);
    expect(net.nZones).toBe(transitZones(b.header));
    const s = new StrategySolver(net);
    s.solve(1);
    const a = activityEnd(b.header, 0);
    expect(s.C[a * NC + C_FARE]).toBeCloseTo(0, 6);
    expect(s.u[a]).toBeGreaterThan(2 * 15);
  });
  it('prices a full lot: its shadow price moves drivers to the bus', () => {
    const base = toy(2, [[[0, 1], 10, 12]]);
    const H = { ...base.header, ext: [{ id: 'x0', name: 'Outside', county: 'Test', lat: 37.7, lon: -122.3, x: -5000, y: 0, toSF: 1, fromSF: 0 }] } as unknown as Omit<BundleHeader, 'arrays'>;
    const b = decodeBundle(encodeBundle(H, { connectors: base.a.connectors as Int32Array, extConnectors: Int32Array.from([0, 0, 600, 0, 900, EXT_DRIVE, 0, 0, 900, 0, 900, EXT_BUS]), transfers: new Int32Array(0) }));
    const o = b.header.zones.length;
    const driveShare = (lot?: Float32Array) => {
      const net = buildNet(b, today, 'AM', null, undefined, lot);
      const s = new StrategySolver(net);
      s.solve(1);
      s.resetVolumes();
      s.load((z) => (z === o ? 1 : 0));
      let drive = 0;
      for (let a = 0; a < net.nLinks; a++) if (net.extRec[a] === 0 && net.type[a] === LINK_ACCESS) drive += s.linkVol[a];
      return drive;
    };
    const free = driveShare();
    const lot = new Float32Array(b.header.stops.length);
    lot[0] = 20;
    expect(free).toBeGreaterThan(0.9);
    expect(driveShare(lot)).toBeLessThan(0.1);
    // the price rises while the cars exceed the room and falls back when they don't
    const up = updateLotPrices(new Float32Array([0]), Float64Array.from([200]), Float64Array.from([100]));
    expect(up[0]).toBeCloseTo(PARK_AND_RIDE.step * Math.log(2), 4);
    expect(updateLotPrices(up, Float64Array.from([40]), Float64Array.from([100]))[0]).toBe(0);
  });
});

describe('beta3 example scenarios', () => {
  it('the Portal example extends Caltrain from its San Francisco station in the current bundle', async () => {
    const fs = await import('node:fs');
    const zlib = await import('node:zlib');
    const portal = JSON.parse(fs.readFileSync('client/beta3/model/portal-scenario.json', 'utf8'));
    expect(portal.edits.length).toBeGreaterThan(0);
    const b = decodeBundle(zlib.gunzipSync(fs.readFileSync('client/beta3/model/sf.bin.gz')));
    for (const e of portal.edits) {
      const st = b.header.stops[e.kind === 'extend' ? e.from : e.stop];
      expect(st.feed).toBe('caltrain');
      expect(st.name).toMatch(/^San Francisco/);
      expect(b.header.lines.some((l) => l.feed === 'caltrain' && l.route === e.route)).toBe(true);
    }
  });
});

describe('beta3 fares across operators', () => {
  // stops 0–1 Muni, 2–4 BART; a Muni line 0→1, BART lines 2→3 and 3→4, a walk from stop 1 to stop 2
  const twoOps = () => {
    const b = toy(5, [
      [[0, 1], 5, 24],
      [[2, 3], 5, 24],
      [[3, 4], 5, 24],
    ], { transfers: [[1, 2, 60]] });
    b.header.stops.forEach((s, i) => (s.feed = i < 2 ? 'muni' : 'bart'));
    b.header.lines.forEach((l, i) => (l.feed = i === 0 ? 'muni' : 'bart'));
    (b.header.fares as Record<string, { board: number; perKm: number }>).bart = { board: 4, perKm: 0 };
    return b;
  };
  it('takes the Clipper discount off the second operator, and charges BART once across a line change', () => {
    const net = buildNet(twoOps(), today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(4);
    // Muni then BART: Muni's expected fare (pass holders pay nothing), then BART less the $2.85
    // discount for riders on the new Clipper system, the full fare for the rest
    expect(s.C[0 * NC + C_FARE]).toBeCloseTo(MUNI_FARE * (1 - MUNI_PASS_SHARE) + CLIPPER_NEXTGEN_SHARE * (4 - 2.85) + (1 - CLIPPER_NEXTGEN_SHARE) * 4, 6);
    // BART changing lines at stop 3: one boarding fare
    expect(s.C[2 * NC + C_FARE]).toBeCloseTo(4, 6);
    expect(s.C[2 * NC + C_BOARDS]).toBeCloseTo(2, 6);
  });
  it('charges the old system’s rule: $0.50 off Muni for riders who pay per ride, nothing off BART', () => {
    // BART 2→3, then walk to Muni's stop 1 and ride 1→0 (the reverse network)
    const b = toy(5, [
      [[2, 3], 5, 24],
      [[1, 0], 5, 24],
    ], { transfers: [[3, 1, 60]] });
    b.header.stops.forEach((s, i) => (s.feed = i < 2 ? 'muni' : 'bart'));
    b.header.lines.forEach((l, i) => (l.feed = i === 0 ? 'bart' : 'muni'));
    (b.header.fares as Record<string, { board: number; perKm: number }>).bart = { board: 4, perKm: 0 };
    const old = buildNet(b, { name: 'old', edits: [], context: { transferDiscount: 0.5, transferDiscountMuniOnly: true } }, 'AM', null);
    const s = new StrategySolver(old);
    s.solve(0);
    expect(s.C[2 * NC + C_FARE]).toBeCloseTo(4 + (1 - MUNI_PASS_SHARE) * (MUNI_FARE - 0.5), 6);
    const now = buildNet(b, today, 'AM', null);
    const t = new StrategySolver(now);
    t.solve(0);
    expect(t.C[2 * NC + C_FARE]).toBeCloseTo(4 + (1 - CLIPPER_NEXTGEN_SHARE) * (1 - MUNI_PASS_SHARE) * (MUNI_FARE - 0.5), 6);
  });
});

describe('beta3 leg periods', () => {
  const sum = (a: Float64Array) => a.reduce((x, v) => x + v, 0);
  it('spreads each leg over the four periods by its tour time-of-day shares', () => {
    for (const [p, t] of Object.entries(TOD)) {
      const w = legWeights(t, p === 'nhb');
      expect(sum(w.out)).toBeCloseTo(1, 9);
      expect(sum(w.back)).toBeCloseTo(1, 9);
    }
    // TPERIODS order AM, MD, PM, NT: commutes leave in the morning peak, social tours come home at night
    const work = legWeights(TOD.work, false), social = legWeights(TOD.social, false);
    expect(work.out[0]).toBeGreaterThan(0.6);
    expect(work.back[2]).toBeGreaterThan(0.6);
    expect(social.back[3]).toBeGreaterThan(0.3);
    expect(social.back[3]).toBeGreaterThan(social.out[3]);
    // a round trip is half out, half back
    expect(work.outShare).toBeCloseTo(0.5, 2);
    expect(work.backShare).toBeCloseTo(0.5, 2);
  });
  it('sends every trip not from home out, one way', () => {
    const w = legWeights(TOD.nhb, true);
    expect(w.outShare).toBeCloseTo(1, 6);
    expect(w.backShare).toBe(0);
  });
});

describe('beta3 getting off', () => {
  /**
   * stops 0–3 in a row, a line each way (5 minutes a hop); zone 3 has two blocks, one at stop 2 and
   * one at stop 3, five minutes' walk apart, and reaches both stops
   */
  const twoBlocks = () => {
    const b = toy(4, [
      [[0, 1, 2, 3], 5, 24],
      [[3, 2, 1, 0], 5, 24],
    ]);
    // (zone, stop, zone-mean seconds): zones 0–2 at their stops; zone 3 at stops 3 and 2
    b.a.connectors = Int32Array.from([0, 0, 0, 1, 1, 0, 2, 2, 0, 3, 3, 150, 3, 2, 150]);
    b.a.zonePtStart = Int32Array.from([0, 1, 2, 3, 5]);
    b.a.zonePtX = Float32Array.from([0, 1000, 2000, 2000, 3000]);
    b.a.zonePtY = Float32Array.from([0, 0, 0, 0, 0]);
    b.a.zonePtW = Float32Array.from([1, 1, 1, 1, 1]);
    // each connector's walk from each block of its zone, seconds: zone 3's blocks to stop 3, then to stop 2
    b.a.connectorPts = Uint16Array.from([0, 0, 0, 300, 0, 0, 300]);
    return b;
  };
  // each test sets PATH.egressLogit itself (on by default)
  const withEgress = (on: boolean, f: () => void) => {
    const prev = PATH.egressLogit;
    PATH.egressLogit = on;
    try {
      f();
    } finally {
      PATH.egressLogit = prev;
    }
  };
  const offAt = (net: ReturnType<typeof buildNet>, vol: Float64Array, line: number) => lineVolumes(net, vol).off[line];

  it('spreads riders over the stops where they can get off, block by block, by the logit of getting on', () => withEgress(true, () => {
    const b = twoBlocks();
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(3);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    const off = offAt(net, s.linkVol, 0);
    // the block at stop 2: off there (no walk) or ride on 5 minutes and walk back 5 (×2); the block at
    // stop 3: walk 5 (×2) from stop 2, or ride on
    const th = PATH.accessTheta, w = PATH.walkWeight;
    const pA = 1 / (1 + Math.exp(-th * (5 + 5 * w))), pB = 1 / (1 + Math.exp(-th * (5 - 5 * w)));
    expect(off[2]).toBeCloseTo(50 * (pA + pB), 4);
    expect(off[2] + off[3]).toBeCloseTo(100, 4);
    // the origin's cost: the wait, the ride to stop 2, and the blocks' mean logsum from there
    const lsA = -Math.log(Math.exp(0) + Math.exp(-th * (5 + 5 * w))) / th;
    const lsB = -Math.log(Math.exp(-th * 5 * w) + Math.exp(-th * 5)) / th;
    const wait = (PATH.waitWeight * 0.5) / 0.1;
    expect(s.u[0]).toBeCloseTo(wait + 10 + (lsA + lsB) / 2, 4);
    // and the walk is the expected walk
    expect(s.C[0 * NC + C_IVT]).toBeCloseTo(10 + 5 * (1 - (pA + pB) / 2), 4);
  }));

  it('gets off as it gets on: the way back boards where the way there got off', () => withEgress(true, () => {
    const b = twoBlocks();
    const net = buildNet(b, today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(3);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    const there = offAt(net, s.linkVol, 0);
    s.solve(0);
    s.resetVolumes();
    s.load((o) => (o === 3 ? 100 : 0));
    const back = lineVolumes(net, s.linkVol).on[1];
    // the return line runs 3, 2, 1, 0: stop 3 is its position 0, stop 2 its position 1
    expect(back[1]).toBeCloseTo(there[2], 4);
    expect(back[0]).toBeCloseTo(there[3], 4);
  }));

  it('without the logit, every rider gets off at the one stop best for the zone', () => withEgress(false, () => {
    const net = buildNet(twoBlocks(), today, 'AM', null);
    const s = new StrategySolver(net);
    s.solve(3);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    const off = offAt(net, s.linkVol, 0);
    expect(Math.max(off[2], off[3])).toBeCloseTo(100, 6);
  }));
});

describe('beta3 background riders', () => {
  it('keeps a pattern\'s background on it, and hands it to the patterns serving the same stops when it is removed', async () => {
    const { backgroundLoads } = await import('../shared/beta3/background');
    const { scenarioLines } = await import('../shared/beta3/net');
    // R0 runs 0-1-2-3 with 24 trips, R1 runs 0-2-3 (skipping 1) with 8 trips
    const b = toy(4, [
      [[0, 1, 2, 3], 5, 24],
      [[0, 2, 3], 6, 8],
    ]);
    b.header.lines[1].bg = { wkd: { AM: [100, 40] } };
    const lines = scenarioLines(b, today, 'AM').lines;
    const bg = backgroundLoads(b, lines, 'AM')!;
    expect([...bg[1]]).toEqual([100, 40]);
    expect([...bg[0]]).toEqual([0, 0, 0]);
    // with R1 gone, R0 carries its riders over every hop between the same stations
    const gone = scenarioLines(b, { name: 'x', edits: [{ kind: 'remove', route: 'R1', feed: 'test' }] }, 'AM').lines;
    const bg2 = backgroundLoads(b, gone, 'AM')!;
    // R0 and R1 ran 32 trips between 0 and 2, R0 alone runs 24: the riders scale by (24/32)^0.5
    const g = Math.sqrt(24 / 32);
    expect(bg2[0][0]).toBeCloseTo(100 * g, 4);
    expect(bg2[0][1]).toBeCloseTo(100 * g, 4);
    expect(bg2[0][2]).toBeCloseTo(40 * g, 4);
    // twice R1's trips: its riders by the frequency elasticity, +41%
    const more = scenarioLines(b, { name: 'x', edits: [{ kind: 'frequency', route: 'R1', feed: 'test', factor: { AM: 2 } }] }, 'AM').lines;
    expect(backgroundLoads(b, more, 'AM')![1][0]).toBeCloseTo(100 * Math.SQRT2, 4);
    // no background in another period
    expect(backgroundLoads(b, lines, 'MD')).toBeNull();
  });

  it('recovers each line\'s boarding-to-alighting journeys from an assignment', async () => {
    const { stationPairs } = await import('../server/beta3/pipeline/station-od');
    const b = toy(4, [[[0, 1, 2, 3], 5, 24]]);
    const net = buildNet(b, today, 'AM', null);
    const Z = net.nZones;
    const od = new Float32Array(Z * Z);
    od[0 * Z + 2] = 30;
    od[0 * Z + 3] = 20;
    od[1 * Z + 3] = 10;
    const res = stationPairs(net, od, Z, ['test']);
    const R = res.test, n = R.stops.length, at = (s: number) => R.stops.indexOf(s);
    expect(R.pairs[at(0) * n + at(2)]).toBeCloseTo(30, 3);
    expect(R.pairs[at(0) * n + at(3)]).toBeCloseTo(20, 3);
    expect(R.pairs[at(1) * n + at(3)]).toBeCloseTo(10, 3);
    expect(R.pairs[at(0) * n + at(1)]).toBeCloseTo(0, 6);
  });
});

describe('synthetic population layout', () => {
  it('packs and unpacks a person', async () => {
    const { packPerson, unpackPerson } = await import('../shared/beta3/synpop');
    const p = { female: true, employed: true, wfh: false, ptype: 3 as const, student: 2 };
    expect(unpackPerson(packPerson(p))).toEqual(p);
    expect(packPerson({ ...p, ptype: 8, student: 3, wfh: true })).toBeLessThan(256);
  });
  it('counts households and residents by segment', async () => {
    const { segmentTables, packPerson } = await import('../shared/beta3/synpop');
    const f = (age: number, employed: boolean) => packPerson({ female: false, employed, wfh: false, ptype: employed ? 1 : 4, student: 0 });
    const pop = {
      zoneStart: Int32Array.from([0, 2]),
      size: Uint8Array.from([2, 1]),
      veh: Uint8Array.from([0, 3]),
      inc: Uint16Array.from([40, 250]),
      kind: Uint8Array.from([0, 0]),
      age: Uint8Array.from([40, 10, 70]),
      flags: Uint8Array.from([f(40, true), f(10, false), f(70, false)]),
    };
    const t = segmentTables(pop, 1);
    expect(t.households[0][0][0]).toBe(1);
    expect(t.households[2][3][0]).toBe(1);
    expect(t.youth[0][0][0]).toBe(1);
    expect(t.seniors[2][3][0]).toBe(1);
    expect(t.commuters[0][0][0]).toBe(1);
  });
});

describe('beta3 where to change lines (transfer logit)', () => {
  // a fast line 0→1→2→3 (2 min a hop) beside a slower one 4→5→6→7 (3 min a hop), with a change
  // inside each of three shared stations (1–4, 2–5, 3–6); the destination, 7, is on the slow line only
  const stations = () =>
    toy(
      8,
      [
        [[0, 1, 2, 3], 2, 24],
        [[4, 5, 6, 7], 3, 24],
      ],
      { transfers: [[1, 4, 0], [2, 5, 0], [3, 6, 0]] },
    );
  const run = (passes = 2) => {
    const keep = [PATH.transferLogit, PATH.transferPasses] as const;
    PATH.transferLogit = passes > 1;
    PATH.transferPasses = passes;
    try {
      const net = buildNet(stations(), today, 'AM', null);
      const s = new StrategySolver(net);
      s.solve(7);
      s.resetVolumes();
      s.load((o) => (o === 0 ? 100 : 0));
      return { s, v: lineVolumes(net, s.linkVol) };
    } finally {
      [PATH.transferLogit, PATH.transferPasses] = keep;
    }
  };

  it('without it, every rider changes at the one station best for the strategy', () => {
    const { v } = run(1);
    expect(v.on[1][2]).toBeCloseTo(100, 6);
    expect(v.on[1][0] + v.on[1][1]).toBeCloseTo(0, 6);
  });

  it('spreads the change over the stations by the logit of getting on and off, and the logsum is the label', () => {
    const { s, v } = run(2);
    // the rides are 2 + 9, 4 + 6, and 6 + 3 minutes; the waits and the change cost the same at each
    const th = PATH.accessTheta, tot = [11, 10, 9];
    const e = tot.map((t) => Math.exp(-th * t)), E = e[0] + e[1] + e[2];
    for (let j = 0; j < 3; j++) expect(v.on[1][j]).toBeCloseTo((100 * e[j]) / E, 4);
    // everyone still gets there, on both lines
    expect(v.off[1][3]).toBeCloseTo(100, 6);
    expect(v.on[0][0]).toBeCloseTo(100, 6);
    // the origin's label: two waits, the change, and the logsum of the three ways through
    const wait = (PATH.waitWeight * 0.5) / 0.1;
    expect(s.u[0]).toBeCloseTo(2 * wait + transferPenalty(null) - Math.log(E) / th, 4);
    // the expected ride is the riders' mean ride
    expect(s.C[0 * NC + C_IVT]).toBeCloseTo((tot[0] * e[0] + tot[1] * e[1] + tot[2] * e[2]) / E, 4);
    expect(s.C[0 * NC + C_BOARDS]).toBeCloseTo(2, 6);
  });

  it('is exact after one more pass when the onward strategy makes no further change', () => {
    const a = run(2), b = run(3);
    expect(b.s.u[0]).toBeCloseTo(a.s.u[0], 9);
    for (let j = 0; j < 3; j++) expect(b.v.on[1][j]).toBeCloseTo(a.v.on[1][j], 9);
  });

  it('does not count getting off to board the same line, or one running on with it, as a change', () => {
    // a fast and a slow line over the same stops: riders on the fast one stay aboard
    const b = toy(4, [
      [[0, 1, 2, 3], 2, 24],
      [[0, 1, 2, 3], 3, 24],
    ]);
    const keep = PATH.transferLogit;
    PATH.transferLogit = true;
    try {
      const net = buildNet(b, today, 'AM', null);
      const s = new StrategySolver(net);
      s.solve(3);
      s.resetVolumes();
      s.load((o) => (o === 0 ? 100 : 0));
      const v = lineVolumes(net, s.linkVol);
      expect(v.off[0][1] + v.off[0][2] + v.off[1][1] + v.off[1][2]).toBeCloseTo(0, 9);
      expect(v.on[0][1] + v.on[0][2] + v.on[1][1] + v.on[1][2]).toBeCloseTo(0, 9);
      expect(v.off[0][3] + v.off[1][3]).toBeCloseTo(100, 6);
    } finally {
      PATH.transferLogit = keep;
    }
  });
});

describe('beta3 downtown BART station times', () => {
  it('moves riders between the stations, not on or off BART, and both legs together', async () => {
    const { fitStationTimes } = await import('../server/beta3/pipeline/stations-fit');
    const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0.3, outShare: 0.05, airportTrips: 0, iterations: 0, report: [] } as never as Parameters<typeof fitStationTimes>[0];
    const obs = { EMBR: { exits: 20, entries: 20 }, MONT: { exits: 20, entries: 20 }, POWL: { exits: 10, entries: 10 }, CIVC: { exits: 10, entries: 10 } };
    // Montgomery over on both legs, Embarcadero under on both, Powell over on one leg and under on the other
    const model = { EMBR: { exits: 15, entries: 15 }, MONT: { exits: 26, entries: 26 }, POWL: { exits: 12, entries: 10 / 1.2 }, CIVC: { exits: 10, entries: 10 } };
    fitStationTimes(calib, obs, model);
    const t = calib.stationSec!;
    expect(Math.abs(t.EMBR + t.MONT + t.POWL + t.CIVC)).toBeLessThanOrEqual(2);
    expect(t.MONT).toBeGreaterThan(0);
    expect(t.EMBR).toBeLessThan(0);
    // a station off by the same factor in opposite directions on the two legs is left where it is (up to the recentring)
    expect(Math.abs(t.POWL - t.CIVC)).toBeLessThanOrEqual(1);
    // bounded within a minute of the assumed time
    fitStationTimes(calib, obs, { ...model, MONT: { exits: 400, entries: 400 } });
    expect(Math.max(...Object.values(calib.stationSec!).map(Math.abs))).toBeLessThanOrEqual(60);
  });
});

describe('beta3 car ownership', () => {
  // two zones; one household class each (one driver, one worker, $60k)
  const hh = (zone: number, drivers: number, workers: number, income2024: number): AoHousehold => ({ zone, weight: 100, drivers, workers, persons16to17: 0, persons18to24: 0, persons25to34: 1, children0to4: 0, children5to17: 0, income2024 });
  const acc = (t: number): AoAccess => ({ auto: Float32Array.from([9, 9]), transit: Float32Array.from([t, t]), walk: Float32Array.from([6, 6]), savings: Float32Array.from([0.4, 0.4]) });
  const dens = Float32Array.from([20, 20]);
  const asc = TM1_AO.constants.map((c, a) => c + TM1_AO.sanFrancisco[a]);

  it('groups households into classes by zone, drivers, workers, and income class, with mean attributes', () => {
    const c = aoClassesFromHouseholds([hh(0, 1, 1, 60_000), hh(0, 1, 1, 80_000), hh(1, 2, 0, 150_000)]);
    expect(c.length / AO_STRIDE).toBe(2);
    expect(c[AO_F.hh]).toBe(200);
    // income in thousands of 2000 dollars, TM1's first piece capped at 30
    expect(c[AO_F.inc0]).toBeCloseTo(30, 5);
    expect(c[AO_STRIDE + AO_F.drivers]).toBe(1);
    expect(c[AO_STRIDE + AO_F.incClass]).toBe(1);
  });

  it('gives probabilities that sum to one, and fewer cars where transit reaches more', () => {
    const c = aoClassesFromHouseholds([hh(0, 2, 2, 120_000), hh(1, 1, 0, 30_000)]);
    const p = aoProbabilities(c, acc(5), dens, asc, () => undefined);
    for (let i = 0; i < 2; i++) expect(p.slice(i * AO_ALTS, (i + 1) * AO_ALTS).reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
    const cars = (q: Float64Array) => q.reduce((a, v, k) => a + v * (k % AO_ALTS), 0);
    expect(cars(aoProbabilities(c, acc(6), dens, asc, () => undefined))).toBeLessThan(cars(p));
    // two drivers and two workers own more cars than one retired driver
    expect(cars(p.slice(0, AO_ALTS))).toBeGreaterThan(cars(p.slice(AO_ALTS)));
  });

  it('aggregates to households by zone, income class, and car segment', () => {
    const c = aoClassesFromHouseholds([hh(0, 1, 1, 60_000), hh(1, 2, 2, 150_000)]);
    const { hh: z } = aoZoneShares(c, aoProbabilities(c, acc(5), dens, asc, () => undefined), 2);
    // zone 0's households are all in the lower income class, zone 1's in the upper
    expect(z[0] + z[1] + z[2]).toBeCloseTo(100, 4);
    expect(z[3] + z[4] + z[5]).toBeCloseTo(0, 6);
    expect(z[9] + z[10] + z[11]).toBeCloseTo(100, 4);
  });
});

import { fitStudents, outCommuteShares, outCommuteWeights, prepare as prepareDemand, type DemandResult, type Prep } from '../shared/beta3/demand';
import { COLLEGE, MODES, PERSON_FARE, SCHOOL_K5, SCHOOL_LEVELS, SCHOOL_RETURN } from '../shared/beta3/params';
import type { Calibration } from '../shared/beta3/types';

describe('beta3 school and college demand', () => {
  /** a zone with only what prepare() reads */
  const zone = (id: string, o: Partial<ZoneAttrs>): ZoneAttrs =>
    ({ id, nhood: '', lat: 37.75, lon: -122.45, x: 0, y: 0, land: 1, pop: 1000, hh: 400, hhVeh: [100, 200, 100], hhInc: [100, 100, 100, 100], workers: 500, age5to17: 100, age18to24: 50, age65plus: 100, college: 50, commute: [], jobsBy: new Array(20).fill(10), jobs: 200, schools: 0, universities: 0, hotelRooms: 0, attractions: 0, garages: 0, areaType: 3, density: 20000, densityIndex: 10, ...o }) as unknown as ZoneAttrs;
  const bundleOf = (zones: ZoneAttrs[]) => ({ header: { zones, ext: [] }, a: {} }) as unknown as Bundle;

  it('keeps the parameters equal to the reference data they cite', async () => {
    const fs = await import('node:fs');
    const R = JSON.parse(fs.readFileSync('server/beta3/reference/student-travel.json', 'utf8'));
    expect(SCHOOL_LEVELS.map((l) => l.share)).toEqual(['elementary', 'middle', 'high'].map((k) => R.acsEnrollment.modelLevelShares[k]));
    const tm1 = R.tm1SchoolLocation.utilityPerMile;
    expect(SCHOOL_LEVELS[0].dist).toEqual(tm1.gradeschool);
    expect(SCHOOL_LEVELS[1].dist).toEqual(tm1.gradeschool);
    expect(SCHOOL_LEVELS[2].dist).toEqual(tm1.highschool);
    expect(COLLEGE.inPerson).toBe(R.ipeds.totals.inPerson);
    expect(COLLEGE.attendance).toBeCloseTo((R.attendance.daysPerWeek / 5) * (R.attendance.weeksPerYear / 52), 10);
    expect(SCHOOL_K5.under1mi).toBe(R.sfusd.k5Distance2017.lessThan1mi);
    const K = R.sfusd.k5Mode2019, avg = (k: string) => (K.kindergarten[k] + K.grade5[k]) / 2;
    const yellow = R.sfusd.yellowBus.studentsDaily / R.sfusd.publicK5Enrollment2025;
    expect(SCHOOL_K5.modes.sr).toBeCloseTo(avg('anyCar') + yellow, 4);
    expect(SCHOOL_K5.modes.transit).toBeCloseTo(avg('anyBus') - yellow, 4);
    expect(SCHOOL_K5.modes.walk).toBeCloseTo(avg('walk'), 4);
  });

  it('lets youth ride Muni free within the city and pay half beyond it', () => {
    expect(PERSON_FARE.youth.inCity).toBe(0);
    expect(PERSON_FARE.youth.outside).toBe(0.5);
  });

  it('sizes each school level by its own grades, and splits a campus by where its students live', () => {
    const p = prepareDemand(bundleOf([
      zone('a', { schoolEnroll: 600, schoolEnrollBy: [500, 100, 0], collegeEnroll: 1000, collegeResShare: 0.4, collegePass: true }),
      zone('b', { schoolEnroll: 900, schoolEnrollBy: [0, 0, 900], collegeEnroll: 500 }),
    ]));
    expect([0, 1, 2].map((l) => p.size[`school${l}`][0])).toEqual([500, 100, 0]);
    expect([0, 1, 2].map((l) => p.size[`school${l}`][1])).toEqual([0, 0, 900]);
    // residents' share of a campus: its own where known, else the default
    expect(p.size.univR[0] / p.size.univ[0]).toBeCloseTo(0.4, 6);
    expect(p.size.univNR[0] / p.size.univ[0]).toBeCloseTo(0.6, 6);
    expect(p.size.univR[1] / p.size.univ[1]).toBeCloseTo(COLLEGE.residentShare, 6);
    expect([...p.collegePass]).toEqual([1, 0]);
  });

  it('moves shadow prices toward enrollment, the distance scale toward SFUSD, and the school constants toward its modes', () => {
    const prep = { size: { school0: Float32Array.from([100, 300]) } } as unknown as Prep;
    // arrivals 200 / 200 against enrollment 100 / 300 (same total)
    const stats = new Float64Array(30);
    // elementary: 40% under a mile (SFUSD 50.6%), car passenger 70%, transit 5%, walk 24%, bike 1%
    const sh: Record<string, number> = { sr: 0.7, transit: 0.05, walk: 0.24, bike: 0.01 };
    for (const [m, v] of Object.entries(sh)) stats[MODES.indexOf(m as (typeof MODES)[number])] = 1000 * v;
    stats[6] = 400;
    stats[7] = 300;
    stats[8] = 300;
    stats[9] = 1000;
    const d = { attract: { school0: Float64Array.from([200, 200]) }, schoolStats: stats } as unknown as DemandResult;
    const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0, outShare: 0, airportTrips: 0, iterations: 0, report: [] } as Calibration;
    fitStudents(calib, prep, d);
    const s = calib.shadow!.school0;
    expect(s[0]).toBeCloseTo(Math.log(100 / 200), 3);
    expect(s[1]).toBeCloseTo(Math.log(300 / 200), 3);
    // too few close to school: distance weighs more
    expect(calib.schoolDistScale!).toBeGreaterThan(1);
    // too little transit and walking against car passenger: their constants rise
    expect(calib.schoolAsc!.transit!).toBeGreaterThan(0);
    expect(calib.schoolAsc!.walk!).toBeGreaterThan(0);
    expect(calib.schoolFit!.under1mi).toEqual([0.4, SCHOOL_K5.under1mi]);
  });

  it("takes middle and high school transit from SFMTA's Student Travel Tally, and fits each level's constant to it", async () => {
    const fs = await import('node:fs');
    const R = JSON.parse(fs.readFileSync('server/beta3/reference/student-travel.json', 'utf8'));
    expect(SCHOOL_LEVELS.map((l) => l.transit)).toEqual([null, R.sfmtaTravelTally2025.transitShare.grade6, R.sfmtaTravelTally2025.transitShare.grade9]);
    const prep = { size: {} } as unknown as Prep;
    const stats = new Float64Array(30);
    // elementary on target; middle 20% transit (33%), high 60% (55%)
    stats[3] = 78;
    stats[9] = 1000;
    stats[10 + 3] = 200;
    stats[10 + 9] = 1000;
    stats[20 + 3] = 600;
    stats[20 + 9] = 1000;
    const d = { attract: {}, schoolStats: stats } as unknown as DemandResult;
    const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0, outShare: 0, airportTrips: 0, iterations: 0, report: [] } as Calibration;
    fitStudents(calib, prep, d);
    const logit = (p: number) => Math.log(p / (1 - p));
    expect(calib.schoolLevelTransit![0]).toBe(0);
    expect(calib.schoolLevelTransit![1]).toBeCloseTo(logit(0.33) - logit(0.2), 3);
    expect(calib.schoolLevelTransit![2]).toBeCloseTo(logit(0.55) - logit(0.6), 3);
    expect(calib.schoolLevelFit).toEqual([null, [0.2, 0.33], [0.6, 0.55]]);
  });

  it("fits school tours' switch home from car passenger to transit to SFCTA's ratio of transit home to transit there", () => {
    const prep = { size: {} } as unknown as Prep;
    const stats = new Float64Array(30);
    stats[3] = 78;
    stats[9] = 1000;
    // elementary: 100 trips each way; 8 by transit to school, 6 home; car passenger tours' 60 legs home, 1 of them by transit
    const dir = new Float64Array(42);
    dir.set([0, 60, 0, 8, 30, 2], 0);
    dir.set([0, 59, 0, 6, 33, 2], 6);
    dir[12] = 60;
    dir[13] = 1;
    const d = { attract: {}, schoolStats: stats, schoolDir: dir } as unknown as DemandResult;
    const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0, outShare: 0, airportTrips: 0, iterations: 0, report: [] } as Calibration;
    fitStudents(calib, prep, d);
    // home by transit should be SCHOOL_RETURN.ratio × 8% of 100 = 12.8 trips: 1 + 6.8 more from the car-passenger tours
    const want = (1 + SCHOOL_RETURN.ratio * 0.08 * 100 - 6) / 60;
    expect(calib.schoolSwitch!['sr>transit']).toBeCloseTo(Math.log(want / (1 / 60)), 3);
    expect(calib.schoolReturnFit![0]).toBeCloseTo(0.06 / 0.08, 3);
    expect(SCHOOL_RETURN.ratio).toBeCloseTo((0.5 * 0.267 + 0.5 * 0.182) / 0.14, 9);
  });

  it("fits college tours' drive-alone constant to SF State's students at the pass campus", () => {
    const prep = { size: {}, collegePass: Uint8Array.from([0, 1]) } as unknown as Prep;
    const stats = new Float64Array(30);
    stats[1] = 1;
    stats[9] = 1;
    // SF State (zone 1): 60% drive alone against the 41% target; zone 0 is not counted
    const cm = new Float64Array(12);
    cm[0] = 100;
    cm[6 + 0] = 60;
    cm[6 + 3] = 40;
    const d = { attract: {}, schoolStats: stats, collegeModes: cm } as unknown as DemandResult;
    const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0, outShare: 0, airportTrips: 0, iterations: 0, report: [] } as Calibration;
    fitStudents(calib, prep, d);
    expect(calib.collegeFit).toEqual([0.6, COLLEGE.sfsuDriveAlone]);
    const logit = (p: number) => Math.log(p / (1 - p));
    expect(calib.collegeDa!).toBeCloseTo(logit(COLLEGE.sfsuDriveAlone) - logit(0.6), 3);
  });

  it('takes the college drive-alone target from SF State\'s published rate', async () => {
    const fs = await import('node:fs');
    const R = JSON.parse(fs.readFileSync('server/beta3/reference/student-travel.json', 'utf8'));
    expect(COLLEGE.sfsuDriveAlone).toBe(R.sfsu.driveAlone2023.students);
  });
});

describe("beta3 residents' commutes to the outside counties", () => {
  // two home zones; flows to zone 1 in the city and to outside zones 2 (San Mateo) and 3 (Alameda)
  const b = {
    header: {
      zones: [{ workers: 100, wfh: 0 }, { workers: 50, wfh: 0.2 }],
      ext: [{ county: 'San Mateo County' }, { county: 'Alameda County' }],
    },
    a: { flowH: Int32Array.from([0, 0, 0, 1]), flowW: Int32Array.from([1, 2, 3, 1]), flowN: Float32Array.from([60, 30, 10, 40]) },
  } as unknown as Bundle;

  it('scales the flows to a county and keeps each home zone\'s commuters', () => {
    const w = outCommuteWeights(b, { outCommuteFactor: { 'San Mateo': 2 } });
    expect([...w]).toEqual([60, 60, 10, 40]);
    expect(outCommuteWeights(b, {})).toBe(b.a.flowN);
    // commuters: zone 0 100, zone 1 40; San Mateo's share of all 140, before and after
    expect(outCommuteShares(b, {})['San Mateo']).toBeCloseTo((100 * 0.3) / 140, 9);
    expect(outCommuteShares(b, { outCommuteFactor: { 'San Mateo': 2 } })['San Mateo']).toBeCloseTo((100 * 60) / 130 / 140, 9);
  });

  it("reads the model year's commuters from the ACS 2024 records", async () => {
    const fs = await import('node:fs');
    const R = JSON.parse(fs.readFileSync('server/beta3/reference/commute-by-year.json', 'utf8'));
    const f = R.flows['San Francisco -> San Mateo'];
    // the pooled estimate is the mean of the five years' (each year's weights times 5)
    const years = ['2020', '2021', '2022', '2023', '2024'];
    expect(years.reduce((a, y) => a + f.all[y].workers, 0) / 5).toBeCloseTo(f.all.pooled, 0);
    // and matches the pooled county table the county targets use
    const C = JSON.parse(fs.readFileSync('server/beta3/reference/commute-by-county.json', 'utf8'));
    expect(f.all.pooled).toBe(C.fromSF['San Mateo'].total);
    expect(f.commuterRail.pooled).toBe(C.fromSF['San Mateo'].transitCommuterRail);
  });
});

describe('beta3 changes of vehicle', () => {
  it("prices a change in route choice at mode choice's weight on a tour, times the calibrated factor", () => {
    // TM1's tour transfer weight is 30 in-vehicle minutes
    expect(transferPenalty({ xferFactor: 0.6 })).toBeCloseTo(18, 9);
    expect(transferPenalty(null)).toBeCloseTo(30, 9);
    const b = toy(3, [
      [[0, 1], 5, 24],
      [[1, 2], 5, 24],
    ]);
    const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0.3, outShare: 0.05, airportTrips: 0, iterations: 0, report: [], xferFactor: 0.5 } as never;
    const s = new StrategySolver(buildNet(b, today, 'AM', calib));
    s.solve(2);
    expect(s.u[0]).toBeCloseTo(2 * ((PATH.waitWeight * 0.5) / 0.1) + 10 + 15, 4);
    // an explicit setting overrides it
    const keep = PATH.transferPenalty;
    PATH.transferPenalty = 4;
    try {
      expect(transferPenalty({ xferFactor: 0.5 })).toBe(4);
    } finally {
      PATH.transferPenalty = keep;
    }
  });

  it('traces boardings after another vehicle, the ride before the change, and whether one line would do', async () => {
    const { traceTransfers } = await import('../server/beta3/pipeline/transfers');
    // 0→1 on R0, 1→2 on R1; and 0→3 on R2 alone
    const b = toyMuni(4, [
      [[0, 1], 5, 24],
      [[1, 2], 5, 24],
      [[0, 3], 5, 24],
    ]);
    const net = buildNet(b, today, 'AM', null);
    const Z = net.nZones;
    const od = new Float32Array(Z * Z);
    od[0 * Z + 2] = 30;
    od[0 * Z + 3] = 10;
    const H = b.header;
    const T = traceTransfers(net, od, (s) => H.stops[s], { direct: true });
    expect(T.groups.muni.boardings).toBeCloseTo(70, 6);
    expect(T.groups.bus.after).toBeCloseTo(30, 6);
    expect(T.groups.muni.from.muniOther).toBeCloseTo(30, 6);
    expect(T.routes.R1.after / T.routes.R1.boardings).toBeCloseTo(1, 6);
    expect(T.routes.R0.after).toBeCloseTo(0, 6);
    expect(T.firstLeg.bus.vol).toBeCloseTo(30, 6);
    expect(T.firstLeg.bus.kmSum / T.firstLeg.bus.vol).toBeCloseTo(1, 6);
    expect(T.sameStop).toBeCloseTo(30, 6);
    expect(T.boardingsAll / T.trips).toBeCloseTo(70 / 40, 6);
    // no line runs from 0 to 2
    expect(T.direct!.changeTrips).toBeCloseTo(30, 6);
    expect(T.direct!.withDirectLine).toBeCloseTo(0, 6);
    expect(T.direct!.noDirectPath).toBeCloseTo(30, 6);
    // and the same share from the summed link volumes (what the calibration fits)
    const { muniAfterVehicle } = await import('../server/beta3/pipeline/transfers');
    const s = new StrategySolver(net);
    for (const d of [2, 3]) (s.solve(d), s.load((o) => od[o * Z + d]));
    const m = muniAfterVehicle({ AM: net }, { AM: s.linkVol });
    expect(m.share).toBeCloseTo(30 / 70, 6);
  });
});

describe('beta3 trip mode choice conditional on tour mode', () => {
  const K = TRIP_SWITCH.map(([a, b]) => TRIP_SWITCH_ASC[`${a}>${b}`]);
  const allowed = (M: string) => [M, ...TRIP_SWITCH.filter(([a]) => a === M).map(([, b]) => b)].sort();
  /** each tour mode's trip shares on a leg with utilities v (6 modes, money included) */
  const sharesOf = (v: number[], theta = 0.6, av = 1) => {
    const G = new Float64Array(6), sw = new Float64Array(TRIP_SWITCH.length);
    tripSwitch(v, theta, K, av, G, sw);
    const P: number[][] = MODES.map((_, M) => MODES.map((_, m) => (m === M ? 1 : 0)));
    TRIP_SWITCH.forEach(([a, b], k) => {
      const M = MODES.indexOf(a), m = MODES.indexOf(b);
      P[M][M] -= sw[k];
      P[M][m] += sw[k];
    });
    return { G, P };
  };
  it('lets each tour mode use only the modes it allows: a drive tour never rides transit, a bike tour only walks', () => {
    expect(allowed('da')).toEqual(['da', 'sr']);
    // a shared ride may come home by transit (someone else drove: a pupil driven to school rides Muni home)
    expect(allowed('sr')).toEqual(['da', 'sr', 'transit', 'walk']);
    expect(allowed('bike')).toEqual(['bike', 'walk']);
    expect(allowed('transit')).toEqual(['sr', 'tnc', 'transit', 'walk']);
    expect(allowed('walk')).toEqual(['sr', 'tnc', 'transit', 'walk']);
    expect(allowed('tnc')).toEqual(['sr', 'tnc', 'transit', 'walk']);
    // transit far better than anything else on the leg: still no transit on drive-alone or bike tours
    // (whose vehicle must come home); a shared ride's passenger may take it
    const { P } = sharesOf([-8, -8, -6, 0, -9, -9]);
    for (const M of ['da', 'bike'] as const) expect(P[MODES.indexOf(M)][MODES.indexOf('transit')]).toBe(0);
    expect(P[MODES.indexOf('sr')][MODES.indexOf('transit')]).toBeGreaterThan(0);
    expect(P[MODES.indexOf('walk')][MODES.indexOf('transit')]).toBeGreaterThan(0);
  });
  it('lets a transit tour come home by ride-hail when transit is poor, and less when it is good', () => {
    const T = MODES.indexOf('transit'), R = MODES.indexOf('tnc');
    const night = sharesOf([-3, -3, -2, -3, -Infinity, -Infinity]).P[T][R];
    const day = sharesOf([-3, -3, -2, -1, -Infinity, -Infinity]).P[T][R];
    expect(night).toBeGreaterThan(0.01);
    expect(day).toBeLessThan(night);
    // with no transit at the hours the leg travels, a walk tour never rides it
    expect(sharesOf([-3, -3, -2, -1, -1, -2], 0.6, 0).P[MODES.indexOf('walk')][T]).toBe(0);
  });
  it('gives each tour mode trip shares that sum to one', () => {
    const { P } = sharesOf([-1.2, -1.5, -2.4, -1.1, -0.9, -1.7]);
    for (const row of P) {
      expect(row.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12);
      for (const x of row) expect(x).toBeGreaterThanOrEqual(0);
    }
  });
  it("adds the trips' logsum to the tour mode, and nothing when only the tour's own mode is available", () => {
    const theta = 0.63;
    // only drive alone and transit: no tour mode has another trip mode, so the tour utility is its leg's
    const only = sharesOf([-1, -Infinity, -Infinity, -2, -Infinity, -Infinity], theta);
    expect([...only.G]).toEqual([0, 0, 0, 0, 0, 0]);
    // transit tours with walking possible: θ ln(e^(v_T/θ) + e^(v_W/θ + K)) − v_T
    const v = [-1, -Infinity, -Infinity, -2, -1.5, -Infinity];
    const { G, P } = sharesOf(v, theta);
    const k = TRIP_SWITCH.findIndex(([a, b]) => a === 'transit' && b === 'walk');
    const ls = theta * Math.log(Math.exp(v[3] / theta) + Math.exp(v[4] / theta + K[k]));
    expect(G[3]).toBeCloseTo(ls - v[3], 12);
    expect(P[3][4]).toBeCloseTo(Math.exp(v[4] / theta + K[k]) / (Math.exp(v[3] / theta) + Math.exp(v[4] / theta + K[k])), 12);
    // the gain is never negative: a tour mode is worth at least its own trips
    for (const g of G) expect(g).toBeGreaterThanOrEqual(0);
  });
  it('gives the same demand split over origins as in one piece, and keeps car tours off transit', async () => {
    const fs = await import('node:fs');
    const zlib = await import('node:zlib');
    const b = decodeBundle(zlib.gunzipSync(fs.readFileSync('client/beta3/model/sf.bin.gz')));
    const prep = prepareDemand(b);
    const { NZ, ZT } = prep;
    const dm = b.a.autoDm as Uint16Array;
    // stand-in transit skims (no path search): slower at night
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
    const whole = computeDemand(b, prep, sk, calib);
    const parts = [0, 1, 2].map((i) => demandPart(b, prep, sk, calib, 'wkd', 1, { index: i, count: 3 }));
    const split = finishDemand(b, calib, parts);
    const rel = (x: number, y: number) => (x === y ? 0 : Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)));
    for (const m of MODES) {
      expect(rel(split.trips[m], whole.trips[m])).toBeLessThan(1e-9);
      expect(rel(split.tripMix.transit[m], whole.tripMix.transit[m])).toBeLessThan(1e-9);
      expect(rel(split.tripMixTour.walk[m], whole.tripMixTour.walk[m])).toBeLessThan(1e-9);
      expect(rel(split.byPurpose.nhb[m], whole.byPurpose.nhb[m])).toBeLessThan(1e-9);
    }
    for (const p of ['AM', 'MD', 'PM', 'NT'] as const) {
      let worst = 0;
      const a = split.transitOD[p], c = whole.transitOD[p];
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, rel(a[i], c[i]));
      expect(worst).toBeLessThan(1e-6);
    }
    expect(rel(split.vkt, whole.vkt)).toBeLessThan(1e-9);
    // stop legs: none by transit on drive-alone or bike tours; some transit tours' legs by ride-hail and walking
    for (const M of ['da', 'bike']) expect(whole.stopLegModes[M].transit).toBe(0);
    expect(whole.stopLegModes.transit.tnc).toBeGreaterThan(0);
    expect(whole.stopLegModes.transit.walk).toBeGreaterThan(0);
    // primary legs: tours that ride transit out come home by every mode a transit tour allows
    expect(whole.tripMix.transit.tnc).toBeGreaterThan(0);
    expect(whole.tripMix.transit.walk).toBeGreaterThan(0);
    expect(whole.tripMix.da.transit).toBe(0);
    for (const M of ['da', 'bike']) expect(whole.tripMixTour[M].transit).toBe(0);
    TRIP_MIX.on = false;
  }, 300_000);
});

describe('beta3 event-goers on Caltrain', () => {
  it("takes the average weekday's extra Giants riders from Caltrain's home and away counts and the game calendar", async () => {
    const { giantsCaltrain } = await import('../server/beta3/pipeline/station-od');
    const g = giantsCaltrain({ weekdayAway: 41603, weekdayHome: 45864 }, [{ name: 'Oracle Park', slots: [{ kind: 'evening', weekdayEvents: 40, weekdayAttendance: 1393875, year: 5318 }, { kind: 'concert', weekdayEvents: 1, weekdayAttendance: 38000, year: 151 }, { kind: 'day', weekdayEvents: 14, weekdayAttendance: 463641, year: 1773 }] }]);
    expect(g.perGame).toBe(4261);
    expect(g.games).toBe(54);
    expect(g.weekdays).toBeCloseTo(262, 0);
    expect(g.perWeekday).toBeGreaterThan(870);
    expect(g.perWeekday).toBeLessThan(890);
    // and from the reference files themselves
    expect(giantsCaltrain().perWeekday).toBeCloseTo(g.perWeekday, 6);
  });
});

describe('beta3 observed running time along a line', () => {
  it('spreads each period over its hops as observed, keeping the total', async () => {
    const { spreadAsObserved } = await import('../server/beta3/pipeline/transit');
    const stops = ['1', '2', '3', '4'].map((id) => ({ id: `muni:${id}`, name: `S${id}` }));
    const line = { feed: 'muni', mode: 'bus', stops: [0, 1, 2, 3], periods: { AM: { trips: 10, hops: [100, 100, 100] }, MD: { trips: 10, hops: [100, 100, 100] } } };
    // AM: all three hops observed (the middle one slow); MD: only one, too little to reshape
    const med = new Map([['11-12|AM', 60], ['12-13|AM', 180], ['13-14|AM', 60], ['11-12|MD', 50]]);
    const [shaped, tried] = spreadAsObserved([line] as never, stops as never, med);
    expect([shaped, tried]).toEqual([1, 2]);
    expect(line.periods.AM.hops).toEqual([60, 180, 60]);
    expect(line.periods.MD.hops).toEqual([100, 100, 100]);
  });
});
