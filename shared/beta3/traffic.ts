/**
 * Traffic feedback: the model's car trips, with ride-hail's empty driving and the fixed background
 * (commercial vehicles, through traffic and the rest of what crosses the city line), assigned to the
 * streets each period; the congested driving times then go back to destination and mode choice,
 * with the link volumes averaged over the feedback iterations (the method of successive averages,
 * as Travel Model One averages its assignments between iterations).
 *
 * Driving times enter demand as a pivot (an incremental model): a scenario's time between two zones
 * is today's fitted time plus the change the assignment finds, its time on the scenario's streets
 * at its own equilibrium less its time on today's streets at today's. Today's driving times stay
 * those fitted to SFCTA's INRIX speeds, so a scenario that changes nothing reproduces the baseline
 * exactly, while volumes, speeds and the response to change come from the assignment.
 *
 * The Peninsula freeways (roads.ts) respond in Precise only: a Quick run holds them at today's
 * speeds, as it holds every road when the scenario leaves the streets and car prices alone.
 */
import { corridorMinutes, dequantise, dequantiseOD, equilibrium, freezeCorridors, quantise, linkTimes, periodRoads, resolveRoadEdits, roadBase, skimRoads, summariseRoads, warmFlows, type PeriodRoads, type RoadAon, type RoadNet, type RoadSkim, type RoadSummary, type RoadEditsResolved } from './roads';
import type { Bundle, Scenario, TPeriod, TrafficResult } from './types';
import { PERIOD_NAME, TPERIODS } from './types';

/** the fixed skims' period for each assignment period (the night is TM1's evening) */
const AP: Record<TPeriod, string> = { AM: 'AM', MD: 'MD', PM: 'PM', NT: 'EV' };

/**
 * Ride-hail drivers drive empty from each drop-off to their next pick-up: a gravity model on the
 * period's pick-ups, its distance decay set so that empty miles are 40% of passenger miles (29% of
 * ride-hail miles: the model's VKT factor of 1.4 per trip; SFCTA's TNCs Today put 20% of their
 * miles in San Francisco out of service in 2016, Fehr & Peers 40% across six regions in 2018).
 */
export const DEADHEAD_SHARE = 0.4;

export interface TrafficOptions {
  /** demand–assignment iterations after the first demand (TM1 runs three) */
  feedback?: number;
  /** relative gap for each assignment */
  gap?: number;
  /** relative gap for an assignment whose times no demand reads, only the traffic shown (default: gap) */
  finalGap?: number;
  maxIter?: number;
  /** 'pivot' (default): today's fitted times plus the assignment's change; 'absolute': the assignment's own times */
  mode?: 'pivot' | 'absolute';
  /**
   * How the pivot measures a trip's change in time: 'route' (default) along today's least-cost
   * route, or along the scenario's where that route crosses a street the scenario changes;
   * 'least-cost' always as the scenario's least-cost time less today's (see demandArrays)
   */
  pivot?: 'route' | 'least-cost';
  /**
   * hold the Peninsula freeways at today's times, as Quick always does (default: Quick only); in a
   * Precise run it isolates what the corridors' own response adds (peninsula-runs.ts --freeze-corridors)
   */
  freezeCorridors?: boolean;
  /** the stage, and how far through this feedback step it is (0–1) */
  onProgress?: (stage: string, f?: number) => void;
}

/**
 * Least-cost paths between all centroids at given link times, on the scenario's streets or today's
 * (`which`); the page splits them over its workers (Traffic's `skim`), Node runs skimRoads.
 */
export type RoadSkimmer = (which: 'scenario' | 'base', p: TPeriod, time: Float64Array, opts: { toll: boolean; sums?: Float64Array[] }) => Promise<RoadSkim>;

export interface TrafficState {
  /** link volumes (MSA-averaged) and congested minutes by period */
  flow: Record<TPeriod, Float64Array>;
  time: Record<TPeriod, Float64Array>;
  gaps: Record<TPeriod, number>;
  iterations: Record<TPeriod, number>;
  summary: RoadSummary;
  /** vehicle trips assigned by period */
  vehicles: Record<TPeriod, number>;
  /** links each road edit touched */
  edited: Record<string, number[]>;
}

