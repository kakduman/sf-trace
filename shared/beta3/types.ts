import type { RunMode } from './runmode';
import type { MicroCalib, MicroSettings } from './micromobility';
import type { Mode, Purpose } from './params';
import type { AoCalibration } from './autoown';
import type { AbmCalib } from './abm';

/** Transit assignment periods: the three day periods and the night (EV + EA, 7pm–6am). */
export const TPERIODS = ['AM', 'MD', 'PM', 'NT'] as const;
/** the periods as the run's progress names them */
export const PERIOD_NAME: Record<TPeriod, string> = { AM: 'morning peak', MD: 'midday', PM: 'evening peak', NT: 'night' };
export type TPeriod = (typeof TPERIODS)[number];
/** the city line's three road corridors: the Golden Gate Bridge, the Bay Bridge, and the San Mateo County line */
export type Corridor = 'north' | 'east' | 'south';
export const TPERIOD_HOURS: Record<TPeriod, number> = { AM: 4, MD: 5, PM: 4, NT: 11 };
export const TPERIOD_LABEL: Record<TPeriod, string> = { AM: 'Morning peak, 6–10am', MD: 'Midday, 10am–3pm', PM: 'Evening peak, 3–7pm', NT: 'Night, 7pm–6am' };

/** Day types the model represents: an average weekday, Saturday and Sunday. */
export const DAY_TYPES = ['wkd', 'sat', 'sun'] as const;
export type DayType = (typeof DAY_TYPES)[number];
export const DAY_LABEL: Record<DayType, string> = { wkd: 'Weekday', sat: 'Saturday', sun: 'Sunday' };

export type TransitMode = 'bus' | 'rapid' | 'trolley' | 'streetcar' | 'lightrail' | 'cablecar' | 'bart' | 'caltrain' | 'ferry' | 'express';

export interface BStop {
  id: string;
  feed: string;
  name: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  station: boolean;
}

export interface BLinePeriod {
  trips: number;
  /** seconds per hop */
  hops: number[];
}

export interface BLine {
  id: string;
  feed: string;
  agency: string;
  route: string;
  routeName: string;
  mode: TransitMode;
  color: string;
  dir: number;
  headsign: string;
  stops: number[];
  periods: Partial<Record<TPeriod, BLinePeriod>>;
  /** Saturday and Sunday service (same period keys as `periods`) */
  days?: Partial<Record<'sat' | 'sun', Partial<Record<string, BLinePeriod>>>>;
  /** trips leaving 7pm–midnight, by day type: the night frequency riders see */
  evening?: Partial<Record<DayType, number>>;
  /** trips leaving midnight–5am, by day type (owl service) */
  owl?: Partial<Record<DayType, number>>;
  /** reliability: expected wait ÷ half the scheduled headway, by period (bunching makes it > 1) */
  waitFactor?: Partial<Record<TPeriod, number>>;
  /** operations as run (reference/muni-operations.json): actual ÷ scheduled running time, by period */
  runFactor?: Partial<Record<TPeriod, number>>;
  /** share of scheduled trips actually run, by period (missed trips lower the frequency riders see) */
  delivered?: Partial<Record<TPeriod, number>>;
  /**
   * day-to-day standard deviation of a ride's running time, minutes: a + b × minutes aboard, by
   * period; rail and ferries carry a per-ride `a` only (their delays come from incidents)
   */
  rideSD?: Partial<Record<TPeriod, { a: number; b: number }>>;
  /** mean minutes late per ride against the timetable (rail and ferries, from on-time shares) */
  lateMin?: number;
  /** stop positions where riders may not board, or may not get off (GTFS pickup_type / drop_off_type 1) */
  noBoard?: number[];
  noAlight?: number[];
  /** a line for some riders only (UCSF's shuttles): anyone may board at openStops; elsewhere only
   * riders bound for one of destZones (city zones) */
  restrict?: { openStops: number[]; destZones: number[] };
  cap: number;
  seats: number;
  path: number[];
  stopAt: number[];
  /**
   * background riders on each hop (riders per period, not per train): trips on this line with no end
   * in San Francisco, which the demand model does not carry; by day type and period (background.ts)
   */
  bg?: Partial<Record<DayType, Partial<Record<TPeriod, number[]>>>>;
}

