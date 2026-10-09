/**
 * Model parameters, each with where it comes from. Sources are recorded in
 * server/beta3/reference/params.json and PARAMS.md.
 *  - TM1: MTC Travel Model One (Bay Area), trip mode choice UEC (TripModeChoice.xls)
 *  - TM2: MTC Travel Model Two / tm2py 2023 transit assignment settings
 *  - NHTS17: 2017 National Household Travel Survey, San Francisco–Oakland metro, weekdays
 *  - ACS: American Community Survey 2020–24 (5-year) and 2024 (1-year)
 * "Assumed" values are judgment where no published figure exists; "calibrated" values are fit
 * to observed San Francisco data by server/beta3/pipeline/calibrate.ts.
 */

export const MODES = ["da", "sr", "tnc", "transit", "walk", "bike"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABEL: Record<Mode, string> = {
  da: "Drive alone",
  sr: "Carpool",
  tnc: "Ride-hail & taxi",
  transit: "Transit",
  walk: "Walk",
  bike: "Bike",
};

/** trip purposes (demand segments) */
export const PURPOSES = [
  "work",
  "school",
  "univ",
  "shop",
  "other",
  "social",
  "nhb",
  "visitor",
  "airport",
  "regional",
  "event",
] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_LABEL: Record<Purpose, string> = {
  work: "Commute",
  school: "School (K–12)",
  univ: "College",
  shop: "Shopping",
  other: "Errands & other",
  social: "Social, dining & recreation",
  nhb: "Neither end at home",
  visitor: "Visitors",
  airport: "Airport (SFO)",
  regional: "Regional visitors",
  event: "Games, concerts & conventions",
};
/** what each trip purpose covers, in plain words (travel-survey and model practice: a trip is
 * "home-based" when one end is the traveler's home; NHTS and BATS call the rest non-home-based) */
export const PURPOSE_HELP: Record<Purpose, string> = {
  work: "Trips between home and work, for residents and for commuters from outside the city.",
  school: "Trips between home and school, kindergarten through high school.",
  univ: "Trips between home and college or university.",
  shop: "Trips between home and a store.",
  other: "Trips between home and errands: appointments, banking, personal business, and the like.",
  social: "Trips between home and visits, restaurants, parks, and entertainment.",
  nhb: "Trips that neither start nor end at home: from one stop to the next on the way somewhere (a store on the way home from work), from work to lunch and back, and commuters' and visitors' trips around the city during the day. Travel surveys and agency models call these non-home-based trips.",
  visitor: "Trips by hotel guests, from their hotel.",
  airport: "Trips between the city and SFO by air travelers.",
  regional: "Trips into the city by people who live elsewhere in the region and come for something other than work.",
  event: "Trips to and from games, concerts, and conventions at Oracle Park, Chase Center, Moscone Center, and the Civic Auditorium, on an average weekday.",
};

/** household car ownership segments: none, one, two or more */
export const SEGMENTS = ["car0", "car1", "car2"] as const;

/** Coefficient sets, per minute of in-vehicle time (TM1). */
export interface Coeffs {
  ivt: number;
  /** walk time up to walkThresh minutes a leg and beyond */
  walkShort: number;
  walkLong: number;
  walkThresh: number;
  /** bike time up to 30 min (6 mi at 12 mph) and beyond */
  bikeShort: number;
  bikeLong: number;
  /** per transfer */
  xfer: number;
  /** destination and origin density index (TM1) */
  density: number;
  originDensity: number;
  /** auto terminal time (TM1 c_walkTimeShort, applied to the terminal minutes) */
  terminal: number;
}

/**
 * TM1 trip mode choice (TripModeChoice.xls): walk 2× IVT to 1 mile (20 minutes) and 10× beyond,
 * bike 4× and 20× beyond 6 miles, 15× IVT a transfer, destination density −0.2× and origin
 * density −0.6× IVT (capped at 15 minutes), terminal time at the walk weight (2×).
 */
const tm1 = (ivt: number): Coeffs => ({
  ivt,
  walkShort: 2 * ivt,
  walkLong: 10 * ivt,
  walkThresh: 20,
  bikeShort: 4 * ivt,
  bikeLong: 20 * ivt,
  xfer: 15 * ivt,
  density: -0.2 * ivt,
  originDensity: -0.6 * ivt,
  terminal: 2 * ivt,
});

/**
 * TM1 tour mode choice (ModeChoice.xls), which TM1 applies to each leg of the tour and sums: walk 2×
 * IVT to 1.5 miles (30 minutes) a leg and 10× beyond, bike as on trips, 30× IVT a transfer on each
 * leg, the destination's density index (−0.2× IVT, once a tour) and no origin density term, and
 * the destination's terminal time on each leg at the walk weight (the home end is not counted).
 */
const tm1Tour = (ivt: number): Coeffs => ({
  ivt,
  walkShort: 2 * ivt,
  walkLong: 10 * ivt,
  walkThresh: 30,
  bikeShort: 4 * ivt,
  bikeLong: 20 * ivt,
  xfer: 30 * ivt,
  density: -0.2 * ivt,
  originDensity: 0,
  terminal: 2 * ivt,
});

/**
 * TM1 trip mode choice (TripModeChoice.xls): Work -0.022, School/University -0.0271, all others
 * (escort, shopping, eating out, maintenance, social, discretionary, at-work) -0.0279. Used for the
 * choices that are not home-based tours: trips not from home, hotel visitors, air travelers, and
 * regional visitors.
 */
export const COEFFS: Record<Purpose, Coeffs> = {
  work: tm1(-0.022),
  school: tm1(-0.0271),
  univ: tm1(-0.0271),
  shop: tm1(-0.0279),
  other: tm1(-0.0279),
  social: tm1(-0.0279),
  nhb: tm1(-0.0279),
  visitor: tm1(-0.0279),
  airport: tm1(-0.0279),
  regional: tm1(-0.0279),
  event: tm1(-0.0279),
};

/**
 * Home-based tours choose their mode with TM1's tour mode choice (ModeChoice.xls), on the sum of the
 * outbound and return legs: in-vehicle time −0.0134 a minute for work, −0.0224 for school and
 * university, −0.0175 for the non-mandatory purposes (escort, shopping, eating out, maintenance,
 * social, discretionary). TM1's trip coefficients (COEFFS) are for the trips within a tour once its
 * mode is known; applied to the average of the two legs (as before 2026-10-05) they made a tour about
 * 20% (work, non-work) to 40% (school) less sensitive to time and cost than TM1's own tour model. SF-CHAMP's
 * tour models likewise use both half-tours' level of service (SFCTA 2002 model development report),
 * and TM2's work tour IVT is −0.016 a minute on the same round-trip form.
 */
export const TOUR_COEFFS: Partial<Record<Purpose, Coeffs>> = {
  work: tm1Tour(-0.0134),
  school: tm1Tour(-0.0224),
  univ: tm1Tour(-0.0224),
  shop: tm1Tour(-0.0175),
  other: tm1Tour(-0.0175),
  social: tm1Tour(-0.0175),
};
/** the coefficients a purpose's choice uses, and whether it is a tour choice (legs summed) */
export const coeffsOf = (p: Purpose): Coeffs => TOUR_COEFFS[p] ?? COEFFS[p];

/**
 * The cost of a change of lines in route choice, in perceived minutes: PATH.transferPenalty when set,
 * else the in-vehicle minutes a change costs in TM1's tour mode choice (30) times the calibrated
 * transfer factor (Calibration.xferFactor, fitted to the on-board surveys' share of boardings that
 * follow another vehicle). Most transit trips are legs of home-based tours; the other choices
 * (trips not from home, visitors) weigh a change at half that in mode choice and see the same routes.
 */
export function transferPenalty(calib: { xferFactor?: number } | null | undefined): number {
  if (PATH.transferPenalty !== null) return PATH.transferPenalty;
  const c = TOUR_COEFFS.work!;
  return (c.xfer / c.ivt) * (calib?.xferFactor ?? 1);
}

/**
 * TM1 school and university tours: a transit penalty for persons aged 10 or under (c_age010_trn,
 * 69.41 × the tour IVT coefficient = −1.555). School tours are made by 5- to 17-year-olds; 45.4% of
 * San Francisco's are 10 or under (ACS 2020–24 B01001: ages 5–9 and a fifth of 10–14).
 */
export const AGE010_TRANSIT = 69.41 * -0.0224;

/**
 * K-12 school tours by level, each with its own destination choice (TM1's school location model as
 * ported to ActivitySim, prototype_mtc): elementary (TK-5), middle (6-8), and high school (9-12).
 *  - share: San Francisco's resident pupils by level (ACS 2020-24 B14001: kindergarten, grades 1-4,
 *    a quarter of grades 5-8; three quarters of 5-8; grades 9-12), used where a zone has no figure.
 *  - dist: TM1's utility per mile over 0-1, 1-2, 2-5, 5-15, and 15+ miles (grade school, which in
 *    TM1 runs to age 14, for elementary and middle; high school for high), times one calibrated scale.
 *  - young: TM1's transit term for children 10 or under applies (elementary).
 * Each level's destinations are its schools sized by their enrollment in its grades, with shadow
 * prices that hold every zone to its enrollment (TM1's shadow pricing): SFUSD assigns pupils by
 * citywide choice and lottery, so where they go is set by where the seats are, not only by distance.
 *  - transit: the share of the level's trips to school by public transit, the target of the level's
 *    own transit constant (calib.schoolLevelTransit): SFMTA's Student Travel Tally, more than 10,000
 *    SFUSD students at 95 schools asked how they get to school (published May 27, 2025): 33% of 6th
 *    graders and 55% of 9th graders, taken for middle and high school (older students ride more, so
 *    for grades 7-8 and 10-12 these are if anything low). Elementary pupils are fitted on all their
 *    modes instead (SCHOOL_K5), with TM1's term for children 10 or under.
 * Sources: server/beta3/reference/student-travel.json.
 */
export const SCHOOL_LEVELS = [
  { name: "elementary", grades: "TK-5", share: 0.4532, young: true, dist: [-1.6419, -0.57, -0.57, -0.2031, -0.046], transit: null },
  { name: "middle", grades: "6-8", share: 0.2399, young: false, dist: [-1.6419, -0.57, -0.57, -0.2031, -0.046], transit: 0.33 },
  { name: "high", grades: "9-12", share: 0.3068, young: false, dist: [-0.9523, -0.57, -0.57, -0.193, -0.1882], transit: 0.55 },
] as const;
/** the share of school tours by children 10 or under (elementary school) */
export const SCHOOL_AGE010_SHARE = SCHOOL_LEVELS[0].share;
/**
 * What SFUSD's elementary pupils do (student-travel.json): 50.6% live less than a mile from their
 * school (SFUSD's 2017 travel analysis, in SFCTA's School Access Plan, 2023), the target of the
 * school distance scale; and how they get there, the average of its kindergarten (2019) and fifth-grade
 * surveys: by car 54.4%, by "any bus" 16.3%, on foot 26.7%, by bike 1.6%. Yellow buses carry about
 * 2,000 pupils (25 general-education buses), taken here as 8.5% of SFUSD's 23,476 TK-5 pupils and
 * counted with car passengers, as BATS counts school buses; Muni then carries 7.7%. The target of the
 * school tours' constants (shares of car passenger, transit, walk, and bike; the 1.2% other left out).
 */
export const SCHOOL_K5 = {
  under1mi: 0.506,
  bins: [0.506, 0.215, 0.278],
  modes: { sr: 0.5435 + 2000 / 23476, transit: 0.1625 - 2000 / 23476, walk: 0.2665, bike: 0.016 },
};

/**
 * School tours' trips home. A school tour's mode is that of its trip to school, which is what SFUSD's
 * surveys and the Student Travel Tally ask ("how do you get to school"), so the rule that the trip into
 * the primary destination is by the tour's mode holds for school tours too; the trip home chooses, with
 * school tours' own offset on the switch from car passenger to transit (calib.schoolSwitch). Its target:
 * how much more often elementary pupils go home by transit than they come, in SFCTA's 2016 Child
 * Transportation Survey (1,746 parents of K-5 pupils, Table 3): 14.0% by transit at drop-off, 26.7% at
 * pickup at the bell, and 18.2% at pickup from aftercare, with over half of parents' children in
 * aftercare (its summary of findings), taken as half. The other switches keep the NHTS's tours of all purposes.
 * Sources: server/beta3/reference/school-travel.json.
 */
export const SCHOOL_RETURN = {
  dropoff: 0.14,
  bell: 0.267,
  aftercare: 0.182,
  aftercareShare: 0.5,
  /** transit on the way home over transit on the way there */
  ratio: (0.5 * 0.267 + 0.5 * 0.182) / 0.14,
};

/** nest scale under the root (TM1 level-2 nests: auto, non-motorized, transit, ride-hail) */
export const NEST = 0.72;

/**
 * Trip mode choice conditional on tour mode (TM1's TripModeChoice.xls, the CT-RAMP structure): once
 * a tour's mode is chosen, its trips choose a mode among those the tour's mode allows, with a constant
 * on each mode other than the tour's own. The trip into the primary destination is by the tour's mode
 * (that is what the tour's mode is, as NHTS tours are read); the trip back and those through stops choose. The modes a tour may use besides its own, as
 * [tour mode, trip mode]:
 *  - drive alone and shared ride: each other (the car comes home either way), and walking or transit
 *    from a shared ride, which TM1 allows (someone else drove; NHTS 2017: 1.2% of the other trips of
 *    dense-tract residents' tours by shared ride are by transit, and pupils driven to school often ride
 *    Muni home, SCHOOL_RETURN). TM1 has no shared-ride trips on a drive-alone
 *    tour; in NHTS 2017, 18% of the other trips of dense-tract residents' tours that drive alone to
 *    their primary destination are shared rides, so the constant is fitted.
 *  - transit: walk, ride-hail, and shared ride (a ride home), as on TM1's walk-to-transit tours.
 *  - walk: transit, ride-hail, and shared ride. TM1 allows only ride-hail (at −7); in NHTS 2017, 16%
 *    of dense-tract residents' tours that walk to their primary destination ride transit on another
 *    trip (reference/nhts-tripmode.json), so the constants are fitted to it.
 *  - ride-hail: walk, transit, and shared ride (TM1's ride-hail tours).
 *  - bike: walk (TM1: −12.7 for work, about −10 for the other purposes; fitted).
 */
export const TRIP_SWITCH: readonly (readonly [Mode, Mode])[] = [
  ['da', 'sr'],
  ['sr', 'da'],
  ['sr', 'walk'],
  ['sr', 'transit'],
  ['transit', 'walk'],
  ['transit', 'tnc'],
  ['transit', 'sr'],
  ['walk', 'transit'],
  ['walk', 'tnc'],
  ['walk', 'sr'],
  ['tnc', 'walk'],
  ['tnc', 'transit'],
  ['tnc', 'sr'],
  ['bike', 'walk'],
];
/**
 * The trips' constants by 'tour mode>trip mode', in TM1's trip utility units, before calibration:
 * TM1's work trip model (TripModeChoice.xls, Work sheet) where it has one, taken relative to the
 * tour's own mode (on shared-ride tours, its two-person constants against drive alone; on ride-hail
 * tours, against TNC single), and a starting value where TM1 has none (−2, −3) or where its value
 * (bike tours' walking, −12.7) would leave the fit too far to travel (−5). Calibration
 * (calibrate.ts) refits them all to NHTS 2017; the ride-hail tour's rest on 17 sampled tours.
 */
/**
 * The tour modes whose trip back and legs through stops have constants of their own. In the NHTS
 * 2017 (residents of dense tracts of the SF–Oakland metro; nhts-tripmode.json), transit tours come
 * home by transit on 81% of their trips back (143 of 179 sampled) but ride on only 28% of their legs
 * through stops (141 sampled), which are walked 44% of the time. One constant per switch fitted to
 * the two pooled (59% by transit) had the model's transit tours coming home by transit on 65% of
 * their trips back and riding to 54% of their stops (83% and 30% in the NHTS over the modes a transit
 * tour's trips may use; reference/muniarea-results.json). Other tour modes
 * keep one set: the NHTS samples of their stop legs are small (car tours'), or their trips are
 * fitted on those under 3 miles (walk tours').
 */
export const TRIP_SWITCH_STOP: readonly Mode[] = ['transit'];
export const TRIP_SWITCH_ASC: Record<string, number> = {
  'da>sr': -2,
  'sr>da': -0.139,
  'sr>walk': -0.453,
  'sr>transit': -4,
  'transit>walk': 0.485,
  'transit>tnc': -2.699,
  'transit>sr': -3.722,
  'walk>transit': -3,
  'walk>tnc': -7,
  'walk>sr': -3,
  'tnc>walk': 0.258,
  'tnc>transit': -3.78,
  'tnc>sr': -3.79,
  'bike>walk': -5,
};
/**
 * The scale of the trip-level choice relative to the tour's. A leg's logsum enters the tour's
 * utility as θ · ln Σ exp(V/θ + K), with V the leg's utilities in the tour model's units and K the
 * trip constants. θ is TM1's tour in-vehicle coefficient over its trip one (work 0.0134 / 0.022 =
 * 0.61, the non-mandatory purposes 0.0175 / 0.0279 = 0.63, school and university 0.0224 / 0.0271 =
 * 0.83), so the trips weigh time and money as TM1's trip model does; it is held at most at the nests'
 * 0.72, so the trips nest within the tour modes that share a nest (drive alone and shared ride, walk
 * and bike).
 */
export const tripScale = (tourIvt: number, tripIvt: number) => Math.min(NEST, tourIvt / tripIvt);
/** TM1: c_originDensityIndexMax (in IVT-minute units of the work coefficient) */
export const ORIGIN_DENSITY_CAP = 15;

/**
 * Household income bands, as BATS 2023 reports San Francisco's mode shares: under $50,000,
 * $50,000–100,000, $100,000–200,000, and $200,000 or more (ACS B19001 by block group).
 * Value of time by band, 2025 $/hour: TM1's lognormal means for its four income classes (2000 $:
 * 6.01 / 8.81 / 10.44 / 12.86 for <$30k, $30–60k, $60–100k, $100k+, which are about <$59k,
 * $59–119k, $119–198k, $198k+ in 2025 dollars) × 1.98 (MTC CPI 2000→2025).
 */
export const INCOME_BANDS = ['under $50,000', '$50,000–100,000', '$100,000–200,000', '$200,000 or more'] as const;
export const VOT_BY_INCOME = [11.9, 17.4, 20.7, 25.5];
/**
 * The income classes that demand is split by: households under and over $100,000 (bands 0–1 and
 * 2–3). BATS 2023's transit shares step there (18.2% and 16.9% below, 11.1% and 10.9% above), so
 * two classes carry the gradient at half the cost of four. Each class's value of time is the
 * harmonic mean of its bands' in each zone.
 */
export const INCOME_CLASSES: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3],
];
export const INCOME_CLASS_NAMES = ['under $100,000', '$100,000 or more'] as const;
/** the middle of the city's incomes, for travelers whose income the model does not know: in-commuters, regional visitors, and in-commuters' trips not from home */
export const VOT_TYPICAL = 19.0;
/**
 * San Francisco households by vehicles (0, 1, 2+; rows) and income band (columns), ACS 2024
 * 1-year PUMS, SF PUMAs (server/beta3/reference/sf-hh-vehicles-income.json): the seed from which
 * each zone's households are split by car ownership and income, raked to its ACS margins.
 */
