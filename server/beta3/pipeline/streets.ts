/**
 * Step 3: the street graph. OpenStreetMap ways are split at intersections into edges carrying
 * length, climb and descent (from the elevation tiles), road class, speed limit, direction rules
 * and who may use them (cars, people on foot, people on bikes).
 *
 * The walking network takes in everything OpenStreetMap maps for people on foot: sidewalks and
 * crossings drawn as their own ways, campus and park paths, public stairways, pedestrian plazas
 * mapped as areas (walked straight across), and paths closed to cars but open on foot. Where the
 * map leaves walkways unjoined, they are joined: two walkways that cross on the same level get a
 * shared node, and a walkway that ends within NEAR_MISS of another is linked to it, unless a wall,
 * fence, freeway or railway lies between. Gates closed to the public are not passed.
 * Writes data/beta3/work/streets.json (with counts of the joins made, `stats`).
 *
 * Run: npx tsx server/beta3/pipeline/streets.ts
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { toXY } from '../../../shared/beta3/geo';
import { ELEV_ZOOM, tileX, tileY } from './fetch-elevation';
import { RAW, WORK } from './paths';

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags: Record<string, string>;
}
export interface OsmRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags: Record<string, string>;
}
export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface StreetVertex {
  lat: number;
  lon: number;
  x: number;
  y: number;
  z: number;
}

export interface StreetEdge {
  a: number;
  b: number;
  /** metres */
  len: number;
  /** metres climbed going a→b, and descended (for stairs, the flight's rise) */
  up: number;
  down: number;
  cls: string;
  name?: string;
  /** km/h, from maxspeed or the class default */
  speed: number;
  /** 0 both ways, 1 only a→b, -1 only b→a (for cars) */
  oneway: 0 | 1 | -1;
  car: boolean;
  walk: boolean;
  bike: boolean;
  /** separated or painted bike facility */
  bikeway: boolean;
  /** stairs: walkable, not bikeable */
  steps: boolean;
  /** underground or indoor (station concourses and stairs, tunnels): walkable, but nothing snaps onto it */
  under?: boolean;
  /**
   * a raised walkway (a footbridge, or a podium deck such as Embarcadero Center's or the Salesforce
   * Transit Center's roof park): walkable, but nothing snaps onto it, since a block's people reach
   * the street at ground level
   */
  above?: boolean;
  /** made here, not mapped as a way: 'area' across a pedestrian plaza, 'link' joining a near miss */
  made?: 'area' | 'link';
  /** intermediate points, flat [lat, lon, ...], for drawing */
  pts: number[];
  /** cars: general-purpose lanes a→b and b→a (OSM lanes, less bus lanes; class defaults where untagged) */
  lanes?: [number, number];
  /** bus-only lanes a→b and b→a (OSM lanes:psv, lanes:bus, bus:lanes) */
  busLanes?: [number, number];
  /** route numbers (OSM ref: "US 101", "I 280", "CA 1") */
  ref?: string;
}

// ---------- elevation ----------

const tiles = new Map<string, PNG | null>();
function tile(x: number, y: number): PNG | null {
  const k = `${x},${y}`;
  if (!tiles.has(k)) {
    const f = `${RAW}/elevation/${ELEV_ZOOM}-${x}-${y}.png`;
    tiles.set(k, fs.existsSync(f) ? PNG.sync.read(fs.readFileSync(f)) : null);
  }
  return tiles.get(k)!;
}
function px(png: PNG, i: number, j: number): number {
  i = Math.max(0, Math.min(255, i));
  j = Math.max(0, Math.min(255, j));
  const o = (j * 256 + i) * 4;
  return png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
}
/** Ground elevation in metres (bilinear within a tile). */
export function elevation(lat: number, lon: number): number {
  const tx = tileX(lon), ty = tileY(lat);
  const x = Math.floor(tx), y = Math.floor(ty);
  const png = tile(x, y);
  if (!png) return 0;
  const fx = (tx - x) * 256 - 0.5, fy = (ty - y) * 256 - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy);
  const u = fx - i, v = fy - j;
  const z = px(png, i, j) * (1 - u) * (1 - v) + px(png, i + 1, j) * u * (1 - v) + px(png, i, j + 1) * (1 - u) * v + px(png, i + 1, j + 1) * u * v;
  // the bay reads as negative depths; streets are never below about -2 m
  return Math.max(-2, z);
}

