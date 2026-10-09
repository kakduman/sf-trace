/**
 * Shared micromobility: Bay Wheels bikeshare (classic bikes and e-bikes, from stations; e-bikes also
 * from wherever the last rider left one) and the permitted shared e-scooters (Lime and Spin), as a
 * travel mode and as a way to reach and leave rail and ferry stations.
 *
 * As a mode, each shared vehicle is an alternative in the non-motorized nest beside walking and an own
 * bike. It is booked under the bike mode, whose survey targets count bikeshare and scooter-share trips
 * as cycling (BATS 2023's linked "bike"), so those targets stay as they were. Being in the nest with
 * walking, not in a nest of its own with the own bike, follows the observed substitution: a shared
 * scooter or bike most often replaces a walk, then a ride-hail or a transit trip (SFMTA's 2022 scooter
 * survey; Reck et al. 2022 in Zurich), and SANDAG's ABM3 likewise keeps them apart from personal bikes.
 * In the code the bike alternative's utility becomes the log-sum of own bike and shared vehicles at the
 * non-motorized nest's own coefficient (MICRO.nest = NEST), which is the same choice as listing them in
 * that nest; the shares within it are booked as shared trips. Each shared vehicle's utility differs
 * from an own bike's by the walk to the vehicle and from where it is left, its riding time (its own
 * speed and climbing on the same route), its price, and a calibrated constant.
 *
 * Demand hooks (demand.ts): `at` before each choice, `bikeUtility` inside the mixture over values of
 * time, `book` when trips are booked, `youth` for the bike trips of persons under 18 (who may not
 * rent: both operators require riders to be 18), and `result` for the tallies.
 * Network hooks (net.ts): `microLinks` adds access and egress links by shared vehicle between city
 * zones and stations.
 */
import { VOT_MAX, VOT_MEDIAN_OF_MEAN, VOT_MIN, VOT_MIX_W, VOT_MIX_Z, VOT_SIGMA, VOT_TYPICAL, VOT_VISITOR, PATH, costCoef, coeffsOf, NEST, PURPOSES, TOUR_COEFFS, type Purpose } from './params';
import { TPERIODS, type Bundle, type Calibration, type DemandContext, type Scenario } from './types';

export const MICRO_TYPES = ['classic', 'ebike', 'scooter'] as const;
export type MicroType = (typeof MICRO_TYPES)[number];

/** Scenario settings (a scenario's 'micromobility' edit): multipliers on today's system */
export interface MicroSettings {
  /** Bay Wheels stations and bikes (1 = today's; walks to a station scale by 1/√factor) */
  docks?: number;
  /** scooters on the street (1 = today's; walks to one scale by 1/√factor) */
  fleet?: number;
  /** prices: Bay Wheels, and scooters */
  bikePrice?: number;
  scooterPrice?: number;
}

/** the demand conditions a scenario's demand is computed with: its context and its shared vehicles */
export function demandContextOf(s: Scenario): DemandContext | undefined {
  const m = microSettingsOf(s);
  return m ? { ...(s.context ?? {}), micromobility: m } : s.context;
}

/** a scenario's shared-vehicle settings: its 'micromobility' edits, multiplied (undefined: today's) */
export function microSettingsOf(s: Scenario): MicroSettings | undefined {
  let out: Required<MicroSettings> | undefined;
  for (const e of s.edits) {
    if (e.kind !== 'micromobility') continue;
    out ??= { ...SETTINGS0 };
    for (const k of Object.keys(SETTINGS0) as (keyof MicroSettings)[]) out[k] *= e[k] ?? 1;
  }
  return out;
}

/** what calibration fits (Calibration.micro) */
export interface MicroCalib {
  /** constants on the shared vehicles against an own bike: Bay Wheels (both bikes), e-bikes (on top), scooters */
  asc: { bayWheels: number; ebike: number; scooter: number };
  /** perceived minutes on riding a shared vehicle to a station, fit to Bay Wheels rides ending at stations */
  accessBias: number;
  /** ...and away from one, fit to Bay Wheels rides starting at the downtown stations (accessBias when absent) */
  egressBias?: number;
  /** a term per km ridden (utils, ≤ 0), fit to Bay Wheels' mean trip length */
  kmCoef?: number;
  /** the own bike's effort of climbing beyond its time, utils per metre climbed on the route (≤ 0), fitted
   * to the ACS's bike commuters by neighborhood (the shared vehicles' are from the literature: MICRO.climbEquiv) */
  climb?: { own?: number };
  /** the last fit: [model, target] */
  fit?: Record<string, [number, number]>;
}

