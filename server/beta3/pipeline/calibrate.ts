/**
 * Step 8: calibrate the model to San Francisco and write the constants into the bundle.
 *
 * Targets (all observed unless marked assumed):
 *  - Commute mode shares of residents by household cars: ACS 2024 1-year, table B08141.
 *  - Commute mode shares of in-commuters: ACS 2020–24 by workplace (B08406) less residents' share.
 *  - All trips by residents: BATS 2023 (MTC) San Francisco residents, linked shares from MTC's
 *    dashboard, the total from the report's unlinked car trips (resident-targets.ts).
 *  - Trips by residents under 18: BATS 2023 (school and non-work tours of youth); transit as its 90%
 *    interval only (YOUTH_TRANSIT_CI).
 *  - School tours: SFUSD's elementary pupils (modes, distance); middle and high school transit, SFMTA's
 *    Student Travel Tally (6th and 9th graders); demand.ts fitStudents.
 *  - Where the city's commuters work: ACS 2024 records, San Mateo, Santa Clara, and Alameda (OUT_2024).
 *  - BART exits at San Francisco stations: BART, August 2026 → regional visitor volume; exits and
 *    entries at the four Market Street stations → their street-to-platform times (stations-fit.ts).
 *  - Destination choice and stops: mean trip length and the share of half a mile or less, by purpose
 *    (NHTS 2017, dense tracts; trip-lengths.ts); walking's time weight to the walk share of trips of
 *    1 to 2 miles (WALK_1_2).
 *  - Visitors, air travellers and regional visitors: mode shares assumed (see the targets below).
 * Then reports Muni boardings by route against SFMTA counts (not fit route by route).
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/calibrate.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { decodeResult } from '../../../shared/beta3/results';
import { EVENT_OD, NONRES_OD, TRIP_MIX, computeDemand, fitEventTransit, fitStudents, outCommuteShares, prepare, type TrnSkims } from '../../../shared/beta3/demand';
import { LocalExecutor, runModel, SKIM_PERIODS } from '../../../shared/beta3/model';
import { boardStop } from '../../../shared/beta3/net';
import { INCOME_CLASSES, MODES, SCHOOL_DAY, SEGMENTS, TRIP_SWITCH, TRIP_SWITCH_ASC, TRIP_SWITCH_STOP, transferPenalty, type Mode, type Purpose } from '../../../shared/beta3/params';
import type { Calibration, RunResult, Scenario, TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { accessShares } from './regional-diag';
import { caltrainCityDirection, giantsCaltrain, readRegional } from './station-od';
import { fitMicro, fitMicroAccess, microAccess, type MicroAccess } from './micromob-diag';
import { DEFAULT_CALIB, loadBundle, validation } from './run-base';
import type { TransitNet } from '../../../shared/beta3/net';
import { DOWNTOWN_BART, FIT_STATION_TIMES, fitStationTimes } from './stations-fit';
import { extPumaWeights, readOdRef } from './od-checks';
import { muniAfterVehicle } from './transfers';
import { residentLinkedShares, residentLinkedTrips } from './resident-targets';
import { fitLengths, fitWalkTime, lengthTargets } from './trip-lengths';
import { visitorTarget } from './visitor-target';

type Shares = Partial<Record<Mode, number>>;
const norm = (s: Shares): Shares => {
  const t = Object.values(s).reduce((a, v) => a + (v ?? 0), 0);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (v ?? 0) / t]));
};

// ---------- targets ----------
const acs = JSON.parse(fs.readFileSync(`${REFERENCE}/acs-commute.json`, 'utf8'));
const B08141_2024 = {
  // ACS 2024 1-year, San Francisco: workers by vehicles available (0, 1, 2+) and means of transport
  car0: { da: 9872, sr: 2117, transit: 44728, walk: 20474, other: 11741 },
  car1: { da: 57695, sr: 9401, transit: 43074, walk: 16637, other: 14015 },
  car2: { da: 48317 + 25960, sr: 11708 + 4381, transit: 18510 + 8797, walk: 4685 + 2183, other: 5314 + 1350 },
};
// "other" (taxi, motorcycle, bike, other) split as residents' commutes overall: bike 17,838, taxi/ride-hail 5,330 of 33,762
const m1 = acs.residentsCommuteMode_B08301_ACS1yr2024.modes;
const otherTot = m1.bike.count + m1.taxiRideHailing.count + m1.motorcycle.count + m1.otherMeans.count;
const WORK_TARGET: Record<string, Shares> = {};
for (const [k, v] of Object.entries(B08141_2024))
  WORK_TARGET[k] = norm({ da: v.da, sr: v.sr, transit: v.transit, walk: v.walk, bike: (v.other * m1.bike.count) / otherTot, tnc: (v.other * m1.taxiRideHailing.count) / otherTot });
// in-commuters: ACS 2024 1-year workplace shares (B08406) less residents commuting within the city
// (B08130), acs-commute.json acs1yr2024; the few who walk or cycle are left out, and taxi, motorcycle,
// and other means count as ride-hail in the share the 2020–24 microdata give them among in-commuters
// who neither drive nor ride transit (commute-by-county.json: 4,017 of 6,793). The 2020–24 5-year
// tables had given 31% by transit, pooling two pandemic years.
const ACS24 = acs.acs1yr2024 as { inCommuters: { total: number; modes: Record<'da' | 'sr' | 'transit' | 'walk' | 'other', number> }; residentsByPlaceOfWork_B08130: { commutersOutsideSF: number; outShareOfCommuters: number; modesOutsideSF: Record<string, number> } };
WORK_TARGET.ext = norm({ da: ACS24.inCommuters.modes.da, sr: ACS24.inCommuters.modes.sr, transit: ACS24.inCommuters.modes.transit, tnc: (ACS24.inCommuters.modes.other * 4017) / 6793 });
// the share of Muni's weekday boardings that follow another bus or train on the same trip (any
// operator), SFMTA 2017 Systemwide On-Board Survey, Table 8 (changes per one-way trip: none 75%,
// one 22%, two 2%, by boardings): 0.22/2 + 0.02·2/3 (od-validation.json muni2017TransfersBefore)
const XFER_TARGET = (JSON.parse(fs.readFileSync(`${REFERENCE}/od-validation.json`, 'utf8')).muni2017TransfersBefore?.system as number) ?? 0.123;
// residents, all trips: BATS 2023 linked shares (MTC's dashboard), and the linked total from the
// report's unlinked car trips (resident-targets.ts)
const RESIDENT_ALL: Shares = residentLinkedShares(JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8')));
const RESIDENT_TRIPS = residentLinkedTrips(JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-share.json`, 'utf8')).bats2023_sfResidents_allTrips_unlinked, RESIDENT_ALL);
/**
 * Residents' transit level against Muni's counts. Agency models (SF-CHAMP, TM1) set transit's level
 * by the boardings counted on the vehicles, not by the household survey, since diaries miss trips and
 * miss short transit trips most. The level is fitted to Muni's counted weekday boardings on the
 * counted routes together (SFMTA, the routes' 12-month mean; the route-by-route counts stay an
 * independent test): a factor on BATS 2023's transit share of residents' trips other than commutes and
 * school (residentTransitLevel), the other modes keeping BATS's split among themselves. Commutes keep
 * the ACS's shares and school travel its own counts. BATS's 13.8% is then a check. Boardings per
 * linked trip are not free: the weight on a change of lines stays fitted to the on-board survey's
 * 12.3% of boardings after another vehicle.
 */
function residentTarget(level: number): Shares {
  return transitScaled(RESIDENT_ALL, level);
}
/** shares with transit's times `level` (at most 60%), the other modes keeping their split */
function transitScaled(S: Shares, level: number): Shares {
  const t = S.transit ?? 0, tt = Math.min(0.6, t * level);
  return Object.fromEntries(MODES.map((m) => [m, m === 'transit' ? tt : ((S[m] ?? 0) * (1 - tt)) / (1 - t)]));
}
/**
 * Who rides Muni: the share of its riders living in the city, MTC's 2023–24 Snapshot survey
 * (od-validation.json snapshot; light rail and local bus, weighted by the counted boardings). The
 * dashboard's shares are of its questionnaires (about 1,430 on Muni), not expanded. Residents' Muni
 * boardings on the counted routes are fitted to the count times it, through residentTransitLevel;
 * non-residents' to the rest, through nonResTransitLevel on their trips within the city that have a
 * choice of their own (in-commuters' and visitors' trips not from home, hotel visitors' trips), their
 * trips across the city line keeping their targets (the ACS's, the regional visitors' BART fit).
 */
const SNAP_RES = (() => {
  const s = JSON.parse(fs.readFileSync(`${REFERENCE}/od-validation.json`, 'utf8')).snapshot;
  return { lr: s['SFMTA (Muni) -- Light Rail'].home_county['San Francisco'] as number, bus: s['SFMTA (Muni) -- Local Bus'].home_county['San Francisco'] as number };
})();
const AIRPORT_TARGET: Shares = norm({ tnc: 0.48, transit: 0.2, sr: 0.2, da: 0.12 });
const REGIONAL_TARGET: Shares = norm({ da: 0.42, sr: 0.3, transit: 0.25, tnc: 0.03 });
// how far trips go: NHTS 2017 means and shares of half a mile or less, by purpose and for stops by
// the tour's mode (trip-lengths.ts)
const LENGTHS = lengthTargets();
/**
 * Walking against distance: the shares of residents' trips of half a mile or less and of 1 to 2 road
 * miles from or to home that are walked, NHTS 2017 (dense tracts of the SF–Oakland metro, both ends
 * dense; nhts-transit-length.json homeBased): 87% and 17%. The walk constants fit how much residents
 * walk (BATS 2023); the factor on walking's minutes (walkTimeFactor) fits how fast walking falls off
 * between the two. Fitted to the aggregate share alone, the walk constants had half of the trips of 1
 * to 2 miles walked.
 */
/**
 * Residents' non-work constants move by at most this share of the log ratio of target to model shares
 * (the smaller of it and the step of every mode constant, 0.5 with trip mode choice). With trips next
 * to home (the near term of destination choice), walking's utility also moves where people go, and so
 * how many trips are short enough to walk: at full steps (1, with a running correction of the targets
 * at 0.7) the walk share swung between 27% and 39% from one iteration to the next, against BATS's 34%.
 */
