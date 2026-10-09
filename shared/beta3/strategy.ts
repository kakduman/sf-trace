/**
 * Optimal strategies (Spiess & Florian, 1989) to one destination, and loading demand onto them.
 *
 * Going backwards from the destination, each node gets the expected perceived cost of the best
 * strategy from it. At a boarding node the traveller waits for a set of attractive lines: with
 * combined frequency F, the wait is (weight · ½)/F. Each line is taken in proportion to its
 * frequency (PATH.lineSplit 'frequency'), or, for riders who know when each line will come, by its
 * chance of being the best once its wait is seen ('information', combineInformed). A line joins the
 * set when riding it beats the current expected cost. Expected values of each component (time,
 * wait, fare...) are carried along the same way, giving the skims for mode choice. City zones
 * choose their access stop block by block (blockOrigin), and riders choose where to get off by the
 * same logit, by destination block (egressBranch).
 */
import { C_TIME, C_WAIT, C_WALK, LINK_ALIGHT, LINK_BOARD, LINK_CHANGE, LINK_EGRESS, LINK_RIDE, LINK_WALK, NC, type TransitNet } from './net';
import { PATH } from './params';
import { BLOCKS_WASM } from './blocksWasm';
import { SEARCH_WASM } from './searchWasm';

/**
 * The block-by-block access split's sums in WebAssembly (wasm/blocks.ts, SIMD), equal bit for bit
 * to the TypeScript (test/beta3-wasm.test.ts), which stays as the fallback where WebAssembly or its
 * SIMD is missing. setBlocksWasm(false) turns it off (tests, comparisons).
 */
let blocksModule: WebAssembly.Module | null | undefined;
let blocksOn = true;
export function setBlocksWasm(on: boolean) {
  blocksOn = on;
}
const compile = (b64: string): WebAssembly.Module | null => {
  try {
    return new WebAssembly.Module(typeof atob === 'function' ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(b64, 'base64')));
  } catch {
    return null;
  }
};
function blocksWasm(): WebAssembly.Module | null {
  if (blocksModule === undefined) blocksModule = compile(BLOCKS_WASM);
  return blocksModule;
}
/**
 * The search's main loop in WebAssembly too (wasm/search.ts: the heap, the labels, informed line
 * choice), with musl's exp: labels can differ from the TypeScript's in the last bits
 * (test/beta3-wasm.test.ts). Off with setSearchWasm(false) or setBlocksWasm(false).
 */
let searchModule: WebAssembly.Module | null | undefined;
let searchOn = true;
/** exp in the search: the page's Math.exp, imported (bit for bit), or musl's in WebAssembly */
let muslExp = false;
export function setSearchWasm(on: boolean, opts: { muslExp?: boolean } = {}) {
  searchOn = on;
  muslExp = !!opts.muslExp;
}
function searchWasm(): WebAssembly.Module | null {
  if (searchModule === undefined) searchModule = compile(SEARCH_WASM);
  return searchModule;
}
interface SearchKernel {
  set(slot: number, at: number): void;
  setup(zones: number, boardFor: boolean, muslExp: boolean): void;
  reset(): void;
  orderCount(): number;
  push(id: number, key: number): void;
  run(d: number, nZones: number, cur: number, egr: boolean, info: boolean, alpha: number, share: number, W: number): void;
}
/** wasm/search.ts's slots, in its order (SLOT) */
const SEARCH_SLOTS = ['u', 'F', 'sumFC', 'C', 'succ', 'att', 'final', 'order', 'hid', 'hkey', 'prob', 'inStart', 'inLinks', 'tail', 'cost', 'freq', 'type', 'comp', 'boardFor', 'destSets', 'outStart', 'outLinks', 'head', 'infoL', 'infoU', 'infoR', 'infoI', 'infoP'] as const;
interface BlocksKernel {
  blockSums(q0: number, q1: number, np: number, va: number, qAcc: number, ptE: number, Sp: number): void;
  blockShares(q0: number, q1: number, np: number, va: number, qAcc: number, qLink: number, ptE: number, ptMin: number, Sp: number, Wp: number, share: number): number;
  blockComponents(o: number, q0: number, q1: number, r: number, qLink: number, qHead: number, comp: number, share: number, C: number): void;
}

export class StrategySolver {
  readonly net: TransitNet;
  u: Float64Array;
  F: Float64Array;
  /** for B nodes: Σ f·(u_j) bookkeeping; for components: Σ f·C_j */
  sumFC: Float64Array;
  C: Float64Array;
  succ: Int32Array;
  /** per link: the solve in which it became attractive */
  attractive: Int32Array;
  final: Uint8Array;
  /** count of solves, marking which links are attractive in the current one */
  private cur = 0;
  order: Int32Array;
  nOrder = 0;
  private heapId: Int32Array;
  private heapKey: Float64Array;
  private heapSize = 0;
  private alpha: number;
  /** volumes of the last load, per link */
  linkVol: Float64Array;
  /** after load(): the riders through each node (for traces such as transfers.ts) */
  nodeVol: Float64Array;
  /** riders already passed on from each node in load()'s sweeps */
  private nodeDone: Float64Array;

  constructor(net: TransitNet) {
    this.net = net;
    const n = net.nNodes;
    this.u = new Float64Array(n);
    this.F = new Float64Array(n);
    this.sumFC = new Float64Array(n * NC);
    this.C = new Float64Array(n * NC);
    this.succ = new Int32Array(n);
    this.attractive = new Int32Array(net.nLinks);
    this.final = new Uint8Array(n);
    this.order = new Int32Array(n);
    this.heapId = new Int32Array(Math.max(1024, n));
    this.heapKey = new Float64Array(Math.max(1024, n));
    this.alpha = PATH.waitWeight * 0.5;
    this.linkVol = new Float64Array(net.nLinks);
    this.nodeVol = new Float64Array(n);
    this.nodeDone = new Float64Array(n);
    this.prob = new Float64Array(PATH.lineSplit === 'information' ? net.nLinks : 0);
    if (net.accPt && net.accPtMin && net.zonePtStart) {
      // each block's walk to a stop as its logit weight, exp(−θ · walk weight · minutes)
      const k = PATH.accessTheta * PATH.walkWeight;
      this.ptE = Float32Array.from(net.accPtMin, (t) => (t < Infinity ? Math.exp(-k * t) : 0));
      this.accShare = new Float64Array(net.nLinks);
      if (blocksOn) this.wasmBlocks();
    }
    // each line node's ride link onward and alight link, for the egress branch
    this.L0 = net.nZones + 2 * net.nStops;
    const nLN = net.lineStart[net.lines.length];
    this.rideOf = new Int32Array(nLN).fill(-1);
    this.alightOf = new Int32Array(nLN).fill(-1);
    for (let a = 0; a < net.nLinks; a++) {
      if (net.type[a] === LINK_RIDE) this.rideOf[net.tail[a] - this.L0] = a;
      else if (net.type[a] === LINK_ALIGHT) this.alightOf[net.tail[a] - this.L0] = a;
    }
    this.branchVol = new Float64Array(nLN);
    // each stop's changes and walks onward from its alighting node, for the transfer branch
    const S = net.nStops, A0 = net.nZones;
    this.aOutStart = new Int32Array(S + 1);
    const isX = (a: number) => (net.type[a] === LINK_CHANGE || net.type[a] === LINK_WALK) && net.tail[a] >= A0 && net.tail[a] < A0 + S;
    for (let a = 0; a < net.nLinks; a++) if (isX(a)) this.aOutStart[net.tail[a] - A0 + 1]++;
    for (let s = 0; s < S; s++) this.aOutStart[s + 1] += this.aOutStart[s];
    this.aOutLinks = new Int32Array(this.aOutStart[S]);
    const fo = this.aOutStart.slice(0, S);
    for (let a = 0; a < net.nLinks; a++) if (isX(a)) this.aOutLinks[fo[net.tail[a] - A0]++] = a;
  }