export const MICRO = {
  /**
   * Riding time, seconds = start + perM · metres + perMClimbed · metres climbed, along the route an own
   * bike takes (skims.ts weights). Bay Wheels classic and e-bikes: fitted to members' rides between
   * stations, October 2025 to September 2026 (each station pair's median ride, weighted by rides;
   * bikeshare.ts, reference/bay-wheels-sf.json speeds). Scooters: the e-bikes' times divided by 0.77,
   * the ratio of shared e-scooters' mean trip speeds to dockless e-bikes' in Austin's open trip data
   * (2.19–2.78 against 3.01–3.44 m/s; Almannaa et al. 2021), climbing included (no shared-scooter
   * speeds on grades are published). The start covers unlocking and setting off.
   */
  speed: {
    classic: { start: 32.0, perM: 0.2369, perMClimbed: 4.35 },
    ebike: { start: 57.8, perM: 0.1748, perMClimbed: 1.01 },
    scooter: { start: 57.8, perM: 0.1748 / 0.77, perMClimbed: 1.01 / 0.77 },
  } as Record<MicroType, { start: number; perM: number; perMClimbed: number }>,
  /**
   * Prices (2026). Bay Wheels (lyftbikes.com/pricing): a single ride $1 to unlock and $0.19 a minute on a
   * classic bike, $0.49 on an e-bike; members ($165 a year or $29 a month) ride classic bikes free for
   * 45 minutes ($0.17 a minute after) and e-bikes at $0.17 a minute; Bike Share for All members ($5 a
   * month) ride classic bikes free for 60 minutes ($0.13 after) and e-bikes at $0.05 a minute, at most
   * $1. Members' fees are sunk: they pay only the per-minute charges. An e-bike left at a public rack
   * rather than a station costs $2. Scooters: Lime $1 to unlock, $0.55 a minute, and $0.48 of city
   * permit fee and local costs a ride (li.me); Spin $1, $0.55 a minute, and a $0.50 fee (spin.app);
   * weighted by their trips (Lime 83.5%, SFMTA's counts), $1.48 a ride and $0.55 a minute.
   */
  price: {
    unlock: 1.0,
    casualPerMin: { classic: 0.19, ebike: 0.49 },
    member: { classicFreeMin: 45, classicPerMin: 0.17, ebikePerMin: 0.17 },
    bsfa: { classicFreeMin: 60, classicPerMin: 0.13, ebikePerMin: 0.05, ebikeMax: 1.0 },
    rackFee: 2.0,
    scooterUnlock: 0.835 * 1.48 + 0.165 * 1.5,
    scooterPerMin: 0.55,
  },
  /**
   * Who rides Bay Wheels in the city: casual riders 18.5% of weekday trips with both ends in the city
   * (trip data, October 2025 to September 2026); Bike Share for All members took nearly 300,000 trips
   * in 2025 (SF.gov, July 29, 2026), 7.2% of the city's 4,153,543 (SFMTA's counts); the rest are members.
   */
  riders: { casual: 0.185, bsfa: 0.072 },
  /** the longest walk to a station or a vehicle counted as having one (minutes) */
  reachMin: 10,
  /** the walk from where a vehicle is left at a rack or pole (minutes, assumed) */
  parkMin: 1,
  /**
   * Vehicles away from stations on an average day: scooters, the two operators' average deployed fleet
   * in 2025 (Lime 2,618, Spin 2,120; SFMTA Board staff report, May 5, 2026); Bay Wheels e-bikes, those
   * standing away from a station in the GBFS snapshot (reference/bay-wheels-sf.json system). Spread
   * over the zones by their residents and jobs (assumed); the walk to the nearest is half the spacing
   * of a random scatter, 0.5/√density, times 1.3 for the street grid.
   */
  fleet: { scooter: 2618 + 2120, ebikeAway: 649 },
  /** the coefficient among own bike and the shared vehicles: the non-motorized nest's (they share it with walking) */
  nest: NEST,
  /**
   * Riding time's weight, in in-vehicle minutes a minute: 1, as in SANDAG's ABM3 (coef_ivt on e-bike and
   * e-scooter riding time). Riders of shared vehicles weigh a minute of riding well below a minute of
   * walking: 0.42 of it for bikeshare and 0.55 for e-scooter sharing in Krauss, Krail & Axhausen's (2022)
   * German mixed logit, 0.84 and 1.1 in-vehicle minutes at TM1's walk weight of 2. With that weight and
   * the constants the counts need, shared trips came out three times as long as Bay Wheels' rides, so a
   * term per km ridden is fitted to their mean length (MicroCalib.kmCoef), as destination choice's
   * distance terms are fitted to NHTS trip lengths; it is used for riding to and from stations too.
   */
  rideWeight: 1,
  /**
   * The effort of climbing beyond the time it takes, as metres of riding per metre climbed (the riding's
   * own utility per metre, time and distance term, prices it): what route-choice studies give for the
   * whole cost of a climb, less what the vehicle's riding time already charges for it here.
   *  - classic: Hood, Sall & Charlton (2011), San Francisco's CycleTracks route choice: on average, 100
   *    feet of climbing is worth 1.12 miles of riding, 59 m a metre; the classic bikes' fitted time
   *    (speed.classic) charges 4.35 s a metre climbed, 18.4 m of flat riding at 0.2369 s a metre: 40.7.
   *  - ebike: Meister, Felder, Schmid & Axhausen (2023), Zurich: e-bike riders' median value of distance on
   *    6–10% slopes is 0.40 of conventional riders' (1.01 against 2.51 km a km), so 0.40 × 59 = 23.6 m a
   *    metre, less the e-bikes' time, 1.01 / 0.1748 = 5.8 m: 17.8.
   *  - scooter: no detectable cost of climbing among Washington's shared e-scooter riders (Qian et al.
   *    2026), so none beyond the time.
   * The own bike's is fitted (MicroCalib.climb.own) to the ACS's bike commuters by neighborhood; its time
   * already slows a 5% climb to under half speed (geo.ts bikeSpeed).
   */
  climbEquiv: { classic: 59 - 4.35 / 0.2369, ebike: 0.4 * 59 - 1.01 / 0.1748, scooter: 0 } as Record<MicroType, number>,
  /** rides to and from stations (metres along the route) */
  accessMinM: 400,
  accessMaxM: 6000,
};

