/** Routes: a searchable, sortable table of every route, and a detail view with load profiles and edits. */
import type { TPeriod, TransitMode } from '../../../shared/beta3/types';
import { columns, legend, loadProfile, type ProfileSeries } from '../charts';
import { COST_PER_HOUR } from '../../../shared/beta3/params';
import { DAY_LABEL, DAY_NOUN, DAY_PHRASE, OPERATORS, OPERATOR_LABEL, PERIOD_SHORT, TPERIODS, TPERIOD_HOURS, baseTrips, hoursOf, routeStats, routeTitle, scenTrips, segBackground, segLoad, segService, type RouteInfo } from '../derive';
import { compact, dec1, esc, headway, int, money, pct, signedInt, signedPct } from '../format';
import { addGroupId, isTerminus, meters, routeEdits, withRouteEdit, withStopRemoved } from '../scenario';
import { set, shownResult, state } from '../state';
import { RUNS_HELP, SERVICE_HOURS_HELP, badge, info, onActs, section, tblWrap, tile, type Ctx } from './common';

export const MODE_NAME: Record<TransitMode, string> = {
  bus: 'Bus',
  trolley: 'Trolleybus',
  rapid: 'Rapid bus',
  express: 'Express bus',
  streetcar: 'Historic streetcar',
  lightrail: 'Light rail',
  cablecar: 'Cable car',
  bart: 'Regional metro',
  caltrain: 'Commuter rail',
  ferry: 'Ferry',
};

type SortKey = 'route' | 'model' | 'obs' | 'diff' | 'plf' | 'runs' | 'cpb';
const view = { q: '', op: 'all', sort: 'model' as SortKey, desc: true };

interface Row {
  r: RouteInfo;
  model: number;
  obs: number | null;
  diff: number | null;
  plf: number;
  runs: number;
  cpb: number;
}

function rows(ctx: Ctx): Row[] {
  const st = routeStats(ctx.m, state.base);
  const day = state.day;
  return ctx.m.routes.map((r) => {
    const s = st.get(r.index);
    const model = s?.day ?? 0;
    const obs = r.observedBy[day];
    return { r, model, obs, diff: obs ? model / obs - 1 : null, plf: s?.peakLoadFactor ?? 0, runs: r.runsDay[day], cpb: model >= 20 && r.feed === 'muni' ? (s?.opCost ?? 0) / model : Infinity };
  });
}

