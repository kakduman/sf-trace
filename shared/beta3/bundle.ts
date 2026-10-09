/**
 * The model bundle: one JSON header followed by typed arrays, gzipped.
 * Layout: "B3M1" | u32 header length | header JSON | padding to 8 | arrays (offsets in header.arrays).
 */
import type { Bundle, BundleHeader } from './types';

const MAGIC = 0x314d3342; // "B3M1" little-endian

type TA = Float32Array | Uint16Array | Int32Array | Uint8Array | Float64Array | Uint32Array;
const CTORS: Record<string, { new (b: ArrayBuffer, o: number, n: number): TA; BYTES_PER_ELEMENT: number }> = {
  Float32Array, Uint16Array, Int32Array, Uint8Array, Float64Array, Uint32Array,
};

export function encodeBundle(header: Omit<BundleHeader, 'arrays'>, arrays: Record<string, TA>): Uint8Array {
  const index: BundleHeader['arrays'] = {};
  let off = 0;
  for (const [k, a] of Object.entries(arrays)) {
    index[k] = { type: a.constructor.name, offset: off, length: a.length };
    off += a.byteLength;
    off += (8 - (off % 8)) % 8;
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...header, arrays: index }));
  let start = 8 + json.length;
  start += (8 - (start % 8)) % 8;
  const out = new Uint8Array(start + off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, json.length, true);
  out.set(json, 8);
  for (const [k, a] of Object.entries(arrays)) out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), start + index[k].offset);
  return out;
}

export function decodeBundle(bytes: Uint8Array): Bundle {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a model bundle');
  const n = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as BundleHeader;
  let start = 8 + n;
  start += (8 - (start % 8)) % 8;
  // copy into a fresh, aligned buffer so typed arrays can view it
  // (Uint8Array.prototype.slice copies; Node's Buffer#slice would return a view of the whole pool)
  const body = Uint8Array.prototype.slice.call(bytes, start).buffer as ArrayBuffer;
  const a: Bundle['a'] = {};
  for (const [k, e] of Object.entries(header.arrays)) {
    const C = CTORS[e.type];
    a[k] = new C(body, e.offset, e.length);
  }
  return { header, a };
}

/** A short fingerprint of a bundle's build and calibration, carried by results made from it. */
export function bundleId(header: Pick<BundleHeader, 'built' | 'calibration'>): string {
  const text = `${header.built}|${JSON.stringify(header.calibration)}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${header.built}#${(h >>> 0).toString(16)}`;
}
