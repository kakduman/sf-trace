/**
 * Transfers ActivitySim's prototype_mtc configs (the Travel Model One lineage; ActivitySim
 * repository, activitysim/examples/prototype_mtc/configs, main branch) into shared/beta3/asim-mtc.ts:
 * the coordinated daily activity pattern (CDAP), mandatory and non-mandatory tour frequency,
 * workplace and school location, destination size terms, and accessibility constants. Expressions
 * are kept as written in the configs and evaluated by shared/beta3/abm.ts; coefficients are
 * resolved from the coefficient files (a blank cell is 0).
 * Input: $BETA3_RAW/asim/*.csv (downloaded from raw.githubusercontent.com)
 * Run: npx tsx server/beta3/pipeline/asim-configs.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { RAW, ROOT } from './paths';

const DIR = `${RAW}/asim`;

/** a small CSV reader (quoted fields with commas) */
function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(`${DIR}/${file}`, 'utf8');
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') out.push(cur), (cur = '');
      else cur += c;
    }
    out.push(cur);
    rows.push(out);
  }
  const head = rows[0];
  return rows.slice(1).filter((r) => !r[0].startsWith('#')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const coefs = (file: string) => Object.fromEntries(readCsv(file).map((r) => [r.coefficient_name, Number(r.value)]));
const val = (C: Record<string, number>, name: string) => {
  if (!name) return 0;
  if (/^-?[\d.]+$/.test(name)) return Number(name);
  if (!(name in C)) throw new Error(`unknown coefficient ${name}`);
  return C[name];
};

// CDAP
const cC = coefs('cdap_coefficients.csv');
const cdapIndiv = readCsv('cdap_indiv_and_hhsize1.csv').filter((r) => r.Expression).map((r) => ({ expr: r.Expression, M: val(cC, r.M), N: val(cC, r.N), H: val(cC, r.H) }));
const cdapInteraction: Record<string, number> = {};
for (const r of readCsv('cdap_interaction_coefficients.csv')) cdapInteraction[`${r.activity}${r.interaction_ptypes}`] = val(cC, r.coefficient);
const cdapFixed = Object.fromEntries(readCsv('cdap_fixed_relative_proportions.csv').map((r) => [Number(r.Expression.replace(/\D/g, '')), { M: Number(r.M), N: Number(r.N), H: Number(r.H) }]));

// mandatory tour frequency
const mC = coefs('mandatory_tour_frequency_coefficients.csv');
const MTF_ALTS = ['work1', 'work2', 'school1', 'school2', 'work_and_school'];
const mtf = readCsv('mandatory_tour_frequency.csv').filter((r) => r.Expression).map((r) => ({ label: r.Label, expr: r.Expression, c: MTF_ALTS.map((a) => val(mC, r[a])) }));

// non-mandatory tour frequency: one coefficient set per person type
const PT = ['FULL', 'PART', 'UNIVERSITY', 'NONWORK', 'RETIRED', 'DRIVING', 'SCHOOL', 'PRESCHOOL'];
const nC = PT.map((p) => coefs(`non_mandatory_tour_frequency_coefficients_PTYPE_${p}.csv`));
const nmtf = readCsv('non_mandatory_tour_frequency.csv').filter((r) => r.Expression).map((r) => ({ label: r.Label, expr: r.Expression, c: PT.map((p, i) => val(nC[i], r[`PTYPE_${p}`])) }));
const nmtfExtension = readCsv('non_mandatory_tour_frequency_extension_probs.csv').map((r) => [r.ptype, r.has_mandatory_tour, r.has_joint_tour, r.nonmandatory_tour_type, r['0_tours'], r['1_tours'], r['2_tours']].map(Number));
const nmtfAlts = readCsv('non_mandatory_tour_frequency_alternatives.csv').map((r) => ['escort', 'shopping', 'othmaint', 'othdiscr', 'eatout', 'social'].map((k) => Number(r[k])));

// location choice
const wC = coefs('workplace_location_coefficients.csv');
const sC = coefs('school_location_coefficients.csv');
const sizeTerms = Object.fromEntries(readCsv('destination_choice_size_terms.csv').map((r) => [`${r.model_selector}:${r.segment}`, Object.fromEntries(Object.entries(r).filter(([k, v]) => !['model_selector', 'segment'].includes(k) && Number(v) !== 0).map(([k, v]) => [k, Number(v)]))]));

const out = {
  source: 'ActivitySim prototype_mtc configs (github.com/ActivitySim/activitysim, activitysim/examples/prototype_mtc/configs, main branch, downloaded 2026-10-05), transferred by server/beta3/pipeline/asim-configs.ts',
  cdap: { indiv: cdapIndiv, interaction: cdapInteraction, fixed: cdapFixed },
  mtf: { alts: MTF_ALTS, rows: mtf },
  nmtf: { purposes: ['escort', 'shopping', 'othmaint', 'othdiscr', 'eatout', 'social'], alts: nmtfAlts, rows: nmtf, extension: nmtfExtension },
  workplace: { dist: [wC.coef_dist_0_1, wC.coef_dist_1_2, wC.coef_dist_2_5, wC.coef_dist_5_15, wC.coef_dist_15_up], dist05High: wC.coef_dist_0_5_high, dist5upHigh: wC.coef_dist_5_up_high, logsum: wC.coef_mode_logsum },
  school: {
    univ: [sC.coef_univ_dist_0_1, sC.coef_univ_dist_1_2, sC.coef_univ_dist_2_5, sC.coef_univ_dist_5_15, sC.coef_univ_dist_15_up],
    high: [sC.coef_high_dist_0_1, sC.coef_high_grade_dist_1_2, sC.coef_high_grade_dist_2_5, sC.coef_high_dist_5_15, sC.coef_high_dist_15_up],
    grade: [sC.coef_grade_dist_0_1, sC.coef_high_grade_dist_1_2, sC.coef_high_grade_dist_2_5, sC.coef_grade_dist_5_15, sC.coef_grade_dist_15_up],
    logsum: sC.coef_mode_logsum,
  },
  sizeTerms,
  accessibility: { autoDispersion: -0.05, transitDispersion: -0.05, walkDispersion: -1, maxWalkMiles: 3, ovtWeight: 2 },
};
const file = path.join(ROOT, 'shared/beta3/asim-mtc.ts');
fs.writeFileSync(
  file,
  `/* Generated by server/beta3/pipeline/asim-configs.ts from ActivitySim's prototype_mtc configs; do not edit. */\n` +
    `export const ASIM = ${JSON.stringify(out, null, 1)} as const;\n`,
);
console.log(`cdap ${cdapIndiv.length} rows, ${Object.keys(cdapInteraction).length} interactions; mtf ${mtf.length}; nmtf ${nmtf.length} rows × ${nmtfAlts.length} alternatives → ${file}`);
