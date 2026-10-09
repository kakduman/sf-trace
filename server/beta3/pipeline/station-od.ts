/**
 * The model's station-to-station rides on chosen operators (BART, Caltrain), from a transit
 * assignment run destination by destination. For one destination the optimal strategy splits the
 * riders at each line node in fixed shares, whoever they are, so the riders on a line who boarded at
 * one stop leave it at each later stop in the same proportion as everyone on board: on and off counts
 * per destination give the exact boarding-to-alighting matrix of each line.
 *
 * Fare-gate data (BART) and the Caltrain survey record a journey on the operator from where it starts
 * to where it ends, through any change of train. A ride that begins where the same destination's
 * riders get off the same operator is counted as a change of train, and so is a ride ending where they
 * board it again; only the share that is not is kept (riders "entering" and "leaving" the operator),
 * so `pairs` approximates gate-to-gate journeys made without a change of train, and `rides` keeps all.
 */
import fs from 'node:fs';
import { buildNet, LINK_ALIGHT, LINK_BOARD, type TransitNet } from '../../../shared/beta3/net';
import type { Bundle, Calibration, DayType, RunResult, TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { REFERENCE } from './paths';
import { StrategySolver } from '../../../shared/beta3/strategy';

export interface StationPairs {
  /** bundle stop index of each station of the operator */
  stops: number[];
  /** journeys entering at i and leaving at j without changing trains: [i * n + j] */
  pairs: Float64Array;
  /** every ride from boarding to alighting, including those after or before a change */
  rides: Float64Array;
}

export function stationPairs(net: TransitNet, od: Float32Array, Z: number, feeds: string[]): Record<string, StationPairs> & { linkVol: Float64Array } {
  const solver = new StrategySolver(net);
  const res: Record<string, StationPairs> = {};
  const lineIdx: Record<string, number[]> = {};
  for (const f of feeds) {
    const ls = net.lines.map((l, i) => [l, i] as const).filter(([l]) => l.feed === f);
    const stops = [...new Set(ls.flatMap(([l]) => l.stops))];
    res[f] = { stops, pairs: new Float64Array(stops.length ** 2), rides: new Float64Array(stops.length ** 2) };
    lineIdx[f] = ls.map(([, i]) => i);
  }
  // board and alight links of the tracked lines, by line and position
  // (a stop has two board links per line: from the street and from a change of line)
  const boardL = new Map<number, number[][]>(), alightL = new Map<number, number[][]>();
  for (const f of feeds) for (const i of lineIdx[f]) {
    boardL.set(i, net.lines[i].stops.map(() => []));
    alightL.set(i, net.lines[i].stops.map(() => []));
  }
  const tracked: number[] = [];
  for (let a = 0; a < net.nLinks; a++) {
    const t = net.type[a];
    if (t !== LINK_BOARD && t !== LINK_ALIGHT) continue;
    const m = (t === LINK_BOARD ? boardL : alightL).get(net.line[a]);
    if (!m) continue;
    m[net.pos[a]].push(a);
    tracked.push(a);
  }
  const prev = new Float64Array(net.nLinks);
  for (let d = 0; d < Z; d++) {
    let any = false;
    for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) (any = true), (o = Z);
    if (!any) continue;
    solver.solve(d);
    solver.load((o) => od[o * Z + d]);
    const lv = solver.linkVol;
    const delta = (as: number[]) => as.reduce((x, a) => x + lv[a] - prev[a], 0);
    for (const f of feeds) {
      const R = res[f], n = R.stops.length;
      const at = new Map(R.stops.map((s, i) => [s, i]));
      // this destination's riders getting on and off the operator at each station
      const on = new Float64Array(n), off = new Float64Array(n);
      for (const i of lineIdx[f]) {
        const l = net.lines[i], b = boardL.get(i)!, al = alightL.get(i)!;
        l.stops.forEach((s, k) => {
          on[at.get(s)!] += delta(b[k]);
          off[at.get(s)!] += delta(al[k]);
        });
      }
      // share of boardings that are changes of train (and of alightings), at most the smaller flow
      const fresh = (s: number) => (on[s] > 0 ? 1 - Math.min(on[s], off[s]) / on[s] : 1);
      const final = (s: number) => (off[s] > 0 ? 1 - Math.min(on[s], off[s]) / off[s] : 1);
      for (const i of lineIdx[f]) {
        const l = net.lines[i], b = boardL.get(i)!, al = alightL.get(i)!;
        const m = l.stops.length;
        const comp = new Float64Array(m); // on board, by stop boarded
        let total = 0;
        for (let k = 0; k < m; k++) {
          const sk = at.get(l.stops[k])!;
          const x = delta(al[k]);
          if (x > 0 && total > 0) {
            const share = Math.min(1, x / total);
            for (let q = 0; q < k; q++) {
              if (!comp[q]) continue;
              const v = comp[q] * share;
              const sq = at.get(l.stops[q])!;
              R.rides[sq * n + sk] += v;
              R.pairs[sq * n + sk] += v * fresh(sq) * final(sk);
              comp[q] -= v;
            }
            total -= Math.min(total, x);
          }
          const y = delta(b[k]);
          if (y > 0) (comp[k] += y), (total += y);
        }
      }
    }
    for (const a of tracked) prev[a] = lv[a];
  }
  return Object.assign(res, { linkVol: solver.linkVol });
}

