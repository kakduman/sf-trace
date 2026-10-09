/**
 * Everything the article prints comes from these files, read at build time:
 *  - model results: validation.json (validate.ts), backcast.json (backcast.ts), scorecard.json (report.ts)
 *  - the bundle's counts, calibration and pipeline constants: facts.json (export-facts.ts)
 *  - observed data, standards, and the NHTS 2017 day-type rates: server/beta3/reference/*.json
 *  - model parameters: shared/beta3/params.ts
 */
import validation from '../model/validation.json';
import backcast from '../model/backcast.json';
import backcastFirst from '../../../server/beta3/reference/backcast-results-first-run.json';
import scorecard from '../model/scorecard.json';
import portal from '../model/portal.json';
import portalRef from '../../../server/beta3/reference/portal.json';
import facts from './facts.json';
import acs from '../../../server/beta3/reference/acs-commute.json';
import autoSpeeds from '../../../server/beta3/reference/sf-auto-speeds.json';
import modeShare from '../../../server/beta3/reference/sf-mode-share.json';
import ntd from '../../../server/beta3/reference/ntd-trip-length.json';
import tod from '../../../server/beta3/reference/time-of-day.json';
import gtfsValidation from '../../../server/beta3/reference/gtfs-validation.json';
import nhtsDays from '../../../server/beta3/reference/nhts-daytypes.json';
import nhtsTours from '../../../server/beta3/reference/nhts-tours.json';
import nhtsTripMode from '../../../server/beta3/reference/nhts-tripmode.json';
import nhtsTripLength from '../../../server/beta3/reference/nhts-triplength.json';
import nhtsPersons from '../../../server/beta3/reference/nhts-persontypes.json';
import batsFreq from '../../../server/beta3/reference/bats-commute-frequency.json';
import peakHour from '../../../server/beta3/reference/peak-hour.json';
import backcastInputs from '../../../server/beta3/reference/backcast-inputs.json';
import backcastDrivers from '../../../server/beta3/reference/backcast-drivers.json';
import benchmarks from '../../../server/beta3/reference/benchmarks.json';
import events from '../../../server/beta3/reference/special-events.json';
import synpop from '../../../server/beta3/reference/synpop.json';
import synpopBridge from '../../../server/beta3/reference/synpop-bridge.json';
import students from '../../../server/beta3/reference/student-travel.json';
import abmValidation from '../../../server/beta3/reference/abm-validation.json';
import abmAggregation from '../../../server/beta3/reference/abm-aggregation.json';
import abmFit from '../../../server/beta3/reference/abm-fit.json';
import commuteDays from '../../../server/beta3/reference/commute-days.json';
import commuteBasis from '../../../server/beta3/reference/commute-basis.json';
import hhVehInc from '../../../server/beta3/reference/sf-hh-vehicles-income.json';
import nhtsTransitLength from '../../../server/beta3/reference/nhts-transit-length.json';
import schoolTravel from '../../../server/beta3/reference/school-travel.json';
import shortTrips from '../../../server/beta3/reference/short-trip-results.json';
import destShort from '../../../server/beta3/reference/dest-short-results.json';
import modeByArea from '../../../server/beta3/reference/sf-mode-by-area.json';
import caltrainRidershipRef from '../../../server/beta3/reference/caltrain-ridership.json';
import transferResults from '../../../server/beta3/reference/transfer-results.json';
import metroResults from '../../../server/beta3/reference/metro-results.json';
import muniareaResults from '../../../server/beta3/reference/muniarea-results.json';
import underreportResults from '../../../server/beta3/reference/underreport-results.json';
import commutesResults from '../../../server/beta3/reference/commutes-results.json';
import visitorTravel from '../../../server/beta3/reference/visitor-travel.json';
import fareMedia from '../../../server/beta3/reference/muni-fare-media.json';
import { residentLinkedShares, residentLinkedTrips } from '../../../server/beta3/pipeline/resident-targets';
import bayWheels from '../../../server/beta3/reference/bay-wheels-sf.json';

