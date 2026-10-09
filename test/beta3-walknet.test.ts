import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toLatLon } from '../shared/beta3/geo';
import { dijkstra, Graph } from '../server/beta3/pipeline/graph';
import { WORK } from '../server/beta3/pipeline/paths';
import { buildStreets, NEAR_MISS, type OsmElement, type StreetEdge, type StreetVertex } from '../server/beta3/pipeline/streets';
import { mainPieces, STAIR, WALK_FLAT, walkGraph, walkTimes } from '../server/beta3/pipeline/walk';
import { KNOWN } from '../server/beta3/pipeline/diag-walk';

/** a tiny map: nodes at (x, y) metres, ways as [node ids, tags] */
function osm(pts: Record<number, [number, number]>, ways: [number[], Record<string, string>][], nodeTags: Record<number, Record<string, string>> = {}): OsmElement[] {
  const out: OsmElement[] = Object.entries(pts).map(([id, [x, y]]) => {
    const [lat, lon] = toLatLon(x, y);
    return { type: 'node', id: Number(id), lat, lon, ...(nodeTags[Number(id)] ? { tags: nodeTags[Number(id)] } : {}) };
  });
  ways.forEach(([nodes, tags], i) => out.push({ type: 'way', id: 1000 + i, nodes, tags }));
  return out;
}

/** walking metres between the vertices nearest two points (Infinity if not joined) */
function walkM(g: { vertices: StreetVertex[]; edges: StreetEdge[] }, a: [number, number], b: [number, number]): number {
  const near = ([x, y]: [number, number]) => g.vertices.reduce((best, v, i) => (Math.hypot(v.x - x, v.y - y) < Math.hypot(g.vertices[best].x - x, g.vertices[best].y - y) ? i : best), 0);
  const arcs = g.edges.filter((e) => e.walk).flatMap((e) => [{ a: e.a, b: e.b, cost: e.len, edge: 0 }, { a: e.b, b: e.a, cost: e.len, edge: 0 }]);
  const dist = new Float64Array(g.vertices.length);
  dijkstra(new Graph(g.vertices.length, arcs), [[near(a), 0]], 1e9, dist);
  return dist[near(b)];
}

const flat = () => 0;
// two paths crossing in an X at (50, 0)
const X = { 1: [0, 0], 2: [100, 0], 3: [50, -50], 4: [50, 50] } as Record<number, [number, number]>;

describe('beta3 walk network: ways that cross', () => {
  it('joins two footways crossing on the same level with a new node', () => {
    const g = buildStreets(osm(X, [[[1, 2], { highway: 'footway' }], [[3, 4], { highway: 'footway' }]]), flat);
    expect(g.stats.crossings).toBe(1);
    expect(walkM(g, [0, 0], [50, 50])).toBeCloseTo(50 + 50, 0);
  });
  it('joins a path to a street it crosses, but never two roads', () => {
    const path = buildStreets(osm(X, [[[1, 2], { highway: 'residential' }], [[3, 4], { highway: 'path' }]]), flat);
    expect(path.stats.crossings).toBe(1);
    const roads = buildStreets(osm(X, [[[1, 2], { highway: 'residential' }], [[3, 4], { highway: 'residential' }]]), flat);
    expect(roads.stats.crossings).toBe(0);
    expect(walkM(roads, [0, 0], [50, 50])).toBe(Infinity);
  });
  it('leaves apart a footbridge, a tunnel, different layers and an indoor corridor', () => {
    for (const tags of <Record<string, string>[]>[{ bridge: 'yes', layer: '1' }, { tunnel: 'yes', layer: '-1' }, { layer: '1' }, { layer: '-1' }, { indoor: 'yes' }, { covered: 'yes' }]) {
      const g = buildStreets(osm(X, [[[1, 2], { highway: 'footway' }], [[3, 4], { highway: 'footway', ...tags }]]), flat);
      expect(g.stats.crossings, JSON.stringify(tags)).toBe(0);
      expect(walkM(g, [0, 0], [50, 50]), JSON.stringify(tags)).toBe(Infinity);
    }
    // a freeway is no walkway, so a path across it is never joined to it
    const fwy = buildStreets(osm(X, [[[1, 2], { highway: 'motorway' }], [[3, 4], { highway: 'footway' }]]), flat);
    expect(fwy.stats.crossings).toBe(0);
  });
  it('joins two bridges on the same layer only where they share a node', () => {
    const g = buildStreets(osm(X, [[[1, 2], { highway: 'footway', bridge: 'yes', layer: '1' }], [[3, 4], { highway: 'footway', bridge: 'yes', layer: '1' }]]), flat);
    expect(g.stats.crossings).toBe(0);
  });
});

