/**
 * One model run: transit skims → demand → transit assignment → crowding and capacity at boarding,
 * over several passes, so crowded and full lines push riders onto alternatives and that feeds back
 * into mode and destination choice.
 * The heavy part (a path search per destination per period) goes through an Executor so the browser
 * can spread it over Web Workers; Node runs it in-process.
 */
import { backgroundLoads } from './background';
import { computeDemand, prepare, type DemandOptions, type Prep, type TrnSkim, type TrnSkims } from './demand';
import type { RoadAon, RoadNet } from './roads';
import { Traffic, scenarioArrays, trafficResult, withRoadArrays, type RoadSkimmer, type TrafficOptions } from './traffic';
import { boardAvail, buildNet, periodService, scenarioLines, C_BIAS, C_BOARDS, C_COST, C_FARE, C_IVTP, C_REL, C_TIME, C_WAIT, C_WALK, EXT_CONNECTOR_FIELDS, EXT_DRIVE, LINK_ACCESS, LINK_ALIGHT, LINK_BOARD, LINK_RIDE, NC, type TransitNet } from './net';
import { demandContextOf, microSettingsOf } from './micromobility';
import { cleanContext } from './context';
import { CAPACITY, COST_PER_HOUR, CROWDING, LOAD_HOURS, LOAD_SPREAD, MODES, PARK_AND_RIDE, PATH } from './params';
import { StrategySolver } from './strategy';
import { editsStreetsOrCarPrices, RUN_MODES } from './runmode';
import type { Bundle, Calibration, DayType, DemandContext, LineResult, RunResult, Scenario, TPeriod } from './types';
import { PERIOD_NAME, TPERIODS } from './types';
import { toXY } from './geo';

/**
 * Kilometres of each hop of a bundle line along its drawn route (the GTFS shape between the points
 * its stops sit on), for passenger distance. Straight lines between stops come out 3–9% short on
 * buses (turns and jogs; 9% on Muni's local buses), against NTD's passenger miles, which follow the
 * route. Lines whose stops a scenario changed fall back to straight hops.
 */
const hopKmCache = new WeakMap<object, (Float32Array | null)[]>();
export function hopKm(bundle: Bundle): (Float32Array | null)[] {
  let v = hopKmCache.get(bundle.header);
  if (v) return v;
  v = bundle.header.lines.map((l) => {
    if (!l.path || l.path.length < 4 || !l.stopAt || l.stopAt.length !== l.stops.length) return null;
    const xy: [number, number][] = [];
    for (let i = 0; i < l.path.length; i += 2) xy.push(toXY(l.path[i], l.path[i + 1]) as [number, number]);
    const out = new Float32Array(l.stops.length - 1);
    for (let k = 0; k + 1 < l.stops.length; k++) {
      let m = 0;
      for (let i = l.stopAt[k]; i < l.stopAt[k + 1]; i++) m += Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]);
      const a = bundle.header.stops[l.stops[k]], b = bundle.header.stops[l.stops[k + 1]];
      const straight = Math.hypot(b.x - a.x, b.y - a.y);
      // a path that doubles back or skips the stop's point (a bad shape match) keeps the straight hop
      out[k] = (m >= straight && m <= 2 * straight + 200 ? m : straight) / 1000;
    }
    return out;
  });
  hopKmCache.set(bundle.header, v);
  return v;
}

/**
 * Skims are made for every assignment period, the night's included: each leg of a trip sees the
 * level of service of the periods it travels in (demand.ts legWeights), and night riders see the
 * night's blend of evening and owl service (net.ts periodService), as night assignment does.
 */
export type SkimPeriod = TPeriod;
export const SKIM_PERIODS = TPERIODS;

/** volumes on one period's lines, in the net's line order */
export interface PeriodVolumes {
  /** per line: boardings at each stop, alightings at each stop, load on each hop */
  on: Float32Array[];
  off: Float32Array[];
  load: Float32Array[];
  /** of `load`, the background riders (trips with no end in the city; background.ts) */
  bg?: Float32Array[];
}

/** the kernels an executor runs, for a set of destination zones */
export function skimColumns(net: TransitNet, dests: number[], out: TrnSkim, Z: number, solver = new StrategySolver(net)) {
  const { C } = solver;
  for (const d of dests) {
    solver.solve(d);
    for (let o = 0; o < Z; o++) {
      const k = o * Z + d;
      if (o === d || solver.label(o) === Infinity) {
        out.g[k] = Infinity;
        out.boards[k] = 0;
        out.fare[k] = 0;
        if (out.cost) out.cost[k] = 0;
        out.time[k] = Infinity;
        continue;
      }
      const c = o * NC;
      out.g[k] = C[c + C_IVTP] + PATH.waitWeight * C[c + C_WAIT] + PATH.walkWeight * C[c + C_WALK] + C[c + C_BIAS] + (PATH.reliabilityInModeChoice ? C[c + C_REL] : 0);
      out.boards[k] = C[c + C_BOARDS];
      out.fare[k] = C[c + C_FARE];
      if (out.cost) out.cost[k] = C[c + C_COST];
      out.time[k] = C[c + C_TIME] + C[c + C_WAIT];
    }
  }
}

