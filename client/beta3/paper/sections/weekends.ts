/** The experimental weekend models: what differs and their calibration (weekendModel), and the weekend counts as a held-out test (weekendValidation). */
import { F, muni, REF, SC, SCX, STD, V, type RouteRow } from '../data';
import { cite, dataTable, dev, eq, fig, figure, fx, int, list, math, nw, pc, pearson, sec, secs, section, spc, tab, table, ymd } from '../doc';

type WeekendDay = 'sat' | 'sun';
const NHTS_PURPOSES: [string, string][] = [
  ['HBW', 'Commute'],
  ['HBSHOP', 'Shopping'],
  ['HBSOCREC', 'Social'],
  ['HBO', 'Errands and other'],
  ['HBSCH_K12', 'School (K–12)'],
  ['HBUNIV', 'College'],
  ['NHB', 'Neither end at home'],
];

function pctRmse(rows: { observed: number; model: number }[]) {
  const n = rows.length;
  const mo = rows.reduce((a, r) => a + r.observed, 0) / n;
  return (100 * Math.sqrt(rows.reduce((a, r) => a + (r.model - r.observed) ** 2, 0) / n)) / mo;
}
const byAbsError = (rs: RouteRow[]) => rs.slice().sort((a, b) => Math.abs(b.model - b.observed) - Math.abs(a.model - a.observed));
/** share of the squared error carried by the k routes with the largest absolute differences */
function topShare(rs: RouteRow[], k: number) {
  const sq = (r: RouteRow) => (r.model - r.observed) ** 2;
  const all = rs.reduce((a, r) => a + sq(r), 0);
  return byAbsError(rs).slice(0, k).reduce((a, r) => a + sq(r), 0) / all;
}

/** the weekend calibration's fitted values (facts.json) */
function fitted() {
  const C = F.calibration;
  const days = C.days as Record<WeekendDay, { transitAsc: number; regionalRate: number; touristFactor: number }>;
  return { C, days, tf: [days.sat.touristFactor, days.sun.touristFactor], bartMonth: F.observed.bartPeriod.split(' average')[0] };
}