export class Traffic {
  readonly nC: number;
  readonly NZ: number;
  readonly NX: number;
  readonly ed: RoadEditsResolved;
  readonly R = {} as Record<TPeriod, PeriodRoads>;
  readonly Rbase = {} as Record<TPeriod, PeriodRoads>;
  private baseOD = {} as Record<TPeriod, Float32Array>;
  private bg = {} as Record<TPeriod, Float32Array>;
  private baseSkim = {} as Record<TPeriod, Promise<RoadSkim>>;
  private prevFlow = {} as Record<TPeriod, Float64Array>;
  private prevOD = {} as Record<TPeriod, Float32Array>;
  private avg = {} as Record<TPeriod, Float64Array>;
  private k = 0;
  readonly hasTolls: boolean;
  private readonly skim: RoadSkimmer;
  /** today's flows and trips for the scenario's run mode (roadBase) */
  readonly baseFlow: Partial<Record<TPeriod, Float32Array>>;
  state: TrafficState | null = null;
  /** the share of vehicle trips that moved between successive feedback iterations */
  convergence: number[] = [];
  /** all-or-nothing loadings (one per BFW iteration, two per warm start) over the run */
  work = { iterations: 0 };
  /** the driving times (and tolls) the last step gave demand */
  lastArrays: Record<string, Uint16Array | Float32Array> | null = null;

  constructor(
    readonly bundle: Bundle,
    readonly net: RoadNet,
    readonly scenario: Scenario,
    readonly aon: RoadAon,
    readonly opts: TrafficOptions = {},
    skim?: RoadSkimmer,
  ) {
    this.skim = skim ?? (async (which, p, time, o) => skimRoads(which === 'base' ? this.Rbase[p] : this.R[p], time, o));
    this.nC = net.h.nC;
    this.NZ = net.h.nZ;
    this.NX = net.h.nX;
    if (this.NZ !== bundle.header.zones.length || this.NX !== bundle.header.ext.length) throw new Error('road network does not match the model bundle');
    this.ed = resolveRoadEdits(net, scenario);
    const rb = roadBase(net, scenario.runMode);
    this.baseFlow = rb.flow;
    this.hasTolls = this.ed.toll.some((v) => v > 0);
    for (const p of TPERIODS) {
      this.R[p] = periodRoads(net, p, this.ed);
      this.Rbase[p] = periodRoads(net, p);
      // Quick: the Peninsula freeways keep today's times (those of the mode's own base flows)
      if ((this.opts.freezeCorridors ?? scenario.runMode === 'quick') && net.h.peninsula) {
        const t = new Float64Array(this.Rbase[p].t0.length);
        linkTimes(this.Rbase[p], this.baseFlow[p] ?? new Float64Array(t.length), t);
        freezeCorridors(this.R[p], t);
        freezeCorridors(this.Rbase[p], t);
      }
      this.bg[p] = dequantiseOD(net.bgOD[p], this.nC * this.nC);
      // today's trips: the model's (quantised as stored) and the background
      const od = dequantiseOD(rb.od[p], this.nC * this.nC);
      for (let i = 0; i < od.length; i++) od[i] += this.bg[p][i];
      this.baseOD[p] = od;
    }
  }

  /**
   * The Peninsula freeways' background drivers' time savings (minutes a weekday; + a gain): on each
   * segment, its fixed background times the change in its time. The background keeps to its own
   * segment, so this is the route sum demandArrays takes for the model's drivers, and a scenario
   * that changes no time on the freeways gives exactly zero.
   */
  peninsulaGain(): number {
    if (!this.state || !this.net.h.peninsula) return 0;
    let g = 0;
    for (const p of TPERIODS) {
      const pre = this.net.pre[p];
      if (!pre) continue;
      const tb = this.baseTime(p),
        ts = this.state.time[p];
      for (const s of this.net.h.peninsula.segments) g += pre[s.link] * (tb[s.link] - ts[s.link]);
    }
    return g;
  }

  private baseSum: RoadSummary | null = null;
  /** today's volumes, speeds and miles (from the saved equilibrium) */
  baseSummary(): RoadSummary {
    if (!this.baseSum) {
      const flow = {} as Record<TPeriod, Float64Array>,
        time = {} as Record<TPeriod, Float64Array>;
      for (const p of TPERIODS) {
        const R = this.Rbase[p];
        flow[p] = Float64Array.from(this.baseFlow[p] ?? new Float32Array(R.t0.length));
        time[p] = new Float64Array(R.t0.length);
        linkTimes(R, flow[p], time[p]);
      }
      this.baseSum = summariseRoads(this.net, flow, time);
    }
    return this.baseSum;
  }

  private commAdj: Record<TPeriod, Float32Array> | null | undefined;
  /** with charges: the change in commercial trips, the scenario's gravity model less today's */
  async commercialChange(): Promise<Record<TPeriod, Float32Array> | null> {
    if (this.commAdj !== undefined) return this.commAdj;
    if (!this.hasTolls) return (this.commAdj = null);
    const NA = this.NZ + this.NX,
      nC = this.nC;
    const toll = {} as Record<TPeriod, Float32Array>;
    for (const p of TPERIODS) {
      const sk = await this.skim('scenario', p, this.baseTime(p), { toll: true });
      const bs = await this.base(p);
      const t = new Float32Array(NA * NA);
      for (let o = 0; o < NA; o++) for (let d = 0; d < NA; d++) t[o * NA + d] = Math.max(0, sk.toll![o * nC + d] - (bs.toll?.[o * nC + d] ?? 0));
      toll[p] = t;
    }
    const base = commercialOD(this.bundle, nC).od,
      scn = commercialOD(this.bundle, nC, toll).od;
    this.commAdj = {} as Record<TPeriod, Float32Array>;
    for (const p of TPERIODS) this.commAdj[p] = Float32Array.from(scn[p], (v, i) => v - base[p][i]);
    return this.commAdj;
  }

