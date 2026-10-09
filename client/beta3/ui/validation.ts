/**
 * Validation: today's modeled network against observed counts. Muni route-by-route boardings are
 * the independent test (not fitted); BART, Caltrain and mode shares are calibration targets.
 */
import { MODE_LABEL, type Mode } from '../../../shared/beta3/params';
import { legend, pairs, scatter } from '../charts';
import { DAY_LABEL, DAY_NOUN, DAY_TYPES, MODE_ORDER, routeStats, routeTitle, type DayType, type RouteInfo } from '../derive';
import { compact, esc, int, pct, signedPct } from '../format';
import { baseOf, state } from '../state';
import { section, tblWrap, tile, type Ctx } from './common';
import { drivingFit } from './driving';

export interface MuniFit {
  rows: { r: RouteInfo; obs: number; model: number }[];
  n: number;
  obs: number;
  model: number;
  rmsePct: number;
  r2: number;
  within25: number;
}

const fits = new WeakMap<object, MuniFit>();
/** modeled against counted Muni boardings route by route, for a day type (default: the day on show) */
export function muniFit(ctx: Ctx, day: DayType = state.day): MuniFit {
  const base = baseOf(day);
  const hit = fits.get(base);
  if (hit) return hit;
  const stats = routeStats(ctx.m, base);
  const rows = ctx.m.routes.filter((r) => r.observedBy[day] !== null).map((r) => ({ r, obs: r.observedBy[day]!, model: stats.get(r.index)?.day ?? 0 }));
  const n = rows.length;
  const obs = rows.reduce((a, x) => a + x.obs, 0), model = rows.reduce((a, x) => a + x.model, 0);
  const mo = obs / n, mm = model / n;
  let se = 0, sxy = 0, sxx = 0, syy = 0, w = 0;
  for (const x of rows) {
    se += (x.model - x.obs) ** 2;
    sxy += (x.obs - mo) * (x.model - mm);
    sxx += (x.obs - mo) ** 2;
    syy += (x.model - mm) ** 2;
    if (Math.abs(x.model - x.obs) <= 0.25 * x.obs) w++;
  }
  const fit = { rows, n, obs, model, rmsePct: Math.sqrt(se / n) / mo, r2: sxy ** 2 / (sxx * syy), within25: w / n };
  fits.set(base, fit);
  return fit;
}

const SF_BART = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB', 'DALY'];
const SF_CALTRAIN = ['San Francisco', '22nd Street', 'Bayshore'];

let logScale = false;

