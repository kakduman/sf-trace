import { MODEL_AUTHOR, MODEL_CITATION, MODEL_LONG_NAME, MODEL_NAME, MODEL_TAGLINE, MODEL_URL, MODEL_VERSION, MODEL_YEAR, PATH } from '../../../../shared/beta3/params';
import { BC, F, FX, muni, REF, tally, V, VX } from '../data';
import { champVerdict } from './front';
import { workShare } from './od';
import { citedOrder, esc, fx, isoDate, list, nw, pc, sec, section, tab, table } from '../doc';
import { REFS } from '../refs';
import GM from '../../../../server/beta3/reference/gateway-markets.json';
import RV from '../../../../server/beta3/reference/road-validation.json';
import RMJ from '../../../../server/beta3/reference/runmodes.json';

/** a model/observed ratio as words: "32% of its count" */
const ofCount = (m: number, o: number) => `${pc(m / o)} of its count`;
/** "12% below" or "8% above" */
const offBy = (ratio: number) => `${pc(Math.abs(ratio - 1))} ${ratio < 1 ? 'below' : 'above'}`;

/** the known gaps, each stated from the results so the sentence stays true when they change */
export function limitations(): string {
  const w = muni('wkd');
  const route = (r: string) => w.routes.find((x) => x.route === r);
  const T = route('T');
  const mission = ['14', '14R', '49'].map(route).filter((r): r is NonNullable<typeof r> => !!r);
  const missionObs = mission.reduce((a, r) => a + r.observed, 0), missionMod = mission.reduce((a, r) => a + r.model, 0);
  const v = champVerdict();
  const sc = tally();

  // BART's downtown stations
  const ex = V.bart.wkd.exits;
  const st = (code: string) => ex.find((e) => e.code === code);
  const dt = ['EMBR', 'MONT', 'CIVC'].map(st).filter((e): e is NonNullable<typeof e> => !!e);
  const short = (e: (typeof dt)[number]) => e.name.replace(/ \/.*$/, '').replace(/ Street$/, '');
  const lowDt = dt.filter((e) => e.model / e.observed < 0.95), highDt = dt.filter((e) => e.model / e.observed > 1.05);
  const exitText = (e: (typeof dt)[number], i: number) => `${offBy(e.model / e.observed)}${i === 0 ? ' the count' : ''} at ${short(e)}`;

  // Muni's level by residence (calibrate.ts), when the facts carry it
  const C = FX.calibration as unknown as { nonResTransitLevel?: number | null; muniLevelFit?: { residents: [number, number]; nonResidents: [number, number] } | null; muniByResidence?: { residents: [number, number]; nonResidents: [number, number] } | null };
  const lv = C.muniLevelFit ?? C.muniByResidence ?? null;
  const nrLevel = C.nonResTransitLevel ?? null;
  const atBound = (x: number) => x <= 0.8 + 1e-6 || x >= 2 - 1e-6;

  // Caltrain: morning arrivals in the city against the survey's estimate; in-commuters' transit shares by county
  const dirFit = (F.calibration as unknown as { caltrainDirFit?: { arrivalsAM?: [number, number] } | null }).caltrainDirFit?.arrivalsAM ?? null;
  const ctArr = (REF.commutesResults as unknown as { after?: { caltrainArrivalsAM?: { model: number; observed: number } } }).after?.caltrainArrivalsAM;
  const ctAm = dirFit ? dirFit[0] / dirFit[1] : ctArr ? ctArr.model / ctArr.observed : null;
  const ws = workShare();
  const cf = (F.calibration as unknown as { countyFit?: { in?: Record<string, [number, number]> } | null }).countyFit?.in ?? null;
  const pen = cf ? (['San Mateo', 'Santa Clara'] as const).filter((k) => cf[k]).map((k) => ({ k, m: cf[k][0], t: cf[k][1] })) : [];
  const penFit = pen.length > 0 && pen.every((p) => Math.abs(p.m - p.t) < 0.02);

  // sensitivity: route-level responses
  const sens = VX.sensitivity;
  const fe = sens.filter((s) => s.test.includes('service +25%')).map((s) => s.elasticity);
  const speed = sens.find((s) => s.measure.includes('14R'));
  const tooLarge = (fe.length > 0 && Math.max(...fe) > 0.8) || (!!speed && speed.elasticity < speed.range[0]);

  // roads: the model's own cars at the city line against the counts less trucks and through trips; midday freeway speeds against INRIX
  const gw = (GM as unknown as { model: { today: { gateways: { name: string; count: number; trucks: number; through: number; model: number }[] } } }).model.today.gateways;
  const own = (names: string[]) => {
    const g = gw.filter((x) => names.includes(x.name));
    const need = g.reduce((a, x) => a + x.count - x.trucks - x.through, 0);
    return g.length && need > 0 ? g.reduce((a, x) => a + x.model, 0) / need : null;
  };
  const ggOwn = own(['Golden Gate']), lineOwn = own(['US-101', 'I-280', 'SR-35', 'SR-82']);
  const fwyMd = (RV as unknown as { inrix?: Record<string, { ratio: number }> }).inrix?.['freeway MD']?.ratio ?? null;

  // Quick against Precise (runmodes.json): within what share of Precise's change Quick came, with the streets left alone and changed
  const rms = (RMJ as unknown as { summary?: { scenarios: number; transitTripsPct: number; timeSavingsPct: number; streets?: { scenarios: number; transitTripsPct: number; timeSavingsPct: number } } }).summary ?? null;

  const beats = BC.meanAbsErrorOfChange.model < BC.meanAbsErrorOfChange.noChangeForecast;
  const sa = muni('sat'), su = muni('sun');

  const gaps: string[] = [
    `<p><i>Muni's routes.</i> On weekday Muni boardings by route, SF-TRACE's %RMSE is ${fx(w.pctRmse, 0)}%, ${v.word} SF-CHAMP 3's ${v.them}%${v.margin ? ` (${v.margin})` : ''}, and ${pc(1 - w.within25)} of routes are more than 25% from their counts (${sec('val-muni')}). These counts were examined during development, so the error on routes never examined could be larger. The largest misses are the T${T ? `, which carries ${ofCount(T.model, T.observed)}` : ''}, and the Mission Street routes${mission.length ? ` (${list(mission.map((r) => r.route))}), which together carry ${pc(missionMod / missionObs)} of theirs` : ''}. The T's shortfall is not a matter of capacity or schedule: the model sends many of the southeast's riders to parallel buses instead.</p>`,
    `<p><i>Who rides Muni.</i> ${ws ? `Work trips make up ${pc(ws.bus[0])} of the model's Muni bus riders and ${pc(ws.lightRail[0])} of its light-rail riders, against ${pc(ws.bus[1])} and ${pc(ws.lightRail[1])} in MTC's on-board survey` : "The share of Muni riders on work trips is below the share in MTC's on-board survey"} (${sec('val-markets')}), so the model carries too few commuters on Muni. ${lv ? `Non-residents' boardings on the counted routes are ${offBy(lv.nonResidents[0] / lv.nonResidents[1])} the part of the count that the survey assigns them (${fx(lv.nonResidents[0] / 1000, 0)} thousand against ${fx(lv.nonResidents[1] / 1000, 0)} thousand)` : "Non-residents' boardings on the counted routes fall short of the part of the count that the survey assigns them"}${nrLevel != null ? `, and the factor that sets their transit level ${atBound(nrLevel) ? `sits at its bound (${fx(nrLevel, 2)}; it is bounded at 0.8 and 2)` : `is ${fx(nrLevel, 2)} (bounded at 0.8 and 2)`}` : ''}. Most of that shortfall is on legs to and from BART, Caltrain, and the ferries, which a factor on their trips within the city cannot reach (${sec('calibration')}).</p>`,
    `<p><i>BART downtown.</i> BART's exits at the city's stations fit well overall (r = ${fx(V.bart.wkd.r, 2)} over ${nw(V.bart.wkd.n)} stations), but the split among the downtown stations does not. ${dt.length ? `The model's exits are ${list(dt.map(exitText))}` : 'The downtown stations differ from their counts'}${lowDt.length && highDt.length ? `, so riders whom the counts put at ${list(lowDt.map(short))} leave the model's trains at ${list(highDt.map(short))}` : ''} (${sec('val-rail')}). The stations are a few blocks apart, and the walk from each block to the platforms decides the split. BART entries at stations outside San Francisco fit poorly (r = ${fx(V.bart.outsideEntries.r, 2)}), since outside the city the model represents whole cities, not neighborhoods.</p>`,
    `<p><i>Caltrain.</i> ${ctAm != null ? `Morning arrivals in the city by Caltrain are ${offBy(ctAm)} the estimate from the 2024 origin–destination survey` : 'Morning arrivals in the city by Caltrain differ from the estimate from the 2024 origin–destination survey'}, ${penFit ? `while the transit shares of in-commuters from ${list(pen.map((p) => p.k))} counties fit their ACS targets (${list(pen.map((p) => `${pc(p.m, 1)} against ${pc(p.t, 1)}`))})` : 'while the transit shares of in-commuters from the Peninsula counties are calibrated to the ACS'}. As the model is specified, both cannot hold: more Caltrain riders into the city in the morning would mean more transit commuters from the Peninsula than the census counts, unless many of those riders are not commuting to work, which neither source settles.</p>`,
    `<p><i>Roads.</i> The road model is a static assignment (${sec('roads')}). It carries no queues from one period to the next, and its midday freeway speeds are ${fwyMd != null ? `${pc(fwyMd - 1)} faster than INRIX measures` : 'faster than measured'}. Its own cars are short of the counts at the city line${ggOwn != null && lineOwn != null ? `: at the Golden Gate Bridge they make up ${pc(ggOwn)} of the traffic left once trucks and through trips are taken out, and at the San Mateo county line ${pc(lineOwn)}` : ''}. The fixed background traffic fills the difference, so a scenario changes that part of the traffic only through its effect on speeds. Driving legs to and from Marin use assumed speeds, since no published speeds cover them. Commercial and through traffic are fixed.</p>`,
    rms?.streets ? `<p><i>Quick runs.</i> The Quick run mode is an approximation (${sec('runmodes')}). On the test scenarios that leave the streets alone, its changes in transit trips came within ${rms.transitTripsPct}% of Precise's and its time savings within ${rms.timeSavingsPct}%. Where a scenario changes streets or what driving costs, its approximate road response is much rougher: on ${nw(rms.streets.scenarios)} such scenarios its transit trips differed from Precise's by up to ${rms.streets.transitTripsPct}% and its time savings by up to ${rms.streets.timeSavingsPct}%. Such scenarios should be run in Precise.</p>` : '',
    `<p><i>Demand.</i> Residents' tours are computed for groups by zone, car ownership, income, and person type. Household members do not share cars or escort children, and a tour's mode is chosen without regard to the stops it will make. The person-level layer (${sec('abm')}) is optional${(F.calibration as unknown as { abmOn?: boolean }).abmOn ? ' and switched on in the delivered model' : ' and switched off in the delivered model'}. Homes, jobs, and working from home are fixed inputs, so the model describes the short- to medium-term response to a change in service. NHTS 2017 supplies the timing of tours, and the timing of tours other than commutes has no post-pandemic check. Event days' extra service and weekend events are not modeled. Visitors', air travelers', and regional visitors' mode shares are assumed, and the number of shuttle riders rests on the assumption that residents who commute by bus to the Peninsula and Silicon Valley ride employer shuttles.</p>`,
    `<p><i>Responses.</i> ${tooLarge ? 'Single routes respond to frequency and running time more strongly than published elasticities suggest' : 'The route-level responses tested fall within published ranges'} (${sec('val-sensitivity')}). Riders at a stop share themselves among all attractive lines, and the logit spread of each block's riders over its access stops (θ = ${PATH.accessTheta} per minute, assumed) lets riders move to a nearby stop on another route for a small difference in cost, so parallel lines are close substitutes. In the backcast the model ${beats ? 'improved on' : 'did not improve on'} a forecast of no change (${sec('val-backcast')}). Crowding and demand settle over a few passes but are not solved to a strict equilibrium (${sec('iteration')}). The measured wait factors come from one weekday and stay fixed in a scenario, so a change in frequency or running time does not change a route's reliability.</p>`,
    `<p><i>Weekends.</i> The Saturday and Sunday models are experimental. Their route %RMSE is ${fx(sa.pctRmse, 0)}% on Saturdays and ${fx(su.pctRmse, 0)}% on Sundays (${sec('val-weekend')}), and they need weekend survey data before their results can be relied on.</p>`,
  ];

  return section('limitations', 'Limitations and known gaps', `
<p>SF-TRACE meets ${sc.passed} of the ${sc.tests.length} independent and held-out tests (${sec('val-scorecard')}). The gaps below are the ones a user should know before relying on a result. Each is stated from the current results.</p>
${gaps.filter(Boolean).join('\n')}
<p>The model is therefore suited to comparing service changes at the level of corridors and the system, and to exploring them interactively. Without calibration against an on-board origin–destination survey, it is not suited to forecasting the ridership of a single route after a change, or BART station use outside the city. Its results are averages for a typical weekday in 2026, not forecasts for a particular date.</p>
`);
}

