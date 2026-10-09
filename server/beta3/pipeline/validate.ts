/**
 * Step 11: validation against accepted standards. Computes the statistics travel-model practice
 * uses (FHWA Validation and Reasonableness Checking Manual 2010; California Transportation
 * Commission RTP Guidelines 2017/2024; Florida transit targets via FHWA Table 9.9; UK DfT TAG
 * M3.2 and M2.1; NCHRP 716; TCRP Report 95) for today's network on weekdays, Saturdays and Sundays,
 * runs sensitivity tests, and compares with published Bay Area model validation. Every threshold is
 * cited in server/beta3/reference/validation-standards.json.
 * Writes server/beta3/reference/validation-results.json (and a copy for the app).
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/validate.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import type { Bundle, DayType, RunResult, Scenario } from '../../../shared/beta3/types';
import { bartSegments } from './bart-segments';
import { RecordingExecutor } from './experiment-exec';
import { regionalDiag } from './regional-diag';
import { caltrainPeaks, caltrainSegments } from './caltrain-segments';
import { CITY_STATIONS, modelRegionalPairs, readRegional } from './station-od';
import { odChecks } from './od-checks';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

import { stats } from './stats';

/** FHWA Table 9.9 (Florida): allowable % difference for a transit line by its daily riders */
const LINE_BANDS = [
  { max: 1000, acceptable: 150, preferable: 100 },
  { max: 2000, acceptable: 100, preferable: 65 },
  { max: 5000, acceptable: 65, preferable: 35 },
  { max: 10000, acceptable: 35, preferable: 25 },
  { max: 20000, acceptable: 25, preferable: 20 },
  { max: Infinity, acceptable: 20, preferable: 15 },
];
const geh = (m: number, c: number) => Math.sqrt((2 * (m - c) ** 2) / Math.max(1e-9, m + c));

function routeBoardings(b: Bundle, r: RunResult) {
  const out = new Map<string, number>();
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = b.header.lines[l.line];
    if (bl.feed !== 'muni') continue;
    out.set(bl.route, (out.get(bl.route) ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0));
  }
  return out;
}

