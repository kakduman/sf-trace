/**
 * Run modes: Precise is the full model; Quick leaves out the most expensive and least important
 * calculations (see RUN_MODES.quick), with its error measured against Precise (runmodes.ts).
 */
import type { Scenario } from './types';
import type { TrafficOptions } from './traffic';

export type RunMode = 'quick' | 'precise';
export const RUN_MODE_LIST: RunMode[] = ['quick', 'precise'];
export const DEFAULT_RUN_MODE: RunMode = 'quick';

export interface RunModeSettings {
  /** strategy searches per destination with the transfer logit (undefined: PATH.transferPasses) */
  transferPasses?: number;
  /**
   * today's road speeds held fixed: no road assignment, so car, ride-hail, and mixed-traffic bus
   * times stay those of today's converged assignment; a scenario that changes streets or car prices
   * (editsStreetsOrCarPrices) gets the approximate road response in `traffic` instead
   */
  fixedRoads: boolean;
  traffic: TrafficOptions;
  /**
   * after traffic feedback, find the transit paths again with the buses' new running times and let
   * demand choose once more (else the new times go to the loading only)
   */
  busReskim: boolean;
}

/**
 * Precise is the full model: traffic feedback until the cars settle, every assignment solved to
 * today's relative gap of 10⁻⁴ (roads-base.ts), so the comparison is like for like.
 *
 * Quick holds today's road speeds fixed, as FTA's STOPS does (it takes one set of highway times
 * for each forecast year, the same for the no-build and the build, and performs no highway
 * assignment: STOPS User Guide v2.52–2.53, pp. 1, 10, 80), so no assignment noise can enter its time
 * savings. A scenario that changes streets or car prices gets an approximate road response: two
 * rounds of demand with traffic, each assignment warm-started from today's and solved to 10⁻³ (at
 * most 20 iterations), the buses' new times going to the loading only. Quick also makes one strategy search per destination: the transfer
 * logit's second search, which spreads riders over the stops where they could change, is left out
 * (about 60% of the path-search time). Its error against Precise is measured on the test scenarios
 * (server/beta3/reference/runmodes.json).
 */
export const RUN_MODES: Record<RunMode, RunModeSettings> = {
  precise: { fixedRoads: false, traffic: { gap: 1e-4, maxIter: 400 }, busReskim: true },
  quick: { transferPasses: 1, fixedRoads: true, traffic: { feedback: 2, gap: 1e-3, maxIter: 20 }, busReskim: false },
};

/** a scenario that changes streets (lanes, bus lanes, closures) or what driving costs (charges, parking, running cost) */
export const editsStreetsOrCarPrices = (s: Pick<Scenario, 'edits' | 'autoCostFactor'>): boolean => s.edits.some((e) => e.kind === 'road' || e.kind === 'cordon' || e.kind === 'parking') || (s.autoCostFactor ?? 1) !== 1;

/** the saved baseline for a day and run mode (client/beta3/model) */
export const baseFile = (day: 'wkd' | 'sat' | 'sun', mode: RunMode) => `${day === 'wkd' ? 'base' : `base-${day}`}${mode === 'quick' ? '-quick' : ''}.bin.gz`;
