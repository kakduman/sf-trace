/**
 * The transit network for one period, as a graph for the optimal-strategy path search
 * (Spiess & Florian 1989; the method of Emme and Visum's headway-based assignment).
 *
 * Nodes: zones; for each stop an arrival node A (after alighting) and a boarding node B; and for
 * each line one node per stop it serves. Links:
 *   access   zone → B         walk (or, outside the city, drive/feeder) to a stop
 *   board    B → line node    with the line's frequency (less riders left behind by full vehicles):
 *                            the strategy picks a set of attractive lines
 *   ride     line k → k+1     in-vehicle time × mode factor × crowding
 *   alight   line → A         the fare of that ride and any calibrated mode bias
 *   change   A → B (same stop, or walk to another): transfer penalty (+ walking)
 *   egress   A → zone
 * Splitting A from B makes every path board at least once and counts transfers exactly.
 */
import { RUN_MODES } from './runmode';
import { muniFareOf } from './context';
import { CABLE_CAR_FARE, CLIPPER_NEXTGEN_SHARE, CLIPPER_TRANSFER_DISCOUNT, COEFFS, HEADWAY_FRACTION, IVT_FACTOR, LEGACY_MUNI_TRANSFER_DISCOUNT, MUNI_FARE, MUNI_PASS_SHARE, PATH, transferPenalty } from './params';
import type { Bundle, BLine, Calibration, DayType, Edit, FareRule, Scenario, TPeriod, TransitMode } from './types';
import { TPERIOD_HOURS } from './types';
import { MICRO, isMicroAccess, microLinks, microSettingsOf } from './micromobility';

/** fields per outside access record in the bundle (zone, stop, access s, parking ¢ per leg, activity-end s, kind) */
export const EXT_CONNECTOR_FIELDS = 6;
/** how an outside access record reaches its stop: on foot (the walk-access share), by local bus, or by car to the lot */
export const EXT_WALK = 0, EXT_BUS = 1, EXT_DRIVE = 2;
export const EXT_KIND = ['walk', 'bus', 'drive'] as const;
export const LINK_ACCESS = 0, LINK_EGRESS = 1, LINK_ALIGHT = 2, LINK_RIDE = 3, LINK_BOARD = 4, LINK_CHANGE = 5, LINK_WALK = 6;

/** component slots carried along a strategy */
export const C_TIME = 0, C_IVT = 1, C_IVTP = 2, C_WAIT = 3, C_WALK = 4, C_BOARDS = 5, C_FARE = 6, C_BIAS = 7;
/** unreliability: the reliability ratio × each ride's standard deviation of running time (perceived minutes) */
export const C_REL = 8;
/** money other than fares: shared bikes' and scooters' prices on the way to and from stations, which
 * no person type's fare discount applies to (micromobility.ts) */
export const C_COST = 9;
export const NC = 10;

export interface NetLine {
  /** index into bundle lines, or -1 for a scenario line */
  src: number;
  /** scenario line id (new lines) */
  newId?: string;
  route: string;
  feed: string;
  mode: TransitMode;
  stops: number[];
  /** seconds per hop this period */
  hops: number[];
  /** vehicles per minute this period (0: not running) */
  freq: number;
  trips: number;
  cap: number;
  seats: number;
  /** expected wait ÷ half the scheduled headway (reliability; 1 = even spacing) */
  waitFactor?: number;
  /** day-to-day SD of a ride's running time, minutes: a + b × minutes aboard (BLine.rideSD) */
  rideSD?: { a: number; b: number };
  /** mean minutes late per ride against the timetable (BLine.lateMin) */
  lateMin?: number;
  /** per stop position: riders may not board (1) or not get off (2) there (BLine.noBoard/noAlight) */
  rule?: Uint8Array;
  /** a line for some riders only (BLine.restrict): stops where anyone may board, and the zones that
   * riders boarding elsewhere must be bound for */
  restrict?: BLine['restrict'];
}

export interface TransitNet {
  period: TPeriod;
  nZones: number;
  nStops: number;
  nNodes: number;
  lines: NetLine[];
  /** first line node of each line */
  lineStart: Int32Array;
  // links
  nLinks: number;
  type: Uint8Array;
  tail: Int32Array;
  head: Int32Array;
  cost: Float32Array;
  freq: Float32Array;
  /** components each link adds (NC per link) */
  comp: Float32Array;
  /** line index for ride/board/alight links, else -1 */
  line: Int32Array;
  /** position along the line (hop index for rides, stop index for board/alight) */
  pos: Int32Array;
  // incoming links per node (by head)
  inStart: Int32Array;
  inLinks: Int32Array;
  // outgoing links: board links per B node, access links per zone
  outStart: Int32Array;
  outLinks: Int32Array;
  /** per link: the outside access record it comes from (index into the bundle's records), or −1 */
  extRec: Int32Array;
  /** extra stops added by scenario lines: x, y, name */
  /** scenario stops; feed: the operator whose fare is paid on entering it ('new:<mode>' for a new line's own) */
  newStops: { x: number; y: number; lat: number; lon: number; name: string; feed: string }[];
  /** block-level access (PATH.blockAccess): per link, the offset of its blocks' walks in accPtMin, or −1 */
  accPt?: Int32Array;
  /** walk minutes from each block of the link's zone to its stop (Infinity beyond reach) */
  accPtMin?: Float32Array;
  /** the city zones' blocks: first block of each zone, and each block's share of its zone */
  zonePtStart?: Int32Array;
  zonePtShare?: Float32Array;
  /** block-level egress (PATH.egressLogit): per link, the offset of its blocks' walks in accPtMin for a city zone's egress link, or −1 */
  egrPt?: Int32Array;
  /** minutes from the street to the platform at each stop (platformSec; 0 for scenario stops) */
  platMin: Float32Array;
  /** per link: a shared bike or scooter link to or from a station (micromobility.ts MM_*), or −1 */
  mmKind?: Int8Array;
  /** per shared-vehicle link of microLinks (in its order): the network link carrying its riders, and
   * their share of that link's volume (1, or its logit share of a walking egress link it was folded into) */
  mmLink?: Int32Array;
  mmShare?: Float32Array;
  /** per link: for a board link of a line for some riders only (NetLine.restrict), the index in
   * destSets of the destination zones it may be used for; −1 for every other link */
  boardFor?: Int32Array;
  destSets?: Uint8Array[];
  /** searches per destination with the transfer logit, when the run mode sets it (else PATH.transferPasses) */
  transferPasses?: number;
}

const FEED_FARE_DEFAULT: Record<string, FareRule> = {
  muni: { board: MUNI_FARE, perKm: 0 },
};

/** share of the night's (7pm–6am) trips that start midnight–5am: NHTS 2017, SF–Oakland metro, weekdays */
export const OWL_SHARE = 0.075;

