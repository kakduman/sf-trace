/**
 * The Peninsula freeways (roads.ts): US-101 from the San Francisco county line to the I-280/I-680
 * interchange in San Jose, and I-280 from the county line to its end at US-101, each direction
 * followed along OpenStreetMap's carriageway (roads/osm-regional.json) and cut at its main
 * interchanges into segments. The cuts in San Mateo County are the limits of C/CAG's monitored
 * freeway segments (2025 CMP Monitoring Report, Table 25), so the model's speeds can be compared
 * with INRIX's segment by segment; the cuts in Santa Clara County are the junctions with SR-85,
 * SR-237, SR-87, I-880, and SR-17. SR-92, SR-85, and the other routes are not modeled: traffic
 * enters and leaves the freeways at the cuts.
 *
 * Each segment's lanes are OSM's, express and HOV lanes counted as lanes (see roads-base.ts), its
 * free-flow speed C/CAG's 65 mph (or INRIX's peak speed on it where that is higher).
 */
import { toXY } from '../../../shared/beta3/geo';

export type PenRoute = 'US-101' | 'I-280';
/** a cut, where the southbound carriageway passes the interchange (OSM ramps; county lines from Caltrans' postmiles) */
export interface PenCut {
  name: string;
  lat: number;
  lon: number;
  /** a cut only for access, within one of C/CAG's monitored segments */
  access?: boolean;
}
/**
 * The cuts, north to south; the first is the county line, where the freeway joins the city's
 * gateway. Positions are those of the southbound ramps (osm-regional.json), the county lines those of
 * Caltrans' AADT points at postmile 0.
 */
export const PEN_CUTS: Record<PenRoute, PenCut[]> = {
  'US-101': [
    { name: 'the county line', lat: 37.701, lon: -122.3934 },
    { name: 'I-380', lat: 37.64086, lon: -122.406 },
    { name: 'Millbrae Ave', lat: 37.60481, lon: -122.38405 },
    { name: 'Broadway', lat: 37.59265, lon: -122.36538 },
    { name: 'Peninsula Ave', lat: 37.58125, lon: -122.32544 },
    { name: 'SR-92', lat: 37.559, lon: -122.30157 },
    { name: 'Whipple Ave', lat: 37.49919, lon: -122.23962 },
    { name: 'Marsh Rd', lat: 37.48433, lon: -122.18404, access: true },
    { name: 'the Santa Clara County line', lat: 37.45271, lon: -122.12791 },
    { name: 'SR-85', lat: 37.41189, lon: -122.07836 },
    { name: 'SR-237', lat: 37.40066, lon: -122.03607 },
    { name: 'SR-87', lat: 37.3744, lon: -121.93097 },
    { name: 'I-880', lat: 37.36557, lon: -121.90513 },
    { name: 'I-280/I-680', lat: 37.3444, lon: -121.85682 },
  ],
  'I-280': [
    { name: 'the county line', lat: 37.7006, lon: -122.4714 },
    { name: 'SR-1 (south)', lat: 37.68115, lon: -122.4718 },
    { name: 'San Bruno Ave', lat: 37.63198, lon: -122.43708 },
    { name: 'Trousdale Dr', lat: 37.58368, lon: -122.40635, access: true },
    { name: 'SR-92', lat: 37.51033, lon: -122.34431 },
    { name: 'Edgewood Rd', lat: 37.47233, lon: -122.29618, access: true },
    { name: 'SR-84', lat: 37.43816, lon: -122.24681 },
    { name: 'the Santa Clara County line', lat: 37.40878, lon: -122.19425 },
    { name: 'Page Mill Rd', lat: 37.39197, lon: -122.16918 },
    { name: 'SR-85', lat: 37.33224, lon: -122.05968 },
    { name: 'I-880/SR-17', lat: 37.3167, lon: -121.94799 },
    { name: 'US-101', lat: 37.3362, lon: -121.8574 },
  ],
};
export const PEN_REF: Record<PenRoute, string> = { 'US-101': 'US 101', 'I-280': 'I 280' };

interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}
interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags: Record<string, string>;
}

/** one direction of one freeway: the carriageway's OSM nodes in order, and where each cut falls on it */
export interface Carriageway {
  route: PenRoute;
  dir: 'N' | 'S';
  nodes: number[];
  /** metres from the first node */
  chain: number[];
  /** the index in `nodes` of each cut (PEN_CUTS order, north to south) */
  cutAt: number[];
  /** per arc (nodes[i] → nodes[i+1]): lanes (all, express and HOV included), express or HOV lanes, posted mph */
  lanes: number[];
  hov: number[];
  mph: number[];
}

export interface PenSegmentGeom {
  route: PenRoute;
  dir: 'N' | 'S';
  /** cut indices (PEN_CUTS order): the segment runs from cut `from` to cut `to` in its direction */
  from: number;
  to: number;
  metres: number;
  /** length-weighted mean lanes (all) and express or HOV lanes */
  lanes: number;
  hov: number;
  postedMph: number;
  /** [lat, lon, ...] along the carriageway */
  pts: number[];
}

/**
 * Follow each freeway's carriageways through the regional OSM extract: southbound from the county
 * line, northbound from the southern end, at each fork keeping to the motorway with the route's
 * ref and the most lanes.
 */
export function corridorCarriageways(elements: (OsmNode | OsmWay)[]): { cw: Carriageway[]; pos: Map<number, [number, number]> } {
  const pos = new Map<number, [number, number]>();
  for (const e of elements) if (e.type === 'node') pos.set(e.id, [e.lat, e.lon]);
  const dist = (a: number, b: number) => {
    const [x1, y1] = toXY(...pos.get(a)!),
      [x2, y2] = toXY(...pos.get(b)!);
    return Math.hypot(x2 - x1, y2 - y1);
  };
  const near = (n: number, lat: number, lon: number) => {
    const [x1, y1] = toXY(...pos.get(n)!),
      [x2, y2] = toXY(lat, lon);
    return Math.hypot(x2 - x1, y2 - y1);
  };
  const lanesOf = (w: OsmWay) => Number((w.tags.lanes ?? '').split(';')[0]) || 0;
  const hovOf = (w: OsmWay) => (w.tags['hov:lanes'] ?? w.tags['hov:lanes:forward'] ?? '').split('|').filter((s) => s === 'designated').length;
  const mphOf = (w: OsmWay) => {
    const m = /^(\d+)\s*mph/.exec(w.tags.maxspeed ?? '');
    return m ? Number(m[1]) : 65;
  };
  const cw: Carriageway[] = [];
  for (const route of Object.keys(PEN_CUTS) as PenRoute[]) {
    const ref = PEN_REF[route];
    const out = new Map<number, { to: number; w: OsmWay }[]>();
    for (const e of elements) {
      if (e.type !== 'way' || e.tags.highway !== 'motorway' || !(e.tags.ref ?? '').split(';').map((s) => s.trim()).includes(ref)) continue;
      for (let i = 0; i + 1 < e.nodes.length; i++) {
        if (!pos.has(e.nodes[i]) || !pos.has(e.nodes[i + 1])) continue;
        (out.get(e.nodes[i]) ?? out.set(e.nodes[i], []).get(e.nodes[i])!).push({ to: e.nodes[i + 1], w: e });
      }
    }
    const cuts = PEN_CUTS[route];
    for (const dir of ['S', 'N'] as const) {
      const first = dir === 'S' ? cuts[0] : cuts[cuts.length - 1],
        last = dir === 'S' ? cuts[cuts.length - 1] : cuts[0];
      // the start: a node near the first cut whose way leads towards the last
      const heads = (n: number) => {
        let m = n;
        for (let i = 0; i < 40 && out.has(m); i++) m = out.get(m)![0].to;
        return near(m, last.lat, last.lon) < near(n, last.lat, last.lon) - 200;
      };
      const starts = [...out.keys()].filter((n) => near(n, first.lat, first.lon) < 500 && heads(n)).sort((a, b) => near(a, first.lat, first.lon) - near(b, first.lat, first.lon));
      if (!starts.length) throw new Error(`peninsula: no ${dir}B start for ${route}`);
      const nodes = [starts[0]],
        chain = [0],
        lanes: number[] = [],
        hov: number[] = [],
        mph: number[] = [];
      const seen = new Set(nodes);
      for (let guard = 0; guard < 100000; guard++) {
        const u = nodes[nodes.length - 1];
        if (near(u, last.lat, last.lon) < 150) break;
        const nx = (out.get(u) ?? []).filter((o) => !seen.has(o.to)).sort((a, b) => lanesOf(b.w) - lanesOf(a.w));
        if (!nx.length) break;
        const { to, w } = nx[0];
        lanes.push(lanesOf(w) || 3);
        hov.push(hovOf(w));
        mph.push(mphOf(w));
        chain.push(chain[chain.length - 1] + dist(u, to));
        nodes.push(to);
        seen.add(to);
      }
      // the end: the node nearest the last cut
      let endAt = 0;
      nodes.forEach((n, i) => near(n, last.lat, last.lon) < near(nodes[endAt], last.lat, last.lon) && (endAt = i));
      if (near(nodes[endAt], last.lat, last.lon) > 500) throw new Error(`peninsula: the ${dir}B carriageway of ${route} does not reach ${last.name}`);
      nodes.length = endAt + 1;
      chain.length = endAt + 1;
      lanes.length = hov.length = mph.length = endAt;
      // each cut: the nearest node, in order along the carriageway
      const cutAt = cuts.map((c) => {
        let best = 0;
        nodes.forEach((n, i) => near(n, c.lat, c.lon) < near(nodes[best], c.lat, c.lon) && (best = i));
        return best;
      });
      const ordered = dir === 'S' ? cutAt : [...cutAt].reverse();
      for (let i = 1; i < ordered.length; i++) if (!(ordered[i] > ordered[i - 1])) throw new Error(`peninsula: ${route} ${dir}B cuts out of order at ${cuts[dir === 'S' ? i : cuts.length - 1 - i].name}`);
      cw.push({ route, dir, nodes, chain, cutAt, lanes, hov, mph });
    }
  }
  return { cw, pos };
}

