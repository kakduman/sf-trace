/**
 * Fit the Market Street BART stations' street-to-platform times (stations-fit.ts) without a full
 * calibration: a few warm-started runs of the model as it stands, each followed by one step of the
 * fit, then the times are written into the bundle's calibration. calibrate.ts refits them with
 * everything else.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/fit-stations.ts [steps=3]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import type { Scenario } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';
import { DOWNTOWN_BART, fitStationTimes } from './stations-fit';

async function main() {
  const steps = Number(process.argv[2] ?? 3);
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const sc: Scenario = { name: 'Today', edits: [] };
  const prep = prepare(b);
  const st = H.observed.bartStations.filter((s) => DOWNTOWN_BART.includes(s.code) && s.stop !== null);
  const obs = Object.fromEntries(st.map((s) => [s.code, { exits: s.exits, entries: s.entries }]));
  for (let i = 0; i < steps; i++) {
    const r = await runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 2, warmCrowd: base.finalCrowd }, prep);
    const model = Object.fromEntries(st.map((s) => [s.code, { exits: r.stopOff[s.stop!], entries: r.stopOn[s.stop!] }]));
    console.log(`step ${i + 1}: ${fitStationTimes(calib, obs, model)}`);
  }
  const { arrays: _a, ...header } = H;
  void _a;
  fs.writeFileSync(process.env.BETA3_BUNDLE_FILE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle({ ...header, calibration: calib }, b.a as never), { level: 9 }));
  console.log(`station times saved: ${JSON.stringify(calib.stationSec)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