export const V = validation;
/** the backcast on the current model, with the summer 2024 demand context fixed in advance: the held-out result */
export const BC = backcast;
/** the first, blind backcast on the model frozen for the article's first version: the history */
export const BC0 = backcastFirst;
/** the same runs scored as the comparison was first specified: July–August counts, the K and T as one route */
export type BackcastSummary = { routes: number; weightedCorrelationOfChange: number; meanAbsErrorOfChange: { model: number; noChangeForecast: number } };
export const firstSpecified = (b: Backcast | null) => (b as unknown as { asFirstSpecified?: BackcastSummary } | null)?.asFirstSpecified ?? null;
export type Backcast = Omit<typeof backcast, 'asFirstSpecified' | 'context' | 'decomposition' | 'secondRunInputs'>;
// files that later pipeline steps write; each is read only if it exists (an empty glob otherwise)
const optional = <T,>(g: Record<string, unknown>): T | null => (Object.values(g)[0] as T | undefined) ?? null;
/** the backcast's split of system growth by condition (backcast.ts), and the second run's inputs rerun on this model */
export interface BackcastDriverRow { key: string; value: number; growth: number; effectPts: number; weightedCorrelationOfChange: number; meanAbsErrorOfChange: number }
export interface BackcastDecomposition {
  networkOnly: { growth: number; effectPts: number; weightedCorrelationOfChange: number; meanAbsErrorOfChange: number };
  drivers: BackcastDriverRow[];
  interactionPts: number;
  totalPts: number;
  observedPts: number;
}
const bcx = backcast as unknown as { decomposition?: BackcastDecomposition; secondRunInputs?: { systemGrowthModel: number; weightedCorrelationOfChange: number; meanAbsErrorOfChange: number }; context?: Record<string, number | boolean> };
export const BC_DEC = bcx.decomposition ?? null;
export const BC_SECOND = bcx.secondRunInputs ?? null;
/** July 2024's conditions with their sources, fixed before the run (and a check made after it) */
export const BC_DRIVERS = backcastDrivers as unknown as {
  written: string;
  drivers: Record<string, { value: number; today?: number; source: string; toMuniOnly?: boolean }>;
  held: Record<string, string>;
  deflator: { factor2024to2026: number };
  examinedAfterResults?: { transferDiscountStep: { meanJulNov2025: number; meanJanJun2026: number } };
};
/** a backcast variant with downtown attendance from BART's downtown exits, chosen after the follow-up (a diagnostic) */
export const BC_BART = optional<Backcast>(import.meta.glob('../model/backcast-bart.json', { eager: true, import: 'default' }));
/** the four downtown stations' exits, July 2024 relative to July 2026, as backcast.ts --bart computes them */
export const BART_DOWNTOWN_RATIO = (() => {
  const e = (backcastInputs as unknown as { bartExits?: { periods?: Record<string, Record<string, number>> } }).bartExits?.periods;
  const dt = (per: string) => ['EMBR', 'MONT', 'POWL', 'CIVC'].reduce((a, c) => a + (e?.[per]?.[c] ?? NaN), 0);
  const r = dt('2024-07') / dt('2026-07');
  return Number.isFinite(r) ? r : null;
})();
/** parameter draws for the example scenarios (uncertainty.ts) */
export interface Uncertainty {
  draws: number;
  /** each run's parameters (the first as calibrated) */
  parameterDraws?: Record<string, number>[];
  summary: Record<string, Record<string, { calibrated: number; p10: number; p50: number; p90: number }>>;
}
export const UNC = optional<Uncertainty>(import.meta.glob('../model/uncertainty.json', { eager: true, import: 'default' }));
/** where capacity at boarding binds in the weekday base run (baseline.ts writes it; run-base.ts capacitySummary) */
export interface CapacityRun {
  settleConvergence: number[];
  leftBehind: Record<'AM' | 'MD' | 'PM' | 'NT', number>;
  overCap: Record<'AM' | 'MD' | 'PM' | 'NT', number>;
  boardings: Record<'AM' | 'MD' | 'PM' | 'NT', number>;
  byGroup: Record<string, number>;
  routes: { p: string; feed: string; route: string; mode: string; headsign: string; leftBehind: number; boardings: number; share: number; stops: number }[];
  stops: { p: string; feed: string; route: string; headsign: string; stop: string; on: number; leftBehind: number }[];
}
export const CAP = optional<CapacityRun>(import.meta.glob('../model/capacity.json', { eager: true, import: 'default' }));
/** the long-run car ownership test (longrun.ts geary): the Geary subway short run and long run */
export interface LongRun {
  runSec: { short: number; long: number };
  corridor: LongRunArea;
  city: LongRunArea;
  hhBySeg: { short: number[]; long: number[] };
  transit: { base: number; short: number; long: number };
  newLine: { short: number; long: number };
  vkt: { base: number; short: number; long: number };
}
export interface LongRunArea { hh: number; cars0: number; cars1: number; carsPct: number; noCarPct: number; accessGain: number; jobs45Pct: number; elastAccess: number; elastJobs45: number }
export const LONGRUN = optional<LongRun>(import.meta.glob('../model/autoown-longrun.json', { eager: true, import: 'default' }));
/** MobilityData gtfs-validator results for each feed */
export const GTFS_VALIDATION = gtfsValidation as unknown as {
  validator: string;
  feeds: Record<string, { bySeverity: Partial<Record<'ERROR' | 'WARNING' | 'INFO', number>>; notices: { code: string; severity: string; total: number }[] }>;
  impactOnModel: Record<string, string>;
};
export const SC = scorecard;
/** The Portal case study (portal.ts) and the official record it is compared with */
export const PORTAL = portal;
export const PORTAL_REF = portalRef;
export const F = facts;
/** residents' linked shares and trips a weekday, the calibration targets (resident-targets.ts) */
export const RESIDENT_TARGET = (() => {
  const shares = residentLinkedShares(modeByArea as never) as Record<string, number>;
  return { shares, trips: residentLinkedTrips(modeShare.bats2023_sfResidents_allTrips_unlinked as never, shares) };
})();
/** BATS 2023's under-18 transit share as the calibration reads it: its 90% interval, sampled transit trips, and weekday trips (MTC dashboard extract) */
const batsYouthRow = (modeByArea as unknown as { batsDashboardSF: { tables: { mode_label: Record<string, { totalWeightedTrips: number; modes: Record<string, { ci90: [number, number]; unweightedTrips: number }> }> } } }).batsDashboardSF.tables.mode_label['2023 | Under 18 | All Income Levels'];
const batsYouth = { ci90: batsYouthRow.modes.WALKTRAN.ci90, transitTrips: batsYouthRow.modes.WALKTRAN.unweightedTrips, trips: batsYouthRow.totalWeightedTrips };
export const REF = { batsYouth, caltrainGameDay: (caltrainRidershipRef as unknown as { systemwide: { giantsGameDayFY2026: { weekdayAway: number; weekdayHome: number } } }).systemwide.giantsGameDayFY2026, acs, autoSpeeds, modeShare, ntd, tod, nhtsDays, nhtsTours, nhtsTripLength, nhtsPersons, batsFreq, peakHour, events, students, hhVehInc, nhtsTransitLength, schoolTravel, shortTrips, destShort, transferResults, bayWheels, nhtsTripMode, metroResults, muniareaResults, underreportResults, commutesResults, visitorTravel, fareMedia };
/** the synthetic population's fit (synpop.ts) and the demand comparison (synpop-bridge.ts) */
export const SYNPOP = { pop: synpop, bridge: synpopBridge };
/** the person-level choices (abm.ts): checks (abm-validate.ts), aggregation error (abm-check.ts), fit against the aggregate rates (abm-compare.ts) */
export const ABMR = { val: abmValidation, agg: abmAggregation, fit: abmFit };
/** how often commuters commute: the evidence (commute-days.json) and the model's test of the two readings of BATS (commute-basis.ts) */
export const COMMUTE = { days: commuteDays, basis: commuteBasis };
/** shared bikes and scooters in the calibrated run (micromob-validate.ts writes it from experiment.ts's results) */
type HarnessSummary = { muni: { r: number; pctRmse: number; total: number; model: number; observed: number }; bart: { r: number; total: number; pctRmse: number }; caltrain: { obs: number; mod: number }; residentShares: Record<string, number> };
export type MicroRun = import('../../../server/beta3/pipeline/micromob-validate').MicroReport & { compare: { without: HarnessSummary | null; with: HarnessSummary }; label: string; calibration: import('../../../shared/beta3/micromobility').MicroCalib | null; muni: { r: number; pctRmse: number; total: number }; bart: { r: number; total: number }; residentShares: Record<string, number> };
export const MM = optional<Omit<MicroRun, 'lines'>>(import.meta.glob('../model/micromobility.json', { eager: true, import: 'default' }));

