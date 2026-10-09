/**
 * Where a run's time goes, in Node: the stages of runModel timed in CPU seconds of this process (the
 * machine may be busy; Node runs the model on one thread), by wrapping the methods that do the work:
 * the transit path searches and their parts, transit loading, demand, and each road feedback step
 * with its all-or-nothing loadings and skims. Used by runmodes.ts.
 */
import { StrategySolver } from '../../../shared/beta3/strategy';
import { Traffic } from '../../../shared/beta3/traffic';
import { LocalExecutor } from '../../../shared/beta3/model';
import type { RoadAon } from '../../../shared/beta3/roads';

const now = () => process.cpuUsage().user / 1000;
const T: Record<string, number> = {};
const N: Record<string, number> = {};
const add = (k: string, ms: number) => ((T[k] = (T[k] ?? 0) + ms / 1000), (N[k] = (N[k] ?? 0) + 1));

/** wrap a prototype method so its time is added under `key` (nested time counts in both) */
function wrap(proto: object, name: string, key: string | ((self: unknown) => string)) {
  const p = proto as Record<string, (...a: unknown[]) => unknown>;
  const f = p[name];
  p[name] = function (this: unknown, ...a: unknown[]) {
    const t0 = now();
    const k = typeof key === 'string' ? key : key(this);
    const r = f.apply(this, a);
    if (r instanceof Promise) return r.finally(() => add(k, now() - t0));
    add(k, now() - t0);
    return r;
  };
}

let on = false;
/** start timing (once per process); returns the timer */
export function timing() {
  if (!on) {
    on = true;
    const S = StrategySolver.prototype;
    wrap(S, 'search', (s) => ((s as { xfer: boolean }).xfer ? 'transit paths: second search (transfer logit)' : 'transit paths: first search'));
    wrap(S, 'transferBranch', 'transit paths: transfer branch');
    wrap(S, 'egressBranch', 'transit paths: egress branch');
    wrap(S, 'load', 'transit loading: sweeps');
    wrap(LocalExecutor.prototype, 'skim', 'transit skims (all)');
    wrap(LocalExecutor.prototype, 'assign', 'transit loading (all)');
    wrap(Traffic.prototype, 'step', 'roads: feedback steps (all)');
    wrap(Traffic.prototype, 'demandArrays', 'roads: skims for demand');
    wrap(Traffic.prototype, 'initialArrays', 'roads: first guess');
    wrap(Traffic.prototype, 'commercialChange', 'roads: commercial vehicles');
  }
  return {
    reset: () => {
      for (const k of Object.keys(T)) delete T[k], delete N[k];
    },
    /** seconds and calls by stage */
    get: () => Object.fromEntries(Object.entries(T).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { s: +v.toFixed(2), calls: N[k] }])),
    /** time a function under a key (demand, the road loadings) */
    time: <A extends unknown[], R>(key: string, f: (...a: A) => R) => (...a: A): R => {
      const t0 = now();
      const r = f(...a);
      if (r instanceof Promise) return r.finally(() => add(key, now() - t0)) as R;
      add(key, now() - t0);
      return r;
    },
    aon: (aon: RoadAon): RoadAon => async (p, c, od) => {
      const t0 = now();
      const r = await aon(p, c, od);
      add('roads: all-or-nothing loadings', now() - t0);
      return r;
    },
  };
}
