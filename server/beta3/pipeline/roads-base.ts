/**
 * Today's traffic: the base run's vehicle trips (the calibrated model's, with ride-hail's empty
 * legs), commercial vehicles (SF-CHAMP's commercial vehicle model), and, fitted to Caltrans' counts
 * where the roads cross the city line, the traffic the model does not make (through trips, trucks
 * and other outside traffic); assigned to equilibrium each period, then checked against counts and
 * speeds that played no part: Caltrans' counts inside the city, SFMTA's counts, SFCTA's CMP speeds.
 * On the Peninsula freeways (roads.ts), each segment's fixed background is what its counts carry
 * beyond the model's own cars, period by period and direction by direction, and its capacity is
 * fitted to INRIX's peak speeds where C/CAG reports them, in each peak (fitPeninsula).
 * Writes client/beta3/model/roads.bin.gz (network, today's flows and trips, in both run modes) and
 * server/beta3/reference/road-validation.json.
 *
 * Run (after baseline.ts and roads.ts; part of npm run model:calibrate, so today's traffic, the warm
 * start of every scenario's assignment, is made again with each new baseline): NODE_OPTIONS=--max-old-space-size=4096 npx tsx server/beta3/pipeline/roads-base.ts [--refresh]
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { bundleId, decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { CAP_FACTOR, dequantise, equilibrium, linkTimes, localAon, periodRoads, quantise, RCLS, roadNetFrom, summariseRoads, warmFlows, type RoadHeader, type RoadNet } from '../../../shared/beta3/roads';
import { COMMERCIAL, commercialOD, modelVehicleOD } from '../../../shared/beta3/traffic';
import { TPERIODS, type Scenario, type TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, RAW, REFERENCE, WORK } from './paths';
import type { RunMode } from '../../../shared/beta3/runmode';
import { toXY } from '../../../shared/beta3/geo';
import { loadBundle } from './run-base';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

function loadNet(): RoadNet {
  const b = decodeBundle(fs.readFileSync(`${WORK}/roads-net.bin`));
  return roadNetFrom(b.header as unknown as RoadHeader, b.a);
}

async function main() {
  console.time('roads-base');
  const B = loadBundle();
  const H = B.header;
  const calib = H.calibration!;
  const net = loadNet();
  const { nC, nZ: NZ, nX: NX } = net.h;
  const ZA = NZ + NX;
  const NG = net.h.gateways.length;

  // ---------- the base run's vehicle trips (in each run mode) ----------
  const baseTrips = async (mode: RunMode) => {
    const cache = `${WORK}/roads-base-demand${mode === 'quick' ? '-quick' : ''}.bin`;
    // the cached trips belong to one baseline (and bundle): made again when either changes
    const baseKey = createHash('sha1').update(fs.readFileSync(`${BUNDLE}/base.bin.gz`)).update(fs.readFileSync(`${BUNDLE}/sf.bin.gz`)).update(mode).digest('hex');
    const cached = fs.existsSync(cache) ? decodeBundle(fs.readFileSync(cache)) : null;
    if (cached && (cached.header as unknown as { baseKey?: string }).baseKey === baseKey && !process.argv.includes('--refresh')) {
      const c = cached;
      return { autoOD: Object.fromEntries(TPERIODS.map((p) => [p, c.a[`od_${p}`] as Float32Array])) as Record<TPeriod, Float32Array>, tncEnds: Object.fromEntries(TPERIODS.map((p) => [p, c.a[`tnc_${p}`] as Float64Array])) as Record<TPeriod, Float64Array> };
    }
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
    const sc: Scenario = { name: 'Today', edits: [], runMode: mode };
    console.log(`running today’s network (${mode}: one pass from the saved crowding, as the baseline)...`);
    const r = await runModel(B, sc, calib, new LocalExecutor(B, sc, calib), { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice, autoOD: true }, prepare(B));
    const out = { autoOD: r.demand.autoOD! as Record<TPeriod, Float32Array>, tncEnds: r.demand.tncEnds! as Record<TPeriod, Float64Array> };
    const arrays: Record<string, Float32Array | Float64Array> = {};
    for (const p of TPERIODS) (arrays[`od_${p}`] = out.autoOD[p]), (arrays[`tnc_${p}`] = out.tncEnds[p]);
    fs.writeFileSync(cache, encodeBundle({ version: 1, baseKey } as never, arrays));
    return out;
  };
  const { autoOD, tncEnds } = await baseTrips('precise');
  const sumOf = (a: ArrayLike<number>) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s;
  };
  console.log(`model vehicle trips by period: ${TPERIODS.map((p) => `${p} ${Math.round(sumOf(autoOD[p])).toLocaleString()}`).join(', ')}`);

  // the model's trips (and ride-hail's empty legs) as centroid matrices
  const modelOD = {} as Record<TPeriod, Float32Array>;
  for (const p of TPERIODS) {
    const od = modelVehicleOD(B, nC, NZ, NX, autoOD[p], tncEnds[p]);
    if (p === 'AM') console.log(`ride-hail: ${Math.round(tncEnds[p][2 * ZA + 1]).toLocaleString()} trips in the AM, ${(tncEnds[p][2 * ZA] / tncEnds[p][2 * ZA + 1]).toFixed(1)} km each; empty legs ${Math.round(sumOf(od) - sumOf(autoOD[p])).toLocaleString()}`);
    modelOD[p] = od;
  }

  // ---------- commercial vehicles ----------
  const comm = commercialOD(B, nC);
  const commTrips = comm.trips;
  console.log(`commercial vehicles: ${Math.round(commTrips).toLocaleString()} trips a weekday`);

  // ---------- assign the model's trips and commercial vehicles ----------
  const aon = localAon(net);
  const gapFit = Number(arg('--gap-fit', '1e-3'));
  const first = {} as Record<TPeriod, Float64Array>;
  const odFirst = {} as Record<TPeriod, Float32Array>;
  // the Peninsula freeways start with all their counted traffic as background
  const pen = net.h.peninsula;
  if (pen) for (const p of TPERIODS) net.pre[p] = Float32Array.from({ length: net.h.nLinks }, () => 0);
  if (pen) for (const sg of pen.segments) for (const p of TPERIODS) net.pre[p]![sg.link] = sg.target![p];
  for (const p of TPERIODS) {
    const od = new Float32Array(nC * nC);
    for (let i = 0; i < od.length; i++) od[i] = modelOD[p][i] + comm.od[p][i];
    const R = periodRoads(net, p);
    const t0 = Date.now();
    const eq = await equilibrium(R, od, aon, { gap: gapFit, maxIter: 200 });
    console.log(`${p}: ${Math.round(sumOf(od)).toLocaleString()} vehicle trips, gap ${eq.gap.toExponential(2)} after ${eq.iterations} iterations, ${((Date.now() - t0) / 1000).toFixed(1)} s (${((Date.now() - t0) / 1000 / (eq.iterations + 1)).toFixed(2)} s an iteration); lost ${eq.lost.toFixed(0)}`);
    first[p] = eq.flow;
    odFirst[p] = od;
  }
  // the background under the model's cars, and the capacities, settled with the model's routes
  // (each round: background from the counts less the model's cars, capacities fitted to the speeds,
  // the model's cars assigned again)
  if (pen)
    for (let round = 0; round < 3; round++) {
      setBackground(net, first);
      fitPeninsula(net);
      for (const p of TPERIODS) {
        const R = periodRoads(net, p);
        const eq = await equilibrium(R, odFirst[p], aon, { gap: gapFit, maxIter: 200, warm: first[p] });
        first[p] = eq.flow;
      }
      console.log(`peninsula round ${round + 1}: ${peninsulaFit(net, first)}`);
    }

  // ---------- fit the background to the counts at the city line ----------
  const counts = net.h.counts;
  // each city-line count's gateway, by route
  const GW_OF: [RegExp, RegExp][] = [
    [/^101-0$/, /^US 101/],
    [/^280-0$/, /^I 280/],
    [/^035-/, /^CA 35/],
    [/^082-/, /^CA 82/],
    [/^080-/, /^Bay Bridge/],
    [/^101-9/, /^Golden Gate/],
  ];
  const gwOfCount = (c: (typeof counts)[number]) => {
    const m = GW_OF.find(([id]) => id.test(c.id));
    if (m) return net.h.gateways.findIndex((g) => m[1].test(g.name));
    const k = c.links[0];
    const lat = net.nodeLat[net.a[k]],
      lon = net.nodeLon[net.a[k]];
    let best = -1,
      bd = 3000;
    net.h.gateways.forEach((g, i) => {
      const d = Math.hypot((g.lat - lat) * 111000, (g.lon - lon) * 88000);
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  };
  const daily = (flows: Record<TPeriod, ArrayLike<number>>, links: number[]) => links.reduce((a, k) => a + TPERIODS.reduce((s, p) => s + flows[p][k], 0), 0);
  const fitted = counts.filter((c) => c.fitted).map((c) => ({ c, g: gwOfCount(c), model: daily(first, c.links) }));
  // one count per gateway (the nearest to it)
  const byGw = new Map<number, (typeof fitted)[number]>();
  for (const f of fitted) {
    if (f.g < 0) continue;
    const prev = byGw.get(f.g);
    if (!prev) byGw.set(f.g, f);
  }
  const resid = new Float64Array(NG);
  for (const [g, f] of byGw) resid[g] = Math.max(0, f.c.daily - f.model);
  console.log(`city-line counts (daily, both ways; model before the background): ${[...byGw].map(([g, f]) => `${net.h.gateways[g].name} ${Math.round(f.model / 1000)}k/${Math.round(f.c.daily / 1000)}k`).join(', ')}`);
  // the time-of-day and direction profile of the model's own trips across each gateway (hub links)
  const hubIn = (g: number) => nC + 2 * g,
    hubOut = (g: number) => nC + 2 * g + 1;
  const prof = Array.from({ length: NG }, () => ({ in: {} as Record<TPeriod, number>, out: {} as Record<TPeriod, number> }));
  for (let k = 0; k < net.h.nLinks; k++) {
    const a = net.a[k],
      b = net.b[k];
    for (let g = 0; g < NG; g++) {
      // flows leaving the in-hub onto the streets, and arriving at the out-hub
      if (a === hubIn(g) && b >= nC + 2 * NG) for (const p of TPERIODS) prof[g].in[p] = (prof[g].in[p] ?? 0) + first[p][k];
      if (b === hubOut(g) && a >= nC + 2 * NG) for (const p of TPERIODS) prof[g].out[p] = (prof[g].out[p] ?? 0) + first[p][k];
    }
  }
  const share = (r: Record<TPeriod, number>) => {
    const t = TPERIODS.reduce((s, p) => s + (r[p] ?? 0), 0);
    return Object.fromEntries(TPERIODS.map((p) => [p, t > 0 ? (r[p] ?? 0) / t : 0.25])) as Record<TPeriod, number>;
  };
  const bg = {} as Record<TPeriod, Float32Array>;
  for (const p of TPERIODS) bg[p] = Float32Array.from(comm.od[p]);
  // through traffic: each bridge's counted traffic times its through share, from the ACS county-to-
  // county commuting flows (reference/through-traffic.json), leaving by US-101 and I-280 in
  // proportion to their counts (each direction half)
  const TT = JSON.parse(fs.readFileSync(`${REFERENCE}/through-traffic.json`, 'utf8')) as { throughShare: Record<string, number> };
  const south = [...byGw.keys()].filter((g) => /^(US 101|I 280)/.test(net.h.gateways[g].name));
  const southCount = south.reduce((a, g) => a + byGw.get(g)!.c.daily, 0);
  const XX = new Float64Array(NG * NG);
  for (const [g, f] of byGw) {
    const sh = Object.entries(TT.throughShare).find(([k]) => net.h.gateways[g].name.startsWith(k))?.[1];
    if (!sh) continue;
    const trips = sh * f.c.daily; // crossings of the bridge a day, both directions
    for (const h of south) {
      const w = byGw.get(h)!.c.daily / southCount;
      XX[g * NG + h] += (trips / 2) * w;
      XX[h * NG + g] += (trips / 2) * w;
    }
  }
  const big = [...byGw.keys()];
  const xxAt = new Float64Array(NG);
  for (const i of big) for (const j of big) xxAt[i] += XX[i * NG + j] + XX[j * NG + i];
  const bgSummary: Record<string, number> = { commercial: Math.round(commTrips) };
  for (const i of big)
    for (const j of big) {
      const v = XX[i * NG + j];
      if (!(v > 0)) continue;
      // through trips go out by j's out profile and in by i's in profile: average the two
      const si = share(prof[i].in),
        sj = share(prof[j].out);
      for (const p of TPERIODS) bg[p][net.h.gateways[i].centroid * nC + net.h.gateways[j].centroid] += v * 0.5 * (si[p] + sj[p]);
      bgSummary.through = (bgSummary.through ?? 0) + v;
    }
  // the rest of each gateway's residual: trips into and out of the city, spread over its zones as
  // the model's own trips across that gateway are (by the outside zones that use it most)
  const ext = net.h.gateways.map(() => ({ inZ: new Float64Array(NZ), outZ: new Float64Array(NZ) }));
  {
    // each outside zone's main gateway: the one carrying most of its AM flow (its cheapest leg)
    const legs: { e: number; g: number; t: number }[] = [];
    for (let k = 0; k < net.h.nLinks; k++) {
      const a = net.a[k];
      if (a < NZ || a >= ZA) continue;
      for (let g = 0; g < NG; g++) if (net.b[k] === hubIn(g)) legs.push({ e: a - NZ, g, t: net.t0[k] });
    }
    const main = new Int32Array(NX).fill(-1);
    const bestT = new Float64Array(NX).fill(Infinity);
    for (const l of legs) if (l.t < bestT[l.e]) (bestT[l.e] = l.t), (main[l.e] = l.g);
    for (const p of TPERIODS)
      for (let e = 0; e < NX; e++) {
        const g = main[e];
        if (g < 0) continue;
        for (let z = 0; z < NZ; z++) {
          ext[g].inZ[z] += autoOD[p][(NZ + e) * ZA + z];
          ext[g].outZ[z] += autoOD[p][z * ZA + NZ + e];
        }
      }
  }
  for (const [g, f] of byGw) {
    const rest = Math.max(0, resid[g] - xxAt[g]);
    bgSummary[`ix:${net.h.gateways[g].name}`] = Math.round(rest);
    if (!(rest > 0)) continue;
    const c = net.h.gateways[g].centroid;
    const si = share(prof[g].in),
      so = share(prof[g].out);
    const ti = ext[g].inZ.reduce((a, v) => a + v, 0),
      to = ext[g].outZ.reduce((a, v) => a + v, 0);
    for (let z = 0; z < NZ; z++)
      for (const p of TPERIODS) {
        if (ti > 0) bg[p][c * nC + z] += (rest / 2) * (ext[g].inZ[z] / ti) * si[p];
        if (to > 0) bg[p][z * nC + c] += (rest / 2) * (ext[g].outZ[z] / to) * so[p];
      }
    void f;
  }
  console.log(`background: ${Object.entries(bgSummary).map(([k, v]) => `${k} ${Math.round(v).toLocaleString()}`).join(', ')}`);

  // ---------- today's equilibrium, on the quantised trips the page will use ----------
  const gapBase = Number(arg('--gap', '1e-4'));
  const baseFlow = {} as Record<TPeriod, Float64Array>,
    baseTime = {} as Record<TPeriod, Float64Array>;
  const qOD = {} as Record<TPeriod, Uint16Array>,
    qBG = {} as Record<TPeriod, Uint16Array>;
  const gaps = {} as Record<TPeriod, number>,
    iters = {} as Record<TPeriod, number>,
    vehicles = {} as Record<TPeriod, number>;
  const odBase = {} as Record<TPeriod, Float32Array>;
  for (const p of TPERIODS) {
    // stored quantised: the model's trips and the background apart (traffic.ts adds them)
    qOD[p] = Uint16Array.from(modelOD[p], quantise);
    qBG[p] = Uint16Array.from(bg[p], quantise);
    const od = new Float32Array(nC * nC);
    for (let i = 0; i < od.length; i++) od[i] = (qOD[p][i] ? dequantise(qOD[p][i]) : 0) + (qBG[p][i] ? dequantise(qBG[p][i]) : 0);
    vehicles[p] = sumOf(od);
    const R = periodRoads(net, p);
    const t0 = Date.now();
    const warm = await warmFlows(R, first[p], odFirst[p], od, aon);
    const eq = await equilibrium(R, od, aon, { gap: gapBase, maxIter: 400, warm });
    baseFlow[p] = eq.flow;
    baseTime[p] = eq.time;
    gaps[p] = eq.gap;
    iters[p] = eq.iterations;
    odBase[p] = od;
    console.log(`today ${p}: ${Math.round(vehicles[p]).toLocaleString()} vehicles, gap ${eq.gap.toExponential(2)} after ${eq.iterations} iterations (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  // the Peninsula background once more under today's own cars (the gateways' background moved them
  // a little), and today's equilibrium again to the same gap
  // (until the model's own cars stop moving: each direction within 0.5% of its count, or six rounds)
  if (pen)
    for (let round = 0; round < 6; round++) {
      if (round > 0 && dirResidual(net, baseFlow) < 0.005) break;
      setBackground(net, baseFlow);
      for (const p of TPERIODS) {
        const R = periodRoads(net, p);
        const eq = await equilibrium(R, odBase[p], aon, { gap: gapBase, maxIter: 400, warm: baseFlow[p] });
        baseFlow[p] = eq.flow;
        baseTime[p] = eq.time;
        gaps[p] = eq.gap;
        iters[p] = eq.iterations;
      }
      console.log(`peninsula, today's equilibrium (round ${round + 1}): ${peninsulaFit(net, baseFlow)}, each way within ${(100 * dirResidual(net, baseFlow)).toFixed(2)}% where both have a background; gaps ${TPERIODS.map((p) => gaps[p].toExponential(1)).join('/')}`);
    }

  // ---------- today in the Quick run mode: its own trips, assigned the same way ----------
  // (the background stays the one fitted above; a Quick scenario pivots on these flows and trips)
  const quick = await baseTrips('quick');
  const qODd = {} as Record<TPeriod, Uint16Array>,
    quickFlow = {} as Record<TPeriod, Float64Array>;
  for (const p of TPERIODS) {
    const mq = modelVehicleOD(B, nC, NZ, NX, quick.autoOD[p], quick.tncEnds[p]);
    const q = Uint16Array.from(mq, quantise);
    qODd[p] = Uint16Array.from(q, (v, i) => (v - qOD[p][i]) & 0xffff);
    const od = new Float32Array(nC * nC);
    for (let i = 0; i < od.length; i++) od[i] = (q[i] ? dequantise(q[i]) : 0) + (qBG[p][i] ? dequantise(qBG[p][i]) : 0);
    const prevOD = new Float32Array(nC * nC);
    for (let i = 0; i < od.length; i++) prevOD[i] = (qOD[p][i] ? dequantise(qOD[p][i]) : 0) + (qBG[p][i] ? dequantise(qBG[p][i]) : 0);
    const R = periodRoads(net, p);
    const t0 = Date.now();
    const warm = await warmFlows(R, baseFlow[p], prevOD, od, aon);
    const eq = await equilibrium(R, od, aon, { gap: gapBase, maxIter: 400, warm });
    quickFlow[p] = eq.flow;
    let moved = 0;
    for (let i = 0; i < q.length; i++) if (q[i] !== qOD[p][i]) moved++;
    console.log(`today ${p} (quick): ${Math.round(sumOf(od)).toLocaleString()} vehicles (${(sumOf(od) - vehicles[p]).toFixed(0)} from precise; ${moved.toLocaleString()} cells differ), gap ${eq.gap.toExponential(2)} after ${eq.iterations} iterations (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }

  // ---------- validation ----------
  const val = validate(net, baseFlow, baseTime, H.zones);
  const sum = summariseRoads(net, baseFlow, baseTime);
  console.log(`VMT by period: ${TPERIODS.map((p) => `${p} ${Math.round(sum.vmt[p] / 1000)}k`).join(', ')}; daily ${Math.round(TPERIODS.reduce((a, p) => a + sum.vmt[p], 0) / 1000)}k`);
  console.log(`speeds (mph) by class: ${Object.entries(sum.speed).map(([c, v]) => `${c} ${TPERIODS.map((p) => v[p].toFixed(1)).join('/')}`).join('; ')}`);
  for (const l of val.lines) console.log(l);

  // ---------- write ----------
  const src = decodeBundle(fs.readFileSync(`${WORK}/roads-net.bin`));
  const header = { ...(src.header as unknown as RoadHeader), commercial: { trips: Math.round(commTrips), tod: COMMERCIAL.tod }, base: { gap: gaps, iterations: iters, background: bgSummary, vehicles, modelId: bundleId(H) } };
  delete (header as Partial<RoadHeader>).arrays;
  const arrays: Record<string, Float32Array | Int32Array | Uint8Array | Uint16Array> = {};
  for (const [k, v] of Object.entries(src.a)) arrays[k] = v as never;
  for (const p of TPERIODS) {
    arrays[`base_${p}`] = Float32Array.from(baseFlow[p]);
    arrays[`baseOD_${p}`] = qOD[p];
    arrays[`bgOD_${p}`] = qBG[p];
    arrays[`baseQuick_${p}`] = Float32Array.from(quickFlow[p]);
    arrays[`baseODdQuick_${p}`] = qODd[p];
    if (net.pre[p]) arrays[`pre_${p}`] = net.pre[p]!;
  }
  if (pen) {
    for (const p of TPERIODS) if (net.capfP?.[p]) arrays[`capf_${p}`] = net.capfP[p]!;
    (header as RoadHeader).peninsula = { ...pen, segments: pen.segments.map((sg) => ({ ...sg, capFactor: Object.fromEntries(TPERIODS.map((p) => [p, +(net.capfP?.[p]?.[sg.link] ?? 1).toFixed(4)])) as Record<TPeriod, number> })) };
  }
  const bin = encodeBundle(header as never, arrays);
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.writeFileSync(`${BUNDLE}/roads.bin.gz`, gz);
  console.log(`roads bundle ${(bin.length / 1e6).toFixed(1)} MB → ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
  fs.writeFileSync(`${REFERENCE}/road-validation.json`, JSON.stringify({ built: header.built, network: { ...networkFacts(net), commercial: header.commercial }, note: 'Base-year road assignment (server/beta3/pipeline/roads-base.ts) against counts and speeds. Counts at the city line were used to fit the background traffic and are not tests.', ...val.json, summary: { vmt: sum.vmt, vht: sum.vht, speed: sum.speed, vehicles, peninsula: sum.peninsula }, base: header.base }, null, 1));
  console.timeEnd('roads-base');
}

/** the network's size and settings, for the article (roads-validate.ts writes the same) */
export function networkFacts(net: RoadNet) {
  const h = net.h;
  let streets = 0,
    miles = 0;
  for (let k = 0; k < h.nLinks; k++) if (net.cls[k] > 0 && !net.corr[k]) ((streets += 1), (miles += net.len[k]));
  return { nodes: h.nNodes, links: h.nLinks, streetLinks: streets, streetMiles: Math.round(miles), centroids: h.nC, zones: h.nZ, outsideZones: h.nX, gateways: h.gateways.map((g) => ({ name: g.name, kind: g.kind })), freeFlow: h.speedTargets.freeFlow, commercial: h.commercial, peninsulaLinks: h.peninsula?.segments.length ?? 0 };
}

