/**
 * App state: one plain object and a tiny change notifier. Views subscribe and re-render only for
 * the keys they care about, so a period switch never rebuilds a panel that doesn't show periods.
 */
import type { DayType, RunResult, Scenario, TPeriod } from '../../shared/beta3/types';
import { cleanContext } from '../../shared/beta3/context';
import type { Draft } from './scenario';
import { DEFAULT_RUN_MODE, RUN_MODE_LIST, type RunMode } from '../../shared/beta3/runmode';

export type PeriodSel = 'day' | TPeriod;
export type Tab = 'overview' | 'routes' | 'scenario' | 'results' | 'method';
export type ColorBy = 'route' | 'mode' | 'crowding' | 'none';
export type ZoneLayer = 'none' | 'share' | 'jobs45' | 'density' | 'zerocar' | 'dshare' | 'daccess' | 'djobs';
/** which network the map shows: today's, the scenario's, or the change between them */
export type MapView = 'base' | 'scenario' | 'change';

export interface RunState {
  status: 'idle' | 'running' | 'done' | 'error';
  stage: string;
  frac: number;
  error?: string;
  started?: number;
}

export interface AppState {
  period: PeriodSel;
  /** the day type shown everywhere and run for scenarios (its baseline is `base`) */
  day: DayType;
  /**
   * today's network for `day` as the shown result was made (its run mode; Precise when there is
   * none), for the map's and the routes' comparisons (weekend baselines load on first use)
   */
  base: RunResult;
  /** the run mode for the next run (runmode.ts): Quick by default, remembered in this browser */
  runMode: RunMode;
  tab: Tab;
  /** selected route group key (see derive.ts RouteInfo.key) */
  route: string | null;
  colorBy: ColorBy;
  zoneLayer: ZoneLayer;
  showStops: boolean;
  view: MapView;
  scenario: Scenario;
  /** result of the last run, and the edits (JSON) it was run for */
  result: RunResult | null;
  resultKey: string | null;
  /** the scenario the result was run for (the editor may have moved on since) */
  resultScenario: Scenario | null;
  run: RunState;
  /** a new line being drawn on the map */
  draft: Draft | null;
  /** route key while clicking its line on the map adds a stop */
  addStop: string | null;
  /** phone layout: is the bottom sheet expanded */
  sheet: 'peek' | 'half' | 'full';
  sidebarOpen: boolean;
  /** experimental: Saturday and Sunday models are offered (off by default; see weekendsFlag) */
  weekends: boolean;
  /** map layer: street speeds (cars) */
  showSpeeds: boolean;
  /** bumped when the road network has loaded */
  roads: number;
}

export const state: AppState = {
  period: 'day',
  day: 'wkd',
  base: null as unknown as RunResult, // set at start-up from the engine
  tab: 'overview',
  route: null,
  colorBy: 'route',
  zoneLayer: 'none',
  showStops: true,
  view: 'base',
  scenario: { name: 'My scenario', edits: [] },
  result: null,
  resultKey: null,
  resultScenario: null,
  run: { status: 'idle', stage: '', frac: 0 },
  draft: null,
  addStop: null,
  sheet: 'half',
  sidebarOpen: true,
  weekends: weekendsFlag(),
  runMode: savedRunMode(),
  showSpeeds: false,
  roads: 0,
};

const WEEKENDS_KEY = 'beta3.weekends';
const RUN_MODE_KEY = 'beta3.runMode';

/** the run mode chosen in this browser before, else the default (Quick) */
export function savedRunMode(): RunMode {
  try {
    const v = localStorage.getItem(RUN_MODE_KEY);
    return RUN_MODE_LIST.includes(v as RunMode) ? (v as RunMode) : DEFAULT_RUN_MODE;
  } catch {
    return DEFAULT_RUN_MODE;
  }
}

/** remember the run mode in this browser */
export function saveRunMode(m: RunMode): void {
  try {
    localStorage.setItem(RUN_MODE_KEY, m);
  } catch {
    /* private window: the choice lasts for this visit */
  }
}

/** The weekend models are experimental: offered when switched on here before, or with ?weekends=1. */
function weekendsFlag(): boolean {
  const q = new URLSearchParams(location.search).get('weekends');
  if (q !== null) return q !== '0';
  try {
    return localStorage.getItem(WEEKENDS_KEY) === '1';
  } catch {
    return false;
  }
}

/** remember the weekend switch in this browser */
export function saveWeekends(on: boolean): void {
  try {
    localStorage.setItem(WEEKENDS_KEY, on ? '1' : '0');
  } catch {
    /* private window: the switch lasts for this visit */
  }
}

type Key = keyof AppState;
type Listener = (changed: Set<Key>) => void;
const listeners: Listener[] = [];
let pending: Set<Key> | null = null;

/** Update state; listeners run once per animation frame with the set of keys that changed. */
export function set(patch: Partial<AppState>): void {
  let any = false;
  for (const k of Object.keys(patch) as Key[]) {
    if (state[k] === patch[k]) continue;
    (state as unknown as Record<string, unknown>)[k] = patch[k];
    (pending ??= new Set()).add(k);
    any = true;
  }
  if (any) schedule();
}

/** mark a key as changed after mutating it in place (e.g. the draft) */
export function touch(...keys: Key[]): void {
  for (const k of keys) (pending ??= new Set()).add(k);
  schedule();
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const changed = pending;
    pending = null;
    if (changed) for (const l of listeners) l(changed);
  });
}

export function subscribe(l: Listener): void {
  listeners.push(l);
}

/** the scenario's key: a result is current when it was run for exactly these edits on this day, in this run mode */
export const editsKey = (s: Scenario = state.scenario, mode: RunMode = s.runMode ?? state.runMode) => JSON.stringify([s.day ?? 'wkd', s.edits, cleanContext(s.context), !!s.traffic, mode]);
/** the last result was run for these edits, in the other run mode */
export const resultOtherMode = () => !!state.result && state.resultKey === editsKey(state.scenario, state.runMode === 'quick' ? 'precise' : 'quick');
export const resultCurrent = () => !!state.result && state.resultKey === editsKey();
/** the day a result was run for */
export const resultDay = (): DayType => state.resultScenario?.day ?? 'wkd';
/** the last result, if it was run for the day on show (the map and route views compare with it) */
export const shownResult = (): RunResult | null => (state.result && resultDay() === state.day ? state.result : null);

/** baselines loaded so far, by day (the weekday one is always there) */
export const bases: Partial<Record<DayType, RunResult>> = {};
export const baseOf = (d: DayType): RunResult => bases[d] ?? bases.wkd!;
/** the Quick baselines loaded so far, by day */
export const quickBases: Partial<Record<DayType, RunResult>> = {};
/** today's network for a day as a run mode makes it (a scenario is compared with the one made like it) */
export const baseIn = (d: DayType, mode: RunMode | undefined): RunResult => (mode === 'quick' ? quickBases[d] : undefined) ?? baseOf(d);
/** what the last result is compared with */
export const resultBase = (): RunResult => baseIn(resultDay(), state.result?.runMode);
