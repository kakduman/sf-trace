/**
 * Households for the car ownership model (shared/beta3/autoown.ts): each block group's households
 * as classes of drivers × workers × income, built from the ACS.
 *
 *  1. The city's households from the ACS 2024 1-year PUMS (SF PUMAs 07507–07514; housing units with
 *     people in them), with their persons' ages and employment from the person file.
 *  2. For each block group, the records are reweighted (iterative proportional updating, Ye et al.
 *     2009, as PopulationSim does) to its ACS 2020–24 tables: households by income (B19001, the four
 *     BATS bands), by size and workers (B08202, published by tract: the tract's shares, scaled to the
 *     block group's households), and persons by age (B01001, as shares of the household population
 *     the weights imply, since B01001 counts group quarters too). Records start at their PUMS
 *     weights, those from the block group's own PUMA counted four times.
 *  3. The reweighted records are grouped into classes (aoClassesFromHouseholds) and written to
 *     work/autoown.json with each block group's households by cars (B25044: 0, 1, 2, 3, 4+), the
 *     calibration's targets. Car ownership itself is never a control: the model predicts it.
 *
 * A synthetic population (one record per household) can replace steps 1–2: aoClassesFromHouseholds
 * takes its households as they are.
 *
 * Run: npx tsx server/beta3/pipeline/autoown.ts (after zones.ts; build.ts packs the result)
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { RAW, WORK } from './paths';
import { aoClassesFromHouseholds, AO_STRIDE, type AoHousehold } from '../../../shared/beta3/autoown';

const SF_PUMAS = ['07507', '07508', '07509', '07510', '07511', '07512', '07513', '07514'];
const EXTRACT = `${RAW}/income/pums2024_sf_autoown.json`;

/** one PUMS household: weight, PUMA, income (2024 $), vehicles, and its persons [age, employed, at work] */
interface PumsHh {
  w: number;
  puma: string;
  inc: number;
  veh: number;
  p: [number, number, number][];
}

function csvRows(zip: string, file: string, keep: (c: string[], col: Record<string, number>) => boolean, onRow: (c: string[], col: Record<string, number>) => void) {
  const text = execFileSync('unzip', ['-p', zip, file], { maxBuffer: 1 << 30 }).toString('latin1');
  let col: Record<string, number> | null = null;
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end < 0) break;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    const c = line.split(',');
    if (!col) {
      col = Object.fromEntries(c.map((h, i) => [h, i]));
      continue;
    }
    if (keep(c, col)) onRow(c, col);
  }
}

function extractPums(): PumsHh[] {
  if (fs.existsSync(EXTRACT) && fs.statSync(EXTRACT).size > 0) return JSON.parse(fs.readFileSync(EXTRACT, 'utf8'));
  const inSF = (c: string[], col: Record<string, number>) => SF_PUMAS.includes(c[col.PUMA].padStart(5, '0'));
  const hh = new Map<string, PumsHh>();
  csvRows(`${RAW}/income/csv_hca_2024.zip`, 'psam_h06.csv', inSF, (c, col) => {
    // housing units only (TYPEHUGQ 1) with people in them
    if (c[col.TYPEHUGQ] !== '1' || !(Number(c[col.NP]) > 0) || c[col.VEH] === '') return;
    hh.set(c[col.SERIALNO], { w: Number(c[col.WGTP]), puma: c[col.PUMA].padStart(5, '0'), inc: Math.round((Number(c[col.HINCP]) * Number(c[col.ADJINC])) / 1e6), veh: Number(c[col.VEH]), p: [] });
  });
  csvRows(`${RAW}/income/csv_pca_2024.zip`, 'psam_p06.csv', inSF, (c, col) => {
    const h = hh.get(c[col.SERIALNO]);
    if (!h) return;
    const esr = c[col.ESR];
    // employed (civilian or armed forces, at work or with a job); at work in the reference week
    h.p.push([Number(c[col.AGEP]), ['1', '2', '4', '5'].includes(esr) ? 1 : 0, ['1', '4'].includes(esr) ? 1 : 0]);
  });
  const out = [...hh.values()].filter((h) => h.p.length > 0);
  fs.writeFileSync(EXTRACT, JSON.stringify(out));
  return out;
}

function readAcs(file: string): Map<string, Record<string, number>> {
  const lines = fs.readFileSync(`${RAW}/census/${file}`, 'utf8').trim().split('\n');
  const head = lines[0].split('|');
  const out = new Map<string, Record<string, number>>();
  for (const l of lines.slice(1)) {
    const c = l.split('|');
    const rec: Record<string, number> = {};
    // estimates (E001...) and their 90% margins of error (M001...)
    head.forEach((h, i) => {
      if (i > 0 && (h.includes('_E') || h.includes('_M'))) rec[h.slice(h.indexOf('_') + 1)] = Number(c[i]) || 0;
    });
    out.set(c[0].slice(c[0].indexOf('US') + 2), rec);
  }
  return out;
}
const sum = (r: Record<string, number>, ...k: string[]) => k.reduce((s, x) => s + (r[x] ?? 0), 0);
const E = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `E${String(a + i).padStart(3, '0')}`);