/** Fare pieces for an operator: paid when boarding it, per km aboard, and surcharges on named hops. */
export interface FareRule {
  board: number;
  perKm: number;
  /** extra on hops between these stop index pairs (e.g. BART's Transbay Tube, SFO) */
  hops?: { a: number; b: number; fare: number }[];
  /** a flat fare by route (short name) in place of `board` (SF Bay Ferry prices each route) */
  routes?: Record<string, number>;
}

export interface ZoneAttrs {
  id: string;
  nhood: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  land: number;
  pop: number;
  hh: number;
  hhVeh: [number, number, number];
  /** households by income band (INCOME_BANDS) */
  hhInc: [number, number, number, number];
  workers: number;
  age5to17: number;
  age18to24: number;
  age65plus: number;
  college: number;
  commute: number[];
  jobsBy: number[];
  jobs: number;
  /** MTC 2023 land use: college FTE and high-school enrolment */
  collegeEnroll?: number;
  hsEnroll?: number;
  schools: number;
  universities: number;
  hotelRooms: number;
  attractions: number;
  /** park acreage: SF Recreation and Park properties, the Presidio and GGNRA sites */
  parkAcres?: number;
  /** K-12 pupils enrolled at schools in the zone (public, charter, and private) */
  schoolEnroll?: number;
  /** the same by level: TK-5, 6-8, 9-12 (SCHOOL_LEVELS) */
  schoolEnrollBy?: [number, number, number];
  /** K-12 pupils living in the zone by level (ACS B14001 by tract, shared out by children aged 5-17) */
  pupils?: [number, number, number];
  /** a campus's share of students living in the city, where known (else COLLEGE.residentShare) */
  collegeResShare?: number;
  /** students at the campus here ride all Bay Area transit free (SF State's Gator Pass, a Clipper BayPass) */
  collegePass?: boolean;
  /** share of residents within 600 m of a private commuter shuttle stop */
  shuttleReach?: number;
  /** the parks here: [name, acres in this zone, the park's total acres] */
  parks?: [string, number, number][];
  garages: number;
  /** OpenStreetMap storefronts: shops; places to eat and drink (with cinemas and theatres); services
   * (banks, clinics, salons, post offices, libraries, places of worship...) */
  shops?: number;
  eateries?: number;
  services?: number;
  /** TM1 area type 0 regional core … 3 urban */
  areaType: number;
  /** pop + jobs per square mile, within ~800 m (for ride-hail waits) */
  density: number;
  /** TM1 density index (households & jobs per acre, harmonic) */
  densityIndex: number;
  /** residents' share working from home (ACS, rescaled to 2024) */
  wfh: number;
  /** MTC superdistrict 1-4 (downtown and the northeast; the north and west; the Mission and southeast; the Sunset), for event attendees' homes */
  sd?: number;
  shape: [number, number][][];
}

export interface ExtZoneAttrs {
  id: string;
  name: string;
  county: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  toSF: number;
  fromSF: number;
  /** share of its in-commuters from households without a car (ACS PUMS by home PUMA) */
  zeroCar?: number;
  /** its in-commuters' home PUMAs, as shares (zones.ts) */
  puma?: Record<string, number>;
  /** retail employment of the Bay Area zones nearest it (MTC 2023 land use), for car ownership's accessibility */
  retail?: number;
}

/** Observed figures the model is checked against. */
export interface Observed {
  muniRoutes: { route: string; boardings: number }[];
  muniPeriod: string;
  muniSystem: number;
  bartStations: { code: string; name: string; stop: number | null; exits: number; entries: number }[];
  bartPeriod: string;
  caltrainStations: { name: string; stop: number | null; boardings: number }[];
  caltrainPeriod: string;
  acsCommute: Record<string, number>;
  acsPeriod: string;
  residentShares: Record<Mode, number>;
  residentSharesSource: string;
  /** weekend counts: Muni routes (latest month) and BART station exits */
  muniRoutesSat?: { route: string; boardings: number }[];
  muniRoutesSun?: { route: string; boardings: number }[];
  bartExitsSat?: Record<string, number>;
  bartExitsSun?: Record<string, number>;
}

/** NHTS 2017 trip making by day type, relative to the weekday (SF–Oakland metro) */
export interface DayTypeProfile {
  /** trips per person relative to the weekday, by model purpose */
  rate: Record<string, number>;
  /** share of each purpose's trips by period, and the share leaving home */
  tod: Record<string, { share: Record<string, number>; fromHome: Record<string, number> }>;
}