/** the segments between successive cuts, each direction */
export function corridorSegments(cw: Carriageway[], pos: Map<number, [number, number]>): PenSegmentGeom[] {
  const segs: PenSegmentGeom[] = [];
  for (const c of cw) {
    const n = PEN_CUTS[c.route].length;
    for (let j = 0; j + 1 < n; j++) {
      // southbound runs from cut j to j+1; northbound from cut j+1 to j
      const from = c.dir === 'S' ? j : j + 1,
        to = c.dir === 'S' ? j + 1 : j;
      const i0 = c.cutAt[from],
        i1 = c.cutAt[to];
      let m = 0,
        ln = 0,
        hv = 0,
        sp = 0;
      const pts: number[] = [];
      for (let i = i0; i <= i1; i++) {
        const p = pos.get(c.nodes[i])!;
        pts.push(+p[0].toFixed(6), +p[1].toFixed(6));
        if (i < i1) {
          const d = c.chain[i + 1] - c.chain[i];
          m += d;
          ln += d * c.lanes[i];
          hv += d * c.hov[i];
          sp += d * c.mph[i];
        }
      }
      segs.push({ route: c.route, dir: c.dir, from, to, metres: m, lanes: m > 0 ? ln / m : 3, hov: m > 0 ? hv / m : 0, postedMph: m > 0 ? sp / m : 65, pts });
    }
  }
  return segs;
}

/**
 * Peninsula traffic by period and direction (reference/peninsula-traffic.json, made by
 * peninsula-data.ts): the two-way share of a weekday's traffic in each period, and the southbound
 * share of each period's traffic.
 */
export interface PenProfile {
  periodShare: Record<string, number>;
  southShare: Record<string, number>;
}
