/**
 * Scenarios: helpers to add and describe edits, example scenarios, sharing through the URL hash,
 * and the geometry of a hand-drawn new line (stops, path, hop times). Bus lines follow streets
 * with the street router; rail and ferry lines are straight between stops.
 */
import portalScenario from './model/portal-scenario.json';
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { routeAlongStreets, loadStreets, type StreetGraph } from '../../shared/beta3/streets';
import type { DayType, DemandContext, Edit, Scenario, TPeriod, TransitMode } from '../../shared/beta3/types';
import { cleanContext, type ConditionKey } from '../../shared/beta3/context';
import { DAY_TYPES, TPERIODS } from '../../shared/beta3/types';
import { RUN_MODE_LIST, type RunMode } from '../../shared/beta3/runmode';
import type { AddStopEdit, Model, NewLineEdit, RouteInfo } from './derive';
import { OPERATOR_LABEL, routeTitle } from './derive';
import { int, pct } from './format';
import streetsUrl from './model/streets.bin.gz?url';

// ---------- new line profiles ----------

export type Profile = 'bus' | 'rapid' | 'lightrail' | 'subway' | 'bart' | 'ferry';
export interface ProfileInfo {
  label: string;
  short: string;
  mode: TransitMode;
  /** average speed including stops, km/h */
  kmh: number;
  /** straight-line distance × circuity when not following streets */
  circuity: number;
  streets: boolean;
  color: string;
  headway: Record<TPeriod, number>;
  note: string;
}
export const PROFILES: Record<Profile, ProfileInfo> = {
  bus: { label: 'Local bus', short: 'Bus', mode: 'bus', kmh: 12, circuity: 1.3, streets: true, color: '#2a78d6', headway: { AM: 10, MD: 12, PM: 10, NT: 20 }, note: 'Follows streets. 12 km/h with stops, 63 riders per bus.' },
  rapid: { label: 'Rapid bus', short: 'Rapid', mode: 'rapid', kmh: 16, circuity: 1.3, streets: true, color: '#1baf7a', headway: { AM: 6, MD: 8, PM: 6, NT: 15 }, note: 'Follows streets. 16 km/h with stops, 94 riders per articulated bus.' },
  lightrail: { label: 'Light rail (surface)', short: 'Light rail', mode: 'lightrail', kmh: 20, circuity: 1.15, streets: false, color: '#eb6834', headway: { AM: 6, MD: 8, PM: 6, NT: 15 }, note: 'Straight between stops. 20 km/h with stops, 238 riders per two-car train.' },
  subway: { label: 'Subway (light rail)', short: 'Subway', mode: 'lightrail', kmh: 32, circuity: 1.15, streets: false, color: '#c2410c', headway: { AM: 4, MD: 6, PM: 4, NT: 10 }, note: 'Straight between stops, grade-separated. 32 km/h with stops, 238 riders per train.' },
  bart: { label: 'BART-like metro', short: 'Metro', mode: 'bart', kmh: 45, circuity: 1.15, streets: false, color: '#4a3aa7', headway: { AM: 5, MD: 10, PM: 5, NT: 15 }, note: 'Straight between stops. 45 km/h with stops, 1,110 riders per 10-car train.' },
  ferry: { label: 'Ferry', short: 'Ferry', mode: 'ferry', kmh: 30, circuity: 1.1, streets: false, color: '#e87ba4', headway: { AM: 20, MD: 30, PM: 20, NT: 60 }, note: 'Straight between stops. 30 km/h, 350 riders per boat.' },
};
export const PROFILE_ORDER: Profile[] = ['bus', 'rapid', 'lightrail', 'subway', 'bart', 'ferry'];

/** the profile is kept in the edit id ("subway-x1y2"), since subway and surface share a mode */
export function profileOf(e: NewLineEdit): Profile {
  const p = e.id.split('-')[0] as Profile;
  if (p in PROFILES) return p;
  return (PROFILE_ORDER.find((k) => PROFILES[k].mode === e.mode) ?? 'bus') as Profile;
}

// ---------- drafts (a new line being drawn) ----------

export interface DraftStop {
  lat: number;
  lon: number;
  /** snapped to this existing stop */
  stop?: number;
  name: string;
}
export interface Leg {
  path: number[];
  meters: number;
  streets: boolean;
}
export interface Draft {
  /** index of the edit being changed, or null for a new line */
  editIndex: number | null;
  id: string;
  name: string;
  profile: Profile;
  color: string;
  stops: DraftStop[];
  /** legs[k] joins stops k and k+1 */
  legs: Leg[];
  headway: Record<TPeriod, number>;
  both: boolean;
}

let lineSeq = 0;
export function newDraft(profile: Profile = 'rapid', existing = 0): Draft {
  const P = PROFILES[profile];
  lineSeq++;
  return {
    editIndex: null,
    id: `${profile}-${Date.now().toString(36)}${lineSeq}`,
    name: `New ${P.short.toLowerCase()} line ${existing + 1}`,
    profile,
    color: P.color,
    stops: [],
    legs: [],
    headway: { ...P.headway },
    both: true,
  };
}