/** Calibrated constants and scale factors (fit by the calibration script). */
export interface Calibration {
  /** where demand's car-ownership and income segments come from (demand.ts SynpopMode; default 'off',
   * the raked ACS margins; 'households' or 'persons' read them from the synthetic population) */
  segments?: 'off' | 'households' | 'persons';
  /** the person-level choices (abm.ts): whether demand uses them, and their calibrated constants and shadow prices */
  abm?: AbmCalib;
  /** how often commuters commute: BATS 2023's stated frequency ('stated', the default) or its travel
   * diaries' day-level commuting ('diary', params DIARY_COMMUTE_FACTOR) */
  commuteBasis?: 'stated' | 'diary';
  /** alternative-specific constants: purpose → segment → mode */
  asc: Record<string, Record<string, Partial<Record<Mode, number>>>>;
  /** extra transit constant by line mode (path-level bias, minutes of IVT) */
  modeBias: Partial<Record<TransitMode, number>>;
  /** in-vehicle time factor by line mode where calibrated (ferries, Caltrain), replacing the TM1 value, or by operator ('feed:ac', AC Transit's Transbay buses) */
  ivtFactor?: Partial<Record<TransitMode | `feed:${string}`, number>>;
  /** destination choice distance coefficient per km, by purpose */
  distCoef: Partial<Record<Purpose, number>>;
  /** destination choice coefficient on the log of distance (km), by purpose (demand.ts nearTerm) */
  distLogCoef?: Partial<Record<Purpose, number>>;
  /** regional visitor trips per in-commuter, and out-of-city share of residents' non-work trips */
  regionalRate: number;
  outShare: number;
  /** air passengers between SFO and the city per weekday (both directions) */
  airportTrips: number;
  /**
   * seconds added to (or taken from) the assumed street-to-platform time (net.ts platformSec) at the
   * downtown BART stations, by BART station code, fitted to BART's exits and entries there with their
   * mean held at zero (calibrate.ts fitStationTimes)
   */
  stationSec?: Record<string, number>;
  /** multiplier on TM1's transfer weight in mode choice, and so on the change penalty in route choice
   * (params.ts transferPenalty): fit to the share of Muni boardings that follow another vehicle */
  xferFactor?: number;
  /** transit constant by home neighborhood (fit to ACS commute transit shares by block group) */
  nhoodTransit?: Record<string, number>;
  /** park size term: weight × acres here × (park's total acres)^(exponent − 1), fit to observed park visits */
  parkWeight?: number;
  parkExponent?: number;
  /** scale on residents' non-work tour rates (NHTS 2017) so their trips total BATS 2023's */
  tourRateFactor?: number;
  /** running correction (log, by mode) to residents' non-work targets so their trips match BATS */
  residentCorrection?: Partial<Record<string, number>>;
  /** transit constant on residents' non-work tours by household income band (INCOME_BANDS), recentred on trips */
  incomeTransit?: number[];
  /** constants on residents' trips by persons under 18 (by mode, shared ride the reference), fitted to BATS 2023's under-18 shares */
  youthAsc?: Partial<Record<Mode, number>>;
  /** a test: [model, target] share of Muni's riders traveling to or from school or college (MTC's
   * 2023–24 Snapshot survey; calibrate.ts) */
  snapshotSchoolFit?: [number, number];
  /** the last calibration iteration's youth fit: mode → [model share, target] */
  youthFit?: Partial<Record<Mode, [number, number]>>;
  /** the last calibration iteration's fit: [model share, target] by income class, and by county */
  incomeFit?: [number, number][];
  countyFit?: { in: Record<string, [number, number]>; out: Record<string, [number, number]> };
  /** commute transit constants by county: into the city by home county, out of it by work county */
  countyTransit?: { in?: Record<string, number>; out?: Record<string, number> };
  /** perceived minutes on each way of reaching a station outside the city (≥ 0; on whichever is over-used), fit to BART's 2024 Station Profile access shares */
  extAccessBias?: Partial<Record<'walk' | 'bus' | 'drive', number>>;
  /**
   * the direction of Caltrain commuting: perceived minutes, of either sign, on reaching a Caltrain
   * station outside the city from an outside zone's home end, where in-commuters and regional visitors
   * start, fit to the morning's Caltrain arrivals at San Francisco and 22nd Street (calibrate.ts)
   */
  caltrainEnd?: number;
  /** the same at an outside zone's activity end, where residents commuting out work, fit to the
   * morning's departures from the two stations */
  caltrainAct?: number;
  /** the last calibration iteration's direction check: [model, target] morning arrivals at the city's
   * Caltrain stations (fitted), and the morning's share of journeys leaving them (a test) */
  caltrainDirFit?: { arrivalsAM: [number, number]; departuresAM?: [number, number]; departAmShare: [number, number] };
  /** park-and-ride shadow prices (perceived minutes per leg, by bundle stop) the calibrated base run settles at; runs start from them */
  lotPrice?: Record<number, number>;
  /** in-commuters' transit constant by home PUMA (ACS 2020–24 PUMS), on top of the county's, applied to
   * each outside zone by the PUMAs its commuters live in (outside zone id → constant) */
  extTransit?: Record<string, number>;
  /** the constants by PUMA, and the last iteration's fit: PUMA → [model share, target] */
  pumaTransit?: Record<string, number>;
  pumaFit?: Record<string, [number, number]>;
  /** shadow prices (utils) on destination size by zone, holding each school level's zones ('school0'-'school2')
   * to their enrollment and each campus ('univ') to its residents' share of its students */
  shadow?: Record<string, number[]>;
  /** scale on TM1's school distance terms (1 = TM1), fit to SFUSD's elementary trip lengths */
  schoolDistScale?: number;
  /** school tours' constants, on top of residents' non-work constants, fit to SFUSD's elementary modes */
  schoolAsc?: Partial<Record<Mode, number>>;
  /** school tours' transit constant by level (SCHOOL_LEVELS order; elementary 0), on top of schoolAsc,
   * fit to SFMTA's Student Travel Tally (6th and 9th graders) */
  schoolLevelTransit?: number[];
  /** residents' commute flows to an outside county (by name without "County"), scaled to its share of
   * the city's commuters in the ACS 2024 records (demand.ts outCommuteWeights) */
  outCommuteFactor?: Record<string, number>;
  /** BATS's under-18 transit share's 90% interval, within which the youth transit constant does not move */
  youthTransitInterval?: [number, number];
  /** the fit: [model, target] share of the city's commuters working in each such county */
  outCommuteFit?: Record<string, [number, number]>;
  /** the last iteration's fit: [model, target] transit share of the trip to school, by level (null: not fitted) */
  schoolLevelFit?: ([number, number] | null)[];
  /** school tours' offsets on their trips home's switches ('tour mode>trip mode'), fit to SFCTA (params SCHOOL_RETURN) */
  schoolSwitch?: Record<string, number>;
  /** the last iteration's fit: [model, target] elementary pupils' transit share home over to school */
  schoolReturnFit?: [number, number];
  /** college tours' drive-alone constant, fit to SF State's students' drive-alone rate */
  collegeDa?: number;
  /** the last iteration's fit: [model, target] drive-alone share of college trips to SF State */
  collegeFit?: [number, number];
  /** the last iteration's fit: elementary [model, target] by mode, and share under a mile */
  schoolFit?: { modes: Partial<Record<Mode, [number, number]>>; under1mi: [number, number] };
  /** distance decay (per km) of where tours stop, fit to NHTS detour lengths */
  stopDistCoef?: number;
  /** the same by the tour's mode class (car, transit, walk, bike) */
  stopDistCoefs?: Record<string, number>;
  /** trip mode choice conditional on tour mode: the constants by 'tour mode>trip mode' (params TRIP_SWITCH_ASC), fitted to NHTS 2017 */
  tripSwitch?: Record<string, number>;
  /** the last calibration iteration's fit: 'out-leg mode>other trip mode' → [model share, target] */
  tripSwitchFit?: Record<string, [number, number]>;
  /**
   * the same constants for the legs through stops and of work subtours, where they differ from the
   * trip back's (params TRIP_SWITCH_STOP: transit tours, fitted to the NHTS's stop legs while the
   * trip back's are fitted to its trips back); absent, those legs take tripSwitch's
   */
  tripSwitchStop?: Record<string, number>;
  /** the last calibration iteration's fit of tripSwitchStop: 'tour mode>trip mode' → [model share, target] */
  tripSwitchStopFit?: Record<string, [number, number]>;
  /**
   * a factor on mode choice's weights on the minutes of walking all the way (TM1: 2× in-vehicle time
   * to 1 or 1½ miles a leg, 10× beyond), fitted to how much less often the NHTS's trips of 1 to 2
   * miles are walked than those of half a mile or less; the walk to and from transit keeps TM1's weights
   */
  walkTimeFactor?: number;
  /** the fit behind it: residents' trips of 1 to 2 miles walked, model and NHTS */
  walkFit?: [number, number];
  /** and of half a mile or less */
  walkFitNear?: [number, number];
  /** where tours stop: coefficient on the log of the detour (km), by the tour's mode class */
  stopLogCoefs?: Record<string, number>;
  /** the regional visitor rate's fit: the city stations' BART exits at midday and night, and all day (a check), [model, observed] */
  regionalFit?: { exitsOffPeak: [number, number]; exitsDay: [number, number] };
  /** a factor on BATS's transit share of residents' non-work trips, fitted to Muni's counted boardings (calibrate.ts residentTarget) */
  residentTransitLevel?: number;
  /** a factor on non-residents' transit share of their trips within the city with a choice of their own (in-commuters' and visitors' trips not from home, hotel visitors'), fitted to non-residents' Muni boardings */
  nonResTransitLevel?: number;
  /** Muni's boardings on the counted routes by residents and non-residents, model (linked trips × boardings per trip) and target */
  muniLevelFit?: { residents: [number, number]; nonResidents: [number, number] };
  /** the same from the last assignment itself */
  muniByResidence?: { residents: [number, number]; nonResidents: [number, number] };
  /** Muni boardings on the counted routes per linked transit trip, from calibration's last assignment: all, residents', non-residents' */
  muniPerTrip?: number;
  muniPerTripRes?: number;
  muniPerTripNonRes?: number;
  /** factor on parks with counted visits (special generators), on top of the size term */
  parkFactor?: Record<string, number>;
  /** transit constant on special-event trips by venue, fit to the venues' surveyed transit shares (reference/special-events.json) */
  /** event attendees from (and home to) San Mateo and Santa Clara counties: a transit constant on top of
   * the venue's, fitted to Caltrain's extra riders on Giants home weekdays (calibrate.ts) */
  eventSouthTransit?: number;
  /** the last fit: [model, target] Caltrain boardings by Oracle Park's attendees on an average weekday */
  eventCaltrainFit?: [number, number];
  eventTransit?: Record<string, number>;
  /** visitors' sightseeing rides per weekday by Muni route (cable cars, historic streetcars) */
  touristRides?: Record<string, number>;
  /** weekend adjustments: a transit constant (fit to Muni's weekend boardings), regional visitors (BART weekend exits), sightseeing factor */
  days?: Partial<Record<'sat' | 'sun', { transitAsc: number; regionalRate: number; touristFactor: number }>>;
  /** car ownership (autoown.ts): constants fitted to ACS B25044 by zone, and the base run's accessibility */
  autoOwn?: AoCalibration;
  /** shared bikes and scooters (micromobility.ts): mode constants and the access bias */
  micro?: MicroCalib;
  iterations: number;
  report: string[];
}