  private baseTimes: Partial<Record<TPeriod, Float64Array>> = {};
  /** today's congested minutes on each link */
  baseTime(p: TPeriod): Float64Array {
    if (!this.baseTimes[p]) {
      const R = this.Rbase[p];
      const t = new Float64Array(R.t0.length);
      linkTimes(R, this.baseFlow[p] ?? new Float64Array(R.t0.length), t);
      this.baseTimes[p] = t;
    }
    return this.baseTimes[p]!;
  }

  /**
   * Buses in mixed traffic: each hop of the bundle's buses and streetcars gains the change in
   * congested time on the links it runs along (SF-CHAMP likewise builds bus times from congested
   * road times). Where the bus has its own lane, today or in the scenario, the traffic does not
   * reach it: a lane given to buses (or a street closed to cars) takes today's congestion delay off
   * the bus, and a link with a bus lane today passes on none of the change. Seconds by period and
   * bundle line; empty when nothing changes by a second.
   *
   * `initial`: before any car is assigned, only what the edits themselves give the buses (the
   * congestion delay a lane given to buses takes off them), so the first transit paths and demand
   * already see a bus lane; the traffic's change on the other links comes after the assignment.
   */
  busDelay(initial = false): NonNullable<Scenario['busDelay']> {
    const out: NonNullable<Scenario['busDelay']> = {};
    if (!this.state && !initial) return out;
    if (initial && !this.ed.any) return out;
    const net = this.net,
      L = net.h.nLinks;
    const nLines = net.busLineStart.length - 1;
    if (nLines !== this.bundle.header.lines.length) return out;
    for (const p of TPERIODS) {
      const q = TPERIODS.indexOf(p);
      const tb = this.baseTime(p),
        ts = initial ? tb : this.state!.time[p],
        t0 = this.Rbase[p].t0;
      const d = new Float64Array(L);
      for (let k = 0; k < L; k++) {
        const own = net.busLane[k];
        const free = this.ed.busLane[q * L + k] || this.ed.closed[q * L + k];
        // minutes the bus gains (+) or saves (−) on this link
        d[k] = free ? -(1 - own) * Math.max(0, tb[k] - t0[k]) : (1 - own) * (ts[k] - tb[k]);
      }
      const byLine: Record<number, number[]> = {};
      for (let li = 0; li < nLines; li++) {
        const h0 = net.busLineStart[li],
          h1 = net.busLineStart[li + 1];
        if (h1 <= h0) continue;
        let any = false;
        const hops: number[] = [];
        for (let h = h0; h < h1; h++) {
          let m = 0;
          for (let j = net.busHopStart[h]; j < net.busHopStart[h + 1]; j++) m += net.busHopFrac[j] * d[net.busHopLink[j]];
          const sec = Math.round(60 * m);
          hops.push(sec);
          if (Math.abs(sec) >= 1) any = true;
        }
        if (any) byLine[li] = hops;
      }
      if (Object.keys(byLine).length) out[p] = byLine;
    }
    return out;
  }

  /** today's skims (time, toll) at today's flows, made once */
  private base(p: TPeriod): Promise<RoadSkim> {
    return (this.baseSkim[p] ??= this.skim('base', p, this.baseTime(p), { toll: true }));
  }

  /** the period's vehicle trips between centroids: the model's, ride-hail's empty legs, and the background */
  vehicleOD(autoOD: Float32Array, tncEnds: Float64Array | undefined, p: TPeriod): Float32Array {
    const od = modelVehicleOD(this.bundle, this.nC, this.NZ, this.NX, autoOD, tncEnds);
    // quantised as today's trips are stored, so trips that have not changed are exactly today's
    for (let i = 0; i < od.length; i++) od[i] = (od[i] ? dequantise(quantise(od[i])) : 0) + this.bg[p][i];
    // commercial vehicles answer a charge by where they go (their gravity model with the charge in
    // it; step() works it out first)
    const adj = this.commAdj?.[p];
    if (adj) for (let i = 0; i < od.length; i++) if (adj[i]) od[i] = Math.max(0, od[i] + adj[i]);
    return od;
  }

