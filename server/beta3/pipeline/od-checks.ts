/**
 * Origin–destination checks: does the model put transit riders between the right places, not only
 * on the right lines? Boardings alone allow compensating errors (too many riders from one place
 * making up for too few from another), so these tests compare markets:
 *
 *  1. BART journeys between each San Francisco station and each group of outside stations (and
 *     between the city's stations), by period and direction, against BART's own station-to-station
 *     counts (August 2026 weekday matrix, split into periods with the 2025 hourly file;
 *     reference/regional-od.json). The model's journeys are exact gate-to-gate flows from its
 *     assignment (station-od.ts).
 *  2. Commute flows: the model's commutes by home and work district (12 districts of the city) and
 *     across the city line, in total and by transit, against CTPP 2017–2021 (Census/AASHTO) flows
 *     by means of transportation (reference/od-validation.json).
 *  3. Who rides: Muni light rail and bus riders' trip purpose and home county against MTC's 2023–24
 *     Snapshot onboard survey; where T Third riders' trips end, how they reach the T, and how many
 *     change from BART or Caltrain (no public stop- or OD-level T data exist; see od-validation.json).
 *
 * Used by validate.ts (out.od); run alone for a quick look:
 *   NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/od-checks.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { computeDemand } from '../../../shared/beta3/demand';
import { SCHOOL_DAY, STOP_MIX } from '../../../shared/beta3/params';
import { LocalExecutor, SKIM_PERIODS, prepare } from '../../../shared/beta3/model';
import { buildNet, LINK_ACCESS, LINK_BOARD, LINK_CHANGE, LINK_WALK, type TransitNet } from '../../../shared/beta3/net';
import { decodeResult } from '../../../shared/beta3/results';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { Bundle, Calibration, RunResult, TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { toXY } from '../../../shared/beta3/geo';
import { BUNDLE, REFERENCE, WORK } from './paths';
import { loadBundle } from './run-base';
import { CITY_STATIONS, modelRegionalPairs, readRegional } from './station-od';
import { stats } from './stats';

type Prep = ReturnType<typeof prepare>;
type Crowd = RunResult['finalCrowd'];
const P = ['AM', 'MD', 'PM', 'NT'] as const;
const round = (v: number) => Math.round(v);

// ---------- districts ----------
/** 12 districts of the city, each a group of the Planning Department's analysis neighborhoods */
export const DISTRICTS: [string, string[]][] = [
  ['Downtown', ['Financial District/South Beach', 'Chinatown', 'Nob Hill', 'Tenderloin']],
  ['SoMa', ['South of Market', 'Treasure Island']],
  ['Mission Bay–Potrero', ['Mission Bay', 'Potrero Hill']],
  ['Northern', ['North Beach', 'Russian Hill', 'Marina', 'Pacific Heights', 'Presidio Heights', 'Presidio', 'Seacliff']],
  ['Western Addition–Haight', ['Hayes Valley', 'Western Addition', 'Japantown', 'Lone Mountain/USF', 'Haight Ashbury']],
  ['Mission', ['Mission']],
  ['Castro–Noe–Bernal', ['Castro/Upper Market', 'Noe Valley', 'Bernal Heights', 'Glen Park', 'Twin Peaks']],
  ['Richmond', ['Inner Richmond', 'Outer Richmond', 'Lincoln Park', 'Golden Gate Park']],
  ['Sunset', ['Inner Sunset', 'Sunset/Parkside']],
  ['Southwest', ['West of Twin Peaks', 'Lakeshore', 'Oceanview/Merced/Ingleside']],
  ['Excelsior–Visitacion Valley', ['Excelsior', 'Outer Mission', 'Portola', 'McLaren Park', 'Visitacion Valley']],
  ['Bayview–Hunters Point', ['Bayview Hunters Point']],
];
/** each city zone's district (a zone with no neighborhood takes its nearest neighbor's) */
export function zoneDistricts(b: Bundle): number[] {
  const of = new Map<string, number>();
  DISTRICTS.forEach(([, ns], k) => ns.forEach((n) => of.set(n, k)));
  const Z = b.header.zones;
  return Z.map((z) => {
    const k = of.get(z.nhood);
    if (k !== undefined) return k;
    let best = -1, bd = Infinity;
    Z.forEach((w) => {
      const kk = of.get(w.nhood);
      const d = Math.hypot(w.x - z.x, w.y - z.y);
      if (kk !== undefined && d < bd) (bd = d), (best = kk);
    });
    return best;
  });
}

// ---------- the model's demand by market, at the delivered crowding ----------
export interface ModelState {
  b: Bundle;
  calib: Calibration;
  prep: Prep;
  crowd: Crowd;
  demand: ReturnType<typeof computeDemand>;
  markets: Record<string, Record<TPeriod, Float32Array>>;
}
export const crowdArrays = (b: Bundle, calib: Calibration, p: TPeriod, crowd: Crowd) => {
  const net0 = buildNet(b, { name: 'Today', edits: [] }, p, calib);
  return net0.lines.map((l) => (l.src >= 0 && crowd?.[p]?.[l.src]?.length === l.stops.length - 1 ? crowd[p][l.src] : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1)));
};
export async function modelState(b: Bundle, calib: Calibration, prep: Prep, crowd: Crowd): Promise<ModelState> {
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  // every skim period (the night's too), with the calibrated park-and-ride prices, as the base run has them
  const lot = new Float32Array(b.header.stops.length);
  for (const [s, v] of Object.entries(calib.lotPrice ?? {})) lot[Number(s)] = v;
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, crowdArrays(b, calib, p, crowd), lot.some((v) => v > 0) ? lot : undefined);
  const markets: Record<string, Record<TPeriod, Float32Array>> = {};
  const demand = computeDemand(b, prep, sk as never, calib, 'wkd', 1, markets);
  return { b, calib, prep, crowd, demand, markets };
}

