/**
 * Shared micromobility on the street network (after skims.ts; read by build.ts):
 *  - for every pair of city zones, the climb along the bike route that skims.ts finds (the same route
 *    weights) and the route's mean weight, so shared bikes' and scooters' riding times can be worked
 *    out from its length and climb (shared/beta3/micromobility.ts rideSec);
 *  - from each block of each zone, the walk on the street network to the nearest Bay Wheels station
 *    (GBFS snapshot, fetch-micromobility.ts);
 *  - the city's rail and ferry stations as places (bikeshare.ts cityStations), with the walk from each
 *    to its nearest Bay Wheels station, and the bike route between every zone and every place, both
 *    ways (length, climb, mean weight), for riding a shared bike or scooter to and from a station.
 * Writes data/beta3/work/micromob.json (+ .bin; a network variant's own, as skims.ts).
 *
 * Run: npx tsx server/beta3/pipeline/micromob-skims.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { bikeSpeed, toXY, walkSpeed } from '../../../shared/beta3/geo';
import { dijkstra, Graph, Snapper } from './graph';
import { RAW, REFERENCE, WORK, variantFile } from './paths';
import { TPERIODS } from '../../../shared/beta3/types';
import { PERIOD_BOUNDS } from '../../../shared/beta3/periods';
import { MM_RAW } from './fetch-micromobility';
import { cityStations } from './bikeshare';
import type { StreetEdge, StreetVertex } from './streets';
import type { InternalZone } from './zones';
import type { Line, Stop } from './transit';

const WALK_FLAT = 1.34;
/** walks to a station beyond this are not kept (seconds) */
const DOCK_WALK_MAX = 1800;
/** rides to and from a rail station considered (metres along the route) */
const RIDE_MAX_M = 8000;

type Arc = { a: number; b: number; cost: number; edge: number };

/**
 * When shared trips are made: each vehicle's share of its weekday trips in each assignment period, from
 * the Bay Wheels trip records by hour (reference/bay-wheels-sf.json); scooters take all Bay Wheels trips'
 * (SFMTA publishes no scooter trips by hour; assumed).
 */
function microTod(): Record<'classic' | 'ebike' | 'scooter', number[]> {
  const W = JSON.parse(fs.readFileSync(`${REFERENCE}/bay-wheels-sf.json`, 'utf8')).weekday;
  const inP = (h: number, [a, b]: [number, number]) => (a < b ? h >= a && h < b : h >= a || h < b);
  const fold = (hours: number[]) => {
    const v = TPERIODS.map(() => 0);
    hours.forEach((n, h) => (v[inP(h, PERIOD_BOUNDS.AM) ? 0 : inP(h, PERIOD_BOUNDS.MD) ? 1 : inP(h, PERIOD_BOUNDS.PM) ? 2 : 3] += n));
    const t = v.reduce((a, x) => a + x, 0);
    return v.map((x) => +(x / t).toFixed(4));
  };
  return { classic: fold(W.byHourType.classic_bike), ebike: fold(W.byHourType.electric_bike), scooter: fold(W.byHour) };
}

