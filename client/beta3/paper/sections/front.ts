import { BC, BENCH, benchRow, F, FX, GTFS_VALIDATION as GV, muni, REF, tally, V, type BenchRow, type BenchStats } from '../data';
import { HOTEL_ROOMS_SF, MODEL_LONG_NAME, MODEL_NAME, MODEL_TAGLINE, MODEL_VERSION, MODEL_AUTHOR, MODEL_AUTHOR_NOTE, MODEL_AUTHOR_URL } from '../../../../shared/beta3/params';
import { cap, cite, fx, int, isoDate, list, nw, pc, sec, secs, section, tab, table, ymd } from '../doc';
import type { RefKey } from '../refs';

const METRO = new Set(['J', 'K', 'L', 'M', 'N', 'T', 'S']);
/** %RMSE and r of a set of routes, as validate.ts computes them */
function fit(rows: { observed: number; model: number }[]) {
  const n = rows.length;
  const mo = rows.reduce((a, r) => a + r.observed, 0) / n, mm = rows.reduce((a, r) => a + r.model, 0) / n;
  const sxy = rows.reduce((a, r) => a + (r.observed - mo) * (r.model - mm), 0);
  const sxx = rows.reduce((a, r) => a + (r.observed - mo) ** 2, 0), syy = rows.reduce((a, r) => a + (r.model - mm) ** 2, 0);
  return { n, pctRmse: (100 * Math.sqrt(rows.reduce((a, r) => a + (r.model - r.observed) ** 2, 0) / n)) / mo, r: sxy / Math.sqrt(sxx * syy), within25: rows.filter((r) => Math.abs(r.model / r.observed - 1) <= 0.25).length / n };
}
/** a benchmark's correlation: r as published, or the square root of a published R² */
const rOf = (s: BenchStats | null) => (s?.r ?? (s?.r2 != null ? Math.sqrt(s.r2) : null));
/** "%RMSE 66%, r = 0.82, 22% within ±25% (68 routes)" from what a benchmark publishes */
function statText(s: BenchStats | null): string {
  if (!s) return '–';
  const parts = [
    s.pctRmse != null ? `%RMSE ${fx(s.pctRmse, 0)}%` : '',
    s.r != null ? `r = ${fx(s.r, 2)}` : s.r2 != null ? `R² = ${fx(s.r2, 2)}` : '',
    s.within25 != null ? `${pc(s.within25)} within ±25%` : '',
  ].filter(Boolean);
  const body = parts.length ? `${parts.join(', ')}${s.n ? ` (${int(s.n)})` : ''}${s.computed ? '<sup>a</sup>' : ''}` : '';
  return [body, s.note ?? ''].filter(Boolean).join('; ') || '–';
}
const benchCite = (b: BenchRow) => cite(...b.refs.map((k, i) => (i === 0 && b.loc ? ([k as RefKey, b.loc] as [RefKey, string]) : (k as RefKey))));

