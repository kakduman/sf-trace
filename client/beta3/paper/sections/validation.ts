import { CLIPPER_NEXTGEN_SHARE } from '../../../../shared/beta3/params';
import { CONDITION_BY_KEY, type ConditionKey } from '../../../../shared/beta3/context';
import { bartDowntown, markets, tThird } from './od';
import { calibExtra } from './calibration';
import { microValidation } from './micromobility';
import { metroWork } from './metro';
import { muniAreaWork } from './muniarea';
import { weekendValidation } from './weekends';
import { BART_DOWNTOWN_RATIO, BC, BC_DEC, BC_DRIVERS, BC_BART, F, FX, muni, REF, STD, tally, TIERS, V, VX, type Backcast, type RouteRow, type Tier } from '../data';
import { balanced, cap, cite, dataTable, dev, fig, figure, fx, int, interval, list, math, money, nw, pc, pearson, rInterval, sec, section, spc, tab, table, vs, ymd } from '../doc';

const METRO = new Set(['J', 'K', 'L', 'M', 'N', 'T', 'S']);
const share = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length / Math.max(1, xs.length);
/** the CTC thresholds, as both editions print them */
const ctcCite = () => cite(['ctc2017', 'p. 49'], ['ctc2024', 'p. 55']);
const TIER_NAME: Record<Tier, string> = { 'held-out': 'Held-out test', independent: 'Independent test', development: 'Development set', calibration: 'Calibration target', benchmark: 'Benchmark' };
/** a backcast's routes whose scheduled trips changed by more than 10% */
const changedOf = (b: Backcast) => b.rows.filter((r) => r.runs2024 > 0 && Math.abs(r.runs2026 / r.runs2024 - 1) > 0.1);
const beatsOf = (b: Backcast) => b.meanAbsErrorOfChange.model < b.meanAbsErrorOfChange.noChangeForecast;
/** "a fall of 1.0%" / "a rise of 2.0%" from a growth ratio */
const growth = (g: number) => (Math.abs(g - 1) < 0.0005 ? 'no change' : `a ${g < 1 ? 'fall' : 'rise'} of ${fx(Math.abs(g - 1) * 100, 1)}%`);

export function validation(): string {
  return section('validation', 'Validation', `
<p>This section compares the weekday model with counts and surveys, grouped by how much the model was fitted to them. The experimental weekend models are validated in ${sec('val-weekend')}.</p>
${framework()}
${muniRoutes()}
${rail()}
${markets()}
${otherChecks()}
${sensitivity()}
${backcastSection()}
${weekendValidation()}
${scorecard()}
`);
}

function framework(): string {
  const ctc = STD.ctc;
  return section('val-framework', 'Framework', `
<p>The comparisons fall into four tiers. Calibration targets (${sec('calibration')}) say little about predictive skill; they are shown with their gaps but not counted as tests. The development set is the weekday Muni boardings by route, which were never fitted route by route but were examined while the model's structure was revised. Some structural choices followed from that examination, among them charging Muni's fare once per trip rather than per boarding, choosing the access stop point by point (${sec('assignment')}), counting long headways in full only up to 15 minutes, letting riders with arrival predictions choose among the lines at a stop, and splitting large external places into parts. None involved a route-specific parameter, but a good fit there is weaker evidence than a good fit on data never looked at. Independent tests use data that were neither fitted nor examined while the structure was revised: BART loads by segment, the split of BART exits among the city's stations and of ferry boardings among routes (only their totals were fitted), the travel markets of ${sec('val-markets')}, NTD trip lengths, the time-of-day profile of BART exits, and elasticities against published ranges. Their results were computed on versions of the model during its development, however, and could have influenced it. Held-out tests had their data set aside, with the conditions of the test fixed before the run: the backcast to the 2024 network (${sec('val-backcast')}), the test closest to the model's intended use, and the weekend route counts (${sec('val-weekend')}).</p>
<p>The standards cited are guidelines. The FHWA manual states its values as examples from practice ${cite(['fhwa2010', '§9'])}, and the CTC asks agencies that miss its thresholds to document why ${cite(['ctc2017', 'p. 49'])}. The CTC correlation and %RMSE thresholds (${math(`r \\ge ${ctc.correlationMin}`)}, %RMSE below ${ctc.pctRmseMax}%) were written for highway links ${ctcCite()}; they are applied here to transit routes because U.S. guidance has no route-level equivalent for transit. The transit-specific standards are the size-banded targets for individual lines in the FHWA manual's Table 9.9, from Florida practice ${cite(['fhwa2010', 'p. 9-32'])}, and TAG M3.2's target of ±25% for individual services ${cite(['tagM32', 'Table 5'])}. With counted values ${math('o_i')} and modeled values ${math('m_i')} over ${math('n')} routes, ${math('\\%RMSE = 100\\,\\sqrt{\\textstyle\\sum_i (m_i - o_i)^2 / n}\\ \\big/\\ \\bar o')}, as the FHWA defines it; ${math('r')} is the Pearson correlation of ${math('m')} and ${math('o')}, with approximate 95% intervals from Fisher's ${math('z')} transformation; and a route is within ±25% when ${math('|m_i/o_i - 1| \\le 0.25')}.</p>
`);
}

