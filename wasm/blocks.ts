/**
 * AssemblyScript: the block-by-block access split of shared/beta3/strategy.ts (StrategySolver
 * blockOrigin), its sums over the blocks in WebAssembly SIMD. The same additions and
 * multiplications in the same order as the TypeScript, lane by lane, so the results are equal bit
 * for bit (test/beta3-wasm.test.ts); the exponentials and logarithms stay in TypeScript.
 *
 * Build: npm run build:wasm (writes shared/beta3/blocksWasm.ts). Memory is the caller's
 * (--importMemory); every argument is a byte offset into it or a count.
 *
 * Per access link q of a zone (q0 ≤ q < q1, numbered from the first zone's first link):
 *   qAcc[q]  i32  the offset of its blocks' walks in ptE/ptMin, or −1
 *   qLink[q] i32  the link (index into share)
 *   qHead[q] i32  the stop node it leads to (index into C, NC components each)
 * comp: f32, NC per link of the network (indexed by qLink)
 * va: f64 per link of the zone, exp(−θ(v − m)); Sp, Wp: f64 per block.
 */

const NC = 10;

/** Sp[p] += va[q] · ptE[off + p], link by link (each block's sum over the stops) */
export function blockSums(q0: i32, q1: i32, np: i32, va: usize, qAcc: usize, ptE: usize, Sp: usize): void {
  for (let q = q0; q < q1; q++) {
    const off = load<i32>(qAcc + (<usize>q << 2));
    if (off < 0) continue;
    const vq = load<f64>(va + (<usize>(q - q0) << 3));
    const v2 = f64x2.splat(vq);
    const e = ptE + (<usize>off << 2);
    let p = 0;
    for (; p + 2 <= np; p += 2) {
      const sp = Sp + (<usize>p << 3);
      const x = f64x2.promote_low_f32x4(v128.load64_zero(e + (<usize>p << 2)));
      v128.store(sp, f64x2.add(v128.load(sp), f64x2.mul(v2, x)));
    }
    if (p < np) {
      const sp = Sp + (<usize>p << 3);
      store<f64>(sp, load<f64>(sp) + vq * <f64>load<f32>(e + (<usize>p << 2)));
    }
  }
}

/**
 * Each link's share of the zone (unnormalised) into share[link], and Σ share · walk by block into
 * Wp; Sp holds each block's weight over its sum (0 for a block beyond every stop). Returns Σ_p Wp.
 */
export function blockShares(q0: i32, q1: i32, np: i32, va: usize, qAcc: usize, qLink: usize, ptE: usize, ptMin: usize, Sp: usize, Wp: usize, share: usize): f64 {
  const zero = f64x2.splat(0);
  for (let q = q0; q < q1; q++) {
    const off = load<i32>(qAcc + (<usize>q << 2));
    if (off < 0) continue;
    const vq = load<f64>(va + (<usize>(q - q0) << 3));
    let sh: f64 = 0;
    if (vq > 0) {
      const v2 = f64x2.splat(vq);
      const e0 = ptE + (<usize>off << 2), m0 = ptMin + (<usize>off << 2);
      let p = 0;
      for (; p + 2 <= np; p += 2) {
        const S = v128.load(Sp + (<usize>p << 3));
        const e = f64x2.mul(f64x2.mul(v2, f64x2.promote_low_f32x4(v128.load64_zero(e0 + (<usize>p << 2)))), S);
        // a block counts where S > 0 and e > 0 (as the TypeScript's `continue`)
        const ok = v128.and(f64x2.gt(S, zero), f64x2.gt(e, zero));
        const em = v128.bitselect(e, zero, ok);
        // (in order, p then p + 1, as the TypeScript adds them)
        sh += f64x2.extract_lane(em, 0);
        sh += f64x2.extract_lane(em, 1);
        const w = Wp + (<usize>p << 3);
        const add = v128.bitselect(f64x2.mul(e, f64x2.promote_low_f32x4(v128.load64_zero(m0 + (<usize>p << 2)))), zero, ok);
        v128.store(w, f64x2.add(v128.load(w), add));
      }
      if (p < np) {
        const S = load<f64>(Sp + (<usize>p << 3));
        const e = S > 0 ? vq * <f64>load<f32>(e0 + (<usize>p << 2)) * S : 0;
        if (e > 0) {
          sh += e;
          const w = Wp + (<usize>p << 3);
          store<f64>(w, load<f64>(w) + e * <f64>load<f32>(m0 + (<usize>p << 2)));
        }
      }
    }
    store<f64>(share + (<usize>load<i32>(qLink + (<usize>q << 2)) << 3), sh);
  }
  let walk: f64 = 0;
  for (let p = 0; p < np; p++) walk += load<f64>(Wp + (<usize>p << 3));
  return walk;
}

/** shares normalised by r, and the zone's components: C[o] += share · (C[head] + comp[link]) */
export function blockComponents(o: i32, q0: i32, q1: i32, r: f64, qLink: usize, qHead: usize, comp: usize, share: usize, C: usize): void {
  const oc = C + (<usize>o * NC << 3);
  for (let q = q0; q < q1; q++) {
    const a = load<i32>(qLink + (<usize>q << 2));
    const s = share + (<usize>a << 3);
    const sh = load<f64>(s) / r;
    store<f64>(s, sh);
    if (!(sh > 0)) continue;
    const s2 = f64x2.splat(sh);
    const hc = C + (<usize>load<i32>(qHead + (<usize>q << 2)) * NC << 3);
    const ac = comp + (<usize>a * NC << 2);
    for (let c = 0; c < NC; c += 2) {
      const x = f64x2.promote_low_f32x4(v128.load64_zero(ac + (<usize>c << 2)));
      const d = oc + (<usize>c << 3);
      v128.store(d, f64x2.add(v128.load(d), f64x2.mul(s2, f64x2.add(v128.load(hc + (<usize>c << 3)), x))));
    }
  }
}
