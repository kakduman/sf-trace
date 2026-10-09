/** Results: the scenario compared with today. */
import { MODE_LABEL, PURPOSE_HELP, PURPOSE_LABEL, type Purpose } from '../../../shared/beta3/params';
import type { RunResult } from '../../../shared/beta3/types';
import { divbars } from '../charts';
import { DAY_LABEL, DAY_NOUN, DAY_PHRASE, MODE_ORDER, OPERATORS, OPERATOR_LABEL, addedStopIndex, dayBoardings, extendStopIndices, lineIndex, newLines, routeStats, type DayType } from '../derive';
import { addGroupId, editGroups } from '../scenario';
import { compact, esc, int, money, pct, signedCompact, signedInt, signedMoney, signedPct } from '../format';
import { baseOf, resultBase, resultCurrent, resultOtherMode, set, state } from '../state';
import { CONDITIONS, cleanContext } from '../../../shared/beta3/context';
import { SERVICE_HOURS_HELP, badge, info, onActs, section, tblWrap, tile, type Ctx } from './common';
import { muniFit } from './validation';
import { drivingChange } from './driving';
import { RUNMODE_ERROR } from '../runmodeError';

const VOT = 20; // $ per hour, for valuing time savings
/** days of each type in a year (Sundays include the ~6 weekday holidays) */
const DAYS_PER_YEAR: Record<DayType, number> = { wkd: 255, sat: 52, sun: 58 };
const CO2_PER_KM = 0.25; // kg per vehicle-km (assumed fleet average)

