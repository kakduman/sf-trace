/**
 * Travel demand: who travels, where to, by which mode, and when.
 *
 *  1. Trip making: commutes from employed residents (ACS) on census home→work flows (LODES,
 *     rescaled to the ACS); other home-based trips from NHTS 2017 rates per person; trips not from
 *     home placed where activity is; hotel visitors, SFO air travellers and regional visitors.
 *  2. Destinations (all but commutes): a logit over zones of size (jobs by sector, schools,
 *     attractions...) and accessibility by every mode (the mode-choice logsum), so better transit
 *     draws trips to the places it serves.
 *  3. Mode: nested logit (auto, non-motorised, transit, ride-hail) with MTC Travel Model One
 *     coefficients and constants calibrated to San Francisco. Home-based tours choose a mode for the
 *     round trip, seeing the outbound and return conditions, each leg's at the mix of the periods it
 *     travels in (legWeights). Residents' tours then choose the modes of their trips conditional on
 *     the tour's mode (TRIP_SWITCH, tripSwitch): the trip into the primary destination is by the
 *     tour's mode, the trip back and those through stops choose, and the tour's utility counts the
 *     trip back at the logsum of its choice.
 *  4. Time of day: NHTS 2017 shares by purpose and direction (SF-CHAMP for visitors); a pair's
 *     transit trips lean toward the periods in which transit serves it best (periodSplit).
 */
import { autoCostOf, commuteDaysOf, wfhOf } from "./context";
import {
  AUTO_COST_PER_MILE,
  ABSENCE,
  ATTENDANCE,
  DIARY_COMMUTE_FACTOR,
  DIARY_COMMUTE_FACTOR_OTHER,
  COMMUTE_DAYS_BY_INCOME,
  HH_PERSONS_PUMA_FACTOR,
  SF_PUMA_TRACTS,
  COMMUTE_DAYS,
  COMMUTE_DAYS_OTHER,
  AGE010_TRANSIT,
  COLLEGE,
  SCHOOL_K5,
  SCHOOL_LEVELS,
  SCHOOL_RETURN,
  TOUR_COEFFS,
  COEFFS,
  coeffsOf,
  TRIP_SWITCH,
  TRIP_SWITCH_ASC,
  TRIP_SWITCH_STOP,
  tripScale,
  VOT_MAX,
  VOT_MEDIAN_OF_MEAN,
  VOT_MIN,
  VOT_MIX_W,
  VOT_MIX_Z,
  VOT_SIGMA,
  YOUTH_VOT_FACTOR,
  SHUTTLE_COUNTIES,
  SHUTTLE_RIDERS,
  STOP_MIX,
  STOP_NEAR_HOME,
  STOP_K,
  STOP_RATE_BY_MODE,
  STOPS_PER_HALF,
  TOUR_RATES,
  WORK_SUBTOURS,
  TUNE,
  PATH,
  HOTEL_ROOMS_SF,
  MODES,
  NEST,
  ORIGIN_DENSITY_CAP,
  EVENT_PARKING,
  PARKING_LONG,
  PARKING_SHORT,
  PURPOSES,
  FREE_MUNI_SENIORS,
  FREE_PARKING_SF,
  PERSON_FARE,
  PERSON_RATE,
  RATES,
  SCHOOL_TRIPS_PER_CHILD,
  SEGMENTS,
  SR_COST_SHARE,
  SR_OCCUPANCY,
  STAY_HOURS,
  TERMINAL_MIN,
  TNC,
  TNC_WAIT_BINS,
  TNC_WAIT_MIN,
  VISITORS_PER_ROOM,
  VISITOR_TRIPS,
  HH_VEH_INC_SEED,
  HH_PERSONS,
  INCOME_BANDS,
  INCOME_CLASSES,
  VOT_BY_INCOME,
  VOT_TYPICAL,
  VOT_VISITOR,
  costCoef,
  type Mode,
  type PersonType,
  type Purpose,
  UNDERREPORT,
} from "./params";
import { toXY } from "./geo";
import { segmentTables, synpopOf } from "./synpop";
import { longRunPrep } from "./autoown";
import {
  buildAbm,
  cdapZone,
  newCdapOut,
  segmentTours,
  tm1Dist,
  workSize,
  NM_PURPOSES,
  NM_TO_MODEL,
  type AbmPrep,
  type SegTours,
  type ZoneAccess,
} from "./abm";
import { ASIM } from "./asim-mtc";
import { microDemand, type MicroResult } from "./micromobility";
import {
  TPERIODS,
  type Bundle,
  type Calibration,
  type Corridor,
  type DayType,
  type DemandContext,
  type EventKind,
  type TPeriod,
} from "./types";

export type DayPeriod = "EA" | "AM" | "MD" | "PM" | "EV";
const DAY: DayPeriod[] = ["EA", "AM", "MD", "PM", "EV"];
export const TP_OF: Record<DayPeriod, TPeriod> = {
  EA: "NT",
  AM: "AM",
  MD: "MD",
  PM: "PM",
  EV: "NT",
};

/**
 * When each purpose's trips travel: the share of its trips in each period, and the share of those
 * leaving home (P→A). A tour's two halves are one trip each way, so for tours the shares are taken
 * from NHTS 2017 tours (SF–Oakland metro residents, weekdays): the period in which the leg into the
 * primary destination starts and the period in which the leg leaving it starts, half the trips each
 * (server/beta3/reference/nhts-tour-tod.json, nhts_tour_tod.py; for work and school, from the first
 * arrival to the last departure, so a lunch out is a subtour). Trip-level HBW/HBO shares, used before,
 * leave out the legs of tours with a stop (NHTS files them as trips not from home) and so did not
 * balance: 55% of work trips went to work and 45% came home.
 * Work timing was checked against the post-pandemic ACS 2024 (B08532, B08132; reference/time-of-day.json):
 * 80% of transit commuters to San Francisco jobs arrive 6–10am and 83% of residents commuting by
 * transit leave home then, in line with NHTS's transit work tours (80% leave for work 6–10am). What
 * fell after 2020 is how many days people commute (BATS 2023, in the commute rates), not when.
 * College tours: 41 sampled tours, so rough.
 */
export const TOD: Record<
  Purpose,
  { share: Record<DayPeriod, number>; fromHome: Record<DayPeriod, number> }
> = {
  work: {
    share: { EA: 0.0466, AM: 0.3548, MD: 0.1478, PM: 0.3632, EV: 0.0877 },
    fromHome: { EA: 0.961, AM: 0.989, MD: 0.565, PM: 0.052, EV: 0.021 },
  },
  school: {
    share: { EA: 0.0012, AM: 0.48, MD: 0.2027, PM: 0.3054, EV: 0.0106 },
    fromHome: { EA: 1, AM: 1, MD: 0.031, PM: 0.033, EV: 0.208 },
  },
  univ: {
    share: { EA: 0, AM: 0.3325, MD: 0.2228, PM: 0.3358, EV: 0.1089 },
    fromHome: { EA: 1, AM: 0.961, MD: 0.396, PM: 0.257, EV: 0.056 },
  },
  shop: {
    share: { EA: 0, AM: 0.1193, MD: 0.4904, PM: 0.2935, EV: 0.0968 },
    fromHome: { EA: 1, AM: 0.607, MD: 0.525, PM: 0.446, EV: 0.405 },
  },
  other: {
    share: { EA: 0.0065, AM: 0.2996, MD: 0.3276, PM: 0.2819, EV: 0.0843 },
    fromHome: { EA: 0.923, AM: 0.587, MD: 0.516, PM: 0.414, EV: 0.385 },
  },
  social: {
    share: { EA: 0.0103, AM: 0.1258, MD: 0.2835, PM: 0.3127, EV: 0.2676 },
    fromHome: { EA: 0.785, AM: 0.651, MD: 0.518, PM: 0.587, EV: 0.298 },
  },
  nhb: {
    share: { EA: 0.003, AM: 0.189, MD: 0.433, PM: 0.312, EV: 0.063 },
    fromHome: { EA: 1, AM: 1, MD: 1, PM: 1, EV: 1 },
  },
  // SF-CHAMP visitor model time of day (origin→destination / return)
  visitor: {
    share: { EA: 0.007, AM: 0.101, MD: 0.508, PM: 0.255, EV: 0.128 },
    fromHome: { EA: 0.57, AM: 0.56, MD: 0.5, PM: 0.46, EV: 0.52 },
  },
  airport: {
    share: { EA: 0.08, AM: 0.24, MD: 0.3, PM: 0.22, EV: 0.16 },
    fromHome: { EA: 0.9, AM: 0.65, MD: 0.5, PM: 0.4, EV: 0.3 },
  },
  regional: {
    share: { EA: 0.01, AM: 0.15, MD: 0.3, PM: 0.3, EV: 0.24 },
    fromHome: { EA: 0.9, AM: 0.85, MD: 0.6, PM: 0.4, EV: 0.15 },
  },
  // set for each kind of event from EVENT_TIMES (this is an evening game's)
  event: {
    share: { EA: 0, AM: 0, MD: 0, PM: 0.4, EV: 0.6 },
    fromHome: { EA: 1, AM: 1, MD: 1, PM: 1, EV: 0.17 },
  },
};

/**
 * When attendees arrive and leave, by kind of event: shares of the trips to the venue and of those
 * back by period (assumed from start times: games at about 7 pm, with the Warriors' TMP's arrivals
 * from 2½ hours before and the Pacific Bell Park TMP's; concerts at 8 pm; Giants day games at 12:45
 * and over by 4; conventions from 8 am). Mode choice sees each leg at these periods' mix of service
 * (legWeights), the night's included.
 */
const EVENT_TIMES: Record<EventKind, { in: Partial<Record<DayPeriod, number>>; out: Partial<Record<DayPeriod, number>> }> = {
  evening: { in: { PM: 0.8, EV: 0.2 }, out: { EV: 1 } },
  concert: { in: { PM: 0.4, EV: 0.6 }, out: { EV: 1 } },
  day: { in: { MD: 1 }, out: { MD: 0.15, PM: 0.85 } },
  convention: { in: { AM: 0.65, MD: 0.35 }, out: { MD: 0.15, PM: 0.65, EV: 0.2 } },
};

/**
 * A round trip's two directions balanced: the shares leaving home rescaled to half the trips, and
 * those coming back to the other half, each keeping its timing. For the weekend shares, which are
 * trip-level NHTS (nhts_daytypes.py) and so carry the imbalance described above. Air travelers'
 * trips are one way and are left as they are.
 */
function balanced(t: { share: Record<DayPeriod, number>; fromHome: Record<DayPeriod, number> }) {
  let o = 0,
    r = 0;
  for (const p of DAY) ((o += t.share[p] * t.fromHome[p]), (r += t.share[p] * (1 - t.fromHome[p])));
  if (o <= 0 || r <= 0) return t;
  const share = {} as Record<DayPeriod, number>,
    fromHome = {} as Record<DayPeriod, number>;
  for (const p of DAY) {
    const a = (0.5 * t.share[p] * t.fromHome[p]) / o,
      b = (0.5 * t.share[p] * (1 - t.fromHome[p])) / r;
    share[p] = a + b;
    fromHome[p] = a + b > 0 ? a / (a + b) : t.fromHome[p];
  }
  return { share, fromHome };
}

// visitors' and regional visitors' day trips are round trips too
TOD.visitor = balanced(TOD.visitor);
TOD.regional = balanced(TOD.regional);

/**
 * The periods each leg of a purpose's trips travels in: for the leg out (production to attraction)
 * and the leg back, the share of it in each assignment period, from the same time-of-day shares
 * that book the trips (TOD; the early morning and the evening make the night). Mode choice sees
 * each leg's level of service as these shares' mix of the periods' (see `leg`), so a social tour's
 * night return (37% of them come home after 7pm, NHTS 2017 tours) is chosen on night service, not
 * the evening peak's. Trips not from home are one way: every one goes out.
 */
export type LegWeights = { out: Float64Array; back: Float64Array; outShare: number; backShare: number };
export function legWeights(t: { share: Record<DayPeriod, number>; fromHome: Record<DayPeriod, number> }, oneWay: boolean): LegWeights {
  const out = new Float64Array(TPERIODS.length),
    back = new Float64Array(TPERIODS.length);
  for (const dp of DAY) {
    const k = TPERIODS.indexOf(TP_OF[dp]);
    const fh = oneWay ? 1 : t.fromHome[dp];
    out[k] += t.share[dp] * fh;
    back[k] += t.share[dp] * (1 - fh);
  }
  const so = out.reduce((a, v) => a + v, 0),
    sb = back.reduce((a, v) => a + v, 0);
  for (let k = 0; k < out.length; k++) {
    out[k] = so > 0 ? out[k] / so : 0;
    back[k] = sb > 0 ? back[k] / sb : out[k];
  }
  return { out, back, outShare: so, backShare: oneWay ? 0 : sb };
}
const AUTO_OF_DAY: Record<DayType, Record<TPeriod, string>> = {
  wkd: { AM: "AM", MD: "MD", PM: "PM", NT: "EV" },
  // weekends: no commute peaks; SFCTA's weekday midday speeds stand in for the day (assumed)
  sat: { AM: "MD", MD: "MD", PM: "MD", NT: "EV" },
  sun: { AM: "MD", MD: "MD", PM: "MD", NT: "EV" },
};
/** NHTS purposes behind the model's purposes (for weekend rates and timing) */
const NHTS_OF: Partial<Record<Purpose, string>> = {
  work: "HBW",
  school: "HBSCH_K12",
  univ: "HBUNIV",
  shop: "HBSHOP",
  other: "HBO",
  social: "HBSOCREC",
  nhb: "NHB",
};

export interface TrnSkim {
  /** perceived minutes for mode choice: weighted IVT + 2×wait + 2×walk (+ mode bias); Infinity if none */
  g: Float32Array;
  boards: Float32Array;
  fare: Float32Array;
  /** money other than fares, which no person type's discount applies to (shared bikes' and scooters'
   * prices on the way to and from stations: net.ts C_COST) */
  cost?: Float32Array;
  /** actual door-to-door minutes */
  time: Float32Array;
}
/** a skim for each assignment period, the night's included (on the night's blend of evening and owl service) */
export type TrnSkims = Record<TPeriod, TrnSkim>;

export type SegPeopleKind = "persons" | "employed" | "age5to17" | "age65plus" | "adults";

/** Zone-level inputs prepared once per bundle. */
export interface Prep {
  NZ: number;
  NX: number;
  Z: number;
  /** zones of the transit network (net.ts transitZones): each outside zone has a home and an activity end */
  ZT: number;
  /** segment shares of households per zone (car0, car1, car2) */
  seg: Float32Array[];
  /** shares of households per zone by car segment and income class ([s][c]; summing over c gives seg) */
  segInc: Float32Array[][];
  /**
   * shares of each zone's people by car segment and income class ([s][c], summing to one over both):
   * all residents, employed residents, children 5–17, persons 65 and over, and the rest (adults
   * 18–64 and children under 5), from the household shares and the persons per household of each
   * kind (params HH_PERSONS)
   */
  segPeople: Record<SegPeopleKind, Float32Array[][]>;
  /** VOT $/h per internal zone by income class (the harmonic mean of its bands) */
  votInc: Float32Array[];
  /** residents' commutes per zone by car segment and income class, as shares ([s][c]) */
  workShare: Float32Array[][];
  /** residents per zone by car segment and income class ([s][c]): all, aged 5–17, 65 and over, in college */
  people: { pop: Float32Array[][]; youth: Float32Array[][]; senior: Float32Array[][]; college: Float32Array[][] };
  /** where the segment shares came from */
  segSource: SynpopMode;
  /** VOT $/h per internal zone (income mix) */
  vot: Float32Array;
  size: Record<string, Float32Array>;
  terminal: Float32Array;
  parkLong: Float32Array;
  parkShort: Float32Array;
  tncWait: Float32Array;
  densIdx: Float32Array;
  hotelVisitors: Float32Array;
  nhbProd: Float32Array;
  /** park acreage per zone (added to recreation and visitor size terms with a calibrated weight) */
  parkAcres: Float32Array;
  /** 1 where a campus's students ride all transit free (Gator Pass) */
  collegePass: Uint8Array;
  /** the person-level choices' segments (abm.ts), when they are on */
  abm: AbmPrep | null;
  /** workplace size by TM1 income segment (4) over city zones and outside zones (their residents' census
   * workplaces, scaled), and the census flows' workplace totals of the city's residents (the shadow prices' target) */
  workSize: Float32Array[];
  workTarget: Float64Array;
  /** workplaces grouped for checking flows: the city's neighborhoods, then counties outside */
  workGroups: string[];
  workGroupOf: Int32Array;
}

/**
 * Whether demand's residents make their tours by the person-level choices (abm.ts) or by aggregate
 * tour rates, and whether their workplaces are chosen or the census flows'. Set by the bundle's
 * calibration (`abm`) or overridden here for an experiment.
 */
/** override of the calibration's commuteBasis (experiments) */
export const COMMUTE_BASIS: { basis: "stated" | "diary" | null } = { basis: null };
export const ABM: { on: boolean | null; workplace: "choice" | "observed" | null } = { on: null, workplace: null };
/** diagnostics (abm-check.ts): when set, each origin's inputs to tour frequency are kept here */
export const ABM_DEBUG: { inputs: Map<number, { acc: ZoneAccess; stats: Float64Array; school: [number, number] }> | null } = { inputs: null };

/**
 * Destination size terms. storefrontWeight: the weight of OpenStreetMap storefront counts against
 * LODES employment in the retail, food-service and other-service size terms (assumed: an even
 * average; LODES leaves out the self-employed and counts chains' head offices, OSM misses some
 * storefronts in outer neighborhoods). hotelJobsPerRoom: hotel staff per room, taken out of LODES's
 * food-and-accommodation sector so hotels don't count as restaurants (assumed). otherAllJobs: weight
 * of all jobs in the errands size term (0; it was 0.1, which drew errands to downtown offices).
 */
export const SIZE = { storefrontWeight: 0.5, hotelJobsPerRoom: 0.5, otherAllJobs: 0 };
/**
 * personShares: split each zone's people by car segment and income class with the shares of its
 * people of each kind (Prep.segPeople), not of its households (false: households' shares, as before
 * October 2026; for experiments).
 * commuteDaysByIncome: commuters in households under $100,000 go in on more weekdays than those
 * above (params.ts COMMUTE_DAYS_BY_INCOME; false: one rate for all, as before).
 * visitorTripsOwnChoice: hotel visitors' trips not from their hotel (one a day) start where visitors
 * go and choose a mode as visitors do (false: pooled with in-commuters' trips not from home, with
 * residents' one-car constants and the jobs-weighted origins, as before).
 * pumaHouseholdSize: persons per household by car segment scaled to each zone's PUMA
 * (params.ts HH_PERSONS_PUMA_FACTOR; false: the city's rates everywhere, as before).
 */
export const DEMAND_OPTS = { personShares: true, commuteDaysByIncome: true, visitorTripsOwnChoice: true, pumaHouseholdSize: true };

/**
 * Each income class's commute days relative to the city's mean (BATS 2023 Table 46), weighted by the
 * city's commuters in each class so that the city's commutes keep ATTENDANCE: factor c is
 * days[c] / Σ_k share_k · days[k].
 */
export function commuteDaysByClass(
  zones: readonly { workers: number; wfh: number }[],
  share: (kind: "employed", s: number, c: number, o: number) => number,
  days: readonly number[] = COMMUTE_DAYS_BY_INCOME,
): number[] {
  if (!DEMAND_OPTS.commuteDaysByIncome) return INCOME_CLASSES.map(() => 1);
  const w = INCOME_CLASSES.map(() => 0);
  zones.forEach((z, o) => {
    const c = z.workers * (1 - z.wfh);
    for (let s = 0; s < 3; s++) for (let k = 0; k < w.length; k++) w[k] += c * share("employed", s, k, o);
  });
  const W = w.reduce((a, v) => a + v, 0);
  const mean = W > 0 ? w.reduce((a, v, k) => a + v * days[k], 0) / W : 1;
  return INCOME_CLASSES.map((_, k) => days[k] / mean);
}

/**
 * The shape of distance in destination choice. 'linear': the calibrated coefficient times km.
 * 'tm1': Travel Model One's piecewise-linear distance terms by purpose (DestinationChoice.xls:
 * slopes per mile over 0-1, 1-2, 2-5, 5-15 and 15+ miles), rescaled to equal 5 at 5 km so the
 * calibrated coefficient keeps its meaning there: errands and shopping feel no distance within 2
 * miles beyond the travel time in the logsum, and every purpose's marginal distance cost falls with
 * distance.
 */
export const DIST_FORM = { form: "tm1" as "linear" | "tm1" };
const TM1_DIST: Partial<Record<Purpose, number[]>> = {
  shop: [0, 0, -0.5655, -0.1832, -0.1832],
  other: [0, 0, -0.6055, -0.1093, -0.1093],
  social: [-1.2231, -0.2365, -0.4056, -0.1484, -0.0659],
  visitor: [-1.2231, -0.2365, -0.4056, -0.1484, -0.0659],
  nhb: [-1.2384, -0.4567, -0.5153, -0.168, -0.2326],
  school: [-3.7147, -1.3639, -0.7033, -0.3209, -0.0308],
  univ: [-2.0278, -2.3505, -0.4669, -0.2564, -0.1385],
};
const tm1U = (b: readonly number[], km: number) => {
  const mi = km / 1.609;
  return (
    b[0] * Math.min(mi, 1) +
    b[1] * Math.max(0, Math.min(mi, 2) - 1) +
    b[2] * Math.max(0, Math.min(mi, 5) - 2) +
    b[3] * Math.max(0, Math.min(mi, 15) - 5) +
    b[4] * Math.max(0, mi - 15)
  );
};
/** distance as destination choice sees it, in km-equivalents (km itself when the form is linear) */
export function distTerm(purpose: Purpose, km: number): number {
  const b = DIST_FORM.form === "tm1" ? TM1_DIST[purpose] : undefined;
  return b ? (5 * tm1U(b, km)) / tm1U(b, 5) : km;
}

/**
 * The log of distance in destination choice and stop placement, beside the linear (or TM1) term: as
 * in the Atlanta Regional Commission's CT-RAMP destination choice, which has distance, its square, its
 * cube, and its log by purpose (on the log: −0.96 shopping, −0.59 maintenance, −2.53 escorting;
 * ActivitySim prototype_arc, non_mandatory_tour_destination_coeffs.csv). A linear term alone,
 * fitted to the mean length, spreads trips evenly over the nearest two miles, where the opportunities
 * grow with the ring's area, so it leaves too few trips very close to home and too many at a mile or
 * two. Distances below NEAR_KM_FLOOR (a block) count as that.
 */
export const NEAR_KM_FLOOR = 0.1;
export const nearTerm = (km: number) => Math.log(Math.max(km, NEAR_KM_FLOOR));

/** destination size per park acre, before the calibrated multiplier (relative weights assumed) */
export const PARK_SIZE: Partial<Record<Purpose, number>> = {
  social: 10,
  visitor: 4,
  regional: 6,
};

/**
 * Where demand's market segments come from. 'off': each zone's households by car ownership and income
 * are the city's PUMS table raked to the zone's ACS margins, and its residents of every kind are split
 * as its households are. 'households': the segments' household shares are counted from the synthetic
 * population (shared/beta3/synpop.ts) instead. 'persons': also the residents of each kind (commuters,
 * children, seniors, college students) are split by the segments they live in, so a zone's workers
 * lean to its households with cars and higher incomes as its people do. Zone totals stay the ACS's.
 * Falls back to 'off' when the bundle carries no population. Set by the bundle's calibration
 * (`segments`, so workers in the browser see it too), or overridden here for an experiment.
 */
export type SynpopMode = "off" | "households" | "persons";
export const SYNPOP: { mode: SynpopMode | null } = { mode: null };

