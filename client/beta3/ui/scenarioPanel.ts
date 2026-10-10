/** Scenario: build a scenario from edits, draw new lines, run the model, share the link. */
import { TODAY_FIRST } from '../engine';
import type { TPeriod } from '../../../shared/beta3/types';
import { DAY_LABEL, DAY_PHRASE, OPERATORS, OPERATOR_LABEL, PERIOD_SHORT, TPERIODS, newLines } from '../derive';
import { esc, minutes } from '../format';
import { MICRO } from '../../../shared/beta3/micromobility';
import {
  PROFILES,
  PROFILE_ORDER,
  draftFromEdit,
  draftHops,
  draftRemoveStop,
  draftToEdit,
  editGroups,
  examples,
  fareFactor,
  MICRO_LABEL,
  microFactor,
  withMicro,
  type MicroKey,
  newDraft,
  relegAll,
  streetGraph,
  streetsReady,
  withCondition,
  withFare,
  type Profile,
} from '../scenario';
import { editsKey, resultCurrent, resultOtherMode, set, state, touch } from '../state';
import { RUN_MODE_LIST, type RunMode } from '../../../shared/beta3/runmode';
import { CONDITIONS, cleanContext, contextValue, type ConditionKey, type ConditionSpec } from '../../../shared/beta3/context';
import backcastDrivers from '../../../server/beta3/reference/backcast-drivers.json';
import type { DemandContext, Scenario } from '../../../shared/beta3/types';
import { onActs, section, type Ctx } from './common';

let lastDraft: string | null = null;

