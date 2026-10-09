/**
 * Step 4: zones. San Francisco's 2020 census block groups become the model's internal zones,
 * carrying who lives there (2020 census, ACS 2020–24 five-year estimates) and what is there
 * (LEHD LODES 2023 jobs by sector, schools, hotels, attractions from OpenStreetMap).
 * Places outside the city that send or receive San Francisco commuters (LODES 2023 home–work
 * flows) become external zones, grouped by city. Writes data/beta3/work/zones.json.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=2048 npx tsx server/beta3/pipeline/zones.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { toXY } from '../../../shared/beta3/geo';
import { RAW, REFERENCE, WORK } from './paths';

type Ring = [number, number][];
type Poly = Ring[];

export interface ZonePoint {
  x: number;
  y: number;
  /** residents + jobs at this block: the weight for walking to and from transit */
  w: number;
}

export interface InternalZone {
  id: string;
  nhood: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  /** land area, m² */
  land: number;
  pop: number;
  hh: number;
  /** households with 0, 1, 2+ vehicles */
  hhVeh: [number, number, number];
  /** households with income < $60k, $60–150k, $150k+ (2024 dollars) */
  hhInc: [number, number, number, number];
  /** employed residents */
  workers: number;
  age5to17: number;
  age18to24: number;
  age65plus: number;
  /** enrolled in college or graduate school (tract total shared out by people aged 18–34) */
  college: number;
  /** ACS B08301 commute mode counts of residents: [drove alone, carpool, bus, subway, commuter rail, light rail/streetcar, ferry, taxi, motorcycle, bike, walk, other, worked from home] */
  commute: number[];
  /** jobs by LODES CNS sector 1..20 (index 0..19), rebalanced to MTC 2023 employment */
  jobsBy: number[];
  /** MTC 2023: college full-time-equivalent and high-school enrolment */
  collegeEnroll?: number;
  hsEnroll?: number;
  jobs: number;
  schools: number;
  universities: number;
  /** hotel rooms (OSM `rooms`, or a typical size by kind) */
  hotelRooms: number;
  /** pull of attractions here: museums, galleries, viewpoints, stadiums (parks are counted by area) */
  attractions: number;
  /** park acreage (SF Rec and Park, Presidio and GGNRA) */
  parkAcres?: number;
  /** the parks here: [name, acres in this zone, the park's total acres] */
  parks?: [string, number, number][];
  /** public garages and lots */
  garages: number;
  /** OpenStreetMap storefronts: shops, places to eat and drink (with cinemas and theatres), and
   * services (banks, clinics, salons, post offices, libraries, places of worship...) */
  shops?: number;
  eateries?: number;
  services?: number;
  points: ZonePoint[];
  /** outline, for the map: rings of [lon, lat] */
  shape: Poly;
}

export interface ExternalZone {
  id: string;
  name: string;
  county: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  /** LODES primary jobs held by residents here, in San Francisco */
  toSF: number;
  /** San Francisco residents employed here */
  fromSF: number;
  /** where those commuters live or work: 400 m cells weighted by commuters to and from SF */
  points?: { x: number; y: number; w: number }[];
  /** the in-commuters' home PUMAs (2020 PUMAs, by census tract), as shares of toSF: build.ts rakes
   * the in-commuters to the ACS PUMS by home PUMA */
  puma?: Record<string, number>;
}

/** a zone's commuter blocks, gathered into 400 m cells */
function cellPoints(blocks: { x: number; y: number; toSF: number; fromSF: number }[]): { x: number; y: number; w: number }[] {
  const cells = new Map<string, { x: number; y: number; w: number }>();
  for (const e of blocks) {
    const n = e.toSF + e.fromSF;
    if (n <= 0) continue;
    const k = `${Math.floor(e.x / 400)},${Math.floor(e.y / 400)}`;
    const c = cells.get(k) ?? { x: 0, y: 0, w: 0 };
    c.x += e.x * n;
    c.y += e.y * n;
    c.w += n;
    cells.set(k, c);
  }
  return [...cells.values()].map((c) => ({ x: Math.round(c.x / c.w), y: Math.round(c.y / c.w), w: c.w }));
}

const BAY = new Set(['06001', '06013', '06041', '06055', '06081', '06085', '06095', '06097']);
const SFO = { lat: 37.6155, lon: -122.39, r: 2500 };
/** homes or jobs further than this from the city are remote work, not commutes */
const MAX_EXTERNAL_KM = 130;

