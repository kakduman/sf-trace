/**
 * The WebAssembly kernel of the strategy search (wasm/blocks.ts: the block-by-block access split)
 * against the TypeScript it replaces: every label, expected component, and loaded volume equal bit
 * for bit, on today's network and on fare-free Muni, in the run's warm-started state.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle } from '../shared/beta3/bundle';
import { warmStart } from '../shared/beta3/model';
import { buildNet, NC } from '../shared/beta3/net';
import { decodeResult } from '../shared/beta3/results';
import { setBlocksWasm, setSearchWasm, StrategySolver } from '../shared/beta3/strategy';
import type { Scenario, TPeriod } from '../shared/beta3/types';

const MODEL = 'client/beta3/model';
const haveModel = fs.existsSync(`${MODEL}/sf.bin.gz`) && fs.existsSync(`${MODEL}/base.bin.gz`);

/** the largest relative difference between two arrays (Infinity where only one is infinite) */
function maxRel(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
    m = Math.max(m, Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)));
  }
  return m;
}

/** the first index where two arrays differ in their bits, or −1 */
function firstDiff(a: Float64Array, b: Float64Array): number {
  const x = new BigInt64Array(a.buffer, a.byteOffset, a.length), y = new BigInt64Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < a.length; i++) if (x[i] !== y[i]) return i;
  return -1;
}

describe.skipIf(!haveModel)('beta3 strategy search in WebAssembly', () => {
  const b = haveModel ? decodeBundle(zlib.gunzipSync(fs.readFileSync(`${MODEL}/sf.bin.gz`))) : null!;
  const base = haveModel ? decodeResult(zlib.gunzipSync(fs.readFileSync(`${MODEL}/base.bin.gz`))) : null!;
  const cases: [string, Scenario, TPeriod][] = [
    ['today, morning, Quick', { name: 'Today', edits: [], runMode: 'quick' }, 'AM'],
    ['fare-free Muni, midday, Precise', { name: 'Free', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] }, 'MD'],
  ];
  for (const [label, sc, p] of cases)
    it(`equals the TypeScript bit for bit: ${label}`, () => {
      const calib = b.header.calibration!;
      const { crowd, lot } = warmStart(b, sc, calib, base.finalCrowd, base.finalLotPrice);
      const net = buildNet(b, sc, p, calib, crowd[p], lot);
      setBlocksWasm(false);
      const ts = new StrategySolver(net);
      setBlocksWasm(true);
      // (the access split only: the search in WebAssembly is tested below, to a tolerance)
      setSearchWasm(false);
      const wa = new StrategySolver(net);
      setSearchWasm(true);
      // (the kernel is in use in one and not the other)
      expect((wa as unknown as { K?: unknown }).K).toBeTruthy();
      expect((ts as unknown as { K?: unknown }).K).toBeUndefined();
      const Z = net.nZones;
      const od = (o: number, d: number) => ((o * 7 + d * 13) % 5) + 0.25;
      for (let d = 0; d < Z; d += 37) {
        ts.solve(d);
        wa.solve(d);
        expect(firstDiff(ts.u, wa.u)).toBe(-1);
        expect(firstDiff(ts.C, wa.C)).toBe(-1);
        // loading reads the access shares the kernel writes
        ts.resetVolumes();
        wa.resetVolumes();
        ts.load((o) => od(o, d));
        wa.load((o) => od(o, d));
        expect(firstDiff(ts.linkVol, wa.linkVol)).toBe(-1);
      }
      expect(ts.C.length).toBe(net.nNodes * NC);
    }, 120_000);

  // the whole search in WebAssembly: with the page's Math.exp imported, bit for bit; with musl's
  // exp, the labels within 1e-15 or so, but a last-bit difference can tip a line in or out of a
  // stop's attractive set, moving some link volumes (reported, not held to 1e-12)
  for (const musl of [false, true])
    for (const [label, sc, p] of cases)
      it(`the whole search in WebAssembly, ${musl ? 'musl’s exp' : 'Math.exp'}: ${label}`, () => {
        const calib = b.header.calibration!;
        const { crowd, lot } = warmStart(b, sc, calib, base.finalCrowd, base.finalLotPrice);
        const net = buildNet(b, sc, p, calib, crowd[p], lot);
        setBlocksWasm(false);
        const ts = new StrategySolver(net);
        setBlocksWasm(true);
        setSearchWasm(true, { muslExp: musl });
        const wa = new StrategySolver(net);
        setSearchWasm(true);
        expect((wa as unknown as { S?: unknown }).S).toBeTruthy();
        const Z = net.nZones;
        const od = (o: number, d: number) => ((o * 7 + d * 13) % 5) + 0.25;
        const worst = { u: 0, C: 0, vol: 0, diff: 0 };
        for (let d = 0; d < Z; d += 37) {
          ts.solve(d);
          wa.solve(d);
          worst.u = Math.max(worst.u, maxRel(ts.u, wa.u));
          worst.C = Math.max(worst.C, maxRel(ts.C, wa.C));
          if (firstDiff(ts.u, wa.u) >= 0 || firstDiff(ts.C, wa.C) >= 0) worst.diff++;
          ts.resetVolumes();
          wa.resetVolumes();
          ts.load((o) => od(o, d));
          wa.load((o) => od(o, d));
          worst.vol = Math.max(worst.vol, maxRel(ts.linkVol, wa.linkVol));
          if (firstDiff(ts.linkVol, wa.linkVol) >= 0) worst.diff++;
        }
        console.log(`${musl ? 'musl exp' : 'Math.exp'}, ${label}: largest relative difference, labels ${worst.u.toExponential(2)}, components ${worst.C.toExponential(2)}, link volumes ${worst.vol.toExponential(2)}`);
        if (!musl) expect(worst.diff).toBe(0);
        else {
          expect(worst.u).toBeLessThan(1e-12);
          expect(worst.C).toBeLessThan(1e-12);
        }
      }, 120_000);
});
