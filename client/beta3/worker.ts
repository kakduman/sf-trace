/// <reference lib="webworker" />
/**
 * A model worker: holds the bundle and runs path searches (skims, loading) for the destinations it
 * is given, or the demand from its share of the origins, for the scenario it was last told about.
 */
import { gunzipSync } from 'fflate';
import { decodeBundle } from '../../shared/beta3/bundle';
import { DEMAND_PHASE, demandPart, prepare, type DemandOptions, type DemandSplit, type Prep, type TrnSkim, type TrnSkims } from '../../shared/beta3/demand';
import { aonOrigins, periodRoads, resolveRoadEdits, roadNetFrom, RoadPaths, skimRoads, type PeriodRoads, type RoadHeader, type RoadNet } from '../../shared/beta3/roads';
import { withRoadArrays } from '../../shared/beta3/traffic';
import { assignColumns, type DemandOverride } from '../../shared/beta3/model';
import { buildNet, type TransitNet } from '../../shared/beta3/net';
import { setBlocksWasm, setSearchWasm, StrategySolver } from '../../shared/beta3/strategy';
import type { Bundle, Calibration, Scenario, TPeriod } from '../../shared/beta3/types';
import { C_BIAS, C_BOARDS, C_COST, C_FARE, C_IVTP, C_REL, C_TIME, C_WAIT, C_WALK, NC } from '../../shared/beta3/net';
import { PATH } from '../../shared/beta3/params';
import { demandContextOf } from '../../shared/beta3/micromobility';

export type WorkerRequest =
  /** `wasm`: false runs the strategy search in TypeScript only; `search`: false keeps only its access split in WebAssembly (timing, testing) */
  | { kind: 'init'; id: number; gz: ArrayBuffer; wasm?: boolean; search?: boolean; lowMem?: boolean }
  | { kind: 'scenario'; id: number; scenario: Scenario; calib: Calibration }
  /** `out`: the skims in shared memory (Z × Z, origin rows), written in place (else the columns are sent back) */
  | { kind: 'skim'; id: number; period: TPeriod; crowd: Float32Array[] | null; lot?: Float32Array | null; dests: number[]; out?: SkimArrays }
  | { kind: 'assign'; id: number; period: TPeriod; crowd: Float32Array[] | null; lot?: Float32Array | null; dests: number[]; od: Float32Array }
  | { kind: 'demandPart'; id: number; sk: TrnSkims | null; skId: number; split: DemandSplit; opts?: DemandOptions; arrays?: Record<string, Uint16Array | Float32Array>; over?: DemandOverride }
  /** the road network (traffic feedback) */
  | { kind: 'roadsInit'; id: number; gz: ArrayBuffer }
  /** an all-or-nothing loading of these origins' trips at these link costs */
  | { kind: 'aon'; id: number; cost: Float64Array; od: Float32Array | null; odId: number; origins: number[] }
  /** least-cost road paths from these origins at these link times, on the scenario's streets or today's */
  | { kind: 'roadSkim'; id: number; which: 'scenario' | 'base'; period: TPeriod; time: Float64Array; toll: boolean; sums?: Float64Array[]; origins: number[] };

let bundle: Bundle | null = null;
let roads: { net: RoadNet; paths: RoadPaths } | null = null;
let prep: Prep | null = null;
let scenario: Scenario = { name: 'Today', edits: [] };
let calib: Calibration | null = null;
const nets = new Map<string, { net: TransitNet; solver: StrategySolver }>();
/** on a phone, keep one network and one set of skims at a time */
let lowMem = false;
/** the trips of the road assignment in progress (see the 'aon' request) */
let aonOD: { id: number; od: Float32Array } | null = null;
/** the transit skims of the demand in progress (see the 'demandPart' request) */
let demandSk: { id: number; sk: TrnSkims } | null = null;
/** each period's streets, today's and the scenario's (cleared with a new scenario) */
const roadPeriods = new Map<string, PeriodRoads>();
function roadsFor(which: 'scenario' | 'base', p: TPeriod): PeriodRoads {
  const key = `${which}:${p}`;
  let R = roadPeriods.get(key);
  if (!R) roadPeriods.set(key, (R = periodRoads(roads!.net, p, which === 'base' ? undefined : resolveRoadEdits(roads!.net, scenario))));
  return R;
}

/** the crowding and lot fingerprint of the last netFor */
let lastFp = 0;
/**
 * Skims made before, by everything that defines the transit network: the scenario less its street
 * and price edits (which reach the buses only through busDelay), the calibration, the period, and
 * the crowding and lot prices. A scenario that changes only streets, charges, or conditions makes
 * the same first skims as today's network; Engine.prefetch finds them while the scenario is edited.
 */
