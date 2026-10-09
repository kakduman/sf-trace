import { REF } from '../data';
import { cite, fx, int, pc, tab, table } from '../doc';

/**
 * Where the Mission Street routes fall short, by the district of the boarding stop, and the causes
 * checked (reference/muniarea-results.json, from od-checks.ts and diag-routes.ts runs;
 * muniarea-results.ts).
 */
export function muniAreaWork(): string {
  const M = REF.muniareaResults as unknown as Results;
  const A = M.after;
  const ms = A?.routeGroups?.find((g) => g.group.startsWith('Mission St'));
  if (!ms) return '';
  const d = (k: string) => ms.byStopDistrict.find((x) => x.district === k);
  const mi = d('Mission'), ex = d('Excelsior–Visitacion Valley'), dt = d('Downtown');
  if (!mi?.tep2006Scaled || !ex?.tep2006Scaled || !dt?.tep2006Scaled) return '';
  const P = M.evidence.population;
  const rel = (n: string) => P?.byNeighborhood[n]?.relative ?? NaN;
  return `Sorted by the district of the boarding stop and set against SFMTA's 2006–07 stop counts scaled to today's total of the three routes ${cite('tep')}, the Mission Street routes (14, 14R, and 49) match the counts downtown (${int(dt.model)} boardings against ${int(dt.tep2006Scaled)}) and fall short near home, in the Mission (${int(mi.model)} against ${int(mi.tep2006Scaled)}) and in the Excelsior and Visitacion Valley (${int(ex.model)} against ${int(ex.tep2006Scaled)}). The 2006–07 shape predates the 14R, so it may overstate today's riders there. The shortfall is not explained by the population${P ? ` (relative to the city, the ACS has ${fx(rel('Mission'), 2)} times the 2020 Census's ratio of people in the Mission and ${fx(rel('Excelsior'), 2)} in the Excelsior ${cite('census2020')})` : ''}, by BATS's trip rates, which show no trend by income ${cite('bats2023t22')}, by residents' transit share by area, which matches SFMTA's Travel Decision Surveys ${cite('sfmtaTds')}, or by fare programs (free Muni for youth and seniors is in the fares, and Lifeline passes are too few to move a route ${cite('sfmtaFareEquity')}).`;
}

/**
 * Survey underreporting by segment, tested and not adopted: every factor is 1
 * (reference/underreport-results.json, underreport-results.ts; research/underreporting.md).
 */
export function underreportWork(): string {
  const U = REF.underreportResults as unknown as { runs: UrRun[]; households: { city: Shares; byDistrict: Record<string, Shares> } };
  const H = U.households;
  const run = (k: string) => U.runs?.find((r) => r.test === k);
  const base = run('base'), inc = run('inc125'), lep = run('lep2'), all = run('strong');
  if (!base || !inc || !lep || !all || !H?.byDistrict.Mission) return '';
  const kk = (n: number) => `${fx(n / 1000, 1)}k`;
  const rows = [base, inc, lep, all].map((r) => [
    { base: 'As calibrated', inc125: 'Under $100,000 ×1.25', lep2: 'Limited-English ×2', strong: 'All at once' }[r.test] ?? r.test,
    fx(r.muniRoutes.pctRmseScaled, 1),
    fx(r.muniRoutes.r, 3),
    ...['T', '14', '14R', '49', '8'].map((x) => kk(r.routesScaled[x].model)),
    fx(r.bartCityExits.r, 3),
  ]);
  rows.push(['Counted', '–', '–', ...['T', '14', '14R', '49', '8'].map((x) => kk(base.routesScaled[x].observed)), '–']);
  const worse = [inc, lep, all].every((r) => r.muniRoutes.pctRmseScaled >= base.muniRoutes.pctRmseScaled);
  return `<p>Survey underreporting. If BATS missed more of the trips of low-income or limited-English households, fitting the model to it would leave their neighborhoods short. No published factor by segment applies to BATS 2023, a mostly smartphone survey whose weights already correct missing trips by diary mode ${cite('bats2023', 'bricka2010')}, so the hypothesis was tested well past any published figure, by multiplying residents' shopping, errand, and social tours by income class, by car ownership, and by the share of a zone's limited-English households ${cite('acsC16002')} (${tab('underreport')}). ${worse ? 'Each test made the route pattern worse' : 'No test improved the route pattern materially'}: such households are spread across the city (${pc(H.byDistrict.Mission.limitedEnglish, 1)} of the Mission's households are limited-English, against ${pc(H.city.limitedEnglish, 1)} of the city's), so the added trips go everywhere. The model keeps BATS as it is, with every factor at 1.</p>
${table(
  'underreport',
  "Survey underreporting by segment, stress tests: Muni's counted routes scaled to their counted total, average weekday.",
  ['Test', '%RMSE', 'r', 'T', '14', '14R', '49', '8', 'BART exits r'],
  rows,
  { numeric: [1, 2, 3, 4, 5, 6, 7, 8], notes: `Two passes from the base run's crowding on the calibrated model; the routes are scaled to their counted total, so only the pattern is compared. Under $100,000 ×1.25: residents' shopping, errand, and social tours in households under $100,000. Limited-English ×2: those tours in limited-English households (ACS C16002). All at once: under $100,000 ×1.5, households without a car another ×1.3, and limited-English ×2. BART exits: the city stations.` },
)}`;
}

interface Shares {
  limitedEnglish: number;
  under100k: number;
}
interface UrRun {
  test: string;
  muniRoutes: { r: number; pctRmseScaled: number };
  routesScaled: Record<string, { model: number; observed: number }>;
  bartCityExits: { r: number };
}
interface Results {
  evidence: { population: { byNeighborhood: Record<string, { relative: number }> } | null };
  after: { routeGroups: { group: string; byStopDistrict: { district: string; model: number; tep2006Scaled: number | null }[] }[] | null } | null;
}