export interface BundleHeader {
  version: number;
  built: string;
  sources: string[];
  zones: ZoneAttrs[];
  ext: ExtZoneAttrs[];
  stops: BStop[];
  lines: BLine[];
  fares: Record<string, FareRule>;
  gateways: string[];
  observed: Observed;
  dayTypes?: Partial<Record<'sat' | 'sun', DayTypeProfile>>;
  calibration: Calibration | null;
  /** park-and-ride lots outside the city: stop, spaces, daily fee ($) (station-parking.json) */
  lots?: { stop: number; spaces: number; fee: number }[];
  /** special events at the big venues (server/beta3/reference/special-events.json, model) */
  events?: EventModel;
  /** shared micromobility (micromob-skims.ts): the city's rail and ferry stations as places, and the GBFS snapshot's date */
  micro?: { gbfs: string; /** each vehicle's share of its trips by assignment period (Bay Wheels by hour) */ tod?: Record<'classic' | 'ebike' | 'scooter', number[]>; places: { name: string; kinds: string[]; stops: number[]; x: number; y: number; dockSec: number; zone: number }[] };
  /** index of the typed arrays that follow the header */
  arrays: Record<string, { type: string; offset: number; length: number }>;
}

export interface Bundle {
  header: BundleHeader;
  a: Record<string, Float32Array | Uint16Array | Int32Array | Uint8Array | Float64Array | Uint32Array>;
}

