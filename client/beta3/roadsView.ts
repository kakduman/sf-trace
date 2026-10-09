/**
 * Street speeds for the page: today's congested times from the saved equilibrium, a link's speed
 * and its share of the free-flow speed for a period (or the day, weighted by its traffic), and the
 * color and width scales of the map layer.
 *
 * Palettes were checked with the dataviz skill's validator against the map's land color (light
 * #eef1f1, dark #141c21): the congestion ramp and each arm of the change scale as ordinal ramps
 * (one hue, monotone lightness, the step nearest the land at 2:1 or more), and the change scale's
 * green and purple at each step as a pair (color-vision-deficiency separation ΔE 14 or more).
 */
import { linkTimes, periodRoads, summariseRoads, type RoadNet, type RoadSummary } from '../../shared/beta3/roads';
import { TPERIODS, type TPeriod } from '../../shared/beta3/types';
import { withBackground } from '../../shared/beta3/traffic';
import type { PeriodSel } from './state';

/**
 * Congestion classes: the speed as a share of the street's free-flow speed (the speed with the
 * street empty, signals and stop signs included), from free-flowing to slowest.
 */
export const CONGESTION_BREAKS = [0.9, 0.75, 0.6, 0.45];
export const CONGESTION_LABELS = ['90% or more', '75–90%', '60–75%', '45–60%', 'Under 45%'];
/** one hue (orange; blue and red mean transit changes on this map): the slower, the darker in light mode and the brighter in dark */
export const CONGESTION_COLORS = {
  light: ['#ed914c', '#cb7229', '#a75605', '#824103', '#5f2e01'],
  dark: ['#9f5102', '#c16302', '#dd7b2b', '#f99549', '#ffb98a'],
};
/** change in speed, mph (scenario − today): faster (green), within half a mile an hour (gray), slower (purple) */
export const CHANGE_BREAKS = [3, 1.5, 0.5, -0.5, -1.5, -3];
export const CHANGE_LABELS = ['3+ faster', '1.5–3 faster', '0.5–1.5 faster', 'Within 0.5', '0.5–1.5 slower', '1.5–3 slower', '3+ slower'];
export const CHANGE_COLORS = {
  light: ['#026a2e', '#0a9645', '#4ac06c', '#b7c0c4', '#bc88f4', '#915dc5', '#683297'],
  dark: ['#7bee98', '#51c672', '#20a04e', '#4b585f', '#9d69d2', '#c28efb', '#dec3ff'],
};
/** line width multiplier by change class: the bigger the change, the thicker; unchanged streets thin */
export const CHANGE_WIDTH = [2.2, 1.7, 1.25, 0.55, 1.25, 1.7, 2.2];

export const congestionClass = (share: number) => {
  const i = CONGESTION_BREAKS.findIndex((b) => share >= b);
  return i < 0 ? CONGESTION_BREAKS.length : i;
};
export const changeClass = (d: number) => {
  const i = CHANGE_BREAKS.findIndex((b) => d >= b);
  return i < 0 ? CHANGE_BREAKS.length : i;
};

/**
 * Drawing groups by road class (RCLS): 0 freeway, 1 ramp, 2 expressway and arterial, 3 collector,
 * 4 local street; −1 not drawn (centroid connectors).
 */
export const roadGroup = (cls: number) => (cls === 1 ? 0 : cls === 2 ? 1 : cls === 3 || cls === 4 ? 2 : cls === 5 ? 3 : cls === 6 ? 4 : -1);
/** the group whose streets appear only from about zoom 14 */
export const LOCAL_GROUP = 4;

const cache = new WeakMap<RoadNet, { flow: Record<TPeriod, Float64Array>; time: Record<TPeriod, Float64Array>; summary: RoadSummary }>();
/**
 * today's traffic on each link (on the Peninsula freeways, the model's cars and the fixed
 * background together), congested minutes, and summary (from the saved equilibrium)
 */
export function todayTraffic(net: RoadNet) {
  let v = cache.get(net);
  if (!v) {
    const flow = {} as Record<TPeriod, Float64Array>,
      time = {} as Record<TPeriod, Float64Array>;
    const assigned = {} as Record<TPeriod, Float64Array>;
    for (const p of TPERIODS) {
      const R = periodRoads(net, p);
      assigned[p] = Float64Array.from(net.base[p] ?? new Float32Array(net.h.nLinks));
      time[p] = new Float64Array(net.h.nLinks);
      linkTimes(R, assigned[p], time[p]);
      flow[p] = Float64Array.from(withBackground(net, p, assigned[p]));
    }
    v = { flow, time, summary: summariseRoads(net, assigned, time) };
    cache.set(net, v);
  }
  return v;
}

type ByPeriod = Record<TPeriod, ArrayLike<number>>;
/** free-flow minutes on link k in period p */
const freeMin = (net: RoadNet, p: TPeriod, k: number) => net.t0[TPERIODS.indexOf(p) * net.h.nLinks + k];

