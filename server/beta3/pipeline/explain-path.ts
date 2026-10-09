/**
 * How one trip travels: the strategy from an origin zone to a destination zone in one period, as
 * the riders of one trip spread over it (access stops, lines, changes, getting off).
 * Run: npx tsx server/beta3/pipeline/explain-path.ts <from lat,lon | zone> <to lat,lon | zone> [AM] [--set key=value,...]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { C_BOARDS, C_IVT, C_WAIT, C_WALK, LINK_ACCESS, LINK_ALIGHT, LINK_BOARD, LINK_CHANGE, LINK_EGRESS, LINK_WALK, NC, buildNet } from '../../../shared/beta3/net';
import { PATH } from '../../../shared/beta3/params';
import { decodeResult } from '../../../shared/beta3/results';
import { StrategySolver } from '../../../shared/beta3/strategy';
import type { TPeriod } from '../../../shared/beta3/types';
import { toXY } from '../../../shared/beta3/geo';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';

const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1] === '--set'));
for (const kv of (process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  const cur = (PATH as Record<string, unknown>)[k];
  (PATH as Record<string, unknown>)[k] = typeof cur === 'number' || cur === null ? Number(v) : typeof cur === 'boolean' ? v === 'true' : v;
}
const b = loadBundle();
const H = b.header;
const zoneOf = (s: string) => {
  // ext:<id or county text>: an outside zone's home end
  if (s.startsWith('ext:')) {
    const q = s.slice(4).toLowerCase();
    const e = H.ext.findIndex((x) => x.id.toLowerCase() === q || JSON.stringify(x).toLowerCase().includes(q));
    if (e < 0) throw new Error(`no outside zone ${q}`);
    return H.zones.length + e;
  }
  if (!s.includes(',')) return Number(s);
  const [lat, lon] = s.split(',').map(Number);
  const [x, y] = toXY(lat, lon);
  let best = 0, bd = Infinity;
  H.zones.forEach((z, i) => {
    const d = Math.hypot(z.x - x, z.y - y);
    if (d < bd) (bd = d), (best = i);
  });
  return best;
};
const o = zoneOf(args[0]), d = zoneOf(args[1]);
const p = (args[2] ?? 'AM') as TPeriod;
const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
const calib = H.calibration!;
const net0 = buildNet(b, { name: 'Today', edits: [] }, p, calib);
const cr = net0.lines.map((l) => (l.src >= 0 ? base.finalCrowd?.[p]?.[l.src] : undefined) ?? new Float32Array(Math.max(0, l.stops.length - 1)).fill(1));
const net = buildNet(b, { name: 'Today', edits: [] }, p, calib, cr);
const S = net.nStops, Z = net.nZones, A0 = Z, B0 = Z + S;
const s = new StrategySolver(net);
s.solve(d);
s.load((z) => (z === o ? 1 : 0));
const C = (k: number) => s.C[o * NC + k];
const zn = (z: number) => (z < H.zones.length ? `${H.zones[z].id} (${H.zones[z].nhood})` : `outside ${H.ext[(z - H.zones.length) % H.ext.length]?.id}`);
console.log(`${zn(o)} → ${zn(d)}, ${p}: cost ${s.u[o].toFixed(1)}, boardings ${C(C_BOARDS).toFixed(2)}, ride ${C(C_IVT).toFixed(1)}, wait ${C(C_WAIT).toFixed(1)}, walk ${C(C_WALK).toFixed(1)} min`);
const stopName = (st: number) => (st < H.stops.length ? H.stops[st].name : `new ${st}`);
const rows: [number, string][] = [];
for (let a = 0; a < net.nLinks; a++) {
  const v = s.linkVol[a];
  if (!(v > 0.005)) continue;
  const t = net.type[a];
  const l = net.line[a] >= 0 ? net.lines[net.line[a]] : null;
  if (t === LINK_ACCESS) rows.push([v, `access  → ${stopName(net.head[a] - B0)}`]);
  else if (t === LINK_BOARD) rows.push([v, `board   ${l!.feed}:${l!.route} at ${stopName(l!.stops[net.pos[a]])} (u ${s.u[net.head[a]].toFixed(1)})`]);
  else if (t === LINK_ALIGHT) rows.push([v, `alight  ${l!.feed}:${l!.route} at ${stopName(l!.stops[net.pos[a]])}`]);
  else if (t === LINK_CHANGE) rows.push([v, `change  at ${stopName(net.tail[a] - A0)}`]);
  else if (t === LINK_WALK) rows.push([v, `walk to change ${stopName(net.tail[a] - A0)} → ${net.head[a] < B0 + S ? stopName(net.head[a] - B0) : '(change node)'}`]);
  else if (t === LINK_EGRESS) rows.push([v, `egress  from ${stopName(net.tail[a] - A0)}`]);
}
for (const [v, r] of rows) console.log(`${v.toFixed(3)}  ${r}`);
