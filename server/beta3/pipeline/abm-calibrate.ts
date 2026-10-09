/**
 * Calibrate the person-level choices (shared/beta3/abm.ts) and write their constants into the bundle
 * (calibration.abm), turning them on. Demand passes on fixed skims (today's network, with the last
 * baseline's crowding and lot prices), each adjusting:
 *  - CDAP constants by person type (ActivitySim / TM1 types):
 *    - workers' M constant, so their work tours per worker not working from home equal the aggregate
 *      model's commuting rate (BATS 2023 Table 45 commute frequency × the absence allowance, ATTENDANCE;
 *      × DIARY_COMMUTE_FACTOR when the calibration's commuteBasis is 'diary');
 *    - students' and children's M constant to NHTS 2017's mandatory-day shares by person type
 *      (reference/nhts-cdap.json; preschoolers enrolled in preschool as children 6–15);
 *    - N against H: NHTS's share of non-mandatory days spent at home by person type, shifted by one
 *      logit so all residents stay home on BATS 2023's share (Table 50: 169,494 of 777,523 San
 *      Francisco residents made no trips on their travel day, 21.8%).
 *  - Non-mandatory tour constants by person type and purpose (shop, errands, social), to NHTS 2017's
 *    tours per person on N and M days, weighted by the model's day patterns. Their overall level is
 *    then the calibration's tour rate factor, fitted to BATS's total resident trips (calibrate.ts).
 *  - Shadow prices (ActivitySim's CT-RAMP method: ln(target/model), damping 1) on workplaces, to the
 *    census flows' workplaces of the city's resident commuters (LODES 2023 rebalanced and rescaled to
 *    the ACS), and on schools and colleges, to enrollment; and one scale on TM1's workplace distance
 *    terms, to the census flows' mean commute length within the city.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/abm-calibrate.ts [passes=10]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { decodeResult } from '../../../shared/beta3/results';
import { ABM, ABM_COLS, computeDemand, prepare, workMiCapOf, type TrnSkims } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { ATTENDANCE, DIARY_COMMUTE_FACTOR } from '../../../shared/beta3/params';
import { MODEL_NM, NM_TO_MODEL, type AbmCalib } from '../../../shared/beta3/abm';
import type { RunResult, TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const logit = (p: number) => Math.log(p / (1 - p));
const lgs = (x: number) => 1 / (1 + Math.exp(-x));

/** BATS 2023 Table 50: San Francisco residents who made no trips on their (Tuesday–Thursday) travel day */
export const BATS_STAY_HOME = 169_494 / 777_523;

