/**
 * Diagnostic: Muni riders whose trip also uses another operator. The strategy assignment does not
 * follow a rider across lines, but a strategy is Markovian (where a rider goes next depends only on
 * the node they are at), so the share is exact: for each destination, a backward pass gives each
 * node the chance that the rest of the trip boards operator g, and a forward pass splits the flow
 * at each node into riders who have boarded g already and those who have not. A Muni boarding is on
 * a trip using g if the rider boarded g before it, or will after it.
 *
 * Also: transfers between operators (riders walking or changing from one operator's stop onto
 * another's), and how riders enter BART's stations in the city (from the street, from Muni, from
 * another operator), for the BART Station Profile Study's share arriving by bus or train.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-xfer.ts
 *   [--bundle 2024] [--context '{"transferDiscount":0.53,"transferDiscountMuniOnly":true}'] [--json out.json]
 * The run is the backcast's (two passes from empty vehicles, the bundle's calibration).
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { C_FARE, LINK_ACCESS, LINK_BOARD, LINK_CHANGE, LINK_WALK, NC, type TransitNet } from '../../../shared/beta3/net';
import { PATH } from '../../../shared/beta3/params';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { Bundle, DemandContext, Scenario, TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, WORK } from './paths';
import { SF_CODES } from './regional-diag';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
/** the operators besides Muni that take Clipper (the free shuttles do not, and are left out) */
export const GROUPS = ['any', 'bart', 'caltrain', 'ferry', 'ggt', 'ac', 'samtrans', 'smart'] as const;
const OTHER = new Set(GROUPS.slice(1));

export interface XferStats {
  muniBoardings: number;
  /** Muni boardings on trips that also board each operator (any: at least one of them) */
  muniOnTripsWith: Record<string, number>;
  /** Muni boardings straight after another operator (a change of operator at the stop) */
  muniAfterOther: number;
  /** Muni boardings straight before another operator */
  muniBeforeOther: number;
  /** changes of operator, from→to */
  pairs: Record<string, number>;
  /** entries at BART's city stations, by way in */
  bartSF: { street: number; muni: number; other: number; bart: number };
  byPeriod: Record<string, { muniBoardings: number; any: number }>;
  /** linked trips by the operators they use (Muni only, another operator only, both), and their mean fare (the paths' expected adult fare) */
  trips: { muniOnly: number; otherOnly: number; both: number; fareMuniOnly: number; fareOtherOnly: number; fareBoth: number; bart: number; bartMuni: number; bartSFSF: number; bartMuniSFSF: number };
  /** entries at BART's city stations in the morning peak, by way in (most are from home) */
  bartSFAM: { street: number; muni: number; other: number };
}

