/**
 * Bay Wheels in San Francisco, from Lyft's public trip histories (fetch-micromobility.ts): weekday
 * trips with both ends in the city, October 2025 to September 2026.
 *  - totals by hour, by bike (classic, e-bike), by rider (member, casual), and by whether each end
 *    was at a station (e-bikes may be locked away from one);
 *  - trips by Analysis Neighborhood pair, for checking the model's origins and destinations;
 *  - trips with a station end within 150 m of a BART, Caltrain, Muni Metro subway, or ferry station;
 *  - SFMTA's monthly counts of Bay Wheels and scooter trips (fetch-micromobility.ts), and from them
 *    the scooter trips of an average weekday;
 *  - riding speeds: each station pair's median ride against its route on the street graph (length
 *    and climb), for classic bikes and e-bikes, fitted as seconds per metre and per metre climbed.
 * Trips with an end away from a station carry coordinates rounded to 0.01° (about 1.1 km by 0.9 km):
 * such an end is spread over the zones in its cell by their people and jobs.
 * Station entrances: OpenStreetMap subway entrances (fetch-osm.ts, osm-entrances.json).
 * Writes server/beta3/reference/bay-wheels-sf.json.
 *
 * Run: npx tsx server/beta3/pipeline/bikeshare.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { bikeSpeed, toXY } from '../../../shared/beta3/geo';
import { dijkstra, Graph, Snapper } from './graph';
import { RAW, REFERENCE, WORK } from './paths';
import { MM_RAW, MONTHS } from './fetch-micromobility';
import type { StreetEdge, StreetVertex } from './streets';
import type { InternalZone } from './zones';
import type { Stop, Line } from './transit';

/** weekday holidays in the twelve months (federal, and the day after Thanksgiving, a city holiday) */
const HOLIDAYS = new Set(['2025-10-13', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07']);
/** a station end this close to a rail or ferry station counts as at it (metres) */
export const NEAR_STATION_M = 150;

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') (cur += '"'), i++;
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else if (c !== '\r') cur += c;
  }
  out.push(cur);
  return out;
}

async function* rows(zip: string): AsyncGenerator<Record<string, string>> {
  const p = spawn('unzip', ['-p', zip, '-x', '__MACOSX/*']);
  const rl = readline.createInterface({ input: p.stdout });
  let head: string[] | null = null;
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!head) {
      head = f;
      continue;
    }
    if (f[0] === 'ride_id') continue;
    const r: Record<string, string> = {};
    head.forEach((h, k) => (r[h] = f[k] ?? ''));
    yield r;
  }
}

const inRings = (lon: number, lat: number, rings: number[][][]) => {
  let inside = false;
  for (const r of rings)
    for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const [xa, ya] = r[a], [xb, yb] = r[b];
      if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
    }
  return inside;
};

/**
 * The rail and ferry stations in the city (BART, Caltrain, the Muni Metro subway and Central Subway,
 * the Ferry Building), as places: stops of any of them within 250 m are one station (BART and Muni
 * share the Market Street stations), each with its points (platforms and, from OpenStreetMap, its
 * street entrances), from which "near" is measured.
 */