  /**
   * Transfer branch (PATH.transferLogit): per line node, the chance of getting off there to change
   * (for riders arriving by riding), the change or walk link taken, and the lines boarded after it
   * (an offset and count into xsLink/xsProb, or count −1 for the previous pass's attractive set at
   * its head); the branch's label and components at each line node; and the riders who took it.
   */
  private xfer = false;
  private aOutStart: Int32Array;
  private aOutLinks: Int32Array;
  private xP?: Float64Array;
  private xLnk?: Int32Array;
  private xOff?: Int32Array;
  private xCnt?: Int32Array;
  private tbU?: Float64Array;
  private tbC?: Float64Array;
  private xferVol?: Float64Array;
  private xsLink = new Int32Array(1024);
  private xsProb = new Float64Array(1024);
  private xsN = 0;
  /** the previous pass's labels, components, combined frequencies, attractive links, and informed shares */
  private uP?: Float64Array;
  private CP?: Float64Array;
  private FP?: Float64Array;
  private attP?: Int32Array;
  private probP?: Float64Array;
  private curP = 0;
  private pending = false;
  private xC = new Float64Array(NC);
  private xBestC = new Float64Array(NC);
  private cwC = new Float64Array(NC);
  /**
   * egress branch (PATH.egressLogit), for the last solve: the places to get off for the destination,
   * as entries (line, position, alight link, egress link) sorted by line and position, grouped by
   * line; per entry its label, the share of the destination's blocks it reaches, and its expected
   * components; per entry and block, the label and the chance of getting off there
   */
  private L0: number;
  private rideOf: Int32Array;
  private alightOf: Int32Array;
  private branchVol: Float64Array;
  private eN = 0;
  private eLine = new Int32Array(256);
  private ePos = new Int32Array(256);
  private eAl = new Int32Array(256);
  private eEg = new Int32Array(256);
  private eG = new Float64Array(256);
  private eR = new Float64Array(256);
  private eC = new Float64Array(256 * NC);
  private gStart: number[] = [];
  private nB = 1;
  private bW = Float64Array.of(1);
  private bG = new Float64Array(256);
  private bP = new Float64Array(256);
  private bCa = new Float64Array(NC * 64);
  private bCb = new Float64Array(NC * 64);
  /** block-level access (PATH.blockAccess): each block's logit weight to each stop, and each access link's share of its zone in the last solve */
  private ptE?: Float32Array;
  private accShare?: Float64Array;
  private va = new Float64Array(64);
  /** blockOrigin's scratch: per block, its sum over the stops (then its weight over it) and its walk */
  private bS = new Float64Array(64);
  private bWk = new Float64Array(64);
  /** informed line choice (PATH.lineSplit 'information'): each board link's share at its stop, and scratch */
  private prob: Float64Array;
  private infoL = new Int32Array(256);
  private infoU = new Float64Array(256);
  private infoR = new Float64Array(256);
  private infoI = new Float64Array(256);
  private infoP = new Float64Array(256);

  /** the WebAssembly kernel for blockOrigin and the byte offsets of its arrays in its memory (wasmBlocks) */
  private K?: BlocksKernel;
  /** the WebAssembly search (wasmBlocks), in the same memory */
  private S?: SearchKernel;
  private kp = { va: 0, Sp: 0, Wp: 0, ptE: 0, ptMin: 0, qAcc: 0, qLink: 0, qHead: 0, comp: 0, share: 0, C: 0 };
  /**
   * Put C, the access shares, blockOrigin's scratch, and per access link of the city zones what
   * blockOrigin reads, in one WebAssembly memory, so the kernel and the TypeScript share them
   * without copying (C and accShare become views on it). Without WebAssembly, nothing changes.
   */
  private wasmBlocks() {
    const mod = blocksWasm();
    if (!mod) return;
    const net = this.net, nZ = net.zonePtStart!.length - 1, Q = net.outStart[nZ];
    let maxQ = 0, maxNp = 0;
    for (let o = 0; o < nZ; o++) {
      maxQ = Math.max(maxQ, net.outStart[o + 1] - net.outStart[o]);
      maxNp = Math.max(maxNp, net.zonePtStart![o + 1] - net.zonePtStart![o]);
    }
    const E = net.accPtMin!.length;
    // f64 arrays first, then f32 and i32, each 16-byte aligned; Sp and Wp with a lane to spare; from
    // 64 KB (below: the search module's own data)
    let at = 65536;
    const take = (bytes: number) => ((at = (at + 15) & ~15), (at += bytes), at - bytes);
    const kp = this.kp;
    kp.C = take(this.C.length * 8);
    kp.share = take(net.nLinks * 8);
    kp.va = take(Math.max(1, maxQ) * 8);
    kp.Sp = take((maxNp + 2) * 8);
    kp.Wp = take((maxNp + 2) * 8);
    kp.ptE = take((E + 2) * 4);
    kp.ptMin = take((E + 2) * 4);
    kp.qAcc = take(Q * 4);
    kp.qLink = take(Q * 4);
    kp.qHead = take(Q * 4);
    kp.comp = take((net.nLinks * NC + 2) * 4);
    // the search's arrays (wasm/search.ts)
    const smod = searchOn ? searchWasm() : null;
    const n = net.nNodes, L = net.nLinks;
    let maxOut = 256;
    for (let i = 0; i < n; i++) maxOut = Math.max(maxOut, net.outStart[i + 1] - net.outStart[i]);
    const nSets = net.destSets?.length ?? 0, setLen = nSets ? net.destSets![0].length : 0;
    const sp = {} as Record<(typeof SEARCH_SLOTS)[number], number>;
    if (smod) {
      sp.C = kp.C;
      sp.u = take(n * 8);
      sp.F = take(n * 8);
      sp.sumFC = take(n * NC * 8);
      sp.hkey = take((L + n + 16) * 8);
      sp.prob = take(L * 8);
      for (const k of ['infoU', 'infoR', 'infoI', 'infoP'] as const) sp[k] = take(maxOut * 8);
      sp.cost = take(L * 4);
      sp.freq = take(L * 4);
      sp.comp = kp.comp;
      for (const k of ['succ', 'order', 'inStart', 'outStart'] as const) sp[k] = take((n + 1) * 4);
      sp.hid = take((L + n + 16) * 4);
      for (const k of ['att', 'inLinks', 'tail', 'outLinks', 'head', 'boardFor'] as const) sp[k] = take(L * 4);
      sp.infoL = take(maxOut * 4);
      sp.final = take(n);
      sp.type = take(L);
      sp.destSets = take(Math.max(1, nSets * setLen));
    }
    let inst: WebAssembly.Instance;
    let sinst: WebAssembly.Instance | null = null;
    let mem: WebAssembly.Memory;
    try {
      mem = new WebAssembly.Memory({ initial: Math.ceil(at / 65536) });
      inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
      if (smod) sinst = new WebAssembly.Instance(smod, { env: { memory: mem, jsexp: Math.exp } });
    } catch {
      return;
    }
    const buf = mem.buffer;
    /**
     * the net's array, copied into the kernel's memory, and the net then reads that copy (its own is
     * freed): one copy of the network, not two (a net with several solvers moves on to the last's)
     */
    function move<T extends Int32Array | Float32Array | Uint8Array>(a: T, Ctor: { new (b: ArrayBufferLike, off: number, n: number): T }, off: number): T {
      const v = new Ctor(buf, off, a.length);
      v.set(a as never);
      return v;
    }
    net.comp = move(net.comp, Float32Array, kp.comp);
    if (sinst) {
      // the solver's own arrays become views on the kernel's memory; the net's move in (below)
      this.u = new Float64Array(buf, sp.u, n);
      this.F = new Float64Array(buf, sp.F, n);
      this.sumFC = new Float64Array(buf, sp.sumFC, n * NC);
      this.succ = new Int32Array(buf, sp.succ, n);
      this.attractive = new Int32Array(buf, sp.att, L);
      this.final = new Uint8Array(buf, sp.final, n);
      this.order = new Int32Array(buf, sp.order, n);
      if (this.prob.length) this.prob = new Float64Array(buf, sp.prob, L);
      net.inStart = move(net.inStart, Int32Array, sp.inStart);
      net.outStart = move(net.outStart, Int32Array, sp.outStart);
      net.inLinks = move(net.inLinks, Int32Array, sp.inLinks);
      net.outLinks = move(net.outLinks, Int32Array, sp.outLinks);
      net.tail = move(net.tail, Int32Array, sp.tail);
      net.head = move(net.head, Int32Array, sp.head);
      net.cost = move(net.cost, Float32Array, sp.cost);
      net.freq = move(net.freq, Float32Array, sp.freq);
      net.type = move(net.type, Uint8Array, sp.type);
      if (net.boardFor) net.boardFor = move(net.boardFor, Int32Array, sp.boardFor);
      net.destSets?.forEach((m, k) => new Uint8Array(buf, sp.destSets + k * setLen, setLen).set(m));
      const S = sinst.exports as unknown as SearchKernel;
      SEARCH_SLOTS.forEach((k, slot) => S.set(slot, sp[k]));
      S.setup(setLen, !!net.boardFor, muslExp);
      this.S = S;
    }
    this.C = new Float64Array(buf, kp.C, this.C.length);
    this.accShare = new Float64Array(buf, kp.share, net.nLinks);
    this.va = new Float64Array(buf, kp.va, Math.max(1, maxQ));
    this.bS = new Float64Array(buf, kp.Sp, maxNp + 2);
    this.bWk = new Float64Array(buf, kp.Wp, maxNp + 2);
    new Float32Array(buf, kp.ptE, E).set(this.ptE!);
    this.ptE = new Float32Array(buf, kp.ptE, E);
    net.accPtMin = move(net.accPtMin!, Float32Array, kp.ptMin);
    const qAcc = new Int32Array(buf, kp.qAcc, Q), qLink = new Int32Array(buf, kp.qLink, Q), qHead = new Int32Array(buf, kp.qHead, Q);
    for (let q = 0; q < Q; q++) {
      const a = net.outLinks[q];
      qAcc[q] = net.accPt![a];
      qLink[q] = a;
      qHead[q] = net.head[a];
    }
    this.K = inst.exports as unknown as BlocksKernel;
  }