// ---------- 1. BART station to station ----------
const BART_GROUPS: [string, string[]][] = [
  ['Daly City & Colma', ['DALY', 'COLM']],
  ['Peninsula & SFO', ['SSAN', 'SBRN', 'SFIA', 'MLBR']],
  ['Oakland & Berkeley', ['WOAK', '12TH', '19TH', 'LAKE', 'MCAR', 'ASHB', 'DBRK', 'NBRK', 'ROCK', 'FTVL']],
  ['Richmond line', ['PLZA', 'DELN', 'RICH']],
  ['Concord–Antioch line', ['ORIN', 'LAFY', 'WCRK', 'PHIL', 'CONC', 'NCON', 'PITT', 'PCTR', 'ANTC']],
  ['Fremont–Berryessa line', ['COLS', 'OAKL', 'SANL', 'BAYF', 'HAYW', 'SHAY', 'UCTY', 'FRMT', 'WARM', 'MLPT', 'BERY']],
  ['Dublin line', ['CAST', 'WDUB', 'DUBL']],
];
type Cell = { obs: number; mod: number };
export function bartOD(st: ModelState) {
  const ref = readRegional();
  const codes = ref.bart.codes;
  const ix = (c: string) => codes.indexOf(c);
  const city = CITY_STATIONS.bart;
  const obs = ref.bart.od.wkd;
  const mod = modelRegionalPairs(st.b, st.calib, 'wkd', st.demand, st.crowd, ref).bart;
  const groups: [string, number[]][] = [['Within the city', city.map(ix)], ...BART_GROUPS.map(([n, cs]) => [n, cs.map(ix)] as [string, number[]])];
  const sum = (M: Record<string, number[][]>, ps: readonly string[], from: number[], to: number[]) => ps.reduce((a, p) => a + from.reduce((x, i) => x + to.reduce((y, j) => y + (i === j ? 0 : M[p][i][j]), 0), 0), 0);
  // cells: city station × group × direction × period
  const cells: { station: string; group: string; dir: 'toCity' | 'fromCity'; period: string; obs: number; mod: number }[] = [];
  for (const s of city)
    for (const [g, gi] of groups)
      for (const p of P) {
        cells.push({ station: s, group: g, dir: 'toCity', period: p, obs: sum(obs, [p], gi, [ix(s)]), mod: sum(mod, [p], gi, [ix(s)]) });
        if (g !== 'Within the city') cells.push({ station: s, group: g, dir: 'fromCity', period: p, obs: sum(obs, [p], [ix(s)], gi), mod: sum(mod, [p], [ix(s)], gi) });
      }
  const agg = (f: (c: (typeof cells)[number]) => string) => {
    const m = new Map<string, Cell>();
    for (const c of cells) {
      const k = f(c), e = m.get(k) ?? { obs: 0, mod: 0 };
      e.obs += c.obs;
      e.mod += c.mod;
      m.set(k, e);
    }
    return m;
  };
  const rows = (m: Map<string, Cell>) => [...m].map(([k, v]) => ({ key: k, observed: round(v.obs), model: round(v.mod), pct: +((100 * (v.mod - v.obs)) / Math.max(1, v.obs)).toFixed(1) }));
  // daily, station × group × direction (the headline test)
  const daily = agg((c) => `${c.station}|${c.group}|${c.dir}`);
  const dailyPairs = [...daily.values()];
  // by group and direction, each period
  const byGroupPeriod = agg((c) => `${c.group}|${c.dir}|${c.period}`);
  const byGroup = agg((c) => `${c.group}|${c.dir}`);
  const byStation = agg((c) => `${c.station}|${c.dir}`);
  // where each group's riders get off in the city: shares by station (toCity, daily)
  const split = groups.map(([g]) => {
    const o = city.map((s) => daily.get(`${s}|${g}|toCity`)!.obs), m = city.map((s) => daily.get(`${s}|${g}|toCity`)!.mod);
    const so = o.reduce((a, v) => a + v, 0), sm = m.reduce((a, v) => a + v, 0);
    return { group: g, observedTotal: round(so), modelTotal: round(sm), shares: city.map((s, k) => ({ station: s, observed: +(o[k] / so).toFixed(3), model: +(m[k] / Math.max(1e-9, sm)).toFixed(3) })) };
  });
  const perPeriodStats = Object.fromEntries(
    (['toCity', 'fromCity'] as const).flatMap((dir) =>
      P.map((p) => {
        const cs = cells.filter((c) => c.dir === dir && c.period === p);
        return [`${dir}${p}`, stats(cs)];
      }),
    ),
  );
  const misses = [...daily].map(([k, v]) => ({ key: k, observed: round(v.obs), model: round(v.mod), diff: round(v.mod - v.obs) })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 12);
  // journeys the city's BART stations carry, by kind (daily, both directions)
  const kinds = groups.map(([g]) => {
    const t = byGroup.get(`${g}|toCity`)!, f = byGroup.get(`${g}|fromCity`);
    return { group: g, observed: round(t.obs + (f?.obs ?? 0)), model: round(t.mod + (f?.mod ?? 0)) };
  });
  return {
    source: 'BART August 2026 average-weekday station-to-station matrix, split into periods pair by pair with the 2025 hourly origin–destination file (regional-od.json)',
    note: 'Model: gate-to-gate journeys without a change of train recovered exactly from the assignment (station-od.ts); journeys with an end in San Francisco only. Observed: all journeys between the same stations, which includes riders who live outside the city on both ends only where neither station is in the city (not in these cells) and the 3–6% whose trip neither starts nor ends in the city but uses a city station (e.g. Oakland to Daly City is not here; Oakland to 16th St is).',
    daily: { ...stats(dailyPairs), cells: rows(daily) },
    perPeriod: perPeriodStats,
    byGroup: rows(byGroup),
    byGroupPeriod: rows(byGroupPeriod),
    byStation: rows(byStation),
    kinds,
    stationSplit: split,
    largestMisses: misses,
  };
}

