import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle } from '../shared/beta3/bundle';
import { decodeResult, encodeResult } from '../shared/beta3/results';
import { TPERIODS, type RunResult, type Scenario, type TrafficResult } from '../shared/beta3/types';
import { gzipSync } from 'fflate';
import { decodeRunFile, encodeRunFile, gunzipCapped, hasShape, resultFits, RETENTION, runFileName, toEvict, type SavedRunMeta } from '../client/beta3/savedRuns';

const per = <T>(f: (i: number) => T) => Object.fromEntries(TPERIODS.map((p, i) => [p, f(i)])) as Record<(typeof TPERIODS)[number], T>;
const traffic: TrafficResult = {
  flow: per((i) => Float32Array.from([i, i + 1])),
  time: per((i) => Float32Array.from([10 + i])),
  gaps: per(() => 1e-4),
  iterations: per(() => 3),
  vehicles: per(() => 100),
  summary: { vmt: per(() => 1), vht: per(() => 2), delay: per(() => 3), speed: { all: per(() => 30), freeway: per(() => 50), arterial: per(() => 20) }, vehicles: per(() => 100), peninsula: { 'US-101 N': { vmt: per(() => 4), vht: per(() => 5) } } },
  base: { vmt: per(() => 1), vht: per(() => 2), delay: per(() => 3), speed: { all: per(() => 31), freeway: per(() => 51), arterial: per(() => 21) }, vehicles: per(() => 100) },
  trips: [{ name: 'Mission to Downtown', period: 'AM', base: 12, scenario: 11 }],
  convergence: [0.1, 0.01],
  loadings: 4,
  changes: [{ name: 'Geary Blvd', base: 100, scenario: 90 }],
};
const result = (): RunResult => ({
  scenario: 'x',
  ms: 1,
  bundleId: 'b#1',
  runMode: 'quick',
  summary: { trips: { da: 1, sr: 2, tnc: 0, transit: 3, walk: 4, bike: 0 }, residentTrips: { da: 1, sr: 2, tnc: 0, transit: 3, walk: 4, bike: 0 }, byPurpose: {}, boardings: { muni: 5 }, transitTrips: 3, vkt: 9, logsum: 1, opCost: 2, revenueHours: 3, avgTransitMin: 30 } as unknown as RunResult['summary'],
  lines: [{ line: 0, boardings: per(() => 1), loads: per((i) => Float32Array.from([i])), peakLoadFactor: 0.5, revenueHours: 1, passengerKm: 2 }],
  stopOn: Float32Array.from([1]),
  stopOff: Float32Array.from([2]),
  zoneTransitShare: Float32Array.from([0.1]),
  zoneJobs45: Float32Array.from([5]),
  zoneLogsum: Float32Array.from([-1]),
  finalCrowd: { AM: { 0: Float32Array.from([1.2]) }, MD: {}, PM: {}, NT: {} } as unknown as RunResult['finalCrowd'],
  finalLotPrice: { 3: 1.5 },
  traffic,
});
const scenario: Scenario = { name: 'Free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }], day: 'wkd', runMode: 'quick' };

describe('beta3 saved runs: the file', () => {
  it('round-trips a run with its scenario and traffic, without the warm-start data', () => {
    const run = decodeRunFile(encodeRunFile({ scenario, result: result(), savedAt: 123 }));
    expect(run.savedAt).toBe(123);
    expect(run.scenario).toEqual(scenario);
    expect(run.result.finalCrowd).toBeUndefined();
    expect(run.result.finalLotPrice).toBeUndefined();
    expect(run.result.runMode).toBe('quick');
    expect(run.result.bundleId).toBe('b#1');
    expect([...run.result.traffic!.flow.PM]).toEqual([2, 3]);
    expect([...run.result.traffic!.time.NT]).toEqual([13]);
    expect(run.result.traffic!.changes[0].name).toBe('Geary Blvd');
    expect(run.result.traffic!.summary.peninsula!['US-101 N'].vmt.AM).toBe(4);
    expect([...run.result.lines[0].loads.MD]).toEqual([1]);
  });

  it('keeps the baseline format as it was (crowding kept, no traffic)', () => {
    const r = result();
    delete r.traffic;
    const d = decodeResult(encodeResult(r));
    expect(d.finalCrowd!.AM[0][0]).toBeCloseTo(1.2, 5);
    expect(d.finalLotPrice).toEqual({ 3: 1.5 });
    expect(d.traffic).toBeUndefined();
  });

  it.skipIf(!fs.existsSync('client/beta3/model/base-quick.bin.gz'))('saves a real result in well under a megabyte', () => {
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync('client/beta3/model/base-quick.bin.gz')));
    const bytes = encodeRunFile({ scenario, result: base, savedAt: 1 });
    const back = decodeRunFile(bytes).result;
    expect(back.stopOn).toEqual(base.stopOn);
    expect(back.lines.length).toBe(base.lines.length);
    expect(back.summary).toEqual(base.summary);
    // (the retention policy's recent runs then take a few MB)
    expect(bytes.byteLength).toBeLessThan(1e6);
  });

  it('turns away what is not a saved run', () => {
    expect(() => decodeRunFile(new TextEncoder().encode('hello'))).toThrow(/not a saved SF-TRACE run/);
    // a model bundle, or a baseline result, is not one either
    expect(() => decodeRunFile(encodeResult(result()))).toThrow(/not a saved SF-TRACE run/);
    const newer = encodeBundle({ format: 'sf-trace-run', v: 99 } as never, {});
    expect(() => decodeRunFile(newer)).toThrow(/newer version/);
  });

  it('turns away a file with text where the panels print numbers', () => {
    const bytes = encodeRunFile({ scenario, result: result(), savedAt: 1 });
    const { header, a } = decodeBundle(zlib.gunzipSync(bytes));
    type H = { arrays?: unknown; result: { summary: Record<string, unknown>; traffic: { changes: { base: unknown }[] } } };
    /** the file with its header changed by f */
    const tamper = (f: (h: H) => void) => {
      const h = JSON.parse(JSON.stringify(header)) as H;
      delete h.arrays;
      f(h);
      return encodeBundle(h as never, a as never);
    };
    expect(() => decodeRunFile(tamper(() => {}))).not.toThrow();
    expect(() => decodeRunFile(tamper((h) => (h.result.summary.transitTrips = '<img src=x onerror=alert(1)>')))).toThrow(/damaged/);
    expect(() => decodeRunFile(tamper((h) => (h.result.traffic.changes[0].base = '<b>')))).toThrow(/damaged/);
    expect(() => decodeRunFile(tamper((h) => (h.result.summary['<x>'] = 1)))).toThrow(/damaged/);
  });

  it('stops unpacking a small file that unpacks to too much', () => {
    // 200 MB of zeros packs to about 200 KB
    const bomb = gzipSync(new Uint8Array(200 * 2 ** 20), { level: 9 });
    expect(bomb.byteLength).toBeLessThan(400_000);
    expect(() => gunzipCapped(bomb, 2 ** 20)).toThrow(/too large/);
    expect(() => decodeRunFile(bomb)).toThrow(/not a saved SF-TRACE run/);
    const ok = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(gunzipCapped(gzipSync(ok), 2 ** 20)).toEqual(ok);
  });

  it('names files after the scenario, day, and run mode', () => {
    expect(runFileName(scenario)).toBe('free-muni-wkd-quick.sftrace');
    expect(runFileName({ name: '  ¡¡¡  ', edits: [], day: 'sat' })).toBe('scenario-sat-precise.sftrace');
  });
});

