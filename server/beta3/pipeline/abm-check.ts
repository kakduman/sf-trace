/**
 * The aggregation error of the person-level choices: tour frequency solved for segments at their
 * mean characteristics (as demand runs it) against the same models solved person by person, with
 * the same CDAP (exact in both: households are pooled only when identical in everything it reads)
 * and the same inputs (each zone's accessibility and workplace statistics from a demand pass).
 * Writes server/beta3/reference/abm-aggregation.json.
 * Run: NODE_OPTIONS=--max-old-space-size=6144 npx tsx server/beta3/pipeline/abm-check.ts
 */
import fs from 'node:fs';
import { ABM, ABM_DEBUG, computeDemand, prepare, type TrnSkims } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { buildAbm, cdapZone, newCdapOut, segmentTours, NM_TO_MODEL, type AbmPrep, type SegTours } from '../../../shared/beta3/abm';
import { synpopOf } from '../../../shared/beta3/synpop';
import { REFERENCE } from './paths';
import { loadBundle } from './run-base';

const KINDS = ['work', 'school', 'shop', 'other', 'social'] as const;

async function main() {
  const b = loadBundle();
  const calib = b.header.calibration!;
  const NZ = b.header.zones.length;
  ABM.on = true;
  ABM_DEBUG.inputs = new Map();
  const prep = prepare(b);
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk = {} as TrnSkims;
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  computeDemand(b, prep, sk, calib);
  const inputs = ABM_DEBUG.inputs!;
  let t = performance.now();
  const P = buildAbm(synpopOf(b)!, NZ, true);
  console.log(`person by person: ${P.segW.length} persons, ${P.hhW.length} households (${((performance.now() - t) / 1000).toFixed(1)} s to build)`);
  const S = prep.abm!;
  const run = (A: AbmPrep) => {
    const z5 = new Float64Array(NZ * KINDS.length);
    const byPt = new Float64Array(9 * KINDS.length);
    const st: SegTours = { pat: [0, 0, 0], work: 0, school: 0, nm: new Float64Array(6), nmOnM: 0, nmOnN: 0 };
    const t0 = performance.now();
    for (let z = 0; z < NZ; z++) {
      const inp = inputs.get(z);
      const n = A.segStart[z + 1] - A.segStart[z];
      if (!inp || !n) continue;
      const C = newCdapOut(n);
      cdapZone(A, z, inp.acc, calib.abm, C);
      for (let i = 0; i < n; i++) {
        const g = A.segStart[z] + i, w = A.segW[g], k = (A.segCar[g] * 4 + A.segBand[g]) * 2;
        segmentTours(A, g, [C.M[i] / w, C.N[i] / w, C.H[i] / w], {
          'distance_to_work<3': inp.stats[k], roundtrip_auto_time_to_work: inp.stats[k + 1], 'distance_to_school<3': inp.school[0], roundtrip_auto_time_to_school: inp.school[1],
          num_under16_not_at_school: C.u16NotM[i] / w, has_preschool_kid_at_home: C.kid8H[i] / w, has_school_kid_at_home: C.kid7H[i] / w,
        }, inp.acc, calib.abm, st);
        const v = [st.work, st.school, 0, 0, 0];
        for (let q = 0; q < 6; q++) v[2 + NM_TO_MODEL[q]] += st.nm[q];
        for (let j = 0; j < KINDS.length; j++) ((z5[z * KINDS.length + j] += w * v[j]), (byPt[A.segPtype[g] * KINDS.length + j] += w * v[j]));
      }
    }
    return { z5, byPt, s: (performance.now() - t0) / 1000 };
  };
  const seg = run(S), per = run(P);
  console.log(`segments ${seg.s.toFixed(1)} s, persons ${per.s.toFixed(1)} s`);
  const out: Record<string, unknown> = { segments: S.segW.length, householdSegments: S.hhW.length, persons: P.segW.length, households: P.hhW.length, secondsSegments: +seg.s.toFixed(2), secondsPersons: +per.s.toFixed(2), citywide: {}, zones: {}, byPtype: {} };
  KINDS.forEach((k, j) => {
    let a = 0, c = 0, se = 0, mx = 0;
    for (let z = 0; z < NZ; z++) {
      const x = seg.z5[z * KINDS.length + j], y = per.z5[z * KINDS.length + j];
      a += x;
      c += y;
      se += (x - y) ** 2;
      if (y > 20) mx = Math.max(mx, Math.abs(x / y - 1));
    }
    (out.citywide as Record<string, unknown>)[k] = { segments: Math.round(a), persons: Math.round(c), diffPct: +((100 * (a - c)) / c).toFixed(2) };
    (out.zones as Record<string, unknown>)[k] = { pctRmse: +((100 * Math.sqrt(se / NZ)) / (c / NZ)).toFixed(2), maxAbsPct: +(100 * mx).toFixed(1) };
    for (let pt = 1; pt <= 8; pt++) {
      const x = seg.byPt[pt * KINDS.length + j], y = per.byPt[pt * KINDS.length + j];
      if (y > 0) ((out.byPtype as Record<string, Record<string, number>>)[pt] ??= {})[k] = +((100 * (x - y)) / y).toFixed(2);
    }
  });
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync(`${REFERENCE}/abm-aggregation.json`, JSON.stringify({ description: 'Aggregation error of the person-level choices (abm-check.ts): expected tours by kind when tour frequency is solved for person segments at their mean characteristics, against the same models solved person by person (same CDAP, same inputs). diffPct: segments against persons, citywide; pctRmse: across the 678 zones, relative to the mean zone; maxAbsPct: the largest zone difference among zones with more than 20 tours of the kind.', ...out }, null, 1));
}

main();
