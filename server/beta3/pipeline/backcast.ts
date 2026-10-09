/**
 * Step 12: a backcast, the held-out test of what the tool is for (predicting change). The calibrated
 * model is run, unchanged, on the June 2024 Muni schedule with the conditions of July 2024 (office
 * attendance downtown, employed residents, jobs, population, hotel visitors, SFO passengers, the price
 * of gasoline, Muni's fare, and Clipper's transfer discount: reference/backcast-drivers.json, each
 * fixed from published series before the run), and on today's network and conditions. Two things are
 * compared with SFMTA's counts of July 2024 and July 2026: the system's growth, and each route's change
 * relative to the system. (August is left out: the Twin Peaks Tunnel was closed August 22–29, 2024,
 * with the K, L, and M replaced by buses; research/metro-2024-2026.md. The first version compared
 * July–August and was revised after its results were seen.) The growth is split by condition: the
 * 2024 network alone, then each condition alone added to it. Nothing here was used to build or
 * calibrate the model.
 *
 * Needs: BETA3_VARIANT=2024 transit.ts, skims.ts and build.ts (data/beta3/work/sf-2024.bin.gz).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/backcast.ts
 * The runs (14) are kept in WORK/backcast-runs; --only=today,full,network,second,bart,<condition>,...
 * makes just those, so several processes can share the work before the last call assembles it.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import type { Bundle, DemandContext, RunResult, Scenario } from '../../../shared/beta3/types';
import { BUNDLE, RAW, REFERENCE, WORK } from './paths';

const load = (f: string) => decodeBundle(zlib.gunzipSync(fs.readFileSync(f)));

/** routes compared as one: the 6 and 21 (merged June 21, 2025). The K and T are compared apart: their
 * interline ended January 7, 2023, and ran again only for APEC and a 2025 subway closure, outside
 * both windows. The L has no 2024 count (it ran as the LBUS bus substitute, which SFMTA reported
 * under "Other"); the model's 2024 network has the LBUS too, so the K and M carry its West Portal
 * transfers in both. */
const routeKey = (r: string) => (r === 'KT' ? 'K/T' : r === '6' || r === '21' ? '6/21' : r);
/** the comparison as first specified: the K and T as one route (and July–August counts) */
const routeKeyKT = (r: string) => (r === 'K' || r === 'T' || r === 'KT' ? 'K/T' : routeKey(r));
type Key = (r: string) => string;

function routeTotals(b: Bundle, r: RunResult, key: Key = routeKey) {
  const out = new Map<string, number>();
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = b.header.lines[l.line];
    if (bl.feed !== 'muni') continue;
    const k = key(bl.route);
    out.set(k, (out.get(k) ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0));
  }
  return out;
}
function scheduledRuns(b: Bundle, key: Key = routeKey) {
  const out = new Map<string, number>();
  for (const l of b.header.lines) {
    if (l.feed !== 'muni') continue;
    const k = key(l.route);
    out.set(k, (out.get(k) ?? 0) + Object.values(l.periods).reduce((a, p) => a + (p?.trips ?? 0), 0));
  }
  return out;
}

/** SFMTA weekday averages by route for the given months */
function observed(months: string[], key: Key = routeKey) {
  const text = fs.readFileSync(`${RAW}/obs/muni_ridership_by_route.csv`, 'utf8').replace(/^﻿/, '');
  const rows = text.trim().split('\n').slice(1);
  const acc = new Map<string, number[]>();
  for (const line of rows) {
    const m = line.match(/^([^,]+),([^,]+),([^,]*),([^,]+),"?([\d,]+)"?/);
    if (!m) continue;
    const [, month, label, , day, val] = m;
    if (day !== 'Weekday' || !months.includes(month)) continue;
    const route = key(label.split(' ')[0]);
    const v = Number(val.replace(/,/g, ''));
    if (!acc.has(route)) acc.set(route, []);
    acc.get(route)!.push(v);
  }
  // routes counted together (K and T, reported apart from 2025; the 6 and 21, merged in June 2025):
  // add them within each month, then average the months
  const out = new Map<string, number>();
  for (const [k, vs] of acc) out.set(k, k.includes('/') ? vs.reduce((a, v) => a + v, 0) / months.length : vs.reduce((a, v) => a + v, 0) / vs.length);
  return out;
}

