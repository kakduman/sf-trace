/**
 * Step 5: the transit network, from each operator's GTFS schedule for a typical midweek day.
 * Every distinct stop pattern of a route becomes a "line" with, for each of the five model periods,
 * how many trips run and how long each stop-to-stop hop takes (scheduled, so it already carries
 * traffic and dwell). Rail stations collapse to one node per station.
 * Writes data/beta3/work/transit.json.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=2048 npx tsx server/beta3/pipeline/transit.ts
 */
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { toXY } from '../../../shared/beta3/geo';
import { PERIODS, PERIOD_BOUNDS } from '../../../shared/beta3/periods';
import { RAW, REFERENCE, VARIANT, WORK, variantFile } from './paths';
import { StreetRouter } from './route-shapes';
import type { StreetEdge, StreetVertex } from './streets';

/** bus lines without a shape are routed on the streets (streets.json, made before this step) */
let router: StreetRouter | null = null;
const streetRouter = () => {
  if (!router) {
    const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
    router = new StreetRouter(vertices, edges);
  }
  return router;
};
/** the patterns routed on the streets, and the sparse shapes matched onto them, for the log */
const routedLog: string[] = [];
const matchedLog: string[] = [];
const matchedShapes = new Map<string, [number, number][] | null>();
function lineLen(pts: [number, number][]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = toXY(...pts[i - 1]),
      [bx, by] = toXY(...pts[i]);
    m += Math.hypot(bx - ax, by - ay);
  }
  return m;
}

export type TransitMode = 'bus' | 'rapid' | 'trolley' | 'streetcar' | 'lightrail' | 'cablecar' | 'bart' | 'caltrain' | 'ferry' | 'express';

interface Feed {
  key: string;
  agency: string;
  file: string;
  /** a typical midweek day inside the feed's dates, and a Saturday and Sunday */
  date: string;
  sat: string;
  sun: string;
  /** keep only routes with a stop in San Francisco */
  sfOnly?: boolean;
}

const FEEDS_TODAY: Feed[] = [
  { key: 'muni', agency: 'Muni', file: 'muni.zip', date: '20260819', sat: '20260822', sun: '20260823' },
  { key: 'bart', agency: 'BART', file: 'bart.zip', date: '20261007', sat: '20261010', sun: '20261011' },
  { key: 'caltrain', agency: 'Caltrain', file: 'caltrain.zip', date: '20260819', sat: '20260822', sun: '20260823' },
  { key: 'ggt', agency: 'Golden Gate Transit', file: 'ggt.zip', date: '20261007', sat: '20261010', sun: '20261011' },
  { key: 'ferry', agency: 'SF Bay Ferry', file: 'ferry.zip', date: '20261007', sat: '20261010', sun: '20261011' },
  // only their routes that reach San Francisco are kept (Transbay buses; SamTrans into the city)
  { key: 'ac', agency: 'AC Transit', file: 'ac.zip', date: '20261007', sat: '20261010', sun: '20261011', sfOnly: true },
  { key: 'samtrans', agency: 'SamTrans', file: 'samtrans.zip', date: '20261007', sat: '20261010', sun: '20261011', sfOnly: true },
  // free shuttles inside the city (reference/sf-shuttles.json): Mission Bay TMA's own GTFS (open to
  // all; its feed ends July 2026, so a Wednesday inside it), and UCSF's campus shuttles (from their
  // published weekday timetables) and PresidiGo Downtown (from the Trust's GTFS), written by shuttles.ts
  { key: 'tma', agency: 'Mission Bay TMA', file: '../shuttle/missionbaytma.zip', date: '20260408', sat: '20260411', sun: '20260412' },
  { key: 'shuttle', agency: 'Shuttles', file: '../shuttle/shuttles.gtfs.zip', date: '20261007', sat: '20261010', sun: '20261011' },
  // SMART (Sonoma–Marin commuter rail, Windsor to Larkspur): it never reaches the city, but Sonoma's
  // and north Marin's commuters ride it to the Larkspur ferry (Trillium's public feed for SMART,
  // https://data.trilliumtransit.com/gtfs/smart-ca-us/smart-ca-us.zip, version of 14 April 2026);
  // last, so the other operators' stops and lines keep their bundle indices)
  { key: 'smart', agency: 'SMART', file: 'smart.zip', date: '20261007', sat: '20261010', sun: '20261011' },
];
/** variant networks swap in an archived schedule (Muni, June 2024 for the backcast) */
const FEEDS: Feed[] =
  VARIANT === '2024'
    ? FEEDS_TODAY.map((f) => (f.key === 'muni' ? { ...f, file: 'muni-2024.zip', date: '20240717', sat: '20240720', sun: '20240721' } : f))
    : FEEDS_TODAY;
const inSF = (lat: number, lon: number) => lat > 37.705 && lat < 37.835 && lon > -122.52 && lon < -122.355;

