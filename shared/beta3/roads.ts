/**
 * Road traffic: a static, period-based, capacity-restrained assignment of vehicle trips to San
 * Francisco's streets, as MTC's Travel Model One and SF-CHAMP do it, so driving times respond to
 * demand and to changes in the streets.
 *
 *  - The network is OpenStreetMap's drivable streets in the city (no service roads), chains of
 *    blocks between intersections joined into links, with capacity from each link's general-purpose
 *    lanes (OSM lanes, less bus lanes) and TM1's capacity per lane by facility and area type;
 *    centroid connectors from each zone; outside zones join the city at its gateways (the Bay
 *    Bridge, the Golden Gate Bridge, and the roads that cross the San Mateo County line).
 *  - Volume-delay functions are TM1's (model-files/scripts/block/SpeedFlowCurve.block): a BPR form
 *    t0·(1 + 0.20·((V/C)/0.75)^6) on freeways and Akçelik's curve on the rest, its parameter set by
 *    TM1's critical speed for the facility and area type. Period capacity is the hourly capacity
 *    times TM2's capacity factor for the period (AM 3.65, MD 5, PM 3.65; the night 3 + 8).
 *  - Equilibrium is found by bi-conjugate Frank–Wolfe (Mitradjieva & Lindberg 2013) to a relative
 *    gap of 1e-3 (TM1 asks 5e-4 in the peaks).
 *  - Routes minimise time plus money at TM1's value of time for assignment ($15 an hour in 2000
 *    dollars, about $28 in 2025): tolls and the running cost per mile.
 *  - The Peninsula's freeways, US-101 and I-280 from the county line to San Jose, are links of the
 *    network too, cut at their main interchanges (PeninsulaHeader): the outside zones to the south
 *    reach the city along them, and each segment carries a fixed background (`pre`, the traffic with
 *    no end in the city) under the model's own cars, so that the two add up to the counts today.
 *
 * Node 0..nC−1 are centroids: the city's zones, the outside zones, and the gateways' own centroids
 * (through traffic and the background fitted to counts at the gateways). Centroids are only ever
 * the ends of a path, never passed through. Hubs follow (h.nHub nodes): each gateway's in and out
 * hub; then the Peninsula freeways' interchanges, which outside zones connect to.
 */
import type { Edit, RoadSummaryT, Scenario, TPeriod } from './types';
import { TPERIODS } from './types';
import { toXY } from './geo';
import type { RunMode } from './runmode';

/** TM2's highway capacity factors (tm2py model_config.toml), the night = EV 8 + EA 3 */
export const CAP_FACTOR: Record<TPeriod, number> = { AM: 3.65, MD: 5, PM: 3.65, NT: 11 };
export const VDF_FIXED = 0,
  VDF_FREEWAY = 1,
  VDF_AKCELIK = 2;
/** road classes, for capacity, reporting and validation */
export const RCLS = ['connector', 'freeway', 'ramp', 'expressway', 'arterial', 'collector', 'local'] as const;
export type RoadClass = (typeof RCLS)[number];
/** TM1's value of time in assignment: $15/hour (2000 dollars) × 1.86 (CPI-U, 2000 to 2025) */
export const ROUTE_VOT = 28;
/** running cost per mile in routing (params AUTO_COST_PER_MILE) */
export const ROUTE_COST_PER_MILE = 0.306;
/**
 * Signals: the uniform delay of HCM's signalized-intersection method (HCM 6th ed., Eq. 19-19),
 * d = 0.5·C·(1 − g/C)² / (1 − min(1, X)·g/C), grows with the approach's volume-to-capacity ratio X.
 * Its value at X = 0 is in the free-flow time (fitted at night); what it adds with traffic is added
 * at each signal on a link, with a 70 s cycle and half the cycle green (assumed: SF's signals run
 * 60 s cycles downtown and longer ones on the outer arterials).
 */
export const SIGNAL = { cycle: 70, green: 0.5 };
/** a closed street: kept in the network at this cost (minutes), so a warm start can move off it */
export const CLOSED_MIN = 600;

/** one counted location: the links whose volumes sum to it */
export interface RoadCount {
  src: 'caltrans' | 'sfmta';
  id: string;
  desc: string;
  links: number[];
  /** daily vehicles (both directions for Caltrans; one direction for SFMTA) */
  daily: number;
  /** Caltrans: peak hour; SFMTA: AM and PM peak hour */
  peak?: number;
  am?: number;
  pm?: number;
  year?: number;
  cls: RoadClass;
  /** a gateway count used to fit the background: not a test */
  fitted?: boolean;
}

/** a CMP monitoring segment: the links along it in its direction, and SFCTA's 2025 INRIX speeds */
export interface CmpSegment {
  id: number;
  name: string;
  from: string;
  to: string;
  dir: string;
  cls: 'arterial' | 'freeway';
  miles: number;
  links: number[];
  AM?: number;
  PM?: number;
}

export interface Gateway {
  name: string;
  kind: 'bridge' | 'freeway' | 'surface';
  lat: number;
  lon: number;
  /** the gateway's own centroid (background traffic) */
  centroid: number;
}

