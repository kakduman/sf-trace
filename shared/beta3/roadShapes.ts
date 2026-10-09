/**
 * The drawn shapes of the road links (client/beta3/model/road-shapes.bin.gz): each street link's
 * chain of OpenStreetMap ways, simplified (Douglas–Peucker, about 2.5 m) and quantized to 1e-5
 * degrees (about a metre), kept apart from the roads bundle so the page fetches it only when the
 * street layer is shown. Built by server/beta3/pipeline/road-shapes.ts after roads.ts.
 *
 * Layout: "B3RS" | u32 header length | header JSON | the points, as zigzag varints: for each link,
 * its point count, then each point's latitude and longitude as the difference from the point
 * before (across links, starting from the header's origin). A link with no points is drawn from
 * the roads bundle's own shape.
 */
import { toXY } from './geo';

const MAGIC = 0x53523342; // "B3RS" little-endian
/** degrees per quantization step */
export const SHAPE_STEP = 1e-5;

export interface RoadShapesHeader {
  version: number;
  built: string;
  nLinks: number;
  /** roadLinkKey of the road network the shapes were made for */
  key: string;
  /** Douglas–Peucker tolerance, metres */
  toleranceM: number;
  /** the first point's offsets are from here, in steps */
  origin: [number, number];
  /** links with a shape of their own, and the points kept */
  stats?: Record<string, number>;
}

export interface RoadShapes {
  h: RoadShapesHeader;
  /** link k's points are q[2·start[k]] … q[2·start[k+1]], as [lat, lon] in steps */
  start: Int32Array;
  q: Int32Array;
}

/**
 * A fingerprint of a road network's links (their ends and classes), so shapes made for one build of
 * the network are never drawn on another's links.
 */
export function roadLinkKey(nLinks: number, a: ArrayLike<number>, b: ArrayLike<number>, cls: ArrayLike<number>): string {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v & 0xffff), 16777619);
    h = Math.imul(h ^ (v >>> 16), 16777619);
  };
  mix(nLinks);
  for (let k = 0; k < nLinks; k++) (mix(a[k]), mix(b[k]), mix(cls[k]));
  return `${nLinks}:${(h >>> 0).toString(16)}`;
}

/** Douglas–Peucker on flat [lat, lon, …] points: the indices (of points) kept, ends always */
export function simplify(pts: ArrayLike<number>, tolM: number): number[] {
  const n = pts.length / 2;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const xy = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const [x, y] = toXY(pts[2 * i], pts[2 * i + 1]);
    xy[2 * i] = x;
    xy[2 * i + 1] = y;
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const ax = xy[2 * i],
      ay = xy[2 * i + 1],
      dx = xy[2 * j] - ax,
      dy = xy[2 * j + 1] - ay,
      L2 = dx * dx + dy * dy;
    let best = -1,
      bd = tolM;
    for (let m = i + 1; m < j; m++) {
      const px = xy[2 * m] - ax,
        py = xy[2 * m + 1] - ay;
      // distance to the segment (to the end point where the segment is a point or overshot)
      const t = L2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > bd) (bd = d), (best = m);
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** shapes ([lat, lon, …] per link, empty for none) → bytes */
export function encodeRoadShapes(h: Omit<RoadShapesHeader, 'origin'>, shapes: ArrayLike<number>[]): Uint8Array {
  if (shapes.length !== h.nLinks) throw new Error(`${shapes.length} shapes for ${h.nLinks} links`);
  const origin: [number, number] = [Math.round(37.7793 / SHAPE_STEP), Math.round(-122.4193 / SHAPE_STEP)];
  const body: number[] = [];
  const varint = (v: number) => {
    let z = v >= 0 ? 2 * v : -2 * v - 1; // zigzag
    while (z >= 0x80) {
      body.push((z & 0x7f) | 0x80);
      z = Math.floor(z / 128);
    }
    body.push(z);
  };
  let pl = origin[0],
    pn = origin[1];
  for (const s of shapes) {
    varint(s.length / 2);
    for (let i = 0; i < s.length; i += 2) {
      const ql = Math.round(s[i] / SHAPE_STEP),
        qn = Math.round(s[i + 1] / SHAPE_STEP);
      varint(ql - pl);
      varint(qn - pn);
      pl = ql;
      pn = qn;
    }
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...h, origin }));
  const out = new Uint8Array(8 + json.length + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(body, 8 + json.length);
  return out;
}

export function decodeRoadShapes(bytes: Uint8Array): RoadShapes {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a road shapes file');
  const n = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as RoadShapesHeader;
  let p = 8 + n;
  const varint = () => {
    let z = 0,
      mul = 1,
      c: number;
    do {
      c = bytes[p++];
      z += (c & 0x7f) * mul;
      mul *= 128;
    } while (c & 0x80);
    return z % 2 ? -(z + 1) / 2 : z / 2;
  };
  const start = new Int32Array(h.nLinks + 1);
  const q: number[] = [];
  let pl = h.origin[0],
    pn = h.origin[1];
  for (let k = 0; k < h.nLinks; k++) {
    start[k] = q.length / 2;
    const m = varint();
    for (let i = 0; i < m; i++) {
      pl += varint();
      pn += varint();
      q.push(pl, pn);
    }
  }
  start[h.nLinks] = q.length / 2;
  if (p !== bytes.length) throw new Error('road shapes: trailing bytes');
  return { h, start, q: Int32Array.from(q) };
}

/** link k's points as [lon, lat] pairs (GeoJSON order), or null when it has none of its own */
export function shapeCoords(s: RoadShapes, k: number): [number, number][] | null {
  const a = s.start[k],
    b = s.start[k + 1];
  if (b - a < 2) return null;
  const out: [number, number][] = [];
  for (let i = a; i < b; i++) out.push([s.q[2 * i + 1] * SHAPE_STEP, s.q[2 * i] * SHAPE_STEP]);
  return out;
}