/** Muni Metro lines and how many cars a train usually runs with */
const LRV_CARS: Record<string, number> = { J: 1, K: 2, L: 2, M: 2, N: 2, T: 2, S: 2, KT: 2 };
/** Muni buses by route: shares of 60- and 32-foot vehicles (the rest 40-foot). Capacities are MTC's
 * (40 ft 63 places, 39 seats; 60 ft 94, 56), and a 32-foot bus is scaled from the 40-foot by SFMTA's
 * planning capacities (33 against 44). */
const MUNI_FLEET = new Map<string, { share60?: number; share60Peak?: number; share32?: number }>(
  (JSON.parse(fs.readFileSync(`${REFERENCE}/muni-fleet-by-route.json`, 'utf8')).routes as { route: string; share60?: number; share60Peak?: number; share32?: number }[]).map((r) => [r.route, r]),
);

export interface Stop {
  id: string;
  feed: string;
  name: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  /** a rail station or ferry terminal rather than a kerbside stop */
  station: boolean;
}

export interface LinePeriod {
  /** trips in the period */
  trips: number;
  /** seconds for each hop between consecutive stops (stops.length - 1) */
  hops: number[];
}

export interface Line {
  id: string;
  feed: string;
  agency: string;
  route: string;
  routeName: string;
  mode: TransitMode;
  color: string;
  dir: number;
  headsign: string;
  stops: number[];
  /** period key → service (weekday) */
  periods: Partial<Record<string, LinePeriod>>;
  /** Saturday and Sunday service */
  days?: { sat?: Partial<Record<string, LinePeriod>>; sun?: Partial<Record<string, LinePeriod>> };
  /** trips leaving 7pm–midnight by day type (the night frequency) */
  evening?: { wkd: number; sat: number; sun: number };
  /** trips leaving midnight–5am by day type (owl service) */
  owl?: { wkd: number; sat: number; sun: number };
  /** positions in `stops` where riders may not board, or may not get off (GTFS pickup_type and
   * drop_off_type 1): SamTrans's 292, 397, and 122 only set down on the way into the city and only
   * pick up on the way out, so they carry no trips within it, and AC Transit's Transbay buses
   * likewise. Absent when every stop allows both. */
  noBoard?: number[];
  noAlight?: number[];
  /** passengers per vehicle (planning capacity) and seats */
  cap: number;
  seats: number;
  /** drawn path [lat, lon, ...] and, per stop, the index of its point on the path */
  path: number[];
  stopAt: number[];
}

// ---------- csv ----------

function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"'), i++;
        else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), (field = '');
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) row.push(field), rows.push(row);
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const secs = (t: string) => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