// ---------- scenarios ----------

/** A change to one route (all its patterns), or a new line. */
export type Edit =
  | { kind: 'frequency'; route: string; feed: string; /** multiplier on trips per period */ factor: Partial<Record<TPeriod, number>> }
  | { kind: 'remove'; route: string; feed: string }
  | { kind: 'speed'; route: string; feed: string; /** multiplier on running time, e.g. 0.85 for transit lanes */ factor: number }
  | { kind: 'fare'; feed: string; /** multiplier on fares */ factor: number }
  /** shared bikes and scooters relative to today: Bay Wheels stations, scooters, and their prices (micromobility.ts) */
  | ({ kind: 'micromobility' } & MicroSettings)
  /** take a stop out of every pattern of a route (not a terminus); the ride saves the stop's lost time */
  | { kind: 'removeStop'; route: string; feed: string; stop: number }
  /**
   * extend a route beyond a terminus: every pattern ending at `from` continues through `stops`
   * (and every pattern starting there begins with them, in reverse), with `hops` seconds between
   * `from` and the first new stop, then between each pair
   */
  | { kind: 'extend'; id: string; route: string; feed: string; from: number; stops: ({ lat: number; lon: number; name?: string } | { stop: number })[]; hops: number[] }
  /** add a stop between two consecutive stops of a route (both directions where they run) */
  | { kind: 'addStop'; id: string; route: string; feed: string; between: [number, number]; lat: number; lon: number; name?: string }
  /**
   * a change to a street for cars (traffic feedback only): `lanes` general-purpose lanes added (or,
   * negative, taken away: a road diet, or a lane given to buses) each way, or the street closed to
   * cars, on the links of `street` along the line from `from` through `via` to `to`
   */
  | { kind: 'road'; id: string; name: string; street: string; from: { lat: number; lon: number }; to: { lat: number; lon: number }; via?: { lat: number; lon: number }[]; lanes?: number; closed?: boolean; /** the lanes taken from cars become bus lanes: buses there no longer wait in traffic */ busLane?: boolean; periods?: TPeriod[] }
  /** parking: dollars an hour added to today's parking rates in the zones whose centers lie in the area */
  | { kind: 'parking'; id: string; name: string; ring: [number, number][]; perHour: number }
  /** a charge on cars entering an area (and leaving it, if `outbound`), $ per crossing by period */
  | { kind: 'cordon'; id: string; name: string; ring: [number, number][]; toll: Partial<Record<TPeriod, number>>; outbound?: boolean; periods?: TPeriod[] }
  | {
      kind: 'newLine';
      id: string;
      name: string;
      mode: TransitMode;
      color: string;
      /** stops as [lat, lon] (new) or existing stop index */
      stops: ({ lat: number; lon: number; name?: string } | { stop: number })[];
      /** drawn path [lat, lon, ...] and per stop the index of its point */
      path: number[];
      stopAt: number[];
      /** minutes between vehicles per period (0 = no service) */
      headway: Record<TPeriod, number>;
      /** seconds per hop */
      hops: number[];
      bothDirections: boolean;
    };