export type SkimArrays = Record<'g' | 'boards' | 'fare' | 'cost' | 'time', Float32Array>;
const SKIM_KEYS = ['g', 'boards', 'fare', 'cost', 'time'] as const;
const skimCache = new Map<string, SkimArrays>();
/** these destinations' columns (j · Z + o) into the shared Z × Z skims (o · Z + d) */
function scatter(cols: SkimArrays, out: SkimArrays, dests: number[], Z: number) {
  for (const k of SKIM_KEYS) {
    const c = cols[k], m = out[k];
    dests.forEach((d, j) => {
      for (let o = 0; o < Z; o++) m[o * Z + d] = c[j * Z + o];
    });
  }
}
let netKey = '';
const STREET_EDITS = new Set(['road', 'cordon', 'parking']);
function netKeyOf(s: Scenario, c: Calibration | null): string {
  const { name: _n, traffic: _t, edits, ...rest } = s;
  void _n, _t;
  const text = JSON.stringify([rest, edits.filter((e) => !STREET_EDITS.has(e.kind)), c]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(36)}:${text.length}`;
}

function netFor(period: TPeriod, crowd: Float32Array[] | null, lot?: Float32Array | null) {
  // crowding, boarding availability, and lot prices change between passes; key on a fingerprint of
  // every value (a sample could miss a change at a single stop)
  let fp = 0;
  if (crowd) for (const c of crowd) for (let i = 0; i < c.length; i++) fp = (Math.imul(fp, 31) + Math.round(c[i] * 1e4)) | 0;
  if (lot) for (let i = 0; i < lot.length; i++) if (lot[i]) fp = (Math.imul(fp, 31) + i * 7 + Math.round(lot[i] * 100)) | 0;
  const key = `${period}:${fp}`;
  lastFp = fp;
  let e = nets.get(key);
  if (!e) {
    if (nets.size > (lowMem ? 0 : 4)) nets.clear();
    const net = buildNet(bundle!, scenario, period, calib, crowd ?? undefined, lot ?? undefined);
    e = { net, solver: new StrategySolver(net) };
    nets.set(key, e);
  }
  return e;
}

/** this request's compute time, sent back with the reply (the engine's run profile) */
let started = 0;
const postMessage = (msg: Record<string, unknown>, transfer: Transferable[] = []) => self.postMessage({ ...msg, busy: performance.now() - started }, transfer);
/**
 * how far this request has got (destinations searched, origins chosen), for the page's progress
 * bar: at most every TICK_MS, so the messages cost the run nothing
 */
const TICK_MS = 150;
let lastTick = 0;
function tick(id: number, done: number, force = false) {
  const now = performance.now();
  if (now - lastTick < TICK_MS && !force) return;
  lastTick = now;
  self.postMessage({ id, tick: done });
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  started = performance.now();
  lastTick = started;
  try {
    switch (m.kind) {
      case 'init': {
        lowMem = !!m.lowMem;
        const bytes = new Uint8Array(m.gz);
        bundle = decodeBundle(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
        prep = prepare(bundle);
        calib = bundle.header.calibration;
        setBlocksWasm(m.wasm !== false);
        setSearchWasm(m.search !== false);
        postMessage({ id: m.id, ok: true });
        return;
      }
      case 'scenario':
        scenario = m.scenario;
        calib = m.calib;
        netKey = netKeyOf(scenario, calib);
        nets.clear();
        roadPeriods.clear();
        postMessage({ id: m.id, ok: true });
        return;
      case 'skim': {
        const { net, solver } = netFor(m.period, m.crowd, m.lot);
        const ckey = `${netKey}|${m.period}|${lastFp}|${m.dests[0]}/${m.dests.length}`;
        const hit = skimCache.get(ckey);
        if (hit && m.out) {
          scatter(hit, m.out, m.dests, net.nZones);
          postMessage({ id: m.id, dests: m.dests, shared: true, cached: true });
          return;
        }
        if (hit) {
          const c = { g: hit.g.slice(), boards: hit.boards.slice(), fare: hit.fare.slice(), cost: hit.cost.slice(), time: hit.time.slice() };
          postMessage({ id: m.id, dests: m.dests, ...c, cached: true }, [c.g.buffer, c.boards.buffer, c.fare.buffer, c.cost.buffer, c.time.buffer]);
          return;
        }
        const Z = net.nZones, n = m.dests.length;
        const g = new Float32Array(Z * n), boards = new Float32Array(Z * n), fare = new Float32Array(Z * n), cost = new Float32Array(Z * n), time = new Float32Array(Z * n);
        const { C } = solver;
        m.dests.forEach((d, j) => {
          tick(m.id, j);
          solver.solve(d);
          for (let o = 0; o < Z; o++) {
            const k = j * Z + o;
            if (o === d || solver.label(o) === Infinity) {
              g[k] = Infinity;
              time[k] = Infinity;
              continue;
            }
            const c = o * NC;
            g[k] = C[c + C_IVTP] + PATH.waitWeight * C[c + C_WAIT] + PATH.walkWeight * C[c + C_WALK] + C[c + C_BIAS] + (PATH.reliabilityInModeChoice ? C[c + C_REL] : 0);
            boards[k] = C[c + C_BOARDS];
            fare[k] = C[c + C_FARE];
            cost[k] = C[c + C_COST];
            time[k] = C[c + C_TIME] + C[c + C_WAIT];
          }
        });
        // kept for a later run with the same network (the last few periods' worth)
        if (skimCache.size >= (lowMem ? 1 : 8)) skimCache.delete(skimCache.keys().next().value!);
        if (m.out) {
          // (the columns kept as they are: nothing else holds them)
          skimCache.set(ckey, { g, boards, fare, cost, time });
          scatter({ g, boards, fare, cost, time }, m.out, m.dests, Z);
          postMessage({ id: m.id, dests: m.dests, shared: true });
          return;
        }
        skimCache.set(ckey, { g: g.slice(), boards: boards.slice(), fare: fare.slice(), cost: cost.slice(), time: time.slice() });
        postMessage({ id: m.id, dests: m.dests, g, boards, fare, cost, time }, [g.buffer, boards.buffer, fare.buffer, cost.buffer, time.buffer]);
        return;
      }
      case 'assign': {
        const { net, solver } = netFor(m.period, m.crowd, m.lot);
        const vol = assignColumns(net, m.od, m.dests, net.nZones, solver, (j) => tick(m.id, j));
        const out = Float64Array.from(vol);
        postMessage({ id: m.id, vol: out }, [out.buffer]);
        return;
      }
      case 'demandPart': {
        const b = m.arrays ? withRoadArrays(bundle!, m.arrays) : bundle!;
        // the skims come once per set (skId); feedback's later demands send only the driving times
        if (m.sk) demandSk = { id: m.skId, sk: m.sk };
        if (!demandSk || demandSk.id !== m.skId) throw new Error('demand: skims missing');
        // (`over`: some of the scenario's inputs put back to today's, to take its time savings apart)
        // (in thousandths; the last phases are always sent)
        const opts: DemandOptions = { ...m.opts, progress: (f) => tick(m.id, Math.round(f * 1000), f >= DEMAND_PHASE.notHome) };
        const p = demandPart(b, prep!, demandSk.sk, calib!, scenario.day ?? 'wkd', m.over ? m.over.autoCostFactor : (scenario.autoCostFactor ?? 1), m.split, undefined, m.over ? m.over.context : demandContextOf(scenario), opts);
        const transfer = [...Object.values(p.transitOD), p.zoneTrips, p.zoneTransit, p.zoneLS, p.zoneLSw, p.zoneWork, p.zoneWorkTransit, p.zoneVisits, p.zoneVisitsLeisure, p.zoneArrivals, p.zoneParkVisits, p.workInZone, ...Object.values(p.autoOD ?? {}), ...Object.values(p.tncEnds ?? {})].map((a) => a.buffer);
        postMessage({ id: m.id, part: p }, transfer);
        return;
      }
      case 'roadsInit': {
        const bytes = new Uint8Array(m.gz);
        const rb = decodeBundle(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
        const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
        roads = { net, paths: new RoadPaths(net) };
        postMessage({ id: m.id, ok: true });
        return;
      }
      case 'roadSkim': {
        const r = skimRoads(roadsFor(m.which, m.period), m.time, { toll: m.toll, origins: m.origins, sums: m.sums }, roads!.paths);
        postMessage({ id: m.id, time: r.time, toll: r.toll, sums: r.sums ?? null }, [r.time.buffer, ...(r.toll ? [r.toll.buffer] : []), ...(r.sums ?? []).map((x) => x.buffer)]);
        return;
      }
      case 'aon': {
        // the trips come once per assignment (odId); later loadings send only the costs
        if (m.od) aonOD = { id: m.odId, od: m.od };
        if (!aonOD || aonOD.id !== m.odId) throw new Error('road loading: trips missing');
        const r = aonOrigins(roads!.paths, m.cost, aonOD.od, m.origins);
        postMessage({ id: m.id, flow: r.flow, sp: r.sp, lost: r.lost }, [r.flow.buffer]);
        return;
      }
    }
  } catch (e) {
    postMessage({ id: m.id, error: (e as Error).message ?? String(e) });
  }
};

export type { TrnSkim };