export function reproducibility(): string {
  const cmds: [string, string, string][] = [
    ['npm run model:fetch', 'fetch-data.ts, fetch-osm.ts, fetch-elevation.ts, fetch-micromobility.ts', 'Download GTFS, LODES, ACS, census geography, neighborhoods, parks, points of interest, the OpenStreetMap street network, elevation tiles, and Bay Wheels\' trip histories and station feed into data/beta3/raw (not in the repository)'],
    ['npm run model:build', 'streets.ts, zones.ts, synpop-seed.ts, synpop.ts, transit.ts, skims.ts, micromob-skims.ts, build.ts, streets-bundle.ts', 'Street graph, zones, synthetic population, transit network, level-of-service matrices, shared bikes\' and scooters\' stations and times, and the model bundle client/beta3/model/sf.bin.gz'],
    ['npm run model:calibrate', 'calibrate.ts, micromob-fit.ts, autoown.ts, build.ts, calibrate-autoown.ts, baseline.ts, roads.ts, road-shapes.ts, roads-base.ts, gateways.ts', `Calibration (${sec('calibration')}), the shared vehicles' constants, the car ownership model and its constants, the base runs for each day type, the road network, and today's road equilibrium (${sec('roads')})`],
    ['npm run model:runmodes', 'runmodes.ts', `Quick and Precise runs of the test scenarios and their comparison (${sec('runmodes')})`],
    ['BETA3_VARIANT=2024 npx tsx server/beta3/pipeline/transit.ts, then skims.ts and build.ts with the same variable', 'transit.ts, skims.ts, build.ts', 'The July 2024 Muni network for the backcast (work files only)'],
    ['python3 server/beta3/pipeline/caltrain_css.py, then npx tsx server/beta3/pipeline/regional-od.ts', 'caltrain_css.py, regional-od.ts', 'BART and Caltrain station-to-station journeys by period and day type (reference/regional-od.json)'],
    ['npx tsx server/beta3/pipeline/background.ts (twice after a calibration), then baseline.ts', 'background.ts, station-od.ts', `Background riders with no end in the city on BART and Caltrain (${sec('assignment')})`],
    ['npx tsx server/beta3/pipeline/backcast.ts', 'backcast.ts', `Backcast with the conditions of July 2024 and its split by condition (${sec('val-backcast')})`],
    ['npx tsx server/beta3/pipeline/validate.ts', 'validate.ts, bart-segments.ts, caltrain-segments.ts', `Validation statistics and sensitivity tests (${sec('validation')})`],
    ['npx tsx server/beta3/pipeline/portal.ts', 'portal.ts', `The Portal scenario (${sec('scen-portal')})`],
    ['npx tsx server/beta3/pipeline/uncertainty.ts', 'uncertainty.ts', `Runs with drawn parameters for the example scenarios (${sec('scen-uncertainty')})`],
    ['npx tsx server/beta3/pipeline/report.ts', 'report.ts', 'Scorecard and the stand-alone validation report'],
    ['npx tsx client/beta3/paper/export-facts.ts', 'export-facts.ts', 'Counts, calibrated values, and pipeline constants read by this article'],
    ['python3 server/beta3/pipeline/nhts_tours.py (and nhts_persontypes.py, nhts_triplength.py, peak_hour.py, nhts_daytypes.py)', 'nhts_*.py, peak_hour.py', 'NHTS 2017 tour and stop rates, person-type rates, trip lengths, transit riders by hour, and weekend rates and shares'],
    ['npm test', 'test/beta3*.test.ts', 'Unit tests of the bundle format, optimal strategies, crowding, capacity at boarding, fares, roads, scenario edits, and this article'],
  ];
  return section('reproducibility', 'Data, code, and reproducibility', `
<p>The model's source code, the pipeline scripts, this article's source, and the reference files with the observed data and published parameters are in the Git repository at <a href="https://github.com/kakduman/sf-trace">github.com/kakduman/sf-trace</a>, under <code>shared/beta3/</code>, <code>server/beta3/</code>, and <code>client/beta3/</code>. The repository has no license file or archived DOI at the time of writing. The raw downloads are not in the repository; the fetch scripts and the reference files give the URL and access date of each.${F.bundleBuilt ? ` The results reported here come from the model bundle built ${isoDate(F.bundleBuilt)}.` : ''}</p>
<p>Every input is public, and the pipeline can be rerun from the repository. ${tab('commands')} lists the steps in order; scripts are in <code>server/beta3/pipeline/</code>. The Node scripts that run the model need about 3 GB of memory. Observed data and published parameters are kept under <code>server/beta3/reference/</code>, each with its source URL, the date it was accessed, and notes on how it was derived; <code>PARAMS.md</code> and <code>VALIDATION-STANDARDS.md</code> there summarize them. A few inputs were downloaded by hand and are named in those files: the AC Transit and SamTrans feeds, the archived July 2024 Muni feed, MTC's TAZ1454 land use and zone boundaries, the NHTS 2017 public-use files, and the standards documents.</p>
<p>The k-means split of large external places is seeded from the blocks with the most commuters, so the zone system is the same on every build. Calibration starts from the constants stored in the current bundle, so rerunning <code>model:calibrate</code> continues from the delivered values rather than reproducing the path to them. The code that runs in the browser and in Node is the same: <code>shared/beta3/</code> holds the demand model (<code>demand.ts</code>), the network and path search (<code>net.ts</code>, <code>strategy.ts</code>), the roads (<code>roads.ts</code>, <code>traffic.ts</code>), the run loop (<code>model.ts</code>), and the parameters with their sources (<code>params.ts</code>). The article reads its numbers at build time from the result files in <code>client/beta3/model/</code>, from <code>facts.json</code> (written by <code>export-facts.ts</code>), from the reference files, and from <code>params.ts</code>, so rerunning the pipeline and rebuilding the page updates every figure and table.</p>
${table('commands', 'Pipeline steps.', ['Command', 'Scripts', 'Output'], cmds.map(([a, b, c]) => [`<code>${a}</code>`, b, c]), { wide: true, cls: 'commands' })}
`);
}