export interface Scenario {
  name: string;
  edits: Edit[];
  /** the day modeled (default: an average weekday) */
  day?: DayType;
  /** multiplier on driving's running cost per mile (fuel, wear), for policy tests */
  autoCostFactor?: number;
  /** traffic feedback: assign cars to the streets and let driving times respond (slower; weekdays) */
  traffic?: boolean;
  /** how the model runs (runmode.ts): 'precise' (the default here) or 'quick' */
  runMode?: RunMode;
  /**
   * set by traffic feedback, not by hand: seconds added to (or taken from) each hop of the bundle's
   * buses by the change in congestion on the streets they run on, by period and bundle line
   */
  busDelay?: Partial<Record<TPeriod, Record<number, number[]>>>;
  /** demand conditions other than the network (backcasts, outlooks, the app's Conditions): see
   * DemandContext and context.ts (today's values, bounds, sources) */
  context?: DemandContext;
}

/**
 * Conditions outside the network. Unset means today's value (the base model's, July–August 2026).
 * Relative values are against today; dollars are today's dollars.
 */
export interface DemandContext {
  /** commuters at work on a weekday relative to today, at jobs downtown (TM1's regional core) */
  attendanceCore?: number;
  /** the same at jobs elsewhere in the city */
  attendanceOther?: number;
  /** residents working from home full time, citywide share (today ACS 2024's 21.4%); each zone's moves in proportion */
  wfh?: number;
  /** weekdays a week a commuter goes in (today BATS 2023's 3.26 for city residents); scales every commuter's */
  commuteDays?: number;
  /** employed residents relative to today (residents' commutes) */
  employedResidents?: number;
  /** jobs in the city relative to today (in-commuters and their trips) */
  jobs?: number;
  /** population relative to today (residents' travel other than commutes) */
  residents?: number;
  /** hotel visitors relative to today (their trips and sightseeing rides) */
  visitors?: number;
  /** air travelers between the city and SFO relative to today */
  airPassengers?: number;
  /** regional visitors (day trips into the city) relative to today */
  regionalVisitors?: number;
  /** crowds at the big venues relative to the average weekday of the year (0: no events) */
  events?: number;
  /** which average weekday the event crowds are: the year's (default) or August 2026's, the month of the BART counts */
  eventMonth?: 'year' | 'aug2026';
  /** regular gasoline, $ a gallon (today $5.39) */
  gasPrice?: number;
  /** Muni's adult Clipper fare, $ (today $2.85) */
  muniFare?: number;
  /** Clipper's discount on changing operators, $ (today $2.85), for riders on the next-generation system */
  transferDiscount?: number;
  /** share of riders on Clipper's next-generation system, who get transferDiscount (today 0.53);
   * the rest keep the old discount ($0.50 onto Muni, free from Daly City BART) */
  transferDiscountShare?: number;
  /** the old system only: transferDiscount is the old discount, onto Muni only (Clipper before December 2025) */
  transferDiscountMuniOnly?: boolean;
  /** long run: households choose again how many cars to own, with the scenario's accessibility
   * (autoown.ts). Off by default: car ownership stays as the ACS has it. */
  carOwnership?: boolean;
  /** the scenario's shared bikes and scooters (its 'micromobility' edit, passed on to demand) */
  micromobility?: MicroSettings;
}

