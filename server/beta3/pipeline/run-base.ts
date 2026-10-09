/**
 * Run the model once in Node on the bundle and print a validation summary.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/run-base.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { PATH } from '../../../shared/beta3/params';
import type { Bundle, Calibration, Scenario } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';

/** the app's bundle, or another (BETA3_SF_BUNDLE=path/to/sf.bin.gz, e.g. to compare a diagnostic before and after a change) */
export function loadBundle(): Bundle {
  // BETA3_SF_BUNDLE (or BETA3_BUNDLE_FILE): another bundle (to compare builds side by side)
  const b = decodeBundle(zlib.gunzipSync(fs.readFileSync(process.env.BETA3_SF_BUNDLE ?? process.env.BETA3_BUNDLE_FILE ?? `${BUNDLE}/sf.bin.gz`)));
  // BETA3_FIXED_STATIONS=1: the assumed street-to-platform times, without the downtown BART stations' fitted ones
  if (process.env.BETA3_FIXED_STATIONS && b.header.calibration) delete b.header.calibration.stationSec;
  // BETA3_PATH='{"transferLogit":true}': path-choice settings for an experiment (shared/beta3/params.ts PATH)
  if (process.env.BETA3_PATH) Object.assign(PATH, JSON.parse(process.env.BETA3_PATH));
  return b;
}

export const DEFAULT_CALIB: Calibration = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0.3, outShare: 0.05, airportTrips: 30000, iterations: 0, report: [] };

export function validation(b: Bundle, r: Awaited<ReturnType<typeof runModel>>) {
  const H = b.header;
  const lines: string[] = [];
  const s = r.summary;
  const tot = Object.values(s.trips).reduce((a, v) => a + v, 0);
  const rtot = Object.values(s.residentTrips).reduce((a, v) => a + v, 0);
  lines.push(`trips/day ${Math.round(tot).toLocaleString()} (residents ${Math.round(rtot).toLocaleString()})`);
  lines.push(`resident shares: ${Object.entries(s.residentTrips).map(([m, v]) => `${m} ${((100 * v) / rtot).toFixed(1)}%`).join(', ')}`);
  lines.push(`boardings: ${Object.entries(s.boardings).map(([k, v]) => `${k} ${Math.round(v).toLocaleString()}`).join(', ')}; linked transit trips ${Math.round(s.transitTrips).toLocaleString()}`);
  // Muni routes
  const byRoute = new Map<string, number>();
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = H.lines[l.line];
    if (bl.feed !== 'muni') continue;
    const b2 = Object.values(l.boardings).reduce((a, v) => a + v, 0);
    byRoute.set(bl.route, (byRoute.get(bl.route) ?? 0) + b2);
  }
  const pairs = H.observed.muniRoutes.map((o) => [o.route, o.boardings, byRoute.get(o.route) ?? 0] as const);
  const obsT = pairs.reduce((a, p) => a + p[1], 0), modT = pairs.reduce((a, p) => a + p[2], 0);
  const rmse = Math.sqrt(pairs.reduce((a, p) => a + (p[2] - p[1]) ** 2, 0) / pairs.length);
  const mean = obsT / pairs.length;
  const mo = pairs.reduce((a, p) => a + p[1], 0) / pairs.length, mm = pairs.reduce((a, p) => a + p[2], 0) / pairs.length;
  const cov = pairs.reduce((a, p) => a + (p[1] - mo) * (p[2] - mm), 0), vo = pairs.reduce((a, p) => a + (p[1] - mo) ** 2, 0), vm = pairs.reduce((a, p) => a + (p[2] - mm) ** 2, 0);
  lines.push(`Muni routes: observed ${Math.round(obsT).toLocaleString()} vs model ${Math.round(modT).toLocaleString()}; %RMSE ${((100 * rmse) / mean).toFixed(0)}%, r² ${((cov * cov) / (vo * vm)).toFixed(2)}`);
  lines.push(
    '  ' +
      pairs
        .slice()
        .sort((a, b2) => b2[1] - a[1])
        .slice(0, 16)
        .map((p) => `${p[0]} ${(p[1] / 1000).toFixed(1)}k/${(p[2] / 1000).toFixed(1)}k`)
        .join(', '),
  );
  // BART in SF
  const sfBart = H.observed.bartStations.filter((st) => st.stop !== null && H.stops[st.stop].lat > 37.7 && H.stops[st.stop].lon < -122.38);
  const ex = sfBart.map((st) => [st.code, st.exits, r.stopOff[st.stop!]] as const);
  lines.push(`BART SF exits: observed ${Math.round(ex.reduce((a, p) => a + p[1], 0)).toLocaleString()} vs model ${Math.round(ex.reduce((a, p) => a + p[2], 0)).toLocaleString()}: ${ex.map((p) => `${p[0]} ${(p[1] / 1000).toFixed(1)}k/${(p[2] / 1000).toFixed(1)}k`).join(', ')}`);
  const ct = H.observed.caltrainStations.filter((st) => st.stop !== null && ['San Francisco', '22nd Street', 'Bayshore'].includes(st.name));
  lines.push(`Caltrain SF boardings: ${ct.map((st) => `${st.name} ${st.boardings}/${Math.round(r.stopOn[st.stop!])}`).join(', ')}`);
  lines.push(`work by segment: ${Object.entries(r.demand.workBySeg).map(([k, v]) => { const t = Object.values(v).reduce((a, x) => a + x, 0); return `${k}: ${Object.entries(v).map(([m, x]) => `${m} ${((100 * x) / t).toFixed(0)}`).join(' ')}`; }).join(' | ')}`);
  lines.push(`mean km: ${Object.entries(r.demand.meanKm).filter(([k]) => !k.endsWith('<5mi')).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}; avg transit trip ${s.avgTransitMin.toFixed(0)} min; VKT ${Math.round(s.vkt).toLocaleString()}`);
  // how far trips go as the calibration fits it (trip-lengths.ts): the mean of trips up to 5 miles and the share within half a mile
  lines.push(`mean km up to 5 mi: ${Object.entries(r.demand.meanKm).filter(([k]) => k.endsWith('<5mi')).map(([k, v]) => `${k.slice(0, -4)} ${v.toFixed(2)}`).join(', ')}`);
  lines.push(`within half a mile: ${Object.entries(r.demand.kmBands).map(([k, v]) => `${k} ${(100 * v[0]).toFixed(1)}%`).join(', ')}`);
  return lines;
}

