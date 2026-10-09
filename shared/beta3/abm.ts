/**
 * Person-level daily choices in expected value over segments of the synthetic population, after
 * ActivitySim's prototype_mtc (the Travel Model One lineage): the coordinated daily activity pattern
 * (CDAP), mandatory and non-mandatory tour frequency, with the coefficients of its public configs
 * (asim-mtc.ts, transferred by server/beta3/pipeline/asim-configs.ts) and constants calibrated to
 * San Francisco. Usual workplace and school location are chosen in demand.ts, which has the
 * mode-choice logsums; their shadow prices are calibrated here too.
 *
 * Nothing is drawn at random. Households with the same zone, members, cars, and income make one
 * household segment, and the CDAP is solved exactly for it: every combination of its members'
 * patterns (3^n for up to five members, as ActivitySim models them jointly) with the household
 * interaction terms, giving each member's probabilities of a mandatory (M), non-mandatory (N), or
 * home (H) day. Members are then pooled into person segments (zone × person type × cars × income
 * band × household size × other children present × works from home × fare class × school age ×
 * employment or enrollment), and tour frequency is solved for each segment at its mean
 * characteristics. That mean is the aggregation error: a logit of the mean is not the mean of the
 * logits (abm-check.ts measures it against the same models solved person by person).
 */
import { ASIM } from './asim-mtc';
import { compile, factor, parse, varsOf, type Fn, type Vars } from './abm-expr';
import { incomeBand, PF, type SynPop } from './synpop';

/** incomes in TM1's 2000 dollars: CPI-U annual averages, 172.2 (2000) / 313.689 (2024) */
export const INCOME_2000 = 172.2 / 313.689;
/** ActivitySim's non-mandatory purposes, in the order of its alternatives table */
export const NM_PURPOSES = ['escort', 'shopping', 'othmaint', 'othdiscr', 'eatout', 'social'] as const;
/** the model's purposes they are booked as (escorting and maintenance are errands; eating out and
 * discretionary activities are social and recreational, as NHTS's purposes were mapped before) */
export const NM_TO_MODEL = [1, 0, 1, 2, 2, 2] as const;
export const MODEL_NM = ['shop', 'other', 'social'] as const;
/** fare and driving classes as demand.ts uses them */
export const PCLASS = ['adult', 'youth', 'senior'] as const;

/**
 * The residual time window (ActivitySim's log_max_window, the longest gap in the day left by the
 * mandatory tours) at the model's resolution, hours, within 5am to midnight (assumed): a work tour
 * 8am–5pm leaves 7 hours in the evening; a school tour 8am–3pm leaves 9; two mandatory tours, 6.
 */
export const WINDOW_HOURS = { work: 7, school: 9, two: 6 };

/** calibrated constants (Calibration.abm) */
export interface AbmCalib {
  /** run the person-level choices (else demand's aggregate tour rates) */
  on?: boolean;
  /** usual workplaces: chosen ('choice', shadow-priced to the census flows' workplace totals) or the
   * census flows themselves ('observed') */
  workplace?: 'choice' | 'observed';
  /** CDAP constants by person type (1–8): on M and N, H the reference */
  cdap?: Record<string, { M?: number; N?: number }>;
  /** non-mandatory tour constants by person type and model purpose (per tour) */
  nmtf?: Record<string, Partial<Record<(typeof MODEL_NM)[number], number>>>;
  /** shadow prices (utils) by workplace (city zones, then outside zones' activity ends) and by school */
  workShadow?: number[];
  schoolShadow?: number[];
  univShadow?: number[];
  /** TM1 distance terms scaled for workplace choice (calibrated to the census flows' mean distance) */
  workDistScale?: number;
  /** the last calibration's fit, for the paper */
  fit?: Record<string, unknown>;
}

// ---------- the specs, compiled ----------

const ALT_VARS = new Set(['escort', 'shopping', 'othmaint', 'othdiscr', 'eatout', 'social', 'tot_tours']);
const DYN_VARS = new Set([
  'auPkTotal', 'auOpRetail', 'trOpRetail', 'nmRetail',
  'distance_to_work', 'distance_to_school', 'roundtrip_auto_time_to_work', 'roundtrip_auto_time_to_school',
  'num_under16_not_at_school', 'num_mand', 'log_max_window', 'has_school_kid_at_home', 'has_preschool_kid_at_home',
  'num_hh_joint_tours', 'num_hh_joint_shop_tours', 'num_hh_joint_eatout_tours', 'num_hh_joint_maint_tours', 'num_hh_joint_social_tours', 'num_hh_joint_othdiscr_tours',
]);