const NONWORK_DAMP = 0.6;
const WALK_BY_DIST = (() => {
  const h = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-transit-length.json`, 'utf8')).homeBased.byBand as { dist: number[]; walk: number[]; sample: number[] };
  return { near: h.walk[0], mid: (h.walk[2] * h.dist[2] + h.walk[3] * h.dist[3]) / (h.dist[2] + h.dist[3]) };
})();
// BATS 2023: San Francisco adults' weekday trips by transit, by household income band (MTC's
// dashboard extract; sf-mode-by-area.json). The share's denominator is drive alone, shared ride,
// transit, walk, and bike, without ride-hail and other modes.
const BATS_INCOME = (() => {
  const t = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8')).batsDashboardSF.tables.mode5cat_label as Record<string, { modes: Record<string, { weightedShare: number }> }>;
  const band = ['1. Less than $50,000', '2. $50,000-$99,999', '3. $100,000-$199,999', '4. $200,000 or more'];
  const row = (k: string) => t[`2023 | 18 and over | ${k}`] as unknown as { totalWeightedTrips: number; modes: Record<string, { weightedShare: number }> };
  // the model's income classes (INCOME_CLASSES): each band's share weighted by its trips
  const bands = INCOME_CLASSES.map((bs) => {
    const w = bs.reduce((a, b) => a + row(band[b]).totalWeightedTrips, 0);
    return bs.reduce((a, b) => a + row(band[b]).modes['3. Transit'].weightedShare * row(band[b]).totalWeightedTrips, 0) / w;
  });
  // all households with an income band (the published all-incomes row also counts unreported ones)
  const tw = INCOME_CLASSES.map((bs) => bs.reduce((a, b) => a + row(band[b]).totalWeightedTrips, 0));
  const all = bands.reduce((a, v, c) => a + v * tw[c], 0) / tw.reduce((a, v) => a + v, 0);
  return { all, bands };
})();
// BATS 2023: San Francisco residents under 18, weekday linked trips by mode (MTC's dashboard extract;
// sf-mode-by-area.json, mode_label, all incomes). The model's youth don't drive or hail rides on their
// own, so driving (16- and 17-year-olds), ride-hail, and school buses count with shared ride.
const YOUTH_TARGET: Shares = (() => {
  const m = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8')).batsDashboardSF.tables.mode_label['2023 | Under 18 | All Income Levels'].modes as Record<string, { weightedShare: number }>;
  const g = (k: string) => m[k]?.weightedShare ?? 0;
  return norm({ sr: g('DA') + g('HOV2') + g('HOV3') + g('TNC') + g('SCHBUS') + g('OTHER'), transit: g('WALKTRAN') + g('DRIVETRAN'), walk: g('WALK'), bike: g('BIKE') });
})();
/**
 * BATS 2023's under-18 transit share as an interval, not a point: its 90% confidence interval from the
 * dashboard extract (WALKTRAN 10.4%, 5.9-14.9%, on 40 sampled transit trips). The share rests on few
 * trips, and its youth trips were reported by proxy: 121,621 a weekday in the city, against 324,000 at
 * NHTS rates, so the trips that teenagers make on their own, which are the ones most often by transit,
 * are the ones most likely missing. School trips, which SFMTA's Student Travel Tally of more than 10,000
 * pupils measures by grade, are fitted on their own (demand.ts fitStudents); the youth constant on other
 * tours keeps the total inside BATS's interval.
 */
const YOUTH_TRANSIT_CI = (() => {
  const m = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8')).batsDashboardSF.tables.mode_label['2023 | Under 18 | All Income Levels'].modes.WALKTRAN as { ci90: [number, number] };
  return m.ci90;
})();
/**
 * Adults' non-work trips by household cars (0, 1, 2+) in the NHTS 2017, residents of dense tracts of
 * the SF–Oakland metro (nhts-transit-length.json byVehicles; nhts_transit_length.py): the shape of the
 * non-work targets across the car segments. Drive alone and shared ride both take the car share
 * (their split stays the city's).
 */
const NONWORK_BY_CARS: Record<Mode, number>[] = (() => {
  const v = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-transit-length.json`, 'utf8')).byVehicles.nonwork as Record<string, number>[];
  return v.map((r) => ({ da: r.car, sr: r.car, tnc: r.tnc, transit: r.transit, walk: r.walk, bike: r.bike }));
})();
/**
 * The share of Muni's weekday riders whose trip is to or from school or college: MTC's 2023–24 Snapshot
 * survey (od-validation.json snapshot; 12.8% of light-rail and 15.6% of bus riders, all ages), the two
 * weighted by the counted boardings on the subway lines and the T and on the buses (SCHOOL_SHARE).
 */
const SNAP_SCHOOL = (() => {
  const snap = JSON.parse(fs.readFileSync(`${REFERENCE}/od-validation.json`, 'utf8')).snapshot;
  return { lr: snap['SFMTA (Muni) -- Light Rail'].trip_purpose_group.School as number, bus: snap['SFMTA (Muni) -- Local Bus'].trip_purpose_group.School as number };
})();
/**
 * The trips of residents' tours (trip mode choice conditional on tour mode): NHTS 2017, residents of
 * dense tracts, tours by the mode of the trip into their primary destination, the share of their other
 * trips (the trip back and those through stops) by mode (nhts-tripmode.json, nhts_tripmode.py). Each
 * is taken over the modes the tour's mode allows (TRIP_SWITCH), the model's likewise. The model's are
 * those of its tours by their own mode, the back leg and the stop legs; since the model's trip into
 * the primary destination is by the tour's mode, this is the survey's reading (also logged, by the
 * rule itself, as a check).
 */
