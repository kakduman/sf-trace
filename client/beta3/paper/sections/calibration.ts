import { ATTENDANCE, COEFFS, COLLEGE, INCOME_CLASS_NAMES, IVT_FACTOR, SCHOOL_K5, SCHOOL_LEVELS, SCHOOL_RETURN, SHUTTLE_RIDERS } from '../../../../shared/beta3/params';
import { F, FX, muni, REF, RESIDENT_TARGET as RT, V, VX, workTargets } from '../data';
import { microCalibration, microTargetRow } from './micromobility';
import { cap, cite, display, eq, fx, int, list, math, nw, pc, sec, section, tab, table } from '../doc';

const MODES = ['da', 'sr', 'tnc', 'transit', 'walk', 'bike'] as const;
const PURPOSE_NAME: Record<string, string> = { shop: 'shopping', other: 'errands and other', social: 'social', school: 'school (K–12)', univ: 'college', nhb: 'neither end at home', visitor: 'hotel visitors' };
const MODE_NAME: Record<string, string> = { da: 'drive alone', sr: 'carpool', tnc: 'ride-hail and taxi', transit: 'transit', walk: 'walk', bike: 'bike' };
const CLASS_NAME: Record<string, string> = { car: 'car', transit: 'transit', walk: 'walking', bike: 'cycling' };

/** the fields calibrate.ts writes that facts.json may not have yet (export-facts.ts) */
interface CalibExtra {
  residentTransitLevel?: number | null;
  nonResTransitLevel?: number | null;
  muniLevelFit?: { residents: [number, number]; nonResidents: [number, number] } | null;
  muniByResidence?: { residents: [number, number]; nonResidents: [number, number] } | null;
  pumaFit?: Record<string, [number, number]> | null;
  tripSwitchFit?: Record<string, [number, number]> | null;
  outCommuteFit?: Record<string, [number, number]> | null;
  outCommuteFactor?: Record<string, number> | null;
  caltrainDirFit?: { arrivalsAM: [number, number]; departuresAM?: [number, number]; departAmShare: [number, number] } | null;
  caltrainAct?: number | null;
  schoolLevelFit?: ([number, number] | null)[] | null;
  extAccessBias?: Record<string, number> | null;
}
export const calibExtra = () => FX.calibration as unknown as CalibExtra;
/** Muni's boardings on the counted routes by residence, [model, target] (the calibration's own estimate, else its last assignment) */
export const muniLevel = () => calibExtra().muniLevelFit ?? calibExtra().muniByResidence ?? null;