/**
 * A spec, compiled for segments: utility[alt] = Σ_features (segment's mean static part) × (dynamic
 * part) × c × H_j[alt], where H_j is one of the spec's distinct alternative parts (kept sparse).
 */
interface Feature {
  s: number;
  d: Fn | null;
  j: number;
  c: number;
}
interface Spec {
  /** by person type (1–8) */
  F: Feature[][];
  /** the alternative parts: nonzero alternatives and values */
  Hi: Int32Array[];
  Hv: Float64Array[];
  nAlt: number;
}

/** the person-level expressions whose segment means are kept (index s of Feature) */
const STATIC: string[] = ['1'];
const STATIC_FN: Fn[] = [() => 1];
const staticIndex = (e: string) => {
  let i = STATIC.indexOf(e);
  if (i < 0) {
    i = STATIC.push(e) - 1;
    STATIC_FN.push(compile(e));
  }
  return i;
};

/**
 * Each row is split into its alternative part (the columns, or the tour counts it reads), its
 * person-type part (folded into the coefficient), its dynamic part (what a run computes), and its
 * static part (the segment's mean).
 */
function compileSpec(rows: readonly { expr: string; c: readonly number[] }[], nAlt: number, altOf: (row: { expr: string; c: readonly number[] }, altExpr: string) => { key: string; H: Float64Array }, coefOf: (row: { c: readonly number[] }, pt: number) => number): Spec {
  const basis = new Map<string, number>();
  const H: Float64Array[] = [];
  const F: Feature[][] = [];
  for (let pt = 1; pt <= 8; pt++) {
    const byKey = new Map<string, Feature>();
    for (const r of rows) {
      const altF = factor(r.expr, ALT_VARS);
      const keyF = factor(altF.right, new Set(['ptype']));
      const a = altOf(r, altF.left);
      let j = basis.get(a.key);
      if (j === undefined) {
        j = H.push(a.H) - 1;
        basis.set(a.key, j);
      }
      const keyVal = compile(keyF.left)({ ptype: pt });
      const c = keyVal * coefOf(r, pt);
      if (c === 0) continue;
      const dynF = factor(keyF.right, DYN_VARS);
      for (const v of varsOf(parse(dynF.right))) if (DYN_VARS.has(v)) throw new Error(`"${r.expr}": dynamic and static mixed`);
      const key = `${dynF.right}|${dynF.left}|${j}`;
      const f = byKey.get(key);
      if (f) f.c += c;
      else byKey.set(key, { s: staticIndex(dynF.right), d: dynF.left === '1' ? null : compile(dynF.left), j, c });
    }
    F[pt] = [...byKey.values()];
  }
  const Hi = H.map((h) => Int32Array.from([...h.keys()].filter((k) => h[k] !== 0)));
  return { F, Hi, Hv: Hi.map((ix, j) => Float64Array.from(ix, (k) => H[j][k])), nAlt };
}

const NM_ALTS = ASIM.nmtf.alts as readonly (readonly number[])[];
const NM_N = NM_ALTS.length;
const NM_TOT = NM_ALTS.map((a) => a.reduce((x, y) => x + y, 0));
const NM_ALT_VARS = NM_ALTS.map((a, k) => ({ escort: a[0], shopping: a[1], othmaint: a[2], othdiscr: a[3], eatout: a[4], social: a[5], tot_tours: NM_TOT[k] }));
/** mandatory tour frequency: the alternatives are the columns (work1, work2, school1, school2, work_and_school) */
const MTF = compileSpec(ASIM.mtf.rows, 5, (r) => ({ key: r.c.join(','), H: Float64Array.from(r.c) }), () => 1);
/** non-mandatory tour frequency: one coefficient set per person type; the alternatives' tour counts */
const NMTF = compileSpec(ASIM.nmtf.rows, NM_N, (_r, e) => {
  const f = compile(e);
  return { key: e, H: Float64Array.from(NM_ALT_VARS, (v) => f(v)) };
}, (r, pt) => r.c[pt - 1]);
/** the alternative parts that count each purpose's tours (rows "escort", "shopping", ...) */
const NM_BASIS = NM_PURPOSES.map((p) => {
  const j = NMTF.Hi.findIndex((ix, j) => ix.length === NM_ALTS.filter((a) => a[NM_PURPOSES.indexOf(p)] > 0).length && ix.every((k, i) => NMTF.Hv[j][i] === NM_ALTS[k][NM_PURPOSES.indexOf(p)]));
  if (j < 0) throw new Error(`no basis for ${p}`);
  return j;
});
/**
 * ActivitySim's non-mandatory extension: a person choosing a purpose may make more tours of it
 * (non_mandatory_tour_frequency_extension_probs.csv, cumulative probabilities of 0, 1, 2 more), by
 * person type, whether the person has a mandatory tour, and the purpose. In expected value: the
 * mean number of extra tours per tour of the purpose (joint tours are not modeled: has_joint_tour 0).
 */
