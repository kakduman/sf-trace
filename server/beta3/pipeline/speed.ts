/**
 * Where a Quick (or Precise) run's time goes in Node, in-process on one thread: a scenario run from
 * today's crowding (as the page runs it), per stage (runmodes-timing.ts).
 *
 *   npx tsx server/beta3/pipeline/speed.ts [--mode quick|precise] [--scenario free] [--ts | --no-search]
 *
 * --ts: the strategy search in TypeScript only (without the WebAssembly kernels); --no-search: only the
 * access split in WebAssembly, not the search's main loop. Stage times are this
 * process's CPU seconds (the machine may be busy); `wall` is wall-clock seconds.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel, type DemandOverride } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { computeDemand, type DemandOptions, type TrnSkims } from '../../../shared/beta3/demand';
import { demandContextOf } from '../../../shared/beta3/micromobility';
import { withRoadArrays } from '../../../shared/beta3/traffic';
import type { Bundle, Calibration, Scenario } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';
import { loadBundle } from './run-base';
import { testScenarios } from './runmodes-scenarios';
import { timing } from './runmodes-timing';
import { setBlocksWasm, setSearchWasm } from '../../../shared/beta3/strategy';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const mode = arg('--mode', 'quick') as 'quick' | 'precise';
if (process.argv.includes('--ts')) setBlocksWasm(false);
if (process.argv.includes('--no-search')) setSearchWasm(false);
// --musl: the search's exp is musl's (in WebAssembly), not Math.exp
if (process.argv.includes('--musl')) setSearchWasm(true, { muslExp: true });
const b = loadBundle();
const calib = b.header.calibration!;
const prep = prepare(b);
const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
const s0 = (testScenarios(b) as Record<string, Scenario>)[arg('--scenario', 'free')];
const scenario: Scenario = { ...s0, runMode: mode };
const tm = timing();
class Timed extends LocalExecutor {
  constructor(private bb: Bundle, private s: Scenario, private c: Calibration) {
    super(bb, s, c);
  }
  async demand(sk: TrnSkims, opts?: DemandOptions, arrays?: Record<string, Uint16Array | Float32Array>, over?: DemandOverride) {
    return tm.time('demand', () => computeDemand(arrays ? withRoadArrays(this.bb, arrays) : this.bb, prep, sk, this.c, this.s.day ?? 'wkd', over ? over.autoCostFactor : (this.s.autoCostFactor ?? 1), undefined, over ? over.context : demandContextOf(this.s), opts))();
  }
}
const t0 = Date.now();
const r = await runModel(b, scenario, calib, new Timed(b, scenario, calib), { iterations: 1, warmCrowd: base.finalCrowd, warmLot: base.finalLotPrice }, prep);
console.log(JSON.stringify({ mode, wasm: process.argv.includes('--ts') ? 'none' : process.argv.includes('--no-search') ? 'access split' : 'access split and search', cpu: +(process.cpuUsage().user / 1e6).toFixed(1), scenario: scenario.name, wall: (Date.now() - t0) / 1000, stages: tm.get(), transit: r.summary.transitTrips, muni: r.summary.boardings.muni }, null, 1));
if (process.env.SPEED_OUT) fs.writeFileSync(process.env.SPEED_OUT, JSON.stringify({ summary: r.summary, lines: r.lines.map((l) => ({ line: l.line, b: l.boardings })) }));
