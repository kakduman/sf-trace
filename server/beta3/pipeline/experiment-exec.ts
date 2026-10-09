import { LocalExecutor } from '../../../shared/beta3/model';
import type { TPeriod } from '../../../shared/beta3/types';

/** An in-process executor that keeps the last assignment's link volumes of each period (regional diagnostics). */
export class RecordingExecutor extends LocalExecutor {
  vols = {} as Record<TPeriod, Float64Array>;
  async assign(period: TPeriod, od: Float32Array, crowd: Float32Array[] | undefined, lot?: Float32Array): Promise<Float64Array> {
    const v = await super.assign(period, od, crowd, lot);
    this.vols[period] = v;
    return v;
  }
}