const NM_EXTRA: number[][][] = (() => {
  const t: number[][][] = [];
  for (const r of ASIM.nmtf.extension as readonly (readonly number[])[]) {
    const [pt, mand, joint, type, p0, p1, p2] = r;
    if (joint) continue;
    ((t[pt] ??= [])[mand] ??= [])[type - 1] = (p1 - p0) * 1 + (p2 - p1) * 2;
  }
  return t;
})();

// ---------- segments ----------

/** what each person contributes to a segment's static means */
function personStatic(v: Vars): Float32Array {
  return Float32Array.from(STATIC_FN, (f) => f(v));
}

export interface AbmPrep {
  NZ: number;
  // person segments (sorted by zone)
  segZone: Int32Array;
  segStart: Int32Array;
  segPtype: Uint8Array;
  segCar: Uint8Array;
  segBand: Uint8Array;
  segClass: Uint8Array;
  /** school age: 1 a child 10 or under, 2 a five-year-old (kindergarten), 0 otherwise */
  segYoung: Uint8Array;
  /** employed (students) or enrolled (workers, children) */
  segFlag: Uint8Array;
  segWfh: Uint8Array;
  segW: Float64Array;
  /** static means, NS per segment */
  segStatic: Float32Array;
  NS: number;
  // household segments (sorted by zone)
  hhStart: Int32Array;
  hhW: Float64Array;
  hhMemStart: Int32Array;
  /** members jointly modeled (≤ 5; the rest take fixed proportions) */
  hhJoint: Uint8Array;
  memSeg: Int32Array;
  memPtype: Uint8Array;
  memU16: Uint8Array;
  /** M available (not for non-workers and retirees, workers who work from home, or children not enrolled) */
  memAvailM: Uint8Array;
  /** CDAP utilities without accessibility or calibrated constants: M, N, H */
  memBase: Float32Array;
  /** ActivitySim's segment of school location: 0 none, 1 grade school, 2 high school, 3 university */
  segSchool: Uint8Array;
}

/** CDAP utility slopes on accessibility by person type: [M on auPkTotal, N on auOpRetail] */
const CDAP_ROWS = ASIM.cdap.indiv.map((r) => ({ f: compile(r.expr), M: r.M, N: r.N, H: r.H }));
const CDAP_SLOPE = Array.from({ length: 9 }, (_, pt) => {
  if (!pt) return [0, 0];
  const at = (v: Vars, a: 'M' | 'N') => CDAP_ROWS.reduce((s, r) => s + r[a] * r.f(v), 0);
  const v0 = { ptype: pt, age: 30, sex: 1 };
  return [at({ ...v0, auPkTotal: 1 }, 'M') - at(v0, 'M'), at({ ...v0, auOpRetail: 1 }, 'N') - at(v0, 'N')];
});

/** ActivitySim's CDAP rank: up to two workers (full-time first), then up to three children (youngest
 * first), then the others; the first five are modeled jointly */
function cdapOrder(pt: number[], age: number[]): number[] {
  const idx = pt.map((_, i) => i);
  const w = idx.filter((i) => pt[i] === 1 || pt[i] === 2).sort((a, b) => pt[a] - pt[b] || age[b] - age[a]);
  const c = idx.filter((i) => pt[i] >= 6).sort((a, b) => age[a] - age[b]);
  const first = [...w.slice(0, 2), ...c.slice(0, 3)];
  return [...first, ...idx.filter((i) => !first.includes(i))];
}