/**
 * Fields that export-facts.ts writes and validate.ts, report.ts, and backcast.ts produce for the
 * current model. Each is optional here so the page still builds from result files written before
 * the field existed; the text leaves out what a file does not yet have.
 */
type Num = number | null;
export interface FactsExtra {
  totals: { age65plus?: number };
  fares: Record<string, { routes?: Record<string, number> | null }>;
  targets: {
    stopKm?: Record<string, number>;
    /** shares of half a mile or less (NHTS), by purpose and for stops by the tour's mode, and the samples */
    tripNear?: Record<string, number>;
    stopNear?: Record<string, number>;
    lengthSample?: Record<string, number>;
    residentAll?: Record<string, number>;
    residentTrips?: number;
    county?: { minCommuters: number; in: Record<string, { share: number; commuters: number }>; out: Record<string, { share: number; commuters: number }> };
    ferryRoutes?: string[];
    parks?: { name: string; acres: number; annual: Num; lessMuseums: number; perWeekday: Num; own: boolean; fitWeight: number }[];
  };
  calibration: {
    tourRateFactor?: Num;
    residentCorrection?: Record<string, number> | null;
    incomeTransit?: number[] | null;
    incomeFit?: [number, number][] | null;
    countyFit?: { in: Record<string, [number, number]>; out: Record<string, [number, number]> } | null;
    countyTransit?: { in?: Record<string, number>; out?: Record<string, number> } | null;
    stopDistCoefs?: Record<string, number> | null;
    schoolDistScale?: Num;
    schoolAsc?: Record<string, number> | null;
    schoolFit?: { modes: Record<string, [number, number]>; under1mi: [number, number] } | null;
    collegeDa?: Num;
    collegeFit?: [number, number] | null;
    youthAsc?: Record<string, number> | null;
    youthFit?: Record<string, [number, number]> | null;
    distLogCoef?: Record<string, number> | null;
    stopLogCoefs?: Record<string, number> | null;
    walkTimeFactor?: Num;
    walkFit?: [number, number] | null;
    walkFitNear?: [number, number] | null;
    /** from the calibration report: means of trips of up to 5 miles (km), and shares within half a mile, by purpose and 'stop:<class>' */
    meanKm5?: Record<string, number>;
    nearShare?: Record<string, number>;
    parkWeight?: Num;
    parkExponent?: Num;
    parkFactor?: Record<string, number> | null;
    ivtFactor?: Record<string, number> | null;
    autoOwn?: { asc: number[]; nhoods: number; classes: number; retailOutside: number; fit: { city: [number, number][]; zonePctRmse: number[]; nhoodPctRmse: number[]; zoneCityOnly?: number[]; nhoodCityOnly?: number[]; zoneTM1?: number[]; cityTM1?: number[]; samplingFloor?: number[]; elasticity?: number } | null } | null;
    ferryFloor?: number;
    /** how calibrate.ts moves each in-vehicle time factor: start (TM1), bounds, and power on the boardings ratio */
    ivtFit?: Record<string, { start: number; floor: number; ceil?: number; power: number }>;
  };
  /** shape length over straight stop-to-stop length, Muni buses and Metro, weighted by scheduled trips */
  shapeRatio?: { bus: number; metro: number } | null;
  /** compressed size of the model bundle the browser loads, bytes */
  bundleBytes?: number;
  operations?: {
    runRatio: { all: Record<string, number> | null; metro: Record<string, number>; slowest: { route: string; period: string; ratio: number }[]; fastest: { route: string; period: string; ratio: number }[] };
    notRun: { day: Record<string, number>; sfmta12m: number; medianRoute: number; p90Route: number };
    sd: Record<string, { a: number; b: number; points: { min: number; sd: number }[] }>;
    leastReliable: { route: string; m: number }[];
    mostReliable: { route: string; m: number }[];
    rail: Record<'bart' | 'caltrain' | 'ferry', { meanLateMin: number; sdMin: number }>;
    predictions: { sd10: number; rsd10: number; bias10: number; sd20: number; sd5: number; retained: number; consulting: number; informedShare: number };
    rr: number;
  };
  reliability?: { day: string | null; routesMeasured: number; patterns: number; median: Record<string, Num>; highestAM: { route: string; v: number }[]; lowestAM: { route: string; v: number }[]; bounds: [number, number] | null };
  night?: { owlOnlyPatterns: number; patternsWithEvening: number };
  schools?: { records: number; placed: number; pupilsPlaced: number; withoutCoords: number; pupilsWithoutCoords: number; nontraditional: number; pupilsInZones: number; seniorParticipants: Num; seniorShare: Num };
  shuttles?: { approvedStops: number; regional2017: Num; reachM: number; residentsInReach: number };
  parking?: { bart: number; caltrain: number; ferry: number; bartNoLot: string[]; bartMedianFee: Num; bartMaxFee: Num };
  backcastContext?: { attendanceCore: number; visitors: number; officeWeeksPast: number; officeWeeksNow: number; serviceChanges: { date: string; routes: string[] }[] };
}
type DeepMerge<A, B> = { [K in keyof A | keyof B]: K extends keyof B ? (K extends keyof A ? (A[K] extends object ? (B[K] extends object ? A[K] & B[K] : A[K]) : A[K]) : B[K]) : K extends keyof A ? A[K] : never };
/** facts.json with the fields of the current export-facts.ts */
export const FX = F as unknown as DeepMerge<typeof F, FactsExtra>;

