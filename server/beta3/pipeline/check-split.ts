/**
 * Check that demand split by origin (as the browser's workers run it) and merged gives the same
 * result as one computeDemand over the whole city: every tally and transit matrix to a relative
 * 1e-9 (the parts add up in a different order, so not always to the last bit).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/check-split.ts [parts=4] [wkd|sat|sun] [abm|abm-observed]
 */
import { ABM, computeDemand, demandPart, finishDemand, prepare } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import type { DayType } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

/** the largest relative difference between two results, field by field */
function maxDiff(a: unknown, b: unknown, path = '', out = { rel: 0, at: '', n: 0 }): typeof out {
  const cmp = (x: number, y: number, at: string) => {
    if (x === y || (Number.isNaN(x) && Number.isNaN(y))) return;
    const r = Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y));
    out.n++;
    if (!(r <= out.rel)) (out.rel = r), (out.at = at);
  };
  if (typeof a === 'number') cmp(a, b as number, path);
  else if (ArrayBuffer.isView(a)) {
    const x = a as unknown as Float64Array, y = b as unknown as Float64Array;
    if (x.length !== y.length) throw new Error(`${path}: lengths differ`);
    for (let i = 0; i < x.length; i++) cmp(x[i], y[i], `${path}[${i}]`);
  } else if (a && typeof a === 'object') {
    const keys = Object.keys(a);
    if (keys.sort().join() !== Object.keys(b as object).sort().join()) throw new Error(`${path}: fields differ`);
    for (const k of keys) maxDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  }
  return out;
}

async function main() {
  const parts = Number(process.argv[2] ?? 4);
  const day = (process.argv[3] ?? 'wkd') as DayType;
  // a fourth argument: 'abm' (person-level choices, chosen workplaces) or 'abm-observed' (census workplaces); else the aggregate rates
  if (process.argv[4]?.startsWith('abm')) ((ABM.on = true), (ABM.workplace = process.argv[4] === 'abm-observed' ? 'observed' : 'choice'));
  else ABM.on = false;
  const b = loadBundle();
  const calib = b.header.calibration!;
  const prep = prepare(b);
  const exec = new LocalExecutor(b, { name: 'Today', edits: [], day }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  let t = performance.now();
  const whole = computeDemand(b, prep, sk as never, calib, day);
  console.log(`computeDemand: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const ps = [];
  for (let i = 0; i < parts; i++) {
    t = performance.now();
    ps.push(demandPart(b, prep, sk as never, calib, day, 1, { index: i, count: parts }));
    console.log(`part ${i + 1} of ${parts}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }
  const split = finishDemand(b, calib, ps);
  const d = maxDiff(split, whole);
  console.log(`${d.n} values differ; largest relative difference ${d.rel.toExponential(2)}${d.at ? ` (${d.at})` : ''}`);
  if (d.rel > 1e-9) process.exit(1);
}

main();