/** time of day of an event: sports at about 7 pm, concerts at 8 pm, day games, conventions */
export type EventKind = 'evening' | 'concert' | 'day' | 'convention';
/** where attendees come from, percent: hotels, SF superdistricts 1-4, and the region's three parts */
export interface EventOrigins {
  hotel: number;
  sd: number[];
  east: number;
  north: number;
  south: number;
}
export interface EventModel {
  origins: Record<string, EventOrigins>;
  /** shares of SF-resident and regional attendees coming straight from a workplace in the city */
  fromWork: Record<EventKind, { sf: number; region: number }>;
  venues: {
    name: string;
    lat: number;
    lon: number;
    origins: string;
    /** surveyed transit share of attendees' trips, which the venue's transit constant is fitted to */
    transitShare: number | null;
    /** attendees on an average weekday, by time of day */
    slots: { kind: EventKind; year: number; aug2026: number }[];
  }[];
}

// ---------- results ----------

export interface LineResult {
  /** index into header.lines, or -1 - newLineIndex for scenario lines */
  line: number;
  /** for scenario lines drawn both ways: true for the return direction */
  reverse?: boolean;
  /** the stops this line actually served, when a scenario changed them (else the bundle line's) */
  stops?: number[];
  boardings: Record<TPeriod, number>;
  /** passengers on each hop, per period */
  loads: Record<TPeriod, Float32Array>;
  /** max load / capacity in the busiest period */
  peakLoadFactor: number;
  revenueHours: number;
  passengerKm: number;
}

