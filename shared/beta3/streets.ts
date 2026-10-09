/**
 * The drivable street network, for drawing new bus lines along real streets (A* on distance,
 * respecting one-way streets). Loaded separately from the model bundle (client/beta3/model/streets.bin.gz).
 */
import { gunzipSync } from 'fflate';
import { decodeBundle } from './bundle';
import { toXY } from './geo';

export interface StreetGraph {
  n: number;
  lat: Float32Array;
  lon: Float32Array;
  x: Float32Array;
  y: Float32Array;
  /** outgoing arcs (compressed): target vertex, length (m), edge id (for the drawn shape), reversed? */
  start: Int32Array;
  to: Int32Array;
  len: Float32Array;
  edge: Int32Array;
  rev: Uint8Array;
  /** each edge's intermediate points, flat [lat, lon, ...], from ptStart[e] to ptStart[e+1] */
  ptStart: Int32Array;
  pts: Float32Array;
  /** grid for snapping */
  cells: Map<string, number[]>;
}

const CELL = 150;

export function decodeStreets(bytes: Uint8Array): StreetGraph {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const { a } = decodeBundle(raw);
  const lat = a.lat as Float32Array, lon = a.lon as Float32Array;
  const n = lat.length;
  const x = new Float32Array(n), y = new Float32Array(n);
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const [px, py] = toXY(lat[i], lon[i]);
    x[i] = px;
    y[i] = py;
    const k = `${Math.floor(px / CELL)},${Math.floor(py / CELL)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(i);
  }
  return { n, lat, lon, x, y, start: a.start as Int32Array, to: a.to as Int32Array, len: a.len as Float32Array, edge: a.edge as Int32Array, rev: a.rev as Uint8Array, ptStart: a.ptStart as Int32Array, pts: a.pts as Float32Array, cells };
}

export async function loadStreets(url: string): Promise<StreetGraph> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`streets: ${res.status}`);
  return decodeStreets(new Uint8Array(await res.arrayBuffer()));
}

export function nearestVertex(g: StreetGraph, lat: number, lon: number): { v: number; d: number } {
  const [px, py] = toXY(lat, lon);
  const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
  let best = -1, bd = Infinity;
  for (let r = 0; r < 12; r++) {
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const i of g.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (g.start[i + 1] === g.start[i]) continue;
          const d = Math.hypot(g.x[i] - px, g.y[i] - py);
          if (d < bd) (bd = d), (best = i);
        }
      }
    if (best >= 0 && bd < r * CELL) break;
  }
  return { v: best, d: bd };
}

/**
 * Shortest drivable path between two points, as a drawn path [lat, lon, ...] (starting and ending
 * at the given points) and its length in metres; null if they don't connect.
 */
export function routeAlongStreets(g: StreetGraph, fromLat: number, fromLon: number, toLat: number, toLon: number): { path: number[]; meters: number } | null {
  const a = nearestVertex(g, fromLat, fromLon), b = nearestVertex(g, toLat, toLon);
  if (a.v < 0 || b.v < 0) return null;
  if (a.v === b.v) {
    const [x1, y1] = toXY(fromLat, fromLon), [x2, y2] = toXY(toLat, toLon);
    return { path: [fromLat, fromLon, toLat, toLon], meters: Math.hypot(x2 - x1, y2 - y1) };
  }
  const n = g.n;
  const dist = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const tx = g.x[b.v], ty = g.y[b.v];
  // binary heap of [f, v]
  const hk: number[] = [], hv: number[] = [];
  const push = (k: number, v: number) => {
    let i = hk.length;
    hk.push(k);
    hv.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= k) break;
      hk[i] = hk[p];
      hv[i] = hv[p];
      i = p;
    }
    hk[i] = k;
    hv[i] = v;
  };
  const pop = () => {
    const v = hv[0];
    const k = hk.pop()!, w = hv.pop()!;
    if (hk.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hk.length) break;
        if (c + 1 < hk.length && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c];
        hv[i] = hv[c];
        i = c;
      }
      hk[i] = k;
      hv[i] = w;
    }
    return v;
  };
  dist[a.v] = 0;
  push(Math.hypot(g.x[a.v] - tx, g.y[a.v] - ty), a.v);
  let found = false;
  let guard = 0;
  while (hk.length && guard++ < 2_000_000) {
    const u = pop();
    if (u === b.v) {
      found = true;
      break;
    }
    const du = dist[u];
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.to[k];
      const nd = du + g.len[k];
      if (nd < dist[v]) {
        dist[v] = nd;
        pred[v] = k;
        push(nd + Math.hypot(g.x[v] - tx, g.y[v] - ty), v);
      }
    }
  }
  if (!found) return null;
  // walk back, collecting each edge's shape in travel order
  const arcs: number[] = [];
  for (let v = b.v; v !== a.v; ) {
    const k = pred[v];
    arcs.push(k);
    // find the arc's tail: the vertex whose range contains k
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.start[mid + 1] <= k) lo = mid + 1;
      else hi = mid;
    }
    v = lo;
  }
  arcs.reverse();
  const path: number[] = [fromLat, fromLon];
  let tail = a.v;
  path.push(g.lat[tail], g.lon[tail]);
  for (const k of arcs) {
    const e = g.edge[k];
    const s = g.ptStart[e], t = g.ptStart[e + 1];
    if (g.rev[k]) for (let i = t - 2; i >= s; i -= 2) path.push(g.pts[i], g.pts[i + 1]);
    else for (let i = s; i < t; i += 2) path.push(g.pts[i], g.pts[i + 1]);
    tail = g.to[k];
    path.push(g.lat[tail], g.lon[tail]);
  }
  path.push(toLat, toLon);
  return { path, meters: dist[b.v] + a.d + b.d };
}
