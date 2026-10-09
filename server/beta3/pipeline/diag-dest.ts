/**
 * Diagnostic: where trips go. For each market (residents' tours by purpose, their stop legs,
 * in-commuters, visitors, regional visitors, air travelers), the transit trips by neighborhood at
 * either end (each trip counted half at each end), and for all modes the trips arriving in each
 * neighborhood. No assignment, so it runs in a couple of minutes.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-dest.ts [--json out.json]
 */
import fs from 'node:fs';
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS, prepare } from '../../../shared/beta3/model';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const markets: Record<string, Record<TPeriod, Float32Array>> = {};
  const d = computeDemand(b, prepare(b), sk as never, calib, 'wkd', 1, markets);
  const NZ = H.zones.length, NX = H.ext.length, Z = NZ + 2 * NX;
  const nh = (i: number) => (i < NZ ? H.zones[i].nhood : 'outside');
  const out: Record<string, Record<string, number>> = {};
  for (const [k, byP] of Object.entries(markets)) {
    const t: Record<string, number> = {};
    for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
      const od = byP[p];
      if (!od) continue;
      for (let o = 0; o < Z; o++)
        for (let q = 0; q < Z; q++) {
          const v = od[o * Z + q];
          if (!v) continue;
          t[nh(o)] = (t[nh(o)] ?? 0) + v / 2;
          t[nh(q)] = (t[nh(q)] ?? 0) + v / 2;
        }
    }
    out[`transit: ${k}`] = t;
  }
  const visits: Record<string, number> = {}, leisure: Record<string, number> = {};
  H.zones.forEach((z, i) => {
    visits[z.nhood] = (visits[z.nhood] ?? 0) + d.zoneVisits[i];
    leisure[z.nhood] = (leisure[z.nhood] ?? 0) + d.zoneVisitsLeisure[i];
  });
  out['all modes: trips arriving'] = visits;
  out['all modes: social, visitor and regional trips arriving'] = leisure;
  for (const [k, t] of Object.entries(out)) {
    const tot = Object.values(t).reduce((a, v) => a + v, 0);
    const top = Object.entries(t).sort((x, y) => y[1] - x[1]).slice(0, 14);
    console.log(`${k} (${Math.round(tot)}): ${top.map(([n, v]) => `${n} ${((100 * v) / tot).toFixed(1)}%`).join(', ')}`);
  }
  const i = process.argv.indexOf('--json');
  if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