/** `perPerson`: every person a segment of their own (abm-check.ts measures the aggregation error with it) */
export function buildAbm(pop: SynPop, NZ: number, perPerson = false): AbmPrep {
  const segKey = new Map<string, number>();
  const sZone: number[] = [], sPt: number[] = [], sCar: number[] = [], sBand: number[] = [], sClass: number[] = [], sYoung: number[] = [], sFlag: number[] = [], sWfh: number[] = [], sSchool: number[] = [];
  const sW: number[] = [];
  const sStatic: number[] = [];
  const NS = STATIC.length;
  const hhKey = new Map<string, number>();
  const cdapCache = new Map<number, number[]>();
  const v: Vars = { non_family: 0, home_is_urban: 1 };
  const hZone: number[] = [], hW: number[] = [], hMem: number[] = [], hJoint: number[] = [];
  const mSeg: number[] = [], mPt: number[] = [], mU16: number[] = [], mAvail: number[] = [], mBase: number[] = [];
  let p = 0;
  for (let z = 0; z < NZ; z++) {
    segKey.clear();
    hhKey.clear();
    for (let h = pop.zoneStart[z]; h < pop.zoneStart[z + 1]; h++) {
      const n = pop.size[h];
      // residents of institutions (nursing homes, jails) make no tours here
      if (pop.kind[h] === 1) {
        p += n;
        continue;
      }
      const age: number[] = [], pt: number[] = [], fl: number[] = [];
      for (let k = 0; k < n; k++) {
        age.push(pop.age[p + k]);
        fl.push(pop.flags[p + k]);
        pt.push(((pop.flags[p + k] >> 3) & 7) + 1);
      }
      p += n;
      const veh = pop.veh[h];
      const emp = fl.map((f): number => (f & PF.employed ? 1 : 0));
      const workers = emp.reduce((a, b) => a + b, 0);
      const inc = pop.inc[h] * INCOME_2000;
      const band = incomeBand(pop.inc[h]);
      const car = Math.min(2, veh);
      const kidsU16 = age.filter((a) => a < 16).length;
      // household variables (ActivitySim's annotate_households), then each person's
      v.auto_ownership = veh;
      v.num_workers = workers;
      v.income_in_thousands = inc;
      v.num_drivers = age.filter((a) => a >= 16).length;
      v.num_young_children = age.filter((a) => a <= 5).length;
      v.num_non_workers = n - workers;
      v.medium_low_income = inc > 20 && inc <= 50 ? 1 : 0;
      v.medium_high_income = inc > 50 && inc <= 100 ? 1 : 0;
      v.high_income = inc > 100 ? 1 : 0;
      v.no_cars = veh === 0 ? 1 : 0;
      v.car_sufficiency = veh - workers;
      const incCode = inc < 20 ? 0 : inc < 50 ? 1 : inc <= 100 ? 2 : 3;
      const cw = Math.sign(veh - workers) + 1;
      const memDesc: string[] = [];
      const memInfo: { seg: number; pt: number; u16: number; avail: number; base: number[] }[] = [];
      const count = (t: number, k: number) => {
        for (let j = 0; j < n; j++) if (j !== k && pt[j] === t) return 1;
        return 0;
      };
      for (let k = 0; k < n; k++) {
        const f = fl[k], a = age[k], t = pt[k];
        const female = f & PF.female ? 1 : 0;
        const wfh = f & PF.wfh ? 1 : 0;
        const student = (f >> 6) & 3;
        v.ptype = t;
        v.age = a;
        v.sex = female ? 2 : 1;
        v.female = female;
        v.student_is_employed = (t === 3 || t === 6) && emp[k] ? 1 : 0;
        v.nonstudent_to_school = (t === 1 || t === 2 || t === 4 || t === 5) && student > 0 ? 1 : 0;
        v['workplace_zone_id>-1'] = emp[k];
        v['school_zone_id>-1'] = student > 0 || t === 3 || t === 6 ? 1 : 0;
        v.has_non_worker = count(4, k);
        v.has_retiree = count(5, k);
        v.has_preschool_kid = count(8, k);
        v.has_driving_kid = count(6, k);
        v.has_school_kid = count(7, k);
        v.has_full_time = count(1, k);
        v.has_university = count(3, k);
        v.has_part_time = 0;
        for (let j = 0; j < n; j++) if (j !== k && emp[j] && pt[j] !== 1) v.has_part_time = 1;
        const cls = a < 18 ? 1 : a >= 65 ? 2 : 0;
        const young = t === 8 ? (a >= 5 ? 2 : 1) : a <= 10 ? 1 : 0;
        const flag = t === 3 || t === 6 ? emp[k] : t === 1 || t === 2 || t >= 7 ? (student > 0 ? 1 : 0) : 0;
        // ActivitySim's school segment: grade school to 14, high school, university
        const school = t === 3 || ((t === 1 || t === 2) && student >= 2) ? 3 : t === 6 ? 2 : t === 7 || t === 8 ? (student > 0 ? (a <= 14 ? 1 : 2) : 0) : (t === 1 || t === 2) && student === 1 ? 2 : 0;
        const key = perPerson ? `${p - n + k}` : `${t}|${car}|${band}|${Math.min(4, n)}|${kidsU16 - (a < 16 ? 1 : 0) > 0 ? 1 : 0}|${wfh}|${cls}|${young}|${flag}`;
        let s = segKey.get(key);
        if (s === undefined) {
          s = sW.length;
          segKey.set(key, s);
          sZone.push(z), sPt.push(t), sCar.push(car), sBand.push(band), sClass.push(cls), sYoung.push(young), sFlag.push(flag), sWfh.push(wfh), sSchool.push(school), sW.push(0);
          for (let i = 0; i < NS; i++) sStatic.push(0);
        }
        sW[s]++;
        for (let i = 0; i < NS; i++) sStatic[s * NS + i] += STATIC_FN[i](v);
        // CDAP: the individual utilities (accessibility and constants added in a run), by what they read
        const ageCode = a <= 1 ? 0 : a <= 3 ? 1 : a <= 5 ? 2 : a <= 9 ? 3 : a <= 12 ? 4 : a <= 15 ? 5 : a < 40 ? 6 : a <= 80 ? 7 : 8;
        const ck = (((t * 9 + ageCode) * 2 + female) * 3 + cw) * 4 + incCode;
        let base = cdapCache.get(ck);
        if (!base) cdapCache.set(ck, (base = (['M', 'N', 'H'] as const).map((alt) => CDAP_ROWS.reduce((acc, r) => acc + r[alt] * r.f(v), 0))));
        const availM = t === 4 || t === 5 ? 0 : t === 1 || t === 2 ? (wfh && !(student > 0) ? 0 : 1) : t >= 7 ? (student > 0 ? 1 : 0) : 1;
        memInfo.push({ seg: s, pt: t, u16: a < 16 ? 1 : 0, avail: availM, base });
        memDesc.push(`${s}.${ck}.${availM}`);
      }
      const order = cdapOrder(pt, age);
      const desc = order.map((i) => memDesc[i]).join(';');
      let hs = hhKey.get(desc);
      if (hs === undefined) {
        hs = hW.length;
        hhKey.set(desc, hs);
        hZone.push(z);
        hW.push(0);
        hJoint.push(Math.min(5, n));
        hMem.push(n);
        for (const i of order) {
          const m = memInfo[i];
          mSeg.push(m.seg), mPt.push(m.pt), mU16.push(m.u16), mAvail.push(m.avail), mBase.push(...m.base);
        }
      }
      hW[hs]++;
    }
  }
  const NSeg = sW.length,
    NH = hW.length;
  const segStart = new Int32Array(NZ + 1),
    hhStart = new Int32Array(NZ + 1);
  for (let i = 0; i < NSeg; i++) segStart[sZone[i] + 1]++;
  for (let i = 0; i < NH; i++) hhStart[hZone[i] + 1]++;
  for (let z = 0; z < NZ; z++) ((segStart[z + 1] += segStart[z]), (hhStart[z + 1] += hhStart[z]));
  const segStatic = Float32Array.from(sStatic);
  for (let s = 0; s < NSeg; s++) for (let i = 0; i < NS; i++) segStatic[s * NS + i] /= sW[s];
  const hhMemStart = new Int32Array(NH + 1);
  for (let i = 0; i < NH; i++) hhMemStart[i + 1] = hhMemStart[i] + hMem[i];
  return {
    NZ,
    segZone: Int32Array.from(sZone),
    segStart,
    segPtype: Uint8Array.from(sPt),
    segCar: Uint8Array.from(sCar),
    segBand: Uint8Array.from(sBand),
    segClass: Uint8Array.from(sClass),
    segYoung: Uint8Array.from(sYoung),
    segFlag: Uint8Array.from(sFlag),
    segWfh: Uint8Array.from(sWfh),
    segSchool: Uint8Array.from(sSchool),
    segW: Float64Array.from(sW),
    segStatic,
    NS,
    hhStart,
    hhW: Float64Array.from(hW),
    hhMemStart,
    hhJoint: Uint8Array.from(hJoint),
    memSeg: Int32Array.from(mSeg),
    memPtype: Uint8Array.from(mPt),
    memU16: Uint8Array.from(mU16),
    memAvailM: Uint8Array.from(mAvail),
    memBase: Float32Array.from(mBase),
  };
}