export function renderResults(ctx: Ctx, el: HTMLElement): void {
  const res = state.result;
  const sc = state.resultScenario;
  if (!res || !sc) {
    el.innerHTML = `<div class="panel-head"><h2>Results</h2></div><div class="empty-state"><p>Run a scenario to see how it compares with today: riders, time saved, cost, and changes by route.</p><button class="btn primary" data-act="scenario">Build a scenario</button></div>`;
    onActs(el, { scenario: () => set({ tab: 'scenario' }) });
    return;
  }
  const rday: DayType = sc.day ?? 'wkd';
  const per = DAY_NOUN[rday];
  const NDAYS = DAYS_PER_YEAR[rday];
  // today's network made in the run's own mode, so the approximation is not counted as a change
  const base = resultBase();
  const B = base.summary, S = res.summary;
  const dTrips = S.transitTrips - B.transitTrips;
  const bBoard = Object.values(B.boardings).reduce((a, b) => a + b, 0);
  const sBoard = Object.values(S.boardings).reduce((a, b) => a + b, 0);
  // the Peninsula freeways' other drivers (their part of the time savings, against today's in the same mode)
  const dMin = S.logsum - B.logsum + peninsulaPart(res, base);
  const dHours = dMin / 60;
  const dVkt = S.vkt - B.vkt;
  const dCost = S.opCost - B.opCost;
  const dRevH = S.revenueHours - B.revenueHours;

  const nChanges = editGroups(ctx.m, sc).length;
  // conditions other than today's (shared/beta3/context.ts)
  const conds = cleanContext(sc.context);
  const condList = conds ? CONDITIONS.filter((c) => conds[c.key] !== undefined).map((c) => c.label.replace(/^(?!Muni|SFO|Clipper)./, (x) => x.toLowerCase())) : [];
  const what = [nChanges ? `${nChanges} network change${nChanges > 1 ? 's' : ''}.` : 'No network changes.', condList.length ? `Changed conditions: ${condList.join(', ')}.` : ''].filter(Boolean).join(' ');
  const quick = res.runMode === 'quick';
  let h = `<div class="panel-head"><h2>${esc(sc.name)}</h2><p class="lede">Compared with today on <b>${DAY_PHRASE[rday]}</b>. ${esc(what)}</p></div>`;
  const otherMode = !resultCurrent() && resultOtherMode();
  if (rday !== state.day)
    h += `<div class="banner">These results are for ${DAY_PHRASE[rday]}. The map and other tabs show ${DAY_PHRASE[state.day]}. <button class="link" data-act="showday">Show ${DAY_LABEL[rday]}</button> or <button class="link" data-act="scenario">run it for ${DAY_LABEL[state.day]}</button>.</div>`;
  else if (!resultCurrent() && !otherMode) h += `<div class="banner">The scenario has changed since this run. <button class="link" data-act="scenario">Run it again</button> to update.</div>`;
  if (quick && rday === state.day && (resultCurrent() || otherMode)) {
    const qn = quickNote(res);
    h += `<div class="banner mode-banner" title="${esc(qn.detail)}"><span><b>Quick run.</b> ${esc(qn.text)}</span>${state.run.status === 'running' ? '' : '<button class="btn sm" data-act="precise">Run precisely</button>'}</div>`;
  }

  h += `<div class="tiles">
    ${tile('Transit trips', signedInt(dTrips), `${signedPct(dTrips / B.transitTrips, 2)} · per ${per}`, dTrips >= 0 ? 'up' : 'down', 'Change in trips by transit, each counted once door to door.')}
    ${tile('Boardings', signedInt(sBoard - bBoard), `${signedPct((sBoard - bBoard) / bBoard, 2)} · all operators`, '', 'Change in the number of times riders get on a bus, train, or boat.')}
    ${tile('Time saved', `${signedCompact(dHours)} h`, `per ${per} · ${signedMoney(dHours * VOT)} at $${VOT}/h`, dHours >= 0 ? 'up' : 'down', 'Hours of riding time saved, summed over all travelers. Includes the value of trips people now make or reroute.')}
    ${tile('Operating cost', signedMoney(dCost), `per ${per} · ${signedInt(dRevH)} service hours`, '', SERVICE_HOURS_HELP)}
  </div>`;
  h += timeSavingsSplit(res, base, per);

  // value summary
  const annBen = dHours * VOT * NDAYS, annCost = dCost * NDAYS;
  const perRider = dTrips > 50 ? dCost / dTrips : NaN;
  h += section(
    'Benefits and costs',
    `<table class="tbl kv"><tbody>
      <tr><td>Time saved</td><td class="num">${signedInt(dMin)} min/day</td></tr>
      <tr><td>… valued at $${VOT}/h</td><td class="num">${signedMoney(dHours * VOT)}/day · <b>${signedMoney(annBen)}/yr</b></td></tr>
      <tr><td>Operating cost</td><td class="num">${signedMoney(dCost)}/day · <b>${signedMoney(annCost)}/yr</b></td></tr>
      <tr><td>Operating cost per new transit trip</td><td class="num">${dCost <= 0 ? '<span class="muted">none: costs fall</span>' : Number.isFinite(perRider) ? money(perRider, { cents: true }) : '<span class="muted">n/a (no new trips)</span>'}</td></tr>
      <tr><td>Vehicle-km driven</td><td class="num">${signedInt(dVkt)} km/day (${signedPct(dVkt / B.vkt, 2)})</td></tr>
      <tr><td>CO₂ from driving ${info(`Assumes ${CO2_PER_KM} kg per vehicle-km.`)}</td><td class="num">${signedCompact((dVkt * CO2_PER_KM) / 1000)} t/day · ${signedCompact((dVkt * CO2_PER_KM * NDAYS) / 1000)} t/yr</td></tr>
${S.carOwn && S.carOwn.carsBase > 0 && B.carOwn ? `      <tr><td>Cars owned by residents <span class="muted">(long run)</span></td><td class="num">${signedPct(S.carOwn.cars / S.carOwn.carsBase - 1, 2)}</td></tr>
      <tr><td>Households without a car <span class="muted">(long run)</span></td><td class="num">${signedInt(S.carOwn.hhBySeg[0] - B.carOwn.hhBySeg[0])} (${signedPct(S.carOwn.hhBySeg[0] / B.carOwn.hhBySeg[0] - 1, 2)})</td></tr>
` : ''}      <tr><td>Average transit trip</td><td class="num">${(S.avgTransitMin - B.avgTransitMin >= 0 ? '+' : '−') + Math.abs(S.avgTransitMin - B.avgTransitMin).toFixed(1)} min (${S.avgTransitMin.toFixed(1)} min)</td></tr>
    </tbody></table>`,
    { note: `Yearly figures count ${rday === 'wkd' ? 'weekdays' : `${DAY_LABEL[rday]}s`} only (${NDAYS} a year) and exclude capital costs.${conds && (conds.residents !== undefined || conds.employedResidents !== undefined || conds.jobs !== undefined || conds.visitors !== undefined || conds.airPassengers !== undefined || conds.regionalVisitors !== undefined || conds.wfh !== undefined || conds.commuteDays !== undefined || conds.attendanceCore !== undefined || conds.attendanceOther !== undefined) ? ' <b>The changed conditions change how many people travel, so time saved is not a benefit measure here.</b>' : ''}` },
  );

  // mode shift
  h += section(
    'Mode shift',
    divbars(
      MODE_ORDER.map((k) => ({ label: MODE_LABEL[k], v: S.trips[k] - B.trips[k], tip: `<div class="tip-h">${MODE_LABEL[k]}</div><div class="tip-row"><span>Today</span><b>${int(B.trips[k])}</b></div><div class="tip-row"><span>Scenario</span><b>${int(S.trips[k])}</b></div><div class="tip-row"><span>Change</span><b>${signedInt(S.trips[k] - B.trips[k])} (${signedPct((S.trips[k] - B.trips[k]) / B.trips[k], 2)})</b></div>` })),
      { labelW: 112 },
    ),
    { note: `Change in trips per ${per}. Modes need not net to zero, since people also change destinations.` },
  );

  // driving (weekdays: traffic is assigned in every run)
  h += drivingChange(res, base);

  // transit by purpose
  const purposes = Object.keys(B.byPurpose) as Purpose[];
  h += section(
    'New transit trips by purpose',
    divbars(
      purposes.map((p) => {
        const d = (S.byPurpose[p]?.transit ?? 0) - (B.byPurpose[p]?.transit ?? 0);
        return { label: PURPOSE_LABEL[p] ?? p, v: d, tip: `<div class="tip-h">${esc(PURPOSE_LABEL[p] ?? p)}</div>${PURPOSE_HELP[p] ? `<div class="tip-sub">${esc(PURPOSE_HELP[p])}</div>` : ''}<div class="tip-row"><span>Transit trips today</span><b>${int(B.byPurpose[p]?.transit ?? 0)}</b></div><div class="tip-row"><span>Change</span><b>${signedInt(d)}</b></div>` };
      }),
      { labelW: 150 },
    ),
    { note: 'Hover a bar to see what each purpose covers.' },
  );

  // boardings by operator
  const ops = [...OPERATORS, ...(S.boardings.new ? ['new'] : [])];
  h += section(
    `Boardings by operator, per ${per}`,
    tblWrap(`<table class="tbl sticky1"><thead><tr><th>Operator</th><th class="num">Today</th><th class="num">Scenario</th><th class="num">Change</th></tr></thead><tbody>${ops
      .map((op) => {
        const b = B.boardings[op] ?? 0, s = S.boardings[op] ?? 0;
        return `<tr><td>${OPERATOR_LABEL[op]}</td><td class="num">${int(b)}</td><td class="num">${int(s)}</td><td class="num">${signedInt(s - b)}${b > 0 ? ` <span class="muted">${signedPct((s - b) / b, 1)}</span>` : ''}</td></tr>`;
      })
      .join('')}</tbody></table>`),
  );

  // routes
  const bs = routeStats(ctx.m, base), ss = routeStats(ctx.m, res);
  const rows: { key?: string; label: string; color: string; name: string; b: number; s: number }[] = ctx.m.routes.map((r) => ({ key: r.key, label: r.badge, color: r.color, name: r.short, b: bs.get(r.index)?.day ?? 0, s: ss.get(r.index)?.day ?? 0 }));
  const { added } = lineIndex(res);
  newLines(sc).forEach((e, k) => rows.push({ label: 'New', color: e.color, name: e.name, b: 0, s: (added.get(k) ?? []).reduce((a, lr) => a + dayBoardings(lr), 0) }));
  const changed = rows.filter((x) => Math.abs(x.s - x.b) >= 50).sort((a, b) => Math.abs(b.s - b.b) - Math.abs(a.s - a.b));
  const top = changed.slice(0, 16);
  h += section(
    `Biggest changes by route, per ${per}`,
    top.length
      ? tblWrap(`<table class="tbl routes sticky1"><thead><tr><th>Route</th><th class="num">Today</th><th class="num">Scenario</th><th class="num">Change</th></tr></thead><tbody>${top
          .map(
            (x) =>
              `<tr${x.key ? ` class="click" tabindex="0" data-route="${esc(x.key)}"` : ''}><td><div class="rt">${badge(x.label, x.color)}<span class="rt-n">${esc(x.name)}</span></div></td><td class="num">${compact(x.b)}</td><td class="num">${compact(x.s)}</td><td class="num ${x.s >= x.b ? 'up' : 'down'}">${signedCompact(x.s - x.b)}${x.b > 0 ? ` <span class="muted">${signedPct((x.s - x.b) / x.b, 0)}</span>` : ''}</td></tr>`,
          )
          .join('')}</tbody></table>`) + `<p class="note">${changed.length} route${changed.length === 1 ? '' : 's'} change by 50 or more boardings.</p>`
      : `<p class="note">No route changes by 50 or more boardings.</p>`,
  );

  // stops added and removed
  const H = ctx.m.bundle.header;
  const stopRows: string[] = [];
  const seenAdd = new Set<string>(), seenRm = new Set<number>(), seenExt = new Set<string>();
  for (const e of sc.edits) {
    if (e.kind === 'extend') {
      const r = ctx.m.routes.find((x) => x.feed === e.feed && x.members.includes(e.route));
      extendStopIndices(ctx.m, sc, e).forEach((i, k) => {
        const st = e.stops[k];
        if ('stop' in st || seenExt.has(`${st.lat},${st.lon}`)) return;
        seenExt.add(`${st.lat},${st.lon}`);
        // every route extended to the same place has its own copy of the stop: add them up
        const idx: number[] = [];
        for (const x of sc.edits)
          if (x.kind === 'extend') extendStopIndices(ctx.m, sc, x).forEach((j, kk) => {
            const y = x.stops[kk];
            if (!('stop' in y) && y.lat === st.lat && y.lon === st.lon) idx.push(j);
          });
        const on = idx.reduce((a, j) => a + (res.stopOn[j] ?? 0), 0), off = idx.reduce((a, j) => a + (res.stopOff[j] ?? 0), 0);
        stopRows.push(`<tr><td><div class="rt">${r ? badge(r.badge, r.color) : ''}<span class="rt-n" title="${esc(st.name ?? 'New stop')}">${esc(st.name ?? 'New stop')}</span></div></td><td>Extension</td><td class="num muted">–</td><td class="num">${int(on)}</td><td class="num">${int(off)}</td></tr>`);
      });
      continue;
    }
    if (e.kind !== 'addStop' && e.kind !== 'removeStop') continue;
    const r = ctx.m.routes.find((x) => x.feed === e.feed && x.members.includes(e.route));
    const rb = r ? badge(r.badge, r.color) : '';
    if (e.kind === 'addStop') {
      // both directions of one new stop are one row
      const g = addGroupId(e);
      if (seenAdd.has(g)) continue;
      seenAdd.add(g);
      const idx = sc.edits.filter((x) => x.kind === 'addStop' && addGroupId(x) === g).map((x) => addedStopIndex(ctx.m, sc, (x as typeof e).id));
      const on = idx.reduce((a, i) => a + (res.stopOn[i] ?? 0), 0), off = idx.reduce((a, i) => a + (res.stopOff[i] ?? 0), 0);
      stopRows.push(`<tr><td><div class="rt">${rb}<span class="rt-n" title="${esc(e.name ?? 'New stop')}">${esc(e.name ?? 'New stop')}</span></div></td><td>Added</td><td class="num muted">–</td><td class="num">${int(on)}</td><td class="num">${int(off)}</td></tr>`);
    } else {
      if (seenRm.has(e.stop)) continue;
      seenRm.add(e.stop);
      stopRows.push(`<tr><td><div class="rt">${rb}<span class="rt-n">${esc(H.stops[e.stop]?.name ?? String(e.stop))}</span></div></td><td>Removed</td><td class="num">${int(base.stopOn[e.stop] ?? 0)}</td><td class="num">${int(res.stopOn[e.stop] ?? 0)}</td><td class="num">${int(res.stopOff[e.stop] ?? 0)}</td></tr>`);
    }
  }
  if (stopRows.length)
    h += section(
      `Stop changes, per ${per}`,
      tblWrap(`<table class="tbl routes fixed sticky1"><colgroup><col><col style="width:64px"><col style="width:68px"><col style="width:68px"><col style="width:72px"></colgroup><thead><tr><th>Stop</th><th>Change</th><th class="num">Boardings<small>today</small></th><th class="num">Boardings<small>scenario</small></th><th class="num">Alightings<small>scenario</small></th></tr></thead><tbody>${stopRows.join('')}</tbody></table>`),
      { note: 'All routes at the stop. A removed stop keeps riders from routes that still stop there.' },
    );

  // map shortcuts
  h += section(
    'On the map',
    `<div class="quick">
      <button class="btn sm${state.view === 'change' ? ' on' : ''}" data-act="vchange">Change in riders</button>
      <button class="btn sm${state.view === 'scenario' ? ' on' : ''}" data-act="vscen">Scenario network</button>
      <button class="btn sm${state.zoneLayer === 'dshare' ? ' on' : ''}" data-act="zshare">Change in transit share</button>
      <button class="btn sm${state.zoneLayer === 'daccess' ? ' on' : ''}" data-act="zaccess">Change in accessibility</button>
    </div>`,
  );

  h += section(
    'Keep in mind',
    `<ul class="plain">
      <li>Modeled Muni boardings are within 25% of the counts on ${pct(muniFit(ctx, rday).within25, 0)} of routes. A change of a few hundred riders is within the model’s error.</li>
      <li>Homes and jobs stay where they are, so long-term land-use effects are not included.</li>
      <li>Traffic is an average for each time of day, not a particular day’s queues.</li>
      <li>New lines use typical speeds and capacities for their type.</li>
    </ul><a class="link" href="method/">How this works</a>`,
  );
  el.innerHTML = h;
  onActs(el, {
    scenario: () => set({ tab: 'scenario' }),
    precise: () => ctx.run('precise'),
    showday: () => ctx.setDay(rday),
    // the map shows a result only on its own day
    vchange: () => (ctx.setDay(rday), set({ view: 'change' })),
    vscen: () => (ctx.setDay(rday), set({ view: 'scenario' })),
    zshare: () => (ctx.setDay(rday), set({ zoneLayer: state.zoneLayer === 'dshare' ? 'none' : 'dshare' })),
    zaccess: () => (ctx.setDay(rday), set({ zoneLayer: state.zoneLayer === 'daccess' ? 'none' : 'daccess' })),
  });
  el.querySelectorAll<HTMLElement>('tr[data-route]').forEach((tr) => {
    tr.onclick = () => ctx.selectRoute(tr.dataset.route!, true);
    tr.onkeydown = (e) => e.key === 'Enter' && ctx.selectRoute(tr.dataset.route!, true);
  });
}