type StatBlock = { n: number; observedTotal: number; modelTotal: number; totalRatio: number; r: number; pctRmse: number; within25: number; medianApe: number };
export interface CaltrainFlowRow { name: string; observedToCityAM: number; modelToCityAM: number; observedFromCityPM: number; modelFromCityPM: number; observedFromCityAM: number; modelFromCityAM: number; observedToCityPM: number; modelToCityPM: number; observedDaily: number; modelDaily: number }
export interface ValidationExtra {
  caltrainRegional?: {
    source: string;
    shareNoCityEnd: { estimateFY2026: number; survey2024: number };
    groups: { rows: CaltrainFlowRow[]; daily: StatBlock; toCityAM: StatBlock; fromCityPM: StatBlock; fromCityAM: StatBlock; toCityPM: StatBlock };
    stations: { rows: CaltrainFlowRow[]; daily: StatBlock; toCityAM: StatBlock };
    segments: {
      peakRows: { dir: 'NB' | 'SB'; period: string; a: string; b: string; observed: number; model: number; background: number; capacity: number; seats: number }[];
      daily: { stretch: string; observed: number; model: number; background: number }[];
      peakStats: StatBlock; peakStatsWithoutBackground: StatBlock; dailyStats: StatBlock; dailyStatsWithoutBackground: StatBlock;
      busiest: { dir: 'NB' | 'SB'; period: string; stretch: string; model: number; background: number; modelWithoutBackground: number; loadPerSeat: number; loadPerSeatWithoutBackground: number; observedStretch: string; observed: number; observedPerSeat: number }[];
    };
    background: Record<string, Record<string, Record<string, { observedAll: number; modelAll: number; observedNoCityEnd: number; modelNoCityEnd: number; background: number; noService: number }>>>;
    modelBoardings: number;
  };
  od?: {
    bart: {
      source: string;
      daily: StatBlock & { cells: { key: string; observed: number; model: number; pct: number }[] };
      perPeriod: Record<string, StatBlock>;
      byGroup: { key: string; observed: number; model: number; pct: number }[];
      byStation: { key: string; observed: number; model: number; pct: number }[];
      kinds: { group: string; observed: number; model: number }[];
      stationSplit: { group: string; observedTotal: number; modelTotal: number; shares: { station: string; observed: number; model: number }[] }[];
      largestMisses: { key: string; observed: number; model: number; diff: number }[];
    } | null;
    commute: {
      source: string;
      totalTransitShare: { observed: number; model: number };
      byDistrict: { district: string; observedShareOfCommuters: number; modelShareOfCommuters: number; observedTransitShare: number; modelTransitShare: number }[];
      districtTransit: StatBlock; districtJobs: StatBlock;
      tracts: { rows: unknown[]; transit: StatBlock; commuters: StatBlock };
    } | null;
    inCommuters: { rows: { puma: string; observedShare: number; modelShare: number; observedTransit: number; observedTransitSE: number; modelTransit: number; observedBart: number; commuters: number }[]; distribution: StatBlock; transitShare: StatBlock } | null;
    riders: {
      purposeMuniLightRail: { purpose: string; observed: number; model: number; modelSchoolDay?: number }[];
      purposeMuniBus: { purpose: string; observed: number; model: number; modelSchoolDay?: number }[];
      residentShare: { lightRail: { model: number; observed: number | null }; bus: { model: number; observed: number | null }; t: { model: number } };
      bartStations: { code: string; modelEntries: number; homeOriginShare: { observed: number | null; model: number }; homeAccessByTransit: { observed: number | null; model: number } }[];
      transfersBefore: { system: { model: number; observed: number | null; modelFromBart: number; modelFromCaltrain: number; modelFromMuni?: number; observedByOperator?: { muni: number; bart: number; caltrain: number; other: number } | null }; crossSurvey?: { muniSurveyTripsWithBart: number; bartSurveyTripsWithMuni: number; muniSurveyTripsWithCaltrain: number; caltrainSurveyTripsWithMuni: number } | null; routes: { route: string; model: number | null; modelFromBart: number | null; modelFromCaltrain: number | null; observed2017: number | null }[] };
      tThird: { purpose: Record<string, number>; tripEndsByDistrict: { district: string; daily: number; am: number }[]; access: Record<string, number>; boardings: number; byStop: { stop: string; boardings: number }[] };
    } | null;
  };
  shuttle?: { modelTrips: number; shareOfResidentTrips: number; batsShuttleVanpoolShare: number; note: string };
  ferry?: { source: string; rows: { route: string; name: string; observed: number; model: number }[]; n: number; r: number; pctRmse: number; totalRatio: number; within25: number };
  sensitivity: { test: string; measure: string; elasticity: number; range: number[]; central: number; source: string; corridor?: string[]; corridorElasticity?: number; systemElasticity?: number }[];
}
/** validation.json with the fields of the current validate.ts */
export const VX = validation as unknown as Omit<typeof validation, 'sensitivity'> & ValidationExtra;
export type Tier = 'calibration' | 'development' | 'independent' | 'held-out' | 'benchmark';
export const TIERS: Tier[] = ['held-out', 'independent', 'development', 'calibration', 'benchmark'];
export interface Check {
  what: string;
  value: string;
  standard: string;
  status: string;
  tier?: Tier;
}
/** scorecard.json: weekday checks, and the experimental weekend models' checks kept apart. Older
 * files have no tier on each check and count every check in the headline; newer ones count only
 * the independent and held-out tests. */
