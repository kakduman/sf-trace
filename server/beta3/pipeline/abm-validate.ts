/**
 * Checks of the person-level choices (abm.ts) against what they were not fitted to, from one demand
 * pass on today's network (the last baseline's crowding): trips per person by person type against
 * NHTS 2017 and BATS 2023, commuting days against BATS 2023, school trips against CDE enrollment,
 * workplaces by neighborhood against the census flows, and residents' mode shares.
 * Writes server/beta3/reference/abm-validation.json.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/abm-validate.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ABM, ABM_COLS, computeDemand, prepare, type TrnSkims } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { ATTENDANCE, MODES, STOPS_PER_HALF, WORK_SUBTOURS } from '../../../shared/beta3/params';
import { NM_TO_MODEL, MODEL_NM } from '../../../shared/beta3/abm';
import { decodeResult } from '../../../shared/beta3/results';
import type { RunResult, TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const BATS_STAY_HOME = 169_494 / 777_523;
/** BATS 2023 dashboard (MTC, Summary_TripRate_TripDistance extract), San Francisco adults, weekday linked trips per person by commute category, and weights */
const BATS_SF = {
  commuted: { trips: 4.262, workTrips: 1.295, weight: 119_141 },
  telecommuted6plus: { trips: 2.783, weight: 151_857 },
  telecommutedUnder6: { trips: 3.157, weight: 31_392 },
  didNotWork: { trips: 3.054, weight: 67_680 },
  notFullTimeWorker: { trips: 3.096, weight: 302_973 },
  allAdults: { trips: 3.231, workTrips: 0.268, weight: 673_043 },
};
/** BATS 2023 dashboard, San Francisco residents under 18: weekday linked trips (all modes) */
const BATS_UNDER18_TRIPS = 121_621;

