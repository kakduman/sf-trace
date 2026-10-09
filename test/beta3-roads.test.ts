import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle } from '../shared/beta3/bundle';
import { computeDemand, demandPart, finishDemand, prepare, type TrnSkims } from '../shared/beta3/demand';
import { odChange } from '../shared/beta3/model';
import { equilibrium, linkTimes, localAon, periodRoads, resolveRoadEdits, roadNetFrom, summariseRoads, VDF_AKCELIK, VDF_FIXED, VDF_FREEWAY, type RoadNet } from '../shared/beta3/roads';
import { Traffic } from '../shared/beta3/traffic';
import { TPERIODS, type Scenario, type TPeriod } from '../shared/beta3/types';

/**
 * A small road network: centroids 0..nC-1, then nodes; links [a, b, miles, free-flow minutes,
 * capacity per hour, vdf, name, lanes]. Node coordinates lie on a line so street edits can find links.
 */
function roadNet(nC: number, nNodes: number, links: [number, number, number, number, number, number, string, number][]): RoadNet {
  const order = links.map((_, i) => i).sort((p, q) => links[p][0] - links[q][0]);
  const L = order.map((i) => links[i]);
  const n = L.length;
  const start = new Int32Array(nNodes + 1);
  for (const l of L) start[l[0] + 1]++;
  for (let i = 0; i < nNodes; i++) start[i + 1] += start[i];
  const t0 = new Float32Array(4 * n);
  for (let q = 0; q < 4; q++) L.forEach((l, k) => (t0[q * n + k] = l[3]));
  const names = [...new Set(L.map((l) => l[6]).filter(Boolean))];
  const nodeLat = Float32Array.from({ length: nNodes }, (_, i) => 37.7 + 0.001 * i),
    nodeLon = Float32Array.from({ length: nNodes }, () => -122.45);
  const vdf = Uint8Array.from(L, (l) => l[5]);
  const ja = Float32Array.from(L, (l) => (l[5] === VDF_AKCELIK ? (1 / (l[2] / (l[3] / 60))) ** 2 * (1 / 0.39 - 1) ** 2 : 0));
  return roadNetFrom(
    { version: 1, built: '', nZ: nC, nX: 0, nC, nNodes, nLinks: n, gateways: [], names, counts: [], cmp: [], speedTargets: {}, arrays: {} } as never,
    {
      a: Int32Array.from(L, (l) => l[0]),
      b: Int32Array.from(L, (l) => l[1]),
      start,
      len: Float32Array.from(L, (l) => l[2]),
      t0,
      cap: Float32Array.from(L, (l) => l[4] * Math.max(1, l[7])),
      lanes: Float32Array.from(L, (l) => l[7]),
      vdf,
      ja,
      cls: Uint8Array.from(L, (l) => (l[5] === VDF_FIXED ? 0 : l[5] === VDF_FREEWAY ? 1 : 4)),
      toll: new Float32Array(4 * n),
      name: Int32Array.from(L, (l) => (l[6] ? names.indexOf(l[6]) : -1)),
      ref: new Int32Array(n).fill(-1),
      nodeLat,
      nodeLon,
      shapeStart: new Int32Array(n + 1),
      shape: new Float32Array(0),
    } as never,
  );
}

/** two zones joined by a freeway and a parallel arterial (two lanes each way), with a cross street */
function corridor(): RoadNet {
  return roadNet(2, 6, [
    [0, 2, 0, 0.5, 0, VDF_FIXED, '', 0],
    [2, 3, 3, 4, 2000, VDF_FREEWAY, 'Freeway', 2],
    [2, 4, 3, 9, 900, VDF_AKCELIK, 'Main Street', 2],
    [4, 3, 0.3, 1, 700, VDF_AKCELIK, 'Cross Street', 1],
    [3, 5, 0.2, 0.5, 900, VDF_AKCELIK, 'Main Street', 2],
    [5, 1, 0, 0.5, 0, VDF_FIXED, '', 0],
  ]);
}