export function howToCite(): string {
  const url = MODEL_URL || '[URL to be added]';
  const bib = `@software{sftrace,
  author  = {${MODEL_AUTHOR}},
  title   = {{${MODEL_NAME}}: ${MODEL_LONG_NAME}},
  note    = {${MODEL_TAGLINE}},
  version = {${MODEL_VERSION}},
  year    = {${MODEL_YEAR}},
  url     = {${url}}
}`;
  return section('cite', 'How to cite', `
<p>Please cite the model with its version:</p>
<p class="citation">${esc(MODEL_CITATION)}</p>
<p>In BibTeX:</p>
<pre class="bibtex"><code>${esc(bib)}</code></pre>
<p>Results depend on the version and on the model bundle, so a report that uses SF-TRACE should give both. The bundle's date is at the top of this article and on the app's About tab.</p>
`);
}

export function references(): string {
  const keys = citedOrder();
  const unused = (Object.keys(REFS) as (keyof typeof REFS)[]).filter((k) => !keys.includes(k));
  if (unused.length) console.warn(`references never cited: ${unused.join(', ')}`);
  return `<section id="references" aria-labelledby="references-h"><h2 id="references-h">References</h2><ol class="refs">${keys.map((k) => `<li id="ref-${k}">${REFS[k]}</li>`).join('')}</ol></section>`;
}
