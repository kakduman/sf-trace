/**
 * Shared bikes and scooters in the article: the model (Section "micromobility"), a paragraph and a target
 * row for the calibration, and the checks for the validation. Numbers come from
 * shared/beta3/micromobility.ts (parameters), server/beta3/reference/bay-wheels-sf.json (the counts,
 * bikeshare.ts), and client/beta3/model/micromobility.json (the calibrated run, micromob-validate.ts).
 */
import { MICRO } from '../../../../shared/beta3/micromobility';
import { NEST } from '../../../../shared/beta3/params';
import { MM, REF } from '../data';
import { cite, dataTable, fx, int, math, money, pc, sec, section, spc } from '../doc';

const BW = REF.bayWheels;
const W = BW.weekday;
const sfmta = BW.sfmtaCounts;
const tripsOf = (re: RegExp) => Object.entries(sfmta.trips as Record<string, number>).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
const scooterYear = tripsOf(/^Powered Scooter/), limeYear = tripsOf(/Scooter \| Lime/);
const ends = W.ends as Record<string, number>;
const atStation = (ends['station-station'] + ends['away-station']) / W.trips;
const sp = BW.speeds;
const P = MICRO.price;
const ACCESS = ['16th Street / Mission', '24th Street / Mission', 'Glen Park', 'Balboa Park'];
const near = BW.nearStations.stations as { name: string; endsAM: number; startsAM: number }[];
const bats = REF.modeShare.bats2023_sfResidents_allTrips_unlinked.sharesPercent;
/** Bay Wheels trips in 2025 in SFMTA's counts (the Bike Share for All share's denominator) */
const BW_2025 = 4_153_543;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** the model's subsection */
export function microModel(): string {
  const sc = MICRO.speed.scooter;
  const kmC = MM?.calibration?.kmCoef;
  return section('micromobility', 'Shared bikes and scooters', `
<p>Two shared fleets run in the city. Bay Wheels, the regional bikeshare system Lyft runs under a franchise from MTC, had ${int(BW.system.stations)} stations and ${int(BW.system.docks)} docks in San Francisco in its GBFS feed of ${BW.system.snapshot} ${cite('bayWheelsGbfs')}, and SFMTA permits two scooter operators, Lime and Spin, at up to 3,250 scooters each ${cite('sfmtaScooters2026')}. On an average weekday from October 2025 to September 2026, Bay Wheels carried ${int(W.trips)} trips with both ends in the city, ${pc(W.byType.electric_bike / W.trips)} of them on e-bikes ${cite('bayWheelsData')}, and the scooters about ${int(sfmta.scootersPerWeekday)}, from SFMTA's counts of ${int(scooterYear)} trips over the twelve months scaled by Bay Wheels' ratio of a weekday's trips to the average day's ${cite('sfmtaSharedTrips')}. No scooter trip records are public.</p>
<p>The shared vehicles are three alternatives in the non-motorized nest, beside walking and an own bike: a Bay Wheels classic bike, a Bay Wheels e-bike, and a scooter. Their trips are booked as bike trips, as BATS 2023 and the ACS count them (BATS reports ${bats.Bikeshare}% and ${bats.Scootershare}% of residents' unlinked trips by bikeshare and scooter share, beside ${bats.Bike}% by bicycle ${cite('bats2023')}). SANDAG's ABM3 gives e-bikes and e-scooters a nest of their own at a coefficient of 0.5 ${cite('sandagAbm3Code')}; MTC estimates bikeshare's effects off the model ${cite('pba2050Method')}, and SF-CHAMP's documentation describes no shared vehicles ${cite('sfchampDocs')}. A tighter nest with the own bike would make them compete mostly with cycling, which the surveys do not show: in SFMTA's 2022 survey, 33% of scooter riders would otherwise have walked, 26% taken a ride-hail, 24% transit, and 4% cycled ${cite(['sfmtaScooterEval', 'Table 5'])}, and in Zurich half of shared e-scooter trips and a quarter of shared e-bike trips replaced walks ${cite('reck2022')}. They therefore sit in the non-motorized nest at its coefficient (${math(`\\mu = ${NEST}`)}).</p>
<p>A shared vehicle's utility on a leg differs from the own bike's (${sec('mode')}) in six terms. Riding time follows the own bike's route, ${math('t = a + bL + cH')} seconds over ${math('L')} meters climbing ${math('H')}, with Bay Wheels' coefficients fitted to members' median rides between stations at least 300 m apart (${int(sp.classic.rides)} classic and ${int(sp.electric.rides)} e-bike rides): classic bikes run at ${fx(sp.classic.flatKmh, 1)} km/h on the flat and lose ${fx(sp.classic.secPerMClimbed, 2)} seconds per meter climbed, e-bikes ${fx(sp.electric.flatKmh, 1)} km/h and ${fx(sp.electric.secPerMClimbed, 2)}. Scooters take the e-bike's time divided by ${fx(MICRO.speed.ebike.perM / sc.perM, 2)}, the ratio of shared e-scooters' to dockless e-bikes' mean speeds in Austin's trip records ${cite('almannaa2021')}. Riding time is weighted as in-vehicle time, as in ABM3; riders of shared vehicles in German cities valued a minute of riding at ${fx(0.42, 2)} to ${fx(0.55, 2)} of a minute walked ${cite('krauss2022')}, about one in-vehicle minute at TM1's walk weight of 2.</p>
<p>Walking to the vehicle and from where it is left is costed at TM1's walk coefficient. A classic bike needs a Bay Wheels station within ${MICRO.reachMin} minutes' walk at both ends. An e-bike starts at a station or where its last rider left it (${int(MICRO.fleet.ebikeAway)} stood away from stations in the snapshot) and ends at a station or at a public rack for ${money(P.rackFee, 0)}. Scooters (the operators' average deployed fleet in 2025, ${int(MICRO.fleet.scooter)} ${cite('sfmtaScooters2026')}) and e-bikes away from stations are spread in proportion to residents and jobs, and the walk to the nearest is ${math('1.3 \\cdot 0.5/\\sqrt{\\rho}')}, the mean distance to the nearest point of a random scatter of density ${math('\\rho')} on a street grid. The share of a zone's people within reach enters as its logarithm, as transit's availability does.</p>
<p>The price enters at the group's cost coefficient. A casual Bay Wheels rider pays ${money(P.unlock, 2)} to unlock and ${money(P.casualPerMin.classic, 2)} a minute on a classic bike or ${money(P.casualPerMin.ebike, 2)} on an e-bike; members ride classic bikes free for ${P.member.classicFreeMin} minutes and pay ${money(P.member.ebikePerMin, 2)} a minute on e-bikes, and Bike Share for All members ride classic bikes free for ${P.bsfa.classicFreeMin} minutes and pay ${money(P.bsfa.ebikePerMin, 2)} a minute on e-bikes, at most ${money(P.bsfa.ebikeMax, 0)} ${cite('bayWheelsPricing')}. The price is averaged over riders: ${pc(MICRO.riders.casual, 1)} casual (from the trip records) and ${pc(MICRO.riders.bsfa, 1)} Bike Share for All (nearly 300,000 trips in 2025 ${cite('sfgovLyft2026')} of ${int(BW_2025)} in SFMTA's counts); who holds a membership is taken as given. A scooter ride costs ${money(P.scooterUnlock, 2)} plus ${money(P.scooterPerMin, 2)} a minute, the two operators' prices weighted by their trips (${pc(limeYear / scooterYear, 1)} Lime's) ${cite('scooterPricing')}.</p>
<p>A term per kilometer ridden${kmC !== undefined ? ` (${fx(kmC, 3)})` : ''} is fitted to the mean length of Bay Wheels rides; without it, the model's shared trips averaged 6 to 7 km, more than twice the length of Bay Wheels rides between stations. Climbing costs effort beyond its time, counted as more riding: in San Francisco's CycleTracks route choice, cyclists traded 100 feet of climbing for 1.12 miles of riding, or ${int(59)} m per meter climbed ${cite('hood2011')}, of which the classic bikes' riding time already charges ${fx(sp.classic.secPerMClimbed / sp.classic.secPerM, 1)} m, leaving ${fx(MICRO.climbEquiv.classic, 1)}. Zurich's e-bike riders valued distance on 6–10% slopes at 0.40 of conventional riders' ${cite('meister2023')}, which leaves ${fx(MICRO.climbEquiv.ebike, 1)} m per meter for e-bikes, and Washington's shared e-scooter riders showed no measurable cost of climbing ${cite('qianScooter2026')}. Each vehicle also has a constant fitted to the counts (${sec('calibration')}).</p>
<p>Persons under 18 cannot rent from either operator. Trips with neither end at home and visitors' trips choose the same way. Shared trips are spread over the day by each vehicle's hours in the Bay Wheels records (scooters by all of Bay Wheels', since SFMTA publishes no scooter hours). The shared vehicles also reach stations: each city zone between ${fx(MICRO.accessMinM / 1000, 1)} and ${int(MICRO.accessMaxM / 1000)} km by bike from a BART, Caltrain, Muni Metro subway, or ferry station has three more access links to it and three egress links from it (a Bay Wheels bike from a station near home, a Bay Wheels e-bike found on the street, and a scooter). Each link carries its riding time, walks, price, distance and climbing terms in in-vehicle minutes, and a calibrated bias, one for riding to stations and one for riding away. The price is carried apart from the transit fare, so youth and senior fare multiples do not apply to it, and riders choose among these links and the walking links block by block (${sec('assignment')}), so a station draws riders from farther away when riding to it is cheap.</p>
`);
}