/** the PUMA of a block group (2020 tract → 2020 PUMA), from the PUMS records' own tract relationship */
function pumaOfTract(): Map<string, string> {
  const f = `${RAW}/census/tract_puma2020_06.txt`;
  if (!fs.existsSync(f)) return new Map();
  const m = new Map<string, string>();
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').slice(1)) {
    const [st, co, tr, puma] = l.split(',');
    if (st === '06' && co === '075') m.set(`06075${tr}`, puma);
  }
  return m;
}

function main() {
  console.time('autoown');
  const recs = extractPums();
  const N = recs.length;
  console.log(`PUMS: ${N} San Francisco households, ${recs.reduce((a, h) => a + h.w, 0).toLocaleString()} weighted`);
  // per record: incidence on each control
  const BANDS = [50_000, 100_000, 200_000];
  const band = (inc: number) => BANDS.filter((b) => inc >= b).length;
  // B08202 cells: size 1 (0–1 workers), 2 (0–2), 3 (0–3), 4+ (0–3+)
  const swCell = (size: number, w: number) => {
    const s = Math.min(size, 4);
    const ww = Math.min(w, s === 1 ? 1 : s === 2 ? 2 : 3);
    return [0, 2, 5, 9][s - 1] + ww;
  };
  const AGE_EDGES = [5, 15, 18, 25, 35, 65];
  const ageGroup = (a: number) => AGE_EDGES.filter((e) => a >= e).length; // 0..6
  const recBand = Int8Array.from(recs, (h) => band(h.inc));
  const recSW = Int8Array.from(recs, (h) => swCell(h.p.length, h.p.reduce((a, p) => a + p[2], 0)));
  const recAge = recs.map((h) => {
    const g = new Float64Array(7);
    for (const p of h.p) g[ageGroup(p[0])]++;
    return g;
  });
  const recNP = Float64Array.from(recs, (h) => h.p.length);
  const hhOf = (h: PumsHh): Omit<AoHousehold, 'zone' | 'weight'> => ({
    drivers: h.p.filter((p) => p[0] >= 16).length,
    workers: h.p.reduce((a, p) => a + p[1], 0),
    persons16to17: h.p.filter((p) => p[0] >= 16 && p[0] <= 17).length,
    persons18to24: h.p.filter((p) => p[0] >= 18 && p[0] <= 24).length,
    persons25to34: h.p.filter((p) => p[0] >= 25 && p[0] <= 34).length,
    children0to4: h.p.filter((p) => p[0] <= 4).length,
    children5to17: h.p.filter((p) => p[0] >= 5 && p[0] <= 17).length,
    income2024: h.inc,
  });
  const attrs = recs.map(hhOf);

  const zonesFile = JSON.parse(fs.readFileSync(`${WORK}/zones.json`, 'utf8')) as { internal: { id: string; nhood: string; hh: number; hhInc: number[] }[] };
  const veh = readAcs('acs_b25044.dat'), age = readAcs('acs_b01001.dat'), sw = readAcs('acs_b08202_tract.dat');
  const pumaTract = pumaOfTract();
  const out: Record<string, { veh: number[]; vehSE: number[]; classes: number[][] }> = {};
  // the standard error of a sum of ACS cells: the root of the summed squared margins over 1.645 (the
  // Census Bureau's approximation)
  const se = (r: Record<string, number>, ...k: string[]) => Math.sqrt(k.reduce((a, x) => a + (r[x.replace('E', 'M')] ?? 0) ** 2, 0)) / 1.645;
  const classRows: number[][] = [];
  const city = { hh: 0, workers: 0, drivers: 0, kid04: 0 };
  let worst = 0;
  zonesFile.internal.forEach((z, zi) => {
    const v = veh.get(z.id);
    out[z.id] = { veh: v ? [sum(v, 'E003', 'E010'), sum(v, 'E004', 'E011'), sum(v, 'E005', 'E012'), sum(v, 'E006', 'E013'), sum(v, 'E007', 'E008', 'E014', 'E015')] : [0, 0, 0, 0, 0], vehSE: v ? [se(v, 'E003', 'E010'), se(v, 'E004', 'E011'), se(v, 'E005', 'E006', 'E007', 'E008', 'E012', 'E013', 'E014', 'E015')].map((x) => +x.toFixed(1)) : [0, 0, 0], classes: [] };
    if (!(z.hh > 0)) return;
    // controls
    const incT = z.hhInc.reduce((a, x) => a + x, 0);
    const incCtl = z.hhInc.map((x) => (incT > 0 ? (x * z.hh) / incT : z.hh / 4));
    const t = sw.get(z.id.slice(0, 11));
    const cells = t ? [...E(7, 8), ...E(10, 12), ...E(14, 17), ...E(19, 22)].map((k) => t[k]) : new Array(13).fill(1);
    const cT = cells.reduce((a, x) => a + x, 0);
    const swCtl = cells.map((x) => (cT > 0 ? (x * z.hh) / cT : z.hh / 13));
    const a = age.get(z.id)!;
    const ag = [
      sum(a, 'E003', 'E027'), sum(a, ...E(4, 5), ...E(28, 29)), sum(a, 'E006', 'E030'), sum(a, ...E(7, 10), ...E(31, 34)),
      sum(a, ...E(11, 12), ...E(35, 36)), sum(a, ...E(13, 19), ...E(37, 43)), sum(a, ...E(20, 25), ...E(44, 49)),
    ];
    const agT = ag.reduce((x, y) => x + y, 0);
    // starting weights: PUMS weights, the zone's own PUMA's records four times
    const myPuma = pumaTract.get(z.id.slice(0, 11));
    const w = Float64Array.from(recs, (h) => h.w * (h.puma === myPuma ? 4 : 1));
    for (let it = 0; it < 40; it++) {
      // households by income band
      const s4 = new Float64Array(4);
      for (let i = 0; i < N; i++) s4[recBand[i]] += w[i];
      for (let i = 0; i < N; i++) w[i] *= s4[recBand[i]] > 0 ? incCtl[recBand[i]] / s4[recBand[i]] : 0;
      // persons by age, as shares of the household population the weights now give
      if (agT > 0) {
        let pop = 0;
        for (let i = 0; i < N; i++) pop += w[i] * recNP[i];
        for (let g = 0; g < 7; g++) {
          let s = 0;
          for (let i = 0; i < N; i++) s += w[i] * recAge[i][g];
          const target = (ag[g] / agT) * pop;
          if (s <= 0) continue;
          const f = target / s;
          for (let i = 0; i < N; i++) if (recAge[i][g] > 0) w[i] *= f;
        }
      }
      // households by size and workers (last, so household totals hold exactly)
      const s13 = new Float64Array(13);
      for (let i = 0; i < N; i++) s13[recSW[i]] += w[i];
      for (let i = 0; i < N; i++) w[i] *= s13[recSW[i]] > 0 ? swCtl[recSW[i]] / s13[recSW[i]] : 0;
    }
    // fit to the income control after the last pass
    const s4 = new Float64Array(4);
    for (let i = 0; i < N; i++) s4[recBand[i]] += w[i];
    worst = Math.max(worst, ...incCtl.map((c, k) => Math.abs(s4[k] - c) / Math.max(z.hh, 1)));
    const households: AoHousehold[] = [];
    for (let i = 0; i < N; i++) if (w[i] > 1e-6) households.push({ zone: zi, weight: w[i], ...attrs[i] });
    for (const h of households) {
      city.hh += h.weight;
      city.workers += h.weight * h.workers;
      city.drivers += h.weight * h.drivers;
      city.kid04 += h.weight * (h.children0to4 > 0 ? 1 : 0);
    }
    const cls = aoClassesFromHouseholds(households, 0.002);
    for (let i = 0; i < cls.length / AO_STRIDE; i++) classRows.push(Array.from(cls.subarray(i * AO_STRIDE, (i + 1) * AO_STRIDE)));
  });
  console.log(`reweighted ${zonesFile.internal.length} block groups; largest income-band miss ${(100 * worst).toFixed(1)}% of a zone's households`);
  for (const r of classRows) out[zonesFile.internal[r[0]].id].classes.push([r[1], r[2], r[3], ...r.slice(4).map((x) => +x.toFixed(4))]);
  const nCls = classRows.length, H = city.hh;
  console.log(`households ${Math.round(H).toLocaleString()}; classes ${nCls} (${(nCls / zonesFile.internal.length).toFixed(1)} a zone); workers/hh ${(city.workers / H).toFixed(2)}, drivers/hh ${(city.drivers / H).toFixed(2)}, with a child 0–4 ${((100 * city.kid04) / H).toFixed(1)}%`);
  fs.writeFileSync(`${WORK}/autoown.json`, JSON.stringify({ source: 'ACS 2024 1-year PUMS reweighted to ACS 2020–24 block-group tables (B19001, B08202 by tract, B01001); vehicles B25044', classFields: ['drivers', 'workers', 'incClass', 'hh', 'p16', 'p18', 'p25', 'kid04', 'kid517', 'inc0', 'inc30'], zones: out }));
  console.timeEnd('autoown');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
