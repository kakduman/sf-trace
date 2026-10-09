/**
 * Observed BART loads on each track segment, from the station-to-station weekday counts (every
 * trip routed on its shortest path through the network), against the model's loads.
 * Used by calibration (BART path preference) and validation.
 */
import fs from 'node:fs';
import type { Bundle, DayType, RunResult } from '../../../shared/beta3/types';
import { REFERENCE } from './paths';

export interface SegmentLoad {
  a: string;
  b: string;
  observed: number;
  /** all modeled riders, the background riders included */
  model: number;
  /** of which background riders (journeys with neither station in the city; background.ts) */
  background: number;
}

/** BART stations (bundle stop index) and their neighbours along the lines */
function bartGraph(b: Bundle) {
  const adj = new Map<number, Map<number, number>>();
  for (const l of b.header.lines.filter((l) => l.feed === 'bart'))
    for (let k = 0; k + 1 < l.stops.length; k++) {
      const a = l.stops[k], c = l.stops[k + 1];
      const S = b.header.stops;
      const km = Math.hypot(S[a].x - S[c].x, S[a].y - S[c].y);
      if (!adj.has(a)) adj.set(a, new Map());
      if (!adj.has(c)) adj.set(c, new Map());
      adj.get(a)!.set(c, km);
      adj.get(c)!.set(a, km);
    }
  return adj;
}

function path(adj: Map<number, Map<number, number>>, from: number, to: number): number[] {
  const dist = new Map([[from, 0]]), prev = new Map<number, number>();
  const open = new Set([from]);
  while (open.size) {
    let u = -1, du = Infinity;
    for (const v of open) if (dist.get(v)! < du) (du = dist.get(v)!), (u = v);
    open.delete(u);
    if (u === to) break;
    for (const [v, km] of adj.get(u) ?? []) if (du + km < (dist.get(v) ?? Infinity)) dist.set(v, du + km), prev.set(v, u), open.add(v);
  }
  const out = [to];
  for (let v = to; v !== from && prev.has(v); ) out.push((v = prev.get(v)!));
  return out.reverse();
}

const SEGS: [string, string][] = [['WOAK', 'EMBR'], ['EMBR', 'MONT'], ['MONT', 'POWL'], ['POWL', 'CIVC'], ['CIVC', '16TH'], ['16TH', '24TH'], ['24TH', 'GLEN'], ['GLEN', 'BALB'], ['BALB', 'DALY']];

/** observed and modelled loads (both directions, all day) on the San Francisco trunk and the Transbay Tube */
export function bartSegments(b: Bundle, r: Pick<RunResult, 'lines'>, day: DayType = 'wkd'): SegmentLoad[] {
  const bart = JSON.parse(fs.readFileSync(`${REFERENCE}/bart-ridership.json`, 'utf8'));
  const codes: string[] = bart.od.codes;
  const M: number[][] = bart.od.matrix;
  const idx = (c: string) => b.header.stops.findIndex((s) => s.id === `bart:${c}`);
  const adj = bartGraph(b);
  const key = (a: number, c: number) => (a < c ? `${a}-${c}` : `${c}-${a}`);
  const obs = new Map<string, number>();
  codes.forEach((o, i) =>
    codes.forEach((d, j) => {
      const n = M[i]?.[j] ?? 0;
      if (!n || i === j) return;
      const a = idx(o), c = idx(d);
      if (a < 0 || c < 0) return;
      const p = path(adj, a, c);
      for (let k = 0; k + 1 < p.length; k++) obs.set(key(p[k], p[k + 1]), (obs.get(key(p[k], p[k + 1])) ?? 0) + n);
    }),
  );
  const mod = new Map<string, number>(), bgm = new Map<string, number>();
  for (const lr of r.lines) {
    if (lr.line < 0) continue;
    const l = b.header.lines[lr.line];
    if (l.feed !== 'bart') continue;
    for (const loads of Object.values(lr.loads)) loads.forEach((v, k) => mod.set(key(l.stops[k], l.stops[k + 1]), (mod.get(key(l.stops[k], l.stops[k + 1])) ?? 0) + v));
    for (const [p, bg] of Object.entries(l.bg?.[day] ?? {})) if (lr.loads[p as keyof typeof lr.loads]) bg!.forEach((v, k) => bgm.set(key(l.stops[k], l.stops[k + 1]), (bgm.get(key(l.stops[k], l.stops[k + 1])) ?? 0) + v));
  }
  return SEGS.map(([a, c]) => ({ a, b: c, observed: Math.round(obs.get(key(idx(a), idx(c))) ?? 0), model: Math.round(mod.get(key(idx(a), idx(c))) ?? 0), background: Math.round(bgm.get(key(idx(a), idx(c))) ?? 0) }));
}