export function periodService(l: BLine, p: TPeriod, day: DayType = 'wkd'): { trips: number; hops: number[]; freqTrips?: number } | null {
  const periods = (day === 'wkd' ? l.periods : l.days?.[day] ?? {}) as Record<string, { trips: number; hops: number[] } | undefined>;
  if (p !== 'NT') {
    const s = periods[p];
    return s && s.trips > 0 ? s : null;
  }
  // the night combines the evening and the early morning
  const ev = periods.EV;
  const ea = periods.EA;
  const parts = [ev, ea].filter((x): x is { trips: number; hops: number[] } => !!x && x.trips > 0);
  if (!parts.length) return null;
  const trips = parts.reduce((s, x) => s + x.trips, 0);
  const hops = parts[0].hops.map((_, i) => Math.round(parts.reduce((s, x) => s + x.hops[i] * x.trips, 0) / trips));
  // the night's riders: 92.5% travel 7pm–midnight and 7.5% midnight–5am (NHTS 2017, SF–Oakland
  // metro, weekdays); the frequency they see blends the evening's and the owl hours' service, so an
  // owl-only route serves the late share and not the evening. The night's trips still count for
  // capacity and cost.
  const ev5 = l.evening?.[day], owl5 = l.owl?.[day];
  if (ev5 === undefined) return { trips, hops, freqTrips: trips };
  const perHour = (1 - OWL_SHARE) * (ev5 / 5) + OWL_SHARE * ((owl5 ?? 0) / 5);
  return { trips, hops, freqTrips: perHour * TPERIOD_HOURS.NT };
}

/**
 * Time a vehicle loses at each stop it serves: dwell plus slowing and pulling out (assumed: buses
 * 25 s, rail 45 s; TCRP Report 165 reports lost time per stop of roughly 20–40 s for buses).
 * Removing a stop saves it; adding one costs it.
 */
export const STOP_LOST_SEC = 25;
export const RAIL_STOP_LOST_SEC = 45;

/**
 * Effective frequency: headways beyond PATH.timedHeadway count half (riders time their arrival).
 * Only a rider starting out can time their arrival at the stop; one changing from another line
 * arrives when that line gets there (`transfer`: the full headway counts), as TM1 weighs initial and
 * transfer waits apart and UK TAG M3.2 (§3.2.5) advises wait curves for the first boarding only.
 */
export function effectiveFreq(freq: number, waitFactor = 1, transfer = false): number {
  if (freq <= 0) return 0;
  const h = 1 / freq;
  // riders arriving at random wait (h/2)·(1 + CV²) on an unevenly spaced line (waitFactor); beyond
  // the timed-arrival headway, they plan their arrival and the extra headway counts half
  const he = transfer || h <= PATH.timedHeadway ? h * waitFactor : PATH.timedHeadway * waitFactor + 0.5 * (h - PATH.timedHeadway);
  return 1 / he;
}

/**
 * Capacity at boarding: the frequency of a board link once riders left behind by full vehicles are
 * counted. `avail` (0–1] is what model.ts boardingAvailability works out from the last assignment:
 * riders wait (1/avail − 1) more headways on average than they would with room on every vehicle, as a
 * rider who fails to board waits a whole headway for the next (Cepeda, Cominetti & Florian 2006 lower
 * the frequency itself; with regular headways the extra wait is the same to first order). It applies
 * on top of whatever effective frequency the link already has (reliability, timed arrivals, scheduled
 * services), so it composes with them: the link's wait is ½/f + headway · (1/avail − 1).
 */
export function capacityFreq(f: number, headwayMin: number, avail: number): number {
  if (!(avail < 1) || f <= 0) return f;
  return 0.5 / (0.5 / f + headwayMin * (1 / Math.max(1e-3, avail) - 1));
}

/**
 * `crowd[li]` for line li with n stops (its line state): n − 1 multipliers on each hop's in-vehicle
 * time (crowding), optionally followed by n boarding availabilities, one per stop (capacity at
 * boarding; 1 = room for everyone), and then the n stops' boardings and riders through, which only
 * warm starts use. All come from the previous assignment (model.ts runModel) and are carried in one
 * array so that warm starts, workers, and saved runs pass them together.
 */
export const boardAvail = (c: Float32Array | undefined, n: number, k: number): number => (c && c.length >= 2 * n - 1 ? c[n - 1 + k] : 1);

/** The stop where board link a boards its line. */
export const boardStop = (net: TransitNet, a: number) => net.lines[net.line[a]].stops[net.pos[a]];

/** The scenario's lines for one period (existing lines with edits applied, then new lines). */
/**
 * Seconds from the street to the platform at a station, by its depth (assumed from station layouts):
 * riders pay it getting on and off, and on both sides of a walking transfer.
 */
export function platformSec(st: { feed: string; name: string; lat: number; lon: number }): number {
  if (st.feed === 'bart') {
    // the city's underground stations (Daly City, at 37.706, and Balboa Park are at the surface)
    const sf = st.lat > 37.71 && st.lat < 37.81 && st.lon > -122.47;
    if (!sf) return 30;
    if (/Embarcadero|Montgomery|Powell|Civic Center/.test(st.name)) return 75;
    if (/Balboa/.test(st.name)) return 30;
    return 60;
  }
  if (st.feed === 'muni') {
    if (/^Chinatown - Rose Pak/.test(st.name)) return 120;
    if (/^Union Square\/Market St Station/.test(st.name)) return 90;
    if (/^Metro Forest Hill|^Forest Hill Station|^Yerba Buena\/Moscone Station/.test(st.name)) return 60;
    if (/^Metro (Embarcadero|Montgomery|Powell|Civic Center|Van Ness|Church|Castro)|^Van Ness Station/.test(st.name)) return 45;
  }
  return 0;
}

const BUS_MODES = new Set(['bus', 'rapid', 'trolley', 'express']);
const MUNI_MODES = new Set(['bus', 'rapid', 'express', 'trolley', 'lightrail', 'streetcar', 'cablecar']);

