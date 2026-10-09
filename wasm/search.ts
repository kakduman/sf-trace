/**
 * AssemblyScript: one optimal-strategy search to a destination (shared/beta3/strategy.ts
 * StrategySolver.search, its main loop): the heap, the labels, and the lines' combination at each
 * boarding node, for frequency-share and informed riders (combineInformed). The origin zones'
 * access logit and the egress and transfer branches' seeds stay in TypeScript, which calls push()
 * for the seeds before run().
 *
 * exp: by default the page's own Math.exp, imported (env.jsexp), so the search equals the
 * TypeScript bit for bit; or (setup's `muslExp`) AssemblyScript's NativeMath.exp, a port of musl's
 * (ARM optimized-routines, table-based, < 1 ulp). V8's Math.exp is fdlibm's, compiled with fused
 * multiply-adds where the platform has them, so no portable exp matches it bit for bit, and a
 * last-bit difference can tip a line in or out of a stop's attractive set: musl's moves some link
 * volumes by up to about 1e-4 (test/beta3-wasm.test.ts).
 *
 * Memory is the caller's (--importMemory), shared with wasm/blocks.ts; set() gives the byte offset
 * of every array (see SLOT), once per solver.
 */

const NC = 10;
const C_WAIT = 3;
const LINK_BOARD: u8 = 4;

// the arrays' byte offsets in memory, by slot (set())
const U = 0, F = 1, SUMFC = 2, C = 3, SUCC = 4, ATT = 5, FINAL = 6, ORDER = 7, HID = 8, HKEY = 9, PROB = 10;
const IN_START = 11, IN_LINKS = 12, TAIL = 13, COST = 14, FREQ = 15, TYPE = 16, COMP = 17, BOARD_FOR = 18, DEST_SETS = 19;
const OUT_START = 20, OUT_LINKS = 21, HEAD = 22, INFO_L = 23, INFO_U = 24, INFO_R = 25, INFO_I = 26, INFO_P = 27;
const SLOTS = 28;
/** the offsets, in a static segment below the caller's arrays (which start at 64 KB) */
const P: usize = memory.data(SLOTS * 4);
@inline function ptr(slot: i32): usize {
  return load<u32>(P + (<usize>slot << 2));
}

let heapSize: i32 = 0;
let nOrder: i32 = 0;
/** the destination sets' length (zones), and whether any link has a set */
let setLen: i32 = 0;
let hasBoardFor: bool = false;
/** exp: musl's (true) or the page's Math.exp (false) */
let musl: bool = false;

@external("env", "jsexp")
declare function jsexp(x: f64): f64;
@inline function exp(x: f64): f64 {
  return musl ? Math.exp(x) : jsexp(x);
}

export function set(slot: i32, at: usize): void {
  store<u32>(P + (<usize>slot << 2), <u32>at);
}
export function setup(zones: i32, boardFor: bool, muslExp: bool): void {
  setLen = zones;
  hasBoardFor = boardFor;
  musl = muslExp;
}
export function reset(): void {
  heapSize = 0;
  nOrder = 0;
}
export function orderCount(): i32 {
  return nOrder;
}

@inline function f64at(slot: i32, i: i32): f64 {
  return load<f64>(ptr(slot) + (<usize>i << 3));
}
@inline function f64put(slot: i32, i: i32, v: f64): void {
  store<f64>(ptr(slot) + (<usize>i << 3), v);
}
@inline function i32at(slot: i32, i: i32): i32 {
  return load<i32>(ptr(slot) + (<usize>i << 2));
}
@inline function i32put(slot: i32, i: i32, v: i32): void {
  store<i32>(ptr(slot) + (<usize>i << 2), v);
}
@inline function f32at(slot: i32, i: i32): f64 {
  return <f64>load<f32>(ptr(slot) + (<usize>i << 2));
}
@inline function u8at(slot: i32, i: i32): u8 {
  return load<u8>(ptr(slot) + <usize>i);
}