/**
 * The Peninsula freeways' background: on each segment and period, the counted vehicles in each
 * direction less the model's own (`flow`), never below zero; where one direction would go below
 * zero, the other takes up the difference, so the two together still carry the count.
 */
export function setBackground(net: RoadNet, flow: Record<TPeriod, ArrayLike<number>>) {
  const pen = net.h.peninsula;
  if (!pen) return;
  const pair = new Map<string, { N?: (typeof pen.segments)[number]; S?: (typeof pen.segments)[number] }>();
  for (const sg of pen.segments) {
    const key = `${sg.route}|${[sg.from, sg.to].sort().join('|')}`;
    (pair.get(key) ?? pair.set(key, {}).get(key)!)[sg.dir] = sg;
  }
  for (const p of TPERIODS) {
    const pre = (net.pre[p] ??= new Float32Array(net.h.nLinks));
    for (const { N, S } of pair.values()) {
      const segs = [N, S].filter(Boolean) as (typeof pen.segments)[number][];
      const want = segs.map((sg) => sg.target![p] - flow[p][sg.link]);
      if (segs.length === 2) {
        if (want[0] < 0) ((want[1] += want[0]), (want[0] = 0));
        if (want[1] < 0) ((want[0] += want[1]), (want[1] = 0));
      }
      segs.forEach((sg, i) => (pre[sg.link] = Math.max(0, want[i])));
    }
  }
}

