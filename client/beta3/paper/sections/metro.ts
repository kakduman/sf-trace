import { REF } from '../data';
import { cite, fx, int, pc } from '../doc';

/**
 * Muni Metro's ride length against its benchmarks (the NTD's series and SFMTA's 2006–07 ride checks),
 * and hotel visitors among Muni's riders (reference/metro-results.json, from diag-metro.ts and
 * od-checks.ts runs; metro-results.ts).
 */
export function metroWork(): string {
  const M = REF.metroResults as unknown as MetroResults;
  const A = M.after;
  if (!A?.metro || !M.ntd) return '';
  const N = M.ntd, H = N.lightRailHistory?.byYear ?? {};
  const lr = (y: string) => H[y]?.lrTripMiles ?? NaN;
  const am = A.metro.model, bart = A.metro.bart;
  const trackOverStraight = A.tripMiles.metro / am.miPerBoardingStraight;
  const tepAll = M.tep2006MiPerBoarding;
  const hasHistory = Number.isFinite(lr('2007')) && Number.isFinite(lr('2016')) && Number.isFinite(lr('2019'));
  return `<p>Metro rides are longer than the NTD's light-rail average, but the benchmark is weak. The FY2024 figure has no L Taraval, which ran as a bus from April 2020 to August 2024${hasHistory ? `; with all lines running, the NTD gave ${fx(lr('2016'), 2)} to ${fx(lr('2019'), 2)} miles a boarding in FY2016–FY2019 ${cite('ntdTs21')}` : ''}. In SFMTA's 2006–07 ride checks, the last stop-by-stop counts of the Metro ${cite('tep')}, rides averaged ${fx(tepAll, 2)} miles in straight lines between stops, against the model's ${fx(am.miPerBoardingStraight, 2)}${hasHistory ? `, while the NTD's passenger miles for the same year give ${fx(lr('2007'), 2)} miles a boarding, ${pc(1 - lr('2007') / (tepAll * trackOverStraight), 0)} less than the ride checks' loads imply: the two sources disagree by about as much as the model and the NTD` : ''}. Short rides inside the Market Street subway are not lost to BART, which carries ${int(bart.downtown.model)} journeys a weekday among its four Market Street stations in the model against ${int(bart.downtown.observed)} counted ${cite('bartRidership')}. Nothing in the model was fitted to Metro ride length.</p>`;
}

/** hotel visitors' share of Muni's riders against the Snapshot's riders from outside the Bay Area */
export function hotelVisitors(): string {
  const M = REF.metroResults as unknown as MetroResults;
  const A = M.after;
  if (!A?.riders || !M.snapshot) return '';
  const o = M.snapshot.outsideBayArea;
  return `Hotel visitors, whose modes follow SF Planning's 2017 surveys at hotel doors ${cite('sfPlanningTia2019')}, make ${pc(A.riders.hotelVisitors, 1)} of Muni's boardings in the model; the Snapshot's riders living outside the Bay Area, ${pc(o.lightRail, 1)} on light rail and ${pc(o.bus, 1)} on buses, also include visitors staying with friends and cable car riders, whom the model carries as sightseeing rides.`;
}

interface MetroResults {
  ntd: { busMilesPerBoarding: number; metroMilesPerBoarding: number; lightRailHistory: { byYear: Record<string, { lrTripMiles: number }> } | null };
  snapshot: { outsideBayArea: { lightRail: number; bus: number } };
  tep2006MiPerBoarding: number;
  after: {
    tripMiles: { bus: number; metro: number };
    riders: { hotelVisitors: number } | null;
    metro: { model: { miPerBoardingStraight: number }; bart: Record<string, { model: number; observed: number }> } | null;
  };
}
