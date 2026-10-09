/**
 * The walking graph built from the street edges (streets.ts), shared by the skims, the walk
 * network checks (diag-walk.ts) and the tests, so that all three walk the same network.
 */
import { walkSpeed } from '../../../shared/beta3/geo';
import { Graph } from './graph';
import type { StreetEdge, StreetVertex } from './streets';

export const WALK_FLAT = 1.34; // m/s, about 3 mph

/**
 * Stairs (Fruin, Pedestrian Planning and Design, 1971: about 0.5 m/s across the ground going up a
 * typical flight and 0.65 m/s coming down): the flat walk, plus 2 seconds a metre climbed and 1.25
 * a metre descended, and never less than 15% over the flat walk. A hill path's time comes from its
 * grade (Tobler's function, geo.ts walkSpeed), which on a stair's grade would be about half the
 * observed pace.
 */
export const STAIR = { upSecPerM: 2, downSecPerM: 1.25, minFactor: 1.15 };

/** seconds to walk an edge from a to b, and from b to a */
export function walkTimes(e: StreetEdge, vertices: StreetVertex[]): [number, number] {
  const flat = e.len / WALK_FLAT;
  if (e.steps) {
    const ab = flat + STAIR.upSecPerM * e.up + STAIR.downSecPerM * e.down;
    const ba = flat + STAIR.upSecPerM * e.down + STAIR.downSecPerM * e.up;
    return [Math.max(STAIR.minFactor * flat, ab), Math.max(STAIR.minFactor * flat, ba)];
  }
  const dz = vertices[e.b].z - vertices[e.a].z;
  const g = e.len > 5 ? dz / e.len : 0;
  return [e.len / walkSpeed(g, WALK_FLAT), e.len / walkSpeed(-g, WALK_FLAT)];
}

export type Arc = { a: number; b: number; cost: number; edge: number };

/** arc lengths in a graph's arc order, from lengths given in the order the arcs were listed */
export function arcLengths(g: Graph, lens: number[], arcs: Arc[]): Float32Array {
  const out = new Float32Array(arcs.length);
  const fill = g.start.slice(0, g.n);
  arcs.forEach((r, i) => (out[fill[r.a]++] = lens[i]));
  return out;
}

/** the walking graph (seconds) with each arc's length in metres */
export function walkGraph(vertices: StreetVertex[], edges: StreetEdge[]): { g: Graph; len: Float32Array } {
  const arcs: Arc[] = [], lens: number[] = [];
  edges.forEach((e, k) => {
    if (!e.walk) return;
    const [ab, ba] = walkTimes(e, vertices);
    arcs.push({ a: e.a, b: e.b, cost: ab, edge: k }, { a: e.b, b: e.a, cost: ba, edge: k });
    lens.push(e.len, e.len);
  });
  const g = new Graph(vertices.length, arcs);
  return { g, len: arcLengths(g, lens, arcs) };
}

/**
 * Strongly connected components (iterative Tarjan): comp[v] is the component's id, or -1 for a
 * vertex no arc touches. For a graph whose arcs all run both ways these are its connected pieces.
 */
export function strongComponents(g: Graph): Int32Array {
  const n = g.n;
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), comp = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n), stack: number[] = [], call: number[] = [], next = new Int32Array(n);
  let counter = 0, nc = 0;
  for (let r = 0; r < n; r++) {
    if (index[r] >= 0 || g.start[r + 1] === g.start[r]) continue;
    call.push(r);
    index[r] = low[r] = counter++;
    next[r] = g.start[r];
    stack.push(r), (onStack[r] = 1);
    while (call.length) {
      const v = call[call.length - 1];
      if (next[v] < g.start[v + 1]) {
        const w = g.to[next[v]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          next[w] = g.start[w];
          stack.push(w), (onStack[w] = 1);
          call.push(w);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        call.pop();
        if (call.length) {
          const u = call[call.length - 1];
          low[u] = Math.min(low[u], low[v]);
        }
        if (low[v] === index[v]) {
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = nc;
          } while (w !== v);
          nc++;
        }
      }
    }
  }
  return comp;
}

/**
 * Where trips may start and end: the largest strongly connected piece, and any other with at least
 * `minSize` vertices (Treasure Island's streets reach the city only by the Bay Bridge freeway, so on
 * foot they are a network of their own). In a piece that is only weakly connected some places
 * cannot be reached, or cannot be left: a one-way service road into the Presidio, a footway where
 * bikes may not go.
 */
export function mainPieces(g: Graph, minSize = Infinity): Uint8Array {
  const comp = strongComponents(g);
  const size = new Map<number, number>();
  for (const c of comp) if (c >= 0) size.set(c, (size.get(c) ?? 0) + 1);
  const root = [...size].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ok = new Set([root, ...[...size].filter(([, k]) => k >= minSize).map(([c]) => c)]);
  return Uint8Array.from(comp, (c) => (c >= 0 && ok.has(c) ? 1 : 0));
}