const WALK_FLAT = 1.34;

/** Zone-level inputs prepared once per bundle and scenario settings. */
export interface MicroData {
  NZ: number;
  /** per zone: share of its people within reach of a vehicle, and their mean walk (minutes), by type */
  share: Float32Array[];
  walk: Float32Array[];
  /** per zone: walk from a Bay Wheels station to the zone (its mean, minutes; Infinity beyond reach) */
  dockWalk: Float32Array;
  dockShare: Float32Array;
  /** per zone: the walk to the nearest free e-bike and scooter (minutes) */
  freeWalk: { ebike: Float32Array; scooter: Float32Array };
  /** per block (zone points): walk to the nearest station (minutes; Infinity beyond reach) */
  ptDock: Float32Array;
  bikeUp: Uint16Array;
  bikeFeel: Uint8Array;
  bikeM: Uint16Array;
  bikeSec: Uint16Array;
  /** neighborhood of each zone (index into nhoods) */
  nh: Int32Array;
  nhoods: string[];
  settings: Required<MicroSettings>;
}

const SETTINGS0: Required<MicroSettings> = { docks: 1, fleet: 1, bikePrice: 1, scooterPrice: 1 };
const dataCache = new WeakMap<object, Map<string, MicroData>>();

export function microData(b: Bundle, s?: MicroSettings): MicroData | null {
  const A = b.a;
  if (!A.mmPtDock || !A.bikeUp) return null;
  const settings = { ...SETTINGS0, ...(s ?? {}) };
  const key = JSON.stringify(settings);
  const m = dataCache.get(b.header) ?? new Map<string, MicroData>();
  dataCache.set(b.header, m);
  const hit = m.get(key);
  if (hit) return hit;
  const H = b.header, NZ = H.zones.length;
  const zps = A.zonePtStart as Int32Array, zpw = A.zonePtW as Float32Array, pd = A.mmPtDock as Uint16Array;
  // more stations, nearer: walks scale by 1/√(station density)
  const dockScale = settings.docks > 0 ? 1 / Math.sqrt(settings.docks) : Infinity;
  const ptDock = Float32Array.from(pd, (t) => (t === 65535 ? Infinity : (t / 60) * dockScale));
  // vehicles away from stations, spread by residents and jobs
  const act = H.zones.map((z) => z.pop + z.jobs);
  const actT = act.reduce((a, v) => a + v, 0);
  const free = (n: number) =>
    Float32Array.from(H.zones, (z, i) => {
      const rho = (n * act[i]) / actT / Math.max(z.land, 1e4);
      return rho > 0 ? (1.3 * 0.5) / Math.sqrt(rho) / WALK_FLAT / 60 : Infinity;
    });
  const freeWalk = { ebike: free(MICRO.fleet.ebikeAway * settings.docks), scooter: free(MICRO.fleet.scooter * settings.fleet) };
  const share = MICRO_TYPES.map(() => new Float32Array(NZ)), walk = MICRO_TYPES.map(() => new Float32Array(NZ));
  const dockWalk = new Float32Array(NZ), dockShare = new Float32Array(NZ);
  const R = MICRO.reachMin;
  for (let z = 0; z < NZ; z++) {
    let W = 0, rc = 0, tc = 0, re = 0, te = 0;
    for (let q = zps[z]; q < zps[z + 1]; q++) {
      const w = zpw[q];
      W += w;
      const td = ptDock[q];
      if (td <= R) (rc += w), (tc += w * td);
      const tf = Math.min(td, freeWalk.ebike[z]);
      if (tf <= R) (re += w), (te += w * tf);
    }
    share[0][z] = W > 0 ? rc / W : 0;
    walk[0][z] = rc > 0 ? tc / rc : Infinity;
    share[1][z] = W > 0 ? re / W : 0;
    walk[1][z] = re > 0 ? te / re : Infinity;
    const ts = freeWalk.scooter[z];
    share[2][z] = ts <= R ? 1 : 0;
    walk[2][z] = ts;
    dockWalk[z] = walk[0][z];
    dockShare[z] = share[0][z];
  }
  const nhoods = [...new Set(H.zones.map((z) => z.nhood))].sort();
  const nhIdx = new Map(nhoods.map((n, i) => [n, i]));
  const d: MicroData = {
    NZ, share, walk, dockWalk, dockShare, freeWalk, ptDock,
    bikeUp: A.bikeUp as Uint16Array, bikeFeel: A.bikeFeel as Uint8Array, bikeM: A.bikeM as Uint16Array, bikeSec: A.bikeSec as Uint16Array,
    nh: Int32Array.from(H.zones, (z) => nhIdx.get(z.nhood)!), nhoods, settings,
  };
  m.set(key, d);
  return d;
}