describe('beta3 walk network: near misses, plazas, access', () => {
  // a path ending 1.5 m short of a sidewalk running along y = 0
  const near = { 1: [0, 0], 2: [100, 0], 3: [50, 1.5], 4: [50, 60] } as Record<number, [number, number]>;
  it(`joins a walkway ending within ${NEAR_MISS} m of another`, () => {
    const g = buildStreets(osm(near, [[[1, 2], { highway: 'footway', footway: 'sidewalk' }], [[4, 3], { highway: 'footway' }]]), flat);
    expect(g.stats.nearMisses).toBe(1);
    expect(walkM(g, [0, 0], [50, 60])).toBeLessThan(50 + 60 + 2);
  });
  it('but not across a fence between them', () => {
    const pts = { ...near, 5: [0, 0.8], 6: [100, 0.8] } as Record<number, [number, number]>;
    const g = buildStreets(osm(pts, [[[1, 2], { highway: 'footway' }], [[4, 3], { highway: 'footway' }], [[5, 6], { barrier: 'fence' }]]), flat);
    expect(g.stats.nearMisses).toBe(0);
    expect(g.stats.nearMissesBarred).toBe(1);
    expect(walkM(g, [0, 0], [50, 60])).toBe(Infinity);
  });
  it('walks straight across a pedestrian plaza between the paths that reach it', () => {
    // a 100 m square plaza; paths reach the middle of its west and east sides
    const pts = { 1: [0, 0], 2: [100, 0], 3: [100, 100], 4: [0, 100], 5: [0, 50], 6: [100, 50], 7: [-40, 50], 8: [140, 50] } as Record<number, [number, number]>;
    const g = buildStreets(osm(pts, [[[1, 2, 6, 3, 4, 5, 1], { highway: 'pedestrian', area: 'yes' }], [[7, 5], { highway: 'footway' }], [[6, 8], { highway: 'footway' }]]), flat);
    expect(g.stats.areaLinks).toBeGreaterThan(0);
    expect(walkM(g, [-40, 50], [140, 50])).toBeCloseTo(180, 0);
    // no cars across it
    expect(g.edges.filter((e) => e.made === 'area').every((e) => !e.car && e.walk)).toBe(true);
  });
  it('lets foot=yes open a path closed to vehicles, and keeps private paths and locked gates closed', () => {
    const pts = { 1: [0, 0], 2: [100, 0] } as Record<number, [number, number]>;
    const open = buildStreets(osm(pts, [[[1, 2], { highway: 'service', access: 'private', foot: 'yes' }]]), flat);
    expect(open.edges[0].walk).toBe(true);
    expect(open.edges[0].car).toBe(false);
    const closed = buildStreets(osm(pts, [[[1, 2], { highway: 'footway', access: 'private' }]]), flat);
    expect(closed.edges.every((e) => !e.walk)).toBe(true);
    const ramp = buildStreets(osm(pts, [[[1, 2], { highway: 'motorway_link', foot: 'yes', sidewalk: 'right' }]]), flat);
    expect(ramp.edges[0].walk).toBe(true);
    const gated = buildStreets(osm({ ...pts, 3: [50, 0] }, [[[1, 3, 2], { highway: 'footway' }]], { 3: { barrier: 'gate', locked: 'yes' } }), flat);
    expect(walkM(gated, [0, 0], [100, 0])).toBe(Infinity);
    const openGate = buildStreets(osm({ ...pts, 3: [50, 0] }, [[[1, 3, 2], { highway: 'footway' }]], { 3: { barrier: 'gate' } }), flat);
    expect(walkM(openGate, [0, 0], [100, 0])).toBeCloseTo(100, 0);
  });
  it('keeps a piece of no length (two nodes on one spot) so the network stays joined', () => {
    const pts = { 1: [0, 0], 2: [50, 0], 3: [50, 0], 4: [100, 0] } as Record<number, [number, number]>;
    const g = buildStreets(osm(pts, [[[1, 2], { highway: 'footway' }], [[2, 3], { highway: 'footway' }], [[3, 4], { highway: 'footway' }]]), flat);
    expect(walkM(g, [0, 0], [100, 0])).toBeLessThan(101);
  });
});

