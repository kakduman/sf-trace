/**
 * The street layer's drawn shapes (client/beta3/model/road-shapes.bin.gz): each road link's true
 * course, the chain of OpenStreetMap street edges it was built from, simplified by Douglas–Peucker
 * to 2.5 m and quantized to about a metre (shared/beta3/roadShapes.ts).
 *
 * A link joins the edges between two junctions, passing through bends (roads.ts). Its chain is
 * found again here from streets.json: from the junction at the link's tail, the edge chain that
 * passes only through bends and reaches the link's head with the link's length. Where the streets
 * have changed since the roads bundle was built (an edge split or a vertex moved), the shortest
 * street path between the link's ends is taken instead, if its length matches and the bundle's own
 * points lie on it. Links found neither way keep the bundle's shape (the file stores no points).
 *
 * Run right after roads.ts (it reads ${WORK}/roads-net.bin and streets.json, the same ones):
 *   npx tsx server/beta3/pipeline/road-shapes.ts
 * or against the shipped bundle: npx tsx server/beta3/pipeline/road-shapes.ts --bundle
 * (add --streets <file> when the bundle was built from an older streets.json)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { toXY } from '../../../shared/beta3/geo';
import { encodeRoadShapes, roadLinkKey, simplify } from '../../../shared/beta3/roadShapes';
import { BUNDLE, WORK } from './paths';
import type { StreetEdge, StreetVertex } from './streets';

/** Douglas–Peucker tolerance, metres: half a metre to a metre off is invisible at zoom 17 */
const TOL = 1;

interface Arc {
  a: number;
  b: number;
  len: number;
  pts: number[];
}

/** distance (m) from point p to the polyline (flat x,y) */
function toLine(px: number, py: number, xy: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < xy.length; i += 2) {
    const ax = xy[i],
      ay = xy[i + 1],
      dx = xy[i + 2] - ax,
      dy = xy[i + 3] - ay,
      L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return xy.length === 2 ? Math.hypot(px - xy[0], py - xy[1]) : best;
}