/** riding seconds (actual) of a shared vehicle over a route of `m` metres climbing `up` metres */
export const rideSec = (k: MicroType, m: number, up: number) => {
  const s = MICRO.speed[k];
  return s.start + s.perM * m + s.perMClimbed * up;
};

/** the expected price of a ride of `min` minutes (actual), over Bay Wheels' riders; `rack`: an e-bike left away from a station */
export function ridePrice(k: MicroType, min: number, settings: Required<MicroSettings>, rack = false): number {
  const P = MICRO.price, sc = MICRO.riders.casual, sb = MICRO.riders.bsfa, sm = 1 - sc - sb;
  if (k === 'scooter') return settings.scooterPrice * (P.scooterUnlock + P.scooterPerMin * min);
  let v: number;
  if (k === 'classic') v = sc * (P.unlock + P.casualPerMin.classic * min) + sm * P.member.classicPerMin * Math.max(0, min - P.member.classicFreeMin) + sb * P.bsfa.classicPerMin * Math.max(0, min - P.bsfa.classicFreeMin);
  else v = sc * (P.unlock + P.casualPerMin.ebike * min) + sm * P.member.ebikePerMin * min + sb * Math.min(P.bsfa.ebikeMax, P.bsfa.ebikePerMin * min) + (rack ? P.rackFee : 0);
  return settings.bikePrice * v;
}

/** an e-bike ends at a station when walking from it costs less than a rack's walk and fee (at a typical value of time) */
const ebikeEnd = (dockWalkMin: number) => {
  const rack = MICRO.parkMin + MICRO.price.rackFee / (VOT_TYPICAL / 60) / PATH.walkWeight;
  return dockWalkMin <= rack ? { walk: dockWalkMin, rack: false } : { walk: MICRO.parkMin, rack: true };
};

/** an own bike's or a shared vehicle's riding term (TM1: one coefficient to 30 minutes, another beyond) */
const bikeTerm = (C: { bikeShort: number; bikeLong: number }, t: number) => C.bikeShort * Math.min(t, 30) + C.bikeLong * Math.max(0, t - 30);
/** the share of travelers with the vehicle, as its log (a market segment without it) */
const lg = (v: number) => (v < 1 ? Math.log(Math.max(v, 1e-6)) : 0);
const LEG = 12;
const PIDX = new Map(PURPOSES.map((p, i) => [p as Purpose, i]));
const legCache = new WeakMap<MicroData, { legs: Float32Array; done: Uint8Array }>();

export interface MicroResult {
  /** trips by type (classic, e-bike, scooter) */
  trips: number[];
  /** by type and period (TPERIODS) */
  byPeriod: number[][];
  /** by purpose: [classic, e-bike, scooter] */
  byPurpose: Record<string, number[]>;
  /** residents' trips by type */
  resident: number[];
  /** trip km by type (bike route lengths), for the mean trip length */
  km: number[];
  /** residents' commute trips by bike (own and shared), by home zone */
  bikeWorkHome: Float64Array;
  /** Bay Wheels trips (classic and e-bike) by neighborhood pair (origin row; MicroData.nhoods), and the classic bikes' */
  od: Float64Array;
  odClassic: Float64Array;
  /** Bay Wheels trips leaving and reaching each zone */
  zoneFrom: Float64Array;
  zoneTo: Float64Array;
}

/**
 * The shared-vehicle part of mode choice for one demand part (demand.ts). `at` sets the pair being
 * chosen; `bikeUtility` returns the bike alternative's utility (own bike and shared vehicles) at a cost coefficient; `book` tallies the
 * shared trips among booked bike trips.
 */