function muniRoutes(): string {
  const w = muni('wkd');
  const ctc = STD.ctc, fh = STD.fhwaTransit, tag = STD.tag;
  const worst = w.routes.slice().sort((a, b) => Math.abs(b.model - b.observed) - Math.abs(a.model - a.observed)).slice(0, 5);
  const big = w.routes.filter((r) => r.observed >= 10000), small = w.routes.filter((r) => r.observed < 5000);
  const metro = w.routes.filter((r) => METRO.has(r.route)), bus = w.routes.filter((r) => !METRO.has(r.route));
  const sum = (rs: RouteRow[], k: 'observed' | 'model') => rs.reduce((a, r) => a + r[k], 0);
  const metroDev = sum(metro, 'model') / sum(metro, 'observed') - 1, busDev = sum(bus, 'model') / sum(bus, 'observed') - 1;
  const rCI = rInterval(w.r, w.n);
  const rLog = pearson(w.routes.map((r) => Math.log(r.observed)), w.routes.map((r) => Math.log(Math.max(1, r.model))));
  const owl = w.groups.find((g) => g.name === 'Owl');
  const groupsOk = w.groups.filter((g) => Math.abs(g.pct) <= ctc.routeGroupPct).length;
  const rt = (r: string) => w.routes.find((x) => x.route === r);
  const T = rt('T'), MS = ['14', '14R', '49'].map(rt).filter((r): r is RouteRow => !!r);
  const msObs = sum(MS, 'observed'), msMod = sum(MS, 'model');
  const sq = (r: RouteRow) => (r.model - r.observed) ** 2;
  const sqAll = w.routes.reduce((a, r) => a + sq(r), 0);
  const missShare = ((T ? sq(T) : 0) + MS.reduce((a, r) => a + sq(r), 0)) / Math.max(1, sqAll);
  return section('val-muni', 'Muni ridership by route', `
<p>${tab('muni-stats')} and ${fig('muni-scatter')} compare modeled and counted weekday boardings on each Muni route with automatic passenger counts, the twelve-month mean to ${w.period.match(/– ([A-Z][a-z]+ \d{4})/)?.[1] ?? w.period} ${cite('sfmtaRidership')}. These counts are the development set. The correlation was ${fx(w.r, 3)} across ${w.n} routes (interval ${interval(rCI)}), ${vs(w.r, ctc.correlationMin)} the CTC threshold of ${ctc.correlationMin}, and the %RMSE ${fx(w.pctRmse, 1)}%, ${vs(w.pctRmse, ctc.pctRmseMax, 'above', 'below')} the ${ctc.pctRmseMax}% threshold. Route sizes span two orders of magnitude, so the largest routes dominate the linear correlation; the correlation of the logarithms is ${fx(rLog, 3)}. Route by route the fit is weaker: ${pc(w.within25)} of routes are within ±25% of their counts, against TAG's target of ${pc(tag.servicesWithin25Share)}, and ${pc(w.fhwaLineBands.acceptableShare)} within the FHWA acceptable band (${fig('muni-bands')}). Large routes fit better in relative terms: ${pc(share(big, (r) => Math.abs(r.pct) <= 25))} of the ${big.length} routes with at least 10,000 weekday boardings were within ±25%, against ${pc(share(small, (r) => Math.abs(r.pct) <= 25))} of the ${small.length} with fewer than 5,000. ${sec('compare')} sets these statistics beside the published validations of SF-CHAMP and Travel Model One.</p>
${table(
  'muni-stats',
  'Muni boardings by route on an average weekday: modeled against counted.',
  ['Statistic', 'Value', 'Guideline'],
  [
    ['Routes compared', String(w.n), '–'],
    ['Counted boardings', int(w.observedTotal), '–'],
    ['Modeled boardings', int(w.modelTotal), '–'],
    ['Total, model against count', dev(w.totalRatio), `±${fh.regionalAcceptable}% acceptable, ±${fh.regionalPreferable}% preferable ${cite(['fhwa2010', 'Table 9.9'])}`],
    ['Correlation r', fx(w.r, 3), `≥ ${ctc.correlationMin} (highway links) ${ctcCite()}`],
    ['95% interval for r', interval(rCI), '–'],
    ['Correlation of logarithms', fx(rLog, 3), '–'],
    ['R²', fx(w.r2, 3), '–'],
    ['%RMSE', `${fx(w.pctRmse, 1)}%`, `< ${ctc.pctRmseMax}% (highway links) ${ctcCite()}`],
    ['Median absolute error', `${fx(w.medianApe, 1)}%`, '–'],
    ['Slope through origin', fx(w.slopeThroughOrigin, 3), '1'],
    ['Routes within FHWA acceptable band', pc(w.fhwaLineBands.acceptableShare), `by size ${cite(['fhwa2010', 'Table 9.9'])}`],
    ['Routes within FHWA preferable band', pc(w.fhwaLineBands.preferableShare), 'by size'],
    ['Routes within ±25%', pc(w.within25), `${pc(tag.servicesWithin25Share)} of services ${cite('tagM32')}`],
    ['Routes with GEH < 5 (hourly mean)', pc(w.gehUnder5Share), `> 85% of links, highway ${cite('tagM31')}`],
  ],
  { numeric: [1], notes: 'GEH was computed on the average hourly boardings over an 18-hour service day, a transfer of a highway statistic shown for reference only.' },
)}
${figure(
  'muni-scatter',
  `<div class="chart-slot" data-chart="muni-wkd"></div>
  <p class="legend"><span class="key dot"></span> within ±25% <span class="key dot out"></span> outside ±25% <span class="key band"></span> ±25% of the count <span class="key one"></span> model equals count</p>`,
  `Modeled against counted weekday boardings for each of ${w.n} Muni routes, on logarithmic axes (r ${fx(w.r, 2)}, %RMSE ${w.pctRmse.toFixed(0)}%). The shaded band is ±25% of the count, the TAG M3.2 target for individual services. Labeled routes are the five largest absolute differences.`,
  {
    alt: `Scatter plot of modeled against counted weekday boardings for ${w.n} Muni routes. Points cluster along the diagonal; ${pc(w.within25)} of routes fall inside the ±25% band.`,
    wide: false,
    data: dataTable(['Route', 'Category', 'Counted', 'Model', 'Difference'], w.routes.map((r) => [r.route, r.category, int(r.observed), int(r.model), spc(r.pct / 100)]), [2, 3, 4]),
  },
)}
${figure(
  'muni-bands',
  `<div class="chart-slot" data-chart="muni-bands"></div><p class="legend"><span class="key band-acc"></span> FHWA acceptable <span class="key band-pref"></span> FHWA preferable <span class="key dot"></span> within acceptable <span class="key dot out"></span> outside</p>`,
  `Error of each Muni route on weekdays against its counted boardings, with the acceptable and preferable bands of FHWA Table 9.9 ${cite('fhwa2010')}. The allowed error narrows from ±150% for lines under 1,000 riders a day to ±20% above 20,000.`,
  { alt: `Scatter of percent error against counted boardings for ${w.n} weekday Muni routes over stepped FHWA bands; ${pc(w.fhwaLineBands.acceptableShare)} of routes fall inside the acceptable band, with the largest relative errors on small routes.` },
)}
<p>The CTC guidelines ask for transit boardings within ±${ctc.routeGroupPct}% by route group and ±${ctc.modePct}% by mode ${ctcCite()}. By SFMTA's service categories (${tab('groups')}), ${groupsOk} of ${w.groups.length} groups were within ±${ctc.routeGroupPct}%. By mode, modeled boardings were ${spc(metroDev, 1)} on Muni Metro and ${spc(busDev, 1)} on buses. ${owl ? `The Owl network, which runs overnight, carries ${int(owl.model)} modeled weekday boardings against ${int(owl.observed)} counted; night riders see its service only in proportion to the share of night trips made after midnight.` : ''}</p>
${table(
  'groups',
  'Muni boardings by SFMTA service category on an average weekday: model against counts.',
  ['Service category', 'Counted', 'Modeled', 'Difference'],
  w.groups.map((g) => [g.name, int(g.observed), int(g.model), spc(g.pct / 100)]),
  { numeric: [1, 2, 3] },
)}
<p>The five largest absolute differences were on routes ${list(worst.map((r) => `${r.route} (${spc(r.pct / 100)})`))}. Two misses stand out${T && MS.length ? `, and together they make ${pc(missShare)} of the squared error across routes` : ''}. ${T ? `The T Third carries ${int(T.model)} modeled boardings against ${int(T.observed)} counted (${spc(T.pct / 100)}).${tThird()}` : ''} ${MS.length ? `The three Mission Street routes, the 14, 14R, and 49, carry ${int(msMod)} against ${int(msObs)} (${spc(msMod / msObs - 1)}). ${muniAreaWork()} ` : ''}Survey underreporting by segment, tested as a cause, made the route pattern worse (${sec('val-markets')}).</p>
`);
}

