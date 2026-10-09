/**
 * Diagnostic: where along each Muni route the model's riders board, against SFMTA's 2006–07 stop
 * counts (TEP; muni-stop-ridership.json). The old counts are used as shares only: for each route,
 * each stop's share of the route's boardings, compared in fifths of the route (by stop order in
 * the TEP pattern) and by neighborhood. Prints the routes whose spread differs most.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-stops.ts [route ...]
 */
import fs from 'node:fs';
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare, SKIM_PERIODS } from '../../../shared/beta3/model';
import { boardStop } from '../../../shared/beta3/net';
import type { TPeriod } from '../../../shared/beta3/types';
import { REFERENCE } from './paths';
import { loadBundle } from './run-base';

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const d = computeDemand(b, prepare(b), sk as never, calib);
  // model boardings by route and stop
  const on = new Map<string, number>();
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const vol = await exec.assign(p, d.transitOD[p], undefined);
    const net = exec.net(p);
    for (let a = 0; a < net.nLinks; a++) {
      if (!vol[a] || net.type[a] !== 4) continue;
      const l = net.lines[net.line[a]];
      if (l.feed !== 'muni') continue;
      const st = H.stops[boardStop(net, a)];
      if (!st) continue;
      const k = `${l.route}|${st.id.replace('muni:', '')}`;
      on.set(k, (on.get(k) ?? 0) + vol[a]);
    }
  }
  const T = JSON.parse(fs.readFileSync(`${REFERENCE}/muni-stop-ridership.json`, 'utf8'));
  const only = new Set(process.argv.slice(2));
  // one route named: its modeled boardings stop by stop, along each pattern
  if (only.size === 1) {
    const r = [...only][0];
    for (const l of H.lines.filter((x) => x.feed === 'muni' && x.route === r)) {
      console.log(`${r} dir ${l.dir}: ${H.stops[l.stops[0]].name} > ${H.stops[l.stops[l.stops.length - 1]].name}`);
      console.log('  ' + l.stops.map((st) => `${H.stops[st].name.replace(/ (Station|Northbound|Southbound|Inbound|Outbound)/g, '').slice(0, 26)} ${Math.round(on.get(`${r}|${H.stops[st].id.replace('muni:', '')}`) ?? 0)}`).join(' · '));
    }
  }
  const nhoodOf = (lat: number, lon: number) => {
    let best = 0, bd = Infinity;
    H.zones.forEach((z, i) => { const dd = (z.lat - lat) ** 2 + (z.lon - lon) ** 2; if (dd < bd) (bd = dd), (best = i); });
    return H.zones[best].nhood;
  };
  const out: { route: string; dev: number; fifths: string; worst: string }[] = [];
  const byRoute = new Map<string, { seq: number; stopId: string; on: number; lat: number; lon: number }[]>();
  for (const r of T.rows) if (r.stopId && r.lat != null) {
    if (!byRoute.has(r.route)) byRoute.set(r.route, []);
    byRoute.get(r.route)!.push({ seq: r.patternId * 1000 + r.seq, stopId: r.stopId, on: r.boardings, lat: r.lat, lon: r.lon });
  }
  for (const [route, rows] of byRoute) {
    if (only.size && !only.has(route)) continue;
    const obsT = rows.reduce((a, r) => a + r.on, 0);
    const modT = rows.reduce((a, r) => a + (on.get(`${route}|${r.stopId}`) ?? 0), 0);
    if (obsT < 500 || modT < 50) continue;
    // fifths along each pattern
    rows.sort((a, c) => a.seq - c.seq);
    const f = [0, 0, 0, 0, 0].map(() => [0, 0]);
    const pats = new Map<number, typeof rows>();
    for (const r of rows) { const p = Math.floor(r.seq / 1000); if (!pats.has(p)) pats.set(p, []); pats.get(p)!.push(r); }
    for (const list of pats.values()) list.forEach((r, i) => { const q = Math.min(4, Math.floor((5 * i) / list.length)); f[q][0] += r.on / obsT; f[q][1] += (on.get(`${route}|${r.stopId}`) ?? 0) / modT; });
    const dev = f.reduce((a, [o, m]) => a + Math.abs(o - m), 0) / 2;
    const nh = new Map<string, [number, number]>();
    for (const r of rows) { const n = nhoodOf(r.lat, r.lon); const v = nh.get(n) ?? [0, 0]; v[0] += r.on / obsT; v[1] += (on.get(`${route}|${r.stopId}`) ?? 0) / modT; nh.set(n, v); }
    const worst = [...nh].sort((a, c) => Math.abs(c[1][1] - c[1][0]) - Math.abs(a[1][1] - a[1][0])).slice(0, 3).map(([n, [o, m]]) => `${n} ${(100 * o).toFixed(0)}%→${(100 * m).toFixed(0)}%`).join(', ');
    out.push({ route, dev, fifths: f.map(([o, m]) => `${(100 * o).toFixed(0)}/${(100 * m).toFixed(0)}`).join(' '), worst });
  }
  out.sort((a, c) => c.dev - a.dev);
  console.log('route  share misplaced  fifths (2006–07 % / model %)  biggest neighborhood differences');
  for (const r of out) console.log(`${r.route.padEnd(5)} ${(100 * r.dev).toFixed(0).padStart(3)}%  ${r.fifths}  ${r.worst}`);
}
main();
