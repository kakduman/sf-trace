/**
 * The synthetic population as typed arrays for the model bundle (layout: shared/beta3/synpop.ts).
 * build.ts adds them when data/beta3/work holds a population (synpop.ts); run on its own, this adds
 * them to an existing bundle in place and reports the size they add.
 *
 * Run: npx tsx server/beta3/pipeline/synpop-bundle.ts [bundle.bin.gz]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import { BUNDLE, WORK } from './paths';

type TA = Float32Array | Uint16Array | Int32Array | Uint8Array;

/** the population's arrays for zones in this order, or null without a synthesized population */
export function synpopArrays(zoneIds: string[]): Record<string, TA> | null {
  const hf = `${WORK}/synpop-households.csv.gz`, pf = `${WORK}/synpop-persons.csv.gz`;
  if (!fs.existsSync(hf) || !fs.existsSync(pf)) return null;
  const lines = (f: string) => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').trim().split('\n');
  const H = lines(hf), P = lines(pf);
  const hc = H[0].split(','), pc = P[0].split(',');
  const col = (head: string[], k: string) => {
    const i = head.indexOf(k);
    if (i < 0) throw new Error(`synpop: no column ${k}`);
    return i;
  };
  const [hBg, hKind, hSize, hVeh, hInc] = ['block_group', 'kind', 'size', 'vehicles', 'income_k'].map((k) => col(hc, k));
  const [pHh, pAge, pSex, pType, pEmp, pWfh, pStu] = ['hh_id', 'age', 'sex', 'ptype', 'employed', 'wfh', 'student'].map((k) => col(pc, k));
  const zoneOf = new Map(zoneIds.map((id, i) => [id, i]));
  const NZ = zoneIds.length, NH = H.length - 1, NP = P.length - 1;
  // households grouped by zone in the bundle's zone order (stable within a zone)
  const hz = new Int32Array(NH);
  const zoneStart = new Int32Array(NZ + 1);
  for (let h = 0; h < NH; h++) {
    const z = zoneOf.get(H[h + 1].split(',', hBg + 1)[hBg]);
    if (z === undefined) throw new Error(`synpop: household ${h} in an unknown zone`);
    hz[h] = z;
    zoneStart[z + 1]++;
  }
  for (let z = 0; z < NZ; z++) zoneStart[z + 1] += zoneStart[z];
  const slot = zoneStart.slice(0, NZ);
  const order = new Int32Array(NH);
  for (let h = 0; h < NH; h++) order[slot[hz[h]]++] = h;
  // each source household's persons (the persons file is in household order)
  const pStart = new Int32Array(NH + 1);
  for (let p = 0; p < NP; p++) pStart[Number(P[p + 1].split(',', 1)[0]) + 1]++;
  for (let h = 0; h < NH; h++) pStart[h + 1] += pStart[h];
  const size = new Uint8Array(NH), veh = new Uint8Array(NH), inc = new Uint16Array(NH), kind = new Uint8Array(NH);
  const age = new Uint8Array(NP), flags = new Uint8Array(NP);
  let q = 0;
  for (let i = 0; i < NH; i++) {
    const h = order[i];
    const c = H[h + 1].split(',');
    size[i] = Number(c[hSize]);
    veh[i] = Math.min(6, Number(c[hVeh]) || 0);
    inc[i] = Math.min(65535, Math.max(0, Number(c[hInc])));
    kind[i] = Number(c[hKind]);
    if (pStart[h + 1] - pStart[h] !== size[i]) throw new Error(`synpop: household ${h} has ${pStart[h + 1] - pStart[h]} persons, size ${size[i]}`);
    for (let p = pStart[h]; p < pStart[h + 1]; p++, q++) {
      const r = P[p + 1].split(',');
      if (Number(r[pHh]) !== h) throw new Error('synpop: persons out of household order');
      age[q] = Math.min(255, Number(r[pAge]));
      // the same bits as packPerson (shared/beta3/synpop.ts)
      flags[q] = (r[pSex] === '2' ? 1 : 0) | (r[pEmp] === '1' ? 2 : 0) | (r[pWfh] === '1' ? 4 : 0) | ((Number(r[pType]) - 1) << 3) | (Number(r[pStu]) << 6);
    }
  }
  return { popZoneStart: zoneStart, popHhSize: size, popHhVeh: veh, popHhInc: inc, popHhKind: kind, popAge: age, popFlags: flags };
}

function main() {
  const file = process.argv[2] ?? `${BUNDLE}/sf.bin.gz`;
  const gz0 = fs.readFileSync(file);
  const b = decodeBundle(zlib.gunzipSync(gz0));
  const arrays = synpopArrays(b.header.zones.map((z) => z.id));
  if (!arrays) throw new Error(`no synthetic population in ${WORK} (run synpop.ts)`);
  const { arrays: _index, ...header } = b.header;
  void _index;
  const kept = Object.fromEntries(Object.entries(b.a).filter(([k]) => !k.startsWith('pop'))) as Record<string, TA>;
  const without = zlib.gzipSync(encodeBundle(header, kept), { level: 9 });
  const bin = encodeBundle(header, { ...kept, ...arrays });
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.writeFileSync(file, gz);
  const each = Object.entries(arrays).map(([k, a]) => `${k} ${(zlib.gzipSync(Buffer.from(a.buffer, a.byteOffset, a.byteLength), { level: 9 }).length / 1e3).toFixed(0)} kB`);
  console.log(`${file}: ${(without.length / 1e6).toFixed(2)} MB → ${(gz.length / 1e6).toFixed(2)} MB gzipped (+${((gz.length - without.length) / 1e6).toFixed(2)} MB for ${arrays.popHhSize.length} households and ${arrays.popAge.length} persons; alone: ${each.join(', ')})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