export function prepare(b: Bundle): Prep {
  const H = b.header;
  const NZ = H.zones.length,
    NX = H.ext.length,
    Z = NZ + NX,
    ZT = NZ + 2 * NX;
  const seg = SEGMENTS.map(() => new Float32Array(NZ));
  const segInc = SEGMENTS.map(() => INCOME_CLASSES.map(() => new Float32Array(NZ)));
  const PEOPLE: SegPeopleKind[] = ["persons", "employed", "age5to17", "age65plus", "adults"];
  const segPeople = Object.fromEntries(
    PEOPLE.map((k) => [k, SEGMENTS.map(() => INCOME_CLASSES.map(() => new Float32Array(NZ)))]),
  ) as Record<SegPeopleKind, Float32Array[][]>;
  // people per household of each car segment and income class: the PUMS rates by band, weighted by
  // the city's households in each band of the class (adults: all persons less children 5–17 and seniors)
  const perHH = Object.fromEntries(
    PEOPLE.map((k) => [
      k,
      SEGMENTS.map((_, s) =>
        INCOME_CLASSES.map((bs) => {
          const r = (b: number) =>
            k === "adults"
              ? HH_PERSONS.persons[s][b] - HH_PERSONS.age5to17[s][b] - HH_PERSONS.age65plus[s][b]
              : HH_PERSONS[k][s][b];
          const w = bs.reduce((a, b) => a + HH_VEH_INC_SEED[s][b], 0);
          return bs.reduce((a, b) => a + HH_VEH_INC_SEED[s][b] * r(b), 0) / w;
        }),
      ),
    ]),
  ) as Record<SegPeopleKind, number[][]>;
  // each SF tract's PUMA (for household sizes by area)
  const pumaOfTract = new Map<string, string>();
  for (const [p, ts] of Object.entries(SF_PUMA_TRACTS)) for (const t of ts.split(" ")) pumaOfTract.set(t, p);
  const votInc = INCOME_CLASSES.map(() => new Float32Array(NZ));
  const vot = new Float32Array(NZ);
  const terminal = new Float32Array(NZ),
    parkLong = new Float32Array(NZ),
    parkShort = new Float32Array(NZ),
    tncWait = new Float32Array(NZ),
    densIdx = new Float32Array(NZ);
  const size: Record<string, Float32Array> = {};
  for (const p of [
    "school",
    "univ",
    "shop",
    "other",
    "social",
    "nhb",
    "visitor",
    "regional",
    "airport",
    "school0",
    "school1",
    "school2",
    "univR",
    "univNR",
  ])
    size[p] = new Float32Array(NZ);
  const collegePass = new Uint8Array(NZ);
  const rooms = H.zones.reduce((s, z) => s + z.hotelRooms, 0);
  // what draws shoppers, diners and errands, in job equivalents (see SIZE below): each zone's LODES
  // retail and food-service jobs averaged with its OpenStreetMap storefronts, each storefront worth
  // the city's jobs per storefront of its kind. Food service is LODES's food-and-accommodation sector
  // less the hotels' own staff (rooms × SIZE.hotelJobsPerRoom).
  const hotelJobs = (z: (typeof H.zones)[number]) =>
    (z.hotelRooms / Math.max(rooms, 1)) * HOTEL_ROOMS_SF * SIZE.hotelJobsPerRoom;
  const foodJobs = H.zones.map((z) => Math.max(0, z.jobsBy[17] - hotelJobs(z)));
  const hasStorefronts = H.zones.some((z) => (z.shops ?? 0) + (z.eateries ?? 0) > 0);
  const perStorefront = (jobs: number, n: number) => (n > 0 ? jobs / n : 0);
  const sumZ = (f: (z: (typeof H.zones)[number], i: number) => number) => H.zones.reduce((a, z, i) => a + f(z, i), 0);
  const jobsPerShop = perStorefront(sumZ((z) => z.jobsBy[6]), sumZ((z) => z.shops ?? 0));
  const jobsPerEatery = perStorefront(sumZ((_, i) => foodJobs[i]), sumZ((z) => z.eateries ?? 0));
  const jobsPerService = perStorefront(sumZ((z) => z.jobsBy[18]), sumZ((z) => z.services ?? 0));
  const w = hasStorefronts ? SIZE.storefrontWeight : 0;
  const retailSize = H.zones.map((z) => (1 - w) * z.jobsBy[6] + w * jobsPerShop * (z.shops ?? 0));
  const foodSize = H.zones.map((z, i) => (1 - w) * foodJobs[i] + w * jobsPerEatery * (z.eateries ?? 0));
  const serviceSize = H.zones.map((z) => (1 - w) * z.jobsBy[18] + w * jobsPerService * (z.services ?? 0));
  const hotelVisitors = new Float32Array(NZ);
  const nhbProd = new Float32Array(NZ);
  const parkAcres = new Float32Array(NZ);
  H.zones.forEach((z, i) => {
    const hh = Math.max(1e-6, z.hhVeh[0] + z.hhVeh[1] + z.hhVeh[2]);
    for (let s = 0; s < 3; s++)
      seg[s][i] = z.hh > 0 ? z.hhVeh[s] / hh : s === 1 ? 1 : 0;
    const inc = Math.max(1e-6, z.hhInc.reduce((a, v) => a + v, 0));
    // the harmonic mean keeps cost sensitivity right for a mix of incomes
    vot[i] =
      z.hh > 0
        ? 1 / (z.hhInc.reduce((a, v, k) => a + v / VOT_BY_INCOME[k], 0) / inc)
        : VOT_TYPICAL;
    // households by car segment and income class: the city's joint table (ACS PUMS) raked to the
    // zone's two margins
    {
      const cls = (v: readonly number[]) => INCOME_CLASSES.map((bs) => bs.reduce((a, b) => a + v[b], 0));
      const seed = HH_VEH_INC_SEED.map((r) => cls(r));
      const cityInc = cls(INCOME_BANDS.map((_, k) => HH_VEH_INC_SEED.reduce((a, r) => a + r[k], 0)));
      const cityTot = cityInc.reduce((a, v) => a + v, 0);
      const rows = seg.map((sg) => sg[i]);
      const cols = z.hh > 0 && inc > 1e-3 ? cls(z.hhInc).map((v) => v / inc) : cityInc.map((v) => v / cityTot);
      const m = seed.map((r) => r.map((v) => v));
      INCOME_CLASSES.forEach((bs, c) => {
        const n = bs.reduce((a, b) => a + z.hhInc[b], 0);
        votInc[c][i] = z.hh > 0 && n > 1e-3 ? 1 / (bs.reduce((a, b) => a + z.hhInc[b] / VOT_BY_INCOME[b], 0) / n) : 1 / (bs.reduce((a, b) => a + 1 / VOT_BY_INCOME[b], 0) / bs.length);
      });
      for (let it = 0; it < 30; it++) {
        for (let a = 0; a < m.length; a++) {
          const t = m[a].reduce((x, v) => x + v, 0);
          for (let k = 0; k < m[a].length; k++) m[a][k] = t > 0 ? (m[a][k] * rows[a]) / t : 0;
        }
        for (let k = 0; k < cols.length; k++) {
          const t = m.reduce((x, r) => x + r[k], 0);
          for (let a = 0; a < m.length; a++) m[a][k] = t > 0 ? (m[a][k] * cols[k]) / t : 0;
        }
      }
      // rows exactly (the car segments are what the rest of the model uses)
      for (let a = 0; a < m.length; a++) {
        const t = m[a].reduce((x, v) => x + v, 0);
        for (let k = 0; k < m[a].length; k++) segInc[a][k][i] = t > 0 ? (m[a][k] * rows[a]) / t : rows[a] / m[a].length;
      }
      // the zone's people of each kind by segment and class, with its PUMA's household sizes
      const pf = DEMAND_OPTS.pumaHouseholdSize ? HH_PERSONS_PUMA_FACTOR[pumaOfTract.get(z.id?.slice(5, 11) ?? "") ?? ""] : undefined;
      const rate = (kind: SegPeopleKind, a: number, c: number) => {
        if (!pf) return perHH[kind][a][c];
        if (kind !== "adults") return perHH[kind][a][c] * pf[kind][a];
        return perHH.persons[a][c] * pf.persons[a] - perHH.age5to17[a][c] * pf.age5to17[a] - perHH.age65plus[a][c] * pf.age65plus[a];
      };
      for (const kind of PEOPLE) {
        let t = 0;
        for (let a = 0; a < SEGMENTS.length; a++)
          for (let c = 0; c < INCOME_CLASSES.length; c++) t += segInc[a][c][i] * Math.max(0, rate(kind, a, c));
        for (let a = 0; a < SEGMENTS.length; a++)
          for (let c = 0; c < INCOME_CLASSES.length; c++)
            segPeople[kind][a][c][i] = t > 0 ? (segInc[a][c][i] * Math.max(0, rate(kind, a, c))) / t : segInc[a][c][i];
      }
    }
    terminal[i] = TERMINAL_MIN[z.areaType];
    parkLong[i] = PARKING_LONG[z.areaType];
    parkShort[i] = PARKING_SHORT[z.areaType];
    let w = TNC_WAIT_MIN[TNC_WAIT_MIN.length - 1];
    for (let k = 0; k < TNC_WAIT_BINS.length; k++)
      if (z.density < TNC_WAIT_BINS[k]) {
        w = TNC_WAIT_MIN[k];
        break;
      }
    tncWait[i] = w;
    densIdx[i] = z.densityIndex;
    const J = z.jobsBy;
    // size terms (assumed weights on LODES sectors: 07 retail, 15 education, 16 health, 17 arts, 18 food & lodging, 19 other services, 20 public admin;
    // retail, food service and other services as storefront-weighted job equivalents, above)
    // K-12: pupils at the schools in the zone (CDE enrollment by school); without them, OSM schools at
    // ~300 pupils each plus MTC's high-school enrollment. College: MTC enrollment
    size.school[i] =
      z.schoolEnroll !== undefined
        ? z.schoolEnroll
        : z.schools * 300 + (z.hsEnroll ?? 0) + 0.05 * J[14];
    size.univ[i] =
      z.collegeEnroll !== undefined
        ? z.collegeEnroll + 0.01 * J[14]
        : z.universities * 800 + 0.3 * J[14] * (z.universities > 0 ? 1 : 0.1);
    // each school level's pupils at the zone's schools (by grade band); each campus's students living
    // in the city and outside it
    SCHOOL_LEVELS.forEach((lv, l) => (size[`school${l}`][i] = z.schoolEnrollBy?.[l] ?? size.school[i] * lv.share));
    const rs = z.collegeResShare ?? COLLEGE.residentShare;
    size.univR[i] = size.univ[i] * rs;
    size.univNR[i] = size.univ[i] * (1 - rs);
    if (z.collegePass) collegePass[i] = 1;
    const R = retailSize[i], F = foodSize[i], V = serviceSize[i];
    size.shop[i] = R + 0.25 * F;
    // errands (NHTS 'other': services, medical, personal business, escorting): services, health care,
    // public offices and some retail, plus homes (visits and escorting). TM1's othMaint has no office
    // employment; an earlier 0.1 × all jobs here drew errands to the Financial District's offices.
    size.other[i] =
      0.4 * z.hh +
      J[15] +
      V +
      J[19] +
      0.3 * R +
      0.2 * J[14] +
      SIZE.otherAllJobs * z.jobs;
    // parks are added by acreage at choice time (their weight is calibrated to park visits)
    parkAcres[i] = z.parkAcres ?? 0;
    size.social[i] = F + 1.5 * J[16] + 0.5 * z.hh + 40 * z.attractions;
    size.nhb[i] = 0.5 * z.jobs + R + F + 0.2 * z.hh;
    size.visitor[i] = 2 * J[16] + F + 120 * z.attractions + 0.5 * R;
    size.regional[i] = F + 1.5 * J[16] + R + 60 * z.attractions;
    size.airport[i] =
      (z.hotelRooms / Math.max(rooms, 1)) * HOTEL_ROOMS_SF * 1.5 +
      0.15 * z.hh +
      0.03 * z.jobs;
    hotelVisitors[i] =
      (z.hotelRooms / Math.max(rooms, 1)) * HOTEL_ROOMS_SF * VISITORS_PER_ROOM;
    nhbProd[i] = z.jobs + 2 * R + 2 * F + 0.3 * z.pop;
  });
  // segment shares from the synthetic population
  const mode: SynpopMode = SYNPOP.mode ?? H.calibration?.segments ?? "off";
  const pop = mode !== "off" ? synpopOf(b) : null;
  const segSource: SynpopMode = pop ? mode : "off";
  const NC = INCOME_CLASSES.length;
  const mk = () => SEGMENTS.map(() => INCOME_CLASSES.map(() => new Float32Array(NZ)));
  const workShare = mk();
  const people = { pop: mk(), youth: mk(), senior: mk(), college: mk() };
  const T = pop ? segmentTables(pop, NZ) : null;
  const byClass = (t: Float32Array[][], s: number, c: number, i: number) => INCOME_CLASSES[c].reduce((a, k) => a + t[s][k][i], 0);
  H.zones.forEach((z, i) => {
    if (T) {
      let n = 0;
      for (let s = 0; s < 3; s++) for (let c = 0; c < NC; c++) n += byClass(T.households, s, c, i);
      if (n > 0) {
        for (let s = 0; s < 3; s++) {
          seg[s][i] = 0;
          for (let c = 0; c < NC; c++) seg[s][i] += segInc[s][c][i] = byClass(T.households, s, c, i) / n;
        }
        // values of time: the harmonic mean over the zone's synthetic households of each class
        let inv = 0;
        INCOME_CLASSES.forEach((bs, c) => {
          let m = 0, iv = 0;
          for (const k of bs)
            for (let s = 0; s < 3; s++) {
              m += T.households[s][k][i];
              iv += T.households[s][k][i] / VOT_BY_INCOME[k];
            }
          if (m > 0) votInc[c][i] = m / iv;
          inv += iv;
        });
        vot[i] = n / inv;
      }
    }
    // residents by segment: (persons) as the synthetic residents of each kind; with the synthetic
    // households, as the households; else as the zone's people of each kind (segPeople: the raked
    // households' shares times the PUMS persons per household of that kind, DEMAND_OPTS.personShares),
    // since households without a car are small
    const split = (out: Float32Array[][], total: number, t: Float32Array[][] | null, kind: SegPeopleKind) => {
      let n = 0;
      if (t) for (let s = 0; s < 3; s++) for (let c = 0; c < NC; c++) n += byClass(t, s, c, i);
      const sh = !T && DEMAND_OPTS.personShares ? segPeople[kind] : segInc;
      for (let s = 0; s < 3; s++)
        for (let c = 0; c < NC; c++) out[s][c][i] = n > 0 ? (total * byClass(t!, s, c, i)) / n : total * sh[s][c][i];
    };
    const P = segSource === "persons" ? T : null;
    split(workShare, 1, P && P.commuters, "employed");
    split(people.pop, z.pop, P && P.persons, "persons");
    split(people.youth, z.age5to17, P && P.youth, "age5to17");
    split(people.senior, z.age65plus, P && P.seniors, "age65plus");
    split(people.college, z.college, P && P.college, "adults");
  });
  // the person-level choices
  const abmOn = ABM.on ?? H.calibration?.abm?.on ?? false;
  const sp = abmOn ? synpopOf(b) : null;
  const abm = sp ? buildAbm(sp, NZ) : null;
  const workTarget = new Float64Array(NZ + NX);
  {
    // (a bundle without commute flows, as in tests, has no targets)
    const fh = (b.a.flowH ?? new Int32Array(0)) as Int32Array, fw = (b.a.flowW ?? new Int32Array(0)) as Int32Array, fn = (b.a.flowN ?? new Float32Array(0)) as Float32Array;
    const tot = new Float64Array(NZ);
    for (let i = 0; i < fh.length; i++) tot[fh[i]] += fn[i];
    // each zone's commuters (the census employed less those working from home) over its flows
    for (let i = 0; i < fh.length; i++) {
      const z = H.zones[fh[i]];
      workTarget[fw[i]] += (z.workers * (1 - z.wfh) * fn[i]) / tot[fh[i]];
    }
  }
  const workSizeArr = [0, 1, 2, 3].map((band) => {
    const w = new Float32Array(NZ + NX);
    let si = 0, ti = 0;
    H.zones.forEach((z, i) => ((w[i] = workSize(z.jobsBy, band)), (si += w[i]), (ti += workTarget[i])));
    // outside the city: its residents' census workplaces there, at the city's size per worker
    for (let e = 0; e < NX; e++) w[NZ + e] = (workTarget[NZ + e] * si) / Math.max(1, ti);
    return w;
  });
  const workGroups: string[] = [];
  const workGroupOf = Int32Array.from([...H.zones.map((z) => z.nhood), ...H.ext.map((x) => x.county)], (g) => {
    let k = workGroups.indexOf(g);
    if (k < 0) k = workGroups.push(g) - 1;
    return k;
  });
  return {
    abm,
    workSize: workSizeArr,
    workTarget,
    workGroups,
    workGroupOf,
    NZ,
    NX,
    Z,
    ZT,
    seg,
    segInc,
    segPeople,
    votInc,
    workShare,
    people,
    segSource,
    vot,
    size,
    terminal,
    parkLong,
    parkShort,
    tncWait,
    densIdx,
    hotelVisitors,
    nhbProd,
    parkAcres,
    collegePass,
  };
}

export interface DemandResult {
  /** transit person trips by assignment period, Z×Z (origin row) */
  transitOD: Record<TPeriod, Float32Array>;
  trips: Record<Mode, number>;
  residentTrips: Record<Mode, number>;
  byPurpose: Record<string, Record<Mode, number>>;
  /** residents' work trips by segment and mode (for calibration against the ACS) */
  workBySeg: Record<string, Record<Mode, number>>;
  /** residents' non-work home-based trips by segment and mode */
  nonworkBySeg: Record<string, Record<Mode, number>>;
  /** residents' tour legs by household income band (adults and seniors) */
  byIncome: Record<Mode, number>[];
  /** residents' tour legs by persons under 18 (school and non-work tours) */
  youthTrips: Record<Mode, number>;
  /** residents' school and college trips (tours' legs, with the legs through their stops) */
  studentTrips: Record<Mode, number>;
  /** school and college trips arriving at each zone by size term, and school trips by level (DemandPart) */
  attract: Record<string, Float64Array>;
  schoolStats: Float64Array;
  /** school trips by level and direction: [to school by mode (6), home by mode (6), car-passenger tours' legs home, of them by transit] */
  schoolDir: Float64Array;
  /** one venue's attendees' transit trips by period, when EVENT_OD.venue is set */
  eventTransitOD?: Record<TPeriod, Float32Array | Float64Array>;
  /** non-residents' transit trips by period, when NONRES_OD.on */
  nonResTransitOD?: Record<TPeriod, Float32Array>;
  collegeModes: Float64Array;
  /** tours that stop: stop mass by tour purpose and mode */
  stopByPurpose: Record<string, number[]>;
  vkt: number;
  logsum: number;
  zoneTransitShare: Float32Array;
  zoneLogsum: Float32Array;
  /** mean transit door-to-door minutes, weighted by transit trips */
  avgTransitMin: number;
  /** mean trip km by purpose (for calibrating destination choice); '<purpose><5mi': of its trips of up to 5 miles */
  meanKm: Record<string, number>;
  /**
   * trips inside the city by purpose (and stops' detour legs, 'stop:<mode class>') by road distance
   * band (LENGTH_BANDS_MI), as shares, with the share within one zone after the bands
   */
  kmBands: Record<string, number[]>;
  /** residents' commute trips and those by transit, by home zone */
  zoneWork: Float64Array;
  zoneWorkTransit: Float64Array;
  /** trips arriving at each zone (all modes), and those for recreation and visiting */
  zoneVisits: Float64Array;
  zoneVisitsLeisure: Float64Array;
  /** tour trips arriving at each zone (destinations, not stops on the way): all modes and transit, interleaved [all, transit] */
  zoneArrivals: Float64Array;
  /** trips drawn by each park (its share of the destination pull where it lies), per day */
  parkVisits: Record<string, number>;
  /** trips on private commuter shuttles (both directions), in total and by car-ownership segment */
  shuttleTrips: number;
  shuttleBySeg: Record<string, number>;
  /** commute trips across the city line by mode: into the city by home county, out of it by work county */
  workIn: Record<string, Record<Mode, number>>;
  workOut: Record<string, Record<Mode, number>>;
  /** in-commuter trips by outside zone: all modes and transit, interleaved [all, transit] */
  workInZone: Float64Array;
  shuttleOut: Record<string, number>;
  nhbPool: Record<Mode, number>;
  /** cars across the city line by market (resident purposes prefixed 'res '), by counted crossing (LINE_X; 0: uncounted) */
  lineVeh: Record<string, Float64Array>;
  /** person trips across the city line by market, by mode and outside zone (6 × NX) */
  lineTrips: Record<string, Float64Array>;
  /** special-event trips (to the venue and back) by venue and mode */
  eventModes: Record<string, Record<Mode, number>>;
  carOwn: CarOwnership;
  /** residents' tours by transit that stop, by the tour's purpose (their trips; the stop legs' tour purposes) */
  stopTransitByPurpose: Record<string, number>;
  /** trips inside the city by market, distance band (LENGTH_BANDS_MI), and mode, [band × 6 + mode]
   * (residents' legs through stops of tours other than by transit only when markets are tallied) */
  lengthBands: Record<string, Float64Array>;
  abm?: AbmTally;
  autoOD?: Record<TPeriod, Float32Array>;
  tncEnds?: Record<TPeriod, Float64Array>;
  /** average driving minutes of car trips (alone or carpooling): commutes, and all */
  driveMin: { work: number; all: number };
  /** shared bikes and scooters among the bike trips (micromobility.ts) */
  micro?: MicroResult;
  /**
   * residents' tours by the mode of the trip into their primary destination: the share of their other
   * trips (the one back and those through stops) by mode, and how many tours (the statistic
   * nhts-tripmode.json gives, by the same rule)
   */
  tripMix: Record<string, Record<Mode, number>>;
  tripMixTours: Record<string, number>;
  /** residents' tours by their own mode: the share of their other trips (the trip back and those through stops) by mode, and how many tours */
  tripMixTour: Record<string, Record<Mode, number>>;
  tripMixTourN: Record<string, number>;
  /** the legs through stops (and of work subtours), by the tour's mode then the trip's */
  stopLegModes: Record<string, Record<Mode, number>>;
  /** residents' tours by their own mode: the share of their trips back by mode (the NHTS's returnLeg) */
  tripMixBack: Record<string, Record<Mode, number>>;
  /** the same for their legs through stops (the NHTS's stopLegs) */
  tripMixStop: Record<string, Record<Mode, number>>;
}

/** what else a demand run returns */
/** demandPart's phases as fractions of its time (DemandOptions.progress) */
export const DEMAND_PHASE = { homeBased: 0.65, notHome: 0.85, stops: 0.9 };

export interface DemandOptions {
  /** vehicle trips by period between zones and outside zones ((NZ+NX)², origin row), for road assignment */
  autoOD?: boolean;
  /**
   * how far this part has got, for a page's progress bar: the fraction of the origins whose home-based
   * trips are chosen, scaled to [0, DEMAND_PHASE.homeBased], then DEMAND_PHASE.notHome and .stops
   */
  progress?: (f: number) => void;
}

/**
 * Residents' households by car segment (car0, car1, car2+) as this run's demand used them, and,
 * when car ownership was chosen again (DemandContext.carOwnership), the model's cars in the city at
 * this run's accessibility and at the base run's
 */
export interface CarOwnership {
  hhBySeg: number[];
  cars: number;
  carsBase: number;
}

/** columns of AbmTally.byPtype, per person type: persons; P(M), P(N), P(H) (weighted); work and school
 * tours; non-mandatory tours by ActivitySim purpose (6); persons working from home; P(M) of the rest;
 * persons who may have a mandatory day; non-mandatory tours on M days and on N days */
export const ABM_COLS = 17;
/** an origin's expected tours from the person-level choices, by cell: non-mandatory [car][income
 * class][adult, youth, senior][shop, other, social]; school [car][class][11+, 10 or under]; college
 * [car][class]; work [car][income band] */
const CELL = { nm: 0, school: 54, univ: 66, work: 72 };
const ABM_CELLS = 84;
/** residents' out-of-city non-work trips per tour in the city: the aggregate rates' ratio (NHTS trips
 * per person over twice the tours per person), so the person-level choices keep the same relation */
const OUT_TRIPS_PER_TOUR = (RATES.shop + RATES.other + RATES.social) / (2 * (TOUR_RATES.shop + TOUR_RATES.other + TOUR_RATES.social));

/** 1.5 times the straight-line miles between two city zones (see abmCommutes) */
export function workMiCapOf(zones: { x: number; y: number }[]) {
  return (o: number, d: number) => (1.5 * Math.hypot(zones[o].x - zones[d].x, zones[o].y - zones[d].y)) / 1609.344;
}

/** what the person-level choices did (summed over origins) */
export interface AbmTally {
  byPtype: Float64Array;
  /** residents' commute trips by workplace, and school and college trips by school (the shadow prices' fit) */
  workDest: Float64Array;
  schoolDest: Float64Array;
  univDest: Float64Array;
  /** commute trips within the city and their km */
  workKm: number[];
  /** commute trips by home zone and workplace group (Prep.workGroups), home-major */
  workByGroup: Float64Array;
  segments: number;
  households: number;
}

/** the share of the origins a demand part covers: those whose index is `index` mod `count` */
export interface DemandSplit {
  index: number;
  count: number;
}

/**
 * Demand from some of the origins, before the parts are merged (finishDemand). Every field is a
 * sum over the origins covered, so parts add up to the whole city; the transit matrices are kept
 * in double precision so the order they are added in doesn't show. What is normalised by the
 * city's totals (the stop legs' purposes, park visits, shares and means) is left to the merge.
 */
export interface DemandPart {
  transitOD: Record<TPeriod, Float64Array>;
  trips: Record<Mode, number>;
  residentTrips: Record<Mode, number>;
  byPurpose: Record<string, Record<Mode, number>>;
  workBySeg: Record<string, Record<Mode, number>>;
  nonworkBySeg: Record<string, Record<Mode, number>>;
  byIncome: Record<Mode, number>[];
  youthTrips: Record<Mode, number>;
  vkt: number;
  logsum: number;
  zoneTrips: Float64Array;
  zoneTransit: Float64Array;
  zoneLS: Float64Array;
  zoneLSw: Float64Array;
  zoneWork: Float64Array;
  zoneWorkTransit: Float64Array;
  zoneVisits: Float64Array;
  zoneVisitsLeisure: Float64Array;
  zoneArrivals: Float64Array;
  zoneParkVisits: Float64Array;
  trnMin: number;
  trnN: number;
  kmSum: Record<string, number>;
  kmN: Record<string, number>;
  /** trips on the legs through tours' stops by the tour's mode and the trip's (6 × 6), and the tours
   * that stop, by purpose and mode */
  stopLegs: Float64Array;
  stopByPurpose: Record<string, number[]>;
  studentTrips: Record<Mode, number>;
  /** school and college trips arriving at each zone, by the size term they were chosen on ('school0'-'school2', 'univR') */
  attract: Record<string, Float64Array>;
  /** school trips by level: [6 modes, straight-line under 1 mile, 1-2, over 2, all] */
  schoolStats: Float64Array;
  /** school trips by level and direction: [to school by mode (6), home by mode (6), car-passenger tours' legs home, of them by transit] */
  schoolDir: Float64Array;
  /** one venue's attendees' transit trips by period, when EVENT_OD.venue is set */
  eventTransitOD?: Record<TPeriod, Float32Array | Float64Array>;
  /** non-residents' transit trips by period, when NONRES_OD.on */
  nonResTransitOD?: Record<TPeriod, Float32Array | Float64Array>;
  /** college trips arriving at each zone by mode (zone × 6) */
  collegeModes: Float64Array;
  shuttleTrips: number;
  shuttleBySeg: Record<string, number>;
  workIn: Record<string, Record<Mode, number>>;
  workOut: Record<string, Record<Mode, number>>;
  workInZone: Float64Array;
  shuttleOut: Record<string, number>;
  nhbPool: Record<Mode, number>;
  /** cars across the city line by market (resident purposes prefixed 'res '), by counted crossing (LINE_X; 0: uncounted) */
  lineVeh: Record<string, Float64Array>;
  /** person trips across the city line by market, by mode and outside zone (6 × NX) */
  lineTrips: Record<string, Float64Array>;
  /** special-event trips (to the venue and back) by venue and mode */
  eventModes: Record<string, Record<Mode, number>>;
  carOwn: CarOwnership;
  abm?: AbmTally;
  /** see DemandResult.lengthBands */
  lengthBands: Record<string, Float64Array>;
  /** trips by purpose and road distance band, the trips within one zone last (DemandResult.kmBands) */
  kmBands: Record<string, Float64Array>;
  /** vehicle trips by period (DemandOptions.autoOD): drivers alone, carpools (riders ÷ occupancy), ride-hail with a passenger */
  autoOD?: Record<TPeriod, Float64Array>;
  /** ride-hail trips by period: pick-ups by origin and drop-offs by destination (for deadheading) */
  tncEnds?: Record<TPeriod, Float64Array>;
  /** car trips (driving alone or carpooling, direct legs): commute minutes, commute trips, all minutes, all trips */
  driveMin: number[];
  micro?: MicroResult;
  /** residents' tours by their mode M and the mode of the leg back b, latX[M·6+b], and their stop legs per tour, latS[M] */
  latX: Float64Array;
  latS: Float64Array;
  /** with TRIP_MIX.on: residents' tours by the mode of the leg out (a) and back (b), mixX[a·6+b], and their stop legs by tour mode, mixY[a·6+M] */
  mixX: Float64Array;
  mixY: Float64Array;
}

/**
 * Distance bands (road miles) for the tallies of trips by mode and distance (lengthBands, kmBands):
 * up to ½, 1, 1½, 2, 3, 5, and 8 miles, and beyond.
 */
export const LENGTH_BANDS_MI = [0.5, 1, 1.5, 2, 3, 5, 8, Infinity];
export const lengthBand = (mi: number) => {
  let k = 0;
  while (mi > LENGTH_BANDS_MI[k]) k++;
  return k;
};

const byModes = () => new Float64Array(MODES.length);
const modeRecord = (a: Float64Array) =>
  Object.fromEntries(MODES.map((m, i) => [m, a[i]])) as Record<Mode, number>;
const modeRecords = (r: Record<string, Float64Array>) =>
  Object.fromEntries(Object.entries(r).map(([k, a]) => [k, modeRecord(a)]));

/** each park's pull: weight × acres here × (its total acres)^(β−1), times its own factor where
 * visits are counted (a special generator) */
const parkPullOf = (calib: Calibration) => {
  const pb = calib.parkExponent ?? 1,
    pf = calib.parkFactor ?? {};
  return (name: string, here: number, total: number) =>
    here * Math.pow(Math.max(total, 0.1), pb - 1) * (pf[name] ?? 1);
};

/** whether demand also reads residents' tours by the mode of their leg out, as NHTS's tours are read
 * (DemandResult.tripMix; for calibration and diagnostics, not needed by the app) */
export const TRIP_MIX = { on: false };
/**
 * When `venue` is set, demand also returns the transit trips of that venue's attendees by period
 * (DemandResult.eventTransitOD), for fitting their Caltrain riders (calibrate.ts).
 */
export const EVENT_OD: { venue: string | null } = { venue: null };
/**
 * When `on`, demand also returns non-residents' transit trips by period (DemandResult.nonResTransitOD:
 * in-commuters, visitors, students and attendees from outside, their trips not from home), for fitting
 * their level on Muni apart from residents' (calibrate.ts).
 */
export const NONRES_OD = { on: false };

/**
 * Cars across the city line, by market: with `paths` (gateway-paths.ts: the counted crossing each car
 * trip between a zone and an outside zone takes, by period, numbered from 1), each booking's cars are
 * tallied by the crossing they use (DemandResult.lineVeh; index 0, an uncounted road); person trips by
 * mode and outside zone are tallied always (lineTrips).
 */