/** load an existing new-line edit back into a draft for editing */
export function draftFromEdit(m: Model, e: NewLineEdit, index: number): Draft {
  const H = m.bundle.header;
  const stops: DraftStop[] = e.stops.map((s) => ('stop' in s ? { lat: H.stops[s.stop].lat, lon: H.stops[s.stop].lon, stop: s.stop, name: H.stops[s.stop].name } : { lat: s.lat, lon: s.lon, name: s.name ?? 'New stop' }));
  const profile = profileOf(e);
  const P = PROFILES[profile];
  const legs: Leg[] = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const i0 = e.stopAt[k], i1 = e.stopAt[k + 1];
    const path = e.path.slice(2 * i0, 2 * i1 + 2);
    legs.push({ path, meters: (e.hops[k] * P.kmh) / 3.6, streets: P.streets && path.length > 4 });
  }
  return { editIndex: index, id: e.id, name: e.name, profile, color: e.color, stops, legs, headway: { ...e.headway }, both: e.bothDirections };
}

// street graph, loaded on first use by a bus profile
let streets: StreetGraph | null = null;
let streetsLoading: Promise<StreetGraph | null> | null = null;
export function streetGraph(): Promise<StreetGraph | null> {
  if (streets) return Promise.resolve(streets);
  streetsLoading ??= loadStreets(streetsUrl)
    .then((g) => (streets = g))
    .catch((err) => {
      console.warn('street network unavailable, drawing straight lines', err);
      return null;
    });
  return streetsLoading;
}
export const streetsReady = () => !!streets;

const M_LAT = 110_950, M_LON = 111_320 * Math.cos((37.78 * Math.PI) / 180);
export const meters = (aLat: number, aLon: number, bLat: number, bLon: number) => Math.hypot((bLat - aLat) * M_LAT, (bLon - aLon) * M_LON);

/** one leg: along streets for bus profiles (when the graph is loaded), else straight × circuity */
export function makeLeg(profile: Profile, a: DraftStop, b: DraftStop): Leg {
  const P = PROFILES[profile];
  if (P.streets && streets) {
    const r = routeAlongStreets(streets, a.lat, a.lon, b.lat, b.lon);
    const straight = meters(a.lat, a.lon, b.lat, b.lon);
    // reject absurd detours (e.g. across a one-way maze or a disconnected pier)
    if (r && r.meters < straight * 3 + 400) return { path: r.path, meters: r.meters, streets: true };
  }
  return { path: [a.lat, a.lon, b.lat, b.lon], meters: meters(a.lat, a.lon, b.lat, b.lon) * P.circuity, streets: false };
}

export function relegAll(d: Draft): void {
  d.legs = [];
  for (let k = 0; k + 1 < d.stops.length; k++) d.legs.push(makeLeg(d.profile, d.stops[k], d.stops[k + 1]));
}

/** a stop at a clicked point: snapped to an existing stop nearby, else a new named stop */
export function draftStopAt(m: Model, d: Draft, lat: number, lon: number): DraftStop {
  const H = m.bundle.header;
  const rail = d.profile === 'bart' || d.profile === 'subway' || d.profile === 'ferry';
  // rail and ferry snap further to stations and terminals
  const snap = (rail ? nearestStop(m, lat, lon, 150, (i) => H.stops[i].station || (d.profile === 'ferry' && H.stops[i].feed !== 'muni')) : null) ?? nearestStop(m, lat, lon, 60);
  if (snap && !d.stops.some((s) => s.stop === snap.i)) return { lat: H.stops[snap.i].lat, lon: H.stops[snap.i].lon, stop: snap.i, name: H.stops[snap.i].name };
  const near = nearestStop(m, lat, lon, 400);
  return { lat, lon, name: near ? `Near ${H.stops[near.i].name}` : `New stop ${d.stops.length + 1}` };
}

export function draftAddStop(m: Model, d: Draft, at: number, lat: number, lon: number): void {
  const s = draftStopAt(m, d, lat, lon);
  d.stops.splice(at, 0, s);
  // rebuild the legs touching the new stop
  const legs: Leg[] = [];
  for (let k = 0; k + 1 < d.stops.length; k++) {
    const old = k < at - 1 ? d.legs[k] : k > at ? d.legs[k - 1] : undefined;
    legs.push(old ?? makeLeg(d.profile, d.stops[k], d.stops[k + 1]));
  }
  d.legs = legs;
}

export function draftMoveStop(m: Model, d: Draft, i: number, lat: number, lon: number): void {
  const others = { ...d, stops: d.stops.filter((_, j) => j !== i) };
  d.stops[i] = draftStopAt(m, others, lat, lon);
  for (const k of [i - 1, i]) if (k >= 0 && k + 1 < d.stops.length) d.legs[k] = makeLeg(d.profile, d.stops[k], d.stops[k + 1]);
}

export function draftRemoveStop(d: Draft, i: number): void {
  d.stops.splice(i, 1);
  const legs: Leg[] = [];
  for (let k = 0; k + 1 < d.stops.length; k++) {
    const old = k < i - 1 ? d.legs[k] : k >= i ? d.legs[k + 1] : undefined;
    legs.push(old ?? makeLeg(d.profile, d.stops[k], d.stops[k + 1]));
  }
  d.legs = legs;
}