/** `onDest(j)`: called before the j-th destination (progress) */
export function assignColumns(net: TransitNet, od: Float32Array, dests: number[], Z: number, solver = new StrategySolver(net), onDest?: (j: number) => void): Float64Array {
  solver.resetVolumes();
  for (let j = 0; j < dests.length; j++) {
    const d = dests[j];
    onDest?.(j);
    let any = false;
    for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) (any = true), (o = Z);
    if (!any) continue;
    // only the zones with trips to d need their access split
    solver.solve(d, (o) => od[o * Z + d] > 0);
    solver.load((o) => od[o * Z + d]);
  }
  return solver.linkVol;
}

/** Turn link volumes into per-line boardings, alightings and loads. */
export function lineVolumes(net: TransitNet, linkVol: Float64Array): PeriodVolumes {
  const on = net.lines.map((l) => new Float32Array(l.stops.length));
  const off = net.lines.map((l) => new Float32Array(l.stops.length));
  const load = net.lines.map((l) => new Float32Array(Math.max(0, l.stops.length - 1)));
  for (let a = 0; a < net.nLinks; a++) {
    const v = linkVol[a];
    if (!v) continue;
    const t = net.type[a];
    if (t === LINK_BOARD) on[net.line[a]][net.pos[a]] += v;
    else if (t === LINK_ALIGHT) off[net.line[a]][net.pos[a]] += v;
    else if (t === LINK_RIDE) load[net.line[a]][net.pos[a]] += v;
  }
  return { on, off, load };
}

/**
 * Visitors riding the cable cars and historic streetcars as an attraction rather than to get
 * somewhere: a special generator (as SF-CHAMP's visitor model has), added end to end on each
 * route, split by direction and pattern in proportion to service. Time of day follows visitors'.
 */
const TOURIST_TOD: Record<TPeriod, number> = { AM: 0.12, MD: 0.48, PM: 0.27, NT: 0.13 };
export function addTouristRides(net: TransitNet, v: PeriodVolumes, p: TPeriod, calib: Calibration, day: DayType = 'wkd', visitors = 1) {
  const rides = calib.touristRides;
  if (!rides) return;
  // and they follow the hotel visitors (Scenario.context)
  const f = (day === 'wkd' ? 1 : calib.days?.[day]?.touristFactor ?? 1) * visitors;
  for (const [route, perDay0] of Object.entries(rides)) {
    const perDay = perDay0 * f;
    const idx = net.lines.map((l, i) => [l, i] as const).filter(([l]) => l.feed === 'muni' && l.route === route);
    const trips = idx.reduce((s, [l]) => s + l.trips * (l.stops.length - 1), 0);
    if (!trips) continue;
    for (const [l, i] of idx) {
      const n = (perDay * TOURIST_TOD[p] * l.trips * (l.stops.length - 1)) / trips;
      v.on[i][0] += n;
      v.off[i][l.stops.length - 1] += n;
      for (let k = 0; k < v.load[i].length; k++) v.load[i][k] += n;
    }
  }
}

/** Add the fixed background riders (BART and Caltrain trips with no end in the city) to the loads. */
export function addBackground(bundle: Bundle, net: TransitNet, v: PeriodVolumes, p: TPeriod, day: DayType = 'wkd') {
  const bg = backgroundLoads(bundle, net.lines, p, day);
  if (!bg) return;
  v.bg = bg;
  bg.forEach((b, i) => {
    for (let k = 0; k < b.length; k++) v.load[i][k] += b[k];
  });
}

/** TM2 crowding: multiplier on in-vehicle time from seated and standing discomfort */
export function crowdMultiplier(V: number, cap: number, seats: number): number {
  if (V <= 0 || cap <= 0) return 1;
  const x = V / cap;
  const seated = Math.min(V, seats), standing = Math.max(0, V - seats);
  const c = CROWDING;
  const sc = c.minSeat + (c.maxSeat - c.minSeat) * x ** c.powSeat;
  const st = c.minStand + (c.maxStand - c.minStand) * x ** c.powStand;
  return Math.max(1, (sc * seated + st * standing) / (V + 0.01));
}

/**
 * Capacity at boarding (strict capacity) for one line at one stop over a period.
 *
 * A frequency-based assignment loads every rider who chooses a line onto it, so a busy line can be
 * loaded past what its vehicles hold. Riders who find the vehicle full are left behind and wait for a
 * later one, and some go another way. Cepeda, Cominetti & Florian (2006) put this into the optimal-
 * strategy assignment (the basis of Emme's capacitated transit assignment) through the frequency a
 * rider sees: the chance of failing to board a vehicle of line a at a stop is
 *     p = (v_a / (κ_a − v̄_a + v_a))^β,
 * with v_a the riders who want to board there, κ_a the capacity the line offers, and v̄_a its load
 * leaving the stop, so κ_a − v̄_a + v_a is the room left by those already on board (CAPACITY.beta).
 *
 * The check is made hour by hour within the period (LOAD_HOURS: each hour's share of the riders
 * against its share of the trips), so a line with room over the morning as a whole can still be full
 * from 8 to 9. A rider who fails to board waits a whole headway for the next vehicle, and fails again
 * with the same chance, so expects 1/(1 − p) − 1 extra headways (that hour's headway). Averaged over
 * the period's riders, that is the extra wait; `avail` = 1 / (1 + extra headways at the period's
 * mean headway) is what lowers the line's frequency at the stop in the next pass's path search
 * (net.ts capacityFreq), so riders weigh the wait and choose other lines, stops, modes, or places.
 *
 *  - on: riders boarding the line at the stop in the period; through: riders staying on through it;
 *    capTrips: the period's capacity (vehicle capacity × trips).
 *  - leftBehind: riders who fail to board the first vehicle that comes (Σ hours v·p);
 *    overCap: riders beyond the room the hour's vehicles have at all (Σ hours max(0, v − room)).
 */
