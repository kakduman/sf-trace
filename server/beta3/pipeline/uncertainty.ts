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
 * In parallel: `uncertainty.ts 12 --only 4-7 --part work/unc-b.json` runs draws 4 to 7 (0-based; the
 * parameters are the serial run's, the generator stepped past the draws skipped), writing each draw to
 * the part file as it finishes; `uncertainty.ts combine 12 <part files>` writes the summary.
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

type Metrics = Record<string, { transitTrips: number; routeBoardings: number; benefitHours: number; caltrain: number }>;
interface Part { k: number; params: Record<string, number>; metrics: Metrics }

/** the summary over all draws (k = 0 the model as calibrated), written beside the bundle and in the references */
function writeSummary(draws: number, parts: Part[]) {
  parts.sort((a, b) => a.k - b.k);
  if (parts.length !== draws || parts.some((p, i) => p.k !== i)) throw new Error(`draws ${parts.map((p) => p.k).join(',')} do not cover 0..${draws - 1}`);
  const results: Record<string, Record<string, number[]>> = {};
  for (const p of parts)
    for (const [id, m] of Object.entries(p.metrics)) for (const [k, v] of Object.entries(m)) ((results[id] ??= {})[k] ??= []).push(v);
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
  const out = { draws, ranges: 'see server/beta3/pipeline/uncertainty.ts header', parameterDraws: parts.map((p) => p.params), summary };
  fs.writeFileSync(`${REFERENCE}/uncertainty.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`${BUNDLE}/uncertainty.json`, JSON.stringify(out));
  console.log(JSON.stringify(summary, null, 1));
}

async function main() {
  if (process.argv[2] === 'combine') {
    const parts = process.argv.slice(4).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as Part[]);
    return writeSummary(Number(process.argv[3]), parts);
  }
  const draws = Number(process.argv[2] ?? 12);
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const only = arg('--only')?.split('-').map(Number), partFile = arg('--part');
  const parts: Part[] = [];
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
  for (let k = 0; k < draws; k++) {
    // k = 0 is the model as calibrated
    const u = () => (k === 0 ? 0.5 : R());
    const ivtScale = 0.8 + 0.4 * u(), wait = 1.5 + u(), walk = 1.5 + u(), xfer = xfer0 * (0.5 + u()), dest = 0.5 + 0.5 * u(), theta = 0.15 + 0.35 * u(), crowd = 0.8 + 0.4 * u();
    const d = k === 0 ? { ivtScale: 1, wait: orig.path.waitWeight, walk: orig.path.walkWeight, xfer: xfer0, dest: orig.dest, theta: orig.path.accessTheta, crowd: 1 } : { ivtScale, wait, walk, xfer, dest, theta, crowd };
    // (the generator has stepped past this draw's parameters either way, so later draws are the serial run's)
    if (only && (k < only[0] || k > (only[1] ?? only[0]))) continue;
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
    const metrics: Metrics = {};
    for (const s of scenarios) {
      const r = await run(s.scenario);
      metrics[s.id] = {
        transitTrips: r.summary.transitTrips - base.summary.transitTrips,
        routeBoardings: routeB(r, s.routes) - routeB(base, s.routes),
        benefitHours: (r.summary.logsum - base.summary.logsum) / 60,
        caltrain: (r.summary.boardings.caltrain ?? 0) - (base.summary.boardings.caltrain ?? 0),
      };
    }
    parts.push({ k, params: d, metrics });
    // each draw kept as it finishes, so a stopped run loses only the draw under way
    if (partFile) fs.writeFileSync(partFile, JSON.stringify(parts));
    console.log(`draw ${k + 1}/${draws}: ${scenarios.map((s) => `${s.id} Δtransit ${Math.round(metrics[s.id].transitTrips)}`).join(', ')}`);
  }
  if (!only) writeSummary(draws, parts);
}

main();
