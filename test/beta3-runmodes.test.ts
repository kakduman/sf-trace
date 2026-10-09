import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { decodeBundle } from '../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../shared/beta3/model';
import { decodeResult } from '../shared/beta3/results';
import { localAon, periodRoads, roadBase, roadNetFrom, skimRoads, VDF_AKCELIK, VDF_FIXED, type RoadNet } from '../shared/beta3/roads';
import { baseFile, DEFAULT_RUN_MODE, editsStreetsOrCarPrices, RUN_MODES, type RunMode } from '../shared/beta3/runmode';
import { Traffic } from '../shared/beta3/traffic';
import { TPERIODS, type Bundle, type RunResult, type Scenario, type TPeriod } from '../shared/beta3/types';

const MODEL = 'client/beta3/model';
const haveModel = fs.existsSync(`${MODEL}/sf.bin.gz`) && fs.existsSync(`${MODEL}/roads.bin.gz`);
const haveQuick = haveModel && fs.existsSync(`${MODEL}/${baseFile('wkd', 'quick')}`);
/** the whole-model runs take minutes: BETA3_FULL=1 runs them */
const full = !!process.env.BETA3_FULL;

describe('beta3 run modes', () => {
  it('runs Quick by default', async () => {
    expect(DEFAULT_RUN_MODE).toBe('quick');
    // a viewer with nothing saved (or no storage at all) gets Quick
    vi.stubGlobal('location', { search: '', hash: '', pathname: '/beta3' });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.resetModules();
    const st = await import('../client/beta3/state');
    expect(st.state.runMode).toBe('quick');
    // saving does not throw where storage is blocked
    expect(() => st.saveRunMode('precise')).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('remembers the viewer’s choice', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('location', { search: '', hash: '', pathname: '/beta3' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const st = await import('../client/beta3/state');
    expect(st.savedRunMode()).toBe('quick');
    st.saveRunMode('precise');
    expect(st.savedRunMode()).toBe('precise');
    store.set('beta3.runMode', 'nonsense');
    expect(st.savedRunMode()).toBe('quick');
    vi.unstubAllGlobals();
  });

  it('carries the run mode in share links', async () => {
    const { encodeScenario, decodeScenario } = await import('../client/beta3/scenario');
    const m = { bundle: { header: { stops: [] } } } as never;
    const s: Scenario = { name: 'Fare-free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] };
    for (const mode of ['quick', 'precise'] as RunMode[]) expect(decodeScenario(m, encodeScenario({ ...s, runMode: mode }))!.runMode).toBe(mode);
    // a link made before run modes (or without one) leaves the viewer's choice alone
    expect(decodeScenario(m, encodeScenario(s))!.runMode).toBeUndefined();
  });

  it('keys a result to its run mode, so switching mode asks for a new run', async () => {
    vi.stubGlobal('location', { search: '', hash: '', pathname: '/beta3' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.resetModules();
    const { editsKey } = await import('../client/beta3/state');
    const s: Scenario = { name: 'x', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] };
    expect(editsKey(s, 'quick')).not.toBe(editsKey(s, 'precise'));
    expect(editsKey({ ...s, runMode: 'precise' })).toBe(editsKey(s, 'precise'));
    vi.unstubAllGlobals();
  });

  it('names each day’s baseline by mode', () => {
    expect(baseFile('wkd', 'precise')).toBe('base.bin.gz');
    expect(baseFile('wkd', 'quick')).toBe('base-quick.bin.gz');
    expect(baseFile('sat', 'quick')).toBe('base-sat-quick.bin.gz');
    // Quick leaves out the transfer logit's second search; Precise is the full model
    expect(RUN_MODES.precise.transferPasses).toBeUndefined();
    expect(RUN_MODES.precise.busReskim).toBe(true);
    // Precise solves scenarios' assignments to today's gap (roads-base.ts: 1e-4); Quick holds today's road speeds
    expect(RUN_MODES.precise.traffic.gap).toBeLessThanOrEqual(1e-4);
    expect(RUN_MODES.precise.fixedRoads).toBe(false);
    expect(RUN_MODES.quick.fixedRoads).toBe(true);
  });

  it('gives a road response in Quick only to changes in streets or what driving costs', () => {
    expect(editsStreetsOrCarPrices({ edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] })).toBe(false);
    expect(editsStreetsOrCarPrices({ edits: [{ kind: 'frequency', route: '14', feed: 'muni', factor: { AM: 0.5 } }] })).toBe(false);
    expect(editsStreetsOrCarPrices({ edits: [{ kind: 'cordon', id: 'c', name: 'c', ring: [], toll: { AM: 8 } }] })).toBe(true);
    expect(editsStreetsOrCarPrices({ edits: [{ kind: 'parking', id: 'p', name: 'p', ring: [], perHour: 4 }] })).toBe(true);
    expect(editsStreetsOrCarPrices({ edits: [{ kind: 'road', id: 'r', name: 'r', street: 'x', from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, lanes: -1 }] })).toBe(true);
    expect(editsStreetsOrCarPrices({ edits: [], autoCostFactor: 1.5 })).toBe(true);
  });
});

describe('beta3 driving-time changes along today\u2019s routes', () => {
  /** two zones, a fast road and a slow one between them; links [a, b, miles, minutes, capacity, vdf] */
  const net = (() => {
    const L: [number, number, number, number, number, number][] = [
      [0, 2, 0, 0.5, 0, VDF_FIXED],
      [2, 3, 2, 4, 900, VDF_AKCELIK],
      [2, 4, 2, 6, 900, VDF_AKCELIK],
      [3, 1, 0, 0.5, 0, VDF_FIXED],
      [4, 1, 0, 0.5, 0, VDF_FIXED],
    ];
    const n = L.length, nNodes = 5;
    const start = new Int32Array(nNodes + 1);
    for (const l of L) start[l[0] + 1]++;
    for (let i = 0; i < nNodes; i++) start[i + 1] += start[i];
    const t0 = new Float32Array(4 * n);
    for (let q = 0; q < 4; q++) L.forEach((l, k) => (t0[q * n + k] = l[3]));
    return roadNetFrom({ version: 1, built: '', nZ: 2, nX: 0, nC: 2, nNodes, nLinks: n, gateways: [], names: [], counts: [], cmp: [], speedTargets: {}, arrays: {} } as never, {
      a: Int32Array.from(L, (l) => l[0]), b: Int32Array.from(L, (l) => l[1]), start, len: Float32Array.from(L, (l) => l[2]), t0,
      cap: Float32Array.from(L, (l) => l[4]), lanes: Float32Array.from(L, () => 1), vdf: Uint8Array.from(L, (l) => l[5]), ja: new Float32Array(n), cls: new Uint8Array(n).fill(4),
      toll: new Float32Array(4 * n), name: new Int32Array(n).fill(-1), ref: new Int32Array(n).fill(-1), nodeLat: new Float32Array(nNodes), nodeLon: new Float32Array(nNodes), shapeStart: new Int32Array(n + 1), shape: new Float32Array(0),
    } as never);
  })();

  it('sums a link array along the least-cost routes', () => {
    const R = periodRoads(net, 'AM');
    const time = Float64Array.from([0.5, 4, 6, 0.5, 0.5]);
    const dt = Float64Array.from([0, 1.5, -3, 0, 0]);
    const sk = skimRoads(R, time, { sums: [dt, time] });
    // 0 → 1 goes by the fast road: its change, and its time again
    expect(sk.sums![0][1]).toBeCloseTo(1.5, 6);
    expect(sk.sums![1][1]).toBeCloseTo(sk.time[1], 5);
    // the slow road got 3 minutes faster, enough to become the faster one: the route sum keeps
    // today's route (a first-order measure), where the least-cost times would gain a minute
    const after = skimRoads(R, Float64Array.from(time, (v, k) => v + dt[k]));
    expect(after.time[1] - sk.time[1]).toBeCloseTo(-1, 5);
  });
});

describe.skipIf(!haveModel)('beta3 run modes on the city model', () => {
  const B: Bundle = haveModel ? decodeBundle(zlib.gunzipSync(fs.readFileSync(`${MODEL}/sf.bin.gz`))) : (null as never);
  const net: RoadNet = haveModel ? (() => {
    const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${MODEL}/roads.bin.gz`)));
    return roadNetFrom(rb.header as never, rb.a);
  })() : (null as never);

  /** today's model trips in a mode, as the road bundle stores them (traffic.ts adds the background) */
  const todayOD = (mode: RunMode) => {
    const nC = net.h.nC,
      ZA = net.h.nZ + net.h.nX;
    const q = roadBase(net, mode).od;
    const od = {} as Record<TPeriod, Float32Array>;
    for (const p of TPERIODS) {
      const m = new Float32Array(ZA * ZA);
      for (let o = 0; o < ZA; o++) for (let d = 0; d < ZA; d++) m[o * ZA + d] = q[p]![o * nC + d] ? (q[p]![o * nC + d] / 256) ** 2 : 0;
      od[p] = m;
    }
    return od;
  };

  for (const mode of ['precise', 'quick'] as RunMode[])
    it.skipIf(mode === 'quick' && !Object.keys(net?.baseQuick ?? {}).length)(`a scenario that changes nothing keeps today’s traffic and driving times exactly (${mode})`, async () => {
      const tr = new Traffic(B, net, { name: 'today', edits: [], runMode: mode }, localAon(net), RUN_MODES[mode].traffic);
      expect(await tr.initialArrays()).toBeNull();
      const arrays = await tr.step(todayOD(mode));
      for (const [k, v] of Object.entries(arrays)) {
        const f = B.a[k] as Uint16Array;
        let diff = 0;
        for (let i = 0; i < v.length; i++) diff = Math.max(diff, Math.abs(v[i] - f[i]));
        expect(diff, k).toBe(0);
      }
      for (const p of TPERIODS) expect(tr.state!.iterations[p]).toBe(0);
      expect(Object.keys(tr.busDelay()).length).toBe(0);
    }, 300_000);

  /** a whole run as the page makes it: one pass from today's crowding, with traffic */
  const run = (s: Scenario, base: RunResult) => runModel(B, s, B.header.calibration!, new LocalExecutor(B, s, B.header.calibration!), { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice, traffic: { net, aon: localAon(net) } }, prepare(B));
  const load = (f: string) => decodeResult(zlib.gunzipSync(fs.readFileSync(`${MODEL}/${f}`)));
  const total = (o: Record<string, number>) => Object.values(o).reduce((a, v) => a + v, 0);

  for (const mode of ['quick', 'precise'] as RunMode[])
    it.skipIf(!full || (mode === 'quick' && !haveQuick))(`a scenario that changes nothing gives no difference from today (${mode})`, async () => {
      const precise = load(baseFile('wkd', 'precise'));
      const saved = load(baseFile('wkd', mode));
      const r = await run({ name: 'No change', edits: [], runMode: mode }, precise);
      expect(r.runMode).toBe(mode);
      // the headline figures, travelers' time savings among them, match the saved baseline exactly
      expect(r.summary.transitTrips).toBe(saved.summary.transitTrips);
      expect(r.summary.logsum).toBe(saved.summary.logsum);
      expect(r.summary.vkt).toBe(saved.summary.vkt);
      expect(total(r.summary.boardings)).toBe(total(saved.summary.boardings));
      const byLine = new Map(saved.lines.map((l) => [l.line, total(l.boardings)]));
      for (const l of r.lines) expect(total(l.boardings), `line ${l.line}`).toBe(byLine.get(l.line));
      // its time savings, and each traveler's part of them, are zero
      expect(r.summary.logsumParts!.noRoads).toBe(saved.summary.logsum);
      expect(r.summary.logsumParts!.networkOnly).toBe(saved.summary.logsum);
      if (mode === 'precise') for (const p of TPERIODS) expect(r.traffic!.iterations[p]).toBe(0);
      else expect(r.roadResponse).toBe('fixed');
    }, 1_800_000);

  /** a scenario's time savings by traveler, in hours a day, against today's network in its mode */
  const split = (r: RunResult, base: RunResult) => {
    const L = r.summary.logsum, P = r.summary.logsumParts!;
    return { transit: (P.networkOnly - base.summary.logsum) / 60, drivers: (L - P.noRoads) / 60, others: (P.noRoads - P.networkOnly) / 60 };
  };
  for (const mode of ['quick', 'precise'] as RunMode[])
    it.skipIf(!full || (mode === 'quick' && !haveQuick))(`the Portal and fare-free Muni save transit riders time (${mode}); in Quick, drivers' times do not change`, async () => {
      const precise = load(baseFile('wkd', 'precise'));
      const saved = load(baseFile('wkd', mode));
      const portal = JSON.parse(fs.readFileSync(`${MODEL}/portal-scenario.json`, 'utf8')) as Scenario;
      for (const s of [portal, { name: 'Fare-free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] } as Scenario]) {
        const r = await run({ ...s, runMode: mode }, precise);
        const t = split(r, saved);
        expect(t.transit, s.name).toBeGreaterThan(0);
        // neither changes streets or what driving costs: Quick holds today's road speeds exactly
        if (mode === 'quick') expect(t.drivers, s.name).toBe(0);
      }
    }, 3_600_000);

  it.skipIf(!full || !haveQuick || !fs.existsSync('server/beta3/reference/runmodes.json'))('Quick agrees with Precise within the measured tolerance on a small scenario', async () => {
    const ref = JSON.parse(fs.readFileSync('server/beta3/reference/runmodes.json', 'utf8')) as { scenarios: Record<string, { transitTrips: { errPct: number } }> };
    const precise = load(baseFile('wkd', 'precise'));
    const quickBase = load(baseFile('wkd', 'quick'));
    // the 14 Mission at half its frequency
    const s: Scenario = { name: 'cut', edits: [{ kind: 'frequency', route: '14', feed: 'muni', factor: { AM: 0.5, MD: 0.5, PM: 0.5, NT: 0.5 } }] };
    const q = await run({ ...s, runMode: 'quick' }, precise);
    const p = await run({ ...s, runMode: 'precise' }, precise);
    const dq = q.summary.transitTrips - quickBase.summary.transitTrips,
      dp = p.summary.transitTrips - precise.summary.transitTrips;
    const tol = Math.max(5, Math.abs(ref.scenarios.cut14?.transitTrips.errPct ?? 10) * 1.5) / 100;
    expect(Math.abs(dq - dp)).toBeLessThanOrEqual(tol * Math.abs(dp) + 50);
  }, 3_600_000);
});