export const LINE_X: { paths: Uint8Array[] | null; n: number } = { paths: null, n: 0 };
const NORTH_COUNTIES = new Set(["Marin", "Sonoma", "Napa", "Lake", "Mendocino"]);
const SOUTH_COUNTIES = new Set(["San Mateo", "Santa Clara", "Santa Cruz", "Monterey", "San Benito"]);
/** the corridor by which an outside zone reaches the city: the Golden Gate, the Bay Bridge, or the county line */
export function corridorOf(x: { id: string; county: string }): Corridor {
  const c = x.county.replace(/ County$/, "");
  return x.id === "SFO" || SOUTH_COUNTIES.has(c) ? "south" : NORTH_COUNTIES.has(c) ? "north" : "east";
}
const SW_FROM = Int8Array.from(TRIP_SWITCH, ([a]) => MODES.indexOf(a));
const SW_TO = Int8Array.from(TRIP_SWITCH, ([, b]) => MODES.indexOf(b));
/**
 * One leg's trips given the tour's mode (trip mode choice conditional on tour mode, params
 * TRIP_SWITCH). For each tour mode M: the logsum of the leg's trip choice, θ · ln Σ_m exp(v_m/θ + K_Mm)
 * over the modes M allows (its own with K = 0), less v_M, is added to G[M] (zero when M allows no other
 * mode, or none is available); sw[k] gets the share of the leg by trip mode TRIP_SWITCH[k][1] on a
 * tour by TRIP_SWITCH[k][0] (the tour's own mode has the rest). v: the leg's utilities in the tour
 * model's units, money included (−Infinity where unavailable); K: the trip constants by switch. As
 * another trip's mode, transit carries the share of the leg's travelers for whom it runs (av, an
 * availability share, as on the tour); a transit tour's own requires it at the tour level.
 */
export function tripSwitch(v: ArrayLike<number>, theta: number, K: ArrayLike<number>, av: number, G: Float64Array, sw: Float64Array, sum = new Float64Array(6), off = 0) {
  sum.fill(0);
  const lav = av > 0 ? Math.log(av) : -Infinity;
  for (let k = 0; k < SW_FROM.length; k++) {
    sw[off + k] = 0;
    const M = SW_FROM[k],
      m = SW_TO[k];
    if (v[M] === -Infinity || v[m] === -Infinity) continue;
    const x = (v[m] + (m === 3 ? lav : 0) - v[M]) / theta + K[k];
    if (!(x > -30)) continue;
    sw[off + k] = Math.exp(x);
    sum[M] += sw[off + k];
  }
  for (let M = 0; M < 6; M++) if (sum[M] > 0) G[M] += theta * Math.log1p(sum[M]);
  for (let k = 0; k < SW_FROM.length; k++) if (sw[off + k] > 0) sw[off + k] /= 1 + sum[SW_FROM[k]];
}

/**
 * Compute demand for a scenario given the transit skims (AM, MD, PM): every origin in one go.
 * The browser splits the same work by origin over its workers (demandPart) and merges the parts.
 */
export function computeDemand(
  b: Bundle,
  prep: Prep,
  sk: TrnSkims,
  calib: Calibration,
  day: DayType = "wkd",
  autoCostFactor = 1,
  /** diagnostics: when given, transit trips are also tallied by market (residents' tours, their
   * stops, in-commuters, visitors, ...) into these matrices, created on first use */
  markets?: Record<string, Record<TPeriod, Float32Array>>,
  context?: DemandContext,
  opts?: DemandOptions,
): DemandResult {
  const part = demandPart(b, prep, sk, calib, day, autoCostFactor, { index: 0, count: 1 }, markets, context, opts);
  return finishDemand(b, calib, [part]);
}