/** capacity factors are kept within these bounds */
const CAPF_RANGE: [number, number] = [0.4, 2];
/**
 * The Peninsula freeways' capacities: on each segment C/CAG monitors, the factor on its lanes'
 * capacity in each peak that brings the model's speed at the counted volume to INRIX's peak speed
 * (midday and night take the two peaks' geometric mean); elsewhere the median of those. A factor
 * for each peak, not one for both: the periods' volumes come from one count station's profile, and
 * the factor takes up what that profile misses on each segment. Stored by period (capf_<period>).
 */
export function fitPeninsula(net: RoadNet) {
  const pen = net.h.peninsula;
  if (!pen) return;
  const L = net.h.nLinks;
  const fitted: Record<'AM' | 'PM', number[]> = { AM: [], PM: [] };
  const speedAt = (links: number[], p: TPeriod, f: number) => {
    let m = 0,
      h = 0;
    for (const k of links) {
      const sg = pen.segments.find((x) => x.link === k)!;
      const t0 = net.t0[TPERIODS.indexOf(p) * L + k];
      const r = sg.target![p] / (net.cap[k] * f * CAP_FACTOR[p]) / 0.75;
      m += net.len[k];
      h += (t0 * (1 + 0.2 * r ** 6)) / 60;
    }
    return m / h;
  };
  const capfP = {} as Record<TPeriod, Float32Array>;
  for (const p of TPERIODS) capfP[p] = (net.capfP?.[p] as Float32Array | undefined) ?? Float32Array.from({ length: L }, () => 1);
  const done = new Set<number>();
  for (const s of pen.monitored) {
    if (!s.links.length) continue;
    const f: Record<'AM' | 'PM', number> = { AM: 1, PM: 1 };
    for (const p of ['AM', 'PM'] as const) {
      // the speed falls as the capacity does: bisection on the log factor
      let lo = Math.log(CAPF_RANGE[0]),
        hi = Math.log(CAPF_RANGE[1]);
      for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2;
        if (speedAt(s.links, p, Math.exp(m)) > s[p]) hi = m;
        else lo = m;
      }
      f[p] = Math.exp((lo + hi) / 2);
      fitted[p].push(f[p]);
    }
    for (const k of s.links) {
      capfP.AM[k] = f.AM;
      capfP.PM[k] = f.PM;
      capfP.MD[k] = capfP.NT[k] = Math.sqrt(f.AM * f.PM);
      done.add(k);
    }
  }
  const med = (v: number[]) => (v.length ? v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] : 1);
  const mAM = med(fitted.AM),
    mPM = med(fitted.PM);
  for (const sg of pen.segments)
    if (!done.has(sg.link)) {
      capfP.AM[sg.link] = mAM;
      capfP.PM[sg.link] = mPM;
      capfP.MD[sg.link] = capfP.NT[sg.link] = Math.sqrt(mAM * mPM);
    }
  net.capfP = capfP;
}