export const SCX = scorecard as unknown as { passed: number; total: number; byTier?: Record<Tier, { total: number; passed: number }>; checks: Check[]; weekend?: Check[] };
/** the weekday scorecard: every check, the tests that the headline counts (independent and held-out), and counts by tier */
export function tally() {
  const checks = SCX.checks.filter((c) => !/Saturday|Sunday/.test(c.what)).map((c) => ({ ...c, tier: tierOf(c) }));
  const pass = (c: Check) => c.status === 'pass';
  const tests = checks.filter((c) => c.tier === 'independent' || c.tier === 'held-out');
  const by = Object.fromEntries(TIERS.map((t) => [t, { total: checks.filter((c) => c.tier === t).length, passed: checks.filter((c) => c.tier === t && pass(c)).length }])) as Record<Tier, { total: number; passed: number }>;
  return { checks, tests, passed: tests.filter(pass).length, by };
}
/** a check's tier: as recorded, or as report.ts assigns it for files written before tiers existed */
export function tierOf(c: Check): Tier {
  if (c.tier) return c.tier;
  const w = c.what;
  if (/^Muni system boardings|in total$/.test(w)) return 'calibration';
  if (/^Muni routes|^Muni route groups|^Individual routes/.test(w)) return 'development';
  if (/^Backcast/.test(w)) return 'held-out';
  if (/Travel Model One/.test(w)) return 'benchmark';
  return 'independent';
}