export function renderRoutes(ctx: Ctx, el: HTMLElement): void {
  const r = state.route ? ctx.m.routeByKey.get(state.route) : null;
  if (r) return renderDetail(ctx, el, r);
  const per = DAY_NOUN[state.day];
  el.innerHTML = `<div class="panel-head"><h2>Routes</h2><p class="lede">Every route on ${DAY_PHRASE[state.day]}. Click one to see where it’s busy or to change it.</p></div>
    <div class="filters">
      <input type="search" class="search" placeholder="Search routes (e.g. 38, N Judah, Yellow)" aria-label="Search routes" value="${esc(view.q)}">
      <div class="chips" role="radiogroup" aria-label="Operator">${['all', ...OPERATORS].map((o) => `<button class="chip" role="radio" aria-checked="${view.op === o}" data-op="${o}">${o === 'all' ? 'All' : OPERATOR_LABEL[o].replace(' Transit', '')}</button>`).join('')}</div>
    </div>
    ${tblWrap(
      `<table class="tbl routes fixed sticky1"><colgroup><col class="c-route"><col style="width:46px"><col style="width:52px"><col style="width:46px"><col style="width:40px"><col style="width:42px"><col style="width:50px"></colgroup><thead><tr>
      ${th('route', 'Route', '')}${th('model', 'Riders<small>/ day</small>', `Modeled boardings per ${per}, both directions.`)}${th('obs', 'Counted<small>SFMTA</small>', `Counted boardings per ${per}, Muni only. Source: SFMTA.`)}${th('diff', 'Diff.<small>vs count</small>', 'Model vs count. Highlighted when off by more than 25%.')}${th('plf', 'Peak<small>load</small>', 'Riders on board ÷ capacity on the busiest stretch in the busiest period. Over 100% is over capacity.')}${th('runs', 'Runs<small>/ day</small>', RUNS_HELP + ` Per ${per}.`)}${th('cpb', 'Cost<small>/ rider</small>', 'Operating cost per boarding, Muni only. Other operators’ costs cover their whole lines.')}
    </tr></thead><tbody></tbody></table>`,
      'routes-wrap',
    )}
    <p class="note">BART, Caltrain, Golden Gate, and ferries: riders to, from, or within San Francisco only.</p>`;
  const body = el.querySelector('tbody')!;
  const draw = () => {
    const q = view.q.trim().toLowerCase();
    let list = rows(ctx).filter((x) => (view.op === 'all' || x.r.feed === view.op) && (!q || `${x.r.label} ${x.r.name} ${routeTitle(x.r)}`.toLowerCase().includes(q)));
    const k = view.sort;
    const val = (x: Row): number | string | null => (k === 'route' ? x.r.feed + x.r.label.padStart(4, '0') : k === 'obs' ? x.obs : k === 'diff' ? (x.diff === null ? null : Math.abs(x.diff)) : k === 'cpb' ? (Number.isFinite(x.cpb) ? x.cpb : null) : x[k]);
    list = list.sort((a, b) => {
      const va = val(a), vb = val(b);
      // rows without a value go last in either direction
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
      const c = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
      return view.desc ? -c : c;
    });
    const dash = '<span class="muted">–</span>';
    body.innerHTML = list.length
      ? list
          .map(
            (x) => `<tr class="click" tabindex="0" data-route="${esc(x.r.key)}"><td><div class="rt">${badge(x.r.badge, x.r.color)}<span class="rt-n" title="${esc(routeTitle(x.r))}">${esc(x.r.short)}</span></div></td>
          <td class="num">${x.model >= 0.5 ? compact(x.model) : dash}</td><td class="num">${x.obs ? compact(x.obs) : dash}</td>
          <td class="num ${x.diff !== null && Math.abs(x.diff) > 0.25 ? 'warn' : ''}">${x.diff === null ? dash : signedPct(x.diff, 0)}</td>
          <td class="num ${x.plf > 1 ? 'warn' : ''}">${x.runs > 0 ? pct(x.plf, 0) : dash}</td><td class="num">${x.runs > 0 ? compact(x.runs) : '<span class="muted" title="No service on this day">none</span>'}</td><td class="num">${Number.isFinite(x.cpb) ? money(x.cpb, { cents: true }) : dash}</td></tr>`,
          )
          .join('')
      : `<tr><td colspan="7" class="empty">No routes match “${esc(view.q)}”.</td></tr>`;
    body.querySelectorAll<HTMLElement>('tr[data-route]').forEach((tr) => {
      tr.onclick = () => ctx.selectRoute(tr.dataset.route!, true);
      tr.onkeydown = (e) => e.key === 'Enter' && ctx.selectRoute(tr.dataset.route!, true);
    });
    el.querySelectorAll<HTMLElement>('th[data-sort]').forEach((t) => t.setAttribute('aria-sort', t.dataset.sort === view.sort ? (view.desc ? 'descending' : 'ascending') : 'none'));
  };
  draw();
  const search = el.querySelector<HTMLInputElement>('.search')!;
  search.oninput = () => ((view.q = search.value), draw());
  el.querySelectorAll<HTMLButtonElement>('.chip').forEach(
    (b) =>
      (b.onclick = () => {
        view.op = b.dataset.op!;
        el.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === b)));
        draw();
      }),
  );
  el.querySelectorAll<HTMLElement>('th[data-sort] button').forEach(
    (b) =>
      (b.onclick = () => {
        const k = b.parentElement!.dataset.sort as SortKey;
        if (view.sort === k) view.desc = !view.desc;
        else (view.sort = k), (view.desc = k !== 'route');
        draw();
      }),
  );
}

