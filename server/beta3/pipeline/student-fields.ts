/**
 * School and college inputs of each block group (build.ts step 7, or on its own to refresh them in an
 * existing bundle without rebuilding it):
 *  - K-12 pupils enrolled at the zone's schools, in all and by level (TK-5, 6-8, 9-12): every public,
 *    charter, and private school in the city at its location (sf-schools.json: CDE directory and
 *    enrollment, private-school affidavits), continuation, court, and adult programs left out;
 *  - K-12 pupils living in the zone by level: ACS B14001 by tract (kindergarten and grades 1-4 and a
 *    quarter of grades 5-8 for TK-5; three quarters of 5-8; 9-12), shared among the tract's block
 *    groups by children aged 5-17 (student-travel.json acsEnrollment);
 *  - college campuses named in college-enrollment.json: their own enrollment, the share of their
 *    students living in the city, and a transit pass.
 * Run on its own: npx tsx server/beta3/pipeline/student-fields.ts (patches BETA3_SF_BUNDLE or the app's
 * bundle, keeping everything else; zone shapes come from the work folder's zones.json)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import { toXY } from '../../../shared/beta3/geo';
import { SCHOOL_LEVELS } from '../../../shared/beta3/params';
import type { ZoneAttrs } from '../../../shared/beta3/types';
import { BUNDLE, RAW, REFERENCE, WORK } from './paths';

type Zone = Pick<ZoneAttrs, 'id' | 'x' | 'y' | 'age5to17' | 'collegeEnroll'> & { shape: [number, number][][] };
export interface StudentFields {
  schoolEnroll?: number;
  schoolEnrollBy?: [number, number, number];
  pupils: [number, number, number];
  collegeEnroll?: number;
  collegeResShare?: number;
  collegePass?: boolean;
}

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const inRings = (lon: number, lat: number, rings: [number, number][][]) => {
  let inside = false;
  for (const r of rings)
    for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const [xa, ya] = r[a], [xb, yb] = r[b];
      if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
    }
  return inside;
};

export function studentFields(Zs: Zone[]): StudentFields[] {
  const NZ = Zs.length;
  const out: StudentFields[] = Zs.map(() => ({ pupils: [0, 0, 0] }));
  // schools at their locations, in all and by grade band
  const schoolFile = fs.existsSync(`${REFERENCE}/sf-schools.json`) ? read(`${REFERENCE}/sf-schools.json`) : null;
  if (schoolFile) {
    const all = new Float64Array(NZ), by = [new Float64Array(NZ), new Float64Array(NZ), new Float64Array(NZ)];
    let placed = 0, missed = 0;
    for (const sc of schoolFile.schools as { enrollment: number | null; k5?: number; g68?: number; g912?: number; lat: number | null; lon: number | null; nontraditional?: boolean }[]) {
      // continuation, court, and adult programs (mostly adults) are left out
      if (!sc.enrollment || sc.lat == null || sc.lon == null || sc.nontraditional) continue;
      let zi = Zs.findIndex((z) => inRings(sc.lon!, sc.lat!, z.shape));
      if (zi < 0) {
        // on a zone edge or in a park: the nearest zone
        const [x, y] = toXY(sc.lat, sc.lon);
        zi = Zs.reduce((bi, z, i) => (Math.hypot(z.x - x, z.y - y) < Math.hypot(Zs[bi].x - x, Zs[bi].y - y) ? i : bi), 0);
        missed++;
      }
      all[zi] += sc.enrollment;
      // grade bands (a school without them counts in each by the city's shares)
      const bands = [sc.k5 ?? 0, sc.g68 ?? 0, sc.g912 ?? 0], bt = bands[0] + bands[1] + bands[2];
      for (let l = 0; l < 3; l++) by[l][zi] += bt > 0 ? (sc.enrollment * bands[l]) / bt : sc.enrollment * SCHOOL_LEVELS[l].share;
      placed++;
    }
    out.forEach((f, i) => ((f.schoolEnroll = Math.round(all[i])), (f.schoolEnrollBy = by.map((a) => Math.round(a[i])) as [number, number, number])));
    console.log(`schools: ${placed} placed (${missed} by nearest zone), ${Math.round(all.reduce((a, v) => a + v, 0)).toLocaleString()} pupils; by level ${by.map((a) => Math.round(a.reduce((x, v) => x + v, 0))).join(', ')}`);
  }
  // resident pupils by level
  {
    const lines = fs.readFileSync(`${RAW}/census/acs_b14001_tract.dat`, 'utf8').trim().split('\n');
    const h = lines[0].split('|');
    const col = (r: string[], k: string) => Number(r[h.indexOf(`B14001_${k}`)]) || 0;
    const byTract = new Map<string, number[]>();
    Zs.forEach((z, i) => byTract.set(z.id.slice(0, 11), [...(byTract.get(z.id.slice(0, 11)) ?? []), i]));
    for (const l of lines.slice(1)) {
      const r = l.split('|');
      const zs = byTract.get(r[0].slice(-11));
      if (!zs) continue;
      const lev = [col(r, 'E004') + col(r, 'E005') + col(r, 'E006') / 4, (col(r, 'E006') * 3) / 4, col(r, 'E007')];
      const kids = zs.reduce((a, i) => a + Zs[i].age5to17, 0);
      for (const i of zs) out[i].pupils = lev.map((v) => +(kids > 0 ? (v * Zs[i].age5to17) / kids : v / zs.length).toFixed(1)) as [number, number, number];
    }
    console.log(`resident pupils by level (ACS B14001): ${[0, 1, 2].map((k) => Math.round(out.reduce((a, f) => a + f.pupils[k], 0))).join(', ')}`);
  }
  // named campuses
  for (const c of read(`${REFERENCE}/college-enrollment.json`).campuses as { name: string; zone: string; enrollment: number; residentShare?: number; pass?: string }[]) {
    const i = Zs.findIndex((q) => q.id === c.zone);
    if (i < 0) throw new Error(`college-enrollment.json: no zone ${c.zone}`);
    console.log(`college enrollment: ${c.name} ${Math.round(Zs[i].collegeEnroll ?? 0)} → ${c.enrollment}`);
    out[i].collegeEnroll = c.enrollment;
    if (c.residentShare !== undefined) out[i].collegeResShare = c.residentShare;
    if (c.pass) out[i].collegePass = true;
  }
  return out;
}

if (process.argv[1]?.endsWith('student-fields.ts')) {
  const file = process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`;
  const b = decodeBundle(zlib.gunzipSync(fs.readFileSync(file)));
  const zf = read(`${WORK}/zones.json`).internal as Zone[];
  const fields = studentFields(zf);
  const byId = new Map(zf.map((z, i) => [z.id, fields[i]]));
  for (const z of b.header.zones) {
    const f = byId.get(z.id);
    if (!f) throw new Error(`no zone ${z.id} in zones.json`);
    Object.assign(z, f);
  }
  const { arrays: _a, ...header } = b.header;
  void _a;
  fs.writeFileSync(file, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log(`written ${file}`);
}
