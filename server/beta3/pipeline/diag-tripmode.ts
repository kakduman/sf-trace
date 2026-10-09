/**
 * Trip mode choice conditional on tour mode, at a glance: one demand pass with the bundle's
 * calibration, uncrowded skims, timing, residents' shares, and the trips of residents' tours by the
 * mode of the leg out (model against NHTS 2017, nhts-tripmode.json).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-tripmode.ts
 */
import fs from 'node:fs';
import { TRIP_MIX, computeDemand, prepare } from '../../../shared/beta3/demand';
import { LocalExecutor, SKIM_PERIODS } from '../../../shared/beta3/model';
import { MODES } from '../../../shared/beta3/params';
import { REFERENCE } from './paths';
import { loadBundle } from './run-base';

async function main() {
  TRIP_MIX.on = true;
  const b = loadBundle();
  const calib = b.header.calibration!;
  const prep = prepare(b);
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  // --skims file: keep the uncrowded skims there (computed the first time), for quick reruns
  const i = process.argv.indexOf('--skims'), file = i > 0 ? process.argv[i + 1] : '';
  const F = ['g', 'boards', 'fare', 'time'] as const;
  const sk: Record<string, Record<string, Float32Array>> = {};
  if (file && fs.existsSync(file)) {
    const buf = fs.readFileSync(file), n = prep.ZT * prep.ZT;
    let off = 0;
    for (const p of SKIM_PERIODS) {
      sk[p] = {};
      for (const f of F) (sk[p][f] = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + 4 * n))), (off += 4 * n);
    }
  } else {
    for (const p of SKIM_PERIODS) sk[p] = (await exec.skim(p, undefined)) as never;
    if (file) fs.writeFileSync(file, Buffer.concat(SKIM_PERIODS.flatMap((p) => F.map((f) => Buffer.from(sk[p][f].buffer, sk[p][f].byteOffset, sk[p][f].byteLength)))));
  }
  let t = performance.now();
  const d = computeDemand(b, prep, sk as never, calib);
  const s1 = (performance.now() - t) / 1000;
  t = performance.now();
  computeDemand(b, prep, sk as never, calib);
  console.log(`computeDemand: ${s1.toFixed(1)} s, again ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const pc = (r: Record<string, number>) => {
    const tot = Object.values(r).reduce((a, v) => a + v, 0);
    return MODES.map((m) => `${m} ${((100 * (r[m] ?? 0)) / tot).toFixed(1)}`).join(' ');
  };
  console.log(`residents' trips ${Math.round(Object.values(d.residentTrips).reduce((a, v) => a + v, 0))}: ${pc(d.residentTrips)}`);
  console.log(`all trips: ${pc(d.trips)}; ride-hail trips ${Math.round(d.trips.tnc)}, residents' ${Math.round(d.residentTrips.tnc)}; VKT ${Math.round(d.vkt)}`);
  const nh = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-tripmode.json`, 'utf8')).byTourMode;
  for (const a of MODES) {
    const o = nh[a]?.otherTrips ?? {};
    console.log(`out by ${a} (${Math.round(d.tripMixTours[a])} tours): other trips model ${pc(d.tripMix[a])} | NHTS ${MODES.map((m) => `${m} ${(100 * (o[m] ?? 0)).toFixed(1)}`).join(' ')}`);
  }
  for (const a of MODES) {
    const o = nh[a]?.otherTrips ?? {};
    console.log(`${a} tours (${Math.round(d.tripMixTourN[a])}): other trips model ${pc(d.tripMixTour[a])} | NHTS ${MODES.map((m) => `${m} ${(100 * (o[m] ?? 0)).toFixed(1)}`).join(' ')}`);
  }
  console.log('trip constants', JSON.stringify(calib.tripSwitch ?? {}));
  for (const M of MODES) console.log(`stop legs of ${M} tours: ${pc(d.stopLegModes[M])}`);
  const tod = Object.fromEntries((['AM', 'MD', 'PM', 'NT'] as const).map((p) => [p, d.transitOD[p].reduce((a, v) => a + v, 0)]));
  console.log('transit trips', Object.entries(tod).map(([p, v]) => `${p} ${Math.round(v)}`).join(' '));
}

main();
