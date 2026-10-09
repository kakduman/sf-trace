/**
 * Everything the views derive from the bundle and from run results: routes grouped from route
 * patterns, the map's flow segments (one per route and stop pair, so patterns of one route that
 * share a street add up instead of overdrawing), and per-route statistics for a result.
 */
import { COST_PER_HOUR, MODES, type Mode } from '../../shared/beta3/params';
import type { BLine, Bundle, DayType, Edit, LineResult, RunResult, Scenario, TPeriod, TransitMode } from '../../shared/beta3/types';
import { DAY_LABEL, DAY_TYPES, TPERIOD_HOURS, TPERIODS } from '../../shared/beta3/types';
import { titleCase } from './format';
import type { PeriodSel } from './state';

export { TPERIODS, TPERIOD_HOURS, DAY_TYPES, DAY_LABEL };
export type { DayType };
/** "an average weekday", "an average Saturday" */
export const DAY_PHRASE: Record<DayType, string> = { wkd: 'an average weekday', sat: 'an average Saturday', sun: 'an average Sunday' };
/** lower-case noun for "per …": weekday, Saturday, Sunday */
export const DAY_NOUN: Record<DayType, string> = { wkd: 'weekday', sat: 'Saturday', sun: 'Sunday' };
export const PERIOD_SHORT: Record<PeriodSel, string> = { day: 'All day', AM: 'AM peak', MD: 'Midday', PM: 'PM peak', NT: 'Night' };
export const PERIOD_HOURS_TEXT: Record<PeriodSel, string> = { day: 'Whole day', AM: '6–10am', MD: '10am–3pm', PM: '3–7pm', NT: '7pm–6am' };

// ---------- operators and colors ----------

export const OPERATORS = ['muni', 'bart', 'caltrain', 'ggt', 'ferry'] as const;
export const OPERATOR_LABEL: Record<string, string> = { muni: 'Muni', bart: 'BART', caltrain: 'Caltrain', ggt: 'Golden Gate Transit', ferry: 'SF Bay Ferry', ac: 'AC Transit', samtrans: 'SamTrans', tma: 'Mission Bay TMA', shuttle: 'Shuttles', new: 'New lines' };

/** Map line groups, each with one fixed color (used when lines are colored by mode). */
export const LINE_GROUPS = ['bus', 'rapid', 'metro', 'cable', 'bart', 'caltrain', 'ferry'] as const;
export type LineGroup = (typeof LINE_GROUPS)[number];
export const LINE_GROUP_LABEL: Record<LineGroup, string> = {
  bus: 'Local bus',
  rapid: 'Rapid & express bus',
  metro: 'Muni Metro & streetcar',
  cable: 'Cable car',
  bart: 'BART',
  caltrain: 'Caltrain',
  ferry: 'Ferry',
};
export const LINE_GROUP_COLOR: Record<LineGroup, string> = {
  bus: '#2a78d6',
  rapid: '#1baf7a',
  metro: '#eb6834',
  cable: '#eda100',
  bart: '#4a3aa7',
  caltrain: '#e34948',
  ferry: '#e87ba4',
};
export function lineGroup(mode: TransitMode): LineGroup {
  switch (mode) {
    case 'bus':
    case 'trolley':
      return 'bus';
    case 'rapid':
    case 'express':
      return 'rapid';
    case 'lightrail':
    case 'streetcar':
      return 'metro';
    case 'cablecar':
      return 'cable';
    case 'bart':
      return 'bart';
    case 'caltrain':
      return 'caltrain';
    default:
      return 'ferry';
  }
}

/** Travel modes: one fixed color each, everywhere in the app. */
export const MODE_ORDER: Mode[] = ['transit', 'walk', 'bike', 'da', 'sr', 'tnc'];
export const MODE_COLOR: Record<Mode, string> = {
  transit: '#2a78d6',
  walk: '#1baf7a',
  bike: '#008300',
  da: '#eb6834',
  sr: '#eda100',
  tnc: '#e87ba4',
};
void MODES;

/** white or near-black text for a badge on this color */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.36 ? '#0b0b0b' : '#ffffff';
}

