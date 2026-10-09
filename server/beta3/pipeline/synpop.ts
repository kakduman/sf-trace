/**
 * Step 4b: a synthetic population of San Francisco: every household and every person, drawn from
 * the ACS 2020–24 five-year microdata (PUMS) so that each block group's households and people add
 * up to its census counts. This is list-based synthesis as PopulationSim does it (RSG and the
 * ActivitySim consortium; used by SF-CHAMP, ActivitySim and MTC's Travel Model Two), with the
 * household and person controls balanced together (Ye, Konduri, Pendyala, Sana & Waddell 2009, IPU):
 *
 *  1. Seeds: the PUMS households of each of the city's eight PUMAs, with their persons.
 *     Group-quarters residents (dorms, nursing homes, jails, shelters) are synthesized apart, one
 *     person each, from the city's PUMS group-quarters persons, to the 2020 census's group-quarters
 *     population of each block group by type (scaled to the ACS 2020–24 total).
 *  2. Controls: households by size, vehicles, and income (block group); persons in households by age
 *     and sex, and employed residents (block group); households by workers and persons by school level
 *     (tract, where the block-group tables are not published).
 *  3. List balancing (entropy maximization with control importance and relaxation, after
 *     PopulationSim's balancer): first each PUMA's seed weights to the PUMA's control totals, then,
 *     tract by tract, one weight per seed household and block group, balanced to the block-group
 *     controls and the tract's together.
 *  4. Integerization: each block group's weights are rounded to whole households, each to its floor or
 *     ceiling, choosing the households that best keep the balanced control totals (a greedy
 *     least-squares rounding with the fractional weights as a prior).
 *  5. Attributes: each person carries the PUMS person's age, sex, employment, school level and
 *     ActivitySim person type; working from home is drawn at 2024 rates (the 2020–21 records' rates
 *     were pandemic rates).
 *
 * Writes data/beta3/work/synpop-households.csv.gz and synpop-persons.csv.gz, and the validation and
 * sources to server/beta3/reference/synpop.json.
 *
 * Run: npx tsx server/beta3/pipeline/synpop-seed.ts (once), then npx tsx server/beta3/pipeline/synpop.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { RAW, REFERENCE, WORK } from './paths';
import { SF_PUMAS } from './synpop-seed';
import { WFH_RESIDENTS_2024 } from '../../../shared/beta3/params';
import { PTYPES, hhSeed, incomeBand, packPerson, type PType } from '../../../shared/beta3/synpop';

// ---------- inputs ----------

function readCsv(file: string): Record<string, string>[] {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].replace(/^﻿/, '').split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, c[i] ?? '']));
  });
}

function readAcs(file: string): Map<string, Record<string, number>> {
  const lines = fs.readFileSync(`${RAW}/census/${file}`, 'utf8').trim().split('\n');
  const head = lines[0].split('|');
  const out = new Map<string, Record<string, number>>();
  for (const l of lines.slice(1)) {
    const c = l.split('|');
    const rec: Record<string, number> = {};
    head.forEach((h, i) => {
      if (i > 0 && h.includes('_E')) rec[h.slice(h.indexOf('_') + 1)] = Number(c[i]) || 0;
    });
    out.set(c[0].slice(c[0].indexOf('US') + 2), rec);
  }
  return out;
}
const sum = (r: Record<string, number> | undefined, ...k: string[]) => (r ? k.reduce((s, x) => s + (r[x] ?? 0), 0) : 0);
const E = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `E${String(a + i).padStart(3, '0')}`);

/** a small deterministic generator (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- seed records ----------

interface SeedPerson {
  sporder: number;
  age: number;
  female: boolean;
  employed: boolean;
  /** at work in the reference week (a worker in the ACS journey-to-work tables) */
  atWork: boolean;
  wfh: boolean;
  /** SCHG: 0 not enrolled, 1 preschool, 2 kindergarten, 3–14 grades 1–12, 15 undergraduate, 16 graduate */
  schg: number;
  student: number;
  ptype: PType;
  incK: number;
  year: number;
}
interface SeedHH {
  serial: string;
  puma: string;
  /** PUMS weight (WGTP, or PWGTP for a group-quarters person) */
  w: number;
  veh: number;
  incK: number;
  /** 0 household; 1 institutional, 2 college, 3 other non-institutional group quarters */
  kind: number;
  persons: SeedPerson[];
  workers: number;
}

const AGE8: [number, number][] = [[0, 4], [5, 17], [18, 24], [25, 34], [35, 49], [50, 64], [65, 79], [80, 200]];
const ageGroup = (a: number) => AGE8.findIndex(([lo, hi]) => a >= lo && a <= hi);

/** ActivitySim / TM1 person type from PUMS fields */
function personType(age: number, employed: boolean, wkhp: number, wkwn: number, schg: number): PType {
  // full time: 35+ hours a week, 40+ weeks a year (TM1's PUMS rule: WKW 50–52, 48–49 or 40–47 weeks)
  const ft = employed && wkhp >= 35 && wkwn >= 40;
  let school = schg >= 1 && schg <= 14, univ = schg >= 15;
  if (school && age > 19) (school = false), (univ = true);
  if (age < 6) return 8;
  if (age < 16) return 7;
  if (ft) return 1;
  if (school) return 6;
  if (univ) return 3;
  if (employed) return 2;
  return age >= 65 ? 5 : 4;
}

