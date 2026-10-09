/**
 * Step 1: San Francisco's street network from OpenStreetMap (Overpass), with the tags the model
 * needs for driving, walking and cycling. Writes data/beta3/raw/osm-network.json.
 *
 * Run: npx tsx server/beta3/pipeline/fetch-osm.ts [entrances]   (entrances: only the station entrances)
 */
import fs from 'node:fs';
import { RAW } from './paths';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// San Francisco's bounding box (with Treasure Island), which takes in a little of Daly City and
// Brisbane so streets that leave the city still join up at the border.
const BBOX = '37.700,-122.520,37.835,-122.355';
// Everything a person can walk on, not only the streets: sidewalks and crossings mapped as their
// own ways (many campus and park paths join the network only through them), pedestrian plazas
// mapped as areas, corridors, and ways closed to the public, whose access tags streets.ts reads
// (a path tagged access=no is often foot=yes). Driveways are left out. Nodes come with their tags,
// for barriers such as locked gates; fences, walls and railways come so that no gap in the map is
// joined across one.
const query = (bbox: string) => `[out:json][timeout:180][bbox:${bbox}];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|path|steps|cycleway|track|busway|corridor|bridleway|platform|road)$"]
     ["service"!~"^(driveway|drive-through)$"];
  relation["highway"="pedestrian"]["type"="multipolygon"];
  way["barrier"~"^(fence|wall|retaining_wall|city_wall|hedge|guard_rail)$"];
  way["railway"~"^(rail|subway|light_rail|narrow_gauge)$"];
);
out body;
>;
out body qt;`;

const ENTRANCES = `[out:json][timeout:120][bbox:${BBOX}];
node["railway"~"^(subway_entrance|train_station_entrance)$"];
out body;`;

/** the bounding box cut into n × n tiles (Overpass times out on the whole city at once) */
function tiles(n: number): string[] {
  const [s, w, no, e] = BBOX.split(',').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) out.push([s + ((no - s) * i) / n, w + ((e - w) * j) / n, s + ((no - s) * (i + 1)) / n, w + ((e - w) * (j + 1)) / n].map((v) => v.toFixed(5)).join(','));
  return out;
}

async function ask(query: string, tries = 3): Promise<string> {
  let lastErr: unknown;
  for (let t = 0; t < tries; t++)
  for (const url of OVERPASS) {
    try {
      console.log(`asking ${url} ...`);
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'interchange-beta3 (transit model research)' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      JSON.parse(text);
      return text;
    } catch (e) {
      lastErr = e;
      console.warn(`failed: ${e}`);
      await new Promise((r) => setTimeout(r, 30000 * (t + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const only = process.argv[2];
  if (only !== 'entrances') {
    // tile by tile (a busy server turns away a query asking for much time or memory), each kept
    // until all are in; a way crossing tiles comes back whole from each, so keep one copy
    const seen = new Map<string, unknown>();
    let osm3s: unknown;
    fs.mkdirSync(`${RAW}/osm-tiles`, { recursive: true });
    for (const bbox of tiles(5)) {
      const f = `${RAW}/osm-tiles/${bbox}.json`;
      if (!fs.existsSync(f)) fs.writeFileSync(f, await ask(query(bbox), 8));
      const json = JSON.parse(fs.readFileSync(f, 'utf8')) as { osm3s: unknown; elements: { type: string; id: number }[] };
      osm3s ??= json.osm3s;
      for (const e of json.elements) seen.set(`${e.type}${e.id}`, e);
      console.log(`  ${bbox}: ${json.elements.length} elements, ${seen.size} in all`);
    }
    const elements = [...seen.values()] as { type: string }[];
    const text = JSON.stringify({ osm3s, elements });
    const ways = elements.filter((e) => e.type === 'way').length;
    const nodes = elements.filter((e) => e.type === 'node').length;
    fs.writeFileSync(`${RAW}/osm-network.json`, text);
    fs.rmSync(`${RAW}/osm-tiles`, { recursive: true });
    console.log(`ways ${ways}, nodes ${nodes}, ${(text.length / 1e6).toFixed(1)} MB`);
  }
  const ent = await ask(ENTRANCES);
  fs.writeFileSync(`${RAW}/osm-entrances.json`, ent);
  console.log(`station entrances ${JSON.parse(ent).elements.length}`);
}

main();
