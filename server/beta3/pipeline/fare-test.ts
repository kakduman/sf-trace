/**
 * The fare sensitivity tests alone, made as validate.ts makes them (three passes warm-started from the
 * saved base run's crowding and lot prices, against an unchanged run made the same way): Muni's fare
 * ±10% (Muni boardings), and Clipper's discount between operators at the old system's rule against
 * today's (Muni boardings, and linked trips using Muni and another operator).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/fare-test.ts [--set operatorChange=6] [--json out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { PATH } from '../../../shared/beta3/params';
import { decodeResult } from '../../../shared/beta3/results';
import type { Scenario } from '../../../shared/beta3/types';
import { xferStats } from './diag-xfer';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

async function main() {
  for (const kv of arg('--set', '').split(',').filter(Boolean)) {
    const [key, v] = kv.split('=');
    if (!(key in PATH)) throw new Error(`unknown PATH setting ${key}`);
    (PATH as Record<string, unknown>)[key] = Number(v);
  }
  const b = loadBundle();
  const calib = b.header.calibration!;
  const prep = prepare(b);
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const run = (sc: Scenario) => runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 3, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice }, prep);
  const ref = await run({ name: 'Today', edits: [] });
  const up = await run({ name: 'fare+10', edits: [{ kind: 'fare', feed: 'muni', factor: 1.1 }] });
  const dn = await run({ name: 'fare-10', edits: [{ kind: 'fare', feed: 'muni', factor: 0.9 }] });
  const muni = (r: { summary: { boardings: Record<string, number> } }) => r.summary.boardings.muni;
  const e = Math.log(muni(up) / muni(dn)) / Math.log(1.1 / 0.9);
  const old = await run({ name: 'old discount', edits: [], context: { transferDiscount: 0.5, transferDiscountMuniOnly: true } });
  const xr = xferStats(b, ref.nets, ref.demand.transitOD), xo = xferStats(b, old.nets, old.demand.transitOD);
  const out = {
    set: arg('--set', ''),
    muniFareElasticity: e,
    range: [-0.85, -0.12],
    muni: { today: muni(ref), oldDiscount: muni(old), effectPts: 100 * Math.log(muni(ref) / muni(old)) },
    transitTrips: { today: ref.summary.transitTrips, oldDiscount: old.summary.transitTrips },
    crossOperator: {
      today: { muniBoardingsShare: xr.muniOnTripsWith.any / xr.muniBoardings, trips: xr.trips.both, fare: xr.trips.fareBoth, bartTrips: xr.trips.bart, bartMuni: xr.trips.bartMuni, bartSFAM: xr.bartSFAM },
      oldDiscount: { muniBoardingsShare: xo.muniOnTripsWith.any / xo.muniBoardings, trips: xo.trips.both, fare: xo.trips.fareBoth, bartTrips: xo.trips.bart, bartMuni: xo.trips.bartMuni, bartSFAM: xo.bartSFAM },
      // the linked trips using Muni and another operator against their mean fare (the composition of
      // the group changes with the fare, so this is indicative)
      elasticity: Math.log(xr.trips.both / xo.trips.both) / Math.log(xr.trips.fareBoth / xo.trips.fareBoth),
    },
  };
  console.log(JSON.stringify(out, null, 1));
  const json = arg('--json', '');
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 1));
}
main();
