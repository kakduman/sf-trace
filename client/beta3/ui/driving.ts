/** Driving: today's traffic (overview), its change in a scenario (results), and its fit to counts (validation). */
import RV from '../../../server/beta3/reference/road-validation.json';
import SPD from '../../../server/beta3/reference/sf-auto-speeds.json';
import { corridorTrips, tripTimes } from '../../../shared/beta3/traffic';
import type { RunResult, TPeriod, TrafficResult } from '../../../shared/beta3/types';
import { compact, dec1, esc, int, pct, signedCompact, signedPct } from '../format';
import { todayTraffic } from '../roadsView';
import { info, section, tile, type Ctx } from './common';

const P: TPeriod[] = ['AM', 'MD', 'PM', 'NT'];
const PNAME: Record<TPeriod, string> = { AM: 'Morning peak', MD: 'Midday', PM: 'Evening peak', NT: 'Night' };
type Sum = TrafficResult['base'];
const day = (r: Record<string, number>) => P.reduce((a, p) => a + (r[p] ?? 0), 0);
const daySpeed = (s: Sum) => day(s.vmt) / Math.max(1, day(s.vht));
const mins = (m: number) => `${Math.round(m)} min`;
const signedMin = (d: number) => (Math.abs(d) < 0.05 ? '±0.0 min' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} min`);
const signedMph = (d: number) => (Math.abs(d) < 0.05 ? '±0.0' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`);
const SPEED_HELP = 'Vehicle miles ÷ vehicle hours on the city’s streets, for cars, ride-hail, trucks, and through traffic.';
const DELAY_HELP = 'Extra vehicle hours compared with empty streets. Empty-street times still include signals and stop signs.';
const PENINSULA_HELP = 'US-101 and I-280 from the county line to San Jose, both directions. These change with a scenario only in a Precise run.';
const CORRIDOR_TRIP_HELP = 'Freeway time only, from the San Francisco county line to Millbrae Avenue or to the Santa Clara County line.';
const PROUTES = ['US-101', 'I-280'] as const;
/** a Peninsula freeway's average speed in a period (both directions), from the summary's miles and hours */
const penMph = (s: Sum, route: string, p: TPeriod) => {
  let m = 0,
    h = 0;
  for (const [k, v] of Object.entries(s.peninsula ?? {})) if (k.startsWith(route)) ((m += v.vmt[p] ?? 0), (h += v.vht[p] ?? 0));
  return h > 0 ? m / h : NaN;
};

/** today's driving, for the overview (weekdays) */
export function drivingToday(ctx: Ctx, base: RunResult): string {
  const net = ctx.engine.roads;
  if (!net) return section('Driving', '<p class="note">Loading the streets…</p>');
  const S = todayTraffic(net).summary;
  const trips = tripTimes(ctx.m.bundle);
  let h = `<div class="tiles">${tile('Average driving speed', `${dec1(daySpeed(S))} mph`, 'all streets, all day', '', SPEED_HELP)}${tile('Vehicle miles', compact(day(S.vmt)), 'per weekday, on the city’s streets')}${tile('Vehicle hours', compact(day(S.vht)), 'per weekday')}${tile('Hours of delay', compact(day(S.delay)), 'per weekday, above empty-street times', '', DELAY_HELP)}</div>`;
  h += `<table class="tbl wrap-head"><thead><tr><th>Average speed, mph</th><th class="num">All streets</th><th class="num">Freeways</th><th class="num">Arterials</th><th class="num">Local streets</th></tr></thead><tbody>${P.map((p) => `<tr><td>${PNAME[p]}</td><td class="num">${dec1(S.speed.all[p])}</td><td class="num">${dec1(S.speed.freeway[p])}</td><td class="num">${dec1(S.speed.arterial[p])}</td><td class="num">${dec1(S.speed.local[p])}</td></tr>`).join('')}</tbody></table>`;
  if (S.peninsula) h += `<table class="tbl wrap-head"><thead><tr><th>Peninsula freeways, mph ${info(PENINSULA_HELP)}</th><th class="num">Morning peak</th><th class="num">Evening peak</th></tr></thead><tbody>${PROUTES.map((r) => `<tr><td>${r}, the county line to San Jose</td><td class="num">${dec1(penMph(S, r, 'AM'))}</td><td class="num">${dec1(penMph(S, r, 'PM'))}</td></tr>`).join('')}</tbody></table>`;
  const T0 = todayTraffic(net).time;
  const ctrips = net.h.peninsula ? corridorTrips(net, (p) => T0[p], (p) => T0[p]) : [];
  h += `<table class="tbl"><thead><tr><th>Drives</th><th class="num">Minutes</th></tr></thead><tbody>${trips.map((t) => `<tr><td>${esc(t.name)} <span class="muted">(${PNAME[t.period].toLowerCase()})</span></td><td class="num">${mins(t.base)}</td></tr>`).join('')}${ctrips.map((t) => `<tr><td>${esc(t.name)} <span class="muted">(${PNAME[t.period].toLowerCase()})</span> ${info(CORRIDOR_TRIP_HELP)}</td><td class="num">${mins(t.base)}</td></tr>`).join('')}${base.summary.driveMin ? `<tr><td>Average commute by car</td><td class="num">${mins(base.summary.driveMin.work)}</td></tr>` : ''}</tbody></table>`;
  return section('Driving on a weekday', h, {
    note: S.peninsula ? 'Totals are for city streets. Peninsula freeways are listed separately.' : '',
  });
}

