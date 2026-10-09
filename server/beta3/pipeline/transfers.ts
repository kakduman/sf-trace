/**
 * Changes of vehicle in an assignment, traced destination by destination: the share of boardings
 * that follow another vehicle (what the on-board surveys ask: "how many buses or trains did you ride
 * before this one?"), what riders changed from (another Muni line, the same route, BART, Caltrain,
 * another operator), how long the ride before each change was, where riders change, and whether a
 * single line would have served the trip.
 *
 * Within one destination's strategy every node but a boarding node has one successor, so a
 * boarding's ride is fixed until it gets off, and the mix of riders reaching a boarding node is split
 * over its lines in the same proportions whatever way they came: tracing each destination's load
 * gives exact shares by line (od-checks.ts splits each stop's mix over its lines after summing all
 * destinations, which is exact for the system and approximate by line).
 *
 * Run on the saved base run: npx tsx server/beta3/pipeline/transfers.ts [out.json] [--direct]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { C_BOARDS, LINK_ACCESS, LINK_ALIGHT, LINK_BOARD, LINK_CHANGE, LINK_EGRESS, LINK_RIDE, LINK_WALK, NC, type NetLine, type TransitNet } from '../../../shared/beta3/net';
import { PATH } from '../../../shared/beta3/params';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { Bundle, TPeriod } from '../../../shared/beta3/types';

/** Muni's groups of lines, as the counts and the surveys report them */
export type MuniGroup = 'metro' | 'bus' | 'streetcar' | 'cablecar';
export const muniGroup = (l: Pick<NetLine, 'feed' | 'mode'>): MuniGroup | null =>
  l.feed !== 'muni' ? null : l.mode === 'lightrail' ? 'metro' : l.mode === 'streetcar' ? 'streetcar' : l.mode === 'cablecar' ? 'cablecar' : 'bus';

/** what a rider boarding after another vehicle came from */
export const FROM = ['muniSame', 'muniOther', 'bart', 'caltrain', 'other'] as const;
export type From = (typeof FROM)[number];

export interface GroupTally {
  boardings: number;
  /** boardings that follow another vehicle, in all and by what it was */
  after: number;
  from: Record<From, number>;
}
const tally = (): GroupTally => ({ boardings: 0, after: 0, from: { muniSame: 0, muniOther: 0, bart: 0, caltrain: 0, other: 0 } });

/** ride lengths before a change (km and stops), as volume by bin */
export const KM_BINS = [0.25, 0.5, 1, 2, 4, Infinity];
export const STOP_BINS = [1, 2, 3, 5, 10, Infinity];

export interface TransferTrace {
  /** Muni boardings by group, and all of Muni */
  groups: Record<MuniGroup | 'muni', GroupTally>;
  /** Muni boardings by route */
  routes: Record<string, GroupTally>;
  /** the rides that end in a change onto Muni: their length by bin, by the group of the ride */
  firstLeg: Record<MuniGroup | 'other', { vol: number; km: number[]; stops: number[]; kmSum: number }>;
  /** changes onto Muni at the same stop (no walk) and by walking to another stop */
  sameStop: number;
  walked: number;
  /** changes onto Muni by stop name, from route, and to route (the largest) */
  pairs: { at: string; from: string; to: string; vol: number }[];
  /** Muni boardings at a stop's own node for changing riders (long headways), not its main node */
  atChangeNode: number;
  /** BART boardings straight after a Muni ride (Muni boardings straight after BART are in groups.muni.from.bart) */
  bartFromMuni: number;
  bartBoardings: number;
  /** transit trips (as assigned) and their expected boardings, all operators */
  trips: number;
  boardingsAll: number;
  /** origin–destination pairs where riders change: does one line serve both ends within reach, and
   * by how much (perceived minutes) the best strategy without changing is worse (with `direct`) */
  direct?: { changeTrips: number; withDirectLine: number; gap: { bins: number[]; vol: number[] }; noDirectPath: number };
}

