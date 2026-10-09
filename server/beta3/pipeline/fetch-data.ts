/**
 * Step 0: download the public inputs (about 230 MB, kept in data/beta3/raw, gitignored):
 * GTFS schedules, LEHD LODES 2023, ACS 2020–24 summary-file tables (filtered to San Francisco),
 * 2020 census blocks and block groups (TIGERweb), SF Analysis Neighborhoods (DataSF) and
 * points of interest (OpenStreetMap). Already-downloaded files are skipped.
 *
 * Run: npx tsx server/beta3/pipeline/fetch-data.ts
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { RAW } from './paths';

const UA = { 'User-Agent': 'interchange-beta3 (transit model research)' };

async function download(url: string, file: string) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return console.log(`have ${file.replace(RAW + '/', '')}`);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`got ${file.replace(RAW + '/', '')} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
}

/** stream a national summary-file table, keeping the header and rows for one geography prefix */
export async function acsTable(table: string, geo: string, file: string, vintage = '5YRData/acsdt5y2024') {
  if (fs.existsSync(file)) return console.log(`have ${file.replace(RAW + '/', '')}`);
  const res = await fetch(`https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/${vintage}-${table}.dat`, { headers: UA });
  if (!res.ok || !res.body) throw new Error(`${table}: ${res.status}`);
  const rl = readline.createInterface({ input: Readable.fromWeb(res.body as never) });
  const out: string[] = [];
  for await (const line of rl) if (!out.length || line.startsWith(geo)) out.push(line);
  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(`got ${file.replace(RAW + '/', '')} (${out.length - 1} rows)`);
}