/** the largest gap between a direction's traffic (model + background) and its count, where both directions have a background */
export function dirResidual(net: RoadNet, flow: Record<TPeriod, ArrayLike<number>>): number {
  const pen = net.h.peninsula;
  if (!pen) return 0;
  let worst = 0;
  for (const sg of pen.segments) {
    const o = pen.segments.find((x) => x.route === sg.route && x.dir !== sg.dir && x.from === sg.to && x.to === sg.from);
    for (const p of TPERIODS) {
      const pre = net.pre[p];
      if (!pre || !(pre[sg.link] > 0) || (o && !(pre[o.link] > 0))) continue;
      worst = Math.max(worst, Math.abs((flow[p][sg.link] + pre[sg.link]) / sg.target![p] - 1));
    }
  }
  return worst;
}

/** how far the Peninsula freeways are from their counts (model + background) and INRIX's speeds */
export function peninsulaFit(net: RoadNet, flow: Record<TPeriod, ArrayLike<number>>, time?: Record<TPeriod, ArrayLike<number>>): string {
  const pen = net.h.peninsula;
  if (!pen) return '';
  let worst = 0,
    model = 0,
    all = 0;
  for (const sg of pen.segments)
    for (const p of TPERIODS) {
      const v = flow[p][sg.link] + (net.pre[p]?.[sg.link] ?? 0);
      worst = Math.max(worst, Math.abs(v / sg.target![p] - 1));
      model += flow[p][sg.link];
      all += v;
    }
  const sp = peninsulaSpeeds(net, flow, time);
  const e = sp.map((r) => Math.abs(r.model / r.obs - 1));
  return `volumes within ${(100 * worst).toFixed(2)}% of the counts (the model's cars ${(100 * model / all).toFixed(1)}% of the traffic); peak speeds within ${(100 * e.reduce((a, x) => a + x, 0) / Math.max(1, e.length)).toFixed(1)}% of INRIX's on average`;
}

