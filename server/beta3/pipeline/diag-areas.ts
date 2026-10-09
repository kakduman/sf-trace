/**
 * Diagnostic: residents' transit use by area, against SFMTA's Travel Decision Survey (2017 and 2019
 * pooled, residents' trips on two days; sf-mode-by-area.json tdsTabulated), relative to the city so
 * that the change in level since 2019 drops out. The survey's five zones are groups of ZIP codes; each
 * Analysis Neighborhood is placed in the zone that holds most of it.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-areas.ts [--json out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { prepare } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';
import { modelState } from './od-checks';

/** the survey's zone groups (ZIP codes, TDS 2021 'Zone Description') by Analysis Neighborhood */
export const TDS_GROUPS: [string, string[]][] = [
  ['SOUTHEAST Z5', ['Excelsior', 'Outer Mission', 'Oceanview/Merced/Ingleside', 'Bayview Hunters Point', 'Visitacion Valley', 'Portola', 'McLaren Park', 'Treasure Island']],
  ['WEST Z3+Z4', ['Inner Richmond', 'Outer Richmond', 'Seacliff', 'Presidio', 'Presidio Heights', 'Lone Mountain/USF', 'Lincoln Park', 'Golden Gate Park', 'Inner Sunset', 'Sunset/Parkside', 'West of Twin Peaks', 'Twin Peaks', 'Glen Park', 'Lakeshore']],
  ['Z1', ['Mission', 'South of Market', 'Potrero Hill', 'Mission Bay', 'Castro/Upper Market', 'Noe Valley', 'Bernal Heights']],
  ['Z2', ['Tenderloin', 'Hayes Valley', 'Chinatown', 'Nob Hill', 'Russian Hill', 'North Beach', 'Financial District/South Beach', 'Western Addition', 'Pacific Heights', 'Haight Ashbury', 'Marina', 'Japantown']],
];

async function main() {
  const b = loadBundle();
  const H = b.header;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const st = await modelState(b, H.calibration!, prepare(b), base.finalCrowd);
  const d = st.demand;
  const tds = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8')).tdsTabulated.byYear['2017+2019'];
  const groupOf = new Map<string, number>();
  TDS_GROUPS.forEach(([, ns], g) => ns.forEach((n) => groupOf.set(n, g)));
  // residents' trips by home zone, each zone's transit share weighted by its people
  const acc = TDS_GROUPS.map(() => ({ pop: 0, transitW: 0, work: 0, workTr: 0 }));
  let cityPop = 0, cityTr = 0;
  H.zones.forEach((z, i) => {
    const g = groupOf.get(z.nhood);
    cityPop += z.pop;
    cityTr += z.pop * d.zoneTransitShare[i];
    if (g === undefined) return;
    acc[g].pop += z.pop;
    acc[g].transitW += z.pop * d.zoneTransitShare[i];
    acc[g].work += d.zoneWork[i];
    acc[g].workTr += d.zoneWorkTransit[i];
  });
  const city = cityTr / cityPop;
  const tCity = tds.allSF.all.publicTransitPct / 100;
  const rows = TDS_GROUPS.map(([name], g) => {
    const key = Object.keys(tds.byZoneGroup_allTrips).find((k) => k.startsWith(name.split(' ')[0]))!;
    const o = tds.byZoneGroup_allTrips[key];
    const m = acc[g].transitW / acc[g].pop;
    return { group: key, tdsTransit: o.publicTransitPct / 100, tdsSE: o.publicTransitSEpct / 100, tdsRelative: o.publicTransitPct / 100 / tCity, modelTransit: m, modelRelative: m / city, modelCommuteTransit: acc[g].workTr / acc[g].work };
  });
  for (const r of rows) console.log(`${r.group.padEnd(60)} TDS ${(100 * r.tdsTransit).toFixed(1)}±${(100 * r.tdsSE).toFixed(1)}% (×${r.tdsRelative.toFixed(2)} the city) | model ${(100 * r.modelTransit).toFixed(1)}% (×${r.modelRelative.toFixed(2)}); model commutes ${(100 * r.modelCommuteTransit).toFixed(1)}%`);
  const i = process.argv.indexOf('--json');
  if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ note: "Residents' trips, all purposes, transit share by the TDS's zone groups; the model's zones weighted by people. TDS: 2017 and 2019 pooled, relative to its city-wide share (19.9%).", rows }, null, 1));
}

if (process.argv[1]?.endsWith('diag-areas.ts')) main();