  /**
   * One feedback step: assign the demand's vehicle trips every period (warm-started from the last
   * step, or today's equilibrium), average the volumes with the earlier steps', and return the
   * driving times and tolls for the next demand as bundle arrays.
   */
  async step(autoOD: Record<TPeriod, Float32Array>, tncEnds?: Record<TPeriod, Float64Array>, final = false): Promise<Record<string, Uint16Array | Float32Array>> {
    this.k++;
    await this.commercialChange();
    const out: Record<string, Uint16Array | Float32Array> = {};
    const flow = {} as Record<TPeriod, Float64Array>,
      time = {} as Record<TPeriod, Float64Array>,
      gaps = {} as Record<TPeriod, number>,
      iterations = {} as Record<TPeriod, number>,
      vehicles = {} as Record<TPeriod, number>;
    for (const p of TPERIODS) {
      const R = this.R[p];
      const od = this.vehicleOD(autoOD[p], tncEnds?.[p], p);
      const pi = TPERIODS.indexOf(p);
      let veh = 0;
      for (let i = 0; i < od.length; i++) veh += od[i];
      vehicles[p] = veh;
      this.opts.onProgress?.(`Assigning cars to streets, ${PERIOD_NAME[p]}, round ${this.k}`, pi / TPERIODS.length);
      const prev = this.prevFlow[p] ?? (this.baseFlow[p] ? Float64Array.from(this.baseFlow[p]!) : null);
      const prevOD = this.prevOD[p] ?? this.baseOD[p];
      const warm = prev ? await warmFlows(R, prev, prevOD, od, this.aon) : undefined;
      // every assignment to the run mode's gap, the first too: demand reads its times, and an
      // assignment stopped early overstates the change in driving times (fare-free Muni's drivers
      // gained 6,300 hours a day at a gap of 3×10⁻³, 4,300 at 10⁻³, 2,300 at 10⁻⁴, today's gap)
      // (`final`: no demand will read this assignment's times, only the traffic shown: finalGap)
      const tol = (final ? this.opts.finalGap : undefined) ?? this.opts.gap ?? 1e-3;
      const eq = await equilibrium(R, od, this.aon, { gap: tol, maxIter: this.opts.maxIter ?? 100, warm });
      this.work.iterations += eq.iterations + 1 + (warm ? 2 : 0);
      this.prevFlow[p] = eq.flow;
      this.prevOD[p] = od;
      // successive averages of the volumes over the feedback iterations
      const a = (this.avg[p] ??= new Float64Array(eq.flow.length));
      for (let i = 0; i < a.length; i++) a[i] += (eq.flow[i] - a[i]) / this.k;
      const t = new Float64Array(a.length);
      linkTimes(R, a, t);
      flow[p] = Float64Array.from(a);
      time[p] = t;
      gaps[p] = eq.gap;
      iterations[p] = eq.iterations;
      Object.assign(out, await this.demandArrays(p, t));
    }
    this.lastArrays = out;
    this.state = { flow, time, gaps, iterations, vehicles, summary: summariseRoads(this.net, flow, time), edited: this.ed.byEdit };
    return out;
  }

  /**
   * The driving times and charges for the first demand, before any car has been assigned: today's
   * flows on the scenario's streets (a lane taken, a street closed, a charge to pay). A scenario that
   * changes no street or price keeps today's times exactly; one that does starts its feedback from
   * the right side of the change instead of from today, so the first demand already sees a charge.
   * Null when nothing on the streets changes.
   */
  async initialArrays(): Promise<Record<string, Uint16Array | Float32Array> | null> {
    if (!this.ed.any) return null;
    const out: Record<string, Uint16Array | Float32Array> = {};
    for (const p of TPERIODS) {
      const t = new Float64Array(this.R[p].t0.length);
      linkTimes(this.R[p], this.baseFlow[p] ?? new Float64Array(t.length), t);
      Object.assign(out, await this.demandArrays(p, t));
    }
    return out;
  }

  private edited: Partial<Record<TPeriod, Float64Array>> = {};
  /** 1 on the links whose street the scenario changes in period p (lanes, closure, charge), else 0 */
  editedLinks(p: TPeriod): Float64Array {
    if (!this.edited[p]) {
      const L = this.net.h.nLinks,
        q = TPERIODS.indexOf(p);
      const f = new Float64Array(L);
      if (this.ed.any) for (let k = 0; k < L; k++) if (this.ed.lanes[q * L + k] !== this.net.lanes[k] || this.ed.closed[q * L + k] || this.ed.toll[q * L + k] > 0) f[k] = 1;
      this.edited[p] = f;
    }
    return this.edited[p]!;
  }

