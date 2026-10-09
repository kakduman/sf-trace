/**
 * Diagnostic: Caltrain at the city's stations (San Francisco and 22nd Street) by market and period:
 * boardings there by riders leaving the city, and alightings there by riders arriving, against the
 * 2024 OD survey's journeys by direction and period (station-od.ts caltrainCityDirection, the
 * calibration's targets). Shows which markets carry the morning's riders each way and which make up
 * the total at other times.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-caltrain-dir.ts [out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { prepare, LocalExecutor } from '../../../shared/beta3/model';
import { boardStop, LINK_BOARD } from '../../../shared/beta3/net';
import { decodeResult } from '../../../shared/beta3/results';
import { TPERIODS, type TPeriod } from '../../../shared/beta3/types';
import { crowdArrays, modelState } from './od-checks';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';
import { readRegional } from './station-od';

async function main() {
  const b = loadBundle();
  const H = b.header, calib = H.calibration!;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const st = await modelState(b, calib, prepare(b), base.finalCrowd);
  // commutes across the city line by county, all modes and transit (shuttles apart), trips a day
  {
    const D = st.demand as unknown as { workIn: Record<string, Record<string, number>>; workOut: Record<string, Record<string, number>>; shuttleOut: Record<string, number> };
    const tot = (r: Record<string, number>) => Object.values(r).reduce((a, v) => a + v, 0);
    for (const c of ['San Mateo', 'Santa Clara']) {
      const i = D.workIn[c], o = D.workOut[c];
      console.log(`${c}: in ${Math.round(tot(i ?? {}))} trips, transit ${Math.round(i?.transit ?? 0)}; out ${Math.round(tot(o ?? {}))} trips, transit ${Math.round(o?.transit ?? 0)}, shuttle ${Math.round(D.shuttleOut[c] ?? 0)}`);
    }
  }
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const city = new Set(H.stops.map((s, i) => (s.feed === 'caltrain' && /^(San Francisco|22nd Street)/.test(s.name) ? i : -1)).filter((i) => i >= 0));
  const out: Record<string, Record<string, { on: number; off: number }>> = {};
  for (const [k, byP] of Object.entries(st.markets)) {
    if (k.startsWith('work ')) continue;
    for (const p of TPERIODS) {
      const od = byP[p];
      if (!od) continue;
      const cr = crowdArrays(b, calib, p, st.crowd);
      const vol = await exec.assign(p, od, cr);
      const net = exec.net(p, cr);
      const e = ((out[k] ??= {})[p] ??= { on: 0, off: 0 });
      for (let a = 0; a < net.nLinks; a++) {
        if (!vol[a]) continue;
        const l = net.lines[net.line[a]];
        if (!l || l.feed !== 'caltrain') continue;
        if (net.type[a] === LINK_BOARD && city.has(boardStop(net, a))) e.on += vol[a];
        else if (net.type[a] === 2 && city.has(net.head[a] - net.nZones)) e.off += vol[a];
      }
    }
  }
  const R = readRegional().caltrain;
  const ci = R.stations.map((n, i) => (['San Francisco', '22nd Street'].includes(n) ? i : -1)).filter((i) => i >= 0);
  const obs = Object.fromEntries(
    TPERIODS.map((p) => {
      const M = R.od.wkd[p as TPeriod];
      let from = 0, to = 0;
      for (const i of ci) for (let j = 0; j < M.length; j++) if (!ci.includes(j)) ((from += M[i][j]), (to += M[j][i]));
      return [p, { on: Math.round(from), off: Math.round(to) }];
    }),
  );
  const tot = Object.fromEntries(TPERIODS.map((p) => [p, Object.values(out).reduce((a, v) => ({ on: a.on + (v[p]?.on ?? 0), off: a.off + (v[p]?.off ?? 0) }), { on: 0, off: 0 })]));
  console.log(`period: model on/off at SF+22nd (observed journeys leaving/arriving)`);
  for (const p of TPERIODS) console.log(`  ${p}: ${Math.round(tot[p].on)}/${Math.round(tot[p].off)} (${obs[p].on}/${obs[p].off})`);
  const rows = Object.entries(out)
    .map(([k, v]) => ({ k, all: TPERIODS.reduce((a, p) => a + (v[p]?.on ?? 0) + (v[p]?.off ?? 0), 0), v }))
    .filter((r) => r.all >= 20)
    .sort((a, c) => c.all - a.all);
  for (const r of rows) console.log(`${r.k.padEnd(28)} ${TPERIODS.map((p) => `${p} ${Math.round(r.v[p]?.on ?? 0)}/${Math.round(r.v[p]?.off ?? 0)}`).join('  ')}`);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ observed: obs, model: tot, byMarket: out }, null, 1));
}

main();
