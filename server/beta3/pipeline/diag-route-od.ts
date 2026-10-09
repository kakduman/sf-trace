/**
 * Diagnostic: who rides chosen Muni routes. Each market's transit trips (residents' tours by
 * purpose, stop legs, in-commuters, visitors...) are assigned on their own, destination by
 * destination, and the routes' boardings are kept by market and by the trip's two ends (the zone it
 * leaves and the zone it goes to, kept apart by destination; origins by the reverse direction of
 * home-based trips). Uncrowded, so totals differ a little from a full run.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-route-od.ts <route> [route ...]
 */
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare } from '../../../shared/beta3/model';
import { LINK_BOARD } from '../../../shared/beta3/net';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

async function main() {
  const want = new Set(process.argv.slice(2));
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of ['AM', 'MD', 'PM'] as const) sk[p] = await exec.skim(p, undefined);
  const markets: Record<string, Record<TPeriod, Float32Array>> = {};
  computeDemand(b, prepare(b), sk as never, calib, 'wkd', 1, markets);
  const NZ = H.zones.length;
  const name = (z: number) => (z < NZ ? `${H.zones[z].nhood} ${H.zones[z].id.slice(5)}` : z < NZ + H.ext.length ? `${H.ext[z - NZ].id} (home end)` : `${H.ext[z - NZ - H.ext.length].id} (activity end)`);
  const byMarket = new Map<string, number>();
  const byDest = new Map<number, number>();
  const byOrig = new Map<number, number>();
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const net = exec.net(p);
    const Z = net.nZones;
    const boardLinks: number[] = [];
    for (let a = 0; a < net.nLinks; a++) if (net.type[a] === LINK_BOARD && net.lines[net.line[a]].feed === 'muni' && want.has(net.lines[net.line[a]].route)) boardLinks.push(a);
    const solver = new StrategySolver(net);
    for (const [mk, byP] of Object.entries(markets)) {
      const od = byP[p];
      if (!od) continue;
      for (let d = 0; d < Z; d++) {
        let any = false;
        for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) { any = true; break; }
        if (!any) continue;
        solver.solve(d);
        solver.resetVolumes();
        solver.load((o) => od[o * Z + d]);
        let v = 0;
        for (const a of boardLinks) v += solver.linkVol[a];
        if (!(v > 1e-6)) continue;
        byMarket.set(mk, (byMarket.get(mk) ?? 0) + v);
        byDest.set(d, (byDest.get(d) ?? 0) + v);
        // attribute to origins where the destination matters: reload each origin with trips on its own
        if (v > 0.5) for (let o = 0; o < Z; o++) {
          const t = od[o * Z + d];
          if (!(t > 0.05)) continue;
          solver.resetVolumes();
          solver.load((q) => (q === o ? t : 0));
          let w = 0;
          for (const a of boardLinks) w += solver.linkVol[a];
          if (w > 1e-6) byOrig.set(o, (byOrig.get(o) ?? 0) + w);
        }
      }
    }
  }
  const top = (m: Map<number, number>) => [...m].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([z, v]) => `${name(z)} ${Math.round(v)}`).join('; ');
  console.log(`routes ${[...want].join(', ')}: by market ${[...byMarket].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
  console.log(`  to: ${top(byDest)}`);
  console.log(`  from: ${top(byOrig)}`);
}
main();
