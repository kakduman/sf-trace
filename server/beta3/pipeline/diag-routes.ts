/**
 * Diagnostic: who rides chosen Muni routes, and where the model's shortfall on them sits.
 *  1. Boardings by the district of the stop, the model against SFMTA's 2006–07 stop counts (TEP;
 *     muni-stop-ridership.json) taken as shares and scaled to today's count of the route group.
 *  2. Boardings by market (residents' tours by purpose, stop legs, in-commuters, visitors...).
 *  3. Productions and attractions: residents' home-based riders by the district of the activity end
 *     (their legs out, whose destination is the activity) and of the home end (their legs back, whose
 *     destination is home). Each market is assigned destination by destination at the base run's
 *     crowding, as od-checks.ts does.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-routes.ts [--json out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildNet, LINK_BOARD } from '../../../shared/beta3/net';
import { prepare } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { StrategySolver } from '../../../shared/beta3/strategy';
import { toXY } from '../../../shared/beta3/geo';
import type { TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';
import { DISTRICTS, modelState, zoneDistricts } from './od-checks';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
export const ROUTE_GROUPS: [string, string[]][] = [
  ['Mission St (14, 14R, 49)', ['14', '14R', '49']],
  ['8 Bayshore', ['8', '8AX', '8BX']],
  ['T Third', ['T']],
  ['9, 9R San Bruno', ['9', '9R']],
  ['38, 38R Geary', ['38', '38R']],
  ['5, 5R Fulton', ['5', '5R']],
  ['N Judah', ['N']],
];

async function main() {
  const b = loadBundle();
  const H = b.header, NZ = H.zones.length;
  const calib = H.calibration!;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const crowd = base.finalCrowd;
  const st = await modelState(b, calib, prepare(b), crowd);
  const dist = zoneDistricts(b);
  const DN = [...DISTRICTS.map((d) => d[0]), 'Outside the city'];
  const dOf = (z: number) => (z < NZ ? dist[z] : DN.length - 1);
  const nearestZone = (x: number, y: number) => {
    let best = 0, bd = Infinity;
    H.zones.forEach((z, i) => {
      const d = (z.x - x) ** 2 + (z.y - y) ** 2;
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  };
  const stopDist = H.stops.map((s) => dist[nearestZone(s.x, s.y)]);
  const groupOf = new Map<string, number>();
  ROUTE_GROUPS.forEach(([, rs], g) => rs.forEach((r) => groupOf.set(r, g)));
  const G = ROUTE_GROUPS.length, D = DN.length;
  const byStop = ROUTE_GROUPS.map(() => new Float64Array(D));
  const byMarket = ROUTE_GROUPS.map(() => new Map<string, number>());
  const actEnd = ROUTE_GROUPS.map(() => new Float64Array(D)), homeEnd = ROUTE_GROUPS.map(() => new Float64Array(D));
  const sc = { name: 'Today', edits: [] };
  for (const p of TPERIODS as readonly TPeriod[]) {
    const net0 = buildNet(b, sc, p, calib);
    const cr = net0.lines.map((l) => (l.src >= 0 && crowd?.[p]?.[l.src] && [1, 2, 4].some((m) => crowd[p][l.src].length === m * l.stops.length - 1) ? crowd[p][l.src] : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1)));
    const net = buildNet(b, sc, p, calib, cr);
    const boards: [number, number, number][] = []; // link, group, stop district
    for (let a = 0; a < net.nLinks; a++) {
      if (net.type[a] !== LINK_BOARD) continue;
      const l = net.lines[net.line[a]];
      if (l.feed !== 'muni') continue;
      const g = groupOf.get(l.route);
      if (g === undefined) continue;
      boards.push([a, g, stopDist[l.stops[net.pos[a]]] ?? 0]);
    }
    const solver = new StrategySolver(net);
    const Z = net.nZones;
    for (const [mk, byP] of Object.entries(st.markets)) {
      if (mk.startsWith('work ')) continue;
      const od = byP[p];
      if (!od) continue;
      const home = /^resident (work|shop|other|social|school|univ|event)( return)?$/.exec(mk);
      for (let d = 0; d < Z; d++) {
        let any = false;
        for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) (any = true), (o = Z);
        if (!any) continue;
        solver.solve(d);
        solver.resetVolumes();
        solver.load((o) => od[o * Z + d]);
        const v = solver.linkVol;
        const per = new Float64Array(G);
        for (const [a, g, sd] of boards) {
          if (!v[a]) continue;
          per[g] += v[a];
          byStop[g][sd] += v[a];
        }
        for (let g = 0; g < G; g++) {
          if (!per[g]) continue;
          byMarket[g].set(mk, (byMarket[g].get(mk) ?? 0) + per[g]);
          if (home) (home[2] ? homeEnd : actEnd)[g][dOf(d)] += per[g];
        }
      }
    }
  }
  // the 2006–07 counts by stop district, scaled to today's counted total of the group
  const T = JSON.parse(fs.readFileSync(`${REFERENCE}/muni-stop-ridership.json`, 'utf8'));
  const counted = new Map(H.observed.muniRoutes.map((r) => [r.route, r.boardings]));
  const tepRoute: Record<string, string> = { T: 'KT' };
  const out = ROUTE_GROUPS.map(([name, rs], g) => {
    const tep = new Float64Array(D);
    for (const r of T.rows as { route: string; lat: number | null; lon: number | null; boardings: number }[]) {
      if (!rs.some((x) => (tepRoute[x] ?? x) === r.route) || r.lat == null) continue;
      const z = nearestZone(...toXY(r.lat, r.lon!));
      tep[dist[z]] += r.boardings;
    }
    const tt = tep.reduce((a, v) => a + v, 0);
    const obs = rs.reduce((a, r) => a + (counted.get(r) ?? 0), 0);
    const mod = byStop[g].reduce((a, v) => a + v, 0);
    const mk = [...byMarket[g]].sort((a, c) => c[1] - a[1]);
    return {
      group: name,
      counted: obs,
      model: Math.round(mod),
      byStopDistrict: DN.slice(0, -1).map((n, k) => ({ district: n, model: Math.round(byStop[g][k]), tep2006Scaled: tt > 0 ? Math.round((obs * tep[k]) / tt) : null })).filter((x) => x.model > 50 || (x.tep2006Scaled ?? 0) > 50),
      byMarket: mk.map(([k, v]) => ({ market: k, boardings: Math.round(v) })),
      residentsByActivityDistrict: DN.map((n, k) => ({ district: n, boardings: Math.round(actEnd[g][k]) })).filter((x) => x.boardings > 50),
      residentsByHomeDistrict: DN.map((n, k) => ({ district: n, boardings: Math.round(homeEnd[g][k]) })).filter((x) => x.boardings > 50),
    };
  });
  for (const r of out) {
    console.log(`== ${r.group}: model ${r.model} / counted ${r.counted}`);
    console.log(`  by stop district (model / 2006–07 shares × today's count): ${r.byStopDistrict.map((x) => `${x.district} ${x.model}/${x.tep2006Scaled ?? '–'}`).join(', ')}`);
    console.log(`  by market: ${r.byMarket.slice(0, 12).map((x) => `${x.market} ${x.boardings}`).join(', ')}`);
    console.log(`  residents' home-based, activity end: ${r.residentsByActivityDistrict.map((x) => `${x.district} ${x.boardings}`).join(', ')}`);
    console.log(`  residents' home-based, home end: ${r.residentsByHomeDistrict.map((x) => `${x.district} ${x.boardings}`).join(', ')}`);
  }
  const jf = arg('--json', '');
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
}

if (process.argv[1]?.endsWith('diag-routes.ts')) main();
