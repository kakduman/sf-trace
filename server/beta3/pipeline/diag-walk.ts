/**
 * Checks on the walking network (streets.json): how far round the network is from the straight
 * line between blocks and the stops near them, the pieces the network falls into and who lives
 * and works on them, the people within 400 and 800 m of a stop, and walks between known places.
 * With skims built, also each zone's road and bike distance against the straight line.
 * Writes data/beta3/work/diag-walk.json.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-walk.ts
 */
import fs from 'node:fs';
import { toXY } from '../../../shared/beta3/geo';
import { dijkstra, Graph, Snapper } from './graph';
import { WORK } from './paths';
import type { StreetEdge, StreetVertex } from './streets';
import type { Stop } from './transit';
import { mainPieces, strongComponents, WALK_FLAT, walkGraph } from './walk';
import type { InternalZone } from './zones';

/** walks between known places: from a point to a point, or to the nearest stop matching a name */
export const KNOWN: { name: string; from: [number, number]; to: [number, number] | { stop: RegExp; feed: string } }[] = [
  { name: 'City College (Science Hall) to Balboa Park BART', from: [37.72571, -122.45112], to: { stop: /^Balboa Park$/, feed: 'bart' } },
  { name: 'City College (Science Hall) to City College Terminal', from: [37.72571, -122.45112], to: { stop: /^City College Terminal/, feed: 'muni' } },
  { name: 'City College (Cloud Hall) to Ocean Ave/Balboa Park', from: [37.72505, -122.45197], to: { stop: /^Ocean Ave\/Balboa Park/, feed: 'muni' } },
  { name: 'SF State (Cesar Chavez Center) to 19th Ave & Holloway', from: [37.72232, -122.47857], to: { stop: /^19th Ave & Holloway/, feed: 'muni' } },
  { name: 'Ferry Building to Embarcadero BART', from: [37.79553, -122.39345], to: { stop: /^Embarcadero$/, feed: 'bart' } },
  { name: 'UCSF Mission Bay (Genentech Hall) to UCSF/Chase Center', from: [37.76731, -122.39337], to: { stop: /^UCSF \/ Chase Center/, feed: 'muni' } },
  { name: 'Presidio Main Post to Lombard Gate', from: [37.80052, -122.45848], to: [37.79856, -122.44696] },
  { name: 'Golden Gate Park: de Young to 9th Ave & Lincoln', from: [37.77146, -122.46868], to: [37.76598, -122.46634] },
  { name: 'Filbert Steps: Sansome St to Coit Tower', from: [37.80195, -122.40326], to: [37.80236, -122.40582] },
  { name: 'Glen Park village to Glen Park BART', from: [37.73397, -122.43381], to: { stop: /^Glen Park$/, feed: 'bart' } },
];

const RAD = [200, 800] as const;

