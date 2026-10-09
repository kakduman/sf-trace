/**
 * Scenarios: how a scenario is run and its time savings measured, and the case studies, from
 * client/beta3/model/portal.json and uncertainty.json and server/beta3/reference/road-scenarios.json,
 * runmodes.json, peninsula-runs.json, and road-validation.json.
 */
import RV from '../../../../server/beta3/reference/road-validation.json';
import { PORTAL, UNC } from '../data';
import { cap, cite, fx, int, list, nw, pc, sec, section, tab, table } from '../doc';
import { RM } from './runmodes';

/** runs with traffic feedback, one pass from today's crowding (roads-test.ts) */
interface Scn {
  seconds: number;
  gaps: Record<string, number>;
  mode: Record<string, number>;
  transitTrips: number;
  vmt: { base: number; scenario: number };
  vht: { base: number; scenario: number };
  speed: { base: Record<string, Record<string, number>>; scenario: Record<string, Record<string, number>> };
  changes: { name: string; base: number; scenario: number }[];
  trips?: { name: string; period: string; base: number; scenario: number }[];
  convergence?: number[];
  bus?: { route: string; base: number; scenario: number }[];
  entering?: { p: string; base: number; scn: number }[];
}
const RS = (Object.values(import.meta.glob('../../../../server/beta3/reference/road-scenarios.json', { eager: true, import: 'default' }))[0] ?? {}) as Record<string, Scn>;

/** Precise runs with the Peninsula freeways, each against today's network run the same way (peninsula-runs.ts) */
type Part = 'transit' | 'drivers' | 'others' | 'peninsula' | 'total';
interface PenRun {
  seconds: { cpu: number; wall: number };
  caltrain: { scenario: number; control: number };
  transitTrips: number;
  trips?: Record<string, number>;
  savings: Record<Part, number>;
  segments: { route: string; dir: string; from: string; to: string; dVeh: Record<string, number>; mphControl: Record<string, number>; mph: Record<string, number> }[] | null;
}
const PR = (Object.values(import.meta.glob('../../../../server/beta3/reference/peninsula-runs.json', { eager: true, import: 'default' }))[0] ?? null) as { before?: { runs: Record<string, PenRun> }; after?: { runs: Record<string, PenRun> } } | null;
const PV = (RV as unknown as { peninsula?: { volumes: { route: string; from: string; to: string; count: number }[] } }).peninsula;

/** a signed count with a true minus */
const sint = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${int(Math.abs(n))}`;
const pctd = (a: number, b: number, d = 1) => `${a >= b ? '+' : '−'}${fx(Math.abs(100 * (a / b - 1)), d)}%`;
const MODE_NAME: Record<string, string> = { da: 'driving alone', sr: 'carpools', tnc: 'ride-hail', transit: 'transit', walk: 'walking', bike: 'cycling' };
const modeLine = (m: Record<string, number>, min = 50) => list(['da', 'sr', 'tnc', 'transit', 'walk', 'bike'].filter((k) => Math.abs(m[k] ?? 0) >= min).map((k) => `${MODE_NAME[k]} ${sint(m[k])}`));
const SCN_NAME: Record<string, string> = { cordon: '$8 peak charge, Downtown and SoMa', buslane: 'Bus lanes on 19th Avenue', free: 'Fare-free Muni', parking: 'Parking +$4 an hour downtown' };
/** the uncertainty runs' scenario names (uncertainty.ts) */
const UNC_NAME: Record<string, string> = {
  '38R x2': "doubling the 38R's frequency",
  'Mission lanes': 'cutting running times on the 14, 14R, and 49 by 20%',
  'Muni fare +25%': 'raising Muni fares by 25%',
  'The Portal': 'the Portal',
};

/** a Precise run with the freeways, and its parts against the control's own (zero when the control reproduces today) */
const run = (k: string) => PR?.after?.runs[k];
const part = (k: string, p: Part) => (run(k)?.savings[p] ?? 0) - (run('today')?.savings[p] ?? 0);
const PART_ROWS: [Part, string][] = [
  ['transit', 'Transit riders'],
  ['drivers', 'Drivers and ride-hail'],
  ['peninsula', 'Other drivers on the Peninsula freeways'],
  ['others', 'Others (the changed conditions)'],
];

export function scenarios(): string {
  return section('scenarios', 'Scenarios', `