export function renderScenario(ctx: Ctx, el: HTMLElement): void {
  const d = state.draft;
  lastDraft = d ? `${d.id}:${d.profile}` : null;
  if (d) return renderDraft(ctx, el);
  const s = state.scenario;
  const groups = editGroups(ctx.m, s);
  let h = `<div class="panel-head"><h2>Scenario</h2><p class="lede">Change routes, stops, or fares, or draw a new line. Then run the model to see what changes.</p></div>
    <label class="field big"><span>Scenario name</span><input id="sc-name" value="${esc(s.name)}" maxlength="80"></label>`;

  // edits
  const list = groups.length
    ? `<ul class="edits-list">${groups
        .map(
          (g) => `<li><div class="ed-main"><span class="ed-kind k-${g.kind}">${kindLabel(g.kind)}</span><div>${g.kind === 'addStop' ? `<input class="ed-rename" data-i="${g.indices.join(',')}" value="${esc(g.title)}" maxlength="60" aria-label="Name of the new stop">` : `<div class="ed-t">${esc(g.title)}</div>`}<div class="ed-d">${esc(g.detail)}</div></div></div>
          <div class="ed-acts">${g.kind === 'newLine' ? `<button class="icon-btn" data-act="editline" data-i="${g.indices[0]}" aria-label="Edit ${esc(g.title)}" title="Edit">✎</button>` : g.route ? `<button class="icon-btn" data-act="open" data-key="${esc(g.route.key)}" aria-label="Open ${esc(g.title)}" title="Open route">↗</button>` : ''}<button class="icon-btn" data-act="del" data-i="${g.indices.join(',')}" aria-label="Remove change: ${esc(g.title)}" title="Remove">✕</button></div></li>`,
        )
        .join('')}</ul><div class="row-actions"><button class="btn sm ghost" data-act="undo"${ctx.canUndo() ? '' : ' disabled'}>Undo</button><button class="btn sm ghost" data-act="clear">Clear all</button><button class="btn sm ghost" data-act="share">Copy share link</button></div>`
    : `<div class="empty-state"><p>No changes yet. Load an example below, draw a line, or open a route.</p>${ctx.canUndo() ? '<button class="btn sm ghost" data-act="undo">Undo</button>' : ''}</div>`;
  h += section(`Your changes${groups.length ? ` (${groups.length})` : ''}`, list);
  h += `<div id="runbox" class="runbox"></div>`;

  // add a change
  h += section(
    'Draw a new line',
    `<div class="profiles">${PROFILE_ORDER.map((p) => `<button class="profile" data-act="draw" data-p="${p}"><span class="pdot" style="background:${PROFILES[p].color}"></span><span><b>${PROFILES[p].label}</b><small>${PROFILES[p].kmh} km/h</small></span></button>`).join('')}</div>`,
    { note: 'Pick a type, then click the map to place stops.' },
  );
  h += section('Change a route', `<p class="note">Pick one in <button class="link" data-act="routes">Routes</button> or click it on the map.</p>`);
  h += section(
    'Fares',
    `<div class="fares">${OPERATORS.map((op) => {
      const f = fareFactor(s, op);
      return `<div class="range-row"><label for="fare-${op}">${OPERATOR_LABEL[op]}</label><input type="range" id="fare-${op}" data-op="${op}" min="0" max="200" step="5" value="${Math.round(f * 100)}"><output>${fareText(f)}</output></div>`;
    }).join('')}</div>`,
    { note: 'Relative to today’s fares.' },
  );
  // shared bikes and scooters (micromobility.ts): one edit, scaled from today's
  const docks = ((ctx.m.bundle.a.mmDocks as Float32Array | undefined)?.length ?? 0) / 3;
  if (docks > 0)
    h += section(
      'Bike share and scooters',
      `<div class="fares">${(Object.keys(MICRO_LABEL) as MicroKey[])
        .map((k) => {
          const f = microFactor(s, k);
          return `<div class="range-row"><label for="mm-${k}">${MICRO_LABEL[k]}</label><input type="range" id="mm-${k}" data-mm="${k}" min="0" max="${k === 'docks' || k === 'fleet' ? 300 : 200}" step="5" value="${Math.round(f * 100)}"><output>${microText(k, f)}</output></div>`;
        })
        .join('')}</div>`,
      { note: `Today: ${docks.toLocaleString('en-US')} Bay Wheels stations and about ${(Math.round(MICRO.fleet.scooter / 100) * 100).toLocaleString('en-US')} scooters.` },
    );
  h += conditionsSection(s);
  h += section(
    'Time horizon',
    `<label class="check"><input type="checkbox" id="sc-longrun"${s.context?.carOwnership ? ' checked' : ''}> Long run</label>`,
    { note: 'On: households adjust how many cars they own, as they would over several years. Off: car ownership stays as it is today.' },
  );
  h += section(
    'Examples',
    `<ul class="examples">${examples(ctx.m)
      .map((x) => `<li><div><div class="ex-t">${esc(x.title)}</div><div class="ex-d">${esc(x.blurb)}</div></div><button class="btn sm" data-act="example" data-id="${x.id}">Load</button></li>`)
      .join('')}</ul>`,
    { note: 'Loading one replaces your changes. You can undo.' },
  );
  el.innerHTML = h;
  renderRunBox(ctx, el.querySelector('#runbox')!);

  const longRun = el.querySelector<HTMLInputElement>('#sc-longrun')!;
  longRun.onchange = () => {
    const { carOwnership: _c, ...rest } = state.scenario.context ?? {};
    void _c;
    const context = longRun.checked ? { ...rest, carOwnership: true } : Object.keys(rest).length ? rest : undefined;
    set({ scenario: { ...state.scenario, context } });
  };
  const name = el.querySelector<HTMLInputElement>('#sc-name')!;
  name.onchange = () => {
    set({ scenario: { ...state.scenario, name: name.value.trim() || 'My scenario' } });
  };
  onActs(el, {
    del: (b) => {
      const idx = new Set(b.dataset.i!.split(',').map(Number));
      ctx.setEdits(
        state.scenario.edits.filter((_, i) => !idx.has(i)),
        'Change removed',
      );
    },
    editline: (b) => {
      const i = Number(b.dataset.i);
      const e = state.scenario.edits[i];
      if (e.kind !== 'newLine') return;
      const dr = draftFromEdit(ctx.m, e, i);
      set({ draft: dr });
      ctx.map.fitPoints(dr.stops);
    },
    open: (b) => ctx.selectRoute(b.dataset.key!, true),
    undo: () => ctx.undo(),
    clear: () => {
      ctx.setEdits([], 'Cleared all changes');
      set({ scenario: { name: 'My scenario', edits: [], day: state.day } });
      // (clearing also returns the conditions to today's)
    },
    share: () => share(ctx),
    routes: () => set({ tab: 'routes' }),
    draw: (b) => startDraft(ctx, b.dataset.p as Profile),
    example: (b) => {
      const x = examples(ctx.m).find((e) => e.id === b.dataset.id)!;
      const sc = x.scenario();
      // an example that matches nothing in this model bundle would otherwise load silently empty
      if (!sc.edits.length) return ctx.toast(`“${x.title}” has no changes for this version of the model.`);
      ctx.loadScenario(sc, `Loaded “${x.title}”`);
    },
  });
  el.querySelectorAll<HTMLInputElement>('input.ed-rename').forEach((inp) => {
    inp.onchange = () => {
      const idx = new Set(inp.dataset.i!.split(',').map(Number));
      const name = inp.value.trim() || 'New stop';
      ctx.setEdits(state.scenario.edits.map((e, i) => (idx.has(i) && e.kind === 'addStop' ? { ...e, name } : e)));
    };
  });
  bindConditions(ctx, el);
  el.querySelectorAll<HTMLInputElement>('input[data-mm]').forEach((r) => {
    const out = r.nextElementSibling as HTMLOutputElement;
    const k = r.dataset.mm as MicroKey;
    r.oninput = () => (out.textContent = microText(k, Number(r.value) / 100));
    r.onchange = () => ctx.setEdits(withMicro(state.scenario, k, Number(r.value) / 100), `${MICRO_LABEL[k]} ${microText(k, Number(r.value) / 100).toLowerCase()}`);
  });
  el.querySelectorAll<HTMLInputElement>('input[data-op]').forEach((r) => {
    const out = r.nextElementSibling as HTMLOutputElement;
    r.oninput = () => (out.textContent = fareText(Number(r.value) / 100));
    r.onchange = () => ctx.setEdits(withFare(state.scenario, r.dataset.op!, Number(r.value) / 100), `${OPERATOR_LABEL[r.dataset.op!]} fares ${fareText(Number(r.value) / 100).toLowerCase()}`);
  });
}

