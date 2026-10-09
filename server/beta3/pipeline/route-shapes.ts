/**
 * Route shapes for bus lines that publish none (UCSF's shuttles and PresidiGo, from timetables;
 * any GTFS pattern without shapes.txt): the path between consecutive stops on the drivable streets,
 * found the way GTFS shape generators such as pfaedle find it. Each stop snaps to the street edges
 * near it (either side of a two-way street); between stops, a shortest path over directed street
 * edges that keeps to one-way streets, prefers the main streets a bus would use over residential
 * ones, avoids service roads (driveways, campus roads) unless a stop is on one, and pays for sharp
 * turns and U-turns. OSM turn restrictions are not in streets.json, so they are not applied.
 *
 * Used by transit.ts; the stop-to-stop times still come from the timetables.
 */
import { toXY } from '../../../shared/beta3/geo';
import type { StreetEdge, StreetVertex } from './streets';

/** cost per metre by street class: main streets first */
const CLASS_COST: Record<string, number> = {
  motorway: 1,
  motorway_link: 1,
  trunk: 1,
  trunk_link: 1,
  primary: 1,
  primary_link: 1,
  secondary: 1,
  secondary_link: 1,
  tertiary: 1.1,
  tertiary_link: 1.1,
  busway: 1,
  unclassified: 1.3,
  residential: 1.4,
  living_street: 2,
  service: 2.5,
};
/** a street closed to cars (a driveway, a campus or park road, a car-free street): only to reach a stop on it, unless a feed shape runs along it */
const CLOSED_SERVICE_COST = 4;
/** metres of cost for a turn sharper than 100°, and for turning back on the same street */
const TURN_COST = 40,
  UTURN_COST = 400;
/** following a guide line: no cost within this distance of it (m), then this much per metre beyond */
const GUIDE_SLACK_M = 15,
  GUIDE_COST = 4;
/** how far a stop may be from the street it is served on (m), and the cost of each metre of it */
const SNAP_M = 80,
  SNAP_COST = 2;

/** a stop's place on a street arc: distance along it, metres off it, and the point */
interface Snap {
  arc: number;
  at: number;
  off: number;
  p: [number, number];
  /** extra cost of leaving the stop from here (another street than the bus arrived on) */
  pen?: number;
}

interface Arc {
  /** street vertex at each end */
  a: number;
  b: number;
  /** the edge it runs along (both directions of a two-way street share it) */
  edge: number;
  /** points [lat, lon], from vertex a to vertex b, and their flat x, y and distance along */
  ll: [number, number][];
  xy: [number, number][];
  s: number[];
  len: number;
  cost: number;
  /** closed to cars: routed through only to reach a stop on it, or where a guide shape runs along it */
  closed: boolean;
}

export interface RoutedShape {
  /** [lat, lon] points, stops' snapped points included */
  shape: [number, number][];
  /** index of each stop's point in shape */
  stopAt: number[];
  /** hops routed on the streets (the others are straight) */
  routed: number;
}

export class StreetRouter {
  private arcs: Arc[] = [];
  private out = new Map<number, number[]>();
  private grid = new Map<string, [number, number][]>(); // cell → [arc, segment]
  private static G = 50;

  constructor(vertices: StreetVertex[], edges: StreetEdge[]) {
    edges.forEach((e, ei) => {
      // streets closed to cars but not to buses or to everything (Market Street, the transit
      // center's ramps, driveways, park drives) are kept, marked closed
      const closed = !e.car && (CLASS_COST[e.cls] !== undefined || e.cls === 'busway') && !/^(motorway|trunk)/.test(e.cls);
      if (!e.car && !closed) return;
      if (e.car && CLASS_COST[e.cls] === undefined) return;
      const per = e.cls === 'busway' ? 1 : CLASS_COST[e.cls];
      const ll: [number, number][] = [[vertices[e.a].lat, vertices[e.a].lon]];
      for (let i = 0; i < e.pts.length; i += 2) ll.push([e.pts[i], e.pts[i + 1]]);
      ll.push([vertices[e.b].lat, vertices[e.b].lon]);
      // a direction with only a bus lane is open to buses
      const [lf, lb] = e.car ? (e.lanes ?? [1, 1]) : [1, 1];
      const [bf, bb] = e.busLanes ?? [0, 0];
      if (e.oneway !== -1 && lf + bf > 0) this.addArc(e.a, e.b, ei, ll, per, closed && e.cls !== 'busway');
      if (e.oneway !== 1 && lb + bb > 0) this.addArc(e.b, e.a, ei, [...ll].reverse(), per, closed && e.cls !== 'busway');
    });
  }