export function boardingAvailability(on: number, through: number, capTrips: number, p: TPeriod): { avail: number; leftBehind: number; overCap: number } {
  if (!(on > 0) || !(capTrips > 0)) return { avail: 1, leftBehind: 0, overCap: 0 };
  const hours = LOAD_HOURS[p];
  const N = hours.length;
  let extra = 0, leftBehind = 0, overCap = 0;
  for (const [r, s] of hours) {
    if (!(r > 0) || !(s > 0)) continue;
    const want = on * r, room = capTrips * s - Math.max(0, through) * r;
    const x = room > 0 ? want / room : Infinity;
    const fail = x >= 1 ? 1 : x ** CAPACITY.beta;
    const a = Math.max(CAPACITY.minAvail, 1 - fail);
    // extra headways for this hour's riders, in units of the period's mean headway (this hour's
    // headway is 1/(s·N) of it)
    extra += (r * (1 / a - 1)) / (s * N);
    leftBehind += want * (1 - a);
    overCap += Math.max(0, want - Math.max(0, room));
  }
  return { avail: 1 / (1 + extra), leftBehind, overCap };
}

/**
 * riders on board leaving stop k of a line who did not board there (the load leaving, less the
 * boardings): those staying on through it, and background riders (BART and Caltrain trips with no end
 * in the city), who take room though they are not boardings of the model's
 */
export const throughLoad = (v: PeriodVolumes, li: number, k: number) => (k < v.load[li].length ? Math.max(0, v.load[li][k] - v.on[li][k]) : 0);

/** where capacity binds in a run: per period, the line stops where riders are left behind */
export interface CapacityReport {
  /** riders failing to board the first vehicle, and riders beyond the vehicles' room, per period */
  leftBehind: Record<TPeriod, number>;
  overCap: Record<TPeriod, number>;
  /** the line stops with at least one rider left behind (in the net's line order of that period) */
  stops: { p: TPeriod; line: number; k: number; on: number; through: number; capTrips: number; avail: number; leftBehind: number; overCap: number }[];
}

/** a demand with some of the scenario's inputs put back to today's, to take its time savings apart (runModel) */
export interface DemandOverride {
  /** the conditions (DemandContext) to use instead of the scenario's (undefined: today's) */
  context: DemandContext | undefined;
  /** the running cost multiplier to use instead of the scenario's */
  autoCostFactor: number;
}

