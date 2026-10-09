/**
 * Diagnostic: the timing of transit travel by market. Each market's transit trips (residents' tours
 * by purpose, their stops and subtours, in-commuters, visitors, ...) are assigned on their own,
 * uncrowded, period by period, and BART's exits and entries at the eight city stations and Muni's
 * boardings are tallied by period, against BART's October 2025 hourly counts.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-tod.ts
 */
import fs from 'node:fs';
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, lineVolumes, prepare, SKIM_PERIODS } from '../../../shared/beta3/model';
import type { TPeriod } from '../../../shared/beta3/types';
import { REFERENCE } from './paths';
import { loadBundle } from './run-base';

const P: TPeriod[] = ['AM', 'MD', 'PM', 'NT'];
async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const markets: Record<string, Record<TPeriod, Float32Array>> = {};
  computeDemand(b, prepare(b), sk as never, calib, 'wkd', 1, markets);
  const codes = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB'];
  const sf = new Set(codes.map((c) => H.observed.bartStations.find((s) => s.code === c)!.stop!));
  const nets = Object.fromEntries(P.map((p) => [p, exec.net(p)]));
  type Row = { trips: Record<string, number>; ex: Record<string, number>; en: Record<string, number>; muni: Record<string, number> };
  const rows: [string, Row][] = [];
  for (const [k, byP] of Object.entries(markets)) {
    const r: Row = { trips: {}, ex: {}, en: {}, muni: {} };
    for (const p of P) {
      const od = byP[p];
      r.trips[p] = r.ex[p] = r.en[p] = r.muni[p] = 0;
      if (!od) continue;
      for (let i = 0; i < od.length; i++) r.trips[p] += od[i];
      const net = nets[p];
      const v = lineVolumes(net, await exec.assign(p, od, undefined));
      net.lines.forEach((l, li) => {
        if (l.feed === 'muni') r.muni[p] += v.on[li].reduce((a, x) => a + x, 0);
        if (l.feed !== 'bart') return;
        l.stops.forEach((s, j) => {
          if (!sf.has(s)) return;
          r.ex[p] += v.off[li][j];
          r.en[p] += v.on[li][j];
        });
      });
    }
    rows.push([k, r]);
  }
  const tot = (x: Record<string, number>) => P.reduce((a, p) => a + x[p], 0);
  const pct = (x: Record<string, number>) => P.map((p) => (tot(x) ? ((100 * x[p]) / tot(x)).toFixed(0) : '-').padStart(4)).join('');
  rows.sort((a, c) => tot(c[1].ex) - tot(a[1].ex));
  const all: Row = { trips: {}, ex: {}, en: {}, muni: {} };
  for (const p of P) for (const f of ['trips', 'ex', 'en', 'muni'] as const) all[f][p] = rows.reduce((a, [, r]) => a + r[f][p], 0);
  console.log('market                       BART city exits  AM  MD  PM  NT | entries  AM  MD  PM  NT | Muni on   AM  MD  PM  NT | trips  AM  MD  PM  NT');
  for (const [k, r] of [...rows, ['ALL', all] as [string, Row]])
    console.log(`${k.padEnd(28)}${Math.round(tot(r.ex)).toString().padStart(9)}      ${pct(r.ex)} |${Math.round(tot(r.en)).toString().padStart(8)} ${pct(r.en)} |${Math.round(tot(r.muni)).toString().padStart(8)} ${pct(r.muni)} |${Math.round(tot(r.trips)).toString().padStart(7)}${pct(r.trips)}`);
  const o = JSON.parse(fs.readFileSync(`${REFERENCE}/time-of-day.json`, 'utf8')).bartSfStations.sfEightStations;
  const ob = (x: Record<string, number>) => ({ AM: x.AM, MD: x.MD, PM: x.PM, NT: x.EA + x.EV });
  console.log(`${'BART observed (Oct 2025)'.padEnd(28)}${o.exitsDaily.toString().padStart(9)}      ${pct(ob(o.exitsByPeriod))} |${o.entriesDaily.toString().padStart(8)} ${pct(ob(o.entriesByPeriod))}`);
}
main();
