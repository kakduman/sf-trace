/**
 * Re-score today's traffic (client/beta3/model/roads.bin.gz) against the counts and speeds as
 * roads.ts maps them now, without re-running the assignment: the counts and CMP segments are taken
 * from work/roads-net.bin when its network is the bundle's. Rewrites the bundle's header and
 * server/beta3/reference/road-validation.json.
 * Run: npx tsx server/beta3/pipeline/roads-validate.ts
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle, encodeBundle } from '../../../shared/beta3/bundle';
import { linkTimes, periodRoads, roadNetFrom, summariseRoads, type RoadHeader } from '../../../shared/beta3/roads';
import { TPERIODS, type TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE, WORK } from './paths';
import { networkFacts, validate } from './roads-base';
import { loadBundle } from './run-base';

function main() {
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`)));
  const h = rb.header as unknown as RoadHeader;
  const fb = decodeBundle(fs.readFileSync(`${WORK}/roads-net.bin`));
  const fresh = fb.header as unknown as RoadHeader;
  if (fresh.nLinks !== h.nLinks || fresh.nNodes !== h.nNodes) throw new Error('roads-net.bin is a different network: run roads-base.ts');
  for (let k = 0; k < h.nLinks; k++) {
    const A = rb.a.a as Int32Array, Bb = fb.a.a as Int32Array, A2 = rb.a.b as Int32Array, B2 = fb.a.b as Int32Array;
    if (A[k] !== Bb[k] || A2[k] !== B2[k]) throw new Error('roads-net.bin is a different network: run roads-base.ts');
  }
  h.counts = fresh.counts;
  h.cmp = fresh.cmp;
  // the network's own arrays (and any added since, such as the buses' links) from roads-net.bin;
  // today's flows and trips from the bundle
  for (const [k, v] of Object.entries(fb.a)) rb.a[k] = v;
  const net = roadNetFrom(h, rb.a);
  const flow = {} as Record<TPeriod, Float64Array>,
    time = {} as Record<TPeriod, Float64Array>;
  for (const p of TPERIODS) {
    const R = periodRoads(net, p);
    flow[p] = Float64Array.from(net.base[p]!);
    time[p] = new Float64Array(h.nLinks);
    linkTimes(R, flow[p], time[p]);
  }
  const val = validate(net, flow, time, loadBundle().header.zones);
  for (const l of val.lines) console.log(l);
  const sum = summariseRoads(net, flow, time);
  console.log(`speeds (mph) by class: ${Object.entries(sum.speed).map(([c, v]) => `${c} ${TPERIODS.map((p) => v[p].toFixed(1)).join('/')}`).join('; ')}`);
  const { arrays: _a, ...header } = h;
  void _a;
  fs.writeFileSync(`${BUNDLE}/roads.bin.gz`, zlib.gzipSync(encodeBundle(header as never, rb.a as never), { level: 9 }));
  const network = networkFacts(net);
  fs.writeFileSync(`${REFERENCE}/road-validation.json`, JSON.stringify({ built: h.built, network, note: 'Base-year road assignment (server/beta3/pipeline/roads-base.ts) against counts and speeds. Counts at the city line were used to fit the background traffic and are not tests.', ...val.json, summary: { vmt: sum.vmt, vht: sum.vht, speed: sum.speed, vehicles: h.base?.vehicles, peninsula: sum.peninsula }, base: h.base }, null, 1));
}

main();