describe('beta3 saved runs: retention', () => {
  const DAY = 86_400_000, now = 1_000 * DAY;
  const meta = (id: string, ageDays: number, kept = false): SavedRunMeta => ({ id, key: id, name: id, day: 'wkd', runMode: 'quick', savedAt: now - ageDays * DAY, usedAt: now - ageDays * DAY, kept, size: 1 });

  it(`keeps the last ${RETENTION.recent} recent runs`, () => {
    const runs = Array.from({ length: RETENTION.recent + 3 }, (_, i) => meta(`r${i}`, i));
    expect(toEvict(runs, now)).toEqual(['r12', 'r13', 'r14']);
  });

  it(`removes recent runs not used for ${RETENTION.days} days`, () => {
    expect(toEvict([meta('new', 1), meta('old', RETENTION.days + 1)], now)).toEqual(['old']);
  });

  it('never removes kept runs, and they leave the recent ones their room', () => {
    const kept = Array.from({ length: 30 }, (_, i) => meta(`k${i}`, 365 + i, true));
    const recent = Array.from({ length: RETENTION.recent }, (_, i) => meta(`r${i}`, i));
    expect(toEvict([...kept, ...recent], now)).toEqual([]);
  });
});

const MODEL = 'client/beta3/model';
const haveBases = fs.existsSync(`${MODEL}/base.bin.gz`) && fs.existsSync(`${MODEL}/base-quick.bin.gz`);
describe.skipIf(!haveBases)('beta3 saved runs: results the panels can show', () => {
  const load = (f: string) => decodeResult(zlib.gunzipSync(fs.readFileSync(`${MODEL}/${f}`)));
  const precise = load('base.bin.gz'), quick = load('base-quick.bin.gz');
  const model = { lines: Math.max(...precise.lines.map((l) => l.line)) + 1, newLines: 0 };
  /** a saved copy of a result, changed by f */
  const saved = (r: RunResult, f: (x: RunResult & Record<string, unknown>) => void = () => {}) => {
    const x = decodeRunFile(encodeRunFile({ scenario, result: r, savedAt: 1 })).result;
    f(x as RunResult & Record<string, unknown>);
    return x;
  };

  it('takes real results, made in either run mode', () => {
    expect(resultFits(saved(quick), quick, model)).toBe(true);
    expect(resultFits(saved(precise), precise, model)).toBe(true);
    expect(hasShape(precise.summary, quick.summary)).toBe(true);
    expect(resultFits(saved({ ...quick, traffic }), quick, model)).toBe(true);
  });

  it('turns away a result missing what the panels read', () => {
    expect(resultFits(saved(quick, (x) => delete (x.summary as unknown as Record<string, unknown>).boardings), quick, model)).toBe(false);
    expect(resultFits(saved(quick, (x) => ((x.summary as unknown as Record<string, unknown>).transitTrips = 'many')), quick, model)).toBe(false);
    expect(resultFits(saved(quick, (x) => delete (x.lines[3] as unknown as Record<string, unknown>).boardings), quick, model)).toBe(false);
    expect(resultFits(saved(quick, (x) => (x.zoneLogsum = new Float32Array(3))), quick, model)).toBe(false);
    expect(resultFits(saved(quick, (x) => (x.lines[0].line = model.lines)), quick, model)).toBe(false);
    // a scenario's own lines are -1 - k for its k-th new line
    expect(resultFits(saved(quick, (x) => (x.lines[0].line = -1)), quick, model)).toBe(false);
    expect(resultFits(saved(quick, (x) => (x.lines[0].line = -1)), quick, { ...model, newLines: 1 })).toBe(true);
  });

  it('turns away traffic the driving panels can’t show', () => {
    const bad = (f: (t: TrafficResult & Record<string, unknown>) => void) => {
      const t = structuredClone(traffic) as TrafficResult & Record<string, unknown>;
      f(t);
      return resultFits(saved({ ...quick, traffic: t }), quick, model);
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((t) => (t.trips[0].period = 'XX' as never))).toBe(false);
    expect(bad((t) => delete (t.summary.speed as Record<string, unknown>).arterial)).toBe(false);
    expect(bad((t) => ((t.base.peninsula = { 'I-280 S': {} as never }), void 0))).toBe(false);
    expect(bad((t) => (t.corridorTrips = [{ name: 'x', period: 'AM', base: 1 } as never]))).toBe(false);
  });
});