// ---------- 2. commute flows ----------
/**
 * CTPP 2017–2021 on the model's year. The CTPP's five survey years end in 2021 and three of them came
 * before the pandemic; the model is calibrated to 2024 surveys. The ACS by workplace (B08406, everyone
 * who works in the city) puts transit at 39.2% of commuters to the city's jobs in 2017–2021 and 34.2%
 * in 2024 (acs-commute-era.json), so the CTPP's shares are moved by the change in the log odds of the
 * city's share, the same for every workplace (no tract table exists for a later period).
 */
export function eraShift(era: { byWorkplace: Record<string, { transitShare: number }> } | null, from = '2017-2021 5-year', to = '2024 1-year') {
  const a = era?.byWorkplace?.[from]?.transitShare, b = era?.byWorkplace?.[to]?.transitShare;
  if (!a || !b) return 0;
  const logit = (p: number) => Math.log(p / (1 - p));
  return logit(b) - logit(a);
}
/** a share moved by a change in its log odds */
export const shiftShare = (p: number, shift: number) => (p <= 0 || p >= 1 ? p : 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + shift))));
const readEra = () => (fs.existsSync(`${REFERENCE}/acs-commute-era.json`) ? JSON.parse(fs.readFileSync(`${REFERENCE}/acs-commute-era.json`, 'utf8')) : null);

/** commuters to jobs in the city by workplace (district and tract), all homes, against CTPP
 * 2017–2021 Part 2: how many work there and how many get there by transit. The model's commute
 * flows are LODES 2023 rescaled (inputs) and its transit constants are fitted by home (block group,
 * county), never by workplace, so the workplace transit share is an independent test. */
export function commuteOD(st: ModelState, ref: OdRef) {
  const C = ref.ctppWorkplace;
  if (!C) return null;
  const H = st.b.header, NZ = H.zones.length, ZT = st.prep.ZT, NO = NZ + H.ext.length;
  const dist = zoneDistricts(st.b);
  const tractOf = H.zones.map((z) => z.id.slice(5, 11));
  const distOfTract = new Map<string, number>();
  H.zones.forEach((z, k) => distOfTract.set(tractOf[k], dist[k]));
  // model: commuters at work by workplace zone, by mode (both legs counted, so halved)
  const all = new Float64Array(NZ), tr = new Float64Array(NZ), res = new Float64Array(NZ);
  for (const [k, byP] of Object.entries(st.markets)) {
    if (!k.startsWith('work ') || k === 'work shuttle') continue;
    const M = byP.AM, isTr = k === 'work transit';
    for (let o = 0; o < NO; o++)
      for (let d = 0; d < NZ; d++) {
        const v = M[o * ZT + d] / 2;
        if (!v) continue;
        all[d] += v;
        if (isTr) tr[d] += v;
        if (o < NZ) res[d] += v;
      }
  }
  const obs = C.tracts.map((t) => ({ ...t, commuters: t.workers - t.wfh }));
  const shift = eraShift(readEra());
  const oTot = obs.reduce((a, t) => a + t.commuters, 0), mTot = all.reduce((a, v) => a + v, 0);
  const byDistrict = DISTRICTS.map(([name], k) => {
    const o = obs.filter((t) => distOfTract.get(t.tract) === k);
    const oc = o.reduce((a, t) => a + t.commuters, 0), ot = o.reduce((a, t) => a + t.transit, 0);
    let mc = 0, mt = 0;
    for (let z = 0; z < NZ; z++) if (dist[z] === k) (mc += all[z]), (mt += tr[z]);
    return { district: name, observedShareOfCommuters: +(oc / oTot).toFixed(4), modelShareOfCommuters: +(mc / mTot).toFixed(4), observedTransitShare: +(ot / oc).toFixed(3), observedTransitShare2024: +shiftShare(ot / oc, shift).toFixed(3), modelTransitShare: +(mt / mc).toFixed(3), observedCommuters: Math.round(oc), modelCommuters: Math.round(mc) };
  });
  // tracts with enough workers for a usable share (ACS margins grow quickly below that)
  const mByTract = new Map<string, { c: number; t: number }>();
  for (let z = 0; z < NZ; z++) {
    const e = mByTract.get(tractOf[z]) ?? { c: 0, t: 0 };
    e.c += all[z];
    e.t += tr[z];
    mByTract.set(tractOf[z], e);
  }
  const tracts = obs.filter((t) => t.commuters >= 2000 && mByTract.has(t.tract)).map((t) => {
    const m = mByTract.get(t.tract)!;
    return { tract: t.tract, district: DISTRICTS[distOfTract.get(t.tract) ?? 0][0], observedCommuters: Math.round(t.commuters), modelCommuters: Math.round(m.c), observedTransitShare: +(t.transit / t.commuters).toFixed(3), modelTransitShare: +(m.t / Math.max(1e-9, m.c)).toFixed(3) };
  });
  const oT = obs.reduce((a, t) => a + t.transit, 0) / oTot;
  const totalTransit = { observed: +oT.toFixed(3), observed2024: +shiftShare(oT, shift).toFixed(3), model: +(tr.reduce((a, v) => a + v, 0) / mTot).toFixed(3) };
  return {
    source: C.source,
    note: 'Commuters = workers less those working at home. Shares, not counts: CTPP counts usual workers 2017–2021, the model commuters at work on an average weekday of 2026. The distribution of jobs comes from LODES 2023 rebalanced to MTC 2023 employment (an input); the transit share by workplace is never fitted. observed…2024: the CTPP share moved to 2024 by the change in the log odds of the ACS workplace share for the whole city (eraShift).',
    eraShift: +shift.toFixed(4),
    totalTransitShare: totalTransit,
    byDistrict,
    districtTransit: stats(byDistrict.map((r) => ({ obs: r.observedTransitShare, mod: r.modelTransitShare }))),
    districtTransit2024: stats(byDistrict.map((r) => ({ obs: r.observedTransitShare2024, mod: r.modelTransitShare }))),
    districtJobs: stats(byDistrict.map((r) => ({ obs: r.observedShareOfCommuters, mod: r.modelShareOfCommuters }))),
    tracts: { rows: tracts, transit: stats(tracts.map((r) => ({ obs: r.observedTransitShare, mod: r.modelTransitShare }))), commuters: stats(tracts.map((r) => ({ obs: r.observedCommuters, mod: r.modelCommuters }))) },
  };
}