<p>This section describes how the application runs a scenario and measures travelers' time savings, then applies the model to five changes: the Portal, set beside its official forecasts; fare-free Muni; a peak charge to drive into Downtown and SoMa, with dearer parking beside it; and bus lanes on 19th Avenue. None has an observed outcome to compare with, so these are applications, not tests. The last subsection gives the range of four example results over drawn parameters.</p>
${method()}
${portal()}
${fare()}
${charge()}
${busLanes()}
${uncertainty()}
`);
}

function method(): string {
  const scns = (['cordon', 'buslane', 'free', 'parking'] as const).filter((k) => RS[k]);
  const gapMax = scns.length ? Math.max(...scns.flatMap((k) => Object.values(RS[k].gaps))) : NaN;
  const cases = (['portal', 'free', 'cordon'] as const).filter((k) => run(k));
  const bus19 = RM?.scenarios.bus19;
  const CASE_NAME: Record<string, string> = { portal: 'The Portal', free: 'Fare-free Muni', cordon: '$8 peak charge' };
  const cols: { name: string; v: (p: Part) => number | null }[] = [
    ...cases.map((k) => ({ name: CASE_NAME[k], v: (p: Part) => part(k, p) })),
    ...(bus19 ? [{ name: 'Bus lanes on 19th Avenue', v: (p: Part) => (p === 'total' ? bus19.timeSavingsH.total.precise : p === 'peninsula' ? null : bus19.timeSavingsH[p].precise) }] : []),
  ];
  const others = cols.some((c) => (c.v('others') ?? 0) !== 0);
  const tsTable = cols.length
    ? table(
        'time-savings',
        'Travelers’ time savings by traveler in Precise runs, hours a weekday, each against today’s network run the same way.',
        ['', ...cols.map((c) => c.name)],
        [
          ...PART_ROWS.filter(([p]) => p !== 'others' || others).map(([p, label]) => [label, ...cols.map((c) => { const v = c.v(p); return v === null ? '–' : sint(v); })]),
          ['All travelers', ...cols.map((c) => sint(c.v('total') ?? 0))],
        ],
        { numeric: cols.map((_, i) => i + 1), wide: true, notes: `The Portal, fare-free Muni, and the charge: Precise runs with the Peninsula freeways (<code>peninsula-runs.ts</code>). Bus lanes on 19th Avenue: the Precise run of ${tab('runmodes')} (<code>runmodes.ts</code>), which reports no Peninsula part. These runs make one pass from today's crowding, as the application does.` },
      )
    : '';
  return section('scen-method', 'Setting up and measuring a scenario', `
<p>A scenario is a list of edits to today's inputs. Transit edits change a route's frequency by period or its running time, remove a route or a stop, add a stop, extend a route, or add a line, and scale an operator's fares; shared bikes and scooters can be changed too. Street edits take lanes from cars or add them, give a lane to buses, or close a street to cars, each along a named street between two points. Price edits charge cars entering an area in chosen periods or raise parking charges in an area. Condition edits change the number of residents, employed residents, jobs, hotel visitors, air travelers, and regional visitors, the share working from home, commuting days, attendance at work, and events. Every change to transit reaches the streets through the shift in mode it causes. The application runs a scenario as one pass from today's crowding in Quick or Precise and compares it with today's network run in the same mode (${sec('runmodes')}).</p>
<p>Travelers' time savings are the change in the logsums of the destination and mode choice models (the consumer surplus), converted to minutes of in-vehicle time with each traveler's in-vehicle time coefficient and summed over all travelers. They include the value of trips people now choose to make, or make to other places or by other modes, not only the time saved on trips they already make. To split them by traveler, demand is run once more with the scenario's transit network, fares, and shared vehicles but today's streets, traffic, car prices, and conditions, and once more with the scenario's conditions added if it changes them. The application reports four parts, each against today's network run in the same mode:</p>
<ul>
<li>Transit riders: the change with only the transit network, fares, and shared vehicles changed.</li>
<li>Drivers and ride-hail: the rest of the change once streets, car prices, and traffic are added. Drivers lose time where a lane is taken from cars or a charge is added, and gain it where fewer cars are on the road. In Quick it is zero unless the scenario edits streets or prices.</li>
<li>Other drivers on the Peninsula freeways: the traffic on US-101 and I-280 with no end in the city, each segment's background times its change in time, in minutes like every other traveler's (${sec('roads')}). It is computed only in Precise, and it is not part of the logsum. A scenario that changes nothing gives exactly zero, and every assignment is solved to today's gap, so the remaining gap does not show as time saved.</li>
<li>Others: the change the scenario's conditions make. A scenario that changes how many people travel mixes the value of the change with the number of travelers, so its time savings are not a benefit measure.</li>
</ul>
${tsTable ? `<p>${tab('time-savings')} gives the split for four of the case studies below.${scns.length ? ` ${tab('road-scenarios')} gives the traffic results of four scenarios run with traffic feedback, one pass from today's crowding, with assignments solved to a relative gap of at most ${fx(gapMax * 1e3, 1)}×10⁻³.` : ''}</p>
${tsTable}` : ''}
${scns.length ? table(
  'road-scenarios',
  'Four scenarios with traffic feedback, against today’s network run the same way (one pass from today’s crowding).',
  ['', ...scns.map((k) => SCN_NAME[k])],
  [
    ['Vehicle miles in the city', ...scns.map((k) => pctd(RS[k].vmt.scenario, RS[k].vmt.base))],
    ['Vehicle hours', ...scns.map((k) => pctd(RS[k].vht.scenario, RS[k].vht.base))],
    ['Morning arterial speed, mph', ...scns.map((k) => `${fx(RS[k].speed.base.arterial.AM, 1)} → ${fx(RS[k].speed.scenario.arterial.AM, 1)}`)],
    ['Transit trips a weekday', ...scns.map((k) => sint(RS[k].transitTrips))],
    ['Trips driving alone', ...scns.map((k) => sint(RS[k].mode.da))],
    ...(RS[scns[0]].trips ?? []).slice(0, 3).map((t, j) => [`${t.name}, ${t.period} (min)`, ...scns.map((k) => { const x = RS[k].trips?.[j]; return x ? `${fx(x.base, 1)} → ${fx(x.scenario, 1)}` : '–'; })]),
    ['Feedback iterations', ...scns.map((k) => String((RS[k].convergence ?? []).length + 1))],
    ['Run time in Node, one thread (s)', ...scns.map((k) => int(RS[k].seconds))],
  ],
  { numeric: scns.map((_, i) => i + 1), notes: 'Runs made with <code>roads-test.ts</code>.' },
) : ''}
`);
}