/** Demand from the origins in one part of a split (see DemandPart). */
export function demandPart(
  b: Bundle,
  prep: Prep,
  sk: TrnSkims,
  calib: Calibration,
  day: DayType,
  autoCostFactor: number,
  split: DemandSplit,
  markets?: Record<string, Record<TPeriod, Float32Array>>,
  context?: DemandContext,
  opts?: DemandOptions,
): DemandPart {
  const H = b.header,
    A = b.a;
  const mine = (i: number) => i % split.count === split.index;
  // long run: households choose again how many cars to own, at this scenario's accessibility
  // (autoown.ts); every part computes the same shares, so the split doesn't matter
  let carsModel = 0,
    carsModelBase = 0;
  if (context?.carOwnership) {
    const lr = longRunPrep(b, prep, sk, calib);
    if (lr) {
      // residents by segment follow their households' new car ownership: each segment and income
      // class's commuters and people of every kind scale as its households' share does
      const old = prep.segInc, nw = lr.prep.segInc;
      const scale = (t: Float32Array[][]) =>
        t.map((byC, s) => byC.map((a, c) => Float32Array.from(a, (v, z) => (old[s][c][z] > 1e-9 ? (v * nw[s][c][z]) / old[s][c][z] : v))));
      lr.prep.workShare = scale(prep.workShare);
      lr.prep.people = { pop: scale(prep.people.pop), youth: scale(prep.people.youth), senior: scale(prep.people.senior), college: scale(prep.people.college) };
      prep = lr.prep;
      carsModel = lr.cars / split.count;
      carsModelBase = lr.carsBase / split.count;
    }
  }
  const hhBySeg = [0, 0, 0];
  H.zones.forEach((z, i) => {
    if (mine(i)) for (let s = 0; s < 3; s++) hhBySeg[s] += z.hh * prep.seg[s][i];
  });
  const mkt = (k: string, tp: TPeriod) => {
    if (!markets) return null;
    const r = (markets[k] ??= {} as Record<TPeriod, Float32Array>);
    return (r[tp] ??= new Float32Array((H.zones.length + 2 * H.ext.length) ** 2));
  };
  const AUTO_OF = AUTO_OF_DAY[day];
  // the price of gasoline moves driving's running cost (conditions, context.ts)
  autoCostFactor *= autoCostOf(context);
  // weekend: trip rates relative to the weekday and their timing (NHTS 2017), and fitted adjustments
  const profile = day === "wkd" ? null : (H.dayTypes?.[day] ?? null);
  const rateOf = (p: Purpose) =>
    profile && NHTS_OF[p] ? (profile.rate[NHTS_OF[p]!] ?? 1) : 1;
  const TODd: typeof TOD = { ...TOD };
  if (profile)
    for (const p of PURPOSES)
      if (NHTS_OF[p] && profile.tod[NHTS_OF[p]!]) {
        const t = profile.tod[NHTS_OF[p]!] as (typeof TOD)[Purpose];
        TODd[p] = p === "nhb" ? t : balanced(t);
      }
  // the periods each leg travels in, from the day's time-of-day shares
  const LW = Object.fromEntries(PURPOSES.map((p) => [p, legWeights(TODd[p], p === "nhb")])) as Record<Purpose, LegWeights>;
  const skq = TPERIODS.map((p) => sk[p]);
  const dayAdj = day === "wkd" ? null : (calib.days?.[day] ?? null);
  const transitShift = dayAdj?.transitAsc ?? 0;
  const regionalRate = dayAdj?.regionalRate ?? calib.regionalRate;
  const { NZ, NX, Z, ZT } = prep;
  // transit uses the activity end of an outside zone when the trips being chosen have their outside
  // end at an activity there (residents' commutes and trips into the region, air travelers), and its
  // home end otherwise (in-commuters, regional visitors)
  let extActivity = false;
  // in-commuters from households without a car: no car to drive to work or to leave at a station
  let noCar = false;
  const tz = (z: number) => (z >= NZ && extActivity ? z + NX : z);
  const autoSec: Record<string, Uint16Array> = {},
    extIn: Record<string, Uint16Array> = {},
    extOut: Record<string, Uint16Array> = {};
  for (const p of ["AM", "MD", "PM", "EV"]) {
    autoSec[p] = A[`autoSec_${p}`] as Uint16Array;
    extIn[p] = A[`extAutoIn_${p}`] as Uint16Array;
    extOut[p] = A[`extAutoOut_${p}`] as Uint16Array;
  }
  const autoDm = A.autoDm as Uint16Array,
    extDmIn = A.extDmIn as Uint16Array,
    extDmOut = A.extDmOut as Uint16Array,
    extToll = A.extTollIn as Float32Array;
  const walkSec = A.walkSec as Uint16Array,
    walkM = A.walkM as Uint16Array,
    bikeSec = A.bikeSec as Uint16Array,
    bikeM = A.bikeM as Uint16Array;

  // ---- level of service between any two zones (internal or external) ----
  const autoMin = (o: number, d: number, p: TPeriod): number => {
    const ap = AUTO_OF[p];
    if (o < NZ && d < NZ) return autoSec[ap][o * NZ + d] / 60;
    if (o >= NZ && d < NZ) return extIn[ap][(o - NZ) * NZ + d] / 60;
    if (o < NZ && d >= NZ) return extOut[ap][(d - NZ) * NZ + o] / 60;
    return Infinity;
  };
  const autoMi = (o: number, d: number): number => {
    if (o < NZ && d < NZ) return autoDm[o * NZ + d] / 160.934;
    if (o >= NZ && d < NZ) return extDmIn[(o - NZ) * NZ + d] / 160.934;
    if (o < NZ && d >= NZ) return extDmOut[(d - NZ) * NZ + o] / 160.934;
    return Infinity;
  };
  const toll = (o: number, d: number) =>
    o >= NZ && d < NZ ? extToll[(o - NZ) * NZ + d] : 0;
  // today's driving times (traffic feedback keeps them as base_*): the scenario's change in a car
  // leg's cost by period moves the leg between periods, by an incremental logit with the scale of
  // mode choice (UK TAG unit M2.1 §4.8.6: for periods of about three hours, macro time-period choice
  // is about as sensitive as main mode choice)
  const baseSec: Record<string, Uint16Array | undefined> = {},
    baseIn: Record<string, Uint16Array | undefined> = {},
    baseOut: Record<string, Uint16Array | undefined> = {};
  for (const p of ["AM", "MD", "PM", "EV"]) {
    baseSec[p] = A[`base_autoSec_${p}`] as Uint16Array | undefined;
    baseIn[p] = A[`base_extAutoIn_${p}`] as Uint16Array | undefined;
    baseOut[p] = A[`base_extAutoOut_${p}`] as Uint16Array | undefined;
  }
  const baseMin = (o: number, d: number, p: TPeriod): number => {
    const ap = AUTO_OF[p];
    if (o < NZ && d < NZ) return (baseSec[ap] ?? autoSec[ap])[o * NZ + d] / 60;
    if (o >= NZ && d < NZ) return (baseIn[ap] ?? extIn[ap])[(o - NZ) * NZ + d] / 60;
    if (o < NZ && d >= NZ) return (baseOut[ap] ?? extOut[ap])[(d - NZ) * NZ + o] / 60;
    return Infinity;
  };
  // charges for driving added by a scenario (a cordon), $ by period between zones and outside zones
  // (the road assignment's toll skims, less today's)
  const roadToll = TPERIODS.map((tp) => A[`roadToll_${tp}`] as Float32Array | undefined);
  const anyRoadToll = roadToll.some(Boolean);
  // parking charges a scenario adds, $ an hour by zone
  const parkAdd = (A.parkAdd as Float32Array | undefined) ?? new Float32Array(NZ);
  const NA = NZ + NX;
  const todOn = day === "wkd" && (!!baseSec.AM || roadToll.some(Boolean) || !!A.parkAdd);
  const todOut = new Float64Array(TPERIODS.length),
    todBack = new Float64Array(TPERIODS.length);
  /** a car leg's period weights: the purpose's, reweighted by exp(ΔV) of each period's change in driving's utility */
  const todWeights = (o: number, d: number, purpose: Purpose, lw: LegWeights) => {
    todOut.set(lw.out);
    todBack.set(lw.back);
    if (!todOn) return;
    const C = coeffsOf(purpose);
    for (const [W, a, b] of [
      [todOut, o, d],
      [todBack, d, o],
    ] as [Float64Array, number, number][]) {
      let s = 0,
        s0 = 0;
      for (let q = 0; q < W.length; q++) {
        if (!(W[q] > 0)) continue;
        const tp = TPERIODS[q];
        const dt = autoMin(a, b, tp) - baseMin(a, b, tp);
        const rt = roadToll[q] ? roadToll[q]![a * NA + b] : 0;
        const dv = C.ivt * ((Number.isFinite(dt) ? dt : 0) + (rt * 60) / VOT_TYPICAL);
        s0 += W[q];
        W[q] *= Math.exp(Math.max(-20, dv));
        s += W[q];
      }
      if (s > 0) for (let q = 0; q < W.length; q++) W[q] *= s0 / s;
    }
  };

  // utilities of the six modes for one leg; writes into u[0..5] (−Infinity when unavailable), with
  // the money each costs ($, shared ride's already divided among its riders) apart in c[0..5], so
  // the cost coefficient of each income band is applied afterwards
  const u = new Float64Array(6),
    c1 = new Float64Array(6);
  const ascs = calib.asc;
  const xferFactor = calib.xferFactor ?? 1;
  // walking all the way: a factor on TM1's weights on its minutes (calibrated; see Calibration)
  const walkTimeFactor = calib.walkTimeFactor ?? 1;
  // demand conditions (context.ts): commuters at work relative to today, downtown and elsewhere;
  // commute days and working from home; employed residents, jobs, and population
  const attendCore = context?.attendanceCore ?? 1,
    attendOther = context?.attendanceOther ?? 1;
  const daysF = commuteDaysOf(context),
    wfhF = wfhOf(context),
    popF = context?.residents ?? 1;
  // residents at work on a weekday, per employed resident not working from home
  const resAttend =
    Math.min(1, COMMUTE_DAYS["San Francisco"] * daysF) * ABSENCE * (context?.employedResidents ?? 1);
  const attendAt = (d: number) =>
    d < NZ && H.zones[d].areaType === 0 ? attendCore : attendOther;
  // the diaries' day-level commuting instead of the stated frequency (calibration commuteBasis)
  const diary = (COMMUTE_BASIS.basis ?? calib.commuteBasis ?? "stated") === "diary";
  const commuteF = (county: string) => (diary ? (DIARY_COMMUTE_FACTOR[county] ?? DIARY_COMMUTE_FACTOR_OTHER) : 1);
  const residentF = commuteF("San Francisco");
  // in-commuters at work on a weekday, by home county (BATS commute frequency, less absence), and
  // jobs in the city relative to today
  const inAttend = Float32Array.from(
    H.ext,
    (x) =>
      Math.min(1, (COMMUTE_DAYS[x.county.replace(/ County$/, "")] ?? COMMUTE_DAYS_OTHER) * daysF) *
      ABSENCE *
      (context?.jobs ?? 1) *
      commuteF(x.county.replace(/ County$/, "")),
  );
  // commuters' transit constants by county (into the city by home county, out of it by work county)
  const countyName = H.ext.map((x) => x.county.replace(/ County$/, ""));
  const countyIn = Float32Array.from(
    H.ext,
    (x, e) => (calib.countyTransit?.in?.[countyName[e]] ?? 0) + (calib.extTransit?.[x.id] ?? 0),
  );
  const countyOut = Float32Array.from(
    countyName,
    (c) => calib.countyTransit?.out?.[c] ?? 0,
  );
  const workIn: Record<string, Float64Array> = {},
    workOut: Record<string, Float64Array> = {};
  const workInZone = new Float64Array(2 * NX);
  const shuttleOut: Record<string, number> = {};
  // residents' transit constant by home neighbourhood
  const homeTransit = new Float32Array(NZ);
  if (calib.nhoodTransit)
    H.zones.forEach(
      (z, i) => (homeTransit[i] = calib.nhoodTransit![z.nhood] ?? 0),
    );
  const HOME_BASED = new Set<Purpose>([
    "work",
    "school",
    "univ",
    "shop",
    "other",
    "social",
    "event",
  ]);
  // the venue whose attendees are being chosen and its transit constant; and whether they are making
  // one-way trips (straight from work, and home afterwards), parking at the venue or not
  let eventAsc = 0,
    eventVenue = "",
    eventOneWay = false,
    eventPark = true,
    // attendees from (or going home to) San Mateo and Santa Clara counties: their own transit constant
    // (calib.eventSouthTransit), fitted to Caltrain's riders on Giants home weekdays
    eventSouth = false;
  const eventSouthAsc = calib.eventSouthTransit ?? 0;
  /** trips made one way, o to d: those not from home, and event attendees' from work and home after */
  const oneWayOf = (p: Purpose) => p === "nhb" || (p === "event" && eventOneWay);
  // residents' non-work tour rates, scaled to BATS 2023's total (calibrated)
  const tourFactor = calib.tourRateFactor ?? 1;
  // the person type of the trips being chosen (set around each call; school trips are youth trips)
  let person: PersonType = "adult";
  // the income band of the residents' tours being chosen (−1: not a resident household)
  let incBand = -1;
  const incomeTransit = calib.incomeTransit ?? INCOME_CLASSES.map(() => 0);
  // seniors not enrolled in Free Muni for Seniors pay the senior fare
  const seniorsPaying = Math.max(
    0,
    1 -
      FREE_MUNI_SENIORS /
        Math.max(
          1,
          H.zones.reduce((a, z) => a + z.age65plus, 0),
        ),
  );
  // the share of a leg's travelers for whom transit runs at their time of day (set by `leg`)
  let legAvail = 1;
  // a transit leg's money that is not a fare (set by `leg`), and a choice's (set by `choose`): the
  // person types' fare multiples do not apply to it
  let legOther = 0,
    choiceOther = 0;
  // shared bikes and scooters, inside the bike alternative (micromobility.ts; null without its data)
  const micro = microDemand(b, calib, prep.vot, context?.micromobility);
  /**
   * One leg's utilities, its level of service the mix of the periods it travels in (W, by
   * TPERIODS): driving times, ride-hail fares, and transit's perceived time, transfers, and fare
   * are each weighted by the leg's share in each period. Transit is weighed over the periods it runs
   * in, and `legAvail` is the share of the leg's travelers who travel then; the caller adds its log
   * to transit's utility (a market segment without the alternative, as an availability share).
   * Weighting the level of service rather than choosing period by period keeps one choice per leg;
   * utilities are linear in it, so this equals averaging the periods' utilities.
   */
  /**
   * TM1's density terms on walk, bike, and transit. A tour (legs summed) counts its destination's
   * density index once, half on each leg, and has no origin term (ModeChoice.xls); a trip counts its
   * destination's and, capped, its origin's (TripModeChoice.xls, which applies the origin term to the
   * non-mandatory purposes only, as here: the trip-level choices are trips not from home and visitors).
   */
  const densTerm = (C: ReturnType<typeof coeffsOf>, tour: boolean, o: number, d: number, pz: number) => {
    if (tour) return pz < NZ ? 0.5 * C.density * Math.min(prep.densIdx[pz], 100) : 0;
    let v = 0;
    if (d < NZ) v += C.density * Math.min(prep.densIdx[d], 100);
    if (o < NZ) v += Math.min(C.originDensity * prep.densIdx[o], -C.ivt * ORIGIN_DENSITY_CAP);
    return v;
  };
  const leg = (
    out: Float64Array,
    oc: Float64Array,
    o: number,
    d: number,
    W: Float64Array,
    purpose: Purpose,
    half: boolean,
    // where the car is parked: the tour's destination, on the way there and back
    pz: number = d,
  ) => {
    // home-based tours use TM1's tour coefficients on each leg (summed in choose); other choices
    // use its trip coefficients
    const C = coeffsOf(purpose);
    const tour = TOUR_COEFFS[purpose] !== undefined;
    oc.fill(0);
    // a tour's constants count once: half on each of its two legs (the segment's mode constants
    // are added to the whole tour or trip in choose)
    const af = tour ? 0.5 : 1;
    // auto: the periods' mix of driving times and ride-hail fares
    const mi = autoMi(o, d);
    let at = 0,
      tncFare = 0,
      rt = 0;
    for (let q = 0; q < W.length; q++)
      if (W[q] > 0) {
        const t = autoMin(o, d, TPERIODS[q]);
        at += W[q] * t;
        tncFare += W[q] * Math.max(TNC.min, TNC.base + TNC.perMile * mi + TNC.perMin * t);
        if (anyRoadToll && roadToll[q]) rt += W[q] * roadToll[q]![o * NA + d];
      }
    if (at < Infinity && mi < Infinity) {
      // terminal time: TM1 counts none at home, so each leg of a tour counts the destination's
      // (where the car is parked); other trips count both ends
      const term = tour
        ? pz < NZ
          ? prep.terminal[pz]
          : 3
        : (o < NZ ? prep.terminal[o] : 3) + (d < NZ ? prep.terminal[d] : 3);
      let park = 0;
      if (pz < NZ)
        park =
          purpose === "work"
            ? (prep.parkLong[pz] + parkAdd[pz]) * 8
            : purpose === "event"
              ? EVENT_PARKING
              : (prep.parkShort[pz] + parkAdd[pz]) * STAY_HOURS[purpose];
      // one parking charge per round trip: half on each leg
      if (half) park *= 0.5;
      const run = AUTO_COST_PER_MILE * autoCostFactor * mi,
        shared = park + toll(o, d) + rt;
      const v = C.ivt * at + C.terminal * term;
      out[0] = v;
      oc[0] = run + shared;
      // TM1: carpoolers split parking and tolls, not the running cost
      out[1] = v;
      oc[1] = run + shared / SR_COST_SHARE;
      const wait = o < NZ ? prep.tncWait[o] : 8;
      const fare = tncFare + toll(o, d) + rt;
      out[2] = C.ivt * (at + 1.5 * wait);
      oc[2] = fare;
      // children ride as passengers
      if (person === "youth") out[0] = out[2] = -Infinity;
      // in-commuters from households without a car ride with someone if they go by car
      if (noCar) out[0] = -Infinity;
    } else out[0] = out[1] = out[2] = -Infinity;
    // transit: the mix of the periods in which it runs
    const k = tz(o) * ZT + tz(d);
    let wT = 0,
      gT = 0,
      xT = 0,
      fT = 0,
      oT = 0;
    for (let q = 0; q < W.length; q++) {
      const w = W[q];
      if (w <= 0) continue;
      const s = skq[q];
      if (!(s.g[k] < Infinity)) continue;
      wT += w;
      gT += w * s.g[k];
      xT += w * Math.max(0, s.boards[k] - 1);
      fT += w * s.fare[k];
      if (s.cost) oT += w * s.cost[k];
    }
    legAvail = wT;
    legOther = wT > 1e-6 ? oT / wT : 0;
    if (wT > 1e-6) {
      const g = gT / wT;
      const xf = xT / wT;
      const pf = PERSON_FARE[person];
      const fare =
        (fT / wT) *
        (o < NZ && d < NZ
          ? person === "senior"
            ? pf.inCity * seniorsPaying
            : pf.inCity
          : pf.outside);
      out[3] =
        af * transitShift +
        C.ivt * g +
        C.xfer * xferFactor * xf +
        densTerm(C, tour, o, d, pz);
      oc[3] = fare + legOther;
    } else ((out[3] = -Infinity), (legAvail = 0));
    // walk and bike (inside the city)
    if (o < NZ && d < NZ) {
      const q = o * NZ + d;
      const dens = densTerm(C, tour, o, d, pz);
      if (walkM[q] <= 6000) {
        const t = walkSec[q] / 60;
        out[4] =
          walkTimeFactor * (C.walkShort * Math.min(t, C.walkThresh) + C.walkLong * Math.max(0, t - C.walkThresh)) +
          dens;
      } else out[4] = -Infinity;
      if (bikeM[q] <= 20000 && bikeSec[q] < 65535) {
        const t = bikeSec[q] / 60;
        out[5] =
          C.bikeShort * Math.min(t, 30) +
          C.bikeLong * Math.max(0, t - 30) +
          dens +
          // the effort of climbing beyond its time (micromobility.ts)
          (micro ? micro.ownClimb(q) : 0);
      } else out[5] = -Infinity;
    } else out[4] = out[5] = -Infinity;
  };

  // nested logit: nests {da, sr}, {walk, bike}, transit, tnc under a root with scale NEST
  // (the non-motorised nest, which costs no money, is worked out apart so a mixture over values of
  // time reuses it)
  const prob = new Float64Array(6);
  const im = 1 / NEST;
  /** the non-motorised nest: its alternatives' exponentials, their sum, and its exp(inclusive value) */
  const walkNest = new Float64Array(4);
  const setWalkNest = (v: Float64Array) => {
    const w0 = v[4] === -Infinity ? 0 : Math.exp(v[4] * im),
      w1 = v[5] === -Infinity ? 0 : Math.exp(v[5] * im);
    const sw = w0 + w1;
    walkNest[0] = w0;
    walkNest[1] = w1;
    walkNest[2] = sw;
    walkNest[3] = sw > 0 ? Math.pow(sw, NEST) : 0;
  };
  /** the non-motorised nest with a new bike utility, walking's kept */
  const setBikeNest = (vb: number) => {
    const w1 = vb === -Infinity ? 0 : Math.exp(vb * im);
    const sw = walkNest[0] + w1;
    walkNest[1] = w1;
    walkNest[2] = sw;
    walkNest[3] = sw > 0 ? Math.pow(sw, NEST) : 0;
  };
  const nlogit = (v: Float64Array): number => {
    setWalkNest(v);
    return nlogitW(v);
  };
  /** nlogit with the non-motorised nest already in walkNest */
  const nlogitW = (v: Float64Array): number => {
    const m = NEST;
    const a0 = v[0] === -Infinity ? 0 : Math.exp(v[0] * im),
      a1 = v[1] === -Infinity ? 0 : Math.exp(v[1] * im),
      w0 = walkNest[0],
      w1 = walkNest[1];
    const sa = a0 + a1,
      sw = walkNest[2];
    // exp(m · ln s) = s^m
    const eA = sa > 0 ? Math.pow(sa, m) : 0,
      eW = walkNest[3];
    const eT = v[3] === -Infinity ? 0 : Math.exp(v[3]),
      eR = v[2] === -Infinity ? 0 : Math.exp(v[2]);
    const tot = eA + eW + eT + eR;
    if (tot <= 0) {
      prob.fill(0);
      return -Infinity;
    }
    prob[0] = (eA / tot) * (sa > 0 ? a0 / sa : 0);
    prob[1] = (eA / tot) * (sa > 0 ? a1 / sa : 0);
    prob[4] = (eW / tot) * (sw > 0 ? w0 / sw : 0);
    prob[5] = (eW / tot) * (sw > 0 ? w1 / sw : 0);
    prob[3] = eT / tot;
    prob[2] = eR / tot;
    return Math.log(tot);
  };
  // a round trip's legs' utilities without money or mode constants, their money (and the part of it
  // that is not a fare), kept while one origin's households are chosen for each car segment and
  // income band in turn (cacheGen marks the entries of this round), and for residents' tours the
  // trips' gains and shares (cacheTG)
  const PIDX = Object.fromEntries(PURPOSES.map((p, k) => [p, k])) as Record<Purpose, number>;
  const PTIDX: Record<PersonType, number> = { adult: 0, youth: 1, senior: 2 };
  const NS = TRIP_SWITCH.length;
  const NCK = PURPOSES.length * 3 * Z;
  const cacheU = new Float64Array(NCK * 12),
    cacheC = new Float64Array(NCK * 12),
    cacheAv = new Float64Array(NCK * 2),
    cacheOth = new Float64Array(NCK * 2),
    cacheGen = new Int32Array(NCK),
    cacheG = new Float64Array(NCK * 12),
    // (one more record at the end for a choice that is not cached)
    cacheSw = new Float64Array((NCK + 1) * 2 * NS),
    cacheTG = new Int32Array(NCK);
  let gen = 0,
    cacheOn = false;
  /**
   * The choice of a class of travelers whose values of time spread around `vot` (its mean): the
   * mixture of the nested logits at three values of time (VOT_MIX_Z, the Gauss–Hermite points of TM1's
   * lognormal), so `prob` holds the class's shares; returns the weighted mean of the logsums. `v` is
   * the utility without money, `c` the money ($) by mode.
   */
  const VOT_MULT = VOT_MIX_Z.map((z) => VOT_MEDIAN_OF_MEAN * Math.exp(VOT_SIGMA * z));
  const mixU = new Float64Array(6),
    mixP = new Float64Array(6);
  const mixLogit = (v: Float64Array, c: Float64Array, vot: number, ivt: number): number => {
    mixP.fill(0);
    let ls = 0;
    // walking and cycling cost nothing, so their nest is the same at every value of time (unless a
    // shared bike or scooter, which costs money, is in the bike nest)
    const shared = micro !== null && micro.active && c[4] === 0 && c[5] === 0;
    const free = c[4] === 0 && c[5] === 0 && !shared;
    if (free || shared) setWalkNest(v);
    for (let k = 0; k < VOT_MULT.length; k++) {
      const cc = costCoef(ivt, Math.min(VOT_MAX, Math.max(VOT_MIN, vot * VOT_MULT[k])));
      for (let m = 0; m < 6; m++) mixU[m] = v[m] === -Infinity ? -Infinity : v[m] + cc * c[m];
      // the bike nest with the shared vehicles at this value of time (walking's part is unchanged)
      if (shared) setBikeNest((mixU[5] = micro.bikeUtility(mixU[5], cc)));
      const l = free || shared ? nlogitW(mixU) : nlogit(mixU);
      if (l === -Infinity) return -Infinity;
      ls += VOT_MIX_W[k] * l;
      for (let m = 0; m < 6; m++) mixP[m] += VOT_MIX_W[k] * prob[m];
    }
    prob.set(mixP);
    return ls;
  };
  // the mode constants of a purpose and car segment, by mode
  const ascTab: Record<string, Record<string, Float64Array>> = {};
  const ascOf = (purpose: Purpose, segKey: string) => {
    const t = (ascTab[purpose] ??= {});
    let a = t[segKey];
    if (!a) {
      // event trips take the constants of the travelers' own kind: residents' non-work tours, regional
      // visitors, hotel visitors
      // college tours take commuters' constants (TM1 groups them with work as mandatory tours)
      const asc =
        ascs[purpose === "univ" ? "work" : purpose]?.[segKey] ??
        (purpose === "event" ? (ascs.regional?.[segKey] ?? ascs.visitor?.[segKey]) : undefined) ??
        ascs.nonwork?.[segKey] ??
        {};
      a = t[segKey] = Float64Array.from(MODES, (m) => asc[m] ?? 0);
    }
    return a;
  };
  // residents' trips by persons under 18: constants fitted to BATS 2023 (on top of the segment's), and
  // whether the school tours being chosen are of children 10 or under (TM1's age term)
  const youthAsc = calib.youthAsc ?? {},
    schoolAsc = calib.schoolAsc ?? {},
    schoolLevelTransit = calib.schoolLevelTransit ?? [],
    collegeDa = calib.collegeDa ?? 0;
  let young = false;
  // the school level whose tours are being chosen (SCHOOL_LEVELS; −1 for other purposes), and whether
  // college tours are of students living outside the city
  let schoolLevel = -1,
    univOutside = false;
  // ---- trip mode choice conditional on tour mode (params TRIP_SWITCH) ----
  // the switches [tour mode → trip mode] as indices, their constants, and each purpose's scale θ
  const swFrom = SW_FROM,
    swTo = SW_TO;
  const swK = Float64Array.from(TRIP_SWITCH, ([a, b]) => calib.tripSwitch?.[`${a}>${b}`] ?? TRIP_SWITCH_ASC[`${a}>${b}`]);
  // the legs through stops and of work subtours: their own constants for the tour modes that have
  // them (TRIP_SWITCH_STOP), else the trip back's
  const swKStop = Float64Array.from(TRIP_SWITCH, ([a, b], k) => (TRIP_SWITCH_STOP.includes(a) ? (calib.tripSwitchStop?.[`${a}>${b}`] ?? swK[k]) : swK[k]));
  // school tours' trips home: their own offsets on the switches (params SCHOOL_RETURN)
  const swKSchool = Float64Array.from(TRIP_SWITCH, ([a, b], k) => swK[k] + (calib.schoolSwitch?.[`${a}>${b}`] ?? 0));
  const THETA = Object.fromEntries(
    PURPOSES.map((p) => [p, TOUR_COEFFS[p] ? tripScale(TOUR_COEFFS[p]!.ivt, COEFFS[p].ivt) : 1]),
  ) as Record<Purpose, number>;
  /** the cost coefficient averaged over a class's values of time (money enters utility linearly) */
  const ccMean = (ivt: number, vot: number) => {
    let s = 0;
    for (let k = 0; k < VOT_MULT.length; k++) s += VOT_MIX_W[k] * costCoef(ivt, Math.min(VOT_MAX, Math.max(VOT_MIN, vot * VOT_MULT[k])));
    return s;
  };
  // the legs of the round trip being chosen (out, back): utilities without money, money, the share
  // of each leg's travelers for whom transit runs, and the money that is not a fare
  const lu0 = new Float64Array(6),
    lu1 = new Float64Array(6),
    lc0 = new Float64Array(6),
    lc1 = new Float64Array(6),
    lcP = new Float64Array(6);
  let lav0 = 1,
    lav1 = 1,
    lo0 = 0,
    lo1 = 0;
  // the trips' gain on each tour mode's utility without money (gain) and on its money (gainC), and
  // where their switch shares are kept (cacheSw at swAt: the share of the leg out by trip mode
  // swTo[k] on a tour by mode swFrom[k] at swAt + k, the leg back's at swAt + NS + k)
  const gain = new Float64Array(6),
    gainC = new Float64Array(6);
  let swAt = 0;
  /** where the last choice's switch shares are (−1: not a resident's tour, so its trips keep its mode) */
  let tcAt = -1;
  const lv = new Float64Array(6),
    lsum = new Float64Array(6);
  /** one leg's trips given the tour's mode (tripSwitch), from its utilities without money (uu), money (cu), and the cost coefficient */
  const legSwitch = (uu: Float64Array, cu: Float64Array, cc: number, theta: number, av: number, G: Float64Array, off: number, K: Float64Array = swK) => {
    for (let m = 0; m < 6; m++) lv[m] = uu[m] === -Infinity ? -Infinity : uu[m] + cc * cu[m];
    tripSwitch(lv, theta, K, av, G, cacheSw, lsum, off);
  };
  /**
   * A resident tour's trips: the gains on each tour mode and the switch shares, at the cost
   * coefficient of the home zone's mix of incomes (a person under 18 at two-thirds of its value of
   * time), so they are the same for every car segment and income band of the zone and are worked out
   * once per destination (cached under `key`). The tour's own choice weighs money at each of its
   * class's values of time, so the gain is split: the leg back's money at the trips' expected cost
   * (gainC: what it adds to the tour mode's own), and the rest of the logsum (gain, its utility at the
   * reference cost coefficient less the expected cost at it). At the reference value of time the two
   * add up to the logsum; at others the leg back costs what its trips are expected to cost, so a
   * tour by an expensive mode that comes home another way does not save the fare it does not pay.
   * The trip into the primary destination is by the tour's mode, which is what makes it the tour's
   * mode (as NHTS tours are read; nhts_tours.py): only the trip back home chooses (its switch shares
   * at swAt + NS; the leg out's, at swAt, stay zero).
   */
  const tripGains = (o: number, purpose: Purpose, key: number, pt: PersonType, ub = lu1, cb = lc1) => {
    swAt = (key >= 0 ? key : NCK) * 2 * NS;
    if (key >= 0 && cacheTG[key] === gen) {
      for (let m = 0; m < 6; m++) (gain[m] = cacheG[key * 12 + m]), (gainC[m] = cacheG[key * 12 + 6 + m]);
      return;
    }
    const vot = (o < NZ ? prep.vot[o] : VOT_TYPICAL) * (pt === "youth" ? YOUTH_VOT_FACTOR : 1);
    const cc = ccMean(coeffsOf(purpose).ivt, vot);
    gain.fill(0);
    gainC.fill(0);
    cacheSw.fill(0, swAt, swAt + NS);
    const bk = swAt + NS;
    legSwitch(ub, cb, cc, THETA[purpose], lav1, gain, bk, purpose === "school" ? swKSchool : swK);
    // the leg back's expected money less the tour mode's own, moved from the utility to the money
    for (let k = 0; k < NS; k++) {
      const x = cacheSw[bk + k];
      if (x > 0) gainC[swFrom[k]] += x * (cb[swTo[k]] - cb[swFrom[k]]);
    }
    for (let m = 0; m < 6; m++) gain[m] -= cc * gainC[m];
    if (key >= 0) {
      for (let m = 0; m < 6; m++) (cacheG[key * 12 + m] = gain[m]), (cacheG[key * 12 + 6 + m] = gainC[m]);
      cacheTG[key] = gen;
    }
  };
  /**
   * A tour's utilities (TM1's tour model: both legs summed) or a trip's (TM1's trip model: one leg, or
   * the mean of the two directions for visitors' and air travelers' round trips), without money, into
   * `u`, with the money in `c1`; then the class's shares into `prob`. Returns the logsum.
   */
  const choose = (
    o: number,
    d: number,
    purpose: Purpose,
    segKey: string,
    vot: number,
  ): number => {
    const lw = LW[purpose];
    const C = coeffsOf(purpose);
    const tour = TOUR_COEFFS[purpose] !== undefined;
    const asc = ascOf(purpose, segKey);
    micro?.at(o, d, purpose, oneWayOf(purpose) ? 1 : tour ? 2 : 3, person === "youth");
    tcAt = -1;
    if (oneWayOf(purpose)) {
      // (event attendees going home from the venue left no car there)
      leg(u, c1, o, d, lw.out, purpose, false, purpose === "event" && !eventPark ? Infinity : d);
      choiceOther = legOther;
      if (u[3] > -Infinity) u[3] += Math.log(legAvail);
      for (let m = 0; m < 6; m++) if (u[m] > -Infinity) u[m] += asc[m];
      if (purpose === "event" && u[3] > -Infinity) u[3] += eventAsc + (eventSouth ? eventSouthAsc : 0);
      return mixLogit(u, c1, vot, C.ivt);
    }
    const key = cacheOn ? (PIDX[purpose] * 3 + PTIDX[person]) * Z + d : -1;
    if (key >= 0 && cacheGen[key] === gen) {
      for (let m = 0; m < 6; m++) {
        (lu0[m] = cacheU[key * 12 + m]), (lu1[m] = cacheU[key * 12 + 6 + m]);
        (lc0[m] = cacheC[key * 12 + m]), (lc1[m] = cacheC[key * 12 + 6 + m]);
      }
      (lav0 = cacheAv[2 * key]), (lav1 = cacheAv[2 * key + 1]);
      (lo0 = cacheOth[2 * key]), (lo1 = cacheOth[2 * key + 1]);
    } else {
      leg(lu0, lc0, o, d, lw.out, purpose, true);
      (lav0 = legAvail), (lo0 = legOther);
      leg(lu1, lc1, d, o, lw.back, purpose, true, d);
      (lav1 = legAvail), (lo1 = legOther);
      if (key >= 0) {
        for (let m = 0; m < 6; m++) {
          (cacheU[key * 12 + m] = lu0[m]), (cacheU[key * 12 + 6 + m] = lu1[m]);
          (cacheC[key * 12 + m] = lc0[m]), (cacheC[key * 12 + 6 + m] = lc1[m]);
        }
        (cacheAv[2 * key] = lav0), (cacheAv[2 * key + 1] = lav1);
        (cacheOth[2 * key] = lo0), (cacheOth[2 * key + 1] = lo1);
        cacheGen[key] = gen;
      }
    }
    const f = tour ? 1 : 0.5;
    choiceOther = f * (lo0 + lo1);
    for (let m = 0; m < 6; m++) {
      u[m] = lu0[m] === -Infinity || lu1[m] === -Infinity ? -Infinity : f * (lu0[m] + lu1[m]);
      c1[m] = f * (lc0[m] + lc1[m]);
    }
    // a tour can go by transit only if it runs at the times of both legs
    if (u[3] > -Infinity) u[3] += Math.log(lav0 * lav1);
    // students at a campus with a transit pass (SF State's Gator Pass, a Clipper BayPass) pay no fares
    const pass = purpose === "univ" && d < NZ && !!prep.collegePass[d];
    // residents' tours: each tour mode at the logsum of its trips' choice on the leg back
    if (tour && segKey !== "ext" && segKey !== "visitor") {
      if (pass) (lcP.set(lc1), (lcP[3] = lo1));
      tripGains(o, purpose, key, person, lu1, pass ? lcP : lc1);
      for (let m = 0; m < 6; m++) if (u[m] > -Infinity) (u[m] += gain[m]), (c1[m] += gainC[m]);
      tcAt = swAt;
    }
    for (let m = 0; m < 6; m++) if (u[m] > -Infinity) u[m] += asc[m];
    // special events: the venue's transit constant (fit to its surveyed transit share)
    if (purpose === "event" && u[3] > -Infinity) u[3] += eventAsc + (eventSouth ? eventSouthAsc : 0);
    // residents' non-work tours: a transit constant by household income (BATS 2023)
    if (incBand >= 0 && purpose !== "work" && purpose !== "univ" && u[3] > -Infinity) u[3] += incomeTransit[incBand];
    // students at a campus with a transit pass (SF State's Gator Pass, a Clipper BayPass) pay no fares;
    // college tours' drive-alone constant (fit to SF State's students)
    if (purpose === "univ") {
      if (pass) c1[3] = choiceOther + (tcAt >= 0 ? gainC[3] : 0);
      if (u[0] > -Infinity) u[0] += collegeDa;
    }
    if (
      o < NZ &&
      segKey !== "ext" &&
      segKey !== "visitor" &&
      HOME_BASED.has(purpose) &&
      u[3] > -Infinity
    )
      u[3] += homeTransit[o];
    // commutes across the city line: a transit constant by the other end's county (ACS county-to-county)
    if (purpose === "work" && u[3] > -Infinity) {
      if (o >= NZ) u[3] += countyIn[o - NZ];
      else if (d >= NZ) u[3] += countyOut[d - NZ];
    }
    // school tours: their own constants (fit to SFUSD's elementary pupils) and TM1's transit term for
    // children 10 or under; other tours of persons under 18: constants fit to BATS
    if (purpose === "school") {
      for (let m = 0; m < 6; m++) if (u[m] > -Infinity) u[m] += schoolAsc[MODES[m]] ?? 0;
      if (young && u[3] > -Infinity) u[3] += AGE010_TRANSIT;
      // middle and high school: a transit constant of the level's own (SFMTA's Student Travel Tally)
      if (schoolLevel >= 0 && u[3] > -Infinity) u[3] += schoolLevelTransit[schoolLevel] ?? 0;
    } else if (person === "youth")
      for (let m = 0; m < 6; m++) if (u[m] > -Infinity) u[m] += youthAsc[MODES[m]] ?? 0;
    // TM1: persons under 18 have two-thirds of their household's value of time
    const v = person === "youth" ? vot * YOUTH_VOT_FACTOR : vot;
    // commutes into a zone that charges for parking: the few who park free (TM1's free parking
    // eligibility) are a class of their own
    const pk = purpose === "work" && d < NZ ? prep.parkLong[d] * 8 * (tour ? 1 : 0.5) : 0;
    if (pk <= 0 || FREE_PARKING_SF <= 0) return mixLogit(u, c1, v, C.ivt);
    const lsPay = mixLogit(u, c1, v, C.ivt);
    if (lsPay === -Infinity) return lsPay;
    for (let m = 0; m < 6; m++) (payP[m] = prob[m]), (freeC[m] = c1[m]);
    if (freeC[0] > -Infinity) freeC[0] -= pk;
    freeC[1] -= pk / SR_COST_SHARE;
    const lsFree = mixLogit(u, freeC, v, C.ivt);
    for (let m = 0; m < 6; m++) prob[m] = (1 - FREE_PARKING_SF) * payP[m] + FREE_PARKING_SF * prob[m];
    return (1 - FREE_PARKING_SF) * lsPay + FREE_PARKING_SF * lsFree;
  };
  const payP = new Float64Array(6),
    freeC = new Float64Array(6);
  /** logsum (utils) to minutes per trip: a tour's logsum covers its two trips */
  const lsMinutes = (p: Purpose) => 1 / (-coeffsOf(p).ivt * (TOUR_COEFFS[p] ? 2 : 1));

  // ---- parks: the destination pull of the parks in each zone ----
  const pw = calib.parkWeight ?? 1,
    parkPull = parkPullOf(calib);
  const parkSize = new Float64Array(NZ);
  H.zones.forEach((z, i) => {
    let s = 0;
    for (const [name, here, total] of z.parks ?? [])
      s += parkPull(name, here, total);
    parkSize[i] = pw * s;
  });
  // ---- outputs ----
  const transitOD = {
    AM: new Float64Array(ZT * ZT),
    MD: new Float64Array(ZT * ZT),
    PM: new Float64Array(ZT * ZT),
    NT: new Float64Array(ZT * ZT),
  } as Record<TPeriod, Float64Array>;
  // one venue's attendees' transit trips (EVENT_OD)
  const evOD = EVENT_OD.venue ? (Object.fromEntries(TPERIODS.map((p) => [p, new Float64Array(ZT * ZT)])) as Record<TPeriod, Float64Array>) : null;
  const nrOD = NONRES_OD.on ? (Object.fromEntries(TPERIODS.map((p) => [p, new Float64Array(ZT * ZT)])) as Record<TPeriod, Float64Array>) : null;
  // vehicle trips for road assignment, by period (zones and outside zones, origin row)
  const ZA = NZ + NX;
  const wantAuto = !!opts?.autoOD;
  const autoOD = wantAuto ? (Object.fromEntries(TPERIODS.map((tp) => [tp, new Float64Array(ZA * ZA)])) as Record<TPeriod, Float64Array>) : null;
  // ride-hail pick-ups by zone, drop-offs by zone, then passenger-km and trips
  const tncEnds = wantAuto ? (Object.fromEntries(TPERIODS.map((tp) => [tp, new Float64Array(2 * ZA + 2)])) as Record<TPeriod, Float64Array>) : null;
  // vehicles per person trip: a carpool carries SR_OCCUPANCY; a ride-hail car one party (its empty
  // driving is added in the assignment)
  const vehPer = [1, 1 / SR_OCCUPANCY, 1];
  // car tours' legs through a stop (driving alone, carpools), as vehicles of the tour's mode, by
  // period and direction: placed in the stop pass, where their trips' modes rescale them
  const stopAuto = wantAuto
    ? [0, 1].map(() => ({ out: Object.fromEntries(TPERIODS.map((tp) => [tp, new Float32Array(NZ * NZ)])) as Record<TPeriod, Float32Array>, in: Object.fromEntries(TPERIODS.map((tp) => [tp, new Float32Array(NZ * NZ)])) as Record<TPeriod, Float32Array> }))
    : null;
  const addAuto = (m: number, a: number, b: number, v: number, tp: TPeriod) => {
    autoOD![tp][a * ZA + b] += v * vehPer[m];
    if (m === 2) {
      const E = tncEnds![tp];
      E[a] += v;
      E[ZA + b] += v;
      const mi = autoMi(a, b);
      if (mi < Infinity) ((E[2 * ZA] += v * mi * 1.609), (E[2 * ZA + 1] += v));
    }
  };
  // trips by mode are tallied in arrays indexed as MODES (records of them are returned)
  const trips = byModes(),
    residentTrips = byModes();
  const byPurpose: Record<string, Float64Array> = {};
  for (const p of PURPOSES) byPurpose[p] = byModes();
  const workBySeg: Record<string, Float64Array> = {},
    nonworkBySeg: Record<string, Float64Array> = {};
  for (const s of SEGMENTS)
    ((workBySeg[s] = byModes()), (nonworkBySeg[s] = byModes()));
  workBySeg.ext = byModes();
  // residents' tour legs by household income band (adults and seniors, as BATS reports them)
  const byIncome = INCOME_CLASSES.map(() => byModes());
  // residents' tour legs by persons under 18 (school and non-work tours)
  const youthTrips = byModes();
  // residents' school and college trips
  const studentT = byModes();
  const zoneTrips = new Float64Array(NZ),
    zoneTransit = new Float64Array(NZ),
    zoneLS = new Float64Array(NZ),
    zoneLSw = new Float64Array(NZ);
  const zoneWork = new Float64Array(NZ),
    zoneWorkTransit = new Float64Array(NZ);
  // visits arriving at each zone (all modes), by purpose group: every trip to a destination, not the return home
  const zoneVisits = new Float64Array(NZ),
    zoneVisitsLeisure = new Float64Array(NZ),
    zoneArrivals = new Float64Array(2 * NZ);
  const zoneParkVisits = new Float64Array(NZ);
  const driveMin = [0, 0, 0, 0];
  let vkt = 0,
    logsum = 0,
    trnMin = 0,
    trnN = 0;
  const kmSum: Record<string, number> = {},
    kmN: Record<string, number> = {};
  const kmBands: Record<string, Float64Array> = {};
  const NB = LENGTH_BANDS_MI.length;
  // by band, and the mean of the trips of up to 5 miles ('<key><5mi' in kmSum, kmN)
  const kmBand = (key: string, a: number, b: number, n: number) => {
    const t = (kmBands[key] ??= new Float64Array(NB + 1));
    const dm = autoDm[a * NZ + b];
    t[lengthBand(dm / 160.934)] += n;
    if (a === b) t[NB] += n;
    if (dm <= 804.67) {
      const k5 = `${key}<5mi`;
      kmSum[k5] = (kmSum[k5] ?? 0) + (n * dm) / 100;
      kmN[k5] = (kmN[k5] ?? 0) + n;
    }
  };
  // trips by market, distance band, and mode (calibrate.ts fits walking's time weight to them); the
  // legs through stops of tours by car, on foot, by bike, or by ride-hail only when markets are tallied
  const lengthBands: Record<string, Float64Array> = {};
  const bandTally = (key: string, a: number, b: number, m: number, n: number) => {
    if (a >= NZ || b >= NZ || !(n > 0)) return;
    const t = (lengthBands[key] ??= new Float64Array(LENGTH_BANDS_MI.length * 6));
    t[lengthBand(autoDm[a * NZ + b] / 160.934) * 6 + m] += n;
  };

  // ---- tours: residents' home-based tours within the city make stops (see the stop pass below).
  // A stop splits a half-tour's leg home→primary into home→stop→primary, by the tour's mode. `book`
  // books the direct share of the legs and keeps the rest here, by mode (and, for transit, by period
  // and direction) for the stop pass; mode shares, visits, and distances stay per tour.
  const NZ2 = NZ * NZ;
  const stopRate = 1;
  const stopMass = MODES.map(() => new Float32Array(NZ2));
  const stopT: Record<"out" | "in", Record<TPeriod, Float32Array>> = {
    out: {
      AM: new Float32Array(NZ2),
      MD: new Float32Array(NZ2),
      PM: new Float32Array(NZ2),
      NT: new Float32Array(NZ2),
    },
    in: {
      AM: new Float32Array(NZ2),
      MD: new Float32Array(NZ2),
      PM: new Float32Array(NZ2),
      NT: new Float32Array(NZ2),
    },
  };
  const stopByPurpose: Record<string, number[]> = {};
  // the legs through stops by the tour's mode and the trip's (6 × 6)
  const stopLegs = new Float64Array(36);
  // trips not from home with their own mode choice (in-commuters', visitors')
  const nhbPool = byModes();
  const lineVeh: Record<string, Float64Array> = {},
    lineTrips: Record<string, Float64Array> = {};
  // special-event trips by venue and mode (both directions)
  const eventModes: Record<string, Float64Array> = {};
  // work-based subtours, by workplace and the work tour's mode
  const subMass = MODES.map(() => new Float64Array(NZ));
  const TOUR_PURPOSES = new Set<Purpose>([
    "work",
    "school",
    "univ",
    "shop",
    "other",
    "social",
  ]);
  const stopRateOf = Float64Array.from(MODES, (m) => STOP_RATE_BY_MODE[m]);
  const vehOf = [1, 1 / SR_OCCUPANCY, 1.4];
  // what booking needs of each purpose: the share of its tours' halves with a stop (its timing is LW's)
  const plans = {} as Record<Purpose, { stops: number }>;
  for (const p of Object.keys(TODd) as Purpose[])
    plans[p] = { stops: TOUR_PURPOSES.has(p) ? STOPS_PER_HALF[p as keyof typeof STOPS_PER_HALF] * stopRate : 0 };

  /**
   * How a pair's transit trips spread over the periods, for the leg out (o→d) and the leg back:
   * the leg's share in each period (LW) times transit's probability if the leg travels then.
   * Mode choice saw the periods' mix; here a leg in a period with slower, sparser, or no service
   * is less likely to be by transit than the mix, and one in a better-served period more. To first
   * order, a leg's period moves transit's utility by the difference between that period's utility
   * and the mix's (whole for a tour, whose legs are summed, and for a one-way trip; half for the
   * trip-level round trips, which average the two directions), against the same move in driving's
   * (weighted by driving's share of the other modes); transit's probability follows the logit
   * through `prob[3]`.
   * Fills splitOut and splitBack (each summing to 1) and the legs' door-to-door minutes.
   */
  const splitOut = new Float64Array(TPERIODS.length),
    splitBack = new Float64Array(TPERIODS.length),
    minOut = new Float64Array(TPERIODS.length),
    minBack = new Float64Array(TPERIODS.length),
    vt = new Float64Array(TPERIODS.length),
    va = new Float64Array(TPERIODS.length);
  const periodSplit = (o: number, d: number, purpose: Purpose) => {
    const C = coeffsOf(purpose),
      lw = LW[purpose];
    // a leg's weight in the choice's utility
    const legW = TOUR_COEFFS[purpose] !== undefined || oneWayOf(purpose) ? 1 : 0.5;
    const P = prob[3];
    const sa = (prob[0] + prob[1] + prob[2]) / Math.max(1e-9, 1 - P);
    // first each period's move in utility (NaN where the leg has no transit then), then the shares
    const avail = [0, 0];
    for (let dir = 0; dir < 2; dir++) {
      const W = dir === 0 ? lw.out : lw.back,
        a = dir === 0 ? o : d,
        b = dir === 0 ? d : o;
      const S = dir === 0 ? splitOut : splitBack,
        T = dir === 0 ? minOut : minBack;
      const k = tz(a) * ZT + tz(b);
      let f = 0,
        mt = 0,
        ma = 0;
      for (let q = 0; q < W.length; q++) {
        const s = skq[q];
        T[q] = s.time[k];
        S[q] = NaN;
        if (W[q] <= 0 || !(s.g[k] < Infinity)) continue;
        vt[q] = C.ivt * s.g[k] + C.xfer * xferFactor * Math.max(0, s.boards[k] - 1);
        const at = autoMin(a, b, TPERIODS[q]);
        va[q] = at < Infinity ? C.ivt * at : 0;
        f += W[q];
        mt += W[q] * vt[q];
        ma += W[q] * va[q];
      }
      avail[dir] = f;
      if (f <= 0) continue;
      ((mt /= f), (ma /= f));
      for (let q = 0; q < W.length; q++)
        if (W[q] > 0 && skq[q].g[k] < Infinity) S[q] = vt[q] - mt - sa * (va[q] - ma);
    }
    // transit's probability where both legs run (mode choice included the availability shares)
    const P0 = Math.min(0.999, P / Math.max(1e-9, avail[0] * (oneWayOf(purpose) ? 1 : avail[1])));
    // no transit tours (their trips by transit are other tours' legs): the legs' own timing
    if (!(P0 > 1e-9)) {
      (splitOut.set(lw.out), splitBack.set(lw.back));
      return;
    }
    const odds = 1 / P0 - 1;
    for (let dir = 0; dir < 2; dir++) {
      const W = dir === 0 ? lw.out : lw.back,
        S = dir === 0 ? splitOut : splitBack;
      let tot = 0;
      for (let q = 0; q < W.length; q++) {
        S[q] = Number.isNaN(S[q]) ? 0 : W[q] / (1 + odds * Math.exp(-legW * S[q]));
        tot += S[q];
      }
      if (tot > 0) for (let q = 0; q < W.length; q++) S[q] /= tot;
      else S.set(W);
    }
  };

  // What `book` books: the tour modes' shares in `prob` and, for residents' tours, their trips' joint
  // shares on each leg, jO[k] = prob[swFrom[k]] · (share of the leg out by mode swTo[k] on a tour by
  // mode swFrom[k]) and jB on the leg back (zero for the other choices, whose trips keep their mode).
  // Choices kept before they are booked keep both, JW wide (putJoint, getJoint): booking is linear in them.
  const JW = 6 + 2 * NS;
  const jO = new Float64Array(NS),
    jB = new Float64Array(NS);
  /** the joint shares from prob and the switch shares at `at` (cacheSw; none when at < 0) */
  const setJoint = (at = tcAt) => {
    if (at >= 0)
      for (let k = 0; k < NS; k++) {
        const p = prob[swFrom[k]];
        ((jO[k] = p * cacheSw[at + k]), (jB[k] = p * cacheSw[at + NS + k]));
      }
    else (jO.fill(0), jB.fill(0));
  };
  /** add n times prob and the joint shares into A at i (JW wide) */
  const putJoint = (A: Float64Array, i: number, n: number) => {
    for (let m = 0; m < 6; m++) A[i + m] += n * prob[m];
    for (let k = 0; k < NS; k++) ((A[i + 6 + k] += n * jO[k]), (A[i + 6 + NS + k] += n * jB[k]));
  };
  /** read prob and the joint shares back from A at i (as shares of the trips there, returned) */
  const getJoint = (A: Float64Array, i: number) => {
    let n = 0;
    for (let m = 0; m < 6; m++) n += A[i + m];
    if (!(n > 0)) return 0;
    for (let m = 0; m < 6; m++) prob[m] = A[i + m] / n;
    for (let k = 0; k < NS; k++) ((jO[k] = A[i + 6 + k] / n), (jB[k] = A[i + 6 + NS + k] / n));
    return n;
  };
  /** keep prob and the joint shares at P[i..i+JW) (a choice, before its trips are booked), and load them back */
  const storeP = (P: Float64Array, i: number) => {
    for (let m = 0; m < 6; m++) P[i + m] = prob[m];
    for (let k = 0; k < NS; k++) ((P[i + 6 + k] = jO[k]), (P[i + 6 + NS + k] = jB[k]));
  };
  const loadP = (P: Float64Array, i: number) => {
    for (let m = 0; m < 6; m++) prob[m] = P[i + m];
    for (let k = 0; k < NS; k++) ((jO[k] = P[i + 6 + k]), (jB[k] = P[i + 6 + NS + k]));
  };
  /** add n trips' primary legs, by the trips' modes, to an income or age tally T (from prob and the joint shares) */
  const tallyJoint = (n: number, purpose: Purpose, T: Float64Array) => {
    const lw = LW[purpose],
      oS = lw.outShare,
      bS = lw.backShare;
    for (let m = 0; m < 6; m++) T[m] += n * prob[m];
    for (let k = 0; k < NS; k++) {
      const x = n * (oS * jO[k] + bS * jB[k]);
      if (x > 0) ((T[swFrom[k]] -= x), (T[swTo[k]] += x));
    }
  };
  // the switches out of each tour mode
  const swOf = MODES.map((_, M) => TRIP_SWITCH.map((_, k) => k).filter((k) => swFrom[k] === M));
  const dO = new Float64Array(6),
    dB = new Float64Array(6),
    dOd = new Float64Array(6),
    dBd = new Float64Array(6),
    sigM = new Float64Array(6),
    cO = new Float64Array(6),
    cB = new Float64Array(6);
  // residents' tours by their mode M: the modes of their leg back (latX[M·6+b]) and their stop legs
  // per tour (latS[M], whose modes the stop pass gives), for calibration against NHTS 2017's tours by
  // the mode of their trip into the primary destination (nhts-tripmode.json). With TRIP_MIX.on, also
  // the tours by the mode of their leg out a (mixX[a·6+b] by the mode of the leg back, mixY[a·6+M]
  // their stop legs by tour mode): the survey's rule applied to the model, as a check
  const latX = new Float64Array(36),
    latS = new Float64Array(6),
    mixX = new Float64Array(36),
    mixY = new Float64Array(36);

  /** book `n` daily person trips between production zone o and attraction d with the tour modes' probabilities in `prob` and the trips' joint shares in jO, jB */
  const book = (
    o: number,
    d: number,
    n: number,
    purpose: Purpose,
    resident: boolean,
    segKey: string | null,
    homeZone: number,
  ) => {
    if (n <= 0) return;
    const T = plans[purpose];
    const lw = LW[purpose];
    const oS = lw.outShare,
      bS = lw.backShare;
    // the share of this tour's halves with a stop (each stop adds a leg), by the tour's mode
    const sig0 = resident && homeZone >= 0 && o < NZ && d < NZ ? T.stops : 0;
    // the trips on each leg by mode: all of them (dO, dB), and those of halves without a stop (dOd,
    // dBd), booked here; the stop pass books the others by the tour's mode
    for (let m = 0; m < 6; m++) {
      sigM[m] = Math.min(0.9, sig0 * stopRateOf[m]);
      dO[m] = dB[m] = prob[m];
      dOd[m] = dBd[m] = prob[m] * (1 - sigM[m]);
    }
    for (let k = 0; k < NS; k++) {
      const M = swFrom[k],
        m = swTo[k],
        dir = 1 - sigM[M];
      if (jO[k] > 0) ((dO[M] -= jO[k]), (dO[m] += jO[k]), (dOd[M] -= jO[k] * dir), (dOd[m] += jO[k] * dir));
      if (jB[k] > 0) ((dB[M] -= jB[k]), (dB[m] += jB[k]), (dBd[M] -= jB[k] * dir), (dBd[m] += jB[k] * dir));
    }
    // the tallies this booking adds to (by mode)
    const work = purpose === "work";
    const purposeT = byPurpose[purpose],
      incomeT = resident && incBand >= 0 ? (person !== "youth" ? byIncome[incBand] : youthTrips) : null,
      // (school and college tours have constants of their own, so they are kept apart from other tours)
      student = resident && (purpose === "school" || purpose === "univ"),
      segT =
        segKey && resident
          ? work
            ? workBySeg[segKey]
            : purpose !== "nhb" && !student
              ? nonworkBySeg[segKey]
              : null
          : work
            ? workBySeg.ext
            : null;
    // commutes across the city line, by the county at the other end (made on first use)
    const county = work && o >= NZ ? countyName[o - NZ] : work && resident && d >= NZ ? countyName[d - NZ] : null;
    // in-commuters by outside zone (all modes, transit)
    const wz = work && o >= NZ ? 2 * (o - NZ) : -1;
    let countyT: Float64Array | null = null,
      stopsT: number[] | null = null;
    const evT = purpose === "event" ? (eventModes[eventVenue] ??= byModes()) : null;
    const mi = autoMi(o, d);
    // a car trip's driving minutes, over the periods its legs travel in
    let driveT = NaN;
    if (dO[0] + dO[1] + dB[0] + dB[1] > 0 && mi < Infinity) {
      driveT = 0;
      for (let q = 0; q < TPERIODS.length; q++) {
        if (lw.out[q] > 0) driveT += oS * lw.out[q] * autoMin(o, d, TPERIODS[q]);
        if (bS > 0 && lw.back[q] > 0) driveT += bS * lw.back[q] * autoMin(d, o, TPERIODS[q]);
      }
      driveT /= Math.max(1e-9, oS + bS);
    }
    // cars on the roads: each leg in the periods it travels (as the transit trips, without the
    // service tilt), the periods reweighted when driving changed (macro time-period choice)
    const roads = autoOD !== null && mi < Infinity && dO[0] + dO[1] + dO[2] + dB[0] + dB[1] + dB[2] > 0;
    if (roads) todWeights(o, d, purpose, lw);
    // across the city line: the market's trips by mode, and (with LINE_X) its cars by crossing
    const lineE = o >= NZ ? o - NZ : d >= NZ ? d - NZ : -1;
    const lineKey = lineE >= 0 ? `${resident ? "res " : ""}${purpose}` : "";
    const lineP = lineE >= 0 && LINE_X.paths && mi < Infinity ? LINE_X.paths : null;
    if (lineP && !roads) todWeights(o, d, purpose, lw);
    for (let m = 0; m < 6; m++) {
      // trips booked here, by leg; all the primary legs; commutes by the mode of the trip to work (as
      // the ACS asks); tours (both legs) by their mode
      const tlO = n * oS * dOd[m],
        tlB = n * bS * dBd[m],
        tl = tlO + tlB,
        tt = n * (oS * dO[m] + bS * dB[m]),
        tw = work ? n * dO[m] : tt,
        tm = n * prob[m];
      if (tl > 0) {
        trips[m] += tl;
        purposeT[m] += tl;
        if (lineE >= 0) {
          (lineTrips[lineKey] ??= new Float64Array(6 * NX))[m * NX + lineE] += tl;
          if (lineP && m <= 2) {
            const V = (lineVeh[lineKey] ??= new Float64Array(LINE_X.n + 1));
            for (let q = 0; q < TPERIODS.length; q++) {
              if (tlO > 0 && todOut[q] > 0) V[lineP[q][o * ZA + d]] += tlO * todOut[q] * vehPer[m];
              if (tlB > 0 && todBack[q] > 0) V[lineP[q][d * ZA + o]] += tlB * todBack[q] * vehPer[m];
            }
          }
        }
        if (purpose === "nhb") nhbPool[m] += tl;
        if (evT) evT[m] += tl;
        if (resident) residentTrips[m] += tl;
        if (m <= 2 && mi < Infinity) vkt += tl * mi * 1.609 * vehOf[m];
        if (lengthBands)
          bandTally(
            resident
              ? purpose === "nhb"
                ? "resident nhb"
                : `resident ${purpose === "work" ? "work" : "home-based"} ${segKey ?? "other"}${person === "youth" ? " youth" : ""}`
              : purpose,
            o,
            d,
            m,
            tl,
          );
        if (m <= 1 && driveT < Infinity) {
          if (work) ((driveMin[0] += tl * driveT), (driveMin[1] += tl));
          driveMin[2] += tl * driveT;
          driveMin[3] += tl;
        }
        if (roads && m <= 2)
          for (let q = 0; q < TPERIODS.length; q++) {
            const tp = TPERIODS[q];
            if (tlO > 0 && todOut[q] > 0) addAuto(m, o, d, tlO * todOut[q], tp);
            if (tlB > 0 && todBack[q] > 0) addAuto(m, d, o, tlB * todBack[q], tp);
          }
      }
      if (tt > 0) {
        if (incomeT) incomeT[m] += tt;
        if (segT) segT[m] += tw;
        if (student) studentT[m] += tt;
        if (county !== null) (countyT ??= o >= NZ ? (workIn[county] ??= byModes()) : (workOut[county] ??= byModes()))[m] += tw;
        if (wz >= 0) {
          workInZone[wz] += tw;
          if (m === 3) workInZone[wz + 1] += tw;
        }
        // diagnostics: commute trips by mode between home and workplace zones (daily, both legs)
        if (markets && work) mkt(`work ${MODES[m]}`, "AM")![o * ZT + d] += tt;
      }
      if (tm > 0) {
        if (sigM[m] > 0) {
          stopMass[m][o * NZ + d] += tm * sigM[m];
          (stopsT ??= stopByPurpose[purpose] ??= [0, 0, 0, 0, 0, 0])[m] += tm * sigM[m];
          // car tours' legs through the stop, as the tour mode's vehicles, for the roads
          if (roads && m <= 1 && stopAuto) {
            const ts = tm * sigM[m] * vehPer[m],
              SA = stopAuto[m];
            for (let q = 0; q < TPERIODS.length; q++) {
              const tp = TPERIODS[q];
              if (todOut[q] > 0) SA.out[tp][o * NZ + d] += ts * oS * todOut[q];
              if (bS > 0 && todBack[q] > 0) SA.in[tp][o * NZ + d] += ts * bS * todBack[q];
            }
          }
        }
        // residents' work tours in the city: subtours from the workplace (n counts both legs: n/2 tours)
        if (work && resident && d < NZ) subMass[m][d] += (tm / 2) * WORK_SUBTOURS;
      }
    }
    // the shared bikes and scooters among the bike trips, legs through stops included
    const bikeT = n * (oS * dO[5] + bS * dB[5]);
    if (micro && bikeT > 0)
      micro.book(o, d, bikeT, purpose, segKey, resident, 1 + Math.min(0.9, sig0 * stopRateOf[5]), oneWayOf(purpose) ? 1 : oS, lw.out, lw.back);
    if (d < NZ) {
      zoneVisits[d] += n;
      zoneArrivals[2 * d] += n;
      zoneArrivals[2 * d + 1] += n * dO[3];
      if (
        purpose === "social" ||
        purpose === "visitor" ||
        purpose === "regional"
      )
        zoneVisitsLeisure[d] += n;
    }
    if (homeZone >= 0 && homeZone < NZ && resident) {
      zoneTrips[homeZone] += n;
      zoneTransit[homeZone] += n * (oS * dO[3] + bS * dB[3]);
      if (purpose === "work")
        ((zoneWork[homeZone] += n), (zoneWorkTransit[homeZone] += n * dO[3]));
    }
    // residents' tours: the modes of the leg back and the stops, by the tour's mode (and, as a check,
    // by the mode of the leg out)
    if (resident && homeZone >= 0 && TOUR_COEFFS[purpose] !== undefined) {
      const tours = n * oS;
      for (let M = 0; M < 6; M++) {
        latX[M * 7] += tours * prob[M];
        latS[M] += tours * prob[M] * 2 * sigM[M];
      }
      for (let k = 0; k < NS; k++)
        if (jB[k] > 0) ((latX[swFrom[k] * 7] -= tours * jB[k]), (latX[swFrom[k] * 6 + swTo[k]] += tours * jB[k]));
      if (TRIP_MIX.on)
        for (let M = 0; M < 6; M++) {
          const P = prob[M];
          if (!(P > 0)) continue;
          (cO.fill(0), cB.fill(0));
          cO[M] = cB[M] = 1;
          for (const k of swOf[M]) ((cO[M] -= jO[k] / P), (cO[swTo[k]] += jO[k] / P), (cB[M] -= jB[k] / P), (cB[swTo[k]] += jB[k] / P));
          for (let a = 0; a < 6; a++) {
            if (!(cO[a] > 0)) continue;
            const w = tours * P * cO[a];
            for (let b = 0; b < 6; b++) mixX[a * 6 + b] += w * cB[b];
            mixY[a * 6 + M] += w * 2 * sigM[M];
          }
        }
    }
    // transit: the legs booked here, and transit tours' halves with a stop (the stop pass books
    // their legs), by period and direction: each leg's trips spread over the periods by where it
    // travels and how well transit serves it then (periodSplit)
    const trO = n * oS * dOd[3],
      trB = n * bS * dBd[3],
      tsT = n * prob[3] * sigM[3];
    if (trO > 0 || trB > 0 || tsT > 0) {
      periodSplit(o, d, purpose);
      const key = markets ? (resident ? `resident ${purpose}` : purpose === "work" ? "in-commuters" : purpose) : "";
      const kOut = tz(o) * ZT + tz(d),
        kBack = tz(d) * ZT + tz(o);
      for (let q = 0; q < TPERIODS.length; q++) {
        const tp = TPERIODS[q];
        const out = trO * splitOut[q],
          back = trB * splitBack[q];
        if (out > 0 && minOut[q] < Infinity) ((trnMin += out * minOut[q]), (trnN += out));
        if (back > 0 && minBack[q] < Infinity) ((trnMin += back * minBack[q]), (trnN += back));
        const M = transitOD[tp];
        M[kOut] += out;
        M[kBack] += back;
        if (evOD && purpose === "event" && eventVenue === EVENT_OD.venue) ((evOD[tp][kOut] += out), (evOD[tp][kBack] += back));
        if (nrOD && !resident) ((nrOD[tp][kOut] += out), (nrOD[tp][kBack] += back));
        if (markets && (out > 0 || back > 0)) {
          const X = mkt(key, tp)!;
          X[kOut] += out;
          // residents' legs back home kept apart from the legs out (trips from home)
          const Xb = resident && !oneWayOf(purpose) ? mkt(`${key} return`, tp)! : X;
          Xb[kBack] += back;
        }
        if (tsT > 0) {
          stopT.out[tp][o * NZ + d] += tsT * oS * splitOut[q];
          stopT.in[tp][o * NZ + d] += tsT * bS * splitBack[q];
        }
      }
    }
    if (o < NZ && d < NZ) {
      const km = autoDm[o * NZ + d] / 100;
      kmSum[purpose] = (kmSum[purpose] ?? 0) + n * km;
      kmN[purpose] = (kmN[purpose] ?? 0) + n;
      kmBand(purpose, o, d, n);
    }
  };

  /** book the last choice's trips (its joint shares, if it was a resident's tour) */
  const bookNow = (o: number, d: number, n: number, purpose: Purpose, resident: boolean, segKey: string | null, homeZone: number) => {
    setJoint();
    book(o, d, n, purpose, resident, segKey, homeZone);
  };

  // ---- the person-level choices (abm.ts): accessibility, workplace choice, CDAP, tour frequency ----
  const AB = prep.abm,
    abmCal = calib.abm;
  const WD = NZ + NX;
  const abmT: AbmTally | undefined = AB
    ? { byPtype: new Float64Array(8 * ABM_COLS), workDest: new Float64Array(WD), workByGroup: new Float64Array(NZ * prep.workGroups.length), schoolDest: new Float64Array(NZ), univDest: new Float64Array(NZ), workKm: [0, 0], segments: 0, households: 0 }
    : undefined;
  /** each origin's expected tours by cell (ABM_CELLS), for the non-work pass */
  const abmCells = new Map<number, Float64Array>();
  /** TM1's accessibility (ActivitySim accessibility.csv) of an origin, over the city's jobs: auto peak
   * to all jobs (AM out, PM back), auto off-peak, transit off-peak, and walking to retail */
  const accessOf = (o: number): ZoneAccess => {
    const K = ASIM.accessibility;
    const aAM = autoSec.AM, aPM = autoSec.PM, aMD = autoSec.MD;
    const gMD = sk.MD.g;
    let pk = 0, op = 0, tr = 0, nm = 0;
    for (let d = 0; d < NZ; d++) {
      const z = H.zones[d];
      const tot = z.jobs, ret = z.jobsBy[6];
      if (!(tot > 0)) continue;
      pk += tot * Math.exp(K.autoDispersion * (aAM[o * NZ + d] + aPM[d * NZ + o]) / 60);
      op += ret * Math.exp(K.autoDispersion * (aMD[o * NZ + d] + aMD[d * NZ + o]) / 60);
      const g1 = gMD[o * ZT + d], g2 = gMD[d * ZT + o];
      if (g1 < Infinity && g2 < Infinity) tr += ret * Math.exp(K.transitDispersion * (g1 + g2));
      const wm = (walkM[o * NZ + d] + walkM[d * NZ + o]) / 1609.34;
      if (wm <= K.maxWalkMiles) nm += ret * Math.exp(K.walkDispersion * wm);
    }
    return { auPkTotal: Math.log1p(pk), auOpRetail: Math.log1p(op), trOpRetail: Math.log1p(tr), nmRetail: Math.log1p(nm) };
  };
  const classOfBand = INCOME_CLASSES.map(() => 0);
  const bandClass = [0, 1, 2, 3].map((k) => INCOME_CLASSES.findIndex((bs) => bs.includes(k)));
  void classOfBand;
  // workplace choice: per car segment and income class, the work tour's mode probabilities and logsum to each workplace
  const wProb = new Float64Array(3 * INCOME_CLASSES.length * WD * (6 + 2 * TRIP_SWITCH.length)),
    wLs = new Float64Array(3 * INCOME_CLASSES.length * WD),
    wP = new Float64Array(3 * 4 * WD),
    wU = new Float64Array(WD);
  const WC = ASIM.workplace;
  const workMiCap = workMiCapOf(H.zones);
  const wShadow = abmCal?.workShadow;
  const wDist = abmCal?.workDistScale ?? 1;
  const segT: SegTours = { pat: [0, 0, 0], work: 0, school: 0, nm: new Float64Array(6), nmOnM: 0, nmOnN: 0 };
  const cdapOut = AB ? newCdapOut(Math.max(1, ...Array.from({ length: NZ }, (_, z) => AB.segStart[z + 1] - AB.segStart[z]))) : null;
  const observedWork = (abmCal?.workplace ?? ABM.workplace ?? "choice") === "observed" || ABM.workplace === "observed";
  /**
   * Residents' commutes by the person-level choices, origin by origin: the zone's accessibility; each
   * car segment's and income band's workplace choice (TM1's distance terms, its 0.3 on the work tour's
   * mode-choice logsum, TM1's size terms by income on LODES jobs, and the calibrated shadow prices);
   * the CDAP and tour frequency of the zone's segments (abm.ts); then the work tours booked to
   * each workplace with the mode probabilities already chosen.
   */
  function abmCommutes(shuttleTo: boolean[], shuttleShareOf: Record<string, number>) {
    // distance to a workplace (miles): the road distance, but within the city never more than 1.5
    // times the straight line (a few zones' road distances are broken in the skims: the Presidio's
    // and three others' are four or more times their straight-line distance from everywhere)
    const workMi = (o: number, d: number) => (d < NZ ? Math.min(autoMi(o, d), workMiCap(o, d)) : autoMi(o, d));
    const A = AB!;
    const fh = b.a.flowH as Int32Array, fw = b.a.flowW as Int32Array, fn = outCommuteWeights(b, calib);
    // the census flows from each origin (for 'observed' workplaces)
    const flowsOf = new Map<number, [number, number][]>();
    if (observedWork) for (let i = 0; i < fh.length; i++) if (mine(fh[i])) (flowsOf.get(fh[i]) ?? flowsOf.set(fh[i], []).get(fh[i])!).push([fw[i], fn[i]]);
    // school statistics for mandatory tour frequency: a distance-only school choice (TM1's grade-school
    // distance terms on enrollment; assumed, as the school choice with logsums comes later)
    const schSize = prep.size.school;
    const NC = INCOME_CLASSES.length;
    const commutes = new Float64Array(JW);
    for (let o = split.index; o < NZ; o += split.count) {
      const z0 = A.segStart[o], nSeg = A.segStart[o + 1] - z0;
      if (nSeg === 0 && !(H.zones[o].workers > 0)) continue;
      gen++;
      cacheOn = true;
      const acc = accessOf(o);
      // 1. workplace choice
      for (let s = 0; s < 3; s++)
        for (let c = 0; c < NC; c++) {
          const base = (s * NC + c) * WD;
          for (let d = 0; d < WD; d++) {
            wLs[base + d] = -Infinity;
            if (!(prep.workSize[0][d] > 0 || prep.workSize[3][d] > 0) && !(observedWork)) continue;
            const ls = choose(o, d, "work", SEGMENTS[s], prep.votInc[c][o]);
            wLs[base + d] = ls;
            if (ls === -Infinity) continue;
            setJoint();
            storeP(wProb, (base + d) * JW);
          }
        }
      const stats = new Float64Array(3 * 4 * 2);
      for (let s = 0; s < 3; s++)
        for (let band = 0; band < 4; band++) {
          const c = bandClass[band], base = (s * NC + c) * WD, P = (s * 4 + band) * WD;
          let mx = -Infinity;
          if (observedWork) {
            wP.fill(0, P, P + WD);
            let t = 0;
            for (const [d, n] of flowsOf.get(o) ?? []) if (wLs[base + d] > -Infinity) ((wP[P + d] += n), (t += n));
            if (t > 0) for (let d = 0; d < WD; d++) wP[P + d] /= t;
          } else {
            const S = prep.workSize[band];
            for (let d = 0; d < WD; d++) {
              const ls = wLs[base + d];
              if (ls === -Infinity || !(S[d] > 0)) {
                wU[d] = -Infinity;
                continue;
              }
              const mi = workMi(o, d);
              const v =
                wDist * (tm1Dist(WC.dist, mi) + (band >= 2 ? WC.dist05High * Math.min(mi, 5) + WC.dist5upHigh * Math.max(0, mi - 5) : 0)) +
                WC.logsum * ls +
                Math.log1p(S[d]) +
                (wShadow?.[d] ?? 0);
              wU[d] = v;
              if (v > mx) mx = v;
            }
            let t = 0;
            for (let d = 0; d < WD; d++) t += wP[P + d] = wU[d] > -Infinity ? Math.exp(wU[d] - mx) : 0;
            for (let d = 0; d < WD; d++) wP[P + d] /= t || 1;
          }
          let lt3 = 0, rt = 0;
          for (let d = 0; d < WD; d++) {
            const p = wP[P + d];
            if (!p) continue;
            const mi = workMi(o, d);
            if (mi < 3) lt3 += p;
            rt += p * (autoMin(o, d, "AM") + autoMin(d, o, "PM"));
          }
          stats[(s * 4 + band) * 2] = lt3;
          stats[(s * 4 + band) * 2 + 1] = rt;
        }
      // school statistics (all segments alike)
      let sLt3 = 0, sRt = 0;
      {
        let t = 0;
        for (let d = 0; d < NZ; d++) {
          if (!(schSize[d] > 0)) continue;
          const mi = autoDm[o * NZ + d] / 160.934;
          const w = schSize[d] * Math.exp(tm1Dist(ASIM.school.grade, mi));
          t += w;
          if (mi < 3) sLt3 += w;
          sRt += w * (autoMin(o, d, "AM") + autoMin(d, o, "PM"));
        }
        if (t > 0) ((sLt3 /= t), (sRt /= t));
      }
      ABM_DEBUG.inputs?.set(o, { acc, stats: stats.slice(), school: [sLt3, sRt] });
      // 2. day patterns and tours of the zone's segments
      const cells = new Float64Array(ABM_CELLS);
      if (nSeg > 0) {
        const C = cdapOut!;
        for (const k of ["M", "N", "H", "kid8H", "kid7H", "u16NotM"] as const) C[k].fill(0, 0, nSeg);
        cdapZone(A, o, acc, abmCal, C);
        abmT!.households += A.hhStart[o + 1] - A.hhStart[o];
        abmT!.segments += nSeg;
        for (let i = 0; i < nSeg; i++) {
          const g = z0 + i, w = A.segW[g];
          const car = A.segCar[g], band = A.segBand[g], c = bandClass[band], pcl = A.segClass[g], pt = A.segPtype[g];
          const st = (car * 4 + band) * 2;
          segmentTours(A, g, [C.M[i] / w, C.N[i] / w, C.H[i] / w], {
            "distance_to_work<3": stats[st], roundtrip_auto_time_to_work: stats[st + 1],
            "distance_to_school<3": sLt3, roundtrip_auto_time_to_school: sRt,
            num_under16_not_at_school: C.u16NotM[i] / w, has_preschool_kid_at_home: C.kid8H[i] / w, has_school_kid_at_home: C.kid7H[i] / w,
          }, acc, abmCal, segT);
          cells[CELL.work + car * 4 + band] += w * segT.work;
          const sch = A.segSchool[g];
          if (sch === 3) cells[CELL.univ + car * NC + c] += w * segT.school;
          else if (sch > 0) {
            // preschool and daycare (under 5) are errands near home; kindergarten to grade 12 is school
            if (pt === 8 && A.segYoung[g] === 1) cells[CELL.nm + ((car * NC + c) * 3 + 1) * 3 + 1] += w * segT.school;
            else cells[CELL.school + (car * NC + c) * 2 + (A.segYoung[g] ? 1 : 0)] += w * segT.school;
          }
          for (let q = 0; q < 6; q++) cells[CELL.nm + ((car * NC + c) * 3 + pcl) * 3 + NM_TO_MODEL[q]] += w * segT.nm[q];
          const r = (pt - 1) * ABM_COLS, T = abmT!.byPtype;
          T[r] += w;
          T[r + 1] += C.M[i];
          T[r + 2] += C.N[i];
          T[r + 3] += C.H[i];
          T[r + 4] += w * segT.work;
          T[r + 5] += w * segT.school;
          for (let q = 0; q < 6; q++) T[r + 6 + q] += w * segT.nm[q];
          if (A.segWfh[g]) T[r + 12] += w;
          else T[r + 13] += C.M[i];
          T[r + 15] += w * segT.nmOnM;
          T[r + 16] += w * segT.nmOnN;
          if (pt === 3 || pt === 6 || ((pt === 1 || pt === 2) && (!A.segWfh[g] || A.segFlag[g])) || (pt >= 7 && A.segFlag[g])) T[r + 14] += w;
        }
      }
      abmCells.set(o, cells);
      // 3. commutes: each car segment's work tours to each workplace, by the modes already chosen
      const shuttleReach = H.zones[o].shuttleReach ?? 0;
      for (let s = 0; s < 3; s++)
        for (let d = 0; d < WD; d++) {
          const sh = d >= NZ && shuttleTo[d - NZ] ? shuttleReach * (shuttleShareOf[H.ext[d - NZ].county] ?? 0) : 0;
          commutes.fill(0);
          let nc = 0;
          for (let c = 0; c < NC; c++) {
            const base = (s * NC + c) * WD + d;
            if (wLs[base] === -Infinity) continue;
            let n = 0;
            for (const band of INCOME_CLASSES[c]) n += cells[CELL.work + s * 4 + band] * wP[(s * 4 + band) * WD + d];
            n *= 2 * rateOf("work") * attendAt(d);
            // as the census flows' commutes: none smaller than 1e-4 trips is booked
            if (n < 1e-4) continue;
            abmT!.workDest[d] += n;
            abmT!.workByGroup[o * prep.workGroups.length + prep.workGroupOf[d]] += n;
            if (d < NZ) ((abmT!.workKm[0] += n), (abmT!.workKm[1] += n * workMi(o, d) * 1.609344));
            if (sh > 0) {
              const ss = n * sh;
              shuttleTrips += ss;
              shuttleOut[countyName[d - NZ]] = (shuttleOut[countyName[d - NZ]] ?? 0) + ss;
              shuttleBySeg[SEGMENTS[s]] = (shuttleBySeg[SEGMENTS[s]] ?? 0) + ss;
              zoneWork[o] += ss;
              zoneWorkTransit[o] += ss;
              zoneTrips[o] += ss;
              n -= ss;
            }
            const ls = wLs[base];
            loadP(wProb, base * JW);
            putJoint(commutes, 0, n);
            // the income tally by the trips' modes
            tallyJoint(n, "work", byIncome[c]);
            nc += n;
            logsum += n * ls * lsMinutes("work");
            zoneLS[o] += n * ls * lsMinutes("work");
            zoneLSw[o] += n;
          }
          if (nc <= 0 || getJoint(commutes, 0) <= 0) continue;
          incBand = -1;
          book(o, d, nc, "work", true, SEGMENTS[s], o);
        }
      cacheOn = false;
    }
  }

  // ---- 1. commutes on census flows: a work tour for each commuter at work that day ----
  let shuttleTrips = 0;
  const shuttleBySeg: Record<string, number> = {};
  {
    const fh = A.flowH as Int32Array,
      fw = A.flowW as Int32Array,
      fn = A.flowN as Float32Array;
    // each flow's weight, with the flows to an outside county scaled to its share of the city's
    // commuters in the model year (outCommuteWeights)
    const fnW = outCommuteWeights(b, calib);
    const tot = new Float64Array(NZ);
    for (let i = 0; i < fh.length; i++) tot[fh[i]] += fnW[i];
    const workRate = rateOf("work");
    const tripsOf = (i: number) => {
      const o = fh[i],
        d = fw[i],
        z = H.zones[o];
      const commuters = z.workers * (1 - Math.min(0.95, z.wfh * wfhF)) * resAttend * residentF;
      return commuters * (fnW[i] / tot[o]) * 2 * workRate * attendAt(d);
    };
    // commute days by income class (BATS 2023 Table 46), relative to the city's mean
    const daysByClass = commuteDaysByClass(H.zones, (_k, s, c, o) => prep.workShare[s][c][o]);
    // private shuttles (weekdays): the share of eligible commutes they carry, from their rider count
    const shuttleTo = H.ext.map((x) => SHUTTLE_COUNTIES.includes(x.county));
    // by county: each county's riders over the commutes there from near a stop
    const eligible: Record<string, number> = {};
    if (day === "wkd")
      for (let i = 0; i < fh.length; i++)
        if (fw[i] >= NZ && shuttleTo[fw[i] - NZ]) {
          const c = H.ext[fw[i] - NZ].county;
          eligible[c] =
            (eligible[c] ?? 0) +
            tripsOf(i) * (H.zones[fh[i]].shuttleReach ?? 0);
        }
    const shuttleShareOf: Record<string, number> = {};
    for (const [c, e] of Object.entries(eligible))
      shuttleShareOf[c] =
        e > 0 ? Math.min(0.8, (2 * (SHUTTLE_RIDERS[c] ?? 0) * (resAttend / ATTENDANCE) * residentF) / e) : 0;
    // residents' commutes: an outside end is a workplace
    extActivity = true;
    const commutes = new Float64Array(JW);
    if (prep.abm) abmCommutes(shuttleTo, shuttleShareOf);
    else for (let i = 0; i < fh.length; i++) {
      const o = fh[i],
        d = fw[i];
      if (!mine(o)) continue;
      let n = tripsOf(i);
      if (n < 1e-4) continue;
      const sh =
        d >= NZ && shuttleTo[d - NZ]
          ? n *
            (H.zones[o].shuttleReach ?? 0) *
            (shuttleShareOf[H.ext[d - NZ].county] ?? 0)
          : 0;
      n -= sh;
      gen++;
      for (let s = 0; s < 3; s++) {
        if (sh > 0) {
          const ss = sh * prep.workShare[s].reduce((a, v) => a + v[o], 0);
          shuttleTrips += ss;
          shuttleOut[countyName[d - NZ]] =
            (shuttleOut[countyName[d - NZ]] ?? 0) + ss;
          shuttleBySeg[SEGMENTS[s]] = (shuttleBySeg[SEGMENTS[s]] ?? 0) + ss;
          if (markets) mkt("work shuttle", "AM")![o * prep.ZT + d] += ss;
          // the ACS records shuttle riders as bus commuters
          zoneWork[o] += ss;
          zoneWorkTransit[o] += ss;
          zoneTrips[o] += ss;
        }
        cacheOn = true;
        // the segment's commutes by mode, summed over income bands before they are booked (the
        // income tally is kept here)
        commutes.fill(0);
        for (let ib = 0; ib < INCOME_CLASSES.length; ib++) {
          const ns = n * prep.workShare[s][ib][o] * daysByClass[ib];
          if (ns <= 0) continue;
          const ls = choose(o, d, "work", SEGMENTS[s], prep.votInc[ib][o]);
          if (ls === -Infinity) continue;
          setJoint();
          putJoint(commutes, 0, ns);
          // the income tally by the trips' modes
          tallyJoint(ns, "work", byIncome[ib]);
          logsum += ns * ls * lsMinutes("work");
          zoneLS[o] += ns * ls * lsMinutes("work");
          zoneLSw[o] += ns;
        }
        const nc = getJoint(commutes, 0);
        if (nc <= 0) continue;
        book(o, d, nc, "work", true, SEGMENTS[s], o);
      }
      cacheOn = false;
    }
    extActivity = false;
    // in-commuters from outside the city (ACS: about a quarter work from home on a given day)
    const ie = A.inE as Int32Array,
      iw = A.inW as Int32Array,
      inn = A.inN as Float32Array;
    // the share from households without a car (ACS PUMS by home PUMA, build.ts) reach the city's
    // transit on foot or by bus: the outside zone's activity end, which has no lot
    for (let i = 0; i < ie.length; i++) {
      const o = NZ + ie[i],
        d = iw[i];
      if (!mine(i)) continue;
      const n = inn[i] * inAttend[ie[i]] * 2 * rateOf("work") * attendAt(d);
      const z0 = H.ext[ie[i]].zeroCar ?? 0;
      for (const without of [false, true]) {
        const nn = n * (without ? z0 : 1 - z0);
        if (nn <= 0) continue;
        noCar = extActivity = without;
        const ls = choose(o, d, "work", "ext", VOT_TYPICAL);
        if (ls !== -Infinity) {
          bookNow(o, d, nn, "work", false, null, -1);
          logsum += nn * ls * lsMinutes("work");
        }
      }
      noCar = extActivity = false;
    }
  }

  // ---- 2. other trips: destination choice on size and accessibility ----
  const util = new Float64Array(Z),
    expU = new Float64Array(Z);
  // each destination's mode shares and its trips' joint shares (JW wide)
  const probs = new Float64Array(Z * JW);
  // each purpose's destination sizes (parks added) and their logs
  // (school tours by level and college tours by where students live have size terms of their own,
  // with shadow prices holding them to enrollment: calib.shadow)
  const sizes: Record<string, { s: Float64Array; log: Float64Array }> = {};
  const sizeKey = (purpose: Purpose) =>
    purpose === "school" && schoolLevel >= 0 ? `school${schoolLevel}` : purpose === "univ" ? (univOutside ? "univNR" : "univR") : purpose;
  const sizeOf = (purpose: Purpose) => {
    const key = sizeKey(purpose);
    let r = sizes[key];
    if (!r) {
      const size = prep.size[key],
        parkW = PARK_SIZE[purpose] ?? 0,
        sh = calib.shadow?.[key];
      const s = Float64Array.from(size, (v, d) => v + parkW * parkSize[d]);
      r = sizes[key] = { s, log: s.map((v, d) => Math.log(v) + (v > 0 ? (sh?.[d] ?? 0) : 0)) };
    }
    return r;
  };
  // school and college arrivals by size term, and school trips by level (modes, straight-line distance)
  const attract: Record<string, Float64Array> = Object.fromEntries(["school0", "school1", "school2", "univR"].map((k) => [k, new Float64Array(NZ)]));
  const schoolStats = new Float64Array(SCHOOL_LEVELS.length * 10);
  // school tours by level: [leg to school by mode (6), leg home by mode (6), car-passenger tours' legs home, of them by transit]
  const schoolDir = new Float64Array(SCHOOL_LEVELS.length * 14);
  // college trips arriving at each zone by mode (zone × 6), residents' and others'
  const collegeModes = new Float64Array(NZ * 6);
  const schoolScale = calib.schoolDistScale ?? 1;
  const Zx = H.zones.map((z) => z.x),
    Zy = H.zones.map((z) => z.y);
  // college trips a weekday (two a tour) at the city's campuses, by students living in it and outside it
  // (COLLEGE); residents' are shared out by where college students live
  const collegeTrips = (() => {
    let all = 0, res = 0;
    for (let i = 0; i < NZ; i++) ((all += prep.size.univ[i]), (res += prep.size.univR[i]));
    const T = 2 * COLLEGE.inPerson * COLLEGE.attendance * rateOf("univ");
    const students = H.zones.reduce((a, z) => a + z.college, 0);
    return { perResident: all > 0 && students > 0 ? (T * res) / all / students : 0, outside: all > 0 ? (T * (all - res)) / all : 0 };
  })();
  const toSFall = H.ext.reduce((a, x) => a + x.toSF, 0);
  // residents' home-based tours of one origin and car segment, summed over income bands and person
  // types by destination and mode before they are booked (booking is linear in each mode's trips)
  // (and their trips' joint shares, JW wide)
  const accTrips = Object.fromEntries(["shop", "other", "social", "school", "univ"].map((p) => [p, new Float64Array(NZ * JW)])) as Record<string, Float64Array>;
  let accSeg: string | null = null;
  const flushAcc = (o: number) => {
    if (accSeg === null) return;
    const band = incBand;
    incBand = -1; // the income tally was kept as the trips were summed
    for (const [purpose, A] of Object.entries(accTrips))
      for (let d = 0; d < NZ; d++) {
        const n = getJoint(A, d * JW);
        if (!(n > 0)) continue;
        A.fill(0, d * JW, (d + 1) * JW);
        book(o, d, n, purpose as Purpose, true, accSeg, o);
      }
    incBand = band;
    accSeg = null;
  };
  const destChoice = (
    o: number,
    prodTrips: number,
    purpose: Purpose,
    segKey: string,
    vot: number,
    resident: boolean,
    homeZone: number,
  ) => {
    if (prodTrips <= 0) return;
    const S = sizeOf(purpose);
    const distCoef = calib.distCoef[purpose] ?? 0;
    const logCoef = calib.distLogCoef?.[purpose] ?? 0;
    const parkW = PARK_SIZE[purpose] ?? 0;
    // school tours: TM1's distance terms for the level (utility per mile), on one calibrated scale
    const lvDist = purpose === "school" && schoolLevel >= 0 ? SCHOOL_LEVELS[schoolLevel].dist : null;
    // residents' schools and colleges with the person-level choices: shadow prices to enrollment
    const shadow = AB && resident ? (purpose === "school" ? abmCal?.schoolShadow : purpose === "univ" ? abmCal?.univShadow : undefined) : undefined;
    const destT = AB && resident ? (purpose === "school" ? abmT!.schoolDest : purpose === "univ" ? abmT!.univDest : null) : null;
    let maxU = -Infinity;
    for (let d = 0; d < NZ; d++) {
      if (S.s[d] <= 0) {
        util[d] = -Infinity;
        continue;
      }
      const ls = choose(o, d, purpose, segKey, vot);
      if (ls === -Infinity) {
        util[d] = -Infinity;
        continue;
      }
      setJoint();
      storeP(probs, d * JW);
      const km =
        o < NZ ? autoDm[o * NZ + d] / 100 : extDmIn[(o - NZ) * NZ + d] / 100;
      const v = S.log[d] + TUNE.destLogsum * ls + (lvDist ? schoolScale * tm1U(lvDist, km) : distCoef * distTerm(purpose, km) + logCoef * nearTerm(km)) + (shadow ? shadow[d] ?? 0 : 0);
      util[d] = v;
      if (v > maxU) maxU = v;
    }
    if (maxU === -Infinity) return;
    let sum = 0;
    for (let d = 0; d < NZ; d++)
      if (util[d] > -Infinity) sum += expU[d] = Math.exp(util[d] - maxU);
    const ds = Math.log(sum) + maxU; // destination-choice logsum
    // residents' tours from home are summed over income bands before they are booked
    const A = resident && homeZone === o && incBand >= 0 ? accTrips[purpose] : undefined;
    const AT = purpose === "school" || (purpose === "univ" && !univOutside) ? attract[sizeKey(purpose)] : undefined;
    const SS = lvDist ? schoolLevel * 10 : -1;
    const cs = ((prodTrips * ds) / TUNE.destLogsum) * lsMinutes(purpose);
    logsum += cs;
    if (homeZone >= 0 && resident)
      ((zoneLS[homeZone] += cs), (zoneLSw[homeZone] += prodTrips));
    for (let d = 0; d < NZ; d++) {
      if (util[d] === -Infinity) continue;
      const n = (prodTrips * expU[d]) / sum;
      if (n < 1e-6) continue;
      if (destT) destT[d] += n;
      if (parkW > 0 && parkSize[d] > 0)
        // a visit is a tour: n counts its two legs
        zoneParkVisits[d] += (0.5 * n * parkW * parkSize[d]) / S.s[d];
      if (AT) AT[d] += n;
      if (purpose === "univ") for (let m = 0; m < 6; m++) collegeModes[d * 6 + m] += n * probs[d * JW + m];
      if (SS >= 0) {
        for (let m = 0; m < 6; m++) schoolStats[SS + m] += n * probs[d * JW + m];
        const mi = o < NZ ? Math.hypot(Zx[o] - Zx[d], Zy[o] - Zy[d]) / 1609.34 : Infinity;
        schoolStats[SS + (mi < 1 ? 6 : mi < 2 ? 7 : 8)] += n;
        schoolStats[SS + 9] += n;
      }
      loadP(probs, d * JW);
      // school tours by level: each leg's trips by mode (the tour's mode, less and plus the switches),
      // and the car-passenger tours' legs home, and those by transit (booking may come later, by purpose)
      if (SS >= 0) {
        const D = (SS / 10) * 14;
        for (let m = 0; m < 6; m++) ((schoolDir[D + m] += n * prob[m]), (schoolDir[D + 6 + m] += n * prob[m]));
        for (let k = 0; k < NS; k++) {
          schoolDir[D + swFrom[k]] -= n * jO[k];
          schoolDir[D + swTo[k]] += n * jO[k];
          schoolDir[D + 6 + swFrom[k]] -= n * jB[k];
          schoolDir[D + 6 + swTo[k]] += n * jB[k];
          if (swFrom[k] === 1 && swTo[k] === 3) schoolDir[D + 13] += n * jB[k];
        }
        schoolDir[D + 12] += n * prob[1];
      }
      if (A) {
        accSeg = segKey;
        putJoint(A, d * JW, n);
        tallyJoint(n, purpose, person !== "youth" ? byIncome[incBand] : youthTrips);
        continue;
      }
      book(o, d, n, purpose, resident, segKey, homeZone);
    }
  };

  /**
   * Destination choice for several person types at once: each destination's mode utilities are
   * computed once for adults, and for youth and seniors adjusted by their transit fare (and, for
   * youth, no driving alone or ride-hailing), which is all that differs between them.
   */
  const typeU = new Float64Array(6),
    typeC = new Float64Array(6),
    adultP = new Float64Array(6),
    adultG = new Float64Array(6),
    tu1 = new Float64Array(6),
    tc1 = new Float64Array(6),
    typeProbs = [
      new Float64Array(NZ * JW),
      new Float64Array(NZ * JW),
      new Float64Array(NZ * JW),
    ];
  const typeUtil = [
    new Float64Array(NZ),
    new Float64Array(NZ),
    new Float64Array(NZ),
  ];
  const destChoiceTypes = (
    o: number,
    people: [PersonType, number][],
    purpose: Purpose,
    segKey: string,
    vot: number,
  ) => {
    const S = sizeOf(purpose);
    const distCoef = calib.distCoef[purpose] ?? 0;
    const logCoef = calib.distLogCoef?.[purpose] ?? 0;
    const parkW = PARK_SIZE[purpose] ?? 0;
    const ivt = coeffsOf(purpose).ivt;
    const maxU = [-Infinity, -Infinity, -Infinity];
    person = "adult";
    for (let d = 0; d < NZ; d++) {
      if (S.s[d] <= 0) {
        for (let t = 0; t < people.length; t++) typeUtil[t][d] = -Infinity;
        continue;
      }
      const lsAdult = choose(o, d, purpose, segKey, vot);
      if (lsAdult === -Infinity) {
        for (let t = 0; t < people.length; t++) typeUtil[t][d] = -Infinity;
        continue;
      }
      // u holds the adults' utilities without money, c1 their money (c1[3] the adult fare), and
      // prob their shares; gain and tcAt their trips' (lu0, lu1, lc0, lc1: their legs')
      for (let m = 0; m < 6; m++) (adultP[m] = prob[m]), (adultG[m] = gain[m]);
      const adultAt = tcAt;
      const inCity = d < NZ;
      const km = autoDm[o * NZ + d] / 100;
      const base = S.log[d] + distCoef * distTerm(purpose, km) + logCoef * nearTerm(km);
      for (let t = 0; t < people.length; t++) {
        const pt = people[t][0];
        let ls = lsAdult;
        if (pt === "adult") {
          for (let m = 0; m < 6; m++) prob[m] = adultP[m];
          tcAt = adultAt;
        } else {
          const pf = PERSON_FARE[pt];
          const ff = inCity ? (pt === "senior" ? pf.inCity * seniorsPaying : pf.inCity) : pf.outside;
          // the legs' money at their fares (the fare takes the person type's multiple; money other than
          // fares does not), and the trips' expected money added below
          for (let m = 0; m < 6; m++) (typeU[m] = u[m]), (typeC[m] = lc0[m] + lc1[m]);
          (tu1.set(lu1), tc1.set(lc1));
          typeC[3] = lo0 + lo1 + (typeC[3] - lo0 - lo1) * ff;
          tc1[3] = lo1 + (tc1[3] - lo1) * ff;
          if (pt === "youth") {
            typeU[0] = typeU[2] = -Infinity;
            tu1[0] = tu1[2] = -Infinity;
            for (let m = 0; m < 6; m++) if (typeU[m] > -Infinity) typeU[m] += youthAsc[MODES[m]] ?? 0;
          }
          // their own trips' choice (fares, no driving for youth) in place of the adults'
          if (adultAt >= 0) {
            tripGains(o, purpose, cacheOn ? (PIDX[purpose] * 3 + PTIDX[pt]) * Z + d : -1, pt, tu1, tc1);
            for (let m = 0; m < 6; m++) if (typeU[m] > -Infinity) (typeU[m] += gain[m] - adultG[m]), (typeC[m] += gainC[m]);
            tcAt = swAt;
          } else tcAt = -1;
          micro?.at(o, d, purpose, 2, pt === "youth");
          ls = mixLogit(typeU, typeC, pt === "youth" ? vot * YOUTH_VOT_FACTOR : vot, ivt);
        }
        if (ls === -Infinity) {
          typeUtil[t][d] = -Infinity;
          continue;
        }
        setJoint();
        storeP(typeProbs[t], d * JW);
        const v = base + TUNE.destLogsum * ls;
        typeUtil[t][d] = v;
        if (v > maxU[t]) maxU[t] = v;
      }
    }
    for (let t = 0; t < people.length; t++) {
      const prodTrips = people[t][1];
      if (prodTrips <= 0 || maxU[t] === -Infinity) continue;
      const U = typeUtil[t],
        P = typeProbs[t];
      const A = incBand >= 0 ? accTrips[purpose] : undefined,
        incomeT = people[t][0] !== "youth" ? byIncome[incBand] : youthTrips;
      let sum = 0;
      for (let d = 0; d < NZ; d++)
        if (U[d] > -Infinity) sum += expU[d] = Math.exp(U[d] - maxU[t]);
      const ds = Math.log(sum) + maxU[t];
      const cs = ((prodTrips * ds) / TUNE.destLogsum) * lsMinutes(purpose);
      logsum += cs;
      zoneLS[o] += cs;
      zoneLSw[o] += prodTrips;
      for (let d = 0; d < NZ; d++) {
        if (U[d] === -Infinity) continue;
        const n = (prodTrips * expU[d]) / sum;
        if (n < 1e-6) continue;
        if (parkW > 0 && parkSize[d] > 0)
          zoneParkVisits[d] += (0.5 * n * parkW * parkSize[d]) / S.s[d];
        loadP(P, d * JW);
        if (A) {
          accSeg = segKey;
          putJoint(A, d * JW, n);
          tallyJoint(n, purpose, incomeT);
          if (people[t][0] === "youth") micro?.youth(purpose, d, n * P[d * JW + 5]);
          continue;
        }
        book(o, d, n, purpose, true, segKey, o);
      }
    }
  };

  for (let o = split.index; o < NZ; o += split.count) {
    opts?.progress?.((DEMAND_PHASE.homeBased * o) / NZ);
    const z = H.zones[o];
    for (let hc = 0; hc < 3 * INCOME_CLASSES.length; hc++) {
      const s = Math.floor(hc / INCOME_CLASSES.length);
      incBand = hc % INCOME_CLASSES.length;
      if (incBand === 0) flushAcc(o);
      if (hc === 0) gen++;
      cacheOn = true;
      // residents of the segment (population as a condition, context.ts)
      const pop = prep.people.pop[s][incBand][o] * popF;
      // the person-level choices' tours (two trips each), or the aggregate rates
      const cells = abmCells.get(o);
      const cellNm = (pcl: number, q: number) => (cells ? 2 * cells[CELL.nm + ((s * INCOME_CLASSES.length + incBand) * 3 + pcl) * 3 + q] : 0);
      if (cells ? !cells.some((v) => v > 0) : pop <= 0) continue;
      const youth = prep.people.youth[s][incBand][o] * popF,
        senior = prep.people.senior[s][incBand][o] * popF;
      const vot = prep.votInc[incBand][o];
      const sk = SEGMENTS[s];
      // residents' non-work trips that leave the city are handled below
      const inCity = 1 - calib.outShare;
      // home-based shopping, other, and social trips by person type
      const people: [PersonType, number][] = [
        ["youth", youth],
        ["senior", senior],
        ["adult", Math.max(0, pop - youth - senior)],
      ];
      // tours (two legs each) by primary purpose, all person types together
      const PCL: Record<PersonType, number> = { adult: 0, youth: 1, senior: 2 };
      // survey underreporting (a sensitivity test; 1 in the model): by segment and limited-English share
      const underF = UNDERREPORT.tours[s][incBand] * (1 + (UNDERREPORT.lepShare?.[o] ?? 0) * (UNDERREPORT.lep - 1));
      for (const pp of ["shop", "other", "social"] as const)
        destChoiceTypes(
          o,
          people.map(
            ([pt, n]) =>
              [
                pt,
                (cells ? cellNm(PCL[pt], ["shop", "other", "social"].indexOf(pp)) : n * 2 * TOUR_RATES[pp] * PERSON_RATE[pp][pt]) *
                  tourFactor *
                  underF *
                  inCity *
                  rateOf(pp),
              ] as [PersonType, number],
          ),
          pp,
          sk,
          vot,
        );
      // school tours by level (TM1's age term on transit for elementary pupils)
      person = "youth";
      // school tours by level (SCHOOL_LEVELS: the zone's pupils at each, from ACS enrollment by level),
      // the segment taking its share of the zone's children (the synthetic population's when demand uses
      // it, prep.people), scaled with the population condition; with the person-level choices, their
      // school tours (10 or under, 11 and over), shared over the levels of each age group by enrollment
      const youthShare = z.age5to17 > 0 ? youth / z.age5to17 : 0;
      const ageShare = (young: boolean) => SCHOOL_LEVELS.reduce((a, l) => a + (l.young === young ? l.share : 0), 0);
      SCHOOL_LEVELS.forEach((lv, l) => {
        schoolLevel = l;
        young = lv.young;
        const kids = z.pupils ? z.pupils[l] : z.age5to17 * lv.share;
        const trips = cells
          ? 2 * cells[CELL.school + (s * INCOME_CLASSES.length + incBand) * 2 + (lv.young ? 1 : 0)] * (lv.share / ageShare(lv.young)) * rateOf("school")
          : kids * youthShare * SCHOOL_TRIPS_PER_CHILD * rateOf("school");
        destChoice(o, trips, "school", sk, vot, true, o);
      });
      schoolLevel = -1;
      young = false;
      person = "adult";
      destChoice(o, cells ? 2 * cells[CELL.univ + s * INCOME_CLASSES.length + incBand] * rateOf("univ") : prep.people.college[s][incBand][o] * popF * collegeTrips.perResident, "univ", sk, vot, true, o);
    }
    flushAcc(o);
  }
  incBand = -1;
  cacheOn = false;
  // trips not from home: produced where activity is, citywide total from residents, commuters and visitors
  {
    const pop = H.zones.reduce((s, z) => s + z.pop, 0);
    const inComm = (A.inN as Float32Array).reduce(
      (s, v, i) => s + v * inAttend[(A.inE as Int32Array)[i]],
      0,
    );
    const visitors =
      prep.hotelVisitors.reduce((s, v) => s + v, 0) * (context?.visitors ?? 1);
    // residents' trips not from home come from their tours' stops and work subtours (the stop pass);
    // in-commuters' and visitors' are produced here
    void pop;
    // in-commuters' follow their days at work (the day's work rate and attendance)
    const own = DEMAND_OPTS.visitorTripsOwnChoice;
    const total = inComm * 0.8 * rateOf("work") * attendOther + (own ? 0 : visitors * 1.0);
    const W = prep.nhbProd.reduce((s, v) => s + v, 0);
    const P = DEMAND_PHASE, mid = (P.homeBased + P.notHome) / 2;
    for (let o = split.index; o < NZ; o += split.count)
      opts?.progress?.(P.homeBased + ((mid - P.homeBased) * o) / NZ),
      destChoice(
        o,
        (total * prep.nhbProd[o]) / W,
        "nhb",
        "car1",
        VOT_TYPICAL,
        // in-commuters' and visitors' (residents' come from their tours)
        false,
        -1,
      );
    // visitors' trips between the places they visit: where visitors go (the visitor size term), and
    // chosen as visitors choose (few have a car), not with residents' one-car constants
    if (own) {
      const SV = prep.size.visitor.reduce((s, v) => s + v, 0);
      for (let o = split.index; o < NZ; o += split.count)
        opts?.progress?.(mid + ((P.notHome - mid) * o) / NZ), destChoice(o, (visitors * 1.0 * prep.size.visitor[o]) / SV, "visitor", "visitor", VOT_VISITOR, false, -1);
    }
  }
  opts?.progress?.(DEMAND_PHASE.notHome);
  // special events (below): the day's attendees, and the hotel guests among them, whose trips to the
  // venue take the place of some of their sightseeing (the visitor volume counts them already)
  const EVM = H.events;
  const evScale = day === "wkd" ? (context?.events ?? 1) : 0;
  const evMonth = context?.eventMonth ?? "year";
  let hotelEventTrips = 0;
  if (EVM && evScale > 0)
    for (const v of EVM.venues)
      for (const sl of v.slots)
        hotelEventTrips += 2 * sl[evMonth] * evScale * (EVM.origins[v.origins].hotel / 100);
  const hotelVisitorTrips =
    prep.hotelVisitors.reduce((a, x) => a + x, 0) * VISITOR_TRIPS * (context?.visitors ?? 1);
  const visitorScale =
    hotelVisitorTrips > 0 ? Math.max(0, 1 - hotelEventTrips / hotelVisitorTrips) : 1;
  // visitors staying in hotels
  for (let o = split.index; o < NZ; o += split.count)
    destChoice(
      o,
      prep.hotelVisitors[o] * VISITOR_TRIPS * (context?.visitors ?? 1) * visitorScale,
      "visitor",
      "visitor",
      VOT_VISITOR,
      false,
      -1,
    );
  // regional visitors: from places that send commuters, in proportion
  for (let e = split.index; e < NX; e += split.count)
    destChoice(
      NZ + e,
      H.ext[e].toSF * regionalRate * (context?.regionalVisitors ?? 1),
      "regional",
      "ext",
      VOT_TYPICAL,
      false,
      -1,
    );
  // college students living outside the city: from places that send commuters, in proportion, to the
  // campuses by their students from outside
  univOutside = true;
  for (let e = split.index; e < NX; e += split.count)
    if (toSFall > 0) destChoice(NZ + e, (collegeTrips.outside * H.ext[e].toSF) / toSFall, "univ", "ext", VOT_TYPICAL, false, -1);
  univOutside = false;
  // ---- special generator: crowds at the big venues on an average weekday of the year (header.events,
  // from reference/special-events.json: Giants, Warriors and Valkyries games, concerts, conventions).
  // Attendees come from homes in the city by superdistrict, from hotels, and from the region's three
  // parts by commuter ties (the Warriors' SEIR); some come straight from a workplace in the city and go
  // home afterwards. Each makes a trip to the venue and one back at the hours of the kind of event
  // (each leg at those periods' mix of service), choosing a mode with the constants of their own kind
  // (residents' non-work tours, regional visitors, hotel visitors) and the venue's transit constant,
  // fit to its survey. Every loop runs over this part's origins (or workplaces) only ----
  if (EVM && evScale > 0) {
    const savedLW = LW.event;
    const REGION: Record<string, "east" | "north" | "south"> = {
      Alameda: "east",
      "Contra Costa": "east",
      Marin: "north",
      Sonoma: "north",
      Napa: "north",
      Solano: "north",
      "San Mateo": "south",
      "Santa Clara": "south",
    };
    const regOf = H.ext.map((x, e) => (x.id === "SFO" ? undefined : REGION[countyName[e]]));
    const regTot = { east: 0, north: 0, south: 0 };
    H.ext.forEach((x, e) => regOf[e] && (regTot[regOf[e]!] += x.toSF));
    const sdPop = [0, 0, 0, 0];
    H.zones.forEach((z) => z.sd && (sdPop[z.sd - 1] += z.pop));
    const jobsT = H.zones.reduce((a, z) => a + z.jobs, 0);
    const hotelT = prep.hotelVisitors.reduce((a, x) => a + x, 0);
    const venueZone = (lat: number, lon: number) => {
      const [vx, vy] = toXY(lat, lon);
      let best = 0,
        bd = Infinity;
      H.zones.forEach((z, i) => {
        const q = (z.x - vx) ** 2 + (z.y - vy) ** 2;
        if (q < bd) ((bd = q), (best = i));
      });
      return best;
    };
    type DP = Partial<Record<DayPeriod, number>>;
    // round trips: half the trips go to the venue at the arrival times, half back at the departures
    const tod = (a: DP, b: DP) => {
      const share = {} as Record<DayPeriod, number>,
        fromHome = {} as Record<DayPeriod, number>;
      for (const p of DAY) {
        const x = a[p] ?? 0,
          y = b[p] ?? 0;
        share[p] = (x + y) / 2;
        fromHome[p] = x + y > 0 ? x / (x + y) : 1;
      }
      return { share, fromHome };
    };
    // one-way trips: all of them from o to d, in the given periods
    const oneWayTOD = (a: DP) => {
      const share = {} as Record<DayPeriod, number>,
        fromHome = {} as Record<DayPeriod, number>;
      for (const p of DAY) ((share[p] = a[p] ?? 0), (fromHome[p] = 1));
      return { share, fromHome };
    };
    // each zone's residents' shares by car segment (the synthetic population's, when demand uses it)
    const segPop = (s: number, o: number) => {
      const z = H.zones[o];
      return z.pop > 0 ? prep.people.pop[s].reduce((a, v) => a + v[o], 0) / z.pop : prep.seg[s][o];
    };
    for (const v of EVM.venues) {
      const d = venueZone(v.lat, v.lon);
      const O = EVM.origins[v.origins];
      const sfShare = O.sd.reduce((a, x) => a + x, 0) / 100;
      const regShare = (O.east + O.north + O.south) / 100;
      // each zone's share of the city's attendees: its superdistrict's share by population
      const sdW = H.zones.map((z) =>
        z.sd && sdPop[z.sd - 1] > 0
          ? (O.sd[z.sd - 1] / 100 / sfShare) * (z.pop / sdPop[z.sd - 1])
          : 0,
      );
      const regW = H.ext.map((x, e) => (regOf[e] ? (O[regOf[e]!] / 100 / regShare) * (x.toSF / regTot[regOf[e]!]) : 0));
      eventAsc = calib.eventTransit?.[v.name] ?? 0;
      eventVenue = v.name;
      for (const sl of v.slots) {
        const A = sl[evMonth] * evScale;
        if (A <= 0) continue;
        const T = EVENT_TIMES[sl.kind];
        const fw = EVM.fromWork[sl.kind];
        // round trips from home (and hotels)
        LW.event = legWeights(tod(T.in, T.out), false);
        for (let o = split.index; o < NZ; o += split.count) {
          if (sdW[o] > 0)
            for (let s = 0; s < 3; s++) {
              const t = 2 * A * sfShare * (1 - fw.sf) * sdW[o] * segPop(s, o);
              if (t <= 0 || choose(o, d, "event", SEGMENTS[s], prep.vot[o]) === -Infinity) continue;
              bookNow(o, d, t, "event", true, SEGMENTS[s], o);
            }
          const th = hotelT > 0 ? (2 * A * (O.hotel / 100) * prep.hotelVisitors[o]) / hotelT : 0;
          if (th > 0 && choose(o, d, "event", "visitor", VOT_VISITOR) > -Infinity)
            bookNow(o, d, th, "event", false, null, -1);
        }
        for (let e = split.index; e < NX; e += split.count) {
          const t = 2 * A * regShare * (1 - fw.region) * regW[e];
          eventSouth = regOf[e] === "south";
          if (t <= 0 || choose(NZ + e, d, "event", "ext", VOT_TYPICAL) === -Infinity) continue;
          bookNow(NZ + e, d, t, "event", false, null, -1);
        }
        eventSouth = false;
        // straight from a workplace in the city (by its jobs), and home from the venue afterwards
        const fromWork = A * (sfShare * fw.sf + regShare * fw.region);
        if (fromWork > 0) {
          eventOneWay = true;
          LW.event = legWeights(oneWayTOD(T.in), true);
          for (let j = split.index; j < NZ; j += split.count) {
            const z = H.zones[j];
            if (z.jobs <= 0) continue;
            const tr = (A * sfShare * fw.sf * z.jobs) / jobsT,
              tx = (A * regShare * fw.region * z.jobs) / jobsT;
            if (tr > 0 && choose(j, d, "event", "car1", VOT_TYPICAL) > -Infinity)
              bookNow(j, d, tr, "event", true, null, -1);
            if (tx > 0 && choose(j, d, "event", "ext", VOT_TYPICAL) > -Infinity)
              bookNow(j, d, tx, "event", false, null, -1);
          }
          LW.event = legWeights(oneWayTOD(T.out), true);
          eventPark = false;
          for (let o = split.index; o < NZ; o += split.count) {
            if (sdW[o] <= 0) continue;
            for (let s = 0; s < 3; s++) {
              const t = A * sfShare * fw.sf * sdW[o] * segPop(s, o);
              if (t <= 0 || choose(d, o, "event", SEGMENTS[s], prep.vot[o]) === -Infinity) continue;
              bookNow(d, o, t, "event", true, SEGMENTS[s], -1);
            }
          }
          for (let e = split.index; e < NX; e += split.count) {
            const t = A * regShare * fw.region * regW[e];
            eventSouth = regOf[e] === "south";
            if (t <= 0 || choose(d, NZ + e, "event", "ext", VOT_TYPICAL) === -Infinity) continue;
            bookNow(d, NZ + e, t, "event", false, null, -1);
          }
          eventSouth = false;
          eventOneWay = false;
          eventPark = true;
        }
      }
    }
    eventAsc = 0;
    eventVenue = "";
    LW.event = savedLW;
  }
  // residents' non-work trips to the rest of the region (by commuter ties and distance), and air
  // travelers: the outside end is an activity there
  extActivity = true;
  {
    const sfo = H.ext.findIndex((x) => x.id === "SFO");
    const w = H.ext.map((x, e) =>
      e === sfo
        ? 0
        : (x.toSF + x.fromSF) * Math.exp((-0.03 * Math.hypot(x.x, x.y)) / 1000),
    );
    const W = w.reduce((s, v) => s + v, 0);
    for (let o = split.index; o < NZ; o += split.count) {
      const z = H.zones[o];
      for (let hc = 0; hc < 3 * INCOME_CLASSES.length; hc++) {
        const s = Math.floor(hc / INCOME_CLASSES.length);
        incBand = hc % INCOME_CLASSES.length;
        if (hc === 0) gen++;
        cacheOn = true;
        const cells = abmCells.get(o);
        let nmTours = 0;
        if (cells) for (let pcl = 0; pcl < 3; pcl++) for (let q = 0; q < 3; q++) nmTours += cells[CELL.nm + ((s * INCOME_CLASSES.length + incBand) * 3 + pcl) * 3 + q] * rateOf(["shop", "other", "social"][q] as Purpose);
        const n =
          (cells
            ? 2 * nmTours * OUT_TRIPS_PER_TOUR
            : prep.people.pop[s][incBand][o] *
              (RATES.shop * rateOf("shop") +
                RATES.other * rateOf("other") +
                RATES.social * rateOf("social"))) *
          tourFactor *
          calib.outShare *
          popF;
        if (n <= 0) continue;
        for (let e = 0; e < NX; e++) {
          if (w[e] <= 0) continue;
          const d = NZ + e;
          const ls = choose(o, d, "social", SEGMENTS[s], prep.votInc[incBand][o]);
          if (ls === -Infinity) continue;
          bookNow(o, d, (n * w[e]) / W, "social", true, SEGMENTS[s], o);
        }
      }
    }
    incBand = -1;
    cacheOn = false;
    // air travellers between the city and SFO
    if (sfo >= 0) {
      const size = prep.size.airport;
      const S = size.reduce((s, v) => s + v, 0);
      for (let o = split.index; o < NZ; o += split.count) {
        const n = (calib.airportTrips * (context?.airPassengers ?? 1) * size[o]) / S;
        if (n <= 0) continue;
        const ls = choose(o, NZ + sfo, "airport", "visitor", VOT_VISITOR);
        if (ls === -Infinity) continue;
        bookNow(o, NZ + sfo, n, "airport", false, null, -1);
      }
    }
  }
  extActivity = false;
  opts?.progress?.(DEMAND_PHASE.stops);

  // ---- the stop pass: where tours stop, and the legs through each stop by the tour's mode ----
  {
    // what stops draw on: shopping, errands, and social places by size (shares of each purpose's
    // total), and how far out of the way they are (km, calibrated to NHTS detour lengths)
    // per km, by the tour's mode class (transit and walking tours stop much nearer; NHTS)
    const lamOf = (c: string) =>
      calib.stopDistCoefs?.[c] ?? calib.stopDistCoef ?? -0.45;
    // and on the log of the detour (nearTerm), which puts stops on the way, next door
    const lamLogOf = (c: string) => calib.stopLogCoefs?.[c] ?? 0;
    const sz = new Float64Array(NZ);
    for (const [k, w] of Object.entries(STOP_MIX) as [
      "shop" | "other" | "social",
      number,
    ][]) {
      const a = prep.size[k];
      let T = 0;
      for (let z = 0; z < NZ; z++) T += a[z];
      if (T > 0) for (let z = 0; z < NZ; z++) sz[z] += (w * a[z]) / T;
    }
    // stop zones reachable from an anchor zone by the tour's mode, as sparse distributions (top K)
    // how many stop zones each anchor keeps (the most likely first): enough to carry the tail of the
    // detours the NHTS reports. Transit and walking tours' stops are mostly next to home or the primary
    // destination (68% and 76% within half a mile) but a sixth of transit tours' are over 1.5 km away;
    // with 40, a strong pull to nearby places (the log term) left only the nearest zones in the list,
    // the linear term went to its bound, and the mean detour stayed 30% short (0.73 km against 1.04).
    type Cls = "car" | "transit" | "walk" | "bike";
    const KC: Record<Cls, number> = { car: STOP_K.car, transit: STOP_K.transit, walk: STOP_K.walk, bike: STOP_K.bike };
    // (one stride for all classes; a class's list ends at its first −1)
    const K = Math.max(...Object.values(KC));
    const CLS: Cls[] = ["car", "car", "car", "transit", "walk", "bike"];
    const skMD = sk.MD;
    const reach = (c: Cls, a: number, b: number) => {
      const q = a * NZ + b;
      if (c === "walk") return walkM[q] <= 3000;
      if (c === "bike") return bikeM[q] <= 10000 && bikeSec[q] < 65535;
      if (c === "transit")
        return walkM[q] <= 1500 || skMD.g[a * ZT + b] < Infinity;
      return autoDm[q] < 65535;
    };
    const dist: Record<Cls, { idx: Int32Array; p: Float32Array; K: number }> = {} as never;
    // the K most likely stops of an anchor, best first (ties in zone order)
    const topU = new Float64Array(K),
      topB = new Int32Array(K);
    for (const c of ["car", "transit", "walk", "bike"] as Cls[]) {
      const lam = lamOf(c),
        lamLog = lamLogOf(c),
        Kc = KC[c];
      const idx = new Int32Array(NZ * K).fill(-1),
        pr = new Float32Array(NZ * K);
      for (let a = 0; a < NZ; a++) {
        let n = 0;
        for (let b = 0; b < NZ; b++) {
          if (sz[b] <= 0 || !reach(c, a, b)) continue;
          const km = autoDm[a * NZ + b] / 100;
          const v = Math.log(sz[b]) + lam * km + lamLog * nearTerm(km);
          if (n === Kc && !(v > topU[Kc - 1])) continue;
          let i = n < Kc ? n++ : Kc - 1;
          for (; i > 0 && topU[i - 1] < v; i--) (topU[i] = topU[i - 1]), (topB[i] = topB[i - 1]);
          (topU[i] = v), (topB[i] = b);
        }
        const mx = n ? topU[0] : 0;
        let S = 0;
        for (let k = 0; k < n; k++) S += Math.exp(topU[k] - mx);
        for (let k = 0; k < n; k++)
          (idx[a * K + k] = topB[k]), (pr[a * K + k] = Math.exp(topU[k] - mx) / S);
      }
      dist[c] = { idx, p: pr, K: Kc };
    }
    // The legs through stops and of work subtours choose their modes as the tours' primary legs do,
    // conditional on the tour's mode, each on its own period's service: a transit tour's short leg is
    // walked (more at night, with longer waits), a walk tour's long one may be ridden, a late one
    // home by ride-hail. TM1's non-mandatory tour coefficients at their trip scale, for an adult at
    // the typical value of time.
    const mkStop = "resident stop legs";
    // car tours' stop legs that choose their modes, for their vehicles on the roads: the legs (vfCh)
    // and the vehicles their modes make (vfVeh), by leg
    const vfCh = stopAuto ? [new Float64Array(NZ2), new Float64Array(NZ2)] : null,
      vfVeh = stopAuto ? [new Float64Array(NZ2), new Float64Array(NZ2)] : null;
    const ccStop = ccMean(coeffsOf("shop").ivt, VOT_TYPICAL),
      thStop = THETA.shop;
    const MDq = TPERIODS.indexOf("MD");
    const oneHot = TPERIODS.map((_, q) => Float64Array.from(TPERIODS, (_, r) => (r === q ? 1 : 0)));
    const su = new Float64Array(6),
      sc = new Float64Array(6),
      ev = new Float64Array(6),
      sh = new Float64Array(6);
    /** the leg a→b's utilities in period q (into su, money in sc) */
    const legLos = (a: number, b: number, q: number) => leg(su, sc, a, b, oneHot[q], "shop", true, b);
    /** the shares of the trip modes (into sh) on the leg in su, sc of a tour by mode M */
    const sharesOf = (M: number) => {
      sh.fill(0);
      const ks = swOf[M];
      if (ks.length === 0) {
        sh[M] = 1;
        return;
      }
      let mx = (ev[M] = su[M] === -Infinity ? -Infinity : (su[M] + ccStop * sc[M]) / thStop);
      for (const k of ks) {
        const m = swTo[k];
        ev[m] = su[m] === -Infinity ? -Infinity : (su[m] + ccStop * sc[m]) / thStop + swKStop[k];
        if (ev[m] > mx) mx = ev[m];
      }
      // none of them reaches: the tour's own mode (a transit tour's leg with no service then is walked)
      if (mx === -Infinity) {
        sh[M === 3 ? 4 : M] = 1;
        return;
      }
      let S = (sh[M] = ev[M] === -Infinity ? 0 : Math.exp(ev[M] - mx));
      for (const k of ks) {
        const m = swTo[k];
        S += sh[m] = ev[m] === -Infinity ? 0 : Math.exp(ev[m] - mx);
      }
      for (let m = 0; m < 6; m++) sh[m] /= S;
    };
    /** n trips on the leg a→b in period q of a tour by mode M at the shares in sh, tallied by tour and trip mode in J */
    const bookShares = (M: number, a: number, b: number, n: number, q: number, J: Float64Array, mk: string, bandKey?: string) => {
      for (let m = 0; m < 6; m++) {
        const x = n * sh[m];
        if (!(x > 0)) continue;
        trips[m] += x;
        residentTrips[m] += x;
        J[M * 6 + m] += x;
        if (m <= 2) {
          const mi = autoMi(a, b);
          if (mi < Infinity) {
            vkt += x * mi * 1.609 * vehOf[m];
            // the roads (car tours' stop legs go there through stopAuto, below)
            if (autoOD && (mk !== mkStop || M > 1)) addAuto(m, a, b, x, TPERIODS[q]);
          }
        } else if (m === 3) {
          const tp = TPERIODS[q];
          transitOD[tp][a * ZT + b] += x;
          if (markets) mkt(mk, tp)![a * ZT + b] += x;
        }
        // (by distance: subtours by trip mode; transit tours' stop legs by trip mode, between home and
        // the stop or not; other tours' stop legs were tallied by the tour's mode as they were placed)
        if (mk !== mkStop) bandTally(mk, a, b, m, x);
        else if (bandKey) bandTally(bandKey, a, b, m, x);
      }
    };
    /** the same, working out the leg's level of service first */
    const bookLeg = (M: number, a: number, b: number, n: number, q: number, J: Float64Array, mk: string) => {
      if (!(n > 0)) return;
      if (swOf[M].length) legLos(a, b, q);
      sharesOf(M);
      bookShares(M, a, b, n, q, J, mk);
    };
    // when walk and ride-hail tours' stop legs travel (the tour mode's own timing is not kept for
    // them): the non-work tours' mix of periods, by direction, weighted by their tour rates
    const prof = [new Float64Array(TPERIODS.length), new Float64Array(TPERIODS.length)];
    {
      let W = 0;
      for (const p of ["shop", "other", "social"] as const) {
        W += TOUR_RATES[p];
        for (let q = 0; q < TPERIODS.length; q++) ((prof[0][q] += TOUR_RATES[p] * LW[p].out[q]), (prof[1][q] += TOUR_RATES[p] * LW[p].back[q]));
      }
      for (const P of prof) for (let q = 0; q < P.length; q++) P[q] /= W;
    }
    const h = STOP_NEAR_HOME;
    const rs = new Float64Array(NZ),
      cs = new Float64Array(NZ),
      nr = new Float64Array(NZ),
      nc = new Float64Array(NZ);
    // the zones with tours from home (a part holds only its own origins' rows)
    const rowsWith = (sums: Float64Array) => {
      const r: number[] = [];
      for (let z = 0; z < NZ; z++) if (sums[z] > 0) r.push(z);
      return r;
    };
    // the legs between stops and the tours' other ends, summed over anchors: for tours X (home ×
    // destination), Q[s, x] = Σ_z P(s|z)·X[z, x] are trips via a stop s near home z, on s→x, and
    // R[x, s] = Σ_z X[x, z]·P(s|z) those via a stop near the destination z, on x→s
    const Q = new Float64Array(NZ2),
      R = new Float64Array(NZ2);
    const viaStops = (X: Float32Array, D: { idx: Int32Array; p: Float32Array }, homes: number[]) => {
      (Q.fill(0), R.fill(0));
      for (const z of homes) {
        const row = z * NZ;
        for (let k = 0; k < K; k++) {
          const st = D.idx[z * K + k];
          if (st < 0) break;
          const pr = D.p[z * K + k],
            q = st * NZ;
          for (let x = 0; x < NZ; x++) Q[q + x] += pr * X[row + x];
        }
        for (let y = 0; y < NZ; y++) {
          const v = X[row + y];
          if (!(v > 0)) continue;
          for (let k = 0; k < K; k++) {
            const st = D.idx[y * K + k];
            if (st < 0) break;
            R[row + st] += v * D.p[y * K + k];
          }
        }
      }
    };
    /**
     * The legs of the halves of tours X (home × destination) with a stop, on the way out: home→stop
     * and stop→destination for a stop near home, home→stop and stop→destination via a stop near the
     * destination (two legs per half); `emit` gets each leg a→b, its trips, and whether it is the leg
     * into the primary destination (reversed, the legs back)
     */
    const legsOf = (X: Float32Array, D: { idx: Int32Array; p: Float32Array }, emit: (a: number, b: number, n: number, into: boolean) => void) => {
      (nr.fill(0), nc.fill(0));
      for (let o = 0; o < NZ; o++)
        for (let d = 0; d < NZ; d++) {
          const v = X[o * NZ + d];
          if (v > 0) ((nr[o] += v), (nc[d] += v));
        }
      // a stop near home z: legs z→s (here) and s→x (Q); near the destination z: legs x→s (R) and s→z (here)
      for (let z = 0; z < NZ; z++) {
        if (!(nr[z] > 0) && !(nc[z] > 0)) continue;
        for (let k = 0; k < K; k++) {
          const st = D.idx[z * K + k];
          if (st < 0) break;
          const pr = D.p[z * K + k];
          const r = h * pr * nr[z],
            c = (1 - h) * pr * nc[z];
          if (r > 0) emit(z, st, r, false);
          if (c > 0) emit(st, z, c, true);
        }
      }
      viaStops(X, D, rowsWith(nr));
      for (let a = 0; a < NZ; a++)
        for (let b = 0; b < NZ; b++) {
          const i = a * NZ + b;
          if (Q[i] > 0) emit(a, b, h * Q[i], true);
          if (R[i] > 0) emit(a, b, (1 - h) * R[i], false);
        }
    };
    const kmS: Record<string, number> = {},
      kmW: Record<string, number> = {};
    const subJ = new Float64Array(36);
    // The stop legs of each tour mode (a→b), before their modes are chosen. The leg into the primary
    // destination on the way out is by the tour's mode, as the primary leg out is (it is what makes
    // the tour's mode), and is booked as it is found; the others choose. Car and bike tours' legs
    // (gathered[M]) are the day's, both ways; transit tours' (gathered[3]) are made period by period;
    // walk and ride-hail tours' are kept as the legs out that choose (gathered[M]) and all the legs
    // (gatheredAll[M]), whose reverse are the legs back. In double precision: a cell sums many
    // homes' tours, and the parts of a split must add up exactly.
    const hasLegs = [false, false, false, false, false, false];
    const gathered = MODES.map(() => new Float64Array(NZ2));
    const gatheredAll: (Float64Array | null)[] = MODES.map((_, M) => (M === 2 || M === 4 ? new Float64Array(NZ2) : null));
    /** n trips on the leg a→b in period q by the tour's own mode M */
    const bookOwn = (M: number, a: number, b: number, n: number, q: number) => {
      if (!(n > 0)) return;
      sh.fill(0);
      sh[M] = 1;
      bookShares(M, a, b, n, q, stopLegs, mkStop, M === 3 ? "resident stop legs other transit" : undefined);
    };
    for (let M = 0; M < 6; M++) {
      const D = dist[CLS[M]];
      const Mm = stopMass[M];
      (rs.fill(0), cs.fill(0));
      let massT = 0;
      for (let o = 0; o < NZ; o++)
        for (let d = 0; d < NZ; d++) {
          const v = Mm[o * NZ + d];
          if (v > 0) ((rs[o] += v), (cs[d] += v), (massT += v));
        }
      if (massT > 0) {
        // stops visited, and how far out of the way (from home: rows; from the destination: columns)
        for (let z = 0; z < NZ; z++)
          for (let k = 0; k < K; k++) {
            const st = D.idx[z * K + k];
            if (st < 0) break;
            const pr = D.p[z * K + k];
            const w = h * rs[z] * pr + (1 - h) * cs[z] * pr;
            zoneVisits[st] += w;
            kmS[CLS[M]] = (kmS[CLS[M]] ?? 0) + w * (autoDm[z * NZ + st] / 100);
            kmW[CLS[M]] = (kmW[CLS[M]] ?? 0) + w;
            kmBand(`stop:${CLS[M]}`, z, st, w);
          }
        // the legs (out: o→s→d; back: d→s→o, the same legs reversed), gathered by the tour's mode
        // (transit tours' by period, below)
        const L = gathered[M],
          LA = gatheredAll[M];
        if (LA)
          // walk and ride-hail tours: half the legs are on the way out, at the non-work tours' periods
          legsOf(Mm, D, (a, b, n, into) => {
            if (markets) bandTally(`resident stop legs ${into ? "other" : "home"} ${CLS[M]}`, a, b, M, n);
            LA[a * NZ + b] += n;
            if (!into) L[a * NZ + b] += n;
            else for (let q = 0; q < TPERIODS.length; q++) bookOwn(M, a, b, 0.5 * n * prof[0][q], q);
          });
        else if (M !== 3)
          // car and bike tours: half the legs into the primary destination are on the way out
          legsOf(Mm, D, (a, b, n, into) => {
            if (markets) bandTally(`resident stop legs ${into ? "other" : "home"} ${CLS[M]}`, a, b, M, n);
            L[a * NZ + b] += into ? 0.5 * n : n;
            if (into) bookOwn(M, a, b, 0.5 * n, MDq);
          });
        hasLegs[M] = true;
      }
      // work subtours: workplace → somewhere → workplace, midday; a car left at work, or none, means
      // short ones are walked
      const S = subMass[M];
      for (let d = 0; d < NZ; d++) {
        if (S[d] <= 0) continue;
        for (let k = 0; k < K; k++) {
          const st = D.idx[d * K + k];
          if (st < 0) break;
          const n = S[d] * D.p[d * K + k];
          if (walkSec[d * NZ + st] <= 900) {
            trips[4] += 2 * n;
            residentTrips[4] += 2 * n;
            subJ[M * 6 + 4] += 2 * n;
          } else {
            bookLeg(M, d, st, n, MDq, subJ, "resident subtours");
            bookLeg(M, st, d, n, MDq, subJ, "resident subtours");
          }
          zoneVisits[st] += n;
        }
      }
    }
    for (let M = 0; M < 6; M++) for (let m = 0; m < 6; m++) byPurpose.nhb[m] += subJ[M * 6 + m];
    // the stop legs' modes, period by period: each leg's level of service once, for every tour mode
    // with legs there. Transit tours' legs keep their tour's period and direction; walk and
    // ride-hail tours' go half each way at the non-work tours' mix of periods (prof); car and bike
    // tours' are the day's, at midday.
    {
      const mk = mkStop;
      const LT = gathered[3],
        // transit tours' legs between home and a stop (the rest of LT is the others)
        LTh = new Float64Array(hasLegs[3] ? NZ2 : 0),
        LW = gathered[4],
        LR = gathered[2],
        LWA = gatheredAll[4]!,
        LRA = gatheredAll[2]!;
      for (let q = 0; q < TPERIODS.length; q++) {
        const tp = TPERIODS[q],
          md = q === MDq;
        if (hasLegs[3]) {
          (LT.fill(0), LTh.fill(0));
          const D = dist.transit;
          legsOf(stopT.out[tp], D, (a, b, n, into) => (into ? bookOwn(3, a, b, n, q) : ((LT[a * NZ + b] += n), (LTh[a * NZ + b] += n))));
          legsOf(stopT.in[tp], D, (a, b, n, into) => ((LT[b * NZ + a] += n), into ? 0 : (LTh[b * NZ + a] += n)));
        }
        const wo = 0.5 * prof[0][q],
          wb = 0.5 * prof[1][q];
        for (let a = 0; a < NZ; a++)
          for (let b = 0; b < NZ; b++) {
            const i = a * NZ + b,
              j = b * NZ + a;
            const nT = hasLegs[3] ? LT[i] : 0,
              nW = hasLegs[4] ? wo * LW[i] + wb * LWA[j] : 0,
              nR = hasLegs[2] ? wo * LR[i] + wb * LRA[j] : 0;
            let any = nT > 0 || nW > 0 || nR > 0;
            if (md) for (const M of [0, 1, 5]) if (hasLegs[M] && gathered[M]![i] > 0) any = true;
            if (!any) continue;
            legLos(a, b, q);
            if (nT > 0) {
              sharesOf(3);
              const nh = LTh[i];
              if (nh > 0) bookShares(3, a, b, nh, q, stopLegs, mk, "resident stop legs home transit");
              if (nT - nh > 0) bookShares(3, a, b, nT - nh, q, stopLegs, mk, "resident stop legs other transit");
            }
            if (nW > 0) (sharesOf(4), bookShares(4, a, b, nW, q, stopLegs, mk));
            if (nR > 0) (sharesOf(2), bookShares(2, a, b, nR, q, stopLegs, mk));
            if (md)
              for (const M of [0, 1, 5]) {
                const n = hasLegs[M] ? gathered[M]![i] : 0;
                if (!(n > 0)) continue;
                sharesOf(M);
                bookShares(M, a, b, n, q, stopLegs, mk);
                if (vfCh && M <= 1) ((vfCh[M][i] += n), (vfVeh![M][i] += n * (sh[0] * vehPer[0] + sh[1] * vehPer[1])));
              }
          }
      }
    }
    // car tours' legs through stops on the roads: o→s→d (and back d→s→o), by period, as their tour
    // mode's vehicles; the legs that choose their modes (all but the leg into the primary destination
    // on the way out) rescaled by the vehicles of the modes the leg's trips took (vfVeh over vfCh,
    // the same in every part of a split)
    if (stopAuto && autoOD) {
      const D = dist.car;
      for (const M of [0, 1]) {
        const ch = vfCh![M], veh = vfVeh![M];
        const vf = (i: number) => (ch[i] > 0 ? veh[i] / (ch[i] * vehPer[M]) : 1);
        for (const tp of TPERIODS)
          for (const back of [false, true]) {
            const X = (back ? stopAuto[M].in : stopAuto[M].out)[tp];
            (rs.fill(0), cs.fill(0));
            let tot = 0;
            for (let o = 0; o < NZ; o++)
              for (let d = 0; d < NZ; d++) {
                const v = X[o * NZ + d];
                if (v > 0) ((rs[o] += v), (cs[d] += v), (tot += v));
              }
            if (!(tot > 0)) continue;
            const AOD = autoOD[tp];
            // a leg a→b of the tour's way out (into: the leg into the primary destination); on the way
            // back it runs b→a
            const leg = (a: number, b: number, v: number, into: boolean) => {
              if (v > 0) AOD[back ? b * ZA + a : a * ZA + b] += v * (into && !back ? 1 : vf(a * NZ + b));
            };
            // the anchors' own legs: home → a stop near it, a stop near the destination → there
            for (let z = 0; z < NZ; z++)
              for (let k = 0; k < K; k++) {
                const st = D.idx[z * K + k];
                if (st < 0) break;
                const pr = D.p[z * K + k];
                if (rs[z] > 0) leg(z, st, h * rs[z] * pr, false);
                if (cs[z] > 0) leg(st, z, (1 - h) * cs[z] * pr, true);
              }
            // the other legs: stop → destination, and home → a stop near the destination
            viaStops(X, D, rowsWith(rs));
            for (let i = 0; i < NZ2; i++) {
              if (Q[i] > 0) leg(Math.floor(i / NZ), i % NZ, h * Q[i], true);
              if (R[i] > 0) leg(Math.floor(i / NZ), i % NZ, (1 - h) * R[i], false);
            }
          }
      }
    }
    for (const c of Object.keys(kmS)) {
      kmSum[`stop:${c}`] = kmS[c];
      kmN[`stop:${c}`] = kmW[c];
    }
  }

  return {
    transitOD,
    trips: modeRecord(trips),
    residentTrips: modeRecord(residentTrips),
    byPurpose: modeRecords(byPurpose),
    workBySeg: modeRecords(workBySeg),
    nonworkBySeg: modeRecords(nonworkBySeg),
    byIncome: byIncome.map(modeRecord),
    youthTrips: modeRecord(youthTrips),
    studentTrips: modeRecord(studentT),
    vkt,
    logsum,
    zoneTrips,
    zoneTransit,
    zoneLS,
    zoneLSw,
    zoneWork,
    zoneWorkTransit,
    zoneVisits,
    zoneVisitsLeisure,
    zoneArrivals,
    zoneParkVisits,
    trnMin,
    trnN,
    kmSum,
    kmN,
    kmBands,
    stopLegs,
    stopByPurpose,
    latX,
    latS,
    mixX,
    mixY,
    attract,
    schoolStats,
    schoolDir,
    ...(evOD ? { eventTransitOD: evOD } : {}),
    ...(nrOD ? { nonResTransitOD: nrOD } : {}),
    collegeModes,
    shuttleTrips,
    shuttleBySeg,
    workIn: modeRecords(workIn),
    workOut: modeRecords(workOut),
    workInZone,
    shuttleOut,
    nhbPool: modeRecord(nhbPool),
    lineVeh,
    lineTrips,
    eventModes: modeRecords(eventModes),
    carOwn: { hhBySeg, cars: carsModel, carsBase: carsModelBase },
    ...(abmT ? { abm: abmT } : {}),
    lengthBands,
    driveMin,
    ...(autoOD ? { autoOD, tncEnds: tncEnds! } : {}),
    ...(micro ? { micro: micro.result() } : {}),
  };
}