// ---------- geometry helpers ----------

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPoly(lon: number, lat: number, poly: Poly): boolean {
  if (!inRing(lon, lat, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(lon, lat, poly[k])) return false;
  return true;
}
/** OSM member ways chained into closed rings */
function chainRings(segs: Ring[]): Ring[] {
  const rings: Ring[] = [];
  const open = segs.map((sg) => sg.slice());
  while (open.length) {
    let ring = open.shift()!;
    for (let guard = 0; guard < 500 && open.length; guard++) {
      const end = ring[ring.length - 1];
      if (end[0] === ring[0][0] && end[1] === ring[0][1]) break;
      const i = open.findIndex((sg) => (sg[0][0] === end[0] && sg[0][1] === end[1]) || (sg[sg.length - 1][0] === end[0] && sg[sg.length - 1][1] === end[1]));
      if (i < 0) break;
      const sg = open.splice(i, 1)[0];
      ring = ring.concat(sg[0][0] === end[0] && sg[0][1] === end[1] ? sg.slice(1) : sg.slice().reverse().slice(1));
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
function polysOf(geom: { type: string; coordinates: unknown }): Poly[] {
  return geom.type === 'Polygon' ? [geom.coordinates as Poly] : (geom.coordinates as Poly[]);
}

// ---------- census tables ----------

function readAcs(file: string): Map<string, Record<string, number>> {
  const lines = fs.readFileSync(`${RAW}/census/${file}`, 'utf8').trim().split('\n');
  const head = lines[0].split('|');
  const out = new Map<string, Record<string, number>>();
  for (const l of lines.slice(1)) {
    const c = l.split('|');
    const rec: Record<string, number> = {};
    head.forEach((h, i) => {
      if (i > 0 && h.includes('_E')) rec[h.slice(h.indexOf('_') + 1)] = Number(c[i]) || 0;
    });
    // GEO_ID like 1500000US060750101001 → 060750101001
    out.set(c[0].slice(c[0].indexOf('US') + 2), rec);
  }
  return out;
}
const sum = (r: Record<string, number>, ...k: string[]) => k.reduce((s, x) => s + (r[x] ?? 0), 0);
const E = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `E${String(a + i).padStart(3, '0')}`);

async function* gzLines(file: string) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

async function main() {
  console.time('zones');
  // ---- block groups ----
  const bgGeo = JSON.parse(fs.readFileSync(`${RAW}/census/bg2020.geojson`, 'utf8'));
  const nhoodGeo = JSON.parse(fs.readFileSync(`${RAW}/neighborhoods.geojson`, 'utf8'));
  const nhoods = nhoodGeo.features.map((f: { properties: { nhood: string }; geometry: { type: string; coordinates: unknown } }) => ({ name: f.properties.nhood, polys: polysOf(f.geometry) }));
  const nhoodAt = (lon: number, lat: number) => nhoods.find((n: { polys: Poly[] }) => n.polys.some((p) => inPoly(lon, lat, p)))?.name;

  const zones = new Map<string, InternalZone>();
  const shapes: { id: string; polys: Poly[] }[] = [];
  for (const f of bgGeo.features) {
    const p = f.properties;
    const lon = Number(p.INTPTLON), lat = Number(p.INTPTLAT);
    if (!(p.AREALAND > 0) || lon < -122.56) continue; // water-only groups and the Farallon Islands
    const polys = polysOf(f.geometry);
    shapes.push({ id: p.GEOID, polys });
    const [x, y] = toXY(lat, lon);
    zones.set(p.GEOID, {
      id: p.GEOID, nhood: nhoodAt(lon, lat) ?? '', lat, lon, x, y, land: p.AREALAND, pop: 0, hh: 0, hhVeh: [0, 0, 0], hhInc: [0, 0, 0, 0], workers: 0,
      age5to17: 0, age18to24: 0, age65plus: 0, college: 0, commute: [], jobsBy: new Array(20).fill(0), jobs: 0, schools: 0, universities: 0,
      hotelRooms: 0, attractions: 0, garages: 0, points: [], shape: polys.length === 1 ? polys[0] : polys.flat(1),
    });
  }
  const zoneAt = (lon: number, lat: number): InternalZone | undefined => {
    for (const s of shapes) if (s.polys.some((p) => inPoly(lon, lat, p))) return zones.get(s.id);
    return undefined;
  };
  // the nearest zone, for points that fall just outside every outline (piers, the shoreline)
  const nearestZone = (lon: number, lat: number): InternalZone => {
    const [x, y] = toXY(lat, lon);
    let best: InternalZone | undefined, bd = Infinity;
    for (const z of zones.values()) {
      const d = (z.x - x) ** 2 + (z.y - y) ** 2;
      if (d < bd) (bd = d), (best = z);
    }
    return best!;
  };
  console.log(`block groups ${zones.size}`);

  // ---- ACS ----
  const veh = readAcs('acs_b25044.dat'), inc = readAcs('acs_b19001.dat'), age = readAcs('acs_b01001.dat');
  const hhs = readAcs('acs_b11001.dat'), emp = readAcs('acs_b23025.dat'), jtw = readAcs('acs_b08301.dat');
  const enrollTract = readAcs('acs_b14001_tract.dat');
  const tot = readAcs('acs_b01001.dat');
  for (const z of zones.values()) {
    const v = veh.get(z.id), i = inc.get(z.id), a = age.get(z.id), h = hhs.get(z.id), e = emp.get(z.id), j = jtw.get(z.id);
    if (!v || !i || !a || !h || !e || !j) {
      console.warn(`no ACS for ${z.id}`);
      continue;
    }
    z.hh = h.E001;
    z.hhVeh = [sum(v, 'E003', 'E010'), sum(v, 'E004', 'E011'), sum(v, 'E005', 'E006', 'E007', 'E008', 'E012', 'E013', 'E014', 'E015')];
    // BATS 2023's bands: <$50k, $50–100k, $100–200k, $200k+
    z.hhInc = [sum(i, ...E(2, 10)), sum(i, ...E(11, 13)), sum(i, ...E(14, 16)), sum(i, 'E017')];
    z.workers = sum(e, 'E004', 'E006');
    z.age5to17 = sum(a, ...E(4, 6), ...E(28, 30));
    z.age18to24 = sum(a, ...E(7, 10), ...E(31, 34));
    z.age65plus = sum(a, ...E(20, 25), ...E(44, 49));
    // drove alone, carpool, bus, subway, commuter rail, light rail, ferry, taxi, motorcycle, bike, walk, other, home
    z.commute = ['E003', 'E004', 'E011', 'E012', 'E013', 'E014', 'E015', 'E016', 'E017', 'E018', 'E019', 'E020', 'E021'].map((k) => j[k] ?? 0);
  }
  // college enrolment is published by tract: share it among the tract's block groups by people aged 18–34
  const byTract = new Map<string, InternalZone[]>();
  for (const z of zones.values()) {
    const t = z.id.slice(0, 11);
    if (!byTract.has(t)) byTract.set(t, []);
    byTract.get(t)!.push(z);
  }
  for (const [t, zs] of byTract) {
    const r = enrollTract.get(t);
    if (!r) continue;
    const college = sum(r, 'E008', 'E009');
    const w = zs.map((z) => {
      const a = tot.get(z.id)!;
      return sum(a, ...E(7, 12), ...E(31, 36)) + 1e-6;
    });
    const W = w.reduce((s, x) => s + x, 0);
    zs.forEach((z, k) => (z.college = (college * w[k]) / W));
  }

  // ---- 2020 block populations (population counts for zone totals use ACS; blocks weight points) ----
  const blocks = JSON.parse(fs.readFileSync(`${RAW}/census/blocks2020.json`, 'utf8')) as { GEOID: string; POP100: number; INTPTLAT: string; INTPTLON: string }[];
  const pointW = new Map<string, { x: number; y: number; pop: number; jobs: number; bg: string }>();
  for (const b of blocks) {
    const bg = b.GEOID.slice(0, 12);
    if (!zones.has(bg)) continue;
    const [x, y] = toXY(Number(b.INTPTLAT), Number(b.INTPTLON));
    pointW.set(b.GEOID, { x, y, pop: b.POP100, jobs: 0, bg });
  }
  for (const z of zones.values()) z.pop = tot.get(z.id)?.E001 ?? 0;

  // ---- jobs by sector: LODES 2023 blocks, head-office filings corrected ----
  // LODES files some employers' jobs at a head-office address. Two corrections, each moving the jobs
  // together with their commuters (the LODES home-work flows to where they were filed):
  //  1. employers that publish their own counts by site (reference/major-employers.json: UCSF, which
  //     LODES puts entirely at Parnassus) are placed at their sites;
  //  2. the rest is rebalanced to MTC/ABAG's 2023 employment (Travel Model One TAZ1454), built from
  //     establishment data, by sector group: in each MTC zone LODES jobs are scaled down to MTC's total
  //     where LODES has more, and the jobs so removed citywide make a pool that fills the zones where
  //     MTC has more, with the pool's mix of sectors and of commuters. (Scaling a receiving zone's own
  //     LODES jobs up instead turned, for example, a few hundred restaurant jobs in Hayes Valley into
  //     3,700.) The health, education and recreation group is not rebalanced: there MTC's differences
  //     are mostly its own placement of UCSF (see major-employers.json).
  const blockJobs = new Map<string, Float64Array>();
  let head: string[] = [];
  for await (const line of gzLines(`${RAW}/lodes/ca_wac_S000_JT00_2023.csv.gz`)) {
    if (!head.length) {
      head = line.split(',');
      continue;
    }
    if (!line.startsWith('06075')) continue;
    const c = line.split(',');
    const v = new Float64Array(20);
    for (let k = 1; k <= 20; k++) v[k - 1] = Number(c[head.indexOf(`CNS${String(k).padStart(2, '0')}`)]);
    blockJobs.set(c[0], v);
  }
  const vsum = (v: Float64Array) => v.reduce((a, x) => a + x, 0);
  const lodesTotal = [...blockJobs.values()].reduce((s, v) => s + vsum(v), 0);
  const lodesByBg = new Map<string, number>();
  for (const [b, v] of blockJobs) lodesByBg.set(b.slice(0, 12), (lodesByBg.get(b.slice(0, 12)) ?? 0) + vsum(v));
  const adjusted = new Map<string, Float64Array>();
  for (const [b, v] of blockJobs) adjusted.set(b, Float64Array.from(v));
  // jobs placed away from where LODES filed them, each group with the commuters of the jobs it came
  // from: `from` gives the source block groups' weights (summing to 1), `to` the jobs placed by block group
  const placed: { from: Map<string, number>; to: Map<string, number> }[] = [];
  const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  // MTC sector groups → LODES CNS sectors (0-based)
  const GROUPS: Record<string, number[]> = {
    RETEMPN: [6], FPSEMPN: [9, 10, 11, 12, 13], HEREMPN: [14, 15, 16, 17], AGREMPN: [0, 1], MWTEMPN: [4, 5, 7], OTHEMPN: [2, 3, 8, 18, 19],
  };
  // (BETA3_NOT_REBALANCED overrides the list, for testing)
  const NOT_REBALANCED = new Set(process.env.BETA3_NOT_REBALANCED !== undefined ? process.env.BETA3_NOT_REBALANCED.split(',') : ['HEREMPN']);
  const DEFAULT_CNS: Record<string, number> = { RETEMPN: 6, FPSEMPN: 11, HEREMPN: 15, AGREMPN: 0, MWTEMPN: 7, OTHEMPN: 18 };
  const { readShapefile } = await import('./shapefile');
  const tazShapes = readShapefile(`${RAW}/mtc/taz1454`).filter((r) => Number(r.attrs.TAZ1454) >= 1 && Number(r.attrs.TAZ1454) <= 190).map((r) => ({ taz: Number(r.attrs.TAZ1454), rings: r.rings }));
  const tazOf = (lon: number, lat: number) => tazShapes.find((t) => inRing(lon, lat, t.rings[0]) || t.rings.some((rg) => inRing(lon, lat, rg)))?.taz;
  const landUse = new Map<number, Record<string, number>>();
  {
    const lines = fs.readFileSync(`${RAW}/mtc/tm1_TAZ1454_2023_LandUse.csv`, 'utf8').trim().split('\n');
    const h = lines[0].split(',').map((x) => x.replace(/"/g, ''));
    for (const l of lines.slice(1)) {
      const c = l.split(',');
      const r = Object.fromEntries(h.map((k, i) => [k, Number(c[i])]));
      if (r.COUNTY === 1) landUse.set(r.ZONE, r);
    }
  }
  const blockTaz = new Map<string, number>();
  const blockLand = new Map<string, number>();
  const blockXY = new Map<string, [number, number]>();
  for (const b of blocks) {
    if (!zones.has(b.GEOID.slice(0, 12))) continue;
    const t = tazOf(Number(b.INTPTLON), Number(b.INTPTLAT));
    if (t) blockTaz.set(b.GEOID, t);
    blockLand.set(b.GEOID, Number((b as unknown as { AREALAND: number }).AREALAND) || 0);
    blockXY.set(b.GEOID, toXY(Number(b.INTPTLAT), Number(b.INTPTLON)));
  }
  // 1. employers placed at their sites
  {
    const majors = JSON.parse(fs.readFileSync(`${REFERENCE}/major-employers.json`, 'utf8')).employers as {
      name: string; headOffice: { blockGroups: string[]; sectors: number[] }; sites: { site: string; lat: number; lon: number; jobs: number; healthShare: number }[];
    }[];
    // the census block a site stands in: the nearest block centroid within its block group
    const siteBlock = (lat: number, lon: number) => {
      const z = zoneAt(lon, lat) ?? nearestZone(lon, lat);
      const [x, y] = toXY(lat, lon);
      let best = '', bd = Infinity;
      for (const [b, [bx, by]] of blockXY) {
        if (b.slice(0, 12) !== z.id) continue;
        const d = (bx - x) ** 2 + (by - y) ** 2;
        if (d < bd) (bd = d), (best = b);
      }
      return best;
    };
    for (const emp of majors) {
      const cns = emp.headOffice.sectors.map((s) => s - 1);
      const from = new Map<string, number>();
      let removed = 0;
      for (const [b, v] of adjusted) {
        if (!emp.headOffice.blockGroups.includes(b.slice(0, 12))) continue;
        for (const k of cns) (addTo(from, b.slice(0, 12), v[k]), (removed += v[k]), (v[k] = 0));
      }
      for (const [bg, n] of from) from.set(bg, n / removed);
      const to = new Map<string, number>();
      for (const st of emp.sites) {
        const b = siteBlock(st.lat, st.lon);
        const v = adjusted.get(b) ?? new Float64Array(20);
        adjusted.set(b, v);
        v[15] += st.jobs * st.healthShare;
        v[14] += st.jobs * (1 - st.healthShare);
        addTo(to, b.slice(0, 12), st.jobs);
      }
      placed.push({ from, to });
      console.log(`${emp.name}: ${Math.round(removed)} LODES jobs at the head office → ${emp.sites.map((s) => `${s.site} ${s.jobs}`).join(', ')}`);
    }
  }
  // 2. MTC rebalancing by sector group, through a pool
  const tazBlocks = new Map<number, string[]>();
  for (const [b, t] of blockTaz) {
    if (!tazBlocks.has(t)) tazBlocks.set(t, []);
    tazBlocks.get(t)!.push(b);
  }
  for (const list of tazBlocks.values()) for (const b of list) if (!adjusted.has(b)) adjusted.set(b, new Float64Array(20));
  let moved = 0;
  for (const [g, cns] of Object.entries(GROUPS)) {
    if (NOT_REBALANCED.has(g)) continue;
    const pool = new Float64Array(20), from = new Map<string, number>();
    let poolTot = 0;
    const short: [number, number][] = [];
    for (const [taz, list] of tazBlocks) {
      const lu = landUse.get(taz);
      if (!lu) continue;
      const target = lu[g] ?? 0;
      const have = list.reduce((s, b) => s + cns.reduce((a, k) => a + adjusted.get(b)![k], 0), 0);
      if (have > target) {
        const f = target / have;
        for (const b of list)
          for (const k of cns) {
            const v = adjusted.get(b)!, x = v[k] * (1 - f);
            pool[k] += x;
            poolTot += x;
            addTo(from, b.slice(0, 12), x);
            v[k] *= f;
          }
      } else if (target > have) short.push([taz, target - have]);
      moved += Math.abs(target - have);
    }
    if (poolTot > 0) for (const [bg, n] of from) from.set(bg, n / poolTot);
    const to = new Map<string, number>();
    for (const [taz, need] of short) {
      const list = tazBlocks.get(taz)!;
      // spread over the zone's blocks by the group's jobs already there, or by land
      let w = list.map((b) => cns.reduce((a, k) => a + adjusted.get(b)![k], 0));
      if (w.every((x) => x <= 0)) w = list.map((b) => blockLand.get(b) || 1);
      const W = w.reduce((a, x) => a + x, 0);
      list.forEach((b, i) => {
        const add = (need * w[i]) / W;
        if (add <= 0) return;
        const v = adjusted.get(b)!;
        if (poolTot > 0) for (const k of cns) v[k] += (add * pool[k]) / poolTot;
        else v[DEFAULT_CNS[g]] += add;
        addTo(to, b.slice(0, 12), add);
      });
    }
    if (poolTot > 0) placed.push({ from, to });
  }
  let wacJobs = 0, wacLost = 0;
  for (const [block, v] of adjusted) {
    const bg = block.slice(0, 12);
    const z = zones.get(bg);
    const total = vsum(v);
    if (!z) {
      wacLost += total;
      continue;
    }
    for (let k = 0; k < 20; k++) z.jobsBy[k] += v[k];
    z.jobs += total;
    wacJobs += total;
    const p = pointW.get(block);
    if (p) p.jobs += total;
  }
  for (const z of zones.values()) (z.jobs = Math.round(z.jobs)), (z.jobsBy = z.jobsBy.map((v) => Math.round(v * 10) / 10));
  // commuters to each block group's jobs: its LODES flows times the share of its LODES jobs still
  // there (`kept`), plus those of the jobs placed there, which bring the flows per job of their sources
  const placedIn = new Map<string, number>();
  for (const pl of placed) for (const [bg, n] of pl.to) addTo(placedIn, bg, n);
  const kept = (bg: string) => {
    const l = lodesByBg.get(bg) ?? 0, z = zones.get(bg);
    return l > 0 && z ? Math.max(0, z.jobs - (placedIn.get(bg) ?? 0)) / l : 0;
  };
  // college and high-school enrolment by MTC zone, shared out by education jobs (then land)
  for (const [taz, list] of tazBlocks) {
    const lu = landUse.get(taz);
    if (!lu) continue;
    const coll = (lu.COLLFTE ?? 0) + 0.5 * (lu.COLLPTE ?? 0), hs = lu.HSENROLL ?? 0;
    const w = list.map((b) => (adjusted.get(b)![14] || 0) + 1e-3 * (blockLand.get(b) ?? 0) / 1e4);
    const W = w.reduce((a, x) => a + x, 0) || 1;
    list.forEach((b, i) => {
      const z = zones.get(b.slice(0, 12));
      if (!z) return;
      z.collegeEnroll = (z.collegeEnroll ?? 0) + (coll * w[i]) / W;
      z.hsEnroll = (z.hsEnroll ?? 0) + (hs * w[i]) / W;
    });
  }
  console.log(`jobs: LODES ${Math.round(lodesTotal)} → rebalanced to MTC 2023 ${Math.round(wacJobs + wacLost)} (moved ${Math.round(moved / 2)}), in land zones ${Math.round(wacJobs)}`);

  // weighted points per zone: blocks with people or jobs, the heaviest 30 kept and the rest folded in
  const ptsByZone = new Map<string, ZonePoint[]>();
  for (const p of pointW.values()) {
    const w = p.pop + p.jobs;
    if (w <= 0) continue;
    if (!ptsByZone.has(p.bg)) ptsByZone.set(p.bg, []);
    ptsByZone.get(p.bg)!.push({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), w });
  }
  for (const z of zones.values()) {
    let pts = (ptsByZone.get(z.id) ?? []).sort((a, b) => b.w - a.w);
    if (pts.length > 30) {
      const rest = pts.slice(30).reduce((s, p) => s + p.w, 0);
      pts = pts.slice(0, 30);
      const W = pts.reduce((s, p) => s + p.w, 0);
      pts.forEach((p) => (p.w += (rest * p.w) / W));
    }
    if (!pts.length) pts = [{ x: +z.x.toFixed(1), y: +z.y.toFixed(1), w: 1 }];
    z.points = pts;
    // the zone's centre of activity, not its geometric middle
    const W = pts.reduce((s, p) => s + p.w, 0);
    z.x = pts.reduce((s, p) => s + p.x * p.w, 0) / W;
    z.y = pts.reduce((s, p) => s + p.y * p.w, 0) / W;
  }

  // ---- points of interest ----
  const pois = JSON.parse(fs.readFileSync(`${RAW}/pois.json`, 'utf8')).elements as { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: Record<string, string> }[];
  const ROOMS: Record<string, number> = { hotel: 120, motel: 40, hostel: 60, guest_house: 10 };
  // a zoo's exhibits and viewpoints are mapped one by one in OpenStreetMap (the San Francisco Zoo has
  // about 40: "Hippo", "Penguin Island"...); they belong to the zoo, which counts once
  const zoos = pois.filter((e) => e.tags.tourism === 'zoo').map((e) => toXY(e.lat ?? e.center!.lat, e.lon ?? e.center!.lon));
  const inZoo = (lat: number, lon: number) => {
    const [x, y] = toXY(lat, lon);
    return zoos.some(([zx, zy]) => Math.hypot(zx - x, zy - y) < 450);
  };
  for (const e of pois) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const z = zoneAt(lon, lat) ?? (lon > -122.53 ? nearestZone(lon, lat) : undefined);
    if (!z) continue;
    const t = e.tags;
    const famous = !!(t.wikipedia || t.wikidata);
    if (t.amenity === 'school') z.schools += 1;
    else if (t.amenity === 'university' || t.amenity === 'college') z.universities += 1;
    else if (t.tourism && ROOMS[t.tourism]) z.hotelRooms += Number(t.rooms) > 0 ? Number(t.rooms) : ROOMS[t.tourism];
    else if (t.amenity === 'parking') z.garages += 1;
    else if ((t.tourism === 'attraction' || t.tourism === 'viewpoint') && !famous && inZoo(lat, lon)) continue;
    else if (t.tourism || (t.leisure && t.leisure !== 'park')) {
      // parks are counted by their acreage below, not as points
      const base = t.leisure === 'stadium' ? 2 : t.tourism === 'viewpoint' ? 0.3 : 1;
      z.attractions += base * (famous ? 3 : 1);
    }
  }

  // ---- shops, places to eat, and services (OpenStreetMap) ----
  // Storefronts by kind, for the destination size terms: LODES counts employees, so it misses the
  // owner-run shops and restaurants of Chinatown or the Mission (the self-employed are not in it) and
  // puts retail chains' head-office staff (Gap at Rincon Hill) where no one shops.
  if (fs.existsSync(`${RAW}/destinations/osm-destinations.json`)) {
    const SERVICE_SHOPS = new Set(['hairdresser', 'beauty', 'laundry', 'dry_cleaning', 'car_repair', 'massage', 'tattoo', 'copyshop', 'pet_grooming', 'storage_rental', 'travel_agency', 'funeral_directors', 'tailor', 'shoe_repair', 'repair', 'cosmetics_service', 'nails', 'money_lender', 'pawnbroker', 'car_wash', 'rental', 'photo_studio', 'locksmith']);
    const EAT = new Set(['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'ice_cream', 'nightclub', 'cinema', 'theatre']);
    const els = JSON.parse(fs.readFileSync(`${RAW}/destinations/osm-destinations.json`, 'utf8')).elements as { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: Record<string, string> }[];
    const n = { shops: 0, eateries: 0, services: 0 };
    for (const e of els) {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      const t = e.tags;
      if (t.shop === 'vacant' || t.disused || /^disused/.test(t.amenity ?? '')) continue;
      const z = zoneAt(lon, lat) ?? (lon > -122.53 ? nearestZone(lon, lat) : undefined);
      if (!z) continue;
      const kind: keyof typeof n = t.shop ? (SERVICE_SHOPS.has(t.shop) ? 'services' : 'shops') : t.amenity === 'marketplace' ? 'shops' : EAT.has(t.amenity) ? 'eateries' : 'services';
      z[kind] = (z[kind] ?? 0) + 1;
      n[kind]++;
    }
    console.log(`storefronts: ${n.shops} shops, ${n.eateries} places to eat and drink, ${n.services} services`);
  }

  // ---- parks: acreage by block group ----
  // SF Recreation and Park Department properties (DataSF "RPD Parks", with outlines) and the federal
  // lands they leave out (the Presidio and the Golden Gate National Recreation Area sites, from
  // OpenStreetMap). Each park is sampled on a 50 m grid and its acreage shared out by block group.
  {
    const parks: { name: string; rings: Ring[] }[] = [];
    if (fs.existsSync(`${RAW}/rpd_parks.json`))
      for (const r of JSON.parse(fs.readFileSync(`${RAW}/rpd_parks.json`, 'utf8')) as { map_park_n: string; the_geom: { type: string; coordinates: unknown } }[]) {
        const g = r.the_geom;
        const polys = g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
        for (const p of polys) parks.push({ name: r.map_park_n, rings: p });
      }
    if (fs.existsSync(`${RAW}/federal_parks.json`)) {
      const els = JSON.parse(fs.readFileSync(`${RAW}/federal_parks.json`, 'utf8')).elements as { type: string; tags: Record<string, string>; geometry?: { lat: number; lon: number }[]; members?: { role: string; geometry?: { lat: number; lon: number }[] }[] }[];
      const seen = new Set<string>();
      for (const e of els) {
        const name = e.tags.name;
        if (seen.has(name) || /Clothing/.test(name)) continue;
        seen.add(name);
        const segs: [number, number][][] = e.type === 'way' ? [e.geometry!.map((p) => [p.lon, p.lat] as [number, number])] : (e.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry!.map((p) => [p.lon, p.lat] as [number, number]));
        // chain open member ways into rings
        const rings: Ring[] = [];
        const open = segs.slice();
        while (open.length) {
          let ring = open.shift()!.slice();
          for (let guard = 0; guard < 500 && open.length; guard++) {
            const end = ring[ring.length - 1];
            if (end[0] === ring[0][0] && end[1] === ring[0][1]) break;
            const i = open.findIndex((sg) => (sg[0][0] === end[0] && sg[0][1] === end[1]) || (sg[sg.length - 1][0] === end[0] && sg[sg.length - 1][1] === end[1]));
            if (i < 0) break;
            const sg = open.splice(i, 1)[0];
            ring = ring.concat(sg[0][0] === end[0] && sg[0][1] === end[1] ? sg.slice(1) : sg.slice().reverse().slice(1));
          }
          if (ring.length > 3) rings.push(ring);
        }
        for (const r of rings) parks.push({ name, rings: [r] });
      }
    }
    // open water inside parks is not park land: Lake Merced's 268 acres made Lake Merced Park the
    // city's third-largest pull after Golden Gate Park and the Presidio (OSM natural=water, fetched to
    // data/beta3/raw/parks-water/osm-water.json by Overpass; bodies over an acre)
    const water: { poly: Poly; box: [number, number, number, number] }[] = [];
    if (fs.existsSync(`${RAW}/parks-water/osm-water.json`)) {
      const els = JSON.parse(fs.readFileSync(`${RAW}/parks-water/osm-water.json`, 'utf8')).elements as { type: string; geometry?: { lat: number; lon: number }[]; members?: { role: string; geometry?: { lat: number; lon: number }[] }[] }[];
      for (const e of els) {
        const segs: Ring[] = e.type === 'way' && e.geometry ? [e.geometry.map((p) => [p.lon, p.lat] as [number, number])] : (e.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry!.map((p) => [p.lon, p.lat] as [number, number]));
        for (const r of chainRings(segs)) {
          const xy = r.map(([lon, lat]) => toXY(lat, lon));
          let a2 = 0;
          for (let i = 0; i < xy.length; i++) a2 += xy[i][0] * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * xy[i][1];
          if (Math.abs(a2) / 2 / 4046.86 < 1) continue;
          const lons = r.map((p) => p[0]), lats = r.map((p) => p[1]);
          water.push({ poly: [r], box: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] });
        }
      }
    }
    const inWater = (lon: number, lat: number) => water.some((w) => lon >= w.box[0] && lon <= w.box[2] && lat >= w.box[1] && lat <= w.box[3] && inPoly(lon, lat, w.poly));
    let waterAcres = 0;
    const STEP = 50;
    let total = 0;
    const inZone = new Map<string, number>();
    for (const park of parks) {
      const outer = park.rings[0];
      const xy = outer.map(([lon, lat]) => toXY(lat, lon));
      const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
      for (let x = Math.min(...xs) + STEP / 2; x < Math.max(...xs); x += STEP)
        for (let y = Math.min(...ys) + STEP / 2; y < Math.max(...ys); y += STEP) {
          const [lat, lon] = (await import('../../../shared/beta3/geo')).toLatLon(x, y);
          if (!inPoly(lon, lat, park.rings)) continue;
          if (inWater(lon, lat)) {
            waterAcres += (STEP * STEP) / 4046.86;
            continue;
          }
          const z = zoneAt(lon, lat);
          if (!z) continue;
          const acres = (STEP * STEP) / 4046.86;
          z.parkAcres = (z.parkAcres ?? 0) + acres;
          total += acres;
          inZone.set(z.id, (inZone.get(z.id) ?? 0) + acres);
        }
      // each zone records the parks it holds: [name, acres here, the park's acres in all]
      const parkTotal = [...inZone.values()].reduce((a, v) => a + v, 0);
      for (const [zid, ac] of inZone) {
        const z = zones.get(zid)!;
        const prev = (z.parks ??= []).find((q) => q[0] === park.name);
        if (prev) (prev[1] += ac), (prev[2] += parkTotal);
        else z.parks.push([park.name, ac, parkTotal]);
      }
      inZone.clear();
    }
    // a park mapped as several outlines (e.g. RPD parcels) sums to one total
    const byName = new Map<string, number>();
    for (const z of zones.values()) for (const q of z.parks ?? []) byName.set(q[0], (byName.get(q[0]) ?? 0) + q[1]);
    for (const z of zones.values()) for (const q of z.parks ?? []) (q[1] = +q[1].toFixed(2)), (q[2] = +byName.get(q[0])!.toFixed(1));
    console.log(`parks: ${parks.length} outlines, ${Math.round(total)} acres inside land zones (${Math.round(waterAcres)} acres of open water left out)`);
  }

  // ---- LODES home–work flows (2023, primary jobs) ----
  const internalFlows = new Map<string, number>(); // "h|w" block groups
  const extIn = new Map<string, number>(); // external home block → SF bg: key `${block}|${bg}`
  // commuters into the city by home block outside it (to the jobs as placed): outside zones are drawn from these
  const blockIn = new Map<string, number>();
  const extOut = new Map<string, number>(); // SF bg → external work block
  // LODES commuters by workplace block group: home block group (in the city) or home block (outside)
  const rawTo = new Map<string, Map<string, number>>();
  const extPlaced: { perJob: Map<string, number>; to: Map<string, number> }[] = [];
  for await (const line of gzLines(`${RAW}/lodes/ca_od_main_JT01_2023.csv.gz`)) {
    const w = line.slice(0, 15), h = line.slice(16, 31);
    const wSF = w.startsWith('06075'), hSF = h.startsWith('06075');
    if (!wSF && !hSF) continue;
    const n = Number(line.slice(32, line.indexOf(',', 32)));
    const wz = wSF ? (zones.has(w.slice(0, 12)) ? w.slice(0, 12) : null) : null;
    const hz = hSF ? (zones.has(h.slice(0, 12)) ? h.slice(0, 12) : null) : null;
    if (wSF && hSF) {
      if (wz && hz) {
        internalFlows.set(`${hz}|${wz}`, (internalFlows.get(`${hz}|${wz}`) ?? 0) + n * kept(wz));
        rawTo.has(wz) || rawTo.set(wz, new Map());
        addTo(rawTo.get(wz)!, hz, n);
      }
    } else if (wSF && wz) {
      extIn.set(`${h}|${wz}`, (extIn.get(`${h}|${wz}`) ?? 0) + n * kept(wz));
      addTo(blockIn, h, n * kept(wz));
      rawTo.has(wz) || rawTo.set(wz, new Map());
      addTo(rawTo.get(wz)!, h, n);
    } else if (hSF && hz) extOut.set(`${hz}|${w}`, (extOut.get(`${hz}|${w}`) ?? 0) + n);
  }
  // the commuters of jobs placed away from where LODES filed them: per job, those of their sources
  for (const pl of placed) {
    const perJob = new Map<string, number>();
    for (const [src, wt] of pl.from) {
      const l = lodesByBg.get(src) ?? 0;
      if (l <= 0) continue;
      for (const [home, n] of rawTo.get(src) ?? []) addTo(perJob, home, (wt * n) / l);
    }
    // homes are SF block groups (12 digits) or blocks outside the city (15); those outside are added
    // once the blocks are grouped into outside zones
    for (const [bg, jobs] of pl.to) for (const [home, r] of perJob) if (home.length === 12) addTo(internalFlows, `${home}|${bg}`, jobs * r);
    const placedJobs = [...pl.to.values()].reduce((a, v) => a + v, 0);
    for (const [home, r] of perJob) if (home.length === 15) addTo(blockIn, home, placedJobs * r);
    extPlaced.push({ perJob: new Map([...perJob].filter(([h]) => h.length === 15)), to: pl.to });
  }
  const need = new Set<string>();
  for (const k of blockIn.keys()) need.add(k);
  for (const k of extOut.keys()) need.add(k.slice(13));
  const xw = new Map<string, { lat: number; lon: number; cty: string; ctyname: string; place: string; placename: string; csub: string; csubname: string }>();
  let xhead: string[] = [];
  const splitCsv = (l: string) => l.match(/("([^"]*)"|[^,]*)(,|$)/g)!.map((s) => s.replace(/,$/, '').replace(/^"|"$/g, ''));
  for await (const line of gzLines(`${RAW}/lodes/ca_xwalk.csv.gz`)) {
    if (!xhead.length) {
      xhead = splitCsv(line);
      continue;
    }
    const id = line.slice(0, 15);
    if (!need.has(id)) continue;
    const c = splitCsv(line);
    const g = (k: string) => c[xhead.indexOf(k)];
    xw.set(id, { lat: Number(g('blklatdd')), lon: Number(g('blklondd')), cty: g('cty'), ctyname: g('ctyname'), place: g('stplc'), placename: g('stplcname'), csub: g('ctycsub'), csubname: g('ctycsubname') });
  }
  // group outside blocks into external zones
  const extZones = new Map<string, ExternalZone & { sx: number; sy: number; sw: number }>();
  let remote = 0;
  const extKey = (b: string): string | null => {
    const r = xw.get(b);
    if (!r) return null;
    const [x, y] = toXY(r.lat, r.lon);
    if (Math.hypot(x, y) > MAX_EXTERNAL_KM * 1000) return null;
    const [sx, sy] = toXY(SFO.lat, SFO.lon);
    if (Math.hypot(x - sx, y - sy) < SFO.r) return 'SFO';
    if (!BAY.has(r.cty)) return `county:${r.cty}`;
    if (r.place && r.place !== '9999999') return `place:${r.place}`;
    return `csub:${r.csub}`;
  };
  const addExt = (b: string, n: number, dir: 'toSF' | 'fromSF') => {
    const key = extKey(b);
    if (!key) {
      remote += n;
      return null;
    }
    const r = xw.get(b)!;
    let z = extZones.get(key);
    if (!z) {
      const name =
        key === 'SFO' ? 'SFO airport' : key.startsWith('county:') ? r.ctyname.replace(', CA', '') : key.startsWith('place:') ? r.placename.replace(/ (city|town|CDP), CA$/, '').replace(', CA', '') : r.csubname.replace(/ \(.*\)$/, '').replace(/ CCD$/, '') + ' (unincorporated)';
      z = { id: key, name, county: r.ctyname.replace(', CA', ''), lat: 0, lon: 0, x: 0, y: 0, toSF: 0, fromSF: 0, sx: 0, sy: 0, sw: 0 };
      extZones.set(key, z);
    }
    z[dir] += n;
    const [x, y] = toXY(r.lat, r.lon);
    z.sx += x * n;
    z.sy += y * n;
    z.sw += n;
    return key;
  };
  for (const [b, n] of blockIn) addExt(b, n, 'toSF');
  for (const [k, n] of extOut) addExt(k.slice(13), n, 'fromSF');
  // fold small external zones into the nearest larger one in the same county
  const MIN_EXT = 400;
  const all = [...extZones.values()];
  for (const z of all) {
    z.x = z.sx / z.sw;
    z.y = z.sy / z.sw;
  }
  const merged = new Map<string, string>();
  const big = all.filter((z) => z.toSF + z.fromSF >= MIN_EXT || z.id === 'SFO' || z.id.startsWith('county:'));
  for (const z of all) {
    if (big.includes(z)) continue;
    const pool = big.filter((b) => b.county === z.county);
    const cand = pool.length ? pool : big;
    let best = cand[0], bd = Infinity;
    for (const b of cand) {
      const d = (b.x - z.x) ** 2 + (b.y - z.y) ** 2;
      if (d < bd) (bd = d), (best = b);
    }
    merged.set(z.id, best.id);
    best.x = (best.x * best.sw + z.x * z.sw) / (best.sw + z.sw);
    best.y = (best.y * best.sw + z.y * z.sw) / (best.sw + z.sw);
    best.sw += z.sw;
    best.toSF += z.toSF;
    best.fromSF += z.fromSF;
  }
  const finalId = (id: string) => merged.get(id) ?? id;
  // big places split into parts: Oakland's hills and its flats reach the city differently
  // (BART stations, Transbay buses, the bridge). k-means on census blocks weighted by commuters.
  const SPLIT = 6000;
  const blocksOf = new Map<string, Map<string, { x: number; y: number; w: number; toSF: number; fromSF: number }>>();
  const addBlock = (b: string, n: number, dir: 'toSF' | 'fromSF') => {
    const key = extKey(b);
    if (!key) return;
    const z = finalId(key);
    const r = xw.get(b)!;
    if (!blocksOf.has(z)) blocksOf.set(z, new Map());
    const m = blocksOf.get(z)!;
    let e = m.get(b);
    if (!e) {
      const [x, y] = toXY(r.lat, r.lon);
      e = { x, y, w: 0, toSF: 0, fromSF: 0 };
      m.set(b, e);
    }
    e.w += n;
    e[dir] += n;
  };
  for (const [b, n] of blockIn) addBlock(b, n, 'toSF');
  for (const [k, n] of extOut) addBlock(k.slice(13), n, 'fromSF');
  const blockZone = new Map<string, string>();
  const externals: ExternalZone[] = [];
  const { toLatLon } = await import('../../../shared/beta3/geo');
  const compass = (dx: number, dy: number) => {
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    return ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'][Math.round(((a + 360) % 360) / 45) % 8];
  };
  // walking catchments of regional stations outside the city (BART, Caltrain, ferry terminals):
  // people living within ~1.2 km of a station reach the city very differently from the rest of their
  // town (they walk to the train or the boat), so each catchment is its own zone
  const CATCH_M = 1200, MIN_CATCH = 150;
  const catchOf = new Map<string, string>();
  const stations: { key: string; name: string; x: number; y: number; county?: string }[] = [];
  if (fs.existsSync(`${WORK}/transit.json`)) {
    const tr = JSON.parse(fs.readFileSync(`${WORK}/transit.json`, 'utf8')) as { stops: { id: string; feed: string; name: string; lat: number; lon: number; x: number; y: number; station: boolean }[]; lines: { mode: string; stops: number[] }[] };
    const ferryStops = new Set(tr.lines.filter((l) => l.mode === 'ferry').flatMap((l) => l.stops));
    tr.stops.forEach((st, i) => {
      const regional = (st.station && ['bart', 'caltrain', 'ferry', 'smart'].includes(st.feed)) || ferryStops.has(i);
      const inCity = st.lat > 37.705 && st.lat < 37.835 && st.lon > -122.52 && st.lon < -122.355;
      if (regional && !inCity) stations.push({ key: `stn:${st.id}`, name: st.name.replace(/ (BART|Caltrain)?\s*Station$/i, '').replace(/ Ferry Terminal$/i, ' ferry'), x: st.x, y: st.y });
    });
  }
  const sfoXY = toXY(SFO.lat, SFO.lon);
  for (const [zid, m] of blocksOf) {
    if (zid === 'SFO' || zid.startsWith('county:')) continue;
    for (const [b, e] of m) {
      if (Math.hypot(e.x - sfoXY[0], e.y - sfoXY[1]) < SFO.r) continue;
      let best: string | null = null, bd = CATCH_M;
      for (const st of stations) {
        const d = Math.hypot(st.x - e.x, st.y - e.y);
        if (d < bd) (bd = d), (best = st.key);
      }
      if (best) catchOf.set(b, best);
    }
  }
  // catchments with too few commuters stay with their town
  const catchFlow = new Map<string, number>();
  for (const [zid, m] of blocksOf) for (const [b, e] of m) if (catchOf.has(b)) catchFlow.set(catchOf.get(b)!, (catchFlow.get(catchOf.get(b)!) ?? 0) + e.w);
  for (const [b, k] of [...catchOf]) if ((catchFlow.get(k) ?? 0) < MIN_CATCH) catchOf.delete(b);
  const catchBlocks = new Map<string, [string, { x: number; y: number; w: number; toSF: number; fromSF: number }, string][]>();
  for (const z of big)
    for (const [b, e] of blocksOf.get(z.id) ?? new Map()) {
      const k = catchOf.get(b);
      if (!k) continue;
      if (!catchBlocks.has(k)) catchBlocks.set(k, []);
      catchBlocks.get(k)!.push([b, e, z.county]);
    }
  for (const [k, list] of catchBlocks) {
    const st = stations.find((x) => x.key === k)!;
    const W = list.reduce((s2, [, e]) => s2 + e.w, 0);
    const cx = list.reduce((s2, [, e]) => s2 + e.x * e.w, 0) / W, cy = list.reduce((s2, [, e]) => s2 + e.y * e.w, 0) / W;
    for (const [b] of list) blockZone.set(b, k);
    const [lat, lon] = toLatLon(cx, cy);
    externals.push({ id: k, name: `Near ${st.name}`, county: list[0][2], lat: +lat.toFixed(5), lon: +lon.toFixed(5), x: Math.round(cx), y: Math.round(cy), toSF: list.reduce((s2, [, e]) => s2 + e.toSF, 0), fromSF: list.reduce((s2, [, e]) => s2 + e.fromSF, 0), points: cellPoints(list.map(([, e]) => e)) });
  }
  console.log(`station catchments: ${catchBlocks.size} zones (of ${stations.length} regional stations), ${[...catchOf.keys()].length} blocks`);
  for (const z of big) {
    const blocks = [...(blocksOf.get(z.id) ?? new Map()).entries()].filter(([b]) => !catchOf.has(b));
    const total = blocks.reduce((s, [, e]) => s + e.w, 0);
    const k = z.id === 'SFO' || z.id.startsWith('county:') ? 1 : Math.min(8, Math.max(1, Math.ceil(total / SPLIT)));
    // k-means, seeded by the heaviest blocks spread apart
    const cents: { x: number; y: number }[] = [];
    const sorted = blocks.slice().sort((a, b) => b[1].w - a[1].w);
    for (const [, e] of sorted) {
      if (cents.length >= k) break;
      if (cents.every((c) => Math.hypot(c.x - e.x, c.y - e.y) > 1500)) cents.push({ x: e.x, y: e.y });
    }
    while (cents.length < k && sorted.length) cents.push({ x: sorted[cents.length][1].x, y: sorted[cents.length][1].y });
    const assign = new Map<string, number>();
    for (let it = 0; it < 15; it++) {
      for (const [b, e] of blocks) {
        let best = 0, bd = Infinity;
        cents.forEach((c, i) => {
          const d = (c.x - e.x) ** 2 + (c.y - e.y) ** 2;
          if (d < bd) (bd = d), (best = i);
        });
        assign.set(b, best);
      }
      const acc = cents.map(() => ({ x: 0, y: 0, w: 0 }));
      for (const [b, e] of blocks) {
        const a = acc[assign.get(b)!];
        a.x += e.x * e.w;
        a.y += e.y * e.w;
        a.w += e.w;
      }
      acc.forEach((a, i) => a.w > 0 && (cents[i] = { x: a.x / a.w, y: a.y / a.w }));
    }
    const cx = z.x, cy = z.y;
    cents.forEach((c, i) => {
      const id = k > 1 ? `${z.id}#${i}` : z.id;
      const mine = blocks.filter(([b]) => (assign.get(b) ?? 0) === i);
      const toSF = mine.reduce((s, [, e]) => s + e.toSF, 0), fromSF = mine.reduce((s, [, e]) => s + e.fromSF, 0);
      if (k > 1 && toSF + fromSF === 0) return;
      for (const [b] of mine) blockZone.set(b, id);
      const [lat, lon] = toLatLon(c.x, c.y);
      externals.push({ id, name: k > 1 ? `${z.name} (${compass(c.x - cx, c.y - cy)})` : z.name, county: z.county, lat: +lat.toFixed(5), lon: +lon.toFixed(5), x: Math.round(c.x), y: Math.round(c.y), toSF, fromSF, points: z.id === 'SFO' ? undefined : cellPoints(mine.map(([, e]) => e)) });
    });
  }
  // two parts of a city can face the same way: number repeats
  const seen = new Map<string, number>();
  for (const z of externals) {
    const n = (seen.get(z.name) ?? 0) + 1;
    seen.set(z.name, n);
    if (n > 1) z.name = z.name.replace(/\)$/, ` ${n})`);
  }
  // each outside zone's in-commuters by home PUMA (census tract to 2020 PUMA relationship file)
  {
    const tractPuma = new Map<string, string>();
    for (const l of fs.readFileSync(`${RAW}/commute-county/2020_Census_Tract_to_2020_PUMA.txt`, 'utf8').replace(/^\uFEFF/, '').trim().split('\n').slice(1)) {
      const [st, cty, tract, puma] = l.trim().split(',');
      if (st === '06') tractPuma.set(`${st}${cty}${tract}`, puma);
    }
    const mix = new Map<string, Map<string, number>>();
    // (by home block, the commuters of jobs placed at their sites and in the rebalancing pool included,
    // so build.ts rakes the in-commuters as placed)
    for (const [b, n] of blockIn) {
      const e = blockZone.get(b), pu = tractPuma.get(b.slice(0, 11));
      if (!e || !pu) continue;
      const m = mix.get(e) ?? new Map<string, number>();
      m.set(pu, (m.get(pu) ?? 0) + n);
      mix.set(e, m);
    }
    for (const z of externals) {
      const m = mix.get(z.id);
      if (!m) continue;
      const t = [...m.values()].reduce((a, v) => a + v, 0);
      z.puma = Object.fromEntries([...m].filter(([, v]) => v / t >= 0.005).map(([p, v]) => [p, +(v / t).toFixed(4)]));
    }
  }
  const inFlows = new Map<string, number>(), outFlows = new Map<string, number>();
  for (const [k, n] of extIn) {
    const e = blockZone.get(k.slice(0, 15));
    if (e) inFlows.set(`${e}|${k.slice(16)}`, (inFlows.get(`${e}|${k.slice(16)}`) ?? 0) + n);
  }
  for (const [k, n] of extOut) {
    const e = blockZone.get(k.slice(13));
    if (e) outFlows.set(`${k.slice(0, 12)}|${e}`, (outFlows.get(`${k.slice(0, 12)}|${e}`) ?? 0) + n);
  }
  // in-commuters to jobs placed away from where LODES filed them, by outside zone
  {
    for (const { perJob, to } of extPlaced) {
      const byZone = new Map<string, number>();
      for (const [h, r] of perJob) {
        const e = blockZone.get(h);
        if (e) addTo(byZone, e, r);
      }
      for (const [bg, jobs] of to)
        for (const [e, r] of byZone) addTo(inFlows, `${e}|${bg}`, jobs * r);
    }
  }

  // placed jobs bring thin flows from many homes: drop those under MIN_FLOW commuters and scale the
  // rest of each workplace's flows up to its total, which keeps the model's commute loop small
  const MIN_FLOW = 0.5;
  const prune = (m: Map<string, number>) => {
    const tot = new Map<string, number>(), keep = new Map<string, number>();
    for (const [k, n] of m) {
      const w = k.slice(k.lastIndexOf('|') + 1);
      addTo(tot, w, n);
      if (n >= MIN_FLOW) addTo(keep, w, n);
    }
    for (const [k, n] of [...m]) {
      const w = k.slice(k.lastIndexOf('|') + 1);
      if (n < MIN_FLOW && (keep.get(w) ?? 0) > 0) m.delete(k);
      else if ((keep.get(w) ?? 0) > 0) m.set(k, (n * tot.get(w)!) / keep.get(w)!);
    }
  };
  const nBefore = internalFlows.size + inFlows.size;
  prune(internalFlows);
  prune(inFlows);
  console.log(`commute flows under ${MIN_FLOW}: ${nBefore - internalFlows.size - inFlows.size} of ${nBefore} dropped (totals kept by workplace)`);
  const internalTotal = [...internalFlows.values()].reduce((s, n) => s + n, 0);
  const inTotal = [...inFlows.values()].reduce((s, n) => s + n, 0);
  const outTotal = [...outFlows.values()].reduce((s, n) => s + n, 0);
  console.log(`commute flows: within SF ${internalTotal}, into SF ${inTotal}, out of SF ${outTotal}; remote (> ${MAX_EXTERNAL_KM} km) ${remote}`);
  console.log(`external zones ${externals.length}; biggest into SF: ${externals.sort((a, b) => b.toSF - a.toSF).slice(0, 8).map((z) => `${z.name} ${z.toSF}`).join(', ')}`);

  const zs = [...zones.values()];
  const tot2 = (f: (z: InternalZone) => number) => Math.round(zs.reduce((s, z) => s + f(z), 0));
  console.log(`pop ${tot2((z) => z.pop)}, hh ${tot2((z) => z.hh)}, zero-car hh ${tot2((z) => z.hhVeh[0])}, workers ${tot2((z) => z.workers)}, college ${tot2((z) => z.college)}, jobs ${tot2((z) => z.jobs)}, schools ${tot2((z) => z.schools)}, hotel rooms ${tot2((z) => z.hotelRooms)}`);

  const round = (r: Ring) => r.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)] as [number, number]);
  fs.writeFileSync(
    `${WORK}/zones.json`,
    JSON.stringify({
      internal: zs.map((z) => ({ ...z, x: +z.x.toFixed(1), y: +z.y.toFixed(1), college: +z.college.toFixed(1), shape: z.shape.map(round) })),
      external: externals,
      flows: {
        internal: [...internalFlows].map(([k, n]) => [...k.split('|'), n]),
        in: [...inFlows].map(([k, n]) => [...k.split('|'), n]),
        out: [...outFlows].map(([k, n]) => [...k.split('|'), n]),
      },
    }),
  );
  console.timeEnd('zones');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