function main() {
  console.time('road-shapes');
  const fromBundle = process.argv.includes('--bundle');
  const src = fromBundle ? decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`))) : decodeBundle(fs.readFileSync(`${WORK}/roads-net.bin`));
  const A = src.a as Record<string, ArrayLike<number>>;
  const nL = (src.header as unknown as { nLinks: number }).nLinks;
  const { a: la, b: lb, cls, len, nodeLat, nodeLon, shapeStart, shape } = A;
  const key = roadLinkKey(nL, la, lb, cls);
  console.log(`road network (${fromBundle ? 'roads.bin.gz' : 'roads-net.bin'}): ${nL} links, key ${key}`);

  // the car arcs, as roads.ts makes them
  // the streets the network was built from (default the work folder's; --streets for an older copy)
  const si = process.argv.indexOf('--streets');
  const streetsFile = si > 0 ? process.argv[si + 1] : `${WORK}/streets.json`;
  const { vertices, edges } = JSON.parse(fs.readFileSync(streetsFile, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  console.log(`streets: ${streetsFile}`);
  const arcs: Arc[] = [];
  for (const e of edges) {
    if (!e.car || e.cls === 'service' || e.cls === 'living_street') continue;
    const [lf, lbk] = e.lanes ?? [1, 1];
    const rev: number[] = [];
    for (let i = e.pts.length - 2; i >= 0; i -= 2) rev.push(e.pts[i], e.pts[i + 1]);
    if (e.oneway !== -1 && lf > 0) arcs.push({ a: e.a, b: e.b, len: e.len, pts: e.pts });
    if (e.oneway !== 1 && lbk > 0) arcs.push({ a: e.b, b: e.a, len: e.len, pts: rev });
  }
  const outArcs = new Map<number, number[]>();
  arcs.forEach((r, i) => (outArcs.get(r.a) ?? outArcs.set(r.a, []).get(r.a)!).push(i));

  // the network's nodes are street vertices (float32 lat/lon): find them by position
  const grid = new Map<string, number[]>();
  const cell = (lat: number, lon: number) => `${Math.round(lat * 2e4)},${Math.round(lon * 2e4)}`;
  for (const v of outArcs.keys()) {
    const k = cell(vertices[v].lat, vertices[v].lon);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(v);
  }
  // also the vertices only reached (the head of a one-way street)
  for (const r of arcs)
    if (!outArcs.has(r.b)) {
      const k = cell(vertices[r.b].lat, vertices[r.b].lon);
      const g = grid.get(k) ?? grid.set(k, []).get(k)!;
      if (!g.includes(r.b)) g.push(r.b);
    }
  const verticesAt = (n: number, tolDeg = 1e-5): number[] => {
    const lat = nodeLat[n],
      lon = nodeLon[n];
    const out: number[] = [];
    const ci = Math.round(lat * 2e4),
      cj = Math.round(lon * 2e4);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const v of grid.get(`${ci + i},${cj + j}`) ?? []) if (Math.abs(vertices[v].lat - lat) < tolDeg && Math.abs(vertices[v].lon - lon) < tolDeg) out.push(v);
    return out;
  };

  /** Dijkstra over the car arcs from any of `from` to any of `to`, up to `maxM` metres: the arcs taken */
  const shortest = (from: number[], to: Set<number>, maxM: number): { chain: number[]; dist: number } | null => {
    const dist = new Map<number, number>(),
      via = new Map<number, number>();
    const heap: [number, number][] = [];
    const push = (d: number, v: number) => {
      heap.push([d, v]);
      for (let i = heap.length - 1; i > 0; ) {
        const j = (i - 1) >> 1;
        if (heap[j][0] <= heap[i][0]) break;
        [heap[i], heap[j]] = [heap[j], heap[i]];
        i = j;
      }
    };
    const pop = () => {
      const top = heap[0],
        last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1,
            r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      return top;
    };
    for (const v of from) (dist.set(v, 0), push(0, v));
    while (heap.length) {
      const [d, v] = pop();
      if (d > (dist.get(v) ?? Infinity) || d > maxM) continue;
      if (to.has(v) && d > 0) {
        const chain: number[] = [];
        for (let u = v; via.has(u); u = arcs[via.get(u)!].a) {
          chain.push(via.get(u)!);
          if (chain.length > 10000) return null;
        }
        return { chain: chain.reverse(), dist: d };
      }
      for (const o of outArcs.get(v) ?? []) {
        const nd = d + arcs[o].len,
          w = arcs[o].b;
        if (nd < (dist.get(w) ?? Infinity)) (dist.set(w, nd), via.set(w, o), push(nd, w));
      }
    }
    return null;
  };

  const shapes: number[][] = [];
  const stats: Record<string, number> = { streetLinks: 0, found: 0, ambiguous: 0, byShortestPath: 0, offShape: 0, notFound: 0, pointsFull: 0, pointsKept: 0, oldPoints: 0, peninsula: 0 };
  const corr = A.corr ?? new Uint8Array(nL);
  for (let k = 0; k < nL; k++) {
    if (cls[k] === 0) {
      shapes.push([]);
      continue;
    }
    // the Peninsula freeways are not in streets.json: their own carriageway, every OSM point (roads.ts), simplified
    if (corr[k]) {
      const pts: number[] = [];
      for (let i = shapeStart[k]; i < shapeStart[k + 1]; i++) pts.push(shape[i]);
      const keep = simplify(pts, TOL);
      stats.peninsula = (stats.peninsula ?? 0) + 1;
      stats.pointsFull += pts.length / 2;
      stats.pointsKept += keep.length;
      shapes.push(keep.flatMap((i) => [pts[2 * i], pts[2 * i + 1]]));
      continue;
    }
    stats.streetLinks++;
    stats.oldPoints += (shapeStart[k + 1] - shapeStart[k]) / 2;
    const want = len[k] * 1609.34;
    const tol = Math.max(1, want * 0.002);
    const heads = new Set(verticesAt(lb[k]));
    // every chain from the tail through bends to the head with the link's length
    const found: number[][] = [];
    for (const va of verticesAt(la[k]))
      for (const first of outArcs.get(va) ?? []) {
        const chain = [first];
        let acc = arcs[first].len;
        for (let guard = 0; guard < 5000 && acc <= want + tol; guard++) {
          const r = arcs[chain[chain.length - 1]];
          if (heads.has(r.b) && Math.abs(acc - want) <= tol) {
            found.push(chain.slice());
            break;
          }
          // a bend: one way on that is not straight back
          const on = (outArcs.get(r.b) ?? []).filter((o) => arcs[o].b !== r.a);
          if (on.length !== 1) break;
          chain.push(on[0]);
          acc += arcs[on[0]].len;
        }
      }
    let viaPath = false;
    if (!found.length) {
      // the streets changed under this link: the shortest street path between its ends (within 3 m)
      const p = shortest(verticesAt(la[k], 3e-5), new Set(verticesAt(lb[k], 3e-5)), want * 1.05 + 10);
      if (p && Math.abs(p.dist - want) <= Math.max(10, want * 0.05)) {
        found.push(p.chain);
        viaPath = true;
      }
    }
    if (!found.length) {
      stats.notFound++;
      shapes.push([]);
      continue;
    }
    const pointsOf = (chain: number[]) => {
      const p: number[] = [];
      for (const i of chain) p.push(vertices[arcs[i].a].lat, vertices[arcs[i].a].lon, ...arcs[i].pts);
      const last = arcs[chain[chain.length - 1]].b;
      p.push(vertices[last].lat, vertices[last].lon);
      return p;
    };
    // the bundle's own (thinned) shape is a subset of the true points: it picks between chains and checks the one taken
    const old: [number, number][] = [];
    for (let i = shapeStart[k]; i < shapeStart[k + 1]; i += 2) old.push(toXY(shape[i], shape[i + 1]));
    const misfit = (p: number[]) => {
      const xy: number[] = [];
      for (let i = 0; i < p.length; i += 2) xy.push(...toXY(p[i], p[i + 1]));
      return old.reduce((m, [x, y]) => Math.max(m, toLine(x, y, xy)), 0);
    };
    let pts = pointsOf(found[0]);
    if (found.length > 1) {
      stats.ambiguous++;
      let best = misfit(pts);
      for (const c of found.slice(1)) {
        const p = pointsOf(c),
          m = misfit(p);
        if (m < best) (best = m), (pts = p);
      }
    }
    if (misfit(pts) > 2) {
      stats.offShape++;
      shapes.push([]);
      continue;
    }
    stats.found++;
    if (viaPath) stats.byShortestPath++;
    const keep = simplify(pts, TOL);
    stats.pointsFull += pts.length / 2;
    stats.pointsKept += keep.length;
    shapes.push(keep.flatMap((i) => [pts[2 * i], pts[2 * i + 1]]));
  }
  const bin = encodeRoadShapes({ version: 1, built: new Date().toISOString(), nLinks: nL, key, toleranceM: TOL, stats }, shapes);
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.writeFileSync(`${BUNDLE}/road-shapes.bin.gz`, gz);
  console.log(
    `Peninsula freeway links ${stats.peninsula}; street links ${stats.streetLinks}: chain found for ${stats.found} (${stats.ambiguous} chosen among several, ${stats.byShortestPath} by the shortest path), ${stats.notFound} not found, ${stats.offShape} off the bundle's shape (these keep the bundle's shape)`,
  );
  console.log(`points: ${stats.pointsFull} on the chains, ${stats.pointsKept} kept at ${TOL} m (the bundle's own shapes have ${stats.oldPoints}); ${(bin.length / 1e3).toFixed(0)} kB → ${(gz.length / 1e3).toFixed(0)} kB gzipped`);
  console.timeEnd('road-shapes');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