export function calibration(): string {
  const C = FX.calibration;
  const X = calibExtra();
  const LV = { res: X.residentTransitLevel ?? null, nr: X.nonResTransitLevel ?? null };
  const MBR = muniLevel();
  const wt = workTargets();
  const wm = C.workModel as Record<string, Record<string, number>>;
  const res = V.modeShares.residents as Record<string, { model: number; observed: number }>;
  const ct = V.caltrain.rows;
  const ctObs = ct.reduce((a, r) => a + r.observedWeekdayEst, 0), ctMod = ct.reduce((a, r) => a + r.model, 0);
  const w = muni('wkd');
  const asc = C.asc as Record<string, Record<string, Record<string, number>>>;
  const mk = { ...(C.meanKm as Record<string, number>) };
  const xf = C.xferFactor ?? 1;
  const tbs = VX.od?.riders?.transfersBefore?.system;
  const segName: Record<string, string> = { car0: 'Residents, no car', car1: 'Residents, one car', car2: 'Residents, two or more cars', ext: 'In-commuters' };
  const bats = REF.modeShare.bats2023_sfResidents_allTrips_unlinked;
  const nwv = REF.nhtsTransitLength.byVehicles.nonwork;
  const snapS = REF.schoolTravel.muniRidersSchoolShare2023_24;
  const unlinkedTransit = (bats.weightedTrips * bats.sharesPercent.Transit) / 100;
  const ctFactor = (V.caltrain as { weekdayFactor?: number }).weekdayFactor;
  const tripFit = X.tripSwitchFit ?? (F.calibration as { tripSwitchFit?: Record<string, [number, number]> }).tripSwitchFit;
  const tripName = (k: string) => {
    const [a, b] = k.split('>');
    return `${MODE_NAME[b]} on ${MODE_NAME[a]} tours`;
  };
  // distance targets (trip-lengths.ts): means of trips up to 5 miles and shares within half a mile
  // where the calibration reports them (meanKm5, nearShare), else the means of all trips
  const NT = REF.nhtsTours.byTourPurpose as Record<string, { meanPrimaryKmDense: number }>;
  const NM = REF.nhtsTours.byTourMode as Record<string, { meanDetourLegKmDense: number }>;
  const assumedKm = F.targets.tripKm as Record<string, number>;
  const fitted5 = !!C.meanKm5 && Object.keys(C.meanKm5).length > 0 && !!FX.targets.tripNear;
  const upTo5 = new Set(fitted5 ? ['shop', 'other', 'social', 'nhb'] : []);
  const tk: Record<string, number> = fitted5
    ? { ...assumedKm }
    : { shop: NT.shop.meanPrimaryKmDense, other: NT.other.meanPrimaryKmDense, social: NT.social.meanPrimaryKmDense, nhb: REF.nhtsTripLength.byPurpose.NHB.meanKm, univ: assumedKm.univ, visitor: assumedKm.visitor };
  if (fitted5) for (const k of upTo5) if (C.meanKm5![k] !== undefined) mk[k] = C.meanKm5![k];
  const stopKm: Record<string, number> = fitted5 ? { ...FX.targets.stopKm } : Object.fromEntries(Object.entries(NM).map(([c, v]) => [c, v.meanDetourLegKmDense]));
  if (fitted5) for (const c of Object.keys(stopKm)) if (C.meanKm5![`stop:${c}`] !== undefined) mk[`stop:${c}`] = C.meanKm5![`stop:${c}`];
  const stopModel = Object.keys(stopKm).filter((c) => mk[`stop:${c}`] !== undefined);
  const nearT = { ...(FX.targets.tripNear ?? {}), ...Object.fromEntries(Object.entries(FX.targets.stopNear ?? {}).map(([c, v]) => [`stop:${c}`, v])) };
  const nearKeys = fitted5 ? Object.keys(nearT).filter((k) => C.nearShare?.[k] !== undefined) : [];
  const nearName = (k: string) => (k.startsWith('stop:') ? `stops on ${CLASS_NAME[k.slice(5)] ?? k.slice(5)} tours` : k === 'nhb' ? 'trips with neither end at home' : `${PURPOSE_NAME[k] ?? k} tours`);
  const resLine = /residents ([\d,]+)\)/.exec(C.report[0] ?? '');
  const resModel = resLine ? Number(resLine[1].replace(/,/g, '')) : null;
  const resTarget = FX.targets.residentTrips;
  const county = FX.targets.county, ctTransit = C.countyTransit;
  const pumaFit = X.pumaFit;
  const SF_ = FX.calibration.schoolFit, YF = FX.calibration.youthFit, CF = FX.calibration.collegeFit;
  const OCF = X.outCommuteFactor;
  const YT_CI = REF.batsYouth.ci90, YT_N = REF.batsYouth.transitTrips;
  const K5M = REF.students.sfusd.k5Mode2019, k5m = (k: 'anyCar' | 'anyBus' | 'walk' | 'bike') => (K5M.kindergarten[k] + K5M.grade5[k]) / 2;
  const ferry = VX.ferry;
  const ferryObs = ferry ? ferry.rows.reduce((a, r) => a + r.observed, 0) : null, ferryMod = ferry ? ferry.rows.reduce((a, r) => a + r.model, 0) : null;
  const ferryFactor = C.ivtFactor?.ferry;
  const floor = C.ferryFloor ?? 0.15;
  const acFactor = (C.ivtFactor as Record<string, number> | null | undefined)?.['feed:ac'];
  const parks = FX.targets.parks, pf = C.parkFactor;
  const workGap = Math.max(...(['car0', 'car1', 'car2', 'ext'] as const).flatMap((sg) => MODES.map((m) => Math.abs((wm[sg]?.[m] ?? 0) - (wt[sg]?.[m] ?? 0)))));
  const ascRow = (label: string, o: Record<string, number> | undefined) => [label, ...(['sr', 'tnc', 'transit', 'walk', 'bike'] as const).map((m) => (o?.[m] === undefined ? '–' : fx(o[m], 2)))];
  const tm1Ferry = 0.83 / Math.abs(COEFFS.work.ivt);
  const fit = C.ivtFit ?? {};
  const ctFit = fit.caltrain ?? { start: IVT_FACTOR.caltrain, floor: 0.35, power: 0.6 };
  const ctCeil = (fit.caltrain as { ceil?: number } | undefined)?.ceil ?? 1.5;
  const ferryFit = fit.ferry ?? { start: IVT_FACTOR.ferry, floor, power: 0.6 };
  const ctIvt = C.ivtFactor?.caltrain;
  const CT_DIR = X.caltrainDirFit;
  const ext = X.extAccessBias;

  // the subway lines (J, K, L, M, N) against the buses; the T and S on neither side
  const metroSet = new Set(['J', 'K', 'L', 'M', 'N', 'T', 'S']), subwaySet = new Set(['J', 'K', 'L', 'M', 'N']);
  const sumR = (f: (r: string) => boolean, k: 'observed' | 'model') => w.routes.filter((r) => f(r.route)).reduce((a, r) => a + r[k], 0);
  const metroBusRatio = (sumR((r) => subwaySet.has(r), 'model') / sumR((r) => !metroSet.has(r), 'model')) / (sumR((r) => subwaySet.has(r), 'observed') / sumR((r) => !metroSet.has(r), 'observed'));
  const commuters = F.totals.workers * (1 - F.totals.wfhShare) * ATTENDANCE;
  const shuttleShare = Object.values(SHUTTLE_RIDERS).reduce((a, v) => a + v, 0) / commuters;
  const ferryNames = ferry ? ferry.rows.filter((r) => !/Larkspur/.test(r.name)).map((r) => r.name) : [];
  const dolores = parks?.find((p) => !p.own), ggp = parks?.find((p) => p.lessMuseums > 0);
  const resGap = Math.max(...MODES.map((m) => Math.abs(res[m].model - res[m].observed))) * 100;
  const distKeys = Object.keys(tk).filter((k) => mk[k] !== undefined);
  const distGap = Math.max(0, ...distKeys.map((k) => Math.abs(mk[k] - tk[k])), ...stopModel.map((c) => Math.abs(mk[`stop:${c}`] - stopKm[c])));
  const distOff = [...distKeys.filter((k) => Math.abs(mk[k] - tk[k]) >= 0.15).map((k) => `${k === 'nhb' ? 'trips with neither end at home' : `${PURPOSE_NAME[k] ?? k} tours`} (${fx(mk[k], 1)} km against ${fx(tk[k], 1)})`), ...stopModel.filter((c) => Math.abs(mk[`stop:${c}`] - stopKm[c]) >= 0.15).map((c) => `stops on ${CLASS_NAME[c] ?? c} tours (${fx(mk[`stop:${c}`], 1)} km against ${fx(stopKm[c], 1)})`)];

  // the factors fitted to totals, their bounds, and the total each one moves
  const TOL = 0.02;
  const gapOf = (m: number, t: number) => m / t - 1;
  const factors = [
    ...(LV.res !== null ? [{ name: "residents' Muni level factor", value: LV.res, lo: 0.8, hi: 2, what: "residents' boardings on the counted Muni routes", fit: MBR?.residents }] : []),
    ...(LV.nr !== null ? [{ name: "non-residents' Muni level factor", value: LV.nr, lo: 0.8, hi: 2, what: "non-residents' boardings on the counted Muni routes", fit: MBR?.nonResidents }] : []),
    { name: 'the regional visitor rate', value: C.regionalRate, lo: 0.02, hi: 3, what: "BART's exits at the nine city-area stations", fit: [V.bart.wkd.modelTotal, V.bart.wkd.observedTotal] as [number, number] },
    ...(ctIvt !== undefined ? [{ name: "Caltrain's in-vehicle time factor", value: ctIvt, lo: ctFit.floor, hi: ctCeil, what: "Caltrain's boardings at the three city stations", fit: [ctMod, ctObs] as [number, number] }] : []),
    ...(ferryFactor !== undefined && ferryObs !== null && ferryMod !== null ? [{ name: 'the ferry in-vehicle time factor', value: ferryFactor, lo: floor, hi: 1, what: 'ferry boardings on the commuter routes', fit: [ferryMod, ferryObs] as [number, number] }] : []),
    ...(acFactor !== undefined ? [{ name: "AC Transit's in-vehicle time factor", value: acFactor, lo: 0.15, hi: 1, what: "AC Transit's Transbay riders", fit: undefined }] : []),
    { name: 'the transfer factor φ', value: xf, lo: 0.3, hi: 1.5, what: 'the share of Muni boardings after another vehicle', fit: tbs?.observed ? ([tbs.model, tbs.observed] as [number, number]) : undefined },
    ...(C.tourRateFactor ? [{ name: 'the tour rate factor', value: C.tourRateFactor, lo: 0.5, hi: 2, what: "residents' trips", fit: resTarget && resModel !== null ? ([resModel, resTarget] as [number, number]) : undefined }] : []),
    ...(typeof X.caltrainAct === 'number' ? [{ name: "Caltrain's direction constant", value: X.caltrainAct, lo: -5, hi: 5, what: "Caltrain's morning departures from the city", fit: CT_DIR?.departuresAM }] : []),
  ].map((f) => ({ ...f, bound: f.value <= f.lo + 1e-6 ? 'lower' : f.value >= f.hi - 1e-6 ? 'upper' : null }));
  const atBound = factors.filter((f) => f.bound);
  const boundText = (f: (typeof factors)[number]) =>
    `${f.name} is at its ${f.bound} bound of ${fx(f.bound === 'lower' ? f.lo : f.hi, 2)}${f.fit ? `, and ${f.what} ${Math.abs(gapOf(f.fit[0], f.fit[1])) <= TOL ? 'still match their target' : `are ${pc(Math.abs(gapOf(f.fit[0], f.fit[1])), 0)} ${f.fit[0] < f.fit[1] ? 'short of' : 'above'} their target (${int(f.fit[0])} against ${int(f.fit[1])})`}` : ''}`;
  const missedFree = factors.filter((f) => !f.bound && f.fit && Math.abs(gapOf(f.fit[0], f.fit[1])) > TOL && f.what !== 'the share of Muni boardings after another vehicle');
  const countyAtBound = (o: Record<string, number> | undefined) => Object.entries(o ?? {}).filter(([, v]) => Math.abs(v) >= 3 - 1e-6).map(([c]) => c);
  const cIn = countyAtBound(ctTransit?.in), cOut = countyAtBound(ctTransit?.out);
  const resShare = (MBR ? MBR.residents[1] / (MBR.residents[1] + MBR.nonResidents[1]) : null);

  return section('calibration', 'Calibration', `
<p>SF-TRACE's coefficients were transferred from Travel Model One and Travel Model Two and were not re-estimated (${sec('mode')}). Calibration adjusts the alternative-specific constants and a small number of scale factors so that the model reproduces San Francisco's travel on an average weekday: mode shares from the ACS and BATS 2023, trip lengths from the NHTS 2017, school and college travel from the school district and campus surveys, and ridership totals on Muni, BART, Caltrain, and the ferries. Totals are fitted, not their parts: Muni's route-by-route counts, the split of BART's exits among stations, and the other comparisons of ${sec('validation')} were not fitted. The experimental weekend models have a fit of their own (${sec('weekend-model')}).</p>
${section('calib-targets', 'Targets', `
<p>${tab('targets')} lists the targets and the parameter each one moves.</p>
${table(
  'targets',
  'Calibration targets.',
  ['Target', 'Source', 'Parameter adjusted'],
  [
    ['Commute mode shares of residents by vehicles available', `ACS 2024 1-year, table B08141 ${cite('acs')}`, 'Commute constants by car segment'],
    ['Commute mode shares of in-commuters', 'ACS 2024, B08406, less residents', 'Commute constants, in-commuters'],
    ['Commute transit share into the city by home county and out of it by work county', `ACS 2020–24 microdata ${cite('acsPums')}`, 'County transit constants'],
    ["In-commuters' transit share by home PUMA, within each county", `ACS 2020–24 microdata ${cite('acsPums')}`, 'PUMA transit constants (in-commuters)'],
    ["Share of the city's commuters working in San Mateo, Santa Clara, and Alameda counties", `ACS PUMS, the 2024 records ${cite('acsPums')}`, "Factors on residents' commute flows to those counties"],
    ['Commute transit share by neighborhood, relative to the city', 'ACS 2020–24, B08301 by block group', 'Neighborhood transit constants'],
    ["Transit share of adults' trips by household income, under and over $100,000, relative to all", `BATS 2023 ${cite('bats2023')}, MTC dashboard tables`, 'Income transit constants'],
    ['Linked trips of residents per weekday', `BATS 2023 report's unlinked car trips ${cite('bats2023')} over the linked car share`, 'Tour rate factor'],
    ["Mode shares of all trips by residents, transit's level aside", `BATS 2023, linked (MTC dashboard) ${cite('batsDashboardLinked')}`, 'Non-work constants'],
    ['How non-work mode shares differ by household cars (0, 1, 2+)', `NHTS 2017, adults in dense tracts ${cite('nhts2017')}`, 'Shape of the non-work targets across car segments'],
    ["Muni boardings on the counted routes, all together, split between residents and non-residents", `SFMTA, 12-month mean weekday boardings ${cite('sfmtaRidership')}; MTC 2023–24 Snapshot ${cite('mtcSnapshot')}`, "Muni level factors: residents' non-work transit share; non-residents' transit share within the city"],
    ["Mode shares of in-commuters' and visitors' trips with neither end at home", "Residents' non-work shares (assumed to apply)", 'Their constants'],
    ['Mode shares of hotel visitors, air travelers, and regional visitors', `SF Planning hotel surveys ${cite('sfPlanningTia2019')} (hotel visitors); assumed (the others)`, 'Their constants'],
    ["Modes of the other trips of residents' tours, by tour mode", `NHTS 2017, dense tracts ${cite('nhts2017')}`, `Trip constants by tour mode`],
    ['Distance from home to the primary destination, by tour purpose: mean of trips up to 5 miles, and share within half a mile', `NHTS 2017, dense tracts ${cite('nhts2017')}; college and visitors assumed`, 'Distance and near coefficients'],
    ['Detour to a stop, by tour mode: mean up to 5 miles, and share within half a mile', 'NHTS 2017, dense tracts', 'Stop distance and near coefficients'],
    ["Share of residents' trips of 1 to 2 road miles from or to home that are walked", 'NHTS 2017, dense tracts', 'Walking time factor ω'],
    ['SFUSD elementary pupils living under a mile from school, 2017', `SFUSD, in the School Access Plan ${cite('sfctaSchoolAccess')}`, "Scale on TM1's school distance terms"],
    ['Mode shares of SFUSD elementary pupils (kindergarten 2019 and fifth grade)', `SFUSD, in the School Access Plan ${cite('sfctaSchoolAccess')}`, 'School tour constants'],
    ["Transit shares of 6th and 9th graders' trips to school", `SFMTA Student Travel Tally ${cite('sfmtaTravelTally')}`, 'Middle and high school transit constants'],
    ["Elementary pupils' transit share home against to school", `SFCTA Child Transportation Survey, 2016 ${cite('sfctaChild2016')}`, "School tours' offset on the switch home from carpool to transit"],
    ['Pupils at each school zone, by level; students at each campus living in the city', `CDE 2025–26 ${cite('cdeEnroll')}; IPEDS ${cite('ipeds')} and campus surveys`, 'Shadow prices on school and college size terms'],
    ['SF State students driving alone to campus', `SF State 2023 survey and 2025 TDM plan ${cite('sfsuSurvey2023', 'sfsuTdm2025')}`, 'College drive-alone constant'],
    ['Walk and bike shares of trips by residents under 18; their transit share as its 90% interval', `BATS 2023 ${cite('bats2023')}`, 'Youth constants (tours other than school)'],
    ['Households by cars available, citywide and by neighborhood', `ACS 2020–24, B25044 ${cite('acs')}`, `Car ownership constants (${sec('population')})`],
    ['Visits to parks with counts', `Park agencies ${cite('parkVisits')}; a newspaper figure for Mission Dolores Park ${cite('doloresPark')}`, 'Park size weight, exponent, and factors'],
    ['Transit shares of event attendees by venue; Caltrain riders on Giants home weekdays', `Venue surveys and Caltrain (${sec('special')})`, 'Event transit constants'],
    ['BART exits at the nine city-area stations, weekday', `BART, August 2026 ${cite('bartRidership')}`, 'Regional visitor rate'],
    ...(ext ? [["How riders from home reach BART stations outside the city (on foot, by bus, by car)", `BART 2024 Station Profile Study ${cite('bartProfile2024')}`, 'Penalties by access mode']] : []),
    ['Caltrain boardings at the three city stations', `Caltrain FY2026 ${cite('caltrainRidership')}`, ctIvt !== undefined ? 'Caltrain in-vehicle time factor' : 'Caltrain path bias'],
    ["Caltrain journeys leaving San Francisco and 22nd Street for outside stations, 6–10am", `Caltrain/MTC 2024 OD survey at FY2026 volumes ${cite('caltrainOD2024')}`, "Caltrain's direction constant"],
    ['Ferry boardings on the commuter routes into the city', `SF Bay Ferry FY2026; Golden Gate Ferry FY2025 ${cite('ferryRidership')}`, 'Ferry in-vehicle time factor'],
    ...(acFactor !== undefined ? [["AC Transit's Transbay riders to and from the city", 'AC Transit, FY2025 average weekday', "AC Transit's in-vehicle time factor"]] : []),
    ['Share of Muni boardings that follow another vehicle on the same trip', `SFMTA 2017 on-board survey ${cite('muniObs2017')}`, 'Transfer factor φ'],
    microTargetRow(),
    ['Boardings on the Market Street subway lines (J, K, L, M, N) relative to bus boardings', `SFMTA ${cite('sfmtaRidership')}`, 'None (reported, not fitted)'],
  ],
)}
<p>The residents' targets are BATS 2023's linked trips, as MTC's dashboard of the survey gives them ${cite('batsDashboardLinked')}: adults' and under-18s' trips weighted by their numbers, without the dashboard's "other" modes and school buses, which the model does not have. Of residents' trips, ${pc(RT.shares.transit, 1)} were by transit, ${pc(RT.shares.walk, 1)} on foot, ${pc(RT.shares.da, 1)} driving alone, ${pc(RT.shares.sr, 1)} in a carpool, ${pc(RT.shares.bike, 1)} by bike, and ${pc(RT.shares.tnc, 1)} by ride-hail and taxi. The survey's report counts unlinked trips, in which each walk to or from transit and each vehicle ridden is a trip of its own (${bats.sharesPercent.Walk}% on foot, ${bats.sharesPercent.Transit}% by transit, and ${bats.sharesPercent.Car}% by car ${cite('bats2023')}). Car trips are the same either way, so the number of linked trips is the report's ${int(bats.weightedTrips)} weighted unlinked trips times their car share divided by the linked car share: ${int(RT.trips)} a weekday. The NHTS 2017 tour rates describe the whole metropolitan area before the pandemic, so a factor on residents' non-work tour rates makes residents' trips, the legs through stops included, equal that total.</p>
<p>Transit's level is set by Muni's counts rather than by the survey, as SF-CHAMP and TM1 calibrate transit to the boardings counted on the vehicles. Muni's boardings on the counted routes are split by where the riders live, by the shares of riders living in the city in MTC's 2023–24 Snapshot survey (light rail and buses weighted by their counted boardings; about 1,430 questionnaires, not expanded ${cite('mtcSnapshot')})${resShare !== null ? `, which puts ${pc(resShare, 0)} of the boardings on residents` : ''}. Each part has a level of its own. Residents' boardings set a factor on BATS's transit share of residents' trips other than commutes and school, the other modes keeping BATS's split among themselves; non-residents' boardings set a factor on the transit share of their trips within the city that have a choice of their own (in-commuters' and visitors' trips with neither end at home, and hotel visitors' trips), while their trips across the city line keep their own targets. Both factors are bounded at 0.8 and 2. Commutes keep the ACS's shares, school travel its own targets, and the transfer factor stays fitted to the on-board survey, so the boardings per linked trip are held by a survey and cannot fill the count. BATS's transit share is then a check: the survey's report has ${int(unlinkedTransit)} unlinked transit trips by residents on every operator${MBR ? `, while residents' target on Muni's counted routes alone is ${int(MBR.residents[1])} boardings (${pc(MBR.residents[1] / unlinkedTransit, 0)} of that total, before BART, Caltrain, the ferries, and Muni's uncounted routes)` : ''}. Travel diaries miss trips, short transit trips most.</p>
<p>The ACS "other" commute category (taxi, motorcycle, bicycle, and other means) was split between bike and ride-hail in proportion to their counts in the 2024 B08301 table; motorcycles and other means were left out and the shares renormalized. ${ctFactor !== undefined ? `Caltrain's mid-week station counts were multiplied by ${fx(ctFactor, 3)}, the ratio of its average weekday riders to the sum of its stations' mid-week figures. ` : ''}The ferry target is the FY2026 average weekday boardings of SF Bay Ferry's ${list(ferryNames)} routes and Larkspur's share of Golden Gate Ferry's annual riders times its weekday average${ferryObs !== null ? `, ${int(ferryObs)} in all` : ''} ${cite('ferryRidership')}. The air-traveler and regional-visitor shares and the trip lengths of college students and visitors are assumptions; there is no current survey of visitors' travel in San Francisco beyond SF Planning's hotel surveys.</p>
`)}
${section('calib-method', 'Procedure', `
<p>The mode constants were adjusted by the usual iterative rule. For each segment, at iteration ${math('k')},</p>
${display('asc-update', `\\alpha_m^{(k+1)} = \\alpha_m^{(k)} + d\\left[\\ln\\frac{s^*_m}{s_m^{(k)}} - \\ln\\frac{s^*_{\\text{DA}}}{s_{\\text{DA}}^{(k)}}\\right]`)}
<p>where ${math('s^*_m')} is the target share, ${math('s_m')} the model share, and ${math('d = 0.5')} a damping factor; the second term keeps drive alone as the reference. The damping is needed because a tour's trips may use modes other than the tour's own (${sec('mode')}), so a tour mode is a close substitute for the modes its trips use; with full steps the constants oscillated. Residents' non-work constants moved by at most 0.6 times the log ratio: through the near term of destination choice, walking's utility also moves where people go. Private shuttle riders count as transit commuters in the comparison with the ACS, as the ACS counts them. The non-work constants act on tours, while BATS counts trips, so the non-work targets were multiplied, mode by mode, by the model's own ratio of the non-work tours' share to the share of all residents' trips other than commutes and school, read each iteration and averaged with the last. Each car segment's non-work target is the city's reshaped by how adults' non-work trips differ with household cars in the NHTS 2017 dense tracts: transit carried ${pc(nwv[0].transit)} of the non-work trips of adults in households without a car, ${pc(nwv[1].transit)} with one car, and ${pc(nwv[2].transit)} with two or more, and walking ${pc(nwv[0].walk)}, ${pc(nwv[1].walk)}, and ${pc(nwv[2].walk)} ${cite('nhts2017')}. A segment's target share of a mode is the city's times the NHTS share in the segment over its trip-weighted mean across segments. The tour rate factor moved by the ratio of target to modeled residents' trips raised to the power 0.8, within 0.5 and 2. The share of Muni's riders traveling to or from school or college in the Snapshot (${pc(snapS.lightRail, 1)} on light rail and ${pc(snapS.localBus, 1)} on buses ${cite('mtcSnapshot')}) is a test, not a target, since school and college travel is fitted to SFUSD's pupils and SF State's students.</p>
<p>The constants of the trips of residents' tours by a mode other than the tour's own were fitted to the NHTS 2017 tours of residents of tracts with 17,000 or more people per square mile in the San Francisco–Oakland area ${cite('nhts2017')}. The survey has no tour modes, so a tour's mode is read from its trip into the primary destination, and its other trips are the trip back and the trips through stops; the model's tours are read the same way. Transit tours' trips back and their stop legs have constants of their own, since the survey's transit tours come home by transit far more often than they ride to their stops. Walking tours are compared on their trips under 3 miles, since the model's walking tours go no farther than a walk. Each constant ${math('K_{Mm}')} moved each iteration by 0.8 times the difference between the log of the survey's ratio ${math('s^*_m/s^*_M')} and the model's ${math('s_m/s_M')}, over the modes the tour's mode allows, by at most two units a step and within −12 and 6.${tripFit ? ` In the last iteration the model's shares were ${list(Object.entries(tripFit).map(([k, [mo, ta]]) => `${tripName(k)} ${pc(mo, 1)} (survey ${pc(ta, 1)})`))}.` : ''}</p>
<p>Neighborhood constants moved by 0.7 times the difference in the logit of the target and model transit shares, bounded at ±2. Each neighborhood's target is its ACS transit share scaled by the ratio of the model's citywide share to the ACS's, and the constants are recentered on their commuter-weighted mean after each step, so they fit the pattern and leave the level to the segment constants. The two income constants followed the same rule within ±2, recentered on residents' trips; they act on non-work tours only. The county constants were fitted the same way, bounded at ±3, to the transit shares of commutes between San Francisco and each county with at least ${county ? int(county.minCommuters) : '3,000'} commuters who do not work from home${county ? ` (into the city, ${list(Object.entries(county.in).map(([c, v]) => `${c} ${pc(v.share)}`))}; out of it, ${list(Object.entries(county.out).map(([c, v]) => `${c} ${pc(v.share)}`))})` : ''}, taking the 2024 records' level where commuter rail's share changed after 2020. ${pumaFit ? `Within each county, a transit constant for in-commuters by home PUMA was fitted the same way, bounded at ±1.5, to the ACS microdata's share from each of the ${nw(Object.keys(pumaFit).length)} PUMAs with at least 1,500 such commuters and a standard error under six points, and recentered within its county so the county constants keep the county totals. ` : ''}Residents' commute flows to San Mateo, Santa Clara, and Alameda counties, which start from LODES's jobs by employer address, were scaled to each county's share of the city's commuters in the ACS's 2024 records, each home zone keeping its commuters${OCF ? ` (factors ${list(Object.entries(OCF).map(([c, v]) => `${fx(v, 2)} for ${c}`))})` : ''}.</p>
<p>The distance coefficients ${math('\\beta^{\\text{dist}}_p')} of ${eq('dest')} moved by 0.12 times the log ratio of target to model mean distance, held at zero or below, and the near coefficients ${math('\\beta^{\\text{near}}_p')} by half the difference in log odds between the target and model shares of trips of half a mile or less, within −3 and 0.5. The targets are NHTS 2017 trips by residents of tracts with 10,000 or more people per square mile ${cite('nhts2017')}, and the means are of trips up to 5 miles: beyond that, a home in the city mostly has the bay and the city line where a home in Oakland or Berkeley, also in the survey's dense tracts, has more city. The stop coefficients ${math('\\lambda_c')} of ${eq('stop')} moved likewise, by 0.18 times the log ratio of the NHTS mean detour on tours of each mode class to the model's, within −5 and 0 per km, and their near coefficients by 0.35 times the difference in log odds (not for cycling tours, with 36 sampled stops). Walking's time factor ${math('\\omega')} of ${eq('v-active')} moved by the difference between the model and the NHTS in the log odds of walking a trip of 1 to 2 road miles from or to home less those of walking one of half a mile or less, over 2.5, so the walk constants keep the level of walking and the factor its fall with distance. Parks with counted visits${parks ? ` (${list(parks.filter((p) => p.own).map((p) => p.name))})` : ''} each had a factor moved toward their count, the special-generator practice; the weighted mean and acreage trend of the log residuals moved into the general weight and exponent of the park size term. ${parks ? (() => {
    const ff = parks.find((p) => p.own && p.fitWeight === 0);
    return `${ff ? `${ff.name}, a natural area of dunes, has a factor but no part in the general fit. ` : ''}${dolores ? `${dolores.name} has no official count; a 2016 newspaper figure of up to ${int(dolores.perWeekday ?? 0)} visitors on a weekday ${cite('doloresPark')} enters the general fit with ${fx(dolores.fitWeight, 1)} weight. ` : ''}${ggp?.annual ? `Golden Gate Park's ${fx(ggp.annual / 1e6, 0)} million annual visits are an undated round figure from the Recreation and Park Department, taken net of the ${int(ggp.lessMuseums)} annual visits to its museums and gardens. ` : ''}`;
  })() : ''}Annual visits were converted to an average weekday by dividing by 365 and by an assumed 1.06.</p>
