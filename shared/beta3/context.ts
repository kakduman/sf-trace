/**
 * Conditions: the demand drivers outside the transit network, as explicit inputs to a run
 * (Scenario.context). Each has today's value (the base model's, July–August 2026), sane bounds, and
 * its source. Values relative to today are 1 by default; prices are dollars of today.
 *
 * The model was calibrated with every condition at today's value, so a run with all of them unset
 * reproduces the base. backcast.ts sets them to July 2024's (reference/backcast-drivers.json).
 */
import { AUTO_COST_PER_MILE, CLIPPER_NEXTGEN_SHARE, CLIPPER_TRANSFER_DISCOUNT, COMMUTE_DAYS, MUNI_FARE } from './params';
import type { DemandContext } from './types';

/** San Francisco regular gasoline, July 2026 mean (EIA weekly series EMM_EPMR_PTE_Y05SF_DPG), $/gal */
export const GAS_PRICE_TODAY = 5.39;
/** maintenance, repair, and tires, $ a mile (AAA, Your Driving Costs 2025: 11.04 cents); the rest
 * of the running cost (AUTO_COST_PER_MILE) is fuel, and moves with the price of gasoline */
export const AUTO_NONFUEL_PER_MILE = 0.1104;
/** residents working from home full time, citywide (ACS 2024 1-year, B08301: 100,347 of 468,430) */
export const WFH_TODAY = 0.2142;
/** weekdays a week that San Francisco residents who commute go in (BATS 2023: 65.1% of weekdays) */
export const COMMUTE_DAYS_TODAY = 5 * COMMUTE_DAYS['San Francisco'];

export type ConditionKey = Exclude<keyof DemandContext, 'transferDiscountMuniOnly' | 'eventMonth' | 'events' | 'carOwnership' | 'micromobility'>;
export interface ConditionSpec {
  key: ConditionKey;
  label: string;
  group: 'Work' | 'People' | 'Visitors' | 'Prices';
  /** how the value is shown: relative to today (%), dollars, days a week, or a share */
  unit: 'rel' | 'usd' | 'days' | 'share';
  today: number;
  min: number;
  max: number;
  step: number;
  /** what it is and where today's value comes from, for the app */
  source: string;
  /** today's value's source, briefly (the method's table) */
  basis: string;
}

