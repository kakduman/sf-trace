/**
 * Shared micromobility inputs (kept in data/beta3/raw/micromobility, gitignored):
 *  - Bay Wheels monthly trip histories, October 2025 to September 2026 (Lyft's public system data,
 *    https://s3.amazonaws.com/baywheels-data/index.html, under Lyft's Bay Wheels data license
 *    agreement), about 230 MB of zips;
 *  - the Bay Wheels GBFS feed: station locations and capacities, live vehicle counts by type, and
 *    pricing plans (a snapshot, dated in its file name);
 *  - SFMTA's monthly shared-mobility trip counts by mode and operator (Bay Wheels classic and e-bike,
 *    Lime and Spin scooters), the table behind its "Shared Mobility Trips" dashboard
 *    (https://www.sfmta.com/reports/shared-mobility-trips), refreshed on every run.
 * Already-downloaded files are skipped. Process them with bikeshare.ts.
 *
 * Run: npx tsx server/beta3/pipeline/fetch-micromobility.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { RAW } from './paths';

const UA = { 'User-Agent': 'interchange-beta3 (transit model research)' };
export const MM_RAW = path.join(RAW, 'micromobility');
/** the twelve months the model is checked against */
export const MONTHS = ['202510', '202511', '202512', '202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609'];
const BUCKET = 'https://s3.amazonaws.com/baywheels-data';
const SFMTA_TRIPS = 'https://transtat.sfmta.com/t/public/views/EMSTrips/SharedMobilityTotalTripsTable.csv';
const GBFS = 'https://gbfs.lyft.com/gbfs/2.3/bay/gbfs.json';

async function get(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  fs.mkdirSync(MM_RAW, { recursive: true });
  // the bucket's file names vary month to month (.csv.zip, .zip, lyftbikes-), so list it first
  const list = (await get(`${BUCKET}?list-type=2`)).toString();
  const keys = [...list.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  for (const m of MONTHS) {
    const key = keys.find((k) => k.startsWith(m) && k.endsWith('.zip'));
    if (!key) throw new Error(`no Bay Wheels file for ${m}`);
    const file = path.join(MM_RAW, `${m}-tripdata.zip`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      console.log(`have ${path.basename(file)}`);
      continue;
    }
    fs.writeFileSync(file, await get(`${BUCKET}/${key}`));
    console.log(`got ${key} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
    await new Promise((r) => setTimeout(r, 500));
  }
  // SFMTA's trip counts (one small table, always fetched: the current month fills in)
  fs.writeFileSync(path.join(MM_RAW, 'sfmta-shared-trips.csv'), await get(SFMTA_TRIPS));
  console.log('got sfmta-shared-trips.csv');
  // GBFS: one snapshot of the feeds that describe the system (not the minute-by-minute status)
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(MM_RAW, `gbfs-${stamp}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
    const root = JSON.parse((await get(GBFS)).toString());
    const feeds: { name: string; url: string }[] = root.data.en.feeds;
    fs.writeFileSync(path.join(dir, 'gbfs.json'), JSON.stringify(root));
    for (const f of feeds)
      if (/station_information|station_status|system_pricing_plans|system_information|vehicle_types|free_bike_status|system_regions/.test(f.name)) {
        fs.writeFileSync(path.join(dir, `${f.name}.json`), await get(f.url));
        console.log(`got gbfs ${f.name}`);
      }
  } else console.log(`have ${path.basename(dir)}`);
}

if (process.argv[1]?.endsWith('fetch-micromobility.ts')) main();