  private push(id: number, key: number) {
    if (this.S) return this.S.push(id, key);
    if (this.heapSize === this.heapId.length) {
      const a = new Int32Array(this.heapId.length * 2), b = new Float64Array(this.heapId.length * 2);
      a.set(this.heapId), b.set(this.heapKey);
      this.heapId = a;
      this.heapKey = b;
    }
    const ids = this.heapId, keys = this.heapKey;
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  private pop(): number {
    const ids = this.heapId, keys = this.heapKey;
    const top = ids[0];
    const id = ids[--this.heapSize], key = keys[this.heapSize];
    let i = 0;
    const n = this.heapSize;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= key) break;
      ids[i] = ids[c];
      keys[i] = keys[c];
      i = c;
    }
    ids[i] = id;
    keys[i] = key;
    return top;
  }

  /**
   * Compute the strategy to destination zone d. Labels for origin zones are left in u / C.
   *
   * With the transfer logit (PATH.transferLogit), the search runs PATH.transferPasses times: each
   * pass after the first sees, at every line node, the transfer branch (transferBranch) built from
   * the previous pass's labels, and the last pass is the strategy that is loaded.
   */
  /** the destination of the last solve (lines for some riders only, in the transfer branch) */
  private dest = -1;
  /**
   * `need`: the origin zones whose labels are wanted (by default all); the others are left unlabeled
   * (Infinity), e.g. zones with no trips to d when loading.
   */
  solve(d: number, need?: (o: number) => boolean) {
    this.dest = d;
    const passes = PATH.transferLogit && PATH.egressLogit ? Math.max(1, this.net.transferPasses ?? PATH.transferPasses) : 1;
    if (PATH.egressLogit) this.egressBranch(d);
    this.xfer = false;
    for (let pass = 0; pass < passes; pass++) {
      if (pass > 0) {
        this.snapshot();
        this.transferBranch();
        this.xfer = true;
      }
      // the origin zones are labeled in the last pass only: the transfer branch reads stops' and
      // boarding nodes' labels, and paths never pass through a zone
      this.search(d, pass === passes - 1 ? (need ?? true) : false);
    }
  }

  /** one optimal-strategy search to d, and (`origins`) the origin zones' logit over their access stops */
  private search(d: number, origins: boolean | ((o: number) => boolean) = true) {
    const net = this.net;
    const { u, F, sumFC, C, succ, attractive, final } = this;
    const n = net.nNodes;
    // bulk fills (memset) are cheaper than per-node resets: almost every node is reached
    u.fill(Infinity);
    F.fill(0);
    sumFC.fill(0);
    C.fill(0);
    succ.fill(-1);
    final.fill(0);
    this.cur++;
    const cur = this.cur;
    this.nOrder = 0;
    this.heapSize = 0;
    this.S?.reset();
    const nZones = net.nZones;
    const { inStart, inLinks, tail, cost, freq, type, comp } = net;
    const alpha = this.alpha;
    const info = PATH.lineSplit === 'information';
    const egr = PATH.egressLogit;
    if (egr) this.seedEgress();
    if (this.xfer) this.seedTransfer();
    // lines for some riders only (UCSF's shuttles) are boarded away from their open stops only by
    // riders bound for one of their zones
    const boardFor = net.boardFor, destSets = net.destSets;
    if (this.S) {
      // (the seeds above went to its heap)
      this.S.run(d, nZones, cur, egr, info, alpha, PATH.informedShare, PATH.waitWeight);
      this.nOrder = this.S.orderCount();
    } else {
      u[d] = 0;
      this.push(d, 0);
      while (this.heapSize) {
        const key = this.heapKey[0];
        const j = this.pop();
        if (final[j] || key > u[j]) continue;
        final[j] = 1;
        this.order[this.nOrder++] = j;
        // origin zones end paths: never pass through another zone
        if (j < nZones && j !== d) continue;
        // with the egress logit, getting off for d is the egress branch (seeded above), not its links
        if (egr && j === d) continue;
        const uj = u[j];
        const jc = j * NC;
        for (let k = inStart[j]; k < inStart[j + 1]; k++) {
          const a = inLinks[k];
          const i = tail[a];
          // zones are labelled after the search, by a logit over their access stops
          if (i < nZones) continue;
          if (final[i]) continue;
          // only the destination's own egress links lead into a zone
          const cand = uj + cost[a];
          if (type[a] === LINK_BOARD) {
            if (cand >= u[i]) continue;
            if (boardFor && boardFor[a] >= 0 && !destSets![boardFor[a]][d]) continue;
            const f = freq[a];
            if (f <= 0) continue;
            if (info) {
              attractive[a] = cur;
              this.combineInformed(i);
              this.push(i, u[i]);
              continue;
            }
            const Fi = F[i] + f;
            const ic = i * NC;
            for (let q = 0; q < NC; q++) sumFC[ic + q] += f * C[jc + q];
            // u_i = (α + Σ f_a (u_j + c_a)) / Σ f_a, kept as running sums
            const prevSum = F[i] > 0 ? u[i] * F[i] - alpha : 0;
            F[i] = Fi;
            u[i] = (alpha + prevSum + f * cand) / Fi;
            for (let q = 0; q < NC; q++) C[ic + q] = sumFC[ic + q] / Fi;
            C[ic + C_WAIT] += 0.5 / Fi;
            attractive[a] = cur;
            this.push(i, u[i]);
          } else if (cand < u[i]) {
            u[i] = cand;
            succ[i] = a;
            const ic = i * NC, ac = a * NC;
            for (let q = 0; q < NC; q++) C[ic + q] = C[jc + q] + comp[ac + q];
            this.push(i, cand);
          }
        }
      }
    }
    // origin zones: spread over access stops by a logit on their cost
    const { outStart, outLinks, head } = net;
    const th = PATH.accessTheta;
    const nBlockZones = this.ptE ? net.zonePtStart!.length - 1 : 0;
    for (let o = 0; o < nZones && origins; o++) {
      if (o === d || (origins !== true && !origins(o))) continue;
      if (o < nBlockZones) {
        this.blockOrigin(o);
        continue;
      }
      let m = Infinity;
      for (let q = outStart[o]; q < outStart[o + 1]; q++) {
        const a = outLinks[q];
        const v = u[head[a]] + cost[a];
        if (v < m) m = v;
      }
      if (m === Infinity) continue;
      let sum = 0;
      for (let q = outStart[o]; q < outStart[o + 1]; q++) {
        const a = outLinks[q];
        const v = u[head[a]] + cost[a];
        if (v < Infinity) sum += Math.exp(-th * (v - m));
      }
      u[o] = m - Math.log(sum) / th;
      const oc = o * NC;
      for (let q = outStart[o]; q < outStart[o + 1]; q++) {
        const a = outLinks[q];
        const v = u[head[a]] + cost[a];
        if (v === Infinity) continue;
        const p = Math.exp(-th * (v - m)) / sum;
        const hc = head[a] * NC, ac = a * NC;
        for (let c = 0; c < NC; c++) C[oc + c] += p * (C[hc + c] + comp[ac + c]);
      }
    }
    void n;
  }

  /**
   * The attractive lines at boarding node i, combined for riders who know when each will come
   * (PATH.lineSplit 'information'; Gentile, Nguyen & Pallottino 2005, "Route choice on transit
   * networks with online information at stops", Transportation Science 39(3)). Each line's wait is
   * exponential with mean half its effective headway, as in Spiess & Florian's combined wait; a rider
   * who sees the waits takes the line with the least perceived cost, waitWeight · wait + u_line. With
   * the lines sorted by u, the chance that no line has yet come at a lower cost falls piecewise
   * exponentially, so the expected cost and each line's share are exact sums over the intervals
   * between the u's. With equal u's this is the frequency share and wait of optimal strategies; a
   * slower line among faster ones gets less than its frequency share (a local beside a rapid, a long
   * way round beside a direct line). Lines join as in optimal strategies, while they beat the
   * current expected cost.
   */
  private combineInformed(i: number) {
    const net = this.net;
    const { outStart, outLinks, head, freq } = net;
    const { u, C, attractive, cur } = this;
    const W = PATH.waitWeight;
    const L = this.infoL, U = this.infoU, R = this.infoR;
    let n = 0;
    for (let q = outStart[i]; q < outStart[i + 1]; q++) {
      const a = outLinks[q];
      if (attractive[a] !== cur) continue;
      L[n] = a;
      U[n] = u[head[a]];
      // the perceived wait W·w is exponential with rate 2f/W (mean W/(2f): half the headway, weighted)
      R[n] = (2 * freq[a]) / W;
      n++;
    }
    this.sortInfo(n);
    const E = this.informed(n);
    // line k is taken at a cost x ≥ u_k with density rate_k · (that chance)
    const prob = this.prob, Pk = this.infoP, ic = i * NC;
    for (let c = 0; c < NC; c++) C[ic + c] = 0;
    // informed riders (PATH.informedShare); the rest take the first line of the optimal-strategy set
    // to come, by frequency (Spiess & Florian): the lines, by cost, while each beats the set's cost
    const a = PATH.informedShare;
    let ride = 0;
    for (let k = 0; k < n; k++) {
      const p = a * Pk[k];
      prob[L[k]] = p;
      ride += p * U[k];
      const hc = head[L[k]] * NC;
      for (let c = 0; c < NC; c++) C[ic + c] += p * C[hc + c];
    }
    let Ef = 0, waitF = 0;
    if (a < 1) {
      Ef = this.firstLine(n);
      const m = this.flM, Fs = this.flF;
      waitF = 0.5 / Fs;
      for (let k = 0; k < m; k++) {
        const p = ((1 - a) * freq[L[k]]) / Fs;
        prob[L[k]] += p;
        const hc = head[L[k]] * NC;
        for (let c = 0; c < NC; c++) C[ic + c] += p * C[hc + c];
      }
    }
    u[i] = a * E + (1 - a) * Ef;
    // the expected wait is what the expected cost adds to the expected ride
    C[ic + C_WAIT] += (a * E - ride) / W + (1 - a) * waitF;
    this.F[i] = 1;
  }

  /**
   * The riders who take the first line to come (1 − PATH.informedShare), over the first n lines in
   * infoL/infoU (sorted by u): lines join while each beats the set's expected cost (Spiess & Florian).
   * Returns that cost; the set's size and combined frequency are left in flM and flF.
   */
  private flM = 0;
  private flF = 0;
  private firstLine(n: number): number {
    const L = this.infoL, U = this.infoU, freq = this.net.freq;
    const alpha = 0.5 * PATH.waitWeight;
    let Fs = 0, sum = 0, m = 0;
    for (; m < n; m++) {
      if (m > 0 && U[m] >= (alpha + sum) / Fs) break;
      const f = freq[L[m]];
      Fs += f;
      sum += f * U[m];
    }
    this.flM = m;
    this.flF = Fs;
    return (alpha + sum) / Fs;
  }

  /** sort the first n lines in infoL/U/R by u (insertion sort: a stop has few lines) */
  private sortInfo(n: number) {
    const L = this.infoL, U = this.infoU, R = this.infoR;
    for (let x = 1; x < n; x++) {
      const a = L[x], uu = U[x], rr = R[x];
      let y = x - 1;
      while (y >= 0 && U[y] > uu) (L[y + 1] = L[y]), (U[y + 1] = U[y]), (R[y + 1] = R[y]), y--;
      (L[y + 1] = a), (U[y + 1] = uu), (R[y + 1] = rr);
    }
  }

  /**
   * Informed riders' expected cost over the first n lines in infoU/infoR (sorted by u), and each
   * line's share in infoP (combineInformed)
   */
  private informed(n: number): number {
    const U = this.infoU, R = this.infoR, Ik = this.infoI, Pk = this.infoP;
    // Ik[k]: the integral over [u_k, u_k+1) of the chance that no line has come at a lower cost
    let g = 1, lam = 0, E = U[0];
    for (let k = 0; k < n; k++) {
      lam += R[k];
      const decay = k + 1 < n ? Math.exp(-lam * (U[k + 1] - U[k])) : 0;
      Ik[k] = (g * (1 - decay)) / lam;
      E += Ik[k];
      g *= decay;
    }
    let tail = 0;
    for (let k = n - 1; k >= 0; k--) {
      tail += Ik[k];
      Pk[k] = R[k] * tail;
    }
    return E;
  }

  /**
   * A city zone's riders choose their access stop block by block (PATH.blockAccess). Riders from
   * block p take stop a with probability ∝ exp(−θ (walk_pa + u_a)), the same logit as for a whole
   * zone but with each block's own walk; the zone's split is the people-weighted mix over its blocks
   * that reach any stop. Blocks beyond reach of every stop add −ln(share reached)/θ, as the zone-level
   * walk-access share does (skims.ts). Its label is the blocks' mean expected cost.
   */
  private blockOrigin(o: number) {
    const net = this.net;
    const { outStart, outLinks, head, cost, comp } = net;
    const { u, C } = this;
    const accPt = net.accPt!, ptMin = net.accPtMin!, ptE = this.ptE!, share = this.accShare!;
    const p0 = net.zonePtStart![o], np = net.zonePtStart![o + 1] - p0, w = net.zonePtShare!;
    const th = PATH.accessTheta;
    const q0 = outStart[o], q1 = outStart[o + 1];
    let m = Infinity;
    for (let q = q0; q < q1; q++) {
      const v = u[head[outLinks[q]]] + cost[outLinks[q]];
      if (v < m) m = v;
    }
    if (m === Infinity) return;
    const va = this.va.length >= q1 - q0 ? this.va : (this.va = new Float64Array(2 * (q1 - q0)));
    for (let q = q0; q < q1; q++) {
      const a = outLinks[q];
      const v = u[head[a]] + cost[a];
      va[q - q0] = v < Infinity ? Math.exp(-th * (v - m)) : 0;
      share[a] = 0;
    }
    // each block's sum over the stops, link by link (a link's block walks are contiguous, so the
    // loops run with the link outside: the same sums, in the same order, as block by block)
    const Sp = this.bS.length >= np ? this.bS : (this.bS = new Float64Array(2 * np));
    const Wp = this.bWk.length >= np ? this.bWk : (this.bWk = new Float64Array(2 * np));
    Sp.fill(0, 0, np);
    Wp.fill(0, 0, np);
    const K = this.K, kp = this.kp;
    if (K) K.blockSums(q0, q1, np, kp.va, kp.qAcc, kp.ptE, kp.Sp);
    else
      for (let q = q0; q < q1; q++) {
        const off = accPt[outLinks[q]];
        if (off < 0) continue;
        const vq = va[q - q0];
        for (let p = 0; p < np; p++) Sp[p] += vq * ptE[off + p];
      }
    let r = 0, ls = 0, walk = 0;
    for (let p = 0; p < np; p++) {
      const S = Sp[p];
      if (!(S > 0)) continue;
      const wp = w[p0 + p];
      r += wp;
      ls += wp * (m - Math.log(S) / th);
      // each block's weight over its sum, for the shares below
      Sp[p] = wp / S;
    }
    if (K) walk = K.blockShares(q0, q1, np, kp.va, kp.qAcc, kp.qLink, kp.ptE, kp.ptMin, kp.Sp, kp.Wp, kp.share);
    else {
      for (let q = q0; q < q1; q++) {
        const a = outLinks[q], off = accPt[a];
        if (off < 0) continue;
        const vq = va[q - q0];
        let sh = 0;
        for (let p = 0; p < np; p++) {
          const S = Sp[p];
          // (a block beyond every stop has S = 0 and adds nothing)
          const e = S > 0 && vq > 0 ? vq * ptE[off + p] * S : 0;
          if (!(e > 0)) continue;
          sh += e;
          Wp[p] += e * ptMin[off + p];
        }
        share[a] = sh;
      }
      for (let p = 0; p < np; p++) walk += Wp[p];
    }
    if (!(r > 0)) return;
    // the share of the zone beyond reach of any stop, as walking (minutes) and as cost
    const shareMin = -Math.log(r) / (th * PATH.walkWeight);
    u[o] = ls / r - Math.log(r) / th;
    const oc = o * NC;
    if (K) K.blockComponents(o, q0, q1, r, kp.qLink, kp.qHead, kp.comp, kp.share, kp.C);
    else
      for (let q = q0; q < q1; q++) {
        const a = outLinks[q];
        const sh = (share[a] /= r);
        if (!(sh > 0)) continue;
        const hc = head[a] * NC, ac = a * NC;
        for (let c = 0; c < NC; c++) C[oc + c] += sh * (C[hc + c] + comp[ac + c]);
      }
    C[oc + C_TIME] += walk / r + shareMin;
    C[oc + C_WALK] += walk / r + shareMin;
  }

  /**
   * Where riders get off for destination d (PATH.egressLogit), the mirror of blockOrigin. A rider on
   * a line who is going to block p of d gets off at the j-th of the line's stops serving d (after
   * the one they are at) with probability ∝ exp(−θ c_jp), where c_jp is the rest of the ride to it,
   * getting off, and block p's walk from it: the logit of getting on, with the same θ and the same
   * block walks. Its cost from line node k is the blocks' mean logsum, −(1/θ) Σ_p w_p ln Σ_j
   * exp(−θ c_jp), over the blocks within reach of some stop, plus −ln(share reached)/θ, as at the
   * origin. Riding on or getting off, stop by stop, is a recursive logit, so the logsums are exact
   * along each line: G_jp = logsum(get off at j, ride to the next place j′ + G_j′p).
   *
   * Each line node k before a place to get off is seeded with that cost, the egress branch: an option
   * beside riding on and changing lines, which the strategy search then weighs as any other (a rider
   * takes the branch at the first node where it is best, and inside it only rides on, gets off, and
   * walks). The destination's own egress links leave the search. A rider who boards at k does not
   * get off at k. The branch's expected components (ride, walk, fare...) are carried as for any
   * strategy. Zones without blocks (outside the city) are one block, at the egress link's cost.
   */
  private egressBranch(d: number) {
    const net = this.net;
    const { inStart, inLinks, type, tail, line, pos, cost, comp } = net;
    const th = PATH.accessTheta, walkW = PATH.walkWeight;
    // the places to get off: every alight link into a stop with an egress link to d
    let n = 0;
    for (let q = inStart[d]; q < inStart[d + 1]; q++) {
      const e = inLinks[q];
      if (type[e] !== LINK_EGRESS) continue;
      const A = tail[e];
      for (let r = inStart[A]; r < inStart[A + 1]; r++) {
        const a = inLinks[r];
        if (type[a] !== LINK_ALIGHT) continue;
        if (n === this.eLine.length) this.growEntries();
        this.eLine[n] = line[a];
        this.ePos[n] = pos[a];
        this.eAl[n] = a;
        this.eEg[n] = e;
        n++;
      }
    }
    this.eN = n;
    this.gStart.length = 0;
    if (!n) return;
    // by line, then position
    const L = this.eLine, P0 = this.ePos, EA = this.eAl, EE = this.eEg;
    const idx = Array.from({ length: n }, (_, i) => i).sort((x, y) => L[x] - L[y] || P0[x] - P0[y]);
    const sl = idx.map((i) => L[i]), sp = idx.map((i) => P0[i]), sa = idx.map((i) => EA[i]), se = idx.map((i) => EE[i]);
    for (let i = 0; i < n; i++) (L[i] = sl[i]), (P0[i] = sp[i]), (EA[i] = sa[i]), (EE[i] = se[i]);
    for (let i = 0; i < n; i++) if (i === 0 || L[i] !== L[i - 1]) this.gStart.push(i);
    this.gStart.push(n);
    // the destination's blocks, their shares and walks (outside the city, one block)
    const egrPt = net.egrPt, ptMin = net.accPtMin, plat = net.platMin;
    const blocks = !!(egrPt && net.zonePtStart && d < net.zonePtStart.length - 1);
    const p0 = blocks ? net.zonePtStart![d] : 0;
    const nB = blocks ? net.zonePtStart![d + 1] - p0 : 1;
    this.nB = nB;
    if (this.bW.length < nB) this.bW = new Float64Array(2 * nB);
    for (let p = 0; p < nB; p++) this.bW[p] = blocks ? net.zonePtShare![p0 + p] : 1;
    if (this.bG.length < n * nB) (this.bG = new Float64Array(2 * n * nB)), (this.bP = new Float64Array(2 * n * nB));
    if (this.bCa.length < nB * NC) (this.bCa = new Float64Array(2 * nB * NC)), (this.bCb = new Float64Array(2 * nB * NC));
    const W = this.bW, G = this.bG, PR = this.bP, eG = this.eG, eR = this.eR, eC = this.eC;
    const rideC = this.rideC, exC = this.exC;
    const ls = net.lineStart, rideOf = this.rideOf;
    for (let g = 0; g + 1 < this.gStart.length; g++) {
      const i0 = this.gStart[g], i1 = this.gStart[g + 1];
      const nb = ls[L[i0]];
      // backwards over the places to get off: per block, the logsum and the chance of getting off
      let next = this.bCa, cur = this.bCb;
      for (let i = i1 - 1; i >= i0; i--) {
        const last = i === i1 - 1;
        let dRide = 0;
        rideC.fill(0);
        if (!last)
          for (let k = P0[i]; k < P0[i + 1]; k++) {
            const a = rideOf[nb + k];
            dRide += cost[a];
            for (let c = 0; c < NC; c++) rideC[c] += comp[a * NC + c];
          }
        const al = EA[i], eg = EE[i];
        const off = blocks ? egrPt![eg] : -1;
        const s = tail[eg] - net.nZones;
        let r = 0, lsum = 0;
        const mix = eC.subarray(i * NC, i * NC + NC);
        mix.fill(0);
        for (let p = 0; p < nB; p++) {
          // getting off here and walking to block p, or riding on
          const walk = off >= 0 ? plat[s] + ptMin![off + p] : 0;
          const ex = off >= 0 ? cost[al] + walkW * walk : cost[al] + cost[eg];
          const cont = last ? Infinity : dRide + G[(i + 1) * nB + p];
          const m = Math.min(ex, cont);
          const k = i * nB + p;
          if (m === Infinity) {
            G[k] = Infinity;
            PR[k] = 0;
            continue;
          }
          const gp = m - Math.log((ex < Infinity ? Math.exp(-th * (ex - m)) : 0) + (cont < Infinity ? Math.exp(-th * (cont - m)) : 0)) / th;
          const pr = ex < Infinity ? Math.exp(-th * (ex - gp)) : 0;
          G[k] = gp;
          PR[k] = pr;
          const cb = p * NC;
          for (let c = 0; c < NC; c++) cur[cb + c] = 0;
          if (pr > 0) {
            for (let c = 0; c < NC; c++) exC[c] = comp[al * NC + c] + (off >= 0 ? 0 : comp[eg * NC + c]);
            if (off >= 0) (exC[C_TIME] += walk), (exC[C_WALK] += walk);
            for (let c = 0; c < NC; c++) cur[cb + c] += pr * exC[c];
          }
          if (cont < Infinity) for (let c = 0; c < NC; c++) cur[cb + c] += (1 - pr) * (rideC[c] + next[cb + c]);
          r += W[p];
          lsum += W[p] * gp;
          for (let c = 0; c < NC; c++) mix[c] += W[p] * cur[cb + c];
        }
        eR[i] = r;
        if (r > 0) {
          eG[i] = lsum / r - Math.log(r) / th;
          for (let c = 0; c < NC; c++) mix[c] /= r;
          // the share of the zone beyond reach, as walking (blockOrigin)
          const shareMin = -Math.log(r) / (th * walkW);
          mix[C_TIME] += shareMin;
          mix[C_WALK] += shareMin;
        } else eG[i] = Infinity;
        const tmp = next;
        next = cur;
        cur = tmp;
      }
    }
  }

  /** seed each line's nodes before its last place to get off for d with the egress branch (egressBranch) */
  private seedEgress() {
    const net = this.net;
    const { cost, comp } = net;
    const { u, C, succ } = this;
    const P0 = this.ePos, eG = this.eG, eC = this.eC, arrC = this.arrC;
    const L0 = this.L0, ls = net.lineStart, rideOf = this.rideOf;
    for (let g = 0; g + 1 < this.gStart.length; g++) {
      const i0 = this.gStart[g], i1 = this.gStart[g + 1];
      const nb = ls[this.eLine[i0]];
      // ride on, then the branch
      let arr = Infinity;
      let ip = i1 - 1;
      for (let k = P0[i1 - 1]; k >= 0; k--) {
        if (k < P0[i1 - 1] && arr < Infinity) {
          const a = rideOf[nb + k];
          const node = L0 + nb + k;
          arr += cost[a];
          for (let c = 0; c < NC; c++) arrC[c] += comp[a * NC + c];
          u[node] = arr;
          succ[node] = -2;
          for (let c = 0; c < NC; c++) C[node * NC + c] = arrC[c];
          this.push(node, arr);
        }
        // arriving at k by riding: the branch from its first place to get off, if it has one
        while (ip >= i0 && P0[ip] > k) ip--;
        if (ip >= i0 && P0[ip] === k) {
          while (ip > i0 && P0[ip - 1] === k) ip--;
          arr = eG[ip];
          for (let c = 0; c < NC; c++) arrC[c] = eC[ip * NC + c];
        }
      }
    }
  }
  /** keep the last pass's labels and strategy, for the transfer branch of the next (transferBranch) */
  private snapshot() {
    const net = this.net, nLN = this.rideOf.length;
    if (!this.uP || this.probP!.length !== this.prob.length) {
      this.uP = new Float64Array(net.nNodes);
      this.CP = new Float64Array(net.nNodes * NC);
      this.FP = new Float64Array(net.nNodes);
      this.attP = new Int32Array(net.nLinks);
      this.probP = new Float64Array(this.prob.length);
      this.xP = new Float64Array(nLN);
      this.xLnk = new Int32Array(nLN);
      this.xOff = new Int32Array(nLN);
      this.xCnt = new Int32Array(nLN);
      this.tbU = new Float64Array(nLN);
      this.tbC = new Float64Array(nLN * NC);
      this.xferVol = new Float64Array(nLN);
    }
    this.uP.set(this.u);
    this.CP!.set(this.C);
    this.FP!.set(this.F);
    this.attP!.set(this.attractive);
    this.probP!.set(this.prob);
    this.curP = this.cur;
  }

  /**
   * Where riders get off a line to change (PATH.transferLogit), the counterpart of egressBranch. A
   * rider arriving at the j-th stop of a line gets off there to change with probability
   * exp(−θ T_j) / (exp(−θ T_j) + exp(−θ (r_j + W_j+1))), where T_j is getting off and the best
   * strategy onward from the stop (a change at the stop or a walk to another, then the lines worth
   * waiting for there), r_j the ride to the next stop, and W the logsum of doing the same from there:
   * W_j = −(1/θ) ln(exp(−θ T_j) + exp(−θ (r_j + W_j+1))), with θ the access and egress logit's. This
   * is a recursive logit along the line (Fosgerau, Frejinger & Karlström 2013), exact because a line
   * only runs forward; at line node k, the branch is the ride to k+1 and W_k+1 (a rider who boards at
   * k does not get off at k). It is seeded at every line node as one more option beside riding on,
   * getting off, and the egress branch, which the strategy search weighs as any other: the logit
   * spreads the change over the stops where it can be made, within the optimal strategy.
   *
   * The onward strategies are the previous pass's (snapshot). Getting off to board the same line
   * again, or a line that runs on with it to its next stop, is not a change: the lines at the
   * strategy's next stop are the attractive ones without them (recombined as the search combines
   * them), so the logit does not count staying aboard as an alternative to itself.
   */
  private transferBranch() {
    const net = this.net;
    const { cost, comp, lineStart: ls } = net;
    const th = PATH.accessTheta;
    const xP = this.xP!, tbU = this.tbU!, tbC = this.tbC!, rideOf = this.rideOf;
    const cw = this.cwC, xc = this.xC;
    this.xsN = 0;
    for (let li = 0; li < net.lines.length; li++) {
      const base = ls[li], n = net.lines[li].stops.length;
      let W = Infinity;
      tbU[base + n - 1] = Infinity;
      for (let j = n - 1; j >= 1; j--) {
        // W: arriving at j + 1 by riding; now arriving at j
        const r = j < n - 1 ? rideOf[base + j] : -1;
        const cont = r >= 0 && W < Infinity ? cost[r] + W : Infinity;
        const T = this.transferAt(li, j);
        const m = Math.min(T, cont);
        if (m === Infinity) {
          W = Infinity;
          xP[base + j] = 0;
        } else {
          const eT = T < Infinity ? Math.exp(-th * (T - m)) : 0, eR = cont < Infinity ? Math.exp(-th * (cont - m)) : 0;
          W = m - Math.log(eT + eR) / th;
          const P = eT / (eT + eR);
          xP[base + j] = P;
          // components: P · (getting off here) + (1 − P) · (riding on)
          for (let c = 0; c < NC; c++) cw[c] = (P > 0 ? P * xc[c] : 0) + (P < 1 ? (1 - P) * (comp[r * NC + c] + cw[c]) : 0);
        }
        // the branch at line node j − 1: the ride to j, then W_j
        const k = base + j - 1, r0 = rideOf[k];
        if (W < Infinity) {
          tbU[k] = cost[r0] + W;
          for (let c = 0; c < NC; c++) tbC[k * NC + c] = comp[r0 * NC + c] + cw[c];
        } else tbU[k] = Infinity;
      }
    }
  }

  /**
   * T_j for the j-th stop of line li (transferBranch): getting off and the best change or walk onward,
   * with the lines that run on with li left out. Its components go to xC; the link taken and the lines
   * boarded after it are kept for loading.
   */
  private transferAt(li: number, j: number): number {
    const net = this.net;
    const { cost, comp, head } = net;
    const idx = net.lineStart[li] + j;
    const al = this.alightOf[idx];
    if (al < 0) return Infinity;
    const stops = net.lines[li].stops;
    const s = stops[j];
    const uP = this.uP!, CP = this.CP!;
    if (uP[net.nZones + s] === Infinity) return Infinity;
    const nx = j + 1 < stops.length ? stops[j + 1] : -1;
    let best = Infinity, bl = -1, bOff = 0, bCnt = -1;
    const xb = this.xBestC, xc = this.xC;
    for (let q = this.aOutStart[s]; q < this.aOutStart[s + 1]; q++) {
      const a = this.aOutLinks[q], X = head[a], ux = uP[X];
      if (ux === Infinity) continue;
      // the strategy without some lines costs no less than with them
      if (cost[a] + ux >= best) continue;
      if (!this.runsOnAt(X, li, nx)) {
        best = cost[a] + ux;
        bl = a;
        bCnt = -1;
        for (let c = 0; c < NC; c++) xb[c] = comp[a * NC + c] + CP[X * NC + c];
        continue;
      }
      const off = this.xsN;
      const v = this.subset(X, li, nx);
      if (cost[a] + v < best) {
        best = cost[a] + v;
        bl = a;
        bOff = off;
        bCnt = this.xsN - off;
        for (let c = 0; c < NC; c++) xb[c] = comp[a * NC + c] + xc[c];
      } else this.xsN = off;
    }
    if (best === Infinity) return Infinity;
    this.xLnk![idx] = bl;
    this.xOff![idx] = bOff;
    this.xCnt![idx] = bCnt;
    for (let c = 0; c < NC; c++) xc[c] = comp[al * NC + c] + xb[c];
    return cost[al] + best;
  }

  /** line l2 boarded at its stop p2 is line li, or runs on with it to li's next stop nx */
  private runsOn(l2: number, p2: number, li: number, nx: number) {
    return l2 === li || (nx >= 0 && this.net.lines[l2].stops[p2 + 1] === nx);
  }

  /** the previous pass's attractive lines at boarding node X include one that runs on with li */
  private runsOnAt(X: number, li: number, nx: number) {
    const { outStart, outLinks, line, pos } = this.net;
    const attP = this.attP!, curP = this.curP;
    for (let q = outStart[X]; q < outStart[X + 1]; q++) {
      const b = outLinks[q];
      if (attP[b] === curP && this.runsOn(line[b], pos[b], li, nx)) return true;
    }
    return false;
  }

  /**
   * The strategy at boarding node X without the lines that run on with li, on the previous pass's
   * labels: lines join in order of their cost while they beat the expected cost of those before, as
   * in the search. Appends the lines and their shares to xsLink/xsProb, puts the components in xC,
   * and returns the expected cost.
   */
  private subset(X: number, li: number, nx: number): number {
    const { outStart, outLinks, head, freq, line, pos } = this.net;
    const uP = this.uP!, CP = this.CP!;
    const info = PATH.lineSplit === 'information', W = PATH.waitWeight;
    const L = this.infoL, U = this.infoU, R = this.infoR, Pk = this.infoP;
    let n = 0;
    for (let q = outStart[X]; q < outStart[X + 1]; q++) {
      const b = outLinks[q], f = freq[b], uh = uP[head[b]];
      if (!(f > 0) || uh === Infinity || this.runsOn(line[b], pos[b], li, nx)) continue;
      // a line for some riders only, boarded away from its open stops (NetLine.restrict)
      const bf = this.net.boardFor?.[b] ?? -1;
      if (bf >= 0 && !this.net.destSets![bf][this.dest]) continue;
      L[n] = b;
      U[n] = uh;
      R[n] = info ? (2 * f) / W : f;
      n++;
    }
    if (!n) return Infinity;
    this.sortInfo(n);
    let m = 1, E: number, F = R[0];
    // (information: informed riders and those taking the first line to come, mixed as in
    // combineInformed; Ei is the informed riders' cost for the last set tried)
    const a = PATH.informedShare;
    let Ei = 0;
    const mixed = (k: number) => {
      Ei = this.informed(k);
      return a < 1 ? a * Ei + (1 - a) * this.firstLine(k) : Ei;
    };
    if (info) {
      E = mixed(1);
      while (m < n && U[m] < E) E = mixed(++m);
    } else {
      let S = R[0] * U[0];
      E = (this.alpha + S) / F;
      while (m < n && U[m] < E) {
        F += R[m];
        S += R[m] * U[m];
        E = (this.alpha + S) / F;
        m++;
      }
      for (let k = 0; k < m; k++) Pk[k] = R[k] / F;
    }
    if (this.xsN + m > this.xsLink.length) {
      const a = new Int32Array(2 * (this.xsN + m)), p = new Float64Array(2 * (this.xsN + m));
      a.set(this.xsLink);
      p.set(this.xsProb);
      this.xsLink = a;
      this.xsProb = p;
    }
    const xc = this.xC;
    xc.fill(0);
    let ride = 0;
    for (let k = 0; k < m; k++) {
      // informed riders' share (information) and the first-line riders', or the frequency share
      const pi = info ? a * Pk[k] : Pk[k];
      const p = pi + (info && a < 1 && k < this.flM ? ((1 - a) * freq[L[k]]) / this.flF : 0);
      this.xsLink[this.xsN] = L[k];
      this.xsProb[this.xsN++] = p;
      ride += pi * U[k];
      const hc = head[L[k]] * NC;
      for (let c = 0; c < NC; c++) xc[c] += p * CP[hc + c];
    }
    xc[C_WAIT] += info ? (a * Ei - ride) / W + (a < 1 ? (1 - a) * (0.5 / this.flF) : 0) : 0.5 / F;
    return E;
  }

  /** seed every line node with its transfer branch where it is the best option so far */
  private seedTransfer() {
    const { u, C, succ } = this;
    const tbU = this.tbU!, tbC = this.tbC!, L0 = this.L0;
    for (let k = 0; k < tbU.length; k++) {
      const v = tbU[k], node = L0 + k;
      if (!(v < u[node])) continue;
      u[node] = v;
      succ[node] = -3;
      for (let c = 0; c < NC; c++) C[node * NC + c] = tbC[k * NC + c];
      this.push(node, v);
    }
  }

  /**
   * Load the riders who took the transfer branch along their line: at each stop, the share of those
   * arriving who get off to change does so, takes the change or walk, and boards the lines of the
   * strategy there (transferAt), which the next sweep of load() carries on.
   */
  private loadXfer() {
    const net = this.net;
    const { lineStart: ls, head, outStart, outLinks, freq } = net;
    const { linkVol, nodeVol, rideOf, alightOf } = this;
    const xv = this.xferVol!, xP = this.xP!, xLnk = this.xLnk!, xOff = this.xOff!, xCnt = this.xCnt!;
    const attP = this.attP!, probP = this.probP!, FP = this.FP!, curP = this.curP;
    const info = PATH.lineSplit === 'information';
    for (let li = 0; li < net.lines.length; li++) {
      const base = ls[li], n = net.lines[li].stops.length;
      let any = false;
      for (let k = 0; k < n - 1; k++) if (xv[base + k] > 0) (any = true), (k = n);
      if (!any) continue;
      let v = 0;
      for (let k = 0; k < n; k++) {
        const idx = base + k;
        if (k > 0 && v > 0) {
          const x = v * xP[idx];
          if (x > 0) {
            v -= x;
            linkVol[alightOf[idx]] += x;
            const a = xLnk[idx];
            linkVol[a] += x;
            if (xCnt[idx] >= 0)
              for (let t = xOff[idx]; t < xOff[idx] + xCnt[idx]; t++) {
                const b = this.xsLink[t], y = x * this.xsProb[t];
                linkVol[b] += y;
                nodeVol[head[b]] += y;
              }
            else {
              const X = head[a];
              for (let q = outStart[X]; q < outStart[X + 1]; q++) {
                const b = outLinks[q];
                if (attP[b] !== curP) continue;
                const y = x * (info ? probP[b] : freq[b] / FP[X]);
                linkVol[b] += y;
                nodeVol[head[b]] += y;
              }
            }
            this.pending = true;
          }
        }
        if (k < n - 1) {
          v += xv[idx];
          xv[idx] = 0;
          if (v > 0) linkVol[rideOf[idx]] += v;
        }
      }
    }
  }

  private rideC = new Float64Array(NC);
  private exC = new Float64Array(NC);
  private arrC = new Float64Array(NC);

  private growEntries() {
    const m = this.eLine.length * 2;
    const g = (x: Int32Array) => {
      const y = new Int32Array(m);
      y.set(x);
      return y;
    };
    this.eLine = g(this.eLine);
    this.ePos = g(this.ePos);
    this.eAl = g(this.eAl);
    this.eEg = g(this.eEg);
    this.eG = new Float64Array(m);
    this.eR = new Float64Array(m);
    this.eC = new Float64Array(m * NC);
  }

  /**
   * Load the riders who took the egress branch (load()) along their line: from where they took it
   * to the first place to get off, where they are split by destination block; at each place, each
   * block's riders get off by its logit chance (egressBranch) and walk.
   */
  private loadBranch() {
    const { linkVol } = this;
    const net = this.net, ls = net.lineStart, rideOf = this.rideOf, bv = this.branchVol;
    const nB = this.nB, W = this.bW, G = this.bG, PR = this.bP, P0 = this.ePos, eR = this.eR;
    if (this.fB.length < nB) this.fB = new Float64Array(2 * nB);
    const f = this.fB;
    for (let g = 0; g + 1 < this.gStart.length; g++) {
      const i0 = this.gStart[g], i1 = this.gStart[g + 1];
      const nb = ls[this.eLine[i0]];
      const lastPos = P0[i1 - 1];
      let any = false;
      for (let k = 0; k < lastPos; k++) if (bv[nb + k] > 0) (any = true), (k = lastPos);
      if (!any) continue;
      f.fill(0, 0, nB);
      let pend = 0, tot = 0, ip = i0;
      for (let k = 0; k <= lastPos; k++) {
        let first = true;
        while (ip < i1 && P0[ip] === k) {
          // riders reaching their first place to get off: by block, over the blocks it reaches
          if (first && pend > 0 && eR[ip] > 0) {
            for (let p = 0; p < nB; p++) if (G[ip * nB + p] < Infinity) f[p] += (pend * W[p]) / eR[ip];
            tot += pend;
            pend = 0;
          }
          first = false;
          let off = 0;
          for (let p = 0; p < nB; p++) {
            const x = f[p] * PR[ip * nB + p];
            if (x > 0) (f[p] -= x), (off += x);
          }
          tot -= off;
          linkVol[this.eAl[ip]] += off;
          linkVol[this.eEg[ip]] += off;
          ip++;
        }
        if (k < lastPos) {
          pend += bv[nb + k];
          bv[nb + k] = 0;
          const v = pend + tot;
          if (v > 0) linkVol[rideOf[nb + k]] += v;
        }
      }
    }
  }
  private fB = new Float64Array(64);

  /** labels of node i in the last solve (Infinity if it was never reached) */
  label(i: number): number {
    return this.u[i];
  }

  /**
   * Load demand to the last solved destination: `demand(o)` trips from each zone o. Adds to
   * linkVol (call resetVolumes() between periods).
   */
  load(demand: (o: number) => number) {
    const net = this.net;
    const { u, F, succ, attractive, nodeVol, linkVol, cur, nodeDone } = this;
    const { outStart, outLinks, freq, head } = net;
    nodeVol.fill(0);
    nodeDone.fill(0);
    let any = false;
    const th = PATH.accessTheta;
    const nBlockZones = this.ptE ? net.zonePtStart!.length - 1 : 0;
    const info = PATH.lineSplit === 'information';
    const cost = net.cost;
    for (let o = 0; o < net.nZones; o++) {
      // (a trip within the destination zone is not a transit trip)
      if (o === this.dest) continue;
      const v = demand(o);
      if (!(v > 0) || u[o] === Infinity) continue;
      any = true;
      if (o < nBlockZones) {
        // the block-by-block split worked out in solve()
        for (let q = outStart[o]; q < outStart[o + 1]; q++) {
          const a = outLinks[q];
          const sh = this.accShare![a];
          if (!(sh > 0)) continue;
          linkVol[a] += v * sh;
          nodeVol[head[a]] += v * sh;
        }
        continue;
      }
      // the same logit split as in solve(): p = exp(-θ(v_a - u_o)) sums to one by construction
      for (let q = outStart[o]; q < outStart[o + 1]; q++) {
        const a = outLinks[q];
        const c = u[head[a]] + cost[a];
        if (c === Infinity) continue;
        const share = v * Math.exp(-th * (c - u[o]));
        linkVol[a] += share;
        nodeVol[head[a]] += share;
      }
    }
    if (!any) return;
    // Sweep from the origins' side; riders who change out of a transfer branch board lines that may
    // come earlier in the sweep (a logit spreads riders onto options dearer than the label), so the
    // sweep repeats for them until none are left (a few rounds: one per further change).
    for (let round = 0; round < 32; round++) {
      for (let k = this.nOrder - 1; k >= 0; k--) {
        const i = this.order[k];
        const v = nodeVol[i];
        if (v <= 0) continue;
        nodeVol[i] = 0;
        nodeDone[i] += v;
        if (F[i] > 0) {
          const Fi = F[i];
          for (let q = outStart[i]; q < outStart[i + 1]; q++) {
            const a = outLinks[q];
            if (attractive[a] !== cur) continue;
            const share = info ? v * this.prob[a] : (v * freq[a]) / Fi;
            linkVol[a] += share;
            nodeVol[head[a]] += share;
          }
        } else {
          const a = succ[i];
          // the egress and transfer branches: loaded below, along the line
          if (a === -2) this.branchVol[i - this.L0] += v;
          else if (a === -3) this.xferVol![i - this.L0] += v;
          if (a < 0) continue;
          linkVol[a] += v;
          nodeVol[head[a]] += v;
        }
      }
      if (PATH.egressLogit) this.loadBranch();
      this.pending = false;
      if (this.xfer) this.loadXfer();
      if (!this.pending) break;
    }
    // what arrived at each node in all (the sweeps passed it on as they went)
    for (let i = 0; i < nodeVol.length; i++) nodeVol[i] += nodeDone[i];
  }

  resetVolumes() {
    this.linkVol.fill(0);
  }
}