<p>School tours were fitted to SFUSD. The scale on TM1's school distance terms moved by 0.7 times the difference in the logit of the share of elementary pupils living under a mile from school, ${pc(SCHOOL_K5.under1mi, 1)} in SFUSD's 2017 analysis ${cite('sfctaSchoolAccess')}, and the model's share. The school constants followed ${eq('asc-update')} with carpool as the reference, to the modes of SFUSD's kindergarten (2019) and fifth-grade pupils averaged: ${pc(k5m('anyCar'), 1)} by car, ${pc(k5m('anyBus'), 1)} by bus, ${pc(k5m('walk'), 1)} on foot, and ${pc(k5m('bike'), 1)} by bike ${cite('sfctaSchoolAccess')}. SFUSD's yellow buses, about ${int(REF.students.sfusd.yellowBus.studentsDaily)} pupils a day, count with carpools as BATS counts school buses, which leaves ${pc(SCHOOL_K5.modes.transit, 1)} on Muni. Middle and high school tours each have a transit constant fitted to the share of trips to school by transit in SFMTA's Student Travel Tally, ${pc(SCHOOL_LEVELS[1].transit ?? 0, 0)} for 6th graders and ${pc(SCHOOL_LEVELS[2].transit ?? 0, 0)} for 9th graders ${cite('sfmtaTravelTally')}. School tours' trips home have an offset on the switch from carpool to transit, fitted so that elementary pupils go home by transit ${fx(SCHOOL_RETURN.ratio, 2)} times as often as they come, as in SFCTA's 2016 survey of their parents ${cite('sfctaChild2016')}. College tours take the commute constants of their segment and one more, on driving alone, fitted to the ${pc(COLLEGE.sfsuDriveAlone, 0)} of SF State's students who drive alone to campus ${cite('sfsuSurvey2023', 'sfsuTdm2025')}. The walk and bike constants of other tours by residents under 18 were fitted to BATS 2023's shares of all their trips. Their transit share binds only as its 90% interval, ${pc(YT_CI[0], 1)} to ${pc(YT_CI[1], 1)}, from ${int(YT_N)} sampled transit trips reported mostly by proxy: the youth transit constant starts at zero, as TM1 has none on these tours, and moves only to bring the model's share inside it.</p>
${microCalibration()}
<p>Every third iteration the demand was assigned, and the parameters fitted to ridership were updated from the assigned boardings. The regional visitor rate moved by the ratio of counted to modeled BART exits at the city's stations raised to the power 1.5, within 0.02 and 3. The in-vehicle time factors of Caltrain${acFactor !== undefined ? ", the ferries, and AC Transit's Transbay buses" : ' and the ferries'} moved by the ratio of modeled to counted boardings raised to the power ${fx(ctFit.power, 1)}, within ${fx(ctFit.floor, 2)} and ${Number.isInteger(ctCeil) ? ctCeil : fx(ctCeil, 1)} for Caltrain and ${fx(ferryFit.floor, 2)} and 1 for ferries${acFactor !== undefined ? ' and AC Transit' : ''}, starting from TM1's ${fx(ctFit.start, 1)} for Caltrain and ${fx(ferryFit.start, 1)} for ferries. The ferry floor is low but consistent with TM1's own treatment of ferries, whose constant for commuters who drive to a ferry is worth about ${fx(tm1Ferry, 0)} minutes of riding at the commute in-vehicle coefficient ${cite('tm1Code')}. The direction of Caltrain commuting has a constant in perceived minutes, of either sign, on the links between Caltrain's outside stations and the activity end of a trip, moved by six times the log of the ratio of modeled to estimated morning departures from the city's two stations and held within ±5 minutes. The morning arrivals at those stations are a test, not a target: a second constant at the home end, fitted to them, fell without limit while the arrivals stayed short, because the in-commuters who make them are held to their counties' transit shares and the constant only moved them between Caltrain and BART. ${ext ? 'Penalties on walking, riding a bus, and driving to BART stations outside the city moved by three times the log ratio of the model\'s access shares to the Station Profile Study\'s, the least-used way carrying none, as TM1 and TM2 calibrate walk- and drive-access constants to on-board surveys. ' : ''}The transfer factor ${math('\\phi')}, which multiplies TM1's weight on a change in mode choice and sets the cost of a change in route choice (${sec('assignment')}), moved by the ratio of the modeled to the surveyed share of Muni boardings after another vehicle raised to the power 1.5, within 0.3 and 1.5; the surveyed share, about ${pc(tbs?.observed ?? 0.123)}, is derived from the 2017 survey's vehicles per one-way trip ${cite('muniObs2017')}. The two Muni level factors moved by the square root of the ratio of target to modeled boardings. Light rail keeps TM1's in-vehicle factor of ${fx(IVT_FACTOR.lightrail, 1)}, and no penalty by Muni mode is used, so the split between the subway lines and the buses is a result.</p>
<p>The constants were fitted with the crowding that the delivered runs have: calibration starts from the crowding of the last base run, recomputes the skims with the current crowding after each assignment step, and refreshes the crowding with a full two-pass model run every six iterations. Each calibration run starts from the constants stored in the bundle, so the delivered constants are the end of a sequence of runs, ${int(C.iterations)} iterations in all; whether a calibration from default constants would reach the same values has not been tested.</p>
`)}
${section('calib-fit', 'Fit to the targets', `
<p>${tab('fit')} compares the calibrated model with its targets. The model's commute shares there are those of the calibration log, which leaves out private shuttle riders (about ${pc(shuttleShare, 1)} of residents' weekday commutes); on that definition the commute shares by car segment are within ${Math.round(workGap * 100) <= 1 ? 'one percentage point' : `${fx(workGap * 100, 0)} percentage points`} of their targets. The residents' trip shares match BATS 2023 ${resGap < 0.05 ? 'to the first decimal place' : `to within ${fx(resGap, 1)} percentage points`}${resTarget && resModel !== null ? `, and residents make ${int(resModel)} trips a weekday, against ${int(resTarget)}` : ''}. ${distOff.length ? `The mean distances are within 0.1 km of their targets except for ${list(distOff)}.` : `All ${nw(distKeys.length)} mean tour and trip distances${stopModel.length ? ` and all ${nw(stopModel.length)} stop detours` : ''} are within ${distGap < 0.05 ? '0.05' : '0.1'} km of their targets.`} ${atBound.length ? `${cap(list(atBound.map(boundText)))}.` : 'None of the factors fitted to ridership totals is at a bound.'} ${missedFree.length ? `${cap(list(missedFree.map((f) => `${f.what} are ${pc(Math.abs(gapOf(f.fit![0], f.fit![1])), 0)} ${f.fit![0] < f.fit![1] ? 'below' : 'above'} their target with ${f.name} inside its bounds`)))}, so the calibration stopped before ${missedFree.length > 1 ? 'they were' : 'it was'} matched.` : ''} ${tbs?.observed ? `In the base run ${pc(tbs.model)} of Muni boardings follow another vehicle, against ${pc(tbs.observed)} in the survey. ` : ''}Muni's boardings on the counted routes are ${pc(Math.abs(w.modelTotal / w.observedTotal - 1), 0)} ${w.modelTotal < w.observedTotal ? 'below' : 'above'} the counts in the base run, and the subway lines' boardings relative to the buses' are ${Math.abs(metroBusRatio - 1) < 0.005 ? 'at the counted ratio' : `${fx(Math.abs(metroBusRatio - 1) * 100, 1)}% ${metroBusRatio < 1 ? 'below' : 'above'} the counted ratio`}, a result rather than a target.</p>
${table(
  'fit',
  'Calibration targets and calibrated model, average weekday.',
  ['Measure', 'Target', 'Model'],
  [
    ...(['car0', 'car1', 'car2', 'ext'] as const).flatMap((s) => [
      [`${segName[s]}: commute transit share`, pc(wt[s].transit ?? 0, 0), pc(wm[s]?.transit ?? NaN, 0)],
      [`${segName[s]}: commute drive-alone share`, pc(wt[s].da ?? 0, 0), pc(wm[s]?.da ?? NaN, 0)],
    ]),
    ...(C.incomeFit ? C.incomeFit.map(([m, t], k) => [`Adults' trips by transit, households ${INCOME_CLASS_NAMES[k] ?? k}`, pc(t, 1), pc(m, 1)]) : []),
    ...(C.countyFit ? Object.entries(C.countyFit.in).map(([c, [m, t]]) => [`Commute transit share into the city from ${c}`, pc(t, 0), pc(m, 0)]) : []),
    ...(C.countyFit ? Object.entries(C.countyFit.out).map(([c, [m, t]]) => [`Commute transit share out of the city to ${c}`, pc(t, 0), pc(m, 0)]) : []),
    ...(pumaFit ? [[`In-commuters' transit share by home PUMA (${Object.keys(pumaFit).length} PUMAs): mean absolute difference, points`, '0', fx(100 * Object.values(pumaFit).reduce((a, [m, t]) => a + Math.abs(m - t), 0) / Object.keys(pumaFit).length, 1)]] : []),
    ...Object.entries(X.outCommuteFit ?? {}).map(([c, v]) => [`City commuters working in ${c} County (ACS 2024 records)`, pc(v[1], 1), pc(v[0], 1)]),
    ...(resTarget && resModel !== null ? [["Residents' trips per weekday", int(resTarget), int(resModel)]] : []),
    ...MODES.map((m) => [`Residents' trips: ${MODE_NAME[m]}`, pc(res[m].observed, 1), pc(res[m].model, 1)]),
    ...distKeys.map((k) => [`Mean distance, ${PURPOSE_NAME[k] ?? k}, km${upTo5.has(k) ? ', trips up to 5 miles' : ''}${k === 'univ' || k === 'visitor' ? ' (assumed target)' : ''}`, fx(tk[k], 1), fx(mk[k], 1)]),
    ...nearKeys.map((k) => [`Within half a mile: ${nearName(k)}`, pc(nearT[k], 0), pc(C.nearShare![k], 0)]),
    ...(C.walkFitNear ? [["Residents' trips of half a mile or less from or to home walked", pc(C.walkFitNear[1], 0), pc(C.walkFitNear[0], 0)]] : []),
    ...(C.walkFit ? [["Residents' trips of 1 to 2 miles from or to home walked", pc(C.walkFit[1], 0), pc(C.walkFit[0], 0)]] : []),
    ...stopModel.map((c) => [`Detour to a stop, ${CLASS_NAME[c] ?? c} tours, km`, fx(stopKm[c], 1), fx(mk[`stop:${c}`], 1)]),
    ...(SF_ ? [['SFUSD elementary pupils under a mile from school', pc(SF_.under1mi[1], 1), pc(SF_.under1mi[0], 1)], ...(['sr', 'transit', 'walk', 'bike'] as const).map((m) => [`Elementary school trips: ${MODE_NAME[m]}`, pc(SF_.modes[m]?.[1] ?? NaN, 1), pc(SF_.modes[m]?.[0] ?? NaN, 1)])] : []),
    ...(X.schoolLevelFit ?? []).flatMap((f, l) => (f ? [[`${['Elementary', 'Middle', 'High'][l]} school trips by transit (Student Travel Tally)`, pc(f[1], 1), pc(f[0], 1)]] : [])),
    ...(CF ? [['SF State students driving alone to campus', pc(CF[1], 0), pc(CF[0], 0)]] : []),
    ...(YF ? (['sr', 'transit', 'walk', 'bike'] as const).map((m) => [`Trips by residents under 18: ${MODE_NAME[m]}${m === 'transit' ? ` (target: within ${pc(YT_CI[0], 1)}–${pc(YT_CI[1], 1)})` : ''}`, pc(YF[m]?.[1] ?? NaN, 1), pc(YF[m]?.[0] ?? NaN, 1)]) : []),
    ...(MBR ? [["Residents' boardings on the counted Muni routes", int(MBR.residents[1]), int(MBR.residents[0])], ["Non-residents' boardings on the counted Muni routes", int(MBR.nonResidents[1]), int(MBR.nonResidents[0])]] : []),
    [`Muni boardings, ${w.n} counted routes (base run)`, int(w.observedTotal), int(w.modelTotal)],
    ['BART exits, nine city-area stations', int(V.bart.wkd.observedTotal), int(V.bart.wkd.modelTotal)],
    ['Caltrain boardings, three city stations', int(ctObs), int(ctMod)],
    ...(CT_DIR?.departuresAM ? [['Caltrain departures from the city, 6–10am', int(CT_DIR.departuresAM[1]), int(CT_DIR.departuresAM[0])]] : []),
    ...(CT_DIR ? [['Caltrain arrivals at the city, 6–10am (a test)', int(CT_DIR.arrivalsAM[1]), int(CT_DIR.arrivalsAM[0])]] : []),
    ...(ferry && ferryObs !== null && ferryMod !== null ? [[`Ferry boardings, ${nw(ferry.rows.length)} commuter routes`, int(ferryObs), int(ferryMod)]] : []),
    ...(tbs?.observed ? [['Muni boardings after another vehicle', pc(tbs.observed, 1), pc(tbs.model, 1)]] : []),
    ["Subway lines' boardings relative to bus boardings (not fitted)", '1.00', fx(metroBusRatio, 2)],
  ],
  { numeric: [1, 2], notes: `Model commute shares by segment are as recorded in the calibration log, rounded to whole percentages, and leave out shuttle riders; the targets count them as transit. Distances for college students and visitors are assumed targets; the others are NHTS 2017. Ridership totals are those of the base run, except Muni's boardings by residence and Caltrain's morning journeys, from the calibration's last assignment. ${ctFactor !== undefined ? `The Caltrain target is the FY2026 mid-week count times ${fx(ctFactor, 3)}.` : ''}` },
)}
<p>${tab('constants')} gives the calibrated constants, in utility units with drive alone as the reference. The commute transit constants ${(asc.work?.car0?.transit ?? 0) > (asc.work?.car1?.transit ?? 0) && (asc.work?.car1?.transit ?? 0) > (asc.work?.car2?.transit ?? 0) ? 'fall' : 'change'} with car ownership, from ${fx(asc.work.car0.transit, 2)} for households without a car to ${fx(asc.work.car2.transit, 2)} for those with two or more. The ${C.nhood.n} neighborhood constants have a standard deviation of ${fx(C.nhood.sd, 2)}${C.nhood.atBound ? `, and ${nw(C.nhood.atBound)} reached the ±2 bound` : ''}; neighborhoods with fewer than 800 ACS commuters keep the city level.${ctTransit?.in && Object.keys(ctTransit.in).length ? ` The county constants range from ${fx(Math.min(...Object.values(ctTransit.in)), 2)} to ${fx(Math.max(...Object.values(ctTransit.in)), 2)} for commutes into the city${ctTransit.out && Object.keys(ctTransit.out).length ? ` and from ${fx(Math.min(...Object.values(ctTransit.out)), 2)} to ${fx(Math.max(...Object.values(ctTransit.out)), 2)} for commutes out of it` : ''}.` : ''}${cIn.length || cOut.length ? ` ${cap(list([...(cIn.length ? [`into the city, ${list(cIn)}`] : []), ...(cOut.length ? [`out of it, ${list(cOut)}`] : [])]))} reached the bound of ±3 and miss${cIn.length + cOut.length === 1 ? 'es its' : ' their'} target${cIn.length + cOut.length === 1 ? '' : 's'}.${cIn.includes('Sonoma') ? " Sonoma County's commuters reach the city by transit only on paths of more than two hours, since SMART is not among the model's feeds, so no constant can reach its share." : ''}` : ''}${C.tourRateFactor ? ` The tour rate factor is ${fx(C.tourRateFactor, 3)}: residents make ${pc(Math.abs(C.tourRateFactor - 1))} ${C.tourRateFactor < 1 ? 'fewer' : 'more'} non-work tours than the NHTS 2017 rates imply${C.tourRateFactor > 1 ? ', although post-pandemic travel would be expected to be lower. The factor absorbs any difference between how BATS 2023 counts linked trips and how the model builds trips from tours, stops, and subtours, and that difference was not decomposed' : ''}.` : ''} ${ctIvt !== undefined ? `Caltrain's in-vehicle time factor is ${fx(ctIvt, 3)}, against TM1's ${fx(ctFit.start, 1)}. ` : ''}${ferryFactor !== undefined ? `The ferry in-vehicle time factor is ${fx(ferryFactor, 3)}: an hour aboard a ferry is perceived as ${fx(60 * ferryFactor, 0)} minutes of bus riding. ` : ''}${C.parkExponent && C.parkWeight ? `The park size term has a weight of ${fx(C.parkWeight, 2)} and an exponent of ${fx(C.parkExponent, 2)} on acreage${pf ? `, and the counted parks' factors are ${list(Object.entries(pf).map(([k, v]) => `${fx(v, 2)} for ${k}`))}` : ''}. ` : ''}${C.incomeTransit ? `The income transit constants are ${list(C.incomeTransit.map((v, k) => `${fx(v, 2)} for households ${INCOME_CLASS_NAMES[k] ?? k}`))}. ` : ''}${LV.res !== null && LV.nr !== null ? `The Muni level factors are ${fx(LV.res, 3)} for residents and ${fx(LV.nr, 3)} for non-residents. ` : ''}The transfer factor is ${fx(xf, 2)}, and the regional visitor rate ${fx(C.regionalRate, 3)} trips per in-commuter.</p>
${table(
  'constants',
  'Calibrated alternative-specific constants (utility; drive alone = 0).',
  ['Purpose and segment', 'Carpool', 'Ride-hail and taxi', 'Transit', 'Walk', 'Bike'],
  [
    ascRow('Commute, no car', asc.work?.car0),
    ascRow('Commute, one car', asc.work?.car1),
    ascRow('Commute, two or more cars', asc.work?.car2),
    ascRow('Commute, in-commuters', asc.work?.ext),
    ascRow('Non-work tours from home, no car', asc.nonwork?.car0),
    ascRow('Non-work tours from home, one car', asc.nonwork?.car1),
    ascRow('Non-work tours from home, two or more cars', asc.nonwork?.car2),
    ascRow('Neither end at home (in-commuters and visitors)', asc.nhb?.car1),
    ascRow('Hotel visitors', asc.visitor?.visitor),
    ascRow('Air travelers', asc.airport?.visitor),
    ascRow('Regional visitors', asc.regional?.ext),
    ...(FX.calibration.schoolAsc ? [ascRow('School tours (added to non-work)', { sr: 0, ...FX.calibration.schoolAsc })] : []),
    ...(FX.calibration.youthAsc ? [ascRow('Other tours under 18 (added)', FX.calibration.youthAsc)] : []),
    ...(typeof FX.calibration.collegeDa === 'number' ? [ascRow('College tours (added to the commute constants)', Object.fromEntries(['sr', 'tnc', 'transit', 'walk', 'bike'].map((m) => [m, -(FX.calibration.collegeDa as number)])))] : []),
  ],
  { numeric: [1, 2, 3, 4, 5], wide: true, notes: "Walk and bike constants for in-commuters and regional visitors apply only to the few trips with both ends in reach; external zones have no walk or bike option to the city. College tours use the commute constants of their segment (TM1 treats both as mandatory tours); school tours use those of non-work tours from home plus the school constants, and other tours by residents under 18 add the youth constants." },
)}
`)}
`);
}