export function xferStats(b: Bundle, nets: Record<TPeriod, TransitNet>, od: Record<TPeriod, Float32Array>): XferStats {
  if (PATH.egressLogit) throw new Error('diag-xfer: the egress branch is not followed');
  const H = b.header;
  const G = GROUPS.length;
  const out: XferStats = { muniBoardings: 0, muniOnTripsWith: Object.fromEntries(GROUPS.map((g) => [g, 0])), muniAfterOther: 0, muniBeforeOther: 0, pairs: {}, bartSF: { street: 0, muni: 0, other: 0, bart: 0 }, byPeriod: {}, trips: { muniOnly: 0, otherOnly: 0, both: 0, fareMuniOnly: 0, fareOtherOnly: 0, fareBoth: 0, bart: 0, bartMuni: 0, bartSFSF: 0, bartMuniSFSF: 0 }, bartSFAM: { street: 0, muni: 0, other: 0 } };
  // classes: bit 1 Muni, 2 BART, 4 another operator, 8 the trip began outside the city
  const C8 = 16, NZC = H.zones.length;
  const tripN = new Float64Array(C8), tripF = new Float64Array(C8), tripSFSF = new Float64Array(C8);
  const sfBart = new Set(H.observed.bartStations.filter((s) => SF_CODES.includes(s.code) && s.stop !== null).map((s) => s.stop!));
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const net = nets[p];
    const Z = net.nZones, S = net.nStops, A0 = Z, B0 = Z + S, N = net.nNodes;
    const feedOfStop = (s: number) => (s < H.stops.length ? H.stops[s].feed : net.newStops[s - H.stops.length].feed);
    // each link: the group whose line it boards (bit mask), whether it boards Muni, and for links
    // between stops the operators at each end
    const boardMask = new Uint8Array(net.nLinks);
    const muniBoard = new Uint8Array(net.nLinks);
    const stopOfNode = new Int32Array(N).fill(-1);
    for (let s = 0; s < S; s++) (stopOfNode[A0 + s] = s), (stopOfNode[B0 + s] = s);
    for (let a = 0; a < net.nLinks; a++) {
      if (net.type[a] !== LINK_BOARD) continue;
      const l = net.lines[net.line[a]];
      if (stopOfNode[net.tail[a]] < 0) stopOfNode[net.tail[a]] = l.stops[net.pos[a]];
      if (l.feed === 'muni' || l.feed === 'new') muniBoard[a] = 1;
      else if (OTHER.has(l.feed as never)) boardMask[a] = 1 | (1 << GROUPS.indexOf(l.feed as never));
    }
    const solver = new StrategySolver(net);
    const sv = solver as unknown as { cur: number; prob: Float64Array; accShare?: Float64Array };
    const info = PATH.lineSplit === 'information';
    const nBlockZones = sv.accShare ? net.zonePtStart!.length - 1 : 0;
    const q = new Float64Array(N * G), vU = new Float64Array(N * G), vT = new Float64Array(N * G), vol = new Float64Array(N);
    const linkVol = new Float64Array(net.nLinks);
    // linked trips by class (bit 1: has boarded Muni, bit 2: BART, bit 4: another operator), and their fares so far
    const cV = new Float64Array(N * C8), cF = new Float64Array(N * C8);
    const cls = new Uint8Array(net.nLinks);
    for (let a = 0; a < net.nLinks; a++) cls[a] = muniBoard[a] ? 1 : boardMask[a] & 2 ? 2 : boardMask[a] ? 4 : 0;
    let mb = 0, many = 0;
    for (let d = 0; d < Z; d++) {
      let any = false;
      for (let o = 0; o < Z; o++) if (od[p][o * Z + d] > 0) (any = true), (o = Z);
      if (!any) continue;
      solver.solve(d);
      const { order, nOrder, F, succ, attractive, u } = solver;
      const cur = sv.cur;
      const share = (i: number, a: number) => (info ? sv.prob[a] : net.freq[a] / F[i]);
      // backward: the chance that the rest of the trip from node i boards group g
      for (let k = 0; k < nOrder; k++) {
        const i = order[k];
        for (let g = 0; g < G; g++) q[i * G + g] = 0;
        if (F[i] > 0) {
          for (let x = net.outStart[i]; x < net.outStart[i + 1]; x++) {
            const a = net.outLinks[x];
            if (attractive[a] !== cur) continue;
            const pa = share(i, a), h = net.head[a], m = boardMask[a];
            for (let g = 0; g < G; g++) q[i * G + g] += pa * (m & (1 << g) ? 1 : q[h * G + g]);
          }
        } else if (succ[i] >= 0) {
          const a = succ[i], h = net.head[a], m = boardMask[a];
          for (let g = 0; g < G; g++) q[i * G + g] = m & (1 << g) ? 1 : q[h * G + g];
        }
      }
      // forward: from the origins, as StrategySolver.load
      for (let k = 0; k < nOrder; k++) {
        const i = order[k];
        vol[i] = 0;
        for (let g = 0; g < G; g++) vU[i * G + g] = vT[i * G + g] = 0;
        for (let c = 0; c < C8; c++) cV[i * C8 + c] = cF[i * C8 + c] = 0;
      }
      const push = (a: number, i: number, f: number, o = 0) => {
        // f: the share of node i's riders taking link a (i < 0: f riders from an origin, untagged)
        const h = net.head[a], m = boardMask[a];
        const v = i < 0 ? f : vol[i] * f;
        if (!(v > 0)) return;
        linkVol[a] += v;
        vol[h] += v;
        const fa = net.comp[a * NC + C_FARE], ca = cls[a];
        if (i < 0) (cV[h * C8 + (ca | (o >= NZC ? 8 : 0))] += v), (cF[h * C8 + (ca | (o >= NZC ? 8 : 0))] += v * fa);
        else
          for (let c = 0; c < C8; c++) {
            const cv = cV[i * C8 + c] * f;
            if (!cv) continue;
            cV[h * C8 + (c | ca)] += cv;
            cF[h * C8 + (c | ca)] += cF[i * C8 + c] * f + cv * fa;
          }
        if (muniBoard[a]) {
          mb += v;
          for (let g = 0; g < G; g++) {
            const t = i < 0 ? 0 : vT[i * G + g] * f, un = v - t;
            out.muniOnTripsWith[GROUPS[g]] += t + un * q[h * G + g];
            if (g === 0) many += t + un * q[h * G + g];
          }
        }
        for (let g = 0; g < G; g++) {
          const t = i < 0 ? 0 : vT[i * G + g] * f, un = v - t;
          if (m & (1 << g)) vT[h * G + g] += v;
          else (vT[h * G + g] += t), (vU[h * G + g] += un);
        }
      };
      for (let o = 0; o < Z; o++) {
        const v = od[p][o * Z + d];
        if (!(v > 0) || u[o] === Infinity) continue;
        for (let x = net.outStart[o]; x < net.outStart[o + 1]; x++) {
          const a = net.outLinks[x];
          if (o < nBlockZones) {
            const sh = sv.accShare![a];
            if (sh > 0) push(a, -1, v * sh, o);
          } else {
            const c = u[net.head[a]] + net.cost[a];
            if (c < Infinity) push(a, -1, v * Math.exp(-PATH.accessTheta * (c - u[o])), o);
          }
        }
      }
      for (let k = nOrder - 1; k >= 0; k--) {
        const i = order[k];
        if (!(vol[i] > 0)) continue;
        if (F[i] > 0) {
          for (let x = net.outStart[i]; x < net.outStart[i + 1]; x++) {
            const a = net.outLinks[x];
            if (attractive[a] === cur) push(a, i, share(i, a));
          }
        } else if (succ[i] >= 0) push(succ[i], i, 1);
      }
      for (let c = 1; c < C8; c++) (tripN[c] += cV[d * C8 + c]), (tripF[c] += cF[d * C8 + c]), d < NZC && !(c & 8) && (tripSFSF[c] += cV[d * C8 + c]);
    }
    out.muniBoardings += mb;
    out.byPeriod[p] = { muniBoardings: mb, any: many };
    // changes of operator, and the ways into BART's city stations
    for (let a = 0; a < net.nLinks; a++) {
      const v = linkVol[a];
      if (!v) continue;
      const t = net.type[a];
      if (t === LINK_ACCESS && net.head[a] >= B0 && net.head[a] < B0 + S) {
        const s = net.head[a] - B0;
        if (sfBart.has(s)) (out.bartSF.street += v), p === 'AM' && (out.bartSFAM.street += v);
        continue;
      }
      if (t !== LINK_WALK && t !== LINK_CHANGE) continue;
      const s0 = stopOfNode[net.tail[a]], s1 = stopOfNode[net.head[a]];
      if (s0 < 0 || s1 < 0) continue;
      const f0 = feedOfStop(s0), f1 = feedOfStop(s1);
      if (sfBart.has(s1)) out.bartSF[f0 === 'bart' ? 'bart' : f0 === 'muni' ? 'muni' : 'other'] += v;
      if (sfBart.has(s1) && p === 'AM' && f0 !== 'bart') out.bartSFAM[f0 === 'muni' ? 'muni' : 'other'] += v;
      if (f0 === f1) continue;
      out.pairs[`${f0}>${f1}`] = (out.pairs[`${f0}>${f1}`] ?? 0) + v;
      if (f1 === 'muni' && OTHER.has(f0 as never)) out.muniAfterOther += v;
      if (f0 === 'muni' && OTHER.has(f1 as never)) out.muniBeforeOther += v;
    }
  }
  const sumC = (arr: Float64Array, test: (c: number) => boolean) => [...arr].reduce((a, v, c) => a + (test(c) ? v : 0), 0);
  const both = (c: number) => (c & 1) > 0 && (c & 6) > 0, other = (c: number) => (c & 1) === 0 && (c & 6) > 0;
  const muniOnly = (c: number) => (c & 7) === 1;
  const nB = sumC(tripN, both), nO = sumC(tripN, other);
  out.trips = { muniOnly: sumC(tripN, muniOnly), otherOnly: nO, both: nB, fareMuniOnly: sumC(tripF, muniOnly) / sumC(tripN, muniOnly), fareOtherOnly: sumC(tripF, other) / nO, fareBoth: sumC(tripF, both) / nB, bart: sumC(tripN, (c) => (c & 2) > 0), bartMuni: sumC(tripN, (c) => (c & 3) === 3), bartSFSF: sumC(tripSFSF, (c) => (c & 2) > 0), bartMuniSFSF: sumC(tripSFSF, (c) => (c & 3) === 3) };
  return out;
}