/** one direction of a Peninsula freeway between two interchanges (one link) */
export interface PeninsulaSegment {
  route: 'US-101' | 'I-280';
  dir: 'N' | 'S';
  from: string;
  to: string;
  link: number;
  miles: number;
  /** lanes, express and HOV lanes among them, and the free-flow speed (mph) */
  lanes: number;
  hov: number;
  ffMph: number;
  /** a weekday's traffic both ways (Caltrans AADT × the weekday factor) */
  daily: number;
  /** the vehicles counted on it by period (this direction): what the base reproduces */
  target?: Record<TPeriod, number>;
  /** the capacity factor by period fitted to INRIX's peak speeds (roads-base.ts), the median elsewhere */
  capFactor?: Record<TPeriod, number>;
}
export interface PeninsulaHeader {
  segments: PeninsulaSegment[];
  /** C/CAG's monitored segments: the model's links along each, and INRIX's peak speeds (mph) */
  monitored: { route: 'US-101' | 'I-280'; dir: 'N' | 'S'; from: string; to: string; links: number[]; ffs: number; AM: number; PM: number }[];
  /** the share of a weekday's traffic by period (both ways), and the southbound share */
  periodShare: Record<TPeriod, number>;
  southShare: Record<TPeriod, number>;
  /** the interchanges: hub nodes by route, direction, and cut (north to south) */
  cuts: Record<string, string[]>;
}

export interface RoadHeader {
  version: number;
  built: string;
  nZ: number;
  nX: number;
  /** centroids: zones, outside zones, gateways */
  nC: number;
  nNodes: number;
  nLinks: number;
  gateways: Gateway[];
  /** hub nodes after the centroids (default: the gateways' in and out hubs) */
  nHub?: number;
  /** the Peninsula freeways (roads.ts, roads-base.ts) */
  peninsula?: PeninsulaHeader;
  names: string[];
  counts: RoadCount[];
  cmp: CmpSegment[];
  /** the targets the free-flow times were fitted to, and the hourly speeds by period (INRIX) */
  speedTargets: Record<string, Record<string, number | number[]>>;
  /** commercial vehicles (SF-CHAMP's model): trip rates and time-of-day shares */
  commercial?: { trips: number; tod: Record<TPeriod, number> };
  /** the base assignment: relative gap by period, BFW iterations, and the background fitted */
  base?: { gap: Record<TPeriod, number>; iterations: Record<TPeriod, number>; background: Record<string, number>; vehicles: Record<TPeriod, number>; /** the model bundle (bundleId) whose trips today's flows are */ modelId?: string };
  arrays: Record<string, { type: string; offset: number; length: number }>;
}

/** the road network as loaded (arrays from the roads bundle) */
export interface RoadNet {
  h: RoadHeader;
  /** link tail and head nodes; links are sorted by tail, `start` indexes them (forward star) */
  a: Int32Array;
  b: Int32Array;
  start: Int32Array;
  /** miles */
  len: Float32Array;
  /** free-flow minutes by period (TPERIODS × nLinks; connectors to the gateways vary by period) */
  t0: Float32Array;
  /** vehicles per hour, all general-purpose lanes */
  cap: Float32Array;
  lanes: Float32Array;
  vdf: Uint8Array;
  /** Akçelik's J (hours² per mile²) */
  ja: Float32Array;
  cls: Uint8Array;
  /** money paid on the link by period ($, TPERIODS × nLinks): bridge tolls */
  toll: Float32Array;
  name: Int32Array;
  /** route numbers ("US 101"), into names */
  ref: Int32Array;
  nodeLat: Float32Array;
  nodeLon: Float32Array;
  /** drawn shape of each link: points [lat, lon, ...] from shapeStart[k] */
  shapeStart: Int32Array;
  shape: Float32Array;
  /** traffic signals along each link */
  sig: Uint8Array;
  /** share of each link's length with a bus lane (OSM) */
  busLane: Float32Array;
  /** each bundle line's hops (busLineStart[line]…[line + 1]), and each hop's links and the share of each it runs along */
  busLineStart: Int32Array;
  busHopStart: Int32Array;
  busHopLink: Int32Array;
  busHopFrac: Float32Array;
  /** base equilibrium flows by period (vehicles), and the base vehicle trips (sqrt-quantised) */
  base: Partial<Record<TPeriod, Float32Array>>;
  baseOD: Partial<Record<TPeriod, Uint16Array>>;
  /** fixed background vehicle trips (commercial vehicles, through traffic, gateway residual), sqrt-quantised */
  bgOD: Partial<Record<TPeriod, Uint16Array>>;
  /**
   * today's flows and vehicle trips as the Quick run mode makes them (runmode.ts), when the bundle
   * has them: a Quick scenario pivots on these, so that one changing nothing changes nothing
   */
  baseQuick: Partial<Record<TPeriod, Float32Array>>;
  baseODQuick: Partial<Record<TPeriod, Uint16Array>>;
  /** the Peninsula freeways: 1 on US-101's links, 2 on I-280's, 0 elsewhere */
  corr: Uint8Array;
  /** the fixed background on each link by period (vehicles; the Peninsula freeways' traffic with no end in the city) */
  pre: Partial<Record<TPeriod, Float32Array>>;
  /** capacity factor by period and link (fitted on the Peninsula freeways; absent or 1 elsewhere) */
  capfP: Partial<Record<TPeriod, Float32Array>>;
}

/** today's road flows and trips for a run mode (Precise's when the bundle has none for it) */
export function roadBase(net: RoadNet, mode: RunMode = 'precise'): { flow: Partial<Record<TPeriod, Float32Array>>; od: Partial<Record<TPeriod, Uint16Array>> } {
  if (mode === 'quick' && Object.keys(net.baseQuick).length) return { flow: net.baseQuick, od: net.baseODQuick };
  return { flow: net.base, od: net.baseOD };
}

