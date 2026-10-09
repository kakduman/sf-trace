/**
 * Outside zones' driving times into the city (the bundle's extAutoIn, which demand reads for
 * in-commuters and other trips from outside) against straight-line distance, by region, and against
 * the road assignment's own times today (roads.bin.gz: the Peninsula freeways fitted to INRIX's peak
 * speeds, the city's streets to SFCTA's). Writes server/beta3/reference/ext-auto-times.json.
 *
 *   npx tsx server/beta3/pipeline/diag-extauto.ts [--skims <dir>] [--tag after]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { toXY } from '../../../shared/beta3/geo';
import { linkTimes, periodRoads, roadNetFrom, skimRoads, type RoadHeader } from '../../../shared/beta3/roads';
import type { TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';
import { regionOf } from './regional-legs';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

/** one array from a skims.ts output (skims.json's index into skims.bin) */
export function skimArray(dir: string, key: string): Uint16Array {
  const j = JSON.parse(fs.readFileSync(`${dir}/skims.json`, 'utf8')) as { index: Record<string, { offset: number; length: number }> };
  const bin = fs.readFileSync(`${dir}/skims.bin`);
  const e = j.index[key];
  return new Uint16Array(bin.buffer.slice(bin.byteOffset + e.offset, bin.byteOffset + e.offset + 2 * e.length));
}

function main() {
  const tag = arg('--tag', 'current');
  const B = loadBundle();
  const H = B.header;
  const Z = H.zones,
    X = H.ext,
    NZ = Z.length;
  const fidi = Z.reduce((bi, z, i) => (Math.hypot(z.lat - 37.792, (z.lon + 122.399) * 0.79) < Math.hypot(Z[bi].lat - 37.792, (Z[bi].lon + 122.399) * 0.79) ? i : bi), 0);
  const jobs = Z.map((z) => z.jobs),
    J = jobs.reduce((a, v) => a + v, 0);
  // the bundle's times, or a skims.ts output's (--skims <dir with skims.json and skims.bin>)
  const skDir = arg('--skims', '');
  const AM = skDir ? skimArray(skDir, 'extAutoIn_AM') : (B.a.extAutoIn_AM as Uint16Array);
  // the road assignment today: least-cost minutes from each outside zone at today's AM congested times
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`)));
  const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
  const p: TPeriod = 'AM';
  const R = periodRoads(net, p);
  const t = new Float64Array(net.h.nLinks);
  linkTimes(R, net.base[p]!, t);
  const sk = skimRoads(R, t, { origins: X.map((_, e) => NZ + e) });
  const nC = net.h.nC;
  const [fx, fy] = toXY(Z[fidi].lat, Z[fidi].lon);
  const rows = X.map((x, e) => {
    const [ex, ey] = toXY(x.lat, x.lon);
    const km = Math.hypot(ex - fx, ey - fy) / 1000;
    let w = 0;
    for (let d = 0; d < NZ; d++) w += (jobs[d] / J) * AM[e * NZ + d];
    return {
      name: x.name,
      region: regionOf(x.lat, x.lon),
      km: +km.toFixed(1),
      toFiDi: +(AM[e * NZ + fidi] / 60).toFixed(1),
      jobWeighted: +(w / 60).toFixed(1),
      assignmentToFiDi: +sk.time[(NZ + e) * nC + fidi].toFixed(1),
    };
  });
  const regions = [...new Set(rows.map((r) => r.region))];
  const med = (v: number[]) => {
    const s = v.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const byRegion = Object.fromEntries(
    regions.map((g) => {
      const r = rows.filter((x) => x.region === g && x.km < 120);
      return [g, { zones: r.length, medianKm: med(r.map((x) => x.km)), medianMinToFiDi: med(r.map((x) => x.toFiDi)), medianStraightKmh: +med(r.map((x) => (x.km / x.toFiDi) * 60)).toFixed(1), medianAssignmentMin: med(r.map((x) => x.assignmentToFiDi)), medianRatioToAssignment: +med(r.map((x) => x.toFiDi / x.assignmentToFiDi)).toFixed(3) }];
    }),
  );
  const file = `${REFERENCE}/ext-auto-times.json`;
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  prev.note = 'Outside zones’ morning driving times to the Financial District (the bundle’s extAutoIn, the time demand reads) against straight-line distance and the road assignment’s own times today (server/beta3/pipeline/diag-extauto.ts). Minutes; km straight line.';
  prev[tag] = { bundle: H.built, byRegion, rows };
  fs.writeFileSync(file, JSON.stringify(prev, null, 1));
  for (const [g, s] of Object.entries(byRegion)) console.log(g.padEnd(26), JSON.stringify(s));
  for (const n of ['Palo Alto', 'San Mateo', 'Redwood City', 'San Jose (west)', 'Mountain View', 'Oakland (east)', 'Berkeley', 'San Rafael', 'Walnut Creek', 'Daly City (south)', 'Fremont (north-west)'])
    console.log(n.padEnd(22), JSON.stringify(rows.find((r) => r.name === n)));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
