/**
 * The Peninsula freeways in scenarios: each scenario run in a run mode against today's network run
 * the same way in the same process (the control), with what the corridors add: Caltrain riders, the
 * model's car trips on US-101 and I-280, the corridor speeds by segment and period, the Peninsula
 * drivers' time savings, and the time savings by part.
 *
 *   npx tsx server/beta3/pipeline/peninsula-runs.ts [--mode precise] [--scenarios portal,free,cordon] [--tag after] [--freeze-corridors]
 *   npx tsx server/beta3/pipeline/peninsula-runs.ts combine   (the "before" and "after" runs → reference/peninsula-runs.json)
 *
 * Writes $BETA3_WORK/peninsula-runs-<mode>[-<tag>].json. The "before" runs are the same model and
 * calibration with the corridors held at today's times (--freeze-corridors, as Quick holds them), so
 * before and after differ only by what the corridors' response adds.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { aonOrigins, linkTimes, localAon, periodRoads, roadNetFrom, RoadPaths, type RoadHeader } from '../../../shared/beta3/roads';
import type { RunMode } from '../../../shared/beta3/runmode';
import { TPERIODS, type Calibration, type Scenario } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE, WORK } from './paths';
import { loadBundle } from './run-base';
import { testScenarios } from './runmodes-scenarios';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const cpu = () => process.cpuUsage().user / 1e6;
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, v) => a + v, 0);

/** before and after the corridors (runs tagged "before" and "after") → server/beta3/reference/peninsula-runs.json */
function combine() {
  const read = (t: string) => JSON.parse(fs.readFileSync(`${WORK}/peninsula-runs-precise-${t}.json`, 'utf8'));
  const before = read('before'),
    after = read('after');
  // the processor time of one all-or-nothing loading of the morning's trips, on the road network
  // without the freeways (--old-roads, the earlier roads.bin.gz) and with them
  const aon: Record<string, number> = {};
  const old = arg('--old-roads', '');
  for (const [k, f] of [['without', old], ['with', `${BUNDLE}/roads.bin.gz`]] as const) {
    if (!f || !fs.existsSync(f)) continue;
    const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(f)));
    const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
    const R = periodRoads(net, 'AM');
    const t = new Float64Array(net.h.nLinks);
    linkTimes(R, net.base.AM!, t);
    const cost = Float64Array.from(t, (v, i) => v + R.fixed[i]);
    const nC = net.h.nC;
    const od = new Float32Array(nC * nC);
    const q = net.baseOD.AM!;
    for (let i = 0; i < od.length; i++) od[i] = q[i] ? (q[i] / 256) ** 2 : 0;
    const P = new RoadPaths(net),
      all = [...Array(nC).keys()];
    aonOrigins(P, cost, od, all);
    const c0 = cpu();
    for (let i = 0; i < 10; i++) aonOrigins(P, cost, od, all);
    aon[k] = +((cpu() - c0) / 10).toFixed(3);
  }
  fs.writeFileSync(`${REFERENCE}/peninsula-runs.json`, JSON.stringify({ note: 'Precise runs with the Peninsula freeways held at today’s times ("before", as Quick holds them) and responding to traffic ("after"), on the same model and calibration (server/beta3/pipeline/peninsula-runs.ts), each against a run of today’s network made the same way in the same process: the difference is what the corridors’ response adds. Hours a weekday; vehicles by period. aonSeconds: processor seconds for one all-or-nothing loading of the morning’s trips, without and with the freeways.', aonSeconds: aon, before, after }, null, 1));
  console.log(`wrote ${REFERENCE}/peninsula-runs.json`);
}

