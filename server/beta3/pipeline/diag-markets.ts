/**
 * Diagnostic: transit trips and boardings by market (residents' tours by purpose, their stop legs and
 * subtours, in-commuters, visitors, regional visitors, air travelers): linked trips, boardings by
 * operator, and Muni boardings per Muni-using trip. Each market's trips are assigned on their own
 * (assignment is linear in demand at fixed costs, uncrowded here).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-markets.ts
 */
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare, SKIM_PERIODS } from '../../../shared/beta3/model';
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
  computeDemand(b, prepare(b), sk as never, calib, 'wkd', 1, markets);
  const rows: [string, number, Record<string, number>][] = [];
  for (const [k, byP] of Object.entries(markets)) {
    if (k.startsWith('work ')) continue; // commute flows by mode (all modes), not transit trips
    let trips = 0;
    const on: Record<string, number> = {};
    for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
      const od = byP[p];
      if (!od) continue;
      for (let i = 0; i < od.length; i++) trips += od[i];
      const vol = await exec.assign(p, od, undefined);
      const net = exec.net(p);
      for (let a = 0; a < net.nLinks; a++) if (vol[a] && net.type[a] === 4) { const f = net.lines[net.line[a]].feed; on[f] = (on[f] ?? 0) + vol[a]; }
    }
    rows.push([k, trips, on]);
  }
  rows.sort((a, c) => (c[2].muni ?? 0) - (a[2].muni ?? 0));
  let T = 0, MU = 0;
  console.log('market                      linked trips  Muni boardings  all boardings  boardings/trip   by operator');
  for (const [k, t, on] of rows) {
    const all = Object.values(on).reduce((a, v) => a + v, 0);
    T += t; MU += on.muni ?? 0;
    console.log(`${k.padEnd(28)}${Math.round(t).toString().padStart(12)}${Math.round(on.muni ?? 0).toString().padStart(16)}${Math.round(all).toString().padStart(15)}${(all / Math.max(1, t)).toFixed(2).padStart(16)}   ${Object.entries(on).sort((a, c) => c[1] - a[1]).map(([f, v]) => `${f} ${Math.round(v)}`).join(', ')}`);
  }
  console.log(`total linked ${Math.round(T)}, Muni boardings ${Math.round(MU)}`);
}
main();