function rail(): string {
  const ctc = STD.ctc;
  const segs = V.bart.segments.loads;
  const thr = new Map(F.bartThrough.map((t) => [`${t.a}-${t.b}`, t.through]));
  const bgOf = (s: (typeof segs)[number]) => (s as { background?: number }).background ?? 0;
  const segNet = segs.map((s) => (s.model - bgOf(s)) / (s.observed - (thr.get(`${s.a}-${s.b}`) ?? 0)));
  const CR = VX.caltrainRegional;
  const tube = segs.find((s) => s.a === 'WOAK');
  const ex = V.bart.wkd.exits.slice().sort((a, b) => Math.abs(b.model / b.observed - 1) - Math.abs(a.model / a.observed - 1)).slice(0, 3);
  const exCI = rInterval(V.bart.wkd.r, V.bart.wkd.n);
  const oe = V.bart.outsideEntries;
  const fe = VX.ferry;
  const dt = bartDowntown();
  const lo = dt.filter((s) => s.ratio < 0.95), hi = dt.filter((s) => s.ratio > 1.05);
  const dtName = (s: (typeof dt)[number]) => `${s.name.replace(' / UN Plaza', '')} (${spc(s.ratio - 1)})`;
  const CT_DIR = calibExtra().caltrainDirFit;
  // Caltrain's morning arrivals at the city's two stations, [model, estimate]: the calibration's last
  // assignment, else the commute check's run (commutes-results.json)
  const ctArrRun = (REF.commutesResults as unknown as { after?: { caltrainArrivalsAM?: { model: number; observed: number } } }).after?.caltrainArrivalsAM;
  const ctArr: [number, number] | null = CT_DIR?.arrivalsAM ?? (ctArrRun ? [ctArrRun.model, ctArrRun.observed] : null);
  const cin = FX.calibration.countyFit?.in;
  const ctCounties = ['San Mateo', 'Santa Clara'].filter((c) => cin?.[c]);
  return section('val-rail', 'BART, Caltrain, and ferries', `
<p>BART's exits at the nine city-area stations (the eight in San Francisco and Daly City) were a calibration target in total, through the regional visitor rate, but not station by station, so their split is an independent test. On weekdays the station exits correlated at r = ${fx(V.bart.wkd.r, 2)} (interval ${interval(exCI)}, from only ${nw(V.bart.wkd.n)} stations) with a %RMSE of ${fx(V.bart.wkd.pctRmse, 0)}% (${fig('bart-stations')}); the largest relative errors were at ${list(ex.map((e) => `${e.name} (${spc(e.model / e.observed - 1)})`))}. ${lo.length && hi.length ? `The split among the four downtown stations is off: the model is low at ${list(lo.map(dtName))} and high at ${list(hi.map(dtName))}${VX.od?.bart ? ', and riders from every group of outside stations show the same pattern, which points to where the model places jobs, shops, and hotels near each station rather than to any one market' : ''}.` : dt.length ? `The four downtown stations are at ${list(dt.map(dtName))}.` : ''}</p>
${figure(
  'bart-stations',
  `<div class="chart-slot" data-chart="bart-stations"></div><p class="legend"><span class="key obs"></span> counted (BART, August 2026) <span class="key mod"></span> modeled</p>`,
  `BART exits on an average weekday at the nine city-area stations. The total was calibrated; the split among stations was not. Values at the right are the model's error.`,
  { alt: `Paired horizontal bars of counted and modeled weekday exits at nine BART stations, with the model's error at each.` },
)}
<p>Loads on the nine segments from West Oakland to Daly City were estimated by routing every station-to-station trip in BART's August 2026 weekday matrix on its shortest path ${cite('bartRidership')}. ${int(F.bartThrough[0].through)} of the counted weekday trips through the Transbay Tube have neither end in the city; the model carries them as background riders (${sec('assignment')}). With them, the correlation across segments was ${fx(V.bart.segments.r, 3)} (${fig('bart-segments')}), ${vs(V.bart.segments.r, ctc.correlationMin)} the CTC threshold, and the loads were ${spc(V.bart.segments.totalRatio - 1, 0)} in total${tube ? ` and ${spc(tube.model / tube.observed - 1, 0)} in the Transbay Tube, a natural screenline, ${Math.abs(tube.model / tube.observed - 1) <= 0.2 ? 'inside' : 'outside'} the ±20% that FHWA's Table 9.9 accepts for transit screenlines ${cite(['fhwa2010', 'p. 9-32'])}` : ''}. Against the counted trips with a city end, the model's own riders are ${pc(Math.min(...segNet.slice(0, 4)))} to ${pc(Math.max(...segNet.slice(0, 4)))} of the load from the Tube to Civic Center and ${pc(Math.min(...segNet.slice(4)))} to ${pc(Math.max(...segNet.slice(4)))} south of it${Math.max(...segNet.slice(0, 4)) < 1 && Math.min(...segNet.slice(4)) > 1 ? ': too few of the modeled arrivals come from the East Bay and too many from the south' : ''}. Entries at BART stations outside the city for trips to it fit poorly (${tab('bart')}: r = ${fx(oe.r, 2)} across ${oe.n} stations, %RMSE ${fx(oe.pctRmse, 0)}%), although the total is within ${fx(Math.abs(oe.totalRatio - 1) * 100, 0)}%. Which outside station a commuter uses is decided by coarse external zones and a simplified account of station access, too coarse for station-level forecasts outside San Francisco.</p>
${figure(
  'bart-segments',
  `<div class="chart-slot" data-chart="bart-segments"></div><p class="legend"><span class="key obs"></span> counted <span class="key part"></span> of which neither end in the city <span class="key mod"></span> modeled <span class="key modpart"></span> of which background riders</p>`,
  `BART passenger loads on the segments from West Oakland (WOAK) through the Transbay Tube to Daly City (DALY), both directions over an average weekday. The hatched part of each counted bar is trips with neither end at a city-area station; the hatched part of each modeled bar is the background riders that stand in for them.`,
  { alt: `Paired horizontal bars of counted and modeled BART loads on nine segments; modeled loads are below the counts on ${segs.every((s) => s.model < s.observed) ? 'every' : 'most'} segment${segs.every((s) => s.model < s.observed) ? '' : 's'}.` },
)}
${table(
  'bart',
  'BART and Caltrain on an average weekday: model against counts.',
  ['Comparison', 'Tier', 'n', 'Total', 'r', '%RMSE'],
  [
    ['BART exits, city-area stations', 'Total calibrated; split independent', V.bart.wkd.n, dev(V.bart.wkd.totalRatio), fx(V.bart.wkd.r, 2), `${fx(V.bart.wkd.pctRmse, 0)}%`],
    ['BART segment loads', 'Independent', V.bart.segments.n, dev(V.bart.segments.totalRatio), fx(V.bart.segments.r, 2), `${fx(V.bart.segments.pctRmse, 0)}%`],
    ['BART entries outside the city, trips to the city', 'Independent', oe.n, dev(oe.totalRatio), fx(oe.r, 2), `${fx(oe.pctRmse, 0)}%`],
    ['Caltrain boardings, city stations', 'Total calibrated', V.caltrain.rows.length, dev(V.caltrain.rows.reduce((a, r) => a + r.model, 0) / V.caltrain.rows.reduce((a, r) => a + r.observedWeekdayEst, 0)), '–', '–'],
  ],
  { numeric: [2, 3, 4, 5], wide: true, notes: 'Outside-station comparison: counted trips from each station to the nine city-area stations, against all modeled boardings there (every modeled BART trip has an end in the city). Stations with fewer than 300 such trips are excluded.' },
)}
<p>At the three Caltrain stations in or next to the city, whose total was a calibration target, the model has ${list(V.caltrain.rows.map((r) => `${int(r.model)} boardings against ${int(r.observedWeekdayEst)} estimated at ${r.name}`))}. ${ctArr ? `The direction of travel is the weaker part. Morning departures from the city's two stations are fitted, but the morning arrivals there, a test, are ${int(ctArr[0])} against ${int(ctArr[1])} estimated from the 2024 survey (${spc(ctArr[0] / ctArr[1] - 1, 0)})${ctCounties.length ? `, while the transit shares of in-commuters from ${list(ctCounties.map((c) => `${c} County (${pc(cin![c][0])} against ${pc(cin![c][1])})`))} fit their ACS targets` : ''}: the in-commuters who would make those arrivals are on transit in the right numbers but ride BART instead.` : ''}</p>
${CR ? (() => {
    const g = CR.groups, sg = CR.segments;
    const south = sg.daily.filter((x) => /^(Palo Alto|California Ave|San Antonio|Mountain View|Sunnyvale|Lawrence|Santa Clara)–/.test(x.stretch));
    const southBg = south.reduce((a, x) => a + x.background, 0) / Math.max(1, south.reduce((a, x) => a + x.model, 0));
    return `<p>Caltrain has no fare gates. The 2024 Caltrain origin–destination survey published its weighted on-to-off results by nine groups of stations ${cite(['caltrainOD2024', 'Table 3'])}; spread to stations by FY2026 boardings ${cite('caltrainRidership')}, it puts ${pc(CR.shareNoCityEnd.estimateFY2026)} of weekday journeys between two stations outside the city, which the model carries as background riders. The journeys it does carry, between the city's two stations and each group of outside stations (${tab('caltrain-groups')}), are an independent test: over the day, across ${nw(g.daily.n)} groups, the correlation was ${fx(g.daily.r, 2)}, with the total ${spc(g.daily.totalRatio - 1, 0)}; toward the city in the morning peak the total was ${spc(g.toCityAM.totalRatio - 1, 0)}, and away from it in the morning ${spc(g.fromCityAM.totalRatio - 1, 0)}. The estimates are the survey's shares at FY2026 volumes, so differences of 20% or so for single groups are within their uncertainty. On the corridor (${fig('caltrain-am')}), the peak loads with background riders correlate with the estimates at r = ${fx(sg.peakStats.r, 2)} across ${nw(sg.peakStats.n)} stretches, and background riders are ${pc(southBg)} of the modeled load between Palo Alto and Santa Clara. They share the trains and respond to frequency but not to fares, travel times, or land use outside the city, so questions about Caltrain's total ridership need a regional model.</p>
${table(
  'caltrain-groups',
  'Caltrain journeys between the city (San Francisco and 22nd Street stations) and each group of outside stations on an average weekday: model against estimates from the 2024 origin–destination survey at FY2026 volumes.',
  ['Outside stations', 'To the city, 6–10am', 'From the city, 3–7pm', 'From the city, 6–10am', 'To the city, 3–7pm', 'Both ways, all day'],
  g.rows.map((r) => [r.name, `${int(r.observedToCityAM)} / ${int(r.modelToCityAM)}`, `${int(r.observedFromCityPM)} / ${int(r.modelFromCityPM)}`, `${int(r.observedFromCityAM)} / ${int(r.modelFromCityAM)}`, `${int(r.observedToCityPM)} / ${int(r.modelToCityPM)}`, `${int(r.observedDaily)} / ${int(r.modelDaily)}`]),
  { numeric: [1, 2, 3, 4, 5], wide: true, notes: 'Each cell: estimated / modeled journeys without a change of Caltrain train. Groups follow the survey; 22nd Street, inside the city, is taken out of its group, and the few journeys from Capitol, Blossom Hill, and the South County stations are combined.' },
)}
${figure(
  'caltrain-am',
  `<div class="chart-slot" data-chart="caltrain-am-nb"></div><p class="legend"><span class="key obs"></span> estimated (2024 survey, FY2026 volumes) <span class="key mod"></span> modeled <span class="key modpart"></span> of which background riders</p>`,
  `Caltrain northbound riders on each stretch in the morning peak (6–10am), from San Jose (top) to San Francisco. The hatched part of each modeled bar is the background riders, whose journeys have no end in the city.`,
  { alt: `Paired horizontal bars of estimated and modeled northbound Caltrain riders on each stretch in the morning peak; background riders are most of the modeled load south of Redwood City and little of it next to the city.` },
)}`;
  })() : ''}
