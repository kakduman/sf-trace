/**
 * Step 7: assemble the model bundle the browser loads (client/beta3/model/sf.bin.gz):
 * zones with derived densities and area types, commute flows rescaled to the ACS, the transit
 * network with fares fitted to each operator's fare table, level-of-service matrices, and the
 * observed counts the model is validated against. Keeps any calibration already in the bundle
 * unless --fresh is passed.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/build.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
import { decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import { microBundleParts } from './micromob-bundle';
import { toXY } from '../../../shared/beta3/geo';
import { WFH_RESIDENTS_2024 } from '../../../shared/beta3/params';
import type { BLine, BStop, BundleHeader, ExtZoneAttrs, FareRule, Observed, TPeriod as TPeriodKey, ZoneAttrs } from '../../../shared/beta3/types';
import { BUNDLE, RAW, REFERENCE, VARIANT, WORK, variantFile } from './paths';
import { readShapefile } from './shapefile';
import { synpopArrays } from './synpop-bundle';
import { studentFields } from './student-fields';

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

/**
 * Residents' commutes leaving the city (share of those not working from home) and in-commuters, from
 * the ACS 2024 1-year tables (acs-commute.json acs1yr2024: B08130 residents by place of work, B08604
 * and B08406 workers at the city's workplaces). The 2020–24 5-year tables pool 2020 and 2021, when
 * residents working from home were counted as working in the city: taken with 2024's share working
 * from home they gave 22.0% of residents' commutes leaving the city and 236,707 in-commuters, against
 * 28.2% and 267,641 in 2024.
 */
export function commuteSplit(acs: { acs1yr2024: { residentsByPlaceOfWork_B08130: { outShareOfCommuters: number }; inCommuters: { total: number } } }) {
  return { outTarget: acs.acs1yr2024.residentsByPlaceOfWork_B08130.outShareOfCommuters, inCommuters: acs.acs1yr2024.inCommuters.total };
}

/** a feed's flat fare by route short name, from GTFS fare_attributes + fare_rules (route-level rules only) */
function gtfsRouteFares(zip: string, pick: 'min' | 'max' = 'min'): Record<string, number> {
  const files = unzipSync(fs.readFileSync(`${RAW}/gtfs/${zip}`));
  const txt = (n: string) => (files[n] ? parseCsv(strFromU8(files[n])) : []);
  const price = new Map(txt('fare_attributes.txt').map((r) => [r.fare_id, Number(r.price)]));
  const short = new Map(txt('routes.txt').map((r) => [r.route_id, r.route_short_name || r.route_id]));
  const out: Record<string, number> = {};
  for (const r of txt('fare_rules.txt')) {
    const p = price.get(r.fare_id);
    if (!r.route_id || p === undefined || !short.has(r.route_id)) continue;
    // several fares on a route: the lowest (cash vs ticket), or the highest (AC Transit lists its local
    // fare on Transbay routes too, for trips within the East Bay)
    const k = short.get(r.route_id)!;
    out[k] = pick === 'min' ? Math.min(out[k] ?? Infinity, p) : Math.max(out[k] ?? -Infinity, p);
  }
  return out;
}

function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const split = (l: string) => l.match(/("([^"]*)"|[^,]*)(,|$)/g)!.slice(0, -1).map((s) => s.replace(/,$/, '').replace(/^"|"$/g, '').trim());
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const c = split(l);
    return Object.fromEntries(head.map((h, i) => [h, c[i] ?? '']));
  });
}

/** least squares for small systems */
function lsq(X: number[][], y: number[]): number[] {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  X.forEach((row, n) => {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += row[i] * row[j];
      A[i][k] += row[i] * y[n];
    }
  });
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < k; r++) {
      if (r === i || Math.abs(A[i][i]) < 1e-12) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[k] / r[i]));
}

/**
 * Where in-commuters live. LODES files jobs at establishment addresses, so it puts too many of the
 * city's workers' homes far away (Santa Clara County 12.5% of in-commuters against the ACS's 6.6%;
 * Sacramento and San Joaquin twice their ACS shares) and too few in San Mateo and Contra Costa.
 * The ACS 2020–24 PUMS (in-commuters-pums.json) gives the in-commuters by home PUMA. Each outside
 * zone's flows are scaled by its PUMA mix (zones.ts) so the totals match the PUMS: by PUMA where it
 * has at least 100 sample records, by county for the rest of a county (and one factor for counties
 * the PUMS tabulation lumps together). Returns a factor per outside zone (mean 1 over the flows).
 */