export interface Executor {
  /** `lot`: park-and-ride shadow prices by stop (perceived minutes), when any lot is full */
  skim(period: SkimPeriod, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<TrnSkim>;
  assign(period: TPeriod, od: Float32Array, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<Float64Array>;
  /**
   * optional: compute demand elsewhere (split over workers by origin), so the page stays responsive;
   * `arrays` replace the bundle's driving times (traffic feedback)
   */
  demand?(sk: TrnSkims, opts?: DemandOptions, arrays?: Record<string, Uint16Array | Float32Array>, over?: DemandOverride): Promise<ReturnType<typeof computeDemand>>;
  /** the scenario changed during a run (traffic feedback's bus delays): build the transit networks from this one */
  setScenario?(s: Scenario): Promise<void> | void;
}

/** In-process executor (Node, tests). */
export class LocalExecutor implements Executor {
  constructor(
    private bundle: Bundle,
    private scenario: Scenario,
    private calib: Calibration,
  ) {}
  nets = new Map<string, TransitNet>();
  setScenario(s: Scenario) {
    this.scenario = s;
  }
  net(p: TPeriod, crowd?: Float32Array[], lot?: Float32Array) {
    return buildNet(this.bundle, this.scenario, p, this.calib, crowd, lot);
  }
  async skim(period: SkimPeriod, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<TrnSkim> {
    const net = this.net(period, crowd, lot);
    const Z = net.nZones;
    const out: TrnSkim = { g: new Float32Array(Z * Z), boards: new Float32Array(Z * Z), fare: new Float32Array(Z * Z), cost: new Float32Array(Z * Z), time: new Float32Array(Z * Z) };
    skimColumns(net, [...Array(Z).keys()], out, Z);
    return out;
  }
  async assign(period: TPeriod, od: Float32Array, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<Float64Array> {
    const net = this.net(period, crowd, lot);
    const Z = net.nZones;
    return Float64Array.from(assignColumns(net, od, [...Array(Z).keys()], Z));
  }
}

export interface RunOptions {
  iterations?: number;
  /**
   * the stage, the fraction of the run done when it starts, and the fraction it takes (`span`, by
   * its usual share of the time), so a page can move the bar within it as the workers report
   */
  onProgress?: (stage: string, frac: number, span?: number) => void;
  /** crowding from an earlier run (by bundle line), to start from instead of empty vehicles */
  warmCrowd?: Partial<Record<TPeriod, Record<number, Float32Array>>>;
  /** park-and-ride shadow prices from an earlier run (by bundle stop), else the calibration's */
  warmLot?: Record<number, number>;
  /** return the vehicle trips by period with the demand (DemandOptions.autoOD) */
  autoOD?: boolean;
  /**
   * traffic feedback (weekdays): the road network and an all-or-nothing loader; driving times then
   * respond to the streets and to the demand (traffic.ts)
   */
  traffic?: { net: RoadNet; aon: RoadAon; opts?: TrafficOptions; skim?: RoadSkimmer };
  /** experiments: the bus-delay re-search on or off, whatever the run mode says (RunModeSettings.busReskim) */
  busReskim?: boolean;
}

/**
 * Cars the model parks at each lot (by stop) and the room it has for them (params PARK_AND_RIDE):
 * drive-to-the-lot riders on the home end's access links before 3 pm, less the share dropped off, at
 * 1.05 riders a car.
 */
export function lotLoads(bundle: Bundle, nets: Partial<Record<TPeriod, TransitNet>>, vols: Partial<Record<TPeriod, Float64Array>>) {
  const H = bundle.header;
  const x = bundle.a.extConnectors as Int32Array;
  const cars = new Float64Array(H.stops.length);
  for (const p of ['AM', 'MD'] as TPeriod[]) {
    const net = nets[p], vol = vols[p];
    if (!net || !vol) continue;
    const B0 = net.nZones + net.nStops;
    for (let a = 0; a < net.nLinks; a++) {
      const r = net.extRec[a];
      if (r < 0 || net.type[a] !== LINK_ACCESS || !vol[a] || x[r * EXT_CONNECTOR_FIELDS + 5] !== EXT_DRIVE) continue;
      cars[net.head[a] - B0] += (vol[a] * PARK_AND_RIDE.parkShare) / PARK_AND_RIDE.occupancy;
    }
  }
  const room = new Float64Array(H.stops.length).fill(Infinity);
  for (const l of H.lots ?? []) {
    const st = H.stops[l.stop];
    const share = PARK_AND_RIDE.sfShare[st.feed];
    if (share === undefined) continue;
    room[l.stop] = l.spaces * PARK_AND_RIDE.parkAndHide * share;
  }
  return { cars, room };
}

/** next shadow prices: up by step × ln(cars/room) where a lot is over, down the same way (not below 0) */
export function updateLotPrices(prev: Float32Array, cars: Float64Array, room: Float64Array): Float32Array {
  const out = new Float32Array(prev.length);
  for (let s = 0; s < prev.length; s++) {
    if (!(room[s] < Infinity)) continue;
    const r = Math.log(Math.max(1e-3, cars[s]) / room[s]);
    out[s] = Math.min(PARK_AND_RIDE.maxPrice, Math.max(0, prev[s] + PARK_AND_RIDE.step * r));
  }
  return out;
}

/** traffic feedback stops when less than this share of the vehicle trips moved between iterations, or after FEEDBACK_MAX assignments */
export const FEEDBACK_TOL = 0.005;
export const FEEDBACK_MAX = 5;
/** the share of vehicle trips that differ between two demands (half the L1 distance over the total) */
export function odChange(a: Record<TPeriod, Float32Array>, b: Record<TPeriod, Float32Array>): number {
  let d = 0,
    t = 0;
  for (const p of TPERIODS) {
    const x = a[p],
      y = b[p];
    for (let i = 0; i < x.length; i++) ((d += Math.abs(x[i] - y[i])), (t += x[i] + y[i]));
  }
  return t > 0 ? d / t : 0;
}

/**
 * A run's first-pass crowding (by line of the scenario's network) and park-and-ride prices: an
 * earlier run's, so one pass settles a scenario (`warmCrowd`, saved by bundle line), else empty
 * vehicles; and `warmLot`, else the calibration's. The page also uses it to find a run's first
 * skims ahead of the run (Engine.prefetch).
 */
export function warmStart(bundle: Bundle, scenario: Scenario, calib: Calibration, warmCrowd?: RunOptions['warmCrowd'], warmLot?: RunOptions['warmLot']): { crowd: Partial<Record<TPeriod, Float32Array[]>>; lot: Float32Array } {
  const crowd: Partial<Record<TPeriod, Float32Array[]>> = {};
  if (warmCrowd) {
    // existing lines start from the earlier run's crowding; new lines start empty
    for (const p of TPERIODS) {
      const w = warmCrowd[p];
      if (!w) continue;
      const { lines } = scenarioLines(bundle, scenario, p);
      crowd[p] = lines.map((l) => {
        const c = l.src >= 0 ? w[l.src] : undefined;
        const n = l.stops.length, m = Math.max(0, n - 1);
        if (!c || !c.length) return new Float32Array(m).fill(1);
        // saved by bundle line: its hops' crowding, then (when capacity at boarding was on) each stop's
        // availability, boardings, and through riders (lineState). A line whose stops changed (added,
        // removed, extended) gets each spread over its new hops and stops.
        const n0 = bundle.header.lines[l.src].stops.length, m0 = n0 - 1;
        const parts = c.length === m0 + 3 * n0 ? 3 : c.length === m0 + n0 ? 1 : 0;
        const spread = (a: Float32Array, len: number) => (a.length === len ? a : Float32Array.from({ length: len }, (_, k) => a[Math.min(a.length - 1, Math.floor((k * a.length) / len))]));
        const hop = spread(c.subarray(0, m0), m);
        if (!parts || !CAPACITY.on) return hop;
        const out = new Float32Array(m + n);
        out.set(hop);
        out.set(spread(c.subarray(m0, m0 + n0), n), m);
        // a line whose service the scenario changes: its availability worked out again from the saved
        // riders with its new capacity, so a single pass sees the room a frequency change makes
        const base = periodService(bundle.header.lines[l.src], p, scenario.day ?? 'wkd');
        if (parts === 3 && base && Math.abs(l.trips / base.trips - 1) > 1e-6) {
          const on = spread(c.subarray(m0 + n0, m0 + 2 * n0), n), th = spread(c.subarray(m0 + 2 * n0), n);
          for (let k = 0; k < n - 1; k++) out[m + k] = boardingAvailability(on[k], th[k], l.cap * l.trips, p).avail;
        }
        return out;
      });
    }
  }
  // park-and-ride shadow prices: from a warm start or the calibration, then updated each pass
  const lot = new Float32Array(bundle.header.stops.length);
  for (const [s, v] of Object.entries(warmLot ?? calib.lotPrice ?? {})) if (Number(s) < lot.length) lot[Number(s)] = v;
  return { crowd, lot };
}

/** Run the model for a scenario. */
export async function runModel(bundle: Bundle, scenario: Scenario, calib: Calibration, exec: Executor, opts: RunOptions = {}, prep: Prep = prepare(bundle)): Promise<RunResult & { demand: ReturnType<typeof computeDemand>; volumes: Record<TPeriod, PeriodVolumes>; nets: Record<TPeriod, TransitNet>; capacity: CapacityReport; convergence: number[]; traffic?: ReturnType<typeof trafficResult>; /** the bundle arrays the last demand ran with (parking charges, traffic's driving times and tolls) */ roadArrays?: Record<string, Uint16Array | Float32Array> }> {
  const t0 = Date.now();
  const iterations = opts.iterations ?? 2;
  const progress = opts.onProgress ?? (() => {});
  // the first pass's crowding and lot prices: an earlier run's (warmStart), else empty vehicles and the calibration's
  const w0 = warmStart(bundle, scenario, calib, opts.warmCrowd, opts.warmLot);
  let crowd: Partial<Record<TPeriod, Float32Array[]>> = w0.crowd;
  let lot: Float32Array = w0.lot;
  const lotArg = () => (lot.some((v) => v > 0) ? lot : undefined);
  let demand!: ReturnType<typeof computeDemand>;
  // traffic feedback only on weekdays (the road speeds are weekday speeds)
  // the run mode's settings (runmode.ts): Precise is the full model
  const rm = { ...RUN_MODES[scenario.runMode ?? 'precise'], ...(opts.busReskim !== undefined ? { busReskim: opts.busReskim } : {}) };
  const topts: TrafficOptions = { ...rm.traffic, ...opts.traffic?.opts };
  // (Quick holds today's road speeds unless the scenario changes streets or car prices)
  const roadsMove = !rm.fixedRoads || editsStreetsOrCarPrices(scenario);
  // (the progress bar's span for the run, and the road assignment's place in it: set below)
  let total = 1;
  const tStep = { at: 0, w: 0 };
  const traffic = opts.traffic && (scenario.day ?? 'wkd') === 'wkd' && roadsMove ? new Traffic(bundle, opts.traffic.net, scenario, opts.traffic.aon, { ...topts, onProgress: (s, f) => progress(s, Math.min(0.99, (tStep.at + tStep.w * (f ?? 0)) / total), tStep.w / TPERIODS.length / total) }, opts.traffic.skim) : null;
  const roadResponse: RunResult['roadResponse'] = opts.traffic && (scenario.day ?? 'wkd') === 'wkd' ? (traffic ? (rm.fixedRoads ? 'approximate' : 'full') : 'fixed') : undefined;
  const dopts: DemandOptions | undefined = traffic || opts.autoOD ? { autoOD: true } : undefined;
  // the bundle arrays a scenario replaces in demand: parking charges, then traffic's driving times
  let roadArrays: Record<string, Uint16Array | Float32Array> | undefined = scenarioArrays(bundle, scenario) ?? undefined;
  // the scenario as the transit networks see it (traffic feedback adds the buses' delays)
  let scn: Scenario = scenario;
  // the first demand sees the scenario's streets and charges at today's traffic (Traffic.initialArrays)
  const first = await traffic?.initialArrays();
  if (first) roadArrays = { ...roadArrays, ...first };
  // and the buses already run in the lanes the scenario gives them (their traffic's change comes later)
  const bd0 = traffic?.busDelay(true);
  if (bd0 && Object.keys(bd0).length) {
    scn = { ...scn, busDelay: bd0 };
    await exec.setScenario?.(scn);
  }
  let demandArrays = roadArrays;
  let logsumParts: { networkOnly: number; noRoads: number; peninsula?: number } | undefined;
  let volumes = {} as Record<TPeriod, PeriodVolumes>;
  let lastAM: TrnSkim | null = null;
  const nets = {} as Record<TPeriod, TransitNet>;
  // progress by each stage's usual share of the time: a period's transit paths or loading 1, a
  // demand 4, a feedback step's road assignment 2 (Quick) or 4 (Precise)
  const W_DEMAND = 4, W_ROADS = rm.fixedRoads ? 2 : 4;
  const F0 = Math.max(1, topts.feedback ?? FEEDBACK_MAX);
  const extraDemands = (!!scenarioArrays(bundle, scenario) || !!traffic || (scenario.autoCostFactor ?? 1) !== 1 ? 1 : 0) + (cleanContext(scenario.context) ? 1 : 0);
  total =
    iterations * (SKIM_PERIODS.length + W_DEMAND + TPERIODS.length + (traffic ? F0 * W_ROADS + (F0 - 1) * W_DEMAND + (rm.busReskim ? SKIM_PERIODS.length + W_DEMAND + W_ROADS : 0) : 0)) + extraDemands * W_DEMAND;
  let done = 0;
  /** a stage starts: report it with its share of the run */
  const stage = (s: string, w: number) => {
    progress(s, Math.min(0.99, done / total), Math.max(0, Math.min(w, 0.99 * total - done)) / total);
    done += w;
  };
  /** the road assignment's place in the bar (Traffic reports by period within it) */
  tStep.w = W_ROADS;
  const roadStep = () => ((tStep.at = Math.min(done, 0.99 * total)), (done += W_ROADS));
  const passOf = (it: number) => (iterations > 1 ? `, pass ${it + 1} of ${iterations}` : '');
  // convergence: the change in boardings at each line stop from the previous pass, relative to all
  const convergence: number[] = [];
  let prevOn: Partial<Record<TPeriod, Float32Array[]>> | null = null;
  let capacity: CapacityReport = { leftBehind: { AM: 0, MD: 0, PM: 0, NT: 0 }, overCap: { AM: 0, MD: 0, PM: 0, NT: 0 }, stops: [] };
  for (let it = 0; it < iterations; it++) {
    const sk = {} as TrnSkims;
    for (const p of SKIM_PERIODS) {
      stage(`Finding transit routes, ${PERIOD_NAME[p]}${passOf(it)}`, 1);
      sk[p] = await exec.skim(p, crowd[p], lotArg());
    }
    stage(`Choosing where and how people travel${passOf(it)}`, W_DEMAND);
    const demandOn = (arrays?: Record<string, Uint16Array | Float32Array>, over?: DemandOverride) =>
      exec.demand ? exec.demand(sk, dopts, arrays, over) : Promise.resolve(computeDemand(arrays ? withRoadArrays(bundle, arrays) : bundle, prep, sk, calib, scenario.day ?? 'wkd', over ? over.autoCostFactor : (scenario.autoCostFactor ?? 1), undefined, over ? over.context : demandContextOf(scenario), dopts));
    demand = await demandOn(roadArrays);
    demandArrays = roadArrays;
    // traffic feedback: assign the cars, then choose again on the congested times, the volumes
    // averaged over the iterations (MSA), until the cars stop moving between iterations (less than
    // FEEDBACK_TOL of the vehicle trips change) or FEEDBACK_MAX assignments
    if (traffic) {
      const F = Math.max(1, topts.feedback ?? FEEDBACK_MAX);
      // whether the last demand's cars have been assigned
      let assigned = false;
      for (let f = 0; ; f++) {
        // (the last round's times feed no demand in Quick, which has no later round for the buses)
        roadStep();
        roadArrays = { ...roadArrays, ...(await traffic.step(demand.autoOD!, demand.tncEnds, f + 1 >= F && !rm.busReskim)) };
        assigned = true;
        if (f + 1 >= F) break;
        stage(`Choosing again with the new traffic, round ${f + 2}`, W_DEMAND);
        const next = await demandOn(roadArrays);
        demandArrays = roadArrays;
        assigned = false;
        const ch = odChange(demand.autoOD!, next.autoOD!);
        traffic.convergence.push(ch);
        demand = next;
        if (ch < FEEDBACK_TOL) break;
      }
      // buses in traffic take the change in congestion on their streets: the transit paths are found
      // again with their new running times, demand chooses once more, and its cars are assigned
      let bd = traffic.busDelay();
      if (!rm.busReskim) {
        // (Quick: the traffic shown, and the buses' new running times, which go to the loading only,
        // are those of the last demand's cars)
        if (!assigned) {
          roadStep();
          roadArrays = { ...roadArrays, ...(await traffic.step(demand.autoOD!, demand.tncEnds, true)) };
          bd = traffic.busDelay();
        }
        if (Object.keys(bd).length) {
          stage('Updating bus times', 0);
          scn = { ...scn, busDelay: bd };
          await exec.setScenario?.(scn);
        }
      } else if (Object.keys(bd).length) {
        stage('Updating bus times', 0);
        scn = { ...scn, busDelay: bd };
        await exec.setScenario?.(scn);
        for (const p of SKIM_PERIODS) {
          stage(`Finding transit routes with the new bus times, ${PERIOD_NAME[p]}`, 1);
          sk[p] = await exec.skim(p, crowd[p], lotArg());
        }
        stage('Choosing again with the new bus times', W_DEMAND);
        demand = await demandOn(roadArrays);
        demandArrays = roadArrays;
        roadStep();
        roadArrays = { ...roadArrays, ...(await traffic.step(demand.autoOD!, demand.tncEnds, true)) };
      }
    }
    // the time savings taken apart (RunSummary.logsumParts): demand again with today's streets,
    // traffic, and car prices (drivers' part), then with today's conditions too (the others'); a run
    // that changes neither needs no more demand
    if (it === iterations - 1) {
      const carsChange = !!demandArrays || (scenario.autoCostFactor ?? 1) !== 1;
      const conditions = !!cleanContext(scenario.context);
      if (carsChange) stage('Taking the time savings apart: drivers', W_DEMAND);
      const noRoads = carsChange ? (await demandOn(undefined, { context: demandContextOf(scenario), autoCostFactor: 1 })).logsum : demand.logsum;
      const micro = microSettingsOf(scenario);
      if (conditions) stage('Taking the time savings apart: conditions', W_DEMAND);
      const networkOnly = conditions ? (await demandOn(undefined, { context: micro ? { micromobility: micro } : undefined, autoCostFactor: 1 })).logsum : noRoads;
      logsumParts = { networkOnly, noRoads };
      // the Peninsula freeways' background drivers, who make no trip in the model (Traffic.peninsulaGain)
      if (traffic?.net.h.peninsula) logsumParts.peninsula = traffic.peninsulaGain();
    }
    lastAM = sk.AM;
    const next: Partial<Record<TPeriod, Float32Array[]>> = {};
    const passVol: Partial<Record<TPeriod, Float64Array>> = {};
    const cap: CapacityReport = { leftBehind: { AM: 0, MD: 0, PM: 0, NT: 0 }, overCap: { AM: 0, MD: 0, PM: 0, NT: 0 }, stops: [] };
    for (const p of TPERIODS) {
      stage(`Loading riders onto routes, ${PERIOD_NAME[p]}${passOf(it)}`, 1);
      const vol = await exec.assign(p, demand.transitOD[p], crowd[p], lotArg());
      const net = buildNet(bundle, scn, p, calib, crowd[p], lotArg());
      passVol[p] = vol;
      nets[p] = net;
      volumes[p] = lineVolumes(net, vol);
      addTouristRides(net, volumes[p], p, calib, scenario.day ?? 'wkd', scenario.context?.visitors ?? 1);
      addBackground(bundle, net, volumes[p], p, scenario.day ?? 'wkd');
      // crowding and capacity at boarding for the next pass, each averaged with the last (the method
      // of successive averages): the hops' multipliers on in-vehicle time (a step of ½), then the
      // stops' boarding availability (boardingAvailability)
      const fresh = it === 0 && !opts.warmCrowd;
      // availability is a steep function of the loads, so it moves by the method of successive
      // averages' falling step, 1/k for the kth state averaged (½ in a one-pass scenario run from a
      // saved state, then ⅓, ¼...), which damps the swing between a full line and a deserted one
      const lam = 1 / (it + (opts.warmCrowd ? 2 : 1));
      next[p] = net.lines.map((l, li) => {
        const n = l.stops.length, nh = Math.max(0, n - 1);
        // lineState: the hops' crowding, then each stop's boarding availability, boardings, and riders
        // through (the last two kept for warm starts of scenarios that change the line's service)
        const m = new Float32Array(CAPACITY.on ? nh + 3 * n : nh);
        const capT = l.cap * l.trips, seats = l.seats * l.trips;
        const was = crowd[p]?.[li];
        for (let k = 0; k < nh; k++) {
          const v = crowdMultiplier(volumes[p].load[li][k] * LOAD_SPREAD[p], capT, seats);
          const prev = was?.[k] ?? 1;
          m[k] = fresh ? v : (prev + v) / 2;
        }
        if (CAPACITY.on) {
          m[nh + n - 1] = 1;
          for (let k = 0; k < n - 1; k++) {
            const on = volumes[p].on[li][k], through = throughLoad(volumes[p], li, k);
            const b = boardingAvailability(on, through, capT, p);
            // availability within 0.1% of full counts as full (and saves compactly)
            const av = fresh ? b.avail : boardAvail(was, n, k) + lam * (b.avail - boardAvail(was, n, k));
            m[nh + k] = av > 0.999 ? 1 : av;
            // whole riders: enough for a warm start, and they compress
            m[nh + n + k] = Math.round(on);
            m[nh + 2 * n + k] = Math.round(through);
            if (b.leftBehind > 0) {
              cap.leftBehind[p] += b.leftBehind;
              cap.overCap[p] += b.overCap;
              if (b.leftBehind >= 1) cap.stops.push({ p, line: li, k, on, through, capTrips: capT, avail: m[nh + k], leftBehind: b.leftBehind, overCap: b.overCap });
            }
          }
        }
        return m;
      });
    }
    // convergence of the passes: Σ|Δ boardings| / Σ boardings over every line stop and period
    let dOn = 0, sOn = 0;
    for (const p of TPERIODS) {
      volumes[p].on.forEach((a, li) => {
        const b = prevOn?.[p]?.[li];
        for (let k = 0; k < a.length; k++) (sOn += a[k]), (dOn += Math.abs(a[k] - (b && b.length === a.length ? b[k] : 0)));
      });
    }
    if (prevOn) convergence.push(sOn > 0 ? dOn / sOn : 0);
    prevOn = Object.fromEntries(TPERIODS.map((p) => [p, volumes[p].on])) as Record<TPeriod, Float32Array[]>;
    capacity = cap;
    crowd = next;
    // lots the model fills past their room get dearer for the next pass (after the last pass, the
    // updated prices are kept for warm starts)
    const { cars, room } = lotLoads(bundle, nets, passVol);
    lot = updateLotPrices(lot, cars, room);
  }
  progress('Summarizing', 0.99, 0.01);
  const out = summarise(bundle, scn, demand, volumes, nets, prep);
  if (logsumParts) out.summary.logsumParts = logsumParts;
  // jobs reachable within 45 minutes by transit in the morning peak
  if (lastAM) {
    const Z = prep.ZT, NZ = prep.NZ;
    const jobs = bundle.header.zones.map((z) => z.jobs);
    for (let o = 0; o < NZ; o++) {
      let n = jobs[o];
      for (let d = 0; d < NZ; d++) if (d !== o && lastAM.time[o * Z + d] <= 45) n += jobs[d];
      out.zoneJobs45[o] = n;
    }
  }
  // the final crowding, by bundle line, for warm starts
  const finalCrowd = {} as Record<TPeriod, Record<number, Float32Array>>;
  for (const p of TPERIODS) {
    finalCrowd[p] = {};
    nets[p].lines.forEach((l, li) => {
      if (l.src >= 0 && crowd[p]?.[li]) finalCrowd[p][l.src] = crowd[p]![li];
    });
  }
  const finalLotPrice: Record<number, number> = {};
  lot.forEach((v, s) => v > 0 && (finalLotPrice[s] = +v.toFixed(2)));
  return { ...out, runMode: scenario.runMode ?? 'precise', ...(roadResponse ? { roadResponse } : {}), demand, volumes, nets, roadArrays: demandArrays, finalCrowd, finalLotPrice, capacity, convergence, ...(traffic?.state ? { traffic: trafficResult(traffic.state, traffic) } : {}), ms: Date.now() - t0 };
}

/** Collect a run into results keyed by line. */
export function summarise(bundle: Bundle, scenario: Scenario, demand: ReturnType<typeof computeDemand>, volumes: Record<TPeriod, PeriodVolumes>, nets: Record<TPeriod, TransitNet>, prep: Prep): Omit<RunResult, 'ms'> {
  const H = bundle.header;
  const lines = new Map<string, LineResult>();
  const S = H.stops.length + Math.max(0, ...TPERIODS.map((p) => nets[p]?.newStops.length ?? 0));
  const stopOn = new Float32Array(S), stopOff = new Float32Array(S);
  const stopOnBy = {} as Record<TPeriod, Float32Array>, stopOffBy = {} as Record<TPeriod, Float32Array>;
  const boardings: Record<string, number> = {};
  let opCost = 0, revenueHours = 0;
  const newIds = scenario.edits.filter((e) => e.kind === 'newLine').map((e) => (e as { id: string }).id);
  for (const p of TPERIODS) {
    const net = nets[p], vol = volumes[p];
    const onP = (stopOnBy[p] = new Float32Array(S)), offP = (stopOffBy[p] = new Float32Array(S));
    net.lines.forEach((l, li) => {
      const key = l.src >= 0 ? `b${l.src}` : `n${l.newId}`;
      let r = lines.get(key);
      if (!r) {
        const idx = l.src >= 0 ? l.src : -1 - Math.max(0, newIds.indexOf(l.newId!.replace(/:r$/, '')));
        const changed = l.src >= 0 && (l.stops.length !== H.lines[l.src].stops.length || l.stops.some((s, k) => s !== H.lines[l.src].stops[k]));
        r = { line: idx, reverse: l.src < 0 && /:r$/.test(l.newId ?? ''), ...(changed ? { stops: l.stops } : {}), boardings: { AM: 0, MD: 0, PM: 0, NT: 0 }, loads: {} as Record<TPeriod, Float32Array>, peakLoadFactor: 0, revenueHours: 0, passengerKm: 0 };
        lines.set(key, r);
      }
      let b = 0;
      vol.on[li].forEach((v, k) => {
        b += v;
        stopOn[l.stops[k]] += v;
        onP[l.stops[k]] += v;
      });
      vol.off[li].forEach((v, k) => ((stopOff[l.stops[k]] += v), (offP[l.stops[k]] += v)));
      r.boardings[p] += b;
      r.loads[p] = vol.load[li];
      const cap = l.cap * l.trips;
      const along = l.src >= 0 && !r.stops ? hopKm(bundle)[l.src] : null;
      for (let k = 0; k < vol.load[li].length; k++) {
        r.peakLoadFactor = Math.max(r.peakLoadFactor, cap > 0 ? vol.load[li][k] / cap : 0);
        const a = l.stops[k], c = l.stops[k + 1];
        const sa = a < H.stops.length ? H.stops[a] : net.newStops[a - H.stops.length];
        const sc = c < H.stops.length ? H.stops[c] : net.newStops[c - H.stops.length];
        // passenger-km of the modeled riders only (background riders are not in the boardings either)
        r.passengerKm += (vol.load[li][k] - (vol.bg?.[li]?.[k] ?? 0)) * (along ? along[k] : Math.hypot(sc.x - sa.x, sc.y - sa.y) / 1000);
      }
      const hours = (l.trips * l.hops.reduce((s, h) => s + h, 0)) / 3600;
      r.revenueHours += hours;
      revenueHours += hours;
      opCost += hours * (COST_PER_HOUR[l.mode] ?? 300);
      const op = l.feed === 'new' ? 'new' : l.feed;
      boardings[op] = (boardings[op] ?? 0) + b;
    });
  }
  // jobs reachable within 45 minutes by transit in the morning (from the last AM skim's times)
  const NZ = prep.NZ;
  const zoneJobs45 = new Float32Array(NZ);
  const transitTrips = demand.trips.transit;
  void MODES;
  return {
    scenario: scenario.name,
    summary: {
      trips: demand.trips,
      residentTrips: demand.residentTrips,
      byPurpose: demand.byPurpose,
      boardings,
      transitTrips,
      shuttleTrips: demand.shuttleTrips,
      vkt: demand.vkt,
      logsum: demand.logsum,
      opCost,
      revenueHours,
      avgTransitMin: demand.avgTransitMin,
      carOwn: demand.carOwn,
      driveMin: demand.driveMin,
    },
    lines: [...lines.values()],
    stopOn,
    stopOff,
    stopOnBy,
    stopOffBy,
    zoneTransitShare: demand.zoneTransitShare,
    zoneJobs45,
    zoneLogsum: demand.zoneLogsum,
  };
}

export { prepare };