describe('beta3 road assignment', () => {
  it('converges to user equilibrium: used routes cost the same, and the gap falls below 1e-4', async () => {
    const net = corridor();
    const R = periodRoads(net, 'AM');
    const od = Float32Array.from([0, 30000, 0, 0]);
    const eq = await equilibrium(R, od, localAon(net), { gap: 1e-4, maxIter: 300 });
    expect(eq.gap).toBeLessThanOrEqual(1e-4);
    const t = new Float64Array(net.h.nLinks);
    linkTimes(R, eq.flow, t);
    const k = (name: string, a: number) => [...Array(net.h.nLinks).keys()].find((i) => net.h.names[net.name[i]] === name && net.a[i] === a)!;
    const fw = k('Freeway', 2),
      art = k('Main Street', 2),
      cross = k('Cross Street', 4);
    expect(eq.flow[fw]).toBeGreaterThan(0);
    expect(eq.flow[art]).toBeGreaterThan(0);
    const cost = (ks: number[]) => ks.reduce((s, i) => s + t[i] + R.fixed[i], 0);
    expect(Math.abs(cost([fw]) - cost([art, cross]))).toBeLessThan(0.05 * cost([fw]));
    // the gap shrinks
    expect(eq.gaps[eq.gaps.length - 1]).toBeLessThan(eq.gaps[0]);
  });

  it('a lane taken from a street slows it and moves traffic off it', async () => {
    const net = corridor();
    const od = Float32Array.from([0, 30000, 0, 0]);
    const base = await equilibrium(periodRoads(net, 'AM'), od, localAon(net), { gap: 1e-5, maxIter: 500 });
    const sc: Scenario = { name: 'diet', edits: [{ kind: 'road', id: 'd', name: 'd', street: 'Main Street', from: { lat: 37.7, lon: -122.45 }, to: { lat: 37.71, lon: -122.45 }, lanes: -1 }] };
    const ed = resolveRoadEdits(net, sc);
    expect(ed.byEdit.d.length).toBe(2);
    const R = periodRoads(net, 'AM', ed);
    const diet = await equilibrium(R, od, localAon(net), { gap: 1e-5, maxIter: 500 });
    const art = ed.byEdit.d.find((k) => net.a[k] === 2)!;
    const tb = new Float64Array(net.h.nLinks),
      ts = new Float64Array(net.h.nLinks);
    linkTimes(periodRoads(net, 'AM'), base.flow, tb);
    linkTimes(R, diet.flow, ts);
    expect(ts[art]).toBeGreaterThan(tb[art]);
    expect(diet.flow[art]).toBeLessThan(base.flow[art]);
  });

  it('fewer cars (a shift away from driving) raise speeds', async () => {
    const net = corridor();
    const R = periodRoads(net, 'AM');
    const run = async (n: number) => {
      const eq = await equilibrium(R, Float32Array.from([0, n, 0, 0]), localAon(net), { gap: 1e-5, maxIter: 500 });
      const flow = {} as Record<TPeriod, Float64Array>,
        time = {} as Record<TPeriod, Float64Array>;
      for (const p of TPERIODS) {
        flow[p] = eq.flow;
        time[p] = new Float64Array(net.h.nLinks);
        linkTimes(R, eq.flow, time[p]);
      }
      return summariseRoads(net, flow, time);
    };
    const busy = await run(30000),
      lighter = await run(27000);
    expect(lighter.speed.all.AM).toBeGreaterThan(busy.speed.all.AM);
    expect(lighter.delay.AM).toBeLessThan(busy.delay.AM);
  });
});

const BUNDLE = 'client/beta3/model/sf.bin.gz',
  ROADS = 'client/beta3/model/roads.bin.gz';
const haveModel = fs.existsSync(BUNDLE) && fs.existsSync(ROADS);
describe.skipIf(!haveModel)('beta3 traffic on the city model', () => {
  const B = haveModel ? decodeBundle(zlib.gunzipSync(fs.readFileSync(BUNDLE))) : (null as never);
  // demand without transit service: enough to compare the car trips of a split run with a whole one
  const noTransit = (Z: number): TrnSkims => Object.fromEntries(TPERIODS.map((p) => [p, { g: new Float32Array(Z * Z).fill(Infinity), boards: new Float32Array(Z * Z), fare: new Float32Array(Z * Z), time: new Float32Array(Z * Z).fill(Infinity) }])) as TrnSkims;

  it('demand split over workers gives the same car trips as one run', () => {
    const prep = prepare(B);
    const sk = noTransit(prep.ZT);
    const calib = B.header.calibration!;
    const whole = computeDemand(B, prep, sk, calib, 'wkd', 1, undefined, undefined, { autoOD: true });
    const parts = [0, 1, 2].map((index) => demandPart(B, prep, sk, calib, 'wkd', 1, { index, count: 3 }, undefined, undefined, { autoOD: true }));
    const split = finishDemand(B, calib, parts);
    expect(odChange(whole.autoOD!, split.autoOD!)).toBeLessThan(1e-6);
    expect(split.driveMin.work).toBeCloseTo(whole.driveMin.work, 6);
    expect(split.vkt).toBeCloseTo(whole.vkt, 0);
  }, 120_000);

  it('a scenario that changes nothing keeps today’s driving times exactly', async () => {
    const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(ROADS)));
    const net = roadNetFrom(rb.header as never, rb.a);
    // today's trips, as stored: the model's part (traffic.ts adds the background)
    const nC = net.h.nC,
      ZA = net.h.nZ + net.h.nX;
    const od = {} as Record<TPeriod, Float32Array>;
    for (const p of TPERIODS) {
      const q = net.baseOD[p]!;
      const m = new Float32Array(ZA * ZA);
      for (let o = 0; o < ZA; o++) for (let d = 0; d < ZA; d++) m[o * ZA + d] = q[o * nC + d] ? (q[o * nC + d] / 256) ** 2 : 0;
      od[p] = m;
    }
    const tr = new Traffic(B, net, { name: 'today', edits: [] }, localAon(net));
    const arrays = await tr.step(od);
    for (const [k, v] of Object.entries(arrays)) {
      const f = B.a[k] as Uint16Array;
      let diff = 0;
      for (let i = 0; i < v.length; i++) diff = Math.max(diff, Math.abs(v[i] - f[i]));
      expect(diff, k).toBe(0);
    }
    expect(Object.keys(tr.busDelay()).length).toBe(0);
  }, 300_000);
});