/** seconds per hop for a draft */
export function draftHops(d: Draft): number[] {
  const v = PROFILES[d.profile].kmh / 3.6;
  return d.legs.map((l) => Math.max(30, Math.round(l.meters / v)));
}

/** the edit a finished draft becomes */
export function draftToEdit(d: Draft): NewLineEdit {
  const path: number[] = [];
  const stopAt: number[] = [];
  d.legs.forEach((leg, k) => {
    if (k === 0) {
      stopAt.push(0);
      path.push(...leg.path.map(round5));
    } else path.push(...leg.path.slice(2).map(round5));
    stopAt.push(path.length / 2 - 1);
  });
  return {
    kind: 'newLine',
    id: d.id,
    name: d.name.trim() || 'New line',
    mode: PROFILES[d.profile].mode,
    color: d.color,
    stops: d.stops.map((s) => (s.stop !== undefined ? { stop: s.stop } : { lat: round5(s.lat), lon: round5(s.lon), name: s.name })),
    path,
    stopAt,
    headway: { ...d.headway },
    hops: draftHops(d),
    bothDirections: d.both,
  };
}
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** nearest existing stop within `maxM` meters (a simple grid over the bundle's stops) */
let stopGrid: Map<string, number[]> | null = null;
const CELL = 0.002;
export function nearestStop(m: Model, lat: number, lon: number, maxM = 60, filter?: (i: number) => boolean): { i: number; d: number } | null {
  const S = m.bundle.header.stops;
  if (!stopGrid) {
    stopGrid = new Map();
    S.forEach((s, i) => {
      const k = `${Math.floor(s.lat / CELL)},${Math.floor(s.lon / CELL)}`;
      if (!stopGrid!.has(k)) stopGrid!.set(k, []);
      stopGrid!.get(k)!.push(i);
    });
  }
  const r = Math.ceil(maxM / 170) + 1;
  const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
  let best: { i: number; d: number } | null = null;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      for (const i of stopGrid.get(`${cy + dy},${cx + dx}`) ?? []) {
        if (filter && !filter(i)) continue;
        const d = meters(lat, lon, S[i].lat, S[i].lon);
        if (d <= maxM && (!best || d < best.d)) best = { i, d };
      }
  return best;
}

// ---------- edits on route groups ----------

const memberOf = (r: RouteInfo, e: Edit) => 'route' in e && e.feed === r.feed && r.members.includes(e.route);

export function routeEdits(s: Scenario, r: RouteInfo) {
  const es = s.edits.filter((e) => memberOf(r, e));
  return {
    removed: es.some((e) => e.kind === 'remove'),
    /** stops taken out of the route */
    removedStops: new Set(es.filter((e) => e.kind === 'removeStop').map((e) => (e as Extract<Edit, { kind: 'removeStop' }>).stop)),
    /** stops added to the route */
    addedStops: es.filter((e): e is AddStopEdit => e.kind === 'addStop'),
    /** extensions beyond a terminus */
    extensions: es.filter((e): e is Extract<Edit, { kind: 'extend' }> => e.kind === 'extend'),
    frequency: (es.find((e) => e.kind === 'frequency') as Extract<Edit, { kind: 'frequency' }> | undefined)?.factor ?? null,
    speed: (es.find((e) => e.kind === 'speed') as Extract<Edit, { kind: 'speed' }> | undefined)?.factor ?? null,
  };
}

/** replace the route's edits of one kind (null removes them) */
export function withRouteEdit(s: Scenario, r: RouteInfo, kind: 'frequency' | 'speed' | 'remove', value: Partial<Record<TPeriod, number>> | number | boolean | null): Edit[] {
  const keep = s.edits.filter((e) => !(e.kind === kind && memberOf(r, e)));
  if (value === null || value === false) return keep;
  const add: Edit[] = r.members.map((route) => {
    if (kind === 'remove') return { kind, route, feed: r.feed };
    if (kind === 'speed') return { kind, route, feed: r.feed, factor: value as number };
    return { kind, route, feed: r.feed, factor: { ...(value as Partial<Record<TPeriod, number>>) } };
  });
  // a removed route needs no other edits
  if (kind === 'remove') return [...keep.filter((e) => !memberOf(r, e)), ...add];
  return [...keep, ...add];
}

/** take a stop out of the route (every member route whose patterns serve it), or put it back */
export function withStopRemoved(m: Model, s: Scenario, r: RouteInfo, stop: number, on: boolean): Edit[] {
  const keep = s.edits.filter((e) => !(e.kind === 'removeStop' && memberOf(r, e) && e.stop === stop));
  if (!on) return keep;
  const H = m.bundle.header;
  const members = [...new Set(r.patterns.filter((i) => H.lines[i].stops.includes(stop)).map((i) => H.lines[i].route))];
  return [...keep, ...members.map((route): Edit => ({ kind: 'removeStop', route, feed: r.feed, stop }))];
}

/** a stop is a terminus when some pattern of the route starts or ends there (the model never removes those) */
export function isTerminus(m: Model, r: RouteInfo, stop: number): boolean {
  const H = m.bundle.header;
  return r.patterns.some((i) => {
    const st = H.lines[i].stops;
    return st[0] === stop || st[st.length - 1] === stop;
  });
}

/** the nearest point on a polyline ([lon, lat]) to a point, with its distance in meters */
function nearestOnLine(coords: [number, number][], lat: number, lon: number): { lat: number; lon: number; d: number } {
  let best = { lat: coords[0][1], lon: coords[0][0], d: Infinity };
  for (let i = 0; i + 1 < coords.length; i++) {
    const [ax, ay] = [coords[i][0] * M_LON, coords[i][1] * M_LAT], [bx, by] = [coords[i + 1][0] * M_LON, coords[i + 1][1] * M_LAT];
    const px = lon * M_LON, py = lat * M_LAT;
    const L = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L)) : 0;
    const x = ax + t * (bx - ax), y = ay + t * (by - ay);
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { lat: y / M_LAT, lon: x / M_LON, d };
  }
  return best;
}

