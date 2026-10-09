/**
 * Which counted city-line crossing each car trip between the city and an outside zone uses: the
 * least-cost paths at today's congested times (roads.bin.gz, the base equilibrium), by period. The
 * demand model tallies its own cars across the city line by market with them (demand.ts LINE_X), for
 * gateways.ts to set against the counts at the Golden Gate Bridge, the Bay Bridge, and the San Mateo
 * County line (US-101, I-280, SR-35, and SR-82), less trucks and through traffic.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { linkTimes, periodRoads, roadNetFrom, skimRoads, type RoadHeader, type RoadNet } from '../../../shared/beta3/roads';
import { TPERIODS, type Bundle, type TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE, WORK } from './paths';

/** the counted gateways, by the Caltrans count's route and postmile (as roads-base.ts fits them) */
export const COUNTED: { name: string; count: RegExp; gw: RegExp; screen: 'Golden Gate' | 'Bay Bridge' | 'County line' }[] = [
  { name: 'Bay Bridge', count: /^080-/, gw: /^Bay Bridge/, screen: 'Bay Bridge' },
  { name: 'Golden Gate', count: /^101-9/, gw: /^Golden Gate/, screen: 'Golden Gate' },
  { name: 'US-101', count: /^101-0$/, gw: /^US 101/, screen: 'County line' },
  { name: 'I-280', count: /^280-0$/, gw: /^I 280/, screen: 'County line' },
  { name: 'SR-35', count: /^035-/, gw: /^CA 35/, screen: 'County line' },
  { name: 'SR-82', count: /^082-/, gw: /^CA 82/, screen: 'County line' },
];

export interface GatewayPaths {
  /** the counted gateway (index into COUNTED, plus one; 0 for none) of the path from o to d, (NZ+NX)², by period */
  paths: Uint8Array[];
  /** each counted gateway's weekday count (both directions), its truck share (Caltrans), and its through trips */
  counts: { name: string; screen: string; daily: number; truckPct: number; through: number }[];
}

/**
 * Today's road network with its base equilibrium (roads.bin.gz), or, where that bundle is older than
 * the network roads.ts last built (its outside zones' legs or the Peninsula freeways missing), that
 * network at free-flow times.
 */
export function roadNet(): RoadNet {
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`)));
  const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
  const wf = `${WORK}/roads-net.bin`;
  if (net.h.peninsula || !fs.existsSync(wf)) return net;
  const w = decodeBundle(fs.readFileSync(wf));
  console.log('gateway paths: the road bundle predates the Peninsula freeways; using roads-net.bin at free-flow times');
  return roadNetFrom(w.header as unknown as RoadHeader, w.a);
}

export function gatewayPaths(B: Bundle, net = roadNet()): GatewayPaths {
  const NZ = B.header.zones.length,
    NX = B.header.ext.length,
    ZA = NZ + NX,
    nC = net.h.nC;
  const counts = net.h.counts.filter((c) => c.fitted);
  const TT = JSON.parse(fs.readFileSync(`${REFERENCE}/through-traffic.json`, 'utf8')) as { throughShare: Record<string, number> };
  // trucks: Caltrans' truck AADT share at the count nearest each gateway (gateway-markets.json)
  const TRUCKS = JSON.parse(fs.readFileSync(`${REFERENCE}/gateway-markets.json`, 'utf8')) as { truckPct: Record<string, { pct: number }> };
  const rows = COUNTED.map((g) => {
    const c = counts.find((x) => g.count.test(x.id));
    if (!c) throw new Error(`no count for ${g.name}`);
    return { g, c };
  });
  // through trips (roads-base.ts): each bridge's count times its through share, leaving by US-101 and
  // I-280 in proportion to their counts
  const bridgeThrough = rows.map(({ g, c }) => (g.name === 'Bay Bridge' ? TT.throughShare['Bay Bridge'] : g.name === 'Golden Gate' ? TT.throughShare['Golden Gate Bridge'] : 0) * c.daily);
  const southCount = rows.filter(({ g }) => g.name === 'US-101' || g.name === 'I-280').reduce((a, { c }) => a + c.daily, 0);
  const totalThrough = bridgeThrough.reduce((a, v) => a + v, 0);
  const out: GatewayPaths = {
    paths: [],
    counts: rows.map(({ g, c }, i) => ({
      name: g.name,
      screen: g.screen,
      daily: c.daily,
      truckPct: TRUCKS.truckPct[g.name]?.pct ?? 0,
      through: bridgeThrough[i] + (g.name === 'US-101' || g.name === 'I-280' ? (totalThrough * c.daily) / southCount : 0),
    })),
  };
  const ind = rows.map(({ c }) => {
    const a = new Float64Array(net.h.nLinks);
    for (const k of c.links) a[k] = 1;
    return a;
  });
  const origins = [...Array(ZA).keys()];
  for (const p of TPERIODS as readonly TPeriod[]) {
    const R = periodRoads(net, p);
    const t = new Float64Array(net.h.nLinks);
    if (net.base[p]) linkTimes(R, net.base[p]!, t);
    else t.set(R.t0);
    const sk = skimRoads(R, t, { origins, sums: ind });
    const P = new Uint8Array(ZA * ZA);
    for (let o = 0; o < ZA; o++)
      for (let d = 0; d < ZA; d++) {
        if (o < NZ === d < NZ) continue;
        for (let g = 0; g < ind.length; g++)
          if (sk.sums![g][o * nC + d] > 0) {
            P[o * ZA + d] = g + 1;
            break;
          }
      }
    out.paths.push(P);
  }
  return out;
}