function rakeInCommuters(X: ExtZoneAttrs[], mix: Record<string, number>[], fIn: [string, string, number][], xi: Map<string, number>): Float64Array {
  const P = read(`${REFERENCE}/in-commuters-pums.json`) as { byPuma: { puma: string; county: string; workers: number; n: number; zeroCar: number }[] };
  const MIN_N = 100;
  const lodes = new Float64Array(X.length);
  for (const [e, , n] of fIn) if (xi.has(e)) lodes[xi.get(e)!] += n;
  const L = lodes.reduce((a, v) => a + v, 0);
  const W = P.byPuma.reduce((a, r) => a + r.workers, 0);
  // PUMA → its group: itself (enough records) or the rest of its county; targets as shares of all in-commuters
  const groupOf = new Map<string, string>(), target = new Map<string, number>();
  for (const r of P.byPuma) {
    const g = r.n >= MIN_N ? `puma:${r.puma}` : `county:${r.county}`;
    groupOf.set(r.puma, g);
    target.set(g, (target.get(g) ?? 0) + r.workers / W);
  }
  const gOf = (puma: string) => groupOf.get(puma) ?? 'other';
  if (!target.has('other')) target.set('other', 0);
  // zones' LODES in-commuters by group, then a factor per group, iterated (zones can span groups)
  const share = X.map((_, e) => {
    const m = new Map<string, number>();
    for (const [pu, w] of Object.entries(mix[e])) m.set(gOf(pu), (m.get(gOf(pu)) ?? 0) + w);
    const t = [...m.values()].reduce((a, v) => a + v, 0);
    if (t <= 0) return new Map([['other', 1]]);
    for (const [k, v] of m) m.set(k, v / t);
    return m;
  });
  // groups with no LODES zone (or no PUMS target) fold into 'other'
  const g = new Map<string, number>([...target.keys()].map((k) => [k, 1]));
  for (const m of share) for (const k of m.keys()) if (!g.has(k)) g.set(k, 1), target.set(k, 0);
  const f = new Float64Array(X.length).fill(1);
  for (let it = 0; it < 30; it++) {
    for (let e = 0; e < X.length; e++) {
      let v = 0;
      for (const [k, w] of share[e]) v += w * g.get(k)!;
      f[e] = v;
    }
    const model = new Map<string, number>();
    for (let e = 0; e < X.length; e++) for (const [k, w] of share[e]) model.set(k, (model.get(k) ?? 0) + (lodes[e] * f[e] * w) / L);
    for (const [k, m] of model) {
      const t = target.get(k) ?? 0;
      // a group the PUMS has no record of keeps its LODES level rather than vanishing
      if (t > 0 && m > 0) g.set(k, g.get(k)! * (t / m));
    }
  }
  // each zone's share of in-commuters from households without a car, from its PUMAs (pooled by
  // group, as the totals are)
  {
    const zc = new Map<string, [number, number]>();
    for (const r of P.byPuma) {
      const k = gOf(r.puma), a = zc.get(k) ?? [0, 0];
      a[0] += r.zeroCar;
      a[1] += r.workers;
      zc.set(k, a);
    }
    const all = P.byPuma.reduce((a, r) => a + r.zeroCar, 0) / W;
    X.forEach((z, e) => {
      let v = 0;
      for (const [k, w] of share[e]) {
        const a = zc.get(k);
        v += w * (a && a[1] > 0 ? a[0] / a[1] : all);
      }
      z.zeroCar = +v.toFixed(4);
    });
  }
  // normalise so the total stays the ACS in-commuter count
  const tot = X.reduce((a, _, e) => a + lodes[e] * f[e], 0) / L;
  for (let e = 0; e < X.length; e++) f[e] /= tot;
  const byCounty = new Map<string, [number, number]>();
  X.forEach((z, e) => {
    const c = byCounty.get(z.county) ?? [0, 0];
    c[0] += lodes[e] / L;
    c[1] += (lodes[e] * f[e]) / L;
    byCounty.set(z.county, c);
  });
  console.log(`in-commuters by home county, LODES → raked: ${[...byCounty].sort((a, b) => b[1][1] - a[1][1]).slice(0, 10).map(([c, [a, b]]) => `${c.replace(/ County$/, '')} ${(100 * a).toFixed(1)}→${(100 * b).toFixed(1)}%`).join(', ')}`);
  return f;
}