/** add b into a, field by field (numbers, typed arrays, and records or arrays of them) */
function addInto<T>(a: T | undefined, b: T): T {
  // (optional fields a part leaves unset, such as the diagnostics without markets)
  if (b === undefined || b === null) return (a ?? b) as T;
  if (typeof b === "number") return ((a as number | undefined ?? 0) + b) as T;
  if (ArrayBuffer.isView(b)) {
    const x = b as unknown as Float64Array;
    const t = (a ?? new (x.constructor as Float64ArrayConstructor)(x.length)) as unknown as Float64Array;
    for (let i = 0; i < x.length; i++) t[i] += x[i];
    return t as unknown as T;
  }
  const t = (a ?? (Array.isArray(b) ? [] : {})) as Record<string, unknown>;
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) t[k] = addInto(t[k], v);
  return t as T;
}

/**
 * Merge the parts of a split (in order; the first is added into) and finish what needs the whole
 * city: the purposes of the legs through stops, park visits, and the shares and means.
 */
export function finishDemand(b: Bundle, calib: Calibration, parts: DemandPart[]): DemandResult {
  const H = b.header;
  const NZ = H.zones.length;
  let P = parts[0];
  for (let i = 1; i < parts.length; i++) P = addInto(P, parts[i]);
  const { trips, byPurpose, zoneParkVisits, zoneTrips, zoneTransit, zoneLS, zoneLSw, kmSum, kmN, stopByPurpose } = P;
  // the legs through stops: those touching home keep the tour purposes (in proportion), the others
  // are trips not from home; by the tour's mode (the purposes' shares) and the trip's
  for (let M = 0; M < 6; M++) {
    let T = 0;
    for (const v of Object.values(stopByPurpose)) T += v[M];
    for (let m = 0; m < 6; m++) {
      const n = P.stopLegs[M * 6 + m];
      if (!(n > 0)) continue;
      for (const [pp, v] of Object.entries(stopByPurpose))
        if (T > 0) byPurpose[pp][MODES[m]] += (n / 2) * (v[M] / T);
      byPurpose.nhb[MODES[m]] += n / 2;
    }
  }
  // residents' tours by the mode of the leg out: their other trips' modes (the leg back, and their
  // stop legs at the modes the stop pass gave the stop legs of tours of each mode)
  const tripMix: Record<string, Record<Mode, number>> = {},
    tripMixTours: Record<string, number> = {},
    tripMixTour: Record<string, Record<Mode, number>> = {},
    tripMixTourN: Record<string, number> = {},
    stopLegModes: Record<string, Record<Mode, number>> = {},
    tripMixBack: Record<string, Record<Mode, number>> = {},
    tripMixStop: Record<string, Record<Mode, number>> = {};
  {
    const SD = MODES.map((_, M) => {
      let t = 0;
      for (let m = 0; m < 6; m++) t += P.stopLegs[M * 6 + m];
      return MODES.map((_, m) => (t > 0 ? P.stopLegs[M * 6 + m] / t : m === M ? 1 : 0));
    });
    for (let a = 0; a < 6; a++) {
      const other = new Float64Array(6);
      let tours = 0;
      for (let b = 0; b < 6; b++) ((other[b] += P.mixX[a * 6 + b]), (tours += P.mixX[a * 6 + b]));
      for (let M = 0; M < 6; M++) for (let b = 0; b < 6; b++) other[b] += P.mixY[a * 6 + M] * SD[M][b];
      const t = other.reduce((x, v) => x + v, 0);
      tripMixTours[MODES[a]] = tours;
      // by the tour's own mode a: the leg back, and the stop legs at the stop pass's modes
      const own = new Float64Array(6);
      let n = 0;
      for (let b = 0; b < 6; b++) ((own[b] = P.latX[a * 6 + b] + P.latS[a] * SD[a][b]), (n += P.latX[a * 6 + b]));
      const to = own.reduce((x, v) => x + v, 0);
      tripMixTourN[MODES[a]] = n;
      tripMixTour[MODES[a]] = Object.fromEntries(MODES.map((m, b) => [m, to > 0 ? own[b] / to : 0])) as Record<Mode, number>;
      tripMix[MODES[a]] = Object.fromEntries(MODES.map((m, b) => [m, t > 0 ? other[b] / t : 0])) as Record<Mode, number>;
      stopLegModes[MODES[a]] = Object.fromEntries(MODES.map((m, b) => [m, P.stopLegs[a * 6 + b]])) as Record<Mode, number>;
      tripMixBack[MODES[a]] = Object.fromEntries(MODES.map((m, b) => [m, n > 0 ? P.latX[a * 6 + b] / n : 0])) as Record<Mode, number>;
      tripMixStop[MODES[a]] = Object.fromEntries(MODES.map((m, b) => [m, SD[a][b]])) as Record<Mode, number>;
    }
  }
  // visits to each park: its share of the park pull in each zone it covers
  const parkPull = parkPullOf(calib);
  const parkVisits: Record<string, number> = {};
  H.zones.forEach((z, i) => {
    if (!zoneParkVisits[i]) return;
    let s = 0;
    const pulls = (z.parks ?? []).map(([name, here, total]) => {
      const v = parkPull(name, here, total);
      s += v;
      return [name, v] as const;
    });
    for (const [name, v] of pulls)
      parkVisits[name] = (parkVisits[name] ?? 0) + (zoneParkVisits[i] * v) / s;
  });
  const zoneTransitShare = new Float32Array(NZ),
    zoneLogsum = new Float32Array(NZ);
  for (let z = 0; z < NZ; z++) {
    zoneTransitShare[z] = zoneTrips[z] > 0 ? zoneTransit[z] / zoneTrips[z] : 0;
    zoneLogsum[z] = zoneLSw[z] > 0 ? zoneLS[z] / zoneLSw[z] : 0;
  }
  const meanKm: Record<string, number> = {};
  for (const k of Object.keys(kmSum)) meanKm[k] = kmSum[k] / kmN[k];
  const kmBands: Record<string, number[]> = {};
  for (const [k, t] of Object.entries(P.kmBands)) {
    let T = 0;
    for (let i = 0; i < t.length - 1; i++) T += t[i];
    kmBands[k] = Array.from(t, (v) => (T > 0 ? v / T : 0));
  }
  const transitOD = {} as Record<TPeriod, Float32Array>;
  for (const tp of TPERIODS) transitOD[tp] = Float32Array.from(P.transitOD[tp]);
  const evP = (P as { eventTransitOD?: Record<TPeriod, Float64Array> }).eventTransitOD;
  const nrP = (P as { nonResTransitOD?: Record<TPeriod, Float64Array> }).nonResTransitOD;
  return {
    transitOD,
    ...(evP ? { eventTransitOD: Object.fromEntries(TPERIODS.map((p) => [p, Float32Array.from(evP[p])])) as Record<TPeriod, Float32Array> } : {}),
    ...(nrP ? { nonResTransitOD: Object.fromEntries(TPERIODS.map((p) => [p, Float32Array.from(nrP[p])])) as Record<TPeriod, Float32Array> } : {}),
    trips,
    residentTrips: P.residentTrips,
    byPurpose,
    workBySeg: P.workBySeg,
    nonworkBySeg: P.nonworkBySeg,
    byIncome: P.byIncome,
    youthTrips: P.youthTrips,
    studentTrips: P.studentTrips,
    attract: P.attract,
    schoolStats: P.schoolStats,
    schoolDir: P.schoolDir,
    collegeModes: P.collegeModes,
    stopByPurpose,
    vkt: P.vkt,
    logsum: P.logsum,
    zoneTransitShare,
    zoneLogsum,
    avgTransitMin: P.trnN > 0 ? P.trnMin / P.trnN : 0,
    meanKm,
    kmBands,
    zoneWork: P.zoneWork,
    zoneWorkTransit: P.zoneWorkTransit,
    zoneVisits: P.zoneVisits,
    zoneVisitsLeisure: P.zoneVisitsLeisure,
    zoneArrivals: P.zoneArrivals,
    parkVisits,
    shuttleTrips: P.shuttleTrips,
    shuttleBySeg: P.shuttleBySeg,
    workIn: P.workIn,
    workInZone: P.workInZone,
    workOut: P.workOut,
    shuttleOut: P.shuttleOut,
    nhbPool: P.nhbPool,
    lineVeh: P.lineVeh,
    lineTrips: P.lineTrips,
    eventModes: P.eventModes,
    carOwn: P.carOwn,
    ...(P.abm ? { abm: P.abm } : {}),
    stopTransitByPurpose: Object.fromEntries(Object.entries(stopByPurpose).map(([k, v]) => [k, v[3]])),
    lengthBands: P.lengthBands,
    driveMin: { work: P.driveMin[1] > 0 ? P.driveMin[0] / P.driveMin[1] : 0, all: P.driveMin[3] > 0 ? P.driveMin[2] / P.driveMin[3] : 0 },
    ...(P.autoOD ? { autoOD: Object.fromEntries(TPERIODS.map((tp) => [tp, Float32Array.from(P.autoOD![tp])])) as Record<TPeriod, Float32Array>, tncEnds: P.tncEnds } : {}),
    ...(P.micro ? { micro: P.micro } : {}),
    tripMix,
    tripMixTours,
    tripMixTour,
    tripMixTourN,
    stopLegModes,
    tripMixBack,
    tripMixStop,
  };
}

