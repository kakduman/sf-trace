/**
 * Collects the survey-underreporting stress tests (October 2026; research/underreporting.md) into
 * server/beta3/reference/underreport-results.json: two-pass experiment.ts runs on the calibrated
 * bundle, the unchanged model and each set of UNDERREPORT factors, with Muni's routes scaled to the
 * counted total so only the pattern is compared, Muni boardings by stop district against SFMTA's
 * 2006–07 shares, and BART's city exits.
 * Run: npx tsx server/beta3/pipeline/underreport-results.ts <dir with base.json and one .json per test>
 */
import fs from 'node:fs';
import { REFERENCE } from './paths';
import { lepShares } from './language';
import { loadBundle } from './run-base';
import { DISTRICTS, zoneDistricts } from './od-checks';

const TESTS: Record<string, string> = {
  base: 'the model as calibrated (all factors 1)',
  inc125: "households under $100,000: shopping, other, and social tours ×1.25 (the top of RSG's 15–25% smartphone-over-web gap, given to every low-income household)",
  lep2: 'limited-English households: those tours ×2 (the cap on RSG\'s factors, given to every limited-English household)',
  strong: 'all at once, beyond any source: under $100,000 ×1.5, households without a car another ×1.3, limited-English ×2',
};
const FOCUS = ['T', '14', '14R', '49', '8', '30'];

const dir = process.argv[2];
const runs = Object.entries(TESTS)
  .filter(([k]) => fs.existsSync(`${dir}/${k}.json`))
  .map(([k, what]) => {
    const e = JSON.parse(fs.readFileSync(`${dir}/${k}.json`, 'utf8'));
    const f = e.muniScaled.factor as number;
    return {
      test: k,
      what,
      muniRoutes: { model: Math.round(e.muni.model), observed: e.muni.observed, scaledBy: f, r: e.muniScaled.r, pctRmseScaled: e.muniScaled.pctRmse, within25Scaled: e.muniScaled.within25 },
      routesScaled: Object.fromEntries(FOCUS.map((r) => {
        const x = (e.routes as { route: string; obs: number; mod: number }[]).find((y) => y.route === r)!;
        return [r, { model: Math.round(f * x.mod), observed: x.obs }];
      })),
      districts: (e.muniDistricts as { district: string; model: number; tep2006: number }[]).map((x) => ({ district: x.district, model: Math.round(x.model), tep2006: Math.round(x.tep2006) })),
      bartCityExits: { r: e.bart.r, total: e.bart.total },
      residentTransitShare: e.residentShares.transit,
    };
  });
// who lives where: limited-English households (ACS C16002) and households under $100,000 (the
// bundle's ACS income bands), by district and for the city
const b = loadBundle();
const lep = lepShares(b), zd = zoneDistricts(b);
const acc = DISTRICTS.map(() => [0, 0, 0]);
b.header.zones.forEach((z, i) => {
  const a = acc[zd[i]];
  a[0] += lep[i] * z.hh;
  a[1] += z.hhInc[0] + z.hhInc[1];
  a[2] += z.hhInc.reduce((s, v) => s + v, 0);
});
const tot = acc.reduce((s, a) => s.map((v, j) => v + a[j]), [0, 0, 0]);
const households = {
  city: { limitedEnglish: tot[0] / tot[2], under100k: tot[1] / tot[2] },
  byDistrict: Object.fromEntries(DISTRICTS.map(([n], k) => [n, { limitedEnglish: acc[k][0] / acc[k][2], under100k: acc[k][1] / acc[k][2] }])),
};
const out = {
  description: "Survey underreporting by segment as a cause of Muni's misses near home (research/underreporting.md). Stress tests of params.ts UNDERREPORT, which is 1 in the model: two-pass experiment.ts runs from the base run's crowding on the calibrated bundle. Muni's 57 counted routes are scaled to their counted total so only the pattern is compared; route counts are not fitted. Districts: Muni boardings by the district of the stop, the model against SFMTA's 2006–07 stop counts taken as shares of the model's total.",
  generated: new Date().toISOString().slice(0, 10),
  households,
  runs,
};
fs.writeFileSync(`${REFERENCE}/underreport-results.json`, JSON.stringify(out, null, 1) + '\n');
console.log(`limited-English households: Mission ${(100 * households.byDistrict.Mission.limitedEnglish).toFixed(1)}%, city ${(100 * households.city.limitedEnglish).toFixed(1)}%; under $100,000: Mission ${(100 * households.byDistrict.Mission.under100k).toFixed(1)}%, city ${(100 * households.city.under100k).toFixed(1)}%`);
for (const r of runs) console.log(`${r.test}: scaled %RMSE ${r.muniRoutes.pctRmseScaled.toFixed(1)}, r ${r.muniRoutes.r.toFixed(3)}, within ±25% ${(100 * r.muniRoutes.within25Scaled).toFixed(0)}%, BART exits r ${r.bartCityExits.r.toFixed(3)} | ${FOCUS.map((x) => `${x} ${r.routesScaled[x].model}/${r.routesScaled[x].observed}`).join(' ')}`);