export function renderValidation(ctx: Ctx, el: HTMLElement): void {
  const H = ctx.m.bundle.header;
  const O = H.observed;
  const day = state.day;
  const wkd = day === 'wkd';
  const per = DAY_NOUN[day];
  const base = baseOf(day);
  const fit = muniFit(ctx);
  const OBS = 'var(--c-obs)', MOD = 'var(--c-model)';

  let h = `<div class="panel-head"><h2>Validation</h2><p class="lede">How the model compares with passenger counts. Muni riders by route are the real test, since the model was not fitted to them.</p>
    <a class="method-link" href="method/"><b>How this works</b><span>The full methodology</span></a>
    ${!state.weekends ? '' : `<div class="day-switch"><span class="muted">Compare</span><span class="seg sm" role="radiogroup" aria-label="Day compared">${DAY_TYPES.map((d) => `<button role="radio" aria-checked="${d === day}" data-day="${d}">${DAY_LABEL[d]}</button>`).join('')}</span></div>`}</div>`;
  if (!wkd)
    h += `<div class="banner info-banner">On ${DAY_LABEL[day]}s only two totals are fitted: Muni boardings and BART exits. How riders split between routes and stations is still a real test.</div>`;

  // --- Muni route test
  if (fit.n > 0) {
    const flagged = (x: MuniFit['rows'][number]) => Math.abs(x.model - x.obs) > 0.25 * x.obs && Math.abs(x.model - x.obs) > 1500;
    const pts = fit.rows.map((x) => ({
      x: x.obs,
      y: x.model,
      label: x.r.label,
      key: x.r.key,
      flag: flagged(x),
      tip: `<div class="tip-h">${esc(routeTitle(x.r))}</div><div class="tip-row"><span>Counted</span><b>${int(x.obs)}</b></div><div class="tip-row"><span>Modeled</span><b>${int(x.model)}</b></div><div class="tip-row"><span>Difference</span><b>${signedPct(x.model / x.obs - 1, 0)}</b></div><div class="tip-sub">Click to open the route</div>`,
    }));
    const tiles = `<div class="tiles">${tile('Routes compared', String(fit.n))}${tile('Total boardings', `${signedPct(fit.model / fit.obs - 1)}`, `${compact(fit.model)} model vs ${compact(fit.obs)} counted${wkd ? '' : ' (fitted)'}`)}${tile('r²', fit.r2.toFixed(2), 'route by route', '', 'How much of the difference between routes the model reproduces. 1 is a perfect match, 0 none.')}${tile('%RMSE', pct(fit.rmsePct, 0), `${pct(fit.within25, 0)} of routes within 25%`, '', 'The typical size of a route’s miss, as a share of the average route’s count.')}</div>`;
    const muniBody =
      tiles +
      `<div class="chart-head"><span class="ch-t">Boardings per Muni route, per ${per}</span><span class="seg sm" role="radiogroup" aria-label="Scale"><button role="radio" aria-checked="${!logScale}" data-act="lin">Linear</button><button role="radio" aria-checked="${logScale}" data-act="log">Log</button></span></div>` +
      scatter(pts, { log: logScale, xLabel: 'Counted boardings (SFMTA)', yLabel: 'Modeled boardings', band: 0.25 }) +
      `<p class="note">Each dot is a route. The shaded band is within 25%. Labeled routes miss by more than 25% and 1,500 boardings. Source: SFMTA.</p>`;
    const misses = [...fit.rows].sort((a, b) => Math.abs(b.model - b.obs) - Math.abs(a.model - a.obs)).slice(0, 8);
    const missTable = tblWrap(
      `<table class="tbl routes sticky1"><thead><tr><th>Route</th><th class="num">Counted</th><th class="num">Modeled</th><th class="num">Diff.</th></tr></thead><tbody>${misses
        .map((x) => `<tr class="click" data-route="${esc(x.r.key)}" tabindex="0"><td><span class="rt-n">${esc(x.r.label)} <span class="muted">${esc(x.r.name)}</span></span></td><td class="num">${int(x.obs)}</td><td class="num">${int(x.model)}</td><td class="num">${signedPct(x.model / x.obs - 1, 0)}</td></tr>`)
        .join('')}</tbody></table>`,
    );
    h += section('Muni riders by route (not fitted)', muniBody + `<h4>Largest differences</h4>` + missTable);
  } else h += section('Muni riders by route', `<p class="note">No ${DAY_LABEL[day]} route counts in this model bundle.</p>`);

  // --- BART
  const exitsFor = (s: (typeof O.bartStations)[number]) => (wkd ? s.exits : ((day === 'sat' ? O.bartExitsSat : O.bartExitsSun)?.[s.code] ?? NaN));
  const bart = O.bartStations.filter((s) => SF_BART.includes(s.code) && s.stop !== null && Number.isFinite(exitsFor(s)));
  const bRows = bart.map((s) => ({ label: s.name.replace(/ Street| \/ .*$/g, '').replace('Civic Center/UN Plaza', 'Civic Center').replace('Montgomery St.', 'Montgomery'), a: exitsFor(s), b: base.stopOff[s.stop!] ?? 0, tip: '' }));
  bRows.forEach((r, i) => (r.tip = `<div class="tip-h">${esc(bart[i].name)}</div><div class="tip-row"><span>Counted exits</span><b>${int(r.a)}</b></div><div class="tip-row"><span>Modeled</span><b>${int(r.b)}</b></div><div class="tip-row"><span>Difference</span><b>${signedPct(r.b / r.a - 1, 0)}</b></div>`));
  const bo = bRows.reduce((a, r) => a + r.a, 0), bm = bRows.reduce((a, r) => a + r.b, 0);
  if (bRows.length)
    h += section(
      'BART exits at SF stations (fitted)',
      legend([
        { label: 'Counted', color: OBS },
        { label: 'Modeled', color: MOD },
      ]) +
        pairs(bRows, { aColor: OBS, bColor: MOD, labelW: 100 }) +
        `<p class="note">Total ${int(bm)} modeled vs ${int(bo)} counted (${signedPct(bm / bo - 1)}). The total is fitted, but the split between stations is not. Source: BART.</p>`,
    );

  if (wkd) {
    // --- Caltrain
    const ct = O.caltrainStations.filter((s) => SF_CALTRAIN.includes(s.name) && s.stop !== null);
    const cRows = ct.map((s) => ({ label: s.name, a: s.boardings, b: base.stopOn[s.stop!] ?? 0, tip: `<div class="tip-h">${esc(s.name)}</div><div class="tip-row"><span>Counted boardings</span><b>${int(s.boardings)}</b></div><div class="tip-row"><span>Modeled</span><b>${int(base.stopOn[s.stop!] ?? 0)}</b></div>` }));
    h += section(
      'Caltrain boardings at SF stations (fitted)',
      legend([
        { label: 'Counted', color: OBS },
        { label: 'Modeled', color: MOD },
      ]) +
        pairs(cRows, { aColor: OBS, bColor: MOD, labelW: 100 }) +
        `<p class="note">Source: Caltrain.</p>`,
    );

    // --- mode shares
    const rt = base.summary.residentTrips;
    const tot = MODE_ORDER.reduce((a, k) => a + rt[k], 0);
    const tg = O.residentShares;
    const autoCombined = (tg.da ?? 0) === 0 && (tg.sr ?? 0) === 0;
    const sRows: { label: string; a: number; b: number; tip: string }[] = [];
    const addRow = (label: string, target: number, model: number) =>
      sRows.push({ label, a: target * 100, b: model * 100, tip: `<div class="tip-h">${esc(label)}</div><div class="tip-row"><span>Survey</span><b>${pct(target)}</b></div><div class="tip-row"><span>Modeled</span><b>${pct(model)}</b></div>` });
    for (const k of ['transit', 'walk', 'bike', 'tnc'] as Mode[]) addRow(MODE_LABEL[k], tg[k] ?? 0, rt[k] / tot);
    if (autoCombined) addRow('Car (driver or passenger)', 1 - (['transit', 'walk', 'bike', 'tnc'] as Mode[]).reduce((a, k) => a + (tg[k] ?? 0), 0), (rt.da + rt.sr) / tot);
    else for (const k of ['da', 'sr'] as Mode[]) addRow(MODE_LABEL[k], tg[k] ?? 0, rt[k] / tot);
    h += section(
      'How residents travel (fitted)',
      legend([
        { label: 'Travel survey', color: OBS },
        { label: 'Modeled', color: MOD },
      ]) +
        pairs(sRows, { aColor: OBS, bColor: MOD, labelW: 150, fmt: (v) => `${v.toFixed(v < 10 && v > 0 ? 1 : 0)}%` }) +
        `<p class="note">Share of residents’ weekday trips.${autoCombined ? ' The survey combines driving alone and carpooling.' : ''} Source: BATS 2023.</p>`,
    );
  } else {
    h += section('Caltrain and how residents travel', `<p class="note">Caltrain counts and the travel survey cover weekdays only. See <button class="link" data-day="wkd">Weekday</button>.</p>`);
  }

  // --- system totals
  const muniModel = base.summary.boardings.muni ?? 0;
  const rowsT: string[] = [];
  if (wkd) rowsT.push(`<tr><td>Muni boardings, all routes</td><td class="num">${int(O.muniSystem)}</td><td class="num">${int(muniModel)}</td><td class="num">${signedPct(muniModel / O.muniSystem - 1)}</td></tr>`);
  if (fit.n) rowsT.push(`<tr><td>Muni routes with counts</td><td class="num">${int(fit.obs)}</td><td class="num">${int(fit.model)}</td><td class="num">${signedPct(fit.model / fit.obs - 1)}</td></tr>`);
  if (bRows.length) rowsT.push(`<tr><td>BART exits, SF stations</td><td class="num">${int(bo)}</td><td class="num">${int(bm)}</td><td class="num">${signedPct(bm / bo - 1)}</td></tr>`);
  h += section(
    `System totals, per ${per}`,
    tblWrap(`<table class="tbl"><thead><tr><th>Measure</th><th class="num">Counted</th><th class="num">Modeled</th><th class="num">Diff.</th></tr></thead><tbody>${rowsT.join('')}</tbody></table>`) +
      (wkd ? '' : `<p class="note">On ${DAY_LABEL[day]}s both totals are fitted.</p>`),
  );

  // --- what was fit
  h += section(
    'What is fitted, what is tested',
    `<ul class="plain">${
      wkd
        ? '<li><b>Fitted</b>, so they match by design: how residents and commuters travel, BART exits and Caltrain boardings at city stations, and how often Muni riders transfer.</li><li><b>Tested</b>, not fitted: Muni riders by route, and traffic counts and speeds.</li>'
        : '<li><b>Fitted</b>: Muni boardings on counted routes and BART exits at city stations, in total.</li><li><b>Tested</b>: how those riders split between routes and stations.</li>'
    }<li><b>Not checked here</b>: cable cars, the F and E streetcars, Golden Gate Transit, and ferries.</li></ul>`,
  );
  if (day === 'wkd') h += drivingFit();
  el.innerHTML = h;

  el.querySelector<HTMLElement>('[data-act="lin"]')?.addEventListener('click', () => ((logScale = false), renderValidation(ctx, el)));
  el.querySelector<HTMLElement>('[data-act="log"]')?.addEventListener('click', () => ((logScale = true), renderValidation(ctx, el)));
  el.querySelectorAll<HTMLElement>('[data-day]').forEach((b) => b.addEventListener('click', () => ctx.setDay(b.dataset.day as DayType)));
  el.querySelectorAll<HTMLElement>('[data-key], [data-route]').forEach((n) => {
    const key = n.dataset.key ?? n.dataset.route!;
    n.style.cursor = 'pointer';
    n.addEventListener('click', () => ctx.selectRoute(key, true));
    n.addEventListener('keydown', (e) => e.key === 'Enter' && ctx.selectRoute(key, true));
  });
}
