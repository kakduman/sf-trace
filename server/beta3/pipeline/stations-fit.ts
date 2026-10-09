/**
 * The street-to-platform time at the four Market Street BART stations, fitted to BART's counts.
 *
 * Riders choose among Embarcadero, Montgomery, Powell, and Civic Center block by block, by the walk
 * from each and the ride to it (PATH.blockAccess, PATH.egressLogit). The walks are measured on
 * OpenStreetMap's streets from the stations' mapped entrances; the time from the street to the
 * platform is assumed from the stations' depth (net.ts platformSec: 75 s at all four). What the
 * network cannot see (escalator and faregate queues, mezzanine walks, through-block passages, the
 * crowding of a platform) is a station's own, so it is fitted, as FTA's STOPS fits station-group
 * effects and regional models fit station-specific access penalties: each station's time moves
 * until its exits and entries (both, so the two legs of a round trip agree) match BART's average
 * weekday, with the four stations' mean held at the assumed 75 s, so only the split between them is
 * fitted and not how many ride BART.
 */
import { PATH } from '../../../shared/beta3/params';
import type { Calibration } from '../../../shared/beta3/types';

export const DOWNTOWN_BART = ['EMBR', 'MONT', 'POWL', 'CIVC'];
/**
 * Whether calibrate.ts fits the times. Off for now: fitted station times absorb whatever else
 * misplaces riders among the four stations (the transfer and egress choices among them are still
 * being settled), so the stations keep their assumed depths and the counts stay a test.
 */
export const FIT_STATION_TIMES = false;
/** seconds: the fitted change stays within this of the assumed time */
const BOUND = 60;

/**
 * One damped step: model / observed exits and entries by station code → calib.stationSec. Returns a
 * line for the log.
 */
export function fitStationTimes(calib: Calibration, obs: Record<string, { exits: number; entries: number }>, model: Record<string, { exits: number; entries: number }>, damping = 0.7): string {
  const cur = calib.stationSec ?? {};
  const step: Record<string, number> = {};
  for (const c of DOWNTOWN_BART) {
    const o = obs[c], m = model[c];
    if (!o || !m || !o.exits || !o.entries || !m.exits || !m.entries) return '';
    // geometric mean of the two ratios; a station with too many riders gets a longer time. The
    // logit weighs its minutes by θ and the walk weight (strategy.ts), so ln(ratio)/(θ·w) minutes
    // would move a rider who chose among stations by that alone; most riders have one station
    // within reach, so the step is damped and the fit iterated
    const r = Math.sqrt((m.exits / o.exits) * (m.entries / o.entries));
    step[c] = (cur[c] ?? 0) + (damping * 60 * Math.log(r)) / (PATH.accessTheta * PATH.walkWeight);
  }
  const mean = DOWNTOWN_BART.reduce((a, c) => a + step[c], 0) / DOWNTOWN_BART.length;
  calib.stationSec = Object.fromEntries(DOWNTOWN_BART.map((c) => [c, Math.round(Math.max(-BOUND, Math.min(BOUND, step[c] - mean)))]));
  return DOWNTOWN_BART.map((c) => `${c} ${(model[c].exits / 1000).toFixed(1)}/${(obs[c].exits / 1000).toFixed(1)} ${(model[c].entries / 1000).toFixed(1)}/${(obs[c].entries / 1000).toFixed(1)} → ${calib.stationSec![c] > 0 ? '+' : ''}${calib.stationSec![c]} s`).join(', ');
}