// ---------- CDAP ----------

const INTER = ASIM.cdap.interaction as Record<string, number>;
const FIXED = ASIM.cdap.fixed as Record<string, { M: number; N: number; H: number }>;
const ACT = ['M', 'N', 'H'] as const;
/** the interaction coefficient of members with these person types sharing an activity */
const inter = (a: number, pts: number[]) => INTER[`${ACT[a]}${pts.slice().sort().join('')}`] ?? 0;

/**
 * The household-interaction part of the CDAP for members of these person types (in CDAP order):
 * for each combination of their activities, the two- and three-way terms for members sharing an
 * activity and the all-members term; with each combination's activities and, for each member,
 * whether another preschool (8) or school (7) child stays home. Cached by the person types.
 */
const JOINT = new Map<string, { I: Float64Array; d: Int8Array; k8: Uint8Array; k7: Uint8Array }>();
function joint(pt: number[]) {
  const key = pt.join('');
  let J = JOINT.get(key);
  if (J) return J;
  const n = pt.length,
    nc = 3 ** n;
  J = { I: new Float64Array(nc), d: new Int8Array(nc * n), k8: new Uint8Array(nc * n), k7: new Uint8Array(nc * n) };
  const combo = new Int8Array(n);
  for (let c = 0; c < nc; c++) {
    let x = c,
      v = 0;
    for (let i = 0; i < n; i++) ((combo[i] = x % 3), (x = (x - combo[i]) / 3), (J.d[c * n + i] = combo[i]));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (combo[i] !== combo[j]) continue;
        v += inter(combo[i], [pt[i], pt[j]]);
        for (let k = j + 1; k < n; k++) if (combo[k] === combo[i]) v += inter(combo[i], [pt[i], pt[j], pt[k]]);
      }
    if (n >= 3 && combo.every((a) => a === combo[0])) v += INTER[`${ACT[combo[0]]}${'*'.repeat(n)}`] ?? 0;
    J.I[c] = v;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (j !== i && combo[j] === 2) {
          if (pt[j] === 8) J.k8[c * n + i] = 1;
          if (pt[j] === 7) J.k7[c * n + i] = 1;
        }
  }
  JOINT.set(key, J);
  return J;
}