function weekday(date: string): number {
  const d = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00Z`);
  return d.getUTCDay(); // 0 sunday
}

function activeServices(files: Record<string, Uint8Array>, date: string): Set<string> {
  const on = new Set<string>();
  const dayCol = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][weekday(date)];
  if (files['calendar.txt'])
    for (const r of parseCsv(strFromU8(files['calendar.txt'])))
      if (r[dayCol] === '1' && r.start_date <= date && r.end_date >= date) on.add(r.service_id);
  if (files['calendar_dates.txt'])
    for (const r of parseCsv(strFromU8(files['calendar_dates.txt'])))
      if (r.date === date) {
        if (r.exception_type === '1') on.add(r.service_id);
        else on.delete(r.service_id);
      }
  return on;
}

// ---------- modes and capacities ----------

function modeOf(feed: string, routeType: number, short: string, long: string): TransitMode {
  if (feed === 'bart') return 'bart';
  // commuter rail: TM1 puts SMART with Caltrain, ACE and the Capitol Corridor
  if (feed === 'caltrain' || feed === 'smart') return 'caltrain';
  if (feed === 'ferry' || routeType === 4) return 'ferry';
  if (feed === 'ggt' || feed === 'ac') return 'express';
  if (feed === 'tma' || feed === 'shuttle') return 'bus';
  if (feed === 'samtrans') return /X$/.test(short) ? 'express' : 'bus';
  if (routeType === 5 || /cable/i.test(long)) return 'cablecar';
  if (routeType === 0) return /^[FE]$/.test(short) ? 'streetcar' : 'lightrail';
  if (/R$/.test(short)) return 'rapid';
  if (/X$|AX$|BX$/.test(short)) return 'express';
  return 'bus';
}

// Muni's electric trolleybus routes
const TROLLEY = new Set(['1', '2', '3', '5', '5R', '6', '7', '14', '14R', '21', '22', '24', '30', '31', '33', '41', '45', '49']);

/**
 * Planning capacity and seats per vehicle. Muni from the SFMTA Short Range Transit Plan load
 * standards and MTC transitSeatCap; BART 10 cars and Caltrain 7-car electric sets from MTC.
 * Bus size is read from how often the route runs: Muni puts its 60-foot buses on the busiest.
 */
function capacity(mode: TransitMode, short: string, peakHeadwayMin: number, muniFeed = false, feedKey = ''): { cap: number; seats: number } {
  switch (mode) {
    case 'lightrail': {
      const cars = LRV_CARS[short] ?? 2;
      return { cap: 119 * cars, seats: 60 * cars };
    }
    case 'streetcar':
      return { cap: 69, seats: 32 };
    case 'cablecar':
      return { cap: 60, seats: 29 };
    case 'bart':
      return { cap: 1110, seats: 550 };
    case 'caltrain':
      // SMART runs two-car diesel sets (Nippon Sharyo DMUs: 79 seats a car, about 160 places with standees, assumed)
      if (short === 'SMART') return { cap: 320, seats: 158 };
      return { cap: 1502, seats: 681 };
    case 'ferry':
      // licensed passengers per vessel (all seated), by operator: Golden Gate Ferry's Larkspur boats are
      // the Spaulding class (630–750) and the Mendocino-class catamarans (390–450), its Sausalito and
      // Tiburon boats the catamarans; SF Bay Ferry's newer vessels carry 445 (Pyxis, Vela, Lyra), some
      // older ones fewer (goldengate.org fleet history; WETA). Capacity at boarding binds on these.
      if (feedKey === 'ggt') return /^LS/.test(short) ? { cap: 600, seats: 600 } : { cap: 420, seats: 420 };
      if (feedKey === 'ferry') return { cap: 400, seats: 400 };
      return { cap: 350, seats: 350 };
    default: {
      // Muni: the route's observed peak mix of 32-, 40-, and 60-foot buses (Cal-ITP vehicle positions,
      // a weekday in June 2026; muni-fleet-by-route.json); others, by frequency
      const f = MUNI_FLEET.get(short);
      if (f && muniFeed) {
        const s60 = f.share60Peak ?? f.share60 ?? 0, s32 = f.share32 ?? 0, s40 = Math.max(0, 1 - s60 - s32);
        return { cap: Math.round(94 * s60 + 63 * s40 + 47 * s32), seats: Math.round(56 * s60 + 39 * s40 + 23 * s32) };
      }
      const long = peakHeadwayMin <= 8;
      return long ? { cap: 94, seats: 56 } : { cap: 63, seats: 39 };
    }
  }
}

// ---------- geometry ----------

function simplify(pts: [number, number][], tol: number): number[] {
  // Douglas–Peucker on local metres; returns kept indices. Distances are to the segment, not the
  // line through it, so a path that comes back to where it started (a loop) keeps its far end
  if (pts.length < 3) return pts.map((_, i) => i);
  const xy = pts.map(([la, lo]) => toXY(la, lo));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, wd = tol;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L2)) : 0;
      const d = Math.hypot(xy[i][0] - ax - t * dx, xy[i][1] - ay - t * dy);
      if (d > wd) (wd = d), (worst = i);
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep.keys()].filter((i) => keep[i]);
}

function main() {
  console.time('transit');
  const stops: Stop[] = [];
  const stopIndex = new Map<string, number>();
  const lines: Line[] = [];

  for (const feed of FEEDS) {
    const files = unzipSync(fs.readFileSync(`${RAW}/gtfs/${feed.file}`));
    const txt = (n: string) => (files[n] ? parseCsv(strFromU8(files[n])) : []);
    const DAYS = [['wkd', feed.date], ['sat', feed.sat], ['sun', feed.sun]] as const;
    const servicesBy = DAYS.map(([, d]) => activeServices(files, d));
    const services = new Set(servicesBy.flatMap((x) => [...x]));
    const routes = new Map(txt('routes.txt').map((r) => [r.route_id, r]));
    // feeds with several operators (the shuttles) name each line's own
    const agencyName = new Map(txt('agency.txt').map((a) => [a.agency_id, a.agency_name]));
    const rawStops = new Map(txt('stops.txt').map((s) => [s.stop_id, s]));
    // rail platforms fold into their parent station
    const nodeOf = (sid: string): string => {
      const s = rawStops.get(sid)!;
      const rail = feed.key === 'bart' || feed.key === 'caltrain' || feed.key === 'ferry' || feed.key === 'smart';
      return rail && s.parent_station ? s.parent_station : sid;
    };
    const stopNode = (sid: string): number => {
      const nid = nodeOf(sid);
      const key = `${feed.key}:${nid}`;
      let i = stopIndex.get(key);
      if (i === undefined) {
        const s = rawStops.get(nid) ?? rawStops.get(sid)!;
        const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
        const [x, y] = toXY(lat, lon);
        i = stops.length;
        const rail = feed.key === 'bart' || feed.key === 'caltrain' || feed.key === 'ferry' || feed.key === 'smart';
        stops.push({ id: key, feed: feed.key, name: s.stop_name, lat, lon, x: +x.toFixed(1), y: +y.toFixed(1), station: rail || (!!s.parent_station && feed.key === 'muni' && /Station/i.test(s.stop_name)) });
        stopIndex.set(key, i);
      }
      return i;
    };
    const trips = txt('trips.txt').filter((t) => services.has(t.service_id));
    const tripById = new Map(trips.map((t) => [t.trip_id, t]));
    // stop_times, grouped by trip
    const times = new Map<string, { seq: number; stop: string; arr: number; dep: number; noOn: boolean; noOff: boolean }[]>();
    const st = strFromU8(files['stop_times.txt']);
    const stRows = parseCsv(st);
    for (const r of stRows) {
      if (!tripById.has(r.trip_id)) continue;
      if (!times.has(r.trip_id)) times.set(r.trip_id, []);
      const arr = r.arrival_time ? secs(r.arrival_time) : NaN;
      const dep = r.departure_time ? secs(r.departure_time) : arr;
      times.get(r.trip_id)!.push({ seq: Number(r.stop_sequence), stop: r.stop_id, arr: isNaN(arr) ? dep : arr, dep, noOn: r.pickup_type === '1', noOff: r.drop_off_type === '1' });
    }
    // frequencies.txt (headway-based trips) expand into individual departures
    const freq = new Map<string, { start: number; end: number; headway: number }[]>();
    for (const f of txt('frequencies.txt')) {
      if (!tripById.has(f.trip_id)) continue;
      if (!freq.has(f.trip_id)) freq.set(f.trip_id, []);
      freq.get(f.trip_id)!.push({ start: secs(f.start_time), end: secs(f.end_time), headway: Number(f.headway_secs) });
    }
    const shapes = new Map<string, [number, number][]>();
    for (const r of txt('shapes.txt')) {
      if (!shapes.has(r.shape_id)) shapes.set(r.shape_id, []);
      shapes.get(r.shape_id)!.push([Number(r.shape_pt_lat), Number(r.shape_pt_lon), Number(r.shape_pt_sequence)] as unknown as [number, number]);
    }
    for (const s of shapes.values()) s.sort((a, b) => (a as unknown as number[])[2] - (b as unknown as number[])[2]);

    // routes reaching the city (for regional bus operators)
    let sfRoutes: Set<string> | null = null;
    if (feed.sfOnly) {
      sfRoutes = new Set();
      for (const [tid, ts] of times) {
        const t = tripById.get(tid)!;
        if (sfRoutes.has(t.route_id)) continue;
        if (ts.some((x) => {
          const st = rawStops.get(x.stop);
          return st && inSF(Number(st.stop_lat), Number(st.stop_lon));
        })) sfRoutes.add(t.route_id);
      }
      for (const tid of [...times.keys()]) if (!sfRoutes.has(tripById.get(tid)!.route_id)) times.delete(tid);
    }
    // patterns
    const patterns = new Map<string, { trip: Record<string, string>; nodes: number[]; noOn: boolean[]; noOff: boolean[]; runs: { t0: number; hops: number[]; day: 'wkd' | 'sat' | 'sun' }[] }>();
    for (const [tid, ts] of times) {
      ts.sort((a, b) => a.seq - b.seq);
      // interpolate missing times (only timepoints are scheduled in some feeds)
      for (let i = 0; i < ts.length; i++)
        if (isNaN(ts[i].dep)) {
          let j = i + 1;
          while (j < ts.length && isNaN(ts[j].dep)) j++;
          const a = ts[i - 1], b = ts[j];
          if (!a || !b) continue;
          for (let k = i; k < j; k++) ts[k].arr = ts[k].dep = a.dep + ((b.arr - a.dep) * (k - i + 1)) / (j - i + 1);
        }
      const nodes: number[] = [];
      const t: number[] = [];
      const noOn: boolean[] = [], noOff: boolean[] = [];
      for (const s of ts) {
        const n = stopNode(s.stop);
        if (nodes.length && nodes[nodes.length - 1] === n) {
          t[t.length - 1] = s.dep;
          // two platforms of one station: riders may board or get off if either allows it
          noOn[noOn.length - 1] &&= s.noOn;
          noOff[noOff.length - 1] &&= s.noOff;
          continue;
        }
        nodes.push(n);
        t.push(s.dep);
        noOn.push(s.noOn);
        noOff.push(s.noOff);
      }
      if (nodes.length < 2) continue;
      const trip = tripById.get(tid)!;
      // stops where boarding or getting off is not allowed make a pattern of their own
      const rule = noOn.some((x) => x) || noOff.some((x) => x) ? `|${noOn.map((x, i) => (x ? 'p' : '') + (noOff[i] ? 'd' : '')).join(',')}` : '';
      const key = `${trip.route_id}|${trip.direction_id}|${nodes.join(',')}${rule}`;
      if (!patterns.has(key)) patterns.set(key, { trip, nodes, noOn, noOff, runs: [] });
      const hops = nodes.slice(1).map((_, i) => Math.max(15, t[i + 1] - t[i]));
      const fs2 = freq.get(tid);
      // a trip runs on each day type whose services include it
      DAYS.forEach(([day], di) => {
        if (!servicesBy[di].has(trip.service_id)) return;
        if (fs2) {
          for (const f of fs2) for (let d = f.start; d < f.end; d += f.headway) patterns.get(key)!.runs.push({ t0: d + (t[Math.floor(t.length / 2)] - t[0]), hops, day });
        } else patterns.get(key)!.runs.push({ t0: t[Math.floor(t.length / 2)], hops, day });
      });
    }

    // a route's morning frequency in its busier direction, all its patterns together (vehicle size
    // is assigned by route: SFMTA runs 60-foot buses on its frequent routes, whatever the pattern)
    const [amA, amB] = PERIOD_BOUNDS.AM;
    const routeDirAM = new Map<string, number>();
    for (const q of patterns.values()) {
      const k = `${q.trip.route_id}|${q.trip.direction_id ?? 0}`;
      const n = q.runs.filter((r) => r.day === 'wkd' && r.t0 % 86400 >= amA * 3600 && r.t0 % 86400 < amB * 3600).length;
      routeDirAM.set(k, (routeDirAM.get(k) ?? 0) + n);
    }
    const routeAM = (routeId: string) => Math.max(...[...routeDirAM].filter(([k]) => k.startsWith(`${routeId}|`)).map(([, v]) => v), 0);
    let kept = 0, dropped = 0;
    for (const [key, p] of patterns) {
      const r = routes.get(p.trip.route_id)!;
      const short = r.route_short_name || r.route_long_name;
      // too rare to matter for a weekday model (school trippers, pull-outs) unless it is all the route has
      const routeRuns = [...patterns.values()].filter((q) => q.trip.route_id === p.trip.route_id).reduce((s, q) => s + q.runs.length, 0);
      if (p.runs.length < 3 && p.runs.length < routeRuns) {
        dropped++;
        continue;
      }
      const periodsOf = (day: 'wkd' | 'sat' | 'sun') => {
        const out: Line['periods'] = {};
        for (const per of PERIODS) {
          const [a, b] = PERIOD_BOUNDS[per];
          const runs = p.runs.filter((r) => {
            if (r.day !== day) return false;
            const t = r.t0 % 86400;
            return a <= b ? t >= a * 3600 && t < b * 3600 : t >= a * 3600 || t < b * 3600;
          });
          if (!runs.length) continue;
          const hops = p.nodes.slice(1).map((_, i) => Math.round(runs.reduce((s, r) => s + r.hops[i], 0) / runs.length));
          out[per] = { trips: runs.length, hops };
        }
        return out;
      };
      const periods = periodsOf('wkd'), sat = periodsOf('sat'), sun = periodsOf('sun');
      // trips leaving 7pm–midnight, when most of the night's riders travel: the night frequency
      // (owl-only routes would otherwise look available all evening at an average frequency)
      const eveningOf = (day: 'wkd' | 'sat' | 'sun') => p.runs.filter((r) => r.day === day && r.t0 % 86400 >= 19 * 3600).length;
      const evening = { wkd: eveningOf('wkd'), sat: eveningOf('sat'), sun: eveningOf('sun') };
      // and midnight–5am (owl service), for the night's riders who travel then
      const owlOf = (day: 'wkd' | 'sat' | 'sun') => p.runs.filter((r) => r.day === day && r.t0 % 86400 < 5 * 3600).length;
      const owl = { wkd: owlOf('wkd'), sat: owlOf('sat'), sun: owlOf('sun') };
      if (!Object.keys(periods).length && !Object.keys(sat).length && !Object.keys(sun).length) continue;
      const amTrips = routeAM(p.trip.route_id) || (periods.AM?.trips ?? sat.MD?.trips ?? 0);
      const mode = modeOf(feed.key, Number(r.route_type), short, r.route_long_name);
      const { cap, seats } = capacity(mode, short, amTrips ? (4 * 60) / amTrips : 99, feed.key === 'muni', feed.key);
      // path: the trip's shape, with each stop placed on it. A bus line without one (a feed with no
      // shapes.txt, or the shuttles' timetables) is routed on the streets between its stops; rail and
      // ferries without one run straight between stops
      let shape = (shapes.get(p.trip.shape_id) ?? []).map(([la, lo]) => [la, lo] as [number, number]);
      let routedAt: number[] | null = null;
      // a bus shape drawn with sparse points (more than 30 m apart on average) that strays from the
      // streets (more than 3% of it over 8 m off: more than a lane's offset) cuts corners: match it onto the streets, keeping
      // the match only if it sits on them at least twice as well and runs within -3%/+10% of the
      // shape's length
      if (shape.length >= 2 && (Number(r.route_type) === 3 || Number(r.route_type) === 11)) {
        const key = `${feed.key}|${p.trip.shape_id}`;
        let m = matchedShapes.get(key);
        if (m === undefined) {
          m = null;
          const R = streetRouter();
          const f0 = R.fit(shape, 8);
          if (f0.spacing > 30 && f0.offShare > 0.03) {
            const mt = R.match(shape);
            const f1 = R.fit(mt, 8);
            const ratio = lineLen(mt) / lineLen(shape);
            if (f1.offShare < f0.offShare / 2 && ratio > 0.97 && ratio < 1.1) m = mt;
            matchedLog.push(`${feed.key} ${short} shape ${p.trip.shape_id}: ${f0.spacing.toFixed(0)} m apart, ${(100 * f0.offShare).toFixed(1)}% over 8 m off the streets → ${(100 * f1.offShare).toFixed(1)}%, length ×${ratio.toFixed(3)}${m ? '' : ' (kept the feed shape)'}`);
          }
          matchedShapes.set(key, m);
        }
        if (m) shape = m;
      }
      if (shape.length < 2) {
        shape = p.nodes.map((n) => [stops[n].lat, stops[n].lon]);
        if (Number(r.route_type) === 3 || Number(r.route_type) === 11) {
          const rs = streetRouter().route(shape);
          if (rs.routed) {
            shape = rs.shape;
            routedAt = rs.stopAt;
            routedLog.push(`${feed.key} ${short} (${rs.routed} of ${p.nodes.length - 1} hops)`);
          }
        }
      }
      const shapeXY = shape.map(([la, lo]) => toXY(la, lo));
      const stopAt: number[] = routedAt ?? [];
      let from = 0;
      for (const n of routedAt ? [] : p.nodes) {
        let best = from, bd = Infinity;
        for (let i = from; i < shapeXY.length; i++) {
          const d = (shapeXY[i][0] - stops[n].x) ** 2 + (shapeXY[i][1] - stops[n].y) ** 2;
          if (d < bd) (bd = d), (best = i);
          if (bd < 25 && d > 250_000) break;
        }
        stopAt.push(best);
        from = best;
      }
      // simplify the path, keeping every point a stop sits on
      const keepIdx = new Set(simplify(shape, 4));
      for (const i of stopAt) keepIdx.add(i);
      const idx = [...keepIdx].sort((a, b) => a - b);
      const remap = new Map(idx.map((v, k) => [v, k]));
      const path = idx.flatMap((i) => [+shape[i][0].toFixed(5), +shape[i][1].toFixed(5)]);
      lines.push({
        id: `${feed.key}:${key.split('|').slice(0, 2).join(':')}:${kept}`,
        feed: feed.key,
        agency: (agencyName.size > 1 && agencyName.get(r.agency_id)) || feed.agency,
        route: short,
        routeName: r.route_long_name || short,
        mode: TROLLEY.has(short) && feed.key === 'muni' && mode !== 'express' ? (mode === 'rapid' ? 'rapid' : 'trolley') : mode,
        color: `#${(r.route_color || '666666').toLowerCase()}`,
        dir: Number(p.trip.direction_id) || 0,
        headsign: p.trip.trip_headsign || stops[p.nodes[p.nodes.length - 1]].name,
        stops: p.nodes,
        periods,
        days: { sat, sun },
        evening,
        owl,
        ...(p.noOn.some((x, i) => x && i < p.nodes.length - 1) ? { noBoard: p.nodes.flatMap((_, i) => (p.noOn[i] && i < p.nodes.length - 1 ? [i] : [])) } : {}),
        ...(p.noOff.some((x, i) => x && i > 0) ? { noAlight: p.nodes.flatMap((_, i) => (p.noOff[i] && i > 0 ? [i] : [])) } : {}),
        cap,
        seats,
        path,
        stopAt: stopAt.map((i) => remap.get(i)!),
      });
      kept++;
    }
    const runsOf = (f: (l: Line) => Partial<Record<string, LinePeriod>> | undefined) => lines.filter((l) => l.feed === feed.key).reduce((s, l) => s + Object.values(f(l) ?? {}).reduce((a, p) => a + (p?.trips ?? 0), 0), 0);
    console.log(`${feed.agency}: services ${services.size}, trips ${trips.length}, patterns kept ${kept} (dropped ${dropped} rare), runs weekday ${runsOf((l) => l.periods)} / Saturday ${runsOf((l) => l.days?.sat)} / Sunday ${runsOf((l) => l.days?.sun)}, routes ${new Set(lines.filter((l) => l.feed === feed.key).map((l) => l.route)).size}`);
  }
  smoothMinuteTimes(lines, 'bart');
  subwayRunningTimes(lines, stops);
  segmentShapes(lines, stops);
  if (routedLog.length) console.log(`routed on the streets (no shape published): ${routedLog.join(', ')}`);
  if (matchedLog.length) console.log(`sparse shapes matched onto the streets:\n  ${matchedLog.join('\n  ')}`);
  console.log(`stops ${stops.length}, lines ${lines.length}`);
  fs.writeFileSync(`${WORK}/${variantFile('transit.json')}`, JSON.stringify({ stops, lines }));
  console.timeEnd('transit');
}