async function main() {
  const today = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/sf.bin.gz`)));
  const which = arg('--bundle', 'today');
  const b = which === 'today' ? today : decodeBundle(zlib.gunzipSync(fs.readFileSync(`${WORK}/sf-${which}.bin.gz`)));
  const calib = today.header.calibration!;
  b.header.calibration = calib;
  const context = JSON.parse(arg('--context', 'null')) as DemandContext | null;
  // --set key=value[,key=value]: path-choice settings (PATH) for this run
  for (const kv of arg('--set', '').split(',').filter(Boolean)) {
    const [key, v] = kv.split('=');
    if (!(key in PATH)) throw new Error(`unknown PATH setting ${key}`);
    (PATH as Record<string, unknown>)[key] = Number(v);
  }
  const sc: Scenario = { name: 'diag-xfer', edits: [], context: context ?? undefined };
  const r = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 2 }, prepare(b));
  const x = xferStats(b, r.nets, r.demand.transitOD);
  const k = (v: number) => `${(v / 1000).toFixed(1)}k`;
  console.log(`${which} ${JSON.stringify(context)} ${arg('--set', '')}: Muni boardings (assigned) ${k(x.muniBoardings)}; summary Muni ${k(r.summary.boardings.muni)}, BART ${k(r.summary.boardings.bart ?? 0)}; transit trips ${k(r.summary.transitTrips)}`);
  for (const g of GROUPS) console.log(`  on trips using ${g}: ${k(x.muniOnTripsWith[g])} (${((100 * x.muniOnTripsWith[g]) / x.muniBoardings).toFixed(1)}%)`);
  console.log(`  straight after another operator ${k(x.muniAfterOther)}, straight before ${k(x.muniBeforeOther)}`);
  const bs = x.bartSF, bt = bs.street + bs.muni + bs.other;
  console.log(`  BART city-station entries: street ${k(bs.street)}, from Muni ${k(bs.muni)} (${((100 * bs.muni) / bt).toFixed(1)}%), other ${k(bs.other)}; BART-to-BART changes ${k(bs.bart)}`);
  const t = x.trips;
  console.log(`  linked trips: Muni only ${k(t.muniOnly)} ($${t.fareMuniOnly.toFixed(2)}), Muni and another operator ${k(t.both)} ($${t.fareBoth.toFixed(2)}), other operators only ${k(t.otherOnly)} ($${t.fareOtherOnly.toFixed(2)})`);
  const am = x.bartSFAM, amT = am.street + am.muni + am.other;
  console.log(`  BART city-station entries, morning peak: from Muni ${((100 * am.muni) / amT).toFixed(1)}% of ${k(amT)}; BART trips ${k(t.bart)}, with Muni ${k(t.bartMuni)} (${((100 * t.bartMuni) / t.bart).toFixed(1)}%); within the city ${k(t.bartSFSF)}, with Muni ${k(t.bartMuniSFSF)}`);
  console.log('  operator changes:', Object.entries(x.pairs).sort((a, c) => c[1] - a[1]).slice(0, 16).map(([p, v]) => `${p} ${k(v)}`).join(', '));
  const json = arg('--json', '');
  if (json) fs.writeFileSync(json, JSON.stringify({ bundle: which, context, set: arg('--set', ''), summary: { muni: r.summary.boardings.muni, bart: r.summary.boardings.bart, transitTrips: r.summary.transitTrips, boardings: r.summary.boardings }, ...x }, null, 1));
}

if (process.argv[1]?.endsWith('diag-xfer.ts')) main();
