/**
 * Facts for the methodology article (/beta3/method) that live in the model bundle or in pipeline
 * source rather than in a JSON file the page can import: counts, the fitted calibration, fare fits,
 * fitted driving-speed parameters, feed service dates and the calibration targets. The article
 * reads client/beta3/paper/facts.json, so every figure it prints comes from a file.
 *
 * Re-run after model:build or model:calibrate:
 *   NODE_OPTIONS=--max-old-space-size=2048 npx tsx client/beta3/paper/export-facts.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { EXT_CONNECTOR_FIELDS } from '../../../shared/beta3/net';
import { residentLinkedShares, residentLinkedTrips } from '../../../server/beta3/pipeline/resident-targets';
import { lengthTargets } from '../../../server/beta3/pipeline/trip-lengths';
import { visitorTarget } from '../../../server/beta3/pipeline/visitor-target';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const PIPE = path.join(ROOT, 'server/beta3/pipeline');
const RAW = process.env.BETA3_RAW ?? path.join(ROOT, 'data/beta3/raw');
const src = (f: string) => fs.readFileSync(path.join(PIPE, f), 'utf8');

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`export-facts: could not read ${what}`);
  return v;
}
/** a flat object literal `{ a: 1, b: 2 + 3 }` → numbers */
function literal(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/([A-Za-z_][\w]*|'[^']+')\s*:\s*([-\d.+\s*]+?)(?=,|$)/g)) {
    const k = m[1].replace(/'/g, '');
    out[k] = m[2].split('+').reduce((a, x) => a + Number(x.trim()), 0);
  }
  return out;
}
const constNum = (text: string, name: string) => Number(need(new RegExp(`const ${name} = ([\\d.]+)`).exec(text), name)[1]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refJson = (f: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, 'server/beta3/reference', f), 'utf8'));
const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

