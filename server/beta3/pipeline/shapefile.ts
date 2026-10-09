/**
 * A minimal ESRI shapefile reader (polygons + the attribute table), enough for MTC's zone file.
 */
import fs from 'node:fs';

export interface ShapeRecord {
  attrs: Record<string, string>;
  /** rings of [lon, lat] */
  rings: [number, number][][];
}

export function readShapefile(base: string): ShapeRecord[] {
  const shp = fs.readFileSync(`${base}.shp`);
  const dbf = fs.readFileSync(`${base}.dbf`);
  // attributes
  const nRec = dbf.readUInt32LE(4), headLen = dbf.readUInt16LE(8), recLen = dbf.readUInt16LE(10);
  const fields: { name: string; len: number }[] = [];
  for (let o = 32; dbf[o] !== 0x0d; o += 32) fields.push({ name: dbf.toString('latin1', o, o + 11).replace(/\0.*$/, ''), len: dbf[o + 16] });
  const attrs: Record<string, string>[] = [];
  for (let r = 0; r < nRec; r++) {
    let o = headLen + r * recLen + 1;
    const a: Record<string, string> = {};
    for (const f of fields) {
      a[f.name] = dbf.toString('latin1', o, o + f.len).trim();
      o += f.len;
    }
    attrs.push(a);
  }
  // geometry
  const out: ShapeRecord[] = [];
  let o = 100, i = 0;
  while (o < shp.length) {
    const len = shp.readInt32BE(o + 4) * 2;
    const c = o + 8;
    const type = shp.readInt32LE(c);
    const rings: [number, number][][] = [];
    if (type === 5 || type === 15) {
      const nParts = shp.readInt32LE(c + 36), nPts = shp.readInt32LE(c + 40);
      const parts = Array.from({ length: nParts }, (_, k) => shp.readInt32LE(c + 44 + 4 * k));
      const p0 = c + 44 + 4 * nParts;
      for (let k = 0; k < nParts; k++) {
        const end = k + 1 < nParts ? parts[k + 1] : nPts;
        const ring: [number, number][] = [];
        for (let q = parts[k]; q < end; q++) ring.push([shp.readDoubleLE(p0 + 16 * q), shp.readDoubleLE(p0 + 16 * q + 8)]);
        rings.push(ring);
      }
    }
    out.push({ attrs: attrs[i++] ?? {}, rings });
    o = c + len;
  }
  return out;
}
