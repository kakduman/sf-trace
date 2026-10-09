/**
 * The regional leg of an outside zone's drive into the city (skims.ts): from the zone to the far
 * side of a gateway, 1.3 times the straight line (REGIONAL.circuity in skims.ts).
 *
 * Where the freeways' speeds are published, the leg runs at them:
 *  - Down the Peninsula, to US-101's and I-280's gateways from zones west of the Bay: INRIX's
 *    peak-period speeds on C/CAG's monitored segments in San Mateo County, by route and direction,
 *    weighted by length (reference/peninsula-traffic.json, peninsula-data.ts).
 *  - From the East Bay and the counties beyond it, to the Bay Bridge: INRIX's peak-period speeds on
 *    Alameda CTC's monitored segments along the zone's corridor (I-80, SR-24, I-580, or I-880), with
 *    the bridge's approach, toll plaza, and span to the county line (reference/eastbay-traffic.json).
 * Off the peaks they run at a free-flow 65 mph (C/CAG's). From the East Bay, every leg first (or,
 * into the city, last) drives the bridge's approach at its own speed, then its corridor's observed
 * speed for as many miles as the corridor was monitored, and the assumed regional speed beyond them
 * (Contra Costa, Solano, the Central Valley, which publish no segment speeds). Down the Peninsula,
 * San Mateo's speeds are carried on through Santa Clara County, which publishes none either. The first 3 km of road are local streets
 * at 30 km/h, as a drive to a station's lot (skims.ts driveAccessSec). INRIX's speeds include the
 * queues at the county line and at the Bay Bridge's toll plaza and metering lights, so these legs
 * add no queue of their own.
 *
 * Everything else (the Golden Gate, and legs that would cross the Bay to reach a gateway) keeps the
 * assumed regional speed by period and the gateway's assumed queue: Marin's latest published
 * freeway speeds are from September 2020, in the pandemic.
 */
export type SkimPeriod = 'AM' | 'MD' | 'PM' | 'EV';
/** observed peak speeds (mph) by corridor, into the city and out of it, and the free-flow speed off the peaks */
export interface ObservedSpeeds {
  routes: Record<string, Record<'in' | 'out', Record<'AM' | 'PM', number>>>;
  /** miles of each corridor the speeds were observed on, into the city and out of it */
  miles: Record<string, Record<'in' | 'out', number>>;
  /** a stretch every leg drives next to the gateway (the Bay Bridge's approach and toll plaza): miles, and peak speeds */
  last?: Record<'in' | 'out', { miles: number; mph: Record<'AM' | 'PM', number> }>;
  /** carry the corridor's speed past its observed miles (else the assumed regional speed beyond them) */
  extend?: boolean;
  freeFlowMph: number;
}
const MPH = 1.609344;
/** local streets at the start of an observed leg: metres and km/h */
export const LOCAL_LEG = { metres: 3000, kmh: 30 };

/**
 * Seconds for a regional leg of `roadM` metres of road along a corridor with observed speeds
 * (`route`, a key of `obs.routes`), into the city or out of it; without one, at the assumed speed.
 * Used by the fixed skims (skims.ts) and by the road assignment's outside-zone connectors (roads.ts),
 * so the assignment routes outside traffic as demand times it.
 */
export function regionalLegSec(roadM: number, route: string | undefined, p: SkimPeriod, dir: 'in' | 'out', assumedKmh: Record<SkimPeriod, number>, obs: ObservedSpeeds | null, withLocal = true): number {
  const speeds = route ? obs?.routes[route] : undefined;
  if (!speeds) return (roadM / 1000 / assumedKmh[p]) * 3600;
  const peak = p === 'AM' || p === 'PM';
  const fwyKmh = (peak ? speeds[dir][p] : obs!.freeFlowMph) * MPH;
  // (withLocal false: the caller has measured the local streets itself, as roads.ts does)
  const local = withLocal ? Math.min(roadM, LOCAL_LEG.metres) : 0;
  // next to the gateway, the stretch every leg drives (the Bay Bridge's approach), at its own speed
  const L = obs!.last?.[dir];
  const last = L ? Math.min(roadM - local, L.miles * MPH * 1000) : 0;
  const lastKmh = L ? (peak ? L.mph[p as 'AM' | 'PM'] : obs!.freeFlowMph) * MPH : 1;
  const rest = roadM - local - last;
  const seen = obs!.extend ? rest : Math.min(rest, obs!.miles[route!][dir] * MPH * 1000);
  const beyond = rest - seen;
  return (local / 1000 / LOCAL_LEG.kmh) * 3600 + (last / 1000 / lastKmh) * 3600 + (seen / 1000 / fwyKmh) * 3600 + (beyond / 1000 / assumedKmh[p]) * 3600;
}

/** the Peninsula's speeds (peninsula-traffic.json corridorMph: N into the city, S out of it) as observed corridors */
export function peninsulaCorridors(j: { corridorMph?: Record<string, Record<'N' | 'S', Record<'AM' | 'PM', number>>>; corridorMiles?: Record<string, Record<'N' | 'S', number>>; freeFlowMph?: number }): ObservedSpeeds | null {
  if (!j.corridorMph || !j.corridorMiles || !j.freeFlowMph) return null;
  return {
    routes: Object.fromEntries(Object.entries(j.corridorMph).map(([r, v]) => [r, { in: v.N, out: v.S }])),
    miles: Object.fromEntries(Object.entries(j.corridorMiles).map(([r, v]) => [r, { in: v.N, out: v.S }])),
    // Santa Clara County publishes no average segment speeds: San Mateo's are carried on to San Jose
    extend: true,
    freeFlowMph: j.freeFlowMph,
  };
}

