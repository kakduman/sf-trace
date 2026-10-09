/**
 * Step 6: level of service between zones, and how zones reach transit.
 *  - walking and cycling times on the street graph, slowed on hills;
 *  - driving times for each period, from speed limits, period congestion factors and delay at
 *    intersections (see AUTO below: these are assumptions, not measured speeds);
 *  - walk links from each zone's blocks to nearby stops, and walk transfers between stops;
 *  - for places outside the city, driving to San Francisco through its gateways (the bridges and
 *    the freeways south) and getting to the regional stations (BART, Caltrain, ferries, Golden Gate).
 * Writes data/beta3/work/skims.json (+ .bin with the matrices).
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/skims.ts
 */
import fs from 'node:fs';
import { bikeSpeed, toXY } from '../../../shared/beta3/geo';
import { platformSec } from '../../../shared/beta3/net';
import { dijkstra, Graph, Snapper } from './graph';
import { RAW, REFERENCE, WORK, variantFile } from './paths';
import { arcLengths, mainPieces, WALK_FLAT, walkGraph, type Arc as WalkArc } from './walk';
import type { StreetEdge, StreetVertex } from './streets';
import type { ExternalZone, InternalZone } from './zones';
import type { Line, Stop } from './transit';
import { EXT_BUS, EXT_DRIVE, EXT_WALK } from '../../../shared/beta3/net';
import { eastBayCorridor, eastBayCorridors, peninsulaCorridors, peninsulaSide, regionalLegSec, viaCrossingM, type ObservedSpeeds } from './regional-legs';

const readRef = (name: string) => (fs.existsSync(`${REFERENCE}/${name}`) ? JSON.parse(fs.readFileSync(`${REFERENCE}/${name}`, 'utf8')) : {});
/** observed freeway speeds (regional-legs.ts): down the Peninsula (peninsula-data.ts), and from the East Bay to the Bay Bridge (Alameda CTC) */
const PEN_SPEEDS: ObservedSpeeds | null = peninsulaCorridors(readRef('peninsula-traffic.json'));
const EB_SPEEDS: ObservedSpeeds | null = eastBayCorridors(readRef('eastbay-traffic.json'));

const AUTO_PERIODS = ['AM', 'MD', 'PM', 'EV'] as const; // EA uses EV
type AP = (typeof AUTO_PERIODS)[number];

/**
 * Driving speeds, fitted to observed San Francisco speeds (SFCTA Congestion Management Program 2025:
 * arterials AM 16.1 / PM 14.7 mph, freeways 32.7 / 23.9 mph, travel-time weighted; midday and
 * evening from SFCTA's INRIX hourly data: arterials 15.5 / 17.1, freeways 39.8 / 50.7 mph).
 * Surface streets cruise at 85% of the limit between intersections and lose the fitted seconds at
 * each intersection crossed; freeways run at the fitted share of the limit. Local streets have no
 * observed speeds: assumed 80% of the arterial speed (all-way stops).
 * See server/beta3/reference/sf-auto-speeds.json; refit with the scratchpad script in calibration notes.
 */
export const AUTO = {
  speedShare: {
    freeway: { AM: 0.632, MD: 0.769, PM: 0.462, EV: 0.979 },
    arterial: { AM: 0.85, MD: 0.85, PM: 0.85, EV: 0.85 },
    local: { AM: 0.85, MD: 0.85, PM: 0.85, EV: 0.85 },
  } as Record<string, Record<AP, number>>,
  /** seconds lost at each intersection crossed */
  delay: { freeway: 0, arterial: { AM: 3.6, MD: 4.1, PM: 4.7, EV: 2.9 }, local: { AM: 4.6, MD: 5.3, PM: 6.3, EV: 3.6 } } as Record<string, number | Record<AP, number>>,
};
const roadType = (cls: string) => (cls.startsWith('motorway') ? 'freeway' : /^(trunk|primary|secondary)/.test(cls) ? 'arterial' : 'local');

/**
 * Where drivers from outside enter the city. `out` is a point on the far side used to measure
 * the regional leg; `delay` adds the bridge or freeway queue by period (minutes, inbound/outbound).
 */
const GATEWAYS = [
  { name: 'Bay Bridge', lat: 37.7869, lon: -122.3907, out: { lat: 37.8247, lon: -122.3133 }, toll: 8.5, delayIn: { AM: 15, MD: 4, PM: 6, EV: 2 }, delayOut: { AM: 4, MD: 4, PM: 15, EV: 2 } },
  { name: 'Golden Gate Bridge', lat: 37.8034, lon: -122.4757, out: { lat: 37.8324, lon: -122.4795 }, toll: 10.25, delayIn: { AM: 6, MD: 2, PM: 2, EV: 1 }, delayOut: { AM: 2, MD: 2, PM: 7, EV: 1 } },
  { name: 'US-101 south', lat: 37.7105, lon: -122.3995, out: { lat: 37.6956, lon: -122.3925 }, route: 'US-101', toll: 0, delayIn: { AM: 8, MD: 2, PM: 3, EV: 1 }, delayOut: { AM: 3, MD: 2, PM: 8, EV: 1 } },
  { name: 'I-280 south', lat: 37.7085, lon: -122.4614, out: { lat: 37.6904, lon: -122.4628 }, route: 'I-280', toll: 0, delayIn: { AM: 6, MD: 2, PM: 2, EV: 1 }, delayOut: { AM: 2, MD: 2, PM: 6, EV: 1 } },
];
/**
 * average regional driving speed to a gateway (km/h; assumed) and road circuity. From the
 * Peninsula and the South Bay, US-101's and I-280's gateways are reached at the freeways' observed
 * speeds instead, and from the East Bay and beyond the Bay Bridge, each with no queue of its own
 * (regional-legs.ts): the assumed speed and queue (6 to 8 minutes) made a drive from Palo Alto to the
 * Financial District 88 minutes in the morning. The Golden Gate keeps the assumed speed and queue.
 */