async function tigerweb(layer: number, fields: string, geometry: boolean): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let off = 0; ; off += 2000) {
    const p = new URLSearchParams({ where: "STATE='06' AND COUNTY='075'", outFields: fields, returnGeometry: String(geometry), f: geometry ? 'geojson' : 'json', resultOffset: String(off), resultRecordCount: '2000', outSR: '4326' });
    if (geometry) p.set('geometryPrecision', '6');
    const d = await (await fetch(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/${layer}/query?${p}`, { headers: UA })).json();
    out.push(...d.features);
    if (d.features.length < 2000) return out;
  }
}

const POI_QUERY = `[out:json][timeout:180][bbox:37.700,-122.520,37.835,-122.355];
(
  nwr["amenity"~"^(school|university|college|hospital)$"];
  nwr["tourism"~"^(hotel|hostel|motel|guest_house|museum|attraction|zoo|aquarium|gallery|viewpoint)$"];
  nwr["leisure"~"^(stadium|park)$"]["name"];
  nwr["amenity"="parking"]["parking"~"^(multi-storey|underground)$"];
);
out center tags qt;`;

// places people go on errands, to shop and to eat: shops, eating and drinking places, banks, clinics,
// post offices, libraries, places of worship and the like (destination size terms, demand.ts)
const DEST_QUERY = `[out:json][timeout:300][bbox:37.700,-122.520,37.835,-122.355];
(
  nwr["shop"];
  nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|cinema|theatre|nightclub|marketplace|bank|pharmacy|clinic|doctors|dentist|post_office|library|community_centre|place_of_worship|townhall|courthouse|social_facility)$"];
  nwr["craft"];
  nwr["office"~"^(government)$"];
  nwr["healthcare"];
);
out center tags qt;`;

// parks, gardens, beaches and recreation grounds, with their outlines (for acreage by block group)
const PARK_QUERY = `[out:json][timeout:180][bbox:37.700,-122.520,37.835,-122.355];
(
  way["leisure"~"^(park|garden|nature_reserve|recreation_ground|playground|dog_park)$"];
  relation["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"];
  way["natural"="beach"];
  relation["natural"="beach"];
);
out geom tags qt;`;

async function main() {
  for (const d of ['gtfs', 'lodes', 'census']) fs.mkdirSync(`${RAW}/${d}`, { recursive: true });
  // schedules (Mobility Database catalog lists these; SFMTA's feed moved in 2025)
  await download('https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip', `${RAW}/gtfs/muni.zip`);
  await download('https://www.bart.gov/dev/schedules/google_transit.zip', `${RAW}/gtfs/bart.zip`);
  await download('https://storage.googleapis.com/storage/v1/b/mdb-latest/o/us-california-caltrain-gtfs-54.zip?alt=media', `${RAW}/gtfs/caltrain.zip`);
  await download('https://realtime.goldengate.org/gtfsstatic/GTFSTransitData.zip', `${RAW}/gtfs/ggt.zip`);
  await download('https://gtfs.sanfranciscobayferry.com/gtfs.zip', `${RAW}/gtfs/ferry.zip`);
  // PresidiGo, the Presidio Trust's shuttles (published by GMV Syncromatics; Transitland f-presidigo~ca~us):
  // shuttles.ts takes its Downtown route's stops, shapes, and trips from it
  fs.mkdirSync(`${RAW}/presidigo`, { recursive: true });
  await download('https://presidiobus.com/gtfs', `${RAW}/presidigo/presidigo-gtfs.zip`);
  // jobs and commutes
  const L = 'https://lehd.ces.census.gov/data/lodes/LODES8/ca';
  await download(`${L}/od/ca_od_main_JT01_2023.csv.gz`, `${RAW}/lodes/ca_od_main_JT01_2023.csv.gz`);
  await download(`${L}/wac/ca_wac_S000_JT00_2023.csv.gz`, `${RAW}/lodes/ca_wac_S000_JT00_2023.csv.gz`);
  await download(`${L}/rac/ca_rac_S000_JT00_2023.csv.gz`, `${RAW}/lodes/ca_rac_S000_JT00_2023.csv.gz`);
  await download(`${L}/ca_xwalk.csv.gz`, `${RAW}/lodes/ca_xwalk.csv.gz`);
  // ACS (block groups unless noted)
  for (const t of ['b25044', 'b19001', 'b01001', 'b11001', 'b23025', 'b08301']) await acsTable(t, '1500000US06075', `${RAW}/census/acs_${t}.dat`);
  for (const t of ['b08202', 'b14001']) await acsTable(t, '1400000US06075', `${RAW}/census/acs_${t}_tract.dat`);
  // the synthetic population's controls (synpop.ts): households by size, and people in households
  for (const t of ['b11016', 'b25008']) await acsTable(t, '1500000US06075', `${RAW}/census/acs_${t}.dat`);
  // limited-English households by block group (language.ts; survey-underreporting tests only)
  fs.mkdirSync(`${RAW}/language`, { recursive: true });
  await acsTable('c16002', '1500000US06075', `${RAW}/language/acs_c16002.dat`);
  // 2020 census redistricting file (group quarters by type, table P5, by block group; synpop-seed.ts)
  fs.mkdirSync(`${RAW}/synpop`, { recursive: true });
  await download('https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/California/ca2020.pl.zip', `${RAW}/synpop/ca2020.pl.zip`);
  await acsTable('b08141', '0500000US06075', `${RAW}/census/acsdt5y2024_b08141.dat`);
  await acsTable('b08141', '0500000US06075', `${RAW}/census/acsdt1y2024_b08141.dat`, '1YRData/acsdt1y2024');
  // census geography
  if (!fs.existsSync(`${RAW}/census/blocks2020.json`)) {
    const blocks = (await tigerweb(10, 'GEOID,POP100,HU100,INTPTLAT,INTPTLON,AREALAND', false)) as { attributes: unknown }[];
    fs.writeFileSync(`${RAW}/census/blocks2020.json`, JSON.stringify(blocks.map((b) => b.attributes)));
    console.log(`got census blocks (${blocks.length})`);
  }
  if (!fs.existsSync(`${RAW}/census/bg2020.geojson`)) {
    const bg = await tigerweb(8, 'GEOID,AREALAND,AREAWATER,INTPTLAT,INTPTLON', true);
    fs.writeFileSync(`${RAW}/census/bg2020.geojson`, JSON.stringify({ type: 'FeatureCollection', features: bg }));
    console.log(`got block groups (${bg.length})`);
  }
  await download('https://data.sfgov.org/api/geospatial/j2bu-swwd?method=export&format=GeoJSON', `${RAW}/neighborhoods.geojson`);
  if (!fs.existsSync(`${RAW}/parks.json`)) {
    // Overpass servers rate-limit: try each, keep only a real JSON answer
    for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
      const res = await fetch(host, { method: 'POST', body: new URLSearchParams({ data: PARK_QUERY }), headers: UA });
      const text = await res.text();
      try {
        JSON.parse(text);
        fs.writeFileSync(`${RAW}/parks.json`, text);
        console.log(`got parks from ${host}`);
        break;
      } catch {
        console.warn(`${host}: ${res.status}, retrying elsewhere`);
      }
    }
  }
  if (!fs.existsSync(`${RAW}/pois.json`)) {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: POI_QUERY }), headers: UA });
    fs.writeFileSync(`${RAW}/pois.json`, await res.text());
    console.log('got points of interest');
  }
  fs.mkdirSync(`${RAW}/destinations`, { recursive: true });
  if (!fs.existsSync(`${RAW}/destinations/osm-destinations.json`))
    for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
      const res = await fetch(host, { method: 'POST', body: new URLSearchParams({ data: DEST_QUERY }), headers: UA });
      const text = await res.text();
      try {
        JSON.parse(text);
        fs.writeFileSync(`${RAW}/destinations/osm-destinations.json`, text);
        console.log(`got shops and services from ${host}`);
        break;
      } catch {
        console.warn(`${host}: ${res.status}, retrying elsewhere`);
      }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