export interface ZoneAccess {
  auPkTotal: number;
  auOpRetail: number;
  trOpRetail: number;
  nmRetail: number;
}

/** per person segment of a zone, after the CDAP: weighted pattern probabilities and household terms */
export interface CdapOut {
  M: Float64Array;
  N: Float64Array;
  H: Float64Array;
  /** weighted P(another preschool child / school child of the household stays home) */
  kid8H: Float64Array;
  kid7H: Float64Array;
  /** weighted expected number of other members under 16 not on a mandatory day */
  u16NotM: Float64Array;
}

export function newCdapOut(n: number): CdapOut {
  return { M: new Float64Array(n), N: new Float64Array(n), H: new Float64Array(n), kid8H: new Float64Array(n), kid7H: new Float64Array(n), u16NotM: new Float64Array(n) };
}

/**
 * The CDAP of every household segment in zone z: individual utilities plus the household
 * interactions (two- and three-way terms for members sharing an activity, and all members alike),
 * solved over all combinations of the jointly modeled members. Results go to `out`, indexed by the
 * zone's person segments (segment − segStart[z]).
 */
export function cdapZone(A: AbmPrep, z: number, acc: ZoneAccess, calib: AbmCalib | undefined, out: CdapOut) {
  const s0 = A.segStart[z];
  const asc = calib?.cdap ?? {};
  const u = new Float64Array(3 * 64),
    pt: number[] = [];
  const P = new Float64Array(3 * 64);
  const U = new Float64Array(243),
    kidH8 = new Float64Array(5),
    kidH7 = new Float64Array(5);
  for (let h = A.hhStart[z]; h < A.hhStart[z + 1]; h++) {
    const w = A.hhW[h],
      m0 = A.hhMemStart[h],
      nAll = A.hhMemStart[h + 1] - m0,
      n = A.hhJoint[h];
    pt.length = 0;
    for (let i = 0; i < nAll; i++) {
      const m = m0 + i,
        t = A.memPtype[m];
      if (i < n) pt.push(t);
      const a = asc[t] ?? {};
      u[i * 3] = A.memAvailM[m] ? A.memBase[m * 3] + CDAP_SLOPE[t][0] * acc.auPkTotal + (a.M ?? 0) : -Infinity;
      u[i * 3 + 1] = A.memBase[m * 3 + 1] + CDAP_SLOPE[t][1] * acc.auOpRetail + (a.N ?? 0);
      u[i * 3 + 2] = A.memBase[m * 3 + 2];
    }
    // joint: every combination of the first n members' activities
    const J = joint(pt);
    P.fill(0, 0, 3 * nAll);
    kidH8.fill(0);
    kidH7.fill(0);
    const nc = J.I.length;
    let mx = -Infinity;
    for (let c = 0; c < nc; c++) {
      let v = J.I[c];
      for (let i = 0; i < n; i++) v += u[i * 3 + J.d[c * n + i]];
      U[c] = v;
      if (v > mx) mx = v;
    }
    let S = 0;
    for (let c = 0; c < nc; c++) S += U[c] = U[c] > -Infinity ? Math.exp(U[c] - mx) : 0;
    for (let c = 0; c < nc; c++) {
      const pr = U[c] / S;
      if (!pr) continue;
      for (let i = 0; i < n; i++) {
        const k = c * n + i;
        P[i * 3 + J.d[k]] += pr;
        // another preschool / school child of the household at home
        if (J.k8[k]) kidH8[i] += pr;
        if (J.k7[k]) kidH7[i] += pr;
      }
    }
    // members beyond the fifth: ActivitySim's fixed relative proportions by person type
    for (let i = n; i < nAll; i++) {
      const f = FIXED[A.memPtype[m0 + i]];
      const mm = A.memAvailM[m0 + i] ? f.M : 0;
      const t = mm + f.N + f.H;
      ((P[i * 3] = mm / t), (P[i * 3 + 1] = f.N / t), (P[i * 3 + 2] = f.H / t));
    }
    for (let i = 0; i < nAll; i++) {
      const s = A.memSeg[m0 + i] - s0;
      out.M[s] += w * P[i * 3];
      out.N[s] += w * P[i * 3 + 1];
      out.H[s] += w * P[i * 3 + 2];
      if (i < n) ((out.kid8H[s] += w * kidH8[i]), (out.kid7H[s] += w * kidH7[i]));
      let u16 = 0;
      for (let j = 0; j < nAll; j++) if (j !== i && A.memU16[m0 + j]) u16 += 1 - P[j * 3];
      out.u16NotM[s] += w * u16;
    }
  }
}