/** Model structure: what differs on Saturdays and Sundays, and how the two weekend quantities were fitted */
export function weekendModel(): string {
  const w = muni('wkd'), sa = muni('sat'), su = muni('sun');
  const B = V.bart;
  const { C, days, tf, bartMonth } = fitted();
  const rate = F.dayTypes as Record<WeekendDay, { rate: Record<string, number> }>;
  const nh = REF.nhtsDays.byDayType as unknown as Record<'weekday' | 'saturday' | 'sunday', Record<string, { n_trips_sample: number }>>;
  const nhN = (d: 'weekday' | 'saturday' | 'sunday') => Object.values(nh[d]).reduce((a, v) => a + v.n_trips_sample, 0);
  const nhP = (d: 'weekday' | 'saturday' | 'sunday', p: string) => nh[d][p]?.n_trips_sample ?? 0;
  /** "August 22 or October 10, 2026," (or full dates when the years differ) */
  const dates = (d: WeekendDay) => {
    const ds = [...new Set(F.feeds.map((f) => f[d]))].sort();
    const years = new Set(ds.map((x) => x.slice(0, 4)));
    const or = (xs: string[]) => (xs.length <= 2 ? xs.join(' or ') : `${xs.slice(0, -1).join(', ')}, or ${xs[xs.length - 1]}`);
    return years.size === 1 ? `${or(ds.map((x) => ymd(x).replace(/, \d{4}$/, '')))}, ${[...years][0]},` : `${or(ds.map(ymd))},`;
  };
  const sign = days.sat.transitAsc > 0 && days.sun.transitAsc > 0 ? 'few' : days.sat.transitAsc < 0 && days.sun.transitAsc < 0 ? 'many' : '';

  return section('weekend-model', 'Weekends (experimental)', `
<p>The application can also run an average Saturday and an average Sunday. These models are experimental and switched off by default. They share the weekday model's zones, streets, choice models, assignment, coefficients, and calibrated constants; only two quantities were fitted for each day, and fewer checks were repeated for them (${sec('val-weekend')}). Each weekend day has its own transit network, built as the weekday network is (${sec('zones')}) from the Saturday and Sunday service in each GTFS feed ${cite('gtfs')} (depending on the feed, the service of ${dates('sat')} for Saturdays and of ${dates('sun')} for Sundays). The transit utility (${eq('v-transit')}) gains one constant, ${math('\\delta_{\\text{day}}')}, the same for every purpose and zone.</p>
<p>Trip rates per person were computed from NHTS 2017 for the San Francisco–Oakland CBSA for weekdays, Saturdays, and Sundays with the same weights and purposes ${cite('nhts2017')}, and each weekend rate enters as its ratio to the weekday rate (${tab('weekend-rates')}). The ratio multiplies the work tours of residents and in-commuters (${eq('commute')}), the tours of each other purpose, and the stops made on them. In-commuters' trips with neither end at home follow the work ratio, so that row of ${tab('weekend-rates')} is for reference only. A Saturday has ${fx(rate.sat.rate.HBW, 2)} times the weekday's commute trips, ${fx(rate.sat.rate.HBSHOP, 2)} times its shopping trips, and ${fx(rate.sat.rate.HBSOCREC, 2)} times its social trips; a Sunday has ${fx(rate.sun.rate.HBW, 2)}, ${fx(rate.sun.rate.HBSHOP, 2)}, and ${fx(rate.sun.rate.HBSOCREC, 2)} times. The NHTS weekend trips also give the period and direction shares of the seven purposes, which replace the weekday shares (${sec('tod')}). Hotel visitors and air travelers make the same number of trips, with the same timing, on every day; private shuttles do not run. The sightseeing rides (${sec('special')}) were assumed to be ${tf[0] === tf[1] ? `${fx(tf[0], 1)} times their weekday number on both days` : `${fx(tf[0], 1)} times their weekday number on Saturdays and ${fx(tf[1], 1)} times on Sundays`}, since SFMTA has published no count of the cable cars or historic streetcars for any day since 2020. SFCTA's speed data cover Tuesdays to Thursdays only ${cite('sfctaCmp')}, so weekend driving times are fixed at weekday midday times in the day's three daytime periods and at weekday evening times at night, with no traffic assignment.</p>
${table(
  'weekend-rates',
  'Weekend trip rates relative to the weekday, by purpose, from NHTS 2017 (San Francisco–Oakland CBSA).',
  ['Purpose', 'Saturday', 'Sunday', 'Sample trips, weekday', 'Sample trips, Saturday', 'Sample trips, Sunday'],
  NHTS_PURPOSES.map(([k, name]) => [name, fx(rate.sat.rate[k] ?? 1, 2), fx(rate.sun.rate[k] ?? 1, 2), int(nhP('weekday', k)), int(nhP('saturday', k)), int(nhP('sunday', k))]),
  { numeric: [1, 2, 3, 4, 5], wide: true, notes: 'Ratio of weighted trips per person on the day type to weighted trips per person on a weekday (<code>nhts_daytypes.py</code>, NHTS 2017 public-use files). Social includes dining and recreation; errands and other is the survey\'s other home-based purpose. Sample trips are unweighted survey trips by residents of the CBSA.' },
)}
<p>Two quantities were fitted for each day, after the weekday calibration and with every weekday parameter held. The constant ${math('\\delta_{\\text{day}}')} was fitted to the total of SFMTA's average boardings for that day of the week on the counted routes, over the same twelve months as the weekday counts ${cite('sfmtaRidership')}, and the regional visitor rate to BART's ${bartMonth} average exits on that day at the nine city-area stations ${cite('bartRidership')}. Each was updated six times on single passes without crowding: the constant by 1.1 times the log of the ratio of counted to modeled Muni boardings, and the rate by the ratio of counted to modeled BART exits raised to the power 1.2, within bounds of 0.05 and 5 (${tab('weekend-fit')}). The base runs the application loads are made with crowding, so they do not reproduce the targets exactly: Muni boardings on the counted routes differ from the counts by ${dev(sa.totalRatio)} on Saturdays and ${dev(su.totalRatio)} on Sundays, and BART exits by ${dev(B.sat.totalRatio)} and ${dev(B.sun.totalRatio)}.${sign ? ` Both transit constants are ${sign === 'few' ? 'positive' : 'negative'}: with the weekday constants and the NHTS weekend rates, the model carried too ${sign} weekend Muni riders.` : ''} The regional visitor rate is ${fx(days.sat.regionalRate / C.regionalRate, 2)} times the weekday rate on Saturdays and ${fx(days.sun.regionalRate / C.regionalRate, 2)} times on Sundays; as the only quantity fitted to BART, it also absorbs any error in residents' and in-commuters' weekend BART trips.</p>
${table(
  'weekend-fit',
  'Weekend calibration: targets, base runs, and fitted values, with the weekday for comparison.',
  ['Quantity', 'Weekday', 'Saturday', 'Sunday'],
  [
    ['Muni routes counted', int(w.n), int(sa.n), int(su.n)],
    ['Muni boardings on the counted routes, counted', int(w.observedTotal), int(sa.observedTotal), int(su.observedTotal)],
    ['Muni boardings on the counted routes, modeled', int(w.modelTotal), int(sa.modelTotal), int(su.modelTotal)],
    ['BART exits, nine city-area stations, counted', int(B.wkd.observedTotal), int(B.sat.observedTotal), int(B.sun.observedTotal)],
    ['BART exits, nine city-area stations, modeled', int(B.wkd.modelTotal), int(B.sat.modelTotal), int(B.sun.modelTotal)],
    ['Transit constant δ<sub>day</sub>', '–', fx(days.sat.transitAsc, 2), fx(days.sun.transitAsc, 2)],
    ['Regional visitor rate, trips per in-commuter', fx(C.regionalRate, 3), fx(days.sat.regionalRate, 3), fx(days.sun.regionalRate, 3)],
    ['Sightseeing rides, relative to the weekday (assumed)', '1', fx(tf[0], 1), fx(tf[1], 1)],
  ],
  { numeric: [1, 2, 3], notes: `Weekday Muni boardings on the counted routes are the target of the transfer factor (${sec('calibration')}). Counts: SFMTA twelve-month means; BART ${bartMonth}.` },
)}
<p>The weekend models rest on weekday evidence. BATS 2023 recorded weekday travel only ${cite('bats2023')}, so there is no weekend mode-share target, and ${math('\\delta_{\\text{day}}')}, fitted to the Muni total, says nothing about walking, cycling, or driving. The mode choice coefficients are TM1's, estimated for a typical weekday ${cite('tm1Code')}. The NHTS 2017 weekend rates predate the pandemic and rest on ${int(nhN('saturday'))} Saturday and ${int(nhN('sunday'))} Sunday sample trips in the whole CBSA, against ${int(nhN('weekday'))} on weekdays; the school and college rates come from ${nw(nhP('saturday', 'HBSCH_K12'))} and ${nw(nhP('saturday', 'HBUNIV'))} sample trips on Saturdays and ${nw(nhP('sunday', 'HBSCH_K12'))} and ${nw(nhP('sunday', 'HBUNIV'))} on Sundays. The destination size terms are the same on every day (${sec('destination')}). Caltrain's weekend figure is a systemwide average that includes trips with neither end in the city, so the weekend models are not compared with Caltrain. The sensitivity tests and the backcast were run on the weekday model only.</p>
`);
}

