/** Overview: today's network at a glance, and what the model is. */
import { MODE_LABEL, MODEL_NAME } from '../../../shared/beta3/params';
import { hbars, legend } from '../charts';
import { DAY_LABEL, DAY_NOUN, DAY_PHRASE, MODE_ORDER, OPERATORS, OPERATOR_LABEL } from '../derive';
import { compact, int, money, pct, signedPct } from '../format';
import { bindWeekendSwitch, info, section, SERVICE_HOURS_HELP, tile, type Ctx, onActs, weekendSwitch } from './common';
import { muniFit } from './validation';
import { baseOf, set, state } from '../state';
import { drivingToday } from './driving';

export function renderOverview(ctx: Ctx, el: HTMLElement): void {
  // today's network as the full model makes it
  const base = baseOf(state.day);
  const day = state.day;
  const per = DAY_NOUN[day];
  const S = base.summary;
  const H = ctx.m.bundle.header;
  const allTrips = MODE_ORDER.reduce((a, k) => a + S.trips[k], 0);
  const resTrips = MODE_ORDER.reduce((a, k) => a + S.residentTrips[k], 0);
  const boardTotal = Object.values(S.boardings).reduce((a, b) => a + b, 0);

  let h = `<div class="panel-head"><h2>San Francisco on ${DAY_PHRASE[day]}</h2>
    <p class="lede">${MODEL_NAME} models travel for San Francisco’s ${compact(H.zones.reduce((a, z) => a + z.pop, 0))} residents, ${compact(H.zones.reduce((a, z) => a + z.jobs, 0))} jobs, and visitors from around the Bay Area. Change the network and see how every trip shifts.</p>
    ${day === 'wkd' ? '' : `<p class="note">${DAY_LABEL[day]} timetables and weekend travel patterns.</p>`}
    <div class="quick">
      <button class="btn" data-act="routes">Browse routes</button>
      <button class="btn" data-act="scenario">Build a scenario</button>
      <a class="btn ghost" href="method/#validation">Compare with counts</a>
    </div></div>`;

  h += `<div class="tiles">${tile(
    `Trips per ${per}`,
    compact(allTrips),
    `${compact(resTrips)} by residents`,
    '',
    'One person going from one place to another by any mode, starting or ending in San Francisco. A trip with a transfer is still one trip.',
  )}${tile(
    'Transit trips',
    compact(S.transitTrips),
    `${pct(S.trips.transit / allTrips)} of all trips`,
    '',
    'Trips made by transit, counted once door to door however many vehicles they use.',
  )}${tile(
    'Boardings',
    compact(boardTotal),
    `${(boardTotal / S.transitTrips).toFixed(2)} per transit trip`,
    '',
    'Each time a rider gets on a bus, train, or boat. Ridership counts, and “riders” in this app, are boardings.',
  )}${tile('Average transit trip', `${Math.round(S.avgTransitMin)} min`, 'door to door')}</div>`;

  // trips by mode: residents (solid) + everyone else (wash). Visitors' trips are counted by purpose;
  // the rest are in-commuters': their commutes across the city line and, mostly on foot, their trips
  // around the city during the day. Walking and cycling exist only within the city.
  const BP = S.byPurpose ?? {};
  const visitorsOf = (k: (typeof MODE_ORDER)[number]) => ['visitor', 'airport', 'regional'].reduce((a, p) => a + (BP[p]?.[k] ?? 0), 0);
  const othTip = (k: (typeof MODE_ORDER)[number], oth: number) => {
    const vis = Math.min(oth, visitorsOf(k));
    const within = k === 'walk' || k === 'bike';
    return `<div class="tip-h">${MODE_LABEL[k]}, non-residents</div><div class="tip-row"><span>Visitors</span><b>${int(vis)}</b></div><div class="tip-row"><span>Commuters from outside the city</span><b>${int(oth - vis)}</b></div><div class="tip-sub">${within ? 'Trips around the city once they are here. Nobody walks or bikes across the city line in the model.' : 'Trips, not people. A commuter usually makes at least two.'}</div>`;
  };
  const rows = MODE_ORDER.map((k) => {
    const res = S.residentTrips[k], oth = Math.max(0, S.trips[k] - res);
    const color = `var(--m-${k})`;
    return {
      label: MODE_LABEL[k],
      segs: [
        { v: res, color, tip: `<div class="tip-h">${MODE_LABEL[k]}, residents</div><div class="tip-row"><span>Person trips</span><b>${int(res)}</b></div><div class="tip-row"><span>Share of residents’ trips</span><b>${pct(res / resTrips)}</b></div>` },
        { v: oth, color, wash: true, tip: othTip(k, oth) },
      ],
      end: `${compact(S.trips[k])} · ${pct(S.trips[k] / allTrips, 0)}`,
    };
  });
  h += section(
    `Trips by mode, per ${per}`,
    legend([
      { label: 'Residents', color: 'var(--ink-2)' },
      { label: 'Visitors and commuters from outside', color: 'var(--ink-2)', wash: true },
    ]) + hbars(rows, { labelW: 104 }),
    { note: `Trips that start or end in San Francisco.${S.shuttleTrips ? ` Not shown: ${compact(S.shuttleTrips)} trips on private commuter shuttles.` : ''}` },
  );

  // boardings by operator
  const opRows = OPERATORS.map((op) => ({ label: OPERATOR_LABEL[op], segs: [{ v: S.boardings[op] ?? 0, color: 'var(--c-transit)' }], tip: `<div class="tip-h">${OPERATOR_LABEL[op]}</div><div class="tip-row"><span>Boardings in the model</span><b>${int(S.boardings[op] ?? 0)}</b></div>` }));
  h += section(`Boardings by operator, per ${per}`, hbars(opRows, { labelW: 130 }), { note: 'BART, Caltrain, Golden Gate, and ferries: riders to, from, or within San Francisco only.' });

  // service
  h += section(
    'Service and cost',
    `<div class="tiles">${tile('Service hours', `${int(S.revenueHours)} h`, `per ${per}, all operators`, '', SERVICE_HOURS_HELP)}${tile(
      'Operating cost',
      money(S.opCost),
      `per ${per} · ${money(S.opCost / boardTotal, { cents: true })} per boarding`,
      '',
      'Service hours × each mode’s cost per hour. Excludes capital costs.',
    )}</div>`,
  );

  if (day === 'wkd') h += drivingToday(ctx, base);

  // reality check
  const fit = muniFit(ctx);
  h += section(
    'How close to the counts',
    `<div class="reality">
      <div><b>${fit.r2.toFixed(2)}</b><span>r² for ${DAY_LABEL[day].toLowerCase()} Muni boardings by route, modeled vs counted (${fit.n} routes) ${info('1 is a perfect match, 0 no relationship. Route counts were not used to fit the model.')}</span></div>
      <div><b>${signedPct(fit.model / fit.obs - 1, 0)}</b><span>Muni boardings on those routes vs SFMTA counts${day === 'wkd' ? '' : ' (fitted on weekends)'}</span></div>
      <div><b>${pct(fit.within25, 0)}</b><span>of routes within 25% of their count</span></div>
    </div><a class="link" href="method/#validation">Full validation in the methodology</a>`,
  );
  h += section('Weekends', weekendSwitch(state.weekends));
  el.innerHTML = h;
  bindWeekendSwitch(ctx, el);
  onActs(el, {
    routes: () => set({ tab: 'routes' }),
    scenario: () => set({ tab: 'scenario' }),
  });
}
