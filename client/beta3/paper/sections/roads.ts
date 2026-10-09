/** Roads and the Peninsula freeways (inside the model section), from server/beta3/reference/road-validation.json, gateway-markets.json, and peninsula-traffic.json. */
import RV from '../../../../server/beta3/reference/road-validation.json';
import { CAP_FACTOR, ROUTE_VOT } from '../../../../shared/beta3/roads';
import { DEADHEAD_SHARE } from '../../../../shared/beta3/traffic';
import { F, REF } from '../data';
import { cite, fx, int, list, math, nw, pc, sec, section, tab, table } from '../doc';

type Stat = { n: number; ratio: number | null; r: number | null; pctRmse: number | null; within25: number | null };
interface Gate { name: string; count: number; trucks: number; through: number; model: number; left?: number }
/** the city line by market (gateways.ts) */
const GM = (Object.values(import.meta.glob('../../../../server/beta3/reference/gateway-markets.json', { eager: true, import: 'default' }))[0] ?? null) as { model: { today: { gateways: Gate[] } } } | null;
/** today's run with traffic feedback on, which must reproduce the baseline (roads-test.ts) */
const RS = (Object.values(import.meta.glob('../../../../server/beta3/reference/road-scenarios.json', { eager: true, import: 'default' }))[0] ?? {}) as Record<string, { mode: Record<string, number> }>;

/** observed traffic on the Peninsula freeways (peninsula-data.ts) */
interface PenTraffic {
  periodShare: Record<string, number>;
  southShare: Record<string, number>;
  vtaGateway2024: Record<'AM' | 'PM', { intoSantaClara: number; outOf: number }>;
}
const PT = (Object.values(import.meta.glob('../../../../server/beta3/reference/peninsula-traffic.json', { eager: true, import: 'default' }))[0] ?? null) as PenTraffic | null;
const PRUN = (Object.values(import.meta.glob('../../../../server/beta3/reference/peninsula-runs.json', { eager: true, import: 'default' }))[0] ?? null) as { aonSeconds?: Record<string, number> } | null;
interface PenVal {
  volumes: { capFactor: number }[];
  speeds: { route: string; dir: string; from: string; to: string; p: 'AM' | 'PM'; obs: number; model: number }[];
  worstVolumeError: number;
  worstDirectionError: number;
  clippedPairs: number;
  pairs: number;
  modelShare: number;
}

const st = (s: Stat) => [s.n, s.ratio === null ? '–' : fx(s.ratio, 2), s.r === null ? '–' : fx(s.r, 2), s.pctRmse === null ? '–' : `${fx(s.pctRmse, 0)}%`, s.within25 === null ? '–' : pc(s.within25)];
/** OpenStreetMap's route names at the gateways, as the text names them */
const roadName = (s: string) => s.replace(/^I (\d+)/, 'I-$1').replace(/^US (\d+)/, 'US-$1').replace(/^CA (\d+)/, 'SR-$1');
const range = (xs: number[], d = 2) => (xs.length ? `${fx(Math.min(...xs), d)} to ${fx(Math.max(...xs), d)}` : '–');