  /**
   * The bundle arrays demand reads for driving in period p: seconds between zones, to and from
   * outside zones, and added tolls.
   *
   * A trip's change in time is measured along today's least-cost route: the sum over its links of
   * the change in each link's time. To first order this is the change in the least-cost time (the
   * envelope theorem: re-routing gains only to second order), and it does not take the least of a
   * set of times that an assignment stopped at a finite gap leaves a little high on some routes and
   * low on others, which biases the scenario's least-cost times low and shows the remaining gap as
   * a gain in time. Where today's route crosses a street the scenario changes (a lane taken or
   * added, a street closed, a charge), re-routing is first order, and the change is the scenario's
   * least-cost time less today's. A scenario that changes nothing changes no time.
   */
  async demandArrays(p: TPeriod, t: Float64Array): Promise<Record<string, Uint16Array | Float32Array>> {
    const { nC, NZ, NX } = this;
    const A = this.bundle.a;
    const ap = AP[p];
    const route = this.opts.pivot !== 'least-cost';
    // the change in each link's time, and the links whose street the scenario changes
    const tb = this.baseTime(p);
    const dt = new Float64Array(t.length);
    for (let k = 0; k < t.length; k++) dt[k] = t[k] - tb[k];
    const [scn, base, along] = await Promise.all([this.skim('scenario', p, t, { toll: this.hasTolls }), this.base(p), route ? this.skim('base', p, tb, { toll: false, sums: [dt, this.editedLinks(p)] }) : null]);
    const absolute = this.opts.mode === 'absolute';
    const sec = (fixed: number, o: number, d: number) => {
      const i = o * nC + d;
      const s = scn.time[i],
        b = base.time[i];
      if (!(s < 1e4)) return 65535;
      const ch = along && !(along.sums![1][i] > 0) && Number.isFinite(along.sums![0][i]) ? along.sums![0][i] : s - b;
      const v = absolute ? s * 60 : fixed + ch * 60;
      return Math.max(0, Math.min(65535, Math.round(Math.max(v, absolute ? 0 : 0.5 * fixed))));
    };
    const zz = Uint16Array.from(A[`autoSec_${ap}`] as Uint16Array);
    for (let o = 0; o < NZ; o++) for (let d = 0; d < NZ; d++) if (o !== d) zz[o * NZ + d] = sec(zz[o * NZ + d], o, d);
    const xin = Uint16Array.from(A[`extAutoIn_${ap}`] as Uint16Array),
      xout = Uint16Array.from(A[`extAutoOut_${ap}`] as Uint16Array);
    for (let e = 0; e < NX; e++)
      for (let z = 0; z < NZ; z++) {
        xin[e * NZ + z] = sec(xin[e * NZ + z], NZ + e, z);
        xout[e * NZ + z] = sec(xout[e * NZ + z], z, NZ + e);
      }
    const res: Record<string, Uint16Array | Float32Array> = { [`autoSec_${ap}`]: zz, [`extAutoIn_${ap}`]: xin, [`extAutoOut_${ap}`]: xout };
    if (this.hasTolls && scn.toll) {
      const NA = NZ + NX;
      const rt = new Float32Array(NA * NA);
      for (let o = 0; o < NA; o++) for (let d = 0; d < NA; d++) if (o !== d) rt[o * NA + d] = Math.max(0, scn.toll[o * nC + d] - (base.toll?.[o * nC + d] ?? 0));
      res[`roadToll_${p}`] = rt;
    }
    return res;
  }
}

/** the model's vehicle trips for one period as a centroid matrix, with ride-hail's empty legs */
export function modelVehicleOD(b: Bundle, nC: number, NZ: number, NX: number, autoOD: Float32Array, tncEnds?: Float64Array): Float32Array {
  const ZA = NZ + NX;
  const od = new Float32Array(nC * nC);
  for (let o = 0; o < ZA; o++)
    for (let d = 0; d < ZA; d++) {
      const v = autoOD[o * ZA + d];
      if (v) od[o * nC + d] = v;
    }
  if (tncEnds) addDeadheads(b, od, nC, NZ, NX, tncEnds);
  return od;
}

/**
 * Parking charges a scenario adds (edit 'parking'): dollars an hour on top of today's rate in the
 * zones whose centers lie in the area, as a bundle array demand reads (parkAdd, by zone).
 */
export function scenarioArrays(b: Bundle, s: Scenario): Record<string, Float32Array> | null {
  const edits = s.edits.filter((e): e is Extract<Scenario['edits'][number], { kind: 'parking' }> => e.kind === 'parking');
  if (!edits.length) return null;
  const Z = b.header.zones;
  const add = new Float32Array(Z.length);
  for (const e of edits) Z.forEach((z, i) => inRing(e.ring, z.lat, z.lon) && (add[i] += e.perHour));
  return { parkAdd: add };
}
function inRing(ring: [number, number][], lat: number, lon: number) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ya, xa] = ring[i],
      [yb, xb] = ring[j];
    if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) c = !c;
  }
  return c;
}