/** each outside zone's commuters (its 400 m cells, from the work files; its centroid otherwise) placed
 * in the PUMA of the nearest tract: outside zone → PUMA → share */
export function extPumaWeights(b: Bundle, R: NonNullable<OdRef['inCommutersByPuma']>) {
  const H = b.header;
  const cents = R.tractCentroids.map(([lat, lon, puma]) => ({ xy: toXY(lat, lon), puma }));
  const nearest = (x: number, y: number) => {
    let best = '', bd = Infinity;
    for (const c of cents) {
      const d = (c.xy[0] - x) ** 2 + (c.xy[1] - y) ** 2;
      if (d < bd) (bd = d), (best = c.puma);
    }
    return best;
  };
  const zf = `${WORK}/zones.json`;
  const ext: { id: string; points: { x: number; y: number; w: number }[] }[] | null = fs.existsSync(zf) ? JSON.parse(fs.readFileSync(zf, 'utf8')).external : null;
  const byId = new Map((ext ?? []).map((e) => [e.id, e.points]));
  return H.ext.map((e) => {
    const m = new Map<string, number>();
    const pts = byId.get(e.id)?.length ? byId.get(e.id)! : [{ x: e.x, y: e.y, w: 1 }];
    const W = pts.reduce((a, p) => a + p.w, 0);
    for (const p of pts) {
      const q = nearest(p.x, p.y);
      m.set(q, (m.get(q) ?? 0) + p.w / W);
    }
    return m;
  });
}

/** in-commuters to the city by home PUMA, against ACS PUMS: how many, and how many by transit.
 * The model's transit constants are fitted by home county, so the split within a county is a test. */
export function inCommutersByPuma(st: ModelState, ref: OdRef) {
  const R = ref.inCommutersByPuma;
  if (!R) return null;
  const H = st.b.header, NZ = H.zones.length, ZT = st.prep.ZT;
  const pumaW = extPumaWeights(st.b, R);
  const all = new Map<string, number>(), tr = new Map<string, number>();
  for (const [k, byP] of Object.entries(st.markets)) {
    if (!k.startsWith('work ')) continue;
    const M = byP.AM, isTr = k === 'work transit';
    for (let e = 0; e < H.ext.length; e++)
      for (let d = 0; d < NZ; d++) {
        const v = M[(NZ + e) * ZT + d];
        if (!v) continue;
        for (const [q, w] of pumaW[e]) {
          all.set(q, (all.get(q) ?? 0) + (v * w) / 2);
          if (isTr) tr.set(q, (tr.get(q) ?? 0) + (v * w) / 2);
        }
      }
  }
  const mTot = [...all.values()].reduce((a, v) => a + v, 0), oTot = R.pumas.reduce((a, p) => a + p.commuters, 0);
  const rows = R.pumas.map((p) => ({ puma: p.puma, observedShare: +(p.commuters / oTot).toFixed(4), modelShare: +((all.get(p.puma) ?? 0) / mTot).toFixed(4), observedTransit: p.transitShare, observedTransitSE: p.transitShareSE, modelTransit: +((tr.get(p.puma) ?? 0) / Math.max(1e-9, all.get(p.puma) ?? 0)).toFixed(3), observedBart: p.bartShare, commuters: p.commuters }));
  return {
    note: 'Share of in-commuters (Bay Area outside San Francisco) by home PUMA, and their transit share. Model: commuters at work on an average weekday; ACS: usual commuters, 2020–24.',
    rows,
    distribution: stats(rows.map((r) => ({ obs: r.observedShare, mod: r.modelShare }))),
    transitShare: stats(rows.map((r) => ({ obs: r.observedTransit, mod: r.modelTransit }))),
  };
}