// ---------- the reference stations (reference/regional-od.json) and the model's flows between them ----------

export const REGIONAL_FEEDS = ['bart', 'caltrain'] as const;
export type RegionalFeed = (typeof REGIONAL_FEEDS)[number];
/** stations inside the city: a trip using one has an end in San Francisco, which the model carries */
export const CITY_STATIONS: Record<RegionalFeed, string[]> = {
  bart: ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB'],
  caltrain: ['San Francisco', '22nd Street'],
};

export interface RegionalRef {
  bart: { codes: string[]; od: Record<DayType, Record<TPeriod, number[][]>> };
  caltrain: { stations: string[]; groups: { name: string; stations: string[] }[]; boardings: number[]; od: Record<DayType, Record<TPeriod, number[][]>>; surveyGroups: { names: string[]; matrix: number[][] } };
}
export const readRegional = (): RegionalRef => JSON.parse(fs.readFileSync(`${REFERENCE}/regional-od.json`, 'utf8'));

/**
 * The direction of Caltrain commuting at the city's stations (San Francisco, 22nd Street; journeys
 * between them left out), from the reference matrix (the 2024 OD survey at FY2026 volumes, each journey
 * timed by the 2025 customer survey's boarding times and raked to the riders by direction and period):
 *  - arrivalsAM: weekday journeys from outside stations arriving there 6–10am (in-commuters, mostly);
 *    calibrate.ts fits calib.caltrainEnd to it;
 *  - departuresAM: journeys leaving them for outside stations 6–10am (the reverse commute); calibrate.ts
 *    fits calib.caltrainAct to it;
 *  - departAmShare: the morning's share of the journeys leaving them.
 */
export function caltrainCityDirection(ref: RegionalRef = readRegional()): { arrivalsAM: number; departuresAM: number; departAmShare: number } {
  const R = ref.caltrain;
  const city = R.stations.map((n, i) => (CITY_STATIONS.caltrain.includes(n) ? i : -1)).filter((i) => i >= 0);
  const out = (i: number) => !city.includes(i);
  const from = (p: TPeriod) => city.reduce((a, i) => a + R.od.wkd[p][i].reduce((x, v, j) => x + (out(j) ? v : 0), 0), 0);
  const to = (p: TPeriod) => R.od.wkd[p].reduce((a, row, j) => a + (out(j) ? city.reduce((x, i) => x + row[i], 0) : 0), 0);
  return { arrivalsAM: to('AM'), departuresAM: from('AM'), departAmShare: from('AM') / TPERIODS.reduce((a, p) => a + from(p), 0) };
}