/**
 * The Quick-run banner: how close Quick came to Precise on the test scenarios (runmodes.ts), in one
 * line, with what Quick leaves out in the tooltip
 */
function quickNote(res: RunResult): { text: string; detail: string } {
  const streets = res.roadResponse === 'approximate';
  const e = streets ? RUNMODE_ERROR?.streets : RUNMODE_ERROR;
  const pct = e ? Math.max(e.transitTripsPct ?? 0, e.timeSavingsPct ?? 0) : undefined;
  const close = pct ? `Results are typically within ${pct}% of a precise run.` : 'Results are close to a precise run’s.';
  const text = `${streets ? 'Traffic is approximated. ' : ''}${close} To finalize results, run this scenario precisely.`;
  const detail = streets
    ? 'A quick run estimates traffic roughly and simplifies where riders change lines.'
    : 'A quick run keeps today’s traffic speeds and simplifies where riders change lines.';
  return { text, detail };
}

/** the Peninsula freeways' background drivers' minutes (RunSummary.logsumParts.peninsula), against today's network run the same way */
function peninsulaPart(res: RunResult, base: RunResult): number {
  return (res.summary.logsumParts?.peninsula ?? 0) - (base.summary.logsumParts?.peninsula ?? 0);
}

/**
 * Travelers' time savings by who gains them (RunSummary.logsumParts): transit riders (the transit
 * network, fares, and shared bikes), drivers and ride-hail (streets, car prices, and traffic), the
 * Peninsula freeways' other drivers (their traffic with no end in the city), and others (the
 * conditions), with the net
 */