function portal(): string {
  const m = PORTAL.model, o = PORTAL.official;
  const center = m.transitCenterOnOff, tunnel = m.tunnelRidersPerDay;
  const sameCount = Math.abs(center - tunnel) < 1;
  const perRider = tunnel > 0 ? m.travelerMinutesSavedPerDay / tunnel : NaN;
  const fta = o.ftaCurrentYear2023DailyLinkedTrips;
  const [lo, hi] = o.feisMinutesSavedPerPeninsulaDowntownTrip;
  const vsFta = tunnel / fta - 1, vsFeis = center / o.feis2020TransitCenterOnOff - 1;
  const u = UNC?.summary?.['The Portal'];
  return section('scen-portal', 'The Portal', `
<p>The Portal extends Caltrain 1.3 miles from its Fourth and King terminal, through a new underground station at Fourth and Townsend, to the Salesforce Transit Center downtown. Its sponsors' forecast, made with FTA's STOPS model for the Capital Investment Grants program, is ${int(fta)} daily linked trips on the project in the current year (2023 population, jobs, and network), with four of each hour's six peak trains running through to the Transit Center and two ending at the surface Fourth and King station, and ${int(o.ftaHorizon2045DailyLinkedTrips)} in 2045 ${cite('ftaPortal')}. The 2004 environmental study forecast ${int(o.feis2020TransitCenterOnOff)} weekday boardings and alightings at the Transit Center in 2020, and door-to-door savings of ${lo} to ${hi} minutes for selected Peninsula–downtown trips ${cite('tjpaFeis2004')}.</p>
<p>The scenario extends every Caltrain train through the two new stations and removes the surface Fourth and King stop, unlike the official plan, where two of the six peak trains an hour still end at the surface. Run times of one minute to Fourth and Townsend and three minutes on to the Transit Center were assumed, since none are published. The comparison with the official figures (${tab('portal')}) uses three passes from today's crowding, so the new trains fill as riders find them, against an unchanged run made the same way, with today's population and jobs and today's road speeds. The model carries ${int(tunnel)} riders a weekday between Fourth and Townsend and the Transit Center${sameCount ? '; since every train ends at the Transit Center, this is also its number of boardings and alightings' : `, and ${int(center)} board or alight at the Transit Center`}. Another ${int(m.townsendOnOff)} board or alight at Fourth and Townsend, which takes all the riders of the removed surface stop. The tunnel figure is ${pc(Math.abs(vsFta), 0)} ${vsFta >= 0 ? 'above' : 'below'} FTA's current-year forecast, though FTA counts linked trips that use any part of the project, including trips to and from Fourth and Townsend. The Transit Center figure is ${pc(Math.abs(vsFeis), 0)} ${vsFeis >= 0 ? 'above' : 'below'} the 2004 forecast for 2020, which assumed pre-pandemic ridership.</p>
<p>Caltrain's boardings rise by ${int(m.caltrainBoardingsChange)} and transit trips by ${int(m.transitTripsChange)}${m.transitTripsChange < tunnel / 2 ? ", so most of the Portal's riders were already traveling by transit" : ''}. Travelers' time savings are ${int(m.travelerMinutesSavedPerDay)} minutes a weekday, ${fx(perRider, 1)} minutes per rider through the tunnel. This measure includes changes of destination and mode and is spread over everyone whose choices change, while the environmental study's ${lo} to ${hi} minutes are door-to-door savings on particular trips; their ${perRider >= lo && perRider <= hi ? 'similar size' : 'difference'} says little about either forecast.${u?.transitTrips ? ` Over the parameter draws of ${sec('scen-uncertainty')}, the added transit trips ranged from ${int(u.transitTrips.p10)} to ${int(u.transitTrips.p90)}${u.caltrain ? ` and the added Caltrain boardings from ${int(u.caltrain.p10)} to ${int(u.caltrain.p90)}` : ''} (10th to 90th percentile).` : ''}</p>
${table(
  'portal',
  'The Portal: the model against the official forecasts.',
  ['Measure', 'Model', 'Official forecast', 'Official source and definition'],
  [
    [sameCount ? "Riders between Fourth and Townsend and the Transit Center (equal to the Transit Center's boardings and alightings)" : 'Riders between Fourth and Townsend and the Transit Center', int(tunnel), int(fta), 'FTA, current year (2023): daily linked trips on the project, including Fourth and Townsend'],
    ...(sameCount ? [] : [['Transit Center boardings and alightings', int(center), '–', '']]),
    ['Transit Center boardings and alightings, 2004 forecast', '–', int(o.feis2020TransitCenterOnOff), '2004 FEIS, forecast for 2020; compare the first row'],
    ['Fourth and Townsend boardings and alightings', int(m.townsendOnOff), '–', ''],
    ['Time savings per rider through the tunnel, minutes (logsum)', fx(perRider, 1), `${lo}–${hi}`, '2004 FEIS: door-to-door travel-time savings, selected Peninsula–downtown trips (a different measure)'],
    ['Change in Caltrain boardings', sint(m.caltrainBoardingsChange), '–', ''],
    ['Change in transit trips', sint(m.transitTripsChange), '–', ''],
  ],
  { numeric: [1, 2], wide: true, notes: "Model: every Caltrain train extended and the surface Fourth and King stop removed; three passes from today's crowding. FTA: four of six peak trains an hour in each direction to the Transit Center, the other two to the surface station, from the STOPS model with a 2023 post-pandemic base. The 2004 forecast assumed pre-pandemic ridership and a 2020 horizon. Time savings: the change in travelers' total logsum, in in-vehicle minutes, divided by the riders through the tunnel." },
)}
${portalRoads()}
`);
}

