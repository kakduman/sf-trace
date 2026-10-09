/** Diagnostic: which lines carry transit trips from a few outside zones to SF (AM). */
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare, SKIM_PERIODS } from '../../../shared/beta3/model';
import { loadBundle } from './run-base';

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const d = computeDemand(b, prepare(b), sk as never, calib);
  const NZ = H.zones.length, Z = NZ + 2 * H.ext.length; // transit zones (net.ts transitZones)
  const AM = sk.AM as { time: Float32Array };
  const ferryBldg = H.zones.findIndex((z) => Math.hypot(z.lat - 37.7955, z.lon + 122.3937) < 0.004);
  for (const re of [/^Alameda \(north\)/, /^Alameda \(south-east\)/, /^Larkspur$/, /^Vallejo$/, /^San Rafael \(south-east\)/]) {
    const e = H.ext.findIndex((x) => re.test(x.name));
    const o = NZ + e;
    let trips = 0;
    const od = new Float32Array(Z * Z);
    for (let q = 0; q < NZ; q++) { od[o * Z + q] = d.transitOD.AM[o * Z + q]; trips += od[o * Z + q]; }
    const vol = await exec.assign('AM', od, undefined);
    const net = exec.net('AM');
    const by = new Map<string, number>();
    for (let a = 0; a < net.nLinks; a++) if (vol[a] && net.type[a] === 4) { const l = net.lines[net.line[a]]; const k = `${l.feed}:${l.route}`; by.set(k, (by.get(k) ?? 0) + vol[a]); }
    console.log(`${H.ext[e].name}: AM transit trips to SF ${Math.round(trips)}; skim to Ferry Building zone ${AM.time[o * Z + ferryBldg]?.toFixed(0)} min; boardings ${[...by].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
  }
}
main();