/** a link's speed (mph) in a period, or over the day weighted by its traffic */
export function linkSpeed(net: RoadNet, flow: ByPeriod, time: ByPeriod, p: PeriodSel, k: number): number {
  const L = net.len[k];
  if (p !== 'day') return time[p][k] > 0 ? (60 * L) / time[p][k] : 0;
  let f = 0,
    h = 0;
  for (const q of TPERIODS) ((f += flow[q][k]), (h += (flow[q][k] * time[q][k]) / 60));
  return h > 0 ? (f * L) / h : (60 * L) / time.MD[k];
}

/** a link's free-flow speed (mph): in a period, or over the day weighted by the same traffic as linkSpeed */
export function freeFlowSpeed(net: RoadNet, flow: ByPeriod, p: PeriodSel, k: number): number {
  const L = net.len[k];
  if (p !== 'day') return (60 * L) / freeMin(net, p, k);
  let f = 0,
    h = 0;
  for (const q of TPERIODS) ((f += flow[q][k]), (h += (flow[q][k] * freeMin(net, q, k)) / 60));
  return h > 0 ? (f * L) / h : (60 * L) / freeMin(net, 'MD', k);
}

/**
 * Congestion: the speed as a share of the free-flow speed (1 = as fast as an empty street), in a
 * period, or over the day as the traffic-weighted speed over the traffic-weighted free-flow speed
 * (equivalently, free-flow vehicle hours over congested vehicle hours).
 */
export function congestionShare(net: RoadNet, flow: ByPeriod, time: ByPeriod, p: PeriodSel, k: number): number {
  const ff = freeFlowSpeed(net, flow, p, k);
  return ff > 0 ? Math.min(1, linkSpeed(net, flow, time, p, k) / ff) : 1;
}

/** a link's traffic in a period (vehicles an hour) or over the day */
export function linkVolume(flow: ByPeriod, p: PeriodSel, k: number): number {
  const H: Record<TPeriod, number> = { AM: 4, MD: 5, PM: 4, NT: 11 };
  return p === 'day' ? TPERIODS.reduce((a, q) => a + flow[q][k], 0) : flow[p][k] / H[p];
}

/**
 * The basemap's drawn road widths (px) from zoom 15 (OpenFreeMap Positron: motorway, major and minor
 * road layers), by drawing group: freeway, ramp (narrower than its motorway), arterial, collector,
 * local street. Close in, the street lines are drawn inside these so they sit on the roads.
 */
const ROAD_W: Record<number, number[]> = {
  15: [6.4, 3.8, 5.8, 5.8, 3.05],
  16: [8.6, 5.2, 7.4, 7.4, 4.2],
  17: [11.6, 7, 9.4, 9.4, 6.0],
  18: [15.8, 9.5, 12.1, 12.1, 8.9],
  20: [30, 18, 20, 20, 20],
};
/** a one-way street's line fills this share of the drawn road; a two-way street's two lines this share each, side by side */
const ONE_WAY_FILL = 0.6,
  TWO_WAY_FILL = 0.45;

/**
 * The street layer's line width (px), a MapLibre expression: thin at city zoom, and from zoom 15
 * inside the basemap's drawn road, freeways widest; `g` is the feature's roadGroup and `m` its
 * multiplier (the change class's CHANGE_WIDTH in the Change view, 1 otherwise). With `offset`, the
 * line offset instead: none to zoom 14, so each line sits on the road's centerline; from zoom 15,
 * where the street is two-way (`tw` 1), each direction moves half its width to the right of travel,
 * so the pair stays within the drawn road.
 */
export function streetWidthExpr(offset = false): unknown {
  const m = ['coalesce', ['get', 'm'], 1];
  const tw = ['==', ['coalesce', ['get', 'tw'], 0], 1];
  const byGroup = (w: number[]) => ['match', ['get', 'g'], 0, w[0], 1, w[1], 2, w[2], 3, w[3], w[4]];
  // to zoom 14: widths by group (freeway, ramp, arterial, collector, local), one line per street
  const city = (w: number[]) => (offset ? 0 : ['*', m, byGroup(w)]);
  const close = (z: number) => (offset ? ['case', tw, ['*', 0.5 * TWO_WAY_FILL, m, byGroup(ROAD_W[z])], 0] : ['*', m, byGroup(ROAD_W[z]), ['case', tw, TWO_WAY_FILL, ONE_WAY_FILL]]);
  return ['interpolate', ['linear'], ['zoom'], 10, city([1.3, 0.5, 0.8, 0.45, 0.3]), 12, city([2.2, 0.9, 1.4, 0.9, 0.6]), 14, city([3.6, 1.6, 2.6, 1.8, 1.3]), 15, close(15), 16, close(16), 17, close(17), 18, close(18), 20, close(20)];
}
