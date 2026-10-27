/**
 * Run results in a compact binary form (same container as the bundle), so the page can load the
 * baseline instantly instead of computing it. Saved runs (client/beta3/savedRuns.ts) use the same
 * parts in a container of their own.
 */
import { decodeBundle, encodeBundle } from './bundle';
import type { BundleHeader, LineResult, RunResult, TrafficResult } from './types';
import { TPERIODS } from './types';

type ResultHeader = { scenario: string; runMode?: RunResult['runMode']; roadResponse?: RunResult['roadResponse']; summary: RunResult['summary']; ms: number; bundleId?: string; finalLotPrice?: Record<number, number>; lines: Omit<LineResult, 'loads'>[]; traffic?: Omit<TrafficResult, 'flow' | 'time'> };

/** a result as a JSON header and its typed arrays */
export function resultParts(r: RunResult): { header: ResultHeader; arrays: Record<string, Float32Array> } {
  const arrays: Record<string, Float32Array> = { stopOn: r.stopOn, stopOff: r.stopOff, zoneTransitShare: r.zoneTransitShare, zoneJobs45: r.zoneJobs45, zoneLogsum: r.zoneLogsum };
  for (const p of TPERIODS) {
    if (r.stopOnBy?.[p]) arrays[`sOn${p}`] = r.stopOnBy[p];
    if (r.stopOffBy?.[p]) arrays[`sOff${p}`] = r.stopOffBy[p];
  }
  r.lines.forEach((l, i) => {
    for (const p of TPERIODS) if (l.loads[p]) arrays[`l${i}${p}`] = l.loads[p];
  });
  if (r.finalCrowd) for (const p of TPERIODS) for (const [src, c] of Object.entries(r.finalCrowd[p] ?? {})) arrays[`c${p}:${src}`] = c;
  let traffic: ResultHeader['traffic'];
  if (r.traffic) {
    const { flow, time, ...rest } = r.traffic;
    for (const p of TPERIODS) {
      if (flow[p]) arrays[`tf${p}`] = flow[p];
      if (time[p]) arrays[`tt${p}`] = time[p];
    }
    traffic = rest;
  }
  const header: ResultHeader = {
    scenario: r.scenario,
    ...(r.runMode ? { runMode: r.runMode } : {}),
    ...(r.roadResponse ? { roadResponse: r.roadResponse } : {}),
    summary: r.summary,
    ms: r.ms,
    bundleId: r.bundleId,
    ...(r.finalLotPrice ? { finalLotPrice: r.finalLotPrice } : {}),
    lines: r.lines.map((l) => ({ ...l, loads: undefined })),
    ...(traffic ? { traffic } : {}),
  };
  return { header, arrays };
}

/** the result from its header and arrays (resultParts) */
export function resultFromParts(header: unknown, a: Record<string, unknown>): RunResult {
  const h = header as ResultHeader;
  const crowdKeys = Object.keys(a).filter((k) => /^c[A-Z]+:/.test(k));
  return {
    scenario: h.scenario,
    ...(h.runMode ? { runMode: h.runMode } : {}),
    ...(h.roadResponse ? { roadResponse: h.roadResponse } : {}),
    bundleId: h.bundleId,
    ...(h.finalLotPrice ? { finalLotPrice: h.finalLotPrice } : {}),
    summary: h.summary,
    ms: h.ms,
    lines: h.lines.map((l, i) => {
      const loads = {} as LineResult['loads'];
      for (const p of TPERIODS) loads[p] = (a[`l${i}${p}`] as Float32Array) ?? new Float32Array(0);
      return { ...l, loads };
    }),
    stopOn: a.stopOn as Float32Array,
    stopOff: a.stopOff as Float32Array,
    ...(a.sOnAM ? { stopOnBy: Object.fromEntries(TPERIODS.map((p) => [p, a[`sOn${p}`] as Float32Array])) as RunResult['stopOnBy'], stopOffBy: Object.fromEntries(TPERIODS.map((p) => [p, a[`sOff${p}`] as Float32Array])) as RunResult['stopOffBy'] } : {}),
    zoneTransitShare: a.zoneTransitShare as Float32Array,
    zoneJobs45: a.zoneJobs45 as Float32Array,
    zoneLogsum: a.zoneLogsum as Float32Array,
    ...(crowdKeys.length
      ? {
          finalCrowd: Object.fromEntries(
            TPERIODS.map((p) => [p, Object.fromEntries(crowdKeys.filter((k) => k.startsWith(`c${p}:`)).map((k) => [Number(k.slice(k.indexOf(':') + 1)), a[k] as Float32Array]))]),
          ) as RunResult['finalCrowd'],
        }
      : {}),
    ...(h.traffic
      ? {
          traffic: {
            ...h.traffic,
            flow: Object.fromEntries(TPERIODS.map((p) => [p, (a[`tf${p}`] as Float32Array) ?? new Float32Array(0)])) as TrafficResult['flow'],
            time: Object.fromEntries(TPERIODS.map((p) => [p, (a[`tt${p}`] as Float32Array) ?? new Float32Array(0)])) as TrafficResult['time'],
          },
        }
      : {}),
  };
}

export function encodeResult(r: RunResult): Uint8Array {
  const { header, arrays } = resultParts(r);
  return encodeBundle(header as unknown as Omit<BundleHeader, 'arrays'>, arrays);
}

export function decodeResult(bytes: Uint8Array): RunResult {
  const { header, a } = decodeBundle(bytes);
  return resultFromParts(header, a);
}
