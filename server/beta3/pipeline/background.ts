/**
 * Background riders on BART and Caltrain: the operators' station-to-station journeys with neither
 * station in San Francisco (reference/regional-od.json), less the model's own journeys between the
 * same stations (San Francisco residents walking to Daly City or Bayshore, Peninsula riders changing to
 * BART at Millbrae), by period and day type. Journeys with a city station are left to the demand model.
 * Each pair's riders are put on the patterns that run between its stations that period, in proportion
 * to their trips (with a change of train where no pattern runs through), and stored as a load on each
 * hop of each pattern.
 *
 * Writes server/beta3/reference/background-loads.json (by pattern id and stop ids, so build.ts carries
 * it into a rebuilt bundle) and puts it into the bundle (BLine.bg). Run after a calibration; from
 * scratch run it twice, since the model's own journeys depend on the crowding the background adds.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/background.ts [--days wkd,sat,sun]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { periodService } from '../../../shared/beta3/net';
import { decodeResult } from '../../../shared/beta3/results';
import type { Bundle, DayType, TPeriod } from '../../../shared/beta3/types';
import { TPERIOD_HOURS, TPERIODS } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';
import { CITY_STATIONS, modelRegionalPairs, readRegional, REGIONAL_FEEDS, regionalStops, type RegionalFeed } from './station-od';

/** boarding penalty when routing background journeys between patterns, minutes (assumed) */
const BOARD_MIN = 10;

/**
 * Put journeys between stations (bundle stop indices) on a feed's patterns for one period and day:
 * returns the load on each hop of each bundle line, and riders that found no service.
 */
export function routeOnLines(b: Bundle, feed: string, p: TPeriod, day: DayType, trips: { a: number; c: number; v: number }[]) {
  const H = b.header;
  const lines = H.lines.map((l, i) => ({ l, i, s: periodService(l, p, day) })).filter((x) => x.l.feed === feed && x.s && x.s.trips > 0);
  const load = new Map<number, Float64Array>();
  for (const x of lines) load.set(x.i, new Float64Array(x.l.stops.length - 1));
  // ride edges between any two stops of a pattern, minutes: in-vehicle + half the pattern's headway + boarding
  const edges = new Map<number, Map<number, number>>();
  for (const x of lines) {
    const hw = (TPERIOD_HOURS[p] * 60) / x.s!.trips / 2;
    const st = x.l.stops, h = x.s!.hops;
    for (let ka = 0; ka < st.length; ka++) {
      let t = 0;
      for (let kb = ka + 1; kb < st.length; kb++) {
        t += h[kb - 1] / 60;
        const c = t + Math.min(hw, 30) + BOARD_MIN;
        const e = edges.get(st[ka]) ?? new Map<number, number>();
        if (c < (e.get(st[kb]) ?? Infinity)) e.set(st[kb], c);
        edges.set(st[ka], e);
      }
    }
  }
  const serve = (a: number, c: number) => lines.filter((x) => { const ka = x.l.stops.indexOf(a); return ka >= 0 && x.l.stops.indexOf(c, ka + 1) >= 0; });
  const put = (a: number, c: number, v: number) => {
    const cand = serve(a, c);
    const t = cand.reduce((s, x) => s + x.s!.trips, 0);
    for (const x of cand) {
      const ka = x.l.stops.indexOf(a), kc = x.l.stops.indexOf(c, ka + 1);
      const L = load.get(x.i)!;
      for (let k = ka; k < kc; k++) L[k] += (v * x.s!.trips) / t;
    }
    return t > 0;
  };
  let lost = 0;
  const byOrigin = new Map<number, { c: number; v: number }[]>();
  for (const t of trips) byOrigin.set(t.a, [...(byOrigin.get(t.a) ?? []), t]);
  for (const [a, ts] of byOrigin) {
    // shortest paths from a over the ride edges
    const dist = new Map([[a, 0]]), prev = new Map<number, number>(), open = new Set([a]);
    while (open.size) {
      let u = -1, du = Infinity;
      for (const v of open) if (dist.get(v)! < du) (du = dist.get(v)!), (u = v);
      open.delete(u);
      for (const [v, c] of edges.get(u) ?? []) if (du + c < (dist.get(v) ?? Infinity)) dist.set(v, du + c), prev.set(v, u), open.add(v);
    }
    for (const { c, v } of ts) {
      if (!dist.has(c)) {
        lost += v;
        continue;
      }
      for (let x = c; x !== a; x = prev.get(x)!) put(prev.get(x)!, x, v);
    }
  }
  return { load, lost };
}

