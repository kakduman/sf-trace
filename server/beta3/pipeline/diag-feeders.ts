/**
 * Diagnostic: how the riders of chosen Muni routes reach and leave them. For each route, its
 * boardings split by whether the rider walked to the stop or changed from another line there (or a
 * short walk away), likewise its alightings, the stops with the most of each, and the length of a
 * ride. Changing at a stop is shared out by the stop's own split (the model does not track a rider
 * across lines), so it is approximate where several lines meet.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-feeders.ts [route ...]
 */
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare } from '../../../shared/beta3/model';
import { LINK_ACCESS, LINK_ALIGHT, LINK_BOARD, LINK_CHANGE, LINK_EGRESS, LINK_RIDE, LINK_WALK } from '../../../shared/beta3/net';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['58', '36', '37', '52', '55', '35', '56', '15', '43', '57', '28', '29', '23', '9', '14', '5']);
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of ['AM', 'MD', 'PM'] as const) sk[p] = await exec.skim(p, undefined);
  const d = computeDemand(b, prepare(b), sk as never, calib);
  type Acc = { on: number; onX: number; off: number; offX: number; pkm: number; stopsOn: Map<number, [number, number]>; stopsOff: Map<number, [number, number]> };
  const acc = new Map<string, Acc>();
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const vol = await exec.assign(p, d.transitOD[p], undefined);
    const net = exec.net(p);
    const S = net.nStops, Z = net.nZones, A0 = Z, B0 = Z + S;
    // at each stop: boardings arriving on foot (access) or from another line (change/walk), and
    // alightings leaving on foot (egress) or onto another line
    const inWalk = new Float64Array(S), inXfer = new Float64Array(S), outWalk = new Float64Array(S), outXfer = new Float64Array(S);
    const stopOfX = new Int32Array(net.nNodes).fill(-1);
    for (let s = 0; s < S; s++) stopOfX[B0 + s] = s;
    for (let a = 0; a < net.nLinks; a++) {
      const t = net.type[a];
      if (t === LINK_BOARD && stopOfX[net.tail[a]] < 0) stopOfX[net.tail[a]] = net.lines[net.line[a]].stops[net.pos[a]];
    }
    for (let a = 0; a < net.nLinks; a++) {
      const v = vol[a];
      if (!v) continue;
      const t = net.type[a];
      if (t === LINK_ACCESS) inWalk[net.head[a] - B0] += v;
      else if (t === LINK_EGRESS) outWalk[net.tail[a] - A0] += v;
      else if (t === LINK_CHANGE || t === LINK_WALK) {
        outXfer[net.tail[a] - A0] += v;
        const s = stopOfX[net.head[a]];
        if (s >= 0) inXfer[s] += v;
      }
    }
    for (let a = 0; a < net.nLinks; a++) {
      const v = vol[a];
      if (!v) continue;
      const t = net.type[a];
      const l = net.lines[net.line[a]];
      if (t !== LINK_BOARD && t !== LINK_ALIGHT && t !== LINK_RIDE) continue;
      if (!want.has(l.route) || l.feed !== 'muni') continue;
      if (!acc.has(l.route)) acc.set(l.route, { on: 0, onX: 0, off: 0, offX: 0, pkm: 0, stopsOn: new Map(), stopsOff: new Map() });
      const r = acc.get(l.route)!;
      if (t === LINK_RIDE) {
        const sa = H.stops[l.stops[net.pos[a]]], sb = H.stops[l.stops[net.pos[a] + 1]];
        r.pkm += (v * Math.hypot(sb.x - sa.x, sb.y - sa.y)) / 1000;
        continue;
      }
      const s = l.stops[net.pos[a]];
      if (t === LINK_BOARD) {
        const x = inXfer[s] / Math.max(1e-9, inXfer[s] + inWalk[s]);
        r.on += v;
        r.onX += v * x;
        const m = r.stopsOn.get(s) ?? [0, 0];
        r.stopsOn.set(s, [m[0] + v, m[1] + v * x]);
      } else {
        const x = outXfer[s] / Math.max(1e-9, outXfer[s] + outWalk[s]);
        r.off += v;
        r.offX += v * x;
        const m = r.stopsOff.get(s) ?? [0, 0];
        r.stopsOff.set(s, [m[0] + v, m[1] + v * x]);
      }
    }
  }
  const obs = new Map(H.observed.muniRoutes.map((o) => [o.route, o.boardings]));
  const k = (x: number) => `${(x / 1000).toFixed(2)}k`;
  for (const [route, r] of [...acc].sort((a, c) => c[1].on / (obs.get(c[0]) ?? 1) - a[1].on / (obs.get(a[0]) ?? 1))) {
    const top = (m: Map<number, [number, number]>) => [...m].sort((a, c) => c[1][0] - a[1][0]).slice(0, 5).map(([s, [v, x]]) => `${H.stops[s].name.slice(0, 30)} ${k(v)} (${((100 * x) / v).toFixed(0)}% change)`).join('; ');
    console.log(`${route}: model ${k(r.on)} / counted ${k(obs.get(route) ?? 0)}; boarding after a change ${((100 * r.onX) / r.on).toFixed(0)}%, alighting to change ${((100 * r.offX) / r.off).toFixed(0)}%; ${(r.pkm / r.on / 1.609).toFixed(2)} mi a ride`);
    console.log(`   on:  ${top(r.stopsOn)}`);
    console.log(`   off: ${top(r.stopsOff)}`);
  }
}
main();