export class MicroDemand {
  /** per type: utility relative to an own bike (constants included), and price, of the current choice */
  private D = new Float64Array(3);
  private M = new Float64Array(3);
  private avail = new Uint8Array(3);
  private any = false;
  private res: MicroResult;
  /** bike trips of persons under 18, by purpose and destination, to leave out at booking */
  private youthBike: Record<string, Float64Array> = {};
  private asc: Float64Array;
  private km: number;
  /** effort of climbing: metres of riding per metre climbed by vehicle (MICRO.climbEquiv), as riding
   * minutes per metre climbed, and the own bike's (utils per metre climbed, fitted) */
  private climbM: Float64Array;
  private climbIvt: Float64Array;
  private climbOwn: number;
  private legs: Float32Array;
  private legDone: Uint8Array;
  constructor(
    private d: MicroData,
    calib: Calibration,
    private vot: Float32Array,
    private tod?: Record<MicroType, number[]>,
  ) {
    const c = calib.micro?.asc ?? { bayWheels: 0, ebike: 0, scooter: 0 };
    this.asc = Float64Array.from([c.bayWheels, c.bayWheels + c.ebike, c.scooter]);
    this.km = calib.micro?.kmCoef ?? 0;
    this.climbM = Float64Array.from(MICRO_TYPES, (k) => MICRO.climbEquiv[k]);
    this.climbIvt = Float64Array.from(MICRO_TYPES, (k) => (MICRO.rideWeight * MICRO.climbEquiv[k] * MICRO.speed[k].perM) / 60);
    this.climbOwn = calib.micro?.climb?.own ?? 0;
    // the legs' purpose-free terms, shared by every demand part over the same data
    const lc = legCache.get(d) ?? legCache.set(d, { legs: new Float32Array(d.NZ * d.NZ * LEG), done: new Uint8Array(d.NZ * d.NZ) }).get(d)!;
    this.legs = lc.legs;
    this.legDone = lc.done;
    this.cacheTag = new Int32Array(PURPOSES.length * 3 * d.NZ).fill(-1);
    this.cacheVal = new Float64Array(PURPOSES.length * 3 * d.NZ * 7);
    const NH = d.nhoods.length;
    this.res = { trips: [0, 0, 0], byPeriod: MICRO_TYPES.map(() => TPERIODS.map(() => 0)), byPurpose: {}, resident: [0, 0, 0], km: [0, 0, 0], bikeWorkHome: new Float64Array(d.NZ), od: new Float64Array(NH * NH), odClassic: new Float64Array(NH * NH), zoneFrom: new Float64Array(d.NZ), zoneTo: new Float64Array(d.NZ) };
  }

  /**
   * One leg's terms, which do not depend on the purpose, worked out once per zone pair (LEG floats a
   * pair, in `legs`; `legDone` marks those done): an own bike's minutes, then by type the perceived
   * riding minutes, the minutes walked at both ends, and the price.
   */
  private legBase(q: number): number {
    const x = this.d, L = this.legs, i = q * LEG;
    if (this.legDone[q]) return i;
    const NZ = x.NZ, o = (q / NZ) | 0, d = q - o * NZ;
    const bm = x.bikeM[q], up = x.bikeUp[q] / 10, feel = x.bikeFeel[q] / 100;
    L[i] = x.bikeSec[q] / 60;
    L[i + 10] = bm / 1000;
    L[i + 11] = up;
    const e = ebikeEnd(x.dockWalk[d]);
    for (let k = 0; k < 3; k++) {
      const type = MICRO_TYPES[k];
      const sp = MICRO.speed[type];
      const sec = rideSec(type, bm, up);
      // perceived as an own bike's time is: the route's weight on the riding, not on the start
      L[i + 1 + k] = (sp.start + (sec - sp.start) * feel) / 60;
      L[i + 4 + k] = k === 0 ? x.walk[0][o] + x.dockWalk[d] : k === 1 ? x.walk[1][o] + e.walk : x.walk[2][o] + MICRO.parkMin;
      L[i + 7 + k] = ridePrice(type, sec / 60, x.settings, k === 1 && e.rack);
    }
    this.legDone[q] = 1;
    return i;
  }

  /** a leg's terms (utils, without constants) and prices, added into D and M with weight f */
  private leg(o: number, d: number, C: ReturnType<typeof coeffsOf>, f: number) {
    const L = this.legs, i = this.legBase(o * this.d.NZ + d);
    const ownU = bikeTerm(C, L[i]);
    for (let k = 0; k < 3; k++) {
      if (!this.avail[k]) continue;
      this.D[k] += f * (MICRO.rideWeight * C.ivt * L[i + 1 + k] + C.walkShort * L[i + 4 + k] + this.km * (L[i + 10] + this.climbM[k] * L[i + 11] / 1000) + this.climbIvt[k] * C.ivt * L[i + 11] - this.climbOwn * L[i + 11] - ownU);
      this.M[k] += f * L[i + 7 + k];
    }
  }