// ---------- 3. who rides: purpose, home county, access, transfers; the T Third ----------
const SNAP_PURPOSE: Record<string, string> = { 'resident work': 'Work', 'in-commuters': 'Work', 'resident school': 'School', 'resident univ': 'School', univ: 'School', 'resident shop': 'Social/Recreation/Shopping', 'resident social': 'Social/Recreation/Shopping', 'resident other': 'Other Purposes', 'resident nhb': 'Other Purposes', visitor: 'Social/Recreation/Shopping', regional: 'Social/Recreation/Shopping', airport: 'Other Purposes', nhb: 'Other Purposes' };
const purposeOf = (k: string) => SNAP_PURPOSE[k.replace(/ return$/, '')] ?? (/ event/.test(` ${k}`) ? 'Social/Recreation/Shopping' : 'Other Purposes');
/**
 * A market's riders by the Snapshot's purpose groups. The Snapshot asked each rider the main purpose
 * of the trip, telling those going home to answer where they came from; MTC's dashboard groups the
 * answers as they are, with no tour logic (transit-passenger-surveys, summarize_snapshot_2023_for_
 * dashboard.R; work-local/research/snapshot-purpose.json). So a trip home takes its origin's purpose.
 * Residents' legs through a tour's stops ('trip' reading): on the way out, home to the stop has the
 * stop's purpose (shopping, errands, or social, STOP_MIX) and the stop to the primary destination
 * that destination's (by the tours that stop, stopTransitByPurpose); on the way back both legs have the
 * stop's (the last one goes home from it). Half the legs each way: three quarters the stop's purpose.
 * Work subtours: out to the stop, its purpose; back to work, Work. The 'tour' reading gives every
 * leg of a tour the tour's purpose instead, as riders who stop for coffee on the way to work may well
 * answer "work". T, when given, is the stop tours' total on an average weekday, so that on a school
 * day the scaled-up school tours add stop legs rather than reshuffle them.
 */
export type Reading = 'trip' | 'tour';
/** the periods the Snapshot surveyed: morning peak, midday, evening peak (MTC, March 2025, p. 5) */
export const SNAPSHOT_PERIODS = ['AM', 'MD', 'PM'] as const satisfies readonly TPeriod[];
export const purposeMix = (k: string, stopTours: Record<string, number>, reading: Reading = 'trip', total?: number): Record<string, number> => {
  const stopMix = { 'Social/Recreation/Shopping': STOP_MIX.shop + STOP_MIX.social, 'Other Purposes': STOP_MIX.other };
  const tourW = reading === 'tour' ? 1 : k === 'resident subtours' ? 0.5 : 0.25;
  if (k === 'resident subtours') {
    const out: Record<string, number> = { Work: tourW };
    for (const [g, v] of Object.entries(stopMix)) out[g] = (out[g] ?? 0) + (1 - tourW) * v;
    return out;
  }
  if (k !== 'resident stop legs') return { [purposeOf(k)]: 1 };
  const out: Record<string, number> = {};
  const T = total ?? Object.values(stopTours).reduce((a, v) => a + v, 0);
  for (const [p, v] of Object.entries(stopTours)) if (T > 0) out[purposeOf(`resident ${p}`)] = (out[purposeOf(`resident ${p}`)] ?? 0) + (tourW * v) / T;
  for (const [g, v] of Object.entries(stopMix)) out[g] = (out[g] ?? 0) + (1 - tourW) * v;
  return out;
};
/** markets whose trips start at home (residents' legs out, not back): BART's "home origin" */
const fromHome = (k: string) => k.startsWith('resident ') && !k.endsWith(' return') && !['resident nhb', 'resident stop legs', 'resident subtours'].includes(k);
const BART_CITY = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB'];

/** how riders reach each boarding: per board link, the riders arriving at its node on foot, from a
 * Muni stop, from a BART or Caltrain station, or from another operator (a stop shared by several
 * lines gives each the mix at the node) */
function arrivals(net: TransitNet, H: Bundle['header'], vol: Float64Array, boards: number[]) {
  const Z = net.nZones, S = net.nStops, A0 = Z;
  const at = new Map<number, Record<'street' | 'muni' | 'bart' | 'caltrain' | 'other', number>>();
  for (const a of boards) at.set(net.tail[a], { street: 0, muni: 0, bart: 0, caltrain: 0, other: 0 });
  for (let a = 0; a < net.nLinks; a++) {
    const e = at.get(net.head[a]);
    if (!e || !vol[a]) continue;
    const t = net.type[a];
    if (t === LINK_ACCESS) e.street += vol[a];
    else if (t === LINK_CHANGE || t === LINK_WALK) {
      const s = net.tail[a] - A0;
      const f = s >= 0 && s < S && s < H.stops.length ? H.stops[s].feed : 'other';
      if (f === 'muni' || f === 'bart' || f === 'caltrain') e[f] += vol[a];
      else e.other += vol[a];
    }
  }
  return (a: number) => {
    const e = at.get(net.tail[a])!, tot = e.street + e.muni + e.bart + e.caltrain + e.other;
    const v = vol[a];
    return tot > 0 ? { street: (v * e.street) / tot, muni: (v * e.muni) / tot, bart: (v * e.bart) / tot, caltrain: (v * e.caltrain) / tot, other: (v * e.other) / tot } : { street: v, muni: 0, bart: 0, caltrain: 0, other: 0 };
  };
}