/** re-render only what changed: the draft's stop list, or the run box */
export function updateScenario(ctx: Ctx, el: HTMLElement, changed: Set<string>): void {
  const d = state.draft;
  const key = d ? `${d.id}:${d.profile}` : null;
  if (changed.has('scenario') || changed.has('result') || key !== lastDraft) return renderScenario(ctx, el);
  if (changed.has('draft') && d) {
    const st = el.querySelector('#draft-stops');
    if (st) st.innerHTML = draftStopsHtml();
    bindDraftStops(el);
    const note = el.querySelector('#dr-note');
    if (note) note.innerHTML = profileNote(d.profile);
    const save = el.querySelector<HTMLButtonElement>('[data-act="save"]');
    if (save) save.disabled = d.stops.length < 2;
  }
  if (changed.has('run') || changed.has('runMode')) {
    const rb = el.querySelector<HTMLElement>('#runbox');
    if (rb) renderRunBox(ctx, rb);
  }
}

export function startDraft(ctx: Ctx, p: Profile): void {
  const d = newDraft(p, newLines(state.scenario).length);
  set({ draft: d, tab: 'scenario', route: null });
  if (PROFILES[p].streets && !streetsReady())
    void streetGraph().then(() => {
      if (state.draft === d && d.stops.length > 1) {
        relegAll(d);
        touch('draft');
      }
    });
  void ctx;
}