async function main() {
  const i = process.argv.indexOf('--days');
  const days = (i > 0 ? process.argv[i + 1].split(',') : ['wkd', 'sat', 'sun']) as DayType[];
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const prep = prepare(b);
  const ref = readRegional();
  const st = regionalStops(b, ref);
  const outFile = `${REFERENCE}/background-loads.json`;
  const prevOut = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  const bgByLine = new Map<number, NonNullable<(typeof H.lines)[number]['bg']>>();
  const summary: Record<string, Record<string, Record<string, Record<string, number>>>> = {};
  for (const day of days) {
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/${day === 'wkd' ? 'base' : `base-${day}`}.bin.gz`)));
    const sc = { name: 'Today', edits: [], day };
    // two passes, so that demand sees the crowding the background riders add
    const r = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 2, warmCrowd: base.finalCrowd }, prep);
    const model = modelRegionalPairs(b, calib, day, r.demand, r.finalCrowd, ref);
    summary[day] = {};
    for (const f of REGIONAL_FEEDS) {
      const obsAll = ref[f].od[day];
      const names = st[f].names, stops = st[f].stops;
      const city = new Set(CITY_STATIONS[f as RegionalFeed]);
      summary[day][f] = {};
      for (const p of TPERIODS) {
        const trips: { a: number; c: number; v: number }[] = [];
        let obsOO = 0, modOO = 0, bg = 0, obsAllT = 0, modAllT = 0, missing = 0;
        names.forEach((x, a) =>
          names.forEach((y, c) => {
            const o = obsAll[p][a]?.[c] ?? 0, m = model[f][p][a][c];
            obsAllT += o;
            modAllT += m;
            if (a === c || city.has(x) || city.has(y)) return;
            obsOO += o;
            modOO += m;
            const v = Math.max(0, o - m);
            if (v <= 0) return;
            if (stops[a] < 0 || stops[c] < 0) return void (missing += v);
            bg += v;
            trips.push({ a: stops[a], c: stops[c], v });
          }),
        );
        const { load, lost } = routeOnLines(b, f, p, day, trips);
        for (const [li, L] of load) {
          if (!L.some((v) => v > 0.5)) continue;
          const e = bgByLine.get(li) ?? {};
          (e[day] ??= {})[p] = Array.from(L, (v) => Math.round(v));
          bgByLine.set(li, e);
        }
        summary[day][f][p] = { observedAll: Math.round(obsAllT), modelAll: Math.round(modAllT), observedNoCityEnd: Math.round(obsOO), modelNoCityEnd: Math.round(modOO), background: Math.round(bg - lost), noService: Math.round(lost + missing) };
      }
      console.log(day, f, JSON.stringify(summary[day][f]));
    }
  }
  // keep the days not rerun from the last file
  const lines = H.lines.map((l, li) => {
    const e = bgByLine.get(li) ?? {};
    const old = prevOut?.lines?.find((x: { id: string; stops: string[] }) => x.id === l.id && x.stops.join() === l.stops.map((s) => H.stops[s].id).join());
    for (const d of ['wkd', 'sat', 'sun'] as DayType[]) if (!days.includes(d) && old?.bg?.[d]) e[d] = old.bg[d];
    l.bg = Object.keys(e).length ? e : undefined;
    return l.bg ? { id: l.id, stops: l.stops.map((s) => H.stops[s].id), bg: l.bg } : null;
  }).filter(Boolean);
  const out = {
    generated: new Date().toISOString().slice(0, 10),
    method: 'Operators\' station-to-station journeys with neither station in San Francisco (regional-od.json), less the model\'s own journeys between the same stations, routed on the patterns running that period in proportion to their trips. Loads are riders per period on each hop of each pattern.',
    summary: { ...(prevOut?.summary ?? {}), ...summary },
    lines,
  };
  fs.writeFileSync(outFile, JSON.stringify(out));
  const { arrays: _a, ...header } = H;
  void _a;
  fs.writeFileSync(`${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log(`background on ${lines.length} patterns written to the bundle and ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