interface EastBaySegment {
  id: string;
  miles: number;
  mph: number;
}
/** the East Bay's corridors to the Bay Bridge (eastbay-traffic.json): each one's segments in each direction, length-weighted (harmonic mean) */
export function eastBayCorridors(j: { corridors?: Record<string, Record<'in' | 'out', string[]>>; bridge?: Record<'in' | 'out', string[]>; segments?: Record<'AM' | 'PM', EastBaySegment[]>; freeFlowMph?: number }): ObservedSpeeds | null {
  if (!j.corridors || !j.segments || !j.freeFlowMph) return null;
  const hm = (ids: string[], p: 'AM' | 'PM') => {
    const segs = ids.map((id) => j.segments![p].find((s) => s.id === id)).filter((s): s is EastBaySegment => !!s && s.mph > 0);
    const mi = segs.reduce((a, s) => a + s.miles, 0);
    return { mi, mph: mi / segs.reduce((a, s) => a + s.miles / s.mph, 0) };
  };
  const routes: ObservedSpeeds['routes'] = {},
    miles: ObservedSpeeds['miles'] = {};
  for (const [r, c] of Object.entries(j.corridors)) {
    routes[r] = { in: { AM: 0, PM: 0 }, out: { AM: 0, PM: 0 } };
    miles[r] = { in: 0, out: 0 };
    for (const dir of ['in', 'out'] as const)
      for (const p of ['AM', 'PM'] as const) {
        const { mi, mph } = hm(c[dir], p);
        routes[r][dir][p] = +mph.toFixed(2);
        if (p === 'AM') miles[r][dir] = +mi.toFixed(2);
      }
  }
  const last = j.bridge
    ? (Object.fromEntries((['in', 'out'] as const).map((dir) => [dir, { miles: +hm(j.bridge![dir], 'AM').mi.toFixed(2), mph: { AM: +hm(j.bridge![dir], 'AM').mph.toFixed(2), PM: +hm(j.bridge![dir], 'PM').mph.toFixed(2) } }])) as ObservedSpeeds['last'])
    : undefined;
  return { routes, miles, ...(last ? { last } : {}), freeFlowMph: j.freeFlowMph };
}

/** the in-commuters' main origins, by where a zone lies (rough county lines, the Bay's shore between them) */
export function regionOf(lat: number, lon: number): 'Marin and Sonoma' | 'Napa, Solano, and beyond' | 'East Bay' | 'South Bay' | 'Peninsula' {
  if (lat > 37.83) return lon < -122.43 ? 'Marin and Sonoma' : lat > 38.05 ? 'Napa, Solano, and beyond' : 'East Bay';
  if (lat >= 37.6 ? lon > -122.33 : lon > -122.12 && lat > 37.47) return 'East Bay';
  if (lat < 37.47) return 'South Bay';
  return 'Peninsula';
}
/** a zone west of the Bay and south of the city (San Mateo and Santa Clara counties, and beyond to the south) */
export const peninsulaSide = (lat: number, lon: number) => {
  const r = regionOf(lat, lon);
  return r === 'Peninsula' || r === 'South Bay';
};
/**
 * The corridor a zone east of the Bay (or beyond it to the north and east) takes to the Bay Bridge:
 * I-80 from the north (Berkeley, Richmond, Solano, Sacramento), SR-24 from central and eastern
 * Contra Costa, I-880 along the Bay from the south (Alameda, San Leandro, Hayward, Fremont), and
 * I-580 otherwise (Oakland, the Tri-Valley, the Central Valley). Null west of the Bay and in Marin.
 */
export function eastBayCorridor(lat: number, lon: number): 'I-80' | 'SR-24' | 'I-880' | 'I-580' | null {
  const r = regionOf(lat, lon);
  if (r !== 'East Bay' && r !== 'Napa, Solano, and beyond') return null;
  if (lat > 38.0 || (lat >= 37.83 && lon < -122.25)) return 'I-80';
  if (lat >= 37.8 && lon > -122.2) return 'SR-24';
  if ((lat < 37.78 && lon < -122.08) || lat < 37.62) return 'I-880';
  return 'I-580';
}

/**
 * The Bay's crossings other than the Bay Bridge (east end, west end): a drive from the East Bay or
 * beyond to US-101's, I-280's, or the Golden Gate's gateway crosses one of them, so its road is
 * measured through it rather than in a straight line across the water.
 */
export const BAY_CROSSINGS: { name: string; east: [number, number]; west: [number, number] }[] = [
  { name: 'San Mateo–Hayward Bridge', east: [37.6213, -122.1418], west: [37.5826, -122.2603] },
  { name: 'Dumbarton Bridge', east: [37.5048, -122.0812], west: [37.4863, -122.1599] },
  { name: 'Richmond–San Rafael Bridge', east: [37.9321, -122.4006], west: [37.9449, -122.4876] },
  { name: 'SR-37 (Vallejo to Novato)', east: [38.1207, -122.2526], west: [38.1009, -122.5466] },
];
/**
 * Metres of road from a zone east of the Bay to a gateway's far side (`out`) through the best of the
 * Bay's crossings: each stretch `circuity` times its straight line.
 */
export function viaCrossingM(zone: [number, number], out: [number, number], toXY: (lat: number, lon: number) => [number, number] | number[], circuity: number): number {
  const d = (a: [number, number], b: [number, number]) => {
    const [ax, ay] = toXY(a[0], a[1]),
      [bx, by] = toXY(b[0], b[1]);
    return Math.hypot(ax - bx, ay - by);
  };
  return Math.min(...BAY_CROSSINGS.map((c) => circuity * (d(zone, c.east) + d(c.east, c.west) + d(c.west, out))));
}