/** the calibration's target row (calibration section, Table "targets") */
export const microTargetRow = (): string[] => [
  'Shared vehicles: Bay Wheels trips with both ends in the city, their e-bike share, and their mean length; scooter trips; Bay Wheels arrivals at four BART stations and departures from four downtown stations, 6–10 a.m.; residents\' bike commuters by neighborhood',
  `Bay Wheels trip histories ${cite('bayWheelsData')}; SFMTA counts ${cite('sfmtaSharedTrips')}`,
  'Shared-vehicle constants, distance term, biases on riding to and from stations, and the own bike\'s climbing term',
];

/** a paragraph for the calibration section */
export function microCalibration(): string {
  const T = MM?.targets;
  const c = MM?.calibration;
  const nearAM = near.filter((s) => ACCESS.includes(s.name)).reduce((a, s) => a + s.endsAM, 0);
  return `<p>The three shared-vehicle constants (one on both Bay Wheels bikes, one more on e-bikes, and one on scooters) were fitted to Bay Wheels' weekday trips with both ends in the city${T ? ` (${int(T.bayWheels)})` : ''}, their e-bike share${T ? ` (${pc(T.ebikeShare)})` : ''}, and the scooter trips${T ? ` (${int(T.scooter)})` : ''}, less the model's own station rides, by steps of ${math('\\mu')} times the log ratio of target to model. The distance term was fitted to the mean route length of Bay Wheels rides between two stations${T ? `, ${fx(T.meanKm, 2)} km` : ''}. The bias on riding to a station was fitted to the Bay Wheels rides ending within 150 m of the four BART stations outside downtown (16th Street, 24th Street, Glen Park, and Balboa Park) between 6 and 10 a.m. (${int(nearAM)} a weekday at Bay Wheels stations, ${T ? int(T.accessAM) : 'more'} once divided by the ${pc(atStation)} of rides that end at a station), and the bias on riding away to the rides starting at the four downtown stations in the same hours${T ? ` (${int(T.egressAM)})` : ''}, an upper bound, since some start from the offices around them. The own bike's climbing term was fitted against the slope of the model's errors in residents' bike commuting by neighborhood against the ACS.${c ? ` The fitted constants are ${fx(c.asc.bayWheels, 2)} on Bay Wheels, ${fx(c.asc.ebike, 2)} more on e-bikes, and ${fx(c.asc.scooter, 2)} on scooters; the distance term is ${fx(c.kmCoef ?? 0, 3)} a kilometer; the biases are ${fx(c.accessBias, 1)} minutes a ride to a station and ${fx(c.egressBias ?? c.accessBias, 1)} away from one; and ${(c.climb?.own ?? 0) < -1e-4 ? `the own bike's climbing term is ${fx(c.climb!.own!, 4)} a meter` : 'the own bike needs no climbing term'}.` : ''}</p>`;
}

