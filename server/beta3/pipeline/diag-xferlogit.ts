/**
 * Diagnostic for the transfer logit (PATH.transferLogit): search time per destination with one,
 * two, and three passes, and how far the second pass's labels are from the third's (the fixed point).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-xferlogit.ts [period] [destinations]
 */
import { buildNet } from '../../../shared/beta3/net';
import { PATH } from '../../../shared/beta3/params';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

const b = loadBundle();
const H = b.header;
const p = (process.argv[2] ?? 'AM') as TPeriod;
const nd = Number(process.argv[3] ?? 60);
const net = buildNet(b, { name: 'Today', edits: [] }, p, H.calibration ?? null);
const Z = net.nZones;
const step = Math.max(1, Math.floor(Z / nd));
const dests = Array.from({ length: Math.ceil(Z / step) }, (_, i) => i * step).filter((d) => d < Z);
const labels = new Map<number, Float64Array[]>();
for (const passes of [1, 2, 3]) {
  PATH.transferLogit = passes > 1;
  PATH.transferPasses = passes;
  const s = new StrategySolver(net);
  s.solve(dests[0]);
  const t0 = performance.now();
  const out: Float64Array[] = [];
  for (const d of dests) {
    s.solve(d);
    out.push(Float64Array.from({ length: Z }, (_, o) => s.u[o]));
  }
  const ms = (performance.now() - t0) / dests.length;
  labels.set(passes, out);
  console.log(`${p}: ${passes} pass(es): ${ms.toFixed(1)} ms per destination (${dests.length} destinations)`);
}
const diff = (a: Float64Array[], c: Float64Array[]) => {
  let max = 0, sum = 0, n = 0, over1 = 0;
  for (let i = 0; i < a.length; i++)
    for (let o = 0; o < Z; o++) {
      if (!(a[i][o] < Infinity) || !(c[i][o] < Infinity)) continue;
      const x = Math.abs(a[i][o] - c[i][o]);
      max = Math.max(max, x);
      sum += x;
      n++;
      if (x > 1) over1++;
    }
  return `mean ${(sum / n).toFixed(3)} min, max ${max.toFixed(2)} min, over a minute ${((100 * over1) / n).toFixed(2)}%`;
};
console.log(`zone labels, 1 pass vs 2: ${diff(labels.get(1)!, labels.get(2)!)}`);
console.log(`zone labels, 2 passes vs 3: ${diff(labels.get(2)!, labels.get(3)!)}`);