export type Day = 'wkd' | 'sat' | 'sun';
export const DAYS: Day[] = ['wkd', 'sat', 'sun'];
export const DAY_NAME: Record<Day, string> = { wkd: 'Weekday', sat: 'Saturday', sun: 'Sunday' };

export interface RouteRow {
  route: string;
  category: string;
  observed: number;
  model: number;
  pct: number;
  acceptable: boolean;
  preferable: boolean;
  geh: number;
}
export const muni = (d: Day) => V.muni[d] as typeof V.muni.wkd & { routes: RouteRow[] };

/** The calibration targets for residents' commutes by household cars, as calibrate.ts builds them:
 * ACS B08141 (2024 1-year), with "other" split into bike and ride-hail in the proportions of B08301. */
export function workTargets(): Record<string, Record<string, number>> {
  const m1 = acs.residentsCommuteMode_B08301_ACS1yr2024.modes;
  const otherTot = m1.bike.count + m1.taxiRideHailing.count + m1.motorcycle.count + m1.otherMeans.count;
  const out: Record<string, Record<string, number>> = {};
  for (const [seg, v] of Object.entries(F.targets.b08141)) {
    const raw = { da: v.da, sr: v.sr, transit: v.transit, walk: v.walk, bike: (v.other * m1.bike.count) / otherTot, tnc: (v.other * m1.taxiRideHailing.count) / otherTot };
    const t = Object.values(raw).reduce((a, x) => a + x, 0);
    out[seg] = Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, x / t]));
  }
  const e = F.targets.ext as Record<string, number>;
  const te = Object.values(e).reduce((a, x) => a + x, 0);
  out.ext = Object.fromEntries(Object.entries(e).map(([k, x]) => [k, x / te]));
  return out;
}