const REGIONAL = { speed: { AM: 48, MD: 72, PM: 45, EV: 80 } as Record<AP, number>, circuity: 1.3 };

/**
 * Getting to a station outside the city by local bus: 10 minutes' walk and wait, then 16 km/h along
 * a road 1.4 times the straight line (assumed; AC Transit's and County Connection's scheduled
 * speeds are about 20 km/h).
 */
const busAccessSec = (d: number) => 600 + (d * 1.4) / (16 / 3.6);
/**
 * Driving to a station's lot: 5 minutes to park and walk to the fare gates, then the road distance
 * (1.3 times the straight line, the circuity of the regional legs) at 30 km/h for the first 3 km on
 * local streets and arterials and at the morning's regional speed (48 km/h, REGIONAL) beyond, where
 * the drive is mostly freeway. Assumed: no regional road network is built outside the city.
 */
const driveAccessSec = (d: number) => {
  const road = d * 1.3, local = Math.min(road, 3000);
  return 300 + local / (30 / 3.6) + (road - local) / (48 / 3.6);
};
const BUS_ACCESS_MAX = 720; // seconds (~0.6 mi at an average pace)
const RAIL_ACCESS_MAX = 1500;
const TRANSFER_MAX = 420;
/** metres: an entrance belongs to the nearest underground station within this of it; a station's platforms lie within STATION_SPAN of one another */
const ENTRANCE_REACH = 200, STATION_SPAN = 120;
/** metres from a platform's middle to its end: BART's 10-car platforms are 700 ft long, Muni Metro's take 4 cars of 75 ft */
const HALF_PLATFORM = { bart: 107, metro: 46 };
const ACC_THETA = 0.3; // PATH.accessTheta (shared/beta3/params.ts)
/** a zone's share living within reach of a stop, as seconds of walking (θ on doubled walk time) */
const shareSec = (r: number) => (-Math.log(Math.max(1e-3, Math.min(1, r))) / (ACC_THETA * 2)) * 60;

