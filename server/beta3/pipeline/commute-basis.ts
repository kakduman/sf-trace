/**
 * The two readings of BATS 2023's commuting (calibration commuteBasis: 'stated' frequency or the
 * travel 'diary'), each with the aggregate tour rates and the person-level choices, each
 * recalibrated briefly: experiment.ts results side by side on what the calibration does not fit,
 * the morning peak (BART exits at the four downtown stations, 6–10am) and the route-level Muni fit.
 * Writes server/beta3/reference/commute-basis.json.
 * Run: npx tsx server/beta3/pipeline/commute-basis.ts agg-stated.json agg-diary.json abm-stated.json abm-diary.json
 */
import fs from 'node:fs';
import { REFERENCE } from './paths';

type Exp = {
  label: string;
  muni: { r: number; pctRmse: number; within25: number; model: number; observed: number };
  groups: Record<string, [number, number]>;
  bart: { r: number; pctRmse: number; total: number };
  bartAm: { code: string; obs: number; mod: number; obsShare: number; modShare: number }[];
  caltrain: { obs: number; mod: number };
  tod: { bartExits: Record<string, number> };
  regional: { outsideEntries: { r: number; pctRmse: number; total: number } };
  residentShares: Record<string, number>;
  calib: { regionalRate: number; xferFactor: number; tourRateFactor: number; commuteBasis: string };
};
const files = process.argv.slice(2);
const runs = Object.fromEntries(
  files.map((f) => {
    const e = JSON.parse(fs.readFileSync(f, 'utf8')) as Exp;
    const amObs = e.bartAm.reduce((a, x) => a + x.obs, 0), amMod = e.bartAm.reduce((a, x) => a + x.mod, 0);
    return [
      e.label,
      {
        commuteBasis: e.calib.commuteBasis,
        bartAmDowntown: { model: Math.round(amMod), count: Math.round(amObs), ratio: +(amMod / amObs).toFixed(3), stations: e.bartAm },
        bartCityExitsAmShare: e.tod.bartExits.AM,
        bartCityExits: { r: +e.bart.r.toFixed(3), pctRmse: +e.bart.pctRmse.toFixed(1), total: +e.bart.total.toFixed(3) },
        bartOutsideEntries: { r: +e.regional.outsideEntries.r.toFixed(3), pctRmse: +e.regional.outsideEntries.pctRmse.toFixed(1) },
        muni: { r: +e.muni.r.toFixed(3), pctRmse: +e.muni.pctRmse.toFixed(1), within25: +e.muni.within25.toFixed(3), total: +(e.muni.model / e.muni.observed).toFixed(3) },
        T: +(e.groups.T[1] / e.groups.T[0]).toFixed(3),
        caltrainSf: +(e.caltrain.mod / e.caltrain.obs).toFixed(3),
        residentTransitShare: +e.residentShares.transit.toFixed(4),
        regionalVisitorRate: +e.calib.regionalRate.toFixed(3),
        transferFactor: +e.calib.xferFactor.toFixed(3),
        tourRateFactor: +e.calib.tourRateFactor.toFixed(3),
      },
    ];
  }),
);
const out = {
  description: "BATS 2023's two readings of commuting, each with the aggregate rates and the person-level choices, each recalibrated (calibrate.ts 3 iterations; the person-level constants by abm-calibrate.ts), from experiment.ts runs. BART's morning count: each downtown station's August 2026 weekday exits times its share of exits by entry hour 6–10am in BART's October 2025 hourly counts. Caltrain publishes no counts by direction or time of day (FY2026 figures are fare-model boardings by origin station), so its morning northbound flow cannot be checked.",
  runs,
};
fs.writeFileSync(`${REFERENCE}/commute-basis.json`, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(runs))
  console.log(`${k.padEnd(11)} BART AM downtown ${v.bartAmDowntown.model}/${v.bartAmDowntown.count} (${v.bartAmDowntown.ratio}), city AM share ${(100 * v.bartCityExitsAmShare).toFixed(1)}% | BART exits r ${v.bartCityExits.r} %RMSE ${v.bartCityExits.pctRmse} | outside entries r ${v.bartOutsideEntries.r} | Muni r ${v.muni.r} %RMSE ${v.muni.pctRmse} ±25% ${v.muni.within25} total ${v.muni.total} | T ${v.T} | Caltrain ${v.caltrainSf} | regional rate ${v.regionalVisitorRate}, xfer ${v.transferFactor}, tour ×${v.tourRateFactor}`);