// ---------- tour frequency ----------

const mtfU = new Float64Array(5),
  nmU = new Float64Array(NM_N);
/** the dynamic variables of the segment being solved (one object of fixed shape) */
const dyn: Vars = Object.fromEntries([...DYN_VARS, 'distance_to_work<3', 'distance_to_school<3'].map((k) => [k, 0]));
const coefBuf = new Float64Array(256);
function evalSpec(S: Spec, pt: number, st: Float32Array, off: number, U: Float64Array, extra?: (a: Float64Array) => void) {
  const a = coefBuf;
  a.fill(0, 0, S.Hi.length);
  for (const f of S.F[pt]) {
    const s = st[off + f.s];
    if (s === 0) continue;
    const x = f.d ? s * f.d(dyn) : s;
    if (x !== 0) a[f.j] += x * f.c;
  }
  if (extra) extra(a);
  U.fill(0);
  for (let j = 0; j < S.Hi.length; j++) {
    const x = a[j];
    if (x === 0) continue;
    const ix = S.Hi[j],
      v = S.Hv[j];
    for (let k = 0; k < ix.length; k++) U[ix[k]] += x * v[k];
  }
}
function softmax(U: Float64Array) {
  let mx = -Infinity;
  for (let k = 0; k < U.length; k++) if (U[k] > mx) mx = U[k];
  let S = 0;
  for (let k = 0; k < U.length; k++) S += U[k] = Math.exp(U[k] - mx);
  for (let k = 0; k < U.length; k++) U[k] /= S;
}

/** a segment's expected tours per person on a day of each kind */
export interface SegTours {
  /** P(M), P(N), P(H) */
  pat: [number, number, number];
  work: number;
  school: number;
  /** non-mandatory tours by ActivitySim purpose */
  nm: Float64Array;
  /** non-mandatory tours (all purposes) on M days and on N days */
  nmOnM: number;
  nmOnN: number;
}

/**
 * Tour frequency for one person segment: mandatory tours given M (ActivitySim's mandatory tour
 * frequency, with the workplace and school statistics in `dynIn`), then non-mandatory tours given N
 * and given each kind of M day (num_mand and the residual window differ), with the calibrated
 * constants per tour and ActivitySim's extension to second and third tours of a purpose.
 */
