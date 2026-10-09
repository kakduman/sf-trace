/**
 * Switch the delivered bundle to the person-level choices, or back. The person-level version's whole
 * calibration (its mode constants and tour rate factor were refitted with it, and calibration.abm
 * holds the CDAP and tour-frequency constants and shadow prices) is kept in
 * server/beta3/reference/abm-calibration.json, written by `--save` from a bundle calibrated with
 * abm-calibrate.ts and calibrate.ts. `--on` puts it into client/beta3/model/sf.bin.gz (then rerun
 * baseline.ts); the delivered bundle is otherwise the aggregate model's.
 * `--basis stated|diary` sets the calibration's commuteBasis (how often commuters commute).
 * The bundle is client/beta3/model/sf.bin.gz or $BETA3_SF_BUNDLE.
 * Run: npx tsx server/beta3/pipeline/abm-apply.ts --save | --on | --basis stated|diary
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeBundle } from '../../../shared/beta3/bundle';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const FILE = `${REFERENCE}/abm-calibration.json`;
const b = loadBundle();
if (process.argv.includes('--save')) {
  if (!b.header.calibration?.abm?.on) throw new Error('the bundle is not calibrated with the person-level choices');
  fs.writeFileSync(FILE, JSON.stringify(b.header.calibration, null, 1));
  console.log(`saved ${FILE}`);
} else if (process.argv.includes('--on')) {
  b.header.calibration = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const { arrays: _a, ...header } = b.header;
  void _a;
  fs.writeFileSync(process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log('bundle now uses the person-level choices; rerun baseline.ts');
} else if (process.argv.includes('--basis')) {
  const v = process.argv[process.argv.indexOf('--basis') + 1] as 'stated' | 'diary';
  b.header.calibration = { ...b.header.calibration!, commuteBasis: v };
  const { arrays: _a, ...header } = b.header;
  void _a;
  fs.writeFileSync(process.env.BETA3_SF_BUNDLE ?? `${BUNDLE}/sf.bin.gz`, zlib.gzipSync(encodeBundle(header, b.a as never), { level: 9 }));
  console.log(`commuteBasis ${v}`);
} else console.log('--save, --on, or --basis');