function main() {
  console.time('micromob-skims');
  const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  const Z = (JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8')) as { internal: InternalZone[] }).internal;
  const { stops, lines } = JSON.parse(fs.readFileSync(`${WORK}/${variantFile('transit.json')}`, 'utf8')) as { stops: Stop[]; lines: Line[] };
  const NV = vertices.length, NZ = Z.length;
  const vx = Float64Array.from(vertices, (v) => v.x), vy = Float64Array.from(vertices, (v) => v.y);

  // the bike graph with skims.ts's route weights; per arc its length, climb, and weighted length
  const fw: Arc[] = [], rv: Arc[] = [];
  const fLen: number[] = [], fUp: number[] = [], fFeel: number[] = [];
  const walkArcs: Arc[] = [];
  edges.forEach((e, k) => {
    const dz = vertices[e.b].z - vertices[e.a].z;
    const g = e.len > 5 ? dz / e.len : 0;
    if (e.walk) {
      const f = e.steps ? 1.15 : 1;
      walkArcs.push({ a: e.a, b: e.b, cost: (f * e.len) / walkSpeed(g, WALK_FLAT), edge: k }, { a: e.b, b: e.a, cost: (f * e.len) / walkSpeed(-g, WALK_FLAT), edge: k });
    }
    if (!e.bike) return;
    const feel = e.bikeway ? 0.8 : /^(primary|secondary|trunk)/.test(e.cls) ? 1.3 : 1;
    const fwdOk = !(e.car && e.oneway === -1 && !e.bikeway), backOk = !(e.car && e.oneway === 1 && !e.bikeway);
    const push = (a: number, b: number, gr: number, up: number) => {
      const cost = (feel * e.len) / bikeSpeed(gr);
      fw.push({ a, b, cost, edge: k });
      rv.push({ a: b, b: a, cost, edge: k });
      fLen.push(e.len), fUp.push(up), fFeel.push(feel * e.len);
    };
    if (fwdOk) push(e.a, e.b, g, Math.max(0, dz));
    if (backOk) push(e.b, e.a, -g, Math.max(0, -dz));
  });
  const G = new Graph(NV, fw), R = new Graph(NV, rv), W = new Graph(NV, walkArcs);
  const inOrder = (g: Graph, arcs: Arc[], v: number[]) => {
    const out = new Float32Array(arcs.length);
    const fill = g.start.slice(0, g.n);
    arcs.forEach((r, i) => (out[fill[r.a]++] = v[i]));
    return out;
  };
  const gLen = inOrder(G, fw, fLen), gUp = inOrder(G, fw, fUp), gFeel = inOrder(G, fw, fFeel);
  const rLen = inOrder(R, rv, fLen), rUp = inOrder(R, rv, fUp), rFeel = inOrder(R, rv, fFeel);

  // zones snap as in skims.ts: onto walkable street (not a station concourse) of the main network
  const walkVertex = new Uint8Array(NV);
  for (const e of edges) if (e.walk && !e.under) walkVertex[e.a] = walkVertex[e.b] = 1;
  const parent = Int32Array.from({ length: NV }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) (parent[i] = parent[parent[i]]), (i = parent[i]);
    return i;
  };
  for (let u = 0; u < NV; u++) for (let k = W.start[u]; k < W.start[u + 1]; k++) parent[find(u)] = find(W.to[k]);
  const size = new Map<number, number>();
  for (let i = 0; i < NV; i++) if (W.start[i + 1] > W.start[i]) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const big = new Set([...size].filter(([, n]) => n >= 150).map(([r]) => r));
  const walkSnap = new Snapper(vx, vy, (i) => walkVertex[i] === 1 && big.has(find(i)));
  const zoneV = Z.map((z) => walkSnap.nearest(z.x, z.y));
  // streets of the main network a bike can use (for the stations' end of a ride)
  const bikeVertex = new Uint8Array(NV);
  for (const e of edges) if (e.bike && !e.under) bikeVertex[e.a] = bikeVertex[e.b] = 1;
  const bikeSnap = new Snapper(vx, vy, (i) => bikeVertex[i] === 1 && walkVertex[i] === 1 && big.has(find(i)));

  const dist = new Float64Array(NV), aL = new Float64Array(NV), aU = new Float64Array(NV), aF = new Float64Array(NV);
  const run = (g: Graph, src: { i: number; d: number }, lenA: Float32Array, upA: Float32Array, feelA: Float32Array, limit: number) => {
    dijkstra(g, [[src.i, src.d / 4.5]], limit, dist, undefined, { arc: lenA, out: aL, init: [src.d] });
    dijkstra(g, [[src.i, src.d / 4.5]], limit, dist, undefined, { arc: upA, out: aU });
    dijkstra(g, [[src.i, src.d / 4.5]], limit, dist, undefined, { arc: feelA, out: aF, init: [src.d] });
  };
  const clamp16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));

  // ---- zone to zone: climb and mean route weight ----
  const bikeUp = new Uint16Array(NZ * NZ), bikeFeel = new Uint8Array(NZ * NZ).fill(100);
  for (let o = 0; o < NZ; o++) {
    run(G, zoneV[o], gLen, gUp, gFeel, 5400);
    for (let d = 0; d < NZ; d++) {
      if (d === o) continue;
      const t = zoneV[d].i, k = o * NZ + d;
      if (!(aL[t] < Infinity)) continue;
      bikeUp[k] = clamp16(aU[t] * 10);
      bikeFeel[k] = Math.max(50, Math.min(200, Math.round((100 * (aF[t] + zoneV[d].d)) / (aL[t] + zoneV[d].d))));
    }
  }
  console.log(`zone pairs: mean climb ${(bikeUp.reduce((a, v) => a + v, 0) / 10 / (NZ * NZ)).toFixed(1)} m`);

  // ---- Bay Wheels stations, and each block's walk to the nearest ----
  const gdir = fs.readdirSync(MM_RAW).filter((f) => f.startsWith('gbfs-')).sort().pop()!;
  const info = JSON.parse(fs.readFileSync(path.join(MM_RAW, gdir, 'station_information.json'), 'utf8')).data.stations as { short_name: string; lat: number; lon: number; capacity: number; region_id: string }[];
  const docks = info.filter((s) => s.region_id === '3').map((s) => {
    const [x, y] = toXY(s.lat, s.lon);
    return { x, y, cap: s.capacity };
  });
  dijkstra(W, docks.map((s) => {
    const v = walkSnap.nearest(s.x, s.y);
    return [v.i, v.d / WALK_FLAT] as [number, number];
  }), DOCK_WALK_MAX, dist);
  const dockWalk = new Float64Array(dist);
  const ptDock: number[] = [];
  for (const z of Z)
    for (const p of z.points) {
      const v = walkSnap.nearest(p.x, p.y);
      const t = dockWalk[v.i] + v.d / WALK_FLAT;
      ptDock.push(t <= DOCK_WALK_MAX ? Math.round(t) : 65535);
    }
  const within = (s: number) => ptDock.filter((t) => t <= s).length / ptDock.length;
  console.log(`Bay Wheels stations ${docks.length} (${docks.reduce((a, s) => a + s.cap, 0)} docks, GBFS ${gdir.slice(5)}); blocks within 5 / 10 minutes' walk of one: ${(100 * within(300)).toFixed(0)}% / ${(100 * within(600)).toFixed(0)}%`);

  // ---- rail and ferry stations: rides to and from every zone ----
  const ent = (JSON.parse(fs.readFileSync(path.join(RAW, 'osm-entrances.json'), 'utf8')).elements as { lat: number; lon: number }[]).map((e) => {
    const [x, y] = toXY(e.lat, e.lon);
    return { x, y };
  });
  // only stations in the city: Daly City BART and Bayshore Caltrain stand just outside it, where neither
  // Bay Wheels nor the city's scooter permits reach (ferry terminals stand on piers, off the land)
  const inRings = (lon: number, lat: number, rings: number[][][]) => {
    let inside = false;
    for (const r of rings)
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, ya] = r[a], [xb, yb] = r[b];
        if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
      }
    return inside;
  };
  const shapes = Z.map((z) => (z as unknown as { shape: number[][][] }).shape);
  const places = cityStations(stops, lines, ent, (s) => s.feed === 'ferry' || s.feed === 'ggt' || s.feed === 'shuttle' || shapes.some((sh) => inRings(s.lon, s.lat, sh)));
  const NP = places.length;
  const acc = new Uint16Array(NP * NZ * 3), egr = new Uint16Array(NP * NZ * 3);
  const placeDock: number[] = [];
  places.forEach((pl, p) => {
    // the walk from the station (its nearest point) to a Bay Wheels station
    placeDock.push(Math.min(65535, Math.round(Math.min(...pl.pts.map((q) => {
      const v = walkSnap.nearest(q.x, q.y);
      return dockWalk[v.i] + v.d / WALK_FLAT;
    })))));
    // the ride starts and ends on a street a bike can use (a plaza over a station may be walk-only)
    const v = bikeSnap.nearest(pl.x, pl.y);
    for (const [g, lenA, upA, feelA, out] of [[G, gLen, gUp, gFeel, egr], [R, rLen, rUp, rFeel, acc]] as const) {
      run(g, v, lenA, upA, feelA, 4000);
      for (let z = 0; z < NZ; z++) {
        const t = zoneV[z].i, k = (p * NZ + z) * 3;
        const m = aL[t] + zoneV[z].d;
        if (!(m < RIDE_MAX_M)) {
          out[k] = 65535;
          continue;
        }
        out[k] = clamp16(m / 10);
        out[k + 1] = clamp16(aU[t] * 10);
        out[k + 2] = Math.round((100 * (aF[t] + zoneV[z].d)) / m);
      }
    }
  });
  console.log(`stations ${NP}: ${places.map((p, i) => `${p.name} (${p.kinds.join('+')}, dock ${placeDock[i]} s)`).join('; ')}`);

  const blobs: Record<string, ArrayBufferView> = {
    bikeUp, bikeFeel, mmPtDock: Uint16Array.from(ptDock), mmAcc: acc, mmEgr: egr,
    mmDocks: Float32Array.from(docks.flatMap((s) => [s.x, s.y, s.cap])),
  };
  const index: Record<string, { type: string; offset: number; length: number }> = {};
  let off = 0;
  const parts: Buffer[] = [];
  for (const [k, a] of Object.entries(blobs)) {
    const buf = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    index[k] = { type: a.constructor.name, offset: off, length: (a as unknown as { length: number }).length };
    parts.push(buf);
    off += buf.length;
    const pad = (8 - (off % 8)) % 8;
    if (pad) parts.push(Buffer.alloc(pad)), (off += pad);
  }
  fs.writeFileSync(`${WORK}/${variantFile('micromob.bin')}`, Buffer.concat(parts));
  fs.writeFileSync(`${WORK}/${variantFile('micromob.json')}`, JSON.stringify({
    index,
    gbfs: gdir.slice(5),
    tod: microTod(),
    // each station's zone: the one whose block is nearest
    places: places.map((p, i) => {
      let zone = -1, bd = Infinity;
      Z.forEach((z, k) => z.points.forEach((q) => {
        const dd = Math.hypot(q.x - p.x, q.y - p.y);
        if (dd < bd) (bd = dd), (zone = k);
      }));
      return { name: p.name, kinds: p.kinds, stops: p.stops, x: Math.round(p.x), y: Math.round(p.y), dockSec: placeDock[i], zone };
    }),
  }));
  console.timeEnd('micromob-skims');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
