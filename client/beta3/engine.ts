/**
 * The model in the browser: loads the bundle and the precomputed baseline, and runs scenarios on
 * a small pool of Web Workers (the path searches split by destination, demand by origin).
 */
import { gunzipSync } from 'fflate';
import { bundleId, decodeBundle } from '../../shared/beta3/bundle';
import { DEMAND_PHASE, finishDemand, type DemandOptions, type DemandPart, type TrnSkim, type TrnSkims } from '../../shared/beta3/demand';
import { roadNetFrom, type RoadAon, type RoadHeader, type RoadNet } from '../../shared/beta3/roads';
import type { RoadSkimmer } from '../../shared/beta3/traffic';
import roadsUrl from './model/roads.bin.gz?url';
import roadShapesUrl from './model/road-shapes.bin.gz?url';
import { decodeRoadShapes, roadLinkKey, type RoadShapes } from '../../shared/beta3/roadShapes';
import { prepare, runModel, SKIM_PERIODS, warmStart, type DemandOverride, type Executor, type SkimPeriod } from '../../shared/beta3/model';
import { decodeResult } from '../../shared/beta3/results';
import { transitZones } from '../../shared/beta3/net';
import type { Bundle, Calibration, RunResult, Scenario, TPeriod } from '../../shared/beta3/types';
import bundleUrl from './model/sf.bin.gz?url';
import baseUrl from './model/base.bin.gz?url';
import baseSatUrl from './model/base-sat.bin.gz?url';
import baseSunUrl from './model/base-sun.bin.gz?url';
import type { DayType } from '../../shared/beta3/types';
import { baseFile, type RunMode } from '../../shared/beta3/runmode';
import type { SkimArrays, WorkerRequest } from './worker';

/**
 * The Quick baselines (baseline.ts writes them beside the Precise ones). A bundle without them gets
 * them made here on the first Quick run, as for a stale baseline.
 */
const QUICK_URLS = import.meta.glob('./model/base*-quick.bin.gz', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const quickUrl = (day: DayType): string | undefined => QUICK_URLS[`./model/${baseFile(day, 'quick')}`];

/** a scenario's run mode (Precise unless it says otherwise) */
export const modeOf = (s: { runMode?: RunMode }): RunMode => s.runMode ?? 'precise';

/** cache key for a run: the day type, the edits, and the run mode */
const runKey = (s: Scenario) => JSON.stringify([s.day ?? 'wkd', s.edits, s.autoCostFactor ?? 1, s.context ?? null, !!s.traffic, modeOf(s)]);

/** thrown by Engine.run when the run is cancelled */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** a stage of a run: its text, the fraction of the run done, and the fraction the stage takes */
type Progress = (stage: string, f: number, span?: number) => void;
/** the stages of today's network when a run makes it first (for the comparison) */
export const TODAY_FIRST = 'Running today’s network to compare: ';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
/** a request without its id (distributes over the union) */
type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/**
 * Where a run's time went: wall-clock seconds by stage on the page, and each worker's compute
 * seconds by kind of request (Engine.lastProfile; window.__b3.engine in the page).
 */
export interface RunProfile {
  mode: string;
  seconds: number;
  stages: Record<string, number>;
  workers: { busy: number; byKind: Record<string, number> }[];
}

class Pool {
  workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;
  /** compute seconds by worker and kind of request, since the last reset */
  busy: { busy: number; byKind: Record<string, number> }[] = [];
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.busy.push({ busy: 0, byKind: {} });
      w.onmessage = (ev) => {
        // progress within a request (worker.ts tick)
        if (ev.data.tick !== undefined) return void this.ticks.get(ev.data.id)?.(ev.data.tick);
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        this.ticks.delete(ev.data.id);
        const b = this.busy[i], kind = this.kinds.get(ev.data.id) ?? '?', sec = (ev.data.busy ?? 0) / 1000;
        this.kinds.delete(ev.data.id);
        b.busy += sec;
        b.byKind[kind] = (b.byKind[kind] ?? 0) + sec;
        if (ev.data.error) p.reject(new Error(ev.data.error));
        else p.resolve(ev.data);
      };
      w.onerror = (ev) => {
        for (const p of this.pending.values()) p.reject(new Error(ev.message || 'worker failed'));
        this.pending.clear();
      };
      this.workers.push(w);
    }
  }
  private kinds = new Map<number, string>();
  private ticks = new Map<number, (done: number) => void>();
  /** `onTick`: the worker's progress through the request (destinations searched, origins chosen) */
  call<T>(i: number, msg: Req, transfer: Transferable[] = [], onTick?: (done: number) => void): Promise<T> {
    const id = ++this.seq;
    this.kinds.set(id, msg.kind);
    if (onTick) this.ticks.set(id, onTick);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.workers[i].postMessage({ ...msg, id }, transfer);
    });
  }
  terminate() {
    for (const w of this.workers) w.terminate();
    // anything still waiting on a worker fails, so a cancelled run unwinds
    for (const p of this.pending.values()) p.reject(new CancelledError());
    this.pending.clear();
    this.ticks.clear();
  }
}