/**
 * The residents' home-to-work flows' weights (bundle flowN, LODES 2023 primary jobs), with those to each
 * outside county scaled by calib.outCommuteFactor (by county name without "County"). LODES files a
 * job where the employer reports it, remote or not, and the model takes the city's work-at-home rate off
 * every flow alike; the factors put the flows to the outside counties at their shares of the city's
 * commuters in the model year (calibrate.ts, ACS 2024 records; reference/commute-by-year.json), and
 * F['*'] those to the other outside counties together. Each home zone's commuters stay as they were:
 * the flows within the city give up what those outside gain.
 */
export function outCommuteWeights(b: Bundle, calib: Pick<Calibration, "outCommuteFactor">): Float32Array {
  const fw = b.a.flowW as Int32Array, fn = b.a.flowN as Float32Array;
  const F = calib.outCommuteFactor;
  if (!F || !Object.keys(F).length) return fn;
  const NZ = b.header.zones.length;
  const f = b.header.ext.map((x) => F[x.county.replace(/ County$/, "")] ?? F["*"] ?? 1);
  return Float32Array.from(fn, (v, i) => (fw[i] >= NZ ? v * f[fw[i] - NZ] : v));
}

/**
 * The city's commuters (residents who commute, at work or not on a given day) by where they work: the
 * share working in each outside county, as the model's flows place them (outCommuteWeights, each home
 * zone's commuters as demand.ts counts them). The ACS's reading: a worker's usual workplace.
 */
