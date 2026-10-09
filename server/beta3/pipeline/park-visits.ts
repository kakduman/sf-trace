/**
 * Check: visits the model sends to Golden Gate Park on each day type, against San Francisco
 * Recreation and Park's published estimate of about 24 million visits a year (sfrecpark.org,
 * Getting to Golden Gate Park), which includes its museums and gardens (calibration nets them out). Park visits
 * are the measure calibration fits on weekdays (demand.ts parkVisits: the park's share of each
 * zone's pull); "zone" adds every trip to the neighborhood's block groups, the park or not.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/park-visits.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import type { DayType, Scenario } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const prep = prepare(b);
  const parks = ['Golden Gate Park', 'Presidio', 'McLaren Park', 'Lincoln Park', 'Lakeshore'];
  const out: Record<string, unknown> = { source: 'SF Recreation and Park: about 24 million visitors a year to Golden Gate Park (https://sfrecpark.org/1159/Getting-to-Golden-Gate-Park)', observedPerDayAverage: Math.round(24e6 / 365) };
  const days: Record<string, Record<string, { park: number; visits: number; leisure: number; acres: number }>> = {};
  for (const day of ['wkd', 'sat', 'sun'] as DayType[]) {
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/${day === 'wkd' ? 'base' : `base-${day}`}.bin.gz`)));
    const sc: Scenario = { name: 'Today', edits: [], day };
    const r = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 1, warmCrowd: base.finalCrowd }, prep);
    days[day] = {};
    for (const p of parks) {
      let v = 0, l = 0, a = 0;
      H.zones.forEach((z, i) => {
        if (z.nhood !== p) return;
        v += r.demand.zoneVisits[i];
        l += r.demand.zoneVisitsLeisure[i];
        a += z.parkAcres ?? 0;
      });
      const park = Object.entries(r.demand.parkVisits).filter(([k]) => k.startsWith(p)).reduce((x, [, y]) => x + y, 0);
      days[day][p] = { park: Math.round(park), visits: Math.round(v), leisure: Math.round(l), acres: Math.round(a) };
    }
    console.log(day, JSON.stringify(days[day]));
  }
  // an average day of the year: 255 weekdays, 52 Saturdays, 58 Sundays and holidays
  const ggp = (d: string) => days[d]['Golden Gate Park'].park;
  out.modelAverageDay = Math.round((255 * ggp('wkd') + 52 * ggp('sat') + 58 * ggp('sun')) / 365);
  out.byDay = days;
  fs.writeFileSync(`${REFERENCE}/park-visits.json`, JSON.stringify(out, null, 1));
  console.log(`Golden Gate Park: model ${out.modelAverageDay} visits on an average day vs ~${out.observedPerDayAverage} published`);
}

main();
