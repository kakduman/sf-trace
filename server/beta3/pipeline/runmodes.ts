/**
 * Quick against Precise (shared/beta3/runmode.ts): the run-mode test scenarios (runmodes-scenarios.ts)
 * run in each mode, each compared with today's network run the same way, then Quick's changes
 * compared with Precise's on the headline results.
 *
 *   npx tsx server/beta3/pipeline/runmodes.ts run --mode precise [--scenarios today,free,...]
 *   npx tsx server/beta3/pipeline/runmodes.ts run --mode quick
 *   npx tsx server/beta3/pipeline/runmodes.ts combine [--over tag,...]   (→ server/beta3/reference/runmodes.json)
 *
 * Experiments: --gap, --feedback, --max-iter, and --reskim 0|1 override the mode's traffic settings, --tag keeps
 * their runs apart (runmodes-<mode>-<tag>.json).
 *
 * A mode's runs go to $BETA3_WORK/runmodes-<mode>.json. Times are the process's CPU seconds (Node runs
 * the model on one thread; the machine may be busy) and wall-clock seconds. Each run is compared with
 * a run of today's network made in the same process and mode (the "control"); the control is also
 * compared with the saved baseline of its mode, which a scenario that changes nothing must reproduce.
 *
 * Travelers' time savings (the change in the choice logsum, in minutes of riding time) are taken
 * apart as the run takes them (RunSummary.logsumParts): transit riders', drivers', and others'.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel, type DemandOverride } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { localAon, roadNetFrom, type RoadHeader } from '../../../shared/beta3/roads';
import { baseFile, type RunMode } from '../../../shared/beta3/runmode';
import { MODES } from '../../../shared/beta3/params';
import { TPERIODS, type Bundle, type Calibration, type RunResult, type Scenario, type TPeriod } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE, WORK } from './paths';
import { loadBundle } from './run-base';
import { testScenarios } from './runmodes-scenarios';
import { timing } from './runmodes-timing';
import { computeDemand, type DemandOptions, type TrnSkims } from '../../../shared/beta3/demand';
import { demandContextOf } from '../../../shared/beta3/micromobility';
import { withRoadArrays } from '../../../shared/beta3/traffic';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const cpu = () => process.cpuUsage().user / 1e6;
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, v) => a + v, 0);

/** keeps the last skims of each period (those the run's last demand chose with), and times demand */
class SkimKeeper extends LocalExecutor {
  sk: Partial<Record<TPeriod, TrnSkim>> = {};
  constructor(
    private b: Bundle,
    private s: Scenario,
    private c: Calibration,
    private prep: ReturnType<typeof prepare>,
    private tm: ReturnType<typeof timing>,
  ) {
    super(b, s, c);
  }
  async skim(p: TPeriod, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<TrnSkim> {
    return (this.sk[p] = await super.skim(p, crowd, lot));
  }
  async demand(sk: TrnSkims, opts?: DemandOptions, arrays?: Record<string, Uint16Array | Float32Array>, over?: DemandOverride) {
    return this.tm.time('demand', () => computeDemand(arrays ? withRoadArrays(this.b, arrays) : this.b, this.prep, sk, this.c, this.s.day ?? 'wkd', over ? over.autoCostFactor : (this.s.autoCostFactor ?? 1), undefined, over ? over.context : demandContextOf(this.s), opts))();
  }
}
type TrnSkim = TrnSkims[TPeriod];

type Run = Awaited<ReturnType<typeof runModel>>;
interface Kept {
  r: Run;
  sk: Partial<Record<TPeriod, TrnSkim>>;
}

/** the headline figures of one run */
function figures(b: Bundle, r: Run) {
  const H = b.header;
  const muniRoutes: Record<string, number> = {};
  for (const l of r.lines) {
    if (l.line < 0) continue;
    const bl = H.lines[l.line];
    if (bl.feed !== 'muni') continue;
    muniRoutes[bl.route] = (muniRoutes[bl.route] ?? 0) + sum(l.boardings);
  }
  const trips = r.summary.trips as Record<string, number>;
  const all = sum(trips);
  const T = r.traffic;
  const vmt = T ? sum(T.summary.vmt) : NaN,
    vht = T ? sum(T.summary.vht) : NaN;
  // today's, as the run's own traffic has it (a Quick control holds today's speeds and has none)
  const vmtBase = T ? sum(T.base.vmt) : NaN,
    vhtBase = T ? sum(T.base.vht) : NaN;
  return {
    muniBoardings: r.summary.boardings.muni ?? 0,
    boardings: sum(r.summary.boardings),
    transitTrips: r.summary.transitTrips,
    shares: Object.fromEntries(MODES.map((m) => [m, (100 * (trips[m] ?? 0)) / all])),
    trips,
    logsumMin: r.summary.logsum,
    vkt: r.summary.vkt,
    vmt,
    mph: vmt / vht,
    vmtBase,
    mphBase: vmtBase / vhtBase,
    driveMin: r.summary.driveMin?.all ?? NaN,
    knownDrives: T?.trips.map((t) => ({ name: t.name, min: t.scenario })) ?? [],
    muniRoutes,
    roads: T ? { gaps: T.gaps, iterations: T.iterations, convergence: T.convergence, loadings: T.loadings } : null,
  };
}
type Fig = ReturnType<typeof figures>;

/**
 * travelers' time savings (hours a day) against the control, taken apart as the run takes them
 * (RunSummary.logsumParts): transit riders' (the transit network, fares, and shared bikes),
 * others' (the conditions), drivers' (streets, car prices, and traffic), and the Peninsula
 * freeways' background drivers'
 */
function savings(c: Kept, s: Kept) {
  const L = s.r.summary.logsum,
    P = s.r.summary.logsumParts ?? { networkOnly: L, noRoads: L },
    B = c.r.summary.logsum;
  // the Peninsula freeways' background drivers (zero in Quick, which holds the freeways' speeds)
  const pen = ((P as { peninsula?: number }).peninsula ?? 0) - ((c.r.summary.logsumParts as { peninsula?: number } | undefined)?.peninsula ?? 0);
  return { total: (L - B + pen) / 60, transit: (P.networkOnly - B) / 60, others: (P.noRoads - P.networkOnly) / 60, drivers: (L - P.noRoads) / 60, peninsula: pen / 60 };
}

/** a run's changes from the control */
function change(f: Fig, c: Fig) {
  const routes: Record<string, number> = {};
  for (const k of new Set([...Object.keys(f.muniRoutes), ...Object.keys(c.muniRoutes)])) routes[k] = (f.muniRoutes[k] ?? 0) - (c.muniRoutes[k] ?? 0);
  return {
    muniBoardings: f.muniBoardings - c.muniBoardings,
    boardings: f.boardings - c.boardings,
    transitTrips: f.transitTrips - c.transitTrips,
    shares: Object.fromEntries(Object.keys(f.shares).map((m) => [m, f.shares[m] - c.shares[m]])),
    vmt: f.vmt - c.vmt,
    vmtPct: (100 * (f.vmt - (Number.isFinite(c.vmt) ? c.vmt : f.vmtBase))) / (Number.isFinite(c.vmt) ? c.vmt : f.vmtBase),
    mph: f.mph - (Number.isFinite(c.mph) ? c.mph : f.mphBase),
    driveMin: f.driveMin - c.driveMin,
    knownDrives: f.knownDrives.map((t, i) => ({ name: t.name, min: t.min - (c.knownDrives[i]?.min ?? t.min) })),
    routes,
  };
}

/** largest differences between a run and a saved result (a scenario changing nothing must reproduce its baseline) */
function sameAs(r: Run, base: RunResult) {
  const d: Record<string, number> = {};
  d.transitTrips = Math.abs(r.summary.transitTrips - base.summary.transitTrips);
  d.logsumMin = Math.abs(r.summary.logsum - base.summary.logsum);
  d.boardings = Math.abs(sum(r.summary.boardings) - sum(base.summary.boardings));
  let line = 0;
  const byKey = new Map(base.lines.map((l) => [l.line, l]));
  for (const l of r.lines) {
    const b0 = byKey.get(l.line);
    if (b0) line = Math.max(line, Math.abs(sum(l.boardings) - sum(b0.boardings)));
  }
  d.lineBoardings = line;
  return d;
}

async function runMode(mode: RunMode) {
  const B = loadBundle();
  const calib = B.header.calibration as Calibration;
  const rb = decodeBundle(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/roads.bin.gz`)));
  const net = roadNetFrom(rb.header as unknown as RoadHeader, rb.a);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const savedFile = `${BUNDLE}/${baseFile('wkd', mode)}`;
  const saved = fs.existsSync(savedFile) ? decodeResult(zlib.gunzipSync(fs.readFileSync(savedFile))) : null;
  const prep = prepare(B);
  const tm = timing();
  const all = testScenarios(B);
  const which = arg('--scenarios', Object.keys(all).join(',')).split(',');
  if (which[0] !== 'today') which.unshift('today');
  // experiments: other traffic settings (--gap, --feedback), kept apart by --tag
  const topts = { ...(process.argv.includes('--gap') ? { gap: Number(arg('--gap', '1e-3')) } : {}), ...(process.argv.includes('--feedback') ? { feedback: Number(arg('--feedback', '5')) } : {}), ...(process.argv.includes('--max-iter') ? { maxIter: Number(arg('--max-iter', '100')) } : {}) };
  const tag = arg('--tag', '');
  const file = `${WORK}/runmodes-${mode}${tag ? `-${tag}` : ''}.json`;
  const out: Record<string, unknown> = { mode, bundle: B.header.built, traffic: topts, reskim: arg('--reskim', ''), runs: {} };
  let control: Kept | null = null,
    cf: Fig | null = null;
  for (const w of which) {
    const sc: Scenario = { ...all[w], runMode: mode };
    const ex = new SkimKeeper(B, sc, calib, prep, tm);
    tm.reset();
    const c0 = cpu(),
      w0 = Date.now();
    const r = await runModel(B, sc, calib, ex, { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice, traffic: { net, aon: tm.aon(localAon(net)), opts: topts }, ...(process.argv.includes('--reskim') ? { busReskim: arg('--reskim', '1') === '1' } : {}) }, prep);
    const secs = { cpu: +(cpu() - c0).toFixed(1), wall: +((Date.now() - w0) / 1000).toFixed(1) };
    const f = figures(B, r);
    const kept: Kept = { r, sk: { ...ex.sk } };
    const row: Record<string, unknown> = { name: sc.name, roadResponse: r.roadResponse, seconds: secs, stages: tm.get(), figures: { ...f, muniRoutes: undefined } };
    if (w === 'today') {
      control = kept;
      cf = f;
      if (saved) row.vsSavedBaseline = sameAs(r, saved);
    }
    row.change = change(f, cf!);
    row.savings = savings(control!, kept);
    (out.runs as Record<string, unknown>)[w] = row;
    const ch = row.change as ReturnType<typeof change>,
      sv = row.savings as ReturnType<typeof savings>;
    console.log(`${mode} ${w}: ${secs.cpu} s CPU (${secs.wall} s wall); transit trips ${ch.transitTrips.toFixed(0)}, Muni boardings ${ch.muniBoardings.toFixed(0)}, VMT ${ch.vmtPct.toFixed(3)}%, mph ${ch.mph.toFixed(3)}; time savings ${sv.total.toFixed(0)} h (drivers ${sv.drivers.toFixed(0)}, transit ${sv.transit.toFixed(0)}, others ${sv.others.toFixed(0)})${row.vsSavedBaseline ? `; vs the saved baseline ${JSON.stringify(row.vsSavedBaseline)}` : ''}`);
    console.log(Object.entries(row.stages as Record<string, { s: number; calls: number }>).map(([k, v]) => `   ${k.padEnd(48)} ${v.s.toFixed(1).padStart(7)} s (${v.calls})`).join('\n'));
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  }
}

/** Quick's changes against Precise's, scenario by scenario (the runs of both modes) */
function combine() {
  type Row = { name: string; roadResponse?: string; seconds: { cpu: number; wall: number }; figures: { vkt: number; knownDrives: { name: string; min: number }[] }; change: ReturnType<typeof change>; savings: ReturnType<typeof savings>; vsSavedBaseline?: Record<string, number> };
  // a mode's runs, with any later runs of some of its scenarios (--tag, e.g. after a change to them) laid over
  const read = (m: RunMode) => {
    const base = JSON.parse(fs.readFileSync(`${WORK}/runmodes-${m}.json`, 'utf8')) as { bundle: string; runs: Record<string, Row> };
    for (const t of arg('--over', '').split(',').filter(Boolean)) {
      const f = `${WORK}/runmodes-${m}-${t}.json`;
      if (!fs.existsSync(f)) continue;
      const o = JSON.parse(fs.readFileSync(f, 'utf8')) as { runs: Record<string, Row> };
      for (const [k, v] of Object.entries(o.runs)) if (k !== 'today') base.runs[k] = v;
    }
    return base;
  };
  const P = read('precise'),
    Q = read('quick');
  const rows: Record<string, unknown> = {};
  // Quick's error where it holds today's road speeds, and where it gives the streets an approximate response
  const errs = { fixed: { transit: [] as number[], muni: [] as number[], savings: [] as number[] }, approximate: { transit: [] as number[], muni: [] as number[], savings: [] as number[] } };
  for (const [w, p] of Object.entries(P.runs)) {
    const q = Q.runs[w];
    if (!q) continue;
    const pc = p.change,
      qc = q.change;
    const keys = Object.keys(pc.routes).filter((k) => Math.abs(pc.routes[k]) > 0 || Math.abs(qc.routes[k] ?? 0) > 0);
    const xs = keys.map((k) => pc.routes[k]),
      ys = keys.map((k) => qc.routes[k] ?? 0);
    const n = xs.length,
      mx = xs.reduce((a, v) => a + v, 0) / (n || 1),
      my = ys.reduce((a, v) => a + v, 0) / (n || 1);
    let sxy = 0,
      sxx = 0,
      syy = 0;
    for (let i = 0; i < n; i++) ((sxy += (xs[i] - mx) * (ys[i] - my)), (sxx += (xs[i] - mx) ** 2), (syy += (ys[i] - my) ** 2));
    const misses = keys
      .map((k) => ({ route: k, precise: Math.round(pc.routes[k]), quick: Math.round(qc.routes[k] ?? 0) }))
      .sort((a, b) => Math.abs(b.quick - b.precise) - Math.abs(a.quick - a.precise))
      .slice(0, 3);
    const rel = (a: number, b: number) => (Math.abs(b) > 1e-9 ? +((100 * (a - b)) / Math.abs(b)).toFixed(1) : null);
    const relErr = errs[q.roadResponse === 'approximate' ? 'approximate' : 'fixed'];
    if (w !== 'today') {
      if (Math.abs(pc.transitTrips) > 100) relErr.transit.push(Math.abs((qc.transitTrips - pc.transitTrips) / pc.transitTrips));
      if (Math.abs(pc.muniBoardings) > 100) relErr.muni.push(Math.abs((qc.muniBoardings - pc.muniBoardings) / pc.muniBoardings));
      if (Math.abs(p.savings.total) > 100) relErr.savings.push(Math.abs((q.savings.total - p.savings.total) / p.savings.total));
    }
    rows[w] = {
      name: p.name,
      seconds: { precise: p.seconds, quick: q.seconds },
      transitTrips: { precise: Math.round(pc.transitTrips), quick: Math.round(qc.transitTrips), errPct: rel(qc.transitTrips, pc.transitTrips) },
      muniBoardings: { precise: Math.round(pc.muniBoardings), quick: Math.round(qc.muniBoardings), errPct: rel(qc.muniBoardings, pc.muniBoardings) },
      sharesPP: Object.fromEntries(Object.keys(pc.shares).map((m) => [m, { precise: +pc.shares[m].toFixed(3), quick: +qc.shares[m].toFixed(3) }])),
      routes: { n, r: n > 2 && sxx > 0 && syy > 0 ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null, largestMisses: misses },
      roadResponse: { precise: p.roadResponse ?? null, quick: q.roadResponse ?? null },
      // vehicle miles on the streets (the assignment's; none where Quick holds today's speeds) and the model's own car km
      vmtPct: { precise: +pc.vmtPct.toFixed(3), quick: Number.isFinite(qc.vmtPct) ? +qc.vmtPct.toFixed(3) : null },
      vktPct: { precise: +((100 * (p.figures.vkt - P.runs.today.figures.vkt)) / P.runs.today.figures.vkt).toFixed(3), quick: +((100 * (q.figures.vkt - Q.runs.today.figures.vkt)) / Q.runs.today.figures.vkt).toFixed(3) },
      mph: { precise: +pc.mph.toFixed(3), quick: Number.isFinite(qc.mph) ? +qc.mph.toFixed(3) : 0 },
      driveMin: { precise: +pc.driveMin.toFixed(3), quick: +qc.driveMin.toFixed(3) },
      // (against today's fitted times, which both modes share: a Quick run holding today's speeds has none of its own)
      knownDrives: pc.knownDrives.map((t, i) => {
        const today = P.runs.today.figures.knownDrives[i]?.min ?? NaN,
          qd = q.figures.knownDrives[i]?.min;
        return { name: t.name, precise: +t.min.toFixed(2), quick: qd === undefined ? 0 : +(qd - today).toFixed(2) };
      }),
      timeSavingsH: Object.fromEntries((['total', 'drivers', 'transit', 'others'] as const).map((k) => [k, { precise: Math.round(p.savings[k]), quick: Math.round(q.savings[k]) }])),
      ...(p.vsSavedBaseline || q.vsSavedBaseline ? { noChangeVsSavedBaseline: { precise: p.vsSavedBaseline, quick: q.vsSavedBaseline } } : {}),
    };
  }
  const pct = (a: number[]) => (a.length ? Math.ceil(100 * Math.max(...a)) : 0);
  const group = (e: (typeof errs)['fixed']) => ({ scenarios: e.transit.length, transitTripsPct: pct(e.transit), muniBoardingsPct: pct(e.muni), timeSavingsPct: pct(e.savings) });
  // (the scenarios that leave the streets alone, the common case; `streets`: those Quick gives an approximate road response)
  const summary = { ...group(errs.fixed), streets: group(errs.approximate) };
  // browser times, measured in the page (window.__b3.engine.lastProfile), if recorded
  const bf = `${WORK}/runmodes-browser.json`;
  const browser = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : null;
  const res = { ...(browser ? { browser } : {}), note: 'Quick against Precise on the run-mode test scenarios (server/beta3/pipeline/runmodes.ts). Each mode is compared with today’s network run in the same mode. Seconds are Node CPU seconds on one thread (wall-clock in parentheses in the log); the browser splits the work over its workers.', bundle: P.bundle, summary, scenarios: rows };
  fs.writeFileSync(`${REFERENCE}/runmodes.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}

const cmd = process.argv[2];
if (cmd === 'run') void runMode(arg('--mode', 'precise') as RunMode);
else if (cmd === 'combine') combine();
else console.log('usage: runmodes.ts run --mode precise|quick [--scenarios a,b] | combine');