async function main() {
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'client/beta3/model/sf.bin.gz')));
  const b = decodeBundle(raw);
  const H = b.header;
  const C = need(H.calibration, 'bundle calibration');
  const A = b.a;

  // ---- counts and totals ----
  const byFeed: Record<string, { patterns: number; routes: number }> = {};
  const routeSet = new Map<string, Set<string>>();
  for (const l of H.lines) {
    byFeed[l.feed] ??= { patterns: 0, routes: 0 };
    byFeed[l.feed].patterns++;
    if (!routeSet.has(l.feed)) routeSet.set(l.feed, new Set());
    routeSet.get(l.feed)!.add(l.route);
  }
  for (const [f, s] of routeSet) byFeed[f].routes = s.size;
  const byMode: Record<string, number> = {};
  for (const l of H.lines) byMode[l.mode] = (byMode[l.mode] ?? 0) + 1;
  const sum = (f: (z: (typeof H.zones)[number]) => number) => H.zones.reduce((a, z) => a + f(z), 0);
  const hhVeh = [0, 1, 2].map((k) => sum((z) => z.hhVeh[k]));
  const jobsByArea = [0, 1, 2, 3].map((t) => H.zones.filter((z) => z.areaType === t).reduce((a, z) => a + z.jobs, 0));
  const zonesByArea = [0, 1, 2, 3].map((t) => H.zones.filter((z) => z.areaType === t).length);
  const pop = sum((z) => z.pop);
  const workers = sum((z) => z.workers);
  const wfhWeighted = sum((z) => z.workers * z.wfh) / workers;
  const extCounties = new Set(H.ext.map((e) => e.county)).size;
  const extSplit = H.ext.filter((e) => /#\d+$/.test(e.id)).length;

  // ---- LODES jobs before rebalancing (raw WAC, if downloaded) ----
  let lodesJobs: number | null = null;
  const lodesByBg = new Map<string, number>();
  const wac = path.join(RAW, 'lodes/ca_wac_S000_JT00_2023.csv.gz');
  if (fs.existsSync(wac)) {
    lodesJobs = 0;
    let head: string[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(wac).pipe(zlib.createGunzip()) });
    for await (const line of rl) {
      if (!head.length) {
        head = line.split(',');
        continue;
      }
      if (!line.startsWith('06075')) continue;
      const c = line.split(',');
      const n = Number(c[head.indexOf('C000')]);
      lodesJobs += n;
      lodesByBg.set(c[0].slice(0, 12), (lodesByBg.get(c[0].slice(0, 12)) ?? 0) + n);
    }
  }

  // jobs taken out of block groups where LODES had more than the rebalanced total (a lower bound on jobs moved)
  const jobsMovedOut = lodesJobs === null ? null : H.zones.reduce((a, z) => a + Math.max(0, (lodesByBg.get(z.id) ?? 0) - z.jobs), 0);

  // ---- parks ----
  const rpdFile = path.join(RAW, 'rpd_parks.json');
  const rpd = fs.existsSync(rpdFile) ? (JSON.parse(fs.readFileSync(rpdFile, 'utf8')) as { acres?: string | number }[]) : null;
  const demandSrc = fs.readFileSync(path.join(ROOT, 'shared/beta3/demand.ts'), 'utf8');
  // destination size per park acre by purpose, relative to the calibrated pull (demand.ts PARK_SIZE)
  const parkSize = literal(/export const PARK_SIZE[^=]*= \{([^}]*)\}/.exec(demandSrc)?.[1] ?? '');
  const parkW = (k: string) => parkSize[k] ?? null;
  const parkAcres = H.zones.map((z) => (z as { parkAcres?: number }).parkAcres ?? 0);
  const parks = {
    rpdProperties: rpd?.length ?? null,
    rpdAcres: rpd ? rpd.reduce((a, r) => a + (Number(r.acres) || 0), 0) : null,
    acresInZones: parkAcres.reduce((a, v) => a + v, 0),
    zonesWithPark: parkAcres.filter((v) => v > 0.5).length,
    weights: { social: parkW('social'), visitor: parkW('visitor'), regional: parkW('regional') },
  };

  // ---- BART fare fit: bundle fares against the GTFS fare table ----
  let bartFare: Record<string, number> | null = null;
  const bz = path.join(RAW, 'gtfs/bart.zip');
  if (fs.existsSync(bz) && H.fares.bart?.hops) {
    const files = unzipSync(fs.readFileSync(bz));
    const csv = (t: string) => {
      const [h, ...rows] = t.replace(/^﻿/, '').trim().split(/\r?\n/);
      const k = h.split(',');
      return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [k[i], v])));
    };
    const price = new Map(csv(strFromU8(files['fare_attributes.txt'])).map((r) => [r.fare_id, Number(r.price)]));
    const rules = csv(strFromU8(files['fare_rules.txt']));
    const idx = new Map(H.stops.map((s, i) => [s.id, i]));
    const adj = new Map<number, Map<number, number>>();
    for (const l of H.lines.filter((l) => l.feed === 'bart'))
      for (let k = 0; k + 1 < l.stops.length; k++) {
        const a = l.stops[k], c = l.stops[k + 1];
        const km = Math.hypot(H.stops[a].x - H.stops[c].x, H.stops[a].y - H.stops[c].y);
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.has(c)) adj.set(c, new Map());
        adj.get(a)!.set(c, km);
        adj.get(c)!.set(a, km);
      }
    const hop = new Map<string, number>();
    for (const h of H.fares.bart.hops) hop.set(`${Math.min(h.a, h.b)}-${Math.max(h.a, h.b)}`, h.fare);
    const fareOf = (from: number, to: number) => {
      const dist = new Map([[from, 0]]), prev = new Map<number, number>(), open = new Set([from]);
      while (open.size) {
        let u = -1, du = Infinity;
        for (const v of open) if (dist.get(v)! < du) (du = dist.get(v)!), (u = v);
        open.delete(u);
        if (u === to) break;
        for (const [v, km] of adj.get(u) ?? []) if (du + km < (dist.get(v) ?? Infinity)) dist.set(v, du + km), prev.set(v, u), open.add(v);
      }
      if (!prev.has(to)) return null;
      let f = H.fares.bart.board;
      for (let v = to; v !== from; v = prev.get(v)!) f += hop.get(`${Math.min(prev.get(v)!, v)}-${Math.max(prev.get(v)!, v)}`) ?? 0;
      return f;
    };
    const err: number[] = [];
    for (const r of rules) {
      const a = idx.get(`bart:${r.origin_id}`), c = idx.get(`bart:${r.destination_id}`);
      if (a === undefined || c === undefined || a === c || !adj.has(a) || !adj.has(c)) continue;
      const f = fareOf(a, c);
      if (f !== null && price.has(r.fare_id)) err.push(f - price.get(r.fare_id)!);
    }
    const abs = err.map(Math.abs).sort((x, y) => x - y);
    bartFare = {
      pairs: err.length,
      board: H.fares.bart.board,
      segments: H.fares.bart.hops.length,
      mae: abs.reduce((a, v) => a + v, 0) / abs.length,
      rmse: Math.sqrt(err.reduce((a, v) => a + v * v, 0) / err.length),
      p90: abs[Math.floor(0.9 * abs.length)],
      minFare: Math.min(...rules.map((r) => price.get(r.fare_id) ?? Infinity)),
    };
  }

  // ---- BART: how much of each counted segment load is trips with neither end at the 9 city-area stations ----
  // (validate.ts compares segment loads routed from every station pair; the model only carries trips with an end in the city)
  const bartRef = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/beta3/reference/bart-ridership.json'), 'utf8'));
  const SF_CODES = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB', 'DALY'];
  const SEGS = [['WOAK', 'EMBR'], ['EMBR', 'MONT'], ['MONT', 'POWL'], ['POWL', 'CIVC'], ['CIVC', '16TH'], ['16TH', '24TH'], ['24TH', 'GLEN'], ['GLEN', 'BALB'], ['BALB', 'DALY']];
  const bartThrough: { a: string; b: string; all: number; through: number }[] = [];
  {
    const sIdx = (c: string) => H.stops.findIndex((s) => s.id === `bart:${c}`);
    const adj = new Map<number, Map<number, number>>();
    for (const l of H.lines.filter((l) => l.feed === 'bart'))
      for (let k = 0; k + 1 < l.stops.length; k++) {
        const a = l.stops[k], c = l.stops[k + 1];
        const km = Math.hypot(H.stops[a].x - H.stops[c].x, H.stops[a].y - H.stops[c].y);
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.has(c)) adj.set(c, new Map());
        adj.get(a)!.set(c, km);
        adj.get(c)!.set(a, km);
      }
    const key = (a: number, c: number) => (a < c ? `${a}-${c}` : `${c}-${a}`);
    const all = new Map<string, number>(), thr = new Map<string, number>();
    const codes: string[] = bartRef.od.codes;
    const M: number[][] = bartRef.od.matrix;
    codes.forEach((o, i) =>
      codes.forEach((d, j) => {
        const n = M[i]?.[j] ?? 0;
        if (!n || i === j) return;
        const a = sIdx(o), c = sIdx(d);
        if (a < 0 || c < 0) return;
        const dist = new Map([[a, 0]]), prev = new Map<number, number>(), open = new Set([a]);
        while (open.size) {
          let u = -1, du = Infinity;
          for (const v of open) if (dist.get(v)! < du) (du = dist.get(v)!), (u = v);
          open.delete(u);
          if (u === c) break;
          for (const [v, km] of adj.get(u) ?? []) if (du + km < (dist.get(v) ?? Infinity)) dist.set(v, du + km), prev.set(v, u), open.add(v);
        }
        const through = !SF_CODES.includes(o) && !SF_CODES.includes(d);
        for (let v = c; v !== a && prev.has(v); v = prev.get(v)!) {
          const k = key(prev.get(v)!, v);
          all.set(k, (all.get(k) ?? 0) + n);
          if (through) thr.set(k, (thr.get(k) ?? 0) + n);
        }
      }),
    );
    for (const [x, y] of SEGS) {
      const k = key(sIdx(x), sIdx(y));
      bartThrough.push({ a: x, b: y, all: Math.round(all.get(k) ?? 0), through: Math.round(thr.get(k) ?? 0) });
    }
  }

  // ---- the street network (work files from streets.ts and diag-walk.ts, if built here) ----
  let streets: Record<string, number> | null = null;
  let streetJoins: Record<string, number> | null = null;
  const WORK = process.env.BETA3_WORK ?? path.join(ROOT, 'data/beta3/work');
  const sj = path.join(WORK, 'streets.json');
  if (fs.existsSync(sj)) {
    const g = JSON.parse(fs.readFileSync(sj, 'utf8')) as { vertices: unknown[]; edges: { len: number; car: boolean; walk: boolean; bike: boolean; bikeway: boolean; steps: boolean; made?: string }[]; stats?: Record<string, number> };
    streetJoins = g.stats ?? null;
    const km = (f: (e: (typeof g.edges)[number]) => boolean) => g.edges.filter(f).reduce((a, e) => a + e.len, 0) / 1000;
    streets = { vertices: g.vertices.length, edges: g.edges.length, kmCar: km((e) => e.car), kmWalk: km((e) => e.walk), kmBike: km((e) => e.bike), kmBikeway: km((e) => e.bikeway), steps: g.edges.filter((e) => e.steps).length, kmSteps: km((e) => e.steps) };
  }
  // the walk network's checks (diag-walk.ts): joins made, pieces, circuity, known walks, before and after
  const dw = path.join(WORK, 'diag-walk.json');
  const dwb = path.join(WORK, 'diag-walk-before.json');
  const slim = (f: string) => {
    if (!fs.existsSync(f)) return null;
    const { badBlocks: _, ...rest } = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...rest, hot: rest.hot.slice(0, 12) };
  };
  // the network as built before the walkways were joined (kept by hand from the earlier build)
  const walkNet = { now: slim(dw), before: slim(dwb) };
  const walkSrc = src('walk.ts'), streetsSrc = src('streets.ts');
  const walkRules = {
    nearMissM: constNum(streetsSrc, 'NEAR_MISS'),
    stepRiseM: constNum(streetsSrc, 'STEP_RISE'),
    stair: literal(need(/export const STAIR = \{([^}]*)\}/.exec(walkSrc), 'STAIR')[1]),
  };

  // ---- pipeline constants (read from source so the article follows the code) ----
  const skims = src('skims.ts');
  const autoBody = need(/export const AUTO = \{([\s\S]*?)\n\};/.exec(skims), 'AUTO')[1];
  const shareOf = (t: string) => literal(need(new RegExp(`${t}: \\{([^}]*)\\}`).exec(need(/speedShare: \{([\s\S]*?)\}\s*as/.exec(autoBody), 'speedShare')[1]), t)[1]);
  const delayBody = need(/delay: \{([\s\S]*?)\} as/.exec(autoBody), 'delay')[1];
  const delayOf = (t: string) => literal(need(new RegExp(`${t}: \\{([^}]*)\\}`).exec(delayBody), `delay ${t}`)[1]);
  const gateways = [...skims.matchAll(/\{ name: '([^']+)'[^\n]*?toll: ([\d.]+), delayIn: \{([^}]*)\}, delayOut: \{([^}]*)\}/g)].map((m) => ({ name: m[1], toll: Number(m[2]), delayIn: literal(m[3]), delayOut: literal(m[4]) }));
  const regional = literal(need(/speed: \{([^}]*)\}/.exec(need(/const REGIONAL = ([^\n]*)/.exec(skims), 'REGIONAL')[1]), 'regional speed')[1]);
  const transit = src('transit.ts');
  const feeds = [...need(/const FEEDS_TODAY: Feed\[\] = \[([\s\S]*?)\n\];/.exec(transit), 'FEEDS_TODAY')[1].matchAll(/key: '(\w+)', agency: '([^']+)'[^\n]*?date: '(\d+)', sat: '(\d+)', sun: '(\d+)'/g)].map((m) => ({ key: m[1], agency: m[2], wkd: m[3], sat: m[4], sun: m[5] }));
  const backcastFeed = need(/file: 'muni-2024\.zip', date: '(\d+)', sat: '(\d+)', sun: '(\d+)'/.exec(transit), 'backcast feed');
  const zonesSrc = src('zones.ts');
  const src_build = src('build.ts');
  const calib = src('calibrate.ts');
  const b08141 = need(/const B08141_2024 = \{([\s\S]*?)\n\};/.exec(calib), 'B08141_2024')[1];
  const seg = (k: string) => literal(need(new RegExp(`${k}: \\{([^}]*)\\}`).exec(b08141), k)[1]);
  const target = (name: string) => literal(need(new RegExp(`const ${name}[^=]*= norm\\(\\{([^}]*)\\}\\)`).exec(calib), name)[1]);
  const extTarget = literal(need(/WORK_TARGET\.ext = norm\(\{([^}]*)\}\)/.exec(calib), 'ext target')[1]);
  // distance targets (NHTS 2017 tours and trips, and the assumed ones) and the stop detours by tour mode
  // and the shares of half a mile or less (trip-lengths.ts)
  const LT = lengthTargets();
  const tripKm = LT.meanKm as Record<string, number>;
  const stopKm = LT.stopKm;
  // residents' linked mode shares (BATS 2023) and their linked trips a weekday, as calibrate.ts derives them
  const residentAll = residentLinkedShares(refJson('sf-mode-by-area.json')) as Record<string, number>;
  const residentTrips = residentLinkedTrips(refJson('sf-mode-share.json').bats2023_sfResidents_allTrips_unlinked, residentAll);
  // commute transit shares across the city line by county (ACS 2020–24 microdata), counties with 3,000+ commuters
  const countyTarget = (() => {
    const j = refJson('commute-by-county.json');
    const minCommuters = Number(need(/r\.total - r\.wfh >= (\d+)/.exec(calib), 'county minimum')[1]);
    const pick = (o: Record<string, { total: number; wfh: number; transit: number }>) =>
      Object.fromEntries(Object.entries(o).filter(([c, r]) => c !== 'San Francisco' && !/^other|^outside/.test(c) && r.total - r.wfh >= minCommuters).map(([c, r]) => [c, { share: r.transit / (r.total - r.wfh), commuters: r.total - r.wfh }]));
    return { minCommuters, in: pick(j.toSF), out: pick(j.fromSF) };
  })();
  // ferry commuter routes calibrated in total (calibrate.ts FERRY_ROUTES)
  const ferryRoutes = [...need(/const FERRY_ROUTES = new Set\(\[([^\]]*)\]\)/.exec(calib), 'FERRY_ROUTES')[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const ferryFloor = Number(need(/calib\.ivtFactor\.ferry = Math\.max\(([\d.]+)/.exec(calib), 'ferry floor')[1]);
  // how each in-vehicle time factor is fitted: its starting value (TM1's), lower bound, and the power
  // on the ratio of modeled to counted boardings (left out if the rule changes form)
  const ivtFit = Object.fromEntries(
    ['caltrain', 'ferry', 'lightrail'].flatMap((k) => {
      const m = new RegExp(`calib\\.ivtFactor\\.${k} = Math\\.max\\(([\\d.]+), Math\\.min\\(([\\d.]+), \\(calib\\.ivtFactor\\.${k} \\?\\? ([\\d.]+)\\) \\* (?:\\([^)]*\\)|\\w+) \\*\\* ([\\d.]+)\\)\\)`).exec(calib);
      return m ? [[k, { floor: Number(m[1]), ceil: Number(m[2]), start: Number(m[3]), power: Number(m[4]) }]] : [];
    }),
  );
  // parks with counted visits (calibrate.ts PARK_TARGETS), per weekday as calibrate.ts converts them
  const parkTargets = (() => {
    const pv = refJson('park-visitation.json');
    const day = need(/const perWeekday = \(y: number\) => y \/ 365 \/ ([\d.]+);/.exec(calib), 'park weekday factor');
    const annual = (re: RegExp) => (pv.parks as { name: string; annualVisits: number | null }[]).find((p) => re.test(p.name) && p.annualVisits)?.annualVisits ?? null;
    const museums = (pv.attractions as { name: string; annualVisits?: number }[]).filter((a) => /Academy|de Young|Conservatory|Tea Garden|Botanical/.test(a.name)).reduce((s, a) => s + (a.annualVisits ?? 0), 0);
    return [...calib.matchAll(/\{ name: '([^']+)', acres: (\d+), perWeekday: ([^,]+), own: (true|false), fit: ([\d.]+) \}/g)].map((m) => {
      const pw = /perWeekday\(annual\(\/\^([^$/]+)(\$?)\/\)( - museums)?\)/.exec(m[3]);
      const a = pw ? annual(new RegExp(`^${pw[1]}${pw[2]}`)) : null;
      return {
        name: m[1],
        acres: Number(m[2]),
        annual: a,
        lessMuseums: pw?.[3] ? museums : 0,
        perWeekday: pw ? (a === null ? null : (a - (pw[3] ? museums : 0)) / 365 / Number(day[1])) : Number(m[3]),
        own: m[4] === 'true',
        fitWeight: Number(m[5]),
      };
    });
  })();

  // ---- calibration results the report recorded ----
  const rep = C.report;
  const workLine = rep.find((l) => l.startsWith('work by segment:')) ?? '';
  const workModel: Record<string, Record<string, number>> = {};
  for (const part of workLine.replace('work by segment:', '').split('|')) {
    const m = /(\w+):\s*(.*)/.exec(part.trim());
    if (!m) continue;
    const o: Record<string, number> = {};
    for (const mm of m[2].matchAll(/(\w+) ([\d.]+)/g)) o[mm[1]] = Number(mm[2]) / 100;
    workModel[m[1]] = o;
  }
  const kmLine = rep.find((l) => l.startsWith('mean km:')) ?? '';
  const meanKm: Record<string, number> = {};
  for (const mm of kmLine.split(';')[0].matchAll(/([\w:]+) ([\d.]+)/g)) meanKm[mm[1]] = Number(mm[2]);
  // the fitted lengths (calibrations since October 2026): means of trips up to 5 miles, shares within half a mile
  const km5Line = rep.find((l) => l.startsWith('mean km up to 5 mi:')) ?? '';
  const meanKm5: Record<string, number> = {};
  for (const mm of km5Line.matchAll(/([\w:]+) ([\d.]+)/g)) meanKm5[mm[1]] = Number(mm[2]);
  const nearLine = rep.find((l) => l.startsWith('within half a mile:')) ?? '';
  const nearShare: Record<string, number> = {};
  for (const mm of nearLine.matchAll(/([\w:]+) ([\d.]+)%/g)) nearShare[mm[1]] = Number(mm[2]) / 100;
  const nh = Object.values(C.nhoodTransit ?? {});
  const nhMean = nh.reduce((a, v) => a + v, 0) / Math.max(1, nh.length);

  // ---- reliability (bundle wait factors, and what was measured: muni-reliability.json as build.ts reads it) ----
  const reliability = (() => {
    const R = refJson('muni-reliability.json');
    const src = (R.sources as { id: string; dataPeriod?: string }[]).find((x) => x.id.startsWith('calitp_stop_time_metrics'));
    const measured = new Set((R.routes as { route: string; source: string; waitFactor?: number }[]).filter((r) => r.source.startsWith('calitp') && r.waitFactor !== undefined).map((r) => r.route));
    const muniLines = H.lines.filter((l) => l.feed === 'muni' && l.mode !== 'cablecar' && l.waitFactor);
    const cable = new Set(H.lines.filter((l) => l.mode === 'cablecar').map((l) => l.route));
    const byRoute = (p: 'AM' | 'MD' | 'PM' | 'NT') => {
      const m = new Map<string, number>();
      for (const l of muniLines) if (l.waitFactor?.[p] !== undefined && measured.has(l.route)) m.set(l.route, l.waitFactor[p]!);
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    const am = byRoute('AM');
    return {
      day: src?.dataPeriod?.slice(0, 10) ?? null,
      routesMeasured: [...measured].filter((r) => !cable.has(r)).length,
      patterns: muniLines.length,
      median: Object.fromEntries((['AM', 'MD', 'PM', 'NT'] as const).map((p) => [p, median(byRoute(p).map(([, v]) => v))])),
      highestAM: am.slice(0, 3).map(([route, v]) => ({ route, v })),
      lowestAM: am.slice(-3).reverse().map(([route, v]) => ({ route, v })),
      bounds: (() => {
        const m = /Math\.min\(([\d.]+), Math\.max\(([\d.]+), v\)\)/.exec(src_build);
        return m ? [Number(m[2]), Number(m[1])] : null;
      })(),
    };
  })();
  // ---- operations as run (muni-operations.json, as build.ts reads it) ----
  const operations = (() => {
    const O = refJson('muni-operations.json');
    const gm = O.runTime.groupMeans as Record<string, number>;
    const byRoute = O.runTime.byRoute as Record<string, Record<string, { ratio: number; schedHoursObserved: number }>>;
    // routes the model scales (cable cars keep their timetable), each route's largest departure once
    const best = new Map<string, { route: string; period: string; ratio: number }>();
    for (const [r, ps] of Object.entries(byRoute)) {
      if (['CA', 'PH', 'PM'].includes(r)) continue;
      for (const [p, v] of Object.entries(ps)) {
        if (v.schedHoursObserved < 8) continue;
        const cur = best.get(r);
        if (!cur || Math.abs(v.ratio - 1) > Math.abs(cur.ratio - 1)) best.set(r, { route: r, period: p, ratio: v.ratio });
      }
    }
    const big = [...best.values()].sort((a, b) => b.ratio - a.ratio);
    const del = O.tripsNotOperated.byRoute as Record<string, Record<string, { delivered: number }>>;
    const lost = Object.values(del).flatMap((ps) => Object.values(ps).map((v) => 1 - v.delivered)).sort((a, b) => a - b);
    const G = O.runTimeVariability.groups as Record<string, { ALL: { a: number; b: number; points: { min: number; sd: number }[] } }>;
    const mult = O.runTimeVariability.routeMultipliers as Record<string, Record<string, { multiplier: number }>>;
    const mean = (r: string) => {
      const v = Object.values(mult[r] ?? {}).map((x) => x.multiplier);
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
    };
    const ranked = Object.keys(mult).filter((r) => Object.keys(mult[r]).length === 4).map((r) => ({ route: r, m: mean(r)! })).sort((a, b) => b.m - a.m);
    const P = O.predictions;
    const busP = P.byGroup.bus.ALL as Record<string, { sd: number; robustSD: number; mean: number }>;
    return {
      runRatio: { all: gm['all|AM'] !== undefined ? Object.fromEntries(['AM', 'MD', 'PM', 'NT'].map((p) => [p, gm[`all|${p}`]])) : null, metro: Object.fromEntries(['AM', 'MD', 'PM', 'NT'].map((p) => [p, gm[`metro|${p}`]])), slowest: big.filter((x) => x.ratio > 1).slice(0, 3), fastest: big.filter((x) => x.ratio < 1).slice(-3).reverse() },
      notRun: { day: O.tripsNotOperated['systemwideNotSeenShare2026-06-10'], sfmta12m: 1 - 0.98658, medianRoute: lost[lost.length >> 1], p90Route: lost[Math.floor(0.9 * lost.length)] },
      sd: Object.fromEntries(Object.entries(G).map(([g, v]) => [g, { a: v.ALL.a, b: v.ALL.b, points: v.ALL.points }])),
      leastReliable: ranked.slice(0, 3), mostReliable: ranked.slice(-3).reverse(),
      rail: O.rail,
      predictions: { sd10: busP['10'].sd, rsd10: busP['10'].robustSD, bias10: busP['10'].mean, sd20: busP['20'].sd, sd5: busP['5'].sd, retained: P.informationRetained.value, consulting: P.shareConsulting.value, informedShare: P.informedShare },
      rr: O.reliabilityRatio.value,
    };
  })();
  // ---- how much straight stop-to-stop hops shorten Muni routes: shape length over straight length,
  // weighted by scheduled weekday trips (the model measures ride distance along straight hops) ----
  const shapeRatio = (() => {
    const R = 6371000, rad = Math.PI / 180;
    const dist = (la1: number, lo1: number, la2: number, lo2: number) => R * Math.hypot((lo2 - lo1) * rad * Math.cos(((la1 + la2) / 2) * rad), (la2 - la1) * rad);
    const acc: Record<'bus' | 'metro', [number, number]> = { bus: [0, 0], metro: [0, 0] };
    for (const l of H.lines) {
      if (l.feed !== 'muni' || !l.path?.length || !l.stopAt?.length) continue;
      const cls = l.mode === 'lightrail' ? 'metro' : ['bus', 'rapid', 'trolley'].includes(l.mode) ? 'bus' : null;
      if (!cls) continue;
      const trips = Object.values(l.periods).reduce((a, p) => a + (p?.trips ?? 0), 0);
      for (let k = 0; k + 1 < l.stopAt.length; k++) {
        for (let i = l.stopAt[k]; i < l.stopAt[k + 1]; i++) acc[cls][0] += trips * dist(l.path[2 * i], l.path[2 * i + 1], l.path[2 * i + 2], l.path[2 * i + 3]);
        const s0 = H.stops[l.stops[k]], s1 = H.stops[l.stops[k + 1]];
        acc[cls][1] += trips * dist(s0.lat, s0.lon, s1.lat, s1.lon);
      }
    }
    return acc.bus[1] > 0 && acc.metro[1] > 0 ? { bus: acc.bus[0] / acc.bus[1], metro: acc.metro[0] / acc.metro[1] } : null;
  })();
  // ---- night service: patterns with trips at night but none leaving 7pm–midnight (owl-only) ----
  const nightTrips = (l: (typeof H.lines)[number]) => ['EV', 'EA'].reduce((a, k) => a + ((l.periods as Record<string, { trips: number } | undefined>)[k]?.trips ?? 0), 0);
  const night = {
    owlOnlyPatterns: H.lines.filter((l) => l.evening && (l.evening.wkd ?? 0) === 0 && nightTrips(l) > 0).length,
    patternsWithEvening: H.lines.filter((l) => l.evening !== undefined).length,
  };
  // ---- schools (sf-schools.json, as build.ts places them) ----
  const schools = (() => {
    const S = refJson('sf-schools.json');
    const rows = S.schools as { enrollment: number | null; lat: number | null; lon: number | null; nontraditional?: boolean }[];
    const used = rows.filter((x) => x.enrollment && x.lat != null && x.lon != null && !x.nontraditional);
    const noCoords = rows.filter((x) => x.enrollment && (x.lat == null || x.lon == null));
    return {
      records: rows.length,
      placed: used.length,
      pupilsPlaced: used.reduce((a, x) => a + (x.enrollment ?? 0), 0),
      withoutCoords: noCoords.length,
      pupilsWithoutCoords: noCoords.reduce((a, x) => a + (x.enrollment ?? 0), 0),
      nontraditional: rows.filter((x) => x.nontraditional).length,
      pupilsInZones: H.zones.reduce((a, z) => a + (z.schoolEnroll ?? 0), 0),
      seniorParticipants: S.seniorsFares?.freeMuniSeniorsAndDisabled?.participantsFY24_25 ?? null,
      seniorShare: S.seniorsFares?.freeMuniSeniorsAndDisabled?.seniorShareOfParticipants ?? null,
    };
  })();
  // ---- private commuter shuttles (commuter-shuttles.json; shuttle reach from build.ts) ----
  const shuttles = (() => {
    const J = refJson('commuter-shuttles.json');
    const reachM = Number(need(/Math\.hypot\(s\.x - p\.x, s\.y - p\.y\) <= (\d+)/.exec(src_build), 'shuttle reach')[1]);
    return {
      approvedStops: (J.approvedStops?.stops ?? []).length,
      regional2017: J.headline?.preCOVIDRidership?.regionalShuttleBoardings_Dec2017 ?? null,
      reachM,
      residentsInReach: H.zones.reduce((a, z) => a + z.pop * (z.shuttleReach ?? 0), 0),
    };
  })();
  // ---- park-and-ride (station-parking.json, with the selection rules of skims.ts) ----
  const parking = (() => {
    const P = refJson('station-parking.json');
    const bart = (P.bart.stations as { inSanFrancisco?: boolean; noBartParking?: boolean; spaces_bartGIS?: number; fee_dailyUSD?: number | null }[]).filter((b) => !b.inSanFrancisco && !b.noBartParking && ((b.spaces_bartGIS ?? 0) > 0 || b.fee_dailyUSD != null));
    const noLot = (P.bart.stations as { inSanFrancisco?: boolean; noBartParking?: boolean; name: string }[]).filter((b) => !b.inSanFrancisco && b.noBartParking).map((b) => b.name);
    const caltrain = (P.caltrain.stations as { inSanFrancisco?: boolean; spaces?: number | null; fee_dailyUSD?: number | null }[]).filter((c) => !c.inSanFrancisco && ((c.spaces ?? 0) > 0 || (c.fee_dailyUSD != null && c.spaces !== null)));
    const ferry = (P.ferries as { spaces?: number; fee_dailyUSD?: number | null; feeDetail?: { offPeak_Oct1_Apr30?: unknown } }[]).filter((f) => (f.spaces ?? 0) > 0 || f.fee_dailyUSD != null || f.feeDetail?.offPeak_Oct1_Apr30);
    const fees = bart.map((b) => b.fee_dailyUSD).filter((v): v is number => v != null);
    return { bart: bart.length, caltrain: caltrain.length, ferry: ferry.length, bartNoLot: noLot, bartMedianFee: median(fees), bartMaxFee: fees.length ? Math.max(...fees) : null };
  })();
  // ---- the backcast's demand context (backcast-inputs.json, as backcast.ts computes it) and the service changes in its window ----
  const backcastContext = (() => {
    const j = refJson('backcast-inputs.json');
    const bsrc = src('backcast.ts');
    const mean = (o: Record<string, number | { pct: number }>, re: RegExp) => {
      const v = Object.entries(o).filter(([k]) => re.test(k)).map(([, x]) => (typeof x === 'number' ? x : x.pct));
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    const k = j.officeAttendance.weekly, h = j.hotelOccupancy.weekly4wkMA;
    // the months compared, as backcast.ts writes them: mean(k, /past/) / mean(k, /now/)
    const months = (v: string) => [...bsrc.matchAll(new RegExp(`mean\\(${v}, /([^/]+)/\\)`, 'g'))].map((m) => new RegExp(m[1]));
    const [kPast, kNow] = months('k'), [hPast, hNow] = months('h');
    const office = mean(k, need(kPast, 'office months')) / mean(k, need(kNow, 'office months'));
    const hotel = mean(h, need(hPast, 'hotel months')) / mean(h, need(hNow, 'hotel months'));
    const windowFrom = `${backcastFeed[1].slice(0, 4)}-${backcastFeed[1].slice(4, 6)}-${backcastFeed[1].slice(6, 8)}`;
    return {
      attendanceCore: office,
      visitors: hotel,
      officeWeeksPast: Object.keys(k).filter((x) => kPast.test(x)).length,
      officeWeeksNow: Object.keys(k).filter((x) => kNow.test(x)).length,
      serviceChanges: (j.serviceChanges as { date: string; routes: string[] }[]).filter((c) => c.date >= windowFrom && c.date <= '2026-08-31').map((c) => ({ date: c.date, routes: c.routes })),
    };
  })();

  const facts = {
    generated: new Date().toISOString(),
    bundleBuilt: H.built,
    sources: H.sources,
    counts: {
      zones: H.zones.length,
      neighborhoods: new Set(H.zones.map((z) => z.nhood)).size,
      external: H.ext.length,
      externalCounties: extCounties,
      externalSplitParts: extSplit,
      stops: H.stops.length,
      patterns: H.lines.length,
      routes: [...routeSet.values()].reduce((a, s) => a + s.size, 0),
      byFeed,
      byMode,
      accessLinks: (A.connectors as Int32Array).length / 3,
      externalAccessLinks: (A.extConnectors as Int32Array).length / EXT_CONNECTOR_FIELDS,
      walkTransfers: (A.transfers as Int32Array).length / 3,
      commuteFlows: (A.flowN as Float32Array).length,
      inCommuteFlows: (A.inN as Float32Array).length,
      zonesByAreaType: zonesByArea,
    },
    totals: {
      pop,
      hh: sum((z) => z.hh),
      hhVeh,
      workers,
      wfhShare: wfhWeighted,
      jobs: sum((z) => z.jobs),
      jobsByAreaType: jobsByArea,
      lodesJobs,
      jobsMovedOut,
      hotelRoomsOsm: sum((z) => z.hotelRooms),
      inCommuters: (A.inN as Float32Array).reduce((a, v) => a + v, 0),
      age5to17: sum((z) => z.age5to17),
      college: sum((z) => z.college),
      collegeEnroll: sum((z) => z.collegeEnroll ?? 0),
      hsEnroll: sum((z) => z.hsEnroll ?? 0),
      age65plus: sum((z) => z.age65plus),
    },
    gateways,
    fares: Object.fromEntries(Object.entries(H.fares).map(([k, v]) => [k, { board: v.board, perKm: v.perKm, segments: v.hops?.length ?? 0, routes: v.routes ?? null }])),
    bartFare,
    bartThrough,
    parks,
    auto: {
      speedShare: { freeway: shareOf('freeway'), arterial: shareOf('arterial'), local: shareOf('local') },
      delay: { arterial: delayOf('arterial'), local: delayOf('local') },
      regionalSpeedKmh: regional,
      regionalCircuity: Number(need(/circuity: ([\d.]+)/.exec(skims), 'circuity')[1]),
    },
    access: {
      walkFlatMs: constNum(src('walk.ts'), 'WALK_FLAT'),
      busAccessMaxSec: constNum(skims, 'BUS_ACCESS_MAX'),
      railAccessMaxSec: constNum(skims, 'RAIL_ACCESS_MAX'),
      transferMaxSec: constNum(skims, 'TRANSFER_MAX'),
    },
    streets,
    walkNet,
    walkRules,
    streetJoins,
    elevationZoom: Number(need(/export const ELEV_ZOOM = (\d+)/.exec(src('fetch-elevation.ts')), 'ELEV_ZOOM')[1]),
    areaTypeRadiusM: constNum(src('build.ts'), 'RADIUS'),
    sfoRadiusM: Number(need(/const SFO = \{[^}]*r: (\d+)/.exec(zonesSrc), 'SFO radius')[1]),
    zonesBuild: { minExternal: constNum(zonesSrc, 'MIN_EXT'), splitAbove: constNum(zonesSrc, 'SPLIT'), maxExternalKm: constNum(zonesSrc, 'MAX_EXTERNAL_KM') },
    feeds,
    backcastFeed: { wkd: backcastFeed[1], sat: backcastFeed[2], sun: backcastFeed[3] },
    targets: {
      b08141: { car0: seg('car0'), car1: seg('car1'), car2: seg('car2') },
      ext: extTarget,
      // hotel visitors: SF Planning's hotel door surveys weighted by the bundle's rooms (visitor-target.ts)
      visitor: visitorTarget(H.zones).target,
      airport: target('AIRPORT_TARGET'),
      regional: target('REGIONAL_TARGET'),
      tripKm,
      stopKm,
      tripNear: LT.near,
      stopNear: LT.stopNear,
      lengthSample: LT.sample,
      residentAll,
      residentTrips,
      county: countyTarget,
      ferryRoutes,
      parks: parkTargets,
    },
    calibration: {
      asc: C.asc,
      modeBias: C.modeBias,
      distCoef: C.distCoef,
      regionalRate: C.regionalRate,
      outShare: C.outShare,
      airportTrips: C.airportTrips,
      tourRateFactor: C.tourRateFactor ?? null,
      residentCorrection: C.residentCorrection ?? null,
      incomeTransit: C.incomeTransit ?? null,
      incomeFit: C.incomeFit ?? null,
      countyFit: C.countyFit ?? null,
      countyTransit: C.countyTransit ?? null,
      pumaFit: C.pumaFit ?? null,
      pumaTransit: C.pumaTransit ?? null,
      stopDistCoefs: C.stopDistCoefs ?? null,
      // school and college tours (demand.ts fitStudents)
      schoolDistScale: C.schoolDistScale ?? null,
      schoolAsc: C.schoolAsc ?? null,
      schoolFit: C.schoolFit ?? null,
      schoolLevelTransit: C.schoolLevelTransit ?? null,
      schoolLevelFit: C.schoolLevelFit ?? null,
      youthTransitInterval: C.youthTransitInterval ?? null,
      // residents' commutes to the outside counties (calibrate.ts OUT_2024)
      outCommuteFactor: C.outCommuteFactor ?? null,
      outCommuteFit: C.outCommuteFit ?? null,
      // school tours' trips home (SCHOOL_RETURN) and Caltrain's direction (constants at the two ends)
      schoolSwitch: C.schoolSwitch ?? null,
      schoolReturnFit: C.schoolReturnFit ?? null,
      caltrainEnd: C.caltrainEnd ?? null,
      caltrainAct: C.caltrainAct ?? null,
      caltrainDirFit: C.caltrainDirFit ?? null,
      // special events: venues' transit constants, and the South Bay's, fitted to Caltrain's Giants riders
      eventTransit: C.eventTransit ?? null,
      eventSouthTransit: C.eventSouthTransit ?? null,
      eventCaltrainFit: C.eventCaltrainFit ?? null,
      collegeDa: C.collegeDa ?? null,
      collegeFit: C.collegeFit ?? null,
      youthAsc: C.youthAsc ?? null,
      youthFit: C.youthFit ?? null,
      distLogCoef: C.distLogCoef ?? null,
      stopLogCoefs: C.stopLogCoefs ?? null,
      walkTimeFactor: C.walkTimeFactor ?? null,
      walkFit: C.walkFit ?? null,
      walkFitNear: C.walkFitNear ?? null,
      parkWeight: C.parkWeight ?? null,
      parkExponent: C.parkExponent ?? null,
      parkFactor: C.parkFactor ?? null,
      ivtFactor: C.ivtFactor ?? null,
      // car ownership: constants, the fit, and how many neighborhoods have their own constants
      // whether the delivered bundle's residents' tours come from the person-level choices (demand.ts reads calibration.abm.on, default off)
      abmOn: !!C.abm?.on,
      autoOwn: C.autoOwn ? { asc: C.autoOwn.asc, fit: C.autoOwn.fit ?? null, nhoods: Object.keys(C.autoOwn.nhood).length, classes: (A.aoClass?.length ?? 0) / 12, retailOutside: H.ext.reduce((a, x) => a + (x.retail ?? 0), 0) } : null,
      ferryFloor,
      ivtFit,
      xferFactor: C.xferFactor,
      // Muni's level by residence (calibrate.ts residentTarget): the two factors (bounded 0.8 and 2), and
      // residents' and non-residents' boardings on the counted routes, [model, target]: muniLevelFit from
      // the calibration's estimate, muniByResidence from its last assignment; the regional visitor rate's
      // check; the penalties on how riders reach BART outside the city
      residentTransitLevel: C.residentTransitLevel ?? null,
      nonResTransitLevel: C.nonResTransitLevel ?? null,
      muniLevelFit: C.muniLevelFit ?? null,
      muniByResidence: C.muniByResidence ?? null,
      regionalFit: C.regionalFit ?? null,
      extAccessBias: C.extAccessBias ?? null,
      touristRides: C.touristRides,
      days: C.days,
      iterations: C.iterations,
      nhood: { n: nh.length, min: Math.min(...nh), max: Math.max(...nh), sd: Math.sqrt(nh.reduce((a, v) => a + (v - nhMean) ** 2, 0) / Math.max(1, nh.length)), atBound: nh.filter((v) => Math.abs(v) >= 2).length },
      workModel,
      meanKm,
      meanKm5,
      nearShare,
      report: rep,
    },
    observed: {
      muniPeriod: H.observed.muniPeriod,
      muniSystem: H.observed.muniSystem,
      bartPeriod: H.observed.bartPeriod,
      caltrainPeriod: H.observed.caltrainPeriod,
      acsPeriod: H.observed.acsPeriod,
      residentShares: H.observed.residentShares,
      residentSharesSource: H.observed.residentSharesSource,
      muniRoutes: H.observed.muniRoutes.length,
      muniRoutesSat: H.observed.muniRoutesSat?.length ?? 0,
      muniRoutesSun: H.observed.muniRoutesSun?.length ?? 0,
    },
    dayTypes: H.dayTypes,
    reliability,
    operations,
    night,
    schools,
    shuttles,
    parking,
    backcastContext,
    shapeRatio,
    bundleBytes: fs.statSync(path.join(ROOT, 'client/beta3/model/sf.bin.gz')).size,
  };
  fs.writeFileSync(path.join(here, 'facts.json'), JSON.stringify(facts, (_, v) => (typeof v === 'number' ? +v.toPrecision(6) : v), 1));
  console.log(`facts.json written (bundle ${H.built}); BART fare MAE ${bartFare?.mae.toFixed(2)} over ${bartFare?.pairs} pairs; LODES ${lodesJobs} → ${facts.totals.jobs}`);
}

main();
