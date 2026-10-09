/**
 * Diagnostic: how long the model's transit trips are, and which short trips it misses.
 *  1. Residents' trips inside the city with one end at home, by mode and road distance, against the
 *     NHTS 2017 (reference/nhts-transit-length.json; dense tracts of the SF–Oakland metro): the direct
 *     legs of tours, then every leg (with those through stops) with a home end and without one; and
 *     how far tours go by purpose and how far out of the way their stops are, against NHTS tours
 *     (reference/nhts-tours.json).
 *  2. Linked transit trips by market and road distance, and their mean.
 *  3. Each market's Muni boardings and miles per boarding (buses and Metro), assigned on its own at
 *     the base run's crowding (assignment is linear in demand at fixed costs), against NTD.
 *  4. What a transit trip costs in mode choice by distance (midday): its perceived minutes and their
 *     parts (walking, waiting, riding, the reliability term route choice adds), against walking.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-length.ts [--json out.json] [--no-assign] [--demand personShares=0]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DEMAND_OPTS, LENGTH_BANDS_MI, lengthBand } from '../../../shared/beta3/demand';
import { buildNet, C_IVTP, C_REL, C_WAIT, C_WALK, C_BIAS, C_BOARDS, LINK_BOARD, LINK_RIDE, NC } from '../../../shared/beta3/net';
import { assignColumns, hopKm, prepare } from '../../../shared/beta3/model';
import { MODES, PATH } from '../../../shared/beta3/params';
import { decodeResult } from '../../../shared/beta3/results';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';
import { modelState } from './od-checks';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const NB = LENGTH_BANDS_MI.length;
const bandLabel = LENGTH_BANDS_MI.map((b, i) => (b === Infinity ? `>${LENGTH_BANDS_MI[i - 1]}` : `≤${b}`));
const pct = (x: number) => (100 * x).toFixed(1).padStart(6);

async function main() {
  for (const kv of arg('--demand', '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    (DEMAND_OPTS as Record<string, boolean>)[k] = v === '1' || v === 'true';
  }
  const b = loadBundle();
  const H = b.header;
  const NZ = H.zones.length, NX = H.ext.length, ZT = NZ + 2 * NX;
  const calib = H.calibration!;
  const prep = prepare(b);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const st = await modelState(b, calib, prep, base.finalCrowd);
  const autoDm = b.a.autoDm as Uint16Array;
  const walkSec = b.a.walkSec as Uint16Array;
  const out: Record<string, unknown> = { bandsMi: LENGTH_BANDS_MI.map((x) => (x === Infinity ? null : x)) };

  // ---- 1. mode by distance, residents' trips from or to home ----
  const LB = st.demand.lengthBands ?? {};
  const ref = fs.existsSync(`${REFERENCE}/nhts-transit-length.json`) ? JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-transit-length.json`, 'utf8')) : null;
  const sumKeys = (f: (k: string) => boolean) => {
    const t = new Float64Array(NB * 6);
    for (const [k, a] of Object.entries(LB)) if (f(k)) for (let i = 0; i < a.length; i++) t[i] += a[i];
    return t;
  };
  const table = (title: string, t: Float64Array, obs?: Record<string, number[]>) => {
    const tot = Array.from({ length: NB }, (_, k) => MODES.reduce((a, _m, m) => a + t[k * 6 + m], 0));
    const T = tot.reduce((a, v) => a + v, 0);
    console.log(`\n== ${title} (${Math.round(T).toLocaleString()} trips)`);
    console.log(`band (road mi)  ${bandLabel.map((x) => x.padStart(6)).join('')}`);
    console.log(`all modes, dist ${tot.map((v) => pct(v / T)).join('')}`);
    const rows: Record<string, number[]> = { dist: tot.map((v) => v / T) };
    for (const m of ['walk', 'transit', 'da', 'sr', 'tnc', 'bike']) {
      const mi = MODES.indexOf(m as never);
      const sh = tot.map((v, k) => (v > 0 ? t[k * 6 + mi] / v : 0));
      rows[m] = sh;
      console.log(`${m.padEnd(8)} share  ${sh.map(pct).join('')}   total ${pct(sh.reduce((a, s, k) => a + s * tot[k], 0) / T)}`);
      if (obs?.[m === 'da' || m === 'sr' ? 'car' : m] && m !== 'sr') console.log(`${'  NHTS'.padEnd(8)}        ${obs[m === 'da' ? 'car' : m].map(pct).join('')}${m === 'da' ? '   (car: drive alone and carpool)' : ''}`);
    }
    const tr = MODES.indexOf('transit');
    const TT = Array.from({ length: NB }, (_, k) => t[k * 6 + tr]);
    const TS = TT.reduce((a, v) => a + v, 0);
    console.log(`transit dist    ${TT.map((v) => pct(v / TS)).join('')}`);
    if (obs?.transitDist) console.log(`  NHTS          ${obs.transitDist.map(pct).join('')}`);
    rows.transitDist = TT.map((v) => v / TS);
    return { trips: T, ...rows };
  };
  const nh = ref?.homeBased?.byBand;
  const res: Record<string, unknown> = {};
  res.homeBased = table("residents' trips from or to home (direct legs; work and other purposes)", sumKeys((k) => k.startsWith('resident work') || k.startsWith('resident home-based')), nh);
  for (const s of ['car0', 'car1', 'car2']) res[s] = table(`  … households with ${s === 'car0' ? 'no car' : s === 'car1' ? 'one car' : 'two or more cars'}`, sumKeys((k) => (k.startsWith('resident work') || k.startsWith('resident home-based')) && k.includes(` ${s}`)), s === 'car0' ? ref?.zeroCar?.byBand : s === 'car1' ? undefined : undefined);
  res.nonWork = table("residents' non-work trips from or to home", sumKeys((k) => k.startsWith('resident home-based')));
  res.work = table("residents' commutes", sumKeys((k) => k.startsWith('resident work')));
  res.stopLegs = table("residents' transit tours' legs through a stop (ridden or walked)", sumKeys((k) => k.startsWith('resident stop legs') && k.endsWith(' transit')));
  // every leg: those through stops count as the NHTS counts them (home to a stop is home-based)
  const ae = ref?.anyEnd;
  const isHome = (k: string) => k.startsWith('resident work') || k.startsWith('resident home-based') || k.startsWith('resident stop legs home');
  const isOther = (k: string) => k.startsWith('resident stop legs other') || k === 'resident subtours';
  res.homeBasedAll = table("residents' trips with a home end, every leg (NHTS: ends of any density)", sumKeys(isHome), ae?.homeBased);
  res.notHomeBasedAll = table("residents' trips without a home end (legs through stops, work subtours)", sumKeys(isOther), ae?.notHomeBased);
  res.allLegs = table("all residents' trips in the city", sumKeys((k) => isHome(k) || isOther(k)), ae?.all);
  // how far tours go (home to the primary destination) and stops' detours, against NHTS tours
  {
    const tours = fs.existsSync(`${REFERENCE}/nhts-tours.json`) ? JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-tours.json`, 'utf8')) : null;
    const KB = st.demand.kmBands;
    console.log(`\n== how far tours go and stops' detours: shares by road miles (${bandLabel.join(' ')}), and within one zone`);
    const rows: Record<string, { model: number[]; intrazonal: number; nhts: number[] | null; sample: number | null }> = {};
    const show = (k: string, obs: number[] | null, n: number | null) => {
      const m = KB[k];
      if (!m) return;
      rows[k] = { model: m.slice(0, NB), intrazonal: m[NB], nhts: obs, sample: n };
      console.log(`${k.padEnd(14)} model ${m.slice(0, NB).map(pct).join('')}   within a zone ${pct(m[NB])}`);
      if (obs) console.log(`${''.padEnd(14)} NHTS  ${obs.map(pct).join('')}   (${n} sampled)`);
    };
    for (const p of ['work', 'school', 'univ', 'shop', 'other', 'social']) show(p, tours?.byTourPurpose?.[p]?.primaryBandsDense ?? null, tours?.byTourPurpose?.[p]?.primarySampleDense ?? null);
    for (const p of ['nhb', 'visitor']) show(p, null, null);
    for (const c of ['car', 'transit', 'walk', 'bike']) show(`stop:${c}`, tours?.byTourMode?.[c]?.detourBandsDense ?? null, tours?.byTourMode?.[c]?.detourSampleDense ?? null);
    out.tourLengths = rows;
  }
  res.subtours = table("residents' work subtours", sumKeys((k) => k === 'resident subtours'));
  res.visitor = table('hotel visitors', sumKeys((k) => k === 'visitor'));
  res.nhb = table("in-commuters' and visitors' trips not from home", sumKeys((k) => k === 'nhb'));
  out.modeByDistance = res;

  // ---- 2. linked transit trips by market and distance ----
  const markets = Object.entries(st.markets).filter(([k]) => !k.startsWith('work '));
  const mk: Record<string, { trips: number; internal: number; dist: number[]; meanMi: number }> = {};
  console.log(`\n== linked transit trips by market: road distance inside the city (${bandLabel.join(' ')} mi)`);
  const all = { trips: 0, internal: 0, d: new Float64Array(NB), mi: 0 };
  for (const [k, byP] of markets) {
    let trips = 0, internal = 0, mi = 0;
    const d = new Float64Array(NB);
    for (const p of TPERIODS) {
      const od = byP[p];
      if (!od) continue;
      for (let o = 0; o < ZT; o++)
        for (let q = 0; q < ZT; q++) {
          const v = od[o * ZT + q];
          if (!(v > 0)) continue;
          trips += v;
          if (o < NZ && q < NZ) {
            const m = autoDm[o * NZ + q] / 160.934;
            internal += v;
            mi += v * m;
            d[lengthBand(m)] += v;
          }
        }
    }
    all.trips += trips;
    all.internal += internal;
    all.mi += mi;
    d.forEach((v, i) => (all.d[i] += v));
    mk[k] = { trips, internal, dist: Array.from(d, (v) => v / internal), meanMi: mi / internal };
    console.log(`${k.padEnd(30)} ${Math.round(trips).toString().padStart(7)} (in city ${Math.round(internal).toString().padStart(7)}), mean ${(mi / internal).toFixed(2)} mi | ${Array.from(d, (v) => pct(v / internal)).join('')}`);
  }
  console.log(`${'all'.padEnd(30)} ${Math.round(all.trips).toString().padStart(7)} (in city ${Math.round(all.internal).toString().padStart(7)}), mean ${(all.mi / all.internal).toFixed(2)} mi | ${Array.from(all.d, (v) => pct(v / all.internal)).join('')}`);
  if (ref?.transitTrips) console.log(`NHTS 2017 transit trips (dense tracts, ≤12 mi), mean ${ref.transitTrips.meanMi.toFixed(2)} mi | ${ref.transitTrips.dist.map(pct).join('')}`);
  out.transitByMarket = mk;
  out.transitAll = { trips: all.trips, internal: all.internal, meanMi: all.mi / all.internal, dist: Array.from(all.d, (v) => v / all.internal) };

  // ---- 3. Muni boardings and miles per boarding by market ----
  if (!process.argv.includes('--no-assign')) {
    const hk = hopKm(b);
    const crowdArr = (p: TPeriod) => {
      const net0 = buildNet(b, { name: 'Today', edits: [] }, p, calib);
      return net0.lines.map((l) => (l.src >= 0 && base.finalCrowd?.[p]?.[l.src]?.length === l.stops.length - 1 ? base.finalCrowd[p][l.src] : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1)));
    };
    const nets = Object.fromEntries(TPERIODS.map((p) => [p, buildNet(b, { name: 'Today', edits: [] }, p, calib, crowdArr(p))])) as Record<TPeriod, ReturnType<typeof buildNet>>;
    const dests = [...Array(ZT).keys()];
    const rows: Record<string, { trips: number; muni: number; bus: [number, number]; metro: [number, number]; all: number }> = {};
    console.log('\n== Muni boardings by market (each assigned alone at the base crowding)');
    let T = { muni: 0, bus: [0, 0], metro: [0, 0] };
    for (const [k, byP] of markets) {
      const r = { trips: mk[k].trips, muni: 0, bus: [0, 0] as [number, number], metro: [0, 0] as [number, number], all: 0 };
      for (const p of TPERIODS) {
        const od = byP[p];
        if (!od) continue;
        const net = nets[p];
        const vol = assignColumns(net, od, dests, ZT);
        for (let a = 0; a < net.nLinks; a++) {
          const v = vol[a];
          if (!v) continue;
          const t = net.type[a];
          if (t !== LINK_BOARD && t !== LINK_RIDE) continue;
          const l = net.lines[net.line[a]];
          if (t === LINK_BOARD) r.all += v;
          if (l.feed !== 'muni' || l.mode === 'cablecar' || l.mode === 'streetcar') {
            if (t === LINK_BOARD && l.feed === 'muni') r.muni += v;
            continue;
          }
          const g = l.mode === 'lightrail' ? r.metro : r.bus;
          if (t === LINK_BOARD) (r.muni += v), (g[0] += v);
          else {
            const along = l.src >= 0 ? hk[l.src] : null;
            const sa = H.stops[l.stops[net.pos[a]]], sb = H.stops[l.stops[net.pos[a] + 1]];
            g[1] += (v * (along ? along[net.pos[a]] : Math.hypot(sb.x - sa.x, sb.y - sa.y) / 1000)) / 1.609;
          }
        }
      }
      rows[k] = r;
      T.muni += r.muni;
      T.bus[0] += r.bus[0];
      T.bus[1] += r.bus[1];
      T.metro[0] += r.metro[0];
      T.metro[1] += r.metro[1];
      console.log(`${k.padEnd(30)} trips ${Math.round(r.trips).toString().padStart(7)}  Muni boardings ${Math.round(r.muni).toString().padStart(7)} (${(r.muni / Math.max(1, r.trips)).toFixed(2)}/trip)  mi/boarding bus ${(r.bus[1] / Math.max(1, r.bus[0])).toFixed(2)}, Metro ${(r.metro[1] / Math.max(1, r.metro[0])).toFixed(2)}`);
    }
    console.log(`${'all'.padEnd(30)} Muni boardings ${Math.round(T.muni)}; mi/boarding bus ${(T.bus[1] / T.bus[0]).toFixed(2)} (NTD 1.89), Metro ${(T.metro[1] / T.metro[0]).toFixed(2)} (NTD 2.34)`);
    out.muniByMarket = rows;
  }

  // ---- 4. the cost of a short transit trip (midday), by distance ----
  {
    const p: TPeriod = 'MD';
    const crowd = (() => {
      const net0 = buildNet(b, { name: 'Today', edits: [] }, p, calib);
      return net0.lines.map((l) => (l.src >= 0 && base.finalCrowd?.[p]?.[l.src]?.length === l.stops.length - 1 ? base.finalCrowd[p][l.src] : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1)));
    })();
    const net = buildNet(b, { name: 'Today', edits: [] }, p, calib, crowd);
    const solver = new StrategySolver(net);
    const C = solver.C;
    const odMD = st.demand.transitOD.MD;
    // trip-weighted (each pair by its midday transit trips) and pair-weighted means, by band
    const acc = Array.from({ length: NB }, () => ({ w: 0, n: 0, walk: 0, wait: 0, ivtp: 0, bias: 0, rel: 0, xfers: 0, g: 0, walkAlt: 0, pairs: 0, gP: 0, walkP: 0 }));
    for (let d = 0; d < NZ; d++) {
      solver.solve(d);
      for (let o = 0; o < NZ; o++) {
        if (o === d || solver.label(o) === Infinity) continue;
        const c = o * NC;
        const mi = autoDm[o * NZ + d] / 160.934;
        const k = lengthBand(mi);
        const g = C[c + C_IVTP] + PATH.waitWeight * C[c + C_WAIT] + PATH.walkWeight * C[c + C_WALK] + C[c + C_BIAS];
        const w = walkSec[o * NZ + d] / 60;
        const A = acc[k];
        A.pairs++;
        A.gP += g;
        A.walkP += w;
        const v = odMD[o * ZT + d];
        if (!(v > 0)) continue;
        A.w += v;
        A.walk += v * C[c + C_WALK];
        A.wait += v * C[c + C_WAIT];
        A.ivtp += v * C[c + C_IVTP];
        A.bias += v * C[c + C_BIAS];
        A.rel += v * C[c + C_REL];
        A.xfers += v * Math.max(0, C[c + C_BOARDS] - 1);
        A.g += v * g;
        A.walkAlt += v * w;
      }
    }
    console.log('\n== midday transit cost by distance (minutes; trip-weighted over the pairs riders use, then all pairs)');
    console.log('band     walk  wait  ride(perc)  bias  rel(route only)  changes  g(mode choice)  walking-all-the-way | all pairs: g  walk');
    const cost = acc.map((A, k) => {
      const f = (x: number) => (A.w > 0 ? x / A.w : NaN);
      console.log(`${bandLabel[k].padEnd(6)} ${f(A.walk).toFixed(1).padStart(5)} ${f(A.wait).toFixed(1).padStart(5)} ${f(A.ivtp).toFixed(1).padStart(10)} ${f(A.bias).toFixed(1).padStart(5)} ${f(A.rel).toFixed(1).padStart(16)} ${f(A.xfers).toFixed(2).padStart(8)} ${f(A.g).toFixed(1).padStart(15)} ${f(A.walkAlt).toFixed(1).padStart(20)} | ${(A.gP / A.pairs).toFixed(1).padStart(6)} ${(A.walkP / A.pairs).toFixed(1).padStart(5)}`);
      return { band: bandLabel[k], trips: A.w, walk: f(A.walk), wait: f(A.wait), ivtp: f(A.ivtp), bias: f(A.bias), rel: f(A.rel), changes: f(A.xfers), g: f(A.g), walkAllTheWay: f(A.walkAlt), pairs: A.pairs, gAllPairs: A.gP / A.pairs, walkAllPairs: A.walkP / A.pairs };
    });
    out.middayCost = cost;
  }

  // residents' transit trips by household cars (linked; tours and their legs) against surveys
  {
    const tr = (s: string) => st.demand.workBySeg[s].transit + st.demand.nonworkBySeg[s].transit;
    const tot = ['car0', 'car1', 'car2'].reduce((a, s) => a + tr(s), 0);
    console.log(`\nresidents' transit tours' legs by household cars: ${['car0', 'car1', 'car2'].map((s) => `${s} ${pct(tr(s) / tot)}%`).join(', ')}`);
    out.transitBySeg = Object.fromEntries(['car0', 'car1', 'car2'].map((s) => [s, tr(s) / tot]));
    const inc = st.demand.byIncome.map((m) => m.transit);
    const it = inc.reduce((a, v) => a + v, 0);
    console.log(`residents' (adults') transit tour legs by income class: ${inc.map((v) => pct(v / it)).join(' ')}`);
  }
  const jf = arg('--json', '');
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