  private addArc(a: number, b: number, edge: number, ll: [number, number][], per: number, closed: boolean) {
    const xy = ll.map(([la, lo]) => toXY(la, lo));
    const s = [0];
    for (let i = 1; i < xy.length; i++) s.push(s[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    const len = s[s.length - 1];
    const k = this.arcs.push({ a, b, edge, ll, xy, s, len, cost: per, closed }) - 1;
    (this.out.get(a) ?? this.out.set(a, []).get(a)!).push(k);
    const G = StreetRouter.G;
    for (let i = 0; i + 1 < xy.length; i++) {
      const x0 = Math.floor(Math.min(xy[i][0], xy[i + 1][0]) / G),
        x1 = Math.floor(Math.max(xy[i][0], xy[i + 1][0]) / G),
        y0 = Math.floor(Math.min(xy[i][1], xy[i + 1][1]) / G),
        y1 = Math.floor(Math.max(xy[i][1], xy[i + 1][1]) / G);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) (this.grid.get(`${x},${y}`) ?? this.grid.set(`${x},${y}`, []).get(`${x},${y}`)!).push([k, i]);
    }
  }

  /** the arcs near a point: each arc's nearest point (distance along it, metres off) */
  private snap(lat: number, lon: number, maxM = SNAP_M): Snap[] {
    const [x, y] = toXY(lat, lon);
    const G = StreetRouter.G,
      R = Math.ceil(maxM / G);
    const best = new Map<number, Snap>();
    const gx = Math.floor(x / G),
      gy = Math.floor(y / G);
    for (let i = -R; i <= R; i++)
      for (let j = -R; j <= R; j++)
        for (const [k, sIdx] of this.grid.get(`${gx + i},${gy + j}`) ?? []) {
          const A = this.arcs[k];
          const [ax, ay] = A.xy[sIdx],
            [bx, by] = A.xy[sIdx + 1];
          const dx = bx - ax,
            dy = by - ay,
            L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
          const off = Math.hypot(x - ax - t * dx, y - ay - t * dy);
          if (off > maxM) continue;
          const cur = best.get(k);
          if (cur && cur.off <= off) continue;
          const [la0, lo0] = A.ll[sIdx],
            [la1, lo1] = A.ll[sIdx + 1];
          best.set(k, { arc: k, at: A.s[sIdx] + t * Math.sqrt(L2), off, p: [la0 + t * (la1 - la0), lo0 + t * (lo1 - lo0)] });
        }
    const all = [...best.values()].sort((p, q) => p.off - q.off);
    // the nearest streets only: within 25 m of the nearest one
    return all.filter((c) => c.off <= all[0]?.off + 25).slice(0, 8);
  }

  private heading(k: number, end: boolean): number {
    const xy = this.arcs[k].xy;
    const [p, q] = end ? [xy[xy.length - 2], xy[xy.length - 1]] : [xy[0], xy[1]];
    return Math.atan2(q[1] - p[1], q[0] - p[0]);
  }

  /**
   * One hop, from every place the bus may leave a stop (each with the cost of getting there) to
   * every place it may stop at the next: for each of those, the cheapest way, its cost, and which
   * departure it came from. Null for a place out of reach.
   */
  private hop(from: { c: Snap; init: number }[], to: Snap[], maxCost: number, guide?: [[number, number], [number, number]]): ({ cost: number; from: number; pts: [number, number][] } | null)[] {
    const arcs = this.arcs;
    // closed streets cost more when routing from stops alone, not when following a feed's shape
    const cost = (A: Arc) => (A.closed && !guide ? Math.max(A.cost, CLOSED_SERVICE_COST) : A.cost);
    const dist = new Map<number, number>(),
      pred = new Map<number, number>(),
      origin = new Map<number, number>(); // arc → index into `from` it started from
    const heap: [number, number][] = [];
    const push = (d: number, k: number) => {
      heap.push([d, k]);
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
    const base = Math.min(...from.map((f) => f.init));
    const targets = new Map<number, number[]>();
    to.forEach((t, i) => (targets.get(t.arc) ?? targets.set(t.arc, []).get(t.arc)!).push(i));
    const sourceArcs = new Set(from.map((f) => f.c.arc));
    // per target: best cost, and how it was reached (directly along one arc, or entering its arc from `via`)
    const best: { cost: number; from: number; direct: boolean; via: number }[] = to.map(() => ({ cost: Infinity, from: -1, direct: false, via: -1 }));
    from.forEach((f, fi) => {
      const A = arcs[f.c.arc];
      const start = f.init - base + SNAP_COST * f.c.off * cost(A);
      for (const ti of targets.get(f.c.arc) ?? []) {
        const t = to[ti];
        if (t.at < f.c.at) continue;
        const d = start + (t.at - f.c.at) * cost(A) + SNAP_COST * t.off * cost(A);
        if (d < best[ti].cost) best[ti] = { cost: d, from: fi, direct: true, via: -1 };
      }
      const d0 = start + (A.len - f.c.at) * cost(A);
      if (d0 < (dist.get(f.c.arc) ?? Infinity)) (dist.set(f.c.arc, d0), origin.set(f.c.arc, fi), push(d0, f.c.arc));
    });
    const worst = () => Math.max(...best.map((b) => b.cost));
    while (heap.length) {
      const [d, k] = pop();
      if (d > (dist.get(k) ?? Infinity)) continue;
      if (d > maxCost || d >= worst()) break;
      const A = arcs[k];
      const h0 = this.heading(k, true);
      for (const j of this.out.get(A.b) ?? []) {
        const B = arcs[j];
        let turn = 0;
        if (B.edge === A.edge) turn = UTURN_COST;
        else {
          let da = Math.abs(this.heading(j, false) - h0);
          if (da > Math.PI) da = 2 * Math.PI - da;
          if (da > (100 * Math.PI) / 180) turn = TURN_COST;
        }
        const enter = d + turn;
        for (const ti of targets.get(j) ?? []) {
          const t = to[ti];
          const fin = enter + t.at * cost(B) + SNAP_COST * t.off * cost(B);
          if (fin < best[ti].cost) best[ti] = { cost: fin, from: origin.get(k)!, direct: false, via: k };
        }
        // a way back onto a departure street would make a loop: not needed between two stops
        if (sourceArcs.has(j)) continue;
        // following a guide line (a sparse feed shape): streets away from it cost more
        const stray = guide ? Math.max(0, segDist(B.xy[B.xy.length - 1], guide[0], guide[1]) - GUIDE_SLACK_M) * GUIDE_COST : 0;
        const nd = enter + B.len * cost(B) + stray;
        if (nd < (dist.get(j) ?? Infinity)) (dist.set(j, nd), pred.set(j, k), origin.set(j, origin.get(k)!), push(nd, j));
      }
    }
    return best.map((b, ti) => {
      if (b.from < 0 || !Number.isFinite(b.cost)) return null;
      const t = to[ti],
        s0 = from[b.from].c;
      if (b.direct) return { cost: b.cost + base, from: b.from, pts: [s0.p, ...this.between(t.arc, s0.at, t.at), t.p] };
      const chain = [b.via];
      while (pred.has(chain[chain.length - 1]) && chain.length < 20000) chain.push(pred.get(chain[chain.length - 1])!);
      chain.reverse();
      const pts: [number, number][] = [s0.p, ...this.between(chain[0], s0.at, Infinity)];
      for (const k of chain.slice(1)) pts.push(...arcs[k].ll.slice(1));
      pts.push(...this.between(t.arc, 0, t.at), t.p);
      return { cost: b.cost + base, from: b.from, pts };
    });
  }

  /** an arc's points strictly between two distances along it (the end vertex included when b is past it) */
  private between(k: number, a: number, b: number): [number, number][] {
    const A = this.arcs[k];
    const out: [number, number][] = [];
    for (let i = 0; i < A.ll.length; i++) if (A.s[i] > a && (A.s[i] < b || (b === Infinity && i === A.ll.length - 1))) out.push(A.ll[i]);
    return out;
  }

  /** metres to the nearest street (Infinity beyond `max`) */
  nearestStreet(x: number, y: number, max: number): number {
    const G = StreetRouter.G,
      R = Math.ceil(max / G);
    const gx = Math.floor(x / G),
      gy = Math.floor(y / G);
    let best = Infinity;
    for (let i = -R; i <= R; i++)
      for (let j = -R; j <= R; j++)
        for (const [k, sIdx] of this.grid.get(`${gx + i},${gy + j}`) ?? []) {
          const A = this.arcs[k];
          const d = segDist([x, y], A.xy[sIdx], A.xy[sIdx + 1]);
          if (d < best) best = d;
        }
    return best <= max ? best : Infinity;
  }

  /**
   * How a shape sits on the streets: its mean point spacing (m) and the share of it more than
   * `tol` metres off any street, both counted only where there are streets (within 100 m; not on
   * bridges, the bay, or outside the city).
   */
  fit(shape: [number, number][], tol = 10): { spacing: number; offShare: number; covered: number } {
    let covered = 0,
      off = 0,
      len = 0,
      segs = 0;
    for (let i = 1; i < shape.length; i++) {
      const a = toXY(...shape[i - 1]),
        b = toXY(...shape[i]);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 10));
      let inside = 0;
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const d = this.nearestStreet(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 100);
        if (!Number.isFinite(d)) continue;
        inside++;
        if (d > tol) off++;
      }
      covered += inside;
      if (inside === n) (len += L), segs++;
    }
    return { spacing: segs ? len / segs : 0, offShare: covered ? off / covered : 0, covered };
  }

  /**
   * A sparse feed shape matched onto the streets: routed between its points (each within 25 m of a
   * street; others, on bridges or outside the city, are kept as they are), with streets more than
   * 15 m from the shape's line between two points costing extra, so the match follows the shape
   * and only fills in the corners it cuts.
   */
  match(guide: [number, number][]): [number, number][] {
    return this.route(guide, { snapM: 25, guide: true }).shape;
  }

  /**
   * A line's shape through its stops ([lat, lon] each). Each stop may be served from any street
   * edge near it; the places are chosen for the whole line at once (Viterbi over the stops), so a
   * bus does not circle a block to leave a stop the way it came. Hops with no street path within
   * reach are drawn straight.
   */
  route(stops: [number, number][], opt: { snapM?: number; guide?: boolean } = {}): RoutedShape {
    const n = stops.length;
    const snaps = stops.map(([la, lo]) => this.snap(la, lo, opt.snapM));
    // per stop and place: the cheapest cost so far, the place at the stop before, and the hop's points
    const cum: number[][] = [snaps[0].map(() => 0)];
    const back: { prev: number; pts: [number, number][] | null }[][] = [snaps[0].map(() => ({ prev: -1, pts: null }))];
    const straightHop: boolean[] = [false];
    for (let k = 1; k < n; k++) {
      const [ax, ay] = toXY(...stops[k - 1]),
        [bx, by] = toXY(...stops[k]);
      const straight = Math.hypot(bx - ax, by - ay);
      // leaving: from where the bus stopped (free), the other way along that street (a U-turn), or
      // another street near the stop
      const from: { c: Snap; init: number; prev: number }[] = [];
      const prevSnaps = snaps[k - 1];
      if (prevSnaps.length && snaps[k].length)
        prevSnaps.forEach((c, ci) => {
          let bestInit = Infinity,
            bestPrev = -1;
          prevSnaps.forEach((a, ai) => {
            if (!Number.isFinite(cum[k - 1][ai])) return;
            const pen = ai === ci ? 0 : this.arcs[a.arc].edge === this.arcs[c.arc].edge ? UTURN_COST : 60;
            if (cum[k - 1][ai] + pen < bestInit) (bestInit = cum[k - 1][ai] + pen), (bestPrev = ai);
          });
          if (bestPrev >= 0) from.push({ c, init: bestInit, prev: bestPrev });
        });
      const res = from.length ? this.hop(from, snaps[k], 4 * straight + 2000, opt.guide ? [[ax, ay], [bx, by]] : undefined) : [];
      const ok = res.some((r) => r && pathLen(r.pts) <= 3 * straight + 500);
      if (!ok) {
        // no street path: a straight hop from the best place at the last stop to each place at this one
        const prevBest = cum[k - 1].reduce((bi, v, i, arr) => (v < arr[bi] ? i : bi), 0);
        const base = Number.isFinite(cum[k - 1][prevBest]) ? cum[k - 1][prevBest] : 0;
        cum.push(snaps[k].length ? snaps[k].map(() => base + straight) : [base + straight]);
        back.push(snaps[k].length ? snaps[k].map(() => ({ prev: prevBest, pts: null })) : [{ prev: prevBest, pts: null }]);
        straightHop.push(true);
        continue;
      }
      cum.push(res.map((r) => (r && pathLen(r.pts) <= 3 * straight + 500 ? r.cost : Infinity)));
      back.push(res.map((r) => ({ prev: r ? from[r.from].prev : -1, pts: r ? r.pts : null })));
      straightHop.push(false);
    }
    // back from the cheapest place at the last stop
    let at = cum[n - 1].reduce((bi, v, i, arr) => (v < arr[bi] ? i : bi), 0);
    const hops: ([number, number][] | null)[] = [];
    const places: number[] = [];
    for (let k = n - 1; k >= 1; k--) {
      places.push(at);
      hops.push(straightHop[k] ? null : back[k][at].pts);
      at = back[k][at].prev;
    }
    places.push(at);
    hops.reverse();
    places.reverse();
    const pointAt = (k: number) => snaps[k][places[k]]?.p ?? stops[k];
    const shape: [number, number][] = [pointAt(0)];
    const stopAt = [0];
    let routed = 0;
    for (let k = 1; k < n; k++) {
      const h = hops[k - 1];
      if (h) {
        routed++;
        // the hop leaves from its own place at the stop (the other side of the street, perhaps)
        if (h[0][0] !== shape[shape.length - 1][0] || h[0][1] !== shape[shape.length - 1][1]) shape.push(h[0]);
        shape.push(...h.slice(1));
      } else shape.push(pointAt(k));
      stopAt.push(shape.length - 1);
    }
    return { shape, stopAt, routed };
  }
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function pathLen(pts: [number, number][]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = toXY(...pts[i - 1]),
      [qx, qy] = toXY(...pts[i]);
    m += Math.hypot(qx - px, qy - py);
  }
  return m;
}