/** model and INRIX speeds on C/CAG's monitored segments (AM and PM peaks) */
export function peninsulaSpeeds(net: RoadNet, flow: Record<TPeriod, ArrayLike<number>>, time?: Record<TPeriod, ArrayLike<number>>) {
  const pen = net.h.peninsula;
  const rows: { route: string; dir: string; from: string; to: string; p: 'AM' | 'PM'; obs: number; model: number }[] = [];
  if (!pen) return rows;
  for (const p of ['AM', 'PM'] as const) {
    let t = time?.[p];
    if (!t) {
      const tt = new Float64Array(net.h.nLinks);
      linkTimes(periodRoads(net, p), flow[p], tt);
      t = tt;
    }
    for (const s of pen.monitored) {
      if (!s.links.length) continue;
      let m = 0,
        h = 0;
      for (const k of s.links) ((m += net.len[k]), (h += t[k] / 60));
      rows.push({ route: s.route, dir: s.dir, from: s.from, to: s.to, p, obs: s[p], model: +(m / h).toFixed(1) });
    }
  }
  return rows;
}

/** FSUTMS 2008 %RMSE targets by daily volume (acceptable, preferable) */
const GROUPS: [number, number, number, number][] = [
  [0, 5000, 100, 45],
  [5000, 10000, 45, 35],
  [10000, 15000, 35, 27],
  [15000, 20000, 30, 25],
  [20000, 30000, 27, 15],
  [30000, 50000, 25, 15],
  [50000, 60000, 20, 10],
  [60000, Infinity, 19, 10],
];

