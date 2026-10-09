/**
 * Step 13: the validation report, from validate.ts and backcast.ts results, as a self-contained
 * HTML page (server/beta3/report/report.html). Statuses follow the cited standards.
 * Run: npx tsx server/beta3/pipeline/report.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { REFERENCE, ROOT } from './paths';
import { MODEL_LONG_NAME, MODEL_NAME, MODEL_VERSION } from '../../../shared/beta3/params';

type Status = 'pass' | 'warn' | 'fail';
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const pc = (v: number, d = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(d)}%`;

function main() {
  const V = read(`${REFERENCE}/validation-results.json`);
  const B = fs.existsSync(`${REFERENCE}/backcast-results.json`) ? read(`${REFERENCE}/backcast-results.json`) : null;
  const m = V.muni.wkd;
  // each check's tier of evidence: calibration targets match by construction (shown, not counted);
  // the development set was looked at while the structure was revised; independent tests used data
  // that played no part in building the model; held-out tests were kept apart from all development
  type Tier = 'calibration' | 'development' | 'independent' | 'held-out' | 'benchmark';
  const checks: { what: string; value: string; standard: string; status: Status; tier: Tier }[] = [];
  let tier: Tier = 'development';
  const add = (what: string, value: string, standard: string, status: Status) => checks.push({ what, value, standard, status, tier });
  const band = (ok: boolean, near: boolean): Status => (ok ? 'pass' : near ? 'warn' : 'fail');

  // the scorecard grades the weekday model; the experimental weekend models are graded separately
  const weekend: typeof checks = [];
  for (const [d, label] of [['sat', 'Saturday'], ['sun', 'Sunday']] as const) {
    const x = V.muni[d];
    weekend.push({ what: `Muni routes, ${label}: correlation`, value: `r = ${x.r.toFixed(3)} across ${x.n} routes`, standard: 'CTC RTP Guidelines: correlation coefficient ≥ 0.88', status: band(x.r >= 0.88, x.r >= 0.8), tier: 'held-out' });
    weekend.push({ what: `Muni routes, ${label}: %RMSE`, value: `${x.pctRmse.toFixed(0)}%`, standard: 'CTC RTP Guidelines: below 40%', status: band(x.pctRmse < 40, x.pctRmse < 50), tier: 'held-out' });
  }
  tier = 'development';
  add('Muni routes: correlation', `r = ${m.r.toFixed(3)} across ${m.n} routes`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88', band(m.r >= 0.88, m.r >= 0.8));
  add('Muni routes: %RMSE', `${m.pctRmse.toFixed(0)}%`, 'CTC RTP Guidelines: below 40%', band(m.pctRmse < 40, m.pctRmse < 50));
  tier = 'calibration';
  add('Muni boardings on the counted routes', `${pc(m.totalRatio - 1, 1)} vs SFMTA counts`, 'FHWA Table 9.9: ±9% acceptable, ±3% preferable (a calibration target)', band(Math.abs(m.totalRatio - 1) <= 0.09, Math.abs(m.totalRatio - 1) <= 0.15));
  add('BART exits at city stations, in total', `${pc(V.bart.wkd.totalRatio - 1, 1)}`, 'FHWA Table 9.9: ±9% acceptable (a calibration target)', band(Math.abs(V.bart.wkd.totalRatio - 1) <= 0.09, Math.abs(V.bart.wkd.totalRatio - 1) <= 0.15));
  tier = 'development';
  const groupsOk = m.groups.filter((g: { pct: number }) => Math.abs(g.pct) <= 20).length;
  add('Muni route groups (service categories)', `${groupsOk} of ${m.groups.length} within ±20%`, 'CTC RTP Guidelines: transit route groups ±20%', band(groupsOk === m.groups.length, groupsOk >= m.groups.length - 2));
  add('Individual routes by size band', `${(100 * m.fhwaLineBands.acceptableShare).toFixed(0)}% acceptable, ${(100 * m.fhwaLineBands.preferableShare).toFixed(0)}% preferable`, 'FHWA Table 9.9 bands (±150% under 1k riders … ±20% over 20k); 75% share used as the bar, as CTC does for links', band(m.fhwaLineBands.acceptableShare >= 0.75, m.fhwaLineBands.acceptableShare >= 0.6));
  add('Individual routes within ±25%', `${(100 * m.within25).toFixed(0)}% of routes`, 'UK DfT TAG M3.2: 95% of services within ±25% (strictest standard found)', band(m.within25 >= 0.95, m.within25 >= 0.6));
  tier = 'independent';
  add('BART exits, split among city stations', `r = ${V.bart.wkd.r.toFixed(2)} across ${V.bart.wkd.n} stations`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88', band(V.bart.wkd.r >= 0.88, V.bart.wkd.r >= 0.8));
  const OE = (V.bart as { outsideEntries?: { r: number; n: number; pctRmse: number } }).outsideEntries;
  if (OE) add('BART entries at stations outside the city, toward the city', `r = ${OE.r.toFixed(2)} across ${OE.n} stations; %RMSE ${OE.pctRmse.toFixed(0)}%`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88', band(OE.r >= 0.88, OE.r >= 0.8));
  const FE = (V as { ferry?: { r: number; n: number; pctRmse: number } }).ferry;
  if (FE) add('Ferry boardings, split among commuter routes', `r = ${FE.r.toFixed(2)} across ${FE.n} routes; %RMSE ${FE.pctRmse.toFixed(0)}%`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (the total is a calibration target)', band(FE.r >= 0.88, FE.r >= 0.8));
  const CR = (V as { caltrainRegional?: { groups: { daily: { r: number; n: number; pctRmse: number; totalRatio: number } }; segments: { peakStats: { r: number; n: number; pctRmse: number; totalRatio: number } } } }).caltrainRegional;
  if (CR) {
    const g = CR.groups.daily, sg = CR.segments.peakStats;
    add('Caltrain journeys to and from the city, by group of outside stations', `r = ${g.r.toFixed(2)} across ${g.n} groups; %RMSE ${g.pctRmse.toFixed(0)}%; total ${pc(g.totalRatio - 1)}`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (observed: 2024 OD survey at FY2026 volumes, an estimate)', band(g.r >= 0.88, g.r >= 0.8));
    add('Caltrain loads by stretch, peak periods and directions', `r = ${sg.r.toFixed(2)} across ${sg.n} stretches; %RMSE ${sg.pctRmse.toFixed(0)}%; total ${pc(sg.totalRatio - 1)}`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (links; includes background riders fixed from the same survey)', band(sg.r >= 0.88, sg.r >= 0.8));
  }
  // origin–destination markets (od-checks.ts): never fitted, so independent
  const OD = (V as { od?: { bart?: { daily: { r: number; n: number; pctRmse: number; totalRatio: number } }; inCommuters?: { distribution: { r: number; n: number }; transitShare: { r: number; n: number; pctRmse: number } } | null; riders?: { bartStations: { homeOriginShare: { observed: number | null; model: number } }[] } } }).od;
  if (OD?.bart) {
    const d = OD.bart.daily;
    add('BART journeys between each city station and each group of stations outside (and within the city), by direction', `r = ${d.r.toFixed(2)} across ${d.n} station–group–direction cells; %RMSE ${d.pctRmse.toFixed(0)}%; total ${pc(d.totalRatio - 1)}`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88; %RMSE below 40% (observed: BART station-to-station counts, August 2026)', band(d.r >= 0.88 && d.pctRmse < 40, d.r >= 0.8));
  }
  const CW = (V as { od?: { commute?: { districtTransit: { r: number; n: number; pctRmse: number }; tracts: { transit: { r: number; n: number } } } | null } }).od?.commute;
  if (CW) add('Commuters\' transit share by workplace district in the city', `r = ${CW.districtTransit.r.toFixed(2)} across ${CW.districtTransit.n} districts (tracts: r = ${CW.tracts.transit.r.toFixed(2)} across ${CW.tracts.transit.n}); %RMSE ${CW.districtTransit.pctRmse.toFixed(0)}%`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (observed: CTPP 2017–2021 Part 2; transit constants are fitted by home, never by workplace)', band(CW.districtTransit.r >= 0.88, CW.districtTransit.r >= 0.8));
  if (OD?.inCommuters) {
    const x = OD.inCommuters;
    add('In-commuters to the city by home PUMA (the Bay Area outside the city)', `r = ${x.distribution.r.toFixed(2)} across ${x.distribution.n} PUMAs`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (observed: ACS 2020–24 PUMS)', band(x.distribution.r >= 0.88, x.distribution.r >= 0.8));
    const tierWas = tier;
    tier = 'calibration';
    add('In-commuters\' transit share by home PUMA', `r = ${x.transitShare.r.toFixed(2)} across ${x.transitShare.n} PUMAs; %RMSE ${x.transitShare.pctRmse.toFixed(0)}%`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (a calibration target: transit constants by home PUMA)', band(x.transitShare.r >= 0.88, x.transitShare.r >= 0.8));
    tier = tierWas;
  }
  if (OD?.riders?.bartStations) {
    const rows = OD.riders.bartStations.filter((r) => r.homeOriginShare.observed != null).map((r) => ({ obs: r.homeOriginShare.observed!, mod: r.homeOriginShare.model }));
    const n = rows.length, mo = rows.reduce((a, r) => a + r.obs, 0) / n, mm = rows.reduce((a, r) => a + r.mod, 0) / n;
    const rr = rows.reduce((a, r) => a + (r.obs - mo) * (r.mod - mm), 0) / Math.sqrt(rows.reduce((a, r) => a + (r.obs - mo) ** 2, 0) * rows.reduce((a, r) => a + (r.mod - mm) ** 2, 0));
    add('Share of entries at each city BART station by riders setting out from home', `r = ${rr.toFixed(2)} across ${n} stations`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (observed: BART 2024 station profile survey)', band(rr >= 0.88, rr >= 0.8));
  }
  add('BART loads by segment', `r = ${V.bart.segments.r.toFixed(2)}; %RMSE ${V.bart.segments.pctRmse.toFixed(0)}%`, 'CTC RTP Guidelines: correlation coefficient ≥ 0.88 (links)', band(V.bart.segments.r >= 0.88, V.bart.segments.r >= 0.8));
  for (const r of V.tripLength.rows) {
    const d = r.model / r.observed - 1;
    add(`Trip length per boarding: ${r.mode}`, `${r.model.toFixed(2)} mi vs ${r.observed.toFixed(2)} (NTD) ${pc(d)}`, 'FHWA §6.2.4: average trip length within ±5%', band(Math.abs(d) <= 0.05, Math.abs(d) <= 0.15));
  }
  const bpl = V.reasonableness.boardingsPerLinkedTrip.model;
  add('Boardings per linked transit trip', bpl.toFixed(2), 'FHWA §9.2.5: typically 1.2–1.6', band(bpl >= 1.2 && bpl <= 1.6, bpl >= 1.1 && bpl <= 1.7));
  for (const s of V.sensitivity as { test: string; measure: string; elasticity: number; corridorElasticity?: number; corridor?: string[]; range: number[]; source: string }[]) {
    // a service change is scored on the riders its corridor gains (its own route also counts riders
    // moving over from parallel lines)
    const e = s.corridorElasticity ?? s.elasticity;
    const inside = e >= s.range[0] && e <= s.range[1];
    const near = e >= s.range[0] - 0.15 && e <= s.range[1] + 0.15;
    // the first citation only, with any parenthesis it opened closed
    let src = s.source.split(';')[0];
    if ((src.match(/\(/g) ?? []).length > (src.match(/\)/g) ?? []).length) src += ')';
    const val = s.corridorElasticity !== undefined ? `corridor ${s.corridorElasticity.toFixed(2)} (${s.corridor!.join(', ')}); route alone ${s.elasticity.toFixed(2)}` : `elasticity ${s.elasticity.toFixed(2)} (${s.measure})`;
    add(`Response: ${s.test}`, val, `${s.range[0]} to ${s.range[1]}: ${src}`, band(inside, near));
  }
  tier = 'held-out';
  if (B) {
    const beats = B.meanAbsErrorOfChange.model < B.meanAbsErrorOfChange.noChangeForecast;
    add('Backcast: route changes 2024→2026', `r = ${B.weightedCorrelationOfChange.toFixed(2)}; direction right on ${B.directionCorrectShare == null ? '–' : (100 * B.directionCorrectShare).toFixed(0) + '%'} of ${B.serviceChangedRoutes} routes with service changes`, 'Held-out test; should beat a no-change forecast', band(beats && B.weightedCorrelationOfChange > 0.3, beats));
  }
  tier = 'benchmark';
  add('Against MTC Travel Model One', `Muni route %RMSE ${m.pctRmse.toFixed(0)}% vs 66%`, 'TM1 2005 validation (MTC, 2011): local 68%, Metro 38%, all 66%', band(m.pctRmse < 66, m.pctRmse < 80));

  // the headline counts the tests (independent and held-out); the other tiers are shown beside them
  const tests = checks.filter((c) => c.tier === 'independent' || c.tier === 'held-out');
  const passed = tests.filter((c) => c.status === 'pass').length;
  const byTier = Object.fromEntries((['calibration', 'development', 'independent', 'held-out', 'benchmark'] as Tier[]).map((t) => [t, { total: checks.filter((c) => c.tier === t).length, passed: checks.filter((c) => c.tier === t && c.status === 'pass').length }]));
  const data = {
    built: V.modelBuilt,
    validation: V,
    backcast: B,
    checks,
    lede: `The model meets ${passed} of ${tests.length} tests drawn from FHWA, California Transportation Commission, UK DfT and TCRP guidance. Route by route it reproduces Muni ridership with a correlation of ${m.r.toFixed(2)} and a %RMSE of ${m.pctRmse.toFixed(0)}%, about half the error MTC's regional model reported for Muni. It responds to fares, frequency and driving costs within the ranges observed in practice. It misses the strictest route-level test (95% of routes within ±25%), and the shortfalls are listed at the end.`,
    tiers: [
      { name: 'Calibration targets', text: 'Fitted: commute mode by household cars (ACS 2024), residents’ mode shares (BATS 2023), transit by home neighborhood (ACS), in-commuters’ transit by home county and PUMA (ACS PUMS), BART exits and Caltrain boardings in the city, Muni’s system total, observed driving speeds (SFCTA), weekend system totals.' },
      { name: 'Development set', text: 'Looked at while improving structure, never fitted: weekday Muni boardings by route. Fixes it prompted were structural (fares paid once per trip, access spread over nearby stops, finer outside zones), not route-specific.' },
      { name: 'Independent tests', text: 'Data that played no part in building the model, scored: BART segment loads, the split of exits among city stations, entries at stations outside the city, BART journeys between city stations and outside station groups, in-commuters by home PUMA, commuters’ transit share by workplace district (CTPP), the home-origin share of BART entries in the city, ferry boardings by route, NTD trip lengths, boardings per linked trip, and elasticities against TCRP 95 and UK TAG. Reported without a score, for want of a standard: the time of day of BART exits and the shuttle share in BATS.' },
      { name: 'Held-out tests', text: 'Kept apart from all model development: a backcast to the 2024 Muni network, and weekend Muni boardings by route for the experimental weekend models.' },
    ],
    muniIntro: `SFMTA counts boardings on every route with automatic passenger counters. The model was never fitted route by route, but these counts were looked at while its structure was revised (a development set). Weekday and weekend counts are 12-month means to September 2026.`,
    backcastIntro: B
      ? `The calibrated model was run, unchanged, on the Muni schedule of June 2024 and on today’s. Between the summers of 2024 and 2026 ridership grew across the system (${pc(B.systemGrowthObserved - 1, 1)}, mostly from the return to offices, which this model holds fixed), so each route’s change is measured relative to the system. The question is whether the model predicts which routes grew faster or slower than the rest, given how their service changed.`
      : 'The backcast has not been run.',
    limits: [
      `Route-level fit misses the strictest standard: ${(100 * (1 - m.within25)).toFixed(0)}% of routes are more than 25% off. The largest weekday misses are ${m.routes.slice().sort((a: { observed: number; model: number }, b: { observed: number; model: number }) => Math.abs(b.model - b.observed) - Math.abs(a.model - a.observed)).slice(0, 4).map((r: { route: string; pct: number }) => `${r.route} (${r.pct > 0 ? '+' : ''}${r.pct.toFixed(0)}%)`).join(', ')}.`,
      'Trip-based, not activity-based: errand chains and household car sharing are simplified compared with SF-CHAMP or ActivitySim.',
      'Driving speeds are fitted to citywide averages by road type (SFCTA CMP), not street by street; car ownership, homes and jobs are fixed, so this is a short-to-medium-term model.',
      `The Saturday and Sunday models are experimental and are not graded above. Route by route they reach r = ${V.muni.sat.r.toFixed(2)} and ${V.muni.sun.r.toFixed(2)} with a %RMSE of ${V.muni.sat.pctRmse.toFixed(0)}% and ${V.muni.sun.pctRmse.toFixed(0)}%. Their trip rates come from the 2017 NHTS, their driving speeds are weekday midday's, and only two constants per day are fitted.`,
      'Cable car and historic streetcar ridership is a sightseeing generator scaled from 2019 counts (no current counts exist); visitor, airport and regional-visitor mode shares are assumed.',
      'Outside the city, places are represented by sub-zones of each city, so travel there (and AC Transit Transbay ridership in particular) is coarse.',
    ],
    sources: [
      'FHWA, Travel Model Validation and Reasonableness Checking Manual, 2nd ed. (FHWA-HEP-10-042, 2010): Table 9.9, §6.2.4, §7, §9.2.5.',
      'California Transportation Commission, Regional Transportation Plan Guidelines (2017, p. 49; 2024, p. 55).',
      'UK Department for Transport, TAG Unit M3.2 Public Transport Assignment (2024) and M2.1 Variable Demand Modeling (2025).',
      'TRB, TCRP Report 95: Traveler Response to Transportation System Changes, chapters 9 and 12 (2004); NCHRP Report 716 (2012).',
      'MTC, Travel Model One calibration and validation (2011; 2005 base year).',
      'Observed: SFMTA ridership by route and month; BART monthly ridership and hourly origin–destination files; Caltrain FY2026 ridership; FTA National Transit Database 2024; ACS 2020–24 and 2024; BATS 2023; SFCTA Congestion Management Program 2025.',
    ],
  };
  // the scorecard, for the app's methodology page
  fs.writeFileSync(path.join(ROOT, 'client/beta3/model/scorecard.json'), JSON.stringify({ passed, total: tests.length, byTier, checks, weekend }));
  const tpl = fs.readFileSync(path.join(ROOT, 'server/beta3/report/template.html'), 'utf8');
  const html = tpl
    .replace('/*DATA*/null', JSON.stringify(data))
    .replace(/%MODEL_NAME%/g, MODEL_NAME)
    .replace(/%MODEL_LONG_NAME%/g, MODEL_LONG_NAME)
    .replace(/%MODEL_VERSION%/g, MODEL_VERSION);
  fs.writeFileSync(path.join(ROOT, 'server/beta3/report/report.html'), html);
  console.log(`report: ${passed}/${tests.length} tests pass (${JSON.stringify(byTier)})`);
  for (const c of checks) console.log(`  ${c.status.padEnd(4)} ${c.what}: ${c.value}`);
}

main();