export const CONDITIONS: ConditionSpec[] = [
  { key: 'attendanceCore', label: 'Office attendance downtown', group: 'Work', unit: 'rel', today: 1, min: 0.5, max: 1.6, step: 0.01, basis: 'Kastle office occupancy, San Francisco metro (46.6% of February 2020 in July 2026)', source: 'Financial District, SoMa, and Civic Center. Today about 47% of pre-pandemic.' },
  { key: 'attendanceOther', label: 'Attendance at jobs elsewhere', group: 'Work', unit: 'rel', today: 1, min: 0.5, max: 1.6, step: 0.01, basis: 'none (commutes to jobs outside the regional core as calibrated)', source: 'Jobs in the rest of the city.' },
  { key: 'wfh', label: 'Residents working from home full time', group: 'Work', unit: 'share', today: WFH_TODAY, min: 0.05, max: 0.5, step: 0.005, basis: 'ACS 2024 1-year, table B08301', source: 'Share of employed residents.' },
  { key: 'commuteDays', label: 'Commute days a week', group: 'Work', unit: 'days', today: COMMUTE_DAYS_TODAY, min: 2, max: 5, step: 0.05, basis: 'BATS 2023 commute frequency, city residents', source: 'Days a week the average commuter goes in.' },
  { key: 'employedResidents', label: 'Employed residents', group: 'People', unit: 'rel', today: 1, min: 0.8, max: 1.3, step: 0.005, basis: 'BLS LAUS, San Francisco County (479,363 in July 2026)', source: 'Today: 479,000.' },
  { key: 'jobs', label: 'Jobs in the city', group: 'People', unit: 'rel', today: 1, min: 0.8, max: 1.3, step: 0.005, basis: 'BLS QCEW, San Francisco County (703,386 in the first quarter of 2026)', source: 'Today: 703,000. Changes the number of commuters from outside.' },
  { key: 'residents', label: 'Population', group: 'People', unit: 'rel', today: 1, min: 0.8, max: 1.3, step: 0.005, basis: 'California DOF E-1 (845,658 on January 1, 2026)', source: 'Today: 845,700. Changes residents’ trips other than commutes.' },
  { key: 'visitors', label: 'Hotel visitors', group: 'Visitors', unit: 'rel', today: 1, min: 0.5, max: 1.5, step: 0.01, basis: 'hotel occupancy, City Performance Scorecard (73.1% in July 2026)', source: 'Hotel guests’ trips. Hotels are about 73% full today.' },
  { key: 'airPassengers', label: 'SFO passengers', group: 'Visitors', unit: 'rel', today: 1, min: 0.5, max: 1.5, step: 0.01, basis: 'SFO passenger statistics (5.30 million in July 2026)', source: 'Air travelers between the city and SFO.' },
  { key: 'regionalVisitors', label: 'Visitors from the region', group: 'Visitors', unit: 'rel', today: 1, min: 0.5, max: 1.5, step: 0.01, basis: 'none (the calibrated rate)', source: 'Day trips from the rest of the Bay Area.' },
  { key: 'gasPrice', label: 'Gas price', group: 'Prices', unit: 'usd', today: GAS_PRICE_TODAY, min: 3, max: 9, step: 0.05, basis: 'EIA, San Francisco regular, July 2026 mean', source: 'Regular, per gallon.' },
  { key: 'muniFare', label: 'Muni adult fare', group: 'Prices', unit: 'usd', today: MUNI_FARE, min: 0, max: 5, step: 0.05, basis: 'SFMTA adult Clipper fare since July 1, 2025', source: 'Clipper single ride. Combines with the Muni fare slider above.' },
  { key: 'transferDiscount', label: 'Clipper discount between operators', group: 'Prices', unit: 'usd', today: CLIPPER_TRANSFER_DISCOUNT, min: 0, max: 3, step: 0.05, basis: 'Next Generation Clipper, since December 10, 2025', source: 'Off each later fare within two hours, for riders on the new Clipper.' },
  { key: 'transferDiscountShare', label: 'Riders on the new Clipper', group: 'Prices', unit: 'share', today: CLIPPER_NEXTGEN_SHARE, min: 0, max: 1, step: 0.01, basis: 'MTC: 53% of Clipper trips on the next-generation system, week ending July 18, 2026', source: 'Riders who get the discount above. The rest get $0.50 off onto Muni.' },
];
export const CONDITION_BY_KEY = Object.fromEntries(CONDITIONS.map((c) => [c.key, c])) as Record<ConditionKey, ConditionSpec>;

/** a context with only valid, non-default values, clamped to the bounds (null when nothing is set) */
export function cleanContext(c: unknown): DemandContext | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const out: DemandContext = {};
  for (const s of CONDITIONS) {
    const v = o[s.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const x = Math.min(s.max, Math.max(s.min, v));
    if (Math.abs(x - s.today) > 1e-9) out[s.key] = x;
  }
  if (typeof o.events === 'number' && Number.isFinite(o.events) && o.events !== 1) out.events = Math.min(2, Math.max(0, o.events));
  if (o.transferDiscountMuniOnly === true) out.transferDiscountMuniOnly = true;
  if (o.eventMonth === 'aug2026') out.eventMonth = 'aug2026';
  if (o.carOwnership === true) out.carOwnership = true;
  return Object.keys(out).length ? out : null;
}

export const contextValue = (c: DemandContext | null | undefined, k: ConditionKey): number => c?.[k] ?? CONDITION_BY_KEY[k]?.today ?? 1;

/** factor on driving's running cost per mile from the price of gasoline */
export function autoCostOf(c?: DemandContext | null): number {
  const gas = c?.gasPrice;
  if (gas === undefined) return 1;
  return (AUTO_NONFUEL_PER_MILE + (AUTO_COST_PER_MILE - AUTO_NONFUEL_PER_MILE) * (gas / GAS_PRICE_TODAY)) / AUTO_COST_PER_MILE;
}
/** factor on Muni's fares from the fare condition */
export const muniFareOf = (c?: DemandContext | null) => (c?.muniFare ?? MUNI_FARE) / MUNI_FARE;
/** factor on commuters' days at work from the commute-days condition */
export const commuteDaysOf = (c?: DemandContext | null) => (c?.commuteDays ?? COMMUTE_DAYS_TODAY) / COMMUTE_DAYS_TODAY;
/** factor on each zone's share working from home */
export const wfhOf = (c?: DemandContext | null) => (c?.wfh ?? WFH_TODAY) / WFH_TODAY;