export function validate(net: RoadNet, flow: Record<TPeriod, ArrayLike<number>>, time: Record<TPeriod, ArrayLike<number>>, zones?: { x: number; y: number; areaType: number }[]) {
  const lines: string[] = [];
  const stats = (rows: { obs: number; mod: number }[]) => {
    const n = rows.length;
    if (!n) return { n: 0, ratio: NaN, r: NaN, pctRmse: NaN, within25: NaN };
    const mo = rows.reduce((a, x) => a + x.obs, 0) / n,
      mm = rows.reduce((a, x) => a + x.mod, 0) / n;
    let cov = 0,
      vo = 0,
      vm = 0,
      se = 0,
      w = 0;
    for (const x of rows) {
      cov += (x.obs - mo) * (x.mod - mm);
      vo += (x.obs - mo) ** 2;
      vm += (x.mod - mm) ** 2;
      se += (x.mod - x.obs) ** 2;
      if (Math.abs(x.mod / x.obs - 1) <= 0.25) w++;
    }
    return { n, ratio: mm / mo, r: cov / Math.sqrt(vo * vm), pctRmse: (100 * Math.sqrt(se / n)) / mo, within25: w / n };
  };
  const dailyOf = (links: number[]) => links.reduce((a, k) => a + TPERIODS.reduce((s, p) => s + flow[p][k], 0), 0);
  const rows = net.h.counts.map((c) => ({ src: c.src, id: c.id, desc: c.desc, cls: c.cls, fitted: !!c.fitted, obs: c.daily, mod: Math.round(dailyOf(c.links)), year: c.year }));
  const tests = rows.filter((x) => !x.fitted);
  const json: Record<string, unknown> = {};
  const fmt = (s: ReturnType<typeof stats>) => `n ${s.n}, model/count ${s.ratio.toFixed(2)}, r ${s.r.toFixed(2)}, %RMSE ${s.pctRmse.toFixed(0)}, within ±25% ${(100 * s.within25).toFixed(0)}%`;
  const bySrc: Record<string, unknown> = {};
  for (const src of ['caltrans', 'sfmta']) {
    const r = tests.filter((x) => x.src === src);
    const s = stats(r);
    bySrc[src] = s;
    lines.push(`${src === 'caltrans' ? 'Caltrans 2023 AADT (state highways, inside the city)' : 'SFMTA 2021–23 weekday counts (one direction)'}: ${fmt(s)}`);
  }
  json.bySource = bySrc;
  const byGroup = GROUPS.map(([lo, hi, acc, pref]) => {
    const r = tests.filter((x) => x.obs >= lo && x.obs < hi);
    const s = stats(r);
    return { group: `${lo / 1000}k–${hi === Infinity ? '' : `${hi / 1000}k`}`, ...s, acceptable: acc, preferable: pref };
  });
  json.byVolumeGroup = byGroup;
  lines.push(`%RMSE by daily volume (FSUTMS acceptable/preferable): ${byGroup.map((g) => `${g.group} ${Number.isFinite(g.pctRmse) ? g.pctRmse.toFixed(0) : '–'}% (n ${g.n}; ${g.acceptable}/${g.preferable})`).join(', ')}`);
  const all = stats(tests);
  json.all = all;
  lines.push(`all tests: ${fmt(all)} (FSUTMS areawide 45/35%; CTC: r ≥ 0.88, %RMSE < 40%)`);
  const byCls: Record<string, unknown> = {};
  for (const c of RCLS.slice(1)) {
    const r = tests.filter((x) => x.cls === c);
    if (r.length) byCls[c] = stats(r);
  }
  json.byClass = byCls;
  lines.push(`by class: ${Object.entries(byCls).map(([c, s]) => `${c} ${fmt(s as ReturnType<typeof stats>)}`).join(' | ')}`);
  // speeds: CMP segments (2025, AM 7–9am and PM 4:30–6:30pm) against the model's period speeds
  const segSpeed = (links: number[], p: TPeriod) => {
    let m = 0,
      h = 0;
    for (const k of links) (m += net.len[k]), (h += time[p][k] / 60);
    return h > 0 ? m / h : NaN;
  };
  const cmpRows: { id: number; name: string; dir: string; cls: string; p: string; obs: number; mod: number }[] = [];
  for (const s of net.h.cmp)
    for (const p of ['AM', 'PM'] as const) {
      const o = s[p];
      if (!o || !s.links.length) continue;
      cmpRows.push({ id: s.id, name: `${s.name} ${s.from}–${s.to}`, dir: s.dir, cls: s.cls, p, obs: o, mod: +segSpeed(s.links, p).toFixed(1) });
    }
  const cmpStats: Record<string, unknown> = {};
  for (const c of ['arterial', 'freeway'])
    for (const p of ['AM', 'PM']) {
      const r = cmpRows.filter((x) => x.cls === c && x.p === p);
      const s = stats(r);
      // network speed as the CMP reports it: total length over total time
      cmpStats[`${c} ${p}`] = { ...s };
    }
  json.cmp = cmpStats;
  lines.push(`CMP 2025 segment speeds (peak 2 h) vs the model's period speed: ${Object.entries(cmpStats).map(([k, s]) => `${k} ${fmt(s as ReturnType<typeof stats>)}`).join(' | ')}`);
  // every monitored segment against SFCTA's hourly INRIX speeds for the same four periods
  // (October 2025 to September 2026, harmonic mean over months and hours), by class and area type
  {
    const H = JSON.parse(fs.readFileSync(`${RAW}/roads/sfcta_inrix_hourly_by_segment.json`, 'utf8')) as { cmp_segid: number; period: string; avg_speed: number }[];
    const by = new Map<number, number[][]>();
    for (const r of H) if (r.avg_speed > 0) (by.get(r.cmp_segid) ?? by.set(r.cmp_segid, Array.from({ length: 24 }, () => [])).get(r.cmp_segid)!)[+r.period].push(r.avg_speed);
    const HRS: Record<TPeriod, number[]> = { AM: [6, 7, 8, 9], MD: [10, 11, 12, 13, 14], PM: [15, 16, 17, 18], NT: [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5] };
    const atOf = (k: number) => {
      if (!zones) return -1;
      const [x, y] = toXY(net.nodeLat[net.a[k]], net.nodeLon[net.a[k]]);
      let best = 3,
        bd = 1500;
      for (const z of zones) {
        const d = Math.hypot(z.x - x, z.y - y);
        if (d < bd) ((bd = d), (best = z.areaType));
      }
      return best;
    };
    const segRows: { id: number; cls: string; at: number; p: TPeriod; obs: number; mod: number }[] = [];
    for (const s of net.h.cmp) {
      const hh = by.get(s.id);
      if (!hh || !s.links.length) continue;
      const at = s.cls === 'freeway' ? -1 : atOf(s.links[0]);
      for (const p of TPERIODS) {
        const v = HRS[p].flatMap((h) => hh[h]).filter((x) => x > 0);
        if (!v.length) continue;
        segRows.push({ id: s.id, cls: s.cls, at, p, obs: +(v.length / v.reduce((a, x) => a + 1 / x, 0)).toFixed(2), mod: +segSpeed(s.links, p).toFixed(2) });
      }
    }
    const segStats: Record<string, unknown> = {};
    for (const p of TPERIODS) {
      segStats[`freeway ${p}`] = stats(segRows.filter((r) => r.cls === 'freeway' && r.p === p));
      segStats[`arterial ${p}`] = stats(segRows.filter((r) => r.cls === 'arterial' && r.p === p));
    }
    const byAT: Record<string, unknown> = {};
    for (const at of [0, 1, 2, 3]) for (const p of ['AM', 'PM'] as TPeriod[]) byAT[`area type ${at} ${p}`] = stats(segRows.filter((r) => r.cls === 'arterial' && r.at === at && r.p === p));
    json.inrix = segStats;
    json.inrixByAreaType = byAT;
    json.inrixRows = segRows;
    lines.push(`INRIX by segment and model period (all monitored segments): ${Object.entries(segStats).map(([k, s]) => `${k} ${fmt(s as ReturnType<typeof stats>)}`).join(' | ')}`);
    lines.push(`  arterials by area type: ${Object.entries(byAT).map(([k, s]) => `${k} ${fmt(s as ReturnType<typeof stats>)}`).join(' | ')}`);
  }
  // the Peninsula freeways: volumes against the counts by segment, direction, and period (the
  // background makes them agree; the residual is what the background could not take up), and
  // speeds against INRIX's on C/CAG's monitored segments
  if (net.h.peninsula) {
    const pen = net.h.peninsula;
    const vol = pen.segments.flatMap((sg) =>
      TPERIODS.map((p) => ({ route: sg.route, dir: sg.dir, from: sg.from, to: sg.to, p, count: sg.target![p], model: Math.round(flow[p][sg.link]), background: Math.round(net.pre[p]?.[sg.link] ?? 0), total: Math.round(flow[p][sg.link] + (net.pre[p]?.[sg.link] ?? 0)), mph: +((60 * net.len[sg.link]) / time[p][sg.link]).toFixed(1), capFactor: +(net.capfP?.[p]?.[sg.link] ?? 1).toFixed(3) })),
    );
    const sp = peninsulaSpeeds(net, flow, time);
    const spStats = Object.fromEntries((['AM', 'PM'] as const).map((p) => [p, stats(sp.filter((r) => r.p === p).map((r) => ({ obs: r.obs, mod: r.model })))]));
    // both directions together, and each direction where the model's own cars left room for a background in both
    const key = (r: (typeof vol)[number]) => `${r.route}|${[r.from, r.to].sort().join('|')}|${r.p}`;
    const pairs = new Map<string, (typeof vol)[number][]>();
    for (const r of vol) (pairs.get(key(r)) ?? pairs.set(key(r), []).get(key(r))!).push(r);
    let worst = 0,
      worstDir = 0,
      clipped = 0;
    for (const ps of pairs.values()) {
      worst = Math.max(worst, Math.abs(ps.reduce((a, r) => a + r.total, 0) / ps.reduce((a, r) => a + r.count, 0) - 1));
      if (ps.some((r) => r.background === 0)) clipped++;
      else for (const r of ps) worstDir = Math.max(worstDir, Math.abs(r.total / r.count - 1));
    }
    json.peninsula = { volumes: vol, speeds: sp, speedStats: spStats, worstVolumeError: worst, worstDirectionError: worstDir, clippedPairs: clipped, pairs: pairs.size, modelShare: vol.reduce((a, r) => a + r.model, 0) / vol.reduce((a, r) => a + r.total, 0) };
    lines.push(`Peninsula freeways: volumes within ${(100 * worst).toFixed(2)}% of the counts by segment and period, both ways (each way within ${(100 * worstDir).toFixed(2)}% where both have a background; ${clipped} of ${pairs.size} segment-periods where the model alone exceeds one direction's count); the model's own cars ${(100 * (json.peninsula as { modelShare: number }).modelShare).toFixed(1)}% of the traffic; INRIX peak speeds ${Object.entries(spStats).map(([p, s]) => `${p} ${fmt(s)}`).join(' | ')}`);
  }
  json.rows = rows;
  json.cmpRows = cmpRows;
  void linkTimes;
  return { lines, json };
}

if (import.meta.url === `file://${process.argv[1]}`) main();