${fe ? `<p>The ferry commuter routes' total was a calibration target${Math.abs(fe.totalRatio - 1) > 0.02 ? `, missed by ${spc(fe.totalRatio - 1, 0)}` : ''}; the split among routes is an independent test (${tab('ferry')}), with a correlation of ${fx(fe.r, 2)} across the ${nw(fe.n)} routes. Which terminal a commuter uses depends on the same coarse external zones as the choice of BART station, and the Larkspur count is an estimate from Golden Gate Ferry's annual route shares.</p>
${table(
  'ferry',
  'Ferry boardings on the commuter routes into the city, average weekday: model against counts.',
  ['Route', 'Counted', 'Modeled', 'Difference'],
  fe.rows.map((r) => [r.name, int(r.observed), int(r.model), spc(r.model / Math.max(1, r.observed) - 1)]),
  { numeric: [1, 2, 3], notes: `${fe.source} ${cite('ferryRidership')}. The total was calibrated; the split among routes was not.` },
)}` : ''}
`);
}

function otherChecks(): string {
  const tl = V.tripLength.rows;
  const R = V.reasonableness;
  const tod = V.timeOfDay.rows;
  const todE = V.timeOfDay.rows as unknown as { modelEntries?: number; observedEntries?: number }[];
  const shuttle = VX.shuttle;
  const shape = FX.shapeRatio;
  return section('val-other', 'Trip length, time of day, and reasonableness', `
