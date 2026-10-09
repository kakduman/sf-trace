import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeRoadShapes, encodeRoadShapes, roadLinkKey, shapeCoords, simplify, SHAPE_STEP } from '../shared/beta3/roadShapes';
import { toLatLon, toXY } from '../shared/beta3/geo';
import type { RoadNet } from '../shared/beta3/roads';
import { congestionClass, congestionShare, freeFlowSpeed, linkSpeed, roadGroup } from '../client/beta3/roadsView';

describe('road shapes', () => {
  it('round-trips shapes through the varint encoding to within the quantization step', () => {
    const shapes = [
      [],
      [37.7793, -122.4193, 37.78012, -122.41875, 37.7811, -122.4177],
      [37.70812, -122.50311, 37.81057, -122.36504],
      [],
      [37.75, -122.45, 37.7501, -122.45001, 37.75023, -122.44987, 37.7504, -122.4497],
    ];
    const bin = encodeRoadShapes({ version: 1, built: 'test', nLinks: shapes.length, key: 'k', toleranceM: 2.5 }, shapes);
    const s = decodeRoadShapes(zlib.gunzipSync(zlib.gzipSync(bin)));
    expect(s.h.nLinks).toBe(5);
    expect(s.h.key).toBe('k');
    expect(shapeCoords(s, 0)).toBeNull();
    expect(shapeCoords(s, 3)).toBeNull();
    for (const k of [1, 2, 4]) {
      const c = shapeCoords(s, k)!;
      expect(c.length).toBe(shapes[k].length / 2);
      c.forEach(([lon, lat], i) => {
        expect(Math.abs(lat - shapes[k][2 * i])).toBeLessThanOrEqual(SHAPE_STEP / 2 + 1e-9);
        expect(Math.abs(lon - shapes[k][2 * i + 1])).toBeLessThanOrEqual(SHAPE_STEP / 2 + 1e-9);
      });
    }
    expect(() => encodeRoadShapes({ version: 1, built: '', nLinks: 2, key: '', toleranceM: 1 }, [[]])).toThrow();
  });

  it('simplifies a curve without cutting its corner, and drops points on a straight line', () => {
    // a quarter circle of 200 m radius in 1° steps: every point is within a few cm of its neighbors' chord
    const arc: number[] = [];
    for (let d = 0; d <= 90; d++) arc.push(...toLatLon(200 * Math.cos((d * Math.PI) / 180), 200 * Math.sin((d * Math.PI) / 180)));
    const keep = simplify(arc, 2.5);
    expect(keep[0]).toBe(0);
    expect(keep[keep.length - 1]).toBe(90);
    expect(keep.length).toBeGreaterThan(5); // the old neighbor test kept only the ends here
    // every dropped point stays within the tolerance of the drawn line
    const xy = keep.map((i) => toXY(arc[2 * i], arc[2 * i + 1]));
    for (let d = 0; d <= 90; d++) {
      const [px, py] = toXY(arc[2 * d], arc[2 * d + 1]);
      let best = Infinity;
      for (let j = 0; j + 1 < xy.length; j++) {
        const [ax, ay] = xy[j],
          [bx, by] = xy[j + 1];
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
        best = Math.min(best, Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)));
      }
      expect(best).toBeLessThanOrEqual(2.5 + 1e-6);
    }
    const line = [...toLatLon(0, 0), ...toLatLon(50, 1), ...toLatLon(100, 0)];
    expect(simplify(line, 2.5)).toEqual([0, 2]);
  });

  it('fingerprints the links, so shapes for another build of the network are not drawn', () => {
    const a = [0, 1, 2],
      b = [1, 2, 0],
      cls = [4, 4, 6];
    expect(roadLinkKey(3, a, b, cls)).toBe(roadLinkKey(3, Int32Array.from(a), Int32Array.from(b), Uint8Array.from(cls)));
    expect(roadLinkKey(3, a, b, cls)).not.toBe(roadLinkKey(3, a, [2, 2, 0], cls));
  });

  it('the shipped shapes match the shipped road network', () => {
    const shapes = decodeRoadShapes(zlib.gunzipSync(fs.readFileSync('client/beta3/model/road-shapes.bin.gz')));
    const raw = zlib.gunzipSync(fs.readFileSync('client/beta3/model/roads.bin.gz'));
    // the roads bundle: magic, header length, header JSON, then the arrays
    const n = raw.readUInt32LE(4);
    const h = JSON.parse(raw.subarray(8, 8 + n).toString()) as { nLinks: number; arrays: Record<string, { offset: number; length: number }> };
    let start = 8 + n;
    start += (8 - (start % 8)) % 8;
    const body = Uint8Array.prototype.slice.call(raw, start).buffer as ArrayBuffer;
    const arr = (k: string, C: Int32ArrayConstructor | Uint8ArrayConstructor) => new C(body, h.arrays[k].offset, h.arrays[k].length);
    expect(shapes.h.key).toBe(roadLinkKey(h.nLinks, arr('a', Int32Array), arr('b', Int32Array), arr('cls', Uint8Array)));
  });
});