export const HH_VEH_INC_SEED = [
  [50067, 20678, 27480, 23084],
  [27065, 27792, 40371, 65701],
  [7567, 11142, 22991, 47991],
];
/**
 * Persons per household by vehicles (rows) and income band (columns), the same PUMS households
 * (sf-hh-vehicles-income.json perHousehold; research/pums_persons_by_vehicles.py): all persons,
 * employed persons, children 5–17, and persons 65 and over. Households without a car are small
 * (1.3–2.0 persons against 2.8–3.4 in households with two or more cars): 32.6% of the city's
 * households but 24.0% of its residents and 23.8% of its employed residents. Each zone's household
 * shares become shares of its people with these (demand.ts prepare); with households' shares, a third
 * too many people lived without a car.
 */
export const HH_PERSONS: Record<'persons' | 'employed' | 'age5to17' | 'age65plus', number[][]> = {
  persons: [[1.3325, 1.5395, 1.6992, 1.9997], [1.6037, 1.8416, 1.8737, 2.2265], [2.7506, 2.8743, 3.1401, 3.4392]],
  employed: [[0.348, 0.9404, 1.3326, 1.7013], [0.4472, 0.9499, 1.2152, 1.6499], [0.8692, 1.3678, 1.8067, 2.1084]],
  age5to17: [[0.0601, 0.1422, 0.05, 0.0255], [0.1286, 0.1676, 0.1361, 0.2052], [0.4541, 0.3436, 0.3856, 0.5735]],
  age65plus: [[0.6025, 0.2969, 0.217, 0.1313], [0.4821, 0.5082, 0.3426, 0.1639], [0.6762, 0.6642, 0.5786, 0.4138]],
};
/**
 * Household size by area: each SF PUMA's persons, employed persons, children 5–17, and persons 65+ per
 * household by vehicles (0, 1, 2+), relative to the city's, ACS 2020–24 5-year PUMS
 * (sf-hh-vehicles-income.json perHouseholdByPuma; research/pums_persons_by_puma.py). Households
 * without a car hold 1.5 times the city's average in the southeast (PUMA 07507: Bayview, Excelsior,
 * Visitacion Valley, Portola) and 0.9 times it downtown (07509: Tenderloin, Nob Hill, Chinatown, North
 * Beach), so the city's rates put too few of the southeast's people in them. Applied on top of
 * HH_PERSONS in each zone (demand.ts prepare), with SF_PUMA_TRACTS giving each 2020 tract's PUMA.
 */
