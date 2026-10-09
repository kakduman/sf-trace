/** Run modes (inside the model section), from server/beta3/reference/runmodes.json (runmodes.ts). */
import { cap, cite, fx, int, nw, sec, section, tab, table } from '../doc';

interface Pair {
  precise: number;
  quick: number;
}
interface Row {
  name: string;
  seconds: { precise: { cpu: number; wall: number }; quick: { cpu: number; wall: number } };
  transitTrips: Pair & { errPct: number | null };
  muniBoardings: Pair & { errPct: number | null };
  sharesPP: Record<string, Pair>;
  routes: { n: number; r: number | null; largestMisses: { route: string; precise: number; quick: number }[] };
  roadResponse?: Record<'precise' | 'quick', string>;
  vktPct: Pair;
  mph: Pair;
  timeSavingsH: Record<'total' | 'drivers' | 'transit' | 'others', Pair> & { peninsula?: Pair };
  noChangeVsSavedBaseline?: Record<'precise' | 'quick', Record<string, number> | undefined>;
}
interface Err { scenarios: number; transitTripsPct: number; muniBoardingsPct: number; timeSavingsPct?: number }
export interface RunModes {
  browser?: { quick: Record<string, number>; precise: Record<string, number> };
  summary: Err & { streets?: Err };
  scenarios: Record<string, Row>;
}
export const RM = (Object.values(import.meta.glob('../../../../server/beta3/reference/runmodes.json', { eager: true, import: 'default' }))[0] ?? null) as RunModes | null;

const sg = (v: number, d = 0) => `${v >= 0 ? '+' : '−'}${d ? fx(Math.abs(v), d) : int(Math.abs(v))}`;
const pair = (p: Pair, d = 0, unit = '') => `${sg(p.precise, d)}${unit} / ${sg(p.quick, d)}${unit}`;