describe('street congestion', () => {
  // two links of a mile: free flow 2 min (30 mph) in every period
  const L = 2;
  const net = { h: { nLinks: L }, len: Float32Array.from([1, 1]), t0: new Float32Array(4 * L).fill(2) } as unknown as RoadNet;
  const flow = { AM: [300, 0], MD: [100, 0], PM: [300, 0], NT: [0, 0] };
  const time = { AM: [4, 2], MD: [2, 2], PM: [3, 2], NT: [2, 2] };

  it('is the speed as a share of the free-flow speed in a period', () => {
    expect(linkSpeed(net, flow, time, 'AM', 0)).toBeCloseTo(15);
    expect(freeFlowSpeed(net, flow, 'AM', 0)).toBeCloseTo(30);
    expect(congestionShare(net, flow, time, 'AM', 0)).toBeCloseTo(0.5);
    expect(congestionShare(net, flow, time, 'PM', 0)).toBeCloseTo(2 / 3);
    expect(congestionShare(net, flow, time, 'MD', 0)).toBeCloseTo(1);
  });

  it('over the day weights the periods by their traffic', () => {
    // 700 vehicles: 700·2 free-flow minutes over 300·4 + 100·2 + 300·3 congested minutes
    expect(congestionShare(net, flow, time, 'day', 0)).toBeCloseTo(1400 / 2300);
    // no traffic: the midday speed, here free flow
    expect(congestionShare(net, flow, time, 'day', 1)).toBeCloseTo(1);
  });

  it('never exceeds free flow, and falls into the legend classes', () => {
    expect(congestionShare(net, flow, { ...time, MD: [1.9, 2] }, 'MD', 0)).toBe(1);
    expect([1, 0.9, 0.89, 0.75, 0.6, 0.45, 0.44, 0].map(congestionClass)).toEqual([0, 0, 1, 1, 2, 3, 4, 4]);
  });

  it('draws freeways, ramps, arterials, collectors, and local streets in their own groups', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(roadGroup)).toEqual([-1, 0, 1, 2, 2, 3, 4]);
  });
});

describe('app defaults', () => {
  it('opens on the whole day', async () => {
    // state.ts reads the page's address for a flag; give it an empty one
    const g = globalThis as { location?: unknown };
    g.location ??= { search: '' };
    const { state } = await import('../client/beta3/state');
    expect(state.period).toBe('day');
  });
});

describe('bus shapes routed on the streets', () => {
  // a 3×3 grid of streets 200 m apart (x east, y north from City Hall), as streets.json edges
  const grid = async () => {
    const { StreetRouter } = await import('../server/beta3/pipeline/route-shapes');
    const vertices: { lat: number; lon: number; x: number; y: number; z: number }[] = [];
    const at = (i: number, j: number) => i * 3 + j;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const [lat, lon] = toLatLon(200 * j, 200 * i);
        vertices.push({ lat, lon, x: 200 * j, y: 200 * i, z: 0 });
      }
    const edge = (a: number, b: number, extra: Record<string, unknown> = {}) => ({ a, b, len: 200, up: 0, down: 0, cls: 'residential', speed: 25, oneway: 0, car: true, walk: true, bike: true, pts: [], ...extra });
    const edges = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++) {
        // the middle east–west street is one-way westward
        edges.push(i === 1 ? edge(at(i, j + 1), at(i, j), { oneway: 1 }) : edge(at(i, j), at(i, j + 1)));
        edges.push(edge(at(j, i), at(j + 1, i)));
      }
    return { R: new StreetRouter(vertices as never, edges as never), at, vertices };
  };

  it('follows the streets, keeps to one-way streets, and puts each stop on the shape', async () => {
    const { R, vertices } = await grid();
    // two stops on the middle (one-way westward) street, a few metres off it
    const w = toLatLon(50, 205),
      e = toLatLon(350, 205);
    // westward: straight along the one-way street
    const back = R.route([e, w]);
    expect(back.routed).toBe(1);
    const len = (sh: [number, number][]) => sh.slice(1).reduce((m, p, i) => m + Math.hypot(toXY(...p)[0] - toXY(...sh[i])[0], toXY(...p)[1] - toXY(...sh[i])[1]), 0);
    expect(len(back.shape)).toBeCloseTo(300, 0);
    // eastward: around the block, since the street is one-way the other way
    const there = R.route([w, e]);
    expect(there.routed).toBe(1);
    expect(len(there.shape)).toBeGreaterThan(650);
    // every point of the shape is on a street of the grid
    for (const p of there.shape) {
      const [x, y] = toXY(...p);
      const onStreet = [0, 200, 400].some((c) => Math.abs(x - c) < 0.5 && y > -0.5 && y < 400.5) || [0, 200, 400].some((c) => Math.abs(y - c) < 0.5 && x > -0.5 && x < 400.5);
      expect(onStreet).toBe(true);
    }
    expect(there.stopAt[0]).toBe(0);
    expect(there.stopAt[1]).toBe(there.shape.length - 1);
    void vertices;
  });

  it('matches a sparse shape that cuts a corner onto the streets', async () => {
    const { R } = await grid();
    // a feed shape along the south street and up the east one, its points too far apart to turn the
    // corner: (0,0) → (300,0) → (400,100) → (400,300)
    const guide = [toLatLon(0, 0), toLatLon(300, 0), toLatLon(400, 100), toLatLon(400, 300)];
    const before = R.fit(guide, 8),
      m = R.match(guide),
      after = R.fit(m, 8);
    expect(before.spacing).toBeGreaterThan(30);
    expect(before.offShare).toBeGreaterThan(0.03);
    expect(after.offShare).toBe(0);
    // through the corner at (400, 0), not across the block
    expect(m.some((p) => Math.hypot(toXY(...p)[0] - 400, toXY(...p)[1]) < 1)).toBe(true);
  });

  it('draws a hop straight when no street is near a stop', async () => {
    const { R } = await grid();
    const far = toLatLon(3000, 3000);
    const r = R.route([toLatLon(0, 5), far]);
    expect(r.routed).toBe(0);
    expect(r.shape.length).toBe(2);
  });
});