async function main() {
  const b = loadBundle();
  const H = b.header;
  const NZ = H.zones.length;
  const calib = H.calibration!;
  ABM.on = true;
  const prep = prepare(b);
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const toNet = (fc: RunResult['finalCrowd'], p: TPeriod) =>
    fc ? exec.net(p).lines.map((l) => { const c = l.src >= 0 ? fc[p]?.[l.src] : undefined; return c && c.length === l.stops.length - 1 ? c : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1); }) : undefined;
  const lot = new Float32Array(H.stops.length);
  for (const [s, v] of Object.entries(calib.lotPrice ?? {})) lot[Number(s)] = v as number;
  const sk = {} as TrnSkims;
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, toNet(base.finalCrowd, p), lot);
  const t0 = Date.now();
  const d = computeDemand(b, prep, sk, calib);
  const secs = (Date.now() - t0) / 1000;
  const A = d.abm!;
  const row = (pt: number) => A.byPtype.subarray((pt - 1) * ABM_COLS, pt * ABM_COLS);
  const nhts = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-cdap.json`, 'utf8')).byPtype as Record<string, { pattern: Record<string, number>; tripsGiven: Record<string, number>; toursGiven: Record<string, Record<string, number>> }>;
  // trips per tour as demand books them: two legs, the stops on each half (NHTS rates), and work subtours
  const tf = calib.tourRateFactor ?? 1, out = calib.outShare;
  const nmTrip = [0, 1, 2].map((q) => 2 * (1 + STOPS_PER_HALF[MODEL_NM[q]]));
  const workTrip = 2 * (1 + STOPS_PER_HALF.work) + 2 * WORK_SUBTOURS;
  const schoolTrip = 2 * (1 + STOPS_PER_HALF.school);
  const tripsOf = (r: Float64Array, which: 'all' | 'M' | 'N') => {
    // non-mandatory tours carry the calibrated tour rate factor; the out-of-city share is booked as trips at the same rate
    let nm = 0;
    if (which === 'all') for (let q = 0; q < 6; q++) nm += r[6 + q] * nmTrip[NM_TO_MODEL[q]];
    else nm = (which === 'M' ? r[15] : r[16]) * (nmTrip.reduce((a, v) => a + v, 0) / 3);
    nm *= tf;
    void out;
    return which === 'N' ? nm : r[4] * workTrip + r[5] * schoolTrip + nm;
  };
  const byPtype: Record<string, unknown> = {};
  let persons = 0, home = 0, adultsTrips = 0, adults = 0;
  for (let pt = 1; pt <= 8; pt++) {
    const r = row(pt), n = r[0];
    persons += n;
    home += r[3];
    const N = nhts[pt === 8 ? 7 : pt];
    const tripsModel = tripsOf(r, 'all') / n;
    const tripsNhts = N.pattern.M * (N.tripsGiven.M ?? 0) + N.pattern.N * (N.tripsGiven.N ?? 0);
    if (pt <= 5) ((adultsTrips += tripsOf(r, 'all')), (adults += n));
    byPtype[pt] = {
      persons: Math.round(n),
      pattern: { M: +(r[1] / n).toFixed(3), N: +(r[2] / n).toFixed(3), H: +(r[3] / n).toFixed(3) },
      patternNhts2017: Object.fromEntries(Object.entries(N.pattern).map(([k, v]) => [k, +v.toFixed(3)])),
      workTours: +(r[4] / n).toFixed(3),
      schoolTours: +(r[5] / n).toFixed(3),
      nonMandatoryTours: +((tf * [...r.subarray(6, 12)].reduce((a, v) => a + v, 0)) / n).toFixed(3),
      tripsPerPerson: +tripsModel.toFixed(2),
      tripsPerPersonNhts2017: +tripsNhts.toFixed(2),
    };
  }
  // full-time workers: commuting days (a work tour) against BATS
  const ft = row(1);
  const ftCommute = ft[4] / ft[0];
  const ftTripsM = (ft[4] * workTrip + tf * ft[15] * (nmTrip.reduce((a, v) => a + v, 0) / 3)) / ft[1];
  const ftTripsNot = (tf * ft[16] * (nmTrip.reduce((a, v) => a + v, 0) / 3)) / (ft[0] - ft[1]);
  const batsNot = (BATS_SF.telecommuted6plus.trips * BATS_SF.telecommuted6plus.weight + BATS_SF.telecommutedUnder6.trips * BATS_SF.telecommutedUnder6.weight + BATS_SF.didNotWork.trips * BATS_SF.didNotWork.weight) / (BATS_SF.telecommuted6plus.weight + BATS_SF.telecommutedUnder6.weight + BATS_SF.didNotWork.weight);
  const batsFtCommute = BATS_SF.commuted.weight / (BATS_SF.commuted.weight + BATS_SF.telecommuted6plus.weight + BATS_SF.telecommutedUnder6.weight + BATS_SF.didNotWork.weight);
  // school trips against CDE enrollment: residents' K-12 school tours, and enrollment at a school day's
  // attendance spread over the year's weekdays (180 school days of 261 weekdays, 94% attendance; assumed)
  const schoolTrips = Object.values(d.byPurpose.school).reduce((a, v) => a + v, 0);
  const enroll = prep.size.school.reduce((a, v) => a + v, 0);
  const schoolTours = A.schoolDest.reduce((a, v) => a + v, 0) / 2;
  // school by zone: modeled residents' tours against enrollment shares
  let se = 0, sm = 0;
  for (let z = 0; z < NZ; z++) {
    const t = (prep.size.school[z] / enroll) * schoolTours;
    se += (A.schoolDest[z] / 2 - t) ** 2;
    sm += t;
  }
  // workplaces: commute trips by home neighborhood × workplace group against the census flows
  const G = prep.workGroups.length;
  const fh = b.a.flowH as Int32Array, fw = b.a.flowW as Int32Array, fn = b.a.flowN as Float32Array;
  const tot = new Float64Array(NZ);
  for (let i = 0; i < fh.length; i++) tot[fh[i]] += fn[i];
  const nhoods = [...new Set(H.zones.map((z) => z.nhood))];
  const obs = new Float64Array(nhoods.length * G), mod = new Float64Array(nhoods.length * G);
  for (let i = 0; i < fh.length; i++) {
    const z = H.zones[fh[i]];
    obs[nhoods.indexOf(z.nhood) * G + prep.workGroupOf[fw[i]]] += (z.workers * (1 - z.wfh) * fn[i]) / tot[fh[i]];
  }
  for (let o = 0; o < NZ; o++) for (let g = 0; g < G; g++) mod[nhoods.indexOf(H.zones[o].nhood) * G + g] += A.workByGroup[o * G + g];
  const so = obs.reduce((a, v) => a + v, 0), smod = mod.reduce((a, v) => a + v, 0);
  let cov = 0, vo = 0, vm = 0, sq = 0, cells = 0, absd = 0;
  const mo = so / obs.length, mm = smod / mod.length;
  for (let i = 0; i < obs.length; i++) {
    const x = obs[i] / so, y = mod[i] / smod;
    cov += (x - mo / so) * (y - mm / smod);
    vo += (x - mo / so) ** 2;
    vm += (y - mm / smod) ** 2;
    sq += (x - y) ** 2;
    absd += Math.abs(x - y);
    if (obs[i] > 0) cells++;
  }
  // in the city, and to each county outside
  const outShareObs = [...obs].reduce((a, v, i) => a + ((i % G) >= nhoods.length ? v : 0), 0) / so;
  const outShareMod = [...mod].reduce((a, v, i) => a + ((i % G) >= nhoods.length ? v : 0), 0) / smod;
  const rt = MODES.reduce((a, m) => a + d.residentTrips[m], 0);
  const res = {
    description: 'Checks of the person-level choices (abm-validate.ts), one demand pass on today\'s network.',
    demandSeconds: +secs.toFixed(1),
    segments: A.segments,
    householdSegments: A.households,
    stayHome: { model: +(home / persons).toFixed(3), bats2023: +BATS_STAY_HOME.toFixed(3), note: 'fitted (one shift on NHTS 2017 shares by person type)' },
    byPtype,
    adults: { tripsPerPerson: +(adultsTrips / adults).toFixed(2), bats2023: BATS_SF.allAdults.trips },
    under18: { trips: Math.round(tripsOf(row(6), 'all') + tripsOf(row(7), 'all') + tripsOf(row(8), 'all')), bats2023: BATS_UNDER18_TRIPS },
    fullTimeWorkers: {
      commuteShare: +ftCommute.toFixed(3),
      commuteShareNotWfh: +(ft[4] / (ft[0] - ft[12])).toFixed(3),
      fitted: `work tours per worker not working from home = ${ATTENDANCE.toFixed(3)} (BATS 2023 Table 45 × absence)`,
      bats2023DayLevel: +batsFtCommute.toFixed(3),
      tripsOnCommuteDays: +ftTripsM.toFixed(2),
      tripsOtherDays: +ftTripsNot.toFixed(2),
      bats2023: { commuted: BATS_SF.commuted.trips, notCommuted: +batsNot.toFixed(2) },
    },
    school: { residentsK12Tours: Math.round(schoolTours), residentsK12Trips: Math.round(schoolTrips), cdeEnrollmentAtCitySchools: Math.round(enroll), enrollmentOnAverageWeekday: Math.round((enroll * 180 * 0.94) / 261), byZonePctRmse: +((100 * Math.sqrt(se / NZ)) / (sm / NZ)).toFixed(1) },
    workplaces: {
      cellsObserved: cells,
      shareCorrelation: +(cov / Math.sqrt(vo * vm)).toFixed(3),
      shareRmse: +Math.sqrt(sq / obs.length).toExponential(2),
      dissimilarity: +(absd / 2).toFixed(3),
      outOfCity: { model: +outShareMod.toFixed(3), census: +outShareObs.toFixed(3) },
      meanKmInCity: +(A.workKm[1] / A.workKm[0]).toFixed(2),
      distanceScale: calib.abm?.workDistScale ?? 1,
    },
    residentTrips: Math.round(rt),
    residentShares: Object.fromEntries(MODES.map((m) => [m, +(d.residentTrips[m] / rt).toFixed(4)])),
    byPurpose: Object.fromEntries(Object.entries(d.byPurpose).map(([p, r]) => [p, Math.round(Object.values(r).reduce((a, v) => a + v, 0))])),
  };
  console.log(JSON.stringify(res, null, 1));
  fs.writeFileSync(`${REFERENCE}/abm-validation.json`, JSON.stringify(res, null, 1));
}

main();