export function outCommuteShares(b: Bundle, calib: Pick<Calibration, "outCommuteFactor">): Record<string, number> {
  const H = b.header, NZ = H.zones.length;
  const fh = b.a.flowH as Int32Array, fw = b.a.flowW as Int32Array, w = outCommuteWeights(b, calib);
  const tot = new Float64Array(NZ);
  for (let i = 0; i < fh.length; i++) tot[fh[i]] += w[i];
  const out: Record<string, number> = {};
  let all = 0;
  for (let i = 0; i < fh.length; i++) {
    const z = H.zones[fh[i]];
    const n = (z.workers * (1 - Math.min(0.95, z.wfh)) * w[i]) / tot[fh[i]];
    all += n;
    if (fw[i] >= NZ) {
      const c = H.ext[fw[i] - NZ].county.replace(/ County$/, "");
      out[c] = (out[c] ?? 0) + n;
    }
  }
  // the counties without a factor of their own, together ('*': calib.outCommuteFactor['*'] scales them)
  const F = calib.outCommuteFactor ?? {};
  let rest = 0;
  for (const [c, v] of Object.entries(out)) if (!(c in F)) rest += v;
  out["*"] = rest;
  for (const c of Object.keys(out)) out[c] /= all;
  return out;
}

/**
 * One step of fitting where school and college tours go and how school tours travel (calibrate.ts;
 * experiment.ts --refit), from a demand pass:
 *  - shadow prices (calib.shadow) that hold each school level's zones to their enrollment, and each
 *    campus to its share of the college trips of students living in the city (TM1's and CTRAMP's
 *    update: the price moves by ln(target / modeled));
 *  - the scale on TM1's school distance terms, to SFUSD's elementary pupils living under a mile from
 *    school (SCHOOL_K5.under1mi);
 *  - school tours' constants on transit, walking, and cycling against car passenger, to SFUSD's
 *    elementary modes (SCHOOL_K5.modes).
 * Returns a summary for logs.
 */