export interface RunSummary {
  /** person trips per weekday by mode, all travelers */
  trips: Record<Mode, number>;
  /** residents only */
  residentTrips: Record<Mode, number>;
  byPurpose: Record<string, Record<Mode, number>>;
  /** transit boardings by operator */
  boardings: Record<string, number>;
  /** linked transit trips */
  transitTrips: number;
  /** trips on private commuter shuttles (fixed by their counts; not public transit) */
  shuttleTrips?: number;
  /** vehicle-km driven within the model per weekday */
  vkt: number;
  /** total logsum (consumer surplus) in IVT-minutes, for comparing scenarios */
  logsum: number;
  /**
   * a scenario's logsum taken apart by what changed (runModel): `networkOnly` with only its transit
   * network, fares, and shared bikes changed (today's conditions, streets, and car prices), and
   * `noRoads` with its conditions too. So against today's logsum: transit riders' time savings are
   * networkOnly − today, others' (the conditions) noRoads − networkOnly, and drivers' (streets, car
   * prices, traffic) logsum − noRoads.
   */
  logsumParts?: {
    networkOnly: number;
    noRoads: number;
    /**
     * the Peninsula freeways' background drivers (the traffic with no end in the city): minutes of
     * driving they gain (+) or lose (−) against today, each segment's background times its change in
     * time (Precise; zero in Quick, which holds the freeways at today's speeds). Not in `logsum`.
     */
    peninsula?: number;
  };
  /** operating cost per weekday ($) and revenue hours */
  opCost: number;
  revenueHours: number;
  /** average door-to-door transit trip time (min) */
  avgTransitMin: number;
  /** residents' households by cars (0, 1, 2+) as demand used them; in a long-run run, also the
   * model's cars at this run's accessibility and at the base run's (autoown.ts) */
  carOwn?: { hhBySeg: number[]; cars: number; carsBase: number };
  /** average driving time (min) of trips by car (driving alone or carpooling): commutes, and all */
  driveMin?: { work: number; all: number };
}

export interface RunResult {
  scenario: string;
  /** the run mode that made it (runmode.ts; absent: 'precise') */
  runMode?: RunMode;
  /** how the streets answered (weekdays): today's speeds held ('fixed', Quick), an approximate response (Quick, a street or price change), or full feedback ('full', Precise) */
  roadResponse?: 'fixed' | 'approximate' | 'full';
  summary: RunSummary;
  lines: LineResult[];
  /** boardings and alightings per stop (all periods) */
  stopOn: Float32Array;
  stopOff: Float32Array;
  /** boardings and alightings per stop by period (alightings include changes between lines) */
  stopOnBy?: Record<TPeriod, Float32Array>;
  stopOffBy?: Record<TPeriod, Float32Array>;
  /** per internal zone: transit share of trips made by residents, jobs reachable within 45 min by transit (AM) */
  zoneTransitShare: Float32Array;
  zoneJobs45: Float32Array;
  /** per internal zone: logsum per resident trip (for scenario comparisons) */
  zoneLogsum: Float32Array;
  /** crowding multipliers at the end of the run, by bundle line (for warm-starting scenarios) */
  finalCrowd?: Record<TPeriod, Record<number, Float32Array>>;
  /** park-and-ride shadow prices at the end of the run (perceived minutes, by bundle stop; model.ts lotPrices) */
  finalLotPrice?: Record<number, number>;
  /** which model bundle (build and calibration) produced this run: results from different ones cannot be compared */
  bundleId?: string;
  /** traffic feedback: road volumes and congested minutes by period (road links), and their summary */
  traffic?: TrafficResult;
  ms: number;
}

/** vehicle miles and hours on the city's streets, hours of delay (above free flow), and mean speeds (all streets, and by class), by period */
export interface RoadSummaryT {
  vmt: Record<TPeriod, number>;
  vht: Record<TPeriod, number>;
  delay: Record<TPeriod, number>;
  speed: Record<string, Record<TPeriod, number>>;
  vehicles: Record<TPeriod, number>;
  /** the Peninsula freeways, apart from the city's streets, by route and direction ('US-101 N'): vehicle miles and hours, their background included */
  peninsula?: Record<string, { vmt: Record<TPeriod, number>; vht: Record<TPeriod, number> }>;
}

export interface TrafficResult {
  flow: Record<TPeriod, Float32Array>;
  time: Record<TPeriod, Float32Array>;
  /** the last assignment's relative gap and iterations by period */
  gaps: Record<TPeriod, number>;
  iterations: Record<TPeriod, number>;
  vehicles: Record<TPeriod, number>;
  summary: RoadSummaryT;
  /** the same for today's streets and trips */
  base: RoadSummaryT;
  /** a few recognizable drives: minutes today and in the scenario */
  trips: { name: string; period: TPeriod; base: number; scenario: number }[];
  /** the share of vehicle trips that moved between successive feedback iterations */
  convergence: number[];
  /** all-or-nothing loadings the assignments took */
  loadings: number;
  /** the streets whose daily volume changed most (the link with the largest change on each) */
  changes: { name: string; base: number; scenario: number }[];
  /** drives along the Peninsula freeways (minutes, today and in the scenario) */
  corridorTrips?: { name: string; period: TPeriod; base: number; scenario: number }[];
}