/** progress within a stage: what is done (e.g. "destination 312 of 678") and the fraction of the stage */
export type StageTick = (detail: string, f: number) => void;
const fmtN = (n: number) => n.toLocaleString('en-US');

/**
 * Sum the workers' progress through their parts of a request: `parts[i]` items for worker i; the
 * callback for worker i, and the tick reported (`noun`: what is counted)
 */
function tally(parts: number[], noun: string, tick: StageTick | undefined): ((i: number) => (done: number) => void) | (() => undefined) {
  if (!tick) return () => undefined;
  const done = parts.map(() => 0), total = parts.reduce((a, b) => a + b, 0);
  return (i: number) => (n: number) => {
    done[i] = Math.min(parts[i], n);
    const sum = done.reduce((a, b) => a + b, 0);
    tick(`${noun} ${fmtN(sum)} of ${fmtN(total)}`, total ? sum / total : 0);
  };
}

/**
 * Shared memory between the page and its workers (SharedArrayBuffer), where the page is
 * cross-origin isolated (COOP and COEP headers: vite.config.ts, server/index.ts). The skims are
 * then written by the workers in place and read by demand's workers without a copy each, and the
 * trips go to the loading once. Elsewhere (e.g. GitHub Pages, which sets no headers) the arrays are
 * copied, as before; the results are the same.
 */
export const sharedMemory = () => typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true && !(pageFlag('copy') || testOpts().copy);
/**
 * For timing and testing in the page: ?copy copies the arrays even where memory could be shared,
 * ?nowasm runs the strategy search in TypeScript only, ?nosearch keeps only its access split in
 * WebAssembly (not the main loop), ?workers=N sets the workers (or the same in
 * window.__b3opts, read when the workers start)
 */
const pageFlag = (k: string) => typeof location !== 'undefined' && new RegExp(`[?&]${k}\\b`).test(location.search);
const testOpts = (): { copy?: boolean; wasm?: boolean; search?: boolean; workers?: number } => (globalThis as { __b3opts?: object }).__b3opts ?? {};
const pageWorkers = () => Number(typeof location !== 'undefined' ? new URLSearchParams(location.search).get('workers') : 0) || testOpts().workers || 0;
const sharedF32 = (n: number) => new Float32Array(new SharedArrayBuffer(n * 4));
/** an array in shared memory (the same one if it is already) */
function toShared(a: Float32Array): Float32Array {
  if (a.buffer instanceof SharedArrayBuffer) return a;
  const s = sharedF32(a.length);
  s.set(a);
  return s;
}

/** split zones across workers, interleaved so each gets a fair mix */
function split(Z: number, n: number): number[][] {
  const out: number[][] = Array.from({ length: n }, () => []);
  for (let d = 0; d < Z; d++) out[d % n].push(d);
  return out;
}

