/**
 * Parameter uncertainty for scenario results. Behavioral parameters taken from other models or
 * assumed are drawn from ranges reported in the literature; for each draw the model runs today's
 * network and each example scenario with the same parameters, so the scenario's effect (scenario
 * minus today, same draw) carries the uncertainty. Calibrated constants are held fixed, so ranges
 * are conservative on levels but meaningful for differences.
 *
 * Ranges (uniform):
 *  - in-vehicle time coefficient ×0.8–1.2 (TM1 trip-level values; FTA's accepted −0.02 to −0.03)
 *  - wait weight 1.5–2.5 (NCHRP 716: wait/IVT ratio 1.5–2.6), walk weight 1.5–2.5
 *  - transfer penalty 2–8 min (TM2 boarding penalties 2.5–4.5 min, TM1 skims up to 20)
 *  - destination logsum coefficient 0.5–1.0 (typical of Bay Area models)
 *  - access spread θ 0.15–0.5 per perceived minute (assumed)
 *  - crowding: maximum seated/standing weights ×0.8–1.2 (TM2)
 * Writes server/beta3/reference/uncertainty.json (+ app copy).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/uncertainty.ts [draws]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { COEFFS, CROWDING, PATH, PURPOSES, TOUR_COEFFS, TUNE, transferPenalty } from '../../../shared/beta3/params';
import { decodeResult } from '../../../shared/beta3/results';
import type { Edit, Scenario } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function main() {
  const draws = Number(process.argv[2] ?? 12);
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const prep = prepare(b);
  const base0 = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const portal = JSON.parse(fs.readFileSync(`${BUNDLE}/portal-scenario.json`, 'utf8')) as Scenario;
  const scenarios: { id: string; scenario: Scenario; routes: string[] }[] = [
    { id: '38R x2', scenario: { name: '38R x2', edits: [{ kind: 'frequency', route: '38R', feed: 'muni', factor: { AM: 2, MD: 2, PM: 2, NT: 2 } }] }, routes: ['38R'] },
    { id: 'Mission lanes', scenario: { name: 'Mission lanes', edits: ['14', '14R', '49'].map((route) => ({ kind: 'speed', route, feed: 'muni', factor: 0.8 }) as Edit) }, routes: ['14', '14R', '49'] },
    { id: 'Muni fare +25%', scenario: { name: 'fare', edits: [{ kind: 'fare', feed: 'muni', factor: 1.25 }] }, routes: [] },
    { id: 'The Portal', scenario: portal, routes: [] },
  ];
  const orig = { ivt: Object.fromEntries(PURPOSES.map((p) => [p, { ...COEFFS[p] }])), tour: Object.fromEntries(PURPOSES.filter((p) => TOUR_COEFFS[p]).map((p) => [p, { ...TOUR_COEFFS[p]! }])), path: { ...PATH }, crowd: { ...CROWDING }, dest: TUNE.destLogsum };
  // the calibrated change penalty, before any draw overrides it
  const xfer0 = transferPenalty(calib);
  const R = rng(20261004);
  const routeB = (r: Awaited<ReturnType<typeof runModel>>, routes: string[]) => r.lines.filter((l) => l.line >= 0 && H.lines[l.line].feed === 'muni' && routes.includes(H.lines[l.line].route)).reduce((a, l) => a + Object.values(l.boardings).reduce((x, v) => x + v, 0), 0);
  const results: Record<string, { transitTrips: number[]; routeBoardings: number[]; benefitHours: number[]; caltrain: number[] }> = {};
  for (const s of scenarios) results[s.id] = { transitTrips: [], routeBoardings: [], benefitHours: [], caltrain: [] };
  const drawsOut: Record<string, number>[] = [];
  for (let k = 0; k < draws; k++) {
    // k = 0 is the model as calibrated
    const u = () => (k === 0 ? 0.5 : R());
    const ivtScale = 0.8 + 0.4 * u(), wait = 1.5 + u(), walk = 1.5 + u(), xfer = xfer0 * (0.5 + u()), dest = 0.5 + 0.5 * u(), theta = 0.15 + 0.35 * u(), crowd = 0.8 + 0.4 * u();
    const d = k === 0 ? { ivtScale: 1, wait: orig.path.waitWeight, walk: orig.path.walkWeight, xfer: xfer0, dest: orig.dest, theta: orig.path.accessTheta, crowd: 1 } : { ivtScale, wait, walk, xfer, dest, theta, crowd };
    drawsOut.push(d);
    for (const p of PURPOSES) for (const key of Object.keys(orig.ivt[p]) as (keyof (typeof COEFFS)[typeof p])[]) COEFFS[p][key] = orig.ivt[p][key] * d.ivtScale;
    // walkThresh is minutes, not a coefficient
    for (const p of PURPOSES) (COEFFS[p].walkThresh = orig.ivt[p].walkThresh);
    for (const [p, c] of Object.entries(orig.tour)) for (const key of Object.keys(c) as (keyof typeof c)[]) TOUR_COEFFS[p as typeof PURPOSES[number]]![key] = key === 'walkThresh' ? c[key] : c[key] * d.ivtScale;
    PATH.waitWeight = d.wait;
    PATH.walkWeight = d.walk;
    PATH.transferPenalty = d.xfer;
    PATH.accessTheta = d.theta;
    TUNE.destLogsum = d.dest;
    CROWDING.maxSeat = 1 + (orig.crowd.maxSeat - 1) * d.crowd;
    CROWDING.maxStand = orig.crowd.minStand + (orig.crowd.maxStand - orig.crowd.minStand) * d.crowd;
    // each draw: an unchanged run and the scenarios, three passes each from today's crowding (as
    // portal.ts runs the Portal, so the draws and its point estimate are alike)
    const run = (sc: Scenario) => runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 3, warmCrowd: base0.finalCrowd }, prep);
    const base = await run({ name: 'Today', edits: [] });
    for (const s of scenarios) {
      const r = await run(s.scenario);
      const o = results[s.id];
      o.transitTrips.push(r.summary.transitTrips - base.summary.transitTrips);
      o.routeBoardings.push(routeB(r, s.routes) - routeB(base, s.routes));
      o.benefitHours.push((r.summary.logsum - base.summary.logsum) / 60);
      o.caltrain.push((r.summary.boardings.caltrain ?? 0) - (base.summary.boardings.caltrain ?? 0));
    }
    console.log(`draw ${k + 1}/${draws}: ${scenarios.map((s) => `${s.id} Δtransit ${Math.round(results[s.id].transitTrips[k])}`).join(', ')}`);
  }
  const q = (xs: number[], p: number) => {
    const s = xs.slice().sort((a, b2) => a - b2);
    const i = (s.length - 1) * p;
    return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
  };
  const summary = Object.fromEntries(
    Object.entries(results).map(([id, o]) => [
      id,
      Object.fromEntries(Object.entries(o).map(([m, xs]) => [m, { calibrated: Math.round(xs[0]), p10: Math.round(q(xs, 0.1)), p50: Math.round(q(xs, 0.5)), p90: Math.round(q(xs, 0.9)) }])),
    ]),
  );
  const out = { draws, ranges: 'see server/beta3/pipeline/uncertainty.ts header', parameterDraws: drawsOut, summary };
  fs.writeFileSync(`${REFERENCE}/uncertainty.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`${BUNDLE}/uncertainty.json`, JSON.stringify(out));
  console.log(JSON.stringify(summary, null, 1));
}

main();