<p>${tab('other-checks')} collects the remaining independent checks. The NTD's passenger miles over unlinked trips for the 2024 report year give the mean distance per boarding ${cite('ntd')}: the model's Muni bus rides average ${fx(tl[0].model, 2)} miles against ${fx(tl[0].observed, 2)} (${spc(tl[0].model / tl[0].observed - 1, 1)}), and its Metro rides ${fx(tl[1].model, 2)} against ${fx(tl[1].observed, 2)} (${spc(tl[1].model / tl[1].observed - 1, 1)}), both measured along each route's drawn shape${shape ? ` (straight lines between stops are ${pc(shape.bus - 1, 1)} short on the buses and ${pc(shape.metro - 1, 1)} on Metro)` : ''}. The FHWA manual's ±5% target for average trip length ${cite(['fhwa2010', '§6.2.4'])} is a trip distribution check, applied here per boarding.</p>
${metroWork()}
<p>Boardings per linked transit trip were ${fx(R.boardingsPerLinkedTrip.model, 2)}, within the range of ${R.boardingsPerLinkedTrip.range[0]} to ${R.boardingsPerLinkedTrip.range[1]} that the FHWA manual gives as typical ${cite(['fhwa2010', '§9.2.5'])}, and the mean door-to-door transit trip took ${fx(R.avgTransitTripMin.model, 0)} minutes, against ${R.avgTransitTripMin.benchmark} for transit trips in urban areas of over one million people with rail in the 2009 NHTS ${cite(['nchrp716', 'Table C.10'])}. Trips per household count every trip with an end in the city, in-commuters' and visitors' included, over resident households, so the commute rate is above NCHRP 716's national value and the non-work rate ${R.tripsPerHousehold.model.HBNW < R.tripsPerHousehold.benchmark.HBNW ? 'below it' : 'near it'}. ${shuttle ? `Private shuttle trips are ${pc(shuttle.shareOfResidentTrips, 1)} of residents' trips in the model, against ${pc(shuttle.batsShuttleVanpoolShare, 1)} for shuttles and vanpools together in BATS 2023's unlinked trips ${cite('bats2023')}; the model's rider count comes from the ACS.` : ''}</p>
${table(
  'other-checks',
  'Other independent checks.',
  ['Measure', 'Model', 'Observed or benchmark', 'Source'],
  [
    ...tl.map((r) => [`Miles per boarding, ${r.mode}`, fx(r.model, 2), fx(r.observed, 2), `NTD 2024 ${cite('ntd')}`]),
    ['Boardings per linked transit trip', fx(R.boardingsPerLinkedTrip.model, 2), `${R.boardingsPerLinkedTrip.range[0]}–${R.boardingsPerLinkedTrip.range[1]}`, 'FHWA 2010 §9.2.5'],
    ['Mean transit trip time, minutes', fx(R.avgTransitTripMin.model, 0), String(R.avgTransitTripMin.benchmark), 'NCHRP 716'],
    ['Home-based work trips per household', fx(R.tripsPerHousehold.model.HBW, 2), fx(R.tripsPerHousehold.benchmark.HBW, 1), 'NCHRP 716 (2009 NHTS)'],
    ['Home-based non-work trips per household', fx(R.tripsPerHousehold.model.HBNW, 2), fx(R.tripsPerHousehold.benchmark.HBNW, 1), 'NCHRP 716'],
    ['Trips with neither end at home per household', fx(R.tripsPerHousehold.model.NHB, 2), fx(R.tripsPerHousehold.benchmark.NHB, 1), 'NCHRP 716'],
    ...tod.map((r) => [`BART exits at the eight San Francisco stations, share in ${r.period}`, pc(r.model, 1), pc(r.observed, 1), 'BART hourly data, October 2025']),
    ...(shuttle ? [["Shuttle share of residents' trips", pc(shuttle.shareOfResidentTrips, 1), pc(shuttle.batsShuttleVanpoolShare, 1), 'BATS 2023 (shuttle and vanpool, unlinked)']] : []),
  ],
  { numeric: [1, 2], wide: true, notes: 'Trips per household count all trips with an end in San Francisco, including those of visitors and in-commuters, divided by resident households.' },
)}
<p>The time-of-day check uses BART's hourly origin–destination data for weekdays in October 2025 ${cite('bartRidership')}. The model puts ${pc(tod[0].model, 0)} of exits at the eight San Francisco stations in the morning peak against ${pc(tod[0].observed, 0)} counted, ${pc(tod[1].model, 0)} at midday against ${pc(tod[1].observed, 0)}, and ${pc(tod[2].model, 0)} in the evening peak against ${pc(tod[2].observed, 0)}${todE[2].modelEntries !== undefined ? `; of entries, ${pc(todE[2].modelEntries, 0)} in the evening peak against ${pc(todE[2].observedEntries!, 0)}` : ''} (${fig('tod')}). BART tabulates trips by the hour of entry, so the counted exits are placed slightly early. The model's period shares come from the tours of the 2017 NHTS; the share of the region's transit trips made in the morning peak fell between the NHTS and BATS 2023, but ACS 2024 commute times show that commuters still travel at the same hours, and the change is in how many days they commute, which the commute rates carry.</p>
${figure(
  'tod',
  `<div class="chart-slot" data-chart="tod"></div><p class="legend"><span class="key obs"></span> counted (BART, October 2025) <span class="key mod"></span> modeled</p>`,
  `Share of weekday BART exits at the eight San Francisco stations by assignment period.`,
  { alt: `Grouped bars of the share of BART exits by period; the model is ${tod[0].model > tod[0].observed ? 'higher' : 'lower'} than the count in the morning peak.`, wide: false },
)}
${microValidation()}
`);
}

