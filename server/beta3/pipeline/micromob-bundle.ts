/**
 * Shared micromobility in the model bundle: the arrays and header that micromob-skims.ts made, as
 * build.ts adds them, and (run directly) added to an existing bundle without rebuilding the rest, so the
 * bundle's calibration and everything else stay as they are.
 *
 * Run: npx tsx server/beta3/pipeline/micromob-bundle.ts   (BETA3_SF_BUNDLE: the bundle to update)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import type { BundleHeader } from '../../../shared/beta3/types';
import { BUNDLE, WORK, variantFile } from './paths';

type TA = Uint16Array | Uint8Array | Float32Array;

/** micromob-skims.ts's arrays and the header's `micro`, or null before it has run */
export function microBundleParts(): { arrays: Record<string, TA>; header: NonNullable<BundleHeader['micro']> } | null {
  const f = `${WORK}/${variantFile('micromob.json')}`;
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const bin = fs.readFileSync(`${WORK}/${variantFile('micromob.bin')}`);
  const C = { Uint16Array, Uint8Array, Float32Array } as const;
  const arrays: Record<string, TA> = {};
  for (const [k, e] of Object.entries(j.index as Record<string, { type: keyof typeof C; offset: number; length: number }>)) {
    const T = C[e.type];
    arrays[k] = new T(bin.buffer.slice(bin.byteOffset + e.offset, bin.byteOffset + e.offset + e.length * T.BYTES_PER_ELEMENT));
  }
  return { arrays, header: { gbfs: j.gbfs, places: j.places, ...(j.tod ? { tod: j.tod } : {}) } };
}

function main() {
  const file = process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`;
  const b = decodeBundle(zlib.gunzipSync(fs.readFileSync(file)));
  const mm = microBundleParts();
  if (!mm) throw new Error('run micromob-skims.ts first');
  const NZ = b.header.zones.length;
  if ((mm.arrays.bikeUp as Uint16Array).length !== NZ * NZ) throw new Error('micromob-skims.ts was run on other zones');
  const { arrays: _a, ...header } = b.header;
  void _a;
  const bin = encodeBundle({ ...header, micro: mm.header }, { ...b.a, ...mm.arrays } as never);
  fs.writeFileSync(file, zlib.gzipSync(bin, { level: 9 }));
  console.log(`${file}: shared micromobility added (${Object.keys(mm.arrays).join(', ')}; ${mm.header.places.length} stations)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
