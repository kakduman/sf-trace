import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle } from '../shared/beta3/bundle';
import { aonOrigins, equilibrium, linkTimes, localAon, periodRoads, roadBase, roadNetFrom, RoadPaths, VDF_FIXED, VDF_FREEWAY, type RoadNet } from '../shared/beta3/roads';
import { RUN_MODES, type RunMode } from '../shared/beta3/runmode';
import { Traffic } from '../shared/beta3/traffic';
import { TPERIODS, type Bundle, type Scenario, type TPeriod } from '../shared/beta3/types';
import { eastBayCorridor, eastBayCorridors, LOCAL_LEG, peninsulaCorridors, peninsulaSide, regionalLegSec, regionOf, viaCrossingM } from '../server/beta3/pipeline/regional-legs';

const MODEL = 'client/beta3/model';
const load = () => {
  if (!fs.existsSync(`${MODEL}/sf.bin.gz`) || !fs.existsSync(`${MODEL}/roads.bin.gz`)) return null;
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${MODEL}/roads.bin.gz`)));
  const net = roadNetFrom(rb.header as never, rb.a);
  if (!net.h.peninsula) return null;
  return { B: decodeBundle(zlib.gunzipSync(fs.readFileSync(`${MODEL}/sf.bin.gz`))) as Bundle, net };
};
const M = load();

describe('beta3 Peninsula freeways: a fixed background under the assigned traffic', () => {
  /** one zone pair joined by a freeway (link 1) and a slower road (link 2), with a background on the freeway */
  const tiny = (pre: number): RoadNet => {
    const L: [number, number, number, number, number, number][] = [
      [0, 2, 0, 0.1, 0, VDF_FIXED],
      [2, 3, 5, 5, 2000, VDF_FREEWAY],
      [2, 3, 5, 9, 2000, VDF_FREEWAY],
      [3, 1, 0, 0.1, 0, VDF_FIXED],
    ];
    const n = L.length,
      nNodes = 4;
    const start = new Int32Array(nNodes + 1);
    for (const l of L) start[l[0] + 1]++;
    for (let i = 0; i < nNodes; i++) start[i + 1] += start[i];
    const t0 = new Float32Array(4 * n);
    for (let q = 0; q < 4; q++) L.forEach((l, k) => (t0[q * n + k] = l[3]));
    const preA = new Float32Array(n);
    preA[1] = pre;
    return roadNetFrom({ version: 1, built: '', nZ: 2, nX: 0, nC: 2, nNodes, nLinks: n, gateways: [], names: [], counts: [], cmp: [], speedTargets: {} } as never, {
      a: Int32Array.from(L, (l) => l[0]), b: Int32Array.from(L, (l) => l[1]), start, len: Float32Array.from(L, (l) => l[2]), t0,
      cap: Float32Array.from(L, (l) => l[4]), lanes: Float32Array.from(L, () => 1), vdf: Uint8Array.from(L, (l) => l[5]), ja: new Float32Array(n), cls: Uint8Array.from(L, (l) => (l[5] === VDF_FIXED ? 0 : 1)),
      toll: new Float32Array(4 * n), name: new Int32Array(n).fill(-1), ref: new Int32Array(n).fill(-1), nodeLat: new Float32Array(nNodes), nodeLon: new Float32Array(nNodes), shapeStart: new Int32Array(n + 1), shape: new Float32Array(0),
      corr: Uint8Array.from([0, 1, 0, 0]), pre_AM: preA,
    } as never);
  };

  it('slows the freeway with its background, so the assigned cars move to the other road', async () => {
    const od = Float32Array.from([0, 6000, 0, 0]);
    const a = await equilibrium(periodRoads(tiny(0), 'AM'), od, localAon(tiny(0)), { gap: 1e-6, maxIter: 500 });
    const nb = tiny(5000);
    const R = periodRoads(nb, 'AM');
    const b = await equilibrium(R, od, localAon(nb), { gap: 1e-6, maxIter: 500 });
    expect(b.flow[1]).toBeLessThan(a.flow[1]);
    // at equilibrium both routes cost the same, the background counted on the freeway
    const t = new Float64Array(4);
    linkTimes(R, b.flow, t);
    expect(Math.abs(t[1] + R.fixed[1] - (t[2] + R.fixed[2]))).toBeLessThan(0.01);
    // the freeway's time is the curve at the assigned cars plus the background
    const r = (b.flow[1] + 5000) / R.C[1] / 0.75;
    expect(t[1]).toBeCloseTo(5 * (1 + 0.2 * r ** 6), 9);
  });
});

describe.skipIf(!M)('beta3 Peninsula freeways on the city model', () => {
  const { B, net } = M ?? ({} as NonNullable<typeof M>);
  const pen = net?.h.peninsula;
  const nC = net?.h.nC ?? 0;
  const todayOD = (mode: RunMode) => {
    const ZA = net.h.nZ + net.h.nX;
    const q = roadBase(net, mode).od;
    const od = {} as Record<TPeriod, Float32Array>;
    for (const p of TPERIODS) {
      const m = new Float32Array(ZA * ZA);
      for (let o = 0; o < ZA; o++) for (let d = 0; d < ZA; d++) m[o * ZA + d] = q[p]![o * nC + d] ? (q[p]![o * nC + d] / 256) ** 2 : 0;
      od[p] = m;
    }
    return od;
  };
  /** outside zones joined to the freeways' interchanges */
  const penZones = () => {
    const cut = new Set<number>();
    for (const s of pen!.segments) (cut.add(net.a[s.link]), cut.add(net.b[s.link]));
    const z = new Set<number>();
    for (let k = 0; k < net.h.nLinks; k++) if (net.a[k] < nC && cut.has(net.b[k])) z.add(net.a[k]);
    return z;
  };
  /** today's trips with the Peninsula zones' car trips to and from the city cut by a share */
  const fewer = (mode: RunMode, cut: number) => {
    const od = todayOD(mode),
      ZA = net.h.nZ + net.h.nX,
      Z = penZones();
    for (const p of TPERIODS)
      for (const e of Z)
        for (let z = 0; z < net.h.nZ; z++) {
          od[p][e * ZA + z] *= 1 - cut;
          od[p][z * ZA + e] *= 1 - cut;
        }
    return od;
  };

  it('reproduces the counts today: the model’s cars and the background add up to each segment’s count', () => {
    const other = (s: NonNullable<typeof pen>["segments"][number]) => pen!.segments.find((x) => x.route === s.route && x.dir !== s.dir && x.from === s.to && x.to === s.from)!;
    let worst = 0,
      n = 0;
    for (const s of pen!.segments)
      for (const p of TPERIODS) {
        // each direction, where both have a background (where the model's own cars alone exceed one
        // direction's count, the other direction takes up the difference)
        if (!(net.pre[p]![s.link] > 0) || !(net.pre[p]![other(s).link] > 0)) continue;
        const v = net.base[p]![s.link] + net.pre[p]![s.link];
        worst = Math.max(worst, Math.abs(v / s.target![p] - 1));
        n++;
      }
    expect(n).toBeGreaterThan(pen!.segments.length * 2);
    expect(worst).toBeLessThan(0.01);
    // both ways together, every segment and period
    for (let i = 0; i < pen!.segments.length; i++) {
      const s = pen!.segments[i];
      const o = other(s);
      for (const p of TPERIODS) {
        const v = [s, o].reduce((a, x) => a + net.base[p]![x.link] + (net.pre[p]?.[x.link] ?? 0), 0);
        expect(Math.abs(v / (s.target![p] + o.target![p]) - 1)).toBeLessThan(0.01);
      }
    }
  });

  for (const mode of ['precise', 'quick'] as RunMode[])
    it(`gives the Peninsula drivers exactly nothing when nothing changes (${mode})`, async () => {
      const tr = new Traffic(B, net, { name: 'today', edits: [], runMode: mode }, localAon(net), RUN_MODES[mode].traffic);
      await tr.step(todayOD(mode));
      expect(tr.peninsulaGain()).toBe(0);
      for (const p of TPERIODS) for (const s of pen!.segments) expect(tr.state!.time[p][s.link]).toBe(tr.baseTime(p)[s.link]);
    }, 600_000);

  it('raises the freeways’ speeds when fewer of the city’s cars use them, and the background drivers gain', async () => {
    const tr = new Traffic(B, net, { name: 'fewer', edits: [], runMode: 'precise' }, localAon(net), RUN_MODES.precise.traffic);
    await tr.step(fewer('precise', 0.2));
    let faster = 0,
      slower = 0;
    for (const p of TPERIODS)
      for (const s of pen!.segments) {
        const d = tr.state!.time[p][s.link] - tr.baseTime(p)[s.link];
        if (d < -1e-6) faster++;
        if (d > 1e-6) slower++;
      }
    // most segments speed up (a few take cars that move over from the other freeway or the streets)
    expect(faster).toBeGreaterThan(4 * slower);
    // end to end, both freeways both ways, every period is quicker
    for (const p of TPERIODS) {
      const sum = (t: ArrayLike<number>) => pen!.segments.reduce((a, sg) => a + t[sg.link], 0);
      expect(sum(tr.state!.time[p]), p).toBeLessThan(sum(tr.baseTime(p)));
    }
    expect(tr.peninsulaGain()).toBeGreaterThan(0);
  }, 600_000);

  it('holds the freeways at today’s speeds in Quick, so their drivers’ part is exactly zero', async () => {
    // a street change, so Quick assigns the traffic at all
    const s: Scenario = { name: 'q', edits: [{ kind: 'road', id: 'r', name: 'r', street: '19th Avenue', from: { lat: 37.7656, lon: -122.4772 }, to: { lat: 37.7347, lon: -122.4751 }, lanes: -1 }], runMode: 'quick' };
    const tr = new Traffic(B, net, s, localAon(net), RUN_MODES.quick.traffic);
    await tr.step(fewer('quick', 0.2));
    expect(tr.peninsulaGain()).toBe(0);
    for (const p of TPERIODS) for (const sg of pen!.segments) expect(tr.state!.time[p][sg.link]).toBe(tr.baseTime(p)[sg.link]);
  }, 600_000);

  it('loads the same flows split over origins as all at once (as the page’s workers split them)', () => {
    const p: TPeriod = 'AM';
    const R = periodRoads(net, p);
    const t = new Float64Array(net.h.nLinks);
    linkTimes(R, net.base[p]!, t);
    const cost = Float64Array.from(t, (v, k) => v + R.fixed[k]);
    const od = new Float32Array(nC * nC);
    const q = net.baseOD[p]!;
    for (let i = 0; i < od.length; i++) od[i] = q[i] ? (q[i] / 256) ** 2 : 0;
    const all = aonOrigins(new RoadPaths(net), cost, od, [...Array(nC).keys()]);
    const parts = 4;
    const sum = new Float64Array(net.h.nLinks);
    let sp = 0;
    for (let j = 0; j < parts; j++) {
      const r = aonOrigins(new RoadPaths(net), cost, od, [...Array(nC).keys()].filter((o) => o % parts === j));
      for (let k = 0; k < sum.length; k++) sum[k] += r.flow[k];
      sp += r.sp;
    }
    let worst = 0;
    for (let k = 0; k < sum.length; k++) worst = Math.max(worst, Math.abs(sum[k] - all.flow[k]) / Math.max(1, all.flow[k]));
    expect(worst).toBeLessThan(1e-9);
    expect(Math.abs(sp - all.sp) / all.sp).toBeLessThan(1e-9);
    // and the freeways carry some of it
    expect(pen!.segments.some((s) => all.flow[s.link] > 0)).toBe(true);
  });
});

describe('beta3 outside zones’ drives down the Peninsula (the fixed skims’ regional legs)', () => {
  const ref = JSON.parse(fs.readFileSync('server/beta3/reference/peninsula-traffic.json', 'utf8')) as { corridorMph: Record<string, Record<'N' | 'S', Record<'AM' | 'PM', number>>>; freeFlowMph: number; cmpSpeeds: { route: string; dir: 'N' | 'S'; AM: number; PM: number }[] };
  const pen = peninsulaCorridors(ref)!;
  const assumed = { AM: 48, MD: 72, PM: 45, EV: 80 };
  it('drives US-101 and I-280 at INRIX’s observed peak speeds, and the bridges at the assumed regional speed', () => {
    // the corridor speeds lie within the range of C/CAG's segment speeds for the route and direction
    for (const route of ['US-101', 'I-280'])
      for (const dir of ['N', 'S'] as const)
        for (const p of ['AM', 'PM'] as const) {
          const v = ref.cmpSpeeds.filter((r) => r.route === route && r.dir === dir).map((r) => r[p]);
          expect(ref.corridorMph[route][dir][p]).toBeGreaterThanOrEqual(Math.min(...v));
          expect(ref.corridorMph[route][dir][p]).toBeLessThanOrEqual(Math.max(...v));
        }
    const road = 47_500;
    const am = regionalLegSec(road, 'US-101', 'AM', 'in', assumed, pen);
    const kmh = ref.corridorMph['US-101'].N.AM * 1.609344;
    // San Mateo's observed speeds, carried on through Santa Clara County (no published speeds there)
    expect(am).toBeCloseTo((LOCAL_LEG.metres / 1000 / LOCAL_LEG.kmh) * 3600 + ((road - LOCAL_LEG.metres) / 1000 / kmh) * 3600, 6);
    // out of the city in the morning is southbound; midday at C/CAG's free-flow speed
    expect(regionalLegSec(road, 'US-101', 'AM', 'out', assumed, pen)).toBeGreaterThan(am);
    const short = 30_000;
    expect(regionalLegSec(short, 'I-280', 'MD', 'in', assumed, pen)).toBeCloseTo((3 / 30) * 3600 + ((short - 3000) / 1000 / (65 * 1.609344)) * 3600, 6);
    // a bridge keeps the assumed speed, and so does everything without the observed speeds
    expect(regionalLegSec(road, undefined, 'AM', 'in', assumed, pen)).toBeCloseTo((road / 1000 / 48) * 3600, 6);
    expect(regionalLegSec(road, 'US-101', 'AM', 'in', assumed, null)).toBeCloseTo((road / 1000 / 48) * 3600, 6);
  });
  it('gives the observed speeds only to zones west of the Bay', () => {
    const at: [string, number, number, string, boolean][] = [
      ['Palo Alto', 37.425, -122.144, 'South Bay', true],
      ['San Mateo', 37.548, -122.307, 'Peninsula', true],
      ['Milpitas', 37.43, -121.898, 'South Bay', true],
      ['Fremont', 37.511, -121.946, 'East Bay', false],
      ['Hayward', 37.643, -122.085, 'East Bay', false],
      ['Richmond', 37.931, -122.343, 'East Bay', false],
      ['San Rafael', 37.988, -122.525, 'Marin and Sonoma', false],
      ['Vallejo', 38.115, -122.232, 'Napa, Solano, and beyond', false],
    ];
    for (const [n, lat, lon, r, west] of at) {
      expect(regionOf(lat, lon), n).toBe(r);
      expect(peninsulaSide(lat, lon), n).toBe(west);
    }
  });
  it('drives from the East Bay to the Bay Bridge at Alameda CTC’s observed speeds along the zone’s corridor', () => {
    const eb = eastBayCorridors(JSON.parse(fs.readFileSync('server/beta3/reference/eastbay-traffic.json', 'utf8')))!;
    // every corridor has speeds in both peaks both ways, within the range of its segments
    for (const r of ['I-80', 'SR-24', 'I-580', 'I-880'])
      for (const dir of ['in', 'out'] as const)
        for (const p of ['AM', 'PM'] as const) {
          expect(eb.routes[r][dir][p], `${r} ${dir} ${p}`).toBeGreaterThan(10);
          expect(eb.routes[r][dir][p]).toBeLessThan(70);
        }
    // into the city in the morning, I-80's approach is the slowest, and the bridge's own approach (toll plaza and metering) slower still
    expect(eb.routes['I-80'].in.AM).toBeLessThan(eb.routes['I-580'].in.AM);
    expect(eb.last!.in.mph.AM).toBeLessThan(eb.routes['I-80'].in.AM);
    // a leg: local streets, then the bridge's approach, the corridor as far as it was monitored, the assumed speed beyond
    const road = 120_000,
      M = 1609.344;
    const last = eb.last!.in.miles * M,
      seen = eb.miles['I-80'].in * M;
    const want = (3 / 30) * 3600 + (last / 1000 / (eb.last!.in.mph.AM * 1.609344)) * 3600 + (seen / 1000 / (eb.routes['I-80'].in.AM * 1.609344)) * 3600 + ((road - 3000 - last - seen) / 1000 / 48) * 3600;
    expect(regionalLegSec(road, 'I-80', 'AM', 'in', { AM: 48, MD: 72, PM: 45, EV: 80 }, eb)).toBeCloseTo(want, 6);
    // the Bay's other crossings: from Hayward to the Peninsula through the San Mateo Bridge, not across the water
    const xy = (lat: number, lon: number) => [(lon + 122.4) * 88_000, (lat - 37.78) * 111_000];
    const straight = Math.hypot(xy(37.643, -122.085)[0] - xy(37.6956, -122.3925)[0], xy(37.643, -122.085)[1] - xy(37.6956, -122.3925)[1]);
    expect(viaCrossingM([37.643, -122.085], [37.6956, -122.3925], xy, 1.3)).toBeGreaterThan(1.3 * straight);
    const at: [string, number, number, string | null][] = [
      ['Berkeley', 37.875, -122.275, 'I-80'],
      ['Richmond', 37.931, -122.343, 'I-80'],
      ['Vallejo', 38.115, -122.232, 'I-80'],
      ['Walnut Creek', 37.903, -122.046, 'SR-24'],
      ['Oakland (east)', 37.803, -122.238, 'I-580'],
      ['Pleasanton', 37.674, -121.882, 'I-580'],
      ['Castro Valley', 37.702, -122.072, 'I-580'],
      ['Hayward', 37.643, -122.085, 'I-880'],
      ['Fremont', 37.511, -121.946, 'I-880'],
      ['San Rafael', 37.988, -122.525, null],
      ['Palo Alto', 37.425, -122.144, null],
    ];
    for (const [n, lat, lon, c] of at) expect(eastBayCorridor(lat, lon), n).toBe(c);
  });
  it('times a leg the road assignment has already walked to the network without adding local streets again', () => {
    const eb = eastBayCorridors(JSON.parse(fs.readFileSync('server/beta3/reference/eastbay-traffic.json', 'utf8')))!;
    const A = { AM: 48, MD: 72, PM: 45, EV: 80 };
    const road = 20_000;
    const withLocal = regionalLegSec(road, 'I-880', 'AM', 'in', A, eb),
      without = regionalLegSec(road, 'I-880', 'AM', 'in', A, eb, false);
    const last = eb.last!.in.miles * 1609.344;
    expect(without).toBeCloseTo((last / 1000 / (eb.last!.in.mph.AM * 1.609344)) * 3600 + ((road - last) / 1000 / (eb.routes['I-880'].in.AM * 1.609344)) * 3600, 6);
    expect(withLocal).toBeGreaterThan(without);
    // without observed speeds the two agree: the assumed regional speed throughout
    expect(regionalLegSec(road, undefined, 'MD', 'in', A, null, false)).toBeCloseTo((road / 1000 / 72) * 3600, 6);
  });
});