function loadSeed() {
  const H = readCsv(`${WORK}/pums-sf-h.csv`);
  const P = readCsv(`${WORK}/pums-sf-p.csv`);
  const bySerial = new Map<string, Record<string, string>[]>();
  for (const p of P) {
    if (!bySerial.has(p.SERIALNO)) bySerial.set(p.SERIALNO, []);
    bySerial.get(p.SERIALNO)!.push(p);
  }
  const num = (s: string) => (s === '' ? NaN : Number(s));
  const person = (p: Record<string, string>): SeedPerson => {
    const age = num(p.AGEP), esr = num(p.ESR), schg = num(p.SCHG) || 0;
    const employed = [1, 2, 4, 5].includes(esr);
    return {
      sporder: num(p.SPORDER),
      age,
      female: p.SEX === '2',
      employed,
      atWork: p.JWTRNS !== '',
      wfh: p.JWTRNS === '11',
      schg,
      student: schg === 0 ? 0 : schg <= 14 ? 1 : schg === 15 ? 2 : 3,
      ptype: personType(age, employed, num(p.WKHP) || 0, num(p.WKWN) || 0, schg),
      incK: ((num(p.PINCP) || 0) * num(p.ADJINC)) / 1e6 / 1000,
      year: Number(p.SERIALNO.slice(0, 4)),
    };
  };
  const hh: SeedHH[] = [];
  const gq: SeedHH[] = [];
  for (const h of H) {
    const type = num(h.TYPEHUGQ), np = num(h.NP);
    const ps = (bySerial.get(h.SERIALNO) ?? []).map(person).sort((a, b) => a.sporder - b.sporder);
    if (type === 1) {
      if (!(np > 0) || !(num(h.WGTP) > 0)) continue; // vacant
      if (ps.length !== np) throw new Error(`${h.SERIALNO}: ${ps.length} persons, NP ${np}`);
      hh.push({
        serial: h.SERIALNO, puma: h.PUMA, w: num(h.WGTP), veh: num(h.VEH), incK: (num(h.HINCP) * num(h.ADJINC)) / 1e6 / 1000,
        kind: 0, persons: ps, workers: ps.filter((p) => p.atWork).length,
      });
    } else {
      for (const p of bySerial.get(h.SERIALNO) ?? []) {
        const sp = person(p);
        const kind = type === 2 ? 1 : sp.schg >= 15 ? 2 : 3;
        gq.push({ serial: h.SERIALNO, puma: h.PUMA, w: num(p.PWGTP), veh: 0, incK: Math.max(0, sp.incK), kind, persons: [sp], workers: sp.atWork ? 1 : 0 });
      }
    }
  }
  return { hh, gq };
}

// ---------- controls ----------

type Level = 'bg' | 'tract';
interface ControlSpec {
  name: string;
  geo: Level;
  /** importance in balancing (PopulationSim's): how firmly the control is held */
  imp: number;
  /** the control's incidence: how many of it a seed household holds */
  f: (h: SeedHH) => number;
}

const SPECS: ControlSpec[] = [
  { name: 'households', geo: 'bg', imp: 1e9, f: () => 1 },
  ...[1, 2, 3, 4].map((k) => ({ name: `size${k}${k === 4 ? '+' : ''}`, geo: 'bg' as Level, imp: 1000, f: (h: SeedHH) => +(Math.min(4, h.persons.length) === k) })),
  ...[0, 1, 2, 3].map((k) => ({ name: `veh${k}${k === 3 ? '+' : ''}`, geo: 'bg' as Level, imp: 1000, f: (h: SeedHH) => +(Math.min(3, h.veh) === k) })),
  ...['inc<50k', 'inc50-100k', 'inc100-200k', 'inc200k+'].map((name, k) => ({ name, geo: 'bg' as Level, imp: 500, f: (h: SeedHH) => +(incomeBand(h.incK) === k) })),
  { name: 'persons', geo: 'bg', imp: 1000, f: (h) => h.persons.length },
  ...AGE8.map(([lo, hi], k) => ({ name: `age${lo}${hi > 120 ? '+' : `-${hi}`}`, geo: 'bg' as Level, imp: 300, f: (h: SeedHH) => h.persons.filter((p) => ageGroup(p.age) === k).length })),
  { name: 'male', geo: 'bg', imp: 100, f: (h) => h.persons.filter((p) => !p.female).length },
  { name: 'female', geo: 'bg', imp: 100, f: (h) => h.persons.filter((p) => p.female).length },
  { name: 'employed', geo: 'bg', imp: 300, f: (h) => h.persons.filter((p) => p.employed).length },
  ...[0, 1, 2, 3].map((k) => ({ name: `workers${k}${k === 3 ? '+' : ''}`, geo: 'tract' as Level, imp: 500, f: (h: SeedHH) => +(Math.min(3, h.workers) === k) })),
  { name: 'preschool', geo: 'tract', imp: 100, f: (h) => h.persons.filter((p) => p.schg === 1).length },
  { name: 'gradeK-12', geo: 'tract', imp: 100, f: (h) => h.persons.filter((p) => p.schg >= 2 && p.schg <= 14).length },
  { name: 'undergraduate', geo: 'tract', imp: 100, f: (h) => h.persons.filter((p) => p.schg === 15).length },
  { name: 'graduate', geo: 'tract', imp: 100, f: (h) => h.persons.filter((p) => p.schg === 16).length },
];
const NC = SPECS.length;
const MASTER = 0;

interface Sparse {
  idx: Int32Array;
  val: Float64Array;
}

/** incidence by control (columns) and by household (rows) */
function incidence(seed: SeedHH[]) {
  const cols: Sparse[] = SPECS.map((s) => {
    const idx: number[] = [], val: number[] = [];
    seed.forEach((h, i) => {
      const v = s.f(h);
      if (v) idx.push(i), val.push(v);
    });
    return { idx: Int32Array.from(idx), val: Float64Array.from(val) };
  });
  const rows: { c: Int32Array; v: Float64Array }[] = seed.map(() => ({ c: new Int32Array(0), v: new Float64Array(0) }));
  const rc: number[][] = seed.map(() => []), rv: number[][] = seed.map(() => []);
  cols.forEach((col, c) => col.idx.forEach((h, j) => (rc[h].push(c), rv[h].push(col.val[j]))));
  seed.forEach((_, h) => (rows[h] = { c: Int32Array.from(rc[h]), v: Float64Array.from(rv[h]) }));
  return { cols, rows };
}

// ---------- list balancing ----------

interface Constraint {
  col: number;
  /** the weight vectors (zones) it sums over */
  zones: number[];
  target: number;
  imp: number;
  master: boolean;
  relax: number;
}

