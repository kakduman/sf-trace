/**
 * Step 10: the drivable street graph for drawing new bus lines in the browser
 * (client/beta3/model/streets.bin.gz). Freeways are left out: buses use streets.
 * Run: npx tsx server/beta3/pipeline/streets-bundle.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import type { BundleHeader } from '../../../shared/beta3/types';
import { BUNDLE, WORK } from './paths';
import type { StreetEdge, StreetVertex } from './streets';

function main() {
  const { vertices, edges } = JSON.parse(fs.readFileSync(`${WORK}/streets.json`, 'utf8')) as { vertices: StreetVertex[]; edges: StreetEdge[] };
  const keep = edges.filter((e) => e.car && !e.cls.startsWith('motorway') && e.cls !== 'service');
  // renumber the vertices used
  const id = new Map<number, number>();
  const vid = (v: number) => {
    if (!id.has(v)) id.set(v, id.size);
    return id.get(v)!;
  };
  for (const e of keep) vid(e.a), vid(e.b);
  const n = id.size;
  const lat = new Float32Array(n), lon = new Float32Array(n);
  for (const [v, i] of id) (lat[i] = vertices[v].lat), (lon[i] = vertices[v].lon);
  const arcs: { a: number; b: number; len: number; edge: number; rev: number }[] = [];
  const ptStart = new Int32Array(keep.length + 1);
  const pts: number[] = [];
  keep.forEach((e, k) => {
    ptStart[k] = pts.length;
    pts.push(...e.pts);
    const a = vid(e.a), b = vid(e.b);
    if (e.oneway !== -1) arcs.push({ a, b, len: e.len, edge: k, rev: 0 });
    if (e.oneway !== 1) arcs.push({ a: b, b: a, len: e.len, edge: k, rev: 1 });
  });
  ptStart[keep.length] = pts.length;
  arcs.sort((p, q) => p.a - q.a);
  const start = new Int32Array(n + 1);
  for (const r of arcs) start[r.a + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const bin = encodeBundle({ version: 1 } as unknown as Omit<BundleHeader, 'arrays'>, {
    lat, lon, start,
    to: Int32Array.from(arcs, (r) => r.b),
    len: Float32Array.from(arcs, (r) => r.len),
    edge: Int32Array.from(arcs, (r) => r.edge),
    rev: Uint8Array.from(arcs, (r) => r.rev),
    ptStart,
    pts: Float32Array.from(pts),
  });
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.writeFileSync(`${BUNDLE}/streets.bin.gz`, gz);
  console.log(`streets: ${n} vertices, ${arcs.length} arcs, ${(gz.length / 1e6).toFixed(2)} MB`);
}

main();