/**
 * BART publishes its timetable to the minute, so one pattern runs Embarcadero–Montgomery in 60 s and
 * the next in 120 s, and Montgomery–Powell the other way round. Riders choosing where to change to
 * Muni Metro (or where to get off) would follow those rounding steps, all on one side of a station
 * or the other. Each hop between two stations takes the mean over every train of the operator
 * running it in that period, day type by day type.
 */
function smoothMinuteTimes(lines: Line[], feed: string) {
  const own = lines.filter((l) => l.feed === feed);
  const tables = (l: Line) => [l.periods, l.days?.sat, l.days?.sun].filter((t): t is NonNullable<typeof t> => !!t) as Record<string, LinePeriod | undefined>[];
  const keys = new Set(own.flatMap((l) => tables(l).flatMap((t, i) => Object.keys(t).map((k) => `${i}:${k}`))));
  for (const key of keys) {
    const [ti, per] = key.split(':');
    const sum = new Map<string, [number, number]>();
    const each = (f: (p: LinePeriod, a: number, b: number, k: number) => void) => {
      for (const l of own) {
        const p = tables(l)[Number(ti)]?.[per];
        if (p && p.trips > 0) for (let k = 0; k + 1 < l.stops.length; k++) f(p, l.stops[k], l.stops[k + 1], k);
      }
    };
    each((p, a, b, k) => {
      const v = sum.get(`${a}-${b}`) ?? [0, 0];
      sum.set(`${a}-${b}`, [v[0] + p.trips * p.hops[k], v[1] + p.trips]);
    });
    each((p, a, b, k) => {
      const v = sum.get(`${a}-${b}`)!;
      p.hops[k] = Math.round(v[0] / v[1]);
    });
  }
}