/** a bundle whose driving times (and added tolls) are replaced by `arrays` */
export const withRoadArrays = (b: Bundle, arrays: Record<string, Uint16Array | Float32Array>): Bundle => {
  // today's driving times stay readable as base_* (demand's time-of-day response compares with them)
  const base: Record<string, Uint16Array | Float32Array> = {};
  for (const k of Object.keys(arrays)) if (/^(autoSec|extAutoIn|extAutoOut)_/.test(k) && b.a[k]) base[`base_${k}`] = b.a[k] as Uint16Array;
  return { header: b.header, a: { ...b.a, ...base, ...arrays } };
};

/**
 * Ride-hail's empty legs (DEADHEAD_SHARE): from each zone's drop-offs to the period's pick-ups by a
 * gravity model on road distance (the fixed morning distances), its decay set by bisection.
 */
export function addDeadheads(b: Bundle, od: Float32Array, nC: number, NZ: number, NX: number, ends: Float64Array) {
  const A = b.a;
  const dm = A.autoDm as Uint16Array,
    dIn = A.extDmIn as Uint16Array;
  const ZA = NZ + NX;
  const pick = ends.subarray(0, ZA),
    drop = ends.subarray(ZA, 2 * ZA);
  // km from a drop-off zone d to a pick-up zone o (pick-ups are in the city)
  const km = (d: number, o: number) => (d < NZ ? dm[d * NZ + o] : dIn[(d - NZ) * NZ + o]) / 100;
  const totalDrop = drop.reduce((a, v) => a + v, 0);
  if (!(totalDrop > 0)) return;
  // the empty legs' mean length: DEADHEAD_SHARE of the passenger trips' mean length
  const meanEmpty = (beta: number) => {
    let n = 0,
      k = 0;
    for (let d = 0; d < ZA; d++) {
      if (!(drop[d] > 0)) continue;
      let s = 0,
        sk = 0;
      for (let o = 0; o < NZ; o++) {
        if (!(pick[o] > 0)) continue;
        const x = km(d, o);
        const w = pick[o] * Math.exp(-beta * x);
        s += w;
        sk += w * x;
      }
      if (s > 0) ((n += drop[d]), (k += (drop[d] * sk) / s));
    }
    return n > 0 ? k / n : 0;
  };
  const target = DEADHEAD_SHARE * (ends[2 * ZA + 1] > 0 ? ends[2 * ZA] / ends[2 * ZA + 1] : 4.5);
  let lo = 0,
    hi = 5;
  for (let i = 0; i < 30; i++) {
    const m = 0.5 * (lo + hi);
    if (meanEmpty(m) > target) lo = m;
    else hi = m;
  }
  const beta = 0.5 * (lo + hi);
  for (let d = 0; d < ZA; d++) {
    if (!(drop[d] > 0)) continue;
    let s = 0;
    for (let o = 0; o < NZ; o++) if (pick[o] > 0) s += pick[o] * Math.exp(-beta * km(d, o));
    if (!(s > 0)) continue;
    for (let o = 0; o < NZ; o++) if (pick[o] > 0 && o !== d) od[d * nC + o] += (drop[d] * pick[o] * Math.exp(-beta * km(d, o))) / s;
  }
}

/** keep the averaged state's result small for the page: volumes and times as Float32 by period */
export function trafficResult(t: TrafficState, tr?: Traffic): TrafficResult {
  const net = tr?.net;
  const base = net ? tr!.baseSummary() : t.summary;
  // the streets whose daily volume changed most
  const changes: TrafficResult['changes'] = [];
  if (net) {
    const best = new Map<string, { name: string; base: number; scenario: number }>();
    for (let k = 0; k < net.h.nLinks; k++) {
      if (net.cls[k] === 0 || net.name[k] < 0 || net.corr[k]) continue;
      let b = 0,
        s = 0;
      for (const p of TPERIODS) ((b += tr!.baseFlow[p]?.[k] ?? 0), (s += t.flow[p][k]));
      const nm = net.h.names[net.name[k]];
      const cur = best.get(nm);
      if (!cur || Math.abs(s - b) > Math.abs(cur.scenario - cur.base)) best.set(nm, { name: nm, base: Math.round(b), scenario: Math.round(s) });
    }
    changes.push(...[...best.values()].sort((x, y) => Math.abs(y.scenario - y.base) - Math.abs(x.scenario - x.base)).slice(0, 12));
  }
  return {
    base,
    changes,
    trips: tr ? tripTimes(tr.bundle, tr.lastArrays ?? undefined) : [],
    ...(tr && net?.h.peninsula ? { corridorTrips: corridorTrips(net, (p) => tr.baseTime(p), (p) => t.time[p]) } : {}),
    convergence: tr?.convergence ?? [],
    loadings: tr?.work.iterations ?? 0,
    // the traffic shown: on the Peninsula freeways, the background with the model's cars
    flow: Object.fromEntries(TPERIODS.map((p) => [p, withBackground(net, p, t.flow[p])])) as Record<TPeriod, Float32Array>,
    time: Object.fromEntries(TPERIODS.map((p) => [p, Float32Array.from(t.time[p])])) as Record<TPeriod, Float32Array>,
    gaps: t.gaps,
    iterations: t.iterations,
    summary: t.summary,
    vehicles: t.vehicles,
  };
}

