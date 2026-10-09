/**
 * The city line's counted crossings taken apart by market: the model's own cars by market (today's
 * run, one pass from the saved crowding, as the baseline), the through trips and trucks, and what is
 * left, against the counts. Writes reference/gateway-markets.json (the `model` part; the published
 * evidence is kept there by hand).
 *
 * Run: npx tsx server/beta3/pipeline/gateways.ts [--label today]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { corridorOf, LINE_X, prepare } from '../../../shared/beta3/demand';
import { LocalExecutor, runModel } from '../../../shared/beta3/model';
import { MODES } from '../../../shared/beta3/params';
import { decodeResult } from '../../../shared/beta3/results';
import type { Scenario } from '../../../shared/beta3/types';
import { COUNTED, gatewayPaths } from './gateway-paths';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

/** the markets' names in the table */
export const MARKET_NAMES: Record<string, string> = {
  'res work': "residents' commutes out",
  work: 'in-commuters',
  'res social': "residents' other trips out",
  regional: 'regional visitors',
  airport: 'air travelers (SFO)',
  event: 'event-goers',
  univ: 'college students from outside',
};

async function main() {
  const label = arg('--label', 'today');
  const B = loadBundle();
  const calib = B.header.calibration!;
  console.time('gateway paths');
  const G = gatewayPaths(B);
  console.timeEnd('gateway paths');
  LINE_X.paths = G.paths;
  LINE_X.n = COUNTED.length;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const sc: Scenario = { name: 'Today', edits: [] };
  const r = await runModel(B, sc, calib, new LocalExecutor(B, sc, calib), { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice }, prepare(B));
  const d = r.demand;
  const NX = B.header.ext.length;
  const markets = Object.keys(d.lineVeh).sort((a, b) => d.lineVeh[b].reduce((x, v) => x + v, 0) - d.lineVeh[a].reduce((x, v) => x + v, 0));
  const table = markets.map((k) => ({
    market: MARKET_NAMES[k] ?? k,
    key: k,
    byGateway: Object.fromEntries(COUNTED.map((g, i) => [g.name, Math.round(d.lineVeh[k][i + 1])])),
    uncounted: Math.round(d.lineVeh[k][0]),
  }));
  const model = COUNTED.map((_, i) => markets.reduce((a, k) => a + d.lineVeh[k][i + 1], 0));
  const gw = G.counts.map((c, i) => {
    const trucks = (c.daily * c.truckPct) / 100;
    return { name: c.name, count: c.daily, truckPct: c.truckPct, trucks: Math.round(trucks), through: Math.round(c.through), model: Math.round(model[i]), left: Math.round(c.daily - trucks - c.through - model[i]) };
  });
  // person trips across the line by market, mode, and corridor
  const persons: Record<string, Record<string, Record<string, number>>> = {};
  for (const k of markets.concat(Object.keys(d.lineTrips).filter((k) => !markets.includes(k)))) {
    const t = d.lineTrips[k];
    if (!t) continue;
    const o: Record<string, Record<string, number>> = {};
    for (let e = 0; e < NX; e++) {
      const c = corridorOf(B.header.ext[e]);
      o[c] ??= {};
      MODES.forEach((m, mi) => (o[c][m] = (o[c][m] ?? 0) + t[mi * NX + e]));
    }
    for (const c of Object.keys(o)) for (const m of MODES) o[c][m] = Math.round(o[c][m]);
    persons[MARKET_NAMES[k] ?? k] = o;
  }
  console.log(`model cars across the city line, by market (weekday, both ways; ${label}):`);
  console.log(['market'.padEnd(32), ...COUNTED.map((g) => g.name.padStart(11)), 'uncounted'.padStart(11)].join(''));
  for (const t of table) console.log([t.market.padEnd(32), ...COUNTED.map((g) => String(t.byGateway[g.name]).padStart(11)), String(t.uncounted).padStart(11)].join(''));
  for (const g of gw) console.log(`${g.name}: count ${g.count}, trucks ${g.trucks} (${g.truckPct}%), through ${g.through}, model ${g.model}, left ${g.left}`);
  const f = `${REFERENCE}/gateway-markets.json`;
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  prev.model ??= {};
  prev.model[label] = { built: new Date().toISOString(), note: "The model's own cars across the counted crossings by market (gateways.ts): today's run, one pass from the saved crowding; each car trip on its least-cost path at today's congested times (roads.bin.gz). Trucks are Caltrans' truck AADT share at the count; through trips as roads-base.ts. 'left' is what the background fills: light commercial vehicles and any market the model misses.", markets: table, gateways: gw, personsByCorridor: persons };
  fs.writeFileSync(f, JSON.stringify(prev, null, 1));
  console.log(`wrote ${f}`);
}

main();
