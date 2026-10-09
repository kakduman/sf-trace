/**
 * Diagnostic: the transit trips to and from one neighborhood (or between two), and the lines that
 * carry them, from an assignment of only those trips.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-od.ts "<nhood>" ["<other nhood>"]
 *   [--market event] only one market's trips (keys ending in it: "event" and "resident event")
 *   [--from exp.json] with the constants an experiment refitted (distance terms, event transit)
 */
import fs from 'node:fs';
import { computeDemand, prepare } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { LINK_BOARD } from '../../../shared/beta3/net';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const market = opt('--market'), from = opt('--from');
  const [a, bName] = argv;
  if (!a) throw new Error('usage: diag-od.ts "<nhood>" ["<other nhood>"]');
  const b = loadBundle();
  const H = b.header;
  const calib = JSON.parse(JSON.stringify(H.calibration!));
  if (from) {
    const j = JSON.parse(fs.readFileSync(from, 'utf8'));
    Object.assign(calib, j.refit ?? { eventTransit: j.eventTransit });
  }
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const markets: Record<string, Record<TPeriod, Float32Array>> = {};
  const d = computeDemand(b, prepare(b), sk as never, calib, 'wkd', 1, market ? markets : undefined);
  const odOf = (p: TPeriod) => {
    if (!market) return d.transitOD[p];
    const sum = new Float32Array(d.transitOD[p].length);
    for (const [k, m] of Object.entries(markets)) if (k === market || k.endsWith(` ${market}`)) m[p]?.forEach((v, i) => (sum[i] += v));
    return sum;
  };
  const NZ = H.zones.length, Z = NZ + 2 * H.ext.length; // transit zones (net.ts transitZones)
  const inA = new Uint8Array(Z), inB = new Uint8Array(Z);
  // without a second neighborhood, the other end is anywhere, outside the city too
  if (!bName) inB.fill(1);
  H.zones.forEach((z, i) => ((inA[i] = z.nhood === a ? 1 : 0), (inB[i] = bName ? (z.nhood === bName ? 1 : 0) : 1)));
  const lines = new Map<string, number>();
  const dests = new Map<string, number>();
  let trips = 0;
  const nhoodOf = (i: number) => (i < NZ ? H.zones[i].nhood : i < NZ + H.ext.length ? 'outside the city (home end)' : 'outside the city (activity end)');
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const od = new Float32Array(Z * Z);
    const src = odOf(p);
    for (let o = 0; o < Z; o++)
      for (let q = 0; q < Z; q++) {
        const v = src[o * Z + q];
        if (!v) continue;
        // trips with one end in A and the other in B (either way round)
        if (!((inA[o] && inB[q]) || (inB[o] && inA[q]))) continue;
        od[o * Z + q] = v;
        trips += v;
        const other = inA[o] ? nhoodOf(q) : nhoodOf(o);
        dests.set(other, (dests.get(other) ?? 0) + v);
      }
    const vol = await exec.assign(p, od, undefined);
    const net = exec.net(p);
    for (let k = 0; k < net.nLinks; k++)
      if (vol[k] && net.type[k] === LINK_BOARD) {
        const l = net.lines[net.line[k]];
        const key = `${l.feed}:${l.route}`;
        lines.set(key, (lines.get(key) ?? 0) + vol[k]);
      }
  }
  const top = (m: Map<string, number>, n: number) => [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
  console.log(`transit trips with one end in ${a}${bName ? ` and the other in ${bName}` : ''}: ${Math.round(trips)}`);
  console.log(`other end: ${top(dests, 12)}`);
  console.log(`boardings by line: ${top(lines, 16)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