function renderDraft(ctx: Ctx, el: HTMLElement): void {
  const d = state.draft!;
  const editing = d.editIndex !== null;
  el.innerHTML = `<div class="panel-head"><button class="back" data-act="cancel">← Back to scenario</button><h2>${editing ? 'Edit line' : 'Draw a new line'}</h2>
      <p class="lede">Click the map to add stops in order. A stop within 60 m of an existing one joins it, so riders can transfer.</p></div>
    <div class="draft-form">
      <label class="field"><span>Line name</span><input id="dr-name" value="${esc(d.name)}" maxlength="40"></label>
      <div class="field-row">
        <label class="field grow"><span>Type</span><select id="dr-profile">${PROFILE_ORDER.map((p) => `<option value="${p}"${p === d.profile ? ' selected' : ''}>${PROFILES[p].label}</option>`).join('')}</select></label>
        <label class="field"><span>Color</span><input type="color" id="dr-color" value="${d.color}"></label>
      </div>
      <p class="note" id="dr-note">${profileNote(d.profile)}</p>
      <h4>Every … minutes</h4>
      <div class="hw-grid">${TPERIODS.map((p) => `<label class="field"><span>${PERIOD_SHORT[p]}</span><input type="number" min="0" max="120" step="1" data-hw="${p}" value="${d.headway[p]}" aria-label="${PERIOD_SHORT[p]} headway in minutes"></label>`).join('')}</div>
      <p class="note">0 means no service in that period.</p>
      <label class="check"><input type="checkbox" id="dr-both"${d.both ? ' checked' : ''}> Runs in both directions</label>
      <div id="draft-stops">${draftStopsHtml()}</div>
      <div class="row-actions sticky">
        <button class="btn primary" data-act="save"${d.stops.length < 2 ? ' disabled' : ''}>${editing ? 'Save changes' : 'Add line to scenario'}</button>
        <button class="btn ghost" data-act="cancel">Cancel</button>
        ${editing ? '<button class="btn ghost danger-text" data-act="delete">Delete line</button>' : ''}
      </div>
    </div>`;
  const name = el.querySelector<HTMLInputElement>('#dr-name')!;
  name.oninput = () => (d.name = name.value);
  const color = el.querySelector<HTMLInputElement>('#dr-color')!;
  color.oninput = () => {
    d.color = color.value;
    ctx.map.refreshDraft();
  };
  el.querySelector<HTMLSelectElement>('#dr-profile')!.onchange = (e) => {
    const p = (e.target as HTMLSelectElement).value as Profile;
    const wasDefault = d.color === PROFILES[d.profile].color;
    d.profile = p;
    if (wasDefault) d.color = PROFILES[p].color;
    d.headway = { ...PROFILES[p].headway };
    d.id = `${p}-${d.id.split('-').slice(1).join('-')}`;
    relegAll(d);
    if (PROFILES[p].streets && !streetsReady())
      void streetGraph().then(() => {
        if (state.draft === d) relegAll(d), touch('draft'), ctx.map.refreshDraft();
      });
    touch('draft');
    renderDraft(ctx, el);
    lastDraft = `${d.id}:${d.profile}`;
    ctx.map.refreshDraft();
  };
  el.querySelectorAll<HTMLInputElement>('input[data-hw]').forEach(
    (i) =>
      (i.onchange = () => {
        d.headway[i.dataset.hw as TPeriod] = Math.max(0, Math.min(120, Number(i.value) || 0));
        i.value = String(d.headway[i.dataset.hw as TPeriod]);
      }),
  );
  el.querySelector<HTMLInputElement>('#dr-both')!.onchange = (e) => (d.both = (e.target as HTMLInputElement).checked);
  onActs(el, {
    cancel: () => set({ draft: null }),
    save: () => {
      if (d.stops.length < 2) return;
      if (TPERIODS.every((p) => !(d.headway[p] > 0))) return ctx.toast('Set a frequency for at least one period.');
      const e = draftToEdit(d);
      const edits = [...state.scenario.edits];
      if (d.editIndex !== null) edits[d.editIndex] = e;
      else edits.push(e);
      set({ draft: null });
      ctx.setEdits(edits, editing ? `Updated ${e.name}` : `Added ${e.name} to the scenario`);
    },
    delete: () => {
      if (d.editIndex === null) return;
      const edits = state.scenario.edits.filter((_, i) => i !== d.editIndex);
      set({ draft: null });
      ctx.setEdits(edits, `Deleted ${d.name}`);
    },
  });
  bindDraftStops(el);
}