/** the reference stations of each feed as bundle stop indices (-1 if the bundle has no such stop) */
export function regionalStops(b: Bundle, ref: RegionalRef): Record<RegionalFeed, { names: string[]; stops: number[] }> {
  const S = b.header.stops;
  const ct = (name: string) =>
    S.findIndex((s) => s.feed === 'caltrain' && (s.name.replace(/ (Caltrain )?Station$/, '') === name || (name === 'California Ave' && /^California Ave/.test(s.name)) || (name === 'Millbrae' && /^Millbrae/.test(s.name))));
  return {
    bart: { names: ref.bart.codes, stops: ref.bart.codes.map((c) => S.findIndex((s) => s.id === `bart:${c}`)) },
    caltrain: { names: ref.caltrain.stations, stops: ref.caltrain.stations.map(ct) },
  };
}

/**
 * The model's journeys between the reference stations on BART and Caltrain, by period: [i][j] in the
 * reference order (gate to gate, no change of train; see stationPairs).
 */
export function modelRegionalPairs(b: Bundle, calib: Calibration, day: DayType, demand: { transitOD: Record<TPeriod, Float32Array> }, crowd: RunResult['finalCrowd'] | undefined, ref: RegionalRef) {
  const sc = { name: 'Today', edits: [], day };
  const st = regionalStops(b, ref);
  const out = {} as Record<RegionalFeed, Record<TPeriod, number[][]>>;
  for (const f of REGIONAL_FEEDS) out[f] = {} as Record<TPeriod, number[][]>;
  for (const p of TPERIODS) {
    const net0 = buildNet(b, sc, p, calib);
    const cr = crowd?.[p] ? net0.lines.map((l) => (l.src >= 0 && [1, 2, 4].some((m) => crowd[p][l.src]?.length === m * l.stops.length - 1) ? crowd[p][l.src] : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1))) : undefined;
    const net = cr ? buildNet(b, sc, p, calib, cr) : net0;
    const res = stationPairs(net, demand.transitOD[p], net.nZones, [...REGIONAL_FEEDS]);
    for (const f of REGIONAL_FEEDS) {
      const R = res[f], n = R.stops.length;
      const at = new Map(R.stops.map((s, i) => [s, i]));
      const ids = st[f].stops;
      out[f][p] = ids.map((a) => ids.map((c) => {
        const i = at.get(a), j = at.get(c);
        return i === undefined || j === undefined ? 0 : R.pairs[i * n + j];
      }));
    }
  }
  return out;
}

/**
 * Caltrain's extra riders from Giants home games on the average weekday (calibrate.ts GIANTS_CALTRAIN):
 * the weekday systemwide difference between home and away game days (FY2026, caltrain-ridership.json)
 * times the weekday home games over the weekdays of the year (special-events.json: each slot's weekday
 * attendance over its average-weekday attendance gives the weekdays).
 */
export function giantsCaltrain(
  c: { weekdayAway: number; weekdayHome: number } = JSON.parse(fs.readFileSync(`${REFERENCE}/caltrain-ridership.json`, 'utf8')).systemwide.giantsGameDayFY2026,
  venues: { name: string; slots: { kind: string; weekdayEvents: number; weekdayAttendance: number; year: number }[] }[] = JSON.parse(fs.readFileSync(`${REFERENCE}/special-events.json`, 'utf8')).venues,
) {
  const games = venues.find((x) => x.name === 'Oracle Park')!.slots.filter((s) => s.kind !== 'concert');
  const n = games.reduce((a, s) => a + s.weekdayEvents, 0);
  const weekdays = games.reduce((a, s) => a + s.weekdayAttendance, 0) / games.reduce((a, s) => a + s.year, 0);
  const perGame = c.weekdayHome - c.weekdayAway;
  return { perGame, games: n, weekdays, perWeekday: (perGame * n) / weekdays };
}