/** the Portal in a Precise run with the Peninsula freeways (peninsula-runs.json) */
function portalRoads(): string {
  const a = run('portal'), b = PR?.before?.runs.portal;
  if (!a || !b || !PV) return '';
  const ct = (r: PenRun) => r.caltrain.scenario - r.caltrain.control;
  const atLine = (r: PenRun, route: string) => (r.segments ?? []).filter((x) => x.route === route && (x.from === 'the county line' || x.to === 'the county line')).reduce((s, x) => s + Object.values(x.dVeh).reduce((t, v) => t + v, 0), 0);
  const lineCount = (route: string) => PV.volumes.filter((v) => v.route === route && (v.from === 'the county line' || v.to === 'the county line')).reduce((s, v) => s + v.count, 0);
  const best = (a.segments ?? []).flatMap((x) => (['AM', 'PM'] as const).map((p) => ({ x, p, d: x.mph[p] - x.mphControl[p] }))).sort((p, q) => q.d - p.d)[0];
  const PNAME: Record<string, string> = { AM: 'morning', PM: 'evening' };
  const fewer = (route: string) => -atLine(a, route);
  return `<p>As the application runs it, in one pass from today's crowding, the Portal gives ${ct(a) < (PORTAL.model.caltrainBoardingsChange) ? 'smaller' : 'larger'} changes than with three passes. In a Precise run, Caltrain gains ${int(ct(a))} boardings a weekday (${int(ct(b))} with the Peninsula freeways held at today's speeds), and transit trips rise by ${int(a.transitTrips)}. The model's own cars on the freeways' first segment out of the city ${fewer('US-101') >= 0 ? 'fall' : 'rise'} by ${int(Math.abs(fewer('US-101')))} a day on US-101 and ${int(Math.abs(fewer('I-280')))} on I-280, both directions together, ${pc(Math.abs(fewer('US-101')) / lineCount('US-101'), 1)} and ${pc(Math.abs(fewer('I-280')) / lineCount('I-280'), 1)} of their counted traffic there.${best ? ` Freeway speeds rise by at most ${fx(best.d, 2)} mph (${best.x.route} ${best.x.dir === 'N' ? 'northbound' : 'southbound'} from ${best.x.from} to ${best.x.to}, in the ${PNAME[best.p]} peak).` : ''} Spread over everyone on the freeways, that is ${int(part('portal', 'peninsula'))} hours a weekday for their other drivers, ${pc(part('portal', 'peninsula') / part('portal', 'total'), 0)} of the Portal's time savings in this run (${tab('time-savings')}).</p>`;
}