const emptyTrace = (): TransferTrace => ({
  groups: { metro: tally(), bus: tally(), streetcar: tally(), cablecar: tally(), muni: tally() },
  routes: {},
  firstLeg: Object.fromEntries((['metro', 'bus', 'streetcar', 'cablecar', 'other'] as const).map((g) => [g, { vol: 0, km: KM_BINS.map(() => 0), stops: STOP_BINS.map(() => 0), kmSum: 0 }])) as TransferTrace['firstLeg'],
  sameStop: 0,
  walked: 0,
  pairs: [],
  atChangeNode: 0,
  bartFromMuni: 0,
  bartBoardings: 0,
  trips: 0,
  boardingsAll: 0,
});

export const GAP_BINS = [0, 2, 5, 10, 20, Infinity];

/**
 * Trace one period's assignment of `od` (zone × zone, as the model assigns it). `stopName` names
 * stops for the change pairs. With `direct`, each pair's best strategy without changing is solved
 * too (twice the time).
 */
/**
 * The trace follows each node's single next link in the strategy, so it is made with the egress and
 * transfer logits off (PATH.egressLogit, PATH.transferLogit): where riders get off and change is then
 * the one best stop, not the logits' spread over stops. The counts of changes it reports are those of
 * that strategy; calibrate.ts fits the share of boardings after another vehicle from the model's own
 * link volumes instead (muniAfterVehicle), which carry the logits.
 */
export function traceTransfers(net: TransitNet, od: ArrayLike<number>, stop: (s: number) => { name: string; x: number; y: number }, opts: { direct?: boolean; into?: TransferTrace; pairMap?: Map<string, number> } = {}): TransferTrace {
  const keep = [PATH.egressLogit, PATH.transferLogit] as const;
  PATH.egressLogit = false;
  PATH.transferLogit = false;
  try {
    return traceStrategies(net, od, stop, opts);
  } finally {
    [PATH.egressLogit, PATH.transferLogit] = keep;
  }
}