export function scenarioLines(bundle: Bundle, scenario: Scenario, p: TPeriod): { lines: NetLine[]; newStops: TransitNet['newStops'] } {
  const H = bundle.header;
  // a new line is as reliable as the median existing line of its mode this period
  const typicalWait = (mode: TransitMode) => {
    const v = H.lines.filter((l) => l.mode === mode && l.waitFactor?.[p]).map((l) => l.waitFactor![p]!).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : 1;
  };
  // and runs as reliably, and as fully, as its mode's median line
  const typicalSD = (mode: TransitMode) => {
    const v = H.lines.filter((l) => l.mode === mode && l.rideSD?.[p]).map((l) => l.rideSD![p]!).sort((a, b) => a.a + 10 * a.b - (b.a + 10 * b.b));
    return v.length ? v[v.length >> 1] : undefined;
  };
  const typicalDelivered = (mode: TransitMode) => {
    const v = H.lines.filter((l) => l.mode === mode && l.delivered?.[p]).map((l) => l.delivered![p]!).sort((a, b) => a - b);
    return v.length && PATH.observedOps ? v[v.length >> 1] : 1;
  };
  const typicalLate = (mode: TransitMode) => H.lines.find((l) => l.mode === mode && l.lateMin !== undefined)?.lateMin;
  const edits = scenario.edits;
  const match = (l: BLine, e: { route: string; feed: string }) => l.route === e.route && l.feed === e.feed;
  // new stops (on new lines and added to routes) are numbered once, in edit order, so every
  // period agrees on them whether or not anything serves them then
  const newStops: TransitNet['newStops'] = [];
  const newStopOf = new Map<string, number>();
  const addNewStop = (key: string, lat: number, lon: number, name: string, feed: string) => {
    const [x, y] = toXYlocal(lat, lon);
    // a new stop at the same place as one already added (within 5 m) is the same stop, so lines
    // extended or drawn through it share it and riders can change there
    const same = newStops.findIndex((n) => Math.hypot(n.x - x, n.y - y) < 5);
    const i = same >= 0 ? H.stops.length + same : (newStops.push({ x, y, lat, lon, name, feed }), H.stops.length + newStops.length - 1);
    newStopOf.set(key, i);
    return i;
  };
  const newLineStops = new Map<string, number[]>();
  for (const e of edits) {
    // a new line's stops are Muni's if it is a Muni mode; an added stop or extension is its route's operator's
    const lineFeed = e.kind === 'newLine' ? (MUNI_MODES.has(e.mode) ? 'muni' : `new:${e.mode}`) : '';
    if (e.kind === 'newLine') newLineStops.set(e.id, e.stops.map((s, k) => ('stop' in s ? s.stop : addNewStop(`${e.id}:${k}`, s.lat, s.lon, s.name ?? 'New stop', lineFeed))));
    if (e.kind === 'addStop') addNewStop(`add:${e.id}`, e.lat, e.lon, e.name ?? 'New stop', e.feed);
    if (e.kind === 'extend') newLineStops.set(`ext:${e.id}`, e.stops.map((s, k) => ('stop' in s ? s.stop : addNewStop(`ext:${e.id}:${k}`, s.lat, s.lon, s.name ?? 'New stop', e.feed))));
  }
  const xy = (s: number) => (s < H.stops.length ? H.stops[s] : newStops[s - H.stops.length]);
  const lines: NetLine[] = [];
  H.lines.forEach((l, i) => {
    if (edits.some((e) => e.kind === 'remove' && match(l, e))) return;
    const s = periodService(l, p, scenario.day ?? 'wkd');
    if (!s) return;
    let trips = s.trips;
    // the trips that set the frequency riders see (the evening's, at night), scaled with the service
    const freqShare = s.freqTrips !== undefined && s.trips > 0 ? s.freqTrips / s.trips : 1;
    // operations as run (PATH.observedOps): running times as observed against the timetable, and
    // only the share of scheduled trips that actually run sets the frequency (capacity too)
    const rf = PATH.observedOps ? (l.runFactor?.[p] ?? 1) : 1;
    trips *= PATH.observedOps ? (l.delivered?.[p] ?? 1) : 1;
    let hops = rf === 1 ? s.hops.slice() : s.hops.map((h) => h * rf);
    // traffic feedback: buses in traffic gain or lose the change in congestion on their streets
    const bd = scenario.busDelay?.[p]?.[i];
    if (bd) hops = hops.map((h, k) => Math.max(10, h + (bd[k] ?? 0)));
    let stops = l.stops.slice();
    // where boarding or getting off is not allowed, kept in step with the stops through the edits
    let rule: number[] | undefined;
    if (l.noBoard || l.noAlight) {
      rule = new Array(stops.length).fill(0);
      for (const k of l.noBoard ?? []) rule[k] |= 1;
      for (const k of l.noAlight ?? []) rule[k] |= 2;
    }
    const lost = l.mode === 'bart' || l.mode === 'caltrain' || l.mode === 'ferry' || l.mode === 'lightrail' ? RAIL_STOP_LOST_SEC : STOP_LOST_SEC;
    for (const e of edits) {
      if (e.kind === 'frequency' && match(l, e)) trips *= e.factor[p] ?? 1;
      if (e.kind === 'speed' && match(l, e)) hops = hops.map((h) => Math.max(10, h * e.factor));
      if (e.kind === 'removeStop' && match(l, e)) {
        const k = stops.indexOf(e.stop);
        if (k > 0 && k < stops.length - 1) {
          const t = hops[k - 1] + hops[k];
          hops.splice(k - 1, 2, Math.max(0.6 * t, t - lost));
          stops.splice(k, 1);
          rule?.splice(k, 1);
        }
      }
      if (e.kind === 'extend' && match(l, e)) {
        const ext = newLineStops.get(`ext:${e.id}`)!;
        if (stops[stops.length - 1] === e.from) {
          stops = stops.concat(ext);
          hops = hops.concat(e.hops);
          rule = rule?.concat(ext.map(() => 0));
        } else if (stops[0] === e.from) {
          stops = [...ext].reverse().concat(stops);
          hops = [...e.hops].reverse().concat(hops);
          rule = rule && ext.map(() => 0).concat(rule);
        }
      }
      if (e.kind === 'addStop' && match(l, e)) {
        const ns = newStopOf.get(`add:${e.id}`)!;
        for (let k = 0; k + 1 < stops.length; k++) {
          const a = stops[k], b = stops[k + 1];
          if (!((a === e.between[0] && b === e.between[1]) || (a === e.between[1] && b === e.between[0]))) continue;
          const da = Math.hypot(xy(ns).x - xy(a).x, xy(ns).y - xy(a).y), db = Math.hypot(xy(b).x - xy(ns).x, xy(b).y - xy(ns).y);
          const f = da + db > 0 ? da / (da + db) : 0.5;
          const t = hops[k];
          hops.splice(k, 1, Math.max(10, t * f + lost / 2), Math.max(10, t * (1 - f) + lost / 2));
          stops.splice(k + 1, 0, ns);
          rule?.splice(k + 1, 0, 0);
          break;
        }
      }
    }
    if (trips <= 0.01) return;
    lines.push({ src: i, route: l.route, feed: l.feed, mode: l.mode, stops, hops, freq: (trips * freqShare) / (TPERIOD_HOURS[p] * 60), trips, cap: l.cap, seats: l.seats, waitFactor: l.waitFactor?.[p], rideSD: l.rideSD?.[p], lateMin: PATH.observedOps ? l.lateMin : undefined, ...(rule ? { rule: Uint8Array.from(rule) } : {}), ...(l.restrict ? { restrict: l.restrict } : {}) });
  });
  for (const e of edits) {
    if (e.kind !== 'newLine') continue;
    const idx = newLineStops.get(e.id)!;
    const h0 = e.headway[p];
    if (!h0 || h0 <= 0) continue;
    // as many of its trips run as its mode's median line's
    const h = h0 / typicalDelivered(e.mode);
    const trips = (TPERIOD_HOURS[p] * 60) / h;
    const late = PATH.observedOps ? typicalLate(e.mode) : undefined;
    const cap = { ...(NEW_LINE_CAP[e.mode] ?? { cap: 94, seats: 56 }), waitFactor: typicalWait(e.mode), rideSD: typicalSD(e.mode), lateMin: late };
    lines.push({ src: -1, newId: e.id, route: e.name, feed: 'new', mode: e.mode, stops: idx, hops: e.hops, freq: 1 / h, trips, ...cap });
    if (e.bothDirections)
      lines.push({ src: -1, newId: `${e.id}:r`, route: e.name, feed: 'new', mode: e.mode, stops: [...idx].reverse(), hops: [...e.hops].reverse(), freq: 1 / h, trips, ...cap });
  }
  return { lines, newStops };
}

