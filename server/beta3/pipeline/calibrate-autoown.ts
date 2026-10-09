/**
 * Step 8b: calibrate the car ownership model (shared/beta3/autoown.ts) and write it into the bundle's
 * calibration. Fast (a minute): it needs the base run's skims, not a model run.
 *
 * Travel Model One's coefficients are kept. Its constants (with its San Francisco county terms folded
 * in) are refitted so the city's households by cars (0, 1, 2, 3, 4+) match ACS 2020–24 B25044, and a
 * constant on one car and on two or more for each of the city's 41 analysis neighborhoods so each
 * neighborhood's 0/1/2+ split matches; neighborhood constants are centred on households, so the
 * city-wide constants keep their meaning. This is the district-constant practice of SF-CHAMP and of
 * TM1's county constants, at the scale the city's neighborhoods differ. The fit is reported by zone,
 * by neighborhood, and citywide, for TM1 as published (its constants and San Francisco terms), with
 * city-wide constants only, and with neighborhood constants.
 *
 * The accessibility terms are computed from the base run's skims (the crowding and lot prices saved
 * with client/beta3/model/base.bin.gz, so a long-run scenario with no changes starts from the same
 * accessibility) and kept with the constants: a long-run scenario pivots on them.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/calibrate-autoown.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { decodeResult } from '../../../shared/beta3/results';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { scenarioLines } from '../../../shared/beta3/net';
import { AO_ALTS, AO_F, AO_STRIDE, TM1_AO, aoAccess, aoDensity, aoProbabilities, type AoAccess, type AoCalibration } from '../../../shared/beta3/autoown';
import type { TrnSkims } from '../../../shared/beta3/demand';
import type { Scenario, TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, WORK } from './paths';
import { loadBundle } from './run-base';

/** households by cars (0..4+) per zone from a set of probabilities */
function byZone(classes: Float32Array, prob: Float64Array, NZ: number) {
  const out = new Float64Array(NZ * AO_ALTS);
  for (let i = 0; i < classes.length / AO_STRIDE; i++) {
    const z = classes[i * AO_STRIDE], w = classes[i * AO_STRIDE + AO_F.hh];
    for (let a = 0; a < AO_ALTS; a++) out[z * AO_ALTS + a] += w * prob[i * AO_ALTS + a];
  }
  return out;
}

/** %RMSE (RMSE over the mean observed) of households by segment 0, 1, 2+, over groups of zones */
function pctRmse(model: Float64Array, obs: Float64Array, group: number[], nG: number) {
  const m = new Float64Array(nG * 3), o = new Float64Array(nG * 3);
  for (let z = 0; z < group.length; z++) {
    const g = group[z];
    if (g < 0) continue;
    for (let a = 0; a < AO_ALTS; a++) {
      const s = Math.min(a, 2);
      m[g * 3 + s] += model[z * AO_ALTS + a];
      o[g * 3 + s] += obs[z * AO_ALTS + a];
    }
  }
  return [0, 1, 2].map((s) => {
    let se = 0, so = 0, n = 0;
    for (let g = 0; g < nG; g++) {
      if (o[g * 3] + o[g * 3 + 1] + o[g * 3 + 2] <= 0) continue;
      se += (m[g * 3 + s] - o[g * 3 + s]) ** 2;
      so += o[g * 3 + s];
      n++;
    }
    return +((100 * Math.sqrt(se / n)) / (so / n)).toFixed(1);
  });
}