/**
 * Entropy-maximizing list balancing after PopulationSim's balancer: each control in turn scales the
 * weights of the households that hold it by γ^incidence, with a Newton step that is damped by the
 * control's importance; a relaxation factor lets an infeasible or inconsistent control give way, more
 * readily the less important it is (importance is halved every 100 iterations until it converges).
 * The master control (households) is held exactly. Several weight vectors (block groups) can be
 * balanced at once, each constraint summing over its own.
 */
function balance(cols: Sparse[], W: Float64Array[], cons: Constraint[], maxIter = 400, tol = 1e-5) {
  const order = [...cons.filter((k) => !k.master), ...cons.filter((k) => k.master)];
  let adj = 1, it = 0, maxDif = 0;
  for (; it < maxIter; it++) {
    if (it > 0 && it % 100 === 0) adj /= 2;
    maxDif = 0;
    for (const k of order) {
      const { idx, val } = cols[k.col];
      let xx = 0, yy = 0;
      for (const z of k.zones) {
        const w = W[z];
        for (let j = 0; j < idx.length; j++) {
          const x = w[idx[j]] * val[j];
          xx += x;
          yy += x * val[j];
        }
      }
      if (xx <= 0) continue;
      const imp = Math.max(k.imp * adj, 1);
      const rc = Math.max(k.target * k.relax, 0.1);
      let g = 1 - (xx - rc) / (yy + rc / imp);
      if (!(g > 1e-10)) g = 1e-10;
      for (const z of k.zones) {
        const w = W[z];
        for (let j = 0; j < idx.length; j++) w[idx[j]] *= val[j] === 1 ? g : Math.pow(g, val[j]);
      }
      if (!k.master) k.relax = Math.min(1e6, k.relax * Math.pow(1 / g, 1 / imp));
      maxDif = Math.max(maxDif, Math.abs(g - 1));
    }
    if (maxDif < tol) break;
  }
  return { iterations: it, maxDif };
}

/**
 * Whole households from balanced weights (PopulationSim's integerizer does this with a linear
 * program; this is a local search to the same end). Each household gets its weight's floor or
 * ceiling and the block group its total households. The households rounded up start as a systematic
 * sample with probability their fractional weight, then pairs are swapped (one rounded up, another
 * down) while that lowers the squared error against the control totals the balanced weights imply,
 * each relative to its total, with λ times the log of the fractional weight as a prior.
 */
function integerize(w: Float64Array, rows: { c: Int32Array; v: Float64Array }[], cols: Sparse[], target: Float64Array, N: number, rand: () => number, lambda = 0.02, maxSwaps = 5000): { n: Int32Array; swaps: number } {
  const n = w.length;
  const out = new Int32Array(n);
  const frac = new Float64Array(n);
  const a = new Float64Array(NC);
  for (let c = 0; c < NC; c++) a[c] = c === MASTER ? 0 : 1 / Math.max(target[c], 1);
  let K = N, F = 0;
  for (let h = 0; h < n; h++) {
    out[h] = Math.floor(w[h] + 1e-9);
    frac[h] = Math.max(0, w[h] - out[h]);
    F += frac[h];
    K -= out[h];
  }
  // fewer households than the floors (rare): drop copies from the smallest weights
  for (; K < 0; K++) {
    let worst = -1;
    for (let h = 0; h < n; h++) if (out[h] > 0 && (worst < 0 || w[h] < w[worst])) worst = h;
    out[worst]--;
  }
  // 1. a systematic sample of K households, with probability their fractional weight
  const up = new Uint8Array(n);
  let got = 0;
  if (K > 0 && F > 0) {
    const step = F / K;
    let cum = 0, h = 0;
    const u0 = rand() * step;
    for (let k = 0; k < K; k++) {
      const x = u0 + k * step;
      while (h < n - 1 && cum + frac[h] <= x) cum += frac[h++];
      if (!up[h]) (up[h] = 1), got++;
    }
  }
  // (a fractional weight above the sampling step can be hit twice; the largest others make up the count)
  while (got < K) {
    let best = -1;
    for (let h = 0; h < n; h++) if (!up[h] && (best < 0 || frac[h] > frac[best])) best = h;
    if (best < 0 || frac[best] <= 0) break;
    up[best] = 1;
    got++;
  }
  for (; got < K; got++) {
    // more households than the weights allow: the largest weights take another copy
    let best = 0;
    for (let h = 1; h < n; h++) if (w[h] > w[best]) best = h;
    out[best]++;
  }
  for (let h = 0; h < n; h++) out[h] += up[h];
  // 2. residuals, and each household's score against them
  const r = Float64Array.from(target);
  for (let h = 0; h < n; h++) {
    const { c, v } = rows[h];
    for (let j = 0; j < c.length; j++) r[c[j]] -= out[h] * v[j];
  }
  const s = new Float64Array(n), q = new Float64Array(n);
  for (let h = 0; h < n; h++) {
    const { c, v } = rows[h];
    for (let j = 0; j < c.length; j++) {
      s[h] += a[c[j]] * r[c[j]] * v[j];
      q[h] += a[c[j]] * v[j] * v[j];
    }
  }
  const lnf = Float64Array.from(frac, (f) => (f > 1e-9 ? Math.log(f) : -Infinity));
  const shift = (h: number, sign: number) => {
    const { c, v } = rows[h];
    for (let j = 0; j < c.length; j++) {
      const cc = c[j], d = sign * v[j];
      r[cc] -= d;
      const col = cols[cc], f = a[cc] * d;
      if (f === 0) continue;
      for (let i = 0; i < col.idx.length; i++) s[col.idx[i]] -= f * col.val[i];
    }
  };
  // 3. swaps while they help: the best household to round up and the best to round down
  let swaps = 0;
  for (; swaps < maxSwaps; swaps++) {
    let bi = -1, gi = -Infinity, bj = -1, gj = -Infinity;
    for (let h = 0; h < n; h++) {
      if (lnf[h] === -Infinity) continue;
      if (up[h]) {
        const g = -2 * s[h] - q[h] - lambda * lnf[h];
        if (g > gj) (gj = g), (bj = h);
      } else {
        const g = 2 * s[h] - q[h] + lambda * lnf[h];
        if (g > gi) (gi = g), (bi = h);
      }
    }
    if (bi < 0 || bj < 0) break;
    // the exact gain adds twice the controls the two share
    let cross = 0;
    const ri = rows[bi], rj = rows[bj];
    for (let x = 0, y = 0; x < ri.c.length && y < rj.c.length; ) {
      if (ri.c[x] === rj.c[y]) (cross += a[ri.c[x]] * ri.v[x] * rj.v[y]), x++, y++;
      else if (ri.c[x] < rj.c[y]) x++;
      else y++;
    }
    if (gi + gj + 2 * cross <= 1e-9) break;
    up[bi] = 1;
    out[bi]++;
    shift(bi, 1);
    up[bj] = 0;
    out[bj]--;
    shift(bj, -1);
  }
  return { n: out, swaps };
}