/**
 * Fares on new lines beyond Muni's (which is paid on reaching any new stop): a regional-style line
 * charges like the operator it resembles (BART per-segment average, Caltrain and ferry fits).
 */
export const NEW_LINE_FARE: Partial<Record<TransitMode, { board: number; perKm: number }>> = {
  bart: { board: 2.0, perKm: 0.15 },
  caltrain: { board: 3.0, perKm: 0.116 },
  ferry: { board: 3.5, perKm: 0.25 },
};

export const NEW_LINE_CAP: Partial<Record<TransitMode, { cap: number; seats: number }>> = {
  bus: { cap: 63, seats: 39 },
  rapid: { cap: 94, seats: 56 },
  trolley: { cap: 94, seats: 56 },
  express: { cap: 63, seats: 39 },
  lightrail: { cap: 238, seats: 120 },
  streetcar: { cap: 69, seats: 32 },
  bart: { cap: 1110, seats: 550 },
  caltrain: { cap: 1502, seats: 681 },
  ferry: { cap: 350, seats: 350 },
};

// local projection (duplicated from geo.ts to keep this module dependency-light)
import { toXY } from './geo';
const toXYlocal = toXY;

/**
 * Build one period's graph. `crowd` (optional) gives, per line in `lines` order, a multiplier on
 * each hop's in-vehicle time from the previous assignment; `lotPrice` (optional), per stop, the
 * perceived minutes a full park-and-ride lot adds to driving there (model.ts lotPrices).
 * `crowd[li]` may also carry each stop's boarding availability after the hops (boardAvail).
 */
/**
 * Zones of the transit network: the city's, then each outside zone twice, as a home end (where a car
 * may wait at a station: in-commuters, regional visitors) and as an activity end (out-commuters'
 * workplaces, residents' trips into the region: reached on foot or by local bus, with no car).
 */
export const transitZones = (H: { zones: unknown[]; ext: unknown[] }) => H.zones.length + 2 * H.ext.length;
/** the activity end of outside zone e (0-based among the outside zones) */
export const activityEnd = (H: { zones: unknown[]; ext: unknown[] }, e: number) => H.zones.length + H.ext.length + e;