/** the heap: least key first; equal keys in the same order as the TypeScript's heap */
export function push(id: i32, key: f64): void {
  const ids = ptr(HID), keys = ptr(HKEY);
  let i = heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const kp = load<f64>(keys + (<usize>p << 3));
    if (kp <= key) break;
    store<i32>(ids + (<usize>i << 2), load<i32>(ids + (<usize>p << 2)));
    store<f64>(keys + (<usize>i << 3), kp);
    i = p;
  }
  store<i32>(ids + (<usize>i << 2), id);
  store<f64>(keys + (<usize>i << 3), key);
}
function pop(): i32 {
  const ids = ptr(HID), keys = ptr(HKEY);
  const top = load<i32>(ids);
  heapSize--;
  const id = load<i32>(ids + (<usize>heapSize << 2)), key = load<f64>(keys + (<usize>heapSize << 3));
  let i = 0;
  const n = heapSize;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && load<f64>(keys + (<usize>(c + 1) << 3)) < load<f64>(keys + (<usize>c << 3))) c++;
    const kc = load<f64>(keys + (<usize>c << 3));
    if (kc >= key) break;
    store<i32>(ids + (<usize>i << 2), load<i32>(ids + (<usize>c << 2)));
    store<f64>(keys + (<usize>i << 3), kc);
    i = c;
  }
  store<i32>(ids + (<usize>i << 2), id);
  store<f64>(keys + (<usize>i << 3), key);
  return top;
}

// combineInformed's results besides the labels (firstLine)
let flM: i32 = 0;
let flF: f64 = 0;

function sortInfo(n: i32): void {
  for (let x = 1; x < n; x++) {
    const a = i32at(INFO_L, x), uu = f64at(INFO_U, x), rr = f64at(INFO_R, x);
    let y = x - 1;
    while (y >= 0 && f64at(INFO_U, y) > uu) {
      i32put(INFO_L, y + 1, i32at(INFO_L, y));
      f64put(INFO_U, y + 1, f64at(INFO_U, y));
      f64put(INFO_R, y + 1, f64at(INFO_R, y));
      y--;
    }
    i32put(INFO_L, y + 1, a);
    f64put(INFO_U, y + 1, uu);
    f64put(INFO_R, y + 1, rr);
  }
}

function informed(n: i32): f64 {
  let g: f64 = 1, lam: f64 = 0, E = f64at(INFO_U, 0);
  for (let k = 0; k < n; k++) {
    lam += f64at(INFO_R, k);
    const decay: f64 = k + 1 < n ? exp(-lam * (f64at(INFO_U, k + 1) - f64at(INFO_U, k))) : 0;
    const Ik = (g * (1 - decay)) / lam;
    f64put(INFO_I, k, Ik);
    E += Ik;
    g *= decay;
  }
  let tail: f64 = 0;
  for (let k = n - 1; k >= 0; k--) {
    tail += f64at(INFO_I, k);
    f64put(INFO_P, k, f64at(INFO_R, k) * tail);
  }
  return E;
}

function firstLine(n: i32, W: f64): f64 {
  const alpha = 0.5 * W;
  let Fs: f64 = 0, sum: f64 = 0, m = 0;
  for (; m < n; m++) {
    const um = f64at(INFO_U, m);
    if (m > 0 && um >= (alpha + sum) / Fs) break;
    const f = f32at(FREQ, i32at(INFO_L, m));
    Fs += f;
    sum += f * um;
  }
  flM = m;
  flF = Fs;
  return (alpha + sum) / Fs;
}

function combineInformed(i: i32, cur: i32, share: f64, W: f64): void {
  let n = 0;
  for (let q = i32at(OUT_START, i), q1 = i32at(OUT_START, i + 1); q < q1; q++) {
    const a = i32at(OUT_LINKS, q);
    if (i32at(ATT, a) != cur) continue;
    i32put(INFO_L, n, a);
    f64put(INFO_U, n, f64at(U, i32at(HEAD, a)));
    f64put(INFO_R, n, (2 * f32at(FREQ, a)) / W);
    n++;
  }
  sortInfo(n);
  const E = informed(n);
  const Cp = ptr(C);
  const ic = Cp + (<usize>i * NC << 3);
  for (let c = 0; c < NC; c++) store<f64>(ic + (<usize>c << 3), 0);
  let ride: f64 = 0;
  for (let k = 0; k < n; k++) {
    const p = share * f64at(INFO_P, k);
    const L = i32at(INFO_L, k);
    f64put(PROB, L, p);
    ride += p * f64at(INFO_U, k);
    const hc = Cp + (<usize>i32at(HEAD, L) * NC << 3);
    for (let c = 0; c < NC; c++) store<f64>(ic + (<usize>c << 3), load<f64>(ic + (<usize>c << 3)) + p * load<f64>(hc + (<usize>c << 3)));
  }
  let Ef: f64 = 0, waitF: f64 = 0;
  if (share < 1) {
    Ef = firstLine(n, W);
    const m = flM, Fs = flF;
    waitF = 0.5 / Fs;
    for (let k = 0; k < m; k++) {
      const L = i32at(INFO_L, k);
      const p = ((1 - share) * f32at(FREQ, L)) / Fs;
      f64put(PROB, L, f64at(PROB, L) + p);
      const hc = Cp + (<usize>i32at(HEAD, L) * NC << 3);
      for (let c = 0; c < NC; c++) store<f64>(ic + (<usize>c << 3), load<f64>(ic + (<usize>c << 3)) + p * load<f64>(hc + (<usize>c << 3)));
    }
  }
  f64put(U, i, share * E + (1 - share) * Ef);
  const w = ic + (<usize>C_WAIT << 3);
  store<f64>(w, load<f64>(w) + ((share * E - ride) / W + (1 - share) * waitF));
  f64put(F, i, 1);
}