/**
 * New stops for a click near a route's line: one on the nearest hop, and one on the nearest hop
 * running the other way within 80 m (the other side of the street), so both directions stop there.
 */
export function addStopEdits(m: Model, r: RouteInfo, lat: number, lon: number, maxM = 80): AddStopEdit[] {
  const H = m.bundle.header;
  const best = new Map<number, { seg: (typeof m.segs)[number]; p: { lat: number; lon: number; d: number } }>();
  for (const seg of m.segs) {
    if (seg.route !== r.index) continue;
    const p = nearestOnLine(seg.coords, lat, lon);
    if (p.d > maxM) continue;
    const dir = H.lines[seg.parts[0].line].dir;
    const cur = best.get(dir);
    if (!cur || p.d < cur.p.d) best.set(dir, { seg, p });
  }
  const picks = [...best.values()].sort((a, b) => a.p.d - b.p.d);
  if (!picks.length) return [];
  // "Geary Blvd between Fillmore St and Scott St" from the stops either side
  const [sa, sb] = [H.stops[picks[0].seg.a].name, H.stops[picks[0].seg.b].name].map((n) => n.split(' & '));
  const street = sa.length === 2 && sb.length === 2 ? sa.find((x) => sb.includes(x)) : undefined;
  const name = street ? `${street} between ${sa.find((x) => x !== street) ?? sa[1]} and ${sb.find((x) => x !== street) ?? sb[1]}` : `Between ${sa.join(' & ')} and ${sb.join(' & ')}`;
  const base = `st${Date.now().toString(36)}`;
  return picks.map(({ seg, p }, k) => ({ kind: 'addStop', id: k ? `${base}~${k}` : base, route: H.lines[seg.parts[0].line].route, feed: r.feed, between: [seg.a, seg.b], lat: round5(p.lat), lon: round5(p.lon), name }));
}
/** added stops placed together (both directions) share the id before "~" */
export const addGroupId = (e: AddStopEdit) => e.id.split('~')[0];

export function withFare(s: Scenario, feed: string, factor: number): Edit[] {
  const keep = s.edits.filter((e) => !(e.kind === 'fare' && e.feed === feed));
  return Math.abs(factor - 1) < 1e-6 ? keep : [...keep, { kind: 'fare', feed, factor }];
}

/** the scenario with one condition set (a value at today's clears it); see shared/beta3/context.ts */
export function withCondition(s: Scenario, key: ConditionKey, value: number): DemandContext | undefined {
  return cleanContext({ ...(s.context ?? {}), [key]: value }) ?? undefined;
}
/** anything to run: edits or conditions other than today's */
export const hasChanges = (s: Scenario) => s.edits.length > 0 || !!cleanContext(s.context);
/** the scenario's shared bikes and scooters: one 'micromobility' edit, dropped when it is back to today */
export type MicroKey = 'docks' | 'fleet' | 'bikePrice' | 'scooterPrice';
export const MICRO_LABEL: Record<MicroKey, string> = { docks: 'Bay Wheels stations', fleet: 'Scooters', bikePrice: 'Bay Wheels prices', scooterPrice: 'Scooter prices' };
export const microFactor = (s: Scenario, k: MicroKey) => s.edits.reduce((f, e) => (e.kind === 'micromobility' ? f * (e[k] ?? 1) : f), 1);
export function withMicro(s: Scenario, k: MicroKey, factor: number): Edit[] {
  const cur = Object.fromEntries((Object.keys(MICRO_LABEL) as MicroKey[]).map((x) => [x, microFactor(s, x)])) as Record<MicroKey, number>;
  cur[k] = factor;
  const keep = s.edits.filter((e) => e.kind !== 'micromobility');
  const set = Object.fromEntries(Object.entries(cur).filter(([, v]) => Math.abs(v - 1) > 1e-6));
  return Object.keys(set).length ? [...keep, { kind: 'micromobility', ...set }] : keep;
}

export const fareFactor = (s: Scenario, feed: string) => s.edits.reduce((f, e) => (e.kind === 'fare' && e.feed === feed ? f * e.factor : f), 1);