export function roads(): string {
  const N = RV.network;
  const V = RV as unknown as {
    bySource: Record<string, Stat>;
    byClass: Record<string, Stat>;
    byVolumeGroup: (Stat & { group: string; acceptable: number; preferable: number })[];
    all: Stat;
    cmp: Record<string, Stat>;
    inrix: Record<string, Stat>;
    inrixByAreaType?: Record<string, Stat>;
    summary: { speed: Record<string, Record<string, number>>; vmt: Record<string, number> };
    base: { gap: Record<string, number>; background: Record<string, number> };
  };
  const FF = N.freeFlow as unknown as { signalDelayByAreaType: number[]; cruiseByAreaType: number[]; freewayShareOfLimit: number };
  const hp = REF.autoSpeeds.hourlyProfile.byModelPeriod;
  const sum = V.summary.speed;
  const P = ['AM', 'MD', 'PM', 'NT'] as const;
  const PI: Record<string, 'AM' | 'MD' | 'PM' | 'EV'> = { AM: 'AM', MD: 'MD', PM: 'PM', NT: 'EV' };
  const bg = V.base.background;
  const ix = Object.entries(bg).filter(([k]) => k.startsWith('ix:'));
  const vmt = P.reduce((a, p) => a + V.summary.vmt[p], 0);
  const surface = N.gateways.filter((g) => g.kind === 'surface').length;
  const groups = V.byVolumeGroup.filter((g) => g.n > 0);
  const today = RS.today;
  // Marin: the assumed regional speed and the Golden Gate's assumed queue (skims.ts, through facts.json)
  const regional = (F.auto as unknown as { regionalSpeedKmh?: Record<string, number> }).regionalSpeedKmh;
  const gg = (F.gateways as unknown as { name: string; delayIn: Record<string, number>; delayOut: Record<string, number> }[]).find((g) => /Golden Gate/.test(g.name));
  // arterial speeds against INRIX, by period and by area type
  const artP = P.map((p) => V.inrix[`arterial ${p}`]).filter((s): s is Stat => !!s && s.ratio !== null);
  const artAT = Object.values(V.inrixByAreaType ?? {}).filter((s) => s.ratio !== null);
  const artN = Math.max(0, ...artP.map((s) => s.n));
  const mdFast = sum.freeway.MD / hp.freeway.MD - 1;

  const gate = (() => {
    if (!GM) return '';
    const g = (n: string) => GM.model.today.gateways.find((x) => x.name === n);
    const left = (x: Gate) => x.left ?? x.count - x.trucks - x.through - x.model;
    const f = (n: string) => { const x = g(n); return x ? pc(x.model / (x.count - x.trucks - x.through)) : '–'; };
    const gap = (ns: string[]) => ns.reduce((a, n) => { const x = g(n); return a + (x ? left(x) : 0); }, 0);
    const k = (v: number) => int(Math.round(v / 1000) * 1000);
    return ` The model's own cars, each on its least-cost path, fill ${f('Bay Bridge')} of the Bay Bridge's count less trucks ${cite('caltransAadt')} and through trips, ${f('Golden Gate')} of the Golden Gate Bridge's, ${f('US-101')} of US-101's at the county line, and ${f('I-280')} of I-280's. They are about ${k(gap(['Golden Gate']))} cars a day short at the Golden Gate and ${k(gap(['US-101', 'I-280', 'SR-35', 'SR-82']))} short at the county line, and the background fills the gap. No published source splits these counts by market (BATS 2023 publishes no county-to-county table), and light commercial vehicles, which no count separates, are among the missing cars. Fitting regional visitors by corridor to the counts was tested and not adopted: it matched the cars but put too many riders on BART into the city and too few on Muni's counted routes.`;
  })();

  return section('roads', 'Roads and the Peninsula freeways', `
<p>On weekdays every run assigns cars to the streets, so driving times, ride-hail times, and the running times of buses in mixed traffic respond to demand, as in the static assignments of TM1 and SF-CHAMP ${cite('tm1Hwy', 'sfchampDocs')}. The network is OpenStreetMap's drivable streets in the city, without service roads and alleys ${cite('osm')}, with the blocks between junctions joined into links: ${int(N.nodes)} nodes and ${int(N.links)} links, ${int(N.streetLinks)} of them streets (${int(N.streetMiles)} miles, each direction counted) and the rest connectors. Each zone connects at 20 km/h to up to three junctions nearest its census blocks, weighted by population. Outside zones join the city at ${nw(N.gateways.length)} gateways where its roads leave the mapped area: the two bridges, US-101, I-280, and ${nw(surface)} surface roads across the San Mateo County line. An outside zone's leg to a gateway runs on the Bay Area's freeways and trunk roads from OpenStreetMap, with the city and its two bridges cut out: 1.3 times the straight line at 30 km/h for the first 6 km, then at the fixed skims' regional speed for the period, with the region's other toll bridges charged and each bridge's queue and toll on its own gateway. Where freeway speeds are published (INRIX's peak speeds on the Peninsula and in the East Bay), the leg runs at them with no queue of its own, as in the fixed skims (${sec('zones')}), so the assignment routes outside traffic as demand times it.${regional && gg ? ` Marin's latest published freeway speeds are from September 2020, during the pandemic, so legs across the Golden Gate run at the assumed regional speeds (${list(Object.entries(regional).map(([p, v]) => `${p} ${v} km/h`))}) with the bridge's assumed queue (${gg.delayIn.AM} minutes inbound in the morning peak and ${gg.delayOut.PM} outbound in the evening).` : ''} A zone connects to every gateway within 20 minutes of its best; a zone within 8 km of a surface gateway may also reach it in a straight line at three-quarters of the regional speed. Zones to the south reach the city along US-101 and I-280, which are links of the network as far as San Jose (below).</p>
<p>A block's free-flow time is its length at 85% of the speed limit plus the control at its far end: the traffic signals and stop signs mapped in OpenStreetMap, and an all-way stop where two local streets or collectors cross and nothing is mapped. The signal delay and the cruising speed were fitted by TM1 area type to the 3–6 a.m. speeds of SFCTA's monitored arterial segments in its hourly INRIX data ${cite('sfctaCmp')}: ${list(FF.signalDelayByAreaType.map((d, i) => `${fx(d, 1)} s a signal in area type ${i}`))}, with the outer arterials cruising at ${pc(FF.cruiseByAreaType[3])} of the limit and the rest at 85%. Freeways run at ${pc(FF.freewayShareOfLimit)} of the limit, capped at 62 mph. Stop delays were scaled so that local streets run at 80% of the arterials' speed, the ratio the fixed skims assume. Capacity is a link's general-purpose lanes (OpenStreetMap's lane count less its bus lanes) times TM1's capacity per lane-hour for the facility and area type: freeways 2,050 to 2,100 vehicles, ramps 1,450 to 1,550, arterials 900 to 1,000, and collectors and local streets 600 to 700 ${cite('tm1Hwy')}. A period's capacity is that times TM2's period factor (${list(P.map((p) => `${p} ${CAP_FACTOR[p]}`))}) ${cite('tm2py')}. A link under 150 m is never narrower than the road on both sides of it, which corrects slips in OpenStreetMap's lane tags. The volume-delay functions are TM1's: on freeways ${math('t = t_0\\,(1 + 0.20\\,((V/C)/0.75)^6)')}, and elsewhere Akçelik's function ${cite('akcelik1991')} with its parameter set as TM1 sets it, so that a link at capacity runs at TM1's critical speed for its facility and area type, taken as a ratio of the link's own free-flow speed. Signals also add the growth of the Highway Capacity Manual's uniform signal delay with the volume-to-capacity ratio, for a 70 s cycle with half of it green.</p>
<p>Each period's vehicles are the model's drivers, carpools (riders divided by occupancy), and ride-hail cars, every leg in the periods its purpose travels in, including the legs through stops and work-based subtours. Ride-hail's empty driving runs from each drop-off to the period's pick-ups by a gravity model whose distance decay makes the empty miles ${pc(DEADHEAD_SHARE)} of the passenger miles (SFCTA put out-of-service miles at 20% in 2016 ${cite('sfctaTncs')}, Fehr &amp; Peers at about 40% ${cite('fehrPeers2019')}). Commercial vehicles follow SF-CHAMP's commercial vehicle model: 0.363 trips per household and 0.45 to 0.98 per job by land use, distributed by a gravity model on midday driving times with the Quick Response Freight Manual's four-tire friction, exp(−0.08 min), and spread over the day by SF-CHAMP's truck factors ${cite('sfchampDocs', 'qrfm1996')}, ${int(N.commercial.trips)} trips a weekday. The rest is background traffic at the city line. At the gateways with a Caltrans count ${cite('caltransAadt')} (US-101 and I-280 at the county line, SR-35, SR-82, the Golden Gate Bridge, and the Bay Bridge; weekday traffic taken as 5% above the annual average), through trips cross the city in the shares the ACS county-to-county commuting flows give, 17.2% of the Golden Gate Bridge's traffic and 6.8% of the Bay Bridge's, and leave by US-101 and I-280 (${int(bg.through ?? 0)} trips) ${cite('acs')}. The rest of each count, less the model's own traffic there, is trips into and out of the city spread like the model's own trips through that gateway (${list(ix.map(([k, v]) => `${roadName(k.slice(3))} ${int(v)}`))}), with the time-of-day and direction profile of the model's own traffic at the gateway. SF-CHAMP likewise scales its truck and commercial demand to its Bay Bridge, Golden Gate, and San Mateo County screenlines ${cite('sfchampDocs')}. These counts are therefore not tests.${gate}</p>
<p>Parking charges are TM1's by area type (${sec('mode')}); the model has no parking supply or search for a space. A scenario's charges enter the commercial vehicles' gravity model as SF-CHAMP's commercial toll choice prices them, at a commercial value of time of $30 an hour in 2000 dollars spread over two entries a day for area pricing ${cite('sfchampDocs')}. A car leg's period shares move with the change in its cost in each period by an incremental logit with mode choice's cost coefficient, the sensitivity UK guidance gives for choice between periods of about three hours ${cite('tagM21')}.</p>
<p>Each period is solved for user equilibrium by bi-conjugate Frank–Wolfe ${cite('mitradjieva2013')}, with routes minimizing time plus tolls and running cost at TM1's assignment value of time, $15 an hour in 2000 dollars (${'$'}${ROUTE_VOT} in 2025) ${cite('tm1Hwy')}. Today's traffic is solved to a relative gap of ${fx(Math.max(...P.map((p) => V.base.gap[p])) * 1e4, 1)}×10⁻⁴ (TM1 asks for 5×10⁻⁴ in the peaks), and a scenario's assignments to the same gap in the Precise run mode (${sec('runmodes')}), since an assignment stopped early overstates the change in driving times. Demand and assignment then alternate until fewer than 0.5% of the car trips move from one iteration to the next, or for at most five assignments, with link volumes averaged over the iterations by the method of successive averages, as TM1 averages its assignments. A scenario starts from today's equilibrium and today's trips, with the change in trips loaded on today's paths, so its first demand already sees its streets and charges at today's volumes.</p>
<p>Congested times enter the rest of the model as a pivot on today's. A scenario's driving time between two zones, for driving alone, carpooling, and ride-hail (whose fare depends on the time too), is today's fitted time plus the change the assignment finds, and a charge such as a cordon toll is added as the toll on the least-cost path. The change is summed link by link along today's least-cost route, which to first order is the change in the least-cost time. Taking the scenario's least-cost time less today's instead would pick the least of a set of route times that an assignment stopped at a finite gap leaves a little high on some routes and a little low on others; that choice is biased low, so the remaining gap would show as time saved. Where today's route crosses a street the scenario changes, rerouting is a first-order effect, and the change is the scenario's least-cost time less today's. Buses and streetcars in mixed traffic gain the change in congested time on the links each hop runs along, as SF-CHAMP builds bus times from congested road times ${cite('sfchampDocs')}. A link with a bus lane today passes on none of the change, and where a scenario gives a lane to buses or closes a street to cars, buses lose today's congestion delay there from the run's first transit path search. After the feedback, transit paths are found again with the traffic's change, demand chooses once more, and its cars are assigned. The calibration and today's results are those of the model without feedback, and a scenario that changes nothing reproduces them${today ? ` (in a test, the largest change in daily trips by any mode was ${fx(Math.max(...Object.values(today.mode).map(Math.abs)), 0)})` : ''}.</p>
${table(
  'roads',
  'Today’s traffic against counts and speeds. Counts at the city line fitted the background and are left out. Daily volumes; Caltrans counts are both directions, SFMTA counts one.',
  ['Comparison', 'n', 'Model ÷ count', 'r', '%RMSE', 'Within ±25%'],
  [
    [`Caltrans 2023 AADT, state highways in the city ${cite('caltransAadt')}`, ...st(V.bySource.caltrans)],
    [`SFMTA weekday counts, 2021–2023 ${cite('sfmtaCounts')}`, ...st(V.bySource.sfmta)],
    ...Object.entries(V.byClass).map(([c, s]) => [`  by class: ${c}`, ...st(s)]),
    ['All counts', ...st(V.all)],
    ...groups.map((g) => [`  daily volume ${g.group} (FSUTMS ${g.acceptable}% acceptable, ${g.preferable}% preferable)`, ...st(g)]),
    ...Object.entries(V.cmp).map(([k, s]) => [`CMP 2025 segment speed, ${k} (2-hour peak)`, ...st(s)]),
    ...Object.entries(V.inrix).map(([k, s]) => [`INRIX segment speed, ${k} (model period)`, ...st(s)]),
  ],
  { numeric: [1, 2, 3, 4, 5], notes: `%RMSE targets by volume are Florida's (FSUTMS 2008) ${cite('fsutms2008')}; CTC asks for r ≥ 0.88 and %RMSE below 40% ${cite('ctc2017')}. TM1 reported a daily %RMSE of 29% overall, 21% on freeways, 67% on arterials, and 132% on collectors ${cite('tm1Report')}.` },
)}
<p>${tab('roads')} compares today's traffic with counts and speeds. The highways are where the counts are densest and the comparison fairest. On the ${nw(V.bySource.caltrans.n)} Caltrans points inside the city the model carries ${pc(V.bySource.caltrans.ratio ?? 0)} of the counted traffic, with a %RMSE of ${fx(V.bySource.caltrans.pctRmse ?? 0, 0)}% (freeways ${fx(V.byClass.freeway?.pctRmse ?? 0, 0)}%, arterials on the state routes ${fx(V.byClass.arterial?.pctRmse ?? 0, 0)}%), close to TM1's own figures. That %RMSE is ${(V.bySource.caltrans.pctRmse ?? 0) < 40 ? 'within' : 'outside'} the CTC's limit, and the correlation (r ${fx(V.bySource.caltrans.r ?? 0, 2)}) ${(V.bySource.caltrans.r ?? 0) >= 0.88 ? 'meets' : 'misses'} its guideline. SFMTA's counts are mostly residential blocks counted for traffic calming, under 5,000 vehicles a day, which a model of ${int(N.zones)} zones loads only roughly through its connectors: their %RMSE is ${fx(V.bySource.sfmta.pctRmse ?? 0, 0)}%, against Florida's 100% for that volume group and TM1's 132% on collectors. Against SFCTA's INRIX means for the same periods, freeways run at ${list(P.map((p) => `${fx(sum.freeway[p], 1)} mph ${p} (INRIX ${hp.freeway[PI[p]]})`))}, and arterials at ${list(P.map((p) => `${fx(sum.arterial[p], 1)} (${hp.arterial[PI[p]]})`))}.${artP.length ? ` On the ${int(artN)} monitored arterial segments, the model's speeds average ${range(artP.map((s) => s.ratio!))} times INRIX's by period${artAT.length ? ` and ${range(artAT.map((s) => s.ratio!))} times by area type and peak` : ''}, with a correlation of ${range(artP.map((s) => s.r ?? 0))} segment by segment.` : ''} Midday freeways run ${pc(Math.abs(mdFast))} too ${mdFast >= 0 ? 'fast' : 'slow'}. Their congestion comes from queues at the Bay Bridge's metered approach and the US-101/I-80 interchange that last through the middle of the day, which a static assignment cannot carry from one period to the next. No sourced remedy was found (TM2's midday capacity factor is simply the period's five hours), and a lower midday capacity fitted to these speeds would be calibration rather than a test, so the bias is left in place. The city's streets carry ${fx(vmt / 1e6, 2)} million vehicle miles a weekday in the model.</p>
${peninsula()}
<p>An all-or-nothing loading of all ${int(N.centroids)} centroids takes about ${PRUN?.aonSeconds?.with ? fx(PRUN.aonSeconds.with, 1) : '0.6'} s in Node on one thread (most outside zones share one tree per gateway); a scenario's assignments take a dozen loadings when nothing changes and a few hundred for a congestion charge. In a browser the loadings are split over the page's workers by origin, as the transit path searches are; run times are in ${sec('runmodes')}. The limits are those of static assignment. Queues do not carry from one period to the next, so midday freeways run too freely, and a segment near capacity responds to its own volume along a steep curve where a real bottleneck meters traffic, so the assignment overstates what a small change in demand does at bottlenecks. The background at the city line and on the Peninsula freeways is fixed, though through trips reroute. Time of day moves only between the four periods, not within them. Weekends keep fixed speeds (${sec('weekend-model')}).</p>
`);
}

/** the Peninsula freeways (roads.ts, roads-base.ts, traffic.ts), from road-validation.json and peninsula-traffic.json */
function peninsula(): string {
  const PV = (RV as unknown as { peninsula?: PenVal }).peninsula;
  if (!PV || !PT) return '';
  const nLinks = (RV.network as unknown as { peninsulaLinks?: number }).peninsulaLinks ?? 0;
  const caps = [...new Set(PV.volumes.map((v) => v.capFactor))].sort((a, b) => a - b);
  const sp = PV.speeds;
  const g = PT.vtaGateway2024;
  const segName = (r: { route: string; dir: string; from: string; to: string }) => `${r.route} ${r.dir === 'N' ? 'north' : 'south'}, ${r.from} to ${r.to}`;
  const rows = [...new Set(sp.map((r) => segName(r)))].map((n) => {
    const am = sp.find((r) => segName(r) === n && r.p === 'AM'),
      pm = sp.find((r) => segName(r) === n && r.p === 'PM');
    return [n, am ? fx(am.obs, 0) : '–', am ? fx(am.model, 1) : '–', pm ? fx(pm.obs, 0) : '–', pm ? fx(pm.model, 1) : '–'];
  });
  const worst = Math.max(...sp.map((r) => Math.abs(r.model - r.obs)));
  return `<p>Beyond the city line the road network continues along US-101 from the county line to its interchange with I-280 and I-680 in San Jose, and along I-280 to its end at US-101. Each direction follows OpenStreetMap's carriageway and is cut at its main interchanges into ${int(nLinks)} links: in San Mateo County at the ends of the segments C/CAG monitors, with a few more cuts where its segments are long, and in Santa Clara County at the junctions with SR-85, SR-237, SR-87, I-880, and SR-17. SR-92, SR-85, and the other routes are not modeled; traffic enters and leaves the freeways at the cuts. Each outside zone to the south connects to the interchanges where its leg plus the drive on to the county line is within five minutes of its best, at most two on each freeway, with its leg measured on the regional network without the two freeways; a zone next to the city line keeps its own leg to the gateway where that is as quick. Capacity is OpenStreetMap's lanes at TM1's 2,100 vehicles a lane-hour. The express lanes on US-101 and the HOV lanes in Santa Clara County count as general-purpose lanes, with no toll or occupancy rule, because the counts include their traffic and INRIX's speeds do not separate it ${cite('ccagCmp2025')}. Free flow is C/CAG's 65 mph, or INRIX's peak speed on the segment where that is higher, and the volume-delay function is the city's freeway curve.</p>
