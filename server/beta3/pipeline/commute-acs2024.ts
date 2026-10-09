/**
 * Puts an existing bundle's commute flows on the ACS 2024 1-year split (build.ts commuteSplit), as a
 * rebuild would, without rebuilding: residents' flows to outside zones are reweighted so that their
 * share of the flows is the ACS's, and in-commuters' flows are scaled to the ACS's total. Both are
 * the arithmetic build.ts applies to the LODES flows, so the result is the same as building again.
 * Bundles built after the change need nothing; running this on one leaves it as it is.
 *
 * Run: npx tsx server/beta3/pipeline/commute-acs2024.ts (patches BETA3_SF_BUNDLE or the app's bundle)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import { BUNDLE, REFERENCE } from './paths';
import { commuteSplit } from './build';

export function applyCommuteSplit(a: Record<string, unknown>, NZ: number, outTarget: number, inCommuters: number) {
  const fw = a.flowW as Int32Array, fn = a.flowN as Float32Array, inN = a.inN as Float32Array;
  let sumI = 0, sumO = 0;
  for (let i = 0; i < fn.length; i++) fw[i] >= NZ ? (sumO += fn[i]) : (sumI += fn[i]);
  const w = (outTarget / (1 - outTarget)) / (sumO / sumI);
  for (let i = 0; i < fn.length; i++) if (fw[i] >= NZ) fn[i] *= w;
  const inTot = inN.reduce((s, v) => s + v, 0);
  for (let i = 0; i < inN.length; i++) inN[i] *= inCommuters / inTot;
  return { outBefore: sumO / (sumI + sumO), outWeight: w, inBefore: inTot };
}

if (process.argv[1]?.endsWith('commute-acs2024.ts')) {
  const file = process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`;
  const b = decodeBundle(zlib.gunzipSync(fs.readFileSync(file)));
  const { outTarget, inCommuters } = commuteSplit(JSON.parse(fs.readFileSync(`${REFERENCE}/acs-commute.json`, 'utf8')));
  const r = applyCommuteSplit(b.a as never, b.header.zones.length, outTarget, inCommuters);
  console.log(`residents' flows leaving the city ${(100 * r.outBefore).toFixed(1)}% → ${(100 * outTarget).toFixed(1)}% (×${r.outWeight.toFixed(3)}); in-commuters ${Math.round(r.inBefore)} → ${inCommuters}`);
  fs.writeFileSync(file, zlib.gzipSync(encodeBundle(b.header, b.a as never), { level: 9 }));
  console.log(`written ${file}`);
}