export function front(): string {
  const w = muni('wkd');
  const beats = BC.meanAbsErrorOfChange.model < BC.meanAbsErrorOfChange.noChangeForecast;
  const T = tally();
  const AG: Record<string, string> = Object.fromEntries(F.feeds.map((f) => [f.key, f.agency]));
  const gv = Object.entries(GV.feeds);
  const withErr = gv.filter(([, f]) => (f.bySeverity.ERROR ?? 0) > 0);
  const wkdDays = F.feeds.map((f) => f.wkd).sort();
  const months = /([A-Z][a-z]+ \d{4}) – ([A-Z][a-z]+ \d{4})/.exec(F.observed.muniPeriod);
  const muniVintage = months ? `${months[1]} to ${months[2]}, twelve-month means of weekdays, Saturdays, and Sundays; July of 2024 and 2026 (backcast)` : F.observed.muniPeriod;
  const stamp = (t: string) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const tagline = MODEL_TAGLINE.charAt(0).toLowerCase() + MODEL_TAGLINE.slice(1);

  return `
<header class="front">
  <h1 id="title">${MODEL_NAME}: ${tagline}</h1>
  <p class="byline"><a href="${MODEL_AUTHOR_URL}">${MODEL_AUTHOR}</a><sup>*</sup> · version ${MODEL_VERSION}</p>
  <p class="author-note"><sup>*</sup> ${MODEL_AUTHOR_NOTE}</p>
  <p class="meta">Model bundle built ${isoDate(F.bundleBuilt)}. Validation run ${isoDate(V.generated)}. Every number in this article is read from the model's output files when the page is built.</p>
  ${V.modelBuilt !== F.bundleBuilt ? `<p class="notice" role="note">The validation results were computed on the bundle built ${stamp(V.modelBuilt)} UTC, which predates the current bundle (built ${stamp(F.bundleBuilt)} UTC). ${secs('model', 'calibration')} describe the current bundle; the validation and scenario results come from the earlier run until the validation is repeated.</p>` : ''}
  <p class="app-link"><a class="btn" href="../">Open the model</a> <span>${MODEL_NAME} runs in the browser.</span></p>
</header>

<section class="abstract" aria-labelledby="abstract-h">
  <h2 id="abstract-h">Abstract</h2>
  <p>${MODEL_NAME}, the ${MODEL_LONG_NAME}, is ${tagline}. It is a tour-based travel model of the city that runs in a web browser, built entirely from public data, and this article documents version ${MODEL_VERSION}: its data, structure, calibration, and validation. Residents' tours are generated for ${F.counts.zones} block-group zones from the American Community Survey, LEHD LODES, the 2017 National Household Travel Survey, and the 2023 Bay Area Travel Study (BATS). Destinations are chosen on mode-choice logsums, modes by a nested logit with coefficients from the Metropolitan Transportation Commission's Travel Model One, and transit paths by headway-based optimal strategies with measured reliability and crowding. A static road assignment of the city's streets and the Peninsula freeways gives driving times. Mode constants and a few path parameters are calibrated to census commute shares, BATS 2023, Muni's total boardings, and counts on BART, Caltrain, and the ferries. Muni's route counts are not fitted one by one. Against them, weekday boardings on ${w.n} routes correlate at r = ${fx(w.r, 2)}, with a percent root mean square error (%RMSE) of ${fx(w.pctRmse, 0)}%, and ${pc(w.within25)} of routes are within ±25% of their counts. ${champSentence()} SF-TRACE meets ${T.passed} of the ${T.tests.length} independent and held-out tests scored against published standards. In a backcast to the ${ymd(F.backcastFeed.wkd).replace(/ \d+,/, '')} Muni network, modeled changes by route correlated with counted changes at a rider-weighted r = ${fx(BC.weightedCorrelationOfChange, 2)}, and the model ${beats ? 'improved on' : 'did not improve on'} a forecast of no change. The article applies the model to four scenarios: the Portal (Caltrain's downtown extension), fare-free Muni, a peak charge to drive into Downtown and SoMa, and bus lanes, and it states the known gaps plainly.</p>
  <p class="keywords"><span>Keywords</span> travel demand model; tour-based model; transit assignment; optimal strategies; model validation; backcasting; San Francisco; open source software</p>
</section>
<div id="toc-mobile" class="toc-mobile"></div>

${section('intro', 'Introduction', `
<p>Transit ridership forecasts in the San Francisco Bay Area come mainly from two activity-based models: the Metropolitan Transportation Commission's (MTC's) Travel Model One, which covers the nine-county region ${cite('tm1Code')}, and the San Francisco County Transportation Authority's (SFCTA's) SF-CHAMP, which covers the city in more detail ${cite('sfchamp2002', 'sfchampDocs')}. Both run in commercial network software, operated by agency staff or consultants. Travel Model One's code and documentation are published, but its transit skims and assignment are Cube scripts, so running it needs a Cube license and a dedicated modeling computer. A member of the public or an advocacy group that wants to test a change to a bus route cannot practically run either model.</p>
<p>${MODEL_NAME} was built to make that kind of test possible without special software. It is written in TypeScript, so the whole model, its zone data, and its networks load into a browser tab. A user can add or remove routes and stops, change frequencies, running times, fares, street space, and car prices, and rerun the model on their own computer. Its parameters come from published Bay Area models where possible, and its constants are calibrated to recent San Francisco surveys and counts. It is meant for transport planners, researchers, and advocates who want to compare service changes at the level of corridors and the system.</p>
<p>The validation is reported by how much the model was fitted to each comparison: calibration targets; a development set (Muni's route counts, examined while the structure was revised but not fitted route by route); independent tests whose data were never used in building the model; and held-out tests (a backcast and the weekend route counts). The statistics are compared with the thresholds in the FHWA validation manual ${cite('fhwa2010')}, the California Transportation Commission's regional plan guidelines ${cite('ctc2017', 'ctc2024')}, and the UK Department for Transport's TAG units ${cite('tagM32', 'tagM21')}.</p>
<p>${sec('compare')} sets SF-TRACE's fit beside the published validation of agency models, and ${sec('related')} places it among related tools. ${cap(sec('data'))} lists the data. ${cap(sec('model'))} sets out the model, ${sec('calibration')} what is calibrated to what, and ${sec('validation')} the validation, all for an average weekday. ${cap(sec('scenarios'))} applies the model to four scenarios. ${cap(sec('limitations'))} states the known gaps, ${sec('reproducibility')} describes how to rebuild the model and every result here, and ${sec('cite')} gives the citation.</p>
${compareSection()}
${section('related', 'Related work', `
<p>Several other tools address parts of the same problem. SF-CHAMP 6 uses the DaySim activity-based demand model ${cite('sfchampDocs')}, and Travel Model One is a tour-based model of the CT-RAMP family ${cite('tm1Code')}. Agent-based simulation in MATSim represents each traveler's day and the interactions on the network ${cite('matsim')}. BEAM, built on MATSim at Lawrence Berkeley National Laboratory, adds on-demand mobility, parking, and within-day mode choice ${cite('beam')}. The eqasim pipeline, first developed for Paris ${cite('eqasimParis')}, builds synthetic populations and MATSim scenarios from open data, with examples for the San Francisco Bay Area and San Diego County ${cite('eqasimCa')}. For transit, Fast-Trips performs dynamic, schedule-based passenger assignment with vehicle capacity and reliability ${cite('fastTrips')}, exchanging networks and demand in the GTFS-PLUS and Dyno-Demand formats ${cite('gtfsPlus')}, and FDOT's TBEST estimates ridership stop by stop from land use and service ${cite('tbest')}. Routing engines such as Conveyal's R5, used through r5r ${cite('r5r')}, and OpenTripPlanner ${cite('otp')} compute travel times and accessibility from GTFS and OpenStreetMap but do not forecast demand; Higgins et al. found that accessibility results depend on each tool's routing algorithm ${cite('higgins')}. Commercial software such as Remix lets agencies draw service changes and see their cost and coverage ${cite('remix')}.</p>
<p>${MODEL_NAME} differs from these in combining a full demand model with transit and road assignment in a form that needs no installation, built only from public data, with its route-level results checked against SFMTA's counts.</p>
`)}
`)}

${section('data', 'Study area and data', `
<p>The study area is the City and County of San Francisco. In the model's zone data the city has ${int(F.totals.pop)} residents in ${int(F.totals.hh)} households, ${pc(F.totals.hhVeh[0] / F.totals.hh)} of which have no car, and ${int(F.totals.workers)} employed residents (ACS table B23025; the commute tables, which count workers who worked during the reference week, give fewer). The zones hold ${int(F.totals.jobs)} jobs after the rebalancing described in ${sec('zones')}. The ACS reports ${int(REF.acs.workersWorkingInSF_B08604.totalWorkersAtSFWorkplaces)} workers at San Francisco workplaces, and ${pc(REF.acs.workplaceCommuteMode_B08406.modes.transit.shareOfCommuters_exclWFH)} of those who travel to them (excluding people working at home) go by transit ${cite('acs')}.</p>
<p>${tab('data')} lists every dataset, its vintage, and its role. All are public. The pipeline's fetch scripts downloaded them in October 2026, or they are recorded, with their sources and access dates, in the repository's reference files.</p>
${table(
  'data',
  'Data sources.',
  ['Dataset', 'Vintage', 'Use in the model'],
  [
    [`2020 Census blocks and block groups ${cite('census2020')}`, '2020', 'Zone geography, block populations for weighting access points'],
    [`American Community Survey ${cite('acs')}`, '2020–24 5-year; 2024 1-year', 'Households by cars and income, ages, workers, enrollment, and commute mode by block group; commute mode by cars available (B08141); place of work (B08007, B08604, B08406); working from home'],
    [`ACS Public Use Microdata Sample ${cite('acsPums')}`, '2020–24 5-year', 'Commute mode between San Francisco and each county (calibration); residents commuting by bus to San Mateo and Santa Clara counties (shuttle riders)'],
    [`ACS Public Use Microdata Sample, housing file ${cite('acsPums1y')}`, '2024 1-year', 'San Francisco households by vehicles and income (the seed for splitting each zone\'s households)'],
    [`LEHD LODES 8 ${cite('lodes')}`, '2023', 'Jobs by sector and block; home-to-work flows'],
    [`MTC Travel Model One land use, TAZ1454 ${cite('tm1Code')}`, '2023', 'Employment by sector and zone (rebalancing LODES), college and high-school enrollment, parking costs, and terminal times'],
    [`OpenStreetMap ${cite('osm')}`, 'October 2026', `Street and path network (${int(F.streets?.vertices ?? 0)} intersections and ends); schools, hotels, attractions`],
    [`USGS 3DEP elevation ${cite('terrain')}`, `Terrain Tiles, zoom ${F.elevationZoom}`, 'Grades for walking and cycling times'],
    [`SF Analysis Neighborhoods ${cite('datasfNhoods')}`, 'current', 'Neighborhood of each zone (transit constants)'],
    [`GTFS schedules ${cite('gtfs')}`, `Weekday service days ${wkdDays[0].slice(0, 4) === wkdDays[wkdDays.length - 1].slice(0, 4) ? ymd(wkdDays[0]).replace(/, \d{4}$/, '') : ymd(wkdDays[0])} to ${ymd(wkdDays[wkdDays.length - 1])}`, `Transit network: ${list(F.feeds.map((f) => f.agency))}; Saturday and Sunday service for the weekend models (${sec('weekend-model')})`],
    [`Archived Muni GTFS ${cite('gtfs')}`, `Service from ${ymd(F.backcastFeed.wkd)}`, `Backcast network (${sec('val-backcast')})`],
    [`2017 NHTS, San Francisco–Oakland CBSA ${cite('nhts2017')}`, '2017', 'Tour rates by purpose and person type, stops and their detours, trip lengths, time-of-day and direction shares, transit riders by hour; weekend rates and shares'],
    [`2023 Bay Area Travel Study ${cite('bats2023', 'bats2023t45')}`, '2023', 'Mode shares and number of trips of San Francisco residents (calibration); commute frequency by home county'],
    [`CDE school enrollment ${cite('cdeEnroll')}`, '2025–26', 'Enrollment and location of public, charter, and private K–12 schools'],
    [`SFMTA Commuter Shuttle Program ${cite('sfmtaShuttles')}`, '2017 report; stops 2024', 'Approved shuttle stops; last published ridership'],
    [`Free Muni for Seniors ${cite('freeMuni')}`, 'FY2024–25', 'Seniors riding Muni free'],
    [`SFCTA Congestion Management Program ${cite('sfctaCmp')}`, '2025; hourly data to September 2026', 'Driving speeds by road type and period'],
    [`SFMTA ridership by route ${cite('sfmtaRidership')}`, muniVintage, `Muni's total (calibration); route counts (development set); backcast; weekend counts; cable car and historic streetcar averages for 2019 (${sec('special')})`],
    [`BART ridership ${cite('bartRidership')}`, 'August 2026; hourly September–November 2025; July 2024 and 2026', `Station exits (calibration), segment loads, outside-station entries, and time of day; weekend exits; journeys with neither station in the city (background riders, ${sec('assignment')})`],
    [`Caltrain ridership ${cite('caltrainRidership')}`, 'FY2026', 'Boardings at the city stations (calibration); boardings at every station (background riders and validation)'],
    [`Caltrain origin–destination survey ${cite('caltrainOD2024')}`, 'May 2024', `Boarding-to-alighting matrix by station group, riders by direction and time of day: background riders and validation of journeys to and from the city (${sec('val-rail')})`],
    [`Caltrain triennial and customer satisfaction surveys ${cite('caltrainTriennial2025', 'caltrainCss2025')}`, 'May and fall 2025', 'Peak and off-peak riders (fall 2025 count); boarding times by station'],
    [`Ferry ridership ${cite('ferryRidership')}`, 'FY2026; Golden Gate Ferry FY2025', 'Boardings on the commuter routes (calibration in total; validation by route)'],
    [`Cal-ITP stop time metrics ${cite('calitp')}`, FX.reliability?.day ? ymd(FX.reliability.day) : 'June 2026', 'Muni wait factors from realtime arrivals'],
    [`Station parking ${cite('stationParking')}`, '2026', 'Lots and daily fees at stations and terminals outside the city'],
    [`Park visitation ${cite('parkVisits', 'doloresPark')}`, 'various, 2016 to 2025', 'Visits to Golden Gate Park, the Presidio, Fort Funston, and Mission Dolores Park (calibration)'],
    [`SF Recreation and Park Department properties ${cite('rpdParks')}`, 'current', 'Park outlines and acreage for destination choice'],
    ['Hotel rooms', 'approximate', `City total of about ${int(HOTEL_ROOMS_SF)} rooms, attributed to San Francisco Travel; located by the rooms of OpenStreetMap hotels (${sec('special')})`],
    ['Air travelers between the city and SFO', 'assumed', `${int(F.calibration.airportTrips)} trips a day; no source (${sec('special')})`],
    [`Kastle office occupancy ${cite('kastle')}; hotel occupancy ${cite('cityScorecard')}; employment ${cite('blsLaus')}, ${cite('blsQcew')}; population ${cite('dofE1')}; SFO passengers ${cite('sfoStats')}; gasoline ${cite('eiaGas')}; prices ${cite('blsCpi')}`, 'July 2024 and 2026 (jobs: first quarters; population: January 1)', `Conditions outside the network: today’s values (${sec('special')}) and those of July 2024 for the backcast`],
    [`National Transit Database ${cite('ntd')}`, String(REF.ntd.period).split(' (')[0], 'Average trip length per boarding (validation)'],
    [`MTC Travel Model One and Two parameters ${cite('tm1Code', 'tm2py')}`, 'current repositories', 'Mode choice coefficients, path weights, crowding curves, value of time, costs, and vehicle capacities'],
    [`SFMTA Short Range Transit Plan ${cite('sfmtaSrtp')}`, 'FY2019–30', 'Vehicle capacities'],
    [`Fare and toll schedules ${cite('fares', 'clipper2')}`, '2026', 'Fares for every operator, the Clipper transfer discount, and bridge tolls'],
  ],
  { wide: true },
)}
<p>SFMTA's route counts come from automatic passenger counters. They exclude the cable cars and the historic E and F streetcars, which SFMTA has not reported since 2020 ${cite('sfmtaRidership')}. Caltrain's station figures are estimates from fare-media sales for Tuesdays to Thursdays, which Caltrain states run about 20% above Mondays and Fridays ${cite('caltrainRidership')}.</p>
<p>Each GTFS feed was checked with MobilityData's GTFS Schedule Validator (${GV.validator.replace('MobilityData gtfs-validator ', 'version ')}) ${cite('gtfsValidator')}; ${tab('gtfs')} summarizes the notices. Errors were reported for ${withErr.length ? list(withErr.map(([k, f]) => `${AG[k] ?? k} (${f.bySeverity.ERROR})`)) : 'no feed'}. None affects the model. The ferry errors are ${GV.feeds.ferry?.notices.find((n) => n.severity === 'ERROR') ? `<code>${GV.feeds.ferry.notices.find((n) => n.severity === 'ERROR')!.code}</code> notices, ` : ''}rows of <code>trips.txt</code> whose service appears in neither calendar file; those trips never run, and the pipeline keeps only trips active on the modeled day. The BART and SamTrans errors are in <code>rider_categories.txt</code>, a GTFS-Fares v2 file the model does not read. The warnings concern capitalization, optional fields, stops slightly off the drawn route shape, and a few implausibly fast hops between stops. Shapes are used only for drawing, and stop-to-stop times come from <code>stop_times.txt</code>.</p>
${table(
  'gtfs',
  'GTFS validation notices by feed.',
  ['Feed', 'Errors', 'Warnings', 'Info', 'Most frequent warning'],
  gv.map(([k, f]) => [AG[k] ?? k, int(f.bySeverity.ERROR ?? 0), int(f.bySeverity.WARNING ?? 0), int(f.bySeverity.INFO ?? 0), (() => { const n = f.notices.filter((x) => x.severity === 'WARNING').sort((a, b) => b.total - a.total)[0]; return n ? `<code>${n.code}</code> (${int(n.total)})` : '–'; })()]),
  { numeric: [1, 2, 3], wide: true, notes: `MobilityData GTFS Schedule Validator, run on the feeds used to build the model.` },
)}
`)}
`;
}