function traceStrategies(net: TransitNet, od: ArrayLike<number>, stop: (s: number) => { name: string; x: number; y: number }, opts: { direct?: boolean; into?: TransferTrace; pairMap?: Map<string, number> }): TransferTrace {
  const T = opts.into ?? emptyTrace();
  const pairMap = opts.pairMap ?? new Map<string, number>();
  const Z = net.nZones, S = net.nStops, A0 = Z, B0 = Z + S, L0 = Z + 2 * S;
  const { type, tail, head, line, pos, outStart, outLinks, inStart, inLinks, freq } = net;
  const solver = new StrategySolver(net);
  const sv = solver as unknown as { cur: number; prob: Float64Array };
  const info = PATH.lineSplit === 'information';
  // each line's cumulative km along its stops (straight line between stops)
  const cumKm = lineKm(net, stop);
  const stopName = (s: number) => stop(s).name;
  // the line node's line and position
  const nLN = net.lineStart[net.lines.length];
  const lnLine = new Int32Array(nLN), lnPos = new Int32Array(nLN);
  net.lines.forEach((l, li) => {
    for (let k = 0; k < l.stops.length; k++) (lnLine[net.lineStart[li] + k] = li), (lnPos[net.lineStart[li] + k] = k);
  });
  const groupOfLine = net.lines.map((l) => muniGroup(l));
  const feedCat = (li: number): 'muni' | 'bart' | 'caltrain' | 'other' => {
    const f = net.lines[li].feed;
    return f === 'muni' ? 'muni' : f === 'bart' ? 'bart' : f === 'caltrain' ? 'caltrain' : 'other';
  };
  // per destination: riders reaching each A node by line (the lines getting off there), and each
  // boarding node's riders who changed, by what they changed from (line index; −1 street)
  const alightBy = new Map<number, Map<number, number>>();
  const changeBy = new Map<number, Map<number, number>>();
  const changeWalked = new Map<number, number>();
  // legs: the A node and alight position each line node's riders reach (per destination)
  const legStamp = new Int32Array(nLN).fill(-1);
  const legA = new Int32Array(nLN), legPos = new Int32Array(nLN);
  let stamp = 0;
  const legEnd = (ln: number): number => {
    // follow ride links to the alight link; returns the line node index where riders get off
    let k = ln;
    const path: number[] = [];
    while (legStamp[k] !== stamp) {
      path.push(k);
      const a = solver.succ[L0 + k];
      if (a < 0 || type[a] !== LINK_RIDE) {
        legStamp[k] = stamp;
        legA[k] = a >= 0 && type[a] === LINK_ALIGHT ? head[a] : -1;
        legPos[k] = lnPos[k];
        break;
      }
      k = head[a] - L0;
    }
    const A = legA[k], P = legPos[k];
    for (const q of path) (legStamp[q] = stamp), (legA[q] = A), (legPos[q] = P);
    return k;
  };
  const kmOf = (li: number, i: number, j: number) => cumKm[li][j] - cumKm[li][i];
  const binOf = (bins: number[], x: number) => bins.findIndex((b) => x <= b);
  const vol = solver.nodeVol;
  // the strategy without changing (direct)
  let dsolver: StrategySolver | null = null;
  if (opts.direct) {
    const cost = Float32Array.from(net.cost);
    for (let a = 0; a < net.nLinks; a++) if (type[a] === LINK_CHANGE || type[a] === LINK_WALK) cost[a] = Infinity;
    dsolver = new StrategySolver({ ...net, cost });
    T.direct ??= { changeTrips: 0, withDirectLine: 0, gap: { bins: GAP_BINS, vol: GAP_BINS.map(() => 0) }, noDirectPath: 0 };
  }
  // lines through each stop, with the position
  const atStop: [number, number][][] = Array.from({ length: S }, () => []);
  net.lines.forEach((l, li) => l.stops.forEach((s, k) => atStop[s].push([li, k])));
  const egMax = new Int32Array(net.lines.length);
  return run();

  function run() {
    for (let d = 0; d < Z; d++) {
      let any = false;
      for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) (any = true), (o = Z);
      if (!any) continue;
      solver.solve(d);
      solver.load((o) => od[o * Z + d]);
      stamp++;
      alightBy.clear();
      changeBy.clear();
      changeWalked.clear();
      const cur = sv.cur, prob = sv.prob, F = solver.F, succ = solver.succ;
      // trips and expected boardings
      for (let o = 0; o < Z; o++) {
        const v = od[o * Z + d];
        if (!(v > 0) || solver.u[o] === Infinity) continue;
        T.trips += v;
        T.boardingsAll += v * solver.C[o * NC + C_BOARDS];
      }
      for (let k = solver.nOrder - 1; k >= 0; k--) {
        const i = solver.order[k];
        const v = vol[i];
        if (!(v > 0)) continue;
        if (F[i] > 0) {
          const ch = changeBy.get(i);
          for (let q = outStart[i]; q < outStart[i + 1]; q++) {
            const a = outLinks[q];
            if (type[a] !== LINK_BOARD || solver.attractive[a] !== cur) continue;
            const s = info ? v * prob[a] : (v * freq[a]) / F[i];
            if (!(s > 0)) continue;
            const li = line[a], g = groupOfLine[li];
            const ln = head[a] - L0;
            const end = legEnd(ln);
            const A = legA[end];
            // riders getting off this line at A: by line, for the next boarding's "changed from"
            if (A >= 0) {
              const m = alightBy.get(A) ?? alightBy.set(A, new Map()).get(A)!;
              m.set(li, (m.get(li) ?? 0) + s);
            }
            if (!g && net.lines[li].feed === 'bart') {
              T.bartBoardings += s;
              if (ch) for (const [fl, fv] of ch) if (net.lines[fl].feed === 'muni') T.bartFromMuni += (s * fv) / v;
            }
            if (g) {
              const l = net.lines[li];
              const r = (T.routes[l.route] ??= tally());
              for (const t of [T.groups[g], T.groups.muni, r]) t.boardings += s;
              if (i >= L0 + nLN) T.atChangeNode += s;
              if (ch) {
                let tot = 0;
                for (const [fl, fv] of ch) {
                  const x = (s * fv) / v;
                  tot += x;
                  const fc = feedCat(fl);
                  const key: From = fc === 'muni' ? (net.lines[fl].route === l.route ? 'muniSame' : 'muniOther') : fc;
                  for (const t of [T.groups[g], T.groups.muni, r]) t.from[key] += x;
                  const stop = l.stops[pos[a]];
                  const pk = `${stopName(stop)}|${net.lines[fl].feed === 'muni' ? net.lines[fl].route : net.lines[fl].feed}|${l.route}`;
                  pairMap.set(pk, (pairMap.get(pk) ?? 0) + x);
                }
                for (const t of [T.groups[g], T.groups.muni, r]) t.after += tot;
                const w = changeWalked.get(i) ?? 0;
                T.walked += (s * w) / v;
                T.sameStop += (s * ([...ch.values()].reduce((x, y) => x + y, 0) - w)) / v;
              }
            }
            // a ride that ends in a change: its length
            if (A >= 0) {
              const na = succ[A];
              if (na >= 0 && (type[na] === LINK_CHANGE || type[na] === LINK_WALK)) {
                const fg = g ?? 'other';
                const fl = T.firstLeg[fg];
                const km = kmOf(li, pos[a], legPos[end]);
                const st = legPos[end] - pos[a];
                fl.vol += s;
                fl.kmSum += s * km;
                fl.km[binOf(KM_BINS, km)] += s;
                fl.stops[binOf(STOP_BINS, st)] += s;
              }
            }
          }
          continue;
        }
        const a = succ[i];
        if (a < 0) continue;
        const t = type[a];
        if (t === LINK_CHANGE || t === LINK_WALK) {
          // the riders getting off at A (tail) change at the boarding node (head), by the line they left
          const h = head[a];
          const m = alightBy.get(i);
          const cm = changeBy.get(h) ?? changeBy.set(h, new Map()).get(h)!;
          if (m) {
            let tot = 0;
            for (const x of m.values()) tot += x;
            for (const [li, x] of m) cm.set(li, (cm.get(li) ?? 0) + (v * x) / tot);
          }
          if (t === LINK_WALK) changeWalked.set(h, (changeWalked.get(h) ?? 0) + v);
        }
      }
      if (dsolver) directCheck(d);
    }
    return T;
  }

  function directCheck(d: number) {
    const D = T.direct!;
    // the last place each line can be left for d
    egMax.fill(-1);
    for (let q = inStart[d]; q < inStart[d + 1]; q++) {
      const e = inLinks[q];
      if (type[e] !== LINK_EGRESS) continue;
      const s = tail[e] - A0;
      if (s < 0 || s >= S) continue;
      for (const [li, k] of atStop[s]) if (k > egMax[li]) egMax[li] = k;
    }
    dsolver!.solve(d);
    for (let o = 0; o < Z; o++) {
      const v = od[o * Z + d];
      if (!(v > 0) || solver.u[o] === Infinity) continue;
      const x = v * Math.max(0, solver.C[o * NC + C_BOARDS] - 1);
      if (!(x > 1e-9)) continue;
      D.changeTrips += x;
      let direct = false;
      for (let q = outStart[o]; q < outStart[o + 1] && !direct; q++) {
        const a = outLinks[q];
        if (type[a] !== LINK_ACCESS) continue;
        const s = head[a] - B0;
        if (s < 0 || s >= S) continue;
        for (const [li, k] of atStop[s]) if (egMax[li] > k) (direct = true);
      }
      if (direct) D.withDirectLine += x;
      const ud = dsolver!.u[o];
      if (ud === Infinity) D.noDirectPath += x;
      else D.gap.vol[binOf(GAP_BINS, ud - solver.u[o])] += x;
    }
  }
}