export const HH_PERSONS_PUMA_FACTOR: Record<string, Record<'persons' | 'employed' | 'age5to17' | 'age65plus', number[]>> = {
  '07507': { persons: [1.515, 1.232, 1.222], employed: [0.862, 0.976, 1.104], age5to17: [4.195, 1.991, 1.352], age65plus: [1.774, 1.429, 1.192] },
  '07508': { persons: [1.071, 1.012, 0.917], employed: [0.973, 1.001, 0.959], age5to17: [1.459, 1.01, 0.998], age65plus: [1.336, 1.058, 0.863] },
  '07509': { persons: [0.9, 0.932, 0.779], employed: [0.942, 0.965, 0.942], age5to17: [0.515, 0.754, 0.491], age65plus: [1.011, 0.866, 0.768] },
  '07510': { persons: [0.942, 0.997, 0.937], employed: [1.05, 1.13, 0.993], age5to17: [0.567, 0.927, 0.974], age65plus: [0.645, 0.561, 0.585] },
  '07511': { persons: [0.989, 0.985, 0.921], employed: [1.145, 1.062, 0.946], age5to17: [0.547, 0.964, 0.882], age65plus: [0.775, 0.804, 0.795] },
  '07512': { persons: [1.227, 1.012, 0.998], employed: [0.856, 0.91, 0.957], age5to17: [2.959, 1.034, 0.946], age65plus: [1.557, 1.479, 1.284] },
  '07513': { persons: [1.336, 1.074, 1.092], employed: [1.047, 0.859, 1.062], age5to17: [2.53, 1.394, 1.146], age65plus: [1.499, 1.672, 1.205] },
  '07514': { persons: [0.923, 0.897, 0.841], employed: [1.002, 0.98, 0.951], age5to17: [0.668, 0.551, 0.708], age65plus: [0.882, 0.802, 0.645] },
};
export const SF_PUMA_TRACTS: Record<string, string> = {
  '07507': '023001 023003 023102 023103 023200 023300 023400 025600 025701 025702 025800 025900 026001 026002 026003 026004 026301 026302 026303 026401 026402 026403 026404 060502 061000 061200 980501 980600 980900',
  '07508': '013300 015401 015402 015600 015701 015702 016500 040100 040200 042601 042602 042700 042800 045100 045201 045202 047600 047701 047702 047801 047802 047902 047903 047904 060100 980200 980300 980401 990100',
  '07509': '010101 010102 010201 010202 010300 010401 010402 010500 010600 010701 010702 010800 010901 010902 011001 011002 011101 011102 011200 011300 011700 011800 011901 011902 012001 012002 012100 012202 012203 012204 012301 012302 012403 012404 012405 012406 012502 012503 012504 017903 061101 061102 990200',
  '07510': '017602 017603 017604 017700 017801 017803 017804 018000 022600 022702 022704 022801 022802 022803 022901 022902 022903 060701 060702 060703 061401 061402 061501 061502 061503 061504 061505 061506 061507 061508',
  '07511': '016601 016602 016900 017000 017101 017102 020101 020102 020201 020202 020300 020401 020402 020500 020601 020602 020701 020702 020801 020802 020900 021000 021100 021200 021300 021400 021500 021600 021700 021800 025100 025200 025300 025401 025402 025403',
  '07512': '030101 030102 030201 030202 030301 030302 030400 030500 032601 032602 032700 032801 032802 032901 032902 035101 035102 035201 035202 035300 035400',
  '07513': '025501 025502 026100 026201 026202 030600 030700 030800 030900 031000 031100 031201 031202 031301 031302 031401 031402 033001 033002 033100 033201 033203 033204 060400',
  '07514': '012601 012602 012700 012801 012802 012901 012902 013001 013002 013101 013102 013200 013401 013402 013500 015100 015201 015202 015300 015500 015801 015802 015900 016000 016101 016102 016200 016300 016400 016700 016801 016802',
};
export const VOT_VISITOR = 25.5;
/** TM1: c_cost = 0.6 · c_ivt / VOT (VOT in $/h, cost in cents) → per dollar: 60 · c_ivt / VOT */
export const costCoef = (ivt: number, votPerHour: number) =>
  (60 * ivt) / votPerHour;