// ---------- rules ----------

const CAR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road']);
const NO_WALK = new Set(['motorway', 'motorway_link', 'busway']);
const NO_BIKE = new Set(['motorway', 'motorway_link', 'steps', 'corridor']);
/** ways for people, not vehicles: bikes may use them only when tagged so */
const FOOT_ONLY = new Set(['footway', 'pedestrian', 'corridor', 'platform', 'busway']);
/** default speed limits in San Francisco, km/h */
const DEFAULT_SPEED: Record<string, number> = {
  motorway: 88, motorway_link: 56, trunk: 56, trunk_link: 40, primary: 40, primary_link: 40, secondary: 40, secondary_link: 40,
  tertiary: 40, tertiary_link: 40, unclassified: 40, residential: 40, living_street: 16, service: 16,
};
/** the rise of one stair, metres (a 7-inch riser) */
export const STEP_RISE = 0.18;

function speedOf(tags: Record<string, string>, cls: string): number {
  const m = /^(\d+)\s*(mph)?/.exec(tags.maxspeed ?? '');
  if (m) return Number(m[1]) * (m[2] || !tags.maxspeed.includes('km') ? 1.609 : 1);
  return DEFAULT_SPEED[cls] ?? 40;
}

/** lanes each way when OSM gives none: a two-way street's lanes per direction, a one-way street's */
const DEFAULT_LANES: Record<string, [number, number]> = {
  motorway: [3, 3], motorway_link: [1, 1], trunk: [2, 3], trunk_link: [1, 1], primary: [2, 3], primary_link: [1, 1], secondary: [2, 3], secondary_link: [1, 1],
  tertiary: [1, 2], tertiary_link: [1, 1], unclassified: [1, 1], residential: [1, 1], living_street: [1, 1], service: [1, 1],
};
const num = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
};
/** count of 'designated' lanes in a lane list such as bus:lanes=no|designated */
const listed = (v: string | undefined) => (v ? v.split('|').filter((x) => x === 'designated' || x === 'yes').length : undefined);
/** General-purpose and bus lanes each way (a→b, b→a), for road capacity. */
export function lanesOf(tags: Record<string, string>, cls: string, oneway: 0 | 1 | -1): { lanes: [number, number]; bus: [number, number] } {
  const def = DEFAULT_LANES[cls] ?? [1, 1];
  const total = num(tags.lanes);
  const busF = num(tags['lanes:psv:forward']) ?? num(tags['lanes:bus:forward']) ?? listed(tags['bus:lanes:forward']) ?? listed(tags['psv:lanes:forward']);
  const busB = num(tags['lanes:psv:backward']) ?? num(tags['lanes:bus:backward']) ?? listed(tags['bus:lanes:backward']) ?? listed(tags['psv:lanes:backward']);
  const busT = num(tags['lanes:psv']) ?? num(tags['lanes:bus']) ?? listed(tags['bus:lanes']) ?? listed(tags['psv:lanes']);
  let f: number, b: number, bf = 0, bb = 0;
  if (oneway !== 0) {
    const n = total ?? def[1];
    const bus = busT ?? busF ?? 0;
    f = oneway === 1 ? n : 0;
    b = oneway === 1 ? 0 : n;
    if (oneway === 1) bf = bus;
    else bb = bus;
  } else {
    const centre = num(tags['lanes:both_ways']) ?? 0;
    const lf = num(tags['lanes:forward']), lb = num(tags['lanes:backward']);
    if (lf !== undefined || lb !== undefined) {
      f = lf ?? Math.max(1, (total ?? 2 * def[0]) - centre - (lb ?? 0));
      b = lb ?? Math.max(1, (total ?? 2 * def[0]) - centre - f);
    } else if (total !== undefined) f = b = Math.max(0.5, (total - centre) / 2);
    else f = b = def[0];
    bf = busF ?? (busT !== undefined ? busT / 2 : 0);
    bb = busB ?? (busT !== undefined ? busT / 2 : 0);
  }
  const gp = (n: number, bus: number) => (n > 0 ? Math.max(0.5, n - bus) : 0);
  return { lanes: [gp(f, bf), gp(b, bb)], bus: [Math.min(bf, f), Math.min(bb, b)] };
}