/** Each line's cumulative km along its stops (straight lines between them), for ride lengths. */
export function lineKm(net: TransitNet, xy: (s: number) => { x: number; y: number }): number[][] {
  return net.lines.map((l) => {
    const c = [0];
    for (let k = 1; k < l.stops.length; k++) {
      const a = xy(l.stops[k - 1]), b = xy(l.stops[k]);
      c.push(c[k - 1] + Math.hypot(b.x - a.x, b.y - a.y) / 1000);
    }
    return c;
  });
}

/** Trace every period of a run (its networks and its transit trips) into one tally. */
export function traceRun(b: Bundle, nets: Partial<Record<TPeriod, TransitNet>>, transitOD: Partial<Record<TPeriod, ArrayLike<number>>>, opts: { direct?: boolean; top?: number } = {}): TransferTrace {
  const H = b.header;
  const T = emptyTrace();
  const pairMap = new Map<string, number>();
  for (const p of Object.keys(nets) as TPeriod[]) {
    const net = nets[p], od = transitOD[p];
    if (!net || !od) continue;
    const stop = (s: number) => (s < H.stops.length ? { name: H.stops[s].name, x: H.stops[s].x, y: H.stops[s].y } : net.newStops[s - H.stops.length]);
    traceTransfers(net, od, stop, { direct: opts.direct, into: T, pairMap });
  }
  T.pairs = [...pairMap]
    .sort((x, y) => y[1] - x[1])
    .slice(0, opts.top ?? 40)
    .map(([k, v]) => {
      const [at, from, to] = k.split('|');
      return { at, from, to, vol: Math.round(v) };
    });
  return T;
}