// ---------- main ----------

interface SynHH {
  zone: number;
  seed: SeedHH;
  kind: number;
}

function main() {
  console.time('synpop');
  const zonesF = JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8'));
  const zones = (zonesF.internal as { id: string }[]).map((z) => z.id);
  const NZ = zones.length;
  const tractOf = zones.map((id) => id.slice(0, 11));
  const pumaOfTract = new Map<string, string>();
  for (const l of fs.readFileSync(`${RAW}/commute-county/2020_Census_Tract_to_2020_PUMA.txt`, 'utf8').replace(/^﻿/, '').trim().split('\n').slice(1)) {
    const [st, co, tr, pu] = l.trim().split(',');
    if (st === '06' && co === '075') pumaOfTract.set(`06075${tr}`, pu);
  }
  const pumaOf = zones.map((_, z) => pumaOfTract.get(tractOf[z])!);
  const tracts = [...new Set(tractOf)];
  const bgsOfTract = new Map(tracts.map((t) => [t, zones.map((_, z) => z).filter((z) => tractOf[z] === t)]));

  const { hh: seedHH, gq: seedGQ } = loadSeed();
  console.log(`seed: ${seedHH.length} households (${seedHH.reduce((a, h) => a + h.persons.length, 0)} persons), ${seedGQ.length} group-quarters persons`);

  // ---- ACS tables ----
  const b11016 = readAcs('acs_b11016.dat'), b25044 = readAcs('acs_b25044.dat'), b19001 = readAcs('acs_b19001.dat');
  const b25008 = readAcs('acs_b25008.dat'), b01001 = readAcs('acs_b01001.dat'), b23025 = readAcs('acs_b23025.dat');
  const b11001 = readAcs('acs_b11001.dat');
  const b08202 = readAcs('acs_b08202_tract.dat'), b14001 = readAcs('acs_b14001_tract.dat');

  // ---- group quarters ----
  const gq2020 = JSON.parse(fs.readFileSync(`${WORK}/gq2020-bg.json`, 'utf8')).blockGroups as Record<string, Record<string, number>>;
  const acsGQ = zones.reduce((a, id) => a + Math.max(0, sum(b01001.get(id), 'E001') - sum(b25008.get(id), 'E001')), 0);
  const gqTypes = (r: Record<string, number> | undefined) => (r ? [r.institutional, r.college, r.military + r.otherNoninstitutional] : [0, 0, 0]);
  const gq2020Total = zones.reduce((a, id) => a + gqTypes(gq2020[id]).reduce((x, y) => x + y, 0), 0);
  // each block group's group-quarters residents: the ACS's (all residents less those in households, so
  // the person controls stay consistent), split by type as the 2020 census found them there (else in
  // its tract, else citywide)
  const shareOf = (v: number[]) => {
    const t = v.reduce((x, y) => x + y, 0);
    return t > 0 ? v.map((x) => x / t) : null;
  };
  const tractGQ = new Map<string, number[]>();
  zones.forEach((id) => {
    const t = id.slice(0, 11), v = gqTypes(gq2020[id]);
    tractGQ.set(t, (tractGQ.get(t) ?? [0, 0, 0]).map((x, k) => x + v[k]));
  });
  const cityGQ = shareOf([...tractGQ.values()].reduce((a, v) => a.map((x, k) => x + v[k]), [0, 0, 0]))!;
  const gqCount = zones.map((id) => {
    const n = Math.max(0, sum(b01001.get(id), 'E001') - sum(b25008.get(id), 'E001'));
    const sh = shareOf(gqTypes(gq2020[id])) ?? shareOf(tractGQ.get(id.slice(0, 11))!) ?? cityGQ;
    return sh.map((x) => x * n);
  });
  const random = rng(20242025);
  const synGQ: SynHH[] = [];
  {
    // bucket rounding keeps each type's citywide total
    const carry = [0, 0, 0];
    const pool = [1, 2, 3].map((k) => seedGQ.filter((g) => g.kind === k));
    const cum = pool.map((p) => {
      const c: number[] = [];
      let t = 0;
      for (const g of p) c.push((t += g.w));
      return c;
    });
    zones.forEach((id, z) => {
      gqCount[z].forEach((n, t) => {
        const x = n + carry[t];
        const k = Math.round(x);
        carry[t] = x - k;
        // systematic sampling proportional to the person weights
        const W = cum[t][cum[t].length - 1];
        const start = random() * (W / Math.max(k, 1));
        let j = 0;
        for (let i = 0; i < k; i++) {
          const u = (start + (i * W) / k) % W;
          let lo = 0, hi = cum[t].length - 1;
          while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (cum[t][m] > u) hi = m;
            else lo = m + 1;
          }
          j = lo;
          synGQ.push({ zone: z, seed: pool[t][j], kind: t + 1 });
        }
      });
    });
  }
  const gqZone = Array.from({ length: NZ }, (_, z) => synGQ.filter((g) => g.zone === z).map((g) => g.seed.persons[0]));
  console.log(`group quarters: ${synGQ.length} residents (ACS ${Math.round(acsGQ)}; 2020 census ${gq2020Total})`);

  // ---- controls by block group and tract (persons in households: the ACS's less group quarters) ----
  const bgCtl = SPECS.map(() => new Float64Array(NZ));
  const C = (name: string) => SPECS.findIndex((s) => s.name === name);
  zones.forEach((id, z) => {
    const s = b11016.get(id), v = b25044.get(id), i = b19001.get(id), a = b01001.get(id), e = b23025.get(id);
    const set = (name: string, x: number) => (bgCtl[C(name)][z] = Math.max(0, x));
    set('households', sum(b11001.get(id), 'E001'));
    set('size1', sum(s, 'E010'));
    set('size2', sum(s, 'E003', 'E011'));
    set('size3', sum(s, 'E004', 'E012'));
    set('size4+', sum(s, ...E(5, 8), ...E(13, 16)));
    set('veh0', sum(v, 'E003', 'E010'));
    set('veh1', sum(v, 'E004', 'E011'));
    set('veh2', sum(v, 'E005', 'E012'));
    set('veh3+', sum(v, 'E006', 'E007', 'E008', 'E013', 'E014', 'E015'));
    set('inc<50k', sum(i, ...E(2, 10)));
    set('inc50-100k', sum(i, ...E(11, 13)));
    set('inc100-200k', sum(i, ...E(14, 16)));
    set('inc200k+', sum(i, 'E017'));
    const hhPop = sum(b25008.get(id), 'E001');
    set('persons', hhPop);
    // age (both sexes) and sex, less the block group's synthesized group-quarters residents, scaled to
    // the persons in households
    const ageCols: string[][] = [[3], [4, 5, 6], [7, 8, 9, 10], [11, 12], [13, 14, 15], [16, 17, 18, 19], [20, 21, 22, 23], [24, 25]].map((ks) => ks.flatMap((k) => [`E${String(k).padStart(3, '0')}`, `E${String(k + 24).padStart(3, '0')}`]));
    let ages = ageCols.map((ks, k) => Math.max(0, sum(a, ...ks) - gqZone[z].filter((p) => ageGroup(p.age) === k).length));
    if (ages.reduce((x, y) => x + y, 0) <= 0) ages = ageCols.map((ks) => sum(a, ...ks));
    const at = ages.reduce((x, y) => x + y, 0);
    AGE8.forEach(([lo, hi], k) => set(`age${lo}${hi > 120 ? '+' : `-${hi}`}`, at > 0 ? (ages[k] * hhPop) / at : 0));
    let male = Math.max(0, sum(a, 'E002') - gqZone[z].filter((p) => !p.female).length), female = Math.max(0, sum(a, 'E026') - gqZone[z].filter((p) => p.female).length);
    if (male + female <= 0) (male = sum(a, 'E002')), (female = sum(a, 'E026'));
    set('male', male + female > 0 ? (male * hhPop) / (male + female) : 0);
    set('female', male + female > 0 ? (female * hhPop) / (male + female) : 0);
    set('employed', sum(e, 'E004', 'E006') - gqZone[z].filter((p) => p.employed).length);
    // tract controls are filled below
  });
  const trCtl = new Map<string, Float64Array>();
  for (const t of tracts) {
    const w = b08202.get(t), sc = b14001.get(t);
    const bgs = bgsOfTract.get(t)!;
    const g = bgs.flatMap((z) => gqZone[z]);
    const v = new Float64Array(NC);
    v[C('workers0')] = sum(w, 'E002');
    v[C('workers1')] = sum(w, 'E003');
    v[C('workers2')] = sum(w, 'E004');
    v[C('workers3+')] = sum(w, 'E005');
    v[C('preschool')] = Math.max(0, sum(sc, 'E003') - g.filter((p) => p.schg === 1).length);
    v[C('gradeK-12')] = Math.max(0, sum(sc, ...E(4, 7)) - g.filter((p) => p.schg >= 2 && p.schg <= 14).length);
    v[C('undergraduate')] = Math.max(0, sum(sc, 'E008') - g.filter((p) => p.schg === 15).length);
    v[C('graduate')] = Math.max(0, sum(sc, 'E009') - g.filter((p) => p.schg === 16).length);
    // the workers table's households, to the block groups' (both ACS, they differ by rounding)
    const hhT = bgs.reduce((a, z) => a + bgCtl[MASTER][z], 0);
    const wt = [0, 1, 2, 3].reduce((a, k) => a + v[C('workers0') + k], 0);
    if (wt > 0) for (let k = 0; k < 4; k++) v[C('workers0') + k] *= hhT / wt;
    trCtl.set(t, v);
  }

  // ---- balance and integerize, PUMA by PUMA ----
  const counts: { zone: number; seed: SeedHH; n: number }[] = [];
  const intRand = rng(1234);
  // the balanced (fractional) weights' totals by block group, to tell balancing from rounding
  const floatBy = SPECS.map(() => new Float64Array(NZ));
  const balanceLog: { puma: string; seed: number; iterations: number; tractIterations: number[] }[] = [];
  for (const puma of SF_PUMAS) {
    const seed = seedHH.filter((h) => h.puma === puma);
    const { cols, rows } = incidence(seed);
    const pz = zones.map((_, z) => z).filter((z) => pumaOf[z] === puma);
    const pt = tracts.filter((t) => pumaOfTract.get(t) === puma);
    // 1. the PUMA's seed weights to its control totals
    const wP = Float64Array.from(seed, (h) => h.w);
    const total = (c: number) => (SPECS[c].geo === 'bg' ? pz.reduce((a, z) => a + bgCtl[c][z], 0) : pt.reduce((a, t) => a + trCtl.get(t)![c], 0));
    const r1 = balance(cols, [wP], SPECS.map((s, c) => ({ col: c, zones: [0], target: total(c), imp: s.imp, master: c === MASTER, relax: 1 })));
    const hhP = total(MASTER);
    const log = { puma, seed: seed.length, iterations: r1.iterations, tractIterations: [] as number[] };
    // 2. tract by tract: a weight per seed household and block group
    for (const t of pt) {
      const bgs = bgsOfTract.get(t)!.filter((z) => bgCtl[MASTER][z] > 0);
      if (!bgs.length) continue;
      const W = bgs.map((z) => Float64Array.from(wP, (x) => (x * bgCtl[MASTER][z]) / hhP));
      const cons: Constraint[] = [];
      SPECS.forEach((s, c) => {
        if (s.geo === 'bg') bgs.forEach((z, k) => cons.push({ col: c, zones: [k], target: bgCtl[c][z], imp: s.imp, master: c === MASTER, relax: 1 }));
        else cons.push({ col: c, zones: bgs.map((_, k) => k), target: trCtl.get(t)![c], imp: s.imp, master: false, relax: 1 });
      });
      const r2 = balance(cols, W, cons);
      log.tractIterations.push(r2.iterations);
      // 3. whole households, block group by block group, keeping the totals the weights imply
      bgs.forEach((z, k) => {
        const target = new Float64Array(NC);
        cols.forEach((col, c) => {
          let x = 0;
          for (let j = 0; j < col.idx.length; j++) x += W[k][col.idx[j]] * col.val[j];
          target[c] = x;
          floatBy[c][z] = x;
        });
        const { n } = integerize(W[k], rows, cols, target, Math.round(bgCtl[MASTER][z]), intRand);
        n.forEach((m, h) => m > 0 && counts.push({ zone: z, seed: seed[h], n: m }));
      });
    }
    balanceLog.push(log);
    console.log(`PUMA ${puma}: ${seed.length} seed households, ${pz.length} block groups, PUMA balance ${r1.iterations} iterations, tracts ${Math.min(...log.tractIterations)}–${Math.max(...log.tractIterations)}`);
  }

  // ---- expand to households and persons ----
  const syn: SynHH[] = [];
  for (const c of counts) for (let k = 0; k < c.n; k++) syn.push({ zone: c.zone, seed: c.seed, kind: 0 });
  syn.push(...synGQ);
  syn.sort((a, b) => a.zone - b.zone || a.kind - b.kind || Math.min(3, a.seed.veh) - Math.min(3, b.seed.veh) || incomeBand(a.seed.incK) - incomeBand(b.seed.incK) || a.seed.persons.length - b.seed.persons.length || a.seed.incK - b.seed.incK || (a.seed.serial < b.seed.serial ? -1 : a.seed.serial > b.seed.serial ? 1 : 0));

  // working from home at 2024 rates: the share of 2024's PUMS workers at work who worked at home, by
  // person type (full time, part time, other) and household income band
  const wfhCell = (p: SeedPerson, incK: number) => (p.ptype === 1 ? 0 : p.ptype === 2 ? 1 : 2) * 4 + incomeBand(incK);
  const wfhN = new Float64Array(12), wfhD = new Float64Array(12);
  for (const h of [...seedHH, ...seedGQ])
    for (const p of h.persons)
      if (p.year === 2024 && p.atWork) {
        const k = wfhCell(p, h.incK);
        wfhD[k] += h.w;
        if (p.wfh) wfhN[k] += h.w;
      }
  const wfhRate = Array.from(wfhD, (d, k) => (d > 0 ? wfhN[k] / d : 0));
  // scaled so the employed residents' share is the ACS 2024 one-year figure the model uses
  {
    let e = 0, x = 0;
    for (const h of syn) for (const p of h.seed.persons) if (p.employed) (e++, (x += wfhRate[wfhCell(p, h.seed.incK)]));
    const f = (WFH_RESIDENTS_2024 * e) / x;
    for (let k = 0; k < 12; k++) wfhRate[k] = Math.min(1, wfhRate[k] * f);
    console.log(`working from home, 2024 PUMS rates scaled by ${f.toFixed(3)} to ${WFH_RESIDENTS_2024}`);
  }
  const wfhRand = rng(7);

  const hhLines = ['hh_id,zone,block_group,puma,kind,size,workers,vehicles,income_k,income_band,seed,serialno'];
  const pLines = ['hh_id,person,age,sex,ptype,employed,wfh,student,sporder'];
  let wfhW = 0, empW = 0;
  syn.forEach((h, i) => {
    const s = h.seed;
    let workers = 0;
    s.persons.forEach((p, k) => {
      const wfh = p.employed && wfhRand() < wfhRate[wfhCell(p, s.incK)];
      if (p.employed) (empW++, wfh && wfhW++);
      if (p.employed) workers++;
      pLines.push(`${i},${k + 1},${p.age},${p.female ? 2 : 1},${p.ptype},${+p.employed},${+wfh},${p.student},${p.sporder}`);
    });
    hhLines.push(`${i},${h.zone},${zones[h.zone]},${pumaOf[h.zone]},${h.kind},${s.persons.length},${workers},${s.veh},${Math.round(Math.max(0, s.incK))},${incomeBand(s.incK)},${hhSeed(i)},${s.serial}`);
  });
  fs.writeFileSync(`${WORK}/synpop-households.csv.gz`, zlib.gzipSync(hhLines.join('\n') + '\n'));
  fs.writeFileSync(`${WORK}/synpop-persons.csv.gz`, zlib.gzipSync(pLines.join('\n') + '\n'));
  const nHH = syn.filter((h) => h.kind === 0).length, nP = syn.reduce((a, h) => a + h.seed.persons.length, 0);
  console.log(`synthetic population: ${nHH} households, ${synGQ.length} group-quarters residents, ${nP} persons; working from home ${(100 * wfhW / empW).toFixed(1)}% of the employed`);

  // ---------- validation ----------
  const synBy = SPECS.map(() => new Float64Array(NZ));
  for (const h of syn) if (h.kind === 0) SPECS.forEach((s, c) => (synBy[c][h.zone] += s.f(h.seed)));
  const pctRmse = (mod: ArrayLike<number>, obs: ArrayLike<number>) => {
    let se = 0, so = 0;
    for (let i = 0; i < obs.length; i++) (se += (mod[i] - obs[i]) ** 2), (so += obs[i]);
    return (100 * Math.sqrt(se / obs.length)) / (so / obs.length);
  };
  const r2 = (mod: ArrayLike<number>, obs: ArrayLike<number>) => {
    const n = obs.length;
    let mo = 0, mm = 0;
    for (let i = 0; i < n; i++) (mo += obs[i] / n), (mm += mod[i] / n);
    let c = 0, vo = 0, vm = 0;
    for (let i = 0; i < n; i++) (c += (obs[i] - mo) * (mod[i] - mm)), (vo += (obs[i] - mo) ** 2), (vm += (mod[i] - mm) ** 2);
    return (c * c) / (vo * vm);
  };
  const controlFit = SPECS.map((s, c) => {
    if (s.geo === 'bg') {
      const obs = bgCtl[c], mod = synBy[c];
      return { control: s.name, geography: 'block group', zones: NZ, total: Math.round(obs.reduce((a, x) => a + x, 0)), synthetic: Math.round(mod.reduce((a, x) => a + x, 0)), pctRmse: +pctRmse(mod, obs).toFixed(2), pctRmseBalanced: +pctRmse(floatBy[c], obs).toFixed(2), r2: +r2(mod, obs).toFixed(4) };
    }
    const obs = tracts.map((t) => trCtl.get(t)![c]), mod = tracts.map((t) => bgsOfTract.get(t)!.reduce((a, z) => a + synBy[c][z], 0));
    const fl = tracts.map((t) => bgsOfTract.get(t)!.reduce((a, z) => a + floatBy[c][z], 0));
    return { control: s.name, geography: 'tract', zones: tracts.length, total: Math.round(obs.reduce((a, x) => a + x, 0)), synthetic: Math.round(mod.reduce((a, x) => a + x, 0)), pctRmse: +pctRmse(mod, obs).toFixed(2), pctRmseBalanced: +pctRmse(fl, obs).toFixed(2), r2: +r2(mod, obs).toFixed(4) };
  });
  console.log('control fit (%RMSE across zones):');
  for (const f of controlFit) console.log(`  ${f.control.padEnd(14)} ${f.geography.padEnd(12)} control ${String(f.total).padStart(7)} synthetic ${String(f.synthetic).padStart(7)}  %RMSE ${f.pctRmse.toFixed(2)} (balanced ${f.pctRmseBalanced.toFixed(2)})`);

  // the ACS's own counts, all residents (group quarters included), against the synthetic population
  const all = (f: (p: SeedPerson) => boolean) => {
    const v = new Float64Array(NZ);
    for (const h of syn) for (const p of h.seed.persons) if (f(p)) v[h.zone]++;
    return v;
  };
  const acsAll = {
    persons: zones.map((id) => sum(b01001.get(id), 'E001')),
    under18: zones.map((id) => sum(b01001.get(id), 'E003', 'E004', 'E005', 'E006', 'E027', 'E028', 'E029', 'E030')),
    age65plus: zones.map((id) => sum(b01001.get(id), ...E(20, 25), ...E(44, 49))),
    employed: zones.map((id) => sum(b23025.get(id), 'E004', 'E006')),
    groupQuarters: zones.map((id) => Math.max(0, sum(b01001.get(id), 'E001') - sum(b25008.get(id), 'E001'))),
  };
  const synAll = {
    persons: all(() => true),
    under18: all((p) => p.age < 18),
    age65plus: all((p) => p.age >= 65),
    employed: all((p) => p.employed),
    groupQuarters: Float64Array.from({ length: NZ }, (_, z) => gqZone[z].length),
  };
  const acsMargins = Object.fromEntries(Object.entries(acsAll).map(([k, obs]) => [k, { acs: Math.round(obs.reduce((a, x) => a + x, 0)), synthetic: Math.round((synAll as Record<string, Float64Array>)[k].reduce((a, x) => a + x, 0)), pctRmseBlockGroups: +pctRmse((synAll as Record<string, Float64Array>)[k], obs).toFixed(2) }]));

  // citywide distributions the controls don't fix, against the PUMS (weighted)
  type Rec = { h: SeedHH; w: number };
  const synRecs: Rec[] = syn.filter((h) => h.kind === 0).map((h) => ({ h: h.seed, w: 1 }));
  const pumsRecs: Rec[] = seedHH.map((h) => ({ h, w: h.w }));
  const crossHH = (recs: Rec[], key: (h: SeedHH) => string) => {
    const m: Record<string, number> = {};
    let t = 0;
    for (const r of recs) (m[key(r.h)] = (m[key(r.h)] ?? 0) + r.w), (t += r.w);
    for (const k in m) m[k] /= t;
    return m;
  };
  const crossP = (recs: Rec[], key: (p: SeedPerson, h: SeedHH) => string) => {
    const m: Record<string, number> = {};
    let t = 0;
    for (const r of recs) for (const p of r.h.persons) (m[key(p, r.h)] = (m[key(p, r.h)] ?? 0) + r.w), (t += r.w);
    for (const k in m) m[k] /= t;
    return m;
  };
  const compare = (a: Record<string, number>, b: Record<string, number>) => {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    let se = 0, mx = 0;
    for (const k of keys) {
      const d = (a[k] ?? 0) - (b[k] ?? 0);
      se += d * d;
      mx = Math.max(mx, Math.abs(d));
    }
    // standardized RMSE: RMSE over the mean cell share
    return { cells: keys.length, srmse: +(Math.sqrt(se / keys.length) / (1 / keys.length)).toFixed(3), maxDiffPts: +(100 * mx).toFixed(2), synthetic: Object.fromEntries(keys.map((k) => [k, +(100 * (a[k] ?? 0)).toFixed(2)])), pums: Object.fromEntries(keys.map((k) => [k, +(100 * (b[k] ?? 0)).toFixed(2)])) };
  };
  const vehK = (h: SeedHH) => ['0', '1', '2', '3+'][Math.min(3, h.veh)];
  const incK = (h: SeedHH) => ['<50k', '50-100k', '100-200k', '200k+'][incomeBand(h.incK)];
  const sizeK = (h: SeedHH) => ['1', '2', '3', '4+'][Math.min(4, h.persons.length) - 1];
  const crosstabs = {
    'vehicles × income × size': compare(crossHH(synRecs, (h) => `${vehK(h)}|${incK(h)}|${sizeK(h)}`), crossHH(pumsRecs, (h) => `${vehK(h)}|${incK(h)}|${sizeK(h)}`)),
    'vehicles × income (demand segments)': compare(crossHH(synRecs, (h) => `${['0', '1', '2+'][Math.min(2, h.veh)]}|${incK(h)}`), crossHH(pumsRecs, (h) => `${['0', '1', '2+'][Math.min(2, h.veh)]}|${incK(h)}`)),
    'workers × vehicles': compare(crossHH(synRecs, (h) => `${Math.min(3, h.workers)}|${vehK(h)}`), crossHH(pumsRecs, (h) => `${Math.min(3, h.workers)}|${vehK(h)}`)),
    'age × employed': compare(crossP(synRecs, (p) => `${ageGroup(p.age)}|${+p.employed}`), crossP(pumsRecs, (p) => `${ageGroup(p.age)}|${+p.employed}`)),
    'person type': compare(crossP(synRecs, (p) => PTYPES[p.ptype - 1]), crossP(pumsRecs, (p) => PTYPES[p.ptype - 1])),
    'person type × household vehicles': compare(crossP(synRecs, (p, h) => `${p.ptype}|${vehK(h)}`), crossP(pumsRecs, (p, h) => `${p.ptype}|${vehK(h)}`)),
  };
  for (const [k, v] of Object.entries(crosstabs)) console.log(`  ${k}: ${v.cells} cells, SRMSE ${v.srmse}, largest gap ${v.maxDiffPts} points`);
  // the 1-year PUMS seed the aggregate model rakes (reference/sf-hh-vehicles-income.json), for comparison
  const ref1 = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-hh-vehicles-income.json`, 'utf8')).households as number[][];
  const ref1T = ref1.flat().reduce((a, x) => a + x, 0);
  const pums1yr = Object.fromEntries(ref1.flatMap((r, s) => r.map((x, k) => [`${['0', '1', '2+'][s]}|${['<50k', '50-100k', '100-200k', '200k+'][k]}`, x / ref1T])));

  const out = {
    description:
      'A synthetic population of San Francisco: every household and resident, listed from the ACS 2020–24 five-year PUMS and balanced to census counts by block group and tract (server/beta3/pipeline/synpop.ts). This file lists its sources and controls and records how well it fits.',
    method: {
      approach: 'List-based synthesis as in PopulationSim (RSG / ActivitySim consortium; used by SF-CHAMP, ActivitySim, and MTC Travel Model Two): PUMA seed balancing, then simultaneous balancing of block groups within each tract with household and person controls together (IPU, Ye et al. 2009), then integerization. Group-quarters residents are synthesized separately.',
      seedGeography: 'PUMA (2020 definitions, 07507–07514)',
      importance: Object.fromEntries(SPECS.map((s) => [s.name, s.imp])),
      integerizer: 'each household its weight floor or ceiling; households rounded up chosen greedily to minimize the squared error relative to each control total implied by the balanced weights, with λ = 0.02 times the log of the fractional weight as a prior',
      workFromHome: 'drawn for each employed person at the 2024 PUMS records’ rate for their person type (full time, part time, other) and household income band, scaled to the ACS 2024 one-year share (21.4%); the 2020–21 records reflect pandemic working (32.5% and 45.4% of workers at work worked from home, against 21.4% in 2024)',
      personTypes: 'ActivitySim / TM1: full time = employed, 35+ hours a week and 40+ weeks a year; students by SCHG (grade school past age 19 counts as university)',
      groupQuarters: 'Each block group’s ACS 2020–24 group-quarters population (B01001 less B25008), split by the 2020 census P5 counts there (else in its tract, else citywide) into institutional; college/university housing; military and other non-institutional. Drawn from the city’s PUMS group-quarters persons of the same kind (college: non-institutional and enrolled in college) by systematic sampling with their weights.',
    },
    sources: [
      { name: 'ACS 2020–2024 5-year PUMS, California housing and person files', url: 'https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/', files: ['csv_hca.zip', 'csv_pca.zip'], use: 'seed households and persons (San Francisco PUMAs 07507–07514)' },
      { name: 'ACS 2020–2024 5-year summary file tables, block groups', url: 'https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/', tables: { B11001: 'households', B11016: 'households by size', B25044: 'households by vehicles available', B19001: 'household income', B25008: 'population in occupied housing units', B01001: 'sex by age', B23025: 'employment status' } },
      { name: 'ACS 2020–2024 5-year summary file tables, tracts', url: 'https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/', tables: { B08202: 'households by number of workers', B14001: 'school enrollment by level' } },
      { name: '2020 Census Redistricting Data (P.L. 94-171), table P5', url: 'https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/California/ca2020.pl.zip', use: 'group-quarters population by type and block group' },
      { name: '2020 Census tract to 2020 PUMA relationship file', url: 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/2020_Census_Tract_to_2020_PUMA.txt' },
      { name: 'PopulationSim', url: 'https://activitysim.github.io/populationsim/', note: 'RSG and the ActivitySim consortium (AMPO); list balancer and integerizer' },
      { name: 'Ye, X., Konduri, K., Pendyala, R. M., Sana, B., & Waddell, P. (2009). A methodology to match distributions of both household and person attributes in the generation of synthetic populations. 88th Annual Meeting of the Transportation Research Board.' },
    ],
    summary: {
      households: nHH,
      groupQuartersResidents: synGQ.length,
      persons: nP,
      workFromHomeShareOfEmployed: +(wfhW / empW).toFixed(4),
      workFromHomeTarget2024: WFH_RESIDENTS_2024,
      seedHouseholds: seedHH.length,
      seedGroupQuartersPersons: seedGQ.length,
      groupQuarters2020Census: gq2020Total,
    },
    controlFit,
    acsMargins,
    crosstabs,
    vehiclesIncome1yrPums: Object.fromEntries(Object.entries(pums1yr).map(([k, v]) => [k, +(100 * v).toFixed(2)])),
    balancing: balanceLog.map((l) => ({ puma: l.puma, seedHouseholds: l.seed, pumaIterations: l.iterations, tractIterationsMax: Math.max(...l.tractIterations), tractIterationsMedian: l.tractIterations.sort((a, b) => a - b)[l.tractIterations.length >> 1] })),
  };
  fs.writeFileSync(`${REFERENCE}/synpop.json`, JSON.stringify(out, null, 1) + '\n');
  console.timeEnd('synpop');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