const CLOSED = /^(no|private)$/;
const OPEN = /^(yes|designated|permissive|destination|customers|official)$/;
/** Is a mode allowed, by the most specific access tag present (OSM's access hierarchy)? undefined if none says. */
function allowed(tags: Record<string, string>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = tags[k];
    if (v !== undefined) return !CLOSED.test(v);
  }
  return undefined;
}

export function rules(tags: Record<string, string>) {
  const cls = tags.highway;
  const level = (tags.level ?? '').split(';').filter((l) => l !== '').map(Number);
  const area = tags.area === 'yes';
  // cars: the class, unless closed to them (a private road, a parking aisle, a plaza)
  const car = CAR.has(cls) && tags.service !== 'parking_aisle' && !area && allowed(tags, ['motorcar', 'motor_vehicle', 'vehicle', 'access']) !== false;
  // on foot: everything but freeways and busways, unless closed to people on foot. foot=yes
  // overrides access=no or private (many campus and park paths), and opens a freeway ramp's
  // sidewalk; a trunk road with no sidewalk and no foot tag is closed to them
  let walk = NO_WALK.has(cls) ? OPEN.test(tags.foot ?? '') : allowed(tags, ['foot', 'access']) !== false && tags.sidewalk !== 'no_walk';
  if ((cls === 'trunk' || cls === 'trunk_link') && tags.foot === undefined && tags.sidewalk === 'no') walk = false;
  let bike = !NO_BIKE.has(cls) && allowed(tags, ['bicycle', 'vehicle', 'access']) !== false;
  if (FOOT_ONLY.has(cls)) bike = OPEN.test(tags.bicycle ?? '');
  const bikeway =
    cls === 'cycleway' ||
    /lane|track|separate|shared_lane/.test(`${tags.cycleway ?? ''} ${tags['cycleway:right'] ?? ''} ${tags['cycleway:left'] ?? ''} ${tags['cycleway:both'] ?? ''}`) ||
    tags.bicycle === 'designated';
  let oneway: 0 | 1 | -1 = 0;
  if (tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true' || tags.junction === 'roundabout' || cls === 'motorway') oneway = 1;
  if (tags.oneway === '-1') oneway = -1;
  // corridors are indoors by definition
  const under = (tags.tunnel !== undefined && tags.tunnel !== 'no') || Number(tags.layer) < 0 || level.some((l) => l < 0) || tags.indoor === 'yes' || tags.location === 'underground' || cls === 'corridor';
  // a walkway off the ground (bridge, layer or level above it); streets on bridges are still streets
  const above = !car && !under && ((tags.bridge !== undefined && tags.bridge !== 'no') || Number(tags.layer) > 0 || level.some((l) => l > 0));
  return { cls, car, walk, bike, bikeway, oneway, steps: cls === 'steps', under, above, area };
}
type Rules = ReturnType<typeof rules>;

/**
 * The level a way is on, for deciding whether two ways that cross meet: its layer and level. Null
 * for a way that meets nothing it crosses (it would share a node if it did): a bridge, a tunnel,
 * a covered or indoor way, or one in a cutting or on an embankment.
 */
export function grade(tags: Record<string, string>): string | null {
  const off = (k: string) => tags[k] !== undefined && tags[k] !== 'no';
  if (off('bridge') || off('tunnel') || off('covered') || off('cutting') || off('embankment') || tags.indoor === 'yes' || tags.location === 'underground' || tags.highway === 'corridor') return null;
  return `${Number(tags.layer) || 0}|${tags.level ?? ''}`;
}

/** a node people cannot pass: a locked or private gate, or a fence or wall drawn through a path */
function blocks(tags?: Record<string, string>): boolean {
  if (!tags?.barrier) return false;
  const foot = allowed(tags, ['foot', 'access']);
  if (/^(wall|fence|retaining_wall|city_wall|hedge|guard_rail|ditch)$/.test(tags.barrier)) return foot !== true;
  if (tags.locked === 'yes' && !OPEN.test(tags.foot ?? '')) return true;
  return foot === false;
}

// ---------- geometry ----------

type P = { x: number; y: number };
const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** where segments pq and rs cross inside both (not at an end), as fractions along each */
export function segCross(p: P, q: P, r: P, s: P): [number, number] | null {
  const dx = q.x - p.x, dy = q.y - p.y, ex = s.x - r.x, ey = s.y - r.y;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((r.x - p.x) * ey - (r.y - p.y) * ex) / den;
  const u = ((r.x - p.x) * dy - (r.y - p.y) * dx) / den;
  const eps = 1e-6;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return [t, u];
}
function inRing(pt: P, ring: P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** a coarse grid of segments, for finding those near a point or a segment */
class SegGrid {
  cells = new Map<string, number[]>();
  constructor(readonly size: number) {}
  key(p: P) {
    return `${Math.floor(p.x / this.size)},${Math.floor(p.y / this.size)}`;
  }
  private keys(a: P, b: P): string[] {
    const out: string[] = [];
    const s = this.size;
    for (let i = Math.floor(Math.min(a.x, b.x) / s); i <= Math.floor(Math.max(a.x, b.x) / s); i++)
      for (let j = Math.floor(Math.min(a.y, b.y) / s); j <= Math.floor(Math.max(a.y, b.y) / s); j++) out.push(`${i},${j}`);
    return out;
  }
  add(id: number, a: P, b: P) {
    for (const k of this.keys(a, b)) (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(id);
  }
  near(a: P, b: P): Set<number> {
    const out = new Set<number>();
    for (const k of this.keys(a, b)) for (const id of this.cells.get(k) ?? []) out.add(id);
    return out;
  }
}

/** join a multipolygon's member ways end to end into closed rings */
function joinRings(parts: number[][]): number[][] {
  const rings: number[][] = [];
  const left = parts.map((p) => [...p]);
  while (left.length) {
    let ring = left.shift()!;
    let grew = true;
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], end = ring[ring.length - 1];
        if (p[0] === end) ring = ring.concat(p.slice(1));
        else if (p[p.length - 1] === end) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring[0] === ring[ring.length - 1] && ring.length > 3) rings.push(ring);
  }
  return rings;
}

// ---------- the graph ----------

/** metres: a walkway ending this close to another on the same level is joined to it */
export const NEAR_MISS = 2;
/** a plaza with more entries than this links each to its nearest AREA_NEAREST only */
const AREA_ALL = 24, AREA_NEAREST = 12;

export interface BuildStats {
  ways: number;
  /** walkways crossing on one level with no shared node, joined */
  crossings: number;
  /** crossings left apart: on different levels (or a bridge, tunnel or indoors), or two roads */
  apartLevels: number;
  apartRoads: number;
  /** walkway ends joined to a walkway within NEAR_MISS, and those left apart by a barrier between */
  nearMisses: number;
  nearMissesBarred: number;
  /** pedestrian areas walked across, and the straight links made across them */
  areas: number;
  areaLinks: number;
  /** gates and barriers closed to people on foot */
  gates: number;
  steps: number;
  stepsWithCount: number;
  /** pieces under half a metre long, once dropped (cutting the network where two nodes share a spot) */
  short: number;
}

/**
 * The street graph from OpenStreetMap elements. `z0` gives the ground's elevation (the tiles, or
 * flat ground in tests).
 */
export function buildStreets(elements: OsmElement[], z0: (lat: number, lon: number) => number = elevation): { vertices: StreetVertex[]; edges: StreetEdge[]; stats: BuildStats } {
  const nodes = new Map<number, OsmNode>();
  const allWays = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') allWays.set(e.id, e);
    else if (e.type === 'relation') relations.push(e);
  }
  const xy = new Map<number, P>();
  const at = (id: number): P => {
    let p = xy.get(id);
    if (!p) {
      const n = nodes.get(id)!;
      const [x, y] = toXY(n.lat, n.lon);
      p = { x, y };
      xy.set(id, p);
    }
    return p;
  };
  const stats: BuildStats = { ways: 0, crossings: 0, apartLevels: 0, apartRoads: 0, nearMisses: 0, nearMissesBarred: 0, areas: 0, areaLinks: 0, gates: 0, steps: 0, stepsWithCount: 0, short: 0 };

  // the network's ways with their rules (a pedestrian multipolygon's untagged outline ways take its tags)
  type W = { nodes: number[]; tags: Record<string, string>; r: Rules };
  const ways: W[] = [];
  const areas: { outer: number[][]; inner: number[][]; tags: Record<string, string> }[] = [];
  for (const w of allWays.values()) {
    if (!w.tags?.highway) continue;
    const ids = w.nodes.filter((id) => nodes.has(id));
    if (ids.length < 2) continue;
    const r = rules(w.tags);
    ways.push({ nodes: ids, tags: w.tags, r });
    if (r.area && r.walk && ids[0] === ids[ids.length - 1]) areas.push({ outer: [ids], inner: [], tags: w.tags });
  }
  for (const rel of relations) {
    if (rel.tags?.highway !== 'pedestrian') continue;
    const tags = { ...rel.tags, area: 'yes' };
    const r = rules(tags);
    if (!r.walk) continue;
    const rings = (role: string) =>
      joinRings(rel.members.filter((m) => m.type === 'way' && (m.role || 'outer') === role).map((m) => allWays.get(m.ref)?.nodes.filter((id) => nodes.has(id))).filter((n): n is number[] => !!n && n.length > 1));
    const outer = rings('outer');
    if (!outer.length) continue;
    areas.push({ outer, inner: rings('inner'), tags });
    for (const m of rel.members) {
      const w = allWays.get(m.ref);
      if (m.type !== 'way' || !w || w.tags?.highway) continue;
      const ids = w.nodes.filter((id) => nodes.has(id));
      if (ids.length > 1) ways.push({ nodes: ids, tags, r });
    }
  }
  stats.ways = ways.length;

  // new nodes (negative ids): where crossing walkways meet, and where a near miss is joined
  let nextId = -1;
  const addNode = (a: number, b: number, t: number) => {
    const id = nextId--;
    const na = nodes.get(a)!, nb = nodes.get(b)!, pa = at(a), pb = at(b);
    nodes.set(id, { type: 'node', id, lat: na.lat + (nb.lat - na.lat) * t, lon: na.lon + (nb.lon - na.lon) * t });
    xy.set(id, { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t });
    return id;
  };
  const inserts = new Map<number, { seg: number; t: number; id: number }[]>();
  const insert = (w: number, seg: number, t: number, id: number) => (inserts.get(w) ?? inserts.set(w, []).get(w)!).push({ seg, t, id });

  // ---- 1. walkways that cross on the same level without a shared node ----
  // Two ways meet where they cross unless either is a bridge, tunnel, covered or indoors, or they
  // are on different layers or levels. Two roads crossing without a node stay apart: on the city's
  // well-mapped streets an untagged overpass is likelier than a missing intersection.
  const segs: { w: number; k: number }[] = [];
  const grid = new SegGrid(60);
  ways.forEach((w, wi) => {
    if (!w.r.walk && !w.r.bike) return;
    for (let k = 0; k + 1 < w.nodes.length; k++) {
      grid.add(segs.length, at(w.nodes[k]), at(w.nodes[k + 1]));
      segs.push({ w: wi, k });
    }
  });
  const grades = ways.map((w) => grade(w.tags));
  for (const [key, cell] of grid.cells)
    for (let i = 0; i < cell.length; i++)
      for (let j = i + 1; j < cell.length; j++) {
        const A = segs[cell[i]], B = segs[cell[j]];
        if (A.w === B.w) continue;
        const wa = ways[A.w], wb = ways[B.w];
        const a0 = wa.nodes[A.k], a1 = wa.nodes[A.k + 1], b0 = wb.nodes[B.k], b1 = wb.nodes[B.k + 1];
        if (a0 === b0 || a0 === b1 || a1 === b0 || a1 === b1) continue;
        const hit = segCross(at(a0), at(a1), at(b0), at(b1));
        if (!hit) continue;
        // each crossing once: in the cell holding it
        const pa = at(a0), pb = at(a1);
        if (grid.key({ x: pa.x + (pb.x - pa.x) * hit[0], y: pa.y + (pb.y - pa.y) * hit[0] }) !== key) continue;
        if (!(wa.r.walk && wb.r.walk) && !(wa.r.bike && wb.r.bike)) continue;
        if (grades[A.w] === null || grades[A.w] !== grades[B.w]) {
          stats.apartLevels++;
          continue;
        }
        if (wa.r.car && wb.r.car) {
          stats.apartRoads++;
          continue;
        }
        const id = addNode(a0, a1, hit[0]);
        insert(A.w, A.k, hit[0], id);
        insert(B.w, B.k, hit[1], id);
        stats.crossings++;
      }

  // ---- 2. walkways that end just short of another ----
  // A way's end that no other way touches, within NEAR_MISS of a walkway on the same level, is
  // joined to the nearest point on it, unless a wall, fence, freeway or railway lies between.
  const touches = new Map<number, number>();
  for (const w of allWays.values()) for (const id of new Set(w.nodes)) touches.set(id, (touches.get(id) ?? 0) + 1);
  const bars = new SegGrid(60);
  const barSegs: [P, P][] = [];
  for (const w of allWays.values()) {
    const t = w.tags ?? {};
    const hard = /^(wall|fence|retaining_wall|city_wall|hedge|guard_rail)$/.test(t.barrier ?? '') || /^(motorway|motorway_link)$/.test(t.highway ?? '') || /^(rail|subway|light_rail|narrow_gauge)$/.test(t.railway ?? '');
    if (!hard) continue;
    const ids = w.nodes.filter((id) => nodes.has(id));
    for (let k = 0; k + 1 < ids.length; k++) {
      bars.add(barSegs.length, at(ids[k]), at(ids[k + 1]));
      barSegs.push([at(ids[k]), at(ids[k + 1])]);
    }
  }
  const barred = (p: P, q: P) => {
    for (const s of bars.near(p, q)) {
      const [r, t] = barSegs[s];
      if (cross(p, q, r) * cross(p, q, t) <= 0 && cross(r, t, p) * cross(r, t, q) <= 0) return true;
    }
    return false;
  };
  const links: { from: number; to: number; tags: Record<string, string>; r: Rules; made: 'area' | 'link' }[] = [];
  const footway = rules({ highway: 'footway' });
  ways.forEach((w, wi) => {
    if (!w.r.walk || w.r.area || grades[wi] === null || w.nodes[0] === w.nodes[w.nodes.length - 1]) return;
    for (const end of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
      if ((touches.get(end) ?? 0) > 1) continue;
      const p = at(end);
      let best: { w: number; k: number; t: number; d: number } | null = null;
      for (const s of grid.near({ x: p.x - NEAR_MISS, y: p.y - NEAR_MISS }, { x: p.x + NEAR_MISS, y: p.y + NEAR_MISS })) {
        const S = segs[s];
        if (S.w === wi || !ways[S.w].r.walk || grades[S.w] !== grades[wi]) continue;
        const a = at(ways[S.w].nodes[S.k]), b = at(ways[S.w].nodes[S.k + 1]);
        const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2)) : 0;
        const d = Math.hypot(a.x + (b.x - a.x) * t - p.x, a.y + (b.y - a.y) * t - p.y);
        if (d <= NEAR_MISS && (!best || d < best.d)) best = { w: S.w, k: S.k, t, d };
      }
      if (!best) continue;
      const tw = ways[best.w];
      const a0 = tw.nodes[best.k], a1 = tw.nodes[best.k + 1];
      const pa = at(a0), pb = at(a1);
      if (barred(p, { x: pa.x + (pb.x - pa.x) * best.t, y: pa.y + (pb.y - pa.y) * best.t })) {
        stats.nearMissesBarred++;
        continue;
      }
      let to = best.t < 1e-3 ? a0 : best.t > 1 - 1e-3 ? a1 : 0;
      if (!to) {
        to = addNode(a0, a1, best.t);
        insert(best.w, best.k, best.t, to);
      }
      links.push({ from: end, to, tags: { highway: 'footway' }, r: { ...footway, bike: w.r.bike && tw.r.bike }, made: 'link' });
      stats.nearMisses++;
    }
  });

  // the ways with their new nodes in place
  inserts.forEach((list, wi) => {
    const w = ways[wi];
    list.sort((a, b) => a.seg - b.seg || a.t - b.t);
    const out: number[] = [];
    let q = 0;
    for (let k = 0; k < w.nodes.length; k++) {
      out.push(w.nodes[k]);
      while (q < list.length && list[q].seg === k) out.push(list[q++].id);
    }
    w.nodes = out;
  });

  // a node becomes a graph vertex where ways meet or end
  const uses = new Map<number, number>();
  const use = (id: number, n: number) => uses.set(id, (uses.get(id) ?? 0) + n);
  for (const w of ways) w.nodes.forEach((id, i) => use(id, i === 0 || i === w.nodes.length - 1 ? 2 : 1));
  for (const l of links) use(l.from, 2), use(l.to, 2);

  // ---- 3. pedestrian areas: walked straight across between the places paths reach them ----
  const ends = new Map<string, number[]>();
  for (const w of ways)
    if (w.r.walk && !w.r.area)
      for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
        const p = at(id), k = `${Math.floor(p.x / 100)},${Math.floor(p.y / 100)}`;
        (ends.get(k) ?? ends.set(k, []).get(k)!).push(id);
      }
  for (const A of areas) {
    const outline = A.outer.flat();
    const outerP = A.outer.map((r) => r.map(at)), innerP = A.inner.map((r) => r.map(at));
    const ringsP = [...outerP, ...innerP];
    const inside = (p: P) => outerP.some((r) => inRing(p, r)) && !innerP.some((r) => inRing(p, r));
    // where other ways join the outline, and walkway ends inside it
    const entries = new Set<number>();
    for (const id of outline) if ((uses.get(id) ?? 0) > 2) entries.add(id);
    const xs = outline.map((id) => at(id).x), ys = outline.map((id) => at(id).y);
    for (let i = Math.floor(Math.min(...xs) / 100); i <= Math.floor(Math.max(...xs) / 100); i++)
      for (let j = Math.floor(Math.min(...ys) / 100); j <= Math.floor(Math.max(...ys) / 100); j++)
        for (const id of ends.get(`${i},${j}`) ?? []) if (inside(at(id))) entries.add(id);
    const E = [...entries];
    if (E.length < 2) continue;
    stats.areas++;
    const sees = (p: P, q: P) => {
      for (const ring of ringsP) for (let k = 0; k + 1 < ring.length; k++) if (segCross(p, q, ring[k], ring[k + 1])) return false;
      return inside({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    };
    const r = { ...rules(A.tags), car: false };
    const made = new Set<string>();
    E.forEach((id, i) => {
      const p = at(id);
      const others = E.map((o, j) => ({ o, j, d: Math.hypot(at(o).x - p.x, at(o).y - p.y) })).filter((o) => o.j !== i);
      const pick = E.length > AREA_ALL ? others.sort((a, b) => a.d - b.d).slice(0, AREA_NEAREST) : others;
      for (const o of pick) {
        const k = i < o.j ? `${i}:${o.j}` : `${o.j}:${i}`;
        if (made.has(k) || o.d < 1 || !sees(p, at(o.o))) continue;
        made.add(k);
        links.push({ from: id, to: o.o, tags: A.tags, r, made: 'area' });
        use(id, 2), use(o.o, 2);
        stats.areaLinks++;
      }
    });
  }

  // ---- 4. split the ways at vertices into edges ----
  // a gate closed to people on foot splits its node in two: a dead end on each side, no way through
  const gates = new Set<number>();
  for (const id of uses.keys()) if (blocks(nodes.get(id)?.tags)) gates.add(id);
  stats.gates = gates.size;
  const vIndex = new Map<string, number>();
  const vertices: StreetVertex[] = [];
  const zOf = new Map<number, number>();
  const z = (id: number) => {
    let v = zOf.get(id);
    if (v === undefined) {
      const n = nodes.get(id)!;
      v = z0(n.lat, n.lon);
      zOf.set(id, v);
    }
    return v;
  };
  const vertex = (id: number, side: number) => {
    const key = gates.has(id) ? `${id}/${side}` : `${id}`;
    let i = vIndex.get(key);
    if (i === undefined) {
      const n = nodes.get(id)!, p = at(id);
      i = vertices.length;
      vertices.push({ lat: +n.lat.toFixed(6), lon: +n.lon.toFixed(6), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +z(id).toFixed(1) });
      vIndex.set(key, i);
    }
    return i;
  };
  const edges: StreetEdge[] = [];
  const push = (ids: number[], tags: Record<string, string>, r: Rules, made?: 'area' | 'link') => {
    let len = 0, up = 0, down = 0;
    const pts: number[] = [];
    for (let k = 0; k + 1 < ids.length; k++) {
      const p = at(ids[k]), q = at(ids[k + 1]);
      len += Math.hypot(q.x - p.x, q.y - p.y);
      const dz = z(ids[k + 1]) - z(ids[k]);
      if (dz > 0) up += dz;
      else down -= dz;
      if (k > 0) pts.push(+nodes.get(ids[k])!.lat.toFixed(6), +nodes.get(ids[k])!.lon.toFixed(6));
    }
    const first = ids[0], last = ids[ids.length - 1];
    const dz = z(last) - z(first);
    // bridges and tunnels do not follow the ground: take only the end-to-end change
    if (tags.bridge || tags.tunnel) (up = Math.max(0, dz)), (down = Math.max(0, -dz));
    // a flight of stairs climbs its steps' rise (step_count), up the way where incline=up (or,
    // unsaid, where the ground rises); without a count, the ground's rise end to end
    if (r.steps) {
      stats.steps++;
      const n = Number(tags.step_count);
      if (n > 0) stats.stepsWithCount++;
      const rise = n > 0 ? n * STEP_RISE : Math.abs(dz);
      const upward = tags.incline === 'up' ? true : tags.incline === 'down' ? false : dz >= 0;
      up = upward ? rise : 0;
      down = upward ? 0 : rise;
    }
    // two nodes on one spot make a piece of no length; it is kept, or the network would break there
    if (len < 0.5) stats.short++;
    const ln = r.car ? lanesOf(tags, r.cls, r.oneway) : null;
    edges.push({
      a: vertex(first, 0), b: vertex(last, 1), len: +Math.max(0.1, len).toFixed(1), up: +up.toFixed(1), down: +down.toFixed(1),
      cls: r.cls, name: tags.name, speed: Math.round(speedOf(tags, r.cls)), oneway: r.oneway,
      car: r.car, walk: r.walk, bike: r.bike, bikeway: r.bikeway, steps: r.steps, ...(r.under ? { under: true } : {}), ...(r.above ? { above: true } : {}), ...(made ? { made } : {}), pts,
      ...(ln ? { lanes: ln.lanes, ...(ln.bus[0] || ln.bus[1] ? { busLanes: ln.bus } : {}) } : {}),
      ...(r.car && tags.ref ? { ref: tags.ref } : {}),
    });
  };
  for (const w of ways) {
    if (!w.r.car && !w.r.walk && !w.r.bike) continue;
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && (uses.get(w.nodes[i]) ?? 0) <= 1 && !gates.has(w.nodes[i])) continue;
      push(w.nodes.slice(start, i + 1), w.tags, w.r);
      start = i;
    }
  }
  for (const l of links) push([l.from, l.to], l.tags, l.r, l.made);
  return { vertices, edges, stats };
}

function main() {
  console.time('streets');
  const osm = JSON.parse(fs.readFileSync(`${RAW}/osm-network.json`, 'utf8')) as { elements: OsmElement[] };
  const { vertices, edges, stats } = buildStreets(osm.elements);
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(`${WORK}/streets.json`, JSON.stringify({ vertices, edges, stats }));
  const km = (f: (e: StreetEdge) => boolean) => (edges.filter(f).reduce((s, e) => s + e.len, 0) / 1000).toFixed(0);
  console.log(`vertices ${vertices.length}, edges ${edges.length}; km car ${km((e) => e.car)}, walk ${km((e) => e.walk)}, bike ${km((e) => e.bike)}, bikeway ${km((e) => e.bikeway)}, steps ${km((e) => e.steps)}`);
  console.log(`joins ${JSON.stringify(stats)}`);
  const zs = vertices.map((v) => v.z);
  console.log(`elevation ${Math.min(...zs).toFixed(0)}..${Math.max(...zs).toFixed(0)} m`);
  console.timeEnd('streets');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