/**
 * Values of time vary within an income class. TM1 draws each household's from a lognormal whose mean
 * is the class value: μ = ln(0.684 · mean), σ = 0.87, held within $1–50 an hour (2000 $; MTC
 * MtcHouseholdDataManager.setDistributedValuesOfTime), and gives persons under 18 two-thirds of it.
 * Cost enters utility through 1/VOT, whose average over that spread is about twice 1/mean, so one
 * value at the mean made the model about half as sensitive to fares, parking and running costs as
 * TM1's population. Here each class's choice is the mixture over two values of time, the
 * two-point Gauss–Hermite rule on the lognormal (median · e^±σ, weights ½): its mean of 1/VOT is
 * within 3% of the exact one (2.05 against 2.0 × 1/mean with TM1's bounds), at two nested-logit
 * evaluations a choice. (Three points, exact, cost one more evaluation; calibrated, both fit the route and station counts the same.)
 */
export const VOT_SIGMA = 0.87;
export const VOT_MEDIAN_OF_MEAN = 0.684;
export const VOT_MIX_Z = [-1, 1];
export const VOT_MIX_W = [0.5, 0.5];
/** TM1's $1–50 (2000 $) bounds in 2025 $ */
export const VOT_MIN = 1.98;
export const VOT_MAX = 99;
export const YOUTH_VOT_FACTOR = 0.667;

/** Driving costs (2025 $). TM1 2023 auto operating cost 15.44 2000-cents/mile ×1.98. */
export const AUTO_COST_PER_MILE = 0.306;
/**
 * Shared ride: TM1 divides parking and bridge tolls by 1.75 (two riders) and 2.5 (three or more),
 * but not the operating cost, which the household bears either way (ModeChoice.xls and
 * TripModeChoice.xls). One shared-ride alternative here: a typical San Francisco carpool is about 2.3
 * people, about 77% of carpools two riders and 23% three or more (at 3.3), and the divisor is the
 * harmonic mix 1 / (0.77/1.75 + 0.23/2.5).
 */
export const SR_COST_SHARE = 1 / (0.77 / 1.75 + 0.23 / 2.5);
export const SR_OCCUPANCY = 2.3;
/**
 * Parking by TM1 area type (2025 $/hour): long-term (commuters, 8-hour stay) and short-term,
 * from TM1 2023 San Francisco TAZ inputs (2000 cents/hour × 1.98).
 * Area types: 0 regional core, 1 CBD, 2 urban business, 3 urban.
 */
export const PARKING_LONG = [3.8, 1.3, 0.51, 0];
export const PARKING_SHORT = [12.2, 3.35, 1.5, 0];
/**
 * Commuters to San Francisco who park free (employer-provided): TM1's free parking eligibility model
 * is calibrated to 5.9% of the city's employees in zones that charge for parking
 * (FreeParkingEligibility.xls, "FreeParking calib targets calc"). Their work tours pay no parking.
 */
export const FREE_PARKING_SF = 0.059;
/**
 * TM1 2023 San Francisco terminal (walk to/from car) minutes by area type, at each trip end but home
 * (TM1 counts none at home), weighted as walking (Coeffs.terminal)
 */
export const TERMINAL_MIN = [5.14, 4.97, 3.42, 2.34];
/** typical stay in hours by purpose, for short-term parking (assumed) */
export const STAY_HOURS: Record<Purpose, number> = {
  work: 8,
  school: 0,
  univ: 4,
  shop: 1.5,
  other: 1.5,
  social: 2.5,
  nhb: 1.2,
  visitor: 3,
  airport: 0,
  regional: 4,
  event: 4,
};

/**
 * Ride-hail (2025 $): base, per mile, per minute and minimum for a single-rider trip in San
 * Francisco (assumed from current published fares; TM1's 2015-era values inflated and with
 * booking fees). Wait by density (TM1 TNC single means, minutes) for pop+jobs per sq mi bins.
 */
export const TNC = { base: 4.0, perMile: 1.5, perMin: 0.32, min: 9.0 };
export const TNC_WAIT_BINS = [500, 2000, 5000, 15000];
export const TNC_WAIT_MIN = [10.3, 8.5, 8.4, 6.3, 3.0];

/**
 * Transit path choice (strategy) weights, in in-vehicle-minute equivalents.
 * TM1 skims: wait ×2, walk ×2; TM2: boarding penalty ≈4 min; TM1 trip IVT factors by mode.
 */