export function segmentTours(A: AbmPrep, s: number, pat: [number, number, number], dynIn: Vars, acc: ZoneAccess, calib: AbmCalib | undefined, out: SegTours) {
  const t = A.segPtype[s],
    off = s * A.NS;
  out.pat = pat;
  out.work = out.school = out.nmOnM = out.nmOnN = 0;
  out.nm.fill(0);
  for (const k in dynIn) dyn[k] = dynIn[k];
  dyn.auPkTotal = acc.auPkTotal;
  dyn.auOpRetail = acc.auOpRetail;
  dyn.trOpRetail = acc.trOpRetail;
  dyn.nmRetail = acc.nmRetail;
  let pw1 = 0,
    pw2 = 0,
    ps1 = 0,
    ps2 = 0,
    pws = 0;
  if (pat[0] > 0) {
    evalSpec(MTF, t, A.segStatic, off, mtfU);
    softmax(mtfU);
    [pw1, pw2, ps1, ps2, pws] = mtfU;
    out.work = pat[0] * (pw1 + 2 * pw2 + pws);
    out.school = pat[0] * (ps1 + 2 * ps2 + pws);
  }
  const asc = calib?.nmtf?.[t] ?? {};
  const ascQ = MODEL_NM.map((q) => asc[q] ?? 0);
  const conds: [number, number, number][] = [
    [pat[1], 0, 0],
    [pat[0] * pw1, 1, WINDOW_HOURS.work],
    [pat[0] * ps1, 1, WINDOW_HOURS.school],
    [pat[0] * (pw2 + ps2 + pws), 2, WINDOW_HOURS.two],
  ];
  for (const [w, nm, win] of conds) {
    if (!(w > 0)) continue;
    dyn.num_mand = nm;
    dyn.log_max_window = Math.log1p(win);
    evalSpec(NMTF, t, A.segStatic, off, nmU, (a) => {
      // the calibrated constants, per tour of each model purpose
      for (let q = 0; q < 6; q++) a[NM_BASIS[q]] += ascQ[NM_TO_MODEL[q]];
    });
    softmax(nmU);
    const ext = NM_EXTRA[t]?.[nm > 0 ? 1 : 0];
    for (let k = 0; k < NM_N; k++) {
      const pr = w * nmU[k];
      if (!pr) continue;
      const a = NM_ALTS[k];
      for (let q = 0; q < 6; q++)
        if (a[q]) {
          const x = pr * (a[q] + (ext?.[q] ?? 0));
          out.nm[q] += x;
          if (nm > 0) out.nmOnM += x;
          else out.nmOnN += x;
        }
    }
  }
}

/** TM1's piecewise-linear distance (miles: 0–1, 1–2, 2–5, 5–15, 15+) */
export const tm1Dist = (b: readonly number[], mi: number) =>
  b[0] * Math.min(mi, 1) + b[1] * Math.max(0, Math.min(mi, 2) - 1) + b[2] * Math.max(0, Math.min(mi, 5) - 2) + b[3] * Math.max(0, Math.min(mi, 15) - 5) + b[4] * Math.max(0, mi - 15);

/**
 * TM1's workplace size terms by income segment (destination_choice_size_terms.csv) on LODES's
 * sectors (CNS01–20, zone jobsBy[0..19]), mapped to ABAG's six groups (assumed): retail RETEMPN =
 * CNS07; financial and professional FPSEMPN = information, finance, real estate, professional,
 * management, administrative (CNS09–14); health, education, recreation HEREMPN = education, health,
 * arts, accommodation and food, other services (CNS15–19); other OTHEMPN = public administration
 * (CNS20); agriculture AGREMPN = CNS01–02; manufacturing, wholesale, transport MWTEMPN = utilities,
 * construction, manufacturing, wholesale, transportation (CNS03–06, 08). Income segments follow
 * BATS's bands (under $50k low, to $100k medium, to $200k high, above very high; TM1's are $30k,
 * $60k, and $100k in 2000 dollars, about $55k, $109k, and $182k today).
 */
const SECTOR: Record<string, number[]> = { RETEMPN: [6], FPSEMPN: [8, 9, 10, 11, 12, 13], HEREMPN: [14, 15, 16, 17, 18], OTHEMPN: [19], AGREMPN: [0, 1], MWTEMPN: [2, 3, 4, 5, 7] };
export function workSize(jobsBy: number[], band: number): number {
  const seg = ['work_low', 'work_med', 'work_high', 'work_veryhigh'][band];
  const t = (ASIM.sizeTerms as Record<string, Record<string, number>>)[`workplace:${seg}`];
  let s = 0;
  for (const [k, w] of Object.entries(t)) for (const j of SECTOR[k] ?? []) s += w * (jobsBy[j] ?? 0);
  return s;
}