const NHTS_TRIPS = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-tripmode.json`, 'utf8')).byTourMode as Record<string, { tours_sample: number; otherTrips: Shares; otherTripsUnder3mi: Shares; returnLeg: Shares; stopLegs: Shares; stopLegsByLength?: Record<string, Shares & { sample: number; weight: number }> }>;
/**
 * The stop legs' target at the model's own leg lengths: the NHTS shares by mode within each length
 * band (nhts_tripmode.py stopLegsByLength: up to ½ mile, ½ to 1½, over 1½; transit tours' stop legs are
 * 90% walked up to ½ mile and 1% walked over 1½), weighted by the model's legs in each band
 * (DemandResult.lengthBands, the transit tours' stop legs by road distance). Fitted to the survey's
 * all-length mix, the walk constant was fitted on the model's legs, which are shorter (its transit
 * tours' detours averaged 0.73 km against the NHTS's 1.04), and so rose to +5.9: legs the survey would
 * ride were walked.
 */
const stopTargetAtModelLengths = (M: Mode, lengthBands: Record<string, Float64Array>): Shares => {
  const byLen = NHTS_TRIPS[M]?.stopLegsByLength;
  if (!byLen) return NHTS_TRIPS[M].stopLegs;
  // LENGTH_BANDS_MI: ½, 1, 1½, 2, ... miles; bands 0, 1–2, and 3 on
  const w = [0, 0, 0];
  for (const [k, a] of Object.entries(lengthBands))
    if (k.startsWith('resident stop legs ') && k.endsWith(` ${M}`))
      for (let b = 0; b < a.length / 6; b++) for (let m = 0; m < 6; m++) w[b === 0 ? 0 : b <= 2 ? 1 : 2] += a[b * 6 + m];
  const W = w[0] + w[1] + w[2];
  if (!(W > 0)) return NHTS_TRIPS[M].stopLegs;
  const bands = ['upTo0.5mi', '0.5to1.5mi', 'over1.5mi'];
  const out: Shares = {};
  bands.forEach((b, i) => {
    for (const m of MODES) out[m] = (out[m] ?? 0) + (w[i] / W) * ((byLen[b]?.[m] as number | undefined) ?? 0);
  });
  return norm(out);
};
/**
 * Walking tours are compared on their trips under 3 miles: the model's walking tours go no farther
 * than a walk (6 km to the primary destination, 3 km to a stop), so their trips by transit are short
 * hops, while two-thirds of the survey's walking tours' trips by transit (by weight) are 3 miles or
 * longer, trips on to places the model reaches by tours of their own. Fitted to all of them, the walk tours' transit constant made too many short bus
 * rides (Muni bus trips 1.63 miles a boarding against NTD's 1.89).
 */
const tripTarget = (M: Mode): Shares => (M === 'walk' ? NHTS_TRIPS[M].otherTripsUnder3mi : NHTS_TRIPS[M].otherTrips);
const allowedOf = (M: Mode) => [M, ...TRIP_SWITCH.filter(([a]) => a === M).map(([, b]) => b)];
const sharesOver = (s: Shares, M: Mode): Shares => norm(Object.fromEntries(allowedOf(M).map((m) => [m, s[m] ?? 0])));
/**
 * The tour modes whose trips' constants are fitted: all of them. The NHTS has only 17 ride-hail tours,
 * so theirs are rough, but TM1's (walking +0.26 against the ride) let a ride-hail tour that walks
 * both legs carry the ride-hail tour constants: in a first run with them, before calibration, the
 * model's ride-hail tours walked 39% of their other trips against the survey's 9%.
 */
const TRIP_FIT = MODES.filter((M) => NHTS_TRIPS[M]?.tours_sample >= 15);

/**
 * Commute transit shares across the city line by county, on one 2024 basis. The level is the ACS 2024
 * 1-year tables' (acs-commute.json acs1yr2024: 34.0% of in-commuters, 23.7% of residents working
 * outside the city), the year of the flows (build.ts commuteSplit) and of every other commute target.
 * The pattern by county is the ACS 2020–24 PUMS's (commute-by-county.json), for counties with 3,000+
 * commuters, except in-commuters from San Mateo and Santa Clara counties, which take their own 2024
 * records (IN_2024_RAIL): the bus, BART, and commuter rail of 2024 scaled by the pooled ratio of all
 * transit (light rail and ferries too) to those three. Caltrain's riders more than doubled between the
 * pooled file's early years and FY2026, and in the 2024 records commuter rail carried 1.8 times the
 * pooled count from San Mateo County and 1.6 times from Santa Clara (commute-by-year.json); a uniform
 * shift of the pooled shares does not see that. The other counties' log odds are shifted together
 * (ERA_SHIFT.in) so that all in-commuters together keep the 2024 level, so neither county is shifted
 * twice; residents' commutes out are shifted to their 2024 level (ERA_SHIFT.out). ERA_SHIFT.in also
 * moves the PUMA targets, whose constants are centred within each county.
 */
const logitOf = (x: number) => Math.log(x / (1 - x));
const shifted = (x: number, d: number) => 1 / (1 + Math.exp(-(logitOf(x) + d)));
const IN_2024_RAIL = (() => {
  const j = JSON.parse(fs.readFileSync(`${REFERENCE}/commute-by-county.json`, 'utf8'));
  const y = JSON.parse(fs.readFileSync(`${REFERENCE}/commute-by-year.json`, 'utf8')).flows as Record<string, Record<string, Record<string, { workers: number }>>>;
  const out: Record<string, number> = {};
  for (const c of ['San Mateo', 'Santa Clara']) {
    const f = y[`${c} -> San Francisco`], r = j.toSF[c];
    const three = (k: string) => f.bus[k].workers + f.subway[k].workers + f.commuterRail[k].workers;
    const pooled3 = (f.bus.pooled as unknown as number) + (f.subway.pooled as unknown as number) + (f.commuterRail.pooled as unknown as number);
    out[c] = (three('2024') / f.all['2024'].workers) * (r.transit / pooled3);
  }
  return out;
})();
const ERA_SHIFT = (() => {
  const j = JSON.parse(fs.readFileSync(`${REFERENCE}/commute-by-county.json`, 'utf8'));
  const rows = (o: Record<string, { total: number; wfh: number; transit: number }>) => Object.entries(o).filter(([c]) => c !== 'San Francisco').map(([c, r]) => ({ c, n: r.total - r.wfh, s: r.transit / Math.max(1, r.total - r.wfh) }));
  /** the shift d of the counties' log odds that brings the commuter-weighted share to `level`, the counties in `fixed` held at their own */
  const solve = (R: { c: string; n: number; s: number }[], level: number, fixed: Record<string, number> = {}) => {
    const N = R.reduce((a, r) => a + r.n, 0);
    const at = (d: number) => R.reduce((a, r) => a + r.n * (fixed[r.c] ?? (r.s > 0 && r.s < 1 ? shifted(r.s, d) : r.s)), 0) / N - level;
    let lo = -3, hi = 3;
    for (let k = 0; k < 60; k++) {
      const m = (lo + hi) / 2;
      if (at(m) > 0) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  };
  const out24 = ACS24.residentsByPlaceOfWork_B08130.modesOutsideSF.transit / ACS24.residentsByPlaceOfWork_B08130.commutersOutsideSF;
  return { in: solve(rows(j.toSF), WORK_TARGET.ext.transit!, IN_2024_RAIL), out: solve(rows(j.fromSF), out24) };
})();
const COUNTY_TARGET = (() => {
  const j = JSON.parse(fs.readFileSync(`${REFERENCE}/commute-by-county.json`, 'utf8'));
  const share = (r: { total: number; wfh: number; transit: number }) => r.transit / (r.total - r.wfh);
  const pick = (o: Record<string, { total: number; wfh: number; transit: number }>, d: number) =>
    Object.fromEntries(Object.entries(o).filter(([c, r]) => c !== 'San Francisco' && !/^other|^outside/.test(c) && r.total - r.wfh >= 3000).map(([c, r]) => [c, shifted(share(r), d)]));
  return { in: { ...pick(j.toSF, ERA_SHIFT.in), ...IN_2024_RAIL }, out: pick(j.fromSF, ERA_SHIFT.out) };
})();

const shareOf = (r: Record<Mode, number>): Shares => {
  const t = MODES.reduce((a, m) => a + r[m], 0);
  return Object.fromEntries(MODES.map((m) => [m, t > 0 ? r[m] / t : 0]));
};

/** move constants by the log ratio of target to model share (drive alone stays the reference) */
function adjust(asc: Partial<Record<Mode, number>>, model: Shares, target: Shares, damp = 1) {
  for (const m of MODES) {
    if (m === 'da') continue;
    const t = target[m] ?? 0, s = model[m] ?? 0;
    if (t <= 0 || s <= 0) {
      if (t <= 0 && s > 0) asc[m] = (asc[m] ?? 0) - 1;
      continue;
    }
    asc[m] = (asc[m] ?? 0) + damp * Math.log(t / s);
  }
  // keep drive alone at zero: when a segment never drives (targets da > 0 but model 0) nothing to do
  if ((target.da ?? 0) > 0 && (model.da ?? 0) > 0) {
    const shift = -damp * Math.log((target.da ?? 0) / (model.da ?? 1));
    for (const m of MODES) if (m !== 'da') asc[m] = (asc[m] ?? 0) + shift;
  }
}

/**
 * Weekday ferry boardings on the commuter routes into San Francisco (ferry-ridership.json): SF Bay
 * Ferry FY2026 by route (Vallejo, Oakland & Alameda, Alameda Seaplane, Harbor Bay, Richmond), and
 * Larkspur at its share of Golden Gate Ferry's annual riders times the FY2025 weekday average (a
 * lower bound, since Larkspur is the commute route). Left out: South San Francisco and the
 * Oakland–Alameda shuttle (they don't reach the city), event boats, and the Sausalito, Tiburon, and
 * Angel Island routes, which have no weekday counts and carry many sightseers.
 */
const FERRY_ROUTES = new Set(['VJO', 'OA', 'SEA', 'HB', 'RCH', 'LSSF']);
/** AC Transit's Transbay lines into the city: FY2025 average weekday, the San Francisco lines' sum (AC Transit route performance report; station-parking.json) */
const AC_TRANSBAY_OBS = JSON.parse(fs.readFileSync(`${REFERENCE}/station-parking.json`, 'utf8')).acTransbay.totals_routeSums.fy2025_avgWeekday.sanFranciscoLinesOnly_routeSum as number;
const FERRY_OBS = (() => {
  const f = JSON.parse(fs.readFileSync(`${REFERENCE}/ferry-ridership.json`, 'utf8'));
  const sfbf = f.sfBayFerry.FY2026.coreSFRoutesAvgWeekdaySum as number;
  const gg = f.goldenGateFerry.statisticsPage.byFY.FY2025;
  return sfbf + Math.round((gg.annualByRoute.Larkspur / gg.annualAll) * gg.avgWeekdayAll);
})();

/** observed park visits (annual → per weekday) and acreage, from park-visitation.json */
const PARK_TARGETS = (() => {
  const pv = JSON.parse(fs.readFileSync(`${REFERENCE}/park-visitation.json`, 'utf8'));
  const annual = (re: RegExp) => pv.parks.find((p: { name: string; annualVisits: number | null }) => re.test(p.name) && p.annualVisits)?.annualVisits as number;
  const museums = (pv.attractions as { name: string; annualVisits?: number }[]).filter((a) => /Academy|de Young|Conservatory|Tea Garden|Botanical/.test(a.name)).reduce((s, a) => s + (a.annualVisits ?? 0), 0);
  const perWeekday = (y: number) => y / 365 / 1.06;
  return [
    // own: a special generator with its own factor; fit: weight in fitting the general size term
    { name: 'Golden Gate Park', acres: 1023, perWeekday: perWeekday(annual(/^Golden Gate Park$/) - museums), own: true, fit: 1 },
    { name: 'Presidio of San Francisco', acres: 1501, perWeekday: perWeekday(annual(/^Presidio of San Francisco$/)), own: true, fit: 1 },
    { name: 'Fort Funston', acres: 182, perWeekday: perWeekday(annual(/^Fort Funston/)), own: true, fit: 0 },
    // newspaper figure only: up to 3,000 on a weekday (SF Chronicle, 2016)
    { name: 'Mission Dolores Park', acres: 16, perWeekday: 3000, own: false, fit: 0.5 },
  ];
})();

/** all-weekday average / mid-week (Tue–Thu) ridership, from Caltrain's FY2026 figures */
function caltrainWeekdayFactor(): number {
  const c = JSON.parse(fs.readFileSync(`${REFERENCE}/caltrain-ridership.json`, 'utf8'));
  return c.systemwide.avgWeekdayRidershipFY2026 / (c.stations as { amwrFY2026?: number }[]).reduce((a, s) => a + (s.amwrFY2026 ?? 0), 0);
}

/**
 * Where the city's commuters work, in the model year: the share of San Francisco's residents who
 * commute (not working at home) whose workplace is in each outside county, from the 2024 records of the
 * ACS 2020-24 PUMS (commute-by-year.json), for the counties with 100 or more records that year (San
 * Mateo 482, Santa Clara 286, Alameda 149). The model's flows are LODES 2023 primary jobs less the
 * city's work-at-home rate applied to every flow alike, which put 7.5% of the city's commuters in San
 * Mateo County and 4.9% in Santa Clara (ACS 2024: 13.5% and 7.7%; pooled 2020-24: 12.5% and 5.8%) and
 * 5.3% in Alameda (3.7%): too few reverse commuters on the Peninsula, whose morning trains out of the
 * city carried 15% of the city stations' departures in the model against 34% in Caltrain's 2024 OD
 * survey. The pooled file's 2020-21 years had a third fewer commuters to Santa Clara.
 * One 2024 basis: the total leaving the city is the ACS 2024 1-year tables' (B08130, 28.2%, the share
 * build.ts commuteSplit gives the flows); these records only divide it among the counties. Their own
 * total (28.1%) is scaled to it, and the other outside counties together ('*') take the rest, so no
 * county's flows are moved twice and the total stays B08130's.
 */
const OUT_2024 = (() => {
  const j = JSON.parse(fs.readFileSync(`${REFERENCE}/commute-by-year.json`, 'utf8'));
  const all = j.sfCommutersInCalifornia['2024'] as number;
  const flows = j.flows as Record<string, { all: Record<string, { workers: number; records: number }> }>;
  const pumsOut = 1 - flows['San Francisco -> San Francisco'].all['2024'].workers / all;
  const k = ACS24.residentsByPlaceOfWork_B08130.outShareOfCommuters / pumsOut;
  const out: Record<string, number> = {};
  let named = 0;
  for (const [key, v] of Object.entries(flows)) {
    const m = /^San Francisco -> (.+)$/.exec(key);
    if (!m || m[1] === 'San Francisco' || v.all['2024'].records < 100) continue;
    out[m[1]] = (k * v.all['2024'].workers) / all;
    named += out[m[1]];
  }
  out['*'] = ACS24.residentsByPlaceOfWork_B08130.outShareOfCommuters - named;
  return out;
})();

/**
 * Caltrain's riders on Giants home weekdays: 45,864 systemwide against 41,603 when the Giants are away
 * (FY2026, Caltrain's annual ridership presentation, p. 12), so 4,261 more boardings on each home
 * weekday; over the year's 54 weekday home games (40 evening, 14 day; special-events.json) among its
 * weekdays, the extra boardings on the average weekday that Oracle Park's attendees make. Attendees
 * from San Mateo and Santa Clara counties have a transit constant of their own (calib.eventSouthTransit)
 * fitted to it, with the venue's transit constant still fitted to the Giants' 45%: with the Warriors'
 * market-study origins (28% from the South Bay) and the venue constant alone, event-goers made about
 * 3,650 of Caltrain's boardings and alightings in the city on the average weekday.
 */
const GIANTS_CALTRAIN = giantsCaltrain();

/** the shared-vehicle fit's damping by iteration (fitMicro) */
const damp0 = (it: number) => (it < 3 ? 0.8 : 1);

async function main() {
  TRIP_MIX.on = true;
  EVENT_OD.venue = 'Oracle Park';
  NONRES_OD.on = true;
  const b = loadBundle();
  // hotel visitors: SF Planning's 2017 door surveys at hotels, weighted by the rooms in each place type
  const VT = visitorTarget(b.header.zones);
  const VISITOR_TARGET: Shares = norm(VT.target);
  console.log(`hotel visitors' target: ${Object.entries(VISITOR_TARGET).map(([m, v]) => `${m} ${(100 * (v ?? 0)).toFixed(1)}`).join(' ')} (rooms by place type ${Object.entries(VT.roomShare).map(([t, v]) => `${t}: ${(100 * v).toFixed(0)}%`).join(', ')})`);
  const prep = prepare(b);
  const calib: Calibration = JSON.parse(JSON.stringify(b.header.calibration ?? DEFAULT_CALIB));
  // residents' commutes to the outside counties (OUT_2024): the flows' factors, solved directly, since
  // where commuters work does not depend on how they travel
  {
    const f = (calib.outCommuteFactor ??= {});
    for (const c of Object.keys(OUT_2024)) f[c] ??= 1;
    for (let k = 0; k < 30; k++) {
      const sh = outCommuteShares(b, calib);
      for (const [c, t] of Object.entries(OUT_2024)) if (sh[c] > 0) f[c] = Math.max(0.2, Math.min(5, (f[c] ?? 1) * t / sh[c]));
    }
    const sh = outCommuteShares(b, calib);
    calib.outCommuteFit = Object.fromEntries(Object.entries(OUT_2024).map(([c, t]) => [c, [+(sh[c] ?? 0).toFixed(4), +t.toFixed(4)]]));
    console.log(`commuters working outside the city (model/ACS 2024): ${Object.entries(OUT_2024).map(([c, t]) => `${c} ${(100 * (sh[c] ?? 0)).toFixed(1)}/${(100 * t).toFixed(1)}% (×${f[c].toFixed(2)})`).join(', ')}`);
  }
  calib.asc ??= {};
  calib.distCoef ??= {};
  const scenario: Scenario = { name: 'Today', edits: [] };
  const exec = new LocalExecutor(b, scenario, calib);

  // skims do not depend on the constants; compute once (uncrowded), recompute with crowding at the end
  console.time('skims');
  const sk = {} as TrnSkims;
  // crowding: the delivered runs include it, so calibration does too. Start from the last baseline's
  // crowding when it fits this network, and refresh it with a full model pass every six iterations.
  let crowd: Partial<Record<TPeriod, Float32Array[]>> | undefined;
  // a run's crowding is kept by bundle line; the network wants it by its own lines
  const toNet = (fc: RunResult['finalCrowd']) => {
    if (!fc) return undefined;
    const out: Partial<Record<TPeriod, Float32Array[]>> = {};
    for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[])
      out[p] = exec.net(p).lines.map((l) => {
        const c = l.src >= 0 ? fc[p]?.[l.src] : undefined;
        // hops' crowding, and (when saved) the stops' boarding availability after them (net.ts boardAvail)
        return c && (c.length === l.stops.length - 1 || c.length === 2 * l.stops.length - 1 || c.length === 4 * l.stops.length - 1) ? c : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1);
      });
    return out;
  };
  {
    const f = `${BUNDLE}/base.bin.gz`;
    if (fs.existsSync(f)) crowd = toNet(decodeResult(zlib.gunzipSync(fs.readFileSync(f))).finalCrowd);
    console.log(crowd ? 'crowding: from the last baseline' : 'crowding: none to start');
  }
  // park-and-ride shadow prices (model.ts): the calibration's, refreshed with the crowding
  const lotArr = () => {
    const a = new Float32Array(b.header.stops.length);
    for (const [s, v] of Object.entries(calib.lotPrice ?? {})) a[Number(s)] = v;
    return a.some((v) => v > 0) ? a : undefined;
  };
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, crowd?.[p], lotArr());
  console.timeEnd('skims');

  const sfBart = b.header.observed.bartStations.filter((st) => st.stop !== null && b.header.stops[st.stop].lat > 37.7 && b.header.stops[st.stop].lon < -122.38);
  // the regional visitors' rate is fitted to the city stations' exits over the whole weekday. The exits at
  // midday and at night (10am–3pm and 7pm–6am; those periods' share of each station's weekday exits from
  // BART's 2025 hourly station-to-station counts, regional-od.json, applied to the August 2026 exits) are
  // a check: fitted to them (October 2026), the rate fell from 0.25 to 0.19, since the model's other
  // riders already leave the city's stations at those hours a little more often than counted (30,600
  // against 29,800), and Muni lost the visitors' rides
  const offPeakShare = (() => {
    const R = readRegional().bart;
    let off = 0, all = 0;
    for (const st of sfBart) {
      const j = R.codes.indexOf(st.code);
      if (j < 0) continue;
      for (const p of ['AM', 'MD', 'PM', 'NT'] as const) {
        const M = R.od.wkd[p];
        let x = 0;
        for (let i = 0; i < M.length; i++) if (i !== j) x += M[i][j];
        all += x;
        if (p === 'MD' || p === 'NT') off += x;
      }
    }
    return all > 0 ? off / all : 0.4;
  })();
  const bartObs = sfBart.reduce((a, s) => a + s.exits, 0);
  const bartObsOff = bartObs * offPeakShare;
  const ITER = Number(process.argv[2] ?? 14);
  const day0Done = false;
  // the ferry and Caltrain in-vehicle factors carry on from the last calibration (TM1's 0.8 and 0.7
  // the first time); Caltrain's one-sided path penalty is no longer used
  // light rail keeps TM1's 0.9: a factor on its minutes fitted to the Metro count drew long trips off
  // BART and made Metro trips too long (2.85 miles a boarding against NTD's 2.34), so Metro against
  // the buses is fitted by a penalty per ride instead (below)
  calib.ivtFactor = { ferry: calib.ivtFactor?.ferry ?? 0.8, caltrain: calib.ivtFactor?.caltrain ?? 0.7 };
  calib.modeBias.caltrain = 0;
  // Caltrain: SF stations' mid-week (Tue–Thu) boardings, scaled to an all-weekday average by Caltrain's
  // own ratio, systemwide average weekday riders / the stations' mid-week sum (caltrainWeekdayFactor)
  const caltrainSF = new Set(b.header.observed.caltrainStations.filter((s) => s.stop !== null && ['San Francisco', '22nd Street', 'Bayshore'].includes(s.name)).map((s) => s.stop!));
  const caltrainObs = b.header.observed.caltrainStations.filter((s) => s.stop !== null && caltrainSF.has(s.stop)).reduce((a, s) => a + s.boardings, 0) * caltrainWeekdayFactor();
  // the direction of Caltrain commuting at the city's stations (station-od.ts caltrainCityDirection,
  // from the 2024 OD survey and the 2025 customer survey)
  const caltrainCity = new Set(b.header.observed.caltrainStations.filter((s) => s.stop !== null && ['San Francisco', '22nd Street'].includes(s.name)).map((s) => s.stop!));
  const CALTRAIN_DIR = caltrainCityDirection();
  const METRO = new Set(['J', 'K', 'L', 'M', 'N', 'T', 'S']);
  const obsRoutes = new Set(b.header.observed.muniRoutes.map((r) => r.route));
  const metroObs = b.header.observed.muniRoutes.filter((r) => METRO.has(r.route)).reduce((a, r) => a + r.boardings, 0);
  // the rail-against-bus preference is fitted on the Market Street subway lines; the T (Central
  // Subway and Third Street) is left out, so its own miss does not set a penalty on every bus
  const SUBWAY = new Set(['J', 'K', 'L', 'M', 'N']);
  const subwayObs = b.header.observed.muniRoutes.filter((r) => SUBWAY.has(r.route)).reduce((a, r) => a + r.boardings, 0);
  const busObs = b.header.observed.muniRoutes.filter((r) => !METRO.has(r.route)).reduce((a, r) => a + r.boardings, 0);
  const SCHOOL_SHARE = (SNAP_SCHOOL.lr * metroObs + SNAP_SCHOOL.bus * busObs) / (metroObs + busObs);
  // in-commuters' transit share by home PUMA: targets and each outside zone's PUMAs
  const PUMA = (() => {
    const R = readOdRef().inCommutersByPuma;
    if (!R) return null;
    const targets = R.pumas.filter((p) => p.commuters >= 1500 && (p as { transitShareSE?: number }).transitShareSE! < 0.06).map((p) => [p.puma, shifted(p.transitShare, ERA_SHIFT.in)] as [string, number]);
    return { targets, weights: extPumaWeights(b, R) };
  })();
  // Muni boardings on the counted routes per linked transit trip, from the last assignment
  // (carried over from the last calibration, so the Muni level is fitted from the first pass)
  let muniPerTrip = calib.muniPerTrip ?? 0;
  const muniCounted = metroObs + busObs;
  const muniResTarget = SNAP_RES.lr * metroObs + SNAP_RES.bus * busObs, muniNrTarget = muniCounted - muniResTarget;
  // boardings on the counted routes per linked transit trip, residents' and non-residents', from the last assignment
  let perTripRes = calib.muniPerTripRes ?? 0, perTripNr = calib.muniPerTripNonRes ?? 0;
  const odSum = (od?: Record<TPeriod, Float32Array>) => (od ? TPERIODS.reduce((a, p) => a + od[p].reduce((x: number, v: number) => x + v, 0), 0) : 0);
  // shared bikes and scooters: the last assignment's rides to and from stations (micromob-diag.ts)
  let microAcc: MicroAccess | null = null;
  let microLine = '';
  for (let it = 0; it < ITER; it++) {
    const d = computeDemand(b, prep, sk, calib);
    // shared bikes and scooters: their constants against Bay Wheels' and SFMTA's counts (the bike
    // targets, which count them as cycling, are fitted as before)
    microLine = fitMicro(calib, d.micro, microAcc, damp0(it), { b, zoneWork: d.zoneWork });
    // ...and before anything else, the bias on riding to stations, which the skims carry
    if (it === 0 && d.micro) {
      console.log(await fitMicroAccess(b, scenario, calib, exec, d.transitOD.AM, crowd?.AM, lotArr(), 6));
      for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, crowd?.[p], lotArr());
    }
    // half steps: with trip mode choice a tour mode is a close substitute for the modes its trips may
    // use (a bike tour that walks a short leg, a drive-alone tour that picks someone up), so tours
    // answer their constants more strongly, and the full steps used before oscillated (the share of
    // youth trips by bike swung between 1% and 58%)
    const damp = 0.5;
    // commutes
    for (const s of [...SEGMENTS, 'ext']) {
      calib.asc.work ??= {};
      calib.asc.work[s] ??= {};
      // the ACS counts private shuttle riders as bus commuters
      const w = d.workBySeg[s], sh = d.shuttleBySeg[s] ?? 0;
      adjust(calib.asc.work[s], shareOf(sh ? { ...w, transit: w.transit + sh } : w), WORK_TARGET[s], damp);
    }
    // commutes across the city line, by county: into the city by home county (re-centred, so the
    // in-commuters' constant keeps the overall level), out of it by work county (shuttles count as
    // transit, as in the ACS)
    {
      const ct = (calib.countyTransit ??= { in: {}, out: {} });
      const logit = (x: number) => Math.log(Math.min(0.97, Math.max(0.005, x)) / (1 - Math.min(0.97, Math.max(0.005, x))));
      const tot = (r: Record<Mode, number>) => MODES.reduce((a, m) => a + r[m], 0);
      let wsum = 0, csum = 0;
      for (const [c, target] of Object.entries(COUNTY_TARGET.in)) {
        const r = d.workIn[c];
        if (!r || tot(r) <= 0) continue;
        ct.in![c] = Math.max(-3, Math.min(3, (ct.in![c] ?? 0) + 0.7 * (logit(target) - logit(r.transit / tot(r)))));
        wsum += tot(r);
        csum += tot(r) * ct.in![c];
      }
      // recentred, then held within the bounds (a county without a usable transit path, such as Sonoma
      // without SMART, would otherwise run on past them)
      if (wsum > 0) for (const c of Object.keys(ct.in!)) ct.in![c] = Math.max(-3, Math.min(3, ct.in![c] - csum / wsum));
      for (const [c, target] of Object.entries(COUNTY_TARGET.out)) {
        const r = d.workOut[c];
        if (!r || tot(r) <= 0) continue;
        const sh = d.shuttleOut[c] ?? 0;
        ct.out![c] = Math.max(-3, Math.min(3, (ct.out![c] ?? 0) + 0.7 * (logit(target) - logit((r.transit + sh) / (tot(r) + sh)))));
      }
      // the fit as it stands (model share, target), for the paper
      const shareIn = (c: string) => (d.workIn[c] && tot(d.workIn[c]) > 0 ? d.workIn[c].transit / tot(d.workIn[c]) : 0);
      const shareOut = (c: string) => (d.workOut[c] ? (d.workOut[c].transit + (d.shuttleOut[c] ?? 0)) / (tot(d.workOut[c]) + (d.shuttleOut[c] ?? 0)) : 0);
      calib.countyFit = {
        in: Object.fromEntries(Object.entries(COUNTY_TARGET.in).map(([c, t]) => [c, [shareIn(c), t]])),
        out: Object.fromEntries(Object.entries(COUNTY_TARGET.out).map(([c, t]) => [c, [shareOut(c), t]])),
      };
      if (it === ITER - 1 || it % 4 === 0)
        console.log(`county transit: in ${Object.entries(COUNTY_TARGET.in).map(([c, t]) => `${c} ${(100 * (d.workIn[c] ? d.workIn[c].transit / tot(d.workIn[c]) : 0)).toFixed(0)}/${(100 * t).toFixed(0)}%`).join(', ')} | out ${Object.entries(COUNTY_TARGET.out).map(([c, t]) => `${c} ${(100 * (d.workOut[c] ? (d.workOut[c].transit + (d.shuttleOut[c] ?? 0)) / (tot(d.workOut[c]) + (d.shuttleOut[c] ?? 0)) : 0)).toFixed(0)}/${(100 * t).toFixed(0)}%`).join(', ')}`);
    }
    // in-commuters by home PUMA (ACS 2020–24 PUMS, od-validation.json): within a county, the transit
    // share falls from the inner East Bay to its outer suburbs far more than a county constant allows,
    // which put too few BART riders on the Oakland–Berkeley and Richmond lines and too many on the
    // Fremont, Dublin, and Concord lines. A constant by PUMA (re-centred within its county, so the
    // county constants keep the county totals) for PUMAs with 1,500+ commuters and a standard error
    // of the share under 6 points; BART's station-to-station counts stay an independent test.
    if (PUMA) {
      const pc = (calib.pumaTransit ??= {});
      const logit = (x: number) => Math.log(Math.min(0.97, Math.max(0.01, x)) / (1 - Math.min(0.97, Math.max(0.01, x))));
      const all = new Map<string, number>(), tr = new Map<string, number>();
      PUMA.weights.forEach((m, e) => {
        for (const [q, w] of m) {
          all.set(q, (all.get(q) ?? 0) + w * d.workInZone[2 * e]);
          tr.set(q, (tr.get(q) ?? 0) + w * d.workInZone[2 * e + 1]);
        }
      });
      const fit: Record<string, [number, number]> = {};
      for (const [q, t] of PUMA.targets) {
        const a = all.get(q) ?? 0;
        if (a <= 0) continue;
        const m = (tr.get(q) ?? 0) / a;
        fit[q] = [m, t];
        pc[q] = Math.max(-1.5, Math.min(1.5, (pc[q] ?? 0) + 0.7 * (logit(t) - logit(m))));
      }
      // re-centre within each county, weighted by the model's commuters
      const byCounty = new Map<string, [number, number]>();
      for (const q of Object.keys(pc)) {
        const c = q.slice(0, 3), a = all.get(q) ?? 0, e = byCounty.get(c) ?? [0, 0];
        byCounty.set(c, [e[0] + a * pc[q], e[1] + a]);
      }
      for (const q of Object.keys(pc)) {
        const e = byCounty.get(q.slice(0, 3))!;
        if (e[1] > 0) pc[q] -= e[0] / e[1];
      }
      calib.extTransit = Object.fromEntries(b.header.ext.map((x, e) => [x.id, +[...PUMA.weights[e]].reduce((a, [q, w]) => a + w * (pc[q] ?? 0), 0).toFixed(4)]));
      calib.pumaFit = fit;
      if (it === ITER - 1 || it % 4 === 0) {
        const err = Object.values(fit).map(([m, t]) => Math.abs(m - t));
        console.log(`PUMA transit (in-commuters): mean abs error ${(100 * err.reduce((a, v) => a + v, 0) / Math.max(1, err.length)).toFixed(1)} points over ${err.length} PUMAs`);
      }
    }
    // how many trips: residents' non-work tours scaled so their trips total BATS 2023's (NHTS 2017's
    // rates are for the whole metro, before the pandemic)
    {
      const tot = MODES.reduce((a, m) => a + d.residentTrips[m], 0);
      calib.tourRateFactor = Math.max(0.5, Math.min(2, (calib.tourRateFactor ?? 1) * (RESIDENT_TRIPS / tot) ** 0.8));
      if (it === ITER - 1 || it % 4 === 0) console.log(`residents' trips ${Math.round(tot)} / BATS ${Math.round(RESIDENT_TRIPS)} → tour rate ×${calib.tourRateFactor.toFixed(3)}`);
    }
    // non-work: resident totals should match BATS once commutes are included; segments keep the ACS pattern
    const resAll = d.residentTrips;
    const resTot = MODES.reduce((a, m) => a + resAll[m], 0);
    const work = MODES.reduce((acc, m) => ((acc[m] = SEGMENTS.reduce((a, s) => a + d.workBySeg[s][m], 0)), acc), {} as Record<Mode, number>);
    const workTot = MODES.reduce((a, m) => a + work[m], 0);
    // school and college tours have constants of their own (fit to SFUSD's pupils; commuters' for
    // college), so the non-work target is what is left after them too
    const stud = d.studentTrips, studTot = MODES.reduce((a, m) => a + stud[m], 0);
    // the transit level: Muni's boardings on the counted routes, as the linked transit trips times the
    // last assignment's boardings per trip, against the counts (residentTarget)
    let levelLine = '';
    if (perTripRes > 0 && perTripNr > 0) {
      const nrTrips = odSum(d.nonResTransitOD), resTrips = d.trips.transit - nrTrips;
      const resEst = perTripRes * resTrips, nrEst = perTripNr * nrTrips;
      const lv = (x: number | undefined, r: number) => Math.max(0.8, Math.min(2, (x ?? 1) * r ** 0.5));
      calib.residentTransitLevel = lv(calib.residentTransitLevel, muniResTarget / resEst);
      calib.nonResTransitLevel = lv(calib.nonResTransitLevel, muniNrTarget / nrEst);
      calib.muniLevelFit = { residents: [resEst, muniResTarget], nonResidents: [nrEst, muniNrTarget] };
      const bound = (x: number) => (x <= 0.8 || x >= 2 ? ' AT BOUND' : '');
      levelLine = ` | Muni counted routes residents ${Math.round(resEst)}/${Math.round(muniResTarget)} → transit ×${calib.residentTransitLevel.toFixed(3)}${bound(calib.residentTransitLevel)} (BATS ${(100 * (RESIDENT_ALL.transit ?? 0)).toFixed(1)}%, a check), non-residents ${Math.round(nrEst)}/${Math.round(muniNrTarget)} → within the city ×${calib.nonResTransitLevel.toFixed(3)}${bound(calib.nonResTransitLevel)}`;
    }
    const RES = residentTarget(calib.residentTransitLevel ?? 1);
    const NR = calib.nonResTransitLevel ?? 1;
    const nonwork0: Shares = norm(Object.fromEntries(MODES.map((m) => [m, Math.max(0.002, (RES[m] ?? 0) * resTot - work[m] - stud[m]) / (resTot - workTot - studTot)])));
    // BATS counts trips; the constants act on the primary legs of tours, while the rest of residents'
    // non-work trips (stop legs, where a transit tour walks its short ones; subtours; trips not from
    // home) have a mix of their own. The correction by mode is the model's own ratio of the non-work
    // primary legs' share to the share of all residents' trips other than commutes and school, so
    // primary legs at nonwork0 × that ratio make all of them come out at nonwork0. It is read off each
    // pass, not summed over passes: summed (a running correction, 0.35 of the log gap a pass), it was
    // a second integrator on top of the constants' own steps and overshot. Residents' walk share rose
    // from 28% to 36.3% against BATS's 34% and took two further calibrations to come back, and the
    // walk share at 1 to 2 miles, whose slope against distance the walk time factor fits but whose
    // level the walk constants set, went from 13% to 23% with it.
    const corr = (calib.residentCorrection ??= {});
    {
      const prim = MODES.reduce((acc, m) => ((acc[m] = SEGMENTS.reduce((a, s) => a + d.nonworkBySeg[s][m], 0)), acc), {} as Record<Mode, number>);
      const rest = MODES.reduce((acc, m) => ((acc[m] = Math.max(1e-6, resAll[m] - work[m] - stud[m])), acc), {} as Record<Mode, number>);
      const sp = shareOf(prim), sr = shareOf(rest);
      for (const m of MODES) {
        const q = Math.log(Math.max(1e-4, sp[m] ?? 0) / Math.max(1e-4, sr[m] ?? 0));
        // lightly smoothed (half the old value), so one pass's noise doesn't move the targets
        corr[m] = Math.max(-1.5, Math.min(1.5, corr[m] === undefined || it === 0 ? q : 0.5 * corr[m] + 0.5 * q));
      }
    }
    const nonwork: Shares = norm(Object.fromEntries(MODES.map((m) => [m, (nonwork0[m] ?? 0) * Math.exp(corr[m] ?? 0)])));
    calib.asc.nonwork ??= {};
    // tilt the non-work target for each car segment by how adults' non-work trips in households with
    // no car, one, and two or more differ in the NHTS (NONWORK_BY_CARS), relative to the mean over the
    // model's own mix of segments. (It used to be the square root of how the segment's commutes differ
    // in the ACS: households without a car then rode transit on 1.25 times the city's non-work share,
    // where the NHTS has them at 4.5 times that of one-car households.)
    const segTrips = SEGMENTS.map((s) => MODES.reduce((a, m) => a + d.nonworkBySeg[s][m], 0));
    const segAll = segTrips.reduce((a, v) => a + v, 0);
    const meanNhts = (m: Mode) => SEGMENTS.reduce((a, _s, k) => a + (segTrips[k] / segAll) * NONWORK_BY_CARS[k][m], 0);
    SEGMENTS.forEach((s, k) => {
      calib.asc.nonwork![s] ??= {};
      const t: Shares = norm(Object.fromEntries(MODES.map((m) => [m, (nonwork[m] ?? 0) * (NONWORK_BY_CARS[k][m] / meanNhts(m))])));
      adjust(calib.asc.nonwork![s], shareOf(d.nonworkBySeg[s]), t, Math.min(NONWORK_DAMP, damp));
    });
    // trips not from home that have their own choice (in-commuters' and visitors'; residents' come
    // from their tours) use the one-car constants
    calib.asc.nhb ??= { car1: {} };
    // (BATS's split for residents, at non-residents' own transit level)
    {
      const nonworkBats: Shares = norm(Object.fromEntries(MODES.map((m) => [m, Math.max(0.002, (RESIDENT_ALL[m] ?? 0) * resTot - work[m] - stud[m]) / (resTot - workTot - studTot)])));
      adjust((calib.asc.nhb.car1 ??= {}), shareOf(d.nhbPool), transitScaled(nonworkBats, NR), damp);
    }
    calib.asc.visitor ??= { visitor: {} };
    adjust((calib.asc.visitor.visitor ??= {}), shareOf(d.byPurpose.visitor), transitScaled(VISITOR_TARGET, NR), damp);
    calib.asc.airport ??= { visitor: {} };
    adjust((calib.asc.airport.visitor ??= {}), shareOf(d.byPurpose.airport), AIRPORT_TARGET, damp);
    calib.asc.regional ??= { ext: {} };
    adjust((calib.asc.regional.ext ??= {}), shareOf(d.byPurpose.regional), REGIONAL_TARGET, damp);
    // transit by home neighbourhood: ACS commute shares (5-year, by block group) relative to the city
    {
      const H = b.header;
      const acsN = new Map<string, [number, number]>(), modN = new Map<string, [number, number]>();
      H.zones.forEach((z, i) => {
        const c = z.commute;
        const trn = c[2] + c[3] + c[4] + c[5] + c[6], commuters = c.reduce((a, v) => a + v, 0) - c[12];
        const a = acsN.get(z.nhood) ?? [0, 0];
        acsN.set(z.nhood, [a[0] + trn, a[1] + commuters]);
        const m = modN.get(z.nhood) ?? [0, 0];
        modN.set(z.nhood, [m[0] + d.zoneWorkTransit[i], m[1] + d.zoneWork[i]]);
      });
      const cityA = [...acsN.values()].reduce((a, v) => [a[0] + v[0], a[1] + v[1]], [0, 0]);
      const cityM = [...modN.values()].reduce((a, v) => [a[0] + v[0], a[1] + v[1]], [0, 0]);
      const logit = (p: number) => Math.log(p / (1 - p));
      calib.nhoodTransit ??= {};
      for (const [n, [at, ac]] of acsN) {
        const [mt, mc] = modN.get(n) ?? [0, 0];
        // too few commuters for a stable share: leave the neighbourhood at the city level
        if (ac < 800 || mc < 50) continue;
        const target = Math.min(0.9, Math.max(0.02, (at / ac) * (cityM[0] / cityM[1]) / (cityA[0] / cityA[1])));
        const model = Math.min(0.95, Math.max(0.01, mt / mc));
        calib.nhoodTransit[n] = Math.max(-2, Math.min(2, (calib.nhoodTransit[n] ?? 0) + 0.7 * (logit(target) - logit(model))));
      }
      // relative to the city: re-centred on the commuters' weighted mean, so the segment constants keep the level
      let wSum = 0, cSum = 0;
      for (const [n, [, mc]] of modN) {
        if (calib.nhoodTransit[n] === undefined) continue;
        wSum += mc;
        cSum += mc * calib.nhoodTransit[n];
      }
      if (wSum > 0) for (const n of Object.keys(calib.nhoodTransit)) calib.nhoodTransit[n] -= cSum / wSum;
    }
    // income: a transit constant on residents' non-work tours by household income band, fitted to
    // BATS 2023's transit share of adults' trips in each band relative to all bands (the level stays
    // with the segment constants), and recentred on the trips
    let incomeLine = '';
    {
      const sh = d.byIncome.map((m) => {
        const den = m.da + m.sr + m.transit + m.walk + m.bike;
        return { share: den > 0 ? m.transit / den : 0, n: den };
      });
      const N = sh.reduce((a, x) => a + x.n, 0);
      const city = sh.reduce((a, x) => a + x.share * x.n, 0) / N;
      const logit = (p: number) => Math.log(p / (1 - p));
      const it0 = calib.incomeTransit ?? sh.map(() => 0);
      const target = (k: number) => Math.min(0.9, Math.max(0.01, (city * BATS_INCOME.bands[k]) / BATS_INCOME.all));
      const next = sh.map((x, k) => Math.max(-2, Math.min(2, it0[k] + 0.7 * (logit(target(k)) - logit(Math.min(0.95, Math.max(0.005, x.share)))))));
      const mean = next.reduce((a, v, k) => a + v * sh[k].n, 0) / N;
      calib.incomeTransit = next.map((v) => v - mean);
      calib.incomeFit = sh.map((x, k) => [x.share, target(k)]);
      incomeLine = ` | transit by income ${sh.map((x, k) => `${(100 * x.share).toFixed(1)}/${(100 * target(k)).toFixed(1)}`).join(' ')} (consts ${calib.incomeTransit.map((v) => v.toFixed(2)).join(' ')})`;
    }
    // persons under 18 (school and non-work tours): constants on transit, walk, and bike against shared
    // ride, fitted to BATS 2023's under-18 shares, on top of the segment constants (TM1 likewise
    // calibrates school tours' constants of their own; the school tours' own constants are fitted to
    // SFUSD's elementary pupils, below)
    let youthLine = '';
    {
      const ya = (calib.youthAsc ??= {});
      const ms = shareOf(d.youthTrips);
      const sr = Math.max(1e-4, ms.sr ?? 0), tsr = YOUTH_TARGET.sr ?? 0;
      for (const m of ['walk', 'bike'] as Mode[]) {
        const t = YOUTH_TARGET[m] ?? 0, v = Math.max(1e-4, ms[m] ?? 0);
        ya[m] = Math.max(-4, Math.min(4, (ya[m] ?? 0) + damp * (Math.log(t / v) - Math.log(tsr / sr))));
      }
      // transit: BATS's share binds only as its 90% interval (YOUTH_TRANSIT_CI). The constant starts at
      // zero (TM1 has none on these tours) and moves only to bring the share back inside it.
      if (!calib.youthTransitInterval) ya.transit = 0;
      calib.youthTransitInterval = YOUTH_TRANSIT_CI;
      // A Newton step on the log odds: the constant acts only on tours other than school, which make
      // the share f of youth's transit trips, so the share's log odds move about f per unit. At half the
      // log ratio a pass (as the other constants), it had closed a sixth of the gap in six passes
      // (19.2% to 18.2% against 14.9%); at 0.8 of this step the gap shrinks about fivefold a pass.
      {
        const v = Math.min(0.95, Math.max(1e-4, ms.transit ?? 0)), t = Math.min(YOUTH_TRANSIT_CI[1], Math.max(YOUTH_TRANSIT_CI[0], v));
        const yt = Math.max(1e-6, d.youthTrips.transit), f = Math.max(0.3, 1 - d.byPurpose.school.transit / yt);
        const logit = (p: number) => Math.log(p / (1 - p));
        ya.transit = Math.max(-4, Math.min(4, (ya.transit ?? 0) + (0.8 * (logit(t) - logit(v))) / f));
      }
      calib.youthFit = Object.fromEntries((['sr', 'transit', 'walk', 'bike'] as Mode[]).map((m) => [m, [ms[m] ?? 0, YOUTH_TARGET[m] ?? 0]]));
      youthLine = ` | youth ${(['sr', 'transit', 'walk', 'bike'] as Mode[]).map((m) => `${m} ${(100 * (ms[m] ?? 0)).toFixed(1)}/${(100 * (YOUTH_TARGET[m] ?? 0)).toFixed(1)}`).join(' ')}`;
    }
    // school and college tours: shadow prices to enrollment, the school distance scale and school
    // constants to SFUSD's elementary pupils (demand.ts fitStudents)
    {
      const line = fitStudents(calib, prep, d, damp);
      if (it === ITER - 1 || it % 4 === 0) console.log(`students: ${line}`);
    }
    // the trips of residents' tours: each constant of a trip by a mode other than its tour's moves by
    // the log ratio of target to model, both relative to the tour's own mode (TRIP_FIT)
    let tripLine = '';
    {
      const ts = (calib.tripSwitch ??= { ...TRIP_SWITCH_ASC });
      const fit: Record<string, [number, number]> = {};
      // the tour modes with constants of their own for the legs through stops (TRIP_SWITCH_STOP) fit the
      // trip back to the NHTS's trips back and the stop legs to its stop legs; the others, both pooled
      const tss = (calib.tripSwitchStop ??= {});
      const fitStop: Record<string, [number, number]> = {};
      const fitSet = (K: Record<string, number>, F: Record<string, [number, number]>, M: Mode, target: Shares, model: Shares) => {
        const t = sharesOver(target, M), s = sharesOver(model, M);
        for (const [a, m] of TRIP_SWITCH) {
          if (a !== M) continue;
          const k = `${M}>${m}`;
          // steps of at most two units: a constant raised far lets the tour's mode stand in for the
          // other on the way back (a bike tour that walks home carries the bike tour's constants)
          // before the tour constants have caught up
          const step = 0.8 * (Math.log(Math.max(1e-4, t[m] ?? 0) / Math.max(1e-4, t[M] ?? 0)) - Math.log(Math.max(1e-5, s[m] ?? 0) / Math.max(1e-5, s[M] ?? 0)));
          K[k] = Math.max(-12, Math.min(6, (K[k] ?? ts[k] ?? TRIP_SWITCH_ASC[k]) + Math.max(-2, Math.min(2, step))));
          F[k] = [s[m] ?? 0, t[m] ?? 0];
        }
      };
      for (const M of TRIP_FIT) {
        if (TRIP_SWITCH_STOP.includes(M)) {
          fitSet(tss, fitStop, M, stopTargetAtModelLengths(M, d.lengthBands), d.tripMixStop[M]);
          fitSet(ts, fit, M, NHTS_TRIPS[M].returnLeg, d.tripMixBack[M]);
        } else fitSet(ts, fit, M, tripTarget(M), d.tripMixTour[M]);
      }
      calib.tripSwitchFit = fit;
      calib.tripSwitchStopFit = fitStop;
      // the survey's rule applied to the model (tours by the mode of their trip in), as a check
      const rule = TRIP_FIT.map((M) => `${M}: ${allowedOf(M).filter((m) => m !== M).map((m) => `${m} ${(100 * (d.tripMix[M]?.[m] ?? 0)).toFixed(1)}/${(100 * (tripTarget(M)[m] ?? 0)).toFixed(1)}`).join(' ')}`).join(', ');
      tripLine = ` | trips by tour mode ${Object.entries(fit).map(([k, [mo, ta]]) => `${k} ${(100 * mo).toFixed(1)}/${(100 * ta).toFixed(1)}`).join(' ')} | stop legs ${Object.entries(fitStop).map(([k, [mo, ta]]) => `${k} ${(100 * mo).toFixed(1)}/${(100 * ta).toFixed(1)}`).join(' ')} | by mode in ${rule}`;
    }
    // special events: each surveyed venue's transit constant to its attendees' transit share
    {
      const line = fitEventTransit(calib, b.header.events, d.eventModes);
      if (line && (it === ITER - 1 || it % 4 === 0)) console.log(`events: transit ${line}`);
    }
    // ...and the South Bay's attendees' transit constant to Caltrain's extra riders on Giants home
    // weekdays (GIANTS_CALTRAIN): Oracle Park's attendees' transit trips assigned on their own, every
    // pass, and their Caltrain boardings counted (a step of 1.2 times the log ratio: the riders move
    // with the constant at about one minus the transit share of these attendees)
    let eventLine = '';
    if (d.eventTransitOD) {
      let on = 0;
      for (const p of ['AM', 'MD', 'PM', 'NT'] as const) {
        const od = d.eventTransitOD[p] as Float32Array;
        const vol = await exec.assign(p, od, crowd?.[p], lotArr());
        const net = exec.net(p, crowd?.[p], lotArr());
        for (let a = 0; a < net.nLinks; a++) if (vol[a] && net.type[a] === 4 && net.lines[net.line[a]].feed === 'caltrain') on += vol[a];
      }
      calib.eventSouthTransit = Math.max(-6, Math.min(3, (calib.eventSouthTransit ?? 0) + 1.2 * Math.log(GIANTS_CALTRAIN.perWeekday / Math.max(1, on))));
      calib.eventCaltrainFit = [on, GIANTS_CALTRAIN.perWeekday];
      eventLine = ` | Oracle Park's attendees on Caltrain ${Math.round(on)}/${Math.round(GIANTS_CALTRAIN.perWeekday)} boardings → South Bay event transit ${calib.eventSouthTransit.toFixed(2)}`;
    }
    // parks. The general size term (weight, exponent on acreage) applies to every park; parks with
    // official visit counts (park-visitation.json) also get their own factor matched to the count, the
    // special-generator practice. Each pass, every counted park's factor moves toward its count; then
    // the weighted mean and acreage trend of the log residuals (factors for counted parks, errors for
    // Dolores Park, which has only a newspaper figure) move into the weight and the exponent, so the
    // general term is the best power-law fit to the landscaped city parks and the factors keep what
    // acreage doesn't explain. Fort Funston, a dune natural area, gets its factor but no say in the
    // general term. Annual visits / 365, less ~6% for a weekday; Golden Gate Park net of its museums.
    {
      const pf = (calib.parkFactor ??= {});
      const pts = PARK_TARGETS.map((t) => ({ ...t, model: Math.max(1, d.parkVisits[t.name] ?? 0) }));
      for (const p of pts) if (p.own) pf[p.name] = Math.max(0.02, Math.min(50, (pf[p.name] ?? 1) * (p.perWeekday / p.model) ** 0.9));
      const fit = pts.filter((p) => p.fit > 0);
      const W = fit.reduce((a, p) => a + p.fit, 0);
      const lr = fit.map((p) => (p.own ? Math.log(pf[p.name]) : Math.log(p.perWeekday / p.model))), la = fit.map((p) => Math.log(p.acres));
      const mr = fit.reduce((a, p, i) => a + p.fit * lr[i], 0) / W, ma = fit.reduce((a, p, i) => a + p.fit * la[i], 0) / W;
      const slope = fit.reduce((a, p, i) => a + p.fit * (lr[i] - mr) * (la[i] - ma), 0) / fit.reduce((a, p, i) => a + p.fit * (la[i] - ma) ** 2, 0);
      // damped, as the Dolores Park error only responds through the next demand pass
      const b0 = calib.parkExponent ?? 1, b1 = Math.max(0.3, Math.min(1.6, b0 + 0.7 * slope));
      const w0 = calib.parkWeight ?? 1, w1 = Math.max(0.05, Math.min(200, w0 * Math.exp(0.7 * mr - (b1 - b0) * ma)));
      // a counted park's pull, weight·A^β·f, is unchanged by the move
      for (const p of pts) if (p.own) pf[p.name] *= (w0 / w1) * p.acres ** (b0 - b1);
      calib.parkWeight = w1;
      calib.parkExponent = b1;
      if (it === ITER - 1 || it % 4 === 0) console.log(`parks: ${pts.map((p) => `${p.name} ${Math.round(p.model)}/${Math.round(p.perWeekday)}${p.own ? ` (×${pf[p.name].toFixed(2)})` : ''}`).join(', ')} → weight ${w1.toFixed(2)}, exponent ${b1.toFixed(2)}`);
    }
    // destination choice and stops: distance terms to the NHTS lengths (means and near shares)
    const lengthLine = fitLengths(calib, d, LENGTHS, 0.12 * (it < 4 ? 2 : 1));
    if (it === ITER - 1 || it % 4 === 0) console.log(`lengths: ${lengthLine}`);
    // walking's time weight: residents' direct legs from or to home of 1 to 2 road miles walked
    const walkLine = ` | ${fitWalkTime(calib, d.lengthBands, WALK_BY_DIST, damp)}`;
    // every few passes: assign, then fit regional visitor volume to BART exits in the city and the
    // path-level preferences (Caltrain; light rail vs bus) to Caltrain and Muni Metro counts
    let bartLine = '';
    let accessLine = '';
    let xferLine = '';
    let schoolLine = '';
    if (it % 3 === 2 || it === ITER - 1 || (it === 0 && !(perTripRes > 0 && perTripNr > 0))) {
      let nrMuni = 0;
      let exits = 0, exitsOff = 0, caltrainOn = 0, metro = 0, subway = 0, bus = 0, ferryOn = 0, acOn = 0, ctCityAM = 0, ctCity = 0, ctArrAM = 0;
      const H = b.header;
      const netsP = {} as Record<TPeriod, TransitNet>, volsP = {} as Record<TPeriod, Float64Array>;
      const downtown = sfBart.filter((s) => DOWNTOWN_BART.includes(s.code));
      const dtModel = Object.fromEntries(downtown.map((s) => [s.code, { exits: 0, entries: 0 }]));
      const dtOf = new Map(downtown.map((s) => [s.stop!, s.code]));
      // shared bikes and scooters: the bias on riding to stations, on the morning's trips (micromob-diag.ts)
      if (d.micro) console.log(await fitMicroAccess(b, scenario, calib, exec, d.transitOD.AM, crowd?.AM, lotArr()));
      for (const p of ['AM', 'MD', 'PM', 'NT'] as const) {
        const linkVol = await exec.assign(p, d.transitOD[p], crowd?.[p], lotArr());
        const net = exec.net(p, crowd?.[p], lotArr());
        netsP[p] = net;
        volsP[p] = linkVol;
        // non-residents' trips alone (for their Muni level; residents' are the rest)
        if (d.nonResTransitOD) {
          const nrVol = await exec.assign(p, d.nonResTransitOD[p], crowd?.[p], lotArr());
          for (let a = 0; a < net.nLinks; a++) if (nrVol[a] && net.type[a] === 4 && net.lines[net.line[a]].feed === 'muni' && obsRoutes.has(net.lines[net.line[a]].route)) nrMuni += nrVol[a];
        }
        for (let a = 0; a < net.nLinks; a++) {
          const v = linkVol[a];
          if (!v) continue;
          if (net.type[a] === 2) {
            const st = net.head[a] - net.nZones;
            if (sfBart.some((s) => s.stop === st)) ((exits += v), (p === 'MD' || p === 'NT') && (exitsOff += v));
            if (p === 'AM' && net.lines[net.line[a]].feed === 'caltrain' && caltrainCity.has(st)) ctArrAM += v;
            if (dtOf.has(st)) dtModel[dtOf.get(st)!].exits += v;
          } else if (net.type[a] === 4) {
            const l = net.lines[net.line[a]];
            const st = H.stops[boardStop(net, a)];
            if (dtOf.has(boardStop(net, a))) dtModel[dtOf.get(boardStop(net, a))!].entries += v;
            if (l.feed === 'caltrain' && st && caltrainSF.has(boardStop(net, a))) caltrainOn += v;
            if (l.feed === 'caltrain' && caltrainCity.has(boardStop(net, a))) (ctCity += v), p === 'AM' && (ctCityAM += v);
            if (l.mode === 'ferry' && FERRY_ROUTES.has(l.route)) ferryOn += v;
            if (l.feed === 'ac') acOn += v;
            if (l.feed === 'muni' && SUBWAY.has(l.route)) subway += v;
            if (l.feed === 'muni' && METRO.has(l.route)) metro += v;
            else if (l.feed === 'muni' && obsRoutes.has(l.route)) bus += v;
          }
        }
      }
      // the Market Street stations' street-to-platform times, to their exits and entries
      // (off: FIT_STATION_TIMES, stations-fit.ts; the stations keep their assumed depths)
      const dtLine = FIT_STATION_TIMES ? fitStationTimes(calib, Object.fromEntries(downtown.map((s) => [s.code, { exits: s.exits, entries: s.entries }])), dtModel) : '';
      const ratio = bartObs / Math.max(1, exits);
      calib.regionalRate = Math.max(0.02, Math.min(3, calib.regionalRate * ratio ** 1.5));
      calib.regionalFit = { exitsOffPeak: [exitsOff, bartObsOff], exitsDay: [exits, bartObs] };
      // Caltrain: its in-vehicle factor, both ways (a penalty could only lower it), from TM1's 0.7
      calib.ivtFactor ??= {};
      calib.ivtFactor.caltrain = Math.max(0.35, Math.min(1.5, (calib.ivtFactor.caltrain ?? 0.7) * (caltrainOn / caltrainObs) ** 0.6));
      // and its direction. A constant at the outside zones' activity end (where residents commuting out
      // reach Caltrain; net.ts), within ±5 minutes, to the morning's departures from the city's two
      // stations; the in-vehicle factor above holds the total. The morning's arrivals (in-commuters, at
      // the outside zones' home end) are a test, not a target: fitted by a home-end constant, it fell
      // without limit (−1.9 to −15 minutes over 26 iterations, the in-vehicle factor rising toward its
      // cap with it) while the arrivals stayed near 2,600 against 3,550, because the in-commuters'
      // transit share is held to their counties' (San Mateo 21%, Santa Clara 27%), so the constant only
      // moved them between Caltrain and BART. The two targets are inconsistent as specified (METHOD).
      {
        calib.caltrainEnd = 0;
        calib.caltrainAct = Math.max(-5, Math.min(5, (calib.caltrainAct ?? 0) + 6 * Math.log(Math.max(1, ctCityAM) / CALTRAIN_DIR.departuresAM)));
        calib.caltrainDirFit = { arrivalsAM: [ctArrAM, CALTRAIN_DIR.arrivalsAM], departuresAM: [ctCityAM, CALTRAIN_DIR.departuresAM], departAmShare: [ctCity > 0 ? ctCityAM / ctCity : 0, CALTRAIN_DIR.departAmShare] };
      }
      // ferries: the commuter routes into the city (FERRY_OBS); riders value the boat, so its in-vehicle
      // factor is fitted
      if (!day0Done) {
        const ferryObs = FERRY_OBS;
        calib.ivtFactor ??= {};
        // as low as 0.15: TM1 gives drive-to-ferry commuters a constant worth ~38 minutes of riding (0.83 utils)
        calib.ivtFactor.ferry = Math.max(0.15, Math.min(1, (calib.ivtFactor.ferry ?? 0.8) * (ferryOn / ferryObs) ** 0.6));
      }
      // AC Transit's Transbay buses: riders value the direct ride downtown and the seat beyond what the
      // path search sees (TM1 gives express bus its own transit sub-mode); an in-vehicle factor for the
      // operator, fitted to its Transbay riders, as for ferries
      calib.ivtFactor ??= {};
      calib.ivtFactor['feed:ac'] = Math.max(0.15, Math.min(1, (calib.ivtFactor['feed:ac'] ?? 1) * (Math.max(1, acOn) / AC_TRANSBAY_OBS) ** 0.6));
      // how riders from home reach BART outside the city (on foot, by bus, by car) against BART's 2024
      // Station Profile Study: a penalty on whichever way is over-used (TM1 and TM2 calibrate walk- and
      // drive-access transit constants to on-board surveys); the least-used way carries none
      {
        if (d.micro) microAcc = microAccess(b, scenario, netsP, volsP);
        const acc = accessShares(b, netsP, volsP);
        const kinds = ['walk', 'bus', 'drive'] as const;
        const raw = kinds.map((k) => (calib.extAccessBias?.[k] ?? 0) + 3 * Math.log(Math.max(1e-3, acc.model[k]) / Math.max(1e-3, acc.target[k])));
        const lo = Math.min(...raw);
        calib.extAccessBias = Object.fromEntries(kinds.map((k, i) => [k, Math.min(30, raw[i] - lo)]));
        accessLine = ` | access walk/bus/car ${kinds.map((k) => `${(100 * acc.model[k]).toFixed(0)}/${(100 * acc.target[k]).toFixed(0)}`).join(' ')} bias ${JSON.stringify(calib.extAccessBias)} | AC ${Math.round(acOn)}/${AC_TRANSBAY_OBS} factor ${calib.ivtFactor['feed:ac']?.toFixed(2)}`;
      }
      // the weight on a change of lines (TM1's tour transfer weight × xferFactor, in mode choice and,
      // through params.ts transferPenalty, in route choice), fitted to the share of Muni's boardings
      // that follow another vehicle in SFMTA's 2017 on-board survey. It used to be fitted to Muni's
      // boardings, which it could only raise by making changes cheaper: at its floor (0.6, a 9-minute
      // change in route choice) 20% of boardings followed another vehicle, against the survey's 12%,
      // and Muni's count was met with too few trips. Muni's boardings are now a result.
      // Muni boardings on the counted routes per linked transit trip, for the school fit below
      muniPerTrip = calib.muniPerTrip = (metro + bus) / Math.max(1, d.trips.transit);
      {
        const nrTrips = odSum(d.nonResTransitOD);
        perTripNr = calib.muniPerTripNonRes = nrMuni / Math.max(1, nrTrips);
        perTripRes = calib.muniPerTripRes = (metro + bus - nrMuni) / Math.max(1, d.trips.transit - nrTrips);
        calib.muniByResidence = { residents: [metro + bus - nrMuni, muniResTarget], nonResidents: [nrMuni, muniNrTarget] };
      }
      const xs = muniAfterVehicle(netsP, volsP);
      calib.xferFactor = Math.max(0.3, Math.min(1.5, (calib.xferFactor ?? 1) * (xs.share / XFER_TARGET) ** 1.5));
      xferLine = ` | after another vehicle ${(100 * xs.share).toFixed(1)}/${(100 * XFER_TARGET).toFixed(1)}% (Metro ${(100 * xs.metroShare).toFixed(1)}, buses ${(100 * xs.busShare).toFixed(1)}) → xfer ${calib.xferFactor.toFixed(3)} (${transferPenalty(calib).toFixed(1)} min a change)`;
      // the subway lines against the buses are not fitted. A penalty per bus ride (about 0.6 minutes)
      // used to be, to win riders back from the buses. Its cause was the choice among a zone's stops,
      // which weighed a station by the mean walk of a 25-minute catchment, so a station looked minutes
      // farther than the bus stop on the same corner. With stops chosen block by block (skims.ts
      // connectorPts, strategy.ts blockOrigin) the model needs no penalty: refitted, it went the other
      // way. The subway's split against the buses is a result, printed below.
      for (const m of ['bus', 'rapid', 'trolley', 'lightrail']) calib.modeBias[m as never] = 0 as never;
      const rel = subway / subwayObs / (bus / busObs);
      bartLine = ` | BART ${Math.round(exits)}/${Math.round(bartObs)} (midday and night ${Math.round(exitsOff)}/${Math.round(bartObsOff)}, a check) → rate ${calib.regionalRate.toFixed(2)} | Caltrain SF ${Math.round(caltrainOn)}/${Math.round(caltrainObs)} | Metro ${Math.round(metro)}/${metroObs} (subway ${Math.round(subway)}/${subwayObs}) bus ${Math.round(bus)}/${busObs}, subway/bus ${rel.toFixed(3)} | xfer ${calib.xferFactor?.toFixed(2)} | ferry ${Math.round(ferryOn)} (factor ${calib.ivtFactor?.ferry?.toFixed(2)}) | Caltrain factor ${calib.ivtFactor?.caltrain?.toFixed(2)}, city AM arrivals ${Math.round(ctArrAM)}/${Math.round(CALTRAIN_DIR.arrivalsAM)} (a test), AM departures ${Math.round(ctCityAM)}/${Math.round(CALTRAIN_DIR.departuresAM)} (activity-end constant ${calib.caltrainAct?.toFixed(1)}), AM share of departures ${(100 * (calib.caltrainDirFit?.departAmShare[0] ?? 0)).toFixed(1)}/${(100 * CALTRAIN_DIR.departAmShare).toFixed(1)}%${accessLine}${dtLine ? ` | downtown BART exits/entries ${dtLine}` : ''}`;
      // the preferences change paths (and every six passes, the crowding): refresh the skims
      if (it % 6 === 5) {
        const prev = crowd;
        const r = await runModel(b, { name: 'Today', edits: [] }, calib, exec, { iterations: 2 }, prep);
        crowd = toNet(r.finalCrowd) ?? prev;
        calib.lotPrice = r.finalLotPrice;
      }
      for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, crowd?.[p], lotArr());
    }
    // a test, not a target: the share of Muni's riders traveling to or from school or college in MTC's
    // 2023–24 Snapshot survey (SCHOOL_SHARE). The model's share is school and college tours' linked
    // transit trips (their legs through stops included) over the Muni boardings on the counted routes,
    // taken between assignments as the linked transit trips times the last assignment's boardings per
    // trip (a school or college trip by transit boards about one Muni vehicle: 1.05 and 0.98 in
    // diag-length.ts, October 2026). School travel is fitted to SFUSD's pupils and SF State's students
    // (fitStudents), so a constant fitted to the Snapshot as well would fight those fits.
    if (muniPerTrip > 0) {
      const sch = d.byPurpose.school.transit + d.byPurpose.univ.transit;
      const share = sch / Math.max(1, muniPerTrip * d.trips.transit);
      // and on a school day (SCHOOL_DAY), as the survey was taken while schools were in session
      const k = d.byPurpose.school.transit * SCHOOL_DAY.k12 + d.byPurpose.univ.transit * SCHOOL_DAY.college;
      const shareDay = k / Math.max(1, muniPerTrip * (d.trips.transit + k - sch));
      calib.snapshotSchoolFit = [share, SCHOOL_SHARE];
      schoolLine = ` | school and college ${(100 * share).toFixed(1)}% of Muni, ${(100 * shareDay).toFixed(1)}% on a school day, against ${(100 * SCHOOL_SHARE).toFixed(1)}% (Snapshot; a test)`;
    }
    const rs = shareOf(d.residentTrips);
    console.log(
      `iter ${it + 1}: residents ${MODES.map((m) => `${m} ${(100 * (rs[m] ?? 0)).toFixed(1)}`).join(' ')} | shuttle ${Math.round(d.shuttleTrips)} | work car1 transit+shuttle ${(100 * (shareOf({ ...d.workBySeg.car1, transit: d.workBySeg.car1.transit + (d.shuttleBySeg.car1 ?? 0) }).transit ?? 0)).toFixed(1)} (target ${(100 * (WORK_TARGET.car1.transit ?? 0)).toFixed(1)}) | km shop ${d.meanKm.shop?.toFixed(1)} other ${d.meanKm.other?.toFixed(1)} nhb ${d.meanKm.nhb?.toFixed(1)} stops car ${d.meanKm['stop:car']?.toFixed(1)} transit ${d.meanKm['stop:transit']?.toFixed(1)} walk ${d.meanKm['stop:walk']?.toFixed(1)} | ≤½ mi ${['shop', 'other', 'social', 'school', 'stop:car', 'stop:walk'].map((k) => `${k} ${(100 * (d.kmBands[k]?.[0] ?? 0)).toFixed(0)}`).join(' ')}${levelLine}${walkLine}${incomeLine}${youthLine}${bartLine}${xferLine}${schoolLine}${eventLine}${tripLine}${microLine ? ` | ${microLine}` : ''}`,
    );
  }
  calib.iterations = (calib.iterations ?? 0) + ITER;
  // sightseeing rides: SFMTA's last published weekday counts (2019; cable car and historic lines
  // have not been reported since) scaled to an assumed 80% recovery in visitors, less what the
  // model already carries on those routes as ordinary trips
  {
    const muni = JSON.parse(fs.readFileSync(`${REFERENCE}/muni-route-ridership.json`, 'utf8'));
    const ROUTES: Record<string, string> = { '59': 'PM', '60': 'PH', '61': 'CA', F: 'F', E: 'E' };
    calib.touristRides = {};
    const d0 = await runModel(b, scenario, { ...calib, touristRides: {} }, new LocalExecutor(b, scenario, { ...calib, touristRides: {} }), { iterations: 1 }, prep);
    for (const h of muni.historicRoutes) {
      const gtfs = ROUTES[h.route];
      if (!gtfs || !h.avgWeekdayBoardings_cy2019Mean_preCOVID) continue;
      const modelled = d0.lines.filter((l) => l.line >= 0 && b.header.lines[l.line].feed === 'muni' && b.header.lines[l.line].route === gtfs).reduce((a, l) => a + Object.values(l.boardings).reduce((x, v) => x + v, 0), 0);
      calib.touristRides[gtfs] = Math.max(0, Math.round(0.8 * h.avgWeekdayBoardings_cy2019Mean_preCOVID - modelled));
    }
    console.log(`sightseeing rides: ${JSON.stringify(calib.touristRides)}`);
  }
  // weekends: two adjustments per day, everything else as on weekdays
  calib.days ??= {};
  if (!process.argv.includes('--weekday-only'))
    for (const day of ['sat', 'sun'] as const) {
      const obsRoutes = (day === 'sat' ? b.header.observed.muniRoutesSat : b.header.observed.muniRoutesSun) ?? [];
      const obsSet = new Set(obsRoutes.map((r) => r.route));
      const muniObs = obsRoutes.reduce((a, r) => a + r.boardings, 0);
      const exitsObs = sfBart.reduce((a, st) => a + ((day === 'sat' ? b.header.observed.bartExitsSat : b.header.observed.bartExitsSun)?.[st.code] ?? 0), 0);
      // sightseeing on weekends: an assumed 1.3× the weekday (no current counts)
      calib.days[day] ??= { transitAsc: 0, regionalRate: calib.regionalRate * 1.5, touristFactor: 1.3 };
      const adj = calib.days[day]!;
      const sc: Scenario = { name: day, edits: [], day };
      for (let it = 0; it < 6; it++) {
        const r = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 1 }, prep);
        const muni = r.lines.filter((l) => l.line >= 0 && b.header.lines[l.line].feed === 'muni' && obsSet.has(b.header.lines[l.line].route)).reduce((a, l) => a + Object.values(l.boardings).reduce((x, v) => x + v, 0), 0);
        const exits = sfBart.reduce((a, st) => a + r.stopOff[st.stop!], 0);
        adj.transitAsc += 1.1 * Math.log(muniObs / Math.max(1, muni));
        adj.regionalRate = Math.max(0.05, Math.min(5, adj.regionalRate * (exitsObs / Math.max(1, exits)) ** 1.2));
        console.log(`${day} ${it + 1}: Muni ${Math.round(muni)}/${muniObs}, BART SF exits ${Math.round(exits)}/${exitsObs} → transit ${adj.transitAsc.toFixed(3)}, regional ${adj.regionalRate.toFixed(2)}`);
      }
    }
  // final check with crowding
  const r = await runModel(b, scenario, calib, new LocalExecutor(b, scenario, calib), { iterations: 2 }, prep);
  calib.lotPrice = r.finalLotPrice;
  calib.report = validation(b, r);
  for (const l of calib.report) console.log(l);
  b.header.calibration = calib;
  const { arrays: _a, ...header } = b.header;
  void _a;
  const bin = encodeBundle(header, b.a as never);
  // BETA3_SF_BUNDLE: calibrate an experiment's own copy of the bundle (run-base.ts loadBundle reads it too)
  fs.writeFileSync(process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(bin, { level: 9 }));
  console.log('calibration saved');
}

main();