/** a link flow array with the fixed background added (the traffic on the road), as Float32 */
export function withBackground(net: RoadNet | undefined, p: TPeriod, flow: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(flow);
  const pre = net?.pre[p];
  if (pre) for (let k = 0; k < out.length; k++) if (pre[k]) out[k] += pre[k];
  return out;
}

/** drives people know along the Peninsula freeways: [name, period, route, direction, from, to] */
export const CORRIDOR_TRIPS: [string, TPeriod, 'US-101' | 'I-280', 'N' | 'S', string, string][] = [
  ['Palo Alto to San Francisco on US-101', 'AM', 'US-101', 'N', 'the Santa Clara County line', 'the county line'],
  ['SFO to Palo Alto on US-101', 'AM', 'US-101', 'S', 'Millbrae Ave', 'the Santa Clara County line'],
  ['San Francisco to Palo Alto on US-101', 'PM', 'US-101', 'S', 'the county line', 'the Santa Clara County line'],
];
/** minutes for CORRIDOR_TRIPS from link times today and in a scenario */
export function corridorTrips(net: RoadNet, base: (p: TPeriod) => ArrayLike<number>, scn: (p: TPeriod) => ArrayLike<number>): { name: string; period: TPeriod; base: number; scenario: number }[] {
  const out: { name: string; period: TPeriod; base: number; scenario: number }[] = [];
  for (const [name, p, route, dir, from, to] of CORRIDOR_TRIPS) {
    const b = corridorMinutes(net, base(p), route, dir, from, to),
      s = corridorMinutes(net, scn(p), route, dir, from, to);
    if (b !== null && s !== null) out.push({ name, period: p, base: +b.toFixed(2), scenario: +s.toFixed(2) });
  }
  return out;
}

/** a few drives people know, by period: from a point to a point (the zones whose centers are nearest) */
export const KNOWN_TRIPS: { name: string; period: TPeriod; from: [number, number] | string; to: [number, number] }[] = [
  { name: 'Outer Sunset to the Financial District', period: 'AM', from: [37.753, -122.504], to: [37.792, -122.399] },
  { name: 'The Mission to the Financial District', period: 'AM', from: [37.76, -122.418], to: [37.792, -122.399] },
  { name: 'Bayview to SoMa', period: 'AM', from: [37.73, -122.39], to: [37.778, -122.405] },
  { name: 'Oakland to the Financial District', period: 'AM', from: 'Oakland', to: [37.792, -122.399] },
  { name: 'The Marina to Mission Bay', period: 'MD', from: [37.801, -122.437], to: [37.77, -122.391] },
  { name: 'The Financial District to the Outer Richmond', period: 'PM', from: [37.792, -122.399], to: [37.778, -122.495] },
];
const AP2: Record<TPeriod, string> = { AM: 'AM', MD: 'MD', PM: 'PM', NT: 'EV' };
/** minutes for KNOWN_TRIPS: today's fitted times, and with `arrays` (a scenario's driving times) */
export function tripTimes(b: Bundle, arrays?: Record<string, Uint16Array | Float32Array>): { name: string; period: TPeriod; base: number; scenario: number }[] {
  const Z = b.header.zones,
    X = b.header.ext,
    NZ = Z.length;
  const zoneAt = ([lat, lon]: [number, number]) => Z.reduce((bi, z, i) => (Math.hypot(z.lat - lat, (z.lon - lon) * 0.79) < Math.hypot(Z[bi].lat - lat, (Z[bi].lon - lon) * 0.79) ? i : bi), 0);
  const out: { name: string; period: TPeriod; base: number; scenario: number }[] = [];
  for (const t of KNOWN_TRIPS) {
    const d = zoneAt(t.to);
    const sec = (a: Record<string, ArrayLike<number>>) => {
      if (typeof t.from === 'string') {
        const e = X.findIndex((x) => x.name.startsWith(t.from as string));
        return e < 0 ? NaN : (a[`extAutoIn_${AP2[t.period]}`] as ArrayLike<number>)[e * NZ + d];
      }
      return (a[`autoSec_${AP2[t.period]}`] as ArrayLike<number>)[zoneAt(t.from) * NZ + d];
    };
    const base = sec(b.a as never) / 60;
    const scn = arrays ? sec({ ...b.a, ...arrays } as never) / 60 : base;
    if (Number.isFinite(base)) out.push({ name: t.name, period: t.period, base: +base.toFixed(1), scenario: +scn.toFixed(1) });
  }
  return out;
}