/**
 * Muni Metro's timetable gives the downtown subway too little time. Between Embarcadero and Van Ness,
 * trains in the peaks and at midday took 508 s outbound and 391 s inbound (Cal-ITP / MTC segment
 * speeds from vehicle positions, weekdays 16 September–16 October 2025, 4,500–4,800 runs a segment)
 * against the GTFS timetable's 300 s each way: its time between the timepoints at Embarcadero and
 * West Portal is shared along the line, and the long Twin Peaks tunnel gets more than trains take
 * (Castro–Forest Hill, 164 s observed outbound against 303 s scheduled). BART's parallel trains then
 * looked slower than Metro's from one Market Street station to the next, which set where riders
 * changed between them. Each line's run through the downtown subway is scaled to the observed time
 * of that run in the period (the sum over its stations, as single segments in a tunnel are located
 * less well than a run); the night keeps the timetable (its subway service ends at 9:30 p.m.).
 */
const SUBWAY_STATION = /^(Metro (Embarcadero|Montgomery|Powell|Civic Center|Van Ness)|Van Ness Station)/;
function subwayRunningTimes(lines: Line[], stops: Stop[]) {
  const file = `${RAW}/ops/muni_segment_arrivals_2025-09-16_2025-10-16.csv`;
  if (!fs.existsSync(file)) return console.warn('no Muni segment arrivals: the subway keeps its timetable');
  const PER: Record<string, string> = { 'AM Peak': 'AM', Midday: 'MD', 'PM Peak': 'PM' };
  const code = (s: number) => (stops[s].id.startsWith('muni:') ? `1${stops[s].id.slice(5)}` : '');
  const wanted = new Set<string>();
  for (const l of lines) if (l.feed === 'muni' && l.mode === 'lightrail') for (let k = 0; k + 1 < l.stops.length; k++) if (SUBWAY_STATION.test(stops[l.stops[k]].name) && SUBWAY_STATION.test(stops[l.stops[k + 1]].name)) wanted.add(`${code(l.stops[k])}-${code(l.stops[k + 1])}`);
  const sum = new Map<string, [number, number]>();
  const text = fs.readFileSync(file, 'utf8');
  for (let i = text.indexOf('\n') + 1; i > 0 && i < text.length; ) {
    const j = text.indexOf('\n', i);
    const row = text.slice(i, j < 0 ? text.length : j).split(',');
    i = j < 0 ? -1 : j + 1;
    const seg = row[9]?.trim().split('-');
    const per = PER[row[4]];
    if (!per || !seg || seg.length < 2) continue;
    const key = `${seg[0]}-${seg[1]}`;
    if (!wanted.has(key)) continue;
    const v = sum.get(`${key}|${per}`) ?? [0, 0];
    sum.set(`${key}|${per}`, [v[0] + Number(row[7]), v[1] + 1]);
  }
  let scaled = 0;
  for (const l of lines) {
    if (l.feed !== 'muni' || l.mode !== 'lightrail') continue;
    const run = l.stops.slice(0, -1).map((_, k) => k).filter((k) => SUBWAY_STATION.test(stops[l.stops[k]].name) && SUBWAY_STATION.test(stops[l.stops[k + 1]].name));
    if (!run.length) continue;
    for (const per of Object.keys(PER).map((k) => PER[k])) {
      const p = l.periods[per as keyof typeof l.periods] as LinePeriod | undefined;
      if (!p || !p.trips) continue;
      let obs = 0, sched = 0;
      for (const k of run) {
        const v = sum.get(`${code(l.stops[k])}-${code(l.stops[k + 1])}|${per}`);
        if (!v || v[1] < 100) {
          obs = NaN;
          break;
        }
        obs += v[0] / v[1];
        sched += p.hops[k];
      }
      if (!(obs > 0) || !(sched > 0)) continue;
      for (const k of run) p.hops[k] = Math.round((p.hops[k] * obs) / sched);
      scaled++;
    }
  }
  console.log(`Muni Metro: ${scaled} line-periods' downtown subway runs set to observed running times`);
}

