/**
 * A quick experiment: one run of the model as it stands in this checkout (code and bundle, with the
 * bundle's calibration), warm-started from the saved base run's crowding, scored against the counts
 * that matter. Minutes, not hours: use it to compare a change against the unchanged code before
 * anything is recalibrated. Calibrated totals will drift when a change moves them; read the pattern
 * (route fit, station split, the T) more than the levels.
 * With --refit N, the destination-choice distance terms (and the stop detour terms) are first refitted
 * in N quick demand passes to the NHTS trip lengths calibrate.ts fits them to, so a change to size
 * terms or to the distance form is compared at the trip lengths the calibration would restore.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/experiment.ts [label] [--passes 2] [--refit 4] [--json out.json] [--set reliabilityRatio=0,observedOps=false] [--path '{"transferPenalty": 8}'] [--base-bundle old-sf.bin.gz] [--no-capacity] [--beta 4] [--synpop off|households|persons] [--demand personShares=0]
 * (--no-capacity: without capacity at boarding, crowding discomfort only, as before it was added)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DEMAND_OPTS, DIST_FORM, SIZE, SYNPOP, TRIP_MIX, computeDemand, fitEventTransit, fitStudents, ABM, ABM_COLS, type SynpopMode } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS, lotLoads, prepare, runModel } from '../../../shared/beta3/model';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { decodeResult } from '../../../shared/beta3/results';
import { toXY } from '../../../shared/beta3/geo';
import type { Scenario } from '../../../shared/beta3/types';
import { CAPACITY, PATH, UNDERREPORT } from '../../../shared/beta3/params';
import { lepShares } from './language';
import { BUNDLE, REFERENCE } from './paths';
import { accessShares, regionalDiag } from './regional-diag';
import { capacitySummary, loadBundle } from './run-base';
import { RecordingExecutor } from './experiment-exec';
import { bartSegments } from './bart-segments';
import { caltrainCityDirection } from './station-od';
import { caltrainPeaks, caltrainSegments } from './caltrain-segments';
import { describeTrace, traceRun } from './transfers';
import { microReport } from './micromob-validate';
import { fitLengths, lengthTargets } from './trip-lengths';
import { DISTRICTS, zoneDistricts } from './od-checks';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

function stats(pairs: { obs: number; mod: number }[]) {
  const n = pairs.length, mo = pairs.reduce((a, p) => a + p.obs, 0) / n, mm = pairs.reduce((a, p) => a + p.mod, 0) / n;
  let cov = 0, vo = 0, vm = 0, se = 0, w25 = 0;
  for (const p of pairs) {
    cov += (p.obs - mo) * (p.mod - mm);
    vo += (p.obs - mo) ** 2;
    vm += (p.mod - mm) ** 2;
    se += (p.mod - p.obs) ** 2;
    if (Math.abs(p.mod / p.obs - 1) <= 0.25) w25++;
  }
  return { n, total: (mm * n) / (mo * n), r: cov / Math.sqrt(vo * vm), pctRmse: (100 * Math.sqrt(se / n)) / mo, within25: w25 / n };
}

async function main() {
  const label = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'experiment';
  TRIP_MIX.on = true;
  const passes = Number(arg('--passes', '2'));
  // --set key=value[,key=value]: override path-choice settings (PATH) for this run
  for (const kv of arg('--set', '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!(k in PATH)) throw new Error(`unknown PATH setting ${k}`);
    const cur = (PATH as Record<string, unknown>)[k];
    (PATH as Record<string, unknown>)[k] = typeof cur === 'number' || cur === null ? Number(v) : typeof cur === 'boolean' ? v === 'true' : v;
    console.log(`PATH.${k} = ${(PATH as Record<string, unknown>)[k]}`);
  }
  // --path '{"transferPenalty": 8}': try path-choice settings without editing params.ts
  const po = arg('--path', '');
  if (po) Object.assign(PATH, JSON.parse(po));
  if (process.argv.includes('--no-capacity')) CAPACITY.on = false;
  CAPACITY.beta = Number(arg('--beta', String(CAPACITY.beta)));
  const b = loadBundle();
  const H = b.header;
  // --underreport '{"tours":[[1.25,1],[1,1],[1,1]],"lep":1.5}': survey underreporting factors (params.ts UNDERREPORT)
  const ur = arg('--underreport', '');
  if (ur) {
    Object.assign(UNDERREPORT, JSON.parse(ur));
    if (UNDERREPORT.lep !== 1) UNDERREPORT.lepShare = lepShares(b);
    console.log(`underreporting: tours ${JSON.stringify(UNDERREPORT.tours)}, limited-English ×${UNDERREPORT.lep}`);
  }
  // --calib '{"ivtFactor":{"feed:ac":0.5}}': try a calibration value without recalibrating (merged one level deep)
  const calib = JSON.parse(JSON.stringify(H.calibration!)) as NonNullable<typeof H.calibration>;
  const over = arg('--calib', '');
  if (over) for (const [k, v] of Object.entries(JSON.parse(over))) (calib as unknown as Record<string, unknown>)[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...((calib as unknown as Record<string, unknown>)[k] as object), ...(v as object) } : v;
  // --bias 0: run without the calibrated rail-against-bus path bias (to test whether the model needs it)
  if (process.argv.includes('--bias')) {
    const v = Number(arg('--bias', '0'));
    calib.modeBias = { ...calib.modeBias, lightrail: Math.max(0, -v), bus: Math.max(0, v), rapid: Math.max(0, v), trolley: Math.max(0, v) };
  }
  // variants without code edits: --size storefrontWeight=0,hotelJobsPerRoom=0 and --events 0
  for (const kv of arg('--size', '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    (SIZE as Record<string, number>)[k] = Number(v);
  }
  // --demand personShares=0: demand options (DEMAND_OPTS) off or on
  for (const kv of arg('--demand', '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!(k in DEMAND_OPTS)) throw new Error(`unknown demand option ${k}`);
    (DEMAND_OPTS as Record<string, boolean>)[k] = v === '1' || v === 'true';
  }
  // --events 0 drops the special events; --event-month aug2026 takes August 2026's (the BART counts' month)
  const context = { events: Number(arg('--events', '1')), eventMonth: arg('--event-month', 'year') as 'year' | 'aug2026' };
  DIST_FORM.form = arg('--dist', DIST_FORM.form) as typeof DIST_FORM.form;
  // --synpop households|persons: demand's segments from the synthetic population (demand.ts SYNPOP)
  const sp = arg('--synpop', '');
  if (sp) SYNPOP.mode = sp as SynpopMode;
  // --abm off|on|observed: residents' tours by the aggregate rates, or by the person-level choices
  // (abm.ts) with chosen workplaces or the census flows' (default: the bundle's calibration)
  const ab = arg('--abm', '');
  if (ab) ((ABM.on = ab !== 'off'), (ABM.workplace = ab === 'observed' ? 'observed' : 'choice'));
  const refit = Number(arg('--refit', '0'));
  if (refit > 0) {
    // the trip lengths calibrate.ts fits (NHTS 2017, residents of dense tracts): means and near shares
    const LT = lengthTargets();
    const ex0 = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
    const sk: Record<string, unknown> = {};
    const lot0 = new Float32Array(H.stops.length);
    for (const [st, v] of Object.entries(calib.lotPrice ?? {})) lot0[Number(st)] = v;
    for (const p of SKIM_PERIODS) sk[p] = await ex0.skim(p, undefined, lot0.some((v) => v > 0) ? lot0 : undefined);
    const pr = prepare(b);
    for (let it = 0; it < refit; it++) {
      const d = computeDemand(b, pr, sk as never, calib, 'wkd', 1, undefined, context);
      const line = fitLengths(calib, d, LT, 0.2);
      console.log(`refit ${it + 1}: students ${fitStudents(calib, pr, d)}`);
      const ev = fitEventTransit(calib, b.header.events, d.eventModes);
      console.log(`refit ${it + 1}: events transit ${ev}`);
      console.log(`refit ${it + 1}: ${line}`);
    }
    const r3 = (o: Record<string, number> | undefined) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, +v.toFixed(3)])));
    console.log(`distCoef ${r3(calib.distCoef)} distLogCoef ${r3(calib.distLogCoef)} stopDistCoefs ${r3(calib.stopDistCoefs)} stopLogCoefs ${r3(calib.stopLogCoefs)}`);
  }
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  // --base-bundle <sf.bin.gz the base run was made with>: when the network's lines changed (a feed
  // added, patterns split), the saved crowding is matched to today's lines by operator, route,
  // direction, and stops, since it is kept by line index
  const bb = arg('--base-bundle', '');
  if (bb && base.finalCrowd) {
    const old = decodeBundle(zlib.gunzipSync(fs.readFileSync(bb))).header.lines;
    const key = (l: { feed: string; route: string; dir: number; stops: number[] }) => `${l.feed}|${l.route}|${l.dir}|${l.stops.join(',')}`;
    const now = new Map<string, number[]>();
    H.lines.forEach((l, i) => now.set(key(l), [...(now.get(key(l)) ?? []), i]));
    for (const p of Object.keys(base.finalCrowd) as (keyof typeof base.finalCrowd)[]) {
      const m: Record<number, Float32Array> = {};
      for (const [src, c] of Object.entries(base.finalCrowd[p] ?? {})) for (const i of now.get(key(old[Number(src)])) ?? []) m[i] = c;
      base.finalCrowd[p] = m;
    }
  }
  const sc: Scenario = { name: 'Today', edits: [], context };
  const t0 = Date.now();
  // wall time by stage (path searches for skims, demand, assignment), from the run's progress calls
  const timing: Record<string, number> = {};
  let stage = '', ts = Date.now();
  const onProgress = (s: string) => {
    const now = Date.now();
    if (stage) timing[stage] = (timing[stage] ?? 0) + (now - ts) / 1000;
    stage = /^Finding/.test(s) ? 'skims' : /^Choosing/.test(s) ? 'demand' : /^Loading/.test(s) ? 'assignment' : 'other';
    ts = now;
  };
  const exec = new RecordingExecutor(b, sc, calib);
  // park-and-ride prices: warm-started from a saved run's (--warm-lot file.json), else the base run's or the calibration's
  const wl = arg('--warm-lot', '');
  const warmLot = wl && fs.existsSync(wl) ? JSON.parse(fs.readFileSync(wl, 'utf8')) : base.finalLotPrice;
  const r = await runModel(b, sc, calib, exec, { iterations: passes, warmCrowd: base.finalCrowd, warmLot, onProgress }, prepare(b));
  onProgress('done');
  const sl = arg('--save-lot', '');
  if (sl) fs.writeFileSync(sl, JSON.stringify(r.finalLotPrice ?? {}));
  // --line-stops out.json: each bundle line's boardings by stop, summed over the periods (for route-by-stop checks)
  const ls = arg('--line-stops', '');
  if (ls) {
    const on: Record<number, number[]> = {};
    for (const [p, net] of Object.entries(r.nets)) {
      const v = r.volumes[p as keyof typeof r.volumes];
      if (!net || !v) continue;
      net.lines.forEach((l, li) => {
        if (l.src < 0) return;
        const row = (on[l.src] ??= new Array(l.stops.length).fill(0));
        for (let k = 0; k < l.stops.length && k < row.length; k++) row[k] += v.on[li][k] ?? 0;
      });
    }
    fs.writeFileSync(ls, JSON.stringify(on));
  }
  const { cars, room } = lotLoads(b, r.nets, exec.vols);
  const lots = (H.lots ?? []).map((l) => ({ name: H.stops[l.stop].name, feed: H.stops[l.stop].feed, spaces: l.spaces, cars: Math.round(cars[l.stop]), room: Number.isFinite(room[l.stop]) ? Math.round(room[l.stop]) : null, price: r.finalLotPrice?.[l.stop] ?? 0 })).sort((a, c) => c.cars - a.cars);
  const regional = regionalDiag(b, r.nets, exec.vols);
  const access = accessShares(b, r.nets, exec.vols);
  // the city's stations both ways (entries: the PM return through the downtown stations)
  const sfBoth = H.observed.bartStations.filter((st) => st.stop !== null && ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB', 'DALY'].includes(st.code)).map((st) => ({ code: st.code, exitsObs: st.exits, exitsMod: Math.round(r.stopOff[st.stop!]), entriesObs: st.entries, entriesMod: Math.round(r.stopOn[st.stop!]) }));
  // ferries by route (SF Bay Ferry FY2026, Larkspur estimated), as in validate.ts
  const ferryRows = (() => {
    const f = JSON.parse(fs.readFileSync(`${REFERENCE}/ferry-ridership.json`, 'utf8'));
    const sfbf = f.sfBayFerry.FY2026.routes as Record<string, { name: string; avgWeekday: number }>;
    const gg = f.goldenGateFerry.statisticsPage.byFY.FY2025;
    const obs: [string, string, number][] = [...['VJO', 'OA', 'SEA', 'HB', 'RCH'].map((x) => ['ferry', x, sfbf[x].avgWeekday] as [string, string, number]), ['ggt', 'LSSF', Math.round((gg.annualByRoute.Larkspur / gg.annualAll) * gg.avgWeekdayAll)]];
    const by = new Map<string, number>();
    for (const l of r.lines) {
      if (l.line < 0) continue;
      const bl = H.lines[l.line];
      if (bl.mode !== 'ferry') continue;
      by.set(`${bl.feed}:${bl.route}`, (by.get(`${bl.feed}:${bl.route}`) ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0));
    }
    return obs.map(([feed, route, o]) => ({ route, obs: o, mod: Math.round(by.get(`${feed}:${route}`) ?? 0) }));
  })();
  const ferry = stats(ferryRows);
  // AC Transit Transbay lines (FY2025 average weekday, AC Transit's route performance report)
  const acObs = JSON.parse(fs.readFileSync(`${REFERENCE}/station-parking.json`, 'utf8')).acTransbay.lines as Record<string, { fy2025_avgWeekday?: number }>;
  const acBy = new Map<string, number>();
  for (const l of r.lines) {
    if (l.line < 0 || H.lines[l.line].feed !== 'ac') continue;
    const k = H.lines[l.line].route;
    acBy.set(k, (acBy.get(k) ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0));
  }
  const acRows = Object.entries(acObs).filter(([, v]) => v.fy2025_avgWeekday).map(([route, v]) => ({ route, obs: v.fy2025_avgWeekday!, mod: Math.round(acBy.get(route) ?? 0) }));
  const ac = { ...stats(acRows), rows: acRows };
  // in-commuters' transit share by home PUMA (PUMAs with 100+ PUMS records): only the county is fitted
  const pums = JSON.parse(fs.readFileSync(`${REFERENCE}/in-commuters-pums.json`, 'utf8')).byPuma as { puma: string; county: string; workers: number; n: number; transit: number }[];
  const wz = r.demand.workInZone;
  const pumaRows = pums.filter((x) => x.n >= 100).map((x) => {
    let all = 0, tr = 0;
    H.ext.forEach((z, e) => {
      const w = z.puma?.[x.puma] ?? 0;
      all += w * wz[2 * e];
      tr += w * wz[2 * e + 1];
    });
    return { puma: x.puma, county: x.county, obs: x.transit / x.workers, mod: all > 0 ? tr / all : 0, trips: Math.round(all) };
  });
  const pumaFit = { ...stats(pumaRows.filter((x) => x.trips > 0)), rmsePts: Math.sqrt(pumaRows.reduce((a, x) => a + (x.mod - x.obs) ** 2, 0) / pumaRows.length) };
  // Muni routes
  const byRoute = new Map<string, number>();
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = H.lines[l.line];
    if (bl.feed !== 'muni') continue;
    byRoute.set(bl.route, (byRoute.get(bl.route) ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0));
  }
  const routes = H.observed.muniRoutes.map((o) => ({ route: o.route, obs: o.boardings, mod: byRoute.get(o.route) ?? 0 }));
  const muni = stats(routes);
  // the pattern alone: the model's routes scaled to the counted total of the 57 routes
  const kScale = routes.reduce((a, x) => a + x.obs, 0) / routes.reduce((a, x) => a + x.mod, 0);
  const muniScaled = stats(routes.map((x) => ({ obs: x.obs, mod: kScale * x.mod })));
  // Muni boardings by the district of the stop, as shares of the system, the model against SFMTA's
  // 2006–07 stop counts (TEP; muni-stop-ridership.json), both expressed at the model's Muni total
  const zDist = zoneDistricts(b);
  const nearestDist = (x: number, y: number) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < H.zones.length; i++) {
      const dd = (H.zones[i].x - x) ** 2 + (H.zones[i].y - y) ** 2;
      if (dd < bd) (bd = dd), (best = i);
    }
    return zDist[best];
  };
  const DN = DISTRICTS.map((x) => x[0]);
  const dMod = new Float64Array(DN.length), dTep = new Float64Array(DN.length);
  H.stops.forEach((st, i) => {
    if (st.feed === 'muni' && r.stopOn[i] > 0) dMod[nearestDist(st.x, st.y)] += r.stopOn[i];
  });
  for (const row of JSON.parse(fs.readFileSync(`${REFERENCE}/muni-stop-ridership.json`, 'utf8')).rows as { lat: number | null; lon: number | null; boardings: number }[])
    if (row.lat != null && row.lon != null) dTep[nearestDist(...toXY(row.lat, row.lon))] += row.boardings;
  const dModT = dMod.reduce((a, v) => a + v, 0), dTepT = dTep.reduce((a, v) => a + v, 0);
  const districts = DN.map((n, k) => ({ district: n, model: dMod[k], tep2006: (dTep[k] * dModT) / dTepT }));
  const sum = (f: (r: string) => boolean, k: 'obs' | 'mod') => routes.filter((x) => f(x.route)).reduce((a, x) => a + x[k], 0);
  const SUB = new Set(['J', 'K', 'L', 'M', 'N']), METRO = new Set(['J', 'K', 'L', 'M', 'N', 'T', 'S']);
  const groups = {
    subway: [sum((x) => SUB.has(x), 'obs'), sum((x) => SUB.has(x), 'mod')],
    T: [sum((x) => x === 'T', 'obs'), sum((x) => x === 'T', 'mod')],
    bus: [sum((x) => !METRO.has(x), 'obs'), sum((x) => !METRO.has(x), 'mod')],
  };
  // BART exits at the city's stations
  const sfBart = H.observed.bartStations.filter((st) => st.stop !== null && H.stops[st.stop].lat > 37.7 && H.stops[st.stop].lon < -122.38);
  const bart = sfBart.map((st) => ({ code: st.code, obs: st.exits, mod: r.stopOff[st.stop!] }));
  const bs = stats(bart);
  const ct = H.observed.caltrainStations.filter((st) => st.stop !== null && ['San Francisco', '22nd Street', 'Bayshore'].includes(st.name));
  const ctObs = ct.reduce((a, s) => a + s.boardings, 0), ctMod = ct.reduce((a, s) => a + r.stopOn[s.stop!], 0);
  // time of day: BART exits and entries at the eight city stations (Daly City left out, as in BART's
  // hourly reference) and Muni boardings, by period
  const P = ['AM', 'MD', 'PM', 'NT'] as const;
  const sf8 = sfBart.filter((st) => st.code !== 'DALY').map((st) => st.stop!);
  const shareOf = (f: (p: (typeof P)[number]) => number) => {
    const v = P.map(f), t = v.reduce((a, x) => a + x, 0);
    return Object.fromEntries(P.map((p, i) => [p, +(v[i] / t).toFixed(4)]));
  };
  // the direction of Caltrain commuting at the city's two stations (calibrate.ts fits the morning
  // arrivals; the morning share of departures, the reverse commute, is a test)
  const ctDir = caltrainCityDirection();
  const ctArrAM = ct.filter((s) => s.name !== 'Bayshore').reduce((a, s) => a + r.stopOffBy!.AM[s.stop!], 0);
  const tod = {
    bartExits: shareOf((p) => sf8.reduce((a, s) => a + r.stopOffBy![p][s], 0)),
    bartEntries: shareOf((p) => sf8.reduce((a, s) => a + r.stopOnBy![p][s], 0)),
    muni: shareOf((p) => r.lines.reduce((a, l) => a + (l.line >= 0 && H.lines[l.line].feed === 'muni' ? l.boardings[p] : 0), 0)),
    allTransitTrips: shareOf((p) => r.demand.transitOD[p].reduce((a, v) => a + v, 0)),
    // Caltrain boardings at San Francisco and 22nd Street by period (the reverse commute leaves in the
    // morning; the OD estimate's morning share is caltrainDirection.departAmShare)
    caltrainCity: shareOf((p) => ct.filter((s) => s.name !== 'Bayshore').reduce((a, s) => a + r.stopOnBy![p][s.stop!], 0)),
  };
  // morning peak: BART exits at the downtown stations, against each station's AM share of exits in
  // BART's hourly counts (October 2025, by entry hour 6–10am) times its daily count
  const hourly = JSON.parse(fs.readFileSync(`${REFERENCE}/time-of-day.json`, 'utf8')).bartSfStations.byStation as Record<string, { exitsDaily: number; exitsByPeriod: Record<string, number> }>;
  const bartAm = ['EMBR', 'MONT', 'POWL', 'CIVC'].map((code) => {
    const st = H.observed.bartStations.find((x) => x.code === code)!;
    const h = hourly[code];
    return { code, obs: Math.round((st.exits * h.exitsByPeriod.AM) / h.exitsDaily), mod: Math.round(r.stopOffBy!.AM[st.stop!]), obsShare: h.exitsByPeriod.AM / h.exitsDaily, modShare: r.stopOffBy!.AM[st.stop!] / r.stopOff[st.stop!] };
  });
  // the city's shuttles and the Treasure Island Ferry, by route (no counts to compare)
  const shuttles: Record<string, number> = {};
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = H.lines[l.line];
    if (bl.feed !== 'tma' && bl.feed !== 'shuttle') continue;
    shuttles[bl.route] = (shuttles[bl.route] ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0);
  }
  // trip length per boarding, against NTD (as validate.ts): Muni buses and Metro
  // (and Metro without the L Taraval, which ran as a bus from April 2020 to August 2024, so the NTD's
  // light rail of FY2021-FY2024 has no L)
  const len = { bus: [0, 0], LR: [0, 0], LRnoL: [0, 0] };
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = H.lines[l.line];
    if (bl.feed !== 'muni' || bl.mode === 'cablecar' || bl.mode === 'streetcar') continue;
    const on = Object.values(l.boardings).reduce((a, v) => a + v, 0), mi = l.passengerKm / 1.609;
    const g = bl.mode === 'lightrail' ? len.LR : len.bus;
    g[0] += on;
    g[1] += mi;
    if (bl.mode === 'lightrail' && bl.route !== 'L') (len.LRnoL[0] += on), (len.LRnoL[1] += mi);
  }
  const tripMiles = { bus: len.bus[1] / len.bus[0], metro: len.LR[1] / len.LR[0], metroWithoutL: len.LRnoL[1] / len.LRnoL[0] };
  // around the ballparks: Muni at King Street (2nd and 4th) and at the Chase Center platforms, Caltrain's terminal
  const stopSum = (re: RegExp, feed = 'muni') => {
    let on = 0, off = 0;
    H.stops.forEach((st, i) => {
      if (st.feed === feed && re.test(st.name)) ((on += r.stopOn[i]), (off += r.stopOff[i]));
    });
    return { on: Math.round(on), off: Math.round(off) };
  };
  const ballpark = {
    kingSt: stopSum(/^(King St & (2nd|4th) St|4th St & King St)$/),
    missionBay: stopSum(/^(UCSF \/ Chase Center|Third Street & Mission Rock St|UCSF Medical Center \(Mariposa\))/),
    caltrainSF: stopSum(/^San Francisco Caltrain Station$/, 'caltrain'),
  };
  const evm = r.demand.eventModes ?? {};
  const events = Object.fromEntries(
    Object.entries(evm).map(([v, m]) => {
      const tot = Object.values(m).reduce((a, x) => a + x, 0);
      return [v, { trips: Math.round(tot), transit: Math.round(m.transit), transitShare: +(m.transit / tot).toFixed(3) }];
    }),
  );
  // Caltrain's busiest stretches and BART's segments (loads include the background riders with no city end)
  const ctSegs = caltrainSegments(b, r);
  const ctPeaks = caltrainPeaks(ctSegs);
  const ctPk = ctSegs.filter((x) => x.period === 'AM' || x.period === 'PM');
  const bartSegs = bartSegments(b, r);
  const worst = routes.slice().sort((a, b2) => Math.abs(b2.mod - b2.obs) - Math.abs(a.mod - a.obs)).slice(0, 14);
  // where capacity at boarding binds: the line stops and routes leaving the most riders behind
  const cs = capacitySummary(b, r);
  // boardings after another vehicle (the on-board surveys' question), traced destination by destination
  // (--direct: also whether one line would have served the trips that change)
  const tt0 = Date.now();
  const transfers = traceRun(b, r.nets, r.demand.transitOD, { direct: process.argv.includes('--direct'), top: 400 });
  timing.transfers = (Date.now() - tt0) / 1000;
  const res = r.summary.residentTrips;
  // persons under 18 against BATS 2023 (as calibrate.ts fits them), and school and college trips by mode
  const youthTarget = (() => {
    const m = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8')).batsDashboardSF.tables.mode_label['2023 | Under 18 | All Income Levels'].modes as Record<string, { weightedShare: number }>;
    const g = (x: string) => m[x]?.weightedShare ?? 0;
    const t = { sr: g('DA') + g('HOV2') + g('HOV3') + g('TNC') + g('SCHBUS') + g('OTHER'), transit: g('WALKTRAN') + g('DRIVETRAN'), walk: g('WALK'), bike: g('BIKE') };
    const s = t.sr + t.transit + t.walk + t.bike;
    return Object.fromEntries(Object.entries(t).map(([x, v]) => [x, v / s]));
  })();
  const yt = r.demand.youthTrips, ytot = Object.values(yt).reduce((a, v) => a + v, 0);
  const youth = Object.fromEntries(['sr', 'transit', 'walk', 'bike'].map((x) => [x, [+((x === 'sr' ? yt.sr + yt.da + yt.tnc : yt[x as keyof typeof yt]) / ytot).toFixed(3), +youthTarget[x].toFixed(3)]]));
  // school tours by level: transit share, and the share living under a mile (straight line) from school
  const SSt = r.demand.schoolStats;
  const SD = r.demand.schoolDir;
  const legShare = (l: number, at: number, m: number) => (SD ? +(SD[l * 14 + at + m] / Math.max(1e-9, SD.slice(l * 14 + at, l * 14 + at + 6).reduce((a, v) => a + v, 0))).toFixed(3) : null);
  const schoolLevels = ['elementary', 'middle', 'high'].map((name, l) => ({ name, trips: Math.round(SSt[l * 10 + 9]), transit: +(SSt[l * 10 + 3] / SSt[l * 10 + 9]).toFixed(3), walk: +(SSt[l * 10 + 4] / SSt[l * 10 + 9]).toFixed(3), under1mi: +(SSt[l * 10 + 6] / SSt[l * 10 + 9]).toFixed(3), over2mi: +(SSt[l * 10 + 8] / SSt[l * 10 + 9]).toFixed(3), transitThere: legShare(l, 0, 3), transitHome: legShare(l, 6, 3), carThere: legShare(l, 0, 1), carHome: legShare(l, 6, 1) }));
  // college trips to SF State's campus (the Gator Pass zone) by mode, against its surveys
  const CM = r.demand.collegeModes;
  const campusModes = (z: number) => {
    const v = Array.from({ length: 6 }, (_, m) => CM[z * 6 + m]), t = v.reduce((a, x) => a + x, 0);
    return { trips: Math.round(t), shares: Object.fromEntries(['da', 'sr', 'tnc', 'transit', 'walk', 'bike'].map((m, i) => [m, +(v[i] / t).toFixed(3)])) };
  };
  const sfsuZ = H.zones.findIndex((z) => z.collegePass);
  const sfsu = sfsuZ >= 0 ? campusModes(sfsuZ) : null;
  // City College's Ocean campus: the zone of its IPEDS address (student-travel.json), against its 2018 survey's 48% by transit
  const ccsf = (() => {
    const inst = JSON.parse(fs.readFileSync(`${REFERENCE}/student-travel.json`, 'utf8')).ipeds.institutions.find((x: { name: string }) => x.name === 'City College of San Francisco');
    if (!inst) return null;
    const [x, y] = toXY(inst.lat, inst.lon);
    const z = H.zones.reduce((bi, q, i) => (Math.hypot(q.x - x, q.y - y) < Math.hypot(H.zones[bi].x - x, H.zones[bi].y - y) ? i : bi), 0);
    return campusModes(z);
  })();
  const studentTrips = Object.fromEntries(['school', 'univ'].map((p) => {
    const x = r.demand.byPurpose[p], t = Object.values(x).reduce((a, v) => a + v, 0);
    return [p, { trips: Math.round(t), transit: Math.round(x.transit), transitShare: +(x.transit / t).toFixed(3) }];
  }));
  const rt = Object.values(res).reduce((a, v) => a + v, 0);
  // shared bikes and scooters against the counts (micromob-validate.ts)
  const micro = microReport(b, sc, r, exec.vols);
  // the campuses: the share by transit of tour trips arriving at the zone of City College's Ocean
  // campus (50 Frida Kahlo Way; its 2018 survey: 48% of students by transit) and of SF State
  const campus = Object.fromEntries(
    ([['ccsfOcean', 37.72583, -122.45111], ['sfState', 37.72408, -122.4787]] as const).map(([name, lat, lon]) => {
      const [x, y] = toXY(lat, lon);
      const z = H.zones.reduce((bi, q, i) => (Math.hypot(q.x - x, q.y - y) < Math.hypot(H.zones[bi].x - x, H.zones[bi].y - y) ? i : bi), 0);
      const za = r.demand.zoneArrivals;
      return [name, { zone: H.zones[z].id, trips: Math.round(za[2 * z]), transitShare: +(za[2 * z + 1] / za[2 * z]).toFixed(3) }];
    }),
  );
  const out = {
    label,
    passes,
    minutes: (Date.now() - t0) / 60000,
    seconds: Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, +v.toFixed(1)])),
    muni: { ...muni, observed: routes.reduce((a, x) => a + x.obs, 0), model: routes.reduce((a, x) => a + x.mod, 0) },
    muniScaled: { ...muniScaled, factor: kScale },
    muniDistricts: districts,
    groups,
    bart: { ...bs, stations: bart },
    caltrain: { obs: ctObs, mod: ctMod, boardings: r.summary.boardings.caltrain ?? 0, peaks: ctPeaks, peakSegments: stats(ctPk.map((x) => ({ obs: x.observed, mod: x.model }))) },
    bartSegments: { rows: bartSegs, ...stats(bartSegs.map((x) => ({ obs: x.observed, mod: x.model }))) },
    tod,
    caltrainDirection: { arrivalsAM: [Math.round(ctArrAM), Math.round(ctDir.arrivalsAM)], departAmShare: [tod.caltrainCity.AM, +ctDir.departAmShare.toFixed(4)] },
    bartAm,
    calib: { regionalRate: calib.regionalRate, xferFactor: calib.xferFactor, tourRateFactor: calib.tourRateFactor, commuteBasis: calib.commuteBasis ?? 'stated' },
    shuttles,
    tripMiles,
    ballpark,
    events,
    campus,
    eventTransit: calib.eventTransit,
    // the refitted constants, for the diagnostics (diag-od.ts --from)
    refit: { distCoef: calib.distCoef, distLogCoef: calib.distLogCoef, stopDistCoefs: calib.stopDistCoefs, stopLogCoefs: calib.stopLogCoefs, eventTransit: calib.eventTransit },
    youth,
    studentTrips,
    schoolLevels,
    sfsu,
    ccsf,
    residentShares: Object.fromEntries(Object.entries(res).map(([m, v]) => [m, v / rt])),
    residentTrips: rt,
    byPurpose: r.demand.byPurpose,
    abm: r.demand.abm ? { byPtype: Array.from({ length: 8 }, (_, k) => Array.from(r.demand.abm!.byPtype.subarray(k * ABM_COLS, (k + 1) * ABM_COLS))), segments: r.demand.abm.segments, households: r.demand.abm.households } : null,
    rideHail: { trips: r.demand.trips.tnc, residents: res.tnc },
    vkt: r.demand.vkt,
    tripMix: r.demand.tripMix,
    tripMixTour: r.demand.tripMixTour,
    tripMixBack: r.demand.tripMixBack,
    tripMixStop: r.demand.tripMixStop,
    workIn: r.demand.workIn,
    workOut: r.demand.workOut,
    regional,
    lots,
    access,
    acTransbay: ac,
    pumaTransit: { ...pumaFit, rows: pumaRows },
    sfBart: sfBoth,
    ferry: { ...ferry, rows: ferryRows },
    capacity: { on: CAPACITY.on, ...cs },
    transitTrips: r.summary.transitTrips,
    transfers,
    micro,
    routes,
  };
  const k = (x: number) => `${(x / 1000).toFixed(1)}k`;
  console.log(`== ${label} (${passes} passes, ${out.minutes.toFixed(1)} min; seconds: ${Object.entries(out.seconds).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`Muni routes: r ${muni.r.toFixed(3)}, %RMSE ${muni.pctRmse.toFixed(1)}, within ±25% ${(100 * muni.within25).toFixed(0)}%, total ${k(out.muni.model)}/${k(out.muni.observed)}`);
  console.log(`Muni routes scaled to the counted total (×${kScale.toFixed(3)}): r ${muniScaled.r.toFixed(3)}, %RMSE ${muniScaled.pctRmse.toFixed(1)}, within ±25% ${(100 * muniScaled.within25).toFixed(0)}% | ${['T', '15', '14', '14R', '49', '8', '5', '5R', '45', '43', '1', '38R', '9', '30'].map((x) => { const y = routes.find((z) => z.route === x); return y ? `${x} ${k(kScale * y.mod)}/${k(y.obs)}` : ''; }).join(' ')}`);
  console.log(`Muni boardings by stop district (model / 2006–07 shares at the model's total): ${districts.map((x) => `${x.district} ${k(x.model)}/${k(x.tep2006)}`).join(', ')}`);
  console.log(`groups (model/count): subway ${k(groups.subway[1])}/${k(groups.subway[0])}, T ${k(groups.T[1])}/${k(groups.T[0])}, buses ${k(groups.bus[1])}/${k(groups.bus[0])}`);
  console.log(`BART city exits: total ${(100 * (bs.total - 1)).toFixed(1)}%, r ${bs.r.toFixed(3)}, %RMSE ${bs.pctRmse.toFixed(1)} | ${bart.map((x) => `${x.code} ${k(x.mod)}/${k(x.obs)}`).join(' ')}`);
  console.log(`BART AM exits downtown (model/count, AM share): ${bartAm.map((x) => `${x.code} ${k(x.mod)}/${k(x.obs)} ${(100 * x.modShare).toFixed(0)}/${(100 * x.obsShare).toFixed(0)}%`).join(' ')}; total ${k(bartAm.reduce((a, x) => a + x.mod, 0))}/${k(bartAm.reduce((a, x) => a + x.obs, 0))}`);
  console.log(`calibration: commute ${calib.commuteBasis ?? 'stated'}, regional visitors ${calib.regionalRate.toFixed(3)}, transfer factor ${calib.xferFactor?.toFixed(3)}, tour rate ×${calib.tourRateFactor?.toFixed(3)}`);
  console.log(`Caltrain city boardings ${k(ctMod)}/${k(ctObs)}; at SF and 22nd St, morning arrivals ${k(ctArrAM)}/${k(ctDir.arrivalsAM)} (fitted; Caltrain constants home end ${(calib.caltrainEnd ?? 0).toFixed(1)}, activity end ${(calib.caltrainAct ?? 0).toFixed(1)} min; in-vehicle factor ${(calib.ivtFactor?.caltrain ?? 0).toFixed(2)}), morning share of departures ${(100 * tod.caltrainCity.AM).toFixed(1)}%/${(100 * ctDir.departAmShare).toFixed(1)}%; residents' transit share ${(100 * (out.residentShares.transit ?? 0)).toFixed(1)}%`);
  console.log(`ride-hail trips ${k(r.demand.trips.tnc)} (residents' ${k(r.summary.residentTrips.tnc)}); VKT ${k(r.demand.vkt)}`);
  if (r.demand.tripMix)
    console.log(`residents' tours by tour mode, their other trips (%): ${Object.entries(r.demand.tripMixTour).map(([a, x]) => `${a}: ${Object.entries(x).filter(([, v]) => v >= 0.0005).map(([m, v]) => `${m} ${(100 * v).toFixed(1)}`).join(' ')}`).join(' | ')}`);
  if (r.demand.tripMix)
    console.log(`residents' tours by the mode of the leg out, their other trips (%): ${Object.entries(r.demand.tripMix).map(([a, x]) => `${a}: ${Object.entries(x).filter(([, v]) => v >= 0.0005).map(([m, v]) => `${m} ${(100 * v).toFixed(1)}`).join(' ')}`).join(' | ')}`);
  const mixLine = (x: Record<string, number> | undefined) => (x ? Object.entries(x).filter(([, v]) => v >= 0.0005).map(([m, v]) => `${m} ${(100 * v).toFixed(1)}`).join(' ') : '–');
  console.log(`transit tours' trips back: ${mixLine(r.demand.tripMixBack?.transit)} (NHTS 2017 transit 81.1) | their stop legs: ${mixLine(r.demand.tripMixStop?.transit)} (NHTS 28.4)`);
  console.log(`Caltrain peak stretches (model incl. background/observed, busiest-hour riders per seat): ${ctPeaks.map((x) => `${x.period} ${x.dir} ${x.stretch} ${k(x.model)} (bg ${k(x.background)})/${k(x.observed)} ${x.loadPerSeat.toFixed(2)}`).join('; ')}; peak stretches r ${out.caltrain.peakSegments.r.toFixed(2)} total ${(100 * (out.caltrain.peakSegments.total - 1)).toFixed(0)}%`);
  console.log(`BART segments (model incl. background/observed): r ${out.bartSegments.r.toFixed(3)} total ${(100 * (out.bartSegments.total - 1)).toFixed(1)}% | ${bartSegs.map((x) => `${x.a}-${x.b} ${k(x.model)}(bg ${k(x.background)})/${k(x.observed)}`).join(' ')}`);
  const fmt = (x: Record<string, number>) => P.map((p) => `${p} ${(100 * x[p]).toFixed(1)}`).join(' ');
  console.log(`time of day (%): BART city exits ${fmt(tod.bartExits)} | entries ${fmt(tod.bartEntries)} | Muni boardings ${fmt(tod.muni)} | linked transit trips ${fmt(tod.allTransitTrips)}`);
  const R = regional;
  console.log(`BART outside entries toward SF: r ${R.outsideEntries.r.toFixed(3)}, %RMSE ${R.outsideEntries.pctRmse.toFixed(1)}, total ${(100 * (R.outsideEntries.total - 1)).toFixed(1)}%; exits from SF: r ${R.outsideExits.r.toFixed(3)}, %RMSE ${R.outsideExits.pctRmse.toFixed(1)}, total ${(100 * (R.outsideExits.total - 1)).toFixed(1)}%`);
  console.log(`  corridors in (model/obs): ${Object.entries(R.corridors).map(([c, v]) => `${c} ${k(v.modIn)}/${k(v.obsIn)}`).join(', ')}`);
  console.log(`  stations in: ${R.rows.filter((x) => x.obsIn > 300).map((x) => `${x.code} ${k(x.modIn)}/${k(x.obsIn)}`).join(' ')}`);
  console.log(`  city stations entries (model/obs): ${sfBoth.map((x) => `${x.code} ${k(x.entriesMod)}/${k(x.entriesObs)}`).join(' ')}`);
  const pc = (x: { walk: number; bus: number; drive: number }) => `walk ${(100 * x.walk).toFixed(0)} bus ${(100 * x.bus).toFixed(0)} car ${(100 * x.drive).toFixed(0)}`;
  console.log(`access to BART outside the city from home (model | 2024 Station Profile): ${pc(access.model)} | ${pc(access.target)}; car share by station r ${access.driveShareFit.r.toFixed(2)}`);
  console.log(`lots (cars/room, price min): ${lots.slice(0, 16).map((x) => `${x.name.slice(0, 14)} ${x.cars}/${x.room ?? '∞'}${x.price ? ` ${x.price.toFixed(0)}` : ''}`).join(', ')}`);
  console.log(`in-commuters' transit share by home PUMA (${pumaRows.length}): r ${pumaFit.r.toFixed(3)}, RMSE ${(100 * pumaFit.rmsePts).toFixed(1)} pts | ${pumaRows.filter((x) => x.county === '001').map((x) => `${x.puma} ${(100 * x.mod).toFixed(0)}/${(100 * x.obs).toFixed(0)}`).join(' ')}`);
  console.log(`AC Transbay: total ${(100 * (ac.total - 1)).toFixed(0)}%, r ${ac.r.toFixed(2)} | ${acRows.map((x) => `${x.route} ${k(x.mod)}/${k(x.obs)}`).join(' ')}`);
  console.log(`  terminals (entries walk/bus/drive/xfer/act): ${R.terminals.slice(0, 14).map((x) => `${x.name.replace(/ (Ferry Terminal|Station|Caltrain)/g, '').slice(0, 18)} ${x.entries} (${x.inBy.walk}/${x.inBy.bus}/${x.inBy.drive}/${x.inBy.xfer}/${x.inBy.act})`).join(', ')}`);
  console.log(`ferries: r ${ferry.r.toFixed(3)}, total ${(100 * (ferry.total - 1)).toFixed(1)}% | ${ferryRows.map((x) => `${x.route} ${k(x.mod)}/${k(x.obs)}`).join(' ')}`);
  const tr = (w: Record<string, Record<string, number>>) => Object.entries(w).map(([c, m]) => `${c} ${(100 * m.transit / Object.values(m).reduce((a, v) => a + v, 0)).toFixed(0)}%`).join(', ');
  console.log(`commuters' transit share: in by home county ${tr(r.demand.workIn)}; out by work county ${tr(r.demand.workOut)}`);
  console.log(`miles per boarding: Muni bus ${tripMiles.bus.toFixed(2)} (NTD 1.89), Metro ${tripMiles.metro.toFixed(2)} (NTD 2.34 without the L), without the L ${tripMiles.metroWithoutL.toFixed(2)}${Object.keys(shuttles).length ? ` | shuttles ${Object.entries(shuttles).map(([k2, v]) => `${k2} ${k(v)}`).join(', ')}` : ''}`);
  console.log(`groups N ${k(byRoute.get('N') ?? 0)}/${k(routes.find((x) => x.route === 'N')?.obs ?? 0)}; King St on/off ${k(ballpark.kingSt.on)}/${k(ballpark.kingSt.off)}, Mission Bay platforms ${k(ballpark.missionBay.on)}/${k(ballpark.missionBay.off)}, Caltrain SF ${k(ballpark.caltrainSF.on)}`);
  console.log(`youth (model/BATS 2023 <18): ${Object.entries(youth).map(([m, [a, t]]) => `${m} ${(100 * a).toFixed(1)}/${(100 * t).toFixed(1)}`).join(' ')} | trips (transit share): school ${k(studentTrips.school.trips)} (${(100 * studentTrips.school.transitShare).toFixed(1)}%), college ${k(studentTrips.univ.trips)} (${(100 * studentTrips.univ.transitShare).toFixed(1)}%)`);
  console.log(`school by level (trips, transit, walk, under 1 mi, over 2 mi): ${schoolLevels.map((x) => `${x.name} ${k(x.trips)} ${(100 * x.transit).toFixed(0)}% ${(100 * x.walk).toFixed(0)}% ${(100 * x.under1mi).toFixed(0)}% ${(100 * x.over2mi).toFixed(0)}%`).join(', ')}`);
  console.log(`school trips by direction (transit to school/home, car passenger to school/home; SFCTA 2016 K-5: transit 14.0% at drop-off, 26.7% at the bell, 18.2% from aftercare): ${schoolLevels.map((x) => `${x.name} ${(100 * (x.transitThere ?? 0)).toFixed(1)}/${(100 * (x.transitHome ?? 0)).toFixed(1)}%, ${(100 * (x.carThere ?? 0)).toFixed(1)}/${(100 * (x.carHome ?? 0)).toFixed(1)}%`).join('; ')}`);
  if (sfsu) console.log(`SF State: ${k(sfsu.trips)} college trips, ${Object.entries(sfsu.shares).map(([m, v]) => `${m} ${(100 * v).toFixed(0)}%`).join(' ')}`);
  if (ccsf) console.log(`City College (Ocean campus zone): ${k(ccsf.trips)} college trips, ${Object.entries(ccsf.shares).map(([m, v]) => `${m} ${(100 * v).toFixed(0)}%`).join(' ')}`);
  console.log(`campus arrivals by transit: ${Object.entries(campus).map(([n, c]) => `${n} ${(100 * c.transitShare).toFixed(1)}% of ${k(c.trips)}`).join(', ')}`);
  console.log(`events: ${Object.entries(events).map(([v, e]) => `${v} ${k(e.trips)} trips, transit ${(100 * e.transitShare).toFixed(0)}%`).join('; ')}`);
  if (CAPACITY.on) console.log(`capacity at boarding: riders left behind ${P.map((p) => `${p} ${k(r.capacity.leftBehind[p])}`).join(' ')}; beyond room ${P.map((p) => `${p} ${k(r.capacity.overCap[p])}`).join(' ')}`);
  if (CAPACITY.on) console.log(`  by route, direction, and period: ${cs.routes.slice(0, 15).map((x) => `${x.p} ${x.feed} ${x.route} → ${x.headsign} ${k(x.leftBehind)} (${(100 * x.share).toFixed(1)}%)`).join(', ')}`);
  if (CAPACITY.on) for (const x of cs.stops.slice(0, 15)) console.log(`  ${x.p} ${x.feed} ${x.route} → ${x.headsign} at ${x.stop}: on ${x.on}, through ${x.through}, capacity ${x.capacity}/period, avail ${x.avail}, left behind ${x.leftBehind} (beyond room ${x.overCap})`);
  if (micro) for (const l of micro.lines) console.log(l);
  if (r.convergence.length) console.log(`convergence (Σ|Δ boardings| / boardings, by pass): ${r.convergence.map((c) => (100 * c).toFixed(2) + '%').join(', ')}`);
  console.log(`largest route misses: ${worst.map((x) => `${x.route} ${k(x.mod)}/${k(x.obs)}`).join(', ')}`);
  console.log(`linked transit trips ${k(r.summary.transitTrips)}; Muni boardings per Muni-riding trip see transfers below`);
  for (const l of describeTrace(transfers)) console.log(l);
  const jf = arg('--json', '');
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