function sensitivity(): string {
  const sens = VX.sensitivity;
  const scoredE = (s: (typeof sens)[number]) => s.corridorElasticity ?? s.elasticity;
  const inside = (s: (typeof sens)[number], e = scoredE(s)) => e >= s.range[0] && e <= s.range[1];
  const fare = sens.find((s) => s.test.startsWith('Muni fare'))!;
  const freq = sens.filter((s) => s.test.includes('service +25%'));
  const car = sens.find((s) => s.measure === 'vehicle-km')!;
  const speed = sens.find((s) => s.measure.includes('14R'))!;
  const routeOf = (s: (typeof sens)[number]) => s.test.split(' ')[0];
  const freqOut = freq.filter((s) => !inside(s));
  const sysSmall = freq.every((s) => Math.abs(s.systemElasticity ?? 0) < 0.05);
  return section('val-sensitivity', 'Sensitivity', `
<p>Elasticities were computed by running the model with one input changed and comparing it with an unchanged run made the same way, three passes of skims, demand, assignment, and crowding from the base run's crowding, so each response includes the adjustment of crowding (${fig('elasticity')}, ${tab('sensitivity')}). The Muni fare elasticity, from fares 10% higher and 10% lower, was ${fx(fare.elasticity, 2)}, ${inside(fare) ? 'within' : 'outside'} TCRP Report 95's range of ${fx(fare.range[0], 2)} to ${fx(fare.range[1], 2)} for U.S. bus systems and ${Math.abs(fare.elasticity - -0.24) < Math.abs(fare.elasticity - -0.4) ? 'nearer its mean for central cities of over one million people (about −0.24) than its mean for bus fares (about −0.40)' : 'nearer its mean for bus fares (about −0.40) than its mean for large central cities (about −0.24)'} ${cite(['tcrp95c12', 'pp. 12-6, 12-12'])}.</p>
<p>Frequency was raised by 25% on single routes. A route's own boardings then include riders who move over from parallel lines, while published service elasticities describe the riders a service gains, so each test is scored on its corridor, the route and the lines sharing its street. The corridor elasticities were ${list(freq.map((s) => `${fx(scoredE(s), 2)} (${routeOf(s)})`))}, ${freqOut.length === 0 ? 'all within' : freqOut.length === freq.length ? 'all outside' : `all but ${list(freqOut.map((s) => `the ${routeOf(s)}'s`))} within`} the +0.3 to +1.0 of TCRP Report 95's chapter on frequency ${cite(['tcrp95c9', 'pp. 9-4 to 9-5'])}; the routes' own boardings rose with elasticities of ${list(freq.map((s) => `${fx(s.elasticity, 2)} (${routeOf(s)})`))}${sysSmall ? ', and systemwide transit trips barely changed, so most of each route\'s gain came from other routes' : ''}. The vehicle-kilometer elasticity with respect to car running cost was ${fx(car.elasticity, 2)}, ${inside(car) ? 'within' : 'outside'} TAG M2.1's range of ${fx(car.range[1], 2)} to ${fx(car.range[0], 2)} for fuel cost ${cite(['tagM21', '§6.4.19'])}. Cutting the running time of the 14 and 14R on Mission Street by 10% raised their boardings with an elasticity of ${fx(speed.elasticity, 2)}, ${speed.elasticity < speed.range[0] ? 'beyond' : inside(speed) ? 'within' : 'short of'} an indicative band of ${fx(speed.range[0], 1)} to ${fx(speed.range[1], 1)}, the authors' judgment after TCRP Report 95's description of ridership gains roughly in proportion to the time saved.${speed.elasticity < -1 ? ' The response exceeds proportional gains, which suggests that the model moves riders between the Mission corridor and parallel routes more readily than they move in practice, so scenario results for running-time changes are likely to overstate shifts between parallel routes.' : ''}</p>
${figure(
  'elasticity',
  `<div class="chart-slot" data-chart="elasticity"></div><p class="legend"><span class="key range"></span> published range <span class="key central"></span> central value <span class="key dot"></span> model, inside range <span class="key dot out"></span> model, outside range <span class="key dot muted"></span> route alone, where the corridor is scored</p>`,
  `Model elasticities against the ranges from TCRP Report 95 and UK TAG M2.1. Frequency tests are shown for the corridor. The running-time band is indicative only.`,
  { alt: `Range chart of ${nw(sens.length)} elasticity tests; ${nw(sens.filter((x) => inside(x)).length)} model values fall inside their ranges${sens.some((x) => !inside(x)) ? `, and ${list(sens.filter((x) => !inside(x)).map((x) => `${x.test} (${fx(scoredE(x), 2)})`))} ${sens.filter((x) => !inside(x)).length === 1 ? 'falls' : 'fall'} outside` : ''}.` },
)}
${table(
  'sensitivity',
  'Sensitivity tests.',
  ['Test', 'Measure', 'Route or measure', 'Corridor', 'Range', 'Source'],
  sens.map((s) => [s.test, s.measure, fx(s.elasticity, 2), s.corridorElasticity !== undefined ? `${fx(s.corridorElasticity, 2)}${s.corridor && s.corridor.length > 1 ? ` (${s.corridor.join(', ')})` : ' (no parallel line)'}` : '–', `${fx(s.range[0], 2)} to ${fx(s.range[1], 2)}`, s.test.startsWith('Muni fare') ? `TCRP 95 ch. 12 ${cite('tcrp95c12')}` : s.test.includes('service') ? `TCRP 95 ch. 9 ${cite('tcrp95c9')}` : s.measure === 'vehicle-km' ? `TAG M2.1 ${cite('tagM21')}` : "Indicative (authors' judgment)"]),
  { numeric: [2, 3], wide: true, notes: 'Route or measure: elasticity of the measure named. Corridor: elasticity of the boardings of the route and the lines sharing its street, the value scored for the frequency tests.' },
)}
`);
}