/**
 * SF-CHAMP's commercial vehicle model (sfchampdocs, activity_demand_models.rst): daily trips
 * produced and attracted per household and per job by land use (CIE, MED, MIPS, PDR, RETAIL,
 * VISITOR), here from LODES sectors; distributed by a gravity model and allocated to periods with
 * SF-CHAMP's truck time-of-day factors (EA 5%, AM 12.5%, MD 42.5%, PM 12.5%, EV 27.5%). The friction
 * is the Quick Response Freight Manual's for four-tire commercial vehicles, exp(−0.08·minutes), on
 * today's midday driving times. A scenario's charges enter its impedance as SF-CHAMP's commercial
 * toll choice prices them: at a commercial value of time (TM1's $30 an hour in 2000 dollars, $56 in
 * 2025) and, for area pricing, spread over SF-CHAMP's two entries a day.
 */
export const COMMERCIAL = {
  perHousehold: 0.363,
  // LODES CNS01..CNS20 → SF-CHAMP rate: PDR 0.982 (agriculture, mining, utilities, construction,
  // manufacturing, wholesale, transportation), RETAIL 0.918 (retail, food, other services), MIPS 0.452
  // (information, finance, real estate, professional, management, administrative), CIE 0.686
  // (education, arts, public administration), MED 0.686 (health); hotel staff are VISITOR 0.982
  perJob: [0.982, 0.982, 0.982, 0.982, 0.982, 0.982, 0.918, 0.982, 0.452, 0.452, 0.452, 0.452, 0.452, 0.452, 0.686, 0.686, 0.686, 0.918, 0.918, 0.686],
  hotelStaffPerRoom: 0.5,
  visitor: 0.982,
  friction: 0.08,
  tod: { AM: 0.125, MD: 0.425, PM: 0.125, NT: 0.325 } as Record<TPeriod, number>,
  vot: 56,
  entriesPerDay: 2,
};

/** commercial vehicle trips by period between the city's zones (nC × nC), with charges by period if given (NZ+NX square, $) */
export function commercialOD(b: Bundle, nC: number, toll?: Partial<Record<TPeriod, Float32Array>>): { od: Record<TPeriod, Float32Array>; trips: number } {
  const Z = b.header.zones,
    NZ = Z.length,
    NA = NZ + b.header.ext.length;
  const P = new Float64Array(NZ);
  Z.forEach((z, i) => {
    let v = COMMERCIAL.perHousehold * z.hh;
    z.jobsBy.forEach((j, k) => (v += COMMERCIAL.perJob[k] * j));
    // hotel staff are visitor-serving (VISITOR) rather than food service (RETAIL)
    const staff = Math.min(z.jobsBy[17], COMMERCIAL.hotelStaffPerRoom * z.hotelRooms);
    v += (COMMERCIAL.visitor - COMMERCIAL.perJob[17]) * staff;
    P[i] = v;
  });
  const tMD = b.a.autoSec_MD as Uint16Array;
  const od = {} as Record<TPeriod, Float32Array>;
  let trips = 0;
  // without charges every period has the same distribution
  const periods: (TPeriod | null)[] = toll && Object.keys(toll).length ? [...TPERIODS] : [null];
  for (const p of periods) {
    const T = p ? toll![p] : undefined;
    const F = new Float64Array(NZ * NZ);
    for (let i = 0; i < NZ; i++)
      for (let j = 0; j < NZ; j++) {
        const m = tMD[i * NZ + j] / 60 + (T ? (T[i * NA + j] * 60) / COMMERCIAL.vot / COMMERCIAL.entriesPerDay : 0);
        F[i * NZ + j] = Math.exp(-COMMERCIAL.friction * m);
      }
    // doubly constrained (productions = attractions), by balancing factors
    const a = new Float64Array(NZ).fill(1),
      bb = new Float64Array(NZ).fill(1);
    for (let it = 0; it < 50; it++) {
      for (let i = 0; i < NZ; i++) {
        let s = 0;
        for (let j = 0; j < NZ; j++) s += bb[j] * P[j] * F[i * NZ + j];
        a[i] = s > 0 ? 1 / s : 0;
      }
      for (let j = 0; j < NZ; j++) {
        let s = 0;
        for (let i = 0; i < NZ; i++) s += a[i] * P[i] * F[i * NZ + j];
        bb[j] = s > 0 ? 1 / s : 0;
      }
    }
    for (const q of p ? [p] : TPERIODS) od[q] = new Float32Array(nC * nC);
    let tot = 0;
    for (let i = 0; i < NZ; i++)
      for (let j = 0; j < NZ; j++) {
        const t = a[i] * P[i] * bb[j] * P[j] * F[i * NZ + j];
        tot += t;
        if (i === j) continue;
        for (const q of p ? [p] : TPERIODS) od[q][i * nC + j] = t * COMMERCIAL.tod[q];
      }
    trips = tot;
  }
  return { od, trips };
}