function muniValidation(b: Bundle, r: RunResult, obs: { route: string; boardings: number }[], categories: Map<string, string>) {
  const mod = routeBoardings(b, r);
  const pairs = obs.map((o) => ({ route: o.route, obs: o.boardings, mod: mod.get(o.route) ?? 0, category: categories.get(o.route) ?? 'Other' }));
  const s = stats(pairs);
  // FHWA/Florida line bands
  let acc = 0, pref = 0;
  const lines = pairs.map((p) => {
    const band = LINE_BANDS.find((x) => p.obs < x.max)!;
    const pct = (100 * (p.mod - p.obs)) / p.obs;
    const a = Math.abs(pct) <= band.acceptable, f = Math.abs(pct) <= band.preferable;
    if (a) acc++;
    if (f) pref++;
    // GEH on average hourly boardings over an 18-hour service day (a transfer of the highway rule; indicative)
    return { ...p, pct, acceptable: a, preferable: f, geh: geh(p.mod / 18, p.obs / 18) };
  });
  // route groups (SFMTA service categories) for the CTC ±20% route-group test
  const groups = new Map<string, { obs: number; mod: number }>();
  for (const p of pairs) {
    const g = groups.get(p.category) ?? { obs: 0, mod: 0 };
    g.obs += p.obs;
    g.mod += p.mod;
    groups.set(p.category, g);
  }
  return {
    ...s,
    fhwaLineBands: { acceptableShare: acc / pairs.length, preferableShare: pref / pairs.length },
    gehUnder5Share: lines.filter((l) => l.geh < 5).length / lines.length,
    groups: [...groups].map(([name, g]) => ({ name, observed: Math.round(g.obs), model: Math.round(g.mod), pct: (100 * (g.mod - g.obs)) / g.obs })),
    routes: lines.map((l) => ({ route: l.route, category: l.category, observed: l.obs, model: Math.round(l.mod), pct: +l.pct.toFixed(1), acceptable: l.acceptable, preferable: l.preferable, geh: +l.geh.toFixed(2) })),
  };
}

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const prep = prepare(b);
  const muniRef = read(`${REFERENCE}/muni-route-ridership.json`);
  const categories = new Map<string, string>(muniRef.routes.map((r: { route: string; serviceCategory: string }) => [r.route, r.serviceCategory]));
  const loadBase = (day: DayType) => decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/${day === 'wkd' ? 'base' : `base-${day}`}.bin.gz`)));
  const base: Record<DayType, RunResult> = { wkd: loadBase('wkd'), sat: loadBase('sat'), sun: loadBase('sun') };
  const out: Record<string, unknown> = { generated: new Date().toISOString(), modelBuilt: H.built };

  // ---- 1. Muni ridership by route (independent test) ----
  out.muni = {
    wkd: { period: H.observed.muniPeriod, ...muniValidation(b, base.wkd, H.observed.muniRoutes, categories) },
    sat: { period: 'Average Saturday, October 2025 – September 2026, 12-month mean (SFMTA)', ...muniValidation(b, base.sat, H.observed.muniRoutesSat ?? [], categories) },
    sun: { period: 'Average Sunday, October 2025 – September 2026, 12-month mean (SFMTA)', ...muniValidation(b, base.sun, H.observed.muniRoutesSun ?? [], categories) },
  };

  // ---- 2. BART ----
  const sfCodes = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB', 'DALY'];
  const bartObs = (day: DayType) =>
    sfCodes.map((c) => {
      const st = H.observed.bartStations.find((s) => s.code === c)!;
      const obs = day === 'wkd' ? st.exits : day === 'sat' ? H.observed.bartExitsSat![c] : H.observed.bartExitsSun![c];
      return { code: c, name: st.name, obs, mod: base[day].stopOff[st.stop!] };
    });
  out.bart = Object.fromEntries(
    (['wkd', 'sat', 'sun'] as DayType[]).map((d) => {
      const p = bartObs(d);
      return [d, { exits: p.map((x) => ({ code: x.code, name: x.name, observed: Math.round(x.obs), model: Math.round(x.mod) })), ...stats(p.map((x) => ({ obs: x.obs, mod: x.mod }))) }];
    }),
  );
  // segment loads through the city and the Transbay Tube, from BART's station-to-station counts (weekday)
  // the model's loads include the background riders with neither station in the city (BART's own
  // counts less the model's journeys between those stations; background.ts), so the comparison tests
  // the journeys the model carries; withoutBackground is the model's riders alone
  const segs = bartSegments(b, base.wkd);
  (out.bart as Record<string, unknown>).segments = {
    loads: segs,
    ...stats(segs.map((s) => ({ obs: s.observed, mod: s.model }))),
    withoutBackground: stats(segs.map((s) => ({ obs: s.observed, mod: s.model - s.background }))),
  };
  // entries and exits at stations outside the city on trips to and from it: from the reference run
  // below (section 8), which keeps its link volumes

  // ---- 3. Caltrain ----
  const ct = H.observed.caltrainStations.filter((s) => s.stop !== null && ['San Francisco', '22nd Street', 'Bayshore'].includes(s.name));
  // mid-week counts to an all-weekday average: Caltrain's systemwide average weekday / its stations' mid-week sum
  const cr = JSON.parse(fs.readFileSync(`${REFERENCE}/caltrain-ridership.json`, 'utf8'));
  const ctFactor = cr.systemwide.avgWeekdayRidershipFY2026 / (cr.stations as { amwrFY2026?: number }[]).reduce((a, s) => a + (s.amwrFY2026 ?? 0), 0);
  out.caltrain = { weekdayFactor: ctFactor, rows: ct.map((s) => ({ name: s.name, observedMidweek: s.boardings, observedWeekdayEst: Math.round(s.boardings * ctFactor), model: Math.round(base.wkd.stopOn[s.stop!]) })) };
  // Caltrain beyond the city: journeys between the city's stations and each group of outside stations
  // (the 2024 OD survey's groups, at FY2026 volumes), loads on each stretch, and riders with no city end
  {
    const ref = readRegional();
    const R = ref.caltrain;
    const sc: Scenario = { name: 'Today', edits: [] };
    const rr = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 1, warmCrowd: base.wkd.finalCrowd }, prep);
    const mp = modelRegionalPairs(b, calib, 'wkd', rr.demand, base.wkd.finalCrowd, ref).caltrain;
    const P = ['AM', 'MD', 'PM', 'NT'] as const;
    const names = R.stations, city = new Set(CITY_STATIONS.caltrain), cityIx = names.map((n, i) => (city.has(n) ? i : -1)).filter((i) => i >= 0);
    const obs = R.od.wkd;
    const flows = (ix: number[], M: Record<string, number[][]>, ps: readonly string[], to: boolean) => ix.reduce((a, i) => a + ps.reduce((x, p) => x + cityIx.reduce((y, j) => y + (to ? M[p][i][j] : M[p][j][i]), 0), 0), 0);
    // outside groups: 22nd Street left out of its group; Capitol and Blossom Hill joined to Morgan Hill–Gilroy
    const groups = R.groups.slice(1).map((g) => ({ name: g.name, stations: g.stations.filter((x) => !city.has(x)) }));
    groups[6] = { name: 'Capitol to Gilroy', stations: [...groups[6].stations, ...groups[7].stations] };
    groups.splice(7, 1);
    const row = (name: string, ix: number[]) => ({
      name,
      observedToCityAM: Math.round(flows(ix, obs, ['AM'], true)), modelToCityAM: Math.round(flows(ix, mp, ['AM'], true)),
      observedFromCityPM: Math.round(flows(ix, obs, ['PM'], false)), modelFromCityPM: Math.round(flows(ix, mp, ['PM'], false)),
      // the reverse commute: away from the city in the morning, back in the evening
      observedFromCityAM: Math.round(flows(ix, obs, ['AM'], false)), modelFromCityAM: Math.round(flows(ix, mp, ['AM'], false)),
      observedToCityPM: Math.round(flows(ix, obs, ['PM'], true)), modelToCityPM: Math.round(flows(ix, mp, ['PM'], true)),
      observedDaily: Math.round(flows(ix, obs, P, true) + flows(ix, obs, P, false)), modelDaily: Math.round(flows(ix, mp, P, true) + flows(ix, mp, P, false)),
    });
    const gRows = groups.map((g) => row(g.name, g.stations.map((x) => names.indexOf(x))));
    const sRows = names.map((n, i) => (city.has(n) ? null : row(n, [i]))).filter((x): x is ReturnType<typeof row> => !!x && x.observedDaily > 100);
    const tot = (M: Record<string, number[][]>, f: (i: number, j: number) => boolean) => P.reduce((a, p) => a + M[p].reduce((x, r, i) => x + r.reduce((y, v, j) => y + (f(i, j) ? v : 0), 0), 0), 0);
    const all = tot(obs, (i, j) => i !== j), noCity = tot(obs, (i, j) => i !== j && !city.has(names[i]) && !city.has(names[j]));
    const sv = ref.caltrain.surveyGroups.matrix, svAll = sv.flat().reduce((a, v) => a + v, 0), svCity = sv[0].reduce((a, v) => a + v, 0) + sv.reduce((a, r) => a + r[0], 0);
    const segsC = caltrainSegments(b, rr);
    const pk = segsC.filter((x) => x.period === 'AM' || x.period === 'PM');
    const daily = new Map<string, { obs: number; mod: number; bg: number }>();
    for (const x of segsC) {
      const k = `${x.a}–${x.b}`, e = daily.get(k) ?? { obs: 0, mod: 0, bg: 0 };
      e.obs += x.observed;
      e.mod += x.model;
      e.bg += x.background;
      daily.set(k, e);
    }
    const dRows = [...daily].map(([k, v]) => ({ stretch: k, observed: Math.round(v.obs), model: Math.round(v.mod), background: Math.round(v.bg) }));
    const bgFile = JSON.parse(fs.readFileSync(`${REFERENCE}/background-loads.json`, 'utf8'));
    out.caltrainRegional = {
      source: 'Observed: 2024 Caltrain/MTC origin–destination survey (on-to-off study, weighted weekday matrix by station group) fitted to Caltrain FY2026 boardings by station, periods from the survey\'s counts by direction and time of day rescaled to the fall 2025 count (regional-od.json). An estimate, not a count: Caltrain has no station-to-station counts.',
      shareNoCityEnd: { estimateFY2026: noCity / all, survey2024: 1 - svCity / svAll, note: 'journeys with neither station in San Francisco (San Francisco, 22nd Street); survey2024 counts group 1 (4th & King) only, so 22nd Street riders are counted as having no city end there' },
      groups: { rows: gRows, daily: stats(gRows.map((r) => ({ obs: r.observedDaily, mod: r.modelDaily }))), toCityAM: stats(gRows.map((r) => ({ obs: r.observedToCityAM, mod: r.modelToCityAM }))), fromCityPM: stats(gRows.map((r) => ({ obs: r.observedFromCityPM, mod: r.modelFromCityPM }))), fromCityAM: stats(gRows.map((r) => ({ obs: r.observedFromCityAM, mod: r.modelFromCityAM }))), toCityPM: stats(gRows.map((r) => ({ obs: r.observedToCityPM, mod: r.modelToCityPM }))) },
      stations: { rows: sRows, daily: stats(sRows.map((r) => ({ obs: r.observedDaily, mod: r.modelDaily }))), toCityAM: stats(sRows.map((r) => ({ obs: r.observedToCityAM, mod: r.modelToCityAM }))) },
      segments: { peakRows: pk, daily: dRows, peakStats: stats(pk.map((x) => ({ obs: x.observed, mod: x.model }))), peakStatsWithoutBackground: stats(pk.map((x) => ({ obs: x.observed, mod: x.model - x.background }))), dailyStats: stats(dRows.map((x) => ({ obs: x.observed, mod: x.model }))), dailyStatsWithoutBackground: stats(dRows.map((x) => ({ obs: x.observed, mod: x.model - x.background }))), busiest: caltrainPeaks(segsC) },
      background: bgFile.summary,
      modelBoardings: Math.round(rr.summary.boardings.caltrain ?? 0),
    };
  }
  // ---- origin–destination markets: BART station to station, commute flows, who rides (od-checks.ts) ----
  out.od = await odChecks(b, calib, prep, base.wkd.finalCrowd);
  // private shuttles: their rider count is an input; BATS 2023 gives an independent share of residents' trips
  {
    const ms = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-share.json`, 'utf8'));
    const bats = ms.bats2023_sfResidents_allTrips_unlinked.sharesPercent['Shuttle/vanpool'] / 100;
    const res = Object.values(base.wkd.summary.residentTrips).reduce((a, v) => a + v, 0);
    const sh = base.wkd.summary.shuttleTrips ?? 0;
    out.shuttle = { modelTrips: Math.round(sh), shareOfResidentTrips: sh / (res + sh), batsShuttleVanpoolShare: bats, note: 'BATS counts shuttle and vanpool together, unlinked; the model counts shuttle trips only' };
  }
  // ferries by route: only the total of the commuter routes is calibrated, so the split is a test
  {
    const f = JSON.parse(fs.readFileSync(`${REFERENCE}/ferry-ridership.json`, 'utf8'));
    const sfbf = f.sfBayFerry.FY2026.routes as Record<string, { name: string; avgWeekday: number }>;
    const gg = f.goldenGateFerry.statisticsPage.byFY.FY2025;
    const obs: [string, string, string, number][] = [
      ...['VJO', 'OA', 'SEA', 'HB', 'RCH'].map((r) => ['ferry', r, sfbf[r].name, sfbf[r].avgWeekday] as [string, string, string, number]),
      ['ggt', 'LSSF', 'Larkspur (estimated weekday)', Math.round((gg.annualByRoute.Larkspur / gg.annualAll) * gg.avgWeekdayAll)],
    ];
    const modelBy = new Map<string, number>();
    for (const l of base.wkd.lines) {
      if (l.line < 0) continue;
      const bl = H.lines[l.line];
      if (bl.mode !== 'ferry') continue;
      const k = `${bl.feed}:${bl.route}`;
      modelBy.set(k, (modelBy.get(k) ?? 0) + Object.values(l.boardings).reduce((a, v) => a + v, 0));
    }
    const rows = obs.map(([feed, route, name, o]) => ({ route, name, observed: o, model: Math.round(modelBy.get(`${feed}:${route}`) ?? 0) }));
    out.ferry = { source: 'SF Bay Ferry public ridership data, FY2026 average weekday; Golden Gate Ferry FY2025 (Larkspur: annual share × weekday average)', rows, ...stats(rows.map((r) => ({ obs: r.observed, mod: r.model }))) };
  }

  // ---- 4. Trip length per boarding (NTD 2024), an independent check ----
  {
    const ntd = read(`${REFERENCE}/ntd-trip-length.json`);
    const byMode = ntd.agencies.muni.byMode;
    const acc: Record<string, [number, number]> = {};
    for (const l of base.wkd.lines) {
      if (l.line < 0) continue;
      const bl = H.lines[l.line];
      if (bl.feed !== 'muni' || bl.mode === 'cablecar' || bl.mode === 'streetcar') continue;
      const k = bl.mode === 'lightrail' ? 'LR' : 'bus';
      acc[k] ??= [0, 0];
      acc[k][0] += Object.values(l.boardings).reduce((a, v) => a + v, 0);
      acc[k][1] += l.passengerKm;
    }
    const busObs = (byMode.MB.pmt + byMode.TB.pmt) / (byMode.MB.upt + byMode.TB.upt);
    out.tripLength = {
      source: `NTD ${ntd.period ?? 'report year 2024'}: passenger miles ÷ unlinked trips`,
      rows: [
        { mode: 'Muni bus and trolleybus', observed: +busObs.toFixed(2), model: +(acc.bus[1] / acc.bus[0] / 1.609).toFixed(2) },
        { mode: 'Muni Metro (light rail)', observed: +byMode.LR.avgTripMiles.toFixed(2), model: +(acc.LR[1] / acc.LR[0] / 1.609).toFixed(2) },
      ],
      note: 'model distance follows each route\'s drawn GTFS shape between its stops (straight lines between stops were 3–9% short on buses)',
    };
  }

  // ---- 5. Time of day (BART SF stations, BART Oct 2025 hourly) ----
  {
    const tod = read(`${REFERENCE}/time-of-day.json`);
    const sfStops = sfCodes.slice(0, 8).map((c) => H.observed.bartStations.find((s) => s.code === c)!.stop!);
    // model: alightings (exits) and boardings (entries) at the city's stations by period, from the
    // per-period stop totals. (Earlier versions took exits from the drop in a line's load, which nets
    // out the riders boarding there and so missed most evening exits downtown.)
    const P = ['AM', 'MD', 'PM', 'NT'] as const;
    const by = (m: RunResult['stopOffBy']) => Object.fromEntries(P.map((p) => [p, sfStops.reduce((a, s) => a + (m?.[p]?.[s] ?? 0), 0)])) as Record<(typeof P)[number], number>;
    // a base saved before per-period stop totals were kept: rerun it (warm-started, as baseline.ts does)
    const wk = base.wkd.stopOffBy ? base.wkd : await runModel(b, { name: 'Today', edits: [] }, calib, new LocalExecutor(b, { name: 'Today', edits: [] }, calib), { iterations: 1, warmCrowd: base.wkd.finalCrowd }, prep);
    const exitsBy = by(wk.stopOffBy), entriesBy = by(wk.stopOnBy);
    const share = (x: Record<string, number>) => {
      const t = Object.values(x).reduce((a, v) => a + v, 0);
      return (p: string) => x[p] / t;
    };
    const ex = share(exitsBy), en = share(entriesBy);
    const o = tod.bartSfStations.sfEightStations.exitsShareByPeriod, oi = tod.bartSfStations.sfEightStations.entriesShareByPeriod;
    const observed = { AM: o.AM, MD: o.MD, PM: o.PM, NT: o.EA + o.EV };
    const observedIn = { AM: oi.AM, MD: oi.MD, PM: oi.PM, NT: oi.EA + oi.EV };
    out.timeOfDay = {
      measure: 'Share of weekday BART exits (and entries) at the eight San Francisco stations by period',
      rows: P.map((p) => ({ period: p, observed: observed[p], model: +ex(p).toFixed(4), observedEntries: observedIn[p], modelEntries: +en(p).toFixed(4) })),
      source: 'BART hourly origin–destination, October 2025 weekdays (by tap-in hour, so exits run slightly early)',
    };
  }

  // ---- 5b. Muni bus speeds: scheduled (GTFS, along each route's drawn path) vs observed (SFCTA CMP 2025) ----
  {
    const cmp = read(`${REFERENCE}/sf-auto-speeds.json`).citywide.muniBusOnCmpNetwork;
    const toXYp = (await import('../../../shared/beta3/geo')).toXY;
    const speed = (p: 'AM' | 'PM') => {
      let miles = 0, hours = 0;
      for (const l of H.lines) {
        if (l.feed !== 'muni' || !['bus', 'rapid', 'trolley'].includes(l.mode)) continue;
        const per = (l.periods as Record<string, { trips: number; hops: number[] }>)[p];
        if (!per) continue;
        let m = 0;
        for (let i = 2; i < l.path.length; i += 2) {
          const [ax, ay] = toXYp(l.path[i - 2], l.path[i - 1]), [bx, by] = toXYp(l.path[i], l.path[i + 1]);
          m += Math.hypot(bx - ax, by - ay);
        }
        miles += (per.trips * m) / 1609.34;
        hours += (per.trips * per.hops.reduce((a, v) => a + v, 0)) / 3600;
      }
      return miles / hours;
    };
    out.muniSpeed = {
      rows: [
        { period: 'AM', observed: cmp.AM, scheduled: +speed('AM').toFixed(2) },
        { period: 'PM', observed: cmp.PM, scheduled: +speed('PM').toFixed(2) },
      ],
      note: 'observed: SFCTA CMP 2025, Muni buses on the CMP network (arterials); scheduled: all Muni bus routes, GTFS run times over their drawn paths, trip-weighted',
    };
  }

  // ---- 6. Mode shares (calibration checks) ----
  const rs = base.wkd.summary.residentTrips;
  const rt = Object.values(rs).reduce((a, v) => a + v, 0);
  out.modeShares = {
    residents: Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, { model: v / rt, observed: H.observed.residentShares[k as keyof typeof rs] }])),
    source: H.observed.residentSharesSource,
  };

  // ---- 7. Reasonableness (FHWA §9.2.5, NCHRP 716) ----
  {
    const s = base.wkd.summary;
    const boardings = Object.values(s.boardings).reduce((a, v) => a + v, 0);
    const hh = H.zones.reduce((a, z) => a + z.hh, 0);
    const res = s.byPurpose;
    const sum = (p: string) => Object.values(res[p] ?? {}).reduce((a, v) => a + (v as number), 0);
    out.reasonableness = {
      boardingsPerLinkedTrip: { model: boardings / s.transitTrips, range: [1.2, 1.6], source: 'FHWA 2010 §9.2.5' },
      avgTransitTripMin: { model: s.avgTransitMin, benchmark: 48, source: 'NCHRP 716: mean transit trip time, all trips, urban areas over 1M with rail (2009 NHTS)' },
      ivtCoefficient: { model: [-0.022, -0.0279], tour: [-0.0134, -0.0224], range: [-0.03, -0.02], source: 'FHWA 2010 p. 7-15 (FTA guidance); trip model (trips not from home, visitors) and, per leg of a home-based tour, TM1 tour model (summed over both legs)' },
      waitToIvtRatio: { model: 2.0, range: [1.5, 2.6], source: 'NCHRP 716 (MPOs over 1M)' },
      nestCoefficients: { model: [0.72], range: [0, 1], source: 'FHWA 2010 §7 (one scale, 0.72 from TM1, for the auto and non-motorized nests)' },
      tripsPerHousehold: { model: { HBW: (2 * sum('work')) / 2 / hh, HBNW: (sum('school') + sum('univ') + sum('shop') + sum('other') + sum('social')) / hh, NHB: sum('nhb') / hh }, benchmark: { HBW: 1.4, HBNW: 5.6, NHB: 3.0 }, source: 'NCHRP 716 (2009 NHTS, national)', note: 'model counts trips with an end in San Francisco, residents and visitors' },
    };
  }

  // ---- 8. Sensitivity tests (TCRP 95, UK TAG M2.1) ----
  // each test and an unchanged run made the same way (three passes of demand, assignment, and
  // crowding from today's crowding), so a test's response includes its crowding adjustment
  const PASSES = 3;
  const run = async (sc: Scenario) => runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: PASSES, warmCrowd: base.wkd.finalCrowd, warmLot: base.wkd.finalLotPrice }, prep);
  const refExec = new RecordingExecutor(b, { name: 'Today', edits: [] }, calib);
  const ref = await runModel(b, { name: 'Today', edits: [] }, calib, refExec, { iterations: PASSES, warmCrowd: base.wkd.finalCrowd, warmLot: base.wkd.finalLotPrice }, prep);
  {
    // BART's station-to-station counts: weekday trips from each station outside the city to the nine
    // city-area stations (and back), against the model's riders entering (leaving) there from the street
    // or another operator; transfers between BART trains are not entries
    const R = regionalDiag(b, ref.nets, refExec.vols);
    const rows = R.rows.filter((r) => r.obsIn > 300).map((r) => ({ code: r.code, corridor: r.corridor, observed: r.obsIn, model: r.modIn, observedFromSF: r.obsOut, modelFromSF: r.modOut, access: r.inBy }));
    (out.bart as Record<string, unknown>).outsideEntries = {
      note: 'observed: weekday trips from each station outside the city to the 9 city-area stations (BART OD); model: riders entering there from the street or another operator (the model carries trips with an end in the city), from a 3-pass run warm-started from the baseline',
      rows,
      ...stats(rows.map((r) => ({ obs: r.observed, mod: r.model }))),
      fromSF: stats(R.rows.filter((r) => r.obsOut > 300).map((r) => ({ obs: r.obsOut, mod: r.modOut }))),
      corridors: R.corridors,
    };
  }
  const muniB = (r: RunResult) => r.summary.boardings.muni;
  const sens: Record<string, unknown>[] = [];
  {
    const up = await run({ name: 'fare+10', edits: [{ kind: 'fare', feed: 'muni', factor: 1.1 }] });
    const dn = await run({ name: 'fare-10', edits: [{ kind: 'fare', feed: 'muni', factor: 0.9 }] });
    const e = Math.log(muniB(up) / muniB(dn)) / Math.log(1.1 / 0.9);
    sens.push({ test: 'Muni fare ±10%', measure: 'Muni boardings', elasticity: e, range: [-0.85, -0.12], central: -0.4, source: 'TCRP 95 ch. 12 (bus fares ≈ −0.40; range −0.12 to −0.85); UK TAG M2.1 bus −0.35 to −0.9; central cities over 1M ≈ −0.24' });
  }
  // a route's own boardings also count riders who switch from parallel lines; the corridor (the route
  // and the lines sharing its street, or for the N the Metro lines sharing the Market Street subway)
  // counts riders gained, which is what the published elasticities measure for a corridor's service
  const CORRIDOR: Record<string, string[]> = { '38R': ['38', '38R'], '14': ['14', '14R', '49'], '22': ['22'], N: ['J', 'K', 'L', 'M', 'N'] };
  for (const route of ['38R', '14', '22', 'N']) {
    const r = await run({ name: `${route} +25%`, edits: [{ kind: 'frequency', route, feed: 'muni', factor: { AM: 1.25, MD: 1.25, PM: 1.25, NT: 1.25 } }] });
    const r0 = routeBoardings(b, ref), r1 = routeBoardings(b, r);
    const b0 = r0.get(route)!, b1 = r1.get(route)!;
    const c0 = CORRIDOR[route].reduce((a, x) => a + (r0.get(x) ?? 0), 0), c1 = CORRIDOR[route].reduce((a, x) => a + (r1.get(x) ?? 0), 0);
    const sys = Math.log(r.summary.transitTrips / ref.summary.transitTrips) / Math.log(1.25);
    sens.push({ test: `${route} service +25%`, measure: `${route} boardings`, elasticity: Math.log(b1 / b0) / Math.log(1.25), corridor: CORRIDOR[route], corridorElasticity: Math.log(c1 / c0) / Math.log(1.25), systemElasticity: sys, range: [0.3, 1.0], central: 0.5, source: 'TCRP 95 ch. 9: service frequency elasticity ≈ +0.5 (clusters near +0.3 and +1.0); headways under 10 min: headway elasticity ≈ −0.22' });
  }
  {
    const r = await run({ name: 'auto cost +10%', edits: [], autoCostFactor: 1.1 });
    sens.push({ test: 'Car running cost +10%', measure: 'vehicle-km', elasticity: Math.log(r.summary.vkt / ref.summary.vkt) / Math.log(1.1), range: [-0.35, -0.15], central: -0.25, source: 'UK TAG M2.1: car fuel cost elasticity of car-km −0.15 to −0.35' });
  }
  {
    const r = await run({ name: '14 and 14R 10% faster', edits: ['14', '14R'].map((route) => ({ kind: 'speed' as const, route, feed: 'muni', factor: 0.9 })) });
    const rb = routeBoardings(b, r), r0 = routeBoardings(b, ref);
    const b0 = (r0.get('14') ?? 0) + (r0.get('14R') ?? 0), b1 = (rb.get('14') ?? 0) + (rb.get('14R') ?? 0);
    sens.push({ test: '14/14R running time −10%', measure: '14 + 14R boardings', elasticity: Math.log(b1 / b0) / Math.log(0.9), range: [-0.9, -0.3], central: -0.5, source: 'Indicative: TCRP 95 reports ridership gains from bus priority roughly proportional to travel-time savings (elasticity −0.3 to −0.9 range used here as a reasonableness band)' });
  }
  out.sensitivity = sens;

  // ---- 9. Benchmarks ----
  out.benchmarks = [
    { model: 'MTC Travel Model One (2005 base, 2011 report)', measure: 'Muni route %RMSE', value: 66, ours: (out.muni as { wkd: { pctRmse: number } }).wkd.pctRmse },
    { model: 'MTC Travel Model One (2005)', measure: 'Muni total boardings vs observed', value: -26, ours: 100 * ((out.muni as { wkd: { totalRatio: number } }).wkd.totalRatio - 1) },
    { model: 'MTC Travel Model 1.5 (2015)', measure: 'Muni bus total', value: -4 },
    { model: 'MTC Travel Model 1.5 (2015)', measure: 'BART total', value: 5 },
  ];
  out.standards = {
    ctc: { correlationMin: 0.88, pctRmseMax: 40, routeGroupPct: 20, modePct: 10, source: 'California Transportation Commission, RTP Guidelines 2017 p. 49 (2024 p. 55)' },
    fhwaTransit: { regionalAcceptable: 9, regionalPreferable: 3, bands: LINE_BANDS, source: 'FHWA Travel Model Validation and Reasonableness Checking Manual, 2nd ed. (2010), Table 9.9 (Florida)' },
    tag: { servicesWithin25Share: 0.95, source: 'UK DfT TAG M3.2 (2024): individual services within ±25% for 95%' },
  };
  const json = JSON.stringify(out, (_, v) => (typeof v === 'number' ? +v.toFixed(4) : v), 1);
  fs.writeFileSync(`${REFERENCE}/validation-results.json`, json);
  fs.writeFileSync(`${BUNDLE}/validation.json`, json);
  const m = out.muni as Record<string, { r: number; pctRmse: number; totalRatio: number; fhwaLineBands: { acceptableShare: number } }>;
  for (const d of ['wkd', 'sat', 'sun']) console.log(`${d}: Muni r ${m[d].r.toFixed(3)}, %RMSE ${m[d].pctRmse.toFixed(1)}, total ${(100 * (m[d].totalRatio - 1)).toFixed(1)}%, FHWA bands acceptable ${(100 * m[d].fhwaLineBands.acceptableShare).toFixed(0)}%`);
  for (const s of sens) console.log(`${s.test}: ${(s.elasticity as number).toFixed(2)}${s.corridorElasticity !== undefined ? ` (corridor ${(s.corridorElasticity as number).toFixed(2)})` : ''} (range ${(s.range as number[]).join(' to ')})`);
  console.log(JSON.stringify(out.tripLength), JSON.stringify(out.reasonableness).slice(0, 400));
}

main();
