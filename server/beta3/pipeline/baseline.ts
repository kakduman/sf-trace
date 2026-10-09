/**
 * Step 9: run today's network with the calibrated model and save the results the page shows
 * first (client/beta3/model/base.bin.gz), plus the validation report. Each day also gets a
 * baseline made in the Quick run mode (base-quick.bin.gz, base-sat-quick.bin.gz...), from the same
 * settled crowding, so a Quick scenario is compared with a Quick run of today (runmode.ts).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/baseline.ts [--days wkd,sat,sun]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { aoAccess } from '../../../shared/beta3/autoown';
import { encodeBundle } from '../../../shared/beta3/bundle';
import type { TrnSkim, TrnSkims } from '../../../shared/beta3/demand';
import type { TPeriod } from '../../../shared/beta3/types';
import { encodeResult } from '../../../shared/beta3/results';
import { bundleId } from '../../../shared/beta3/bundle';
import type { DayType, Scenario } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';
import { capacitySummary, loadBundle, validation } from './run-base';
import { baseFile } from '../../../shared/beta3/runmode';

const SETTLE_PASSES = 4;

/** keeps the skims of the run (one pass: the skims a scenario's first pass starts from) */
class SkimKeeper extends LocalExecutor {
  sk = {} as TrnSkims;
  async skim(p: TPeriod, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<TrnSkim> {
    return (this.sk[p] = await super.skim(p, crowd, lot));
  }
}

async function main() {
  const b = loadBundle();
  const calib = b.header.calibration;
  if (!calib) throw new Error('calibrate first');
  const prep = prepare(b);
  const onProgress = (s: string) => process.stdout.write(`\r${s.padEnd(60)}`);
  const di = process.argv.indexOf('--days');
  const days = (di > 0 ? process.argv[di + 1].split(',') : ['wkd', 'sat', 'sun']) as DayType[];
  for (const day of days) {
    const scenario: Scenario = { name: 'Today', edits: [], day };
    // settle crowding and capacity at boarding with four passes (riders left behind at full stops
    // take longer to settle than crowding alone, which two passes did), then save a run made exactly
    // as scenarios are made (one pass from that state), so a scenario with no changes reproduces the
    // baseline
    const settle = await runModel(b, scenario, calib, new LocalExecutor(b, scenario, calib), { iterations: SETTLE_PASSES, onProgress }, prep);
    console.log(`\n${day}: settled in ${SETTLE_PASSES} passes; change in boardings by pass ${settle.convergence.map((c) => (100 * c).toFixed(2) + '%').join(', ')}; riders left behind ${Object.entries(settle.capacity.leftBehind).map(([p, v]) => `${p} ${Math.round(v)}`).join(', ')}`);
    const ex = new SkimKeeper(b, scenario, calib);
    const r = await runModel(b, scenario, calib, ex, { iterations: 1, onProgress, warmCrowd: settle.finalCrowd, warmLot: settle.finalLotPrice }, prep);
    // car ownership pivots on the accessibility of exactly this run (a long-run scenario with no
    // changes then reproduces it); kept with the calibration, so the bundle is written again
    if (day === 'wkd' && calib.autoOwn && b.a.aoClass) {
      const a = aoAccess(b, ex.sk);
      const r4 = (x: Float32Array) => Array.from(x, (v) => +v.toFixed(4));
      calib.autoOwn.base = { auto: r4(a.auto), transit: r4(a.transit), walk: r4(a.walk), savings: r4(a.savings) };
      b.header.calibration = calib;
      const { arrays: _a, ...header } = b.header;
      void _a;
      fs.writeFileSync(process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
      console.log('\ncar ownership: base accessibility updated in the bundle');
    }
    r.finalCrowd = settle.finalCrowd;
    r.finalLotPrice = settle.finalLotPrice;
    r.bundleId = bundleId(b.header);
    console.log(`\n${day}: ran in ${(r.ms / 1000).toFixed(1)} s`);
    if (day === 'wkd') for (const l of validation(b, r)) console.log(l);
    // where capacity at boarding binds today (the article's Section 3.9 reads it)
    if (day === 'wkd') fs.writeFileSync(`${BUNDLE}/capacity.json`, JSON.stringify({ settleConvergence: settle.convergence, ...capacitySummary(b, r) }, null, 1));
    else console.log(`boardings: ${Object.entries(r.summary.boardings).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
    const { demand: _d, volumes: _v, nets: _n, ...result } = r;
    void _d, _v, _n;
    const bin = encodeResult(result);
    fs.writeFileSync(`${BUNDLE}/${baseFile(day, 'precise')}`, zlib.gzipSync(bin, { level: 9 }));
    console.log(`baseline ${day} ${(bin.length / 1e6).toFixed(2)} MB`);
    // the Quick baseline: one Quick pass from the same settled state (scenarios start from the
    // Precise baseline's crowding in both modes, so it is not saved again)
    const quick: Scenario = { ...scenario, runMode: 'quick' };
    const q = await runModel(b, quick, calib, new LocalExecutor(b, quick, calib), { iterations: 1, onProgress, warmCrowd: settle.finalCrowd, warmLot: settle.finalLotPrice }, prep);
    q.finalLotPrice = settle.finalLotPrice;
    q.bundleId = r.bundleId;
    const { demand: _qd, volumes: _qv, nets: _qn, finalCrowd: _qc, ...qres } = q;
    void _qd, _qv, _qn, _qc;
    const qbin = encodeResult(qres);
    fs.writeFileSync(`${BUNDLE}/${baseFile(day, 'quick')}`, zlib.gzipSync(qbin, { level: 9 }));
    const tb = (x: typeof r) => Object.values(x.summary.boardings).reduce((a, v) => a + v, 0);
    console.log(`\nquick baseline ${day}: ran in ${(q.ms / 1000).toFixed(1)} s; boardings ${Math.round(tb(q)).toLocaleString()} (precise ${Math.round(tb(r)).toLocaleString()}), transit trips ${Math.round(q.summary.transitTrips).toLocaleString()} (${Math.round(r.summary.transitTrips).toLocaleString()}); ${(qbin.length / 1e6).toFixed(2)} MB`);
  }
}

main();