describe('PresidiGo from the Trust’s GTFS', () => {
  it('keeps the feed’s stops, shape, and trips, with the pass and pick-up rules', async () => {
    const { strToU8, zipSync } = await import('fflate');
    const { presidiGoFromGtfs } = await import('../server/beta3/pipeline/shuttles');
    const feed = {
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n1,1,1,1,1,1,0,0,20260627,20991231\n2,0,0,0,0,0,1,1,20260627,20991231\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n1,"Presidio Transit Center",37.801858,-122.455962\n2,"Van Ness & Union (Drop Off)",37.798609,-122.424085\n3,"Drumm & California (Embarcadero BART Pick Up)",37.793868,-122.396348\n',
      'routes.txt': 'route_id,route_short_name\n66,"Presidio GO Downtown"\n673,"South Hills"\n',
      'trips.txt': 'trip_id,route_id,service_id,shape_id\nAM,66,1,9\nPM,66,1,9\nMID,66,1,9\nSAT,66,2,9\nHILLS,673,1,8\n',
      'stop_times.txt':
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n' +
        ['AM,07:00', 'PM,16:00', 'MID,12:00', 'SAT,12:00', 'HILLS,07:00'].map((x) => { const [t, h] = x.split(','); const m = (a: number) => `${String(Number(h.slice(0, 2)) + Math.floor((Number(h.slice(3)) + a) / 60)).padStart(2, '0')}:${String((Number(h.slice(3)) + a) % 60).padStart(2, '0')}:00`; return `${t},${m(0)},${m(0)},1,0,0,\n${t},${m(10)},${m(10)},2,1,1,\n${t},${m(32)},${m(32)},3,2,0,\n${t},${m(55)},${m(55)},1,3,0,\n`; }).join(''),
      'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n9,37.80,-122.45,1\n9,37.79,-122.40,0\n',
    };
    const zip = zipSync(Object.fromEntries(Object.entries(feed).map(([k, v]) => [k, strToU8(v)])));
    const pg = presidiGoFromGtfs(zip, { routeId: '66', stopKeys: { '1': 'PTC', '2': 'VNU', '3': 'DRUMM' }, pickUpOnly: ['DRUMM'], passBefore: 9.5, passDowntown: [16.5, 17], downtownStop: 'DRUMM' });
    // the other route is left out; the weekday trips and the weekend one are kept
    expect(pg.trips.map((t) => [t.trip, t.route, t.service])).toEqual([
      ['pg-AM', 'pg-DTP', 'WKD'], // leaves before 9:30am
      ['pg-PM', 'pg-DTP', 'WKD'], // leaves downtown at 4:32pm
      ['pg-MID', 'pg-DT', 'WKD'],
      ['pg-SAT', 'pg-DT', 'WE'], // no pass rule on weekends
    ]);
    const am = pg.trips[0].calls;
    expect(am.map((c) => c.stop)).toEqual(['pg:PTC', 'pg:VNU', 'pg:DRUMM', 'pg:PTC']);
    expect(am[1].noOn).toBe(true); // set-down only (the feed's pickup_type)
    expect(am[2].noOff).toBe(true); // pick-up only (the Trust's rule)
    expect(am[2].t - am[0].t).toBe(32 * 60);
    expect(pg.stops.get('pg:VNU')).toEqual({ id: 'pg:VNU', name: 'PresidiGo Van Ness & Union', lat: 37.798609, lon: -122.424085 });
    expect(pg.stops.get('pg:DRUMM')!.name).toBe('PresidiGo Drumm & California (Embarcadero BART)');
    // the shape, in sequence order
    expect(pg.shapes.get('pg-9')!.map(([la]) => la)).toEqual([37.79, 37.8]);
    expect(pg.trips.every((t) => t.shape === 'pg-9')).toBe(true);
  });
});