type TA = Float32Array | Uint16Array | Int32Array | Uint8Array | Float64Array | Uint32Array;
export function roadNetFrom(h: RoadHeader, A: Record<string, TA>): RoadNet {
  const per = <T extends TA>(k: string) => Object.fromEntries(TPERIODS.filter((p) => A[`${k}_${p}`]).map((p) => [p, A[`${k}_${p}`] as T])) as Partial<Record<TPeriod, T>>;
  return {
    h,
    a: A.a as Int32Array,
    b: A.b as Int32Array,
    start: A.start as Int32Array,
    len: A.len as Float32Array,
    t0: A.t0 as Float32Array,
    cap: A.cap as Float32Array,
    lanes: A.lanes as Float32Array,
    vdf: A.vdf as Uint8Array,
    ja: A.ja as Float32Array,
    cls: A.cls as Uint8Array,
    toll: A.toll as Float32Array,
    name: A.name as Int32Array,
    ref: A.ref as Int32Array,
    nodeLat: A.nodeLat as Float32Array,
    nodeLon: A.nodeLon as Float32Array,
    shapeStart: A.shapeStart as Int32Array,
    shape: A.shape as Float32Array,
    busLane: (A.busLane as Float32Array) ?? new Float32Array(h.nLinks),
    sig: (A.sig as Uint8Array) ?? new Uint8Array(h.nLinks),
    busLineStart: (A.busLineStart as Int32Array) ?? new Int32Array(1),
    busHopStart: (A.busHopStart as Int32Array) ?? new Int32Array(1),
    busHopLink: (A.busHopLink as Int32Array) ?? new Int32Array(0),
    busHopFrac: (A.busHopFrac as Float32Array) ?? new Float32Array(0),
    corr: (A.corr as Uint8Array) ?? new Uint8Array(h.nLinks),
    pre: per<Float32Array>('pre'),
    capfP: per<Float32Array>('capf'),
    base: per<Float32Array>('base'),
    baseOD: per<Uint16Array>('baseOD'),
    bgOD: per<Uint16Array>('bgOD'),
    // Quick's flows are stored as they are; its trips as the difference from Precise's (mostly zeros, so they compress)
    baseQuick: per<Float32Array>('baseQuick'),
    baseODQuick: Object.fromEntries(
      TPERIODS.filter((p) => A[`baseODdQuick_${p}`] && A[`baseOD_${p}`]).map((p) => {
        const b = A[`baseOD_${p}`] as Uint16Array, d = A[`baseODdQuick_${p}`] as Uint16Array;
        return [p, Uint16Array.from(b, (v, i) => (v + d[i]) & 0xffff)];
      }),
    ) as Partial<Record<TPeriod, Uint16Array>>,
  };
}

/** trips are kept to 2 bytes a cell on a square-root scale: 0.0002 vehicles to 65,000 */
export const quantise = (v: number) => Math.min(65535, Math.round(Math.sqrt(Math.max(0, v)) * 256));
export const dequantise = (q: number) => (q / 256) ** 2;
export function dequantiseOD(q: Uint16Array | undefined, n: number): Float32Array {
  const out = new Float32Array(n);
  if (q) for (let i = 0; i < n; i++) if (q[i]) out[i] = dequantise(q[i]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// scenario edits

/** a street's links between two points: those named `street` within `width` m of the line */
function streetLinks(net: RoadNet, street: string, from: { lat: number; lon: number }, to: { lat: number; lon: number }, via: { lat: number; lon: number }[] = [], width = 45): number[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(street|st)\b/g, 'st')
      .replace(/\b(avenue|ave)\b/g, 'ave')
      .replace(/\b(boulevard|blvd)\b/g, 'blvd')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const want = norm(street);
  const pts = [from, ...via, to].map((p) => toXY(p.lat, p.lon));
  const out: number[] = [];
  const near = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i],
        [bx, by] = pts[i + 1];
      const dx = bx - ax,
        dy = by - ay;
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  };
  for (let k = 0; k < net.h.nLinks; k++) {
    if (net.cls[k] === 0) continue;
    const nm = net.name[k] >= 0 ? norm(net.h.names[net.name[k]]) : '';
    if (nm !== want && !nm.startsWith(want + ' ')) continue;
    const [x1, y1] = toXY(net.nodeLat[net.a[k]], net.nodeLon[net.a[k]]);
    const [x2, y2] = toXY(net.nodeLat[net.b[k]], net.nodeLon[net.b[k]]);
    if (near(x1, y1) <= width && near(x2, y2) <= width) out.push(k);
  }
  return out;
}

/** point in polygon (lat/lon ring) */
function inside(ring: [number, number][], lat: number, lon: number) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ya, xa] = ring[i],
      [yb, xb] = ring[j];
    if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) c = !c;
  }
  return c;
}

export interface RoadEditsResolved {
  /** general-purpose lanes after the edits, by period (TPERIODS × nLinks), and closed links */
  lanes: Float32Array;
  closed: Uint8Array;
  /** links where the scenario gives buses their own lane, by period (TPERIODS × nLinks) */
  busLane: Uint8Array;
  /** money added on each link by period ($, TPERIODS × nLinks) */
  toll: Float32Array;
  /** links each edit touched (for the page) */
  byEdit: Record<string, number[]>;
  any: boolean;
}

export type RoadEdit = Extract<Edit, { kind: 'road' } | { kind: 'cordon' }>;
export const isRoadEdit = (e: Edit): e is RoadEdit => e.kind === 'road' || e.kind === 'cordon';