export const PATH = {
  waitWeight: 2.0,
  walkWeight: 2.0,
  /**
   * Perceived minutes added at each change of lines, beyond its walking and waiting; null: the weight
   * mode choice gives a change on a home-based tour, TM1's 30 in-vehicle minutes times the calibrated
   * transfer factor (transferPenalty below), so that a rider weighs a change the same way in choosing a
   * route as in choosing transit. A number overrides it (experiments, uncertainty draws).
   * It was 9, from TM1's trip coefficient (15 minutes, which applies only to the choices that are not
   * tours) times a factor of 0.6 that the calibration had reached by fitting Muni's boardings with the
   * transfer weight: with it 20% of Muni boardings followed another vehicle after calibration (28% in
   * an earlier calibration), against 12% in SFMTA's 2017 on-board survey, and 11 to 22% on the
   * Metro lines against 6 to 15%. TM1's own
   * path builder charges 20 minutes for a second boarding (TransitSkims.job), and published "pure"
   * transfer penalties run 4–20 in-vehicle minutes (Garcia-Martinez et al. 2018, Transportation
   * Research A 110: 15.2–17.7 in Madrid; Currie 2005, Journal of Public Transportation 8(1): about 8
   * for rail, more for bus).
   */
  transferPenalty: null as number | null,
  /**
   * Perceived minutes added to a change between operators, beyond a change of lines. Tested at 10 and
   * not adopted (October 2026, server/beta3/research/transfer-fares.md): it cut the BART riders who
   * also ride Muni by only a quarter, while lowering the share of riders reaching BART's city stations
   * by Muni well below the 2024 Station Profile's, and the Muni route fit got worse.
   */
  operatorChange: 0,
  /**
   * Headways above this (minutes) are partly timed by riders starting a trip: the excess counts half
   * (net.ts effectiveFreq). UK TAG unit M3.2 (2024, §3.2.10) counts half the headway only for services
   * "less than 10-15 minute headway" and a flatter wait curve beyond, for the first boarding only
   * (§3.2.5); the Toronto GTAModel's Emme assignment flattens effective headways above 15 minutes
   * (TMG toolbox, V4 fare-based transit assignment). TM1 halves the weight of initial waits beyond
   * 10 minutes (a 20-minute headway) in mode choice, but Muni riders now see predicted arrivals at
   * shelters and on phones, so they can time their walk to a less frequent line. Transfers wait the
   * full headway.
   */
  timedHeadway: 15,
  /** value of time for fares in path choice, $/min (≈ $20/h) */
  votPerMin: 20 / 60,
  /**
   * Spread of a zone's riders over its access stops: a logit on the cost of each (per perceived
   * minute), standing in for where people actually live in the zone (assumed; set a priori, not
   * fitted to route counts). Without it every rider in a zone uses its single best stop.
   */
  accessTheta: 0.3,
  /**
   * Choose the access stop block by block: each census block of a zone has its own network walk to
   * each stop (skims.ts connectorPts), and its riders split over the stops by the logit above; the
   * zone's split is the people-weighted mix of its blocks' (StrategySolver.blockOrigin). A block
   * group is often wide enough to hold two parallel lines, and with the zone's mean walk the more
   * frequent one took nearly all of its riders.
   */
  blockAccess: true,
  /**
   * Choose where to get off as the access stop is chosen: riders on a line spread over the stops
   * where they could get off for their destination by the same logit (θ = accessTheta) on the rest
   * of the ride, getting off, and each destination block's own walk (StrategySolver.egressBranch).
   * Without it, every rider on a line got off at the one stop best for the zone's mean walk, so the
   * two legs of a round trip used stations differently (East Bay riders got off at Embarcadero, the
   * first downtown station, more than they got on there).
   * On (October 2026): accuracy over run time. It had been off while, alone, it worsened the fit to
   * BART's city stations (exits: r 0.90 → 0.84 before recalibration); the station entrances, the
   * BART–Metro change in the concourse, and the transfer logit below address that, and the model is
   * recalibrated with both on.
   */
  egressLogit: true,
  /**
   * Choose where to change lines the same way (needs egressLogit): riders on a line spread over the
   * stops where they could get off to change toward their destination, by the same logit on the rest
   * of the ride and the strategy onward from each (StrategySolver.transferBranch), instead of all
   * changing at the one stop best for the strategy.
   */
  transferLogit: true,
  /**
   * Searches per destination with the transfer logit: each after the first sees the strategies onward
   * from the previous one's labels (2: the onward strategies are those without the transfer logit;
   * more passes approach its fixed point)
   */
  transferPasses: 2,
  /**
   * How riders at a stop split over its attractive lines: 'frequency' (optimal strategies: whichever
   * comes first, so by frequency) or 'information' (riders who know when each line will come take
   * the one that gets them there best: Gentile, Nguyen & Pallottino 2005; StrategySolver.combineInformed).
   * Muni shows predicted arrivals at its shelters and in apps, and TM2's Emme assignment likewise
   * splits flow between lines by their total impedance, not by frequency alone.
   */
  lineSplit: 'information' as 'frequency' | 'information',
  /**
   * Share of riders at a stop who choose their line as informed riders do (lineSplit 'information');
   * the rest take the first attractive line to come, as in optimal strategies. Muni's arrival
   * predictions are often off: on a weekday in June 2026 the prediction in force 10 minutes ahead
   * missed by 1.9 minutes (standard deviation; 1.3 robust) and one 20 minutes ahead by 2.9 (Cal-ITP's
   * TripUpdates metrics). Simulated at two-line stops, riders acting on predictions that far off keep
   * 77% of what exact knowledge would gain over taking the first bus; 87% of riders check the
   * predictions before walking to the stop at least sometimes (SFMTA's 2018 survey of 5,810 riders).
   * 0.77 × 0.87 = 0.67. reference/muni-operations.json, predictions.
   */
  informedShare: 0.67,
  /**
   * Operations as run (reference/muni-operations.json): running times scaled to those observed by
   * route and period, rail's mean lateness added, and frequencies net of trips not run. False: the
   * timetable.
   */
  observedOps: true,
  /**
   * Value of a minute of standard deviation of a ride's running time, in in-vehicle minutes (the
   * reliability ratio): 1.2 for bus and train (RAND Europe's 2004 expert workshop for the Dutch
   * ministry, reported in SHRP 2 L17's guidebook; Sweden's ASEK uses 1.1 for urban transit). Applied
   * to every mode's ride SD (BLine.rideSD); 0 turns the term off.
   */
  reliabilityRatio: 1.2,
  /**
   * Whether the reliability term also enters mode choice (the transit skim g); it always enters
   * route choice. TM1's mode-choice coefficients were estimated without a reliability term for any
   * mode, so its in-vehicle time already carries transit's typical unreliability, and driving has
   * none of its own here: adding transit's alone would count it twice against driving. In the
   * experiment (October 2026) it also cut Muni's boardings 9% before recalibration and worsened
   * the route fit more than route choice alone did.
   */
  reliabilityInModeChoice: false,
  /**
   * Rail preference in route choice only: perceived minutes added to each bus ride (bus, rapid,
   * trolley, express, any operator) against rail (light rail, streetcar, cable car, BART, Caltrain,
   * ferry) when riders choose among lines and stops; mode choice is untouched (the skims' components
   * leave it out). 0: none. Experiment knob (October 2026, server/beta3/research/route-choice.md).
   */
  railBonus: 0,
};
/**
 * Park-and-ride capacity (TM2's ParkingCapacityRestraint: lots fill, and drivers who find one full
 * go elsewhere). Here a lot that fills gets a shadow price, perceived minutes on driving there,
 * raised each pass while the cars parked by the model's riders exceed what the lot holds for them and
 * eased while they don't (as workplace shadow prices are in activity-based models):
 *  - cars: the model's drive-to-the-lot riders arriving before 3 pm (when BART's fees stop), less those
 *    dropped off (the model's car access includes them: 64% of car access at BART's stations with lots
 *    parks, 2024 Station Profile Study, home origins: drive/carpool 36.1%, drop-off 16.8%, ride-hail
 *    3.5%), at TM2's 1.05 riders a car;
 *  - room for them: the lot's spaces × TM2's park-and-hide factor 1.15 (drivers who park on nearby
 *    streets) × the share of the lot's users the model carries. The model carries only trips with an
 *    end in the city: on BART that is 51% of weekday entries at stations outside it (BART's August 2026
 *    station-to-station counts, one systemwide share, so the station split stays a test); at ferry
 *    terminals, all of them. Caltrain's and SMART's lots are not constrained (no occupancy counts, and
 *    the model's San Francisco riders are a share there that is not known).
 */