async function main() {
  if (process.argv[2] === 'combine') return combine();

  const mode = arg('--mode', 'precise') as RunMode;
  const tag = arg('--tag', '');
  const B = loadBundle();
  const calib = B.header.calibration as Calibration;
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`)));
  const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const prep = prepare(B);
  const all = testScenarios(B);
  const which = arg('--scenarios', 'portal,free,cordon').split(',');
  if (which[0] !== 'today') which.unshift('today');
  const file = `${WORK}/peninsula-runs-${mode}${tag ? `-${tag}` : ''}.json`;
  const frozen = process.argv.includes('--freeze-corridors');
  const out: Record<string, unknown> = { mode, bundle: B.header.built, roads: net.h.built, corridors: !!(net.h as { peninsula?: unknown }).peninsula, frozen, runs: {} };
  type Run = Awaited<ReturnType<typeof runModel>>;
  let control: Run | null = null;
  for (const w of which) {
    const sc: Scenario = { ...all[w], runMode: mode };
    const c0 = cpu(),
      w0 = Date.now();
    const r = await runModel(B, sc, calib, new LocalExecutor(B, sc, calib), { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice, traffic: { net, aon: localAon(net), ...(frozen ? { opts: { freezeCorridors: true } } : {}) } }, prep);
    const secs = { cpu: +(cpu() - c0).toFixed(1), wall: +((Date.now() - w0) / 1000).toFixed(1) };
    if (w === 'today') control = r;
    const c = control!;
    const L = r.summary.logsum,
      P = (r.summary.logsumParts ?? { networkOnly: L, noRoads: L }) as { networkOnly: number; noRoads: number; peninsula?: number },
      Bl = c.summary.logsum,
      Pc = (c.summary.logsumParts ?? {}) as { peninsula?: number };
    // hours a day; the Peninsula drivers' part against the control's (zero when the control reproduces today)
    const pen = (P.peninsula ?? 0) - (Pc.peninsula ?? 0);
    const savings = { transit: (P.networkOnly - Bl) / 60, drivers: (L - P.noRoads) / 60, others: (P.noRoads - P.networkOnly) / 60, peninsula: pen / 60, total: (L - Bl + pen) / 60 };
    const T = r.traffic as (Run['traffic'] & { peninsula?: unknown }) | undefined;
    const Tc = c.traffic as (Run['traffic'] & { peninsula?: unknown }) | undefined;
    // the freeways segment by segment: the change in vehicles (the model's own: the background is
    // the same in both) and in speed, by period, against the control
    const penH = (net.h as { peninsula?: { segments: { route: string; dir: string; from: string; to: string; link: number; miles: number }[] } }).peninsula;
    const segments =
      penH && T && Tc
        ? penH.segments.map((sg) => ({
            route: sg.route,
            dir: sg.dir,
            from: sg.from,
            to: sg.to,
            dVeh: Object.fromEntries(TPERIODS.map((p) => [p, +(T.flow[p][sg.link] - Tc.flow[p][sg.link]).toFixed(1)])),
            mphControl: Object.fromEntries(TPERIODS.map((p) => [p, +((60 * sg.miles) / Tc.time[p][sg.link]).toFixed(3)])),
            mph: Object.fromEntries(TPERIODS.map((p) => [p, +((60 * sg.miles) / T.time[p][sg.link]).toFixed(3)])),
          }))
        : null;
    const row = {
      name: sc.name,
      roadResponse: r.roadResponse,
      seconds: secs,
      caltrain: { scenario: r.summary.boardings.caltrain ?? 0, control: c.summary.boardings.caltrain ?? 0 },
      transitTrips: r.summary.transitTrips - c.summary.transitTrips,
      trips: Object.fromEntries(Object.keys(r.summary.trips).map((m) => [m, (r.summary.trips as Record<string, number>)[m] - (c.summary.trips as Record<string, number>)[m]])),
      savings,
      vmtCity: T && Tc ? sum(T.summary.vmt) - sum(Tc.summary.vmt) : null,
      peninsula: T?.peninsula ?? null,
      peninsulaControl: w === 'today' ? null : (Tc?.peninsula ?? null),
      gaps: T?.gaps ?? null,
      iterations: T?.iterations ?? null,
      convergence: T?.convergence ?? null,
      trips2: T?.trips ?? null,
      corridorTrips: T?.corridorTrips ?? null,
      segments,
      summary: T ? { peninsula: T.summary.peninsula ?? null, control: Tc?.summary.peninsula ?? null } : null,
    };
    (out.runs as Record<string, unknown>)[w] = row;
    console.log(`${mode} ${w}: ${secs.cpu} s CPU (${secs.wall} s wall); Caltrain ${Math.round(row.caltrain.scenario - row.caltrain.control)}; time savings ${savings.total.toFixed(0)} h (transit ${savings.transit.toFixed(0)}, drivers ${savings.drivers.toFixed(0)}, Peninsula ${savings.peninsula.toFixed(1)}, others ${savings.others.toFixed(0)})`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  }
  void TPERIODS;
}

main();