describe('beta3 walk network: stairs', () => {
  it('walks stairs at a stair pace: slower than the flat, slower up than down', () => {
    // 20 steps over 10 m, climbing northward
    const pts = { 1: [0, 0], 2: [0, 10] } as Record<number, [number, number]>;
    const g = buildStreets(osm(pts, [[[1, 2], { highway: 'steps', step_count: '20', incline: 'up' }]]), flat);
    const e = g.edges[0];
    expect(e.walk && e.steps && !e.bike).toBe(true);
    expect(e.up).toBeCloseTo(3.6, 1);
    const [up, down] = walkTimes(e, g.vertices);
    const flatSec = 10 / WALK_FLAT;
    expect(up).toBeCloseTo(flatSec + STAIR.upSecPerM * 3.6, 3);
    expect(down).toBeCloseTo(flatSec + STAIR.downSecPerM * 3.6, 3);
    expect(down).toBeLessThan(up);
    // stairs with no count and flat ground still cost more than the flat
    const plain = buildStreets(osm(pts, [[[1, 2], { highway: 'steps' }]]), flat);
    expect(Math.min(...walkTimes(plain.edges[0], plain.vertices))).toBeCloseTo(STAIR.minFactor * flatSec, 3);
  });
  it('drops nothing walkable on the hills: a stairway joined at both ends stays in the network', () => {
    const pts = { 1: [0, 0], 2: [0, 100], 3: [100, 0], 4: [100, 100] } as Record<number, [number, number]>;
    const g = buildStreets(osm(pts, [[[1, 3], { highway: 'residential' }], [[2, 4], { highway: 'residential' }], [[1, 2], { highway: 'steps' }]]), (lat) => (lat - 37.7) * 1e5);
    const { g: wg } = walkGraph(g.vertices, g.edges);
    expect([...mainPieces(wg)].every((m) => m === 1)).toBe(true);
  });
});

describe('beta3 driving and cycling: places that can be reached and left', () => {
  it('leaves a one-way dead end out of the network trips start and end on', () => {
    // a two-way street 0-1-2 and a one-way spur 1→3 with no way back
    const arcs = [
      { a: 0, b: 1, cost: 1, edge: 0 }, { a: 1, b: 0, cost: 1, edge: 0 },
      { a: 1, b: 2, cost: 1, edge: 1 }, { a: 2, b: 1, cost: 1, edge: 1 },
      { a: 1, b: 3, cost: 1, edge: 2 },
    ];
    expect([...mainPieces(new Graph(4, arcs))]).toEqual([1, 1, 1, 0]);
  });
});

// with the network built (BETA3_WORK), the known walks and the zones' distances
const built = fs.existsSync(`${WORK}/streets.json`) && fs.existsSync(`${WORK}/diag-walk.json`);
describe.skipIf(!built)('beta3 walk network as built', () => {
  const diag = built ? JSON.parse(fs.readFileSync(`${WORK}/diag-walk.json`, 'utf8')) : null;
  it('reaches Balboa Park BART from City College within 1.5 times the straight line', () => {
    const k = diag.known.find((x: { name: string }) => x.name === KNOWN[0].name);
    expect(k.ratio).toBeLessThan(1.5);
  });
  it('leaves no zone whose median road, bike or walk distance from the others is over 2.5 times the straight line', () => {
    expect(diag.zones.car.over2_5).toBe(0);
    expect(diag.zones.bike.over2_5).toBe(0);
  });
});
