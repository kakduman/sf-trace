/**
 * Traffic feedback scenarios in Node, run as the page runs them (one pass from today's crowding):
 * first today's network with feedback on (it must reproduce the baseline), then a congestion charge
 * and a road diet. Prints what changes and how long each step takes.
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx tsx server/beta3/pipeline/roads-test.ts [today,cordon,diet] [--feedback 3]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { localAon, resolveRoadEdits, roadNetFrom, type RoadHeader } from '../../../shared/beta3/roads';
import { TPERIODS, type Edit, type Scenario } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

/** SFCTA's Downtown Congestion Pricing Study zone (client/beta3/scenario.ts DOWNTOWN_RING) */
const RING: [number, number][] = [
  [37.8058, -122.4239], [37.8091, -122.4152], [37.8088, -122.4098], [37.806, -122.404], [37.7956, -122.3918], [37.787, -122.387], [37.778, -122.3858], [37.764, -122.3855],
  [37.7638, -122.3958], [37.7718, -122.4021], [37.7699, -122.4046], [37.7695, -122.4198], [37.7681, -122.4199], [37.7678, -122.4288], [37.7718, -122.4248], [37.7784, -122.4262], [37.7791, -122.4196], [37.8058, -122.4239],
];
const SCENARIOS: Record<string, Scenario> = {
  control: { name: 'Today without traffic feedback', edits: [] },
  today: { name: 'Today with traffic feedback', edits: [], traffic: true },
  cordon: { name: 'Downtown congestion charge', traffic: true, edits: [{ kind: 'cordon', id: 'downtown', name: 'Downtown congestion charge', ring: RING, toll: { AM: 8, PM: 8 } }] },
  diet: { name: '19th Avenue road diet', traffic: true, edits: [{ kind: 'road', id: '19th', name: '19th Avenue road diet', street: '19th Avenue', from: { lat: 37.7656, lon: -122.4772 }, to: { lat: 37.7347, lon: -122.4751 }, lanes: -1 }] },
  buslane: { name: 'Bus lanes on 19th Avenue', traffic: true, edits: [{ kind: 'road', id: '19thbus', name: 'Bus lanes on 19th Avenue', street: '19th Avenue', from: { lat: 37.7656, lon: -122.4772 }, to: { lat: 37.7347, lon: -122.4751 }, lanes: -1, busLane: true }] },
  geary: { name: 'Bus lanes on Geary Boulevard', edits: [{ kind: 'road', id: 'geary', name: 'Bus lanes on Geary', street: 'Geary Boulevard', from: { lat: 37.782, lon: -122.4473 }, to: { lat: 37.7795, lon: -122.493 }, lanes: -1, busLane: true }] },
  free: { name: 'Fare-free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] },
  parking: { name: 'Dearer parking downtown', edits: [{ kind: 'parking', id: 'p', name: 'Downtown parking +$4/h', ring: RING, perHour: 4 }] },
  close: { name: 'Close the Embarcadero to cars', traffic: true, edits: [{ kind: 'road', id: 'emb', name: 'Embarcadero closed', street: 'The Embarcadero', from: { lat: 37.8063, lon: -122.4053 }, to: { lat: 37.7845, lon: -122.3878 }, closed: true }] },
};

async function main() {
  const which = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'today,cordon,diet').split(',');
  // the comparison is with a run of today's network made the same way, without feedback: the saved
  // baseline can come from an older version of the code
  if (which[0] !== 'control') which.unshift('control');
  let control: Awaited<ReturnType<typeof runModel>> | null = null;
  const B = loadBundle();
  const calib = B.header.calibration!;
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`)));
  const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const prep = prepare(B);
  const out: Record<string, unknown> = {};
  for (const w of which) {
    const sc = SCENARIOS[w];
    const ed = resolveRoadEdits(net, sc);
    for (const [id, links] of Object.entries(ed.byEdit)) console.log(`${sc.name}: edit ${id} touches ${links.length} links (${[...new Set(links.map((k) => net.h.names[net.name[k]]))].slice(0, 5).join(', ')})`);
    const timing: Record<string, number> = {};
    let stage = '',
      ts = Date.now();
    const onProgress = (s: string) => {
      const now = Date.now();
      if (stage) timing[stage] = (timing[stage] ?? 0) + (now - ts) / 1000;
      stage = /^Finding/.test(s) ? 'transit skims' : /^Choosing/.test(s) ? 'demand' : /^Assigning/.test(s) ? 'road assignment' : /^Loading/.test(s) ? 'transit assignment' : 'other';
      ts = now;
    };
    const t0 = Date.now();
    const traffic = w === 'control' ? undefined : { net, aon: localAon(net), opts: { feedback: Number(arg('--feedback', '5')) } };
    const r = await runModel(B, sc, calib, new LocalExecutor(B, sc, calib), { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice, onProgress, traffic }, prep);
    onProgress('done');
    if (w === 'control') {
      control = r;
      console.log(`control (no feedback): ${((Date.now() - t0) / 1000).toFixed(0)} s (${Object.entries(timing).map(([k, v]) => `${k} ${v.toFixed(0)} s`).join(', ')})`);
      out.control = { seconds: (Date.now() - t0) / 1000, timing };
      continue;
    }
    const ref = control!;
    const T = r.traffic!;
    const day = (x: Record<string, number>) => TPERIODS.reduce((a, p) => a + x[p], 0);
    const pctd = (a: number, b: number) => `${(100 * (a / b - 1)).toFixed(2)}%`;
    const mode = Object.fromEntries(Object.entries(r.summary.trips).map(([m, v]) => [m, Math.round(v - ref.summary.trips[m as keyof typeof ref.summary.trips])]));
    console.log(`\n== ${sc.name}: ${((Date.now() - t0) / 1000).toFixed(0)} s (${Object.entries(timing).map(([k, v]) => `${k} ${v.toFixed(0)} s`).join(', ')})`);
    console.log(`  gaps ${TPERIODS.map((p) => `${p} ${T.gaps[p].toExponential(1)} (${T.iterations[p]} it)`).join(', ')}; ${T.loadings} all-or-nothing loadings in all`);
    console.log(`  person trips by mode vs today: ${Object.entries(mode).map(([m, v]) => `${m} ${v >= 0 ? '+' : ''}${v}`).join(', ')}; transit trips ${pctd(r.summary.transitTrips, ref.summary.transitTrips)}`);
    console.log(`  VMT ${pctd(day(T.summary.vmt), day(T.base.vmt))} (${Math.round(day(T.summary.vmt) / 1000)}k mi), VHT ${pctd(day(T.summary.vht), day(T.base.vht))}; vehicles ${TPERIODS.map((p) => `${p} ${pctd(T.vehicles[p], T.base.vehicles[p] ?? T.vehicles[p])}`).join(' ')}`);
    console.log(`  speeds AM (today → scenario): ${Object.keys(T.summary.speed).map((c) => `${c} ${T.base.speed[c].AM.toFixed(1)}→${T.summary.speed[c].AM.toFixed(1)}`).join(', ')}`);
    console.log(`  largest changes: ${T.changes.slice(0, 8).map((c) => `${c.name} ${c.base}→${c.scenario}`).join('; ')}`);
    // end-to-end morning running time of the routes on the edited streets, today and in the scenario
    const busOf = (route: string) => {
      const sum = (nets: typeof r.nets) => {
        const ls = nets.AM.lines.filter((l) => l.feed === 'muni' && l.route === route);
        return ls.length ? ls.reduce((a, l) => a + l.hops.reduce((x, y) => x + y, 0), 0) / ls.length / 60 : NaN;
      };
      return { route, base: +sum(ref.nets).toFixed(1), scenario: +sum(r.nets).toFixed(1) };
    };
    const bus = w === 'buslane' ? ['28', '28R'].map(busOf) : w === 'geary' ? ['38', '38R'].map(busOf) : w === 'cordon' ? ['30', '8', '12'].map(busOf) : [];
    if (bus.length) console.log(`  bus end-to-end AM minutes: ${bus.map((b) => `${b.route} ${b.base}→${b.scenario}`).join(', ')}`);
    console.log(`  drives: ${T.trips.map((t) => `${t.name} ${t.period} ${t.base}→${t.scenario}`).join('; ')}; convergence ${T.convergence.map((c) => c.toFixed(4)).join(', ')}`);
    const res: Record<string, unknown> = { bus, trips: T.trips, convergence: T.convergence, seconds: (Date.now() - t0) / 1000, timing, gaps: T.gaps, iterations: T.iterations, mode, transitTrips: r.summary.transitTrips - ref.summary.transitTrips, vmt: { base: day(T.base.vmt), scenario: day(T.summary.vmt) }, vht: { base: day(T.base.vht), scenario: day(T.summary.vht) }, speed: { base: T.base.speed, scenario: T.summary.speed }, changes: T.changes };
    // the charge: cars entering the zone by period (toll links), today and with the charge
    const cord = sc.edits.find((e): e is Extract<Edit, { kind: 'cordon' }> => e.kind === 'cordon');
    if (cord) {
      const links = ed.byEdit[cord.id];
      const sum = (f: ArrayLike<number>) => links.reduce((a, k) => a + f[k], 0);
      const by = TPERIODS.map((p) => ({ p, base: sum(net.base[p]!), scn: sum(T.flow[p]) }));
      console.log(`  vehicles entering the zone: ${by.map((x) => `${x.p} ${Math.round(x.base)}→${Math.round(x.scn)} (${pctd(x.scn, x.base)})`).join(', ')}`);
      res.entering = by;
    }
    for (const e of sc.edits)
      if (e.kind === 'road') {
        const links = ed.byEdit[e.id];
        const sum = (f: ArrayLike<number>) => links.reduce((a, k) => a + f[k], 0) / Math.max(1, links.length);
        const by = TPERIODS.map((p) => ({ p, base: sum(net.base[p]!), scn: sum(T.flow[p]) }));
        console.log(`  mean volume on the edited links: ${by.map((x) => `${x.p} ${Math.round(x.base)}→${Math.round(x.scn)}`).join(', ')}`);
        res.edited = by;
      }
    if (w === 'today') {
      // with nothing changed, the run must reproduce today's
      const d = Object.entries(r.summary.trips).map(([m, v]) => Math.abs(v - ref.summary.trips[m as keyof typeof ref.summary.trips]));
      console.log(`  reproduces today: largest change in trips by mode ${Math.max(...d).toFixed(3)}`);
    }
    out[w] = res;
  }
  const f = `${REFERENCE}/road-scenarios.json`;
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  fs.writeFileSync(f, JSON.stringify({ ...prev, ...out }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