export async function riders(st: ModelState, ref: OdRef) {
  const { b, calib } = st;
  const H = b.header, NZ = H.zones.length, NX = H.ext.length;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const bartStop = new Map(BART_CITY.map((c) => [H.stops.findIndex((x) => x.id === `bart:${c}`), c]));
  type Acc = { lr: number; bus: number; t: number; lrP: Record<TPeriod, number>; busP: Record<TPeriod, number>; bart: Record<string, { on: number; fromMuni: number }> };
  const byMarket: Record<string, Acc> = {};
  // all markets together, by period: link volumes for route-level transfer shares
  const totVol: Partial<Record<TPeriod, Float64Array>> = {};
  for (const [k, byP] of Object.entries(st.markets)) {
    if (k.startsWith('work ')) continue;
    const zp = () => Object.fromEntries(TPERIODS.map((p) => [p, 0])) as Record<TPeriod, number>;
    const e: Acc = (byMarket[k] = { lr: 0, bus: 0, t: 0, lrP: zp(), busP: zp(), bart: Object.fromEntries(BART_CITY.map((c) => [c, { on: 0, fromMuni: 0 }])) });
    for (const p of TPERIODS) {
      const od = byP[p];
      if (!od) continue;
      const cr = crowdArrays(b, calib, p, st.crowd);
      const vol = await exec.assign(p, od, cr);
      const net = exec.net(p, cr);
      const tv = (totVol[p] ??= new Float64Array(net.nLinks));
      for (let a = 0; a < net.nLinks; a++) tv[a] += vol[a];
      const bartBoards: number[] = [];
      for (let a = 0; a < net.nLinks; a++) {
        if (!vol[a] || net.type[a] !== LINK_BOARD) continue;
        const l = net.lines[net.line[a]];
        if (l.feed === 'bart' && bartStop.has(l.stops[net.pos[a]])) bartBoards.push(a);
        if (l.feed !== 'muni') continue;
        if (l.mode === 'lightrail') (e.lr += vol[a]), (e.lrP[p] += vol[a]);
        else if (['bus', 'rapid', 'trolley', 'express'].includes(l.mode)) (e.bus += vol[a]), (e.busP[p] += vol[a]);
        if (l.route === 'T') e.t += vol[a];
      }
      // gate entries at the city's BART stations: boardings less changes between BART trains
      const arr = arrivals(net, H, vol, bartBoards);
      for (const a of bartBoards) {
        const c = bartStop.get(net.lines[net.line[a]].stops[net.pos[a]])!, x = arr(a);
        e.bart[c].on += x.street + x.muni + x.caltrain + x.other;
        e.bart[c].fromMuni += x.muni;
      }
    }
  }
  const share = (f: (k: string) => boolean, g: (a: Acc) => number) => {
    let x = 0, tot = 0;
    for (const [k, v] of Object.entries(byMarket)) {
      if (f(k)) x += g(v);
      tot += g(v);
    }
    return +(x / tot).toFixed(3);
  };
  // the legs through tours' stops: a half-tour home → stop → destination is a leg to the stop (the
  // survey files it under the stop's activity) and a leg on to the destination (under the tour's
  // purpose), so half their boardings go by the purposes of the transit tours that stop and half by
  // what stops are for (STOP_MIX)
  const stopTours = st.demand.stopTransitByPurpose ?? {};
  const stopT = Object.values(stopTours).reduce((a, v) => a + v, 0);
  // on a school day (SCHOOL_DAY): school and college trips, and the stop legs of their tours, scaled up
  // from the average weekday of the year, for surveys taken while schools are in session
  const dayK = (k: string, schoolDay: boolean) => {
    if (!schoolDay) return 1;
    const b = k.replace(/ return$/, '');
    return b === 'resident school' ? SCHOOL_DAY.k12 : b === 'resident univ' || b === 'univ' ? SCHOOL_DAY.college : 1;
  };
  const stopToursOn = (schoolDay: boolean) => (schoolDay ? Object.fromEntries(Object.entries(stopTours).map(([p, v]) => [p, v * dayK(`resident ${p}`, true)])) : stopTours);
  // periods: only the boardings of these periods (the Snapshot surveyed the morning peak, midday, and
  // the evening peak, not the night: MTC, Snapshot Survey presentation, March 2025, p. 5)
  const boardOf = (v: Acc, f: 'lr' | 'bus' | 't', periods?: readonly TPeriod[]) => (periods && f !== 't' ? periods.reduce((a, p) => a + (f === 'lr' ? v.lrP[p] : v.busP[p]), 0) : v[f]);
  const purpose = (f: 'lr' | 'bus' | 't', schoolDay = false, reading: Reading = 'trip', periods?: readonly TPeriod[]) => {
    const s: Record<string, number> = {};
    const tours = stopToursOn(schoolDay);
    let tot = 0;
    for (const [k, v] of Object.entries(byMarket)) {
      for (const [g, w] of Object.entries(purposeMix(k, tours, reading, stopT))) {
        const x = w * boardOf(v, f, periods) * dayK(k, schoolDay);
        s[g] = (s[g] ?? 0) + x;
        tot += x;
      }
    }
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +(v / tot).toFixed(3)]));
  };
  const snap = ref.snapshot ?? {};
  const purposeRows = (f: 'lr' | 'bus', op: string) => {
    const m = purpose(f), sd = purpose(f, true), mt = purpose(f, false, 'tour'), o = snap[op]?.trip_purpose_group ?? {};
    // as surveyed: the Snapshot's periods (6am–7pm) on a school day, by the trip and by the tour
    const sp = purpose(f, true, 'trip', SNAPSHOT_PERIODS), spt = purpose(f, true, 'tour', SNAPSHOT_PERIODS);
    return Object.keys(o).map((k) => ({ purpose: k, observed: o[k], model: m[k] ?? 0, modelSchoolDay: sd[k] ?? 0, modelByTour: mt[k] ?? 0, modelSurveyed: sp[k] ?? 0, modelSurveyedByTour: spt[k] ?? 0 }));
  };
  // BART's city stations: share of entries by riders setting out from home, and how those reach BART
  const prof = (ref.bartProfile2024 ?? {}) as Record<string, { homeOriginShare: number; homeAccessTransit: number }>;
  const bartStations = BART_CITY.map((c) => {
    let on = 0, home = 0, homeMuni = 0;
    for (const [k, v] of Object.entries(byMarket)) {
      on += v.bart[c].on;
      if (fromHome(k)) (home += v.bart[c].on), (homeMuni += v.bart[c].fromMuni);
    }
    return { code: c, modelEntries: round(on), homeOriginShare: { observed: prof[c]?.homeOriginShare ?? null, model: +(home / on).toFixed(3) }, homeAccessByTransit: { observed: prof[c]?.homeAccessTransit ?? null, model: +(homeMuni / Math.max(1e-9, home)).toFixed(3) } };
  });
  // Muni lines: the share of each line's boardings made by changing from another line or operator
  const tb = new Map<string, { on: number; fromLine: number; fromBart: number; fromCaltrain: number; fromMuni: number }>();
  for (const p of TPERIODS) {
    const vol = totVol[p];
    if (!vol) continue;
    const net = exec.net(p, crowdArrays(b, calib, p, st.crowd));
    const boards: number[] = [];
    for (let a = 0; a < net.nLinks; a++) if (vol[a] && net.type[a] === LINK_BOARD && net.lines[net.line[a]].feed === 'muni') boards.push(a);
    const arr = arrivals(net, H, vol, boards);
    for (const a of boards) {
      const r = net.lines[net.line[a]].route, x = arr(a), e = tb.get(r) ?? { on: 0, fromLine: 0, fromBart: 0, fromCaltrain: 0, fromMuni: 0 };
      e.on += vol[a];
      e.fromLine += x.muni + x.bart + x.caltrain + x.other;
      e.fromBart += x.bart;
      e.fromCaltrain += x.caltrain;
      e.fromMuni += x.muni;
      tb.set(r, e);
    }
  }
  const obsTr = (ref.muni2017TransfersBefore ?? {}) as Record<string, number>;
  const tAll = [...tb.values()].reduce((a, v) => ({ on: a.on + v.on, fromLine: a.fromLine + v.fromLine, fromBart: a.fromBart + v.fromBart, fromCaltrain: a.fromCaltrain + v.fromCaltrain, fromMuni: a.fromMuni + v.fromMuni }), { on: 0, fromLine: 0, fromBart: 0, fromCaltrain: 0, fromMuni: 0 });
  const transfersBefore = {
    system: { model: +(tAll.fromLine / tAll.on).toFixed(3), observed: obsTr.system ?? null, modelFromBart: +(tAll.fromBart / tAll.on).toFixed(4), modelFromCaltrain: +(tAll.fromCaltrain / tAll.on).toFixed(4), modelFromMuni: +(tAll.fromMuni / tAll.on).toFixed(4), observedByOperator: (ref.muni2017TransfersBeforeByOperator as { muni: number; bart: number; caltrain: number; other: number } | undefined) ?? null },
    // Muni–rail connections as each operator's own survey reports them (derived; od-validation.json)
    crossSurvey: (ref.muni2017CrossSurveyLegs as { muniSurveyTripsWithBart: number; bartSurveyTripsWithMuni: number; muniSurveyTripsWithCaltrain: number; caltrainSurveyTripsWithMuni: number } | undefined) ?? null,
    routes: ['J', 'K', 'L', 'M', 'N', 'T', 'F'].map((r) => {
      const e = tb.get(r);
      return { route: r, model: e ? +(e.fromLine / e.on).toFixed(3) : null, modelFromBart: e ? +(e.fromBart / e.on).toFixed(3) : null, modelFromCaltrain: e ? +(e.fromCaltrain / e.on).toFixed(3) : null, observed2017: obsTr[r === 'K' || r === 'T' ? 'KT' : r] ?? null };
    }),
  };

  // the T: where its riders' trips end (by district), how they reach it, and changes from BART/Caltrain
  const dist = zoneDistricts(b);
  const tEnds = new Float64Array(DISTRICTS.length + 2); // + outside the city, + activity ends outside
  const tEndsAM = new Float64Array(DISTRICTS.length + 2);
  const tByStop = new Map<number, number>();
  const access = { street: 0, fromMuni: 0, fromBart: 0, fromCaltrain: 0, fromOther: 0 };
  for (const p of TPERIODS) {
    const cr = crowdArrays(b, calib, p, st.crowd);
    const net = buildNet(b, { name: 'Today', edits: [] }, p, calib, cr);
    const tBoard: number[] = [];
    for (let a = 0; a < net.nLinks; a++) if (net.type[a] === LINK_BOARD && net.lines[net.line[a]].route === 'T' && net.lines[net.line[a]].feed === 'muni') tBoard.push(a);
    if (!tBoard.length) continue;
    const solver = new StrategySolver(net);
    const od = st.demand.transitOD[p];
    const Z = net.nZones;
    // the solver's link volumes accumulate over loads: each destination's riders are the change
    const prevT = new Float64Array(tBoard.length);
    for (let d = 0; d < Z; d++) {
      let any = false;
      for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) (any = true), (o = Z);
      if (!any) continue;
      solver.solve(d);
      solver.load((o) => od[o * Z + d]);
      const lv = solver.linkVol;
      let x = 0;
      tBoard.forEach((a, k) => ((x += lv[a] - prevT[k]), (prevT[k] = lv[a])));
      if (x > 0) {
        const k = d < NZ ? dist[d] : d < NZ + NX ? DISTRICTS.length : DISTRICTS.length + 1;
        tEnds[k] += x;
        if (p === 'AM') tEndsAM[k] += x;
      }
    }
    const tot = solver.linkVol;
    const arr = arrivals(net, H, tot, tBoard);
    for (const a of tBoard) {
      if (!tot[a]) continue;
      const x = arr(a);
      access.street += x.street;
      access.fromMuni += x.muni;
      access.fromBart += x.bart;
      access.fromCaltrain += x.caltrain;
      access.fromOther += x.other;
      const stop = net.lines[net.line[a]].stops[net.pos[a]];
      tByStop.set(stop, (tByStop.get(stop) ?? 0) + tot[a]);
    }
  }
  const tt = tEnds.reduce((a, v) => a + v, 0), ta = tEndsAM.reduce((a, v) => a + v, 0);
  const names = [...DISTRICTS.map((d) => d[0]), 'Outside the city (home end)', 'Outside the city (activity end)'];
  const accTot = Object.values(access).reduce((a, v) => a + v, 0);
  // stops by name (a station's platforms and a stop's two directions together)
  const byName = new Map<string, number>();
  for (const [s, v] of tByStop) {
    const n = (H.stops[s]?.name ?? String(s)).replace(/ (Station )?(North|South)bound$/, '').replace(/ Station$/, '');
    byName.set(n, (byName.get(n) ?? 0) + v);
  }
  return {
    purposeMuniLightRail: purposeRows('lr', 'SFMTA (Muni) -- Light Rail'),
    purposeMuniBus: purposeRows('bus', 'SFMTA (Muni) -- Local Bus'),
    residentShare: {
      lightRail: { model: share((k) => k.startsWith('resident'), (a) => a.lr), observed: snap['SFMTA (Muni) -- Light Rail']?.home_county?.['San Francisco'] ?? null },
      bus: { model: share((k) => k.startsWith('resident'), (a) => a.bus), observed: snap['SFMTA (Muni) -- Local Bus']?.home_county?.['San Francisco'] ?? null },
      t: { model: share((k) => k.startsWith('resident'), (a) => a.t) },
      note: "model: boardings on residents' trips (their tours, stops and subtours); observed: Snapshot survey riders whose home county is San Francisco (weekday, 2023–24). Visitors from outside the Bay Area are 4–6% of Muni riders in the survey; the model's visitors and air travelers are counted as non-residents.",
    },
    bartStations,
    transfersBefore,
    boardingsByMarket: Object.fromEntries(Object.entries(byMarket).map(([k, v]) => [k, { lightRail: round(v.lr), bus: round(v.bus), t: round(v.t), byPeriod: Object.fromEntries(TPERIODS.map((p) => [p, round(v.lrP[p] + v.busP[p])])) }])),
    tThird: {
      purpose: purpose('t'),
      tripEndsByDistrict: names.map((n, k) => ({ district: n, daily: +(tEnds[k] / tt).toFixed(3), am: +(tEndsAM[k] / ta).toFixed(3) })),
      access: Object.fromEntries(Object.entries(access).map(([k, v]) => [k, +(v / accTot).toFixed(3)])),
      boardings: round(accTot),
      byStop: [...byName].sort((a, c) => c[1] - a[1]).slice(0, 15).map(([n, v]) => ({ stop: n, boardings: round(v) })),
      note: "Trip ends: the destination zone of each T rider's trip, all day (over a day of round trips this is also where they come from) and in the morning peak (mostly workplaces and schools). Access: the mix of riders arriving at the boarding node of each T stop, on foot or from another line.",
    },
  };
}

