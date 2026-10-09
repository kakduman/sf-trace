/**
 * Diagnostic: where Caltrain's San Francisco boardings (and ferry boardings) come from, by kind of
 * trip: SF→outside, outside→SF, within SF, and by purpose class of the external zone.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-caltrain.ts
 */
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare, SKIM_PERIODS } from '../../../shared/beta3/model';
import { boardStop } from '../../../shared/beta3/net';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const prep = prepare(b);
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const d = computeDemand(b, prep, sk as never, calib);
  const NZ = H.zones.length, Z = NZ + 2 * H.ext.length; // transit zones (net.ts transitZones)
  const sfCt = new Set(H.stops.map((s, i) => (s.feed === 'caltrain' && /^(San Francisco|22nd Street|Bayshore)/.test(s.name) ? i : -1)).filter((i) => i >= 0));
  const classes: Record<string, (o: number, dd: number) => boolean> = {
    'SF→SF': (o, dd) => o < NZ && dd < NZ,
    'SF→out': (o, dd) => o < NZ && dd >= NZ,
    'out→SF': (o, dd) => o >= NZ && dd < NZ,
    'out→out': (o, dd) => o >= NZ && dd >= NZ,
  };
  const res: Record<string, { ctSF: number; ctAll: number; ferry: number; trips: number }> = {};
  for (const [name, f] of Object.entries(classes)) {
    const r = (res[name] = { ctSF: 0, ctAll: 0, ferry: 0, trips: 0 });
    for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
      const od = new Float32Array(d.transitOD[p].length);
      for (let o = 0; o < Z; o++) for (let q = 0; q < Z; q++) if (f(o, q)) { od[o * Z + q] = d.transitOD[p][o * Z + q]; r.trips += od[o * Z + q]; }
      const vol = await exec.assign(p, od, undefined);
      const net = exec.net(p);
      for (let a = 0; a < net.nLinks; a++) {
        if (!vol[a] || net.type[a] !== 4) continue;
        const l = net.lines[net.line[a]];
        const st = boardStop(net, a);
        if (l.feed === 'caltrain') { r.ctAll += vol[a]; if (sfCt.has(st)) r.ctSF += vol[a]; }
        if (l.mode === 'ferry') r.ferry += vol[a];
      }
    }
  }
  // SF→outside by period (AM: mostly residents leaving for work; PM: mostly in-commuters going home), and by county
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const od = new Float32Array(d.transitOD[p].length);
    const byCounty: Record<string, number> = {};
    for (let o = 0; o < NZ; o++) for (let q = NZ; q < Z; q++) { const v = d.transitOD[p][o * Z + q]; od[o * Z + q] = v; const c = H.ext[(q - NZ) % H.ext.length].county; byCounty[c] = (byCounty[c] ?? 0) + v; }
    const vol = await exec.assign(p, od, undefined);
    const net = exec.net(p);
    let ct = 0;
    for (let a = 0; a < net.nLinks; a++) if (vol[a] && net.type[a] === 4 && net.lines[net.line[a]].feed === 'caltrain' && sfCt.has(boardStop(net, a))) ct += vol[a];
    console.log(`SF→out ${p}: Caltrain SF boardings ${Math.round(ct)}; transit trips by county ${Object.entries(byCounty).map(([c, v]) => `${c} ${Math.round(v)}`).join(', ')}`);
  }
  for (const [k, v] of Object.entries(res)) console.log(`${k.padEnd(8)} transit trips ${Math.round(v.trips)}  Caltrain boardings at SF stations ${Math.round(v.ctSF)}  all Caltrain ${Math.round(v.ctAll)}  ferry ${Math.round(v.ferry)}`);
  // out-commuting by residents to the Peninsula / South Bay, and its transit share
  console.log('work by segment', JSON.stringify(d.workBySeg).slice(0, 600));
  // external zones by Caltrain boardings would need per-zone runs; list biggest outside→SF transit producers instead
  const prod = H.ext.map((x, e) => { let t = 0; for (let q = 0; q < NZ; q++) for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) t += d.transitOD[p][(NZ + e) * Z + q] + d.transitOD[p][q * Z + NZ + e]; return [x.name, Math.round(t)] as const; }).sort((a, c) => c[1] - a[1]);
  console.log('top external zones by transit trips to/from SF:', prod.slice(0, 25).map((p) => `${p[0]} ${p[1]}`).join(', '));
}
main();