/** the scenario's traffic against today's, for the results */
export function drivingChange(res: RunResult, base: RunResult): string {
  const T = res.traffic;
  if (!T) return '';
  const B = T.base, S = T.summary;
  const dv = day(S.vmt) - day(B.vmt), dh = day(S.vht) - day(B.vht), dd = day(S.delay) - day(B.delay);
  const ds = daySpeed(S) - daySpeed(B);
  let h = `<div class="tiles">${tile('Average driving speed', `${signedMph(ds)} mph`, `${dec1(daySpeed(B))} → ${dec1(daySpeed(S))} mph, all day`, ds >= 0 ? 'up' : 'down', SPEED_HELP)}${tile('Vehicle miles', signedCompact(dv), `${signedPct(dv / day(B.vmt), 2)} · per weekday`)}${tile('Vehicle hours', signedCompact(dh), `${signedPct(dh / day(B.vht), 2)} · per weekday`)}${tile('Hours of delay', signedCompact(dd), `${signedPct(dd / Math.max(1, day(B.delay)), 1)} · per weekday`, dd <= 0 ? 'up' : 'down', DELAY_HELP)}</div>`;
  const bw = base.summary.driveMin?.work, sw = res.summary.driveMin?.work;
  h += `<table class="tbl wrap-head"><thead><tr><th>Average speed, mph</th><th class="num">All streets</th><th class="num">Freeways</th><th class="num">Arterials</th></tr></thead><tbody>${P.map((p) => `<tr><td>${PNAME[p]}</td>${(['all', 'freeway', 'arterial'] as const).map((c) => `<td class="num">${dec1(B.speed[c][p])} → <b>${dec1(S.speed[c][p])}</b></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  if (S.peninsula && B.peninsula) h += `<table class="tbl wrap-head"><thead><tr><th>Peninsula freeways, mph ${info(PENINSULA_HELP)}</th><th class="num">Morning peak</th><th class="num">Evening peak</th></tr></thead><tbody>${PROUTES.map((r) => `<tr><td>${r}, the county line to San Jose</td>${(['AM', 'PM'] as const).map((p) => `<td class="num">${dec1(penMph(B, r, p))} → <b>${dec1(penMph(S, r, p))}</b></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  h += `<table class="tbl"><thead><tr><th>Drives</th><th class="num">Today</th><th class="num">Scenario</th></tr></thead><tbody>${T.trips.map((t) => `<tr><td>${esc(t.name)} <span class="muted">(${PNAME[t.period].toLowerCase()})</span></td><td class="num">${mins(t.base)}</td><td class="num">${t.scenario.toFixed(1)} min <span class="muted">(${signedMin(t.scenario - t.base)})</span></td></tr>`).join('')}${(T.corridorTrips ?? []).map((t) => `<tr><td>${esc(t.name)} <span class="muted">(${PNAME[t.period].toLowerCase()})</span> ${info(CORRIDOR_TRIP_HELP)}</td><td class="num">${mins(t.base)}</td><td class="num">${t.scenario.toFixed(1)} min <span class="muted">(${signedMin(t.scenario - t.base)})</span></td></tr>`).join('')}${bw && sw ? `<tr><td>Average commute by car ${info('Driving alone or carpooling. Includes commuters who switch routes or destinations.')}</td><td class="num">${bw.toFixed(1)} min</td><td class="num">${sw.toFixed(1)} min <span class="muted">(${signedMin(sw - bw)})</span></td></tr>` : ''}</tbody></table>`;
  if (T.changes.length) h += `<table class="tbl"><thead><tr><th>Largest changes in daily traffic</th><th class="num">Today</th><th class="num">Scenario</th></tr></thead><tbody>${T.changes.slice(0, 8).map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${int(c.base)}</td><td class="num">${int(c.scenario)} <span class="muted">(${c.scenario >= c.base ? '+' : '−'}${int(Math.abs(c.scenario - c.base))})</span></td></tr>`).join('')}</tbody></table>`;
  return section('Driving', h, {
    note: `Each street’s change is for the block and direction where it changed most. Turn on Street speeds in Map layers to see where.`,
  });
}

/** the base traffic against counts and speeds, for the validation tab */
export function drivingFit(): string {
  const V = RV as unknown as { bySource: Record<string, { n: number; ratio: number; r: number; pctRmse: number; within25: number }>; byClass: Record<string, { n: number; ratio: number; r: number; pctRmse: number; within25: number }>; cmp: Record<string, { n: number; ratio: number; r: number; pctRmse: number; within25: number }>; summary: { speed: Record<string, Record<string, number>> } };
  const row = (label: string, s: { n: number; ratio: number; r: number; pctRmse: number; within25: number }) => `<tr><td>${label}</td><td class="num">${s.n}</td><td class="num">${s.ratio?.toFixed(2) ?? '–'}</td><td class="num">${s.r?.toFixed(2) ?? '–'}</td><td class="num">${s.pctRmse ? `${Math.round(s.pctRmse)}%` : '–'}</td><td class="num">${pct(s.within25, 0)}</td></tr>`;
  const sp = V.summary.speed;
  const hp = SPD.hourlyProfile.byModelPeriod as unknown as Record<string, Record<string, number>>;
  const h = `<table class="tbl wrap-head"><thead><tr><th>Today’s traffic against</th><th class="num">n</th><th class="num">Model ÷ count</th><th class="num">r</th><th class="num">%RMSE</th><th class="num">Within ±25%</th></tr></thead><tbody>
    ${row('Caltrans 2023 counts, state highways (both directions)', V.bySource.caltrans)}
    ${Object.entries(V.byClass).map(([c, s]) => row(`&nbsp;&nbsp;${c}`, s)).join('')}
    ${row('SFMTA 2021–23 counts, city streets (one direction)', V.bySource.sfmta)}
    ${Object.entries(V.cmp).map(([k, s]) => row(`SFCTA CMP 2025 speeds, ${k}`, s)).join('')}
  </tbody></table>
  <p class="note">Speeds by period (AM, midday, PM, night), mph. Model: freeways ${P.map((p) => dec1(sp.freeway[p])).join(', ')}; arterials ${P.map((p) => dec1(sp.arterial[p])).join(', ')}. SFCTA: freeways ${['AM', 'MD', 'PM', 'EV'].map((p) => dec1(hp.freeway[p])).join(', ')}; arterials ${['AM', 'MD', 'PM', 'EV'].map((p) => dec1(hp.arterial[p])).join(', ')}.</p>`;
  return section('Traffic', h, {
    note: 'Daily volumes. Counts at the city line set through traffic, so they are left out. A common target is %RMSE under 40%.',
  });
}