function main() {
  console.time('skims');
  const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  const zonesFile = JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8')) as { internal: InternalZone[]; external: ExternalZone[] };
  const Z = zonesFile.internal, X = zonesFile.external;
  const { stops, lines } = JSON.parse(fs.readFileSync(`${WORK}/${variantFile('transit.json')}`, 'utf8')) as { stops: Stop[]; lines: Line[] };
  const NV = vertices.length, NZ = Z.length;
  const vx = Float64Array.from(vertices, (v) => v.x), vy = Float64Array.from(vertices, (v) => v.y);

  // ---------- graphs ----------
  type Arc = WalkArc;
  const { g: walkG, len: walkArcLen } = walkGraph(vertices, edges);
  const bikeArcs: Arc[] = [];
  const bikeLen: number[] = [];
  edges.forEach((e, k) => {
    if (e.bike) {
      const dz = vertices[e.b].z - vertices[e.a].z;
      const g = e.len > 5 ? dz / e.len : 0;
      // perceived: bike lanes and paths feel shorter, busy arterials longer (route-choice weights)
      const feel = e.bikeway ? 0.8 : /^(primary|secondary|trunk)/.test(e.cls) ? 1.3 : 1;
      const fwdOk = !(e.car && e.oneway === -1 && !e.bikeway), backOk = !(e.car && e.oneway === 1 && !e.bikeway);
      if (fwdOk) bikeArcs.push({ a: e.a, b: e.b, cost: (feel * e.len) / bikeSpeed(g), edge: k }), bikeLen.push(e.len);
      if (backOk) bikeArcs.push({ a: e.b, b: e.a, cost: (feel * e.len) / bikeSpeed(-g), edge: k }), bikeLen.push(e.len);
    }
  });
  const bikeG = new Graph(NV, bikeArcs);
  const bikeArcLen = arcLengths(bikeG, bikeLen, bikeArcs);
  const carDeg = new Int32Array(NV);
  for (const e of edges) if (e.car) carDeg[e.a]++, carDeg[e.b]++;
  const carGraphs = {} as Record<AP, { fwd: Graph; rev: Graph; len: Float32Array; revLen: Float32Array }>;
  for (const p of AUTO_PERIODS) {
    const arcs: Arc[] = [], rarcs: Arc[] = [], lens: number[] = [];
    edges.forEach((e, k) => {
      if (!e.car) return;
      const t = roadType(e.cls);
      const v = (e.speed / 3.6) * AUTO.speedShare[t][p];
      const d = AUTO.delay[t];
      const delay = typeof d === 'number' ? d : d[p];
      const cost = (b: number) => e.len / v + (carDeg[b] >= 3 && !e.cls.startsWith('motorway') ? delay : 0);
      if (e.oneway !== -1) arcs.push({ a: e.a, b: e.b, cost: cost(e.b), edge: k }), rarcs.push({ a: e.b, b: e.a, cost: cost(e.b), edge: k }), lens.push(e.len);
      if (e.oneway !== 1) arcs.push({ a: e.b, b: e.a, cost: cost(e.a), edge: k }), rarcs.push({ a: e.a, b: e.b, cost: cost(e.a), edge: k }), lens.push(e.len);
    });
    const fwd = new Graph(NV, arcs), rev = new Graph(NV, rarcs);
    carGraphs[p] = { fwd, rev, len: arcLengths(fwd, lens, arcs), revLen: arcLengths(rev, lens, rarcs) };
  }
  console.log(`graphs: walk arcs ${walkG.to.length}, bike arcs ${bikeArcs.length}`);

  // walkers snap onto the street, never into a station concourse or a tunnel (the street-to-platform
  // time is net.ts platformSec), though they may walk through one; nor onto a raised walkway, such as
  // Embarcadero Center's podium deck, whose stairs reach the street at only a few corners
  const walkVertex = new Uint8Array(NV), carVertex = new Uint8Array(NV);
  for (const e of edges) {
    if (e.walk && !e.under && !e.above) walkVertex[e.a] = walkVertex[e.b] = 1;
    // drivers start from ordinary streets, not freeways
    if (e.car && !e.cls.startsWith('motorway') && !e.cls.startsWith('trunk_link')) carVertex[e.a] = carVertex[e.b] = 1;
  }
  // only snap onto the main connected network, never onto an isolated walkway or service road; and
  // for driving and cycling, onto the part that can be both reached and left (strongly connected):
  // the Presidio's and Treasure Island's one-way service roads had made four zones unreachable by
  // car, and a footway where bikes may not go had cut 39 zones off by bike
  const walkMain = mainPieces(walkG, 150), carMain = mainPieces(carGraphs.AM.fwd), bikeMain = mainPieces(bikeG);
  const bikeVertex = new Uint8Array(NV);
  for (const e of edges) if (e.bike && !e.under && !e.above) bikeVertex[e.a] = bikeVertex[e.b] = 1;
  const walkSnap = new Snapper(vx, vy, (i) => walkVertex[i] === 1 && walkMain[i] === 1);
  const carSnap = new Snapper(vx, vy, (i) => carVertex[i] === 1 && carMain[i] === 1);
  const bikeSnap = new Snapper(vx, vy, (i) => bikeVertex[i] === 1 && bikeMain[i] === 1);

  // ---------- zone-to-zone walking, cycling, driving ----------
  const zoneWalkV = Z.map((z) => walkSnap.nearest(z.x, z.y));
  const zoneCarV = Z.map((z) => carSnap.nearest(z.x, z.y));
  const zoneBikeV = Z.map((z) => bikeSnap.nearest(z.x, z.y));
  const walkSec = new Uint16Array(NZ * NZ), walkM = new Uint16Array(NZ * NZ), bikeSec = new Uint16Array(NZ * NZ), bikeM = new Uint16Array(NZ * NZ);
  const autoSec = {} as Record<AP, Uint16Array>;
  for (const p of AUTO_PERIODS) autoSec[p] = new Uint16Array(NZ * NZ);
  const autoDm = new Uint16Array(NZ * NZ); // tens of metres, morning paths
  const dist = new Float64Array(NV), aux = new Float64Array(NV);
  const clamp16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));
  // a trip within one zone: about half the zone's size, straight-ish
  const intraM = Z.map((z) => 0.5 * Math.sqrt(z.land));
  for (let o = 0; o < NZ; o++) {
    const s = zoneWalkV[o];
    dijkstra(walkG, [[s.i, s.d / WALK_FLAT]], 6000, dist, undefined, { arc: walkArcLen, out: aux, init: [s.d] });
    for (let d = 0; d < NZ; d++) {
      const t = zoneWalkV[d];
      const k = o * NZ + d;
      if (o === d) {
        walkSec[k] = clamp16(intraM[o] / WALK_FLAT);
        walkM[k] = clamp16(intraM[o]);
      } else {
        walkSec[k] = clamp16(dist[t.i] + t.d / WALK_FLAT);
        walkM[k] = clamp16(aux[t.i] + t.d);
      }
    }
    const sb = zoneBikeV[o];
    dijkstra(bikeG, [[sb.i, sb.d / 4.5]], 5400, dist, undefined, { arc: bikeArcLen, out: aux, init: [sb.d] });
    for (let d = 0; d < NZ; d++) {
      const t = zoneBikeV[d], k = o * NZ + d;
      if (o === d) {
        bikeSec[k] = clamp16(intraM[o] / 4);
        bikeM[k] = clamp16(intraM[o]);
      } else {
        bikeSec[k] = clamp16(dist[t.i] + t.d / 4.5);
        bikeM[k] = clamp16(aux[t.i] + t.d);
      }
    }
    for (const p of AUTO_PERIODS) {
      const c = zoneCarV[o];
      const G = carGraphs[p];
      dijkstra(G.fwd, [[c.i, c.d / 8]], 7200, dist, undefined, p === 'AM' ? { arc: G.len, out: aux, init: [c.d] } : undefined);
      for (let d = 0; d < NZ; d++) {
        const t = zoneCarV[d], k = o * NZ + d;
        if (o === d) {
          autoSec[p][k] = clamp16(intraM[o] / 6);
          if (p === 'AM') autoDm[k] = clamp16(intraM[o] / 10);
        } else {
          autoSec[p][k] = clamp16(dist[t.i] + t.d / 8);
          if (p === 'AM') autoDm[k] = clamp16((aux[t.i] + t.d) / 10);
        }
      }
    }
    if (o % 100 === 0) console.log(`  zone ${o}/${NZ}`);
  }

  // ---------- external zones: driving through the gateways ----------
  const NX = X.length;
  const extAutoIn = {} as Record<AP, Uint16Array>, extAutoOut = {} as Record<AP, Uint16Array>;
  const extDmIn = new Uint16Array(NX * NZ), extDmOut = new Uint16Array(NX * NZ);
  const extTollIn = new Float32Array(NX * NZ), extTollOut = new Float32Array(NX * NZ);
  const gwV = GATEWAYS.map((g) => {
    const [x, y] = toXY(g.lat, g.lon);
    return new Snapper(vx, vy, (i) => edges.length > 0 && carVertex[i] === 1 || false).nearest(x, y);
  });
  // gateway ↔ zone driving inside the city, per period
  const gwIn: Record<AP, Float64Array[]> = {} as never, gwOut: Record<AP, Float64Array[]> = {} as never, gwDin: Float64Array[] = [], gwDout: Float64Array[] = [];
  for (const p of AUTO_PERIODS) {
    gwIn[p] = [];
    gwOut[p] = [];
    GATEWAYS.forEach((_, g) => {
      const G = carGraphs[p];
      dijkstra(G.fwd, [[gwV[g].i, 0]], 7200, dist, undefined, p === 'AM' ? { arc: G.len, out: aux } : undefined);
      gwIn[p][g] = Float64Array.from(Z, (_, d) => dist[zoneCarV[d].i] + zoneCarV[d].d / 8);
      if (p === 'AM') gwDin[g] = Float64Array.from(Z, (_, d) => aux[zoneCarV[d].i] + zoneCarV[d].d);
      dijkstra(G.rev, [[gwV[g].i, 0]], 7200, dist, undefined, p === 'AM' ? { arc: G.revLen, out: aux } : undefined);
      gwOut[p][g] = Float64Array.from(Z, (_, d) => dist[zoneCarV[d].i] + zoneCarV[d].d / 8);
      if (p === 'AM') gwDout[g] = Float64Array.from(Z, (_, d) => aux[zoneCarV[d].i] + zoneCarV[d].d);
    });
  }
  for (const p of AUTO_PERIODS) {
    extAutoIn[p] = new Uint16Array(NX * NZ);
    extAutoOut[p] = new Uint16Array(NX * NZ);
  }
  X.forEach((xz, e) => {
    // west of the Bay, the drive to US-101's and I-280's gateways is down the Peninsula's freeways;
    // east of it, the drive to the Bay Bridge is along the zone's corridor in Alameda County
    const westSide = peninsulaSide(xz.lat, xz.lon);
    const ebRoute = eastBayCorridor(xz.lat, xz.lon);
    const regional = GATEWAYS.map((g) => {
      const [ox, oy] = toXY(g.out.lat, g.out.lon);
      const [gx, gy] = toXY(g.lat, g.lon);
      // to the far side of the gateway, then across it; from east of the Bay to a gateway other than
      // the Bay Bridge, through one of the Bay's other crossings rather than across the water
      const toOut = ebRoute && g.name !== 'Bay Bridge' ? viaCrossingM([xz.lat, xz.lon], [g.out.lat, g.out.lon], toXY, REGIONAL.circuity) : REGIONAL.circuity * Math.hypot(xz.x - ox, xz.y - oy);
      return toOut + Math.hypot(ox - gx, oy - gy);
    });
    for (let d = 0; d < NZ; d++) {
      for (const p of AUTO_PERIODS) {
        let bestIn = Infinity, bestOut = Infinity, gIn = 0, gOut = 0;
        GATEWAYS.forEach((g, k) => {
          const gr = (g as { route?: string }).route;
          const route = westSide && gr ? gr : ebRoute && g.name === 'Bay Bridge' ? ebRoute : undefined;
          const obs = westSide && gr ? PEN_SPEEDS : ebRoute && g.name === 'Bay Bridge' ? EB_SPEEDS : null;
          const observed = !!(route && obs?.routes[route]);
          const legIn = regionalLegSec(regional[k], route, p, 'in', REGIONAL.speed, obs),
            legOut = regionalLegSec(regional[k], route, p, 'out', REGIONAL.speed, obs);
          // (INRIX's speeds include the queues at the county line and at the Bay Bridge's toll plaza)
          const tin = legIn + (observed ? 0 : g.delayIn[p] * 60) + gwIn[p][k][d] + g.toll * 30; // a toll is worth ~ half a minute per dollar in routing
          const tout = legOut + (observed ? 0 : g.delayOut[p] * 60) + gwOut[p][k][d];
          if (tin < bestIn) (bestIn = tin), (gIn = k);
          if (tout < bestOut) (bestOut = tout), (gOut = k);
        });
        const i = e * NZ + d;
        extAutoIn[p][i] = clamp16(bestIn - GATEWAYS[gIn].toll * 30);
        extAutoOut[p][i] = clamp16(bestOut);
        if (p === 'AM') {
          extDmIn[i] = clamp16((regional[gIn] + gwDin[gIn][d]) / 10);
          extDmOut[i] = clamp16((regional[gOut] + gwDout[gOut][d]) / 10);
          // bridges collect tolls into the city only (westbound Bay Bridge, southbound Golden Gate)
          extTollIn[i] = GATEWAYS[gIn].toll;
          extTollOut[i] = 0;
        }
      }
    }
  });

  // ---------- zones to stops: walking ----------
  const stopV = stops.map((s) => walkSnap.nearest(s.x, s.y));
  const inCity = (s: Stop) => s.lat > 37.69 && s.lat < 37.84 && s.lon > -122.53 && s.lon < -122.35;
  const linesAt: number[][] = stops.map(() => []);
  lines.forEach((l, li) => new Set(l.stops).forEach((s) => linesAt[s].push(li)));
  const BUS_FEEDS = new Set(['muni', 'ggt', 'ac', 'samtrans', 'tma', 'shuttle']);
  const isFerry = (s: number) => linesAt[s].some((li) => lines[li].mode === 'ferry');
  const isRail = (s: number) => !BUS_FEEDS.has(stops[s].feed) || stops[s].station || linesAt[s].some((li) => ['lightrail', 'cablecar', 'streetcar', 'ferry'].includes(lines[li].mode));
  // An underground station is reached from the street at its mapped entrances (OpenStreetMap
  // railway=subway_entrance; fetch-osm.ts). Market Street's stations are long: Embarcadero's run
  // from Drumm Street to Main and Beale, Montgomery's from Post and New Montgomery to Sansome and
  // Sutter, 100–170 m from the platform's middle. An entrance belongs to the underground stops
  // nearest it (BART's platform and Muni Metro's share a concourse and its entrances). Inside, a
  // rider entering beyond the end of the platform walks along the concourse to it.
  const entrances = fs.existsSync(`${RAW}/osm-entrances.json`)
    ? (JSON.parse(fs.readFileSync(`${RAW}/osm-entrances.json`, 'utf8')).elements as { type: string; lat: number; lon: number }[]).filter((e) => e.type === 'node').map((e) => {
        const [x, y] = toXY(e.lat, e.lon);
        return { x, y };
      })
    : [];
  // underground stations (Market Street's BART and Muni Metro, the Mission and Glen Park BART
  // stations, the Twin Peaks tunnel and the Central Subway)
  const deep = stops.map((st) => inCity(st) && platformSec(st) >= 45);
  // a station: its underground platforms within STATION_SPAN of one another (BART's and Muni
  // Metro's at Market Street's four, both of Muni's directions)
  const deepIdx = stops.map((_, s) => s).filter((s) => deep[s]);
  const group = new Map(deepIdx.map((s) => [s, s]));
  const root = (s: number): number => (group.get(s) === s ? s : root(group.get(s)!));
  for (const a of deepIdx) for (const b of deepIdx) if (a < b && Math.hypot(stops[a].x - stops[b].x, stops[a].y - stops[b].y) <= STATION_SPAN) group.set(root(a), root(b));
  // an entrance belongs to the station nearest it, to all of its platforms
  const entranceOf: number[][] = stops.map(() => []);
  entrances.forEach((e, k) => {
    let d0 = Infinity, near = -1;
    for (const s of deepIdx) {
      const d = Math.hypot(stops[s].x - e.x, stops[s].y - e.y);
      if (d < d0) (d0 = d), (near = s);
    }
    if (d0 > ENTRANCE_REACH) return;
    for (const s of deepIdx) if (root(s) === root(near)) entranceOf[s].push(k);
  });
  const halfPlatform = (s: number) => (stops[s].feed === 'bart' ? HALF_PLATFORM.bart : HALF_PLATFORM.metro);
  // the platforms of one station share an entrance: riders change between them inside (net.ts adds
  // each platform's time from the concourse)
  const sameStation = (s: number, t: number) => entranceOf[s].some((k) => entranceOf[t].includes(k));
  // Other stops reach the street from every walkable point near them (80 m for a station without
  // mapped entrances, 30 m for a stop), each at its straight-line walk, and not only from the
  // nearest: the nearest is often the dead end of an unmapped plaza or station path (Civic Center's
  // was 2.7 times as far round by the network as in a straight line)
  let byEntrance = 0;
  const stopSeeds = stops.map((st, k) => {
    const ent = entranceOf[k]
      .map((q) => {
        const e = entrances[q];
        const v = walkSnap.nearest(e.x, e.y);
        // the walk inside, along the concourse beyond the platform's end, counts as distance
        const inside = Math.max(0, Math.hypot(e.x - st.x, e.y - st.y) - halfPlatform(k));
        return v.d <= 40 ? { i: v.i, d: v.d + inside } : null;
      })
      .filter((v): v is { i: number; d: number } => v !== null);
    if (ent.length) {
      byEntrance++;
      return ent;
    }
    const near = walkSnap.within(st.x, st.y, isRail(k) ? 80 : 30);
    return near.length ? near : [stopV[k]];
  });
  console.log(`station entrances ${entrances.length}; ${byEntrance} underground stops reached by theirs`);
  // points of each zone, snapped
  const zonePts = Z.map((z) => {
    const pts = z.points.map((p) => ({ v: walkSnap.nearest(p.x, p.y), w: p.w }));
    const W = pts.reduce((s, p) => s + p.w, 0);
    return { pts, W };
  });
  // candidate zone→stop times
  const cand: Map<number, number>[] = Z.map(() => new Map());
  const weak: Map<number, number>[] = Z.map(() => new Map());
  // and each block's own walk to the stop (seconds; 65535 beyond reach), for choosing a stop block
  // by block (PATH.blockAccess in shared/beta3/params.ts)
  const blockSec: Map<number, Uint16Array>[] = Z.map(() => new Map());
  const transfers: [number, number, number][] = [];
  const nearStops = new Snapper(Float64Array.from(stops, (s) => s.x), Float64Array.from(stops, (s) => s.y), () => true, 400);
  void nearStops;
  for (let s = 0; s < stops.length; s++) {
    if (!inCity(stops[s])) continue;
    const rail = isRail(s);
    const max = rail ? RAIL_ACCESS_MAX : BUS_ACCESS_MAX;
    // reverse search would be exact for one-way slopes; walking graphs are near-symmetric, so search from the stop
    dijkstra(walkG, stopSeeds[s].map((v) => [v.i, v.d / WALK_FLAT] as [number, number]), max + 300, dist);
    for (let z = 0; z < NZ; z++) {
      const zp = zonePts[z];
      // quick reject: the zone centre far beyond reach
      if (Math.hypot(Z[z].x - stops[s].x, Z[z].y - stops[s].y) > max * WALK_FLAT * 1.1 + 500) continue;
      // walk-access share (TM1, STOPS): the mean walk of the blocks within reach of the stop, plus
      // −ln(share within reach)/θ, so the zone's logit over its stops sends riders to each stop in
      // proportion to how much of the zone lives near it
      let accT = 0, reach = 0;
      const bs = new Uint16Array(zp.pts.length).fill(65535);
      zp.pts.forEach((p, q) => {
        const t = dist[p.v.i] + p.v.d / WALK_FLAT;
        if (t <= max) (reach += p.w), (accT += p.w * t), (bs[q] = Math.round(t));
      });
      const tz = reach > 0 ? accT / reach + shareSec(reach / zp.W) : Infinity;
      if (reach > 0) blockSec[z].set(s, bs);
      // enough of the zone must be within reach (or, failing that, some of it: see the fallback below)
      if (reach / zp.W >= 0.15) cand[z].set(s, tz);
      else if (reach > 0) weak[z].set(s, tz);
    }
    // walk transfers to nearby stops serving other lines
    for (let t = 0; t < stops.length; t++) {
      if (t === s || !inCity(stops[t])) continue;
      if (Math.abs(stops[t].x - stops[s].x) > 600 || Math.abs(stops[t].y - stops[s].y) > 600) continue;
      // between the platforms of one station, inside it (net.ts adds both platforms' times)
      const tt = sameStation(s, t) ? 0 : Math.min(...stopSeeds[t].map((v) => dist[v.i] + v.d / WALK_FLAT));
      const limit = rail || isRail(t) ? TRANSFER_MAX : 300;
      if (tt > limit) continue;
      const a = linesAt[s].map((l) => lines[l].route).sort().join(), b = linesAt[t].map((l) => lines[l].route).sort().join();
      if (a === b) continue; // same routes both sides: nothing to change to
      transfers.push([s, t, Math.round(tt)]);
    }
  }
  // outside the city there is no street graph: changing between operators there (SMART to the
  // Larkspur ferry, BART to Caltrain at Millbrae, Golden Gate buses to SMART at San Rafael) walks
  // the straight line × 1.3, up to 600 m, when one side is a station or terminal
  {
    const out = stops.map((s, k) => k).filter((k) => !inCity(stops[k]));
    let n = 0;
    for (const s of out)
      for (const t of out) {
        // between operators (Golden Gate's buses and its ferries count as two)
        if (s === t || (stops[s].feed === stops[t].feed && isFerry(s) === isFerry(t))) continue;
        if (!(isRail(s) || isRail(t) || isFerry(s) || isFerry(t))) continue;
        const d = Math.hypot(stops[t].x - stops[s].x, stops[t].y - stops[s].y);
        if (d > 600) continue;
        const a = linesAt[s].map((l) => lines[l].route).sort().join(), b = linesAt[t].map((l) => lines[l].route).sort().join();
        if (a === b) continue;
        transfers.push([s, t, Math.round((d * 1.3) / WALK_FLAT)]);
        n++;
      }
    console.log(`walk transfers outside the city: ${n}`);
  }
  // underground connections the street network does not have: the Central Subway's Union
  // Square/Market Street station reaches the Powell Street station's mezzanine (BART and Muni Metro)
  // through a concourse outside fare control (SFMTA, Union Square–Market Street Station fact sheet,
  // 2012). By the street the T and BART platforms were beyond the transfer limit, so no T rider
  // could change to or from BART there. About 200 m of concourse; platform times are added in net.ts.
  {
    const CONCOURSES: [RegExp, RegExp, number][] = [[/^Union Square\/Market St Station/, /^(Powell Street|Metro Powell Station)/, 150]];
    for (const [a, b, sec] of CONCOURSES)
      for (let s = 0; s < stops.length; s++) {
        if (!a.test(stops[s].name)) continue;
        for (let t = 0; t < stops.length; t++) {
          if (!b.test(stops[t].name) || Math.hypot(stops[t].x - stops[s].x, stops[t].y - stops[s].y) > 500) continue;
          for (const [f, g] of [[s, t], [t, s]]) {
            const k = transfers.findIndex((x) => x[0] === f && x[1] === g);
            if (k >= 0) transfers[k][2] = Math.min(transfers[k][2], sec);
            else transfers.push([f, g, sec]);
          }
        }
      }
  }
  // a big or awkward zone where no stop serves most of it: use the stops that serve part of it
  for (let z = 0; z < NZ; z++) if (!cand[z].size) cand[z] = weak[z];
  // keep, for each zone, the nearest few stops of every line (up to 3, within 5 minutes' walk of
  // the nearest), plus all rail stations in reach. People in a block group live along its length,
  // so a line's next stop along is a real choice for some of them; with only the nearest stop,
  // stops nobody is "nearest" to would get no riders at all.
  const PER_LINE = 3, EXTRA_SEC = 300;
  const connectors: [number, number, number][] = [];
  // per connector, the walk from each of its zone's blocks (zone points, in order), seconds
  const connectorPts: number[] = [];
  for (let z = 0; z < NZ; z++) {
    const keep = new Set<number>();
    const byLine = new Map<number, [number, number][]>();
    for (const [s, t] of cand[z]) {
      if (stops[s].station) keep.add(s);
      for (const l of linesAt[s]) {
        if (!byLine.has(l)) byLine.set(l, []);
        byLine.get(l)!.push([s, t]);
      }
    }
    for (const list of byLine.values()) {
      list.sort((a, b) => a[1] - b[1]);
      for (const [s, t] of list.slice(0, PER_LINE)) if (t <= list[0][1] + EXTRA_SEC) keep.add(s);
    }
    // and every block's nearest stop on each line in its reach, even one that reaches little of the
    // zone: riders choose their stop block by block (PATH.blockAccess), so a line along one edge of a
    // zone is a real choice for the blocks beside it
    const all = new Map([...weak[z], ...cand[z]]);
    const lineStops = new Map<number, number[]>();
    for (const s of all.keys()) for (const l of linesAt[s]) (lineStops.get(l) ?? lineStops.set(l, []).get(l)!).push(s);
    const nb = zonePts[z].pts.length;
    for (const list of lineStops.values())
      for (let q = 0; q < nb; q++) {
        let best = -1, bt = 65535;
        for (const s of list) {
          const t = blockSec[z].get(s)![q];
          if (t < bt) (bt = t), (best = s);
        }
        if (best >= 0) keep.add(best);
      }
    for (const s of keep) {
      connectors.push([z, s, Math.round(all.get(s)!)]);
      for (const t of blockSec[z].get(s)!) connectorPts.push(t);
    }
  }
  const zonesWithout = Z.filter((_, z) => !connectors.some((c) => c[0] === z)).length;
  console.log(`connectors ${connectors.length} (${(connectors.length / NZ).toFixed(1)} per zone; ${zonesWithout} zones with no stop in reach), transfers ${transfers.length}`);

  // ---------- park-and-ride: which outside stations have parking, and its daily fee ----------
  // (station-parking.json: BART's GIS layer and fee table, Caltrain station pages, ferry operators).
  // A lot with a known fee but no count still counts as a lot; Sausalito's are city lots, priced at
  // the lowest off-peak daily maximum.
  const parking = (() => {
    const P = JSON.parse(fs.readFileSync(`${REFERENCE}/station-parking.json`, 'utf8'));
    const norm = (n: string) => n.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/caltrain|station|ferry terminal|ferry|bart|terminal|smart/g, ' ').replace(/street|st\./g, 'st').replace(/[^a-z0-9]+/g, ' ').trim();
    const out: { feed: string; key: string; fee: number; spaces: number | null }[] = [];
    for (const b of P.bart.stations) if (!b.inSanFrancisco && !b.noBartParking && (b.spaces_bartGIS > 0 || b.fee_dailyUSD != null)) out.push({ feed: 'bart', key: norm(b.name), fee: b.fee_dailyUSD ?? 3.4, spaces: b.spaces_bartGIS || null });
    for (const c of P.caltrain.stations) if (!c.inSanFrancisco && (c.spaces > 0 || (c.fee_dailyUSD != null && c.spaces !== null))) out.push({ feed: 'caltrain', key: norm(c.name), fee: c.fee_dailyUSD ?? 0, spaces: c.spaces || null });
    for (const f of P.ferries) {
      let fee = f.fee_dailyUSD as number | null;
      if (fee == null && f.feeDetail?.offPeak_Oct1_Apr30) fee = Math.min(...Object.values(f.feeDetail.offPeak_Oct1_Apr30 as Record<string, { maxPerDayUSD: number }>).map((x) => x.maxPerDayUSD));
      if (f.spaces > 0 || fee != null) out.push({ feed: 'ferry', key: norm(f.terminal), fee: fee ?? 0, spaces: f.spaces || null });
    }
    // SMART: free day-use lots at ten stations (SMART's parking page; no space counts)
    for (const m of P.smart?.stations ?? []) out.push({ feed: 'smart', key: norm(m.name), fee: m.fee_dailyUSD ?? 0, spaces: m.spaces || null });
    const find = (s: Stop, ferry: boolean) => {
      const feed = ferry ? 'ferry' : s.feed;
      const n = norm(s.name);
      return out.find((o) => o.feed === feed && (n === o.key || n.startsWith(o.key + ' ') || o.key.startsWith(n + ' ') || n.split(' ')[0] === o.key.split(' ')[0] && n.split(' ')[1] === o.key.split(' ')[1])) ?? null;
    };
    const of = (s: Stop, ferry: boolean): number | null => find(s, ferry)?.fee ?? null;
    const spaces = (s: Stop, ferry: boolean): number | null => find(s, ferry)?.spaces ?? null;
    return { of, spaces };
  })();

  // ---------- external zones to regional stations ----------
  // Getting to a stop from a place outside the city: walk if close, else drive and park, or a local
  // bus. Each zone's commuters live in many places, so the access time to a stop is a logsum over
  // the zone's commuter cells (zones.ts), with the same dispersion as the choice among access stops;
  // like TM1's walk-access shares, a stop a few blocks from some of the zone counts for those people.
  const THETA = ACC_THETA, W_ACC = 2; // PATH.walkWeight
  // (zone, stop, access seconds, parking cents per leg, activity-end seconds, kind: net.ts EXT_*)
  const extConnectors: [number, number, number, number, number, number][] = [];
  // a dollar as seconds of (walk-weighted) access time: 1/PATH.votPerMin minutes, halved by the walk weight
  const FEE_SEC_PER_DOLLAR = (3 * 60) / W_ACC;
  // which stations have a lot comes from the parking table, which leaves out the city's own: Daly
  // City BART (2,047 spaces) sits just inside the box used for the city's walk access, but its lot is
  // in Daly City and serves Daly City and Pacifica
  const parkFee = stops.map((s, k) => (BUS_FEEDS.has(s.feed) && !isFerry(k) ? null : parking.of(s, isFerry(k))));
  // spaces at each lot (BART's GIS layer, Caltrain's station pages, the ferry operators), for the
  // park-and-ride capacity constraint (net.ts lot prices)
  const lots: [number, number, number][] = [];
  stops.forEach((s, k) => {
    const sp = parkFee[k] === null ? null : parking.spaces(s, isFerry(k));
    if (sp) lots.push([k, sp, parkFee[k]!]);
  });
  {
    const lots = stops.map((s, k) => [s, parkFee[k]] as const).filter(([, f]) => f !== null);
    console.log(`park-and-ride stops: ${lots.length} (${[...new Set(lots.map(([s, f]) => `${s.name} $${f}`))].slice(0, 80).join(', ')})`);
  }

  X.forEach((xz, e) => {
    const airport = (xz as ExternalZone).id === 'SFO';
    const pts = (xz as ExternalZone).points?.length ? (xz as ExternalZone).points! : [{ x: xz.x, y: xz.y, w: 1 }];
    const W = pts.reduce((a, p) => a + p.w, 0);
    // [stop, access s, parking cents per leg, activity-end s, kind]
    const options: [number, number, number, number, number][] = [];
    stops.forEach((s, k) => {
      // the city's shuttles (feeds 'tma' and 'shuttle') are local services, like Muni's stops
      const regional = (s.feed !== 'muni' && s.feed !== 'tma' && s.feed !== 'shuttle') || (s.station && !inCity(s));
      const d0 = Math.hypot(s.x - xz.x, s.y - xz.y);
      if (!regional && !(d0 < 4000 && !inCity(s))) return;
      if (d0 > 25_000) return;
      // drive and park only where there is a lot (half the daily fee on each leg)
      const fee = !BUS_FEEDS.has(s.feed) || isFerry(k) ? parkFee[k] : null;
      // three ways in, each its own access link so the zone's riders split among them by their
      // cost (a logit, as among stops): on foot, for the commuters near the stop (the walk-access
      // share); by local bus, for anyone in the zone; and by car to the lot, for anyone in the zone
      // with a car (the home end only). Times are the mean over the zone's commuter cells.
      let wT = 0, wR = 0, bT = 0, dT = 0;
      for (const p of pts) {
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d <= 1500) (wR += p.w), (wT += p.w * ((d * 1.3) / WALK_FLAT));
        bT += p.w * busAccessSec(d);
        dT += p.w * driveAccessSec(d);
      }
      if (wR > 0) {
        const t = wT / wR + shareSec(wR / W);
        options.push([k, t, 0, t, EXT_WALK]);
      }
      // the airport is reached on foot or by AirTrain from its own stops: an air traveler has no car
      // at a station nearby, and no bus links one to the terminals
      if (airport) return;
      options.push([k, bT / W, 0, bT / W, EXT_BUS]);
      if (fee != null) options.push([k, dT / W, (fee / 2) * 100, bT / W, EXT_DRIVE]);
    });
    // the closest few of each operator and way in (an operator's ferry docks apart from its bus
    // stops), ranked by perceived cost (time plus the parking fee); TM1 drives to the four closest lots
    const byFeed = new Map<string, [number, number, number, number, number][]>();
    for (const o of options) {
      const f = `${stops[o[0]].feed}${isFerry(o[0]) ? ':ferry' : ''}:${o[4]}`;
      if (!byFeed.has(f)) byFeed.set(f, []);
      byFeed.get(f)!.push(o);
    }
    for (const list of byFeed.values())
      for (const [k, t, cents, tE, kind] of list.sort((a, b) => a[1] + (a[2] / 100) * FEE_SEC_PER_DOLLAR - (b[1] + (b[2] / 100) * FEE_SEC_PER_DOLLAR)).slice(0, 6))
        if (t < 3600) extConnectors.push([e, k, Math.round(t), Math.round(cents), Math.round(Math.min(tE, 7200)), kind]);
  });
  console.log(`external connectors ${extConnectors.length}`);

  // ---------- write ----------
  const blobs: Record<string, ArrayBufferView> = { walkSec, walkM, bikeSec, bikeM, autoDm, extDmIn, extDmOut, extTollIn, extTollOut, connectorPts: Uint16Array.from(connectorPts) };
  for (const p of AUTO_PERIODS) {
    blobs[`autoSec_${p}`] = autoSec[p];
    blobs[`extAutoIn_${p}`] = extAutoIn[p];
    blobs[`extAutoOut_${p}`] = extAutoOut[p];
  }
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
  fs.writeFileSync(`${WORK}/${variantFile('skims.bin')}`, Buffer.concat(parts));
  fs.writeFileSync(`${WORK}/${variantFile('skims.json')}`, JSON.stringify({ NZ, NX, index, connectors, transfers, extConnectors, lots, gateways: GATEWAYS.map((g) => g.name) }));

  // a few checks against common experience
  const zi = (name: string) => Z.findIndex((z) => z.nhood === name);
  const pairs: [string, string][] = [['Sunset/Parkside', 'Financial District/South Beach'], ['Mission', 'Financial District/South Beach'], ['Marina', 'Mission'], ['Bayview Hunters Point', 'Financial District/South Beach']];
  for (const [a, b] of pairs) {
    const o = zi(a), d = zi(b);
    if (o < 0 || d < 0) continue;
    const k = o * NZ + d;
    console.log(`${a} → ${b}: walk ${(walkSec[k] / 60).toFixed(0)} min (${(walkM[k] / 1000).toFixed(1)} km), bike ${(bikeSec[k] / 60).toFixed(0)} min, drive AM ${(autoSec.AM[k] / 60).toFixed(0)} / MD ${(autoSec.MD[k] / 60).toFixed(0)} min (${(autoDm[k] / 100).toFixed(1)} km)`);
  }
  const oak = X.findIndex((x) => x.name === 'Oakland'), fd = zi('Financial District/South Beach');
  if (oak >= 0 && fd >= 0) console.log(`Oakland → Financial District drive AM ${(extAutoIn.AM[oak * NZ + fd] / 60).toFixed(0)} min, MD ${(extAutoIn.MD[oak * NZ + fd] / 60).toFixed(0)} min, toll $${extTollIn[oak * NZ + fd]}`);
  console.timeEnd('skims');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