export function cityStations(stops: Stop[], lines: Line[], entrances: { x: number; y: number }[] = [], inside: (s: Stop) => boolean = () => true): { name: string; kinds: string[]; x: number; y: number; stops: number[]; pts: { x: number; y: number }[] }[] {
  const inCity = (s: Stop) => s.lat > 37.705 && s.lat < 37.84 && s.lon > -122.53 && s.lon < -122.35;
  const modes: string[][] = stops.map(() => []);
  lines.forEach((l) => l.stops.forEach((s) => modes[s].push(l.mode)));
  const out: { name: string; kinds: string[]; x: number; y: number; stops: number[]; pts: { x: number; y: number }[] }[] = [];
  const RANK = ['bart', 'caltrain', 'metro', 'ferry'];
  const add = (name: string, kind: string, k: number) => {
    const same = out.find((o) => o.stops.some((j) => Math.hypot(stops[j].x - stops[k].x, stops[j].y - stops[k].y) < 250));
    if (same) {
      same.stops.push(k);
      same.pts.push({ x: stops[k].x, y: stops[k].y });
      if (!same.kinds.includes(kind)) same.kinds.push(kind);
      // named for its highest-ranked operator
      if (RANK.indexOf(kind) < Math.min(...same.kinds.filter((x) => x !== kind).map((x) => RANK.indexOf(x)))) same.name = name;
      // a ferry terminal is named for its main operator's stop (the Ferry Building)
      if (kind === 'ferry' && stops[k].feed === 'ferry') same.name = name;
    } else out.push({ name, kinds: [kind], x: stops[k].x, y: stops[k].y, stops: [k], pts: [{ x: stops[k].x, y: stops[k].y }] });
  };
  stops.forEach((s, k) => {
    if (!inCity(s) || !inside(s)) return;
    if (s.feed === 'bart' && s.station) add(s.name, 'bart', k);
    else if (s.feed === 'caltrain' && s.station) add(s.name, 'caltrain', k);
    else if (s.feed === 'muni' && modes[k].includes('lightrail') && /Station|^Metro /.test(s.name) && !/Caltrain|Sunnydale|Balboa Park|Stonestown|SF State/.test(s.name)) add(s.name, 'metro', k);
    else if (modes[k].includes('ferry') && /Ferry Building|San Francisco-Gate|Ferry Terminal/.test(s.name)) add(s.name, 'ferry', k);
  });
  // street entrances within 300 m of a station's platforms
  for (const e of entrances) {
    let best: (typeof out)[number] | null = null, bd = 300;
    for (const o of out)
      for (const p of o.pts) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < bd) (bd = d), (best = o);
      }
    if (best) best.pts.push(e);
  }
  return out;
}