async function main() {
  const b = loadBundle();
  const calib = b.header.calibration ?? DEFAULT_CALIB;
  const scenario: Scenario = { name: 'Today', edits: [] };
  const prep = prepare(b);
  console.time('run');
  const r = await runModel(b, scenario, calib, new LocalExecutor(b, scenario, calib), { iterations: 1, onProgress: (s) => process.stdout.write(`\r${s.padEnd(60)}`) }, prep);
  console.log();
  console.timeEnd('run');
  for (const l of validation(b, r)) console.log(l);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

/**
 * Where capacity at boarding binds in a run (model.ts boardingAvailability): riders left behind by
 * period, the routes and line stops that leave the most, and their share of the period's boardings.
 */
export function capacitySummary(b: Bundle, r: Awaited<ReturnType<typeof runModel>>, top = 40) {
  const H = b.header;
  const P = ['AM', 'MD', 'PM', 'NT'] as const;
  const boardings = Object.fromEntries(P.map((p) => [p, r.lines.reduce((a, l) => a + l.boardings[p], 0)])) as Record<(typeof P)[number], number>;
  const name = (x: { p: (typeof P)[number]; line: number }) => {
    const l = r.nets[x.p].lines[x.line];
    const bl = l.src >= 0 ? H.lines[l.src] : null;
    return { feed: l.feed, route: l.route, mode: l.mode, headsign: bl?.headsign ?? '', dir: bl?.dir ?? 0 };
  };
  const stops = r.capacity.stops
    .slice()
    .sort((a, c) => c.leftBehind - a.leftBehind)
    .slice(0, top)
    .map((x) => {
      const l = r.nets[x.p].lines[x.line];
      const st = l.stops[x.k] < H.stops.length ? H.stops[l.stops[x.k]] : null;
      return { p: x.p, ...name(x), stop: st?.name ?? 'new stop', on: Math.round(x.on), through: Math.round(x.through), capacity: Math.round(x.capTrips), avail: +x.avail.toFixed(3), leftBehind: Math.round(x.leftBehind), overCap: Math.round(x.overCap) };
    });
  // by route, direction, and period
  const byRoute = new Map<string, { p: string; feed: string; route: string; mode: string; headsign: string; leftBehind: number; boardings: number; stops: number }>();
  for (const x of r.capacity.stops) {
    const n = name(x);
    const key = `${n.feed}|${n.route}|${n.headsign}|${x.p}`;
    const e = byRoute.get(key) ?? { p: x.p, feed: n.feed, route: n.route, mode: n.mode, headsign: n.headsign, leftBehind: 0, boardings: 0, stops: 0 };
    e.leftBehind += x.leftBehind;
    e.stops++;
    byRoute.set(key, e);
  }
  for (const e of byRoute.values())
    e.boardings = r.lines.reduce((a, l) => (l.line >= 0 && H.lines[l.line].feed === e.feed && H.lines[l.line].route === e.route && (H.lines[l.line].headsign ?? '') === e.headsign ? a + l.boardings[e.p as (typeof P)[number]] : a), 0);
  const routes = [...byRoute.values()].sort((a, c) => c.leftBehind - a.leftBehind).slice(0, top).map((e) => ({ ...e, leftBehind: Math.round(e.leftBehind), boardings: Math.round(e.boardings), share: e.boardings > 0 ? +(e.leftBehind / e.boardings).toFixed(4) : 0 }));
  // by kind of service, over every line stop where anyone is left behind
  const group = (feed: string, mode: string) =>
    feed === 'muni' ? (mode === 'lightrail' ? 'muniMetro' : mode === 'cablecar' ? 'cableCar' : mode === 'streetcar' ? 'streetcar' : 'muniBus') : mode === 'ferry' ? 'ferry' : feed === 'bart' || feed === 'caltrain' ? feed : 'regionalBus';
  const byGroup: Record<string, number> = {};
  for (const x of r.capacity.stops) {
    const n = name(x);
    const g = group(n.feed, n.mode);
    byGroup[g] = (byGroup[g] ?? 0) + x.leftBehind;
  }
  const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
  return { leftBehind: round(r.capacity.leftBehind), overCap: round(r.capacity.overCap), boardings: round(boardings), byGroup: round(byGroup), convergence: r.convergence, routes, stops };
}