/** Turn a scenario's road edits into lanes, closures and tolls on links. */
export function resolveRoadEdits(net: RoadNet, scenario: Scenario): RoadEditsResolved {
  const L = net.h.nLinks,
    P = TPERIODS.length;
  const lanes = new Float32Array(P * L);
  for (let q = 0; q < P; q++) lanes.set(net.lanes, q * L);
  const closed = new Uint8Array(P * L);
  const busLane = new Uint8Array(P * L);
  const toll = new Float32Array(P * L);
  const byEdit: Record<string, number[]> = {};
  let any = false;
  for (const e of scenario.edits) {
    if (!isRoadEdit(e)) continue;
    any = true;
    const periods = (e.periods?.length ? e.periods : TPERIODS) as readonly TPeriod[];
    if (e.kind === 'road') {
      const links = streetLinks(net, e.street, e.from, e.to, e.via);
      byEdit[e.id] = links;
      for (const k of links)
        for (const p of periods) {
          const q = TPERIODS.indexOf(p);
          if (e.closed) {
            closed[q * L + k] = 1;
            continue;
          }
          // a street that has a bus lane already keeps its lanes for cars under a bus-lane edit
          if (e.busLane && net.busLane[k] >= 0.5) continue;
          if (e.busLane) busLane[q * L + k] = 1;
          // taking lanes leaves at least one: closing a street is its own edit
          lanes[q * L + k] = Math.max(1, lanes[q * L + k] + (e.lanes ?? 0));
        }
    } else {
      const inRing = new Uint8Array(net.h.nNodes);
      for (let v = net.h.nC; v < net.h.nNodes; v++) inRing[v] = inside(e.ring, net.nodeLat[v], net.nodeLon[v]) ? 1 : 0;
      const links: number[] = [];
      for (let k = 0; k < L; k++) {
        if (net.a[k] < net.h.nC || net.b[k] < net.h.nC) continue;
        const enter = !inRing[net.a[k]] && inRing[net.b[k]],
          leave = inRing[net.a[k]] && !inRing[net.b[k]];
        if (!(enter || (e.outbound && leave))) continue;
        links.push(k);
        for (const p of periods) toll[TPERIODS.indexOf(p) * L + k] += e.toll[p] ?? 0;
      }
      byEdit[e.id] = links;
    }
  }
  return { lanes, closed, busLane, toll, byEdit, any };
}

// ---------------------------------------------------------------------------------------------
// one period's link costs

/** what the assignment needs for one period on one scenario's streets */
export interface PeriodRoads {
  p: TPeriod;
  net: RoadNet;
  /** free-flow minutes, period capacity (vehicles in the period), fixed minutes (money), toll $ */
  t0: Float64Array;
  C: Float64Array;
  fixed: Float64Array;
  toll: Float64Array;
  vdf: Uint8Array;
  /** Akçelik's 16·J·D² per link (dimensionless with V/C) */
  k16: Float64Array;
  /** signals on each link */
  sig: Uint8Array;
  /** fixed background vehicles on each link (the Peninsula freeways'), or null */
  pre: Float64Array | null;
}

export function periodRoads(net: RoadNet, p: TPeriod, ed?: RoadEditsResolved): PeriodRoads {
  const L = net.h.nLinks,
    q = TPERIODS.indexOf(p);
  const t0 = new Float64Array(L),
    C = new Float64Array(L),
    fixed = new Float64Array(L),
    toll = new Float64Array(L),
    k16 = new Float64Array(L);
  const vdf = new Uint8Array(net.vdf);
  const perMin = 60 / ROUTE_VOT;
  const pp = net.pre[p];
  const pre = pp ? Float64Array.from(pp) : null;
  const cf = net.capfP[p];
  for (let k = 0; k < L; k++) {
    t0[k] = net.t0[q * L + k];
    const ln = ed ? ed.lanes[q * L + k] : net.lanes[k];
    C[k] = net.lanes[k] > 0 ? (net.cap[k] * (cf ? cf[k] : 1) * ln) / net.lanes[k] * CAP_FACTOR[p] : 0;
    toll[k] = net.toll[q * L + k] + (ed ? ed.toll[q * L + k] : 0);
    fixed[k] = perMin * (toll[k] + ROUTE_COST_PER_MILE * net.len[k]);
    k16[k] = 16 * net.ja[k] * net.len[k] * net.len[k];
    if (ed && ed.closed[q * L + k]) {
      t0[k] = CLOSED_MIN;
      vdf[k] = VDF_FIXED;
    }
  }
  return { p, net, t0, C, fixed, toll, vdf, k16, sig: net.sig, pre };
}

/**
 * Hold the Peninsula freeways at fixed times (minutes by link), as Quick does: their links stop
 * responding to traffic, so nothing a scenario does changes their speeds.
 */
export function freezeCorridors(R: PeriodRoads, time: ArrayLike<number>) {
  const corr = R.net.corr;
  for (let k = 0; k < R.t0.length; k++)
    if (corr[k]) {
      R.t0[k] = time[k];
      R.vdf[k] = VDF_FIXED;
    }
}