/** Validation: the weekend counts as a held-out test */
export function weekendValidation(): string {
  const w = muni('wkd'), sa = muni('sat'), su = muni('sun');
  const ctc = STD.ctc, fh = STD.fhwaTransit, tag = STD.tag;
  const { bartMonth } = fitted();
  const B = V.bart;

  const wByRoute = new Map(w.routes.map((r) => [r.route, r]));
  const wSame = pctRmse(sa.routes.map((r) => wByRoute.get(r.route)).filter((r): r is RouteRow => !!r));
  const sameSet = sa.routes.length === su.routes.length && sa.routes.every((r) => su.routes.some((x) => x.route === r.route));
  const share5 = { wkd: topShare(w.routes, 5), sat: topShare(sa.routes, 5), sun: topShare(su.routes, 5) };
  const worst = (rs: RouteRow[]) => byAbsError(rs).slice(0, 5);
  const wkdTop = worst(w.routes).map((r) => r.route), weTop = new Set([...worst(sa.routes), ...worst(su.routes)].map((r) => r.route));
  const overlap = wkdTop.filter((r) => weTop.has(r));
  // weekend-to-weekday ratios by route: the part of the weekend fit the weekday development set does not share
  const ratioRows = (d: WeekendDay) => muni(d).routes.flatMap((r) => { const x = wByRoute.get(r.route); return x && x.model > 0 && r.model > 0 ? [[Math.log(r.observed / x.observed), Math.log(r.model / x.model)]] : []; });
  const ratioR = (d: WeekendDay) => pearson(ratioRows(d).map((v) => v[0]), ratioRows(d).map((v) => v[1]));
  const ratioN = ratioRows('sat').length;

  // service categories
  const grp = (d: 'wkd' | WeekendDay, name: string) => muni(d).groups.find((g) => g.name === name);
  const groupsOk = (d: 'wkd' | WeekendDay) => muni(d).groups.filter((g) => Math.abs(g.pct) <= ctc.routeGroupPct).length;
  const outside = (d: WeekendDay) => muni(d).groups.filter((g) => Math.abs(g.pct) > ctc.routeGroupPct);
  const metro = { wkd: grp('wkd', 'Muni Metro'), sat: grp('sat', 'Muni Metro'), sun: grp('sun', 'Muni Metro') };

  // BART stations
  const rel = (e: { observed: number; model: number }) => e.model / e.observed - 1;
  const stationErr = (d: WeekendDay) => new Map(B[d].exits.map((e) => [e.code, rel(e)]));
  const es = stationErr('sat'), eu = stationErr('sun');
  const lowBoth = B.wkd.exits.filter((e) => (es.get(e.code) ?? 0) < -0.1 && (eu.get(e.code) ?? 0) < -0.1).map((e) => e.name);
  const highBoth = B.wkd.exits.filter((e) => (es.get(e.code) ?? 0) > 0.1 && (eu.get(e.code) ?? 0) > 0.1).map((e) => e.name);
  const bartLargest = (d: 'wkd' | WeekendDay) => list(B[d].exits.slice().sort((a, b) => Math.abs(rel(b)) - Math.abs(rel(a))).slice(0, 2).map((e) => `${e.name} (${spc(rel(e))})`));

  const scored = (SCX.weekend ?? SC.checks.filter((c) => /Saturday|Sunday/.test(c.what))).filter((c) => /correlation/.test(c.what));
  const verb: Record<string, [string, string]> = { pass: ['meets', 'meet'], warn: ['is near', 'are near'], fail: ['misses', 'miss'] };
  const allSame = scored.length === 2 && scored[0].status === scored[1].status;
  const scoredText = !scored.length ? '' : allSame ? `both weekend correlations ${verb[scored[0].status]?.[1] ?? scored[0].status} it` : list(scored.map((c) => `the ${/Saturday/.test(c.what) ? 'Saturday' : 'Sunday'} correlation ${verb[c.status]?.[0] ?? c.status} it`));
  const statRow = (label: string, f: (d: 'wkd' | WeekendDay) => string, std: string) => [label, f('wkd'), f('sat'), f('sun'), std];
  const within = (d: WeekendDay) => pc(muni(d).within25);

  return section('val-weekend', 'Weekend counts', `
<p>The weekend route counts are a held-out test of the experimental weekend models (${sec('weekend-model')}). They were not examined while the model structure was developed, and only their total on the counted routes was fitted, so the split of boardings among routes is a test; like the weekday counts, they are twelve-month means of SFMTA's monthly averages ${cite('sfmtaRidership')}. ${tab('weekend-muni')} and ${fig('weekend-scatter')} compare them with the model. On Saturdays the correlation across ${sa.n} routes was ${fx(sa.r, 3)} and the %RMSE ${fx(sa.pctRmse, 1)}%; on Sundays ${fx(su.r, 3)} and ${fx(su.pctRmse, 1)}%, against ${fx(w.pctRmse, 1)}% on weekdays and the CTC threshold of ${ctc.pctRmseMax}%. Fewer routes are counted on weekends (${sa.n}${sameSet ? '' : ` on Saturdays and ${su.n} on Sundays`}, against ${w.n} on weekdays); on the routes counted on Saturdays, the weekday %RMSE is ${fx(wSame, 1)}%.${scoredText ? ` The scorecard grades the weekend route correlations against the CTC threshold of ${ctc.correlationMin}, and ${scoredText}.` : ''} The test is not fully independent of the weekday development set, since the weekend models share the weekday structure${overlap.length >= 3 ? `, and ${nw(overlap.length)} of the five routes with the largest weekday misses (${list(overlap)}) are also among the five largest on Saturdays or Sundays` : ''}. The ratio of each route's weekend to weekday boardings removes what the two days share: across the ${ratioN} routes counted on both, the logarithms of the modeled and counted Saturday-to-weekday ratios correlate at ${fx(ratioR('sat'), 2)}, and the Sunday-to-weekday ratios at ${fx(ratioR('sun'), 2)}.</p>
${table(
  'weekend-muni',
  'Muni boardings by route on weekends: modeled against counted, with the weekday for comparison.',
  ['Statistic', 'Weekday', 'Saturday', 'Sunday', 'Guideline'],
  [
    statRow('Routes compared', (d) => String(muni(d).n), '–'),
    statRow('Counted boardings', (d) => int(muni(d).observedTotal), '–'),
    statRow('Modeled boardings', (d) => int(muni(d).modelTotal), '–'),
    statRow('Total, model against count', (d) => dev(muni(d).totalRatio), `±${fh.regionalAcceptable}% acceptable, ±${fh.regionalPreferable}% preferable ${cite(['fhwa2010', 'Table 9.9'])}`),
    statRow('Correlation r', (d) => fx(muni(d).r, 3), `≥ ${ctc.correlationMin} (highway links) ${cite('ctc2017')}`),
    statRow('R²', (d) => fx(muni(d).r2, 3), '–'),
    statRow('%RMSE', (d) => `${fx(muni(d).pctRmse, 1)}%`, `< ${ctc.pctRmseMax}% (highway links) ${cite('ctc2017')}`),
    statRow('Median absolute error', (d) => `${fx(muni(d).medianApe, 1)}%`, '–'),
    statRow('Slope through origin', (d) => fx(muni(d).slopeThroughOrigin, 3), '1'),
    statRow('Routes within FHWA acceptable band', (d) => pc(muni(d).fhwaLineBands.acceptableShare), `by size ${cite(['fhwa2010', 'Table 9.9'])}`),
    statRow('Routes within FHWA preferable band', (d) => pc(muni(d).fhwaLineBands.preferableShare), 'by size'),
    statRow('Routes within ±25%', (d) => pc(muni(d).within25), `${pc(tag.servicesWithin25Share)} of services ${cite('tagM32')}`),
    statRow('Share of squared error on the five largest misses', (d) => pc(share5[d]), '–'),
  ],
  { numeric: [1, 2, 3], wide: true, notes: `Weekday column as in ${tab('muni-stats')}. The weekend totals were fitted (${sec('weekend-model')}); the split among routes was not.` },
)}
${figure(
  'weekend-scatter',
  `<div class="panels">${(['sat', 'sun'] as WeekendDay[]).map((d) => `<div class="panel"><p class="panel-h">${d === 'sat' ? 'Saturday' : 'Sunday'} <span>${muni(d).n} routes · r ${fx(muni(d).r, 2)} · %RMSE ${muni(d).pctRmse.toFixed(0)}%</span></p><div class="chart-slot" data-chart="muni-${d}"></div></div>`).join('')}</div>
  <p class="legend"><span class="key dot"></span> within ±25% <span class="key dot out"></span> outside ±25% <span class="key band"></span> ±25% of the count <span class="key one"></span> model equals count</p>`,
  `Modeled against counted boardings for each Muni route on Saturdays and Sundays, on logarithmic axes, as in ${fig('muni-scatter')}. Labeled routes are the five largest absolute differences on each day.`,
  {
    alt: `Two scatter plots of modeled against counted Muni route boardings for Saturdays and Sundays. Points cluster along the diagonal; ${within('sat')} of Saturday routes and ${within('sun')} of Sunday routes fall inside the ±25% band.`,
    data: dataTable(['Route', 'Category', 'Saturday counted', 'Saturday model', 'Sunday counted', 'Sunday model'], sa.routes.map((r) => {
      const u = su.routes.find((x) => x.route === r.route);
      return [r.route, r.category, int(r.observed), int(r.model), u ? int(u.observed) : '–', u ? int(u.model) : '–'];
    }), [2, 3, 4, 5]),
  },
)}
<p>The five largest absolute differences carry ${pc(share5.sat)} of the squared error on Saturdays and ${pc(share5.sun)} on Sundays, against ${pc(share5.wkd)} on weekdays: routes ${list(worst(sa.routes).map((r) => `${r.route} (${spc(r.pct / 100)})`))} on Saturdays, and ${list(worst(su.routes).map((r) => `${r.route} (${spc(r.pct / 100)})`))} on Sundays. Within ±25% of the count are ${within('sat')} of routes on Saturdays and ${within('sun')} on Sundays, against ${pc(w.within25)} on weekdays. By SFMTA service category, ${groupsOk('sat')} of ${sa.groups.length} groups ${groupsOk('sat') === 1 ? 'was' : 'were'} within ±${ctc.routeGroupPct}% on Saturdays and ${groupsOk('sun')} of ${su.groups.length} on Sundays, against ${groupsOk('wkd')} of ${w.groups.length} on weekdays${outside('sat').length ? `; those outside it on Saturdays were ${list(outside('sat').map((g) => `${g.name} (${spc(g.pct / 100)})`))}` : ''}.${metro.wkd && metro.sat && metro.sun ? ` Muni Metro is ${spc(metro.wkd.pct / 100)} against its count on weekdays, ${spc(metro.sat.pct / 100)} on Saturdays, and ${spc(metro.sun.pct / 100)} on Sundays.` : ''}</p>
<p>BART's weekend exits at the nine city-area stations were fitted in total, so again only their split across stations is a test (${tab('weekend-bart')}). The correlation across stations was ${fx(B.sat.r, 2)} on Saturdays and ${fx(B.sun.r, 2)} on Sundays, against ${fx(B.wkd.r, 2)} on weekdays, and the %RMSE ${fx(B.sat.pctRmse, 0)}% and ${fx(B.sun.pctRmse, 0)}%, against ${fx(B.wkd.pctRmse, 0)}%.${lowBoth.length && highBoth.length ? ` On both weekend days the model has more than 10% too few exits at ${list(lowBoth)} and more than 10% too many at ${list(highBoth)}; the destination size terms, which do not change by day, may cause the pattern, but this was not tested.` : ''}</p>
${table(
  'weekend-bart',
  'BART exits at the nine city-area stations by day type: split across stations, model against counts.',
  ['Day', 'Stations', 'r', '%RMSE', 'Within ±25%', 'Largest relative errors'],
  (['wkd', 'sat', 'sun'] as const).map((d) => [d === 'wkd' ? 'Weekday' : d === 'sat' ? 'Saturday' : 'Sunday', B[d].n, fx(B[d].r, 2), `${fx(B[d].pctRmse, 0)}%`, pc(B[d].within25), bartLargest(d)]),
  { numeric: [1, 2, 3, 4], wide: true, notes: `BART ${bartMonth} averages by day type ${cite('bartRidership')}. On every day the total was fitted through the regional visitor rate (${secs('calibration', 'weekend-model')}).` },
)}
`);
}