function main() {
  console.time('build');
  const zonesF = read(`${WORK}/zones.json`);
  const transit = read(`${WORK}/${variantFile('transit.json')}`) as { stops: BStop[]; lines: BLine[] };
  const sk = read(`${WORK}/${variantFile('skims.json')}`);
  const skBin = fs.readFileSync(`${WORK}/${variantFile('skims.bin')}`);
  const Zs = zonesF.internal as (ZoneAttrs & { points: { x: number; y: number; w: number }[] })[];
  // the commuter cells of outside zones are used by skims.ts only
  const X = (zonesF.external as (ExtZoneAttrs & { points?: unknown })[]).map(({ points: _p, ...z }) => (void _p, z as ExtZoneAttrs));
  const extPuma = X.map((z) => z.puma ?? {});
  const NZ = Zs.length;

  // ---------- zone derived attributes ----------
  const acres = (m2: number) => m2 / 4046.86;
  const RADIUS = 800;
  // working from home: the 5-year mix by area, rescaled to the 2024 citywide level
  const wfh5 = Zs.map((z) => {
    const t = z.commute.reduce((s, v) => s + v, 0);
    return t > 0 ? z.commute[12] / t : 0.3;
  });
  const w5 = Zs.reduce((s, z, i) => s + wfh5[i] * z.workers, 0) / Zs.reduce((s, z) => s + z.workers, 0);
  // private commuter shuttles: the share of each zone's residents within 600 m (about a 10-minute
  // walk) of an approved SFMTA Commuter Shuttle Program stop
  const shuttleStops = (read(`${REFERENCE}/commuter-shuttles.json`).approvedStops.stops as [number, number, string][]).map(([lat, lon]) => { const [x, y] = toXY(lat, lon); return { x, y }; });
  const shuttleReach = Zs.map((z) => {
    let near = 0, all = 0;
    for (const p of z.points) {
      all += p.w;
      if (shuttleStops.some((s) => Math.hypot(s.x - p.x, s.y - p.y) <= 600)) near += p.w;
    }
    return all > 0 ? near / all : 0;
  });
  const inRings = (lon: number, lat: number, rings: [number, number][][]) => {
    let inside = false;
    for (const r of rings)
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, ya] = r[a], [xb, yb] = r[b];
        if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
      }
    return inside;
  };
  // K-12 pupils at the zone's schools and living in it, by level; named college campuses (student-fields.ts)
  const students = studentFields(Zs as never);
  students.forEach((f, i) => f.collegeEnroll !== undefined && (Zs[i].collegeEnroll = f.collegeEnroll));
  // MTC superdistrict of each block group (that of the TAZ1454 zone holding its centroid; the nearest
  // block group's where the centroid falls in the bay): where special-event attendees live (special-events.json)
  const sdOf = new Int8Array(NZ);
  {
    const taz = readShapefile(`${RAW}/mtc/taz1454`).filter((r) => Number(r.attrs.TAZ1454) <= 190).map((r) => ({ taz: Number(r.attrs.TAZ1454), rings: r.rings as [number, number][][] }));
    const lines = fs.readFileSync(`${RAW}/mtc/tm1_TAZ1454_2023_LandUse.csv`, 'utf8').trim().split('\n');
    const h = lines[0].split(',').map((x) => x.replace(/"/g, ''));
    const sdOfTaz = new Map(lines.slice(1).map((l) => l.split(',')).map((c) => [Number(c[h.indexOf('ZONE')]), Number(c[h.indexOf('SD')])]));
    Zs.forEach((z, i) => {
      const t = taz.find((q) => inRings(z.lon, z.lat, q.rings));
      if (t) sdOf[i] = sdOfTaz.get(t.taz) ?? 0;
    });
    Zs.forEach((z, i) => {
      if (sdOf[i]) return;
      let best = -1, bd = Infinity;
      Zs.forEach((q, k) => {
        const dd = Math.hypot(q.x - z.x, q.y - z.y);
        if (sdOf[k] && dd < bd) ((bd = dd), (best = k));
      });
      if (best >= 0) sdOf[i] = sdOf[best];
    });
    const pop = [0, 0, 0, 0];
    Zs.forEach((z, i) => sdOf[i] && (pop[sdOf[i] - 1] += z.pop));
    console.log(`superdistricts: population ${pop.map((p) => Math.round(p / 1000) + 'k').join(', ')}`);
  }
  const zones: ZoneAttrs[] = Zs.map((z, i) => {
    let pop = 0, jobs = 0, hh = 0, land = 0;
    for (const q of Zs) {
      if (Math.hypot(q.x - z.x, q.y - z.y) > RADIUS) continue;
      pop += q.pop;
      jobs += q.jobs;
      hh += q.hh;
      land += q.land;
    }
    const ac = Math.max(acres(land), 1);
    const tm1Density = (pop + 2.5 * jobs) / ac;
    // TM1 area types from floating density: regional core, CBD, urban business, urban
    const areaType = tm1Density > 300 ? 0 : tm1Density > 100 ? 1 : tm1Density > 55 ? 2 : 3;
    const perSqMi = ((pop + jobs) / Math.max(land, 1)) * 2.59e6;
    const densityIndex = hh + jobs > 0 ? (2 * hh * jobs) / (hh + jobs) / ac : 0;
    const { points: _p, ...rest } = z;
    void _p;
    return { ...rest, areaType, density: Math.round(perSqMi), densityIndex: +densityIndex.toFixed(2), wfh: +Math.min(0.9, (wfh5[i] * WFH_RESIDENTS_2024) / w5).toFixed(3), shuttleReach: +shuttleReach[i].toFixed(3), ...(sdOf[i] ? { sd: sdOf[i] } : {}), ...students[i] };
  });
  const at = [0, 0, 0, 0];
  zones.forEach((z) => (at[z.areaType] += z.jobs));
  console.log(`shuttle stops: ${shuttleStops.length}; residents within 600 m: ${Math.round(Zs.reduce((a, z, i) => a + z.pop * shuttleReach[i], 0)).toLocaleString()}`);
  console.log(`jobs by area type (core, CBD, urban business, urban): ${at.map((v) => Math.round(v / 1000) + 'k').join(', ')}`);

  // zone block points (for new stops' walk access)
  const ptStart = new Int32Array(NZ + 1);
  Zs.forEach((z, i) => (ptStart[i + 1] = ptStart[i] + z.points.length));
  const ptX = new Float32Array(ptStart[NZ]), ptY = new Float32Array(ptStart[NZ]), ptW = new Float32Array(ptStart[NZ]);
  Zs.forEach((z, i) => z.points.forEach((p, k) => ((ptX[ptStart[i] + k] = p.x), (ptY[ptStart[i] + k] = p.y), (ptW[ptStart[i] + k] = p.w))));

  // ---------- commute flows rescaled to the ACS ----------
  const acs = read(`${REFERENCE}/acs-commute.json`);
  const zi = new Map(zones.map((z, i) => [z.id, i]));
  const xi = new Map(X.map((z, i) => [z.id, i]));
  const fI = zonesF.flows.internal as [string, string, number][];
  const fIn = zonesF.flows.in as [string, string, number][];
  const fOut = zonesF.flows.out as [string, string, number][];
  // residents: LODES puts too many SF residents' jobs outside the city (head-office addresses);
  // reweight the outside share to the ACS's, then use shares. In-commuters: ACS workers at SF
  // workplaces less residents working in the city. Both from the ACS 2024 1-year tables, the year of
  // the working-from-home share and the commute mode targets (commuteSplit)
  const sumI = fI.reduce((s, f) => s + f[2], 0), sumO = fOut.reduce((s, f) => s + f[2], 0);
  const { outTarget, inCommuters } = commuteSplit(acs);
  const outWeight = (outTarget / (1 - outTarget)) / (sumO / sumI);
  console.log(`LODES out-of-city share ${(sumO / (sumI + sumO)).toFixed(3)} → ACS ${outTarget.toFixed(3)} (weight ${outWeight.toFixed(2)})`);
  const flowH: number[] = [], flowW: number[] = [], flowN: number[] = [];
  for (const [h, w, n] of fI) if (zi.has(h) && zi.has(w)) flowH.push(zi.get(h)!), flowW.push(zi.get(w)!), flowN.push(n);
  for (const [h, e, n] of fOut) if (zi.has(h) && xi.has(e)) flowH.push(zi.get(h)!), flowW.push(NZ + xi.get(e)!), flowN.push(n * outWeight);
  const sumIn = fIn.reduce((s, f) => s + f[2], 0);
  const inFactor = rakeInCommuters(X, extPuma, fIn, xi);
  const inH: number[] = [], inW: number[] = [], inN: number[] = [];
  for (const [e, w, n] of fIn) if (xi.has(e) && zi.has(w)) inH.push(xi.get(e)!), inW.push(zi.get(w)!), inN.push((n * inFactor[xi.get(e)!] * inCommuters) / sumIn);
  console.log(`in-commuters (ACS) ${inCommuters}, LODES ${sumIn} → scale ${(inCommuters / sumIn).toFixed(2)}, raked by home PUMA`);

  // ---------- fares fitted to each operator's fare table ----------
  const stopIdx = new Map(transit.stops.map((s, i) => [s.id, i]));
  const fares: Record<string, FareRule> = {};
  {
    const files = unzipSync(fs.readFileSync(`${RAW}/gtfs/bart.zip`));
    const attrs = new Map(parseCsv(strFromU8(files['fare_attributes.txt'])).map((r) => [r.fare_id, Number(r.price)]));
    const rules = parseCsv(strFromU8(files['fare_rules.txt']));
    const st = (code: string) => transit.stops[stopIdx.get(`bart:${code}`) ?? -1];
    const east = (s: BStop) => s.lon > -122.33 && s.lat > 37.6;
    const X1: number[][] = [], y: number[] = [];
    for (const r of rules) {
      const a = st(r.origin_id), b = st(r.destination_id);
      if (!a || !b || a === b) continue;
      const km = Math.hypot(a.x - b.x, a.y - b.y) / 1000;
      const tube = east(a) !== east(b) ? 1 : 0;
      const sfo = r.origin_id === 'SFIA' || r.destination_id === 'SFIA' ? 1 : 0;
      X1.push([1, km, tube, sfo]);
      y.push(attrs.get(r.fare_id)!);
    }
    const [board0, perKm0, tube0, sfo0] = lsq(X1, y);
    const pred = X1.map((r) => board0 + perKm0 * r[1] + tube0 * r[2] + sfo0 * r[3]);
    const rmse0 = Math.sqrt(pred.reduce((s, p, i) => s + (p - y[i]) ** 2, 0) / y.length);
    // better: a fare for boarding plus one per track segment, fitted over every station pair's
    // shortest path (BART charges by route distance with surcharges, which this reproduces)
    const bartStops = [...new Set(transit.lines.filter((l) => l.feed === 'bart').flatMap((l) => l.stops))];
    const adj = new Map<number, Map<number, number>>();
    for (const l of transit.lines.filter((l) => l.feed === 'bart'))
      for (let k = 0; k + 1 < l.stops.length; k++) {
        const a = l.stops[k], c = l.stops[k + 1];
        const km = Math.hypot(transit.stops[a].x - transit.stops[c].x, transit.stops[a].y - transit.stops[c].y) / 1000;
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.has(c)) adj.set(c, new Map());
        adj.get(a)!.set(c, km);
        adj.get(c)!.set(a, km);
      }
    const segKey = (a: number, c: number) => (a < c ? `${a}-${c}` : `${c}-${a}`);
    const segs = new Map<string, number>();
    for (const [a, m] of adj) for (const c of m.keys()) if (!segs.has(segKey(a, c))) segs.set(segKey(a, c), segs.size);
    const pathSegs = (from: number, to: number): number[] | null => {
      const dist = new Map<number, number>([[from, 0]]), prev = new Map<number, number>();
      const open = new Set([from]);
      while (open.size) {
        let u = -1, du = Infinity;
        for (const v of open) if (dist.get(v)! < du) (du = dist.get(v)!), (u = v);
        open.delete(u);
        if (u === to) break;
        for (const [v, km] of adj.get(u) ?? []) {
          const nd = du + km;
          if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd), prev.set(v, u), open.add(v);
        }
      }
      if (!prev.has(to)) return null;
      const out: number[] = [];
      for (let v = to; v !== from; v = prev.get(v)!) out.push(segs.get(segKey(prev.get(v)!, v))!);
      return out;
    };
    const rowsX: number[][] = [], rowsY: number[] = [];
    for (const r of rules) {
      const a = stopIdx.get(`bart:${r.origin_id}`), c = stopIdx.get(`bart:${r.destination_id}`);
      if (a === undefined || c === undefined || a === c || !bartStops.includes(a) || !bartStops.includes(c)) continue;
      const p = pathSegs(a, c);
      if (!p) continue;
      const row = new Array(1 + segs.size).fill(0);
      row[0] = 1;
      for (const k of p) row[1 + k] += 1;
      rowsX.push(row);
      rowsY.push(attrs.get(r.fare_id)!);
    }
    // a light ridge keeps rarely-identified segments sensible
    for (let k = 0; k < segs.size; k++) {
      const row = new Array(1 + segs.size).fill(0);
      row[1 + k] = 0.3;
      rowsX.push(row);
      rowsY.push(0.3 * 0.3);
    }
    const beta = lsq(rowsX, rowsY);
    const fitted = rowsX.slice(0, rowsX.length - segs.size).map((r) => r.reduce((s, v, i) => s + v * beta[i], 0));
    const rmse = Math.sqrt(fitted.reduce((s, p, i) => s + (p - rowsY[i]) ** 2, 0) / fitted.length);
    const hops: FareRule['hops'] = [];
    for (const [k, i] of segs) {
      const [a, c] = k.split('-').map(Number);
      hops.push({ a, b: c, fare: +beta[1 + i].toFixed(3) });
    }
    fares.bart = { board: +beta[0].toFixed(3), perKm: 0, hops };
    console.log(`BART fare: straight-line fit rmse $${rmse0.toFixed(2)}; per-segment fit $${beta[0].toFixed(2)} + ${segs.size} segments, rmse $${rmse.toFixed(2)} over ${fitted.length} pairs`);
  }
  const zoneFare = (feed: string, file: string, stationOf: (stopId: string, raw: Map<string, Record<string, string>>) => string) => {
    const files = unzipSync(fs.readFileSync(`${RAW}/gtfs/${file}`));
    const attrs = new Map(parseCsv(strFromU8(files['fare_attributes.txt'])).map((r) => [r.fare_id, Number(r.price)]));
    const rules = parseCsv(strFromU8(files['fare_rules.txt']));
    const raw = new Map(parseCsv(strFromU8(files['stops.txt'])).map((r) => [r.stop_id, r]));
    // zone → mean position of our stops in it
    const zpos = new Map<string, { x: number; y: number; n: number }>();
    for (const r of raw.values()) {
      if (!r.zone_id) continue;
      const i = stopIdx.get(`${feed}:${stationOf(r.stop_id, raw)}`);
      if (i === undefined) continue;
      const p = zpos.get(r.zone_id) ?? { x: 0, y: 0, n: 0 };
      p.x += transit.stops[i].x;
      p.y += transit.stops[i].y;
      p.n++;
      zpos.set(r.zone_id, p);
    }
    const X1: number[][] = [], y: number[] = [];
    for (const r of rules) {
      const a = zpos.get(r.origin_id), b = zpos.get(r.destination_id);
      if (!a || !b || !attrs.has(r.fare_id)) continue;
      const km = Math.hypot(a.x / a.n - b.x / b.n, a.y / a.n - b.y / b.n) / 1000;
      X1.push([1, km]);
      y.push(attrs.get(r.fare_id)!);
    }
    if (y.length < 3) return null;
    const [board, perKm] = lsq(X1, y);
    console.log(`${feed} fare ≈ $${board.toFixed(2)} + $${perKm.toFixed(3)}/km (${y.length} zone pairs)`);
    return { board, perKm };
  };
  fares.caltrain = zoneFare('caltrain', 'caltrain.zip', (id, raw) => raw.get(id)?.parent_station || id) ?? { board: 4, perKm: 0.09 };
  fares.ggt = zoneFare('ggt', 'ggt.zip', (id) => id) ?? { board: 5, perKm: 0.06 };
  // SMART: $1.50 a zone with Clipper (its GTFS fare table, five zones Larkspur to Windsor)
  fares.smart = zoneFare('smart', 'smart.zip', (id, raw) => raw.get(id)?.parent_station || id) ?? { board: 0, perKm: 0.1 };
  // SF Bay Ferry prices each route (GTFS fare_attributes/fare_rules by route); new ferry lines in
  // scenarios use the board-plus-distance rule in net.ts
  fares.ferry = { board: 5.1, perKm: 0, routes: gtfsRouteFares('ferry.zip') };
  fares.muni = { board: 0, perKm: 0 }; // per-boarding fare set in params (MUNI_FARE)
  // regional buses into the city, from their GTFS fares: AC Transit Transbay, SamTrans
  fares.ac = { board: gtfsRouteFares('ac.zip', 'max').NL ?? 6.5, perKm: 0 };
  fares.samtrans = { board: Object.values(gtfsRouteFares('samtrans.zip'))[0] ?? 2.25, perKm: 0 };
  console.log(`fares: ferry ${JSON.stringify(fares.ferry.routes)}, AC Transbay $${fares.ac.board}, SamTrans $${fares.samtrans.board}`);

  // bus size by route, for routes the observed fleet does not cover (transit.ts gives the others the
  // peak mix of 32-, 40-, and 60-foot buses seen on them; muni-fleet-by-route.json). Muni runs 60-foot
  // buses on its busiest routes: per route, the most frequent direction.
  const fleetRoutes = new Set((read(`${REFERENCE}/muni-fleet-by-route.json`).routes as { route: string }[]).map((r) => r.route));
  const amByRoute = new Map<string, number>();
  for (const l of transit.lines) {
    const k = `${l.feed}:${l.route}:${l.dir}`;
    amByRoute.set(k, (amByRoute.get(k) ?? 0) + ((l.periods as Record<string, { trips: number }>).AM?.trips ?? 0));
  }
  for (const l of transit.lines) {
    if (!['bus', 'rapid', 'trolley', 'express'].includes(l.mode) || l.feed !== 'muni' || fleetRoutes.has(l.route)) continue;
    const best = Math.max(amByRoute.get(`${l.feed}:${l.route}:0`) ?? 0, amByRoute.get(`${l.feed}:${l.route}:1`) ?? 0);
    const long = best >= 30; // a bus every 8 minutes or better in the morning peak
    l.cap = long ? 94 : 63;
    l.seats = long ? 56 : 39;
  }

  // ---------- observed ----------
  const muni = read(`${REFERENCE}/muni-route-ridership.json`);
  const bart = read(`${REFERENCE}/bart-ridership.json`);
  const cal = read(`${REFERENCE}/caltrain-ridership.json`);
  const a1 = acs.residentsCommuteMode_B08301_ACS1yr2024;
  const raw1 = acs.rawTables?.B08301_1yr ?? null;
  void raw1;
  const shareOf = (k: string) => a1.modes[k]?.shareOfCommuters_exclWFH ?? 0;
  const observed: Observed = {
    // the 12-month mean: September alone runs high (schools and universities back in session)
    muniRoutes: muni.routes
      .filter((r: { avgWeekdayBoardings: number | null }) => r.avgWeekdayBoardings)
      .map((r: { route: string; avgWeekdayBoardings: number; avgWeekdayBoardings_last12moMean?: number }) => ({ route: r.route, boardings: Math.round(r.avgWeekdayBoardings_last12moMean ?? r.avgWeekdayBoardings) })),
    muniPeriod: 'Average weekday, October 2025 – September 2026 (SFMTA automatic passenger counts, 12-month mean)',
    muniSystem: muni.systemwide.latestMonthAvgWeekdayBoardings,
    bartStations: bart.stations.map((s: { code: string; name: string; avgWeekdayExits: number; avgWeekdayEntries: number }) => ({ code: s.code, name: s.name, stop: stopIdx.get(`bart:${s.code}`) ?? null, exits: Math.round(s.avgWeekdayExits), entries: Math.round(s.avgWeekdayEntries) })),
    bartPeriod: 'August 2026 average weekday (BART monthly ridership report)',
    caltrainStations: cal.stations.map((s: { name: string; amwrFY2026: number }) => {
      const i = transit.stops.findIndex((t) => t.feed === 'caltrain' && t.name.replace(/ (Caltrain )?Station$/, '').toLowerCase() === s.name.toLowerCase().replace(/ station$/, ''));
      return { name: s.name, stop: i >= 0 ? i : null, boardings: s.amwrFY2026 };
    }),
    caltrainPeriod: 'FY2026 average mid-week (Tue–Thu) boardings, estimated from fare media (Caltrain)',
    acsCommute: { driveAlone: shareOf('driveAlone'), carpool: shareOf('carpool'), transit: shareOf('transit'), walk: shareOf('walk'), bike: shareOf('bike'), taxi: shareOf('taxiRideHailing'), other: shareOf('motorcycle') + shareOf('otherMeans') },
    acsPeriod: 'ACS 2024 1-year, San Francisco residents who commute (excluding working from home)',
    // BATS 2023 unlinked shares for SF residents, linked here (see calibrate.ts for the derivation)
    residentShares: { da: 0.267, sr: 0.218, tnc: 0.026, transit: 0.12, walk: 0.34, bike: 0.029 },
    residentSharesSource: 'BATS 2023 (MTC), San Francisco residents: unlinked trip shares converted to linked trips; car trips split 55/45 driver/passenger (assumed)',
  };
  // weekend counts (SFMTA: twelve-month means of the monthly Saturday/Sunday averages, like the
  // weekday counts; BART: August 2026)
  type MuniRow = { route: string; avgSaturdayBoardings: number | null; avgSundayBoardings: number | null; avgSaturdayBoardings_last12moMean?: number; avgSundayBoardings_last12moMean?: number };
  observed.muniRoutesSat = (muni.routes as MuniRow[]).filter((r) => r.avgSaturdayBoardings).map((r) => ({ route: r.route, boardings: r.avgSaturdayBoardings_last12moMean ?? r.avgSaturdayBoardings! }));
  observed.muniRoutesSun = (muni.routes as MuniRow[]).filter((r) => r.avgSundayBoardings).map((r) => ({ route: r.route, boardings: r.avgSundayBoardings_last12moMean ?? r.avgSundayBoardings! }));
  observed.bartExitsSat = Object.fromEntries(bart.stations.map((s: { code: string; avgSaturdayExits: number }) => [s.code, Math.round(s.avgSaturdayExits)]));
  observed.bartExitsSun = Object.fromEntries(bart.stations.map((s: { code: string; avgSundayExits: number }) => [s.code, Math.round(s.avgSundayExits)]));
  // weekend trip making relative to weekdays (NHTS 2017, SF–Oakland metro; nhts_daytypes.py)
  const nd = read(`${REFERENCE}/nhts-daytypes.json`).byDayType;
  const dayTypes: BundleHeader['dayTypes'] = {};
  for (const [k, key] of [['sat', 'saturday'], ['sun', 'sunday']] as const) {
    const rate: Record<string, number> = {}, tod: Record<string, { share: Record<string, number>; fromHome: Record<string, number> }> = {};
    for (const [p, v] of Object.entries(nd[key]) as [string, { trips_per_person: number; period_share: Record<string, number>; from_home_share: Record<string, number> }][]) {
      rate[p] = +(v.trips_per_person / nd.weekday[p].trips_per_person).toFixed(4);
      tod[p] = { share: v.period_share, fromHome: v.from_home_share };
    }
    dayTypes[k] = { rate, tod };
  }
  console.log(`weekend rates vs weekday: Sat ${JSON.stringify(dayTypes.sat!.rate)}`);
  console.log(`ACS commuter shares: ${JSON.stringify(observed.acsCommute)}`);
  console.log(`Caltrain stations matched: ${observed.caltrainStations.filter((s) => s.stop !== null).length}/${observed.caltrainStations.length}; BART ${observed.bartStations.filter((s) => s.stop !== null).length}/${observed.bartStations.length}`);

  // ---------- arrays ----------
  const blob = (k: string) => {
    const e = sk.index[k];
    const C = { Uint16Array, Float32Array }[e.type as 'Uint16Array' | 'Float32Array'];
    const buf = skBin.buffer.slice(skBin.byteOffset + e.offset, skBin.byteOffset + e.offset + e.length * C.BYTES_PER_ELEMENT);
    return new C(buf);
  };
  const arrays: Record<string, Float32Array | Uint16Array | Int32Array | Uint8Array> = {};
  for (const k of Object.keys(sk.index)) arrays[k] = blob(k);
  arrays.connectors = Int32Array.from((sk.connectors as number[][]).flat());
  arrays.extConnectors = Int32Array.from((sk.extConnectors as number[][]).flat());
  arrays.transfers = Int32Array.from((sk.transfers as number[][]).flat());
  arrays.zonePtStart = ptStart;
  arrays.zonePtX = ptX;
  arrays.zonePtY = ptY;
  arrays.zonePtW = ptW;
  arrays.flowH = Int32Array.from(flowH);
  arrays.flowW = Int32Array.from(flowW);
  arrays.flowN = Float32Array.from(flowN);
  arrays.inE = Int32Array.from(inH);
  arrays.inW = Int32Array.from(inW);
  arrays.inN = Float32Array.from(inN);
  // the synthetic population (synpop.ts), when one has been built: about 1.3 MB gzipped
  const pop = synpopArrays(zones.map((z) => z.id));
  if (pop) Object.assign(arrays, pop);
  else console.warn('no synthetic population in the work folder (synpop.ts): the bundle goes without it');
  // car ownership (shared/beta3/autoown.ts): each zone's household classes (autoown.ts in this
  // folder), and the retail employment its accessibility measures reach outside the city: MTC's 2023
  // land use, each Bay Area zone's RETEMPN given to the nearest outside zone
  if (fs.existsSync(`${WORK}/autoown.json`)) {
    const ao = read(`${WORK}/autoown.json`) as { zones: Record<string, { classes: number[][] }> };
    const rows: number[] = [];
    zones.forEach((z, i) => {
      for (const c of ao.zones[z.id]?.classes ?? []) rows.push(i, ...c);
    });
    arrays.aoClass = Float32Array.from(rows);
    const centroid = new Map<number, [number, number]>();
    for (const r of readShapefile(`${RAW}/mtc/taz1454`)) {
      const ring = r.rings.reduce((a, b) => (b.length > a.length ? b : a), r.rings[0]);
      const n = ring.length;
      centroid.set(Number(r.attrs.TAZ1454), [ring.reduce((a, p) => a + p[1], 0) / n, ring.reduce((a, p) => a + p[0], 0) / n]);
    }
    const lu = fs.readFileSync(`${RAW}/mtc/tm1_TAZ1454_2023_LandUse.csv`, 'utf8').trim().split('\n');
    const h = lu[0].split(',').map((x) => x.replace(/"/g, ''));
    const ci = h.indexOf('COUNTY'), zi = h.indexOf('ZONE'), ri = h.indexOf('RETEMPN');
    for (const x of X) x.retail = 0;
    for (const l of lu.slice(1)) {
      const c = l.split(',');
      if (Number(c[ci]) === 1) continue; // San Francisco: the city zones' own retail jobs
      const ll = centroid.get(Number(c[zi]));
      if (!ll) continue;
      const [px, py] = toXY(ll[0], ll[1]);
      let best = 0, bd = Infinity;
      X.forEach((x, e) => {
        const d = (x.x - px) ** 2 + (x.y - py) ** 2;
        if (d < bd) (bd = d), (best = e);
      });
      X[best].retail! += Number(c[ri]);
    }
    for (const x of X) x.retail = Math.round(x.retail!);
    console.log(`car ownership: ${rows.length / 12} household classes; retail jobs outside the city ${X.reduce((a, x) => a + (x.retail ?? 0), 0).toLocaleString()}`);
  }
  // shared micromobility (micromob-skims.ts), when it has been run
  const micro = microBundleParts();
  if (micro) Object.assign(arrays, micro.arrays as Record<string, Uint16Array>);

  let calibration = null;
  // a variant (backcast) bundle stays in the work folder; it reuses today's calibration
  // BETA3_SF_BUNDLE: write the bundle elsewhere (an experiment's own copy), keeping the app's calibration
  const out = VARIANT ? `${WORK}/sf-${VARIANT}.bin.gz` : process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`;
  if (out !== `${BUNDLE}/sf.bin.gz` && !fs.existsSync(out) && fs.existsSync(`${BUNDLE}/sf.bin.gz`)) calibration = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/sf.bin.gz`))).header.calibration;
  if (VARIANT && fs.existsSync(`${BUNDLE}/sf.bin.gz`)) calibration = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/sf.bin.gz`))).header.calibration;
  if (!VARIANT && !process.argv.includes('--fresh') && fs.existsSync(out)) {
    try {
      calibration = decodeBundle(zlib.gunzipSync(fs.readFileSync(out))).header.calibration;
      if (calibration) console.log('keeping the existing calibration');
    } catch {
      /* rebuild */
    }
  }
  // Muni reliability: expected wait ÷ half the scheduled headway by route and period, measured from
  // realtime arrivals on a weekday (muni-reliability.json); a route without a measurement gets its
  // mode's median. Cable cars are left even (too few of their trips are in the realtime feed).
  {
    const R = read(`${REFERENCE}/muni-reliability.json`);
    const PER: Record<string, TPeriodKey> = { AM: 'AM', MD: 'MD', PM: 'PM', EV: 'NT' };
    const wf = new Map<string, Partial<Record<TPeriodKey, number>>>();
    for (const r of R.routes as { route: string; period: string; waitFactor?: number; waitFactor_excludingSpansOfUnobservedTrips?: number; source: string }[]) {
      const p = PER[r.period.slice(0, 2)];
      const v = r.waitFactor_excludingSpansOfUnobservedTrips ?? r.waitFactor;
      if (!p || v === undefined || !r.source.startsWith('calitp')) continue;
      if (!wf.has(r.route)) wf.set(r.route, {});
      wf.get(r.route)![p] = Math.min(2.5, Math.max(1, v));
    }
    const median = (mode: string, p: TPeriodKey) => {
      const v = transit.lines.filter((l: BLine) => l.feed === 'muni' && l.mode === mode && wf.get(l.route)?.[p]).map((l: BLine) => wf.get(l.route)![p]!).sort((a: number, b: number) => a - b);
      return v.length ? v[v.length >> 1] : 1;
    };
    let n = 0;
    for (const l of transit.lines as BLine[]) {
      if (l.feed !== 'muni' || l.mode === 'cablecar') continue;
      l.waitFactor = {};
      for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriodKey[]) l.waitFactor[p] = +(wf.get(l.route)?.[p] ?? median(l.mode, p)).toFixed(3);
      n++;
    }
    console.log(`reliability: wait factors on ${n} Muni patterns (${wf.size} routes measured)`);
  }
  // Operations as run (muni-operations.json): Muni's running time against the schedule and its share
  // of trips run, by route and period (realtime arrivals, a weekday in June 2026); the day-to-day
  // spread of a ride's running time by route and period (15 weekdays, fall 2025), as a + b × minutes
  // from its group's fit times the route's multiplier; rail's and ferries' mean lateness and spread
  // per ride from their published on-time shares. Other operators' buses take Muni's spread (express
  // buses the express group's); nothing is measured of their timetables' accuracy, so they keep them.
  {
    const O = read(`${REFERENCE}/muni-operations.json`);
    const TP = ['AM', 'MD', 'PM', 'NT'] as TPeriodKey[];
    const run = O.runTime.byRoute as Record<string, Partial<Record<TPeriodKey, { ratio: number }>>>;
    const runG = O.runTime.groupMeans as Record<string, number>;
    const del = O.tripsNotOperated.byRoute as Record<string, Partial<Record<TPeriodKey, { delivered: number }>>>;
    const sdG = O.runTimeVariability.groups as Record<string, { ALL: { a: number; b: number } }>;
    const sdR = O.runTimeVariability.routeMultipliers as Record<string, Partial<Record<TPeriodKey, { multiplier: number }>>>;
    const rail = O.rail as Record<'bart' | 'caltrain' | 'ferry', { meanLateMin: number; sdMin: number }>;
    // the delivered share of a route without its own count: the median route's in that period
    const sysDel: Partial<Record<TPeriodKey, number>> = {};
    for (const p of TP) {
      const v = Object.values(del).map((r) => r[p]?.delivered).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
      sysDel[p] = v.length ? v[v.length >> 1] : 1;
    }
    const group = (l: BLine): string => {
      if (l.feed !== 'muni') return l.mode === 'express' ? 'express' : 'bus';
      if (l.mode === 'lightrail') return l.route === 'T' ? 'T' : 'metro';
      if (l.mode === 'streetcar' || l.mode === 'cablecar') return 'streetcar';
      if (l.mode === 'rapid') return 'rapid';
      if (l.mode === 'express') return 'express';
      return 'bus';
    };
    let nm = 0;
    for (const l of transit.lines as BLine[]) {
      // by mode: SMART (commuter rail) takes Caltrain's figures and Golden Gate's Larkspur and
      // Sausalito boats the ferries' (assumed; neither publishes its own)
      if (l.mode === 'bart' || l.mode === 'caltrain' || l.mode === 'ferry') {
        const r = rail[l.mode];
        l.lateMin = r.meanLateMin;
        l.rideSD = Object.fromEntries(TP.map((p) => [p, { a: r.sdMin, b: 0 }]));
        continue;
      }
      const g = sdG[group(l)]?.ALL ?? sdG.bus.ALL;
      const mult = (p: TPeriodKey) => (l.feed === 'muni' ? (sdR[l.route]?.[p]?.multiplier ?? 1) : 1);
      l.rideSD = Object.fromEntries(TP.map((p) => [p, { a: +(g.a * mult(p)).toFixed(3), b: +(g.b * mult(p)).toFixed(4) }]));
      if (l.feed !== 'muni' || l.mode === 'cablecar') continue;
      l.runFactor = Object.fromEntries(TP.map((p) => [p, run[l.route]?.[p]?.ratio ?? +(runG[`${group(l)}|${p}`] ?? runG[`all|${p}`] ?? 1).toFixed(3)]));
      l.delivered = Object.fromEntries(TP.map((p) => [p, del[l.route]?.[p]?.delivered ?? sysDel[p] ?? 1]));
      nm++;
    }
    console.log(`operations: running times and trips run on ${nm} Muni patterns; ride spread on all lines`);
  }
  // UCSF's shuttles carry UCSF people only (staff, students, patients, visitors; sf-shuttles.json):
  // anyone may board at a UCSF site, since those leaving it are mostly UCSF's, but at a BART, Castro,
  // Japan Center, UC Law, or Rincon Center stop only riders bound for a zone near a UCSF site
  {
    const U = read(`${REFERENCE}/sf-shuttles.json`).modeled.ucsf;
    const campus = new Set((U.stops as { key: string; campus: boolean }[]).filter((s) => s.campus).map((s) => `shuttle:ucsf:${s.key}`));
    const campusStops = transit.stops.flatMap((s, i) => (campus.has(s.id) ? [i] : []));
    const dest = new Set<number>();
    for (const i of campusStops) {
      const st = transit.stops[i];
      let best = 0;
      Zs.forEach((z, k) => {
        if (Math.hypot(z.x - st.x, z.y - st.y) <= U.campusReachMeters) dest.add(k);
        if (Math.hypot(z.x - st.x, z.y - st.y) < Math.hypot(Zs[best].x - st.x, Zs[best].y - st.y)) best = k;
      });
      dest.add(best);
    }
    const destZones = [...dest].sort((a, b) => a - b);
    let n = 0;
    for (const l of transit.lines) if (l.feed === 'shuttle' && l.agency === 'UCSF Shuttles') (l.restrict = { openStops: campusStops.filter((s) => l.stops.includes(s)), destZones }), n++;
    console.log(`UCSF shuttles: ${n} patterns, ${campusStops.length} campus stops, ${destZones.length} zones near a UCSF site`);
    // PresidiGo's pass-only trips: Presidio residents and employees, so likewise riders boarding
    // downtown must be bound for the Presidio
    const P = read(`${REFERENCE}/sf-shuttles.json`).modeled.presidiGo;
    const pStops = transit.stops.flatMap((s, i) => ((P.openStops as string[]).some((k) => s.id === `shuttle:pg:${k}`) ? [i] : []));
    const pDest = new Set<number>();
    for (const i of pStops) {
      const st = transit.stops[i];
      const d = (z: { x: number; y: number }) => Math.hypot(z.x - st.x, z.y - st.y);
      Zs.forEach((z, k) => d(z) <= U.campusReachMeters && pDest.add(k));
      pDest.add(Zs.reduce((bi, z, k) => (d(z) < d(Zs[bi]) ? k : bi), 0));
    }
    const pr = { openStops: pStops, destZones: [...pDest].sort((a, b) => a - b) };
    for (const l of transit.lines) if (l.feed === 'shuttle' && l.route === 'PresidiGo DT pass') l.restrict = pr;
    console.log(`PresidiGo pass trips: ${pr.destZones.length} Presidio zones`);
  }
  // the free shuttles (Mission Bay TMA, UCSF, PresidiGo) charge nothing; the Treasure Island Ferry $5
  fares.tma = { board: 0, perKm: 0 };
  fares.shuttle = { board: 0, perKm: 0, routes: { 'TI Ferry': 5 } };
  // background riders on BART and Caltrain (trips with no end in the city; background.ts), matched to
  // patterns by id and stops so that a pattern whose stops changed starts without them
  if (fs.existsSync(`${REFERENCE}/background-loads.json`)) {
    const bg = read(`${REFERENCE}/background-loads.json`);
    const byId = new Map<string, { stops: string[]; bg: BLine['bg'] }>((bg.lines as { id: string; stops: string[]; bg: BLine['bg'] }[]).map((x) => [x.id, x]));
    let n = 0;
    for (const l of transit.lines as BLine[]) {
      const x = byId.get(l.id);
      if (x && x.stops.join() === l.stops.map((s: number) => transit.stops[s].id).join()) (l.bg = x.bg), n++;
    }
    console.log(`background riders on ${n} of ${byId.size} patterns`);
  }
  const header: Omit<BundleHeader, 'arrays'> = {
    version: 1,
    built: new Date().toISOString(),
    sources: [
      'U.S. Census Bureau: 2020 Census blocks (TIGERweb), ACS 2020–24 5-year and 2024 1-year, LEHD LODES 2023',
      'OpenStreetMap contributors (streets, schools, hotels, attractions), © OpenStreetMap, ODbL',
      'Terrain Tiles on AWS (USGS 3DEP elevation)',
      'GTFS schedules: SFMTA (Muni), BART, Caltrain, Golden Gate Transit, San Francisco Bay Ferry, AC Transit, SamTrans, Mission Bay TMA, PresidiGo; UCSF shuttle timetables',
      'MTC Travel Model One / Two parameters; NHTS 2017; BATS 2023',
      'Synthetic population: ACS 2020–24 5-year PUMS, balanced to ACS 2020–24 block-group and tract tables and 2020 census group quarters (P.L. 94-171)',
      'Observed: SFMTA ridership by route, BART monthly ridership, Caltrain annual ridership, ACS commute',
    ],
    zones, ext: X, stops: transit.stops, lines: transit.lines, fares, gateways: sk.gateways, observed, dayTypes, calibration,
    lots: ((sk.lots ?? []) as [number, number, number][]).map(([stop, spaces, fee]) => ({ stop, spaces, fee })),
    // special events (built by events.ts)
    events: read(`${REFERENCE}/special-events.json`).model,
    ...(micro ? { micro: micro.header } : {}),
  };
  const bin = encodeBundle(header, arrays);
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.mkdirSync(BUNDLE, { recursive: true });
  fs.writeFileSync(out, gz);
  console.log(`bundle ${(bin.length / 1e6).toFixed(1)} MB → ${(gz.length / 1e6).toFixed(1)} MB gzipped`);
  console.timeEnd('build');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