  /**
   * Set the choice being made: zones o → d (both in the city), the purpose's coefficients, and the form
   * (1: one way; 2: a tour, both legs summed; 3: a round trip, the legs averaged). Persons under 18 may
   * not rent.
   */
  at(o: number, d: number, purpose: Purpose, form: 1 | 2 | 3, youth: boolean) {
    const x = this.d;
    this.any = false;
    if (youth || o >= x.NZ || d >= x.NZ) return;
    // the same choice for each household class: kept for the origin being worked on
    if (o !== this.cacheO) (this.cacheO = o), this.cacheGen++;
    const ck = ((PIDX.get(purpose) ?? 0) * 3 + form - 1) * x.NZ + d, cv = ck * 7;
    if (this.cacheTag[ck] === this.cacheGen) {
      const c = this.cacheVal;
      for (let k = 0; k < 3; k++) (this.D[k] = c[cv + k]), (this.M[k] = c[cv + 3 + k]), (this.avail[k] = (c[cv + 6] >> k) & 1);
      this.any = c[cv + 6] > 0;
      return;
    }
    this.compute(o, d, purpose, form);
    const c = this.cacheVal;
    for (let k = 0; k < 3; k++) (c[cv + k] = this.D[k]), (c[cv + 3 + k] = this.M[k]);
    c[cv + 6] = this.any ? this.avail[0] | (this.avail[1] << 1) | (this.avail[2] << 2) : 0;
    this.cacheTag[ck] = this.cacheGen;
  }
  private cacheO = -1;
  private cacheGen = 0;
  private cacheTag: Int32Array;
  private cacheVal: Float64Array;
  private compute(o: number, d: number, purpose: Purpose, form: 1 | 2 | 3) {
    const x = this.d;
    const C = coeffsOf(purpose);
    // availability: a station within reach at both ends (classic bikes), an e-bike within reach at the
    // start, a scooter within reach
    this.avail[0] = x.share[0][o] > 0 && x.dockShare[d] > 0 && x.settings.docks > 0 ? 1 : 0;
    this.avail[1] = x.share[1][o] > 0 && x.settings.docks > 0 ? 1 : 0;
    this.avail[2] = x.share[2][o] > 0 && x.settings.fleet > 0 ? 1 : 0;
    // ...and back, for a round trip
    if (form !== 1) {
      this.avail[0] &= x.share[0][d] > 0 && x.dockShare[o] > 0 ? 1 : 0;
      this.avail[1] &= x.share[1][d] > 0 ? 1 : 0;
      this.avail[2] &= x.share[2][d] > 0 ? 1 : 0;
    }
    if (!this.avail[0] && !this.avail[1] && !this.avail[2]) return;
    this.D.fill(0);
    this.M.fill(0);
    const f = form === 3 ? 0.5 : 1;
    this.leg(o, d, C, f);
    if (form !== 1) this.leg(d, o, C, f);
    // the share of the travelers who have the vehicle (the log, as a market segment without it): a
    // station within reach at both ends for a classic bike, whichever the direction; for an e-bike or a
    // scooter, one within reach where each leg starts
    this.D[0] += lg(x.share[0][o] * x.dockShare[d]);
    this.D[1] += lg(x.share[1][o] * (form !== 1 ? x.share[1][d] : 1));
    this.D[2] += lg(x.share[2][o] * (form !== 1 ? x.share[2][d] : 1));
    for (let k = 0; k < 3; k++) this.D[k] += this.asc[k];
    this.any = true;
  }

  /** the own bike's climbing term on the route o → d (zone pair index q), utils */
  ownClimb(q: number): number {
    return this.climbOwn * (this.d.bikeUp[q] / 10);
  }

  /** whether the current choice has a shared vehicle */
  get active() {
    return this.any;
  }

  /** the bike alternative's utility (own bike and shared vehicles) at cost coefficient cc, given an own bike's v; fills `sub` with the shares within it */
  readonly sub = new Float64Array(4);
  bikeUtility(v: number, cc: number): number {
    if (!this.any || v === -Infinity) {
      this.sub.fill(0);
      this.sub[3] = 1;
      return v;
    }
    const mu = MICRO.nest;
    let s = 1;
    for (let k = 0; k < 3; k++) {
      const e = this.avail[k] ? Math.exp((this.D[k] + cc * this.M[k]) / mu) : 0;
      this.sub[k] = e;
      s += e;
    }
    for (let k = 0; k < 3; k++) this.sub[k] /= s;
    this.sub[3] = 1 / s;
    return v + mu * Math.log(s);
  }

  /** bike trips of persons under 18 in a pool booked later (destChoiceTypes), to keep out of the shared tally */
  youth(purpose: Purpose, d: number, n: number) {
    (this.youthBike[purpose] ??= new Float64Array(this.d.NZ))[d] += n;
  }