/** Edits grouped for display: a BART line's two directions are one row. */
export interface EditGroup {
  key: string;
  indices: number[];
  title: string;
  detail: string;
  kind: Edit['kind'];
  route?: RouteInfo;
}
export function editGroups(m: Model, s: Scenario): EditGroup[] {
  const H = () => m.bundle.header;
  const out: EditGroup[] = [];
  const byKey = new Map<string, EditGroup>();
  s.edits.forEach((e, i) => {
    let key: string, title: string, detail: string, route: RouteInfo | undefined;
    if (e.kind === 'micromobility') {
      key = 'micromobility';
      title = 'Bike share and scooters';
      detail = (Object.keys(MICRO_LABEL) as MicroKey[])
        .filter((k) => e[k] !== undefined && Math.abs(e[k]! - 1) > 1e-6)
        .map((k) => `${MICRO_LABEL[k]} ${e[k] === 0 ? 'none' : `×${e[k]!.toFixed(2)}`}`)
        .join(', ');
    } else if (e.kind === 'fare') {
      key = `fare:${e.feed}`;
      title = `${OPERATOR_LABEL[e.feed] ?? e.feed} fares`;
      detail = e.factor === 0 ? 'Free' : `${e.factor > 1 ? '+' : '−'}${pct(Math.abs(e.factor - 1), 0)} (×${e.factor.toFixed(2)})`;
    } else if (e.kind === 'addStop') {
      key = `add:${addGroupId(e)}`;
      route = m.routes.find((r) => r.feed === e.feed && r.members.includes(e.route));
      title = e.name ?? 'New stop';
      detail = `Added to ${route ? routeTitle(route) : e.route}, between ${H().stops[e.between[0]]?.name ?? '?'} and ${H().stops[e.between[1]]?.name ?? '?'}`;
    } else if (e.kind === 'removeStop') {
      route = m.routes.find((r) => r.feed === e.feed && r.members.includes(e.route));
      key = `rmstop:${route?.key ?? e.feed + e.route}`;
      title = route ? routeTitle(route) : e.route;
      detail = `1 stop removed: ${H().stops[e.stop]?.name ?? `stop ${e.stop}`}`;
    } else if (e.kind === 'extend') {
      route = m.routes.find((r) => r.feed === e.feed && r.members.includes(e.route));
      // one extension run by several routes (Caltrain's Local, Limited, Express) is one row
      const last = e.stops[e.stops.length - 1];
      key = `ext:${e.from}:${e.stops.length}:${'stop' in last ? last.stop : `${last.lat},${last.lon}`}`;
      const lastName = 'stop' in last ? H().stops[last.stop]?.name : last.name;
      title = `Extension to ${lastName ?? 'a new terminus'}`;
      const min = Math.round(e.hops.reduce((a, b) => a + b, 0) / 60);
      detail = `${route ? routeTitle(route) : e.route}: ${e.stops.length} stop${e.stops.length > 1 ? 's' : ''} beyond ${H().stops[e.from]?.name ?? 'the terminus'}, ${min} min`;
    } else if (e.kind === 'newLine') {
      key = `new:${e.id}`;
      const P = PROFILES[profileOf(e)];
      const km = e.hops.reduce((a, h) => a + (h * P.kmh) / 3.6, 0) / 1000;
      title = e.name;
      detail = `New ${P.label.toLowerCase()} · ${e.stops.length} stops · ${km.toFixed(1)} km · every ${e.headway.AM || '–'} min at peak`;
    } else if (e.kind === 'road') {
      key = `road:${e.id}`;
      title = e.name;
      const when = e.periods?.length ? ` (${e.periods.join(', ')})` : '';
      detail = e.closed ? `${e.street} closed to cars${when}` : `${e.street}: ${e.lanes && e.lanes > 0 ? '+' : '−'}${Math.abs(e.lanes ?? 0)} lane${Math.abs(e.lanes ?? 0) === 1 ? '' : 's'} each way for cars${e.busLane ? ', given to buses' : ''}${when}`;
    } else if (e.kind === 'parking') {
      key = `parking:${e.id}`;
      title = e.name;
      detail = `Parking ${e.perHour >= 0 ? '+' : '−'}$${Math.abs(e.perHour).toFixed(2).replace(/\.00$/, '')} an hour in the area`;
    } else if (e.kind === 'cordon') {
      key = `cordon:${e.id}`;
      title = e.name;
      const tolls = TPERIODS.filter((p) => e.toll[p]).map((p) => `${p} $${e.toll[p]!.toFixed(2).replace(/\.00$/, '')}`);
      detail = `Charge per car entering${e.outbound ? ' or leaving' : ''}: ${tolls.join(', ') || 'none'}`;
    } else {
      route = m.routes.find((r) => r.feed === e.feed && r.members.includes(e.route));
      key = `${e.kind}:${route?.key ?? e.feed + e.route}`;
      const name = route ? routeTitle(route) : e.route;
      title = name;
      if (e.kind === 'remove') detail = 'Removed';
      else if (e.kind !== 'speed' && e.kind !== 'frequency') detail = '';
      else if (e.kind === 'speed') detail = `Transit priority: running time ×${e.factor.toFixed(2)} (${int((1 / e.factor - 1) * 100)}% faster)`;
      else {
        const f = TPERIODS.map((p) => e.factor[p] ?? 1);
        detail = f.every((x) => x === f[0]) ? `Frequency ×${fmtF(f[0])} all day` : `Frequency ${TPERIODS.map((p, j) => `${p} ×${fmtF(f[j])}`).join(', ')}`;
      }
    }
    const g = byKey.get(key);
    if (g) {
      g.indices.push(i);
      // a route's removed stops are one row; the same stop on two member routes counts once
      if (e.kind === 'removeStop') {
        const names = new Set(g.indices.map((j) => H().stops[(s.edits[j] as Extract<Edit, { kind: 'removeStop' }>).stop]?.name));
        g.detail = `${names.size} stop${names.size > 1 ? 's' : ''} removed: ${[...names].slice(0, 4).join('; ')}${names.size > 4 ? '; …' : ''}`;
      }
      if (e.kind === 'extend') {
        const routes = [...new Set(g.indices.map((j) => {
          const x = s.edits[j] as Extract<Edit, { kind: 'extend' }>;
          const r = m.routes.find((rr) => rr.feed === x.feed && rr.members.includes(x.route));
          return r ? routeTitle(r) : x.route;
        }))];
        g.detail = g.detail.replace(/^[^:]+:/, `${listText(routes)}:`);
        g.route = undefined;
      }
    } else {
      const ng: EditGroup = { key, indices: [i], title, detail, kind: e.kind, route };
      byKey.set(key, ng);
      out.push(ng);
    }
  });
  return out;
}
/** "a", "a and b", "a, b, and c" */
export const listText = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`);
const fmtF = (f: number) => (Number.isInteger(f) ? String(f) : f.toFixed(2).replace(/0$/, ''));

// ---------- examples ----------

/**
 * The zone of SFCTA's Downtown Congestion Pricing Study (2021): Van Ness Avenue, Fulton and Laguna
 * streets, 14th, Division, Townsend and 7th streets and Mariposa Street, and the waterfront.
 * Drawn approximately from those streets: [lat, lon].
 */
export const DOWNTOWN_RING: [number, number][] = [
  [37.8058, -122.4239],
  [37.8091, -122.4152],
  [37.8088, -122.4098],
  [37.806, -122.404],
  [37.7956, -122.3918],
  [37.787, -122.387],
  [37.778, -122.3858],
  [37.764, -122.3855],
  [37.7638, -122.3958],
  [37.7718, -122.4021],
  [37.7699, -122.4046],
  [37.7695, -122.4198],
  [37.7681, -122.4199],
  [37.7678, -122.4288],
  [37.7718, -122.4248],
  [37.7784, -122.4262],
  [37.7791, -122.4196],
  [37.8058, -122.4239],
];

export interface Example {
  id: string;
  title: string;
  blurb: string;
  scenario: () => Scenario;
}

export function examples(m: Model): Example[] {
  const H = m.bundle.header;
  return [
    {
      id: '38r',
      title: 'Double the 38R Geary Rapid',
      blurb: 'Twice as many buses on the busiest bus corridor, all day.',
      scenario: () => ({ name: 'Double the 38R', edits: [{ kind: 'frequency', route: '38R', feed: 'muni', factor: { AM: 2, MD: 2, PM: 2, NT: 2 } }] }),
    },
    {
      id: 'mission',
      title: 'Transit lanes on Mission Street',
      blurb: 'Red lanes and signal priority make the 14, 14R, and 49 25% faster.',
      scenario: () => ({ name: 'Mission Street transit lanes', edits: ['14', '14R', '49'].map((route) => ({ kind: 'speed' as const, route, feed: 'muni', factor: 0.8 })) }),
    },
    {
      id: 'no1',
      title: 'Remove the 1 California',
      blurb: 'Where riders go when a major trolleybus line is cut.',
      scenario: () => ({ name: 'Remove the 1 California', edits: [{ kind: 'remove', route: '1', feed: 'muni' }] }),
    },
    {
      id: 'stops38',
      title: 'Stop consolidation on the 38',
      blurb: 'Every other local stop on Geary from Presidio to 33rd Avenue is removed. 38R stops stay.',
      scenario: () => {
        const r38 = m.routeByKey.get('muni:38');
        const r38r = m.routeByKey.get('muni:38R');
        const rapid = new Set(r38r ? r38r.patterns.flatMap((i) => H.lines[i].stops) : []);
        const edits: Edit[] = [];
        const seen = new Set<number>();
        for (const li of r38?.main ?? []) {
          const st = H.lines[li].stops;
          const a = st.findIndex((x) => /masonic|presidio av/i.test(H.stops[x].name)), b = st.findIndex((x) => /33rd av/i.test(H.stops[x].name));
          if (a < 0 || b < 0) continue;
          let k = 0;
          for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) {
            const x = st[i];
            if (rapid.has(x)) {
              k = 0;
              continue;
            }
            if (k++ % 2 === 0 && !seen.has(x)) seen.add(x), edits.push({ kind: 'removeStop', route: '38', feed: 'muni', stop: x });
          }
        }
        return { name: 'Stop consolidation on the 38', edits };
      },
    },
    {
      id: 'portal',
      title: 'The Portal (Caltrain to Salesforce Transit Center)',
      blurb: 'Caltrain extends 1.3 miles underground from 4th & King to the Salesforce Transit Center.',
      // the same edits the published case study runs (server/beta3/pipeline/portal.ts): station
      // positions from OSM, all Caltrain trains extended, surface 4th & King no longer served by them
      scenario: () => ({ name: portalScenario.name, edits: portalScenario.edits as Edit[] }),
    },
    {
      id: 'cordon',
      title: 'A downtown congestion charge',
      blurb: 'Cars pay $8 to enter Downtown and SoMa, 6–10am and 3–7pm.',
      scenario: () => ({ name: 'Downtown congestion charge', edits: [{ kind: 'cordon', id: 'downtown', name: 'Downtown congestion charge', ring: DOWNTOWN_RING, toll: { AM: 8, PM: 8 } }] }),
    },
    {
      id: 'parking',
      title: 'Dearer parking downtown',
      blurb: 'Parking in Downtown and SoMa costs $4 an hour more, all day.',
      scenario: () => ({ name: 'Dearer parking downtown', edits: [{ kind: 'parking', id: 'downtown-parking', name: 'Downtown parking +$4/h', ring: DOWNTOWN_RING, perHour: 4 }] }),
    },
    {
      id: '19th',
      title: 'A road diet on 19th Avenue',
      blurb: 'One less car lane each way on 19th Avenue, Lincoln Way to Sloat.',
      scenario: () => ({
        name: '19th Avenue road diet',
       
        edits: [{ kind: 'road', id: '19th', name: '19th Avenue road diet', street: '19th Avenue', from: { lat: 37.7656, lon: -122.4772 }, to: { lat: 37.7347, lon: -122.4751 }, lanes: -1 }],
      }),
    },
    {
      id: '19thbus',
      title: 'Bus lanes on 19th Avenue',
      blurb: 'One lane each way on 19th Avenue, Lincoln Way to Sloat, becomes a bus lane for the 28 and 28R.',
      scenario: () => ({
        name: '19th Avenue bus lanes',
       
        edits: [{ kind: 'road', id: '19thbus', name: '19th Avenue bus lanes', street: '19th Avenue', from: { lat: 37.7656, lon: -122.4772 }, to: { lat: 37.7347, lon: -122.4751 }, lanes: -1, busLane: true }],
      }),
    },
    {
      id: 'free',
      title: 'Fare-free Muni',
      blurb: 'No Muni fares. Other operators unchanged.',
      scenario: () => ({ name: 'Fare-free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] }),
    },
    {
      id: 'geary',
      title: 'A Geary subway',
      blurb: 'Light rail underground from the Salesforce Transit Center to Ocean Beach, 11 stations, every 4 minutes at peak.',
      scenario: () => {
        const want = ['Transit Center', 'Market St & Montgomery', 'Geary St & Powell', 'Van Ness', 'Fillmore', 'Divisadero', 'Arguello', 'Park Presidio', '25th Ave', '33rd Ave', '48th Ave'];
        const r38 = m.routeByKey.get('muni:38R');
        const pat = r38 ? H.lines[r38.main[0]] : null;
        const stops: DraftStop[] = [];
        if (pat)
          for (const w of want) {
            const i = pat.stops.find((s) => H.stops[s].name.includes(w));
            if (i !== undefined && !stops.some((s) => s.stop === i)) stops.push({ lat: H.stops[i].lat, lon: H.stops[i].lon, stop: i, name: H.stops[i].name });
          }
        const d = newDraft('subway');
        d.id = 'subway-geary';
        d.name = 'Geary subway';
        d.stops = stops;
        relegAll(d);
        return { name: 'A Geary subway', edits: [draftToEdit(d)] };
      },
    },
  ];
}

// ---------- sharing via the URL hash ----------

const b64url = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};

export function encodeScenario(s: Scenario): string {
  const day = s.day && s.day !== 'wkd' ? { day: s.day } : {};
  const context = cleanContext(s.context);
  const traffic = s.traffic ? { traffic: true } : {};
  // the run mode the link was made with (runmode.ts)
  const mode = s.runMode ? { mode: s.runMode } : {};
  return b64url(deflateSync(strToU8(JSON.stringify({ v: 1, name: s.name, edits: s.edits, ...day, ...(context ? { context } : {}), ...traffic, ...mode })), { level: 9 }));
}

/** decode a shared scenario, dropping anything malformed */
export function decodeScenario(m: Model, code: string): Scenario | null {
  try {
    const o = JSON.parse(strFromU8(inflateSync(unb64url(code)))) as { name?: unknown; edits?: unknown; day?: unknown; context?: unknown; longRun?: unknown; traffic?: unknown; mode?: unknown };
    if (!Array.isArray(o.edits)) return null;
    const S = m.bundle.header.stops.length;
    const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
    const edits = (o.edits as Edit[]).filter((e) => {
      if (!e || typeof e !== 'object') return false;
      switch (e.kind) {
        case 'frequency':
          return typeof e.route === 'string' && typeof e.feed === 'string' && e.factor && typeof e.factor === 'object';
        case 'remove':
          return typeof e.route === 'string' && typeof e.feed === 'string';
        case 'speed':
          return typeof e.route === 'string' && num(e.factor) && e.factor > 0.2 && e.factor <= 2;
        case 'fare':
          return typeof e.feed === 'string' && num(e.factor) && e.factor >= 0;
        case 'micromobility':
          return (['docks', 'fleet', 'bikePrice', 'scooterPrice'] as const).every((k) => e[k] === undefined || (num(e[k]) && e[k]! >= 0 && e[k]! <= 5));
        case 'removeStop':
          return typeof e.route === 'string' && typeof e.feed === 'string' && num(e.stop) && e.stop >= 0 && e.stop < S;
        case 'extend':
          return (
            typeof e.id === 'string' &&
            typeof e.route === 'string' &&
            typeof e.feed === 'string' &&
            num(e.from) &&
            e.from >= 0 &&
            e.from < S &&
            Array.isArray(e.stops) &&
            e.stops.length >= 1 &&
            e.stops.every((s) => ('stop' in s ? num(s.stop) && s.stop >= 0 && s.stop < S : num(s.lat) && num(s.lon))) &&
            Array.isArray(e.hops) &&
            e.hops.length === e.stops.length &&
            e.hops.every((h) => num(h) && h > 0)
          );
        case 'addStop':
          return (
            typeof e.id === 'string' &&
            typeof e.route === 'string' &&
            typeof e.feed === 'string' &&
            Array.isArray(e.between) &&
            e.between.length === 2 &&
            e.between.every((x) => num(x) && x >= 0 && x < S) &&
            num(e.lat) &&
            num(e.lon) &&
            (e.name === undefined || typeof e.name === 'string')
          );
        case 'newLine':
          return (
            Array.isArray(e.stops) &&
            e.stops.length >= 2 &&
            e.stops.every((s) => ('stop' in s ? num(s.stop) && s.stop >= 0 && s.stop < S : num(s.lat) && num(s.lon))) &&
            Array.isArray(e.hops) &&
            e.hops.length === e.stops.length - 1 &&
            Array.isArray(e.path) &&
            Array.isArray(e.stopAt) &&
            e.stopAt.length === e.stops.length &&
            e.headway &&
            TPERIODS.every((p) => num(e.headway[p]))
          );
        case 'road':
          return (
            typeof e.id === 'string' &&
            typeof e.name === 'string' &&
            typeof e.street === 'string' &&
            num(e.from?.lat) &&
            num(e.from?.lon) &&
            num(e.to?.lat) &&
            num(e.to?.lon) &&
            (e.lanes === undefined || (num(e.lanes) && Math.abs(e.lanes) <= 4)) &&
            (e.busLane === undefined || typeof e.busLane === 'boolean') &&
            (e.via === undefined || (Array.isArray(e.via) && e.via.every((v) => num(v?.lat) && num(v?.lon))))
          );
        case 'parking':
          return typeof e.id === 'string' && typeof e.name === 'string' && Array.isArray(e.ring) && e.ring.length >= 3 && e.ring.every((v) => Array.isArray(v) && num(v[0]) && num(v[1])) && num(e.perHour) && Math.abs(e.perHour) <= 50;
        case 'cordon':
          return typeof e.id === 'string' && typeof e.name === 'string' && Array.isArray(e.ring) && e.ring.length >= 3 && e.ring.every((v) => Array.isArray(v) && num(v[0]) && num(v[1])) && e.toll && typeof e.toll === 'object' && TPERIODS.every((p) => e.toll[p] === undefined || (num(e.toll[p]) && e.toll[p]! >= 0 && e.toll[p]! <= 100));
        default:
          return false;
      }
    });
    // (longRun: links made before car ownership was a condition)
    const context = cleanContext(o.longRun === true ? { ...(o.context as object), carOwnership: true } : o.context);
    return { name: typeof o.name === 'string' ? o.name.slice(0, 80) : 'Shared scenario', edits, day: isDay(o.day) ? o.day : 'wkd', ...(context ? { context } : {}), ...(o.traffic === true ? { traffic: true } : {}), ...(RUN_MODE_LIST.includes(o.mode as RunMode) ? { runMode: o.mode as RunMode } : {}) };
  } catch {
    return null;
  }
}

const isDay = (d: unknown): d is DayType => typeof d === 'string' && (DAY_TYPES as readonly string[]).includes(d);

export function scenarioFromHash(m: Model): Scenario | null {
  const h = location.hash.match(/[#&]s=([A-Za-z0-9_-]+)/);
  return h ? decodeScenario(m, h[1]) : null;
}

/** the day in the address (#d=sat) when there is no scenario */
export function dayFromHash(): DayType | null {
  const h = location.hash.match(/[#&]d=([a-z]+)/);
  return h && isDay(h[1]) ? h[1] : null;
}

/** put the scenario (and the run mode it is to be run in) in the address, for sharing */
export function writeHash(s: Scenario, mode?: RunMode): void {
  const day = s.day ?? 'wkd';
  const hash = hasChanges(s) ? `#s=${encodeScenario(mode ? { ...s, runMode: mode } : s)}` : day !== 'wkd' ? `#d=${day}` : '';
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}