/**
 * Where along a Muni line its time goes. Between timepoints, GTFS stop times are spread by distance,
 * so a timetable gives a slow downtown block and a fast outer one much the same time a meter, and
 * a route's observed running time (build.ts runFactor) only scales the whole run. Each line's
 * scheduled time in a period is spread over its hops in proportion to the median observed time of
 * each hop (Cal-ITP / MTC segment arrivals from vehicle positions, Tuesdays to Thursdays,
 * 16 September to 16 October 2025; at least 20 runs a hop), keeping the period's total, so runFactor still sets the
 * level. A line-period is reshaped only where observed hops cover at least 80% of its scheduled
 * time; the downtown subway's runs keep the observed times subwayRunningTimes gave them.
 */
export function segmentShapes(lines: Line[], stops: Stop[]) {
  const file = `${RAW}/ops/muni_segment_arrivals_2025-09-16_2025-10-16.csv`;
  if (!fs.existsSync(file)) return console.warn('no Muni segment arrivals: hops keep the timetable spread');
  const PER: Record<string, string> = { 'AM Peak': 'AM', Midday: 'MD', 'PM Peak': 'PM', Evening: 'EV', 'Early AM': 'EA' };
  const code = (s: number) => (stops[s].id.startsWith('muni:') ? `1${stops[s].id.slice(5)}` : '');
  const wanted = new Set<string>();
  for (const l of lines) if (l.feed === 'muni') for (let k = 0; k + 1 < l.stops.length; k++) wanted.add(`${code(l.stops[k])}-${code(l.stops[k + 1])}`);
  const vals = new Map<string, number[]>();
  const text = fs.readFileSync(file, 'utf8');
  for (let i = text.indexOf('\n') + 1; i > 0 && i < text.length; ) {
    const j = text.indexOf('\n', i);
    const row = text.slice(i, j < 0 ? text.length : j).split(',');
    i = j < 0 ? -1 : j + 1;
    const per = PER[row[4]];
    const seg = row[9]?.trim().split('-');
    if (!per || !seg || seg.length < 2) continue;
    const key = `${seg[0]}-${seg[1]}|${per}`;
    if (!wanted.has(key.slice(0, key.indexOf('|')))) continue;
    const t = Number(row[7]);
    if (!(t > 0)) continue;
    (vals.get(key) ?? vals.set(key, []).get(key)!).push(t);
  }
  const med = new Map<string, number>();
  for (const [k, v] of vals) if (v.length >= 20) (v.sort((a, c) => a - c), med.set(k, v[v.length >> 1]));
  const [shaped, tried] = spreadAsObserved(lines, stops, med);
  console.log(`Muni: ${shaped} of ${tried} line-periods' running time spread over their hops as observed`);
}