<p>Each segment carries a fixed background by period and direction, the traffic with no end in the city. It starts from the segment's 2023 Caltrans AADT ${cite('caltransAadt')}, raised 5% for a weekday and spread over the periods as the one continuous count FHWA publishes on these freeways (I-280 a mile south of Cañada Road) spreads its weekday traffic: ${list(['AM', 'MD', 'PM', 'NT'].map((p) => `${p} ${pc(PT.periodShare[p], 1)}`))} (April 2024, Tuesdays to Thursdays) ${cite('fhwaTmas')}. The peaks are split by direction as VTA's 2024 gateway counts at the county line split them (${pc(PT.southShare.AM, 1)} southbound in the morning and ${pc(1 - PT.southShare.PM, 1)} northbound in the evening, of ${int(g.AM.intoSantaClara + g.AM.outOf)} and ${int(g.PM.intoSantaClara + g.PM.outOf)} vehicles in three hours) ${cite('vtaCmp2024')}, midday evenly, and night so that each direction carries half the day. The background is that count less the model's own cars in the base, never below zero; where the model alone exceeds one direction's count, the other direction takes up the difference. The model's cars are ${pc(PV.modelShare, 1)} of the freeways' traffic, and with the background every segment carries its count in each period ${PV.worstVolumeError < 5e-4 ? 'exactly' : `to within ${fx(100 * PV.worstVolumeError, 1)}%`}, both directions together, and so does each direction where both have a background${PV.worstDirectionError < 5e-4 ? '' : ` (to within ${fx(100 * PV.worstDirectionError, 1)}%)`}; ${PV.clippedPairs ? `in ${nw(PV.clippedPairs)} of ${int(PV.pairs)} segment-periods the model alone exceeds one direction's count` : `in none of the ${int(PV.pairs)} segment-periods does the model alone exceed one direction's count`}. Each monitored segment's capacity was then scaled in each peak so that its speed at the counted volume is INRIX's average for 7–9 a.m. or 4–6 p.m. in April and May 2025 (C/CAG's Table 25) ${cite('ccagCmp2025')}, with midday and night taking the geometric mean of the two factors. Each peak has its own factor because the periods' volumes come from one count station's profile, and the factor takes up what that profile misses on each segment. The factors run from ${fx(caps[0], 2)} to ${fx(caps[caps.length - 1], 2)}; the Santa Clara segments, which have no published segment speeds, take the median in each peak. The model's speeds then match INRIX's to within ${fx(worst, 1)} mph on every monitored segment in both peaks (${tab('peninsula')}), though its four-hour periods stand in for INRIX's two-hour peaks.</p>
${table(
  'peninsula',
  'The Peninsula freeways today: INRIX average speeds in the two-hour peaks (C/CAG 2025) and the model’s speeds in its four-hour periods, mph, on each monitored segment.',
  ['Segment', 'INRIX AM', 'Model AM', 'INRIX PM', 'Model PM'],
  rows,
  { numeric: [1, 2, 3, 4] },
)}
<p>The freeways respond only in a Precise run; a Quick run holds them at today's speeds (${sec('runmodes')}). In a Precise run, a change in the city's car trips on the freeways changes their speeds. The change enters the driving times of the city's own trips, summed along today's routes as on the streets, and the time of the freeways' other drivers, a part of the time savings of its own (${sec('scen-method')}). The background does not respond: the Peninsula's own trips do not change route, time, or mode when the freeways speed up or slow down, so no traffic fills the room a scenario makes there.</p>`;
}