/** the checks for the validation section (paragraphs and a data table; the caller places them in its section) */
export function microValidation(): string {
  const m = MM;
  if (!m) return '';
  const T = m.targets;
  const tot = m.trips.total, bw = tot[0] + tot[1];
  const A = m.od.areas;
  const HS = m.od.hillSlopes;
  const bart = m.access.bart.filter((s) => s.profile);
  return `<p>Shared bikes and scooters were checked against Bay Wheels' trip records and BART's station profiles. The model carries ${int(bw)} Bay Wheels trips a weekday against ${int(T.bayWheels)} counted, ${pc(tot[1] / bw)} of them on e-bikes (${pc(T.ebikeShare)} counted), and ${int(tot[2])} scooter trips against about ${int(T.scooter)}. Bay Wheels trips average ${fx(m.tripKm.model.ebike, 2)} km on e-bikes and ${fx(m.tripKm.model.classic, 2)} km on classic bikes, against ${fx(m.tripKm.observed.ebike, 2)} and ${fx(m.tripKm.observed.classic, 2)} km for rides between stations; scooter trips average ${fx(m.tripKm.model.scooter, 2)} km, against the 1.5 miles (${fx(1.5 * 1.609, 1)} km) SFMTA reported for 2022 ${cite('sfmtaScooterEval')}, to which nothing was fitted. Across the city's ${int(m.od.neighborhoods.length)} Analysis Neighborhoods, the modeled share of Bay Wheels trip ends correlates with the counted share at ${math(`r = ${fx(m.od.byNeighborhood.r, 2)}`)}, and between neighborhood pairs at ${fx(m.od.r, 2)} (${fx(m.od.big.r, 2)} over the ${int(m.od.big.n)} pairs with 20 or more counted trips a day). The model has ${spc(A.downtown.ratio - 1, 0)} of the counted share of trip ends downtown and ${spc(A.hills.ratio - 1, 0)} in the hilly neighborhoods: across neighborhoods, the log of the model's share over the counted share rises by ${fx(10 * HS.classic.slope, 3)} for each 10 m of mean climb on classic bikes (${math(`r = ${fx(HS.classic.r, 2)}`)}), while the own bike shows ${Math.abs(HS.own.r) < 0.3 ? 'no such bias' : 'a weaker one'} (slope ${fx(10 * HS.own.slope, 3)}, ${math(`r = ${fx(HS.own.r, 2)}`)}). A climbing term fitted to each shared vehicle went to five to ten times the route-choice values and still left most of the slope, so the bias is not the effort of climbing: in the hilly residential neighborhoods Bay Wheels' riders are fewer than residents and jobs imply.</p>
<p>In all, ${int(sum(m.access.totalAccess))} riders a day reach a station by shared vehicle and ${int(sum(m.access.totalEgress))} leave one. BART's 2024 Station Profile Study gives the share of each station's riders from home who arrived by bicycle and by electric scooter, owned or shared ${cite('bartProfileFreq')}. Caltrain's surveys suggest that most scooter riders reaching rail own their scooters (in its 2024 survey, 3% of weekday riders came on their own e-scooter and 1% by bikeshare ${cite('caltrainOd2024')}), so the model's shares by shared vehicle should fall below the profile's:</p>
${dataTable(
    ['Station', 'Model: Bay Wheels', 'Model: scooter', 'Profile: bicycle', 'Profile: scooter'],
    bart.map((s) => [s.name, pc(s.model.bayWheels, 1), pc(s.model.scooter, 1), pc(s.profile!.bike, 0), pc(s.profile!.scooter, 0)]),
    [1, 2, 3, 4],
  )}`;
}