export async function main() {
  const passes = Number(process.argv[2] ?? 10);
  const b = loadBundle();
  const H = b.header;
  const NZ = H.zones.length, NX = H.ext.length;
  const calib = JSON.parse(JSON.stringify(H.calibration));
  ABM.on = true;
  ABM.workplace = 'choice';
  const ac: AbmCalib = (calib.abm ??= {});
  ac.on = true;
  ac.workplace = 'choice';
  // --reset-work: start the workplace shadow prices and distance scale afresh
  if (process.argv.includes('--reset-work')) (delete ac.workShadow, delete ac.workDistScale);
  ac.cdap ??= {};
  ac.nmtf ??= {};
  const prep = prepare(b);
  // skims with the last baseline's crowding and lot prices
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const toNet = (fc: RunResult['finalCrowd'], p: TPeriod) =>
    fc ? exec.net(p).lines.map((l) => { const c = l.src >= 0 ? fc[p]?.[l.src] : undefined; return c && c.length === l.stops.length - 1 ? c : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1); }) : undefined;
  const lot = new Float32Array(H.stops.length);
  for (const [s, v] of Object.entries(calib.lotPrice ?? {})) lot[Number(s)] = v as number;
  const sk = {} as TrnSkims;
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, toNet(base.finalCrowd, p), lot);

  // targets
  const nhts = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-cdap.json`, 'utf8')).byPtype as Record<string, { pattern: Record<string, number>; toursGiven: Record<string, Record<string, number>> }>;
  const NH = (pt: number) => nhts[pt === 8 ? 7 : pt];
  const M_TARGET: Record<number, number> = { 3: NH(3).pattern.M, 6: NH(6).pattern.M, 7: NH(7).pattern.M, 8: NH(7).pattern.M };
  const hShare = (pt: number) => NH(pt).pattern.H / (NH(pt).pattern.N + NH(pt).pattern.H);
  // NHTS tours per person-day of each pattern, by model purpose
  const ASIM_P = ['escort', 'shopping', 'othmaint', 'othdiscr', 'eatout', 'social'];
  const nmGiven = (pt: number, pat: 'M' | 'N') => {
    const g = NH(pt).toursGiven[pat] ?? {};
    const out = [0, 0, 0];
    ASIM_P.forEach((p, k) => (out[NM_TO_MODEL[k]] += g[p] ?? 0));
    return out;
  };
  // the census flows' commute length within the city (the workplace distance scale's target)
  const fh = b.a.flowH as Int32Array, fw = b.a.flowW as Int32Array, fn = b.a.flowN as Float32Array, dm = b.a.autoDm as Uint16Array;
  let kmT = 0, kmW = 0;
  const cap = workMiCapOf(H.zones);
  {
    const tot = new Float64Array(NZ);
    for (let i = 0; i < fh.length; i++) tot[fh[i]] += fn[i];
    for (let i = 0; i < fh.length; i++) {
      if (fw[i] >= NZ) continue;
      const z = H.zones[fh[i]];
      const w = (z.workers * (1 - z.wfh) * fn[i]) / tot[fh[i]];
      // as demand measures it: road distance, at most 1.5 times the straight line
      kmT += w * Math.min(dm[fh[i] * NZ + fw[i]] / 100, cap(fh[i], fw[i]) * 1.609344);
      kmW += w;
    }
  }
  const kmTarget = kmT / kmW;
  let kappa = 0;
  for (let it = 0; it < passes; it++) {
    const t0 = Date.now();
    const d = computeDemand(b, prep, sk, calib);
    const A = d.abm!;
    const T = A.byPtype;
    const row = (pt: number) => T.subarray((pt - 1) * ABM_COLS, pt * ABM_COLS);
    // CDAP
    let persons = 0, home = 0;
    for (let pt = 1; pt <= 8; pt++) ((persons += row(pt)[0]), (home += row(pt)[3]));
    const damp = it < 2 ? 0.7 : 1;
    kappa += damp * (logit(BATS_STAY_HOME) - logit(home / persons));
    const lines: string[] = [];
    for (let pt = 1; pt <= 8; pt++) {
      const r = row(pt), a = (ac.cdap![pt] ??= {});
      const M = r[1] / r[0], N = r[2] / r[0], Hh = r[3] / r[0];
      if (pt === 1 || pt === 2) {
        // work tours per worker not working from home → ATTENDANCE
        const perNotWfh = r[4] / (r[0] - r[12]);
        const mNot = r[13] / (r[0] - r[12]);
        const target = Math.min(0.97, (mNot * ATTENDANCE * (calib.commuteBasis === 'diary' ? DIARY_COMMUTE_FACTOR['San Francisco'] : 1)) / perNotWfh);
        a.M = (a.M ?? 0) + damp * (logit(target) - logit(mNot));
      } else if (M_TARGET[pt]) {
        // children not enrolled have no M day: the target is among those enrolled
        a.M = (a.M ?? 0) + damp * (logit(M_TARGET[pt]) - logit(Math.max(1e-4, r[1] / r[14])));
      }
      const hT = lgs(logit(hShare(pt)) + kappa);
      a.N = (a.N ?? 0) + damp * (logit(1 - hT) - logit(N / (N + Hh)));
      // non-mandatory tours by model purpose
      const nm = (ac.nmtf![pt] ??= {});
      const gM = nmGiven(pt, 'M'), gN = nmGiven(pt, 'N');
      const mod = [0, 0, 0];
      for (let q = 0; q < 6; q++) mod[NM_TO_MODEL[q]] += r[6 + q] / r[0];
      MODEL_NM.forEach((q, k) => {
        const tgt = M * gM[k] + N * gN[k];
        if (tgt > 0 && mod[k] > 0) nm[q] = (nm[q] ?? 0) + damp * Math.log(tgt / mod[k]);
      });
      lines.push(`pt${pt} M ${M.toFixed(3)} N ${N.toFixed(3)} H ${Hh.toFixed(3)} work ${(r[4] / r[0]).toFixed(3)} school ${(r[5] / r[0]).toFixed(3)} nm ${mod.map((v) => v.toFixed(3)).join('/')} target ${MODEL_NM.map((_, k) => (M * gM[k] + N * gN[k]).toFixed(3)).join('/')}`);
    }
    // shadow prices: workplaces (city zones and outside activity ends), schools, colleges
    const shadow = (cur: number[] | undefined, model: Float64Array, target: ArrayLike<number>) => {
      const n = model.length;
      let tm = 0, tt = 0;
      for (let i = 0; i < n; i++) ((tm += model[i]), (tt += target[i]));
      const out = cur && cur.length === n ? cur.slice() : new Array(n).fill(0);
      let se = 0, st = 0;
      for (let i = 0; i < n; i++) {
        const t = (target[i] * tm) / tt;
        if (t > 1 && model[i] > 1e-3) out[i] = Math.max(-8, Math.min(8, out[i] + Math.log(t / model[i])));
        se += (model[i] - t) ** 2;
        st += t;
      }
      return { out: out.map((v) => +v.toFixed(4)), pctRmse: (100 * Math.sqrt(se / n)) / (st / n) };
    };
    const ws = shadow(ac.workShadow, A.workDest, prep.workTarget);
    const ss = shadow(ac.schoolShadow, A.schoolDest, prep.size.school);
    const us = shadow(ac.univShadow, A.univDest, prep.size.univ);
    ac.workShadow = ws.out;
    ac.schoolShadow = ss.out;
    ac.univShadow = us.out;
    const km = A.workKm[1] / A.workKm[0];
    ac.workDistScale = Math.max(0.02, Math.min(3, (ac.workDistScale ?? 1) * (km / kmTarget) ** (it < 3 ? 1 : 0.5)));
    const tot = Object.values(d.residentTrips).reduce((a, v) => a + v, 0);
    console.log(`pass ${it + 1} (${((Date.now() - t0) / 1000).toFixed(0)} s): stay home ${(100 * home / persons).toFixed(1)}% (BATS ${(100 * BATS_STAY_HOME).toFixed(1)}%, shift ${kappa.toFixed(2)}); residents' trips ${Math.round(tot)}; workplaces %RMSE ${ws.pctRmse.toFixed(1)}, schools ${ss.pctRmse.toFixed(1)}, colleges ${us.pctRmse.toFixed(1)}; commute km ${km.toFixed(2)} (census ${kmTarget.toFixed(2)}) → distance scale ${ac.workDistScale.toFixed(3)}`);
    for (const l of lines) console.log(`  ${l}`);
    ac.fit = { pass: it + 1, stayHome: [home / persons, BATS_STAY_HOME], workplacePctRmse: ws.pctRmse, schoolPctRmse: ss.pctRmse, collegePctRmse: us.pctRmse, commuteKm: [km, kmTarget], segments: A.segments, households: A.households };
  }
  for (const pt of Object.keys(ac.cdap!)) for (const k of ['M', 'N'] as const) if (ac.cdap![pt][k] !== undefined) ac.cdap![pt][k] = +ac.cdap![pt][k]!.toFixed(4);
  for (const pt of Object.keys(ac.nmtf!)) for (const q of MODEL_NM) if (ac.nmtf![pt][q] !== undefined) ac.nmtf![pt][q] = +ac.nmtf![pt][q]!.toFixed(4);
  ac.workDistScale = +ac.workDistScale!.toFixed(4);
  b.header.calibration = calib;
  const { arrays: _a, ...header } = b.header;
  void _a;
  fs.writeFileSync(process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log('person-level choices calibrated and saved (calibration.abm)');
  void NX;
}

main();