function draftStopsHtml(): string {
  const d = state.draft!;
  if (!d.stops.length) return `<div class="empty-state small"><p>No stops yet: click the map to place the first stop.</p></div>`;
  const hops = draftHops(d);
  const km = d.legs.reduce((a, l) => a + l.meters, 0) / 1000;
  const min = hops.reduce((a, b) => a + b, 0) / 60;
  const streets = d.legs.length ? d.legs.filter((l) => l.streets).length : 0;
  return `<div class="draft-sum"><span><b>${d.stops.length}</b> stops</span><span><b>${km.toFixed(1)}</b> km</span><span><b>${minutes(min)}</b> end to end</span>${PROFILES[d.profile].streets && d.legs.length ? `<span class="muted">${streets}/${d.legs.length} legs on streets</span>` : ''}</div>
    <ol class="stops-list">${d.stops
      .map(
        (s, i) => `<li><span class="sn${s.stop !== undefined ? ' snap' : ''}" style="--c:${d.color}">${i + 1}</span><span class="st-name">${esc(s.name)}${s.stop !== undefined ? ' <span class="muted">(existing stop)</span>' : ''}</span>${i > 0 ? `<span class="muted st-t">+${Math.round(hops[i - 1] / 60)} min</span>` : ''}<button class="icon-btn sm" data-rm="${i}" aria-label="Remove stop ${i + 1}">✕</button></li>`,
      )
      .join('')}</ol>`;
}

function bindDraftStops(el: HTMLElement) {
  el.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach(
    (b) =>
      (b.onclick = () => {
        draftRemoveStop(state.draft!, Number(b.dataset.rm));
        touch('draft');
      }),
  );
}

/** the run box: status, progress and the run / cancel buttons */
/** the run modes as the page describes them (runmode.ts); the times are measured (runmodes.ts) */
export const RUN_MODE_TEXT: Record<RunMode, { label: string; time: string; note: string }> = {
  quick: { label: 'Quick', time: 'about a minute', note: 'holds today’s traffic unless you change streets or what driving costs (then about two minutes)' },
  precise: { label: 'Precise', time: 'several minutes', note: 'the full model, traffic included' },
};

/** the run-mode switch and its line of explanation */
function runModeControl(): string {
  const m = state.runMode;
  return `<div class="rb-mode"><span class="seg sm" role="radiogroup" aria-label="Run mode">${RUN_MODE_LIST.map((k) => `<button role="radio" aria-checked="${k === m}" data-act="mode" data-mode="${k}">${RUN_MODE_TEXT[k].label}</button>`).join('')}</span></div>`;
}