function main() {
  console.time('diag-walk');
  const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  const Z = (JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8')) as { internal: InternalZone[] }).internal;
  const { stops } = JSON.parse(fs.readFileSync(`${WORK}/transit.json`, 'utf8')) as { stops: Stop[] };
  const NV = vertices.length;
  const vx = Float64Array.from(vertices, (v) => v.x), vy = Float64Array.from(vertices, (v) => v.y);
  const { g, len } = walkGraph(vertices, edges);
  // the same network by length, for distances
  const byLen: { a: number; b: number; cost: number; edge: number }[] = [];
  for (let u = 0; u < NV; u++) for (let k = g.start[u]; k < g.start[u + 1]; k++) byLen.push({ a: u, b: g.to[k], cost: len[k], edge: k });
  const L = new Graph(NV, byLen);

  const walkVertex = new Uint8Array(NV);
  for (const e of edges) if (e.walk && !e.under && !e.above) walkVertex[e.a] = walkVertex[e.b] = 1;
  const main = mainPieces(g, 150);
  const snap = new Snapper(vx, vy, (i) => walkVertex[i] === 1 && main[i] === 1);
  const anySnap = new Snapper(vx, vy, (i) => walkVertex[i] === 1);
  const inCity = (s: Stop) => s.lat > 37.69 && s.lat < 37.84 && s.lon > -122.53 && s.lon < -122.35;

  // ---- pieces ----
  const comp = strongComponents(g);
  const size = new Map<number, number>();
  for (const c of comp) if (c >= 0) size.set(c, (size.get(c) ?? 0) + 1);
  const sizes = [...size.values()].sort((a, b) => b - a);
  // a block's people and jobs: the zone's, shared out by the block's weight (residents plus jobs)
  const pts = Z.flatMap((z) => {
    const W = z.points.reduce((s, p) => s + p.w, 0) || 1;
    return z.points.map((p) => ({ z, x: p.x, y: p.y, w: p.w, pop: (z.pop * p.w) / W, jobs: (z.jobs * p.w) / W }));
  });
  let offPop = 0, offJobs = 0, offPts = 0;
  const offPlaces = new Map<string, number>();
  for (const p of pts) {
    const v = anySnap.nearest(p.x, p.y);
    if (main[v.i]) continue;
    offPts++, (offPop += p.pop), (offJobs += p.jobs);
    offPlaces.set(p.z.nhood, (offPlaces.get(p.z.nhood) ?? 0) + p.pop + p.jobs);
  }
  const pieces = {
    count: sizes.length,
    largest: sizes[0],
    mainShare: +(main.reduce((s, m) => s + m, 0) / [...comp].filter((c) => c >= 0).length).toFixed(4),
    over10: sizes.filter((n) => n > 10).length,
    blocksOff: offPts,
    popOff: Math.round(offPop),
    jobsOff: Math.round(offJobs),
    where: [...offPlaces].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, w]) => `${n} ${Math.round(w)}`),
  };
  console.log('pieces', pieces);

  // ---- circuity: each block to the stops 200-800 m from it ----
  const city = stops.map((s, k) => k).filter((k) => inCity(stops[k]));
  const stopV = stops.map((s) => snap.nearest(s.x, s.y));
  const ptV = pts.map((p) => snap.nearest(p.x, p.y));
  const grid = new Snapper(Float64Array.from(pts, (p) => p.x), Float64Array.from(pts, (p) => p.y), () => true, 400);
  const dist = new Float64Array(NV);
  const ratios: { r: number; w: number; nh: string; zone: string; x: number; y: number }[] = [];
  for (const s of city) {
    const near = grid.within(stops[s].x, stops[s].y, RAD[1]).filter((q) => q.d >= RAD[0]);
    if (!near.length) continue;
    dijkstra(L, [[stopV[s].i, stopV[s].d]], RAD[1] * 4, dist);
    for (const q of near) {
      const p = pts[q.i];
      const net = dist[ptV[q.i].i] + ptV[q.i].d;
      ratios.push({ r: Math.min(10, net / q.d), w: p.w, nh: p.z.nhood, zone: p.z.id, x: p.x, y: p.y });
    }
  }
  const wq = (list: typeof ratios, f: number) => {
    const s = [...list].sort((a, b) => a.r - b.r);
    const W = s.reduce((t, x) => t + x.w, 0);
    let c = 0;
    for (const x of s) if ((c += x.w) >= f * W) return +x.r.toFixed(3);
    return +s[s.length - 1].r.toFixed(3);
  };
  const share = (list: typeof ratios, f: (x: (typeof ratios)[number]) => boolean) => {
    const W = list.reduce((t, x) => t + x.w, 0);
    return +(list.filter(f).reduce((t, x) => t + x.w, 0) / W).toFixed(4);
  };
  const circuity = {
    pairs: ratios.length,
    median: wq(ratios, 0.5),
    p75: wq(ratios, 0.75),
    p90: wq(ratios, 0.9),
    p95: wq(ratios, 0.95),
    over1_5: share(ratios, (x) => x.r > 1.5),
    over2: share(ratios, (x) => x.r > 2),
    over3: share(ratios, (x) => x.r > 3),
  };
  console.log('circuity (block to stop, 200-800 m, weighted by residents + jobs)', circuity);
  // where: the neighborhoods with the most weight in pairs over 2
  const byNh = new Map<string, { w: number; bad: number }>();
  for (const x of ratios) {
    const o = byNh.get(x.nh) ?? { w: 0, bad: 0 };
    o.w += x.w;
    if (x.r > 2) o.bad += x.w;
    byNh.set(x.nh, o);
  }
  const hot = [...byNh].map(([nh, o]) => ({ nh, over2: +(o.bad / o.w).toFixed(3) })).sort((a, b) => b.over2 - a.over2);
  console.log('neighborhoods with most pairs over 2:', hot.slice(0, 12).map((h) => `${h.nh} ${(h.over2 * 100).toFixed(0)}%`).join(', '));
  // blocks whose median ratio is over 2, as points for a map
  const byPt = new Map<string, { x: number; y: number; r: number[]; w: number; zone: string }>();
  for (const x of ratios) {
    const k = `${x.x},${x.y}`;
    const o = byPt.get(k) ?? { x: x.x, y: x.y, r: [], w: x.w, zone: x.zone };
    o.r.push(x.r);
    byPt.set(k, o);
  }
  const badBlocks = [...byPt.values()].map((o) => ({ ...o, med: o.r.sort((a, b) => a - b)[o.r.length >> 1] })).filter((o) => o.med > 2);

  // ---- people within 400 and 800 m of a stop, by the network ----
  dijkstra(L, city.map((s) => [stopV[s].i, stopV[s].d] as [number, number]), 2000, dist);
  let P = 0, J = 0, p400 = 0, p800 = 0, j400 = 0, j800 = 0;
  const zoneNear = new Map<string, number>();
  pts.forEach((p, q) => {
    const d = dist[ptV[q].i] + ptV[q].d;
    (P += p.pop), (J += p.jobs);
    if (d <= 400) (p400 += p.pop), (j400 += p.jobs), zoneNear.set(p.z.id, (zoneNear.get(p.z.id) ?? 0) + p.pop);
    if (d <= 800) (p800 += p.pop), (j800 += p.jobs);
  });
  const access = {
    pop400: +(p400 / P).toFixed(4), pop800: +(p800 / P).toFixed(4), jobs400: +(j400 / J).toFixed(4), jobs800: +(j800 / J).toFixed(4),
    zonesUnderHalf400: Z.filter((z) => z.pop > 0 && (zoneNear.get(z.id) ?? 0) / z.pop < 0.5).length,
  };
  console.log('within reach of a stop (network distance)', access);

  // ---- known walks ----
  const known = KNOWN.map((k) => {
    const [fx, fy] = toXY(k.from[0], k.from[1]);
    let tx: number, ty: number;
    if (Array.isArray(k.to)) [tx, ty] = toXY(k.to[0], k.to[1]);
    else {
      const to = k.to;
      const cands = stops.filter((s) => s.feed === to.feed && to.stop.test(s.name));
      const s = cands.sort((a, b) => Math.hypot(a.x - fx, a.y - fy) - Math.hypot(b.x - fx, b.y - fy))[0];
      [tx, ty] = [s.x, s.y];
    }
    const a = snap.nearest(fx, fy), b = snap.nearest(tx, ty);
    dijkstra(L, [[a.i, a.d]], 20000, dist);
    const m = dist[b.i] + b.d;
    const time = new Float64Array(NV);
    dijkstra(g, [[a.i, a.d / WALK_FLAT]], 20000, time);
    const straight = Math.hypot(tx - fx, ty - fy);
    return { name: k.name, straight: Math.round(straight), network: Math.round(m), ratio: +(m / straight).toFixed(2), min: +((time[b.i] + b.d / WALK_FLAT) / 60).toFixed(1) };
  });
  for (const k of known) console.log(`  ${k.name}: ${k.straight} m straight, ${k.network} m by the network (${k.ratio}), ${k.min} min`);

  // ---- stairs ----
  const stepsKm = edges.filter((e) => e.steps).reduce((s, e) => s + e.len, 0) / 1000;
  const stepsMain = edges.filter((e) => e.steps && main[e.a] && main[e.b]).reduce((s, e) => s + e.len, 0) / 1000;
  const stairs = { km: +stepsKm.toFixed(1), onMain: +(stepsMain / stepsKm).toFixed(3) };
  console.log('stairs', stairs);

  // ---- with skims: road and bike distance against the straight line, by destination zone ----
  let zonesCheck: unknown = null;
  if (fs.existsSync(`${WORK}/skims.json`)) {
    const sk = JSON.parse(fs.readFileSync(`${WORK}/skims.json`, 'utf8')) as { NZ: number; index: Record<string, { offset: number; length: number }> };
    const bin = fs.readFileSync(`${WORK}/skims.bin`);
    const get = (k: string) => new Uint16Array(bin.buffer, bin.byteOffset + sk.index[k].offset, sk.index[k].length);
    const NZ = sk.NZ;
    const ratio = (key: string, scale: number, maxD: number) => {
      const m = get(key);
      return Z.map((zd, d) => {
        const r: number[] = [];
        for (let o = 0; o < NZ; o++) {
          const s = Math.hypot(Z[o].x - zd.x, Z[o].y - zd.y);
          if (o !== d && s >= 1000 && s <= maxD) r.push((m[o * NZ + d] * scale) / s);
        }
        return r.sort((a, b) => a - b)[r.length >> 1] ?? 0;
      });
    };
    const car = ratio('autoDm', 10, Infinity), bike = ratio('bikeM', 1, 4000), walk = ratio('walkM', 1, 4000);
    const worst = (r: number[]) => r.map((v, d) => [Z[d].id, Z[d].nhood, +v.toFixed(2)] as const).sort((a, b) => b[2] - a[2]).slice(0, 5);
    zonesCheck = {
      car: { over2_5: car.filter((v) => v > 2.5).length, worst: worst(car) },
      bike: { over2_5: bike.filter((v) => v > 2.5).length, worst: worst(bike) },
      walk: { over2_5: walk.filter((v) => v > 2.5).length, worst: worst(walk) },
    };
    console.log('zones whose median distance from other zones is over 2.5 times the straight line', JSON.stringify(zonesCheck));
  }

  fs.writeFileSync(`${WORK}/diag-walk.json`, JSON.stringify({ pieces, circuity, hot, access, known, stairs, zones: zonesCheck, badBlocks: badBlocks.map((b) => [Math.round(b.x), Math.round(b.y), +b.med.toFixed(2), b.zone]) }, null, 1));
  console.timeEnd('diag-walk');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