/** this model's weekday route and BART-station fit, in the form of the benchmark rows */
export function ownFit() {
  const w = muni('wkd');
  const routes = fit(w.routes);
  const bart = V.bart.wkd;
  return { routes, bart, metro: fit(w.routes.filter((r) => METRO.has(r.route))), bus: fit(w.routes.filter((r) => !METRO.has(r.route))) };
}

/** "about the same as", "lower than", or "higher than", for two %RMSE values (validation's wording) */
export function rmseWord(mine: number, theirs: number): string {
  return Math.abs(mine - theirs) < 5 ? 'about the same as' : mine < theirs ? 'lower than' : 'higher than';
}

/** where this model's route %RMSE stands among the published ones in the comparison table */
export function standing(): string {
  const me = ownFit().routes.pctRmse;
  const pub = BENCH.comparison.filter((b) => b.inTable && b.routes?.pctRmse != null).map((b) => b.routes!.pctRmse!);
  return me <= Math.min(...pub) + 5 ? 'at least as accurate as' : me <= Math.max(...pub) ? 'within the range of' : 'less accurate than';
}

/**
 * SF-TRACE's weekday Muni route %RMSE against SF-CHAMP 3's, compared as printed (whole percent),
 * so the verdict and its margin follow whatever the final validation gives.
 */
