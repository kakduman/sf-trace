/**
 * The road network for traffic assignment (client/beta3/model/roads.bin.gz): OpenStreetMap's
 * drivable streets (streets.json, without service roads), each block's free-flow time from its
 * speed limit and the control at its far end (traffic signals and stop signs from OSM), capacity
 * from its general-purpose lanes (OSM lanes, less bus lanes) and TM1's capacity per lane by facility
 * and area type, Akçelik or BPR delay as TM1 sets them; chains of blocks without a junction joined
 * into one link; centroid connectors from each zone's blocks; outside zones joined to the roads that
 * cross the city line (the bridges and the San Mateo County line) by their regional leg.
 * Also maps the counts the assignment is tested against onto links: Caltrans 2023 AADT on the state
 * highways, SFMTA's 2021–23 weekday counts, and SFCTA's CMP segments (2025 INRIX speeds).
 *
 * Run (after build.ts): npx tsx server/beta3/pipeline/roads.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { toXY } from '../../../shared/beta3/geo';
import { RCLS, ROUTE_VOT, VDF_AKCELIK, VDF_FIXED, VDF_FREEWAY, type CmpSegment, type Gateway, type RoadCount, type RoadHeader } from '../../../shared/beta3/roads';
import { TPERIODS, type TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, RAW, REFERENCE, WORK } from './paths';
import { corridorCarriageways, corridorSegments, PEN_CUTS, type PenRoute } from './peninsula';
import { eastBayCorridor, eastBayCorridors, peninsulaCorridors, peninsulaSide, regionalLegSec, type ObservedSpeeds, type SkimPeriod } from './regional-legs';
import { loadBundle } from './run-base';
import type { StreetEdge, StreetVertex } from './streets';

const ROADS_RAW = `${RAW}/roads`;
const cls = (c: string): number => {
  if (c === 'motorway') return 1;
  if (c === 'motorway_link') return 2;
  if (c === 'trunk' || c === 'primary' || c === 'secondary' || /_link$/.test(c)) return 4;
  if (c === 'tertiary') return 5;
  return 6;
};
/**
 * TM1's capacity per lane-hour (SpeedCapacity_1hour.block) and critical speed ÷ free-flow speed
 * (FreeFlowSpeed.block, SPDCAP SPEED), by area type 0 (regional core) … 3 (urban): freeway (FT 2),
 * ramp (FT 5), expressway (FT 3), major arterial (FT 7), collector (FT 4). Local streets, which TM1
 * leaves to its centroid connectors, take the collector's.
 */
const CAP: Record<number, number[]> = { 1: [2050, 2050, 2100, 2100], 2: [1450, 1500, 1550, 1550], 3: [1450, 1450, 1600, 1600], 4: [900, 950, 1000, 1000], 5: [600, 650, 700, 700], 6: [600, 650, 700, 700] };
const CRIT: Record<number, number[]> = {
  2: [11.772 / 30, 11.772 / 30, 14.126 / 35, 14.126 / 35],
  3: [11.772 / 40, 11.772 / 40, 14.126 / 45, 14.126 / 45],
  4: [7.063 / 20, 9.417 / 25, 11.772 / 30, 11.772 / 30],
  5: [4.709 / 10, 4.709 / 15, 7.063 / 20, 9.417 / 25],
  6: [4.709 / 10, 4.709 / 15, 7.063 / 20, 9.417 / 25],
};
/**
 * Free flow: surface streets cruise at 85% of the limit between junctions (as skims.ts) and lose
 * time at signals and stop signs; the signal delay and the freeway share of the limit are fitted
 * below to SFCTA's INRIX speeds at night (3–6am), when the streets are empty. Stop signs: an assumed
 * 6 s at an all-way stop and 4 s on the minor street of a two-way stop (HCM LOS A, ≤10 s, includes
 * slowing down).
 */
const FREE = { cruise: 0.85, stopAll: 6, stopMinor: 4, connectorKmh: 20 };
/** regional driving speeds to the city line (skims.ts REGIONAL), km/h, and its circuity; surface roads at 75% of it (assumed) */
const REGIONAL: Record<TPeriod, number> = { AM: 48, MD: 72, PM: 45, NT: 80 };
const CIRCUITY = 1.3;
/** queues at the bridges and freeways beyond the city (skims.ts GATEWAYS), minutes in/out */
const QUEUES: { match: RegExp; out?: [number, number]; toll: number; in: Record<TPeriod, number>; outQ: Record<TPeriod, number> }[] = [
  { match: /Bay Bridge/, out: [37.8247, -122.3133], toll: 8.5, in: { AM: 15, MD: 4, PM: 6, NT: 2 }, outQ: { AM: 4, MD: 4, PM: 15, NT: 2 } },
  { match: /Golden Gate/, out: [37.8324, -122.4795], toll: 10.25, in: { AM: 6, MD: 2, PM: 2, NT: 1 }, outQ: { AM: 2, MD: 2, PM: 7, NT: 1 } },
];
/** Caltrans AADT is an average of all days; weekday traffic on urban highways runs a few percent above it (assumed 5%) */
const WEEKDAY_OF_AADT = 1.05;

/** a street name as the city's and OSM's both reduce to: "16TH AVE", "GEARY BLVD" */
const normName = (s: string) =>
  s
    .toUpperCase()
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bTERRACE\b/g, 'TER')
    .replace(/\bPLACE\b/g, 'PL')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bEXPRESSWAY\b/g, 'EXPY')
    .replace(/\bHIGHWAY\b/g, 'HWY')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bWAY\b/g, 'WY')
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

interface Arc {
  a: number;
  b: number;
  len: number;
  cls: number;
  kmh: number;
  lanes: number;
  name: string;
  ref: string;
  /** control delay at the head, seconds */
  ctl: number;
  signal: boolean;
  pts: number[];
  alive: boolean;
  /** bus-only lanes this way (OSM) */
  bus: number;
}

