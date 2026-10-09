import { REF } from '../data';
import { cite, fx, int, pc, spc } from '../doc';

/**
 * Commute trips: their volume against BART's downtown morning exits, and residents' transit trips to
 * work against SFMTA's Travel Decision Surveys (reference/commutes-results.json, from od-checks.ts and
 * diag-commutes.ts runs; commutes-results.ts; commute_checks.py for the surveys).
 */
export function commutesWork(): string {
  const C = REF.commutesResults as unknown as Results;
  const A = C.after, E = C.evidence;
  if (!A?.bartAmDowntown || !E?.acs?.oneYear2024) return '';
  const a1 = E.acs.oneYear2024;
  const tds19 = E.checks.tds['2019'], tds21 = E.checks.tds['2021'];
  const am = A.bartAmDowntown.model / A.bartAmDowntown.count - 1;
  return `<p>Commute trips. Commutes across the city line follow the ACS 2024 one-year tables, the year of every other commute target: ${int(a1.inCommuters)} in-commuters, and ${pc(a1.outShare, 1)} of residents' commutes leaving the city ${cite('acs2024Commute')}. Their volume is tested by BART's exits at its four downtown stations from 6 to 10am, which the model puts ${spc(am, 0)} from the count (${int(A.bartAmDowntown.model)} against ${int(A.bartAmDowntown.count)}) ${cite('bartRidership')} ${cite('bartHourly')}. The commutes' share of transit use is weaker. In SFMTA's Travel Decision Surveys, ${pc(tds19.workShareOfTransitTrips, 1)} of residents' transit trips in 2019 and ${pc(tds21.workShareOfTransitTrips, 1)} in 2021 went to work or home from it ${cite('sfmtaTds')}, against ${pc(A.residentWorkShareOfTransitTrips, 1)} in the model read the same way: in the 2021 survey work trips rode transit ${fx(tds21.workTransitShare / tds21.nonWorkTransitShare, 1)} times as often as other trips. The surveys are small (${int(tds19.transitTrips)} and ${int(tds21.transitTrips)} transit trips) and older than the model's year, and nothing was fitted to them.</p>`;
}

interface Results {
  evidence: {
    acs: { oneYear2024: { inCommuters: number; outShare: number } };
    checks: { tds: Record<string, { transitTrips: number; workTransitShare: number; nonWorkTransitShare: number; workShareOfTransitTrips: number }> };
  };
  after: { bartAmDowntown: { model: number; count: number }; residentWorkShareOfTransitTrips: number };
}