function timeSavingsSplit(res: RunResult, base: RunResult, per: string): string {
  const baseLogsum = base.summary.logsum;
  const L = res.summary.logsum,
    P = res.summary.logsumParts ?? { networkOnly: L, noRoads: L };
  const pen = peninsulaPart(res, base);
  const hrs = (m: number) => `${signedCompact(m / 60)} h`;
  const rows: [string, number][] = [
    ['Transit riders', P.networkOnly - baseLogsum],
    ['Drivers and ride-hail', L - P.noRoads],
    ...(res.roadResponse === 'full' ? ([['Through traffic on Peninsula freeways', pen]] as [string, number][]) : []),
    ...(Math.abs(P.noRoads - P.networkOnly) > 0.5 ? ([['Changed conditions', P.noRoads - P.networkOnly]] as [string, number][]) : []),
  ];
  const roads =
    res.roadResponse === 'fixed'
      ? ' This Quick run keeps today’s road speeds.'
      : res.roadResponse === 'approximate'
        ? ' This Quick run approximates traffic.'
        : '';
  return section(
    'Time savings by traveler',
    `<table class="tbl kv"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${hrs(v)} per ${per}</td></tr>`).join('')}<tr><td><b>All travelers</b></td><td class="num"><b>${hrs(L - baseLogsum + pen)}</b></td></tr></tbody></table>`,
    { note: `Drivers lose time where cars lose a lane or pay a charge, and gain it where fewer cars are on the road.${roads}` },
  );
}