/** a run's time so far: 42s, 1:05 */
const elapsed = (started?: number) => {
  const t = started ? Math.max(0, Math.floor((performance.now() - started) / 1000)) : 0;
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
/** the elapsed time ticks on its own, between the stages' reports */
let elapsedTimer: number | undefined;
function tickElapsed(el: HTMLElement, started: number | undefined) {
  clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  if (started === undefined) return;
  elapsedTimer = window.setInterval(() => {
    const t = el.querySelector('.rb-secs');
    if (!t || !t.isConnected) return void clearInterval(elapsedTimer);
    t.textContent = elapsed(started);
  }, 500);
}

export function renderRunBox(ctx: Ctx, el: HTMLElement): void {
  const run = state.run;
  const nc = Object.keys(cleanContext(state.scenario.context) ?? {}).filter((k) => k !== 'transferDiscountMuniOnly').length;
  const n = editGroups(ctx.m, state.scenario).length + nc;
  const current = resultCurrent();
  const mode = RUN_MODE_TEXT[state.runMode];
  let h = '';
  if (run.status === 'running') {
    // (a run that first makes today's network for the comparison says so in its title)
    const today = run.stage.startsWith(TODAY_FIRST);
    const stage = today ? run.stage.charAt(TODAY_FIRST.length).toUpperCase() + run.stage.slice(TODAY_FIRST.length + 1) : run.stage;
    h = `<div class="rb-row"><div class="rb-t"><b>${today ? 'Running today’s network first' : `Running the model (${mode.label.toLowerCase()})`}… <span class="rb-secs">${elapsed(run.started)}</span></b><span class="muted rb-stage">${esc(stage)}</span></div><button class="btn sm ghost" data-act="cancel">Cancel</button></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(run.frac * 100)}"><span style="width:${Math.max(2, run.frac * 100).toFixed(1)}%"></span></div>`;
  } else if (!n) {
    h = `<div class="rb-row"><div class="rb-t"><b>Nothing to run yet</b><span class="muted">Add at least one change, or set a condition.</span></div><button class="btn primary" disabled>Run model</button></div>${runModeControl()}`;
  } else if (current) {
    h = `<div class="rb-row"><div class="rb-t"><b>Results are ready</b><span class="muted">for these ${n} change${n > 1 ? 's' : ''}${nc ? ' and conditions' : ''}, ${DAY_PHRASE[state.day]}, ${mode.label.toLowerCase()} run</span></div><button class="btn primary" data-act="results">View results</button></div>${runModeControl()}`;
  } else {
    const otherDay = state.result && (state.resultScenario?.day ?? 'wkd') !== state.day;
    const title = !state.result ? 'Ready to run' : otherDay ? `Not run for ${DAY_LABEL[state.day]} yet` : resultOtherMode() ? `Not run in ${mode.label} mode yet` : 'Scenario changed since the last run';
    h = `<div class="rb-row"><div class="rb-t"><b>${title}</b><span class="muted">${run.status === 'error' ? `<span class="warn">Last run failed: ${esc(run.error ?? '')}</span>` : `Runs for ${DAY_PHRASE[state.day]} (change the day at the top)`}</span></div><button class="btn primary" data-act="run">Run model</button></div>${runModeControl()}`;
  }
  el.innerHTML = h;
  tickElapsed(el, run.status === 'running' ? run.started : undefined);
  onActs(el, {
    run: () => ctx.run(),
    cancel: () => ctx.cancel(),
    results: () => set({ tab: 'results' }),
    mode: (b) => ctx.setRunMode(b.dataset.mode as RunMode),
  });
  void editsKey;
}

export async function share(ctx: Ctx): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    ctx.toast('Link copied. Anyone opening it sees this scenario and can run it.');
  } catch {
    ctx.toast('The browser blocked copying. Copy the page address to share this scenario.');
  }
}

const profileNote = (p: Profile) => esc(PROFILES[p].note) + (PROFILES[p].streets && !streetsReady() ? ' Loading streets…' : '');
const microText = (k: MicroKey, f: number) => (f === 0 ? (k === 'docks' || k === 'fleet' ? 'None' : 'Free') : fareText(f));
const fareText = (f: number) => (f === 0 ? 'Free' : Math.abs(f - 1) < 1e-6 ? 'Today' : `${f > 1 ? '+' : '−'}${Math.round(Math.abs(f - 1) * 100)}%`);
const kindLabel = (k: string) => ({ frequency: 'Frequency', speed: 'Speed', remove: 'Removed', fare: 'Fare', micromobility: 'Bikes', newLine: 'New line', addStop: 'New stop', removeStop: 'Stops', extend: 'Extension', road: 'Street', cordon: 'Pricing', parking: 'Parking' })[k] ?? k;

// ---------- conditions: the demand drivers outside the network (shared/beta3/context.ts) ----------