/** GTFS colors can be near-white (Caltrain) or neon yellow (BART): darken those for a light map. */
export function mapColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#666666';
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const lum = (r: number, g: number, b: number) => {
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  for (let i = 0; i < 20 && lum(r, g, b) > 0.32; i++) (r *= 0.9), (g *= 0.9), (b *= 0.9);
  const h = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ---------- routes ----------

export interface RouteInfo {
  /** group key, e.g. "muni:38R" or "bart:Yellow" */
  key: string;
  index: number;
  feed: string;
  /** the GTFS route ids in the group (BART's two directions are separate routes) */
  members: string[];
  /** short label: "38R", "Yellow", "Local" */
  label: string;
  /** long name: "Geary Rapid" */
  name: string;
  /** text for the colored route badge ("38R", "BART", "CT") */
  badge: string;
  /** name shown next to the badge in tables */
  short: string;
  mode: TransitMode;
  group: LineGroup;
  color: string;
  patterns: number[];
  /** scheduled vehicle runs (departures) per transit period, all patterns and both directions, by day type */
  runs: Record<DayType, Record<TPeriod, number>>;
  /** scheduled vehicle runs over the whole day, by day type */
  runsDay: Record<DayType, number>;
  /** the busiest pattern per direction (for load profiles) */
  main: number[];
  /** counted weekday boardings (SFMTA, Muni only) */
  observed: number | null;
  /** counted boardings by day type */
  observedBy: Record<DayType, number | null>;
}

export interface Model {
  bundle: Bundle;
  routes: RouteInfo[];
  routeByKey: Map<string, RouteInfo>;
  /** route index per bundle line */
  lineRoute: Int32Array;
  segs: Seg[];
  segByKey: Map<string, number>;
  stopCount: number;
}

export interface Seg {
  id: number;
  route: number;
  a: number;
  b: number;
  /** [lon, lat] */
  coords: [number, number][];
  /** the patterns that run over it, with the hop index on each */
  parts: { line: number; hop: number }[];
}

/** vehicle runs a pattern makes in a transit period on a day type (night = evening + early morning) */
export function baseTrips(l: BLine, p: TPeriod, day: DayType = 'wkd'): number {
  const ps = (day === 'wkd' ? l.periods : (l.days?.[day] ?? {})) as Record<string, { trips: number } | undefined>;
  if (p === 'NT') return (ps.EV?.trips ?? 0) + (ps.EA?.trips ?? 0);
  return ps[p]?.trips ?? 0;
}

export function groupKey(l: BLine) {
  if (l.feed === 'bart') return `bart:${l.route.replace(/-[NS]$/, '')}`;
  return `${l.feed}:${l.route}`;
}

function routeLabels(l: BLine): { label: string; name: string } {
  switch (l.feed) {
    case 'bart':
      return { label: l.route.replace(/-[NS]$/, ''), name: l.routeName.replace(/ to /, ' – ') };
    case 'caltrain':
      return { label: l.route.replace(/ Weekday$/, ''), name: l.routeName.replace(/ Weekday$/, '') };
    case 'ggt':
    case 'ferry':
      return { label: l.route, name: l.routeName.replace(/ - /g, ' – ') };
    default:
      return { label: l.route, name: titleCase(l.routeName) };
  }
}

export function buildModel(bundle: Bundle): Model {
  const H = bundle.header;
  const O = H.observed;
  const obsBy: Record<DayType, Map<string, number> | null> = {
    wkd: new Map(O.muniRoutes.map((r) => [r.route, r.boardings])),
    sat: O.muniRoutesSat ? new Map(O.muniRoutesSat.map((r) => [r.route, r.boardings])) : null,
    sun: O.muniRoutesSun ? new Map(O.muniRoutesSun.map((r) => [r.route, r.boardings])) : null,
  };
  const zeros = (): Record<TPeriod, number> => ({ AM: 0, MD: 0, PM: 0, NT: 0 });
  const routes: RouteInfo[] = [];
  const routeByKey = new Map<string, RouteInfo>();
  const lineRoute = new Int32Array(H.lines.length);
  H.lines.forEach((l, i) => {
    const key = groupKey(l);
    let r = routeByKey.get(key);
    if (!r) {
      const { label, name } = routeLabels(l);
      r = {
        key,
        index: routes.length,
        feed: l.feed,
        members: [],
        label,
        name,
        badge: l.feed === 'bart' ? 'BART' : l.feed === 'caltrain' ? 'CT' : label,
        short: l.feed === 'bart' ? `${label} line` : l.feed === 'caltrain' ? label : name,
        mode: l.mode,
        group: lineGroup(l.mode),
        color: mapColor(l.color),
        patterns: [],
        runs: { wkd: zeros(), sat: zeros(), sun: zeros() },
        runsDay: { wkd: 0, sat: 0, sun: 0 },
        main: [],
        observed: l.feed === 'muni' ? (obsBy.wkd!.get(l.route) ?? null) : null,
        observedBy: {
          wkd: l.feed === 'muni' ? (obsBy.wkd!.get(l.route) ?? null) : null,
          sat: l.feed === 'muni' ? (obsBy.sat?.get(l.route) ?? null) : null,
          sun: l.feed === 'muni' ? (obsBy.sun?.get(l.route) ?? null) : null,
        },
      };
      routes.push(r);
      routeByKey.set(key, r);
    }
    if (!r.members.includes(l.route)) r.members.push(l.route);
    r.patterns.push(i);
    for (const d of DAY_TYPES) for (const p of TPERIODS) r.runs[d][p] += baseTrips(l, p, d);
    lineRoute[i] = r.index;
  });
  for (const r of routes) {
    for (const d of DAY_TYPES) r.runsDay[d] = TPERIODS.reduce((s, p) => s + r.runs[d][p], 0);
    // main pattern per direction: most trips, favoring full-length patterns
    const byDir = new Map<number, { i: number; score: number }>();
    for (const i of r.patterns) {
      const l = H.lines[i];
      const t = TPERIODS.reduce((s, p) => s + baseTrips(l, p), 0);
      const score = t * Math.sqrt(l.stops.length);
      const cur = byDir.get(l.dir);
      if (!cur || score > cur.score) byDir.set(l.dir, { i, score });
    }
    r.main = [...byDir.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.i);
  }

  // flow segments: one per route and consecutive stop pair
  const segs: Seg[] = [];
  const segByKey = new Map<string, number>();
  H.lines.forEach((l, li) => {
    const ri = lineRoute[li];
    for (let k = 0; k + 1 < l.stops.length; k++) {
      const a = l.stops[k], b = l.stops[k + 1];
      const key = `${ri}|${a}|${b}`;
      let si = segByKey.get(key);
      if (si === undefined) {
        si = segs.length;
        segByKey.set(key, si);
        segs.push({ id: si, route: ri, a, b, coords: pathSlice(l.path, l.stopAt[k], l.stopAt[k + 1], H.stops[a], H.stops[b]), parts: [] });
      }
      segs[si].parts.push({ line: li, hop: k });
    }
  });
  return { bundle, routes, routeByKey, lineRoute, segs, segByKey, stopCount: H.stops.length };
}

/** the drawn path between two point indices, as [lon, lat] (at least two points) */
export function pathSlice(path: number[], i0: number, i1: number, sa?: { lat: number; lon: number }, sb?: { lat: number; lon: number }): [number, number][] {
  const out: [number, number][] = [];
  if (i1 > i0) for (let i = i0; i <= i1; i++) out.push([path[2 * i + 1], path[2 * i]]);
  if (out.length < 2) {
    if (sa && sb) return [[sa.lon, sa.lat], [sb.lon, sb.lat]];
    if (out.length === 1) out.push([out[0][0] + 1e-6, out[0][1]]);
  }
  return out;
}

// ---------- scenario-aware service ----------

const matchEdit = (l: BLine, e: { route: string; feed: string }) => l.route === e.route && l.feed === e.feed;

/** runs a pattern makes in a period on a day under a scenario (removed: 0; frequency edits applied) */
export function scenTrips(l: BLine, p: TPeriod, s: Scenario | null, day: DayType = 'wkd'): number {
  let t = baseTrips(l, p, day);
  if (!s) return t;
  for (const e of s.edits) {
    if (e.kind === 'remove' && matchEdit(l, e)) return 0;
    if (e.kind === 'frequency' && matchEdit(l, e)) t *= e.factor[p] ?? 1;
  }
  return t;
}

// ---------- results ----------

const lineMaps = new WeakMap<RunResult, { base: Map<number, LineResult>; added: Map<number, LineResult[]> }>();

/** a result's line results by bundle line index, and new lines' (forward, reverse) by edit order */
export function lineIndex(r: RunResult) {
  let m = lineMaps.get(r);
  if (!m) {
    const base = new Map<number, LineResult>();
    const added = new Map<number, LineResult[]>();
    for (const lr of r.lines) {
      if (lr.line >= 0) base.set(lr.line, lr);
      else {
        const k = -1 - lr.line;
        if (!added.has(k)) added.set(k, []);
        added.get(k)!.push(lr);
      }
    }
    // forward first, then the return direction
    for (const list of added.values()) list.sort((a, b) => Number(!!a.reverse) - Number(!!b.reverse));
    m = { base, added };
    lineMaps.set(r, m);
  }
  return m;
}

export const periodsOf = (p: PeriodSel): TPeriod[] => (p === 'day' ? [...TPERIODS] : [p]);
export const hoursOf = (p: PeriodSel) => (p === 'day' ? 24 : TPERIOD_HOURS[p]);

/**
 * For a line whose stops a scenario changed (lr.stops), the hops of the result that cover each of
 * the bundle line's hops: [first, end) into lr.loads. An added stop splits a hop in two (the
 * bundle hop gets their mean); a removed stop merges two (both bundle hops get the merged load).
 */
const hopMaps = new WeakMap<LineResult, [number, number][]>();
export function hopSpan(m: Model, lr: LineResult, hop: number): [number, number] | null {
  if (!lr.stops) return [hop, hop + 1];
  let map = hopMaps.get(lr);
  if (!map) {
    const S = m.bundle.header.lines[lr.line].stops;
    const R = lr.stops;
    // position in R of each bundle stop still served (in order), else -1
    const pos: number[] = [];
    let j = 0;
    for (const st of S) {
      let k = j;
      while (k < R.length && R[k] !== st) k++;
      if (k < R.length) (pos.push(k), (j = k + 1));
      else pos.push(-1);
    }
    map = [];
    for (let h = 0; h + 1 < S.length; h++) {
      let a = h, b = h + 1;
      while (a > 0 && pos[a] < 0) a--;
      while (b < S.length - 1 && pos[b] < 0) b++;
      map.push(pos[a] >= 0 && pos[b] > pos[a] ? [pos[a], pos[b]] : [-1, -1]);
    }
    hopMaps.set(lr, map);
  }
  const sp = map[hop];
  return sp && sp[0] >= 0 ? sp : null;
}

/** passengers on a bundle line's hop over one period, in a result */
export function hopLoad(m: Model, lr: LineResult, hop: number, q: TPeriod): number {
  const L = lr.loads[q];
  if (!L) return 0;
  if (!lr.stops) return L[hop] ?? 0;
  const sp = hopSpan(m, lr, hop);
  if (!sp) return 0;
  let v = 0;
  for (let k = sp[0]; k < sp[1]; k++) v += L[k] ?? 0;
  return v / (sp[1] - sp[0]);
}

/** passengers over the period (or day) on a segment */
export function segLoad(m: Model, r: RunResult, seg: Seg, p: PeriodSel): number {
  const { base } = lineIndex(r);
  let v = 0;
  for (const part of seg.parts) {
    const lr = base.get(part.line);
    if (!lr) continue;
    for (const q of periodsOf(p)) v += hopLoad(m, lr, part.hop, q);
  }
  return v;
}

/** today's background riders on a segment (BART and Caltrain trips with no end in the city; shared/beta3/background.ts) */
export function segBackground(m: Model, seg: Seg, p: PeriodSel, day: DayType = 'wkd'): number {
  const H = m.bundle.header;
  let v = 0;
  for (const part of seg.parts) for (const q of periodsOf(p)) v += H.lines[part.line]?.bg?.[day]?.[q]?.[part.hop] ?? 0;
  return v;
}

/** vehicles over the period on a segment, and seated+standing capacity */
export function segService(m: Model, seg: Seg, p: PeriodSel, s: Scenario | null, day: DayType = 'wkd'): { trips: number; cap: number } {
  const H = m.bundle.header;
  let trips = 0, cap = 0;
  for (const part of seg.parts) {
    const l = H.lines[part.line];
    for (const q of periodsOf(p)) {
      const t = scenTrips(l, q, s, day);
      trips += t;
      cap += t * l.cap;
    }
  }
  return { trips, cap };
}

/** busiest load factor of a segment across the selected periods */
export function segLoadFactor(m: Model, r: RunResult, seg: Seg, p: PeriodSel, s: Scenario | null, day: DayType = 'wkd'): number {
  let best = 0;
  for (const q of periodsOf(p)) {
    const svc = segService(m, seg, q, s, day);
    if (svc.cap > 0) best = Math.max(best, segLoad(m, r, seg, q) / svc.cap);
  }
  return best;
}

export interface RouteStats {
  boardings: Record<TPeriod, number>;
  day: number;
  peakLoadFactor: number;
  revenueHours: number;
  opCost: number;
  passengerKm: number;
}

const statCache = new WeakMap<RunResult, Map<number, RouteStats>>();

/** per-route totals for a result */
export function routeStats(m: Model, r: RunResult): Map<number, RouteStats> {
  let out = statCache.get(r);
  if (out) return out;
  out = new Map();
  const H = m.bundle.header;
  for (const lr of r.lines) {
    if (lr.line < 0) continue;
    const ri = m.lineRoute[lr.line];
    let s = out.get(ri);
    if (!s) out.set(ri, (s = { boardings: { AM: 0, MD: 0, PM: 0, NT: 0 }, day: 0, peakLoadFactor: 0, revenueHours: 0, opCost: 0, passengerKm: 0 }));
    for (const p of TPERIODS) s.boardings[p] += lr.boardings[p];
    s.day += TPERIODS.reduce((a, p) => a + lr.boardings[p], 0);
    s.peakLoadFactor = Math.max(s.peakLoadFactor, lr.peakLoadFactor);
    s.revenueHours += lr.revenueHours;
    s.opCost += lr.revenueHours * (COST_PER_HOUR[H.lines[lr.line].mode] ?? 300);
    s.passengerKm += lr.passengerKm;
  }
  statCache.set(r, out);
  return out;
}

export const dayBoardings = (lr: LineResult) => TPERIODS.reduce((a, p) => a + lr.boardings[p], 0);

// ---------- scenario lines and stops ----------

export type NewLineEdit = Extract<Edit, { kind: 'newLine' }>;
export const newLines = (s: Scenario): NewLineEdit[] => s.edits.filter((e): e is NewLineEdit => e.kind === 'newLine');

export type AddStopEdit = Extract<Edit, { kind: 'addStop' }>;
export type RemoveStopEdit = Extract<Edit, { kind: 'removeStop' }>;
export type ExtendEdit = Extract<Edit, { kind: 'extend' }>;

/**
 * The scenario's new stops in the order the model numbers them (after the bundle's stops): in
 * edit order, each new line's unsnapped stops and each stop added to a route.
 */
export interface NewStop {
  lat: number;
  lon: number;
  name: string;
  /** the edit that adds it to a route, if any */
  added?: AddStopEdit;
  extended?: ExtendEdit;
}
export function newStopList(s: Scenario): NewStop[] {
  const out: NewStop[] = [];
  for (const e of s.edits) {
    if (e.kind === 'newLine') for (const st of e.stops) if (!('stop' in st)) out.push({ lat: st.lat, lon: st.lon, name: st.name ?? 'New stop' });
    if (e.kind === 'addStop') out.push({ lat: e.lat, lon: e.lon, name: e.name ?? 'New stop', added: e });
    if (e.kind === 'extend') for (const st of e.stops) if (!('stop' in st)) out.push({ lat: st.lat, lon: st.lon, name: st.name ?? 'New stop', extended: e });
  }
  return out;
}
/** an extension's stops as model stop indices (existing stops keep theirs) */
export function extendStopIndices(m: Model, s: Scenario, e: ExtendEdit): number[] {
  const list = newStopList(s);
  let k = list.findIndex((x) => x.extended === e);
  return e.stops.map((st) => ('stop' in st ? st.stop : m.bundle.header.stops.length + k++));
}
/** the model's stop index of an added stop */
export function addedStopIndex(m: Model, s: Scenario, id: string): number {
  const k = newStopList(s).findIndex((x) => x.added?.id === id);
  return k < 0 ? -1 : m.bundle.header.stops.length + k;
}

/** stop position and name for any stop index (bundle stops, then the scenario's new stops) */
export function stopInfo(m: Model, s: Scenario | null, i: number): { lat: number; lon: number; name: string; feed: string } | null {
  const H = m.bundle.header;
  if (i < H.stops.length) return H.stops[i];
  const ns = s ? newStopList(s)[i - H.stops.length] : undefined;
  return ns ? { ...ns, feed: 'new' } : null;
}

/** a new line's stops as lat/lon */
export function newLineStops(m: Model, e: NewLineEdit): { lat: number; lon: number; name: string; stop?: number }[] {
  const H = m.bundle.header;
  return e.stops.map((st) => ('stop' in st ? { lat: H.stops[st.stop].lat, lon: H.stops[st.stop].lon, name: H.stops[st.stop].name, stop: st.stop } : { lat: st.lat, lon: st.lon, name: st.name ?? 'New stop' }));
}

export const routeTitle = (r: RouteInfo) => {
  switch (r.feed) {
    case 'muni':
      return `${r.label} ${r.name}`;
    case 'bart':
      return `BART ${r.label} line`;
    case 'caltrain':
      return `Caltrain ${r.label}`;
    case 'ggt':
      return r.mode === 'ferry' ? `Golden Gate Ferry: ${r.name.replace(/ – San Francisco Ferry$/, '')}` : `Golden Gate ${r.label}`;
    case 'ferry':
      return `Ferry: ${r.name}`;
    case 'tma':
      return `Mission Bay shuttle: ${r.label}`;
    default:
      return r.label;
  }
};

/** modes in display order, with labels, for mode tables */
export type { Mode };
