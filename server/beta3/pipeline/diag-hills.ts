/**
 * Diagnostic: are Muni's hill routes missing riders? Each counted route's climb per km (the rises
 * between its consecutive stops, from the street network's elevations, summed over its patterns,
 * over their length) against the model's boardings relative to the count, the total scaled out. If
 * walking up hills were too cheap in the model, routes that carry riders up them (the 1, the 24, the
 * cable cars) would fall short more than flat ones.
 * Run: npx tsx server/beta3/pipeline/diag-hills.ts <experiment.json> [--json out.json]
 *   (BETA3_SF_BUNDLE: the bundle the experiment ran; BETA3_WORK: streets.json)
 */
import fs from 'node:fs';
import { WORK } from './paths';
import { loadBundle } from './run-base';
import { stats } from './stats';

const exp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as { routes: { route: string; obs: number; mod: number }[] };
const b = loadBundle();
const H = b.header;
const { vertices } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: { x: number; y: number; z: number }[] };
const CELL = 100;
const grid = new Map<string, number[]>();
vertices.forEach((v, i) => {
  const k = `${Math.floor(v.x / CELL)},${Math.floor(v.y / CELL)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
});
/** ground elevation at the nearest street vertex */
const elev = (x: number, y: number) => {
  let best = -1, bd = Infinity;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = Math.hypot(vertices[i].x - x, vertices[i].y - y);
        if (d < bd) (bd = d), (best = i);
      }
  return best >= 0 ? vertices[best].z : NaN;
};
const climb = new Map<string, { m: number; km: number }>();
for (const l of H.lines) {
  if (l.feed !== 'muni') continue;
  const z = l.stops.map((s) => elev(H.stops[s].x, H.stops[s].y));
  const r = climb.get(l.route) ?? { m: 0, km: 0 };
  for (let k = 1; k < z.length; k++) {
    r.m += Math.max(0, z[k] - z[k - 1]);
    r.km += Math.hypot(H.stops[l.stops[k]].x - H.stops[l.stops[k - 1]].x, H.stops[l.stops[k]].y - H.stops[l.stops[k - 1]].y) / 1000;
  }
  climb.set(l.route, r);
}
const rows = exp.routes.filter((x) => x.obs >= 1500 && climb.has(x.route)).map((x) => ({ route: x.route, obs: x.obs, mod: x.mod, climbPerKm: climb.get(x.route)!.m / climb.get(x.route)!.km }));
const scale = rows.reduce((a, x) => a + x.obs, 0) / rows.reduce((a, x) => a + x.mod, 0);
rows.sort((a, c) => c.climbPerKm - a.climbPerKm);
const lr = rows.map((x) => Math.log((x.mod * scale) / x.obs));
const s = stats(rows.map((x, i) => ({ obs: x.climbPerKm, mod: lr[i] })));
const thirds = [0, 1, 2].map((t) => {
  const g = rows.slice(Math.round((t * rows.length) / 3), Math.round(((t + 1) * rows.length) / 3));
  const o = g.reduce((a, x) => a + x.obs, 0), m = g.reduce((a, x) => a + x.mod, 0) * scale;
  return { climbPerKm: [g[g.length - 1].climbPerKm, g[0].climbPerKm], routes: g.map((x) => x.route), modelOverCount: m / o };
});
for (const x of rows) console.log(`${x.route.padEnd(5)} ${x.climbPerKm.toFixed(1).padStart(5)} m/km  model/count (scaled) ${((x.mod * scale) / x.obs).toFixed(2)}`);
console.log(`routes ${rows.length}: correlation of climb per km with log(model/count) ${s.r.toFixed(3)}`);
for (const t of thirds) console.log(`climb ${t.climbPerKm[0].toFixed(1)}–${t.climbPerKm[1].toFixed(1)} m/km: model/count ${t.modelOverCount.toFixed(3)} (${t.routes.join(' ')})`);
const i = process.argv.indexOf('--json');
if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ routes: rows, correlation: s.r, thirds }, null, 1));