/** the standards' text, for quoting thresholds with their source */
export const STD = V.standards;

/** Published transit validation of other models (server/beta3/reference/benchmarks.json). Each row
 * gives what that model was compared with and its route-level and rail-station statistics as
 * published, or as computed from a published table (computed: true). */
export interface BenchStats {
  n: number | null;
  pctRmse: number | null;
  r: number | null;
  r2: number | null;
  within25: number | null;
  computed?: boolean;
  note?: string;
}
export interface BenchRow {
  id: string;
  /** 'sf': models used for San Francisco; 'us': other U.S. models */
  group: 'sf' | 'us';
  /** shown in the article's comparison table */
  inTable: boolean;
  model: string;
  agency: string;
  baseYear: string;
  structure: string;
  compared: string;
  routes: BenchStats | null;
  rail: BenchStats | null;
  fit: string;
  refs: string[];
  loc?: string;
  uncertain?: string;
  /** Muni total boardings, observed and modeled, where published */
  muniTotal?: { observed: number; modeled: number; ratio: number };
  bartTotal?: { observed: number; modeled: number; ratio: number };
  muniBusTotal?: { observed: number; modeled: number; ratio: number };
  /** statistics for subsets of routes, computed from the published table */
  computedAlso?: Record<string, BenchStats>;
}
export const BENCH = benchmarks as unknown as {
  accessed: string;
  comparison: BenchRow[];
  tm1Table74: { all: BenchStats; bySubmode: Record<string, BenchStats>; busLocalAndLimited: BenchStats; metroWithoutF: BenchStats; withoutCableCarsAndF: BenchStats };
};
export const benchRow = (id: string) => {
  const b = BENCH.comparison.find((x) => x.id === id);
  if (!b) throw new Error(`benchmarks.json has no row ${id}`);
  return b;
};