/** the second run's inputs: Kastle office attendance downtown and hotel occupancy, nothing else */
function secondRunContext(): DemandContext {
  const j = JSON.parse(fs.readFileSync(`${REFERENCE}/backcast-inputs.json`, 'utf8'));
  const mean = (o: Record<string, number | { pct: number }>, re: RegExp) => {
    const v = Object.entries(o).filter(([k]) => re.test(k)).map(([, x]) => (typeof x === 'number' ? x : x.pct));
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  const k = j.officeAttendance.weekly, h = j.hotelOccupancy.weekly4wkMA;
  // July of each year, as the counts
  const office = mean(k, /^2024-07/) / mean(k, /^2026-07/);
  const hotel = mean(h, /^2024-07/) / mean(h, /^2026-07/);
  return { attendanceCore: office, visitors: hotel };
}

/** downtown attendance from BART's exits at the four downtown stations, July 2024 against July 2026 (a sensitivity, chosen after the second run) */
function bartDowntown(): number {
  const j = JSON.parse(fs.readFileSync(`${REFERENCE}/backcast-inputs.json`, 'utf8'));
  const e = j.bartExits.periods as Record<string, Record<string, number>>;
  const dt = (per: string) => ['EMBR', 'MONT', 'POWL', 'CIVC'].reduce((a, c) => a + e[per][c], 0);
  return dt('2024-07') / dt('2026-07');
}

/** July 2024's conditions, fixed in advance in backcast-drivers.json: the drivers in the order reported */
const DRIVERS = ['attendanceCore', 'employedResidents', 'jobs', 'residents', 'visitors', 'airPassengers', 'gasPrice', 'muniFare', 'transferDiscount'] as const;
function pastDrivers(): { ctx: DemandContext; one: Record<string, DemandContext> } {
  const d = JSON.parse(fs.readFileSync(`${REFERENCE}/backcast-drivers.json`, 'utf8')).drivers as Record<string, { value: number; toMuniOnly?: boolean }>;
  const one: Record<string, DemandContext> = {};
  for (const k of DRIVERS) one[k] = k === 'transferDiscount' ? { transferDiscount: d[k].value, transferDiscountMuniOnly: !!d[k].toMuniOnly } : { [k]: d[k].value };
  const ctx = Object.assign({}, ...Object.values(one)) as DemandContext;
  return { ctx, one };
}

async function main() {
  const today = load(`${BUNDLE}/sf.bin.gz`);
  const past = load(`${WORK}/sf-2024.bin.gz`);
  const calib = today.header.calibration!;
  past.header.calibration = calib;
  // each run's Muni boardings are kept in the work folder by bundle and conditions, so the runs can
  // be spread over processes (--only=name,...) and the last one assembles them
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  fs.mkdirSync(`${WORK}/backcast-runs`, { recursive: true });
  const run = async (b: Bundle, context?: DemandContext, name = 'run'): Promise<RunResult> => {
    const key = JSON.stringify([b.header.built, calib.report?.length ?? 0, context ?? null]);
    const file = `${WORK}/backcast-runs/${name}.json`;
    if (fs.existsSync(file)) {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c.key === key) return { lines: c.lines } as RunResult;
    }
    if (only && !only.includes(name)) throw new Error(`run ${name} not cached`);
    const sc: Scenario = { name: 'backcast', edits: [], context };
    const r = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 2 }, prepare(b));
    const lines = r.lines.map((l) => ({ line: l.line, boardings: l.boardings }));
    fs.writeFileSync(file, JSON.stringify({ key, lines }));
    console.log(`  ran ${name}`);
    return { lines } as RunResult;
  };
  if (only) {
    const { ctx, one } = pastDrivers();
    const plan: Record<string, () => Promise<RunResult>> = {
      today: () => run(today, undefined, 'today'),
      full: () => run(past, ctx, 'full'),
      network: () => run(past, undefined, 'network'),
      second: () => run(past, secondRunContext(), 'second'),
      bart: () => run(past, { ...ctx, attendanceCore: bartDowntown() }, 'bart'),
      ...Object.fromEntries(DRIVERS.map((k) => [k, () => run(past, one[k], k)])),
    };
    for (const n of only) await plan[n]();
    return;
  }
  // Demand in July 2024 relative to July 2026, set in advance from sources other than Muni's counts
  // (backcast-drivers.json): office attendance downtown, employed residents, jobs, population, hotel
  // visitors, SFO passengers, the price of gasoline, Muni's fare, and Clipper's transfer discount.
  const { ctx, one } = pastDrivers();
  console.log('2024 conditions:', JSON.stringify(ctx));
  console.time('runs');
  const rNow = await run(today, undefined, 'today');
  const rPast = await run(past, ctx, 'full');
  const res = compare(today, past, rNow, rPast, routeKey, ['July 2026'], ['July 2024']);
  const growth = (r: RunResult) => compare(today, past, rNow, r, routeKey, ['July 2026'], ['July 2024']);
  const pct = (g: number) => +(100 * (g - 1)).toFixed(2);
  const summary = (c: ReturnType<typeof compare>) => ({ systemGrowthModel: c.systemGrowthModel, weightedCorrelationOfChange: c.weightedCorrelationOfChange, meanAbsErrorOfChange: c.meanAbsErrorOfChange.model });
  // the growth each driver accounts for: the 2024 network with that condition alone, against the
  // network alone (log points, so they add up with the interactions)
  const net = growth(await run(past, undefined, 'network'));
  console.log(`network only: model ${pct(net.systemGrowthModel)}%`);
  const drivers: { key: string; value: number; growth: number; effectPts: number; weightedCorrelationOfChange: number; meanAbsErrorOfChange: number }[] = [];
  for (const k of DRIVERS) {
    const c = growth(await run(past, one[k], k));
    const effectPts = 100 * (Math.log(c.systemGrowthModel) - Math.log(net.systemGrowthModel));
    drivers.push({ key: k, value: (one[k] as Record<string, number>)[k], growth: c.systemGrowthModel, effectPts, weightedCorrelationOfChange: c.weightedCorrelationOfChange, meanAbsErrorOfChange: c.meanAbsErrorOfChange.model });
    console.log(`  ${k}: ${effectPts.toFixed(2)} points`);
  }
  const totalPts = 100 * Math.log(res.systemGrowthModel);
  const decomposition = {
    description: 'Model system growth 2024→2026 split by driver: the network alone, then each condition of July 2024 added alone to it (log points, ×100), and the interaction (the full run less the sum)',
    networkOnly: { growth: net.systemGrowthModel, effectPts: 100 * Math.log(net.systemGrowthModel), weightedCorrelationOfChange: net.weightedCorrelationOfChange, meanAbsErrorOfChange: net.meanAbsErrorOfChange.model },
    drivers,
    interactionPts: totalPts - 100 * Math.log(net.systemGrowthModel) - drivers.reduce((a, d) => a + d.effectPts, 0),
    totalPts,
    observedPts: 100 * Math.log(res.systemGrowthObserved),
  };
  // the second run's inputs on this model (the 'before'), and BART's downtown exits in place of Kastle's
  const before = summary(growth(await run(past, secondRunContext(), 'second')));
  const bartRatio = bartDowntown();
  const rBart = await run(past, { ...ctx, attendanceCore: bartRatio }, 'bart');
  console.timeEnd('runs');
  const bart = compare(today, past, rNow, rBart, routeKey, ['July 2026'], ['July 2024']);
  // the same runs scored as the comparison was first specified (July–August counts, K and T as one),
  // before the August 2024 tunnel closure was found
  const first = compare(today, past, rNow, rPast, routeKeyKT, ['July 2026', 'August 2026'], ['July 2024', 'August 2024']);
  const strip = ({ changed: _c, sameSign: _s, ...x }: ReturnType<typeof compare>) => x;
  const { rows: _r, ...firstSummary } = strip(first);
  const out = {
    description: 'Backcast: the model (calibrated on 2026) run on the June 2024 Muni schedule with the conditions of July 2024 (backcast-drivers.json); route-level change 2024→2026 relative to the system, and system growth, model vs SFMTA counts (weekdays, July of each year; August 2024 had a Twin Peaks Tunnel closure)',
    context: ctx,
    ...strip(res),
    decomposition,
    secondRunInputs: { description: 'The second run’s inputs (Kastle downtown attendance and hotel occupancy only) on this model', context: secondRunContext(), ...before },
    asFirstSpecified: { description: 'The same runs against July–August counts with the K and T as one route', ...firstSummary },
  };
  fs.writeFileSync(`${REFERENCE}/backcast-results.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`${BUNDLE}/backcast.json`, JSON.stringify(out));
  const outBart = { description: 'Backcast sensitivity: as backcast.json, with downtown attendance from BART’s four downtown stations instead of Kastle (chosen after the second run’s result was known)', context: { ...ctx, attendanceCore: bartRatio }, ...strip(bart) };
  fs.writeFileSync(`${REFERENCE}/backcast-results-bart.json`, JSON.stringify(outBart, null, 1));
  fs.writeFileSync(`${BUNDLE}/backcast-bart.json`, JSON.stringify(outBart));
  const { rows, changed, sameSign } = res;
  console.log(`routes ${rows.length}; system growth observed ${(100 * (res.systemGrowthObserved - 1)).toFixed(1)}%, model ${(100 * (res.systemGrowthModel - 1)).toFixed(1)}% (second run's inputs ${(100 * (before.systemGrowthModel - 1)).toFixed(1)}%, BART downtown ${(100 * (bart.systemGrowthModel - 1)).toFixed(1)}%)`);
  console.log(`weighted r of route change (relative to system): ${res.weightedCorrelationOfChange.toFixed(2)}; routes with >10% service change: ${changed.length}, direction right ${sameSign}`);
  console.log(`mean abs error of relative change: model ${(100 * res.meanAbsErrorOfChange.model).toFixed(1)}% vs a no-change forecast ${(100 * res.meanAbsErrorOfChange.noChangeForecast).toFixed(1)}%`);
  console.log(`  as first specified (July–August, K/T): r ${first.weightedCorrelationOfChange.toFixed(2)}, model ${(100 * first.meanAbsErrorOfChange.model).toFixed(1)}% vs ${(100 * first.meanAbsErrorOfChange.noChangeForecast).toFixed(1)}%`);
  for (const row of changed) console.log(`  ${row.route}: runs ${row.runs2024}→${row.runs2026}, observed ${(100 * row.obsRelChange).toFixed(0)}%, model ${(100 * row.modelRelChange).toFixed(0)}%`);
}

/** route-level change, model against counts, for one way of grouping routes and one window of months */
function compare(today: Bundle, past: Bundle, rNow: RunResult, rPast: RunResult, key: Key, nowMonths: string[], pastMonths: string[]) {
  const mNow = routeTotals(today, rNow, key), mPast = routeTotals(past, rPast, key);
  const sNow = scheduledRuns(today, key), sPast = scheduledRuns(past, key);
  const oNow = observed(nowMonths, key), oPast = observed(pastMonths, key);
  // routes counted in both years with riders in the model in both (owl-only routes get none: the night network is the evening's)
  const routes = [...oNow.keys()].filter((k) => oPast.has(k) && (mNow.get(k) ?? 0) > 0 && (mPast.get(k) ?? 0) > 0 && oNow.get(k)! > 300 && oPast.get(k)! > 300);
  const sum = (m: Map<string, number>) => routes.reduce((a, k) => a + m.get(k)!, 0);
  const growthObs = sum(oNow) / sum(oPast), growthMod = sum(mNow) / sum(mPast);
  const rows = routes.map((k) => {
    const obs = oNow.get(k)! / oPast.get(k)! / growthObs;
    const mod = mNow.get(k)! / mPast.get(k)! / growthMod;
    return { route: k, observed2024: Math.round(oPast.get(k)!), observed2026: Math.round(oNow.get(k)!), model2024: Math.round(mPast.get(k)!), model2026: Math.round(mNow.get(k)!), runs2024: sPast.get(k) ?? 0, runs2026: sNow.get(k) ?? 0, obsRelChange: obs - 1, modelRelChange: mod - 1 };
  });
  // agreement on the relative change, weighted by riders
  const w = rows.map((r) => r.observed2026);
  const x = rows.map((r) => Math.log(1 + r.modelRelChange)), y = rows.map((r) => Math.log(1 + r.obsRelChange));
  const W = w.reduce((a, v) => a + v, 0);
  const mx = x.reduce((a, v, i) => a + v * w[i], 0) / W, my = y.reduce((a, v, i) => a + v * w[i], 0) / W;
  let cov = 0, vx = 0, vy = 0;
  x.forEach((xi, i) => ((cov += w[i] * (xi - mx) * (y[i] - my)), (vx += w[i] * (xi - mx) ** 2), (vy += w[i] * (y[i] - my) ** 2)));
  const r = cov / Math.sqrt(vx * vy);
  // routes whose service changed by more than 10%: did the model get the direction of the change right?
  const changed = rows.filter((row) => row.runs2024 > 0 && Math.abs(row.runs2026 / row.runs2024 - 1) > 0.1);
  const sameSign = changed.filter((row) => Math.sign(row.modelRelChange) === Math.sign(row.obsRelChange)).length;
  const errNaive = rows.reduce((a, row) => a + Math.abs(row.obsRelChange) * row.observed2026, 0) / W;
  const errModel = rows.reduce((a, row) => a + Math.abs(row.obsRelChange - row.modelRelChange) * row.observed2026, 0) / W;
  return {
    systemGrowthObserved: growthObs,
    systemGrowthModel: growthMod,
    routes: rows.length,
    weightedCorrelationOfChange: r,
    serviceChangedRoutes: changed.length,
    directionCorrectShare: changed.length ? sameSign / changed.length : null,
    meanAbsErrorOfChange: { model: errModel, noChangeForecast: errNaive },
    rows: rows.sort((a, b) => b.observed2026 - a.observed2026),
    changed,
    sameSign,
  };
}

main();