export const PARK_AND_RIDE = {
  occupancy: 1.05,
  parkShare: 0.64,
  parkAndHide: 1.15,
  sfShare: { bart: 0.51, ferry: 1, ggt: 1 } as Record<string, number>,
  /** perceived minutes added per pass for each unit of ln(cars / room) (riders' access choice is a steep
   * logit, so small steps keep the prices from overshooting), and the most a lot can cost */
  step: 3,
  maxPrice: 60,
};

/**
 * Share of the headway riders wait, by mode (TM2 / tm2py 2023 transit settings): riders of
 * commuter rail and ferries arrive for a scheduled departure (0.1 of the headway), others turn up
 * at random (0.5).
 */
export const HEADWAY_FRACTION: Record<string, number> = {
  caltrain: 0.1,
  ferry: 0.1,
};

/** in-vehicle time perception by mode (TM1: LRT 0.9, ferry 0.8, BART 0.8, Caltrain 0.7, express 1.0) */
export const IVT_FACTOR: Record<string, number> = {
  bus: 1,
  rapid: 1,
  trolley: 1,
  express: 1,
  streetcar: 0.9,
  lightrail: 0.9,
  cablecar: 0.9,
  bart: 0.8,
  caltrain: 0.7,
  ferry: 0.8,
};

/**
 * Fares (2026, $) as additive pieces so the path search can carry them.
 * Muni: the adult Clipper fare, $2.85 per trip, paid once (transfers are free within 120 minutes),
 * times the share of paying adult riders who pay per ride (MUNI_PASS_SHARE): a monthly or day pass
 * holder pays nothing more for a ride. Riders on the free programs are the person types below. (A
 * blended fare of everything collected, about $0.60 a boarding, made riders far less fare-sensitive
 * than observed, TCRP 95: about −0.24 to −0.4.) Riders under 19 ride Muni free (Free Muni for All
 * Youth), and BART and Caltrain charge youth half: a school trip within the city pays
 * nothing, one leaving it half the fare (SCHOOL_FARE_IN_CITY, SCHOOL_FARE_OUTSIDE). Cable car $9 cash, many riders on passes: $6 (assumed).
 * BART, Caltrain, Golden Gate, AC Transit, SamTrans and ferries: fitted to or set from their fare
 * tables, stored in the bundle.
 */
/** the model's name and release (the HTML pages read these through vite.config.ts, the validation report through report.ts) */
export const MODEL_NAME = 'SF-TRACE';
export const MODEL_LONG_NAME = 'San Francisco Transit Ridership And Choice Estimator';
export const MODEL_TAGLINE = 'An open model of transit ridership and travel choices in San Francisco';
export const MODEL_VERSION = '1.0';
/** the year of the release, for citations; the URL is filled in when the model has its own address */
export const MODEL_YEAR = 2026;
export const MODEL_AUTHOR = 'Koray Akduman';
export const MODEL_AUTHOR_URL = 'https://korayakduman.com';
/** the author footnote on the byline (About and the article) */
export const MODEL_AUTHOR_NOTE = 'With substantial help from AI systems. Not peer reviewed.';
export const MODEL_URL = 'https://kakduman.github.io/sf-trace/';
/** the suggested citation, plain text (the URL is a placeholder until MODEL_URL is set) */
export const MODEL_CITATION = `${MODEL_AUTHOR}. ${MODEL_NAME} ${MODEL_VERSION}: ${MODEL_LONG_NAME}. ${MODEL_TAGLINE}. Version ${MODEL_VERSION}, ${MODEL_YEAR}. ${MODEL_URL || '[URL to be added]'}`;
export const MUNI_FARE = 2.85;
/**
 * Share of Muni's paying adult riders on monthly or day passes, who pay nothing more per ride: 18.5%
 * monthly and 1.5% day or visitor passes against 54.8% paying per ride (SFMTA 2025 onboard survey,
 * Spring 2024 to Winter 2025, in the April 21, 2026 budget staff report's fare-equity table;
 * server/beta3/reference/muni-fare-media.json). The rest of the survey's riders (24.6%) are mostly on
 * the free programs. Fare evasion (about 20%, SFMTA) is not counted.
 */
export const MUNI_PASS_SHARE = 20 / 74.8;
/**
 * Clipper's discount between operators. From December 10, 2025 (MTC's No-Cost and Reduced Cost
 * Interagency Transfer Pilot, MOU art. II; BART news, 2025-10-21): up to $2.85 off each further
 * agency's fare within two hours, never below zero, for riders on the next-generation system (a card
 * moved to it, or a bank card). Discount fare categories get a discount in proportion to their fare.
 */
export const CLIPPER_TRANSFER_DISCOUNT = 2.85;
/**
 * Share of riders who get the new discount: only cards moved to the next-generation system (and bank
 * cards) do, and the move of the rest was held up (bulk migration on hold; MTC, Clipper Executive
 * Board, April 27, 2026). Share of all Clipper trips on the new system: about 31% in February 2026
 * (MTC Commission, March 25, 2026), 38% on April 20, 45% in the week ending May 23, and 53% in the
 * week ending July 18 (MTC news, May 26 and July 24, 2026). The base model's month is July 2026: 0.53
 * (sources in data/beta3/raw/xferfare; server/beta3/research/transfer-fares.md).
 */
export const CLIPPER_NEXTGEN_SHARE = 0.53;
/**
 * The discount before the new system, which cards not yet moved keep: $0.50 off Muni's adult fare
 * for full-fare riders transferring to Muni from any connecting agency on Clipper, and a free
 * round-trip transfer from Daly City BART to the Muni lines serving that station (SFMTA fare table,
 * FY2024 to July 2025, "Inter-agency discounts" 1 and 2). No operator discounted a transfer from Muni.
 */
export const LEGACY_MUNI_TRANSFER_DISCOUNT = 0.5;
export const SCHOOL_FARE_IN_CITY = 0;
export const SCHOOL_FARE_OUTSIDE = 0.5;

/**
 * Person types for home-based trips. Youth (5–17) ride Muni free and pay half elsewhere, and can't
 * drive alone or hail a ride on their own (16- and 17-year-olds who drive are few in the city).
 * Seniors (65+) pay Muni's senior fare, $1.40 against $2.85, and half on BART and Caltrain; those
 * enrolled in Free Muni for Seniors (about 38,600: 45,379 participants in FY2024–25, 85% of them
 * seniors, SFMTA) ride free, so the senior fare in the city is scaled by the share not enrolled.
 * Trip rates relative to the average person, weekdays, NHTS 2017 for the SF–Oakland metro
 * (server/beta3/reference/nhts-persontypes.json, school trips excluded).
 */
export type PersonType = "adult" | "youth" | "senior";
export const PERSON_FARE: Record<
  PersonType,
  { inCity: number; outside: number }
> = {
  adult: { inCity: 1, outside: 1 },
  youth: { inCity: SCHOOL_FARE_IN_CITY, outside: SCHOOL_FARE_OUTSIDE },
  senior: { inCity: 1.4 / 2.85, outside: 0.5 },
};
export const FREE_MUNI_SENIORS = 38_600;
export const PERSON_RATE: Record<
  "shop" | "other" | "social",
  Record<PersonType, number>
> = {
  shop: { youth: 0.593, adult: 0.975, senior: 1.615 },
  other: { youth: 0.608, adult: 1.071, senior: 1.08 },
  social: { youth: 1.06, adult: 0.905, senior: 1.44 },
};
export const CABLE_CAR_FARE = 6.0;