export function fitStudents(calib: Calibration, prep: Prep, d: DemandResult, damp = 1): string {
  const out: string[] = [];
  const sh = (calib.shadow ??= {});
  for (const [k, A] of Object.entries(d.attract)) {
    const size = prep.size[k];
    let ts = 0, ms = 0;
    for (let i = 0; i < size.length; i++) if (size[i] > 0) ((ts += size[i]), (ms += A[i]));
    if (!(ts > 0 && ms > 0)) continue;
    const s = (sh[k] ??= new Array(size.length).fill(0));
    let off = 0;
    for (let i = 0; i < size.length; i++) {
      if (!(size[i] > 0)) continue;
      const t = (size[i] * ms) / ts;
      off += Math.abs(A[i] - t);
      if (A[i] > 0) s[i] = +Math.max(-8, Math.min(8, s[i] + damp * Math.log(t / A[i]))).toFixed(4);
    }
    out.push(`${k} ${((100 * off) / 2 / ms).toFixed(1)}% misplaced`);
  }
  const E = d.schoolStats;
  if (E[9] > 0) {
    const logit = (p: number) => Math.log(p / (1 - p));
    const u1 = E[6] / E[9];
    const scale = calib.schoolDistScale ?? 1;
    calib.schoolDistScale = +Math.max(0.05, Math.min(20, scale * Math.exp(0.7 * damp * (logit(SCHOOL_K5.under1mi) - logit(Math.min(0.99, Math.max(0.01, u1))))))).toFixed(4);
    const tot = SCHOOL_K5.modes.sr + SCHOOL_K5.modes.transit + SCHOOL_K5.modes.walk + SCHOOL_K5.modes.bike;
    const T: Partial<Record<Mode, number>> = Object.fromEntries(Object.entries(SCHOOL_K5.modes).map(([m, v]) => [m, v / tot]));
    const v = (m: Mode) => Math.max(1e-4, E[MODES.indexOf(m)] / E[9]);
    const sa = (calib.schoolAsc ??= {});
    for (const m of ["transit", "walk", "bike"] as Mode[])
      sa[m] = +Math.max(-5, Math.min(5, (sa[m] ?? 0) + damp * (Math.log(T[m]! / v(m)) - Math.log(T.sr! / v("sr"))))).toFixed(4);
    // middle and high school: each level's transit constant to its share in SFMTA's Student Travel Tally
    const lt = (calib.schoolLevelTransit ??= SCHOOL_LEVELS.map(() => 0));
    calib.schoolLevelFit = SCHOOL_LEVELS.map((lv, l) => {
      const n = E[l * 10 + 9];
      if (lv.transit === null || !(n > 0)) return null;
      const s = Math.min(0.99, Math.max(0.005, E[l * 10 + 3] / n));
      lt[l] = +Math.max(-5, Math.min(5, (lt[l] ?? 0) + damp * (logit(lv.transit) - logit(s)))).toFixed(4);
      out.push(`${lv.name} transit ${(100 * s).toFixed(1)}/${(100 * lv.transit).toFixed(0)}% (constant ${lt[l]})`);
      return [+s.toFixed(4), lv.transit];
    });
    // school tours' trips home: the offset on the switch from car passenger to transit, so that
    // elementary pupils go home by transit SCHOOL_RETURN.ratio times as often as they come; a step on the
    // switch's own share, as most of the gap is in it (the same offset for every level)
    {
      const S = d.schoolDir;
      if (S) {
        const sum = (a: number) => S.slice(a, a + 6).reduce((x, v) => x + v, 0);
        const there = S[3] / Math.max(1e-9, sum(0)), backAll = sum(6), back = S[6 + 3] / Math.max(1e-9, backAll);
        const srB = S[12], srT = S[13];
        if (there > 0 && srB > 0) {
          const ss = (calib.schoolSwitch ??= {});
          const cur = Math.max(1e-5, srT / srB);
          const want = Math.min(0.9, Math.max(1e-4, (srT + SCHOOL_RETURN.ratio * there * backAll - S[6 + 3]) / srB));
          ss["sr>transit"] = +Math.max(-6, Math.min(10, (ss["sr>transit"] ?? 0) + damp * Math.log(want / cur))).toFixed(4);
          calib.schoolReturnFit = [+(back / there).toFixed(4), +SCHOOL_RETURN.ratio.toFixed(4)];
          out.push(`elementary transit home/to school ${(100 * back).toFixed(1)}/${(100 * there).toFixed(1)}% = ×${(back / there).toFixed(2)}/${SCHOOL_RETURN.ratio.toFixed(2)} (car passenger→transit offset ${ss["sr>transit"]})`);
        }
      }
    }
    calib.schoolFit = {
      modes: Object.fromEntries((["sr", "transit", "walk", "bike"] as Mode[]).map((m) => [m, [+v(m).toFixed(4), +T[m]!.toFixed(4)]])),
      under1mi: [+u1.toFixed(4), SCHOOL_K5.under1mi],
    };
    // college tours' drive-alone constant, to SF State's students (the Gator Pass zone)
    {
      const CM = d.collegeModes, pass = prep.collegePass ?? [];
      let all = 0, da = 0;
      if (CM) for (let z = 0; z < pass.length; z++)
        if (pass[z]) for (let m = 0; m < 6; m++) ((all += CM[z * 6 + m]), m === 0 && (da += CM[z * 6]));
      if (all > 0) {
        const s = Math.min(0.99, Math.max(0.01, da / all));
        calib.collegeDa = +Math.max(-5, Math.min(5, (calib.collegeDa ?? 0) + damp * (logit(COLLEGE.sfsuDriveAlone) - logit(s)))).toFixed(4);
        calib.collegeFit = [+s.toFixed(4), COLLEGE.sfsuDriveAlone];
        out.push(`SF State drive alone ${(100 * s).toFixed(1)}/${(100 * COLLEGE.sfsuDriveAlone).toFixed(1)}% (constant ${calib.collegeDa})`);
      }
    }
    out.push(`elementary under a mile ${(100 * u1).toFixed(1)}/${(100 * SCHOOL_K5.under1mi).toFixed(1)}% (scale ${calib.schoolDistScale}), modes ${(["sr", "transit", "walk", "bike"] as Mode[]).map((m) => `${m} ${(100 * v(m)).toFixed(1)}/${(100 * T[m]!).toFixed(1)}`).join(" ")}`);
  }
  return out.join("; ");
}

/**
 * One step of fitting each surveyed venue's transit constant (calib.eventTransit) to its transit
 * share (header.events: Oracle Park, the Giants' 2012 survey; Chase Center, the Warriors' SEIR/TMP),
 * from a demand pass's event trips. Returns "model/target" by venue, for logs.
 */
export function fitEventTransit(
  calib: Calibration,
  events: Bundle["header"]["events"],
  eventModes: Record<string, Record<Mode, number>>,
  damp = 0.8,
): string {
  if (!events) return "";
  const logit = (p: number) => Math.log(p / (1 - p));
  const out: string[] = [];
  calib.eventTransit ??= {};
  for (const v of events.venues) {
    const m = eventModes[v.name];
    if (v.transitShare == null || !m) continue;
    const tot = MODES.reduce((a, k) => a + m[k], 0);
    if (tot <= 0) continue;
    const sh = Math.min(0.95, Math.max(0.01, m.transit / tot));
    const c = calib.eventTransit[v.name] ?? 0;
    calib.eventTransit[v.name] = Math.max(-4, Math.min(4, c + damp * (logit(v.transitShare) - logit(sh))));
    out.push(`${v.name} ${(100 * sh).toFixed(1)}/${(100 * v.transitShare).toFixed(0)}% (const ${calib.eventTransit[v.name].toFixed(2)})`);
  }
  return out.join(", ");
}