export function buildNet(bundle: Bundle, scenario: Scenario, p: TPeriod, calib: Calibration | null, crowd?: Float32Array[], lotPrice?: Float32Array): TransitNet {
  const H = bundle.header;
  const a = bundle.a;
  const NZ = H.zones.length, NX = H.ext.length, Z = transitZones(H);
  const { lines, newStops } = scenarioLines(bundle, scenario, p);
  const S = H.stops.length + newStops.length;
  const A0 = Z, B0 = Z + S, L0 = Z + 2 * S;
  const lineStart = new Int32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) lineStart[i + 1] = lineStart[i] + lines[i].stops.length;
  // Riders changing lines board from their own node at a stop (X): they cannot time their arrival
  // for a long headway (effectiveFreq), so a stop served by any line with one gets a second boarding
  // node that the transfer links lead to; elsewhere X is the stop's boarding node B.
  const longHeadway = new Uint8Array(S);
  for (const l of lines) if (!HEADWAY_FRACTION[l.mode] && l.freq > 0 && 1 / l.freq > PATH.timedHeadway) for (const st of l.stops) longHeadway[st] = 1;
  const X = new Int32Array(S);
  let nNodes = L0 + lineStart[lines.length];
  for (let s = 0; s < S; s++) X[s] = longHeadway[s] ? nNodes++ : B0 + s;

  const fareOf = (feed: string): FareRule => H.fares[feed] ?? FEED_FARE_DEFAULT[feed] ?? { board: 0, perKm: 0 };
  // fare edits, and Muni's fare among the conditions (context.ts)
  const fareFactor = (feed: string) => scenario.edits.reduce((f, e) => (e.kind === 'fare' && e.feed === feed ? f * e.factor : f), feed === 'muni' ? muniFareOf(scenario.context) : 1);
  const stopXY = (s: number) => (s < H.stops.length ? H.stops[s] : newStops[s - H.stops.length]);

  // collect links in plain arrays first
  const T: number[] = [], TL: number[] = [], HD: number[] = [], CO: number[] = [], FQ: number[] = [], LN: number[] = [], PS: number[] = [];
  const CP: number[] = [];
  const add = (type: number, tail: number, head: number, cost: number, freq: number, line: number, pos: number, comp: number[] | null) => {
    T.push(type), TL.push(tail), HD.push(head), CO.push(cost), FQ.push(freq), LN.push(line), PS.push(pos);
    for (let k = 0; k < NC; k++) CP.push(comp ? comp[k] ?? 0 : 0);
  };
  const walkW = PATH.walkWeight;
  // a change of lines: the weight mode choice gives it (params.ts transferPenalty)
  const xferPen = transferPenalty(calib);
  const comp = (o: Partial<Record<number, number>>) => {
    const c = new Array(NC).fill(0);
    for (const [k, v] of Object.entries(o)) c[Number(k)] = v!;
    return c;
  };

  // Muni, BART, and Caltrain charge their boarding fare once per trip on that operator, on the way
  // in: from home, or by walking over from another operator, when Clipper takes up to $2.85 off it
  // (from December 2025). Changing lines within one of them pays nothing more; BART's and
  // Caltrain's distance charges are on the rides. Other operators charge each ride (below).
  // Scenario stops belong to Muni.
  // the expected fare of a ride: pass holders pay nothing more (MUNI_PASS_SHARE)
  const muniFare = MUNI_FARE * fareFactor('muni') * (1 - MUNI_PASS_SHARE);
  const feedOf = (s: number) => (s >= H.stops.length ? newStops[s - H.stops.length].feed : H.stops[s].feed);
  const ENTRY_FEEDS = new Set(['muni', 'bart', 'caltrain']);
  const fareAt = (s: number) => {
    const f = feedOf(s);
    if (f === 'muni') return muniFare;
    if (f === 'bart' || f === 'caltrain') return fareOf(f).board * fareFactor(f);
    return 0;
  };
  // the free shuttles and the Treasure Island Ferry take no Clipper fare, so there is no discount
  // after them: the next operator's full fare
  const NO_CLIPPER = new Set(['tma', 'shuttle']);
  // Clipper's discounts (conditions, context.ts). Riders on the next-generation system (a share of
  // them, CLIPPER_NEXTGEN_SHARE) get up to $2.85 off each later operator; the rest keep the old
  // system's: $0.50 off Muni's fare from any operator, and Muni free from Daly City BART. A Muni
  // pass holder pays nothing on Muni either way, so a discount onto Muni comes off the fare of those
  // who pay per ride, not off the expected fare. (The 2024 backcast: the old system only, its $0.50
  // in today's dollars.)
  const ctx = scenario.context;
  const oldOnly = !!ctx?.transferDiscountMuniOnly;
  const newDiscount = oldOnly ? 0 : ctx?.transferDiscount ?? CLIPPER_TRANSFER_DISCOUNT;
  const newShare = oldOnly ? 0 : ctx?.transferDiscountShare ?? CLIPPER_NEXTGEN_SHARE;
  const oldDiscount = oldOnly ? ctx?.transferDiscount ?? LEGACY_MUNI_TRANSFER_DISCOUNT : LEGACY_MUNI_TRANSFER_DISCOUNT;
  const muniPaying = (d: number) => (1 - MUNI_PASS_SHARE) * Math.max(0, MUNI_FARE * fareFactor('muni') - d);
  const dalyCity = H.observed?.bartStations?.find((b) => b.code === 'DALY')?.stop ?? -1;
  const transferFare = (from: number, to: number) => {
    const ft = feedOf(to);
    if (!ENTRY_FEEDS.has(ft) || feedOf(from) === ft) return 0;
    if (NO_CLIPPER.has(feedOf(from))) return fareAt(to);
    const muni = ft === 'muni';
    const after = muni ? muniPaying(newDiscount) : Math.max(0, fareAt(to) - newDiscount);
    const before = muni ? (from === dalyCity ? 0 : muniPaying(oldDiscount)) : fareAt(to);
    return newShare * after + (1 - newShare) * before;
  };
  // a change between operators: its own perceived cost (PATH.operatorChange) beyond a change of lines
  // (a scenario's new lines count as Muni's)
  const opOf = (s: number) => (feedOf(s).startsWith('new') ? 'muni' : feedOf(s));
  const opChange = (from: number, to: number) => (opOf(from) !== opOf(to) ? PATH.operatorChange : 0);
  const accessComp = (t: number, s: number) => comp({ [C_TIME]: t, [C_WALK]: t, [C_FARE]: fareAt(s) });
  // access / egress, from the bundle (zone, stop, seconds)
  const conn = a.connectors as Int32Array;
  // between the platforms of one station (skims.ts writes these changes as 0 s of walking), only
  // their depths count
  const platIn = Float32Array.from(H.stops, (st) => platformSec(st) / 60);
  // from the street, the downtown BART stations' times as fitted to BART's counts (calib.stationSec)
  const plat = platIn.slice();
  for (const st of H.observed?.bartStations ?? []) if (st.stop !== null && calib?.stationSec?.[st.code]) plat[st.stop] = Math.max(0, plat[st.stop] + calib.stationSec[st.code] / 60);
  // Walking to a stop, block by block (PATH.blockAccess): each access link from a city zone carries
  // the walk from each of the zone's blocks (minutes; Infinity beyond reach), so the zone's riders
  // choose their stop from where they live (StrategySolver.solve) instead of from the zone's average.
  // The link's own cost is then only what does not depend on the block: the platform and the fare.
  const zps = a.zonePtStart as Int32Array, zpx = a.zonePtX as Float32Array, zpy = a.zonePtY as Float32Array, zpw = a.zonePtW as Float32Array;
  const blockAcc = PATH.blockAccess && !!zps;
  const PO: number[] = [];
  const PTm: number[] = [];
  const connPt = a.connectorPts as Uint16Array | undefined;
  // fallback for a bundle without per-block walks: straight-line walks (× 1.3 at 1.34 m/s) rescaled
  // so the reachable blocks' mean matches the connector's network walk
  const railStop = new Uint8Array(H.stops.length);
  if (blockAcc && !connPt) for (const l of H.lines) if (!['bus', 'rapid', 'trolley', 'express'].includes(l.mode)) for (const s of l.stops) railStop[s] = 1;
  let cpOff = 0;
  for (let i = 0; i < conn.length; i += 3) {
    const z = conn[i], s = conn[i + 1], t = conn[i + 2] / 60 + plat[s];
    if (blockAcc) {
      const n = zps[z + 1] - zps[z];
      const tp: number[] = new Array(n);
      if (connPt) {
        for (let q = 0; q < n; q++) tp[q] = connPt[cpOff + q] === 65535 ? Infinity : connPt[cpOff + q] / 60;
        cpOff += n;
      } else {
        const st = H.stops[s];
        const max = (railStop[s] || st.station || !['muni', 'ggt', 'ac', 'samtrans', 'tma', 'shuttle'].includes(st.feed) ? 1500 : 720) / 60;
        let W = 0, R = 0, sum = 0;
        for (let q = 0; q < n; q++) {
          const g = (Math.hypot(zpx[zps[z] + q] - st.x, zpy[zps[z] + q] - st.y) * 1.3) / 1.34 / 60;
          W += zpw[zps[z] + q];
          tp[q] = g <= max ? g : Infinity;
          if (g <= max) (R += zpw[zps[z] + q]), (sum += zpw[zps[z] + q] * g);
        }
        // the connector's time is the network mean of the reachable blocks plus −ln(share)/(θ·walk weight)
        const share = R > 0 ? Math.max(1e-3, R / W) : 1e-3;
        const meanNet = conn[i + 2] / 60 + Math.log(share) / (PATH.accessTheta * walkW);
        const k = R > 0 && sum > 0 ? Math.min(2, Math.max(0.5, meanNet / (sum / R))) : 1;
        if (R === 0) for (let q = 0; q < n; q++) tp[q] = conn[i + 2] / 60;
        else for (let q = 0; q < n; q++) tp[q] *= k;
      }
      PO[T.length] = PTm.length;
      // the egress link back from the stop carries the same blocks' walks (StrategySolver.egressBranch)
      PO[T.length + 1] = PTm.length;
      for (const x of tp) PTm.push(x);
      add(LINK_ACCESS, z, B0 + s, walkW * plat[s] + fareAt(s) / PATH.votPerMin, 0, -1, 0, accessComp(plat[s], s));
    } else add(LINK_ACCESS, z, B0 + s, walkW * t + fareAt(s) / PATH.votPerMin, 0, -1, 0, accessComp(t, s));
    // its cost is the zone's: the mean walk of the blocks within reach plus −ln(share)/(θ·walk weight),
    // used as is when a zone's blocks are not modelled or egress is not a logit
    add(LINK_EGRESS, A0 + s, z, walkW * t, 0, -1, 0, comp({ [C_TIME]: t, [C_WALK]: t }));
  }
  // outside the city: (zone, stop, access seconds, parking cents per leg, activity-end seconds, kind).
  // The home end (in-commuters, regional visitors) has each record: on foot, by bus, and by car to
  // a lot, where the car waits all day, paying half the daily fee on each leg plus the lot's shadow
  // price when it fills (lotPrice). The activity end (transitZones: residents' trips out, their
  // workplaces) has no car there: on foot or by bus only.
  const xconn = a.extConnectors as Int32Array;
  const XS = EXT_CONNECTOR_FIELDS;
  if (xconn.length % XS !== 0) throw new Error(`model bundle: outside access links are not ${XS}-field records; rebuild it`);
  const REC: number[] = [];
  const addRec = (r: number, ...args: Parameters<typeof add>) => {
    add(...args);
    REC[T.length - 1] = r;
  };
  for (let i = 0; i < xconn.length; i += XS) {
    const r = i / XS;
    const z = NZ + xconn[i], s = xconn[i + 1], t = xconn[i + 2] / 60 + plat[s], park = xconn[i + 3] / 100, te = xconn[i + 4] / 60, kind = xconn[i + 5];
    // the lot's shadow price, and the calibrated preference among the ways in (extAccessBias)
    const kb = calib?.extAccessBias?.[EXT_KIND[kind]] ?? 0;
    // Caltrain's constants by end (calib.caltrainEnd at an outside zone's home end, where in-commuters
    // and visitors from outside start; calib.caltrainAct at its activity end, where residents commuting
    // out work), in perceived minutes of either sign: TM1 gives commuter rail a constant of its own, and
    // the two ends let in-commuters and reverse commuters differ (fit to the morning's arrivals in the
    // city and departures from it). A link keeps at least half its cost without them, so no link is
    // negative (a bonus that large would be far outside the fitted range)
    const caltrain = H.stops[s]?.feed === 'caltrain';
    const ce = caltrain ? calib?.caltrainEnd ?? 0 : 0, ca = caltrain ? calib?.caltrainAct ?? 0 : 0;
    const withEnd = (cost: number, k: number) => Math.max(cost / 2, cost + k);
    const shadow = (kind === EXT_DRIVE ? lotPrice?.[s] ?? 0 : 0) + kb;
    const ac = accessComp(t, s);
    ac[C_FARE] += park;
    ac[C_BIAS] += shadow + ce;
    addRec(r, LINK_ACCESS, z, B0 + s, withEnd(walkW * t + (fareAt(s) + park) / PATH.votPerMin + shadow, ce), 0, -1, 0, ac);
    addRec(r, LINK_EGRESS, A0 + s, z, withEnd(walkW * t + park / PATH.votPerMin + shadow, ce), 0, -1, 0, comp({ [C_TIME]: t, [C_WALK]: t, [C_FARE]: park, [C_BIAS]: shadow + ce }));
    if (kind === EXT_DRIVE) continue;
    const za = NZ + NX + xconn[i], ta = te + plat[s];
    const aca = accessComp(ta, s);
    aca[C_BIAS] += kb + ca;
    addRec(r, LINK_ACCESS, za, B0 + s, withEnd(walkW * ta + fareAt(s) / PATH.votPerMin + kb, ca), 0, -1, 0, aca);
    addRec(r, LINK_EGRESS, A0 + s, za, withEnd(walkW * ta + kb, ca), 0, -1, 0, comp({ [C_TIME]: ta, [C_WALK]: ta, [C_BIAS]: kb + ca }));
  }
  // shared bikes and scooters to and from the city's rail and ferry stations (micromobility.ts
  // microLinks): access links walk from each block to the vehicle (its block walks, as walking to a stop
  // does) and carry the ride, the walk at the station, the price, and the calibrated bias. Riders split
  // over access links by the access logit (StrategySolver.blockOrigin), but leave a stop for a zone by
  // its single cheapest egress link, so where a stop has a walking egress link to the zone, the shared
  // vehicles are folded into it by the same logit: its cost becomes the log-sum of walking and riding,
  // its components their mix, and each vehicle's riders are its share of the link's volume (mmLink,
  // mmShare). Egress to a zone beyond walking from the stop is a link of its own.
  const MK: number[] = [];
  const mmLink: number[] = [], mmShare: number[] = [];
  {
    const mmBias = calib?.micro?.accessBias ?? 0, mmEgrBias = calib?.micro?.egressBias ?? mmBias;
    // the term per km ridden (utils) in in-vehicle minutes, at TM1's trip coefficient for non-work trips
    const mmKm = (calib?.micro?.kmCoef ?? 0) / COEFFS.other.ivt;
    const blockOff = new Map<Float32Array, number>();
    // the walking egress link from each stop to each city zone
    const walkEgr = new Map<number, number>();
    for (let i = 0; i < T.length; i++) if (T[i] === LINK_EGRESS && HD[i] < NZ) walkEgr.set((TL[i] - A0) * NZ + HD[i], i);
    const folds = new Map<number, { j: number; cost: number; comp: number[] }[]>();
    microLinks(bundle, microSettingsOf(scenario)).forEach((l, j) => {
      const s = l.s;
      const ride = MICRO.rideWeight * l.ridePerceived + mmKm * l.km + (isMicroAccess(l.kind) ? mmBias : mmEgrBias);
      if (isMicroAccess(l.kind)) {
        const fare = fareAt(s);
        const w = plat[s] + l.walk + (blockAcc ? 0 : l.zoneWalk ?? 0);
        if (blockAcc) {
          let off = blockOff.get(l.blocks!);
          if (off === undefined) {
            off = PTm.length;
            for (const t of l.blocks!) PTm.push(t);
            blockOff.set(l.blocks!, off);
          }
          PO[T.length] = off;
        }
        MK[T.length] = l.kind;
        (mmLink[j] = T.length), (mmShare[j] = 1);
        add(LINK_ACCESS, l.z, B0 + s, walkW * w + ride + (fare + l.price) / PATH.votPerMin, 0, -1, 0, comp({ [C_TIME]: w + l.ride, [C_WALK]: w, [C_FARE]: fare, [C_COST]: l.price, [C_BIAS]: ride }));
      } else {
        const w = plat[s] + l.walk;
        const cost = walkW * w + ride + l.price / PATH.votPerMin;
        const cp = comp({ [C_TIME]: w + l.ride, [C_WALK]: w, [C_COST]: l.price, [C_BIAS]: ride });
        const we = walkEgr.get(s * NZ + l.z);
        if (we !== undefined) {
          (folds.get(we) ?? folds.set(we, []).get(we)!).push({ j, cost, comp: cp });
          return;
        }
        MK[T.length] = l.kind;
        (mmLink[j] = T.length), (mmShare[j] = 1);
        add(LINK_EGRESS, A0 + s, l.z, cost, 0, -1, 0, cp);
      }
    });
    const th = PATH.accessTheta;
    for (const [i, opts] of folds) {
      const cw = CO[i];
      const m = Math.min(cw, ...opts.map((o) => o.cost));
      const e = opts.map((o) => Math.exp(-th * (o.cost - m)));
      const ew = Math.exp(-th * (cw - m));
      const S = ew + e.reduce((a, v) => a + v, 0);
      CO[i] = m - Math.log(S) / th;
      const mix = new Array(NC).fill(0);
      for (let c = 0; c < NC; c++) mix[c] = (ew / S) * CP[i * NC + c];
      opts.forEach((o, k) => {
        (mmLink[o.j] = i), (mmShare[o.j] = e[k] / S);
        for (let c = 0; c < NC; c++) mix[c] += (e[k] / S) * o.comp[c];
      });
      for (let c = 0; c < NC; c++) CP[i * NC + c] = mix[c];
    }
  }
  // scenario stops: walk from the zones' blocks (straight-line distance × 1.3 at 1.34 m/s), with the
  // same walk-access share as the bundle's stops (skims.ts): the mean walk of the blocks within reach
  // (12 minutes to a bus stop, 25 to a station) plus −ln(share within reach)/θ
  if (newStops.length) {
    const zx = a.zonePtX as Float32Array, zy = a.zonePtY as Float32Array, zw = a.zonePtW as Float32Array, zs = a.zonePtStart as Int32Array;
    const station = (ns: (typeof newStops)[number]) => ns.feed === 'bart' || ns.feed === 'caltrain' || ns.feed.startsWith('new:') && !/bus|rapid|express|trolley/.test(ns.feed);
    newStops.forEach((ns, k) => {
      const s = H.stops.length + k;
      const max = station(ns) ? 1500 : 720;
      for (let z = 0; z < NZ; z++) {
        if (Math.hypot(H.zones[z].x - ns.x, H.zones[z].y - ns.y) > max * 1.34 + 600) continue;
        let accT = 0, W = 0, reach = 0;
        for (let q = zs[z]; q < zs[z + 1]; q++) {
          const t = (Math.hypot(zx[q] - ns.x, zy[q] - ns.y) * 1.3) / 1.34;
          W += zw[q];
          if (t <= max) (reach += zw[q]), (accT += zw[q] * t);
        }
        if (W <= 0 || reach / W < 0.15) continue;
        const t = (accT / reach + (-Math.log(reach / W) / (PATH.accessTheta * walkW)) * 60) / 60;
        if (blockAcc) {
          PO[T.length] = PTm.length;
          PO[T.length + 1] = PTm.length;
          for (let q = zs[z]; q < zs[z + 1]; q++) {
            const tq = (Math.hypot(zx[q] - ns.x, zy[q] - ns.y) * 1.3) / 1.34;
            PTm.push(tq <= max ? tq / 60 : Infinity);
          }
          add(LINK_ACCESS, z, B0 + s, fareAt(s) / PATH.votPerMin, 0, -1, 0, accessComp(0, s));
        } else add(LINK_ACCESS, z, B0 + s, walkW * t + fareAt(s) / PATH.votPerMin, 0, -1, 0, accessComp(t, s));
        add(LINK_EGRESS, A0 + s, z, walkW * t, 0, -1, 0, comp({ [C_TIME]: t, [C_WALK]: t }));
      }
      // transfers to nearby existing stops
      for (let t = 0; t < H.stops.length; t++) {
        const st = H.stops[t];
        const d = Math.hypot(st.x - ns.x, st.y - ns.y);
        // up to ~7 minutes on foot (a new station near downtown reaches BART and Market Street lines)
        if (d > 550) continue;
        const m = (d * 1.3) / 1.34 / 60 + plat[t];
        // fares on the way in, less the Clipper discount, as at any transfer between operators
        const f0 = transferFare(s, t), f1 = transferFare(t, s);
        add(LINK_WALK, A0 + s, X[t], walkW * m + xferPen + opChange(s, t) + f0 / PATH.votPerMin, 0, -1, 0, comp({ [C_TIME]: m, [C_WALK]: m, [C_FARE]: f0 }));
        add(LINK_WALK, A0 + t, X[s], walkW * m + xferPen + opChange(t, s) + f1 / PATH.votPerMin, 0, -1, 0, comp({ [C_TIME]: m, [C_WALK]: m, [C_FARE]: f1 }));
      }
    });
  }
  // transfers: at the same stop, and walking to another
  for (let s = 0; s < S; s++) add(LINK_CHANGE, A0 + s, X[s], xferPen, 0, -1, 0, null);
  const tr = a.transfers as Int32Array;
  for (let i = 0; i < tr.length; i += 3) {
    const P = tr[i + 2] === 0 ? platIn : plat;
    const m = tr[i + 2] / 60 + P[tr[i]] + P[tr[i + 1]];
    // changing onto Muni, BART, or Caltrain from another operator pays its fare less the Clipper discount
    const f = transferFare(tr[i], tr[i + 1]);
    add(LINK_WALK, A0 + tr[i], X[tr[i + 1]], walkW * m + xferPen + opChange(tr[i], tr[i + 1]) + f / PATH.votPerMin, 0, -1, 0, comp({ [C_TIME]: m, [C_WALK]: m, [C_FARE]: f }));
  }
  // lines for some riders only: their board links away from the open stops, by destination set
  const BF: number[] = [];
  const destSets: Uint8Array[] = [];
  const setOf = new Map<BLine['restrict'], number>();
  // lines
  lines.forEach((l, li) => {
    let ds = -1;
    if (l.restrict) {
      if (!setOf.has(l.restrict)) {
        const m = new Uint8Array(Z);
        for (const z of l.restrict.destZones) m[z] = 1;
        setOf.set(l.restrict, destSets.push(m) - 1);
      }
      ds = setOf.get(l.restrict)!;
    }
    const open = l.restrict ? new Set(l.restrict.openStops) : null;
    const n = l.stops.length;
    // scheduled services (Caltrain, ferries): riders wait a tenth of the headway (TM2); others half,
    // with long headways partly timed (effectiveFreq)
    const hf = HEADWAY_FRACTION[l.mode];
    const f = hf ? (l.freq * 0.5) / hf : effectiveFreq(l.freq, l.waitFactor ?? 1);
    const fx = hf ? f : effectiveFreq(l.freq, l.waitFactor ?? 1, true);
    const rule = fareOf(l.feed);
    const ff = fareFactor(l.feed);
    // Muni's, BART's, and Caltrain's fares are paid on the way in (above); cable cars charge their
    // own fare each ride, as do the other operators
    const newRule = l.feed === 'new' ? NEW_LINE_FARE[l.mode] : undefined;
    const boardFare = (l.mode === 'cablecar' ? CABLE_CAR_FARE : newRule ? newRule.board : ENTRY_FEEDS.has(l.feed) || l.feed === 'new' ? 0 : (rule.routes?.[l.route] ?? rule.board)) * ff;
    const bias = calib?.modeBias[l.mode] ?? 0;
    // rail preference in route choice only (PATH.railBonus): a cost on bus rides, not in the components
    const busPen = BUS_MODES.has(l.mode) ? PATH.railBonus : 0;
    // an operator's own calibrated factor (AC Transit's Transbay buses) before its mode's
    const factor = calib?.ivtFactor?.[`feed:${l.feed}`] ?? calib?.ivtFactor?.[l.mode] ?? IVT_FACTOR[l.mode] ?? 1;
    const cm = crowd?.[li];
    // unreliability (PATH.reliabilityRatio): RR × the ride's SD of running time, a + b × minutes,
    // split as a per ride (on alighting) and b per minute aboard; rail's mean lateness is time aboard.
    // Summing SDs over a trip's rides, rather than variances, counts a transfer trip's spread in
    // full, as if its rides' delays went together.
    const RR = PATH.reliabilityRatio;
    const relRide = RR * (l.rideSD?.a ?? 0);
    const relMin = RR * (l.rideSD?.b ?? 0);
    const late = l.lateMin ?? 0;
    for (let k = 0; k < n; k++) {
      const node = L0 + lineStart[li] + k;
      const stop = l.stops[k];
      const noOn = !!l.rule && (l.rule[k] & 1) > 0, noOff = !!l.rule && (l.rule[k] & 2) > 0;
      const bf = open && !open.has(stop) ? ds : -1;
      // full vehicles leave riders behind at this stop (capacity at boarding): a lower frequency, on
      // top of the effective frequency (reliability, timed arrivals, scheduled services)
      const av = k < n - 1 ? boardAvail(cm, n, k) : 1;
      if (k < n - 1 && !noOn) (BF[T.length] = bf), add(LINK_BOARD, B0 + stop, node, 0, capacityFreq(f, 1 / l.freq, av), li, k, null);
      if (k < n - 1 && !noOn && X[stop] !== B0 + stop) (BF[T.length] = bf), add(LINK_BOARD, X[stop], node, 0, capacityFreq(fx, 1 / l.freq, av), li, k, null);
      if (k > 0 && !noOff)
        add(LINK_ALIGHT, node, A0 + stop, bias + busPen + boardFare / PATH.votPerMin + relRide + late * factor, 0, li, k, comp({ [C_BOARDS]: 1, [C_FARE]: boardFare, [C_BIAS]: bias, [C_REL]: relRide, [C_TIME]: late, [C_IVT]: late, [C_IVTP]: late * factor }));
      if (k < n - 1) {
        const t = l.hops[k] / 60;
        const sa = stopXY(stop), sb = stopXY(l.stops[k + 1]);
        const km = Math.hypot(sb.x - sa.x, sb.y - sa.y) / 1000;
        let fare = (newRule ? newRule.perKm : rule.perKm) * km;
        if (rule.hops) for (const h of rule.hops) if ((h.a === stop && h.b === l.stops[k + 1]) || (h.b === stop && h.a === l.stops[k + 1])) fare += h.fare;
        fare *= ff;
        const tp = t * factor * (cm ? cm[k] : 1);
        const rel = relMin * t;
        add(LINK_RIDE, node, node + 1, tp + rel + fare / PATH.votPerMin, 0, li, k, comp({ [C_TIME]: t, [C_IVT]: t, [C_IVTP]: tp, [C_FARE]: fare, [C_REL]: rel }));
      }
    }
  });

  const nLinks = T.length;
  const net: TransitNet = {
    transferPasses: RUN_MODES[scenario.runMode ?? 'precise'].transferPasses,
    period: p, nZones: Z, nStops: S, nNodes, lines, lineStart, nLinks,
    type: Uint8Array.from(T), tail: Int32Array.from(TL), head: Int32Array.from(HD), cost: Float32Array.from(CO), freq: Float32Array.from(FQ),
    comp: Float32Array.from(CP), line: Int32Array.from(LN), pos: Int32Array.from(PS),
    inStart: new Int32Array(nNodes + 1), inLinks: new Int32Array(nLinks), outStart: new Int32Array(nNodes + 1), outLinks: new Int32Array(0), newStops,
    extRec: Int32Array.from({ length: nLinks }, (_, i) => REC[i] ?? -1),
    platMin: Float32Array.from({ length: S }, (_, s) => (s < H.stops.length ? plat[s] : 0)),
  };
  if (MK.length) net.mmKind = Int8Array.from({ length: nLinks }, (_, i) => MK[i] ?? -1);
  if (mmLink.length) (net.mmLink = Int32Array.from(mmLink)), (net.mmShare = Float32Array.from(mmShare));
  if (destSets.length) {
    net.boardFor = Int32Array.from({ length: nLinks }, (_, i) => BF[i] ?? -1);
    net.destSets = destSets;
  }
  if (blockAcc) {
    net.accPt = Int32Array.from({ length: nLinks }, (_, i) => (T[i] === LINK_ACCESS ? PO[i] ?? -1 : -1));
    net.egrPt = Int32Array.from({ length: nLinks }, (_, i) => (T[i] === LINK_EGRESS ? PO[i] ?? -1 : -1));
    net.accPtMin = Float32Array.from(PTm);
    net.zonePtStart = zps;
    // each block's share of its zone's people and jobs
    net.zonePtShare = Float32Array.from(zpw);
    for (let z = 0; z < NZ; z++) {
      let W = 0;
      for (let q = zps[z]; q < zps[z + 1]; q++) W += zpw[q];
      for (let q = zps[z]; q < zps[z + 1]; q++) net.zonePtShare[q] = W > 0 ? zpw[q] / W : 0;
    }
  }
  // incoming CSR
  for (let i = 0; i < nLinks; i++) net.inStart[net.head[i] + 1]++;
  for (let v = 0; v < nNodes; v++) net.inStart[v + 1] += net.inStart[v];
  const fill = net.inStart.slice(0, nNodes);
  for (let i = 0; i < nLinks; i++) net.inLinks[fill[net.head[i]]++] = i;
  // outgoing board links per B node
  let nb = 0;
  // outgoing board links per B node, and access links per zone
  const out = (t: number) => t === LINK_BOARD || t === LINK_ACCESS;
  for (let i = 0; i < nLinks; i++) if (out(net.type[i])) net.outStart[net.tail[i] + 1]++, nb++;
  for (let v = 0; v < nNodes; v++) net.outStart[v + 1] += net.outStart[v];
  net.outLinks = new Int32Array(nb);
  const fo = net.outStart.slice(0, nNodes);
  for (let i = 0; i < nLinks; i++) if (out(net.type[i])) net.outLinks[fo[net.tail[i]]++] = i;
  return net;
}

export type { Edit };
