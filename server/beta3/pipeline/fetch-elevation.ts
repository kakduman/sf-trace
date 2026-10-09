/**
 * Step 2: ground elevation for San Francisco, from the public Terrain Tiles on AWS (Mapzen
 * "terrarium" encoding, built from USGS 3DEP/NED; about 9.5 m per pixel at zoom 14).
 * Writes data/beta3/raw/elevation/<z>-<x>-<y>.png. Elevations feed walking and cycling times:
 * San Francisco's hills change both a great deal.
 *
 * Run: npx tsx server/beta3/pipeline/fetch-elevation.ts
 */
import fs from 'node:fs';
import { RAW } from './paths';

export const ELEV_ZOOM = 14;
export const ELEV_BBOX = { s: 37.69, w: -122.53, n: 37.84, e: -122.35 };

export function tileX(lon: number, z = ELEV_ZOOM) {
  return ((lon + 180) / 360) * 2 ** z;
}
export function tileY(lat: number, z = ELEV_ZOOM) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

async function main() {
  const dir = `${RAW}/elevation`;
  fs.mkdirSync(dir, { recursive: true });
  const x0 = Math.floor(tileX(ELEV_BBOX.w)), x1 = Math.floor(tileX(ELEV_BBOX.e));
  const y0 = Math.floor(tileY(ELEV_BBOX.n)), y1 = Math.floor(tileY(ELEV_BBOX.s));
  let n = 0;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const f = `${dir}/${ELEV_ZOOM}-${x}-${y}.png`;
      if (fs.existsSync(f)) continue;
      const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ELEV_ZOOM}/${x}/${y}.png`);
      if (!res.ok) throw new Error(`tile ${x},${y}: ${res.status}`);
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      n++;
    }
  console.log(`tiles ${(x1 - x0 + 1) * (y1 - y0 + 1)} (${n} new)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
