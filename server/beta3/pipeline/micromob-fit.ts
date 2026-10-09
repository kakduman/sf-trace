/**
 * Refit only the shared vehicles' constants, distance and climbing terms, and station biases on full model runs, everything else in
 * the bundle's calibration held: each round runs the model (two passes, warm-started from the base run's
 * crowding, as experiment.ts does) and moves the constants by fitMicro with the run's own rides to and
 * from stations. calibrate.ts fits them alongside the rest; this settles them after it without moving
 * any other constant.
 *
 * Run: npx tsx server/beta3/pipeline/micromob-fit.ts [rounds=3]   (BETA3_SF_BUNDLE: the bundle to update)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import type { Scenario } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';
import { RecordingExecutor } from './experiment-exec';
import { fitMicro, fitMicroAccess, microAccess } from './micromob-diag';

async function main() {
  const rounds = Number(process.argv[2] ?? 3);
  const b = loadBundle();
  const calib = b.header.calibration!;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const sc: Scenario = { name: 'Today', edits: [] };
  const prep = prepare(b);
  for (let r = 0; r < rounds; r++) {
    const exec = new RecordingExecutor(b, sc, calib);
    const res = await runModel(b, sc, calib, exec, { iterations: 2, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice }, prep);
    const acc = microAccess(b, sc, res.nets, exec.vols);
    console.log(`round ${r + 1}: ${fitMicro(calib, res.demand.micro, acc, 1, { b, zoneWork: res.demand.zoneWork })}`);
    // and the biases on riding to and from stations, on the morning's trips
    console.log(`  ${await fitMicroAccess(b, sc, calib, new RecordingExecutor(b, sc, calib), res.demand.transitOD.AM, undefined, undefined, 4)}`);
  }
  const file = process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`;
  const { arrays: _a, ...header } = b.header;
  void _a;
  fs.writeFileSync(file, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log(`saved ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