/** travel minutes on each link at flows x (and, if `dt`, the derivative per vehicle) */
export function linkTimes(R: PeriodRoads, x: ArrayLike<number>, t: Float64Array, dt?: Float64Array) {
  const { t0, C, vdf, k16, sig, pre } = R;
  for (let k = 0; k < t.length; k++) {
    const v = vdf[k];
    if (v === VDF_FIXED || !(C[k] > 0)) {
      t[k] = t0[k];
      if (dt) dt[k] = 0;
    } else if (v === VDF_FREEWAY) {
      // (the fixed background, where there is one, shares the road)
      const r = (pre ? x[k] + pre[k] : x[k]) / C[k] / 0.75;
      const r5 = r * r * r * r * r;
      t[k] = t0[k] * (1 + 0.2 * r5 * r);
      if (dt) dt[k] = (t0[k] * 0.2 * 6 * r5) / (0.75 * C[k]);
    } else {
      // Akçelik, as TM1 writes it: 60·(D/S0 + 0.25·((u−1) + √((u−1)² + 16·J·u·D²))), T = 1 hour
      const u = x[k] / C[k],
        w = u - 1,
        s = Math.sqrt(w * w + k16[k] * u);
      t[k] = t0[k] + 15 * (w + s);
      if (dt) dt[k] = s > 0 ? (15 * (1 + (w + 0.5 * k16[k]) / s)) / C[k] : 0;
      const ns = sig[k];
      if (ns) {
        // the signals' uniform delay beyond its empty-street value, minutes
        const g = SIGNAL.green,
          a = (0.5 * SIGNAL.cycle * (1 - g) ** 2) / 60,
          xx = Math.min(u, 0.98);
        t[k] += ns * a * (1 / (1 - xx * g) - 1);
        if (dt && u < 0.98) dt[k] += (ns * a * g) / (1 - xx * g) ** 2 / C[k];
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// shortest paths and all-or-nothing loading

/** shortest-path trees over the road network (one per origin), reused across calls */
export class RoadPaths {
  readonly n: number;
  readonly dist: Float64Array;
  readonly pred: Int32Array;
  readonly order: Int32Array;
  nOrder = 0;
  private heapId: Int32Array;
  private heapKey: Float64Array;
  private done: Uint32Array;
  private stamp = 0;
  private nodeFlow: Float64Array;
  constructor(readonly net: RoadNet) {
    this.n = net.h.nNodes;
    this.dist = new Float64Array(this.n);
    this.pred = new Int32Array(this.n);
    this.order = new Int32Array(this.n);
    this.heapId = new Int32Array(net.h.nLinks + this.n);
    this.heapKey = new Float64Array(net.h.nLinks + this.n);
    this.done = new Uint32Array(this.n);
    this.nodeFlow = new Float64Array(this.n);
  }

  /** labels from centroid o over link costs `cost` (centroids are not passed through) */
  tree(o: number, cost: Float64Array) {
    const { dist, pred, order, done } = this;
    const { start, b } = this.net;
    const nC = this.net.h.nC;
    const hid = this.heapId,
      hk = this.heapKey;
    const st = ++this.stamp;
    dist.fill(Infinity);
    dist[o] = 0;
    pred[o] = -1;
    let size = 0;
    // push
    const push = (id: number, key: number) => {
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= key) break;
        hid[i] = hid[p];
        hk[i] = hk[p];
        i = p;
      }
      hid[i] = id;
      hk[i] = key;
    };
    push(o, 0);
    let n = 0;
    while (size > 0) {
      const u = hid[0],
        du = hk[0];
      // pop
      const lid = hid[--size],
        lk = hk[size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= lk) break;
        hid[i] = hid[c];
        hk[i] = hk[c];
        i = c;
      }
      hid[i] = lid;
      hk[i] = lk;
      if (done[u] === st || du > dist[u]) continue;
      done[u] = st;
      order[n++] = u;
      if (u < nC && u !== o) continue;
      for (let k = start[u], e = start[u + 1]; k < e; k++) {
        const v = b[k];
        const nd = du + cost[k];
        if (nd < dist[v]) {
          dist[v] = nd;
          pred[v] = k;
          push(v, nd);
        }
      }
    }
    this.nOrder = n;
  }

  /**
   * Load one origin's trips (row: trips to each centroid) onto the last tree, adding to `flow`;
   * returns Σ trips × path cost, and the trips with no path in `lost`.
   */
  load(o: number, row: ArrayLike<number>, rowOff: number, flow: Float64Array, lost: { n: number }): number {
    const { dist, pred, order, nodeFlow } = this;
    const a = this.net.a;
    const nC = this.net.h.nC;
    let sp = 0;
    for (let d = 0; d < nC; d++) {
      const v = row[rowOff + d];
      if (!v || d === o) continue;
      if (dist[d] < Infinity) {
        nodeFlow[d] += v;
        sp += v * dist[d];
      } else lost.n += v;
    }
    for (let i = this.nOrder - 1; i > 0; i--) {
      const u = order[i];
      const f = nodeFlow[u];
      if (!f) continue;
      nodeFlow[u] = 0;
      const k = pred[u];
      flow[k] += f;
      nodeFlow[a[k]] += f;
    }
    nodeFlow[o] = 0;
    return sp;
  }

  /**
   * Skim the last tree: time (minutes), toll ($) and miles to every centroid along the
   * least-cost paths, into row `o` of the matrices.
   */
  skim(o: number, time: Float64Array, toll: Float64Array | null, T: Float32Array, M: Float32Array | null, D: Float32Array | null) {
    const { pred, order } = this;
    const { a, len } = this.net;
    const nC = this.net.h.nC;
    const tt = (this.sTime ??= new Float64Array(this.n)),
      tl = (this.sToll ??= new Float64Array(this.n)),
      mi = (this.sMiles ??= new Float64Array(this.n));
    const reached = (this.sReached ??= new Uint32Array(nC));
    const st = ++this.stamp;
    const root = order[0];
    tt[root] = tl[root] = mi[root] = 0;
    for (let i = 1; i < this.nOrder; i++) {
      const u = order[i],
        k = pred[u],
        t = a[k];
      tt[u] = tt[t] + time[k];
      if (toll) tl[u] = tl[t] + toll[k];
      if (D) mi[u] = mi[t] + len[k];
    }
    for (let i = 0; i < this.nOrder; i++) if (order[i] < nC) reached[order[i]] = st;
    for (let d = 0; d < nC; d++) {
      const r = o * nC + d;
      if (d === o || reached[d] !== st) {
        T[r] = d === o ? 0 : Infinity;
        if (M) M[r] = 0;
        if (D) D[r] = 0;
        continue;
      }
      T[r] = tt[d];
      if (M) M[r] = tl[d];
      if (D) D[r] = mi[d];
    }
  }
  private sTime?: Float64Array;
  private sToll?: Float64Array;
  private sMiles?: Float64Array;
  private sReached?: Uint32Array;
  private sAcc?: Float64Array[];

  /** Sum link arrays along the last tree: into row `o` of each `out` (nC × nC), the sum over the path to each centroid. */
  sumAlong(o: number, link: ArrayLike<number>[], out: Float32Array[]) {
    const { pred, order } = this;
    const a = this.net.a;
    const nC = this.net.h.nC;
    const acc = (this.sAcc ??= []);
    while (acc.length < link.length) acc.push(new Float64Array(this.n));
    const reached = (this.sReached ??= new Uint32Array(nC));
    const st = ++this.stamp;
    const root = order[0];
    for (let j = 0; j < link.length; j++) acc[j][root] = 0;
    for (let i = 1; i < this.nOrder; i++) {
      const u = order[i],
        k = pred[u],
        t = a[k];
      for (let j = 0; j < link.length; j++) acc[j][u] = acc[j][t] + link[j][k];
    }
    for (let i = 0; i < this.nOrder; i++) if (order[i] < nC) reached[order[i]] = st;
    for (let d = 0; d < nC; d++) {
      const r = o * nC + d;
      for (let j = 0; j < link.length; j++) out[j][r] = d === o ? 0 : reached[d] === st ? acc[j][d] : NaN;
    }
  }
}

/** An all-or-nothing loading of a period's trips at fixed link costs: link flows and Σ trips × cost. */
export interface RoadAon {
  (p: TPeriod, cost: Float64Array, od: Float32Array): Promise<{ flow: Float64Array; sp: number; lost: number }>;
}

/** in-process loading (Node, tests; the page splits origins over workers) */
export function localAon(net: RoadNet, origins?: number[]): RoadAon {
  const paths = new RoadPaths(net);
  const nC = net.h.nC;
  return async (_p, cost, od) => aonOrigins(paths, cost, od, origins ?? [...Array(nC).keys()]);
}
/**
 * All-or-nothing loading from the given origins. An outside zone (or a gateway's own centroid)
 * reaches the streets only through the gateways' hubs, so its shortest paths are its connector plus
 * the hub's: one tree per hub serves every outside zone, instead of one per zone. (A zone joined to
 * the Peninsula freeways' interchanges gets a tree of its own.)
 */
const hubCache = new WeakMap<RoadPaths, { viaHub: Uint8Array; hubs: Map<number, RoadPaths> }>();
export function aonOrigins(paths: RoadPaths, cost: Float64Array, od: Float32Array, origins: number[]) {
  const net = paths.net;
  const nC = net.h.nC,
    nHub = net.h.nHub ?? 2 * net.h.gateways.length;
  const flow = new Float64Array(net.h.nLinks);
  const lost = { n: 0 };
  let sp = 0;
  let hc = hubCache.get(paths);
  if (!hc) {
    const viaHub = new Uint8Array(nC);
    const hubs = new Map<number, RoadPaths>();
    for (let o = 0; o < nC; o++) {
      const k0 = net.start[o],
        k1 = net.start[o + 1];
      if (k1 <= k0) continue;
      let all = true;
      for (let k = k0; k < k1; k++) if (!(net.b[k] >= nC && net.b[k] < nC + nHub)) all = false;
      if (!all) continue;
      viaHub[o] = 1;
      for (let k = k0; k < k1; k++) if (!hubs.has(net.b[k])) hubs.set(net.b[k], new RoadPaths(net));
    }
    hc = { viaHub, hubs };
    hubCache.set(paths, hc);
  }
  const hubOrigins = origins.filter((o) => hc!.viaHub[o]);
  for (const o of origins) {
    if (hc.viaHub[o]) continue;
    let any = false;
    for (let d = 0; d < nC; d++) if (od[o * nC + d] > 0) ((any = true), (d = nC));
    if (!any) continue;
    paths.tree(o, cost);
    sp += paths.load(o, od, o * nC, flow, lost);
  }
  if (hubOrigins.length) {
    for (const [h, P] of hc.hubs) P.tree(h, cost);
    const agg = new Map<number, Float64Array>();
    for (const h of hc.hubs.keys()) agg.set(h, new Float64Array(nC));
    for (const o of hubOrigins) {
      const k0 = net.start[o],
        k1 = net.start[o + 1];
      for (let d = 0; d < nC; d++) {
        const v = od[o * nC + d];
        if (!v || d === o) continue;
        let best = -1,
          bc = Infinity;
        for (let k = k0; k < k1; k++) {
          const c = cost[k] + hc.hubs.get(net.b[k])!.dist[d];
          if (c < bc) ((bc = c), (best = k));
        }
        if (best < 0 || !(bc < Infinity)) {
          lost.n += v;
          continue;
        }
        flow[best] += v;
        agg.get(net.b[best])![d] += v;
        sp += v * bc;
      }
    }
    for (const [h, P] of hc.hubs) P.load(h, agg.get(h)!, 0, flow, lost);
  }
  return { flow, sp, lost: lost.n };
}

// ---------------------------------------------------------------------------------------------
// equilibrium (bi-conjugate Frank–Wolfe)

export interface EquilibriumResult {
  flow: Float64Array;
  /** congested minutes per link */
  time: Float64Array;
  gap: number;
  iterations: number;
  lost: number;
  /** the relative gap after each iteration */
  gaps: number[];
}

/**
 * User equilibrium for one period (Beckmann's problem) by bi-conjugate Frank–Wolfe
 * (Mitradjieva & Lindberg 2013, as AequilibraE implements it), from `warm` flows when given:
 * they must be feasible for these trips (see warmFlows).
 */
export async function equilibrium(R: PeriodRoads, od: Float32Array, aon: RoadAon, opts: { gap?: number; maxIter?: number; warm?: Float64Array; onIter?: (it: number, gap: number) => void } = {}): Promise<EquilibriumResult> {
  const L = R.t0.length;
  const tol = opts.gap ?? 1e-3,
    maxIter = opts.maxIter ?? 200;
  const t = new Float64Array(L),
    dt = new Float64Array(L),
    cost = new Float64Array(L);
  const costAt = (x: ArrayLike<number>, withDt: boolean) => {
    linkTimes(R, x, t, withDt ? dt : undefined);
    for (let k = 0; k < L; k++) cost[k] = t[k] + R.fixed[k];
  };
  let x: Float64Array;
  let lost = 0;
  if (opts.warm) x = Float64Array.from(opts.warm);
  else {
    costAt(new Float64Array(L), false);
    const r = await aon(R.p, cost, od);
    x = r.flow;
    lost = r.lost;
  }
  let sPrev: Float64Array | null = null,
    sPrev2: Float64Array | null = null,
    tauPrev = 1;
  const gaps: number[] = [];
  let gap = Infinity,
    it = 0;
  for (; ; it++) {
    costAt(x, true);
    const r = await aon(R.p, cost, od);
    lost = r.lost;
    const y = r.flow;
    let tstt = 0;
    for (let k = 0; k < L; k++) tstt += x[k] * cost[k];
    if (!Number.isFinite(tstt) || !Number.isFinite(r.sp)) throw new Error('road assignment: link costs are not finite');
    gap = tstt > 0 ? Math.max(0, (tstt - r.sp) / tstt) : 0;
    gaps.push(gap);
    opts.onIter?.(it, gap);
    if (gap <= tol || it >= maxIter) break;
    // the direction: Frank–Wolfe's first, conjugate the second, bi-conjugate after (with restarts)
    let s: Float64Array = y;
    if (sPrev && tauPrev < 0.99999) {
      if (!sPrev2) {
        let num = 0,
          den = 0;
        for (let k = 0; k < L; k++) {
          const a1 = sPrev[k] - x[k];
          num += a1 * (y[k] - x[k]) * dt[k];
          den += a1 * (y[k] - sPrev[k]) * dt[k];
        }
        let al = den !== 0 ? num / den : 0;
        al = Math.max(0, Math.min(0.99999, al));
        s = new Float64Array(L);
        for (let k = 0; k < L; k++) s[k] = al * sPrev[k] + (1 - al) * y[k];
      } else {
        let muN = 0,
          muD = 0,
          nuN = 0,
          nuD = 0;
        for (let k = 0; k < L; k++) {
          const xb = tauPrev * sPrev[k] - x[k] + (1 - tauPrev) * sPrev2[k];
          const yx = y[k] - x[k],
            sx = sPrev[k] - x[k];
          muN += xb * yx * dt[k];
          muD += xb * (sPrev2[k] - sPrev[k]) * dt[k];
          nuN += sx * yx * dt[k];
          nuD += sx * sx * dt[k];
        }
        const mu = muD !== 0 ? Math.max(0, -muN / muD) : 0;
        const nu = nuD !== 0 ? Math.max(0, -nuN / nuD + (mu * tauPrev) / (1 - tauPrev)) : 0;
        const b0 = 1 / (1 + mu + nu),
          b1 = nu * b0,
          b2 = mu * b0;
        if (Number.isFinite(b0) && Number.isFinite(b1) && Number.isFinite(b2)) {
          s = new Float64Array(L);
          for (let k = 0; k < L; k++) s[k] = b0 * y[k] + b1 * sPrev[k] + b2 * sPrev2[k];
        }
      }
    }
    // line search: the step that makes Σ c(x + τ(s − x))·(s − x) zero (bisection)
    const d = new Float64Array(L);
    for (let k = 0; k < L; k++) d[k] = s[k] - x[k];
    const xs = new Float64Array(L),
      ts = new Float64Array(L);
    const slope = (tau: number) => {
      for (let k = 0; k < L; k++) xs[k] = x[k] + tau * d[k];
      linkTimes(R, xs, ts);
      let g = 0;
      for (let k = 0; k < L; k++) g += (ts[k] + R.fixed[k]) * d[k];
      return g;
    };
    let lo = 0,
      hi = 1,
      tau = 1;
    if (slope(1) > 0) {
      for (let i = 0; i < 24; i++) {
        const m = 0.5 * (lo + hi);
        if (slope(m) > 0) hi = m;
        else lo = m;
      }
      tau = 0.5 * (lo + hi);
    }
    for (let k = 0; k < L; k++) x[k] += tau * d[k];
    // a step to the end restarts the conjugate directions
    if (tau >= 0.99999) {
      sPrev = null;
      sPrev2 = null;
    } else {
      sPrev2 = sPrev;
      sPrev = s;
    }
    tauPrev = tau;
  }
  linkTimes(R, x, t);
  return { flow: x, time: Float64Array.from(t), gap, iterations: it, lost, gaps };
}

/**
 * A feasible start for new trips from an earlier equilibrium: its flows, plus the change in trips
 * loaded all-or-nothing on the paths at its costs (the paths the earlier trips were using), clipped
 * at zero.
 */
export async function warmFlows(R: PeriodRoads, prevFlow: ArrayLike<number>, prevOD: Float32Array, od: Float32Array, aon: RoadAon): Promise<Float64Array> {
  const L = R.t0.length;
  const t = new Float64Array(L),
    cost = new Float64Array(L);
  linkTimes(R, prevFlow, t);
  for (let k = 0; k < L; k++) cost[k] = t[k] + R.fixed[k];
  const delta = new Float32Array(od.length);
  let any = false;
  for (let i = 0; i < od.length; i++) {
    delta[i] = od[i] - prevOD[i];
    if (delta[i] !== 0) any = true;
  }
  const x = Float64Array.from(prevFlow);
  if (!any) return x;
  // loading signed trips: the tree is the same, so load positive and negative apart
  const pos = new Float32Array(od.length),
    neg = new Float32Array(od.length);
  for (let i = 0; i < od.length; i++) delta[i] > 0 ? (pos[i] = delta[i]) : (neg[i] = -delta[i]);
  const a = await aon(R.p, cost, pos),
    b = await aon(R.p, cost, neg);
  for (let k = 0; k < L; k++) x[k] = Math.max(0, x[k] + a.flow[k] - b.flow[k]);
  return x;
}

// ---------------------------------------------------------------------------------------------
// skims

export interface RoadSkim {
  /** minutes, nC × nC (Infinity where no path) */
  time: Float32Array;
  /** $ of tolls paid on the way (bridge tolls included) */
  toll: Float32Array | null;
  miles: Float32Array | null;
  /** with opts.sums: each link array summed along the same paths (NaN where no path) */
  sums?: Float32Array[];
}

/**
 * Least-cost paths at the given link times: minutes (and tolls, miles, and any link arrays `sums`)
 * between all centroids.
 */
export function skimRoads(R: PeriodRoads, time: Float64Array, opts: { toll?: boolean; miles?: boolean; origins?: number[]; sums?: ArrayLike<number>[] } = {}, paths = new RoadPaths(R.net)): RoadSkim {
  const nC = R.net.h.nC,
    L = time.length;
  const cost = new Float64Array(L);
  for (let k = 0; k < L; k++) cost[k] = time[k] + R.fixed[k];
  const T = new Float32Array(nC * nC),
    M = opts.toll ? new Float32Array(nC * nC) : null,
    D = opts.miles ? new Float32Array(nC * nC) : null;
  const S = opts.sums?.map(() => new Float32Array(nC * nC));
  for (const o of opts.origins ?? [...Array(nC).keys()]) {
    paths.tree(o, cost);
    paths.skim(o, time, M ? R.toll : null, T, M, D);
    if (S) paths.sumAlong(o, opts.sums!, S);
  }
  return { time: T, toll: M, miles: D, ...(S ? { sums: S } : {}) };
}

// ---------------------------------------------------------------------------------------------
// summaries

export type RoadSummary = RoadSummaryT;

/**
 * Miles, hours, delay, and speeds on the city's streets (flows as assigned, without the fixed
 * background) and, apart, on the Peninsula freeways (with their background) by route and direction.
 */
export function summariseRoads(net: RoadNet, flows: Record<TPeriod, ArrayLike<number>>, times: Record<TPeriod, ArrayLike<number>>): RoadSummary {
  const vmt = {} as Record<TPeriod, number>,
    vht = {} as Record<TPeriod, number>,
    delay = {} as Record<TPeriod, number>,
    vehicles = {} as Record<TPeriod, number>;
  const speed: Record<string, Record<TPeriod, number>> = {};
  for (const p of TPERIODS) {
    const f = flows[p],
      t = times[p];
    if (!f) continue;
    let m = 0,
      h = 0,
      dl = 0;
    const q = TPERIODS.indexOf(p),
      L = net.h.nLinks;
    const byM: number[] = RCLS.map(() => 0),
      byH: number[] = RCLS.map(() => 0);
    for (let k = 0; k < net.h.nLinks; k++) {
      const c = net.cls[k];
      if (c === 0 || net.corr[k]) continue;
      const vm = f[k] * net.len[k],
        vh = (f[k] * t[k]) / 60;
      m += vm;
      h += vh;
      dl += Math.max(0, (f[k] * (t[k] - net.t0[q * L + k])) / 60);
      byM[c] += vm;
      byH[c] += vh;
    }
    vmt[p] = m;
    vht[p] = h;
    delay[p] = dl;
    (speed.all ??= {} as Record<TPeriod, number>)[p] = h > 0 ? m / h : 0;
    RCLS.forEach((c, i) => {
      if (i === 0) return;
      (speed[c] ??= {} as Record<TPeriod, number>)[p] = byH[i] > 0 ? byM[i] / byH[i] : 0;
    });
    let v = 0;
    for (let k = net.start[0]; k < net.start[net.h.nC]; k++) v += f[k];
    vehicles[p] = v;
  }
  const peninsula = net.h.peninsula ? peninsulaSummary(net, flows, times) : undefined;
  return { vmt, vht, delay, speed, vehicles, ...(peninsula ? { peninsula } : {}) };
}

/** the Peninsula freeways by route and direction ('US-101 N', …): vehicle miles and hours by period, the background included */
export function peninsulaSummary(net: RoadNet, flows: Record<TPeriod, ArrayLike<number>>, times: Record<TPeriod, ArrayLike<number>>): NonNullable<RoadSummary['peninsula']> {
  const out: NonNullable<RoadSummary['peninsula']> = {};
  for (const s of net.h.peninsula?.segments ?? []) {
    const key = `${s.route} ${s.dir}`;
    const o = (out[key] ??= { vmt: {} as Record<TPeriod, number>, vht: {} as Record<TPeriod, number> });
    for (const p of TPERIODS) {
      const f = flows[p];
      if (!f) continue;
      const k = s.link,
        v = f[k] + (net.pre[p]?.[k] ?? 0);
      o.vmt[p] = (o.vmt[p] ?? 0) + v * net.len[k];
      o.vht[p] = (o.vht[p] ?? 0) + (v * times[p][k]) / 60;
    }
  }
  return out;
}

/** minutes along a Peninsula freeway between two of its interchanges, in its direction (null if they are not on it in order) */
export function corridorMinutes(net: RoadNet, time: ArrayLike<number>, route: 'US-101' | 'I-280', dir: 'N' | 'S', from: string, to: string): number | null {
  const segs = (net.h.peninsula?.segments ?? []).filter((s) => s.route === route && s.dir === dir);
  let at = segs.findIndex((s) => s.from === from);
  if (at < 0) return null;
  let m = 0;
  for (let guard = 0; guard < segs.length; guard++) {
    const s = segs[at];
    m += time[s.link];
    if (s.to === to) return m;
    at = segs.findIndex((x) => x.from === s.to);
    if (at < 0) return null;
  }
  return null;
}