const pct = (x: number, t: number) => `${((100 * x) / Math.max(1e-9, t)).toFixed(1)}%`;
/** The shares, as lines of text */
export function describeTrace(T: TransferTrace): string[] {
  const out: string[] = [];
  const g = (k: keyof TransferTrace['groups']) => {
    const t = T.groups[k];
    return `${k} ${pct(t.after, t.boardings)} of ${(t.boardings / 1000).toFixed(1)}k (from Muni same route ${pct(t.from.muniSame, t.boardings)}, other Muni ${pct(t.from.muniOther, t.boardings)}, BART ${pct(t.from.bart, t.boardings)}, Caltrain ${pct(t.from.caltrain, t.boardings)}, other operators ${pct(t.from.other, t.boardings)})`;
  };
  out.push(`boardings after another vehicle: ${g('muni')}`);
  out.push(`  ${g('metro')}`);
  out.push(`  ${g('bus')}`);
  out.push(`  ${g('streetcar')}; ${g('cablecar')}`);
  out.push(`  by route: ${['J', 'K', 'L', 'M', 'N', 'T', 'F', '14', '14R', '38', '38R', '49', '22', '1', '5', '5R', '9', '9R', '8', '30', '24', '44', '29', '28'].filter((r) => T.routes[r]).map((r) => `${r} ${pct(T.routes[r].after, T.routes[r].boardings)}`).join(', ')}`);
  out.push(`  changes onto Muni at the same stop ${pct(T.sameStop, T.sameStop + T.walked)}, walking to another stop ${pct(T.walked, T.sameStop + T.walked)}; Muni boardings at a stop's node for changing riders ${pct(T.atChangeNode, T.groups.muni.boardings)}`);
  const bm = T.groups.muni.from.bart;
  out.push(`  changes between BART and Muni: BART→Muni ${(bm / 1000).toFixed(1)}k, Muni→BART ${(T.bartFromMuni / 1000).toFixed(1)}k, together ${((bm + T.bartFromMuni) / 1000).toFixed(1)}k (${pct(bm + T.bartFromMuni, T.bartBoardings)} of ${(T.bartBoardings / 1000).toFixed(1)}k BART boardings)`);
  out.push(`  boardings per trip (all operators) ${(T.boardingsAll / T.trips).toFixed(3)} over ${(T.trips / 1000).toFixed(1)}k trips`);
  for (const [k, f] of Object.entries(T.firstLeg)) {
    if (!(f.vol > 0)) continue;
    out.push(`  rides ending in a change, on ${k}: ${(f.vol / 1000).toFixed(1)}k, mean ${(f.kmSum / f.vol).toFixed(2)} km; km ≤ ${KM_BINS.join('/')}: ${f.km.map((x) => pct(x, f.vol)).join(' ')}; stops ≤ ${STOP_BINS.join('/')}: ${f.stops.map((x) => pct(x, f.vol)).join(' ')}`);
  }
  if (T.direct) {
    const D = T.direct;
    out.push(`  trips' changes: ${(D.changeTrips / 1000).toFixed(1)}k; with one line serving both ends within reach ${pct(D.withDirectLine, D.changeTrips)}; best strategy without changing worse by ≤ ${GAP_BINS.join('/')} min: ${D.gap.vol.map((x) => pct(x, D.changeTrips)).join(' ')}; no path without changing ${pct(D.noDirectPath, D.changeTrips)}`);
  }
  out.push(`  largest changes onto Muni (at, from → to): ${T.pairs.slice(0, 25).map((x) => `${x.at.slice(0, 26)} ${x.from}→${x.to} ${(x.vol / 1000).toFixed(1)}k`).join('; ')}`);
  return out;
}