async function main() {
  const Z = (JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8')) as { internal: (InternalZone & { shape: number[][][] })[] }).internal;
  const NZ = Z.length;
  const { stops, lines } = JSON.parse(fs.readFileSync(`${WORK}/transit.json`, 'utf8')) as { stops: Stop[]; lines: Line[] };
  // zones by 0.01° cell, for points; the zone a point is in
  const bbox = Z.map((z) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const r of z.shape) for (const [lo, la] of r) (a = Math.min(a, lo)), (b = Math.max(b, lo)), (c = Math.min(c, la)), (d = Math.max(d, la));
    return [a, b, c, d];
  });
  const zoneAt = (lat: number, lon: number) => {
    for (let i = 0; i < NZ; i++) {
      const [a, b, c, d] = bbox[i];
      if (lon < a || lon > b || lat < c || lat > d) continue;
      if (inRings(lon, lat, Z[i].shape)) return i;
    }
    return -1;
  };
  // a rounded (0.01°) end: the zones in its cell, by their people and jobs within it (block points)
  const cellZones = new Map<string, [number, number][]>();
  const cellKey = (lat: number, lon: number) => `${Math.round(lat * 100)},${Math.round(lon * 100)}`;
  {
    const acc = new Map<string, Map<number, number>>();
    Z.forEach((z, i) =>
      z.points.forEach((p) => {
        const lat = 37.7793 + p.y / 110_950, lon = -122.4193 + p.x / (111_320 * Math.cos((37.7793 * Math.PI) / 180));
        const k = cellKey(lat, lon);
        const m = acc.get(k) ?? acc.set(k, new Map()).get(k)!;
        m.set(i, (m.get(i) ?? 0) + p.w + 1e-6);
      }),
    );
    for (const [k, m] of acc) {
      const t = [...m.values()].reduce((a, v) => a + v, 0);
      cellZones.set(k, [...m].map(([i, w]) => [i, w / t]));
    }
  }
  // stations of the system (GBFS snapshot) by short name
  const gdir = fs.readdirSync(MM_RAW).filter((f) => f.startsWith('gbfs-')).sort().pop()!;
  const gbfs = (f: string) => JSON.parse(fs.readFileSync(path.join(MM_RAW, gdir, `${f}.json`), 'utf8'));
  const stInfo = gbfs('station_information').data.stations as { station_id: string; short_name: string; name: string; lat: number; lon: number; capacity: number; region_id: string }[];
  const stStatus = gbfs('station_status').data.stations as { station_id: string; num_bikes_available: number; num_ebikes_available: number; is_installed: number }[];
  const free = gbfs('free_bike_status').data.bikes as { lat: number; lon: number; vehicle_type_id: string; is_disabled: number }[];
  const station = new Map<string, { lat: number; lon: number; zone: number; x: number; y: number }>();
  for (const s of stInfo) {
    const [x, y] = toXY(s.lat, s.lon);
    station.set(s.short_name, { lat: s.lat, lon: s.lon, zone: zoneAt(s.lat, s.lon), x, y });
  }
  const sfStations = stInfo.filter((s) => s.region_id === '3');
  const statusOf = new Map(stStatus.map((s) => [s.station_id, s]));
  const freeSF = free.filter((b) => zoneAt(b.lat, b.lon) >= 0 && !b.is_disabled);
  const system = {
    snapshot: gdir.slice(5),
    stations: sfStations.length,
    docks: sfStations.reduce((a, s) => a + s.capacity, 0),
    bikesAtStations: sfStations.reduce((a, s) => a + (statusOf.get(s.station_id)?.num_bikes_available ?? 0), 0),
    ebikesAtStations: sfStations.reduce((a, s) => a + (statusOf.get(s.station_id)?.num_ebikes_available ?? 0), 0),
    ebikesAwayFromStations: freeSF.length,
  };
  console.log(`system (GBFS ${system.snapshot}): ${JSON.stringify(system)}`);

  // rail and ferry stations, and the Bay Wheels stations within 150 m of each
  const ent = (JSON.parse(fs.readFileSync(path.join(RAW, 'osm-entrances.json'), 'utf8')).elements as { lat: number; lon: number }[]).map((e) => {
    const [x, y] = toXY(e.lat, e.lon);
    return { x, y };
  });
  const rail = cityStations(stops, lines, ent);
  const nearRail = new Map<string, number>();
  for (const [sn, s] of station) {
    if (s.zone < 0) continue;
    let best = -1, bd = NEAR_STATION_M;
    rail.forEach((r, k) => {
      for (const p of r.pts) {
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d <= bd) (bd = d), (best = k);
      }
    });
    if (best >= 0) nearRail.set(sn, best);
  }
  console.log(`rail and ferry stations ${rail.length}; Bay Wheels stations within ${NEAR_STATION_M} m of one: ${nearRail.size}`);

  // ---- the trips ----
  const days = new Set<string>();
  const hour = new Float64Array(24);
  const hourBy: Record<string, Float64Array> = {};
  const byType: Record<string, number> = {}, byRider: Record<string, number> = {}, docked: Record<string, number> = {};
  const byTypeRider: Record<string, number> = {};
  const nhoods = [...new Set(Z.map((z) => z.nhood))].sort();
  const nhIdx = new Map(nhoods.map((n, i) => [n, i]));
  const NH = nhoods.length;
  const od = new Float64Array(NH * NH), odClassic = new Float64Array(NH * NH);
  const zoneOrig = new Float64Array(NZ), zoneDest = new Float64Array(NZ);
  const railEnds = rail.map(() => ({ startsAM: 0, endsAM: 0, startsPM: 0, endsPM: 0, starts: 0, ends: 0 }));
  let railTrips = 0, railTripsAM = 0;
  // station pairs: durations by bike, for the speed fit (members, both ends at stations)
  const pairDur = new Map<string, number[]>();
  // every weekday ride between two different stations, by bike and pair (for the mean trip length)
  const pairAll = new Map<string, number>();
  const durByType: Record<string, number[]> = { classic_bike: [], electric_bike: [] };
  let total = 0, kept = 0;
  // every trip starting in the city, any day (to compare with SFMTA's monthly counts), and those on weekdays
  let sfStartsAll = 0, sfStartsWeekday = 0;
  const end = (lat: number, lon: number, sn: string): [number, number][] | null => {
    const s = sn ? station.get(sn) : undefined;
    if (s) return s.zone >= 0 ? [[s.zone, 1]] : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // an end away from a station: its rounded cell's zones (or, at full precision, its own zone)
    const rounded = Math.abs(lat * 100 - Math.round(lat * 100)) < 1e-6 && Math.abs(lon * 100 - Math.round(lon * 100)) < 1e-6;
    if (rounded) return cellZones.get(cellKey(lat, lon)) ?? null;
    const z = zoneAt(lat, lon);
    return z >= 0 ? [[z, 1]] : null;
  };
  for (const m of MONTHS) {
    const file = path.join(MM_RAW, `${m}-tripdata.zip`);
    let n = 0;
    for await (const r of rows(file)) {
      total++;
      const day = r.started_at.slice(0, 10);
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      const weekday = !(dow === 0 || dow === 6 || HOLIDAYS.has(day));
      const a = end(+r.start_lat, +r.start_lng, r.start_station_id);
      if (a) (sfStartsAll++, weekday && sfStartsWeekday++);
      if (!weekday) continue;
      const b = end(+r.end_lat, +r.end_lng, r.end_station_id);
      if (!a || !b) continue;
      days.add(day);
      kept++, n++;
      const h = +r.started_at.slice(11, 13);
      hour[h]++;
      (hourBy[r.rideable_type] ??= new Float64Array(24))[h]++;
      byType[r.rideable_type] = (byType[r.rideable_type] ?? 0) + 1;
      byRider[r.member_casual] = (byRider[r.member_casual] ?? 0) + 1;
      byTypeRider[`${r.rideable_type} ${r.member_casual}`] = (byTypeRider[`${r.rideable_type} ${r.member_casual}`] ?? 0) + 1;
      const dk = `${r.start_station_id ? 'station' : 'away'}-${r.end_station_id ? 'station' : 'away'}`;
      docked[dk] = (docked[dk] ?? 0) + 1;
      for (const [za, wa] of a) {
        zoneOrig[za] += wa;
        for (const [zb, wb] of b) {
          const i = nhIdx.get(Z[za].nhood)! * NH + nhIdx.get(Z[zb].nhood)!;
          od[i] += wa * wb;
          if (r.rideable_type === 'classic_bike') odClassic[i] += wa * wb;
        }
      }
      for (const [zb, wb] of b) zoneDest[zb] += wb;
      const ra = nearRail.get(r.start_station_id), rb = nearRail.get(r.end_station_id);
      const am = h >= 6 && h < 10, pm = h >= 15 && h < 19;
      if (ra !== undefined) (railEnds[ra].starts++, am && railEnds[ra].startsAM++, pm && railEnds[ra].startsPM++);
      if (rb !== undefined) (railEnds[rb].ends++, am && railEnds[rb].endsAM++, pm && railEnds[rb].endsPM++);
      if (ra !== undefined || rb !== undefined) (railTrips++, am && railTripsAM++);
      const dur = (Date.parse(r.ended_at.replace(' ', 'T')) - Date.parse(r.started_at.replace(' ', 'T'))) / 1000;
      if (dur > 0 && dur < 4 * 3600) durByType[r.rideable_type]?.push(dur);
      if (r.start_station_id && r.end_station_id && r.start_station_id !== r.end_station_id) {
        const k = `${r.rideable_type}|${r.start_station_id}|${r.end_station_id}`;
        pairAll.set(k, (pairAll.get(k) ?? 0) + 1);
      }
      if (r.member_casual === 'member' && r.start_station_id && r.end_station_id && r.start_station_id !== r.end_station_id && dur > 60 && dur < 3600) {
        const k = `${r.rideable_type}|${r.start_station_id}|${r.end_station_id}`;
        (pairDur.get(k) ?? pairDur.set(k, []).get(k)!).push(dur);
      }
    }
    console.log(`${m}: ${n} weekday trips within the city`);
  }
  const D = days.size;
  console.log(`${kept} of ${total} trips (weekdays, both ends in the city) over ${D} weekdays: ${(kept / D).toFixed(0)} a day`);

  // ---- speeds: station pairs routed on the street graph (the model's bike route weights) ----
  const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  const NV = vertices.length;
  type Arc = { a: number; b: number; cost: number; edge: number };
  const arcs: Arc[] = [], lens: number[] = [], climbs: number[] = [], model: number[] = [];
  edges.forEach((e, k) => {
    if (!e.bike) return;
    const dz = vertices[e.b].z - vertices[e.a].z;
    const g = e.len > 5 ? dz / e.len : 0;
    const feel = e.bikeway ? 0.8 : /^(primary|secondary|trunk)/.test(e.cls) ? 1.3 : 1;
    const fwdOk = !(e.car && e.oneway === -1 && !e.bikeway), backOk = !(e.car && e.oneway === 1 && !e.bikeway);
    if (fwdOk) arcs.push({ a: e.a, b: e.b, cost: (feel * e.len) / bikeSpeed(g), edge: k }), lens.push(e.len), climbs.push(Math.max(0, dz)), model.push(e.len / bikeSpeed(g));
    if (backOk) arcs.push({ a: e.b, b: e.a, cost: (feel * e.len) / bikeSpeed(-g), edge: k }), lens.push(e.len), climbs.push(Math.max(0, -dz)), model.push(e.len / bikeSpeed(-g));
  });
  const G = new Graph(NV, arcs);
  const inOrder = (v: number[]) => {
    const out = new Float32Array(arcs.length);
    const fill = G.start.slice(0, G.n);
    arcs.forEach((r, i) => (out[fill[r.a]++] = v[i]));
    return out;
  };
  const lenA = inOrder(lens), climbA = inOrder(climbs), modelA = inOrder(model);
  const bikeV = new Uint8Array(NV);
  for (const e of edges) if (e.bike) bikeV[e.a] = bikeV[e.b] = 1;
  const snap = new Snapper(Float64Array.from(vertices, (v) => v.x), Float64Array.from(vertices, (v) => v.y), (i) => bikeV[i] === 1);
  const dist = new Float64Array(NV), auxL = new Float64Array(NV), auxC = new Float64Array(NV), auxM = new Float64Array(NV);
  const route = new Map<string, Map<string, { m: number; climb: number; modelSec: number }>>();
  const from = new Set([...pairAll.keys()].map((k) => k.split('|')[1]));
  for (const sa of from) {
    const s = station.get(sa);
    if (!s || s.zone < 0) continue;
    const v = snap.nearest(s.x, s.y);
    dijkstra(G, [[v.i, 0]], 4000, dist, undefined, { arc: lenA, out: auxL });
    dijkstra(G, [[v.i, 0]], 4000, dist, undefined, { arc: climbA, out: auxC });
    dijkstra(G, [[v.i, 0]], 4000, dist, undefined, { arc: modelA, out: auxM });
    const m = new Map<string, { m: number; climb: number; modelSec: number }>();
    for (const [sb, t] of station) {
      if (t.zone < 0 || sb === sa) continue;
      const w = snap.nearest(t.x, t.y);
      if (auxL[w.i] < Infinity) m.set(sb, { m: auxL[w.i] + v.d + w.d, climb: auxC[w.i], modelSec: auxM[w.i] + (v.d + w.d) / 4.5 });
    }
    route.set(sa, m);
  }
  // each pair's median ride (pairs with 5 or more rides by members), against its route
  type Obs = { type: string; m: number; climb: number; sec: number; modelSec: number; n: number };
  const obs: Obs[] = [];
  for (const [k, d] of pairDur) {
    if (d.length < 5) continue;
    const [type, sa, sb] = k.split('|');
    const rt = route.get(sa)?.get(sb);
    if (!rt || rt.m < 300) continue;
    d.sort((x, y) => x - y);
    obs.push({ type, m: rt.m, climb: rt.climb, sec: d[d.length >> 1], modelSec: rt.modelSec, n: d.length });
  }
  // least squares, weighted by rides: seconds = a + b · metres + c · metres climbed
  const fit = (o: Obs[]) => {
    const X = o.map((r) => [1, r.m, r.climb]), y = o.map((r) => r.sec), w = o.map((r) => r.n);
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
    X.forEach((x, i) => {
      for (let p = 0; p < 3; p++) {
        B[p] += w[i] * x[p] * y[i];
        for (let q = 0; q < 3; q++) A[p][q] += w[i] * x[p] * x[q];
      }
    });
    // Gaussian elimination
    for (let p = 0; p < 3; p++) {
      for (let r = p + 1; r < 3; r++) {
        const f = A[r][p] / A[p][p];
        for (let q = p; q < 3; q++) A[r][q] -= f * A[p][q];
        B[r] -= f * B[p];
      }
    }
    const c = [0, 0, 0];
    for (let p = 2; p >= 0; p--) c[p] = (B[p] - A[p].slice(p + 1).reduce((s, v, j) => s + v * c[p + 1 + j], 0)) / A[p][p];
    const n = w.reduce((a, v) => a + v, 0);
    const ratio = o.reduce((a, r) => a + r.n * (r.sec / r.modelSec), 0) / n;
    const flatKmh = 3.6 / c[1];
    return { pairs: o.length, rides: n, startSec: +c[0].toFixed(1), secPerM: +c[1].toFixed(4), secPerMClimbed: +c[2].toFixed(2), flatKmh: +flatKmh.toFixed(1), meanRatioToModelBike: +ratio.toFixed(3), meanKm: +(o.reduce((a, r) => a + r.n * r.m, 0) / n / 1000).toFixed(2) };
  };
  // the mean route length of rides between two stations, by bike (all riders)
  const tripKm: Record<string, { trips: number; km: number }> = {};
  for (const [k, n] of pairAll) {
    const [type, sa, sb] = k.split('|');
    const rt = route.get(sa)?.get(sb);
    if (!rt) continue;
    const e = (tripKm[type] ??= { trips: 0, km: 0 });
    e.trips += n;
    e.km += (n * rt.m) / 1000;
  }
  const meanKm = Object.fromEntries(Object.entries(tripKm).map(([k, v]) => [k, +(v.km / v.trips).toFixed(3)]));
  console.log(`mean route km between stations: ${JSON.stringify(meanKm)}`);
  const speeds = { classic: fit(obs.filter((r) => r.type === 'classic_bike')), electric: fit(obs.filter((r) => r.type === 'electric_bike')) };
  console.log(`speeds: ${JSON.stringify(speeds)}`);
  const median = (v: number[]) => (v.sort((a, b) => a - b), v[v.length >> 1] / 60);

  const per = (v: number) => +(v / D).toFixed(1);
  // SFMTA's counts for the same twelve months, by mode and operator
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const want = new Set(MONTHS.map((m) => `${MON[+m.slice(4) - 1]} ${m.slice(0, 4)}`));
  const sfmta: Record<string, number> = {};
  for (const line of fs.readFileSync(path.join(MM_RAW, 'sfmta-shared-trips.csv'), 'utf8').split('\n').slice(1)) {
    const f = splitCsv(line);
    if (f.length < 4 || !want.has(f[1])) continue;
    const k = `${f[0]} | ${f[2]}`;
    sfmta[k] = (sfmta[k] ?? 0) + Number(f[3].replace(/,/g, ''));
  }
  const days365 = (Date.parse(`${MONTHS[MONTHS.length - 1].slice(0, 4)}-${MONTHS[MONTHS.length - 1].slice(4)}-30`) - Date.parse(`${MONTHS[0].slice(0, 4)}-${MONTHS[0].slice(4)}-01`)) / 864e5 + 1;
  const scooters = Object.entries(sfmta).filter(([k]) => k.startsWith('Powered Scooter')).reduce((a, [, v]) => a + v, 0);
  const bwSfmta = Object.entries(sfmta).filter(([k]) => /Bicycle|E-Bike/.test(k)).reduce((a, [, v]) => a + v, 0);
  // a weekday's trips relative to the average day's, and the share of trips starting in the city
  // that end there too, from the Bay Wheels trips; applied to the scooters (assumed: the same weekly
  // rhythm; their service area is the city, so every trip ends in it)
  const weekdayRatio = sfStartsWeekday / D / (sfStartsAll / days365);
  const bothEnds = kept / sfStartsWeekday;
  console.log(`SFMTA counts ${JSON.stringify(sfmta)}; Bay Wheels trips starting in the city ${sfStartsAll} (SFMTA ${bwSfmta}); weekday / average day ${weekdayRatio.toFixed(3)}; both ends in the city ${bothEnds.toFixed(3)}`);
  const out = {
    source: "Lyft Bikes and Scooters, Bay Wheels system data (monthly trip histories), https://s3.amazonaws.com/baywheels-data/index.html; GBFS feed https://gbfs.lyft.com/gbfs/2.3/bay/gbfs.json",
    license: 'Data License Agreement, Lyft Bikes and Scooters, LLC (January 11, 2022; https://baywheels-assets.s3.amazonaws.com/data-license-agreement.html). Only aggregates computed from the trip histories are kept here, as source material for the model and its article; the trip records themselves are not redistributed.',
    months: `${MONTHS[0]}–${MONTHS[MONTHS.length - 1]}`,
    generated_by: 'server/beta3/pipeline/bikeshare.ts',
    universe: 'trips starting on a weekday (federal holidays and the day after Thanksgiving excluded) with both ends in San Francisco block groups; an end away from a station is spread over the zones of its 0.01° cell',
    weekdays: D,
    tripsAllDaysAllPlaces: total,
    weekday: {
      trips: per(kept),
      byHour: Array.from(hour, per),
      byHourType: Object.fromEntries(Object.entries(hourBy).map(([k, v]) => [k, Array.from(v, per)])),
      byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, per(v)])),
      byRider: Object.fromEntries(Object.entries(byRider).map(([k, v]) => [k, per(v)])),
      byTypeRider: Object.fromEntries(Object.entries(byTypeRider).map(([k, v]) => [k, per(v)])),
      ends: Object.fromEntries(Object.entries(docked).map(([k, v]) => [k, per(v)])),
      meanRouteKmBetweenStations: meanKm,
      medianMinutes: { classic: +median(durByType.classic_bike).toFixed(1), electric: +median(durByType.electric_bike).toFixed(1) },
    },
    system,
    sfmtaCounts: {
      source: "SFMTA, Shared Mobility Trips dashboard (https://www.sfmta.com/reports/shared-mobility-trips), table SharedMobilityTotalTripsTable.csv: trips by month of start, mode, and operator",
      months: [...want],
      days: days365,
      trips: sfmta,
      bayWheelsTripsStartingInCityFromTripData: sfStartsAll,
      weekdayToAverageDay: +weekdayRatio.toFixed(4),
      bothEndsInCityShare: +bothEnds.toFixed(4),
      scootersPerWeekday: Math.round((scooters / days365) * weekdayRatio),
      scooterNote: 'scooter trips a weekday: the twelve months’ trips over their days, times Bay Wheels’ ratio of a weekday’s trips to the average day’s (assumed to hold for scooters); scooters cannot leave the city',
    },
    speeds: { note: 'members’ rides between stations at least 300 m apart, each pair’s median ride (pairs with 5 or more rides) against its route on the street graph by the model’s bike route weights; least squares weighted by rides: seconds = start + secPerM · metres + secPerMClimbed · metres climbed. meanRatioToModelBike: ride time over the model’s own bike time on the same route (shared/beta3/geo.ts bikeSpeed).', ...speeds },
    nearStations: {
      radiusM: NEAR_STATION_M,
      note: 'trips with a station end within the radius of a rail or ferry station (ends away from stations have rounded coordinates and are not counted); AM 6–10am, PM 3–7pm by start time',
      tripsPerWeekday: per(railTrips),
      tripsPerWeekdayAM: per(railTripsAM),
      stations: rail.map((r, k) => ({ name: r.name, kinds: r.kinds, ...Object.fromEntries(Object.entries(railEnds[k]).map(([a, v]) => [a, per(v)])) })),
    },
    byNeighborhood: {
      neighborhoods: nhoods,
      od: [...od].map((v, i) => [Math.floor(i / NH), i % NH, per(v)]).filter((x) => x[2] >= 0.05),
      odClassic: [...odClassic].map((v, i) => [Math.floor(i / NH), i % NH, per(v)]).filter((x) => x[2] >= 0.05),
    },
    byZone: { origins: Array.from(zoneOrig, (v) => +(v / D).toFixed(2)), destinations: Array.from(zoneDest, (v) => +(v / D).toFixed(2)) },
  };
  fs.writeFileSync(`${REFERENCE}/bay-wheels-sf.json`, JSON.stringify(out, null, 1));
  console.log(`wrote reference/bay-wheels-sf.json: ${out.weekday.trips} trips a weekday; near rail/ferry ${out.nearStations.tripsPerWeekday} (AM ${out.nearStations.tripsPerWeekdayAM})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