/** July 2024's conditions as the backcast sets them (server/beta3/reference/backcast-drivers.json) */
const JULY_2024: DemandContext = (() => {
  const d = backcastDrivers.drivers as unknown as Record<string, { value?: number; toMuniOnly?: boolean }>;
  const c: Record<string, number | boolean> = {};
  for (const s of CONDITIONS) if (typeof d[s.key]?.value === 'number') c[s.key] = d[s.key].value!;
  if (d.transferDiscount?.toMuniOnly) c.transferDiscountMuniOnly = true;
  return cleanContext(c) ?? {};
})();

const condText = (s: ConditionSpec, v: number) => {
  if (Math.abs(v - s.today) < 1e-9) return s.unit === 'rel' ? 'Today' : `${condValue(s, v)} today`;
  return condValue(s, v);
};
const condValue = (s: ConditionSpec, v: number) =>
  s.unit === 'rel' ? `${(v * 100).toFixed(Math.abs(v * 100 - Math.round(v * 100)) < 0.05 ? 0 : 1)}%` : s.unit === 'usd' ? `$${v.toFixed(2)}` : s.unit === 'days' ? `${v.toFixed(1)} days` : `${(v * 100).toFixed(1)}%`;

function conditionsSection(s: Scenario): string {
  const groups = [...new Set(CONDITIONS.map((c) => c.group))];
  const set = cleanContext(s.context);
  const rows = groups
    .map(
      (g) =>
        `<h4 class="cond-g">${g}</h4>` +
        CONDITIONS.filter((c) => c.group === g)
          .map((c) => {
            const v = contextValue(s.context, c.key);
            const changed = Math.abs(v - c.today) > 1e-9;
            const extra =
              c.key === 'transferDiscount'
                ? `<label class="check cond-sub"><input type="checkbox" id="cond-muni-only"${s.context?.transferDiscountMuniOnly ? ' checked' : ''}> Only when boarding Muni (as before December 2025)</label>`
                : '';
            return `<div class="range-row cond${changed ? ' changed' : ''}"><label for="cond-${c.key}" title="${esc(c.source)}">${esc(c.label)}</label><input type="range" id="cond-${c.key}" data-cond="${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" aria-describedby="cond-src-${c.key}"><output>${condText(c, v)}</output><p class="cond-src" id="cond-src-${c.key}">${esc(c.source)}</p></div>${extra}`;
          })
          .join(''),
    )
    .join('');
  return section(
    'Conditions',
    `<div class="conditions">${rows}</div><div class="row-actions"><button class="btn sm ghost" data-act="cond-reset"${set ? '' : ' disabled'}>Back to today</button><button class="btn sm ghost" data-act="cond-2024">Conditions of July 2024</button></div>`,
    {
      note: 'Things outside the transit network that change how many people travel. Each starts at today’s value. Results get less reliable far from it.',
    },
  );
}

function bindConditions(ctx: Ctx, el: HTMLElement) {
  const apply = (context: DemandContext | undefined, note: string) => {
    set({ scenario: { ...state.scenario, context } });
    if (context) ctx.engine.warm();
    ctx.toast(note);
  };
  el.querySelectorAll<HTMLInputElement>('input[data-cond]').forEach((r) => {
    const spec = CONDITIONS.find((c) => c.key === r.dataset.cond)!;
    const out = r.nextElementSibling as HTMLOutputElement;
    r.oninput = () => (out.textContent = condText(spec, Number(r.value)));
    r.onchange = () => {
      const v = Number(r.value);
      apply(withCondition(state.scenario, spec.key as ConditionKey, v), `${spec.label}: ${condText(spec, v).toLowerCase()}`);
    };
  });
  const mo = el.querySelector<HTMLInputElement>('#cond-muni-only');
  if (mo) mo.onchange = () => apply(cleanContext({ ...(state.scenario.context ?? {}), transferDiscountMuniOnly: mo.checked }) ?? undefined, mo.checked ? 'Clipper discount only onto Muni' : 'Clipper discount between any operators');
  onActs(el, {
    'cond-reset': () => apply(undefined, 'Conditions back to today'),
    'cond-2024': () => apply({ ...JULY_2024 }, 'Loaded the conditions of July 2024'),
  });
}