export function runModes(): string {
  const S = RM ? Object.entries(RM.scenarios).filter(([k]) => k !== 'today') : [];
  const today = RM?.scenarios.today;
  const noChangeExact = !!today?.noChangeVsSavedBaseline && (['precise', 'quick'] as const).every((m) => Object.values(today.noChangeVsSavedBaseline![m] ?? {}).every((v) => v === 0));
  const cpu = (m: 'precise' | 'quick') => S.map(([, r]) => r.seconds[m].cpu);
  const ratio = S.length ? S.reduce((a, [, r]) => a + r.seconds.quick.cpu / r.seconds.precise.cpu, 0) / S.length : NaN;
  const rs = S.map(([, r]) => r.routes.r).filter((x): x is number => x !== null);
  const sm = RM?.summary;
  // the scenario with the largest relative miss among those that change streets or prices
  const approx = S.filter(([, r]) => r.roadResponse?.quick === 'approximate');
  const worstApprox = approx.slice().sort((a, b) => Math.abs(b[1].transitTrips.errPct ?? 0) - Math.abs(a[1].transitTrips.errPct ?? 0))[0];
  const hasOthers = S.some(([, r]) => r.timeSavingsH.others.precise !== 0 || r.timeSavingsH.others.quick !== 0);
  const hasPen = S.some(([, r]) => r.timeSavingsH.peninsula);
  return section('runmodes', 'Run modes', `
<p>The application runs a scenario in one of two modes. <i>Quick</i>, the default, holds today's road speeds fixed: car, ride-hail, and mixed-traffic bus times stay those of today's converged assignment, and the Peninsula freeways keep today's speeds. This is the practice of FTA's simplified ridership forecasts for New Starts, which take one set of zone-to-zone highway times for each forecast year from the region's model, the same for the no-build and the build, and perform no highway assignment ${cite(['stopsGuide', 'pp. 1, 10, 80'])}. The exception is a scenario that edits streets or what driving costs (lanes, bus lanes, closures, a cordon or parking charge): Quick then gives the traffic an approximate response, two rounds of demand with traffic and the assignments warm-started from today's and solved to a relative gap of 10⁻³ (at most 20 iterations). Quick also makes one optimal-strategy search per destination, leaving out the second search the transfer logit needs (${sec('assignment')}). <i>Precise</i> is the full model with traffic feedback (${sec('roads')}), every scenario assignment solved to today's gap of 10⁻⁴. Each mode's scenario is compared with today's network run in the same mode, from a baseline saved for each mode and day, so the approximation never shows up as a change; a scenario that changes nothing gives no difference in either mode${noChangeExact ? ', which the test runs confirm to the last digit' : ''}. Both modes split travelers' time savings in the same way (${sec('scen-method')}).</p>
${
  RM && S.length && sm
    ? `<p>${cap(nw(S.length))} test scenarios were run in both modes (${tab('runmodes')}). Quick took ${fx(100 * ratio, 0)}% of Precise's processor time on average: ${int(Math.min(...cpu('quick')))} to ${int(Math.max(...cpu('quick')))} seconds in Node on one thread, against ${int(Math.min(...cpu('precise')))} to ${int(Math.max(...cpu('precise')))}. On the ${nw(sm.scenarios)} that leave the streets alone, Quick's change in transit trips came within ${sm.transitTripsPct}% of Precise's, its change in Muni boardings within ${sm.muniBoardingsPct}%${sm.timeSavingsPct !== undefined ? `, and its time savings within ${sm.timeSavingsPct}%, most of the difference being the drivers' gain from fewer cars, which Quick leaves out` : ''}.${sm.streets?.scenarios ? ` On the ${nw(sm.streets.scenarios)} that change streets or prices, where its road response is approximate, the errors were up to ${sm.streets.transitTripsPct}%, ${sm.streets.muniBoardingsPct}%, and ${sm.streets.timeSavingsPct ?? '–'}%${worstApprox ? `, the largest on ${/^The /.test(worstApprox[1].name) ? 'the' + worstApprox[1].name.slice(3) : `the ${worstApprox[1].name.charAt(0).toLowerCase() + worstApprox[1].name.slice(1)}`}, whose changes are small` : ''}.` : ''}${rs.length ? ` Route by route, the two modes' changes in boardings correlate at r = ${fx(Math.min(...rs), 2)} or better.` : ''}${browserLine(RM)} Quick is suited to exploring transit changes; a result that depends on traffic, or on the Peninsula freeways, needs Precise.</p>
${table(
  'runmodes',
  'Quick against Precise on the test scenarios, each against today’s network run in its own mode: changes per weekday, Precise / Quick.',
  ['', ...S.map(([, r]) => r.name)],
  [
    ['Transit trips', ...S.map(([, r]) => pair(r.transitTrips))],
    ['Muni boardings', ...S.map(([, r]) => pair(r.muniBoardings))],
    ['Transit share of trips (points)', ...S.map(([, r]) => pair(r.sharesPP.transit, 2))],
    ['Route changes, r', ...S.map(([, r]) => (r.routes.r === null ? '–' : fx(r.routes.r, 2)))],
    ['Largest route miss', ...S.map(([, r]) => (r.routes.largestMisses[0] ? `${r.routes.largestMisses[0].route}: ${sg(r.routes.largestMisses[0].precise)} / ${sg(r.routes.largestMisses[0].quick)}` : '–'))],
    ['Car km driven (%)', ...S.map(([, r]) => pair(r.vktPct, 2))],
    ['Street speed (mph)', ...S.map(([, r]) => pair(r.mph, 2))],
    ['Time savings, h', ...S.map(([, r]) => pair(r.timeSavingsH.total))],
    ['… transit riders', ...S.map(([, r]) => pair(r.timeSavingsH.transit))],
    ['… drivers and ride-hail', ...S.map(([, r]) => pair(r.timeSavingsH.drivers))],
    ...(hasPen ? [['… Peninsula freeways’ other drivers', ...S.map(([, r]) => (r.timeSavingsH.peninsula ? pair(r.timeSavingsH.peninsula) : '–'))]] : []),
    ...(hasOthers ? [['… others (changed conditions)', ...S.map(([, r]) => pair(r.timeSavingsH.others))]] : []),
    ['Processor time, s', ...S.map(([, r]) => `${int(r.seconds.precise.cpu)} / ${int(r.seconds.quick.cpu)}`)],
  ],
  { numeric: S.map((_, i) => i + 1), wide: true, notes: 'Processor time is Node on one thread.' },
)}`
    : ''
}
`);
}

/** browser run times, if measured (runmodes.ts combine reads them) */
function browserLine(rm: RunModes): string {
  const b = rm.browser;
  if (!b) return '';
  const approx = new Set(Object.entries(rm.scenarios).filter(([, r]) => r.roadResponse?.quick === 'approximate').map(([k]) => k));
  // the browser's keys are the pipeline's short names (bus19 for the 19th Avenue run)
  const streets = (k: string) => approx.has(k) || k === 'bus19' || k === 'cordon';
  const q = Object.entries(b.quick).filter(([k]) => !streets(k)).map(([, v]) => v),
    qs = Object.entries(b.quick).filter(([k]) => streets(k)).map(([, v]) => v),
    p = Object.values(b.precise);
  const rng = (a: number[]) => (a.length ? `${int(Math.min(...a))} to ${int(Math.max(...a))} seconds` : '');
  return ` In a browser with six workers, measured with other runs on the same computer and so on the slow side, Quick took ${rng(q)} for scenarios that leave the streets alone${qs.length ? ` and ${rng(qs)} for those that change them` : ''}, and Precise ${rng(p)}.`;
}