/** TM2 crowding: seated 1.0→1.4 (power 2.2), standing 1.4→1.6 (power 3.4) of V/C */
/**
 * Riders meet more than a period's average load: within a period, more of them travel in its busiest
 * hours. The load a rider meets, averaged over riders, relative to the period average: the sum over
 * hours of (rider share)² / (service share). Riders by hour: BART's October 2025 weekday entries and
 * exits at the eight city stations (the one large post-pandemic hourly count in the city; the morning
 * now peaks at 8–9am, 37% of the period); service by hour: Muni's weekday timetable
 * (server/beta3/reference/peak-hour.json, peak_hour.py). The night (7pm–6am) is the most uneven: its
 * trips run all night but 32% of its riders travel 7–8pm. NHTS 2017's ~200 transit trips a period,
 * used before, gave AM 1.18 (a 7am peak), MD 1.06, PM 1.01 and NT 1.24 (the night was left at 1).
 * Applied to loads when computing crowding.
 */
export const LOAD_SPREAD: Record<"AM" | "MD" | "PM" | "NT", number> = {
  AM: 1.091,
  MD: 1.014,
  PM: 1.065,
  NT: 1.212,
};

export const CROWDING = {
  minSeat: 1.0,
  maxSeat: 1.4,
  powSeat: 2.2,
  minStand: 1.4,
  maxStand: 1.6,
  powStand: 3.4,
};

/**
 * The same hours as LOAD_SPREAD, one by one: [share of the period's riders, share of its scheduled
 * trips] in each hour (peak-hour.json; LOAD_SPREAD is Σ rider² / service over these). Capacity at
 * boarding is checked hour by hour, so the busiest hour (8–9am carries 37% of the morning's riders
 * on 26% of its trips) is the one that binds.
 *   AM 6–9am, MD 10am–2pm, PM 3–6pm, NT 7pm–5am (by the hour each starts)
 */
export const LOAD_HOURS: Record<"AM" | "MD" | "PM" | "NT", [number, number][]> = {
  AM: [[0.1118, 0.2099], [0.2449, 0.2671], [0.3683, 0.2629], [0.275, 0.26]],
  MD: [[0.2285, 0.1955], [0.1786, 0.1998], [0.1765, 0.1998], [0.1881, 0.2005], [0.2283, 0.2044]],
  PM: [[0.1627, 0.2563], [0.2483, 0.2568], [0.338, 0.2523], [0.2511, 0.2345]],
  NT: [[0.3173, 0.1921], [0.1798, 0.1748], [0.1458, 0.1509], [0.1266, 0.1071], [0.1037, 0.0802], [0.0408, 0.052], [0.0052, 0.0239], [0.0001, 0.0234], [0.0001, 0.0234], [0.0023, 0.0356], [0.0783, 0.1366]],
};

/**
 * Strict capacity at boarding (model.ts boardingAvailability). A rider who finds the vehicle full is
 * left behind and waits for a later one. Following Cepeda, Cominetti & Florian (2006), the frequency-
 * based assignment with strict capacities behind Emme's capacitated transit assignment, the chance of
 * failing to board a vehicle of line a at a stop is (v_a / (κ_a − v̄_a + v_a))^β: v_a riders wanting
 * to board there, κ_a the line's capacity per hour, v̄_a its load leaving the stop, so the denominator
 * is the room left by the riders already on board. It is negligible while boarders are a small part of
 * the room and reaches one as they fill it.
 *  - beta: the exponent (β). Larger is closer to a sharp limit at capacity.
 *  - minAvail: the least chance of boarding any one vehicle (riders left behind at a full stop board
 *    within about 1/minAvail vehicles: queues clear between bunches, and riders give up, which the
 *    rerouting itself represents).
 */
export const CAPACITY = {
  on: true,
  beta: 4,
  minAvail: 0.1,
};

/**
 * Trip rates per person per weekday (NHTS17, SF–Oakland metro), and adjustments.
 * Commute trips come from employed residents instead (see demand.ts).
 */
export const RATES = { shop: 0.474, other: 0.593, social: 0.351, nhb: 1.122 };
/** K-12 school tours: 0.103 a weekday per person (NHTS 2017 tours, SF–Oakland metro) over the 15.7%
 * of persons who are 5–17, two trips each (nhts-tours.json, nhts-persontypes.json) */
export const SCHOOL_TRIPS_PER_CHILD = (2 * 0.103) / 0.157;
/**
 * College tours are set by the campuses, not by the students' homes: of the 56,058 students enrolled
 * at the city's colleges in fall 2023 who took at least one class on campus (IPEDS, less those
 * exclusively in distance education), a share comes on an average weekday of the year: 3 days a week
 * (SF State 2023: most students come 2-4 days) for 30 weeks (its academic year), assumed for all.
 * Students living in the city make the share of a campus's tours given by residentShare (City College
 * credit students, 72% San Francisco residents in 2021-22; SF State's 41% in 2018 is set on its own
 * zone, college-enrollment.json); the rest come from outside the city, from each outside zone in
 * proportion to its commuters into the city. Residents' tours start from where college students
 * live (ACS B14001), with shadow prices holding each campus to its residents' share.
 * Sources: server/beta3/reference/student-travel.json.
 */
/**
 * School days against the average weekday of the year, for comparisons with surveys taken while
 * schools are in session (MTC's Snapshot survey: fall 2023 and spring 2024). K-12: California's 180
 * school days (Education Code 41420) among about 251 weekdays that are not public holidays, so the
 * NHTS rate of 0.66 tours a pupil becomes 0.91 on a school day, about SFUSD's attendance. College:
 * the 30 weeks of classes assumed in COLLEGE.attendance.
 */
export const SCHOOL_DAY = { k12: 251 / 180, college: 52 / 30 };
export const COLLEGE = {
  inPerson: 56058,
  attendance: (3 / 5) * (30 / 52),
  residentShare: 0.72,
  /**
   * SF State's students drive alone to campus at 41% (its 2023 survey, Table 2-4; the "student
   * drive-alone rate" of its 2025 TDM Plan Update): the target of a drive-alone constant on all college
   * tours (calib.collegeDa). The survey lets students name several modes, so no other share is clean.
   */
  sfsuDriveAlone: 0.41,
};
/**
 * Commuting: how many of a commuter's weekdays they commute. BATS 2023 asked workers how often
 * they commute (Table 45, by home county): SF residents who commute do so on 65% of weekdays on
 * average, hybrid schedules included (bats-commute-frequency.json). Leave, holidays, and sick days
 * take a further 7% (assumed: about 19 of 250 working days). Applied to residents who don't work
 * from home (ACS) and to in-commuters by home county. Each day at work is a work tour.
 */
export const ABSENCE = 0.93;
export const COMMUTE_DAYS: Record<string, number> = {
  "San Francisco": 0.6511,
  Alameda: 0.6812,
  "Contra Costa": 0.7346,
  "San Mateo": 0.6544,
  "Santa Clara": 0.72,
  Solano: 0.765,
  Sonoma: 0.6698,
  Marin: 0.6686,
  Napa: 0.6686,
};
/** counties BATS doesn't report separately: their mean */
export const COMMUTE_DAYS_OTHER = 0.693;
export const ATTENDANCE = COMMUTE_DAYS["San Francisco"] * ABSENCE;
/**
 * The other reading of BATS 2023: the travel diaries' day-level commuting (MTC's BATS 2019–2023
 * dashboard, full-time workers by commute category and home county, Tuesday–Thursday travel days),
 * as a factor on the stated frequency above. San Francisco's full-time workers commuted on 32.2% of
 * diary days; the stated frequency, with the ACS share working from home and the absence allowance,
 * gives 47.0% (0.606 × 0.775, the synthetic population's full-time workers not working from home), a
 * factor of 0.686. Other counties scale it by their diary-to-stated ratio relative to San
 * Francisco's (Marin and Napa together, as Table 45 groups them). Used when the calibration's
 * `commuteBasis` is 'diary' (see METHOD.md, Commuting days, for why the stated frequency is kept).
 */