/** a sortable header; its explanation shows in the shared tooltip */
const th = (k: SortKey, label: string, help: string) =>
  `<th data-sort="${k}" class="${k === 'route' ? '' : 'num'}"${help ? ` data-tip="${esc(`<div class="tip-p">${esc(help)}</div>`)}"` : ''}><button aria-label="${esc(`${label.replace(/<small>/, ' ').replace(/<[^>]+>/g, '')}${help ? `: ${help}` : ''}`)}">${label}</button></th>`;

// ---------- detail ----------

function renderDetail(ctx: Ctx, el: HTMLElement, r: RouteInfo): void {
  const m = ctx.m;
  const H = m.bundle.header;
  const base = state.base;
  const dayT = state.day;
  const per = DAY_NOUN[dayT];
  const st = routeStats(m, base).get(r.index);
  const shown = shownResult();
  const scen = shown && state.resultScenario ? { res: shown, s: state.resultScenario } : null;
  const sst = scen ? routeStats(m, scen.res).get(r.index) : undefined;
  const edits = routeEdits(state.scenario, r);
  const day = st?.day ?? 0;
  const obs = r.observedBy[dayT];
  const runs = r.runsDay[dayT];
  const trainHours = r.feed === 'bart' || r.feed === 'caltrain';
  const costHr = COST_PER_HOUR[r.mode] ?? 300;

  let h = `<div class="panel-head"><button class="back" data-act="back">← All routes</button>
    <h2 class="route-h">${badge(r.badge, r.color)} <span>${esc(r.feed === 'muni' ? r.name : r.feed === 'bart' ? r.short : routeTitle(r))}</span></h2>
    <p class="lede">${esc(OPERATOR_LABEL[r.feed])} · ${MODE_NAME[r.mode]} · ${r.patterns.length} pattern${r.patterns.length > 1 ? 's' : ''} ${info('Each direction, short turn, and branch of a route is a pattern.')} · ${DAY_LABEL[dayT]}${edits.removed ? ' · <b class="warn">removed in your scenario</b>' : ''}</p></div>`;
  if (!runs) h += `<div class="banner">This route has no scheduled service on ${DAY_LABEL[dayT]}s.</div>`;

  // tiles
  let t = tile(`Riders per ${per}`, compact(day), 'modeled boardings', '', 'Each time someone gets on, both directions, all day. A rider who transfers counts again on the next route.');
  if (obs) t += tile('Counted', compact(obs), `Source: SFMTA · model ${signedPct(day / obs - 1, 0)}`);
  if (sst || (scen && edits.removed)) {
    const sd = sst?.day ?? 0;
    t += tile('In the scenario', compact(sd), `${signedInt(sd - day)} (${signedPct(day > 0 ? sd / day - 1 : 0, 0)}) vs today`, 'accent');
  }
  t += tile('Peak load', pct(st?.peakLoadFactor ?? 0, 0), 'busiest stretch and period', '', `Riders on board ÷ seats and standing room. Over 100% is over capacity.${r.feed === 'bart' || r.feed === 'caltrain' ? ' Includes riders whose trips have no end in San Francisco.' : ''}`);
  t += tile(`Scheduled runs per ${per}`, int(runs), `${r.feed === 'bart' || r.feed === 'caltrain' ? 'trains' : r.mode === 'ferry' ? 'sailings' : 'trips'}, both directions`, '', RUNS_HELP);
  t += tile('Service hours', `${int(st?.revenueHours ?? 0)} h`, `per ${per}${trainHours ? ', train-hours' : ''} · ${money(costHr)} per hour`, '', SERVICE_HOURS_HELP);
  t += tile('Operating cost', money(st?.opCost ?? 0), r.feed === 'muni' ? `per ${per} · ${day >= 20 ? money((st?.opCost ?? 0) / day, { cents: true }) : '–'} per rider` : `per ${per}, the whole line`, '', `Service hours × ${money(costHr)} an hour${trainHours ? ' per train' : ''}. Excludes capital costs.`);
  h += `<div class="tiles">${t}</div>`;

  // boardings by period
  const groups = TPERIODS.map((p) => {
    const bars = [{ v: st?.boardings[p] ?? 0, color: 'var(--c-today)', tip: `<div class="tip-h">${PERIOD_SHORT[p]}, today</div><div class="tip-row"><span>Riders (boardings)</span><b>${int(st?.boardings[p] ?? 0)}</b></div><div class="tip-row"><span>Per hour</span><b>${int((st?.boardings[p] ?? 0) / TPERIOD_HOURS[p])}</b></div>` }];
    if (scen) bars.push({ v: sst?.boardings[p] ?? 0, color: 'var(--c-scen)', tip: `<div class="tip-h">${PERIOD_SHORT[p]}, scenario</div><div class="tip-row"><span>Riders (boardings)</span><b>${int(sst?.boardings[p] ?? 0)}</b></div>` });
    return { label: PERIOD_SHORT[p], sub: periodHours(p), bars };
  });
  h += section('Riders by time of day', (scen ? legend([{ label: 'Today', color: 'var(--c-today)' }, { label: 'Scenario', color: 'var(--c-scen)' }]) : '') + columns(groups, { h: 150 }), { note: 'Periods differ in length. Night is 11 hours.' });

  // service by period and direction
  const dirs = [...new Set(r.patterns.map((i) => H.lines[i].dir))].sort();
  const svcRows = TPERIODS.map((p) => {
    const cells = dirs.map((d) => {
      const pats = r.patterns.filter((i) => H.lines[i].dir === d);
      const b = pats.reduce((a, i) => a + baseTrips(H.lines[i], p, dayT), 0) / TPERIOD_HOURS[p];
      const s = pats.reduce((a, i) => a + scenTrips(H.lines[i], p, state.scenario, dayT), 0) / TPERIOD_HOURS[p];
      return `<td class="num">${headway(b).replace('every ', '')}${Math.abs(s - b) > 0.01 ? ` <span class="chg">→ ${headway(s).replace('every ', '')}</span>` : ''}</td>`;
    });
    return `<tr><td>${PERIOD_SHORT[p]} <span class="muted">${periodHours(p)}</span></td>${cells.join('')}<td class="num muted">${int(r.runs[dayT][p])}</td></tr>`;
  });
  const dirHead = dirs.map((d) => {
    const main = r.main.find((i) => H.lines[i].dir === d) ?? r.patterns.find((i) => H.lines[i].dir === d)!;
    return `<th class="num">to ${esc(shorten(H.lines[main].headsign, 22))}</th>`;
  });
  h += section(
    `Service on ${DAY_PHRASE[dayT]}`,
    tblWrap(`<table class="tbl sticky1"><thead><tr><th>Period</th>${dirHead.join('')}<th class="num" data-tip="${esc(`<div class="tip-p">${esc(RUNS_HELP)}</div>`)}">Runs</th></tr></thead><tbody>${svcRows.join('')}</tbody><tfoot><tr><td>Whole day</td>${dirs.map(() => '<td></td>').join('')}<td class="num"><b>${int(runs)}</b></td></tr></tfoot></table>`),
    { note: 'Average minutes between buses or trains, each direction. Arrows show your edits.' },
  );

  // load profiles
  const p = state.period;
  for (const li of r.main) {
    const line = H.lines[li];
    const names = line.stops.map((s) => H.stops[s].name);
    const dist = [0];
    for (let k = 0; k + 1 < line.stops.length; k++) {
      let d = 0;
      for (let i = line.stopAt[k]; i < line.stopAt[k + 1]; i++) d += meters(line.path[2 * i], line.path[2 * i + 1], line.path[2 * i + 2], line.path[2 * i + 3]);
      if (d <= 0) d = meters(H.stops[line.stops[k]].lat, H.stops[line.stops[k]].lon, H.stops[line.stops[k + 1]].lat, H.stops[line.stops[k + 1]].lon);
      dist.push(dist[k] + d / 1000);
    }
    const segsOf = line.stops.slice(0, -1).map((a, k) => m.segs[m.segByKey.get(`${r.index}|${a}|${line.stops[k + 1]}`)!]);
    const series: ProfileSeries[] = [];
    let unit: string;
    if (p === 'day') {
      unit = 'riders per day';
      const cols: Record<TPeriod, string> = { AM: 'var(--p-am)', MD: 'var(--p-md)', PM: 'var(--p-pm)', NT: 'var(--p-nt)' };
      for (const q of TPERIODS) series.push({ label: `${PERIOD_SHORT[q]} (per hour)`, color: cols[q], v: segsOf.map((sg) => segLoad(m, base, sg, q) / TPERIOD_HOURS[q]) });
      unit = 'riders per hour';
    } else {
      unit = 'riders per hour';
      const hrs = hoursOf(p);
      series.push({ label: 'Capacity today', color: 'var(--ink-3)', ref: true, v: segsOf.map((sg) => segService(m, sg, p, null, dayT).cap / hrs) });
      series.push({ label: 'Riders today', color: 'var(--c-today)', area: true, v: segsOf.map((sg) => segLoad(m, base, sg, p) / hrs) });
      // BART and Caltrain: the riders with no end in the city, which the model holds fixed
      const bgv = segsOf.map((sg) => segBackground(m, sg, p, dayT) / hrs);
      if (bgv.some((v) => v > 1)) series.push({ label: 'of which no end in SF', color: 'var(--ink-2)', v: bgv });
      if (scen) {
        series.push({ label: 'Riders in scenario', color: 'var(--c-scen)', v: segsOf.map((sg) => segLoad(m, scen.res, sg, p) / hrs) });
        const capS = segsOf.map((sg) => segService(m, sg, p, scen.s, dayT).cap / hrs);
        if (capS.some((c, k) => Math.abs(c - series[0].v[k]) > 1)) series.push({ label: 'Capacity in scenario', color: 'var(--c-scen)', ref: true, v: capS });
      }
    }
    const peak = Math.max(...series.filter((s) => !s.ref).flatMap((s) => s.v));
    h += section(
      `Load toward ${shorten(line.headsign, 34)}`,
      legend(series.map((s) => ({ label: s.label, color: s.color, dashed: s.ref }))) + loadProfile(names, dist, series, { unit }),
      { note: `Riders on board in an average hour${p === 'day' ? ' of each period' : `, ${periodHours(p)}`}. Busiest: ${int(peak)} per hour. Hover for stop names.` },
    );
  }

  // edits
  const f = edits.frequency ?? {};
  const speedPct = edits.speed ? Math.round((1 / edits.speed - 1) * 100) : 0;
  const mults = [0, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const freqRows = TPERIODS.map((q) => {
    const tph = r.patterns.reduce((a, i) => a + baseTrips(H.lines[i], q, dayT), 0) / TPERIOD_HOURS[q] / Math.max(1, dirs.length);
    const cur = f[q] ?? 1;
    return `<tr><td>${PERIOD_SHORT[q]}</td><td><select data-q="${q}" aria-label="${PERIOD_SHORT[q]} frequency"${tph === 0 ? ' disabled' : ''}>${mults.map((x) => `<option value="${x}"${Math.abs(x - cur) < 1e-6 ? ' selected' : ''}>${x === 0 ? 'No service' : `×${x}`}</option>`).join('')}${mults.some((x) => Math.abs(x - cur) < 1e-6) ? '' : `<option value="${cur}" selected>×${cur.toFixed(2)}</option>`}</select></td><td class="num muted">${tph === 0 ? `no ${DAY_LABEL[dayT]} service` : `${headway(tph).replace('every ', '')} → <b>${headway(tph * cur).replace('every ', '')}</b>`}</td></tr>`;
  });
  h += section(
    'Change this route',
    `<div class="edit-block"><h4>Frequency</h4><div class="quick sm">${[0.5, 1.5, 2].map((x) => `<button class="btn sm" data-act="allday" data-x="${x}">×${x} all day</button>`).join('')}${edits.frequency ? '<button class="btn sm ghost" data-act="allday" data-x="1">Reset</button>' : ''}</div>
      <table class="tbl compact"><tbody>${freqRows.join('')}</tbody></table>
      <p class="note">Minutes between buses or trains, each direction. Applies to every day you run.</p></div>
    <div class="edit-block"><h4>Speed</h4>
      <div class="range-row"><input type="range" min="0" max="40" step="5" value="${speedPct}" id="speed" aria-label="Speed increase"><output for="speed">${speedPct ? `${speedPct}% faster` : 'No change'}</output></div>
      <p class="note">Red lanes and signal priority in San Francisco typically save 10–25%.</p></div>
    <div class="edit-block"><div class="row-between"><h4>Stops</h4><button class="btn sm${state.addStop === r.key ? ' on' : ''}" data-act="addstop" aria-pressed="${state.addStop === r.key}">${state.addStop === r.key ? 'Done adding stops' : 'Add a stop'}</button></div>
      <p class="note">Each removed stop saves about ${r.group === 'bart' || r.group === 'caltrain' || r.group === 'metro' ? 45 : 25} seconds. To add one, press Add a stop and click the line on the map.</p>
      ${stopLists(ctx, r, edits)}</div>
    <div class="edit-block row-between"><div><h4>${edits.removed ? 'Removed in your scenario' : 'Remove this route'}</h4><p class="note">Riders choose other routes, another mode, or other destinations.</p></div>
      <button class="btn ${edits.removed ? '' : 'danger'}" data-act="remove">${edits.removed ? 'Restore' : 'Remove'}</button></div>`,
    { cls: 'edits' },
  );
  el.innerHTML = h;
  // keep the stop lists the reader opened across re-renders
  const opened = openDirs.get(r.key) ?? new Set<number>();
  el.querySelectorAll<HTMLDetailsElement>('details.stops-dir').forEach((d, k) => {
    if (opened.has(k)) d.open = true;
    d.ontoggle = () => {
      if (d.open) opened.add(k);
      else opened.delete(k);
      openDirs.set(r.key, opened);
    };
  });

  onActs(el, {
    back: () => ctx.selectRoute(null),
    addstop: () => set({ addStop: state.addStop === r.key ? null : r.key }),
    rmstop: (b) => {
      const st = Number(b.dataset.stop);
      const on = !edits.removedStops.has(st);
      ctx.setEdits(withStopRemoved(m, state.scenario, r, st, on), `${on ? 'Removed' : 'Restored'} ${H.stops[st].name} on the ${r.label}`);
    },
    deladd: (b) => {
      const g = b.dataset.g!;
      ctx.setEdits(
        state.scenario.edits.filter((e) => !(e.kind === 'addStop' && addGroupId(e) === g)),
        'New stop deleted',
      );
    },
    gostop: (b) => ctx.map.fitPoints([{ lat: Number(b.dataset.lat), lon: Number(b.dataset.lon) }]),
    remove: () => ctx.setEdits(withRouteEdit(state.scenario, r, 'remove', !edits.removed), edits.removed ? `Restored ${r.label}` : `Removed ${r.label} in your scenario`),
    allday: (b) => {
      const x = Number(b.dataset.x);
      ctx.setEdits(withRouteEdit(state.scenario, r, 'frequency', x === 1 ? null : { AM: x, MD: x, PM: x, NT: x }), x === 1 ? `Reset ${r.label} frequency` : `${r.label}: frequency ×${x} all day`);
    },
  });
  el.querySelectorAll<HTMLSelectElement>('select[data-q]').forEach(
    (s) =>
      (s.onchange = () => {
        const nf: Partial<Record<TPeriod, number>> = { ...f };
        nf[s.dataset.q as TPeriod] = Number(s.value);
        const all1 = TPERIODS.every((q) => (nf[q] ?? 1) === 1);
        ctx.setEdits(withRouteEdit(state.scenario, r, 'frequency', all1 ? null : nf), `${r.label}: ${PERIOD_SHORT[s.dataset.q as TPeriod]} frequency ×${s.value}`);
      }),
  );
  const range = el.querySelector<HTMLInputElement>('#speed')!;
  const out = el.querySelector('output')!;
  range.oninput = () => (out.textContent = Number(range.value) ? `${range.value}% faster` : 'No change');
  range.onchange = () => {
    const v = Number(range.value);
    ctx.setEdits(withRouteEdit(state.scenario, r, 'speed', v ? 1 / (1 + v / 100) : null), v ? `${r.label}: ${v}% faster` : `${r.label}: speed reset`);
  };
}

const openDirs = new Map<string, Set<number>>();

/** the route's stops in each direction, as a strip map: remove or restore, and the stops added */
function stopLists(ctx: Ctx, r: RouteInfo, edits: ReturnType<typeof routeEdits>): string {
  const m = ctx.m;
  const H = m.bundle.header;
  const base = state.base;
  return r.main
    .map((li, k) => {
      const line = H.lines[li];
      const items: string[] = [];
      line.stops.forEach((st, i) => {
        const S = H.stops[st];
        const removed = edits.removedStops.has(st);
        const term = isTerminus(m, r, st);
        const on = base.stopOn[st] ?? 0;
        items.push(
          `<li class="${removed ? 'removed' : ''}${term ? ' term' : ''}"><button class="rs-name" data-act="gostop" data-lat="${S.lat}" data-lon="${S.lon}" title="Show on the map">${esc(S.name)}</button><span class="rs-n" title="Boardings at this stop on all routes, today">${compact(on)}</span>${
            term ? '<span class="rs-act muted">terminus</span>' : `<button class="btn sm ghost rs-act" data-act="rmstop" data-stop="${st}" aria-label="${removed ? 'Restore' : 'Remove'} ${esc(S.name)}">${removed ? 'Restore' : 'Remove'}</button>`
          }</li>`,
        );
        const nx = line.stops[i + 1];
        for (const a of edits.addedStops)
          if (nx !== undefined && ((a.between[0] === st && a.between[1] === nx) || (a.between[1] === st && a.between[0] === nx)))
            items.push(`<li class="added"><button class="rs-name" data-act="gostop" data-lat="${a.lat}" data-lon="${a.lon}" title="Show on the map">${esc(a.name ?? 'New stop')}</button><span class="rs-n">new</span><button class="btn sm ghost rs-act" data-act="deladd" data-g="${esc(addGroupId(a))}" aria-label="Delete ${esc(a.name ?? 'new stop')}">Delete</button></li>`);
      });
      // an extension beyond either terminus of this pattern
      for (const x of edits.extensions) {
        const names = x.stops.map((st) => ('stop' in st ? H.stops[st.stop].name : (st.name ?? 'New stop')));
        const pts = x.stops.map((st) => ('stop' in st ? H.stops[st.stop] : st));
        const li = (k: number) => `<li class="added"><button class="rs-name" data-act="gostop" data-lat="${pts[k].lat}" data-lon="${pts[k].lon}" title="Show on the map">${esc(names[k])}</button><span class="rs-n">new</span><span class="rs-act muted">extension</span></li>`;
        if (line.stops[line.stops.length - 1] === x.from) items.push(...x.stops.map((_, k) => li(k)));
        else if (line.stops[0] === x.from) items.unshift(...x.stops.map((_, k) => li(k)).reverse());
      }
      const nRemoved = line.stops.filter((st) => edits.removedStops.has(st)).length;
      return `<details class="stops-dir"${k === 0 && (nRemoved || edits.addedStops.length || edits.extensions.length) ? ' open' : ''}><summary>Toward ${esc(shorten(line.headsign, 30))} <span class="muted">${line.stops.length} stops${nRemoved ? `, ${nRemoved} removed` : ''}</span></summary><ol class="route-stops" style="--rc:${r.color}">${items.join('')}</ol></details>`;
    })
    .join('');
}

const periodHours = (p: TPeriod) => ({ AM: '6–10am', MD: '10am–3pm', PM: '3–7pm', NT: '7pm–6am' })[p];
const shorten = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