// ---------- reference ----------
export interface OdRef {
  ctppWorkplace?: { source: string; tracts: { tract: string; workers: number; wfh: number; transit: number; drive: number }[] };
  snapshot?: Record<string, Record<string, Record<string, number>>>;
  bartProfile2024?: Record<string, { homeOriginShare: number; homeAccessTransit: number }>;
  muni2017TransfersBefore?: Record<string, number>;
  inCommutersByPuma?: { pumas: { puma: string; commuters: number; transitShare: number; transitShareSE: number; bartShare: number }[]; tractCentroids: [number, number, string][] };
  [k: string]: unknown;
}
export const readOdRef = (): OdRef => (fs.existsSync(`${REFERENCE}/od-validation.json`) ? JSON.parse(fs.readFileSync(`${REFERENCE}/od-validation.json`, 'utf8')) : {});

export async function odChecks(b: Bundle, calib: Calibration, prep: Prep, crowd: Crowd, parts = ['bart', 'commute', 'riders']) {
  const st = await modelState(b, calib, prep, crowd);
  const ref = readOdRef();
  return {
    bart: parts.includes('bart') ? bartOD(st) : null,
    commute: parts.includes('commute') ? commuteOD(st, ref) : null,
    inCommuters: parts.includes('commute') ? inCommutersByPuma(st, ref) : null,
    riders: parts.includes('riders') ? await riders(st, ref) : null,
  };
}

if (process.argv[1]?.endsWith('od-checks.ts')) {
  (async () => {
    const t0 = Date.now();
    const b = loadBundle();
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
    const f = process.argv[2] ?? '/tmp/od-checks.json';
    const r = await odChecks(b, b.header.calibration!, prepare(b), base.finalCrowd, process.argv[3]?.split(','));
    fs.writeFileSync(f, JSON.stringify(r, null, 1));
    console.log(`written ${f} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (!r.bart) return;
    const d = r.bart.daily;
    console.log(`BART daily station×group×direction: r ${d.r.toFixed(3)}, %RMSE ${d.pctRmse.toFixed(0)}, total ${(100 * (d.totalRatio - 1)).toFixed(1)}%`);
    for (const [k, v] of Object.entries(r.bart.perPeriod)) console.log(`  ${k}: r ${v.r.toFixed(3)} %RMSE ${v.pctRmse.toFixed(0)} total ${(100 * (v.totalRatio - 1)).toFixed(0)}%`);
    console.log(r.bart.byGroup.map((x) => `${x.key} ${x.observed} ${x.model} ${x.pct}%`).join('\n'));
  })();
}
