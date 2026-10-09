/**
 * A compact directed graph (compressed adjacency) and a Dijkstra that can stop at a radius.
 */
export class Graph {
  readonly n: number;
  readonly start: Int32Array;
  readonly to: Int32Array;
  readonly cost: Float32Array;
  /** which input edge each arc came from, for tracing paths */
  readonly edge: Int32Array;

  constructor(n: number, arcs: { a: number; b: number; cost: number; edge: number }[]) {
    this.n = n;
    this.start = new Int32Array(n + 1);
    for (const r of arcs) this.start[r.a + 1]++;
    for (let i = 0; i < n; i++) this.start[i + 1] += this.start[i];
    this.to = new Int32Array(arcs.length);
    this.cost = new Float32Array(arcs.length);
    this.edge = new Int32Array(arcs.length);
    const fill = this.start.slice(0, n);
    for (const r of arcs) {
      const k = fill[r.a]++;
      this.to[k] = r.b;
      this.cost[k] = r.cost;
      this.edge[k] = r.edge;
    }
  }
}

/** Binary min-heap of node ids keyed by a Float64Array of labels (lazy deletion). */
class Heap {
  private ids: Int32Array;
  private keys: Float64Array;
  size = 0;
  constructor(cap: number) {
    this.ids = new Int32Array(cap);
    this.keys = new Float64Array(cap);
  }
  push(id: number, key: number) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2), keys = new Float64Array(this.ids.length * 2);
      ids.set(this.ids);
      keys.set(this.keys);
      this.ids = ids;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }
  pop(): number {
    const top = this.ids[0];
    const id = this.ids[--this.size], key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = id;
    this.keys[i] = key;
    return top;
  }
  topKey() {
    return this.keys[0];
  }
}

/**
 * Shortest costs from several sources (each with a starting cost) to every node, stopping at
 * `limit`. `dist` is filled in place (Infinity where unreached); `pred` (optional) records the arc.
 */
export function dijkstra(g: Graph, sources: [number, number][], limit: number, dist: Float64Array, pred?: Int32Array, aux?: { arc: Float32Array; out: Float64Array; init?: number[] }): void {
  dist.fill(Infinity);
  if (pred) pred.fill(-1);
  if (aux) aux.out.fill(Infinity);
  const heap = new Heap(1024);
  sources.forEach(([s, c], k) => {
    if (c < dist[s]) {
      dist[s] = c;
      if (aux) aux.out[s] = aux.init?.[k] ?? 0;
      heap.push(s, c);
    }
  });
  while (heap.size) {
    const d = heap.topKey();
    const u = heap.pop();
    if (d > dist[u]) continue;
    if (d > limit) break;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.to[k];
      const nd = d + g.cost[k];
      if (nd < dist[v]) {
        dist[v] = nd;
        if (pred) pred[v] = k;
        if (aux) aux.out[v] = aux.out[u] + aux.arc[k];
        heap.push(v, nd);
      }
    }
  }
}

/** Nearest graph node to (x, y) among the allowed ones, via a coarse grid. */
export class Snapper {
  private cells = new Map<string, number[]>();
  constructor(
    private xs: Float64Array | number[],
    private ys: Float64Array | number[],
    allowed: (i: number) => boolean,
    private size = 200,
  ) {
    for (let i = 0; i < xs.length; i++) {
      if (!allowed(i)) continue;
      const k = `${Math.floor(xs[i] / size)},${Math.floor(ys[i] / size)}`;
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k)!.push(i);
    }
  }
  nearest(x: number, y: number): { i: number; d: number } {
    const cx = Math.floor(x / this.size), cy = Math.floor(y / this.size);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 30; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const i of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
            if (d < bd) (bd = d), (best = i);
          }
        }
      if (best >= 0 && bd < r * this.size) break;
    }
    return { i: best, d: bd };
  }
  /** every allowed point within r of (x, y), with its distance */
  within(x: number, y: number, r: number): { i: number; d: number }[] {
    const out: { i: number; d: number }[] = [];
    const n = Math.ceil(r / this.size), cx = Math.floor(x / this.size), cy = Math.floor(y / this.size);
    for (let dx = -n; dx <= n; dx++)
      for (let dy = -n; dy <= n; dy++)
        for (const i of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
          if (d <= r) out.push({ i, d });
        }
    return out;
  }
}