function fare(): string {
  const r = RS.free, a = run('free'), q = RM?.scenarios.free;
  if (!r && !a) return section('scen-fare', 'Fare-free Muni', '<p>No run of fare-free Muni has been recorded.</p>');
  const tr = part('free', 'transit'), tot = part('free', 'total');
  return section('scen-fare', 'Fare-free Muni', `
<p>Making Muni free changes only fares, so the streets respond only through the trips that leave cars.${a ? ` In a Precise run, transit trips rise by ${int(a.transitTrips)} a weekday${a.trips ? `; by mode, ${modeLine(a.trips)}` : ''}.` : ''}${r ? ` With traffic feedback, the city's streets carry ${pctd(r.vmt.scenario, r.vmt.base, 2).replace('−', '')} ${r.vmt.scenario < r.vmt.base ? 'fewer' : 'more'} vehicle miles and morning arterial speeds go from ${fx(r.speed.base.arterial.AM, 1)} to ${fx(r.speed.scenario.arterial.AM, 1)} mph (${tab('road-scenarios')}).` : ''}${a ? ` Transit riders gain ${int(tr)} hours a weekday, ${pc(tr / tot, 0)} of all travelers' time savings; drivers and ride-hail gain ${int(part('free', 'drivers'))} hours from the cars taken off the road, and the Peninsula freeways' other drivers ${int(part('free', 'peninsula'))} (${tab('time-savings')}).` : ''}${q ? ` Quick, which leaves out the drivers' gain, gives transit trips within ${fx(Math.abs(q.transitTrips.errPct ?? 0), 1)}% of Precise's (${tab('runmodes')}).` : ''} The fare elasticity behind these numbers is tested against published ranges in ${sec('val-sensitivity')}; a change this large is far outside the observed fare changes those ranges come from.</p>
`);
}

function charge(): string {
  const c = RS.cordon, p = RS.parking, a = run('cordon');
  if (!c && !a) return section('scen-charge', 'A downtown charge and dearer parking', '<p>No run of a downtown charge has been recorded.</p>');
  const ent = c?.entering ? Object.fromEntries(c.entering.map((r) => [r.p, r])) : null;
  const drop = (x: { base: number; scn: number }) => pc(1 - x.scn / x.base, 0);
  const day = (x: { base: number; scn: number }[]) => [x.reduce((s, r) => s + r.base, 0), x.reduce((s, r) => s + r.scn, 0)];
  return section('scen-charge', 'A downtown charge and dearer parking', `
<p>The charge is $8 for each car entering Downtown and SoMa in the morning and evening peaks, in the zone of SFCTA's Downtown Congestion Pricing Study, whose options charged up to $12.50 by income and aimed at 15% fewer peak car trips downtown ${cite('sfctaPricing')}.${ent?.AM && ent.PM ? ` With traffic feedback, the cars entering the zone fall by ${drop(ent.AM)} in the morning peak and ${drop(ent.PM)} in the evening; over the day ${(() => { const [b, s] = day(c!.entering!); return `${int(b)} entries become ${int(s)}`; })()}. By mode, ${modeLine(c!.mode)} trips a weekday (${tab('road-scenarios')}).` : ''}${a ? ` In the Precise run, drivers and ride-hail lose ${int(Math.abs(part('cordon', 'drivers')))} hours a weekday, since the logsum counts the charge as time lost by those who pay it and by those who change their trips to avoid it${part('cordon', 'drivers') < 0 ? ', and the faster streets do not make up for it' : ''}. The Peninsula freeways' other drivers ${part('cordon', 'peninsula') >= 0 ? 'gain' : 'lose'} ${int(Math.abs(part('cordon', 'peninsula')))} hours as the city's cars leave them (${tab('time-savings')}). The charge's revenue is not counted as a gain to anyone.` : ''}</p>
${p ? `<p>Raising parking charges in the same zone by $4 an hour, with the streets responding, takes ${int(Math.abs(p.mode.da))} trips a weekday out of cars driven alone and adds ${int(p.transitTrips)} transit trips; the city's vehicle miles change by ${pctd(p.vmt.scenario, p.vmt.base)} and vehicle hours by ${pctd(p.vht.scenario, p.vht.base)} (${tab('road-scenarios')}). Ride-hail ${p.mode.tnc >= 0 ? 'gains' : 'loses'} ${int(Math.abs(p.mode.tnc))} trips, since it pays no parking. Because the model has no parking supply (${sec('roads')}), the charge acts only through its price, not through the search for a space.</p>` : ''}
`);
}

function busLanes(): string {
  const r = RS.buslane, q = RM?.scenarios.bus19;
  if (!r && !q) return section('scen-buslanes', 'Bus lanes on 19th Avenue', '<p>No run of bus lanes on 19th Avenue has been recorded.</p>');
  return section('scen-buslanes', 'Bus lanes on 19th Avenue', `
<p>The scenario gives one lane each way on 19th Avenue between Lincoln Way and Sloat Boulevard to buses.${r ? ` With traffic feedback, cars move from 19th Avenue to parallel streets; the largest changes in cars a day are ${list(r.changes.slice(0, 3).map((c) => `${c.name} ${int(c.base)} to ${int(c.scenario)}`))}. The 28 and 28R run in their own lane there${r.bus?.length ? `, and their end-to-end times in the morning peak go from ${list(r.bus.slice(0, 2).map((b) => `${fx(b.base, 1)} to ${fx(b.scenario, 1)} minutes (${b.route})`))}` : ''}. By mode, ${modeLine(r.mode, 10)} trips a weekday (${tab('road-scenarios')}).` : ''}${q ? ` In the Precise run, transit riders gain ${int(q.timeSavingsH.transit.precise)} hours a weekday and drivers and ride-hail ${q.timeSavingsH.drivers.precise >= 0 ? 'gain' : 'lose'} ${int(Math.abs(q.timeSavingsH.drivers.precise))}, so all travelers ${q.timeSavingsH.total.precise >= 0 ? 'gain' : 'lose'} ${int(Math.abs(q.timeSavingsH.total.precise))} (${tab('time-savings')}). The changes are small, and Quick's approximate road response misses them by the most of any test scenario: ${sint(q.transitTrips.quick)} transit trips against Precise's ${sint(q.transitTrips.precise)} (${tab('runmodes')}).` : ''} The model has no reliability gain from a bus lane (the measured wait factors stay fixed in a scenario), so the benefit to riders is the running time alone.</p>
`);
}

/** the change in daily transit trips over runs with drawn parameters (uncertainty.ts) */
function uncertainty(): string {
  const unc = UNC ? Object.entries(UNC.summary).filter(([, v]) => v.transitTrips) : [];
  if (!unc.length) return section('scen-uncertainty', 'Parameter uncertainty', '<p>The runs with drawn parameters have not been made for this bundle.</p>');
  const xd = (UNC!.parameterDraws ?? []).slice(1).map((d) => d.xfer).filter((v) => Number.isFinite(v));
  const xferRange = xd.length ? `from ${fx(Math.min(...xd), 0)} to ${fx(Math.max(...xd), 0)} minutes` : 'from half to one and a half times its calibrated value';
  const wid = unc.map(([k, v]) => [k, (v.transitTrips.p90 - v.transitTrips.p10) / Math.abs(v.transitTrips.calibrated || 1)] as const).sort((a, b) => b[1] - a[1]);
  return section('scen-uncertainty', 'Parameter uncertainty', `
<p>The transferred and assumed parameters carry uncertainty that the validation does not show. The model was run ${nw(UNC!.draws)} times, once as calibrated and otherwise with the in-vehicle time coefficients scaled by 0.8 to 1.2, the wait and walk weights from 1.5 to 2.5, the transfer penalty ${xferRange}, the destination logsum coefficient from 0.5 to 1.0, the access spread θ from 0.15 to 0.5 per minute, and the crowding weights scaled by 0.8 to 1.2, each drawn uniformly, with the calibrated constants held fixed. ${tab('uncertainty')} gives the change in daily transit trips in four example scenarios as calibrated and at the 10th and 90th percentiles of these runs. The range is widest, relative to the calibrated change, for ${UNC_NAME[wid[0][0]] ?? wid[0][0]} and narrowest for ${UNC_NAME[wid[wid.length - 1][0]] ?? wid[wid.length - 1][0]}. Because the constants were not refitted for each draw, these ranges describe the sensitivity of the results to the parameters rather than a calibrated distribution, and the separate effect of θ was not isolated.</p>
${table('uncertainty', 'Change in daily transit trips in four example scenarios, as calibrated and across runs with drawn parameters.', ['Scenario', 'As calibrated', '10th percentile', '90th percentile'], unc.map(([k, v]) => [cap(UNC_NAME[k] ?? k), sint(v.transitTrips.calibrated), sint(v.transitTrips.p10), sint(v.transitTrips.p90)]), { numeric: [1, 2, 3], notes: `${cap(nw(UNC!.draws))} runs, the first with the parameters as calibrated (<code>server/beta3/pipeline/uncertainty.ts</code>). Calibrated constants are held fixed in every run.` })}
`);
}