/**
 * segmentShapes' spreading, given each hop's median observed seconds by "from-to|period" (stop codes
 * as in the segment file: 1 + the GTFS stop id). Returns [line-periods reshaped, line-periods tried].
 */
export function spreadAsObserved(lines: Line[], stops: Stop[], med: Map<string, number>): [number, number] {
  const code = (s: number) => (stops[s].id.startsWith('muni:') ? `1${stops[s].id.slice(5)}` : '');
  const subway = (l: Line, k: number) => SUBWAY_STATION.test(stops[l.stops[k]].name) && SUBWAY_STATION.test(stops[l.stops[k + 1]].name);
  let shaped = 0, tried = 0;
  for (const l of lines) {
    if (l.feed !== 'muni' || l.mode === 'cablecar') continue;
    for (const per of ['AM', 'MD', 'PM', 'EV', 'EA']) {
      const p = l.periods[per as keyof typeof l.periods] as LinePeriod | undefined;
      if (!p || !p.trips) continue;
      tried++;
      let sched = 0, schedCov = 0, obsCov = 0;
      const obs: (number | undefined)[] = [];
      for (let k = 0; k < p.hops.length; k++) {
        if (subway(l, k)) continue;
        sched += p.hops[k];
        const o = med.get(`${code(l.stops[k])}-${code(l.stops[k + 1])}|${per}`);
        if (o !== undefined && p.hops[k] > 0) (obs[k] = o), (schedCov += p.hops[k]), (obsCov += o);
      }
      if (!(sched > 0) || schedCov / sched < 0.8) continue;
      for (let k = 0; k < p.hops.length; k++) if (obs[k] !== undefined) p.hops[k] = Math.max(10, Math.round((obs[k]! * schedCov) / obsCov));
      shaped++;
    }
  }
  return [shaped, tried];
}

if (import.meta.url === `file://${process.argv[1]}`) main();