class WorkerExecutor implements Executor {
  constructor(
    private pool: Pool,
    private Z: number,
    private bundle: Bundle,
    private calib: Calibration,
    /** progress within the stage in hand */
    private tick?: StageTick,
  ) {}
  async skim(period: SkimPeriod, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<TrnSkim> {
    const Z = this.Z;
    const shared = sharedMemory();
    const make = shared ? sharedF32 : (n: number) => new Float32Array(n);
    const out: TrnSkim = { g: make(Z * Z), boards: make(Z * Z), fare: make(Z * Z), cost: make(Z * Z), time: make(Z * Z) };
    const parts = split(Z, this.pool.workers.length);
    const t = tally(parts.map((p) => p.length), 'destination', this.tick);
    await Promise.all(
      parts.map(async (dests, i) => {
        const r = await this.pool.call<{ dests: number[]; shared?: boolean; g: Float32Array; boards: Float32Array; fare: Float32Array; cost: Float32Array; time: Float32Array }>(i, { kind: 'skim', period, crowd: crowd ?? null, lot: lot ?? null, dests, ...(shared ? { out: out as SkimArrays } : {}) }, [], t(i));
        // (in shared memory, the worker wrote its columns in place)
        if (r.shared) return;
        r.dests.forEach((d, j) => {
          for (let o = 0; o < Z; o++) {
            const k = o * Z + d, q = j * Z + o;
            out.g[k] = r.g[q];
            out.boards[k] = r.boards[q];
            out.fare[k] = r.fare[q];
            out.cost![k] = r.cost[q];
            out.time[k] = r.time[q];
          }
        });
      }),
    );
    return out;
  }
  async assign(period: TPeriod, od: Float32Array, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<Float64Array> {
    const parts = split(this.Z, this.pool.workers.length);
    const t = tally(parts.map((p) => p.length), 'destination', this.tick);
    // (in shared memory, one copy of the trips for all the workers)
    if (sharedMemory()) od = toShared(od);
    const vols = await Promise.all(parts.map((dests, i) => this.pool.call<{ vol: Float64Array }>(i, { kind: 'assign', period, crowd: crowd ?? null, lot: lot ?? null, dests, od }, [], t(i))));
    const total = new Float64Array(vols[0].vol.length);
    for (const v of vols) for (let i = 0; i < total.length; i++) total[i] += v.vol[i];
    return total;
  }
  async setScenario(s: Scenario) {
    await Promise.all(this.pool.workers.map((_, i) => this.pool.call(i, { kind: 'scenario', scenario: s, calib: this.calib })));
  }
  /** the skims last sent to the workers for demand, which keep them (traffic feedback chooses again on the same skims) */
  private sentSk: TrnSkims | null = null;
  private skSeq = 0;
  /** each worker takes every n-th origin; the parts are merged here */
  async demand(sk: TrnSkims, opts?: DemandOptions, arrays?: Record<string, Uint16Array | Float32Array>, over?: DemandOverride) {
    const n = this.pool.workers.length;
    // (the same arrays: the run may swap a period's skims inside the same object)
    const same = !!this.sentSk && (Object.keys(sk) as (keyof TrnSkims)[]).every((p) => sk[p] === this.sentSk![p]);
    if (!same) ((this.sentSk = { ...sk }), this.skSeq++);
    const skId = this.skSeq;
    // (each worker reports its fraction done, in thousandths: the areas whose home-based trips are
    // chosen, then the trips not from home and the stops on the way; demand.ts DEMAND_PHASE)
    const NZ = this.bundle.header.zones.length, tick = this.tick;
    const fr = this.pool.workers.map(() => 0);
    const onTick = (i: number) => (k: number) => {
      fr[i] = k / 1000;
      const f = fr.reduce((a, b) => a + b, 0) / n;
      const P = DEMAND_PHASE;
      tick?.(f < P.homeBased ? `area ${fmtN(Math.round((f / P.homeBased) * NZ))} of ${fmtN(NZ)}` : f < P.notHome ? 'trips not from home' : 'events and stops along the way', f);
    };
    const parts = await Promise.all(this.pool.workers.map((_, i) => this.pool.call<{ part: DemandPart }>(i, { kind: 'demandPart', sk: same ? null : sk, skId, split: { index: i, count: n }, opts, arrays, over }, [], tick && onTick(i))));
    return finishDemand(this.bundle, this.calib, parts.map((r) => r.part));
  }
}

/**
 * All-or-nothing road loading split over the workers by origin. An equilibrium loads the same trips
 * at new costs dozens of times: each worker keeps the last trips it was sent, so only the costs go.
 */
function workerAon(pool: Pool, nC: number): RoadAon {
  const parts = split(nC, pool.workers.length);
  let last: Float32Array | null = null,
    seq = 0;
  return async (_p, cost, od) => {
    const same = od === last;
    if (!same) ((last = od), seq++);
    const odId = seq;
    // (in shared memory, one copy of the trips for all the workers)
    const sent = same ? null : sharedMemory() ? toShared(od) : od;
    const rs = await Promise.all(parts.map((origins, i) => pool.call<{ flow: Float64Array; sp: number; lost: number }>(i, { kind: 'aon', cost, od: sent, odId, origins })));
    const flow = rs[0].flow;
    for (let j = 1; j < rs.length; j++) for (let k = 0; k < flow.length; k++) flow[k] += rs[j].flow[k];
    return { flow, sp: rs.reduce((a, r) => a + r.sp, 0), lost: rs.reduce((a, r) => a + r.lost, 0) };
  };
}

/** least-cost road paths between all centroids, split over the workers by origin */
function workerSkimmer(pool: Pool, nC: number): RoadSkimmer {
  const parts = split(nC, pool.workers.length);
  return async (which, p, time, opts) => {
    const rs = await Promise.all(parts.map((origins, i) => pool.call<{ time: Float32Array; toll: Float32Array | null; sums: Float32Array[] | null }>(i, { kind: 'roadSkim', which, period: p, time, toll: opts.toll, sums: opts.sums, origins })));
    const T = new Float32Array(nC * nC),
      M = opts.toll ? new Float32Array(nC * nC) : null,
      S = opts.sums?.map(() => new Float32Array(nC * nC));
    parts.forEach((origins, i) => {
      for (const o of origins) {
        T.set(rs[i].time.subarray(o * nC, (o + 1) * nC), o * nC);
        if (M && rs[i].toll) M.set(rs[i].toll!.subarray(o * nC, (o + 1) * nC), o * nC);
        if (S) S.forEach((x, j) => x.set(rs[i].sums![j].subarray(o * nC, (o + 1) * nC), o * nC));
      }
    });
    return { time: T, toll: M, miles: null, ...(S ? { sums: S } : {}) };
  };
}

export interface Loaded {
  bundle: Bundle;
  base: RunResult;
}

async function fetchBytes(url: string, onProgress?: (f: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) out.set(c, off), (off += c.length);
  return out.buffer;
}

const gunzipMaybe = (b: ArrayBuffer) => {
  const u = new Uint8Array(b);
  return u[0] === 0x1f && u[1] === 0x8b ? gunzipSync(u) : u;
};

export class Engine {
  private pool: Pool | null = null;
  private gz: ArrayBuffer | null = null;
  private ready: Promise<void> | null = null;
  bundle!: Bundle;
  /** today's network on an average weekday (loaded first) */
  base!: RunResult;
  private bases: Partial<Record<DayType, Promise<RunResult>>> = {};
  /** today's network as the Quick run mode makes it, by day (null: the bundle has none saved) */
  private quickBases: Partial<Record<DayType, Promise<RunResult | null>>> = {};
  /** baselines made here this session ("day:mode"), current however the saved files are */
  private remade = new Set<string>();

  /**
   * Today's network for a day type (weekend baselines load on first use). `mode`: the run mode it was
   * made in; a scenario is compared with today's network made the same way, or the approximation
   * would show up as a change. Without a saved Quick baseline, the Precise one is given (and run()
   * makes the Quick one before its first Quick scenario).
   */
  async baseFor(day: DayType, mode: RunMode = 'precise'): Promise<RunResult> {
    if (mode === 'quick') {
      const q = await this.quickBase(day);
      if (q) return q;
    }
    if (day === 'wkd') return this.base;
    this.bases[day] ??= fetchBytes(day === 'sat' ? baseSatUrl : baseSunUrl).then((b) => decodeResult(gunzipMaybe(b)));
    return this.bases[day]!;
  }
  private quickBase(day: DayType): Promise<RunResult | null> {
    const url = quickUrl(day);
    this.quickBases[day] ??= url ? fetchBytes(url).then((b) => decodeResult(gunzipMaybe(b))) : Promise.resolve(null);
    return this.quickBases[day]!;
  }

  /** a saved baseline made from a different model bundle than the one loaded (e.g. mid-update) */
  isStale(r: RunResult): boolean {
    return r.bundleId !== bundleId(this.bundle.header);
  }

  /**
   * Make sure the day's baseline in this run mode comes from the loaded model (and, on weekdays, that
   * today's traffic does too); if not, recompute today's network here, the same way scenarios are
   * run, so a comparison never mixes two versions of the model or two run modes.
   */
  private async consistentBase(day: DayType, mode: RunMode, traffic: { net: RoadNet; aon: RoadAon; skim: RoadSkimmer } | undefined, onProgress: Progress, tick?: StageTick): Promise<{ base: RunResult; remade: boolean }> {
    const precise = await this.baseFor(day, 'precise');
    const saved = mode === 'quick' ? await this.quickBase(day) : precise;
    const roadsStale = !!traffic && traffic.net.h.base?.modelId !== undefined && traffic.net.h.base.modelId !== bundleId(this.bundle.header);
    if (saved && (this.remade.has(`${day}:${mode}`) || (!this.isStale(saved) && !roadsStale))) return { base: saved, remade: false };
    onProgress(saved ? 'Recomputing today’s network to match this version of the model' : 'Running today’s network in this mode, for the comparison', 0.02);
    const Z = transitZones(this.bundle.header);
    const calib = this.bundle.header.calibration!;
    const today: Scenario = { name: 'Today', edits: [], day, runMode: mode };
    const pool = this.pool!;
    await Promise.all(pool.workers.map((_, i) => pool.call(i, { kind: 'scenario', scenario: today, calib })));
    // (scenarios start from the Precise baseline's crowding in either mode, and so does this)
    const r = await runModel(this.bundle, today, calib, new WorkerExecutor(this.pool!, Z, this.bundle, calib, tick), { iterations: 1, warmCrowd: precise.finalCrowd, warmLot: precise.finalLotPrice, traffic, onProgress: (s, f, span) => onProgress(`${TODAY_FIRST}${s.charAt(0).toLowerCase()}${s.slice(1)}`, f * 0.5, (span ?? 0) * 0.5) }, prepare(this.bundle));
    const { demand: _d, volumes: _v, nets: _n, roadArrays: _r, ...fresh } = r;
    void _d, _v, _n, _r;
    fresh.finalCrowd = precise.finalCrowd;
    fresh.bundleId = bundleId(this.bundle.header);
    this.remade.add(`${day}:${mode}`);
    if (mode === 'quick') this.quickBases[day] = Promise.resolve(fresh);
    else if (day === 'wkd') this.base = fresh;
    else this.bases[day] = Promise.resolve(fresh);
    return { base: fresh, remade: true };
  }
  /** the road network (traffic feedback), fetched on first use */
  private roadsGz: Promise<ArrayBuffer> | null = null;
  roads: RoadNet | null = null;
  async loadRoads(): Promise<RoadNet> {
    this.roadsGz ??= fetchBytes(roadsUrl);
    const gz = await this.roadsGz;
    if (!this.roads) {
      const rb = decodeBundle(gunzipMaybe(gz));
      this.roads = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
    }
    return this.roads;
  }
  /**
   * The streets' drawn shapes (fetched when the street layer is first shown), or null when they were
   * made for another build of the road network (each link then keeps the roads bundle's shape).
   */
  private roadShapesP: Promise<RoadShapes | null> | null = null;
  roadShapes: RoadShapes | null = null;
  loadRoadShapes(): Promise<RoadShapes | null> {
    this.roadShapesP ??= Promise.all([fetchBytes(roadShapesUrl), this.loadRoads()]).then(([gz, net]) => {
      const s = decodeRoadShapes(gunzipMaybe(gz));
      const key = roadLinkKey(net.h.nLinks, net.a, net.b, net.cls);
      if (s.h.key !== key) {
        console.warn(`road-shapes.bin.gz was made for road network ${s.h.key}, not ${key}: run server/beta3/pipeline/road-shapes.ts`);
        return null;
      }
      return (this.roadShapes = s);
    }).catch((e: Error) => {
      console.warn(`road shapes: ${e.message}`);
      return null;
    });
    return this.roadShapesP;
  }
  running = false;
  private cancelRun: ((e: Error) => void) | null = null;
  /** finished runs by day and scenario edits (JSON), so re-running an unchanged scenario is instant */
  private cache = new Map<string, RunResult>();

  static async load(onProgress?: (f: number) => void): Promise<Engine> {
    const e = new Engine();
    const [gz, baseGz] = await Promise.all([fetchBytes(bundleUrl, onProgress), fetchBytes(baseUrl)]);
    e.gz = gz;
    e.bundle = decodeBundle(gunzipMaybe(gz));
    e.base = decodeResult(gunzipMaybe(baseGz));
    // the weekday Quick baseline (Quick is the default run mode)
    void e.quickBase('wkd').catch(() => {});
    return e;
  }

  /**
   * three quarters of the cores (rounded down, at least one), leaving the rest for the page and the
   * rest of the machine; at most four on a machine with little memory (each worker holds the model
   * and the streets)
   */
  private workerCount() {
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const mem = typeof navigator !== 'undefined' ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) : 8;
    return pageWorkers() || Math.max(1, Math.min(mem >= 8 ? Infinity : 4, Math.floor(hc * 0.75)));
  }

  private start(): Promise<void> {
    if (!this.ready) {
      this.pool = new Pool(this.workerCount());
      const pool = this.pool;
      this.ready = Promise.all(pool.workers.map((_, i) => pool.call(i, { kind: 'init', gz: this.gz!.slice(0), wasm: !pageFlag('nowasm') && testOpts().wasm !== false, search: !pageFlag('nosearch') && testOpts().search !== false }))).then(() => undefined);
    }
    return this.ready;
  }

  /** start the workers ahead of a run (they decode the bundle, a few seconds) */
  warm(): void {
    // the streets too (traffic feedback on weekdays), so the first run does not wait for them
    void this.start()
      .then(() => this.roadsToWorkers())
      .catch(() => {});
  }

  /** the road network in every worker, once per pool */
  private roadsReady: Promise<void> | null = null;
  private roadsToWorkers(): Promise<void> {
    if (!this.roadsReady) {
      const pool = this.pool!;
      this.roadsReady = this.loadRoads()
        .then(() => this.roadsGz!)
        .then((gz) => Promise.all(pool.workers.map((_, i) => pool.call(i, { kind: 'roadsInit', gz: gz.slice(0) }))))
        .then(() => undefined)
        .catch((e) => {
          this.roadsReady = null;
          throw e;
        });
    }
    return this.roadsReady;
  }

  /** the scenario whose first skims are being found ahead of its run (prefetch) */
  private prefetchKey: string | null = null;
  /**
   * Find a scenario's first transit skims while it is being edited, so a run soon after finds them
   * made (the workers keep them by network; a scenario that changes only streets, charges, or
   * conditions has today's). Stops when a run starts or the scenario changes.
   */
  async prefetch(scenario: Scenario): Promise<void> {
    const key = runKey(scenario);
    if (this.running || this.prefetchKey === key || this.cache.has(key)) return;
    this.prefetchKey = key;
    try {
      await this.start();
      const day = scenario.day ?? 'wkd';
      const precise = await this.baseFor(day, 'precise');
      if (this.running || this.prefetchKey !== key) return;
      const calib = this.bundle.header.calibration!;
      const pool = this.pool!;
      await Promise.all(pool.workers.map((_, i) => pool.call(i, { kind: 'scenario', scenario, calib })));
      // the run's own first-pass inputs: today's crowding and lot prices (runModel's warm start)
      const { crowd, lot } = warmStart(this.bundle, scenario, calib, precise.finalCrowd, precise.finalLotPrice);
      const ex = new WorkerExecutor(pool, transitZones(this.bundle.header), this.bundle, calib);
      for (const p of SKIM_PERIODS) {
        if (this.running || this.prefetchKey !== key) return;
        await ex.skim(p, crowd[p], lot.some((v) => v > 0) ? lot : undefined);
      }
    } catch {
      /* a cancelled run or a stopped pool: the run finds its skims itself */
    } finally {
      if (this.prefetchKey === key) this.prefetchKey = null;
    }
  }

  /** a finished result for these edits, if one is cached */
  cached(scenario: Scenario): RunResult | undefined {
    return this.cache.get(runKey(scenario));
  }

  /** Run a scenario. Calls onProgress(stage, fraction). Rejects with CancelledError after cancel(). */
  async run(scenario: Scenario, onProgress: (stage: string, f: number) => void, calib: Calibration = this.bundle.header.calibration!): Promise<RunResult> {
    if (this.running) throw new Error('a run is already in progress');
    const key = runKey(scenario);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, scenario: scenario.name };
    this.running = true;
    const cancelled = new Promise<never>((_, reject) => (this.cancelRun = reject));
    try {
      const r = await Promise.race([this.runInner(scenario, onProgress, calib), cancelled]);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, r);
      return r;
    } finally {
      this.running = false;
      this.cancelRun = null;
    }
  }

  /** stop a run in progress (the workers are restarted on the next run) */
  cancel(): void {
    if (!this.running) return;
    this.cancelRun?.(new CancelledError());
    this.stop();
  }

  /** where the last run's time went */
  lastProfile: RunProfile | null = null;

  private async runInner(scenario: Scenario, onProgress0: (stage: string, f: number) => void, calib: Calibration): Promise<RunResult> {
    // the time between progress reports, by stage (a report's stage lasts until the next)
    const stages: Record<string, number> = {};
    const t0 = performance.now();
    let stage = '', ts = t0;
    const stageOf = (s: string) =>
      s.startsWith(TODAY_FIRST) ? 'today (baseline remade)' : /^Finding transit routes with the new bus/.test(s) ? 'transit paths (buses in new traffic)' : /^Finding/.test(s) ? 'transit paths (skims)' : /^Choosing/.test(s) ? 'demand' : /^Taking the time savings apart/.test(s) ? 'demand (time savings apart)' : /^Assigning/.test(s) ? 'roads' : /^Loading riders/.test(s) ? 'transit loading' : /^Loading the street/.test(s) ? 'loading the streets' : 'other';
    // the stage in hand: its text, where it starts on the bar, and its share of the bar
    let cur = { s: '', f: 0, span: 0 };
    const onProgress: Progress = (s, f, span = 0) => {
      const now = performance.now();
      if (stage) stages[stage] = (stages[stage] ?? 0) + (now - ts) / 1000;
      stage = stageOf(s);
      ts = now;
      cur = { s, f, span };
      onProgress0(s, f);
    };
    // the workers' progress within the stage: its count, and the bar moved through the stage's share
    const tick: StageTick = (detail, x) => onProgress0(`${cur.s} (${detail})`, cur.f + cur.span * Math.min(1, x));
    for (const b of this.pool?.busy ?? []) (b.busy = 0), (b.byKind = {});
    try {
      return await this.runBody(scenario, onProgress, calib, tick);
    } finally {
      if (stage) stages[stage] = (stages[stage] ?? 0) + (performance.now() - ts) / 1000;
      this.lastProfile = { mode: modeOf(scenario), seconds: (performance.now() - t0) / 1000, stages, workers: (this.pool?.busy ?? []).map((b) => ({ busy: +b.busy.toFixed(2), byKind: Object.fromEntries(Object.entries(b.byKind).map(([k, v]) => [k, +v.toFixed(2)])) })) };
    }
  }

  private async runBody(scenario: Scenario, onProgress0: Progress, calib: Calibration, tick: StageTick): Promise<RunResult> {
    let onProgress = onProgress0;
    onProgress('Starting the model', 0);
    await this.start();
    const pool = this.pool!;
    const day = scenario.day ?? 'wkd', mode = modeOf(scenario);
    const Z = transitZones(this.bundle.header);
    // traffic feedback: the road network in every worker
    let traffic: { net: RoadNet; aon: RoadAon; skim: RoadSkimmer } | undefined;
    if (day === 'wkd') {
      onProgress('Loading the street network', 0.01);
      const net = await this.loadRoads();
      await this.roadsToWorkers();
      traffic = { net, aon: workerAon(pool, net.h.nC), skim: workerSkimmer(pool, net.h.nC) };
    }
    // the comparison baseline must come from this same model and run mode (made first if the saved one doesn't)
    const { remade } = await this.consistentBase(day, mode, traffic, onProgress, tick);
    // (today's network made first took the first half of the bar)
    if (remade) onProgress = (s, f, span) => onProgress0(s, 0.5 + 0.5 * f, 0.5 * (span ?? 0));
    const precise = await this.baseFor(day, 'precise');
    await Promise.all(pool.workers.map((_, i) => pool.call(i, { kind: 'scenario', scenario, calib })));
    // start from today's crowding (the Precise baseline's, in either mode): one pass then settles a scenario
    const r = await runModel(this.bundle, scenario, calib, new WorkerExecutor(pool, Z, this.bundle, calib, tick), { iterations: 1, onProgress, warmCrowd: precise.finalCrowd, warmLot: precise.finalLotPrice, traffic }, prepare(this.bundle));
    const { demand: _d, volumes: _v, nets: _n, roadArrays: _r, ...result } = r;
    void _d, _v, _n, _r;
    result.bundleId = bundleId(this.bundle.header);
    return result;
  }

  /** free the workers (e.g. when the tab is hidden for long) */
  stop() {
    this.pool?.terminate();
    this.pool = null;
    this.ready = null;
    this.roadsReady = null;
  }
}