/**
 * The search to d from what the heap holds (the seeds), d added: `cur` marks this search's
 * attractive links; `egr`: the egress branch replaces d's own links; `info`: informed line choice.
 */
export function run(d: i32, nZones: i32, cur: i32, egr: bool, info: bool, alpha: f64, share: f64, W: f64): void {
  const Cp = ptr(C), SF = ptr(SUMFC);
  f64put(U, d, 0);
  push(d, 0);
  while (heapSize) {
    const key = load<f64>(ptr(HKEY));
    const j = pop();
    if (u8at(FINAL, j) || key > f64at(U, j)) continue;
    store<u8>(ptr(FINAL) + <usize>j, 1);
    i32put(ORDER, nOrder++, j);
    if (j < nZones && j != d) continue;
    if (egr && j == d) continue;
    const uj = f64at(U, j);
    const jc = Cp + (<usize>j * NC << 3);
    for (let k = i32at(IN_START, j), k1 = i32at(IN_START, j + 1); k < k1; k++) {
      const a = i32at(IN_LINKS, k);
      const i = i32at(TAIL, a);
      if (i < nZones) continue;
      if (u8at(FINAL, i)) continue;
      const cand = uj + f32at(COST, a);
      if (u8at(TYPE, a) == LINK_BOARD) {
        if (cand >= f64at(U, i)) continue;
        if (hasBoardFor) {
          const bf = i32at(BOARD_FOR, a);
          if (bf >= 0 && !load<u8>(ptr(DEST_SETS) + <usize>(bf * setLen + d))) continue;
        }
        const f = f32at(FREQ, a);
        if (f <= 0) continue;
        if (info) {
          i32put(ATT, a, cur);
          combineInformed(i, cur, share, W);
          push(i, f64at(U, i));
          continue;
        }
        const Fi0 = f64at(F, i);
        const Fi = Fi0 + f;
        const ic = Cp + (<usize>i * NC << 3), sc = SF + (<usize>i * NC << 3);
        for (let q = 0; q < NC; q++) store<f64>(sc + (<usize>q << 3), load<f64>(sc + (<usize>q << 3)) + f * load<f64>(jc + (<usize>q << 3)));
        const prevSum = Fi0 > 0 ? f64at(U, i) * Fi0 - alpha : 0;
        f64put(F, i, Fi);
        f64put(U, i, (alpha + prevSum + f * cand) / Fi);
        for (let q = 0; q < NC; q++) store<f64>(ic + (<usize>q << 3), load<f64>(sc + (<usize>q << 3)) / Fi);
        const w = ic + (<usize>C_WAIT << 3);
        store<f64>(w, load<f64>(w) + 0.5 / Fi);
        i32put(ATT, a, cur);
        push(i, f64at(U, i));
      } else if (cand < f64at(U, i)) {
        f64put(U, i, cand);
        i32put(SUCC, i, a);
        const ic = Cp + (<usize>i * NC << 3);
        const ac = ptr(COMP) + (<usize>a * NC << 2);
        for (let q = 0; q < NC; q++) store<f64>(ic + (<usize>q << 3), load<f64>(jc + (<usize>q << 3)) + <f64>load<f32>(ac + (<usize>q << 2)));
        push(i, cand);
      }
    }
  }
}
