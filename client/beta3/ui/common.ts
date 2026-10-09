/** Shared bits for the sidebar panels: the context they get, and small HTML builders. */
import type { RunMode } from '../../../shared/beta3/runmode';
import type { DayType, Edit, Scenario } from '../../../shared/beta3/types';
import { inkOn, type Model } from '../derive';
import type { Engine } from '../engine';
import { esc } from '../format';
import type { TransitMap } from '../map';

export interface Ctx {
  m: Model;
  engine: Engine;
  map: TransitMap;
  selectRoute(key: string | null, fit?: boolean): void;
  /** show another day type (loads its baseline on first use) */
  setDay(day: DayType): void;
  /** switch the experimental weekend models on or off */
  setWeekends(on: boolean): void;
  /** replace the scenario's edits (records undo) */
  setEdits(edits: Edit[], note?: string): void;
  loadScenario(s: Scenario, note?: string): void;
  undo(): void;
  canUndo(): boolean;
  /** run the scenario, in `mode` this once if given (else the chosen run mode) */
  run(mode?: RunMode): void;
  /** choose the run mode (`remember`: in this browser, the default) */
  setRunMode(mode: RunMode, remember?: boolean): void;
  cancel(): void;
  toast(msg: string, action?: { label: string; fn: () => void }): void;
}

/** a figure with its label; `help` (plain text) adds an ⓘ that explains it on hover or focus */
export function tile(label: string, value: string, sub = '', cls = '', help = ''): string {
  return `<div class="tile ${cls}"><div class="tile-l">${esc(label)}${help ? info(help) : ''}</div><div class="tile-v">${value}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
}

/** a small ⓘ with an explanation in the shared tooltip (plain text, escaped here) */
export function info(text: string): string {
  return `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(`<div class="tip-p">${esc(text)}</div>`)}">i</span>`;
}

/** what "service hours" means, for tooltips wherever it is shown */
export const SERVICE_HOURS_HELP =
  'Hours buses, trains, and boats spend in passenger service, from the timetables. A BART or Caltrain train counts once, however many cars it has.';

/** what "scheduled runs" means */
export const RUNS_HELP = 'Timetabled trips by one bus or train in one direction, both directions added. Not riders.';

/** a table that scrolls sideways inside its panel when it is wider than the panel */
export const tblWrap = (table: string, cls = '') => `<div class="tbl-wrap ${cls}">${table}</div>`;

export function section(title: string, body: string, opts: { note?: string; id?: string; cls?: string } = {}): string {
  return `<section class="sec ${opts.cls ?? ''}"${opts.id ? ` id="${opts.id}"` : ''}><h3>${esc(title)}</h3>${opts.note ? `<p class="note">${opts.note}</p>` : ''}${body}</section>`;
}

export const swatch = (color: string) => `<span class="sw" style="background:${color}"></span>`;

/** route badge: the route's short name on its color */
export function badge(label: string, color: string): string {
  return `<span class="badge" style="--bc:${color};color:${inkOn(color)}">${esc(label)}</span>`;
}

/** run fn on click for [data-act] buttons inside el */
export function onActs(el: HTMLElement, acts: Record<string, (btn: HTMLElement, ev: Event) => void>): void {
  el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => {
    const fn = acts[b.dataset.act!];
    if (fn) b.addEventListener('click', (ev) => fn(b, ev));
  });
}

/** the switch for the experimental weekend models (bound by bindWeekendSwitch) */
export function weekendSwitch(on: boolean): string {
  return `<label class="xp-switch"><input type="checkbox" data-weekends ${on ? 'checked' : ''}><span><b>Weekend models</b><span class="muted xp-d">Adds Saturday and Sunday to the day picker.</span></span></label>`;
}

export function bindWeekendSwitch(ctx: Ctx, el: HTMLElement): void {
  el.querySelectorAll<HTMLInputElement>('input[data-weekends]').forEach((b) => (b.onchange = () => ctx.setWeekends(b.checked)));
}