export const DIARY_COMMUTE_FACTOR: Record<string, number> = (() => {
  const diary: Record<string, number> = { "San Francisco": 0.322, Alameda: 0.314, "Contra Costa": 0.364, "San Mateo": 0.304, "Santa Clara": 0.36, Solano: 0.356, Sonoma: 0.433, Marin: 0.402, Napa: 0.402 };
  const fSF = 0.322 / (ATTENDANCE * 0.775);
  const rSF = diary["San Francisco"] / COMMUTE_DAYS["San Francisco"];
  return Object.fromEntries(Object.entries(diary).map(([c, d]) => [c, (fSF * d) / COMMUTE_DAYS[c] / rSF]));
})();
export const DIARY_COMMUTE_FACTOR_OTHER = Object.values(DIARY_COMMUTE_FACTOR).reduce((a, v) => a + v, 0) / Object.keys(DIARY_COMMUTE_FACTOR).length;
/**
 * Commute days by household income: BATS 2023 Table 46 ("reported typical commute frequency by
 * income", report p. 69; all nine counties, workers who commute), read as Table 45 is. Workers in
 * households under $100,000 go in on 76.4% of weekdays, those at $100,000 or more on 66.4% (the
 * bands' weighted means: under $25,000 0.674, $25–50,000 0.790, $50–75,000 0.771, $75–100,000
 * 0.778, $100–200,000 0.729, $200,000 or more 0.611): hybrid schedules are mostly a high-income
 * pattern. Used relative to each other (INCOME_CLASSES order) with the city's mean held at
 * ATTENDANCE (demand.ts), so the county's own figure sets the level and the income table the split.
 */
export const COMMUTE_DAYS_BY_INCOME = [0.7638, 0.6642];
/**
 * Private shuttle riders by work county: SF residents who usually commute by bus to San Mateo and
 * Santa Clara counties (ACS 2020-24 microdata, commute-by-county.json: 3,712 and 3,778; nearly all
 * on employer shuttles, as SamTrans carries few SF residents to work there), at work on a weekday
 * (ATTENDANCE): about 4,500 riders, against SFMTA's 8,500 in 2017 less the 40% fall in shuttle stops
 * since 2019 (5,100).
 */
export const SHUTTLE_RIDERS: Record<string, number> = {
  "San Mateo County": 3712 * ATTENDANCE,
  "Santa Clara County": 3778 * ATTENDANCE,
};

/**
 * Tours. Home-based travel is generated as tours (home → primary destination → home) at NHTS 2017
 * weekday rates per person by primary purpose; each tour chooses one mode. Each half of a tour may
 * make stops: the share of half-tours with a stop times the stops in such a half, and the share of
 * stops nearer home than the primary destination. Work tours also make subtours from the workplace
 * (lunch, errands). SF–Oakland metro residents; server/beta3/reference/nhts-tours.json (nhts_tours.py).
 */
export const TOUR_RATES = { shop: 0.125, other: 0.174, social: 0.276 };
/**
 * Household-survey underreporting, for sensitivity tests only (all factors 1, so off): a multiple on
 * residents' home-based shopping, other, and social tours by car segment and income class
 * (tours[s][c], SEGMENTS by INCOME_CLASSES), and one on the share of a zone's households that are
 * limited-English (lep, applied as 1 + share × (lep − 1); lepShare by zone, from ACS C16002, set by
 * the caller). See server/beta3/research/underreporting.md: no published factor by segment applies
 * to a smartphone diary like BATS 2023, so none is used in the model.
 */
export const UNDERREPORT: { tours: number[][]; lep: number; lepShare: Float32Array | null } = {
  tours: [
    [1, 1],
    [1, 1],
    [1, 1],
  ],
  lep: 1,
  lepShare: null,
};
export const STOPS_PER_HALF: Record<
  "work" | "school" | "univ" | "shop" | "other" | "social",
  number
> = {
  work: 0.31 * 1.45,
  school: 0.19 * 1.43,
  univ: 0.22 * 2.08,
  shop: 0.24 * 1.44,
  other: 0.18 * 1.49,
  social: 0.23 * 1.42,
};
export const STOP_NEAR_HOME = 0.46;
/** stops by the tour's mode relative to all tours (NHTS stops per half-tour: car 0.38, transit 0.31,
 * walk 0.32, bike 0.22, against 0.36 for all) */
export const STOP_RATE_BY_MODE: Record<
  "da" | "sr" | "tnc" | "transit" | "walk" | "bike",
  number
> = {
  da: 1.06,
  sr: 1.06,
  tnc: 1.06,
  transit: 0.86,
  walk: 0.89,
  bike: 0.61,
};
export const WORK_SUBTOURS = 0.177;
/** what stops are for (shares of stops on all tours, NHTS 2017): their destination size term */
export const STOP_MIX = { shop: 0.3, other: 0.36, social: 0.34 };

/**
 * Private commuter shuttles (SFMTA Commuter Shuttle Program; commuter-shuttles.json) carry residents
 * near the approved stops to work in these counties (riders: SHUTTLE_RIDERS). The ACS counts them as
 * bus commuters, so they count as transit against ACS targets.
 */
export const SHUTTLE_COUNTIES = ["San Mateo County", "Santa Clara County"];
/** ACS 2024 1-year: 21.4% of San Francisco residents worked from home (the 5-year mix is rescaled to this) */
export const WFH_RESIDENTS_2024 = 0.214;

/** Destination choice: logsum coefficient (assumed, typical of Bay Area models 0.6–0.9) */
export const DEST_LOGSUM = 0.75;
/** run-time tunables (used by the uncertainty analysis to vary parameters; defaults as above) */
export const TUNE = { destLogsum: DEST_LOGSUM, ivtScale: 1 };

/**
 * Parking for a game, concert or convention near the venue, per car (assumed: the Giants' lots and
 * the garages near Chase Center price by demand, from about $12 to $70 a game as parking resellers
 * list them, 2026). It replaces the zone's hourly rate for event trips.
 */
export const EVENT_PARKING = 40;

/**
 * Hotel rooms in San Francisco (~34,000; SF Travel's 2011 fact sheet counted 32,976) and guests per
 * room: SF-CHAMP's party size (1.69) times SF Travel's hotel occupancy for 2026, the year of the Muni
 * counts (70.7%, its August 2026 forecast; 63% in 2024 and 67.2% in 2025). It was an assumed 78%,
 * above every year since the pandemic (server/beta3/reference/visitor-travel.json).
 */
export const HOTEL_ROOMS_SF = 34_000;
export const HOTEL_OCCUPANCY = 0.707;
export const VISITORS_PER_ROOM = 1.69 * HOTEL_OCCUPANCY;
export const VISITOR_TRIPS = 3.6;

/** Operating cost per vehicle revenue hour, 2024 $ (NTD 2024) */
export const COST_PER_HOUR: Record<string, number> = {
  bus: 301.6,
  rapid: 301.6,
  express: 301.6,
  trolley: 281.3,
  lightrail: 412.1,
  streetcar: 631.19,
  cablecar: 871.27,
  bart: 374.5 * 10,
  caltrain: 994.09 * 7,
  ferry: 2500,
};

/**
 * Stop zones kept per anchor in the stop pass (demand.ts), by the tour's mode class: the most likely
 * first. Transit and walking tours need more to carry the tail of their detours (NHTS 2017, dense tracts:
 * transit tours' detour legs average 1.04 km up to 5 miles though 68% are within half a mile).
 */
export const STOP_K = { car: 40, transit: 150, walk: 150, bike: 40 };