  /**
   * Tally the shared trips among `n` bike trips (both legs of a round trip, or one way) between o and d.
   * The split within the bike alternative is taken at the travelers' value of time (the mixture of TM1's
   * spread around it): the origin zone's for residents, the typical or the visitors' for others.
   * `legs`: trips per tour leg booked (1, or 1 + the share of halves with a stop); `out`: the share
   * going o → d; `periods`: each direction's share by period.
   */
  book(o: number, d: number, n: number, purpose: Purpose, segKey: string | null, resident: boolean, legs: number, out: number, wOut: Float64Array, wBack: Float64Array) {
    const x = this.d;
    if (n <= 0 || o >= x.NZ) return;
    if (resident && purpose === 'work') this.res.bikeWorkHome[o] += n;
    if (d >= x.NZ) return;
    const yb = this.youthBike[purpose];
    if (yb && yb[d] > 0) {
      const y = Math.min(n, yb[d]);
      yb[d] = 0;
      n -= y;
    }
    if (purpose === 'school' || n <= 0) return;
    const oneWay = out >= 1;
    this.at(o, d, purpose, oneWay ? 1 : TOUR_COEFFS[purpose] ? 2 : 3, false);
    if (!this.any) return;
    const vot = resident && segKey !== 'ext' && segKey !== 'visitor' ? this.vot[o] : segKey === 'visitor' ? VOT_VISITOR : VOT_TYPICAL;
    const C = coeffsOf(purpose);
    const p = [0, 0, 0];
    for (let j = 0; j < VOT_MIX_Z.length; j++) {
      const cc = costCoef(C.ivt, Math.min(VOT_MAX, Math.max(VOT_MIN, vot * VOT_MEDIAN_OF_MEAN * Math.exp(VOT_SIGMA * VOT_MIX_Z[j]))));
      this.bikeUtility(0, cc);
      for (let k = 0; k < 3; k++) p[k] += VOT_MIX_W[j] * this.sub[k];
    }
    const R = this.res, NH = x.nhoods.length;
    const pp = (R.byPurpose[purpose] ??= [0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      const t = n * p[k] * legs;
      if (!(t > 0)) continue;
      R.trips[k] += t;
      R.km[k] += (t * (x.bikeM[o * x.NZ + d] + x.bikeM[d * x.NZ + o])) / 2000;
      pp[k] += t;
      if (resident) R.resident[k] += t;
      const to = t * out, tb = t - to;
      // by period: each vehicle's own profile (Bay Wheels by hour), else the purpose's legs'
      const tod = this.tod?.[MICRO_TYPES[k]];
      for (let q = 0; q < TPERIODS.length; q++) R.byPeriod[k][q] += tod ? t * tod[q] : to * wOut[q] + tb * wBack[q];
      if (k === 2) continue;
      R.od[x.nh[o] * NH + x.nh[d]] += to;
      R.od[x.nh[d] * NH + x.nh[o]] += tb;
      if (k === 0) (R.odClassic[x.nh[o] * NH + x.nh[d]] += to), (R.odClassic[x.nh[d] * NH + x.nh[o]] += tb);
      R.zoneFrom[o] += to;
      R.zoneTo[d] += to;
      R.zoneFrom[d] += tb;
      R.zoneTo[o] += tb;
    }
  }

  result(): MicroResult {
    return this.res;
  }
}

/** the shared-vehicle part of a demand part, or null for a bundle without shared-vehicle data */
export function microDemand(b: Bundle, calib: Calibration, vot: Float32Array, settings?: MicroSettings): MicroDemand | null {
  const d = microData(b, settings);
  return d ? new MicroDemand(d, calib, vot, b.header.micro?.tod) : null;
}

// ---------------- access to and egress from stations ----------------

/**
 * Link kinds (TransitNet.mmKind): a Bay Wheels bike from a station (classic or e-bike), a Bay Wheels
 * e-bike found on the street, or a scooter; to a station (access, 0–2) or from one (egress, 3–5)
 */
export const MM_DOCK_ACCESS = 0, MM_EBIKE_ACCESS = 1, MM_SCOOTER_ACCESS = 2, MM_DOCK_EGRESS = 3, MM_EBIKE_EGRESS = 4, MM_SCOOTER_EGRESS = 5;
export const MM_KIND = ['station bike', 'e-bike on the street', 'scooter'] as const;
export const isMicroAccess = (k: number) => k >= 0 && k < 3;

export interface MicroLink {
  kind: number;
  /** the vehicle ridden (for a station's bikes, the cheaper of the classic bike and the e-bike) */
  vehicle: MicroType;
  /** zone and bundle stop */
  z: number;
  s: number;
  place: number;
  /** minutes walked apart from the blocks' own walk, riding minutes (actual), perceived riding minutes, price ($) */
  walk: number;
  ride: number;
  ridePerceived: number;
  /** km ridden, and the climb's effort as more riding (MICRO.climbEquiv), for the distance term */
  km: number;
  price: number;
  /** access only: the walk to the vehicle from each block of the zone (zone points; minutes,
   * Infinity beyond reach), and its mean over the blocks within reach */
  blocks?: Float32Array;
  zoneWalk?: number;
}

/**
 * The access and egress links by shared vehicle (net.ts buildNet): for each city zone and each rail or
 * ferry station 400 m to 6 km away by bike, riding a Bay Wheels bike from a station near home (classic
 * or e-bike, whichever costs less), a Bay Wheels e-bike found on the street, or a scooter, to the
 * station, and the same from it (three links each way, among which riders split as among stops). A
 * station's bike is left at the Bay Wheels station nearest the platform (a classic bike must be), an
 * e-bike at a station or a rack, a scooter beside the station. The link's riding time is weighted as
 * in-vehicle time (MICRO.rideWeight), the distance term (MicroCalib.kmCoef) is converted to in-vehicle
 * minutes, the price is converted at the path choice's value of time, and every link carries the
 * calibrated bias.
 */
const linkCache = new WeakMap<object, Map<string, MicroLink[]>>();
export function microLinks(b: Bundle, settings?: MicroSettings): MicroLink[] {
  const key = JSON.stringify({ ...SETTINGS0, ...(settings ?? {}) });
  const m = linkCache.get(b.header) ?? new Map<string, MicroLink[]>();
  linkCache.set(b.header, m);
  return m.get(key) ?? m.set(key, makeLinks(b, settings)).get(key)!;
}
function makeLinks(b: Bundle, settings?: MicroSettings): MicroLink[] {
  const x = microData(b, settings);
  const P = b.header.micro?.places;
  const acc = b.a.mmAcc as Uint16Array | undefined, egr = b.a.mmEgr as Uint16Array | undefined;
  if (!x || !P || !acc || !egr) return [];
  const NZ = x.NZ, out: MicroLink[] = [];
  const zps = b.a.zonePtStart as Int32Array;
  // (which of a station's bikes is cheaper is judged at the starting ride weight)
  const vot = PATH.votPerMin, ww = PATH.walkWeight, rw = MICRO.rideWeight;
  // per zone: its blocks' walks to the nearest station (one array, shared by the zone's links)
  const blocksOf = new Map<number, Float32Array>();
  const blocks = (z: number) => blocksOf.get(z) ?? blocksOf.set(z, x.ptDock.subarray(zps[z], zps[z + 1]).map((t) => (t <= MICRO.reachMin ? t : Infinity))).get(z)!;
  const cost = (l: Omit<MicroLink, 'kind' | 'z' | 's' | 'place' | 'vehicle' | 'km'>) => ww * l.walk + rw * l.ridePerceived + l.price / vot;
  const docksOn = x.settings.docks > 0, fleetOn = x.settings.fleet > 0;
  P.forEach((pl, p) => {
    if (!pl.stops.length) return;
    const placeZone = pl.zone;
    const stationDock = pl.dockSec >= 65535 || !docksOn ? Infinity : (pl.dockSec / 60) / Math.sqrt(x.settings.docks);
    for (let z = 0; z < NZ; z++) {
      for (const [arr, isAcc] of [[acc, true], [egr, false]] as const) {
        const i = (p * NZ + z) * 3;
        const m = arr[i] * 10;
        if (arr[i] === 65535 || m < MICRO.accessMinM || m > MICRO.accessMaxM) continue;
        const up = arr[i + 1] / 10, feel = arr[i + 2] / 100;
        const opt = (k: MicroType, walk: number, rack: boolean) => {
          const sec = rideSec(k, m, up), s = MICRO.speed[k];
          // a climb's effort beyond its time (MICRO.climbEquiv) as that much more riding, in time and distance
          const eq = MICRO.climbEquiv[k] * up;
          return { vehicle: k, km: (m + eq) / 1000, walk, ride: sec / 60, ridePerceived: (s.start + (sec - s.start) * feel + s.perM * eq) / 60, price: ridePrice(k, sec / 60, x.settings, rack) };
        };
        // from a station's bikes: classic (a station at the far end) or e-bike (a station, or a rack).
        // Access: the walk to the bike is each block's own (blocks); the rest is at the station.
        // Egress: from the platform to the bikes, the ride, and on from where the bike is left.
        if (docksOn && x.dockShare[z] > 0 && stationDock < Infinity) {
          const eEnd = ebikeEnd(isAcc ? stationDock : x.dockWalk[z]);
          const c = opt('classic', isAcc ? stationDock : stationDock + x.dockWalk[z], false);
          const e = opt('ebike', isAcc ? eEnd.walk : stationDock + eEnd.walk, eEnd.rack);
          const best = cost(c) <= cost(e) ? c : e;
          for (const s of pl.stops) out.push({ kind: isAcc ? MM_DOCK_ACCESS : MM_DOCK_EGRESS, z, s, place: p, ...best, ...(isAcc ? { blocks: blocks(z), zoneWalk: x.dockWalk[z] } : {}) });
        }
        // a vehicle on the street: a Bay Wheels e-bike (left at a rack, $2) or a scooter; access walks to
        // it from the zone (the same for every block), egress from around the station
        const near = isAcc ? z : placeZone;
        if (near < 0) continue;
        const street: [MicroType, number, boolean, number, number][] = [];
        if (docksOn) street.push(['ebike', x.freeWalk.ebike[near], true, MM_EBIKE_ACCESS, MM_EBIKE_EGRESS]);
        if (fleetOn) street.push(['scooter', x.freeWalk.scooter[near], false, MM_SCOOTER_ACCESS, MM_SCOOTER_EGRESS]);
        for (const [k, find, rack, ka, ke] of street) {
          if (!(find <= MICRO.reachMin)) continue;
          const o = opt(k, isAcc ? MICRO.parkMin : find + MICRO.parkMin, rack);
          const blk = isAcc ? new Float32Array(zps[z + 1] - zps[z]).fill(find) : undefined;
          for (const s of pl.stops) out.push({ kind: isAcc ? ka : ke, z, s, place: p, ...o, ...(blk ? { blocks: blk, zoneWalk: find } : {}) });
        }
      }
    }
  });
  return out;
}