/** the backcast: the run with the demand conditions fixed in advance is the held-out result */
function backcastSection(): string {
  const ctx = FX.backcastContext;
  const svc = (ctx?.serviceChanges ?? []).flatMap((c) =>
    c.routes.includes('L') && c.routes.includes('L Bus') ? [`the return of L Taraval trains on ${ymd(c.date)}`] : c.routes.includes('21') && c.routes.includes('6') && c.routes.includes('5') ? [`the budget cuts of ${ymd(c.date)}, which cut back the 5, 9, and 31 and merged the 6 and the 21`] : [],
  );
  const changed = changedOf(BC);
  const beats = beatsOf(BC);
  const has = (r: string) => BC.rows.some((x) => x.route === r);
  const overstated = changed.filter((r) => Math.abs(r.modelRelChange) > Math.abs(r.obsRelChange));
  const worstChange = changed.slice().sort((a, b) => Math.abs(b.modelRelChange - b.obsRelChange) - Math.abs(a.modelRelChange - a.obsRelChange))[0];
  const ci = rInterval(BC.weightedCorrelationOfChange, BC.routes);
  const dirText = BC.directionCorrectShare === 1 ? `all ${nw(changed.length)}` : `${nw(Math.round((BC.directionCorrectShare ?? 0) * changed.length))} of the ${nw(changed.length)}`;
  const bart = BC_BART;
  const D = BC_DRIVERS.drivers, dec = BC_DEC;
  const pts = (x: number) => `${x < 0 ? '−' : '+'}${fx(Math.abs(x), 1)}`;
  const eff = (k: string) => dec?.drivers.find((d) => d.key === k)?.effectPts ?? NaN;
  const ranked = dec ? dec.drivers.slice().sort((a, b) => Math.abs(b.effectPts) - Math.abs(a.effectPts)) : [];
  const lbl = (k: string) => DRIVER_NAME[k] ?? k;
  const others = ranked.filter((d) => d.key !== 'transferDiscount' && Math.abs(d.effectPts) > 0.25);
  const gap = 100 * (Math.log(BC.systemGrowthObserved) - Math.log(BC.systemGrowthModel));
  const chk = BC_DRIVERS.examinedAfterResults?.transferDiscountStep;
  return section('val-backcast', 'Backcast to the 2024 network', `
<p>The backcast runs the calibrated model on the Muni GTFS feed for service from ${ymd(F.backcastFeed.wkd)} and on the current feed, with the same zones, other operators, and constants, and compares the change in each route's modeled riders with the change in SFMTA's counts between July 2024 and July 2026 ${cite('sfmtaRidership')}. The two feeds contain the service changes of the intervening two years ${cite('sfmtaService')}${svc.length ? `, among them ${list(svc)}` : ''}. Two things are compared: the growth of the system as a whole, which depends on conditions outside the network as much as on the network, and each route's change relative to its system, which tests whether the model predicts which routes grew faster or slower than the rest. The comparison covers the ${BC.routes} routes with at least 300 weekday riders counted in both years and modeled riders in both runs${has('6/21') ? ', counting the 6 and the 21 as one route on both dates, since they were merged' : ''}; the K and the T are compared apart, since the line that joined them was split in January 2023 ${cite('sfmtaKT')}.</p>
<p>The design was changed once after results were seen, and the change is disclosed here: the comparison was first specified on counts averaged over July and August with the K and the T as one route, and it was moved to July alone and to the K and the T apart on finding that the August counts contain the Twin Peaks Tunnel's closure of August 22 to 29, 2024 ${cite('sfmtaTwinPeaks')}, a decision that rests on the record of the closure and of the K–T split, not on the fit. ${chk ? `The coding of Clipper's transfer discount was also corrected after the first result: only riders on the new Clipper system, ${pc(CLIPPER_NEXTGEN_SHARE)} of Clipper trips in mid-July 2026 ${cite('clipperMigration')}, get today's discount, and the old $0.50 came off the fare of riders who pay per ride, not of pass holders.` : ''}</p>
<p>The conditions of July 2024 were fixed before the run reported here, from published series other than Muni's counts and by rules committed to the repository before any run used them (${tab('drivers')}): office attendance downtown ${cite('kastle')}, employed residents ${cite('blsLaus')}, jobs in the city ${cite('blsQcew')}, population ${cite('dofE1')}, hotel visitors ${cite('cityScorecard')}, SFO passengers ${cite('sfoStats')}, the price of gasoline ${cite('eiaGas')}, Muni's adult Clipper fare ${cite('fares')}, and Clipper's discount on changing operators, which before December 2025 was $0.50 off Muni's fare only, against up to ${money(D.transferDiscount.today ?? 2.85)} off any operator's today ${cite('clipper2')}. Prices are in July 2026 dollars by the consumer price index for San Francisco–Oakland–Hayward (×${fx(BC_DRIVERS.deflator.factor2024to2026, 3)}) ${cite('blsCpi')}. Conditions without a source covering both years were held at today's values.</p>
<p>Over the ${BC.routes} routes, counted ridership grew by ${fx((BC.systemGrowthObserved - 1) * 100, 1)}% from July 2024 to July 2026, and the model predicts ${growth(BC.systemGrowthModel)}${Math.abs(gap) < 1 ? ', close to the count' : `, ${fx(Math.abs(gap), 1)} points ${gap > 0 ? 'below' : 'above'} it`}.${dec ? ` The 2024 network alone, with today's conditions, gives ${growth(dec.networkOnly.growth)}. Each condition of July 2024 added to it alone changes the log of the modeled growth by the points in ${tab('drivers')}. The largest is Clipper's transfer discount, ${pts(eff('transferDiscount'))} points: in 2024 a rider coming from BART paid ${money(Math.max(0, D.muniFare.value - D.transferDiscount.value))} to board Muni and one coming from Muni paid BART's full boarding charge, so the model puts fewer riders on Muni for part of a regional trip. ${others.length ? `${cap(list(others.map((d) => `${lbl(d.key)} (${pts(d.effectPts)})`)))} follow.` : ''}${chk ? ` SFMTA's weekday boardings grew ${fx(chk.meanJulNov2025, 1)}% a year from July to November 2025 and ${fx(chk.meanJanJun2026, 1)}% from January to June 2026, each against the same month a year earlier, while the discount began on December 10, 2025; the step the model's split implies for January to June, about ${fx(eff('transferDiscount') * 0.36 / CLIPPER_NEXTGEN_SHARE, 1)} points, is within two standard errors of that difference, but the model's response to the discount is probably too large, since it acts on a share of BART riders changing to Muni above the on-board surveys' (${sec('val-markets')}).` : ''}` : ''}</p>
<p>Route by route, the rider-weighted correlation between modeled and counted relative changes was ${fx(BC.weightedCorrelationOfChange, 2)} (approximate interval ${interval(ci)}; ${fig('backcast')})${dec ? `, against ${fx(dec.networkOnly.weightedCorrelationOfChange, 2)} with the network alone` : ''}. ${cap(nw(changed.length))} routes had their scheduled trips changed by more than 10%, and the model got the direction of the change right on ${dirText}: ${list(changed.map((r) => `the ${r.route} (trips ${r.runs2024} to ${r.runs2026}; counted ${spc(r.obsRelChange)}, modeled ${spc(r.modelRelChange)})`))}. On ${overstated.length === changed.length ? `all ${nw(changed.length)}` : `${nw(overstated.length)} of the ${nw(changed.length)}`} the model overstated the size of the response${worstChange ? `, most on the ${worstChange.route}` : ''}, the pattern of the high own-route elasticities of ${sec('val-sensitivity')}. Weighted by riders, the mean absolute error of the modeled change was ${pc(BC.meanAbsErrorOfChange.model, 1)}, ${beats ? 'smaller' : 'larger'} than the ${pc(BC.meanAbsErrorOfChange.noChangeForecast, 1)} of a forecast in which every route keeps its share, so ${beats ? 'the model added information beyond the assumption of no change' : 'on this test the model did not beat the assumption of no change'}. Most routes changed little in service, and their relative changes came from causes outside the network.${bart ? ` A variant chosen after these results were known, with downtown attendance scaled by BART's downtown exits${BART_DOWNTOWN_RATIO !== null ? ` (×${fx(BART_DOWNTOWN_RATIO, 3)})` : ''} instead of Kastle's index ${cite('bartRidership')}, gives ${growth(bart.systemGrowthModel)} and a mean absolute error of ${pc(bart.meanAbsErrorOfChange.model, 1)}; it shows how much the result depends on that input and is not evidence of skill.` : ''}</p>
${figure(
  'backcast',
  `<div class="chart-slot" data-chart="backcast"></div><p class="legend"><span class="key dot hl"></span> scheduled trips changed by more than 10% <span class="key dot muted"></span> other routes (area ∝ riders) <span class="key one"></span> model equals count</p>`,
  `Backcast. Change in each Muni route's weekday riders between July 2024 and July 2026 relative to the system, modeled against counted, with the July 2024 conditions fixed in advance. The model was calibrated on 2026 data and run on the ${ymd(F.backcastFeed.wkd)} schedule.`,
  {
    alt: `Scatter of modeled against counted relative change for ${BC.routes} Muni routes; the points spread widely around the diagonal${BC.directionCorrectShare === 1 ? ', and the routes with large service changes lie on the correct side of zero' : ''}.`,
    wide: false,
    data: dataTable(['Route', 'Trips 2024', 'Trips 2026', 'Counted 2024', 'Counted 2026', 'Counted change', 'Modeled change'], BC.rows.map((r) => [r.route, int(r.runs2024), int(r.runs2026), int(r.observed2024), int(r.observed2026), spc(r.obsRelChange), spc(r.modelRelChange)]), [1, 2, 3, 4, 5, 6]),
  },
)}
${dec ? table(
  'drivers',
  'Backcast: the conditions of July 2024 relative to July 2026, fixed before the run, and the growth in modeled Muni riders from 2024 to 2026 that each accounts for (log points, ×100; the 2024 network alone, then each condition added to it alone).',
  ['Condition', 'July 2024', 'Source', 'Effect on modeled growth'],
  [
    [`Network: Muni's schedule of ${ymd(F.backcastFeed.wkd)}`, '', `archived GTFS ${cite('gtfs')}`, pts(dec.networkOnly.effectPts)],
    ...dec.drivers.map((d) => {
      const spec = CONDITION_BY_KEY[d.key as ConditionKey];
      const v = spec?.unit === 'usd' ? `${money(d.value)}${d.key === 'transferDiscount' ? ', onto Muni only' : ''} (today ${money(spec.today)})` : pc(d.value, 1);
      return [spec?.label ?? d.key, v, DRIVER_SOURCE[d.key] ?? '', pts(d.effectPts)];
    }),
    ['Interaction', '', '', pts(dec.interactionPts)],
    ['<b>Modeled growth</b>', '', '', `<b>${pts(dec.totalPts)}</b>`],
    ['<b>Counted growth</b>', '', `SFMTA ${cite('sfmtaRidership')}`, `<b>${pts(dec.observedPts)}</b>`],
  ],
  { numeric: [1, 3], wide: true, notes: `Relative values are July 2024 over July 2026; dollars are July 2026 dollars. Held at today's values for want of a source covering both years: ${list(Object.keys(BC_DRIVERS.held).filter((k) => CONDITION_BY_KEY[k as ConditionKey]).map((k) => CONDITION_BY_KEY[k as ConditionKey].label.toLowerCase()))}. Inputs and rules: <code>server/beta3/reference/backcast-drivers.json</code>.` },
) : ''}
`);
}

function scorecard(): string {
  const T = tally();
  const statusWord: Record<string, string> = { pass: 'Meets', warn: 'Near', fail: 'Misses' };
  const rows = TIERS.flatMap((t) => T.checks.filter((c) => c.tier === t));
  const standardText = (c: (typeof rows)[number]) =>
    /running time/.test(c.what)
      ? `${c.standard.split(':')[0]}: indicative band, the authors' judgment`
      : /Florida screenline/.test(c.standard)
        ? 'FHWA Table 9.9 (Florida): transit screenlines ±20% acceptable, ±10% preferable'
        : c.standard;
  const missedTests = T.tests.filter((c) => c.status === 'fail');
  const nearTests = T.tests.filter((c) => c.status === 'warn');
  const checkName = (c: (typeof rows)[number]) =>
    c.what.replace(/^Response: (.*)$/, 'the $1 test').replace(/^Backcast:.*/, 'the backcast').replace(/^Trip length per boarding: /, 'trip length on ').replace(/^Boardings/, 'boardings').replace(/^Individual/, 'individual').replace(/the Car /, 'the car ').replace(/^Ferry/, 'ferry').replace(/ \(independent\)$/, '');
  const semi = (xs: string[]) => (xs.some((x) => x.includes(',')) && xs.length > 2 ? `${xs.slice(0, -1).join('; ')}; and ${xs[xs.length - 1]}` : list(xs));
  const frac = (p: number, n: number, t: Tier) => (n === 1 ? `${p ? '' : 'not '}the ${t} test` : `${p === 0 ? 'none' : p} of the ${n} ${t} tests`);
  return section('val-scorecard', 'Summary against the standards', `
<p>${tab('scorecard')} lists the checks of the weekday model that the validation report scores against a cited standard, grouped by tier. Only the independent and held-out tests are counted: the model meets ${T.passed} of these ${T.tests.length} (${list((['independent', 'held-out'] as Tier[]).filter((t) => T.by[t].total).map((t) => frac(T.by[t].passed, T.by[t].total, t)))}). ${missedTests.length ? `It misses ${semi(missedTests.map(checkName))}${nearTests.length ? `. It is near the standard on ${semi(nearTests.map(checkName))}` : ''}.` : nearTests.length ? `It is near the standard on ${semi(nearTests.map(checkName))}.` : ''} The development-set statistics (${T.by.development.passed} of ${T.by.development.total} met), the calibration targets, and the benchmarks are listed for reference and not counted. The weekend models are scored with the other weekend results (${sec('val-weekend')}).</p>
${table(
  'scorecard',
  'Validation checks against standards, weekday model.',
  ['Tier', 'Check', 'Result', 'Standard', 'Status'],
  rows.map((c, i) => [i === 0 || rows[i - 1].tier !== c.tier ? TIER_NAME[c.tier] : '', c.what, c.value.replace(/-(?=\d)/g, '−'), balanced(standardText(c)).replace(/-(?=\d)/g, '−'), `<span class="status ${c.status}">${statusWord[c.status] ?? c.status}</span>`]),
  { wide: true, cls: 'scorecard', notes: `Status as assigned by the validation report (<code>server/beta3/pipeline/report.ts</code>). "Near" means within the report's margin of the standard: r of at least 0.80 against 0.88; %RMSE below 50% against 40%; a total within ±15% against ±9%; all but two route groups within ±20%; at least 60% of routes within their FHWA band against 75%, or within ±25% against 95%; trip length within ±15% against ±5%; boardings per linked trip from 1.1 to 1.7 against 1.2 to 1.6; an elasticity within 0.15 of its range; and, for the backcast, an error below that of a no-change forecast with a correlation of 0.3 or less.` },
)}
`);
}

const DRIVER_NAME: Record<string, string> = {
  attendanceCore: 'office attendance downtown',
  employedResidents: 'employed residents',
  jobs: 'jobs in the city',
  residents: 'population',
  visitors: 'hotel visitors',
  airPassengers: 'SFO passengers',
  gasPrice: 'the price of gasoline',
  muniFare: "Muni's fare",
  transferDiscount: "Clipper's transfer discount",
};
const DRIVER_SOURCE: Record<string, string> = {
  attendanceCore: 'Kastle office occupancy, mean of the July weeks',
  employedResidents: 'BLS LAUS, San Francisco County, July',
  jobs: 'BLS QCEW, San Francisco County, first quarters',
  residents: 'DOF E-1, interpolated to July',
  visitors: 'hotel occupancy, 4-week moving average, July',
  airPassengers: 'SFO passengers, July',
  gasPrice: 'EIA weekly San Francisco regular, July',
  muniFare: 'SFMTA fare table ($2.50 in July 2024)',
  transferDiscount: 'SFMTA fare table; Next Generation Clipper',
};