if (process.argv[1]?.endsWith('transfers.ts')) {
  (async () => {
    const { loadBundle } = await import('./run-base');
    const { prepare, LocalExecutor } = await import('../../../shared/beta3/model');
    const { decodeResult } = await import('../../../shared/beta3/results');
    const { modelState } = await import('./od-checks');
    const { buildNet } = await import('../../../shared/beta3/net');
    const { BUNDLE } = await import('./paths');
    const t0 = Date.now();
    const b = loadBundle();
    const calib = b.header.calibration!;
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
    const st = await modelState(b, calib, prepare(b), base.finalCrowd);
    void LocalExecutor;
    const nets: Partial<Record<TPeriod, TransitNet>> = {};
    for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
      const net0 = buildNet(b, { name: 'Today', edits: [] }, p, calib);
      const cr = net0.lines.map((l) => (l.src >= 0 ? base.finalCrowd?.[p]?.[l.src] : undefined) ?? new Float32Array(Math.max(0, l.stops.length - 1)).fill(1));
      nets[p] = buildNet(b, { name: 'Today', edits: [] }, p, calib, cr);
    }
    const T = traceRun(b, nets, st.demand.transitOD, { direct: process.argv.includes('--direct') });
    const f = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/tmp/transfers.json';
    fs.writeFileSync(f, JSON.stringify(T, null, 1));
    for (const l of describeTrace(T)) console.log(l);
    console.log(`written ${f} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  })();
}

/**
 * The share of Muni's boardings that follow another vehicle, from an assignment's link volumes: each
 * boarding node's riders who arrived by a change (at the stop or walking from another) over all who
 * arrived there, given to its boardings in proportion. Exact for Muni as a whole when, as here, no
 * boarding node mixes Muni with other operators' lines in a way that matters; by group approximate.
 */
export function muniAfterVehicle(nets: Partial<Record<TPeriod, TransitNet>>, vols: Partial<Record<TPeriod, Float64Array>>) {
  const out = { boardings: 0, after: 0, metro: [0, 0], bus: [0, 0] };
  for (const p of Object.keys(nets) as TPeriod[]) {
    const net = nets[p], vol = vols[p];
    if (!net || !vol) continue;
    const all = new Float64Array(net.nNodes), chg = new Float64Array(net.nNodes);
    for (let a = 0; a < net.nLinks; a++) {
      const v = vol[a], t = net.type[a];
      if (!v || !(t === LINK_ACCESS || t === LINK_CHANGE || t === LINK_WALK)) continue;
      all[net.head[a]] += v;
      if (t !== LINK_ACCESS) chg[net.head[a]] += v;
    }
    for (let a = 0; a < net.nLinks; a++) {
      const v = vol[a];
      if (!v || net.type[a] !== LINK_BOARD) continue;
      const g = muniGroup(net.lines[net.line[a]]);
      if (!g) continue;
      const i = net.tail[a];
      const x = all[i] > 0 ? (v * chg[i]) / all[i] : 0;
      out.boardings += v;
      out.after += x;
      if (g === 'metro' || g === 'bus') (out[g][0] += v), (out[g][1] += x);
    }
  }
  return { ...out, share: out.after / Math.max(1e-9, out.boardings), metroShare: out.metro[1] / Math.max(1e-9, out.metro[0]), busShare: out.bus[1] / Math.max(1e-9, out.bus[0]) };
}