async function main() {
  const t0 = Date.now();
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration;
  if (!calib) throw new Error('calibrate first');
  const classes = b.a.aoClass as Float32Array | undefined;
  if (!classes) throw new Error('no household classes in the bundle: run autoown.ts, then build.ts');
  const NZ = H.zones.length;
  const nCls = classes.length / AO_STRIDE;

  // ---- the base run's skims ----
  const sc: Scenario = { name: 'Today', edits: [] };
  const exec = new LocalExecutor(b, sc, calib);
  const base = fs.existsSync(`${BUNDLE}/base.bin.gz`) ? decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`))) : null;
  const lot = new Float32Array(H.stops.length);
  for (const [s, v] of Object.entries(base?.finalLotPrice ?? calib.lotPrice ?? {})) lot[Number(s)] = v;
  const sk = {} as TrnSkims;
  for (const p of SKIM_PERIODS) {
    const w = base?.finalCrowd?.[p as TPeriod];
    const crowd = w ? scenarioLines(b, sc, p).lines.map((l) => {
      const c = l.src >= 0 ? w[l.src] : undefined;
      return c && c.length === l.stops.length - 1 ? c : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1);
    }) : undefined;
    sk[p] = await exec.skim(p, crowd, lot.some((v) => v > 0) ? lot : undefined);
  }
  console.log(`skims ${((Date.now() - t0) / 1000).toFixed(0)} s (${base ? 'crowding and lot prices of the saved base run' : 'uncrowded'})`);
  const t1 = Date.now();
  const access = aoAccess(b, sk);
  const tAccess = Date.now() - t1;
  const mean = (a: Float32Array) => a.reduce((x, v, i) => x + v * H.zones[i].hh, 0) / H.zones.reduce((x, z) => x + z.hh, 0);
  console.log(`accessibility (household means; ${tAccess} ms): car ${mean(access.auto).toFixed(2)}, transit ${mean(access.transit).toFixed(2)}, walk ${mean(access.walk).toFixed(2)}, work auto time savings ${mean(access.savings).toFixed(3)}`);

  // ---- targets: households by cars, ACS 2020–24 B25044, scaled to each zone's households ----
  const ao = JSON.parse(fs.readFileSync(`${WORK}/autoown.json`, 'utf8')) as { zones: Record<string, { veh: number[]; vehSE?: number[] }> };
  const obs = new Float64Array(NZ * AO_ALTS);
  H.zones.forEach((z, i) => {
    const v = ao.zones[z.id]?.veh ?? [0, 0, 0, 0, 0];
    const t = v.reduce((a, x) => a + x, 0);
    for (let a = 0; a < AO_ALTS; a++) obs[i * AO_ALTS + a] = t > 0 ? (v[a] * z.hh) / t : 0;
  });
  // how far the ACS's own sampling error alone puts block groups from their true values: the %RMSE a
  // perfect model would show against these estimates
  const floor = [0, 1, 2].map((s) => {
    let v = 0, o = 0, n = 0;
    H.zones.forEach((z) => {
      const r = ao.zones[z.id];
      if (!r?.vehSE || !(z.hh > 0)) return;
      v += r.vehSE[s] ** 2;
      o += s < 2 ? r.veh[s] : r.veh[2] + r.veh[3] + r.veh[4];
      n++;
    });
    return +((100 * Math.sqrt(v / n)) / (o / n)).toFixed(1);
  });
  console.log(`ACS sampling error alone, %RMSE by zone 0/1/2+: ${floor.join('/')}`);
  const cityObs = [0, 1, 2, 3, 4].map((a) => H.zones.reduce((x, _, i) => x + obs[i * AO_ALTS + a], 0));
  const HH = cityObs.reduce((a, x) => a + x, 0);
  const nhoodNames = [...new Set(H.zones.map((z) => z.nhood))].sort();
  const nhoodIdx = H.zones.map((z) => nhoodNames.indexOf(z.nhood));
  const nhHh = nhoodNames.map((_, g) => H.zones.reduce((x, z, i) => x + (nhoodIdx[i] === g ? z.hh : 0), 0));
  const density = aoDensity(b);
  const prob = new Float64Array(nCls * AO_ALTS);
  const nhK = nhoodNames.map(() => [0, 0] as [number, number]);
  const fit = (asc: number[], useNh: boolean) => {
    aoProbabilities(classes, access, density, asc, (z) => (useNh ? nhK[nhoodIdx[z]] : undefined), prob);
    return byZone(classes, prob, NZ);
  };
  const report = (label: string, m: Float64Array) => {
    const city = [0, 1, 2, 3, 4].map((a) => H.zones.reduce((x, _, i) => x + m[i * AO_ALTS + a], 0));
    const zone = pctRmse(m, obs, H.zones.map((_, i) => i), NZ);
    const nh = pctRmse(m, obs, nhoodIdx, nhoodNames.length);
    const carsM = city.reduce((x, v, a) => x + a * v, 0) / HH, carsO = cityObs.reduce((x, v, a) => x + a * v, 0) / HH;
    console.log(`${label}: shares 0/1/2/3/4+ ${city.map((v) => ((100 * v) / HH).toFixed(1)).join('/')} (ACS ${cityObs.map((v) => ((100 * v) / HH).toFixed(1)).join('/')}); cars/hh ${carsM.toFixed(3)} (ACS ${carsO.toFixed(3)}, 4+ as 4); %RMSE by zone 0/1/2+ ${zone.join('/')}, by neighborhood ${nh.join('/')}`);
    return { city, zone, nh };
  };
  // TM1 as published: its constants and its San Francisco county terms
  const ascTM1 = TM1_AO.constants.map((c, a) => c + TM1_AO.sanFrancisco[a]);
  const tm1 = report('TM1 as published', fit(ascTM1, false));
  // city-wide constants
  const asc = ascTM1.slice();
  for (let it = 0; it < 60; it++) {
    const m = fit(asc, false);
    const city = [0, 1, 2, 3, 4].map((a) => H.zones.reduce((x, _, i) => x + m[i * AO_ALTS + a], 0));
    for (let a = 1; a < AO_ALTS; a++) asc[a - 1] += Math.log(cityObs[a] / city[a]) - Math.log(cityObs[0] / city[0]);
  }
  const cityOnly = report('city-wide constants', fit(asc, false));
  // neighborhood constants (one car; two or more), centred on households
  for (let it = 0; it < 80; it++) {
    const m = fit(asc, true);
    const city = [0, 1, 2, 3, 4].map((a) => H.zones.reduce((x, _, i) => x + m[i * AO_ALTS + a], 0));
    for (let a = 1; a < AO_ALTS; a++) asc[a - 1] += Math.log(cityObs[a] / city[a]) - Math.log(cityObs[0] / city[0]);
    const mg = nhoodNames.map(() => [0, 0, 0]), og = nhoodNames.map(() => [0, 0, 0]);
    for (let i = 0; i < NZ; i++)
      for (let a = 0; a < AO_ALTS; a++) {
        mg[nhoodIdx[i]][Math.min(a, 2)] += m[i * AO_ALTS + a];
        og[nhoodIdx[i]][Math.min(a, 2)] += obs[i * AO_ALTS + a];
      }
    nhoodNames.forEach((_, g) => {
      // too few households to fit (parks, the Presidio): no constant
      if (nhHh[g] < 300) return;
      for (const s of [1, 2]) {
        const d = Math.log(Math.max(og[g][s], 0.5) / mg[g][s]) - Math.log(Math.max(og[g][0], 0.5) / mg[g][0]);
        nhK[g][s - 1] = Math.max(-4, Math.min(4, nhK[g][s - 1] + 0.8 * d));
      }
    });
    for (const s of [0, 1]) {
      const c = nhK.reduce((x, k, g) => x + k[s] * nhHh[g], 0) / HH;
      nhK.forEach((k) => (k[s] -= c));
      if (s === 0) asc[0] += c;
      else for (let a = 1; a < 4; a++) asc[a] += c;
    }
  }
  const final = report('with neighborhood constants', fit(asc, true));
  const spread = nhK.map((k, g) => [nhoodNames[g], k] as const).filter(([, k]) => k[0] || k[1]).sort((x, y) => x[1][1] - y[1][1]);
  console.log(`neighborhood constants (1 car, 2+): lowest ${spread.slice(0, 3).map(([n, k]) => `${n} ${k[0].toFixed(2)}/${k[1].toFixed(2)}`).join(', ')}; highest ${spread.slice(-3).map(([n, k]) => `${n} ${k[0].toFixed(2)}/${k[1].toFixed(2)}`).join(', ')}`);
  console.log(`constants 1/2/3/4+ cars: TM1 with SF terms ${ascTM1.map((v) => v.toFixed(2)).join('/')} → ${asc.map((v) => v.toFixed(2)).join('/')}`);

  // ---- the model's own sensitivity: households' cars if every zone's transit accessibility rose by 0.1 ----
  const cars = (acc: AoAccess) => {
    aoProbabilities(classes, acc, density, asc, (z) => nhK[nhoodIdx[z]], prob);
    let c = 0;
    for (let i = 0; i < nCls; i++) for (let a = 1; a < AO_ALTS; a++) c += classes[i * AO_STRIDE + AO_F.hh] * a * prob[i * AO_ALTS + a];
    return c;
  };
  const c0 = cars(access);
  const c1 = cars({ ...access, transit: access.transit.map((v) => v + 0.1) });
  // transit accessibility is a log of jobs reached, so +0.1 is about 10.5% more retail jobs reachable
  console.log(`cars ${Math.round(c0).toLocaleString()}; with 10.5% more retail jobs reachable by transit everywhere ${Math.round(c1).toLocaleString()} (elasticity ${(Math.log(c1 / c0) / Math.log(Math.exp(0.1))).toFixed(3)})`);

  const r4 = (a: Float32Array) => Array.from(a, (v) => +v.toFixed(4));
  const out: AoCalibration = {
    asc: asc.map((v) => +v.toFixed(4)),
    nhood: Object.fromEntries(nhoodNames.map((n, g) => [n, [+nhK[g][0].toFixed(4), +nhK[g][1].toFixed(4)] as [number, number]]).filter(([, k]) => (k as number[])[0] || (k as number[])[1])),
    base: { auto: r4(access.auto), transit: r4(access.transit), walk: r4(access.walk), savings: r4(access.savings) },
    fit: { city: final.city.map((v, a) => [+(v / HH).toFixed(4), +(cityObs[a] / HH).toFixed(4)]), zonePctRmse: final.zone, nhoodPctRmse: final.nh, zoneCityOnly: cityOnly.zone, nhoodCityOnly: cityOnly.nh, zoneTM1: tm1.zone, cityTM1: tm1.city.map((v) => +(v / HH).toFixed(4)), samplingFloor: floor, elasticity: +(Math.log(c1 / c0) / 0.1).toFixed(4) },
  };
  calib.autoOwn = out;
  if (process.argv.includes('--dry')) return;
  H.calibration = calib;
  const { arrays: _a, ...header } = H;
  void _a;
  fs.writeFileSync(process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log(`car ownership calibrated (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

main();