function main() {
  console.time('roads');
  const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  const zonesFile = JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8')) as { internal: { id: string; x: number; y: number; points: { x: number; y: number; w: number }[] }[] };
  const B = loadBundle();
  const Z = B.header.zones,
    X = B.header.ext;
  const NZ = Z.length,
    NX = X.length;
  const zpts = new Map(zonesFile.internal.map((z) => [z.id, z.points]));
  if (Z.some((z) => !zpts.has(z.id))) throw new Error('zones.json does not match the bundle');

  // ---------- directed arcs ----------
  const arcs: Arc[] = [];
  for (const e of edges) {
    if (!e.car || e.cls === 'service' || e.cls === 'living_street') continue;
    const c = cls(e.cls);
    const [lf, lb] = e.lanes ?? [1, 1];
    const pts = e.pts;
    const rev: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
    const base = { len: e.len, cls: c, kmh: e.speed, name: e.name ?? '', ref: e.ref ?? '', ctl: 0, signal: false, alive: true };
    if (e.oneway !== -1 && lf > 0) arcs.push({ ...base, a: e.a, b: e.b, lanes: lf, pts, bus: e.busLanes?.[0] ?? 0 });
    if (e.oneway !== 1 && lb > 0) arcs.push({ ...base, a: e.b, b: e.a, lanes: lb, pts: rev, bus: e.busLanes?.[1] ?? 0 });
  }
  const NV = vertices.length;
  const inDeg = new Int32Array(NV),
    outDeg = new Int32Array(NV);
  for (const r of arcs) outDeg[r.a]++, inDeg[r.b]++;
  console.log(`car arcs ${arcs.length} on ${new Set(arcs.flatMap((r) => [r.a, r.b])).size} vertices`);

  // ---------- control at junctions: OSM traffic signals and stop signs ----------
  const grid = new Map<string, number[]>();
  const G = 40;
  const used = new Uint8Array(NV);
  for (const r of arcs) used[r.a] = used[r.b] = 1;
  for (let v = 0; v < NV; v++) if (used[v]) (grid.get(`${Math.floor(vertices[v].x / G)},${Math.floor(vertices[v].y / G)}`) ?? grid.set(`${Math.floor(vertices[v].x / G)},${Math.floor(vertices[v].y / G)}`, []).get(`${Math.floor(vertices[v].x / G)},${Math.floor(vertices[v].y / G)}`)!).push(v);
  const nearest = (x: number, y: number, max: number, ok: (v: number) => boolean = () => true) => {
    let best = -1,
      bd = max;
    const gx = Math.floor(x / G),
      gy = Math.floor(y / G),
      R = Math.ceil(max / G);
    for (let i = -R; i <= R; i++)
      for (let j = -R; j <= R; j++)
        for (const v of grid.get(`${gx + i},${gy + j}`) ?? []) {
          const d = Math.hypot(vertices[v].x - x, vertices[v].y - y);
          if (d < bd && ok(v)) (bd = d), (best = v);
        }
    return best;
  };
  const deg = new Int32Array(NV);
  {
    const nb = new Map<number, Set<number>>();
    for (const r of arcs) {
      (nb.get(r.a) ?? nb.set(r.a, new Set()).get(r.a)!).add(r.b);
      (nb.get(r.b) ?? nb.set(r.b, new Set()).get(r.b)!).add(r.a);
    }
    for (const [v, s] of nb) deg[v] = s.size;
  }
  const signal = new Uint8Array(NV),
    stop = new Uint8Array(NV); // 1 minor-street stop, 2 all-way
  const osm = JSON.parse(fs.readFileSync(`${ROADS_RAW}/osm-signals.json`, 'utf8')) as { elements: { lat: number; lon: number; tags: Record<string, string> }[] };
  let nSig = 0,
    nStop = 0;
  for (const n of osm.elements) {
    const [x, y] = toXY(n.lat, n.lon);
    const hw = n.tags.highway;
    // signals and stops sit at the junction or a few metres before it
    const v = nearest(x, y, hw === 'traffic_signals' ? 25 : 20, (u) => deg[u] >= 3 || hw === 'traffic_signals');
    if (v < 0) continue;
    if (hw === 'traffic_signals') (signal[v] = 1), nSig++;
    else if (hw === 'stop') (stop[v] = Math.max(stop[v], n.tags.stop === 'all' ? 2 : 1)), nStop++;
  }
  console.log(`signals at ${signal.reduce((a, v) => a + v, 0)} junctions (${nSig} OSM nodes), stop signs at ${stop.reduce((a, v) => a + (v ? 1 : 0), 0)} (${nStop})`);
  // the best class through each junction: on a two-way stop the busier street does not stop
  const bestCls = new Int32Array(NV).fill(9);
  for (const r of arcs) (bestCls[r.a] = Math.min(bestCls[r.a], r.cls)), (bestCls[r.b] = Math.min(bestCls[r.b], r.cls));

  // ---------- CMP segments, to fit free flow: links later, arcs now ----------
  const cmpGeo = JSON.parse(fs.readFileSync(`${ROADS_RAW}/sfcta_cmp_segments_geom.json`, 'utf8')) as { cmp_segid: number; cmp_name: string; cmp_from: string; cmp_to: string; direction: string; length: number; cls_hcm00: string; geometry: string }[];
  const cmpSpd = JSON.parse(fs.readFileSync(`${RAW}/obs/sfcta_cmp_autotransit_xd_2024_2025.json`, 'utf8')) as { cmp_segid: number; year: number; period: string; auto_speed: number | null }[];
  // arcs near a polyline, heading its way
  const arcGrid = new Map<string, number[]>();
  arcs.forEach((r, i) => {
    const pa = vertices[r.a],
      pb = vertices[r.b];
    const k = `${Math.floor((pa.x + pb.x) / 2 / 100)},${Math.floor((pa.y + pb.y) / 2 / 100)}`;
    (arcGrid.get(k) ?? arcGrid.set(k, []).get(k)!).push(i);
  });
  const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax,
      dy = by - ay,
      L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  /** arcs along a line (x,y points), each within `tol` m of it at both ends and heading along it */
  const arcsAlong = (line: [number, number][], tol: number, filter: (r: Arc) => boolean = () => true) => {
    const found = new Set<number>();
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, ay] = line[i],
        [bx, by] = line[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1) continue;
      const ux = (bx - ax) / L,
        uy = (by - ay) / L;
      const steps = Math.ceil(L / 50);
      for (let s = 0; s <= steps; s++) {
        const px = ax + ((bx - ax) * s) / steps,
          py = ay + ((by - ay) * s) / steps;
        const gx = Math.floor(px / 100),
          gy = Math.floor(py / 100);
        for (let di = -2; di <= 2; di++)
          for (let dj = -2; dj <= 2; dj++)
            for (const k of arcGrid.get(`${gx + di},${gy + dj}`) ?? []) {
              if (found.has(k)) continue;
              const r = arcs[k];
              if (!filter(r)) continue;
              const pa = vertices[r.a],
                pb = vertices[r.b];
              const rl = Math.hypot(pb.x - pa.x, pb.y - pa.y);
              if (rl < 1) continue;
              if (((pb.x - pa.x) * ux + (pb.y - pa.y) * uy) / rl < 0.6) continue;
              if (segDist(pa.x, pa.y, ax, ay, bx, by) <= tol && segDist(pb.x, pb.y, ax, ay, bx, by) <= tol) found.add(k);
            }
      }
    }
    return [...found];
  };
  const cmpArcs: { seg: (typeof cmpGeo)[number]; arcs: number[]; fwy: boolean; AM?: number; PM?: number }[] = [];
  for (const seg of cmpGeo) {
    const g = JSON.parse(seg.geometry) as { type: string; coordinates: number[][] | number[][][] };
    const lines = (g.type === 'MultiLineString' ? (g.coordinates as number[][][]) : [g.coordinates as number[][]]).map((l) => l.map(([lon, lat]) => toXY(lat, lon) as [number, number]));
    const fwy = seg.cls_hcm00 === 'Fwy';
    const found = lines.flatMap((l) => arcsAlong(l, fwy ? 45 : 25, (r) => (fwy ? r.cls === 1 : r.cls >= 3)));
    const spd = (p: string) => cmpSpd.find((s) => s.cmp_segid === seg.cmp_segid && s.year === 2025 && s.period === p)?.auto_speed ?? undefined;
    if (found.length) cmpArcs.push({ seg, arcs: [...new Set(found)], fwy, AM: spd('AM'), PM: spd('PM') });
  }
  console.log(`CMP segments on the network: ${cmpArcs.length}/${cmpGeo.length} (${cmpArcs.filter((c) => c.AM).length} with 2025 speeds)`);

  // ---------- free-flow times: fit the signal delay and the freeway share to INRIX at night ----------
  const speeds = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-auto-speeds.json`, 'utf8'));
  const hourly = speeds.hourlyProfile.byModelPeriod as Record<string, Record<string, number>>;
  // control delay at the head of each arc, in units: signals (to be fitted), and stops (seconds)
  for (const r of arcs) {
    r.signal = signal[r.b] === 1 && r.cls >= 2;
    if (r.signal || r.cls < 4) continue;
    // an all-way stop mapped in OSM stops everyone; otherwise the busier street goes through and
    // the lesser one stops. Where two collectors or local streets cross and OSM maps nothing, an
    // all-way stop is assumed (most of the city's residential crossings have one; OSM maps 2,200
    // stop-controlled junctions, far fewer than there are)
    if (stop[r.b] === 2) r.ctl = FREE.stopAll;
    else if (deg[r.b] < 3) r.ctl = stop[r.b] ? FREE.stopMinor : 0;
    else if (r.cls > bestCls[r.b]) r.ctl = FREE.stopMinor;
    else if (r.cls >= 5) r.ctl = FREE.stopAll;
  }
  // night speeds by CMP segment: SFCTA's hourly INRIX speeds, 3–6 a.m., October 2025 to September
  // 2026 (harmonic mean over months and hours)
  const hourlySeg = JSON.parse(fs.readFileSync(`${ROADS_RAW}/sfcta_inrix_hourly_by_segment.json`, 'utf8')) as { cmp_segid: number; period: string; avg_speed: number }[];
  const nightOf = new Map<number, number[]>();
  for (const r of hourlySeg) if (['3', '4', '5'].includes(r.period) && r.avg_speed > 0) (nightOf.get(r.cmp_segid) ?? nightOf.set(r.cmp_segid, []).get(r.cmp_segid)!).push(r.avg_speed);
  const nightMph = (id: number) => {
    const v = nightOf.get(id);
    return v?.length ? v.length / v.reduce((a, x) => a + 1 / x, 0) : NaN;
  };
  // each arc's TM1 area type (the nearest zone's; beyond the city, urban)
  const atOf = (x: number, y: number) => {
    let best = 3,
      bd = 1500;
    for (const z of Z) {
      const d = Math.hypot(z.x - x, z.y - y);
      if (d < bd) ((bd = d), (best = z.areaType));
    }
    return Math.min(3, Math.max(0, best));
  };
  const arcAT = arcs.map((r) => atOf((vertices[r.a].x + vertices[r.b].x) / 2, (vertices[r.a].y + vertices[r.b].y) / 2));
  const mph = (m: number, sec: number) => m / 1609.34 / (sec / 3600);
  // arterials: by area type, the signal delay that makes the monitored arterials' free-flow time
  // match their night time (a ratio estimator over segments); where that would be negative (the
  // outer arterials, with long blocks and coordinated signals), no signal delay and a faster cruise
  const sigDelayAT = [0, 0, 0, 0],
    cruiseAT = [FREE.cruise, FREE.cruise, FREE.cruise, FREE.cruise];
  {
    const acc = [0, 1, 2, 3].map(() => ({ T: 0, cruise: 0, ctl: 0, sig: 0, len: 0, n: 0 }));
    for (const c of cmpArcs) {
      if (c.fwy || !c.arcs.length) continue;
      const v = nightMph(c.seg.cmp_segid);
      if (!(v > 0)) continue;
      const len = c.arcs.reduce((a, k) => a + arcs[k].len, 0);
      const at = arcAT[c.arcs[0]];
      const A = acc[at];
      A.T += len / 1609.34 / v * 3600;
      for (const k of c.arcs) ((A.cruise += arcs[k].len / ((arcs[k].kmh / 3.6) * FREE.cruise)), (A.ctl += arcs[k].ctl), (A.sig += arcs[k].signal ? 1 : 0));
      A.len += len;
      A.n++;
    }
    acc.forEach((A, at) => {
      if (!A.n) return;
      const d = (A.T - A.cruise - A.ctl) / Math.max(1, A.sig);
      if (d >= 0) sigDelayAT[at] = d;
      else cruiseAT[at] = FREE.cruise * (A.cruise / Math.max(1, A.T - A.ctl));
    });
    console.log(`free flow fitted to INRIX 3–6am by CMP segment: ${acc.map((A, at) => `area type ${at} (${A.n} segments, ${(A.len / 1609.34).toFixed(0)} mi, ${mph(A.len, A.T).toFixed(1)} mph): signal delay ${sigDelayAT[at].toFixed(1)} s, cruise ${(100 * cruiseAT[at]).toFixed(0)}% of the limit`).join('; ')}`);
  }
  const sigDelay = sigDelayAT.reduce((a, x) => a + x, 0) / 4;
  // freeways: the share of the limit that makes the monitored freeways run at their night speed
  const fwSegs = cmpArcs.filter((c) => c.fwy && nightMph(c.seg.cmp_segid) > 0);
  let fwT = 0,
    fwAtLimitT = 0;
  for (const c of fwSegs) {
    const len = c.arcs.reduce((a, k) => a + arcs[k].len, 0);
    fwT += len / 1609.34 / nightMph(c.seg.cmp_segid) * 3600;
    for (const k of c.arcs) fwAtLimitT += arcs[k].len / (arcs[k].kmh / 3.6);
  }
  const fwyShare = fwSegs.length ? fwAtLimitT / fwT : 1.1;
  const target = { arterial: hourly.arterial.EA, freeway: hourly.freeway.EA };
  const art = [...new Set(cmpArcs.filter((c) => !c.fwy).flatMap((c) => c.arcs))],
    fw = [...new Set(fwSegs.flatMap((c) => c.arcs))];
  const artLen = art.reduce((a, k) => a + arcs[k].len, 0),
    fwLen = fw.reduce((a, k) => a + arcs[k].len, 0);
  console.log(`freeways at ${(100 * fwyShare).toFixed(1)}% of the limit (${fwSegs.length} segments)`);
  // freeways no faster than 62 mph (the fastest hour in INRIX's profile is 58)
  const fwyMs = (r: Arc) => Math.min((r.kmh / 3.6) * fwyShare, 62 * 0.44704);
  let stopScale = 1;
  const freeSec = (r: Arc, k: number) => (r.cls === 1 ? r.len / fwyMs(r) : r.len / ((r.kmh / 3.6) * cruiseAT[arcAT[k]]) + stopScale * r.ctl + (r.signal ? sigDelayAT[arcAT[k]] : 0));
  // local streets have no observed speeds: their stop delays are scaled so that at free flow they
  // run at 80% of the arterials' speed, the ratio the fixed skims assume (skims.ts)
  {
    const sumBy = (c: (r: Arc) => boolean) => {
      let m = 0,
        t = 0,
        ctl = 0;
      arcs.forEach((r, k) => { if (c(r)) ((m += r.len), (t += freeSec(r, k) - stopScale * r.ctl), (ctl += r.ctl)); });
      return { m, t, ctl };
    };
    const A = sumBy((r) => r.cls === 4),
      Lc = sumBy((r) => r.cls === 6);
    const vArt = A.m / (A.t + A.ctl);
    const want = Lc.m / (0.8 * vArt);
    stopScale = Math.max(0.2, Math.min(5, (want - Lc.t) / Math.max(1, Lc.ctl)));
    const vLoc = Lc.m / (Lc.t + stopScale * Lc.ctl);
    console.log(`stop delays ×${stopScale.toFixed(2)} (${(FREE.stopAll * stopScale).toFixed(1)} s all-way, ${(FREE.stopMinor * stopScale).toFixed(1)} s minor street): free flow arterials ${(vArt * 2.237).toFixed(1)} mph, local streets ${(vLoc * 2.237).toFixed(1)} mph`);
  }
  console.log(`  check: monitored arterials ${mph(artLen, art.reduce((a, k) => a + freeSec(arcs[k], k), 0)).toFixed(1)} mph, freeways ${mph(fwLen, fw.reduce((a, k) => a + freeSec(arcs[k], k), 0)).toFixed(1)} mph at free flow`);

  // ---------- join chains (a vertex with one way in and one out, or a two-way street passing through) ----------
  const t0 = arcs.map((r, k) => freeSec(r, k));
  const inArcs: number[][] = Array.from({ length: NV }, () => []),
    outArcs: number[][] = Array.from({ length: NV }, () => []);
  arcs.forEach((r, i) => (outArcs[r.a].push(i), inArcs[r.b].push(i)));
  const same = (p: Arc, q: Arc) => p.cls === q.cls && p.lanes === q.lanes && p.name === q.name && p.ref === q.ref;
  // the arc continuing `i` through its head, if the head is a mere bend in the street
  const through = (i: number): number => {
    const v = arcs[i].b;
    const ins = inArcs[v],
      outs = outArcs[v];
    if (ins.length === 1 && outs.length === 1 && arcs[outs[0]].b !== arcs[i].a) return same(arcs[i], arcs[outs[0]]) ? outs[0] : -1;
    if (ins.length === 2 && outs.length === 2) {
      const back = outs.find((o) => arcs[o].b === arcs[i].a);
      const fwd = outs.find((o) => arcs[o].b !== arcs[i].a);
      if (back === undefined || fwd === undefined) return -1;
      // the other way along must be the mirror
      const otherIn = ins.find((x) => x !== i)!;
      if (arcs[otherIn].a !== arcs[fwd].b) return -1;
      return same(arcs[i], arcs[fwd]) && same(arcs[otherIn], arcs[back]) ? fwd : -1;
    }
    return -1;
  };
  const isBend = new Uint8Array(NV);
  for (let v = 0; v < NV; v++) {
    if (!inArcs[v].length) continue;
    isBend[v] = inArcs[v].every((i) => through(i) >= 0) ? 1 : 0;
  }
  interface Link {
    a: number;
    b: number;
    len: number;
    t0: number;
    cls: number;
    lanes: number;
    name: string;
    ref: string;
    pts: number[];
    arcs: number[];
    signals: number;
    /** metres with a bus lane */
    busLen: number;
  }
  const links: Link[] = [];
  const arcLink = new Int32Array(arcs.length).fill(-1);
  for (let i = 0; i < arcs.length; i++) {
    if (isBend[arcs[i].a] || arcLink[i] >= 0) continue;
    const L: Link = { a: arcs[i].a, b: arcs[i].b, len: 0, t0: 0, cls: arcs[i].cls, lanes: arcs[i].lanes, name: arcs[i].name, ref: arcs[i].ref, pts: [], arcs: [], signals: 0, busLen: 0 };
    let k = i;
    for (let guard = 0; guard < 10000; guard++) {
      const r = arcs[k];
      L.len += r.len;
      L.t0 += t0[k];
      L.pts.push(vertices[r.a].lat, vertices[r.a].lon, ...r.pts);
      L.arcs.push(k);
      L.signals += r.signal ? 1 : 0;
      L.busLen += r.bus > 0 ? r.len : 0;
      arcLink[k] = links.length;
      L.b = r.b;
      if (!isBend[r.b]) break;
      k = through(k);
      if (k < 0 || arcLink[k] >= 0) break;
    }
    L.pts.push(vertices[L.b].lat, vertices[L.b].lon);
    links.push(L);
  }
  // loops of bends (rare): keep each arc as its own link
  for (let i = 0; i < arcs.length; i++)
    if (arcLink[i] < 0) {
      const r = arcs[i];
      arcLink[i] = links.length;
      links.push({ a: r.a, b: r.b, len: r.len, t0: t0[i], cls: r.cls, lanes: r.lanes, name: r.name, ref: r.ref, pts: [vertices[r.a].lat, vertices[r.a].lon, ...r.pts, vertices[r.b].lat, vertices[r.b].lon], arcs: [i], signals: r.signal ? 1 : 0, busLen: r.bus > 0 ? r.len : 0 });
    }
  // OSM's lane counts have slips on short pieces (a toll-plaza split, a lane tagged for buses that
  // takes the only lane): a link under 150 m is never narrower than both the road before and after
  // it, and a freeway has at least two general-purpose lanes
  {
    const into = new Map<number, number[]>(),
      from = new Map<number, number[]>();
    links.forEach((l, i) => {
      (into.get(l.b) ?? into.set(l.b, []).get(l.b)!).push(i);
      (from.get(l.a) ?? from.set(l.a, []).get(l.a)!).push(i);
    });
    let fixed = 0;
    const lanes = links.map((l) => l.lanes);
    links.forEach((l, i) => {
      let n = lanes[i];
      if (l.cls === 1) n = Math.max(n, 2);
      if (l.len < 150) {
        const up = Math.max(0, ...(into.get(l.a) ?? []).filter((j) => links[j].cls === l.cls && links[j].a !== l.b).map((j) => lanes[j]));
        const dn = Math.max(0, ...(from.get(l.b) ?? []).filter((j) => links[j].cls === l.cls && links[j].b !== l.a).map((j) => lanes[j]));
        if (up && dn) n = Math.max(n, Math.min(up, dn));
      }
      if (n !== l.lanes) ((l.lanes = n), fixed++);
    });
    console.log(`lanes raised on ${fixed} short or freeway links`);
  }
  console.log(`links ${links.length} (from ${arcs.length} arcs)`);

  // ---------- gateways: where the roads leave the mapped area ----------
  // the OSM extract stops at its box; a road cut at the box edge is a way in (no arcs into its end)
  // or out (none leaving it). Cuts on the Bay Bridge, the Golden Gate Bridge and across the San
  // Mateo County line become gateways (collector and above).
  const nodesUsed = new Set(links.flatMap((l) => [l.a, l.b]));
  const lin = new Int32Array(NV),
    lout = new Int32Array(NV);
  for (const l of links) lout[l.a]++, lin[l.b]++;
  interface Cut {
    v: number;
    inbound: boolean;
    name: string;
    ref: string;
    cls: number;
  }
  const cuts: Cut[] = [];
  const nbrs = new Map<number, Set<number>>();
  for (const l of links) {
    (nbrs.get(l.a) ?? nbrs.set(l.a, new Set()).get(l.a)!).add(l.b);
    (nbrs.get(l.b) ?? nbrs.set(l.b, new Set()).get(l.b)!).add(l.a);
  }
  for (const v of nodesUsed) {
    const p = vertices[v];
    const south = p.lat < 37.7015,
      east = p.lon > -122.36,
      north = p.lat > 37.83;
    if (!south && !east && !north) continue;
    // nothing continues outward from it: the end of what was mapped
    const inward = [...nbrs.get(v)!].every((u) => (south ? vertices[u].lat > p.lat : east ? vertices[u].lon < p.lon : vertices[u].lat < p.lat));
    if (!(nbrs.get(v)!.size === 1 || lin[v] === 0 || lout[v] === 0 || inward)) continue;
    const l = links.find((x) => x.a === v || x.b === v)!;
    if (l.cls > 5) continue;
    // a carriageway that only starts here is a way in; one that only ends here, a way out
    if (lout[v] > 0 && (lin[v] === 0 || nbrs.get(v)!.size === 1 || inward)) cuts.push({ v, inbound: true, name: l.name, ref: l.ref, cls: l.cls });
    if (lin[v] > 0 && (lout[v] === 0 || nbrs.get(v)!.size === 1 || inward)) cuts.push({ v, inbound: false, name: l.name, ref: l.ref, cls: l.cls });
  }
  // group cuts into gateways by road (ref, else name) and place
  const gwMap = new Map<string, Cut[]>();
  for (const c of cuts) {
    const p = vertices[c.v];
    const road = c.ref ? c.ref.split(';')[0] : c.name || `road ${c.v}`;
    const key = p.lon > -122.36 ? 'Bay Bridge' : p.lat > 37.83 ? 'Golden Gate Bridge' : road;
    (gwMap.get(key) ?? gwMap.set(key, []).get(key)!).push(c);
  }
  interface GW {
    name: string;
    kind: 'bridge' | 'freeway' | 'surface';
    lat: number;
    lon: number;
    ins: number[];
    outs: number[];
  }
  const gws: GW[] = [];
  for (const [name, cs] of gwMap) {
    // split a road's cuts that lie far apart (the same street name in two places)
    const groups: Cut[][] = [];
    for (const c of cs) {
      const g = /Bridge/.test(name) ? groups[0] : groups.find((gr) => gr.some((d) => Math.hypot(vertices[d.v].x - vertices[c.v].x, vertices[d.v].y - vertices[c.v].y) < 400));
      if (g) g.push(c);
      else groups.push([c]);
    }
    for (const g of groups) {
      const ins = g.filter((c) => c.inbound).map((c) => c.v),
        outs = g.filter((c) => !c.inbound).map((c) => c.v);
      if (!ins.length || !outs.length) continue;
      const lat = g.reduce((a, c) => a + vertices[c.v].lat, 0) / g.length,
        lon = g.reduce((a, c) => a + vertices[c.v].lon, 0) / g.length;
      const kind = /Bridge/.test(name) ? 'bridge' : g.some((c) => c.cls === 1) ? 'freeway' : 'surface';
      gws.push({ name: groups.length > 1 ? `${name} (${gws.length})` : name, kind, lat, lon, ins, outs });
    }
  }
  gws.sort((p, q) => (p.kind === q.kind ? q.lon - p.lon : p.kind < q.kind ? -1 : 1));
  console.log(`gateways ${gws.length}: ${gws.map((g) => `${g.name} [${g.kind}] ${g.ins.length}/${g.outs.length}`).join(', ')}`);

  // ---------- node numbering: centroids (zones, outside zones, gateways), then hubs, then streets ----------
  const NG = gws.length;
  const nC = NZ + NX + NG;
  const nodeId = new Map<number, number>();
  // hubs: each gateway's in and out, then each Peninsula freeway's interchanges, each direction
  const PEN_ROUTES = Object.keys(PEN_CUTS) as PenRoute[];
  const penGw = (r: PenRoute) => gws.findIndex((g) => g.name.startsWith(r === 'US-101' ? 'US 101' : 'I 280'));
  const penOn = PEN_ROUTES.every((r) => penGw(r) >= 0);
  if (!penOn) console.warn('peninsula: the US-101 or I-280 gateway is missing; the freeways are left out');
  const cutNode = new Map<string, number>();
  let nPenHub = 0;
  if (penOn) for (const r of PEN_ROUTES) for (const d of ['N', 'S']) PEN_CUTS[r].forEach((_, j) => cutNode.set(`${r}|${d}|${j}`, nC + 2 * NG + nPenHub++));
  // (only the gateways' are hubs for the all-or-nothing loading: a zone that reaches the freeways
  // gets a shortest-path tree of its own, cheaper in the browser than every worker building a tree
  // from every interchange; aonOrigins)
  const nHub = 2 * NG;
  let nNodes = nC + nHub + nPenHub;
  const hubIn = (g: number) => nC + 2 * g,
    hubOut = (g: number) => nC + 2 * g + 1;
  for (const l of links)
    for (const v of [l.a, l.b])
      if (!nodeId.has(v)) nodeId.set(v, nNodes++);
  // area type of each link: the nearest zone's (the streets beyond the city: urban)
  const zoneAt = (lat: number, lon: number) => {
    const [x, y] = toXY(lat, lon);
    let best = 3,
      bd = 1500;
    for (const z of Z) {
      const d = Math.hypot(z.x - x, z.y - y);
      if (d < bd) (bd = d), (best = z.areaType);
    }
    return best;
  };

  interface Out {
    a: number;
    b: number;
    lenMi: number;
    t0: number[];
    cap: number;
    lanes: number;
    vdf: number;
    ja: number;
    cls: number;
    toll: number[];
    name: string;
    ref?: string;
    pts: number[];
    /** share of the link's length with a bus lane */
    busShare?: number;
    /** traffic signals along it (at its junctions) */
    sig?: number;
    /** a Peninsula freeway's link (1 US-101, 2 I-280) */
    corr?: number;
  }
  const out: Out[] = [];
  const linkOf = new Int32Array(links.length);
  for (const [i, l] of links.entries()) {
    const mid = Math.floor(l.pts.length / 4) * 2;
    const at = Math.min(3, Math.max(0, zoneAt(l.pts[mid], l.pts[mid + 1])));
    // trunk roads without signals along them run as expressways (Doyle Drive, the Park Presidio tunnel)
    let ft = l.cls;
    if (ft === 4 && /^(US 101|CA 1)/.test(l.ref) && l.signals === 0 && l.len > 300 && l.len / l.t0 > 40 / 3.6 * 0.85) ft = 3;
    const capLane = CAP[ft][at];
    const lenMi = l.len / 1609.34;
    let vdf = VDF_AKCELIK,
      ja = 0;
    if (ft === 1) vdf = VDF_FREEWAY;
    else {
      const s0 = lenMi / (l.t0 / 3600); // free-flow mph
      const ratio = CRIT[ft][at];
      ja = (1 / s0) ** 2 * (1 / ratio - 1) ** 2;
    }
    linkOf[i] = out.length;
    out.push({ a: nodeId.get(l.a)!, b: nodeId.get(l.b)!, lenMi, t0: TPERIODS.map(() => l.t0 / 60), cap: capLane * l.lanes, lanes: l.lanes, vdf, ja, cls: ft === 3 ? 3 : l.cls, toll: TPERIODS.map(() => 0), name: l.name || l.ref, ref: l.ref, pts: l.pts, busShare: l.len > 0 ? Math.min(1, l.busLen / l.len) : 0, sig: l.signals });
  }

  // ---------- centroid connectors: each zone to the junctions its blocks are nearest ----------
  const streetNode = new Set<number>();
  for (const l of links) if (l.cls >= 4) streetNode.add(l.a), streetNode.add(l.b);
  const conn = (a: number, b: number, meters: number) => out.push({ a, b, lenMi: meters / 1609.34, t0: TPERIODS.map(() => meters / (FREE.connectorKmh / 3.6) / 60), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: TPERIODS.map(() => 0), name: '', pts: [] });
  let nConn = 0;
  Z.forEach((z, zi) => {
    const pts = zpts.get(z.id)!;
    const w = new Map<number, { w: number; d: number }>();
    for (const p of pts) {
      const v = nearest(p.x, p.y, 600, (u) => streetNode.has(u) && !isBend[u]);
      if (v < 0) continue;
      const e = w.get(v) ?? { w: 0, d: 0 };
      e.w += p.w;
      e.d += p.w * Math.hypot(vertices[v].x - p.x, vertices[v].y - p.y);
      w.set(v, e);
    }
    let top = [...w].sort((p, q) => q[1].w - p[1].w).slice(0, 3);
    if (!top.length) {
      const v = nearest(z.x, z.y, 2000, (u) => streetNode.has(u) && !isBend[u]);
      top = [[v, { w: 1, d: Math.hypot(vertices[v].x - z.x, vertices[v].y - z.y) }]];
    }
    for (const [v, e] of top) {
      const m = Math.max(50, e.d / Math.max(1e-9, e.w));
      conn(zi, nodeId.get(v)!, m);
      conn(nodeId.get(v)!, zi, m);
      nConn += 2;
    }
  });

  // ---------- outside zones to the gateways: the regional leg (fixed) ----------
  const gwCentroid = (g: number) => NZ + NX + g;
  // the regional leg runs on the Bay Area's freeways and trunk roads (OSM, roads/osm-regional.json):
  // from the outside zone to the nearest of them, then along them to the gateway, at the regional
  // speed by period (skims.ts REGIONAL; trunk roads at 80% of it); a gateway on a surface road off
  // that network is reached from the nearest freeway node at local speed, or, from a zone within
  // 8 km of it, straight from the zone as before (1.3 × the straight line at 75% of the regional
  // speed), whichever is quicker
  const raw = JSON.parse(fs.readFileSync(`${ROADS_RAW}/osm-regional.json`, 'utf8')) as { elements: ({ type: 'node'; id: number; lat: number; lon: number } | { type: 'way'; id: number; nodes: number[]; tags: Record<string, string> })[] };
  // the Peninsula freeways' carriageways (peninsula.ts): their links are the assignment's, so the
  // legs to their interchanges are measured on the regional network without them (`skip`), each
  // carriageway node within 1.5 km of an interchange joined to it (`join`, where ramps from other
  // routes meet the freeway)
  const pen = corridorCarriageways(raw.elements as never);
  const penSegs = corridorSegments(pen.cw, pen.pos);
  const penSkip = new Set<string>(),
    penJoin: [number, number][] = [];
  for (const c of pen.cw) {
    const lo = Math.min(...c.cutAt),
      hi = Math.max(...c.cutAt);
    for (let i = lo; i < hi; i++) penSkip.add(`${c.nodes[i]},${c.nodes[i + 1]}`);
    for (let i = lo; i <= hi; i++) {
      let best = -1,
        bd = 1500;
      c.cutAt.forEach((ci) => {
        const d = Math.abs(c.chain[i] - c.chain[ci]);
        if (d < bd) ((bd = d), (best = ci));
      });
      if (best >= 0 && best !== i) penJoin.push([c.nodes[i], c.nodes[best]]);
    }
  }
  const buildReg = (skip?: Set<string>, join?: [number, number][]) => {
    const nodePos = new Map<number, [number, number]>();
    // the city and its two bridges are left out: inside them, traffic is on the city's own streets,
    // and a path from outside can cross the Bay Bridge or the Golden Gate only through their gateways
    // (which carry their tolls and queues)
    const inCity = (lat: number, lon: number) => lat > 37.7 && lat < 37.832 && lon > -122.53 && lon < -122.356;
    for (const e of raw.elements) if (e.type === 'node' && !inCity(e.lat, e.lon)) nodePos.set(e.id, toXY(e.lat, e.lon) as [number, number]);
    const idx = new Map<number, number>();
    const X2: number[] = [],
      Y2: number[] = [];
    const id = (n: number) => {
      let i = idx.get(n);
      if (i === undefined) {
        const p = nodePos.get(n)!;
        i = X2.length;
        X2.push(p[0]);
        Y2.push(p[1]);
        idx.set(n, i);
      }
      return i;
    };
    // arcs: [from, to, metres, trunk]; the state's toll bridges (BATA, $8.50 in 2026, collected one
    // way) add half their toll each way, as metres of freeway at the morning's regional speed and the
    // assignment's value of time (the Bay Bridge's and the Golden Gate's own tolls are on the gateways)
    const TOLL_BRIDGE = /^(Benicia-Martinez Bridge|Richmond-San Rafael Bridge|Carquinez Bridge|Dumbarton Bridge|San Mateo - Hayward Bridge|Antioch Bridge)$/;
    const tollMetres = (((8.5 / 2) * 60) / ROUTE_VOT / 60) * REGIONAL.AM * 1000;
    const arcsR: [number, number, number, number][] = [];
    const bridgeWays = new Map<string, number>();
    for (const e of raw.elements) if (e.type === 'way' && TOLL_BRIDGE.test(e.tags.name ?? '') && (e.tags.bridge === 'yes' || e.tags.toll === 'yes')) bridgeWays.set(e.tags.name, (bridgeWays.get(e.tags.name) ?? 0) + 1);
    for (const e of raw.elements) {
      if (e.type !== 'way') continue;
      const hw = e.tags.highway;
      const trunk = hw.startsWith('trunk') ? 1 : 0;
      const ow = e.tags.oneway === 'yes' || e.tags.oneway === '1' || (hw === 'motorway' && e.tags.oneway !== 'no') || e.tags.junction === 'roundabout';
      const rev = e.tags.oneway === '-1';
      const ns = e.nodes;
      const toll = TOLL_BRIDGE.test(e.tags.name ?? '') && (e.tags.bridge === 'yes' || e.tags.toll === 'yes');
      // a bridge mapped as several ways each way shares its toll among them
      let tollLeft = toll ? tollMetres / Math.max(1, (bridgeWays.get(e.tags.name!) ?? 2) / 2) : 0;
      for (let i = 0; i + 1 < ns.length; i++) {
        if (!nodePos.has(ns[i]) || !nodePos.has(ns[i + 1])) continue;
        if (skip && (skip.has(`${ns[i]},${ns[i + 1]}`) || skip.has(`${ns[i + 1]},${ns[i]}`))) continue;
        const a = id(ns[i]),
          b = id(ns[i + 1]);
        const m = Math.hypot(X2[b] - X2[a], Y2[b] - Y2[a]) + tollLeft;
        tollLeft = 0;
        if (!rev) arcsR.push([a, b, m, trunk]);
        if (!ow || rev) arcsR.push([b, a, m, trunk]);
      }
    }
    for (const [u, v] of join ?? []) {
      if (!nodePos.has(u) || !nodePos.has(v)) continue;
      const a = id(u),
        b = id(v);
      arcsR.push([a, b, 0, 0], [b, a, 0, 0]);
    }
    const n = X2.length;
    // distance-equivalent: trunk metres count 1/0.8 freeway metres
    const fwd: number[][] = Array.from({ length: n }, () => []),
      bwd: number[][] = Array.from({ length: n }, () => []);
    arcsR.forEach((r, k) => (fwd[r[0]].push(k), bwd[r[1]].push(k)));
    const dij = (src: number, forward: boolean) => {
      const d = new Float64Array(n).fill(Infinity);
      d[src] = 0;
      const heap: [number, number][] = [[0, src]];
      const pop = () => {
        const top = heap[0],
          last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            let c = 2 * i + 1;
            if (c >= heap.length) break;
            if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
            if (heap[c][0] >= heap[i][0]) break;
            [heap[c], heap[i]] = [heap[i], heap[c]];
            i = c;
          }
        }
        return top;
      };
      const push = (x: [number, number]) => {
        heap.push(x);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      };
      while (heap.length) {
        const [du, u] = pop();
        if (du > d[u]) continue;
        for (const k of forward ? fwd[u] : bwd[u]) {
          const r = arcsR[k];
          const v = forward ? r[1] : r[0];
          const nd = du + r[2] / (r[3] ? 0.8 : 1);
          if (nd < d[v]) ((d[v] = nd), push([nd, v]));
        }
      }
      return d;
    };
    const near = (x: number, y: number, max: number) => {
      const res: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const dd = Math.hypot(X2[i] - x, Y2[i] - y);
        if (dd <= max) res.push([i, dd]);
      }
      return res;
    };
    return { n, X2, Y2, dij, near, idx };
  };
  const reg = buildReg();
  console.log(`regional network: ${reg.n} nodes`);
  const regPen = buildReg(penSkip, penJoin);
  const LOCAL_KMH = 30;
  // per gateway: freeway-equivalent metres from every regional node to it (in) and from it (out)
  const gwReg = gws.map((g) => {
    const [gx, gy] = toXY(g.lat, g.lon);
    const cand = reg.near(gx, gy, g.kind === 'surface' ? 1500 : 800).sort((p, q) => p[1] - q[1]);
    if (!cand.length) return null;
    const [node, dLocal] = cand[0];
    return { node, dLocal, din: reg.dij(node, false), dout: reg.dij(node, true) };
  });
  // each outside zone's access to the regional network: nodes within 6 km (local speed), else the nearest
  const accessOf = (xz: { x: number; y: number }) => {
    let c = reg.near(xz.x, xz.y, 6000);
    if (!c.length) {
      let best = -1,
        bd = Infinity;
      for (let i = 0; i < reg.n; i++) {
        const dd = Math.hypot(reg.X2[i] - xz.x, reg.Y2[i] - xz.y);
        if (dd < bd) ((bd = dd), (best = i));
      }
      c = [[best, bd]];
    }
    return c;
  };
  const accessCache = new Map<{ x: number; y: number }, [number, number][]>();
  // where the freeways' speeds are published, the regional part of a leg runs at them, with no
  // queue of its own (regional-legs.ts, as the fixed skims do): from the East Bay and beyond to the
  // Bay Bridge along the zone's corridor, and, without the Peninsula freeways in the network, from west
  // of the Bay to US-101's and I-280's gateways (with them, those legs are the freeways' own links)
  const readRef = (name: string) => JSON.parse(fs.readFileSync(`${REFERENCE}/${name}`, 'utf8'));
  const OBS_PEN = peninsulaCorridors(readRef('peninsula-traffic.json')),
    OBS_EB = eastBayCorridors(readRef('eastbay-traffic.json'));
  const SKIM_P: Record<TPeriod, SkimPeriod> = { AM: 'AM', MD: 'MD', PM: 'PM', NT: 'EV' };
  const ASSUMED = { AM: REGIONAL.AM, MD: REGIONAL.MD, PM: REGIONAL.PM, EV: REGIONAL.NT };
  const observedOf = (xz: { lat: number; lon: number }, g: GW): { route: string; obs: ObservedSpeeds } | null => {
    if (!penOn && peninsulaSide(xz.lat, xz.lon) && OBS_PEN && /^(US 101|I 280)/.test(g.name)) return { route: g.name.startsWith('US 101') ? 'US-101' : 'I-280', obs: OBS_PEN };
    const eb = eastBayCorridor(xz.lat, xz.lon);
    if (eb && OBS_EB && /Bay Bridge/.test(g.name)) return { route: eb, obs: OBS_EB };
    return null;
  };
  /** minutes from an outside zone to a gateway (with the gateway's queue, unless the observed speeds carry it), and the gateway's queue and toll */
  const legMin = (xz: { x: number; y: number; lat: number; lon: number }, g: GW, p: TPeriod, dir: 'in' | 'out' = 'in') => {
    const q = QUEUES.find((Q) => Q.match.test(g.name));
    const ob = observedOf(xz, g);
    const regionalMin = (m: number) => (ob ? regionalLegSec(m, ob.route, SKIM_P[p], dir, ASSUMED, ob.obs, false) / 60 : (m / 1000 / REGIONAL[p]) * 60);
    const gi = gws.indexOf(g);
    const [gx, gy] = toXY(g.lat, g.lon);
    const [ox, oy] = q?.out ? toXY(q.out[0], q.out[1]) : [gx, gy];
    // the old straight-line leg, kept for surface roads near the zone
    const direct = ((CIRCUITY * Math.hypot(xz.x - ox, xz.y - oy) + Math.hypot(ox - gx, oy - gy)) / 1000 / (REGIONAL[p] * (g.kind === 'surface' ? 0.75 : 1))) * 60;
    const G = gwReg[gi];
    let viaNet = Infinity;
    if (G) {
      const acc = accessCache.get(xz) ?? accessCache.set(xz, accessOf(xz)).get(xz)!;
      const D = dir === 'in' ? G.din : G.dout;
      for (const [node, dd] of acc) {
        // access: local speed for the first 6 km, the regional speed beyond
        const local = Math.min(dd, 6000),
          far = Math.max(0, dd - 6000);
        const t = ((CIRCUITY * local) / 1000 / LOCAL_KMH + (CIRCUITY * G.dLocal) / 1000 / LOCAL_KMH) * 60 + regionalMin(CIRCUITY * far + D[node]);
        if (t < viaNet) viaNet = t;
      }
    }
    // the straight line only for a zone next to a surface gateway (it would cross the Bay otherwise)
    const nearGw = Math.hypot(xz.x - gx, xz.y - gy) < 8000;
    const queue = ob ? 0 : (dir === 'in' ? q?.in[p] : q?.outQ[p]) ?? 0;
    return { min: (g.kind === 'surface' ? (nearGw ? Math.min(direct, viaNet) : viaNet) : Number.isFinite(viaNet) ? viaNet : direct) + queue, q };
  };
  // ---------- the Peninsula freeways: a link per direction between interchanges ----------
  const pdata = JSON.parse(fs.readFileSync(`${REFERENCE}/peninsula-traffic.json`, 'utf8')) as { periodShare: Record<TPeriod, number>; southShare: Record<TPeriod, number>; cmpSpeeds: { route: PenRoute; dir: 'N' | 'S'; north: string; south: string; ffs: number; AM: number; PM: number }[]; aadt: { route: PenRoute; lat: number; lon: number; back: number; ahead: number }[] };
  const penOut: { seg: (typeof penSegs)[number]; o: Out; daily: number; ffMph: number }[] = [];
  if (penOn) {
    // each segment's weekday traffic: the Caltrans AADT points between its interchanges (each the
    // mean of the counts on either side), on the southbound carriageway's chainage
    const chainOf = (r: PenRoute, lat: number, lon: number) => {
      const c = pen.cw.find((x) => x.route === r && x.dir === 'S')!;
      const [x0, y0] = toXY(lat, lon);
      let best = 0,
        bd = Infinity;
      c.nodes.forEach((n, i) => {
        const [x, y] = toXY(...pen.pos.get(n)!);
        const d = Math.hypot(x - x0, y - y0);
        if (d < bd) ((bd = d), (best = i));
      });
      return { chain: c.chain[best], d: bd };
    };
    const pts = pdata.aadt
      .map((a) => ({ r: a.route, v: a.back && a.ahead ? (a.back + a.ahead) / 2 : a.back || a.ahead, ...chainOf(a.route, a.lat, a.lon) }))
      .filter((a) => a.v > 0 && a.d < 300);
    for (const sg of penSegs) {
      const c = pen.cw.find((x) => x.route === sg.route && x.dir === 'S')!;
      const north = Math.min(sg.from, sg.to),
        south = Math.max(sg.from, sg.to);
      const a0 = c.chain[c.cutAt[north]],
        a1 = c.chain[c.cutAt[south]];
      const on = pts.filter((q) => q.r === sg.route && q.chain >= a0 && q.chain <= a1);
      const mid = (a0 + a1) / 2;
      const use = on.length ? on : [pts.filter((q) => q.r === sg.route).sort((x, y) => Math.abs(x.chain - mid) - Math.abs(y.chain - mid))[0]];
      const daily = (use.reduce((t, q) => t + q.v, 0) / use.length) * WEEKDAY_OF_AADT;
      const fromName = PEN_CUTS[sg.route][sg.from].name,
        toName = PEN_CUTS[sg.route][sg.to].name;
      // free flow: C/CAG's 65 mph, or INRIX's peak speed on the monitored segment where faster
      const mon = pdata.cmpSpeeds.find((m) => m.route === sg.route && m.dir === sg.dir && PEN_CUTS[sg.route].findIndex((x) => x.name === m.north) <= north && PEN_CUTS[sg.route].findIndex((x) => x.name === m.south) >= south);
      const ffMph = Math.max(mon?.ffs ?? 65, mon?.AM ?? 0, mon?.PM ?? 0);
      const lenMi = sg.metres / 1609.34;
      const o: Out = {
        a: cutNode.get(`${sg.route}|${sg.dir}|${sg.from}`)!,
        b: cutNode.get(`${sg.route}|${sg.dir}|${sg.to}`)!,
        lenMi,
        t0: TPERIODS.map(() => (lenMi / ffMph) * 60),
        // TM1's freeway capacity per lane (urban); express and HOV lanes counted as lanes (roads-base.ts fits a factor to INRIX's speeds)
        cap: CAP[1][3] * sg.lanes,
        lanes: sg.lanes,
        vdf: VDF_FREEWAY,
        ja: 0,
        cls: 1,
        toll: TPERIODS.map(() => 0),
        name: `${sg.route} ${sg.dir === 'N' ? 'north' : 'south'}, ${fromName} to ${toName}`,
        ref: sg.route.replace('-', ' '),
        pts: sg.pts,
        corr: sg.route === 'US-101' ? 1 : 2,
      };
      out.push(o);
      penOut.push({ seg: sg, o, daily, ffMph });
    }
    // the freeways meet the city at their gateways: northbound into the in-hub, southbound out of the out-hub
    const zero = () => TPERIODS.map(() => 0);
    for (const r of PEN_ROUTES) {
      const g = penGw(r);
      out.push({ a: cutNode.get(`${r}|N|0`)!, b: hubIn(g), lenMi: 0, t0: zero(), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: zero(), name: '', pts: [] });
      out.push({ a: hubOut(g), b: cutNode.get(`${r}|S|0`)!, lenMi: 0, t0: zero(), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: zero(), name: '', pts: [] });
    }
    console.log(`peninsula: ${penOut.length} freeway links (${(penOut.reduce((t, x) => t + x.o.lenMi, 0) / 2).toFixed(0)} miles each way), ${nPenHub} interchange hubs`);
  }
  // an outside zone's leg to a Peninsula freeway's interchange (in: onto the northbound carriageway;
  // out: off the southbound), on the regional network without the freeways, as legMin
  const penLegCache = new Map<string, { din: Float64Array; dout: Float64Array; node: number } | null>();
  const penLeg = (xz: { x: number; y: number }, r: PenRoute, j: number, p: TPeriod, dir: 'in' | 'out') => {
    const key = `${r}|${j}`;
    if (!penLegCache.has(key)) {
      const cwN = pen.cw.find((c) => c.route === r && c.dir === 'N')!,
        cwS = pen.cw.find((c) => c.route === r && c.dir === 'S')!;
      const nN = regPen.idx.get(cwN.nodes[cwN.cutAt[j]]),
        nS = regPen.idx.get(cwS.nodes[cwS.cutAt[j]]);
      penLegCache.set(key, nN === undefined || nS === undefined ? null : { din: regPen.dij(nN, false), dout: regPen.dij(nS, true), node: nN });
    }
    const G = penLegCache.get(key);
    if (!G) return Infinity;
    let acc: [number, number][] = regPen.near(xz.x, xz.y, 6000);
    if (!acc.length) {
      let best = -1,
        bd = Infinity;
      for (let i = 0; i < regPen.n; i++) {
        const dd = Math.hypot(regPen.X2[i] - xz.x, regPen.Y2[i] - xz.y);
        if (dd < bd) ((bd = dd), (best = i));
      }
      acc = [[best, bd]];
    }
    const D = dir === 'in' ? G.din : G.dout;
    let t = Infinity;
    for (const [node, dd] of acc) {
      const local = Math.min(dd, 6000),
        far = Math.max(0, dd - 6000);
      t = Math.min(t, ((CIRCUITY * local) / 1000 / LOCAL_KMH + (CIRCUITY * far) / 1000 / REGIONAL[p] + D[node] / 1000 / REGIONAL[p]) * 60);
    }
    return t;
  };
  // free-flow minutes along a freeway from interchange j to the county line (northbound)
  const penToCity = (r: PenRoute, j: number) => penOut.filter((x) => x.seg.route === r && x.seg.dir === 'N' && x.seg.from <= j).reduce((t, x) => t + x.o.t0[0], 0);
  let nExt = 0,
    nPen = 0;
  X.forEach((xz, e) => {
    const c = NZ + e;
    // the Peninsula freeways: the interchanges whose leg and drive to the city line are within 5
    // minutes (AM) of the best (at most two), unless the zone is near the line and its own leg to
    // the gateway is as quick
    const penPick = new Map<number, number[]>();
    const penBest = new Map<number, number>();
    if (penOn)
      for (const r of PEN_ROUTES) {
        const opts = PEN_CUTS[r].map((_, j) => (j === 0 ? Infinity : penLeg(xz, r, j, 'AM', 'in') + penToCity(r, j)));
        const best = Math.min(...opts);
        if (!Number.isFinite(best)) continue;
        const g = penGw(r);
        if (legMin(xz, gws[g], 'AM').min <= best + 1) continue;
        penPick.set(g, opts.map((v, j) => [v, j]).filter(([v]) => v <= best + 5).sort((a, b) => a[0] - b[0]).slice(0, 2).map(([, j]) => j));
        penBest.set(g, best);
      }
    // the gateways within 20 minutes (AM) of its best
    const am = gws.map((g, gi) => (penBest.has(gi) ? penBest.get(gi)! : legMin(xz, g, 'AM').min));
    const best = Math.min(...am);
    const pick = gws.map((g, i) => i).filter((i) => Number.isFinite(am[i]) && am[i] <= best + 20).sort((i, j) => am[i] - am[j]).slice(0, 8);
    if (!pick.length) console.warn(`no regional path from ${xz.name ?? e} to any gateway`);
    for (const g of pick) {
      const cuts = penPick.get(g);
      if (cuts) {
        const r = PEN_ROUTES.find((x) => penGw(x) === g)!;
        for (const j of cuts) {
          const tin = TPERIODS.map((p) => penLeg(xz, r, j, p, 'in')),
            tout = TPERIODS.map((p) => penLeg(xz, r, j, p, 'out'));
          if (![...tin, ...tout].every(Number.isFinite)) continue;
          out.push({ a: c, b: cutNode.get(`${r}|N|${j}`)!, lenMi: 0, t0: tin, cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: TPERIODS.map(() => 0), name: '', pts: [] });
          out.push({ a: cutNode.get(`${r}|S|${j}`)!, b: c, lenMi: 0, t0: tout, cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: TPERIODS.map(() => 0), name: '', pts: [] });
          nPen += 2;
        }
        continue;
      }
      const legs = TPERIODS.map((p) => legMin(xz, gws[g], p, 'in')),
        legsOut = TPERIODS.map((p) => legMin(xz, gws[g], p, 'out'));
      if (![...legs, ...legsOut].every((l) => Number.isFinite(l.min))) continue;
      const q = legs[0].q;
      out.push({ a: c, b: hubIn(g), lenMi: 0, t0: legs.map((l) => l.min), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: TPERIODS.map(() => q?.toll ?? 0), name: '', pts: [] });
      out.push({ a: hubOut(g), b: c, lenMi: 0, t0: legsOut.map((l) => l.min), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: TPERIODS.map(() => 0), name: '', pts: [] });
      nExt += 2;
    }
  });
  gws.forEach((g, i) => {
    const zero = () => TPERIODS.map(() => 0);
    // gateway centroids (through traffic and the counted background): tolls as for anyone crossing
    const q = QUEUES.find((Q) => Q.match.test(g.name));
    out.push({ a: gwCentroid(i), b: hubIn(i), lenMi: 0, t0: zero(), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: TPERIODS.map(() => q?.toll ?? 0), name: '', pts: [] });
    out.push({ a: hubOut(i), b: gwCentroid(i), lenMi: 0, t0: zero(), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: zero(), name: '', pts: [] });
    for (const v of g.ins) out.push({ a: hubIn(i), b: nodeId.get(v)!, lenMi: 0, t0: zero(), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: zero(), name: '', pts: [] });
    for (const v of g.outs) out.push({ a: nodeId.get(v)!, b: hubOut(i), lenMi: 0, t0: zero(), cap: 0, lanes: 0, vdf: VDF_FIXED, ja: 0, cls: 0, toll: zero(), name: '', pts: [] });
  });
  console.log(`connectors: ${nConn} zone, ${nExt} outside-zone to gateways, ${nPen} to the Peninsula freeways' interchanges`);

  // ---------- keep what is strongly connected to the zones ----------
  const adj: number[][] = Array.from({ length: nNodes }, () => []),
    radj: number[][] = Array.from({ length: nNodes }, () => []);
  out.forEach((l, k) => (adj[l.a].push(k), radj[l.b].push(k)));
  const reach = (from: number, fwd: boolean) => {
    const seen = new Uint8Array(nNodes);
    const st = [from];
    seen[from] = 1;
    while (st.length) {
      const u = st.pop()!;
      for (const k of fwd ? adj[u] : radj[u]) {
        const v = fwd ? out[k].b : out[k].a;
        if (!seen[v]) (seen[v] = 1), st.push(v);
      }
    }
    return seen;
  };
  // from the zone nearest the middle of the city, both ways
  const mid = Z.reduce((bi, z, i) => (Math.hypot(z.lat - 37.7749, z.lon + 122.4194) < Math.hypot(Z[bi].lat - 37.7749, Z[bi].lon + 122.4194) ? i : bi), 0);
  // centroids may only be path ends, so search from a street node next to it
  const seed = out.find((l) => l.a === mid)!.b;
  const f = reach(seed, true),
    r = reach(seed, false);
  const keepNode = (v: number) => v < nC || (f[v] && r[v]);
  let kept = out.filter((l) => keepNode(l.a) && keepNode(l.b));
  const newId = new Int32Array(nNodes).fill(-1);
  let nn = 0;
  // drop street nodes no link touches
  const touched = new Uint8Array(nNodes);
  for (const l of kept) touched[l.a] = touched[l.b] = 1;
  nn = 0;
  for (let v = 0; v < nNodes; v++) newId[v] = v < nC + nHub + nPenHub || touched[v] ? nn++ : -1;
  kept = kept.map((l) => ({ ...l, a: newId[l.a], b: newId[l.b] }));
  const lostZones = Z.filter((_, i) => !kept.some((l) => l.a === i)).length;
  console.log(`strongly connected: ${nn} nodes, ${kept.length} links (dropped ${out.length - kept.length}); zones without a connector ${lostZones}`);
  // street-link index after filtering, for the counts
  const keptIndex = new Map<Out, number>();
  // sort by tail (forward star)
  const order = kept.map((_, i) => i).sort((p, q) => kept[p].a - kept[q].a || kept[p].b - kept[q].b);
  const sorted = order.map((i) => kept[i]);
  sorted.forEach((l, i) => keptIndex.set(l, i));
  const outIndex = new Map<Out, Out>();
  {
    let j = 0;
    for (const l of out) if (keepNode(l.a) && keepNode(l.b)) outIndex.set(l, kept[j++]);
  }
  /** the final index of street link i (links[] order), or -1 if dropped */
  const finalOf = (i: number) => {
    const o = outIndex.get(out[linkOf[i]]);
    return o ? keptIndex.get(o)! : -1;
  };
  const nL = sorted.length;
  const start = new Int32Array(nn + 1);
  for (const l of sorted) start[l.a + 1]++;
  for (let i = 0; i < nn; i++) start[i + 1] += start[i];

  // node coordinates
  const nodeLat = new Float32Array(nn),
    nodeLon = new Float32Array(nn);
  Z.forEach((z, i) => ((nodeLat[i] = z.lat), (nodeLon[i] = z.lon)));
  X.forEach((x, i) => ((nodeLat[NZ + i] = x.lat), (nodeLon[NZ + i] = x.lon)));
  gws.forEach((g, i) => {
    for (const v of [NZ + NX + i, hubIn(i), hubOut(i)]) (nodeLat[newId[v]] = g.lat), (nodeLon[newId[v]] = g.lon);
  });
  for (const [key, v] of cutNode) {
    const [r, d, j] = key.split('|');
    const c = pen.cw.find((x) => x.route === r && x.dir === d)!;
    const [la, lo] = pen.pos.get(c.nodes[c.cutAt[Number(j)]])!;
    nodeLat[newId[v]] = la;
    nodeLon[newId[v]] = lo;
  }
  for (const [v, id] of nodeId) if (newId[id] >= 0) (nodeLat[newId[id]] = vertices[v].lat), (nodeLon[newId[id]] = vertices[v].lon);

  // ---------- counts ----------
  const counts: RoadCount[] = [];
  const linkGrid = new Map<string, number[]>();
  sorted.forEach((l, k) => {
    if (l.cls === 0) return;
    const ma = Math.floor(l.pts.length / 4) * 2;
    for (let i = 0; i < l.pts.length; i += 2) {
      const [x, y] = toXY(l.pts[i], l.pts[i + 1]);
      const key = `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
      const arr = linkGrid.get(key) ?? linkGrid.set(key, []).get(key)!;
      if (arr[arr.length - 1] !== k) arr.push(k);
    }
    void ma;
  });
  /** distance from a point to a link's drawn line, and the link's heading there (unit vector) */
  const toLink = (k: number, x: number, y: number) => {
    const p = sorted[k].pts;
    let best = Infinity,
      hx = 0,
      hy = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [ax, ay] = toXY(p[i], p[i + 1]),
        [bx, by] = toXY(p[i + 2], p[i + 3]);
      const d = segDist(x, y, ax, ay, bx, by);
      if (d < best) {
        best = d;
        const L = Math.hypot(bx - ax, by - ay) || 1;
        hx = (bx - ax) / L;
        hy = (by - ay) / L;
      }
    }
    return { d: best, hx, hy };
  };
  const linksNear = (x: number, y: number, max: number, ok: (k: number) => boolean) => {
    const res: { k: number; d: number; hx: number; hy: number }[] = [];
    const gx = Math.floor(x / 100),
      gy = Math.floor(y / 100),
      R = Math.ceil(max / 100);
    const seen = new Set<number>();
    for (let i = -R; i <= R; i++)
      for (let j = -R; j <= R; j++)
        for (const k of linkGrid.get(`${gx + i},${gy + j}`) ?? []) {
          if (seen.has(k) || !ok(k)) continue;
          seen.add(k);
          const t = toLink(k, x, y);
          if (t.d <= max) res.push({ k, ...t });
        }
    return res.sort((p, q) => p.d - q.d);
  };
  const clsName = (k: number) => RCLS[sorted[k].cls];
  // Caltrans 2023 AADT: both ways at each point on a state highway
  {
    const cal = JSON.parse(fs.readFileSync(`${ROADS_RAW}/caltrans_aadt_sf.json`, 'utf8')) as { features: { attributes: Record<string, string | number | null>; geometry: { x: number; y: number } }[] };
    const truck = JSON.parse(fs.readFileSync(`${ROADS_RAW}/caltrans_truck_sf.json`, 'utf8')) as { features: { attributes: Record<string, string | number | null> }[] };
    const refOf: Record<string, RegExp> = { '101': /US 101/, '280': /I 280/, '080': /I 80/, '001': /CA 1/, '035': /CA 35/, '082': /CA 82/ };
    // a postmile's points: the same count is often published twice (both sides of the road), and
    // where a highway splits into two alignments each carries its own count (one per direction,
    // summed here to compare with both carriageways); a point named for an alignment only counts
    // when nothing else is published at that postmile
    const groups = new Map<string, typeof cal.features>();
    for (const f of cal.features) {
      const k = `${f.attributes.RTE}|${f.attributes.PM}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
    }
    const valOf = (a: Record<string, string | number | null>) => {
      const back = Number(a.BACK_AADT) || 0,
        ahead = Number(a.AHEAD_AADT) || 0;
      // at a point between two counted segments, the mean of the two
      return back && ahead ? (back + ahead) / 2 : back || ahead;
    };
    const peakOf = (a: Record<string, string | number | null>) => {
      const b = Number(a.BACK_PEAK_HOUR) || 0,
        h = Number(a.AHEAD_PEAK_HOUR) || 0;
      return b && h ? (b + h) / 2 : b || h;
    };
    for (const fs0 of groups.values()) {
      const uniq = [...new Map(fs0.map((f) => [`${f.attributes.DESCRIPTION}|${f.attributes.BACK_AADT}|${f.attributes.AHEAD_AADT}`, f])).values()].filter((f) => valOf(f.attributes) > 0);
      if (!uniq.length) continue;
      const plain = uniq.filter((f) => !/ALIGNMENT/.test(String(f.attributes.DESCRIPTION)));
      const use = plain.length ? plain : uniq;
      const f = use[0];
      const a = f.attributes;
      const rte = String(a.RTE).padStart(3, '0');
      if (!refOf[rte]) continue;
      const aadt = use.reduce((s1, g) => s1 + valOf(g.attributes), 0);
      const peak = use.reduce((s1, g) => s1 + peakOf(g.attributes), 0) || undefined;
      const [x, y] = toXY(f.geometry.y, f.geometry.x);
      // the route's links here, the nearest each way (a divided highway's two carriageways)
      const near = linksNear(x, y, 90, (k) => refOf[rte].test(sorted[k].ref ?? '') && sorted[k].cls !== 2);
      const pick: typeof near = [];
      for (const n of near) if (!pick.some((p) => p.hx * n.hx + p.hy * n.hy > 0)) pick.push(n);
      if (pick.length < 1) continue;
      const desc = String(a.DESCRIPTION).replace(/^SAN FRANCISCO, /, '');
      // the counts where the roads cross the city line fit the background (roads-base.ts); SR-1's
      // county-line point is on the freeway it shares with I-280, counted there already, so it stays a test
      const gateway = /COUNTY LINE|GOLDEN GATE BRIDGE/.test(desc) && rte !== '001';
      const tr = truck.features.find((t) => String(t.attributes.RTE).padStart(3, '0') === rte && Math.abs(Number(t.attributes.POSTMILE) - Number(a.PM)) < 0.05);
      counts.push({ src: 'caltrans', id: `${rte}-${a.PM}`, desc: `${rte === '080' ? 'I-80' : rte === '280' ? 'I-280' : rte === '101' ? 'US-101' : `SR-${Number(rte)}`} at ${desc.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}`, links: pick.map((p) => p.k), daily: Math.round(aadt * WEEKDAY_OF_AADT), peak: peak ? Math.round(peak * WEEKDAY_OF_AADT) : undefined, cls: clsName(pick[0].k), ...(gateway ? { fitted: true } : {}), ...(tr ? { truckPct: Number(tr.attributes.TRK_PERCENT_TOT) } : {}) } as RoadCount);
    }
  }
  // SFMTA weekday counts 2021–2023 (Tue–Thu), by street block (CNN) and direction
  {
    const geo = JSON.parse(fs.readFileSync(`${ROADS_RAW}/sf_streets_cnn.geojson`, 'utf8')) as { features: { properties: { cnn: string; streetname: string; f_node_cnn: string; t_node_cnn: string }; geometry: { type: string; coordinates: number[][] } | null }[] };
    const cnnGeo = new Map<string, { name: string; line: [number, number][] }>();
    // where streets meet: the city's centerline nodes and the streets at each
    const nodeXY = new Map<string, [number, number]>(),
      nodeStreets = new Map<string, Set<string>>();
    for (const f of geo.features) {
      if (f.geometry?.type !== 'LineString') continue;
      const line = f.geometry.coordinates.map(([lon, lat]) => toXY(lat, lon) as [number, number]);
      cnnGeo.set(String(Number(f.properties.cnn)), { name: f.properties.streetname, line });
      const ends: [string, [number, number]][] = [
        [String(Number(f.properties.f_node_cnn)), line[0]],
        [String(Number(f.properties.t_node_cnn)), line[line.length - 1]],
      ];
      for (const [n, xy] of ends) {
        nodeXY.set(n, xy);
        (nodeStreets.get(n) ?? nodeStreets.set(n, new Set()).get(n)!).add(normName(f.properties.streetname ?? ''));
      }
    }
    /** where two streets cross (the first such node; streets that cross twice are rare) */
    const crossing = (a: string, b: string): [number, number] | null => {
      for (const [n, st] of nodeStreets) if (st.has(a) && st.has(b)) return nodeXY.get(n)!;
      return null;
    };
    const csv = fs.readFileSync(`${ROADS_RAW}/sfmta_corridor_counts_2014_2022.csv`, 'latin1').split(/\r?\n/);
    const head = csv[0].split(',');
    const col = (n: string) => head.indexOf(n);
    const parse = (line: string) => {
      const out: string[] = [];
      let cur = '',
        q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) (out.push(cur), (cur = ''));
        else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const DIR: Record<string, [number, number]> = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
    const groups = new Map<string, { adt: number[]; am: number[]; pm: number[]; year: number; name: string; x1: string; x2: string; desc: string; cnn: string; dir: string }>();
    for (const line of csv.slice(1)) {
      if (!line.trim()) continue;
      const c = parse(line);
      const year = Number(c[col('YEAR')]);
      const dow = (c[col('DAY_OF_WEEK')] || '').toUpperCase();
      const adt = Number(c[col('VOLUME_ADT')]);
      if (!(year >= 2021) || !['TUESDAY', 'WEDNESDAY', 'THURSDAY'].includes(dow) || !(adt > 0)) continue;
      const dir = (c[col('DIRECTION')] || '').trim().toUpperCase()[0];
      if (!DIR[dir]) continue;
      const cnn = c[col('CNN')] ? String(Number(c[col('CNN')])) : '';
      const key = `${cnn || `${c[col('PRIMARY_STREET')]}|${c[col('CROSS_STREET_1')]}|${c[col('CROSS_ST_2')]}`}|${dir}`;
      const g = groups.get(key) ?? { adt: [], am: [], pm: [], year, name: c[col('PRIMARY_STREET')], x1: c[col('CROSS_STREET_1')], x2: c[col('CROSS_ST_2')], desc: `${c[col('PRIMARY_STREET')]} between ${c[col('CROSS_STREET_1')]} and ${c[col('CROSS_ST_2')]}`, cnn, dir };
      g.adt.push(adt);
      if (Number(c[col('VOLUME_AM_PEAK')]) > 0) g.am.push(Number(c[col('VOLUME_AM_PEAK')]));
      if (Number(c[col('VOLUME_PM_PEAK')]) > 0) g.pm.push(Number(c[col('VOLUME_PM_PEAK')]));
      g.year = Math.max(g.year, year);
      groups.set(key, g);
    }
    const norm = normName;
    let unmatched = 0;
    for (const g of groups.values()) {
      // the block's middle: from the centerline (CNN), else between the two cross streets
      let mx = NaN,
        my = NaN;
      const want = norm(g.name);
      const geo1 = g.cnn ? cnnGeo.get(g.cnn) : undefined;
      if (geo1) {
        const l = geo1.line;
        let total = 0;
        for (let i = 0; i + 1 < l.length; i++) total += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
        let acc = 0;
        (mx = l[0][0]), (my = l[0][1]);
        for (let i = 0; i + 1 < l.length; i++) {
          const sl = Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
          if (acc + sl >= total / 2) {
            const t = (total / 2 - acc) / (sl || 1);
            mx = l[i][0] + t * (l[i + 1][0] - l[i][0]);
            my = l[i][1] + t * (l[i + 1][1] - l[i][1]);
            break;
          }
          acc += sl;
        }
      } else {
        // cross streets may be written "DONAHUE ST \ GILMAN AVE": take the first
        const x1 = normName(g.x1.split('\\')[0]),
          x2 = normName(g.x2.split('\\')[0]);
        const p1 = x1 ? crossing(normName(g.name), x1) : null,
          p2 = x2 ? crossing(normName(g.name), x2) : null;
        if (p1 && p2 && Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 800) (mx = (p1[0] + p2[0]) / 2), (my = (p1[1] + p2[1]) / 2);
      }
      if (!Number.isFinite(mx)) {
        unmatched++;
        continue;
      }
      const [ux, uy] = DIR[g.dir];
      const near = linksNear(mx, my, 40, (k) => {
        const n = norm(sorted[k].name);
        return n === want || n.startsWith(want) || want.startsWith(n) && n.length > 3;
      }).filter((n) => n.hx * ux + n.hy * uy > 0.3);
      if (!near.length) {
        unmatched++;
        continue;
      }
      const mean = (v: number[]) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : undefined);
      counts.push({ src: 'sfmta', id: `${g.cnn}${g.dir}`, desc: `${g.desc.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())} (${g.dir}B)`, links: [near[0].k], daily: Math.round(mean(g.adt)!), am: mean(g.am) && Math.round(mean(g.am)!), pm: mean(g.pm) && Math.round(mean(g.pm)!), year: g.year, cls: clsName(near[0].k) });
    }
    console.log(`SFMTA counts 2021–23 (Tue–Thu): ${groups.size} block-directions, ${groups.size - unmatched} on the network`);
  }
  console.log(`Caltrans points ${counts.filter((c) => c.src === 'caltrans').length} (${counts.filter((c) => c.fitted).length} at the city line)`);

  // CMP segments as final links
  const cmp: CmpSegment[] = cmpArcs.map((c) => ({
    id: c.seg.cmp_segid,
    name: c.seg.cmp_name,
    from: c.seg.cmp_from,
    to: c.seg.cmp_to,
    dir: c.seg.direction,
    cls: c.fwy ? 'freeway' : 'arterial',
    miles: c.seg.length,
    links: [...new Set(c.arcs.map((a) => finalOf(arcLink[a])).filter((k) => k >= 0))],
    ...(c.AM ? { AM: c.AM } : {}),
    ...(c.PM ? { PM: c.PM } : {}),
  }));

  // ---------- the Peninsula freeways in the header ----------
  const finalOut = (o: Out) => {
    const k = outIndex.get(o);
    return k ? keptIndex.get(k)! : -1;
  };
  let peninsula: RoadHeader['peninsula'];
  if (penOn) {
    const segments = penOut.map(({ seg, o, daily, ffMph }) => ({
      route: seg.route,
      dir: seg.dir,
      from: PEN_CUTS[seg.route][seg.from].name,
      to: PEN_CUTS[seg.route][seg.to].name,
      link: finalOut(o),
      miles: +o.lenMi.toFixed(3),
      lanes: +seg.lanes.toFixed(2),
      hov: +seg.hov.toFixed(2),
      ffMph,
      daily: Math.round(daily),
      target: Object.fromEntries(TPERIODS.map((p) => [p, Math.round(daily * pdata.periodShare[p] * (seg.dir === 'S' ? pdata.southShare[p] : 1 - pdata.southShare[p]))])) as Record<TPeriod, number>,
    }));
    if (segments.some((x) => x.link < 0)) throw new Error('peninsula: a freeway link was dropped from the network');
    const ix = (r: PenRoute, n: string) => PEN_CUTS[r].findIndex((c) => c.name === n);
    const monitored = pdata.cmpSpeeds.map((m) => ({
      route: m.route,
      dir: m.dir,
      from: m.dir === 'S' ? m.north : m.south,
      to: m.dir === 'S' ? m.south : m.north,
      links: penOut.filter((x) => x.seg.route === m.route && x.seg.dir === m.dir && Math.min(x.seg.from, x.seg.to) >= ix(m.route, m.north) && Math.max(x.seg.from, x.seg.to) <= ix(m.route, m.south)).map((x) => finalOut(x.o)),
      ffs: m.ffs,
      AM: m.AM,
      PM: m.PM,
    }));
    peninsula = { segments, monitored, periodShare: pdata.periodShare, southShare: pdata.southShare, cuts: Object.fromEntries(PEN_ROUTES.map((r) => [r, PEN_CUTS[r].map((c) => c.name)])) };
  }

  // ---------- buses on the streets: each hop of every bus line, the links it runs along ----------
  // (traffic feedback adds the change in congestion on them to the hop's running time; traffic.ts)
  const BUSLIKE = new Set(['bus', 'rapid', 'trolley', 'express', 'streetcar']);
  const busLineStart = new Int32Array(B.header.lines.length + 1);
  const hopStart: number[] = [0],
    hopLink: number[] = [],
    hopFrac: number[] = [];
  let mappedLines = 0,
    nHops = 0;
  B.header.lines.forEach((l, li) => {
    busLineStart[li] = nHops;
    if (!BUSLIKE.has(l.mode) || !l.path || l.path.length < 4 || !l.stopAt || l.stopAt.length !== l.stops.length) return;
    const xy: [number, number][] = [];
    for (let i = 0; i < l.path.length; i += 2) xy.push(toXY(l.path[i], l.path[i + 1]) as [number, number]);
    let any = false;
    for (let k = 0; k + 1 < l.stops.length; k++) {
      const cover = new Map<number, number>();
      for (let i = l.stopAt[k]; i < l.stopAt[k + 1] && i + 1 < xy.length; i++) {
        const [ax, ay] = xy[i],
          [bx, by] = xy[i + 1];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1) continue;
        const ux = (bx - ax) / L,
          uy = (by - ay) / L;
        const steps = Math.max(1, Math.round(L / 20));
        for (let j = 0; j < steps; j++) {
          const t = (j + 0.5) / steps;
          const near = linksNear(ax + t * (bx - ax), ay + t * (by - ay), 20, (q) => sorted[q].cls >= 3).filter((n) => n.hx * ux + n.hy * uy > 0.7);
          if (near.length) cover.set(near[0].k, (cover.get(near[0].k) ?? 0) + L / steps);
        }
      }
      for (const [q, m] of cover) {
        const f = Math.min(1, m / (sorted[q].lenMi * 1609.34));
        if (f < 0.2) continue;
        hopLink.push(q);
        hopFrac.push(+f.toFixed(3));
        any = true;
      }
      hopStart.push(hopLink.length);
      nHops++;
    }
    if (any) mappedLines++;
  });
  busLineStart[B.header.lines.length] = nHops;
  console.log(`buses on the streets: ${mappedLines} of ${B.header.lines.filter((l) => BUSLIKE.has(l.mode)).length} bus and streetcar patterns, ${nHops} hops, ${hopLink.length} hop-links; ${sorted.filter((l) => (l.busShare ?? 0) > 0).length} links with a bus lane`);

  // ---------- write ----------
  const names: string[] = [];
  const nameIx = new Map<string, number>();
  const ix = (n: string | undefined) => {
    if (!n) return -1;
    if (!nameIx.has(n)) nameIx.set(n, names.push(n) - 1);
    return nameIx.get(n)!;
  };
  const name = Int32Array.from(sorted, (l) => ix(l.name));
  const ref = Int32Array.from(sorted, (l) => ix(l.ref));
  const shapeStart = new Int32Array(nL + 1);
  const shape: number[] = [];
  sorted.forEach((l, k) => {
    shapeStart[k] = shape.length;
    // drop the points that add little (within 3 m of the straight line), to keep the file small
    const p = l.pts;
    for (let i = 0; i < p.length; i += 2) {
      // (the Peninsula freeways keep every point: road-shapes.ts simplifies them for the map)
      if (i > 0 && i < p.length - 2 && !l.corr) {
        const [ax, ay] = toXY(p[i - 2], p[i - 1]),
          [bx, by] = toXY(p[i], p[i + 1]),
          [cx, cy] = toXY(p[i + 2], p[i + 3]);
        if (segDist(bx, by, ax, ay, cx, cy) < 3) continue;
      }
      shape.push(p[i], p[i + 1]);
    }
  });
  shapeStart[nL] = shape.length;
  const P = TPERIODS.length;
  const t0Arr = new Float32Array(P * nL),
    toll = new Float32Array(P * nL);
  sorted.forEach((l, k) => TPERIODS.forEach((_, q) => ((t0Arr[q * nL + k] = l.t0[q]), (toll[q * nL + k] = l.toll[q]))));
  const gateways: Gateway[] = gws.map((g, i) => ({ name: g.name, kind: g.kind, lat: +g.lat.toFixed(5), lon: +g.lon.toFixed(5), centroid: NZ + NX + i }));
  const header: Omit<RoadHeader, 'arrays'> = {
    version: 1,
    built: new Date().toISOString(),
    nZ: NZ,
    nX: NX,
    nC,
    nNodes: nn,
    nLinks: nL,
    gateways,
    nHub,
    ...(peninsula ? { peninsula } : {}),
    names,
    counts,
    cmp,
    speedTargets: {
      freeFlow: { arterial: target.arterial, freeway: target.freeway, signalDelaySec: +sigDelay.toFixed(2), signalDelayByAreaType: sigDelayAT.map((x) => +x.toFixed(2)), cruiseByAreaType: cruiseAT.map((x) => +x.toFixed(3)), freewayShareOfLimit: +fwyShare.toFixed(4) },
      arterial: hourly.arterial,
      freeway: hourly.freeway,
      cmpPeak: { arterialAM: speeds.citywide.arterial.AM, arterialPM: speeds.citywide.arterial.PM, freewayAM: speeds.citywide.freeway.AM, freewayPM: speeds.citywide.freeway.PM },
    },
  };
  const arrays: Record<string, Float32Array | Int32Array | Uint8Array | Uint16Array> = {
    a: Int32Array.from(sorted, (l) => l.a),
    b: Int32Array.from(sorted, (l) => l.b),
    start,
    len: Float32Array.from(sorted, (l) => l.lenMi),
    t0: t0Arr,
    cap: Float32Array.from(sorted, (l) => l.cap),
    lanes: Float32Array.from(sorted, (l) => l.lanes),
    vdf: Uint8Array.from(sorted, (l) => l.vdf),
    ja: Float32Array.from(sorted, (l) => l.ja),
    cls: Uint8Array.from(sorted, (l) => l.cls),
    toll,
    name,
    ref,
    nodeLat,
    nodeLon,
    shapeStart,
    shape: Float32Array.from(shape),
    busLane: Float32Array.from(sorted, (l) => l.busShare ?? 0),
    sig: Uint8Array.from(sorted, (l) => Math.min(255, l.sig ?? 0)),
    busLineStart,
    busHopStart: Int32Array.from(hopStart),
    busHopLink: Int32Array.from(hopLink),
    busHopFrac: Float32Array.from(hopFrac),
    corr: Uint8Array.from(sorted, (l) => l.corr ?? 0),
  };
  const bin = encodeBundle(header as never, arrays);
  fs.writeFileSync(`${WORK}/roads-net.bin`, bin);
  const gz = zlib.gzipSync(bin, { level: 9 });
  console.log(`road network: ${nn} nodes (${nC} centroids), ${nL} links (${sorted.filter((l) => l.cls > 0).length} streets, ${(sorted.reduce((a, l) => a + (l.cls > 0 ? l.lenMi : 0), 0)).toFixed(0)} miles of street, each way counted); ${counts.length} counts, ${cmp.length} CMP segments; ${(bin.length / 1e6).toFixed(1)} MB → ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
  const byCls = RCLS.map((c, i) => `${c} ${sorted.filter((l) => l.cls === i).length}`).join(', ');
  console.log(`  by class: ${byCls}`);
  void BUNDLE;
  console.timeEnd('roads');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