export function champVerdict() {
  const me = Math.round(ownFit().routes.pctRmse), them = Math.round(benchRow('sfchamp3').routes!.pctRmse!);
  const d = them - me;
  const word = Math.abs(d) <= 1 ? 'about the same as' : d > 0 ? 'better than' : 'worse than';
  const margin = d === 0 ? '' : `${nw(Math.abs(d))} percentage point${Math.abs(d) === 1 ? '' : 's'} ${d > 0 ? 'lower' : 'higher'}`;
  return { me, them, d, word, margin };
}
/** the headline comparison with SF-CHAMP, as one sentence */
export function champSentence(): string {
  const v = champVerdict();
  return `On this measure SF-TRACE is ${v.word} SFCTA's SF-CHAMP 3, whose %RMSE on Muni's routes was ${v.them}%${v.margin ? ` (SF-TRACE's is ${v.margin})` : ''}.`;
}

/** the comparison with SF-CHAMP 3 and Travel Model One, for the limitations and elsewhere */
export function comparisonSentence(short = false): string {
  const { routes: me } = ownFit();
  const v = champVerdict();
  const t05 = benchRow('tm1').routes!, t10 = benchRow('tm1y2010').routes!;
  const tail = `${v.word} the ${v.them}% of SFCTA's SF-CHAMP 3 on its year-2000 base${v.margin ? ` (${v.margin})` : ''}, and ${rmseWord(me.pctRmse, Math.min(t05.pctRmse!, t10.pctRmse!))} the ${fx(t10.pctRmse!, 0)}% and ${fx(t05.pctRmse!, 0)}% of MTC's Travel Model One in its 2010 and 2005 validations`;
  return short ? `That is ${tail}` : `Route by route, SF-TRACE's %RMSE of ${fx(me.pctRmse, 0)}% is ${tail}`;
}

/** SF-TRACE's fit set beside the published validation of agency models (benchmarks.json) */
function compareSection(): string {
  const w = muni('wkd');
  const { routes: me, bart, metro, bus } = ownFit();
  const c3 = benchRow('sfchamp3'), t05 = benchRow('tm1'), t10 = benchRow('tm1y2010');
  const t74 = BENCH.tm1Table74;
  const shown = BENCH.comparison.filter((b) => b.inTable);
  const us = shown.filter((b) => b.group === 'us' && b.routes && (b.routes.pctRmse != null || rOf(b.routes) != null));
  const usRmse = us.filter((b) => b.routes!.pctRmse != null), usR2 = us.filter((b) => b.routes!.pctRmse == null && b.routes!.r2 != null);
  const r2Only = BENCH.comparison.find((b) => b.routes?.r2 != null && b.routes.pctRmse != null && b.routes.r2 > 0.95);
  const arc = benchRow('arc');
  const beats = BC.meanAbsErrorOfChange.model < BC.meanAbsErrorOfChange.noChangeForecast;
  const v = champVerdict();
  const rows: string[][] = [
    [MODEL_NAME, 'This article; 2025–26', 'Aggregate tour-based, San Francisco only', `Weekday boardings on ${w.n} Muni routes against SFMTA automatic passenger counts; BART exits at ${nw(bart.n)} city-area stations. Muni and BART totals calibrated; routes and stations not fitted one by one`, statText({ n: me.n, pctRmse: me.pctRmse, r: me.r, r2: null, within25: me.within25 }), statText({ n: bart.n, pctRmse: bart.pctRmse, r: bart.r, r2: null, within25: null }), sec('validation')],
    ...shown.map((b) => [`${b.model}${b.uncertain ? '<sup>b</sup>' : ''}`, `${b.agency}; ${b.baseYear}`, b.structure, `${b.compared}${b.fit && b.fit !== '–' ? `. ${b.fit}` : ''}`, statText(b.routes), statText(b.rail), benchCite(b)]),
  ];
  const agencyName = (b: BenchRow) => `${/^[A-Z][a-z]+ /.test(b.agency) && !/^LA /.test(b.agency) ? 'the ' : ''}${b.agency.replace(/ \(.*\)$/, '')}`;
  return section('compare', 'Comparison with SF-CHAMP and Travel Model One', `
<p>The usual test of a transit model is how closely it reproduces counted boardings, route by route and station by station. ${tab('compare')} sets SF-TRACE's weekday fit beside the published validation of the models used for San Francisco and of other U.S. models. On ${w.n} Muni routes, SF-TRACE's percent root mean square error (%RMSE, defined in ${sec('val-framework')}) is ${fx(me.pctRmse, 0)}%, its correlation with the counts is r = ${fx(me.r, 2)}, and ${pc(me.within25)} of routes are within ±25% of their counts. SF-CHAMP 3, documented in 2007, compared ${c3.routes!.n} Muni routes with year-2000 counts. Computed from its published table, its %RMSE was ${fx(c3.routes!.pctRmse!, 0)}%, r = ${fx(c3.routes!.r!, 2)}, and ${pc(c3.routes!.within25!)} of routes were within ±25% ${benchCite(c3)}. SF-TRACE is therefore ${v.word} SF-CHAMP 3 on this measure${v.margin ? `: its %RMSE is ${v.margin}` : ''}. Travel Model One had a %RMSE of ${fx(t05.routes!.pctRmse!, 0)}% on ${t05.routes!.n} routes in its 2005 validation, with ${pc(t05.routes!.within25!)} within ±25% ${benchCite(t05)}, and ${fx(t10.routes!.pctRmse!, 0)}% on ${t10.routes!.n} routes in 2010, with ${pc(t10.routes!.within25!)} within ±25% and the R² of ${fx(t10.routes!.r2!, 2)} that MTC reported ${benchCite(t10)}.</p>
<p>Most of the difference from Travel Model One is in the buses. SF-TRACE's %RMSE is ${fx(bus.pctRmse, 0)}% on its ${bus.n} bus routes, against Travel Model One's ${fx(t74.busLocalAndLimited.pctRmse!, 0)}% on its local and limited routes in 2005, and ${fx(metro.pctRmse, 0)}% on the ${nw(metro.n)} Muni Metro lines, against ${fx(t74.bySubmode.Metro.pctRmse!, 0)}%. At the BART stations, SF-TRACE's %RMSE of ${fx(bart.pctRmse, 0)}% over ${nw(bart.n)} stations compares with ${fx(c3.rail!.pctRmse!, 0)}% for SF-CHAMP 3 over eight and ${fx(arc.rail!.pctRmse!, 0)}% for Atlanta's model over ${arc.rail!.n} MARTA stations. SFCTA and MTC have published no route-level results for the versions in use today (SF-CHAMP 6 and 7, Travel Model One 1.5 and 1.6, and Travel Model Two) ${cite(['sfctaCmp', 'ch. 8'], 'tm152')}, so the comparison is with older versions of their models.${usRmse.length ? ` Elsewhere, ${list(usRmse.map((b) => `${agencyName(b)}'s ${b.model.toLowerCase().startsWith('regional') ? 'regional model' : b.model} had a %RMSE of ${fx(b.routes!.pctRmse!, 0)}% on ${b.routes!.n} corridor routes${b.routes!.within25 != null ? `, with ${pc(b.routes!.within25)} within ±25%` : ''} ${benchCite(b)}`))}.` : ''}${usR2.length ? ` ${list(usR2.map((b) => b.agency.replace(/ \(.*\)$/, '')))} publish only R² for their route fits: ${list(usR2.map((b) => `${fx(b.routes!.r2!, 2)} for ${b.model === 'ARC ABM' ? "ARC's model" : b.model}${b.routes!.note && /AM/.test(b.routes!.note) ? ' in the morning peak' : ''} ${benchCite(b)}`))}.` : ''}</p>
${table(
  'compare',
  'Published transit validation of SF-TRACE and of other models.',
  ['Model', 'Agency; base year', 'Structure', 'Compared with', 'Routes', 'Rail stations', 'Source'],
  rows,
  { wide: true, cls: 'compare', notes: `Statistics as defined in ${sec('val-framework')}, over all routes or stations compared; their number in parentheses. A correlation r is shown where it was published or computed; where an agency published only the R² of a fitted line, that is shown. <sup>a</sup> Computed here from the published table of observed and modeled boardings. <sup>b</sup> See the note on this source in <code>server/beta3/reference/benchmarks.json</code>. Travel Model One's 2005 observed values are identical to SF-CHAMP 3's year-2000 counts, so their year is uncertain. Sources accessed ${BENCH.accessed}; the reference file also records the models with only operator or mode totals.` },
)}
<p>The numbers in ${tab('compare')} are not like for like. SF-TRACE's route counts were examined while its structure was revised, and its Muni total and the ratio of subway lines to buses are calibrated, so its route fit is a development-set result. SF-CHAMP 3 matched Muni's total within 1% and Travel Model One missed it by about a quarter, but neither was fitted route by route, and several of the other U.S. models were calibrated to the same counts or surveys they are compared with. The observed data differ too: automatic passenger counts from 2025 and 2026 here, older counts or expanded on-board surveys for the others. The base years run from 2000 to 2026, and Muni's network and ridership have changed greatly in that time. R² alone flatters a model whose routes span a wide range of sizes${r2Only ? `: the ${r2Only.agency.replace(/ \(.*\)$/, '')}'s corridor routes have R² = ${fx(r2Only.routes!.r2!, 2)} but a %RMSE of ${fx(r2Only.routes!.pctRmse!, 0)}%` : ''}. A close fit to today's routes also shows only that a model reproduces today's pattern of riding, not that it predicts the effect of a change. The backcast of ${sec('val-backcast')} tests that, and there SF-TRACE ${beats ? 'improved on' : 'did not improve on'} a forecast of no change. Of the models in the table, only STOPS has published a comparable test, against the ridership of projects after they opened ${cite(['stopsGuide', '§2.3'])}.</p>
<p>SF-TRACE is also narrower than the agency models. Travel Model One, Travel Model Two, and SF-CHAMP simulate each member of a synthetic population through a day of tours and stops, with joint travel, cars shared within the household, and a choice of time of day ${cite('tm1Code', 'sfchampDocs')}. They cover the whole region with a highway assignment, and they forecast future years from forecasts of land use. SF-TRACE computes residents' travel for groups by zone, car ownership, income, and person type (a person-level layer is optional, ${sec('abm')}); it assigns traffic on the city's streets and the Peninsula freeways only; and outside the city it represents places as whole cities or parts of cities, so its BART entries at stations outside San Francisco fit poorly (r = ${fx(V.bart.outsideEntries.r, 2)}, ${sec('val-rail')}). It is a model of travel in and to San Francisco, not of the region.</p>
`);
}
