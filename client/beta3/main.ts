/**
 * SF-TRACE: bootstrap. Loads the model with real progress, builds the shell
 * (top bar, tabbed side panel / bottom sheet, map), restores a shared scenario from the URL, and
 * wires state changes to the panels that show them.
 */
import './tokens.css';
import './style.css';
import type { DayType, Edit, Scenario } from '../../shared/beta3/types';
import { buildModel, DAY_LABEL, DAY_PHRASE, DAY_TYPES, PERIOD_SHORT, PERIOD_HOURS_TEXT } from './derive';
import { CancelledError, Engine } from './engine';
import { TransitMap } from './map';
import { addStopEdits, dayFromHash, editGroups, draftRemoveStop, hasChanges, scenarioFromHash, writeHash } from './scenario';
import { bases, editsKey, quickBases, resultCurrent, resultDay, saveRunMode, saveWeekends, set, state, subscribe, touch, type AppState, type PeriodSel, type Tab } from './state';
import type { RunMode } from '../../shared/beta3/runmode';
import type { Ctx } from './ui/common';
import { renderMethod } from './ui/method';
import { renderOverview } from './ui/overview';
import { renderResults } from './ui/results';
import { renderRoutes } from './ui/routes';
import { renderScenario, updateScenario } from './ui/scenarioPanel';
import { bindTips, hideTip } from './ui/tooltip';
import { setChartWidth } from './charts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'routes', label: 'Routes' },
  { id: 'scenario', label: 'Scenario' },
  { id: 'results', label: 'Results' },
  { id: 'method', label: 'About' },
];
const PERIODS: PeriodSel[] = ['day', 'AM', 'MD', 'PM', 'NT'];
const DAY_SHORT: Record<DayType, string> = { wkd: 'Weekday', sat: 'Sat', sun: 'Sun' };

// ---------- loading ----------

const bar = $('load-bar'), text = $('load-text');
Engine.load((f) => {
  bar.style.width = `${(f * 92).toFixed(1)}%`;
  text.textContent = `Downloading the model… ${Math.round(f * 100)}%`;
})
  .then((engine) => {
    text.textContent = 'Preparing the map…';
    bar.style.width = '96%';
    // let the progress paint before the synchronous setup (a timer, not a frame: a page loading
    // in a background tab gets no frames, and should still be ready when it is shown)
    setTimeout(() => start(engine), 30);
  })
  .catch((err) => {
    console.error(err);
    bar.parentElement!.classList.add('err');
    text.innerHTML = `The model could not be loaded (${String(err.message ?? err)}). <button class="link" onclick="location.reload()">Try again</button>`;
  });

// ---------- app ----------

function start(engine: Engine) {
  const m = buildModel(engine.bundle);
  bases.wkd = engine.base;
  state.base = engine.base;
  // the streets (traffic): fetched after the page is up, for the driving figures and the speeds layer
  setTimeout(() => void engine.loadRoads().then(() => set({ roads: state.roads + 1 })).catch(() => {}), 1500);
  const app = $('app');
  app.hidden = false;
  initResizer(app, () => map.resize(), () => relayout());

  // tabs and panels
  const tabs = $('tabs'), panels = $('panels');
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.id = `tab-${t.id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `panel-${t.id}`);
    b.dataset.tab = t.id;
    b.innerHTML = `${t.label}<span class="tab-dot" hidden></span>`;
    b.onclick = () => {
      set({ tab: t.id });
      if (isPhone() && state.sheet === 'peek') set({ sheet: 'half' });
    };
    tabs.append(b);
    const p = document.createElement('div');
    p.className = 'panel';
    p.id = `panel-${t.id}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labeledby', b.id);
    p.tabIndex = -1;
    panels.append(p);
  }
  tabs.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.id === state.tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
      set({ tab: n });
      requestAnimationFrame(() => $(`tab-${n}`).focus());
      e.preventDefault();
    }
  });

  // period control
  const per = $('period');
  per.innerHTML = PERIODS.map((p) => `<button role="radio" data-p="${p}" title="${PERIOD_HOURS_TEXT[p]}">${PERIOD_SHORT[p]}</button>`).join('');
  per.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => set({ period: b.dataset.p as PeriodSel })));
  const perSel = $<HTMLSelectElement>('period-select');
  perSel.innerHTML = PERIODS.map((p) => `<option value="${p}">${PERIOD_SHORT[p]}</option>`).join('');
  perSel.onchange = () => set({ period: perSel.value as PeriodSel });

  // day control
  const dayEl = $('day');
  dayEl.innerHTML = DAY_TYPES.map((d) => `<button role="radio" data-d="${d}" title="${DAY_PHRASE[d].replace(/^an/, 'An')}">${DAY_SHORT[d]}</button>`).join('');
  dayEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => ctx.setDay(b.dataset.d as DayType)));
  const daySel = $<HTMLSelectElement>('day-select');
  daySel.innerHTML = DAY_TYPES.map((d) => `<option value="${d}">${DAY_LABEL[d]}</option>`).join('');
  daySel.onchange = () => ctx.setDay(daySel.value as DayType);
  /** the day being loaded, if any (its baseline is fetched on first use) */
  let wantDay: DayType | null = null;

  // map
  const map = new TransitMap($('map'), m, engine, {
    selectRoute: (k) => ctx.selectRoute(k),
    setDay: (d) => ctx.setDay(d),
    addStopAt: (lat, lon) => {
      const r = state.addStop ? m.routeByKey.get(state.addStop) : undefined;
      if (!r) return;
      const add = addStopEdits(m, r, lat, lon);
      if (!add.length) return ctx.toast(`Click on the ${r.label}’s line to place a stop there.`);
      ctx.setEdits([...state.scenario.edits, ...add], `Added a stop on the ${r.label}${add.length > 1 ? ' (both directions)' : ''}`);
    },
  });

  // ---------- actions ----------
  const undoStack: Scenario[] = [];
  let toastTimer = 0;
  const ctx: Ctx = {
    m,
    engine,
    map,
    selectRoute(key, fit = false) {
      set({ route: key, tab: key ? 'routes' : state.tab });
      if (key && fit) map.fitRoute(key);
      if (key && isPhone() && state.sheet === 'peek') set({ sheet: 'half' });
      $('panel-routes').scrollTop = 0;
    },
    setDay(day: DayType) {
      // a weekend link or scenario switches the experimental weekend models on
      if (day !== 'wkd' && !state.weekends) set({ weekends: true });
      wantDay = day;
      renderDay();
      if (day === state.day) {
        wantDay = null;
        renderDay();
        return;
      }
      engine
        .baseFor(day)
        .then(async (b) => {
          bases[day] = b;
          // the comparisons on the map are with today's network made as the result shown is
          const r = state.result && (state.resultScenario?.day ?? 'wkd') === day ? state.result : null;
          const cmp = r?.runMode === 'quick' ? (quickBases[day] = await engine.baseFor(day, 'quick')) : b;
          if (wantDay !== day) return;
          wantDay = null;
          set({ day, base: cmp, scenario: { ...state.scenario, day } });
        })
        .catch((e) => {
          console.error(e);
          if (wantDay === day) wantDay = null;
          renderDay();
          ctx.toast(`Could not load the ${DAY_LABEL[day]} model (${String(e.message ?? e)}).`);
        });
    },
    setWeekends(on: boolean) {
      saveWeekends(on);
      set({ weekends: on });
      if (!on && (wantDay ?? state.day) !== 'wkd') ctx.setDay('wkd');
      ctx.toast(on ? 'Weekend models are on: pick Saturday or Sunday at the top.' : 'Weekend models are off.');
    },
    setEdits(edits: Edit[], note?: string) {
      undoStack.push(state.scenario);
      if (undoStack.length > 50) undoStack.shift();
      set({ scenario: { ...state.scenario, edits } });
      if (edits.length) engine.warm();
      if (note) ctx.toast(note, edits.length && state.tab !== 'scenario' ? { label: 'Open scenario', fn: () => set({ tab: 'scenario' }) } : undefined);
    },
    loadScenario(s, note) {
      undoStack.push(state.scenario);
      set({ scenario: { name: s.name, edits: s.edits, day: state.day, ...(s.context ? { context: s.context } : {}), ...(s.traffic ? { traffic: true } : {}) }, draft: null });
      if (hasChanges(s)) engine.warm();
      if (note) ctx.toast(note);
    },
    undo() {
      const prev = undoStack.pop();
      if (prev) set({ scenario: { ...prev, day: state.day } });
    },
    canUndo: () => undoStack.length > 0,
    setRunMode(mode: RunMode, remember = true) {
      if (remember) saveRunMode(mode);
      set({ runMode: mode });
    },
    run(mode?: RunMode) {
      if (state.run.status === 'running' || !hasChanges(state.scenario)) return;
      if (wantDay) return ctx.toast(`Loading the ${DAY_LABEL[wantDay]} model; run again in a moment.`);
      // (a one-off mode, e.g. "Run precisely" from Quick results, is shown but not remembered)
      if (mode && mode !== state.runMode) set({ runMode: mode });
      const scenario: Scenario = { ...JSON.parse(JSON.stringify(state.scenario)), day: state.day, runMode: mode ?? state.runMode };
      const started = performance.now();
      set({ run: { status: 'running', stage: 'Starting the model', frac: 0, started }, draft: null });
      engine
        .run(scenario, (stage, frac) => set({ run: { status: 'running', stage, frac, started } }))
        .then(async (r) => {
          // compare with today's network made in the same run mode (the engine recomputes a
          // baseline saved from an older model bundle; compare with that one)
          const rd = scenario.day ?? 'wkd', mode = scenario.runMode ?? 'precise';
          const fresh = await engine.baseFor(rd, mode);
          if (mode === 'quick') quickBases[rd] = fresh;
          else bases[rd] = fresh;
          bases[rd] = await engine.baseFor(rd, 'precise');
          if (rd === state.day) set({ base: fresh });
          const onScenario = state.tab === 'scenario' || state.tab === 'results';
          set({ result: r, resultKey: editsKey(scenario), resultScenario: scenario, run: { status: 'done', stage: '', frac: 1 }, view: 'change', tab: onScenario ? 'results' : state.tab });
          if (!onScenario) ctx.toast('Scenario results are ready.', { label: 'View results', fn: () => set({ tab: 'results' }) });
          $('panel-results').scrollTop = 0;
        })
        .catch((e) => {
          if (e instanceof CancelledError) {
            set({ run: { status: 'idle', stage: '', frac: 0 } });
            ctx.toast('Run canceled.');
          } else {
            console.error(e);
            set({ run: { status: 'error', stage: '', frac: 0, error: String(e.message ?? e) } });
          }
        });
    },
    cancel() {
      engine.cancel();
    },
    toast(msg, action) {
      const t = $('toast');
      t.innerHTML = '';
      const s = document.createElement('span');
      s.textContent = msg;
      t.append(s);
      if (action) {
        const b = document.createElement('button');
        b.className = 'link';
        b.textContent = action.label;
        b.onclick = () => {
          action.fn();
          t.hidden = true;
        };
        t.append(b);
      }
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (t.hidden = true), 4500);
    },
  };

  // ---------- rendering ----------
  const renderers: Record<Tab, (el: HTMLElement) => void> = {
    overview: (el) => renderOverview(ctx, el),
    routes: (el) => renderRoutes(ctx, el),
    scenario: (el) => renderScenario(ctx, el),
    results: (el) => renderResults(ctx, el),
    method: (el) => renderMethod(ctx, el),
  };
  /** which state keys make each panel stale */
  const deps: Record<Tab, (keyof AppState)[]> = {
    overview: ['base', 'weekends', 'roads', 'day'],
    routes: ['route', 'period', 'scenario', 'result', 'base', 'addStop'],
    scenario: ['scenario', 'draft', 'run', 'result', 'day', 'runMode'],
    results: ['result', 'scenario', 'view', 'zoneLayer', 'base', 'roads', 'runMode', 'run'],
    method: ['weekends'],
  };
  const dirty = new Set<Tab>(TABS.map((t) => t.id));
  const rendered = new Set<Tab>();

  function showPanels(changed: Set<keyof AppState>) {
    for (const t of TABS) if (deps[t.id].some((k) => changed.has(k))) dirty.add(t.id);
    for (const t of TABS) {
      const on = t.id === state.tab;
      const b = $(`tab-${t.id}`);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $(`panel-${t.id}`).hidden = !on;
    }
    const el = $(`panel-${state.tab}`);
    // the routes list fills the panel (its table scrolls on its own, header and first column fixed)
    $('panel-routes').classList.toggle('fill', !state.route);
    if (state.tab === 'scenario' && rendered.has('scenario') && !changed.has('tab')) {
      updateScenario(ctx, el, changed as Set<string>);
      dirty.delete('scenario');
    } else if (dirty.has(state.tab)) {
      // keep the scroll position when the same view re-renders (e.g. a period switch)
      const keep = !changed.has('tab') && !changed.has('route') ? el.scrollTop : 0;
      chartWidth = contentWidth(el);
      setChartWidth(chartWidth);
      renderers[state.tab](el);
      el.scrollTop = keep;
      dirty.delete(state.tab);
      rendered.add(state.tab);
    }
    if (changed.has('tab')) {
      el.scrollTop = 0;
      hideTip();
    }
    // a dot on Results while there are results not yet looked at
    const dot = $('tab-results').querySelector<HTMLElement>('.tab-dot')!;
    if (changed.has('result') && state.result && state.tab !== 'results') dot.hidden = false;
    if (state.tab === 'results' || !state.result) dot.hidden = true;
  }

  function renderDay() {
    const shown = wantDay ?? state.day;
    dayEl.querySelectorAll('button').forEach((b) => {
      const d = b.getAttribute('data-d');
      b.setAttribute('aria-checked', String(d === shown));
      b.classList.toggle('busy', d === wantDay);
    });
    daySel.value = shown;
    document.querySelector('.brand-sub')!.textContent = `Average ${DAY_LABEL[state.day].replace('Weekday', 'weekday')}${wantDay ? ` · loading ${DAY_LABEL[wantDay]}…` : ''}`;
  }

  /** the panel's content width, which charts are drawn for */
  let chartWidth = 0;
  function contentWidth(el: HTMLElement) {
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }
  /** after the panel changes width: redraw the charts at the new size (other tabs on their next visit) */
  function relayout() {
    const el = $(`panel-${state.tab}`);
    if (Math.abs(contentWidth(el) - chartWidth) < 8) return;
    for (const t of TABS) if (t.id !== 'scenario') dirty.add(t.id);
    if (state.tab !== 'scenario') showPanels(new Set());
  }

  function renderTop(changed: Set<keyof AppState>) {
    if (changed.has('period')) {
      per.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.getAttribute('data-p') === state.period)));
      perSel.value = state.period;
    }
    if (changed.has('day')) renderDay();
    if (changed.has('weekends')) app.classList.toggle('weekends', state.weekends);
    const st = $('status');
    // a change as the scenario list shows it (a BART line's two directions, a stop's two sides: one)
    const n = editGroups(m, state.scenario).length;
    const run = state.run;
    let cls = '', html = '';
    if (run.status === 'running') {
      cls = 'running';
      html = `<span class="pill-prog" style="--p:${(run.frac * 100).toFixed(0)}%"></span><span>Running ${(run.frac * 100).toFixed(0)}%</span>`;
    } else if (resultCurrent()) {
      cls = 'done';
      html = `<span class="pill-dot"></span><span>${escText(state.scenario.name)}: results</span>`;
    } else if (n) {
      cls = 'pending';
      html = `<span class="pill-dot"></span><span>${escText(state.scenario.name)} · ${n} change${n > 1 ? 's' : ''}${state.result ? ' · re-run' : ' · not run'}</span>`;
      if (state.result && resultDay() !== state.day && editsKey({ ...state.scenario, day: resultDay() }) === state.resultKey) html = `<span class="pill-dot"></span><span>${escText(state.scenario.name)} · not run for this day</span>`;
    } else {
      html = `<span class="pill-dot"></span><span>Today’s network</span>`;
    }
    st.className = `status-pill ${cls}`;
    st.innerHTML = html;
    st.onclick = () => set({ tab: resultCurrent() ? 'results' : 'scenario' });
    st.title = run.status === 'running' ? run.stage : 'Open the scenario';
  }

  function layout(changed: Set<keyof AppState>) {
    if (changed.has('sidebarOpen')) {
      app.classList.toggle('sb-closed', !state.sidebarOpen);
      $('sb-toggle').setAttribute('aria-expanded', String(state.sidebarOpen));
      $('sb-toggle').setAttribute('aria-label', state.sidebarOpen ? 'Hide side panel' : 'Show side panel');
      setTimeout(() => map.resize(), 220);
    }
    if (changed.has('sheet')) {
      app.dataset.sheet = state.sheet;
      $('sheet-handle').setAttribute('aria-label', state.sheet === 'full' ? 'Collapse panel' : 'Expand panel');
    }
  }

  subscribe((changed) => {
    showPanels(changed);
    renderTop(changed);
    layout(changed);
    if (changed.has('scenario') || changed.has('runMode')) writeHash(state.scenario, state.runMode);
    if (changed.has('scenario') || changed.has('runMode') || changed.has('day')) schedulePrefetch();
    if (changed.has('result') && !state.result) set({ view: 'base' });
    // adding stops ends when the route closes, another opens, or a line is drawn
    if (state.addStop && (state.addStop !== state.route || state.draft)) set({ addStop: null });
  });

  // a scenario left alone for a moment gets its first transit skims found ahead of its run
  let prefetchTimer = 0;
  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    if (!hasChanges(state.scenario) || state.draft) return;
    prefetchTimer = window.setTimeout(() => {
      if (state.run.status === 'running' || wantDay || !hasChanges(state.scenario) || state.draft) return;
      void engine.prefetch({ ...JSON.parse(JSON.stringify(state.scenario)), day: state.day, runMode: state.runMode });
    }, 1500);
  }

  $('sb-toggle').onclick = () => set({ sidebarOpen: !state.sidebarOpen });
  $('sheet-handle').onclick = () => set({ sheet: state.sheet === 'full' ? 'peek' : state.sheet === 'half' ? 'full' : 'half' });
  bindTips($('panels'));

  // radio groups (period, day, operator, map view, scale): arrow keys move the choice
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || t.getAttribute('role') !== 'radio') return;
    const group = t.closest('[role="radiogroup"]');
    if (!group) return;
    const opts = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter((b) => !(b as HTMLButtonElement).disabled);
    const i = opts.indexOf(t);
    const n = opts[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length];
    if (!n || n === t) return;
    e.preventDefault();
    n.click();
    // the group may re-render on click: focus the option with the same value
    requestAnimationFrame(() => {
      const sel = ['data-p', 'data-d', 'data-op', 'data-v', 'data-day', 'data-act'].find((a) => n.hasAttribute(a));
      const again = sel ? document.querySelector<HTMLElement>(`[role="radio"][${sel}="${n.getAttribute(sel)}"]`) : null;
      (again ?? n).focus();
    });
  });

  // keyboard: Escape closes a route; Backspace removes the last drawn stop
  document.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).closest('input, select, textarea, [contenteditable]');
    if (typing) return;
    if (e.key === 'Escape' && state.addStop) set({ addStop: null });
    else if (e.key === 'Escape' && state.route) ctx.selectRoute(null);
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.draft?.stops.length) {
      draftRemoveStop(state.draft, state.draft.stops.length - 1);
      touch('draft');
      map.refreshDraft();
      e.preventDefault();
    }
  });

  // a shared scenario (or just a day) in the URL
  const restore = () => {
    const s0 = scenarioFromHash(m);
    // the link's run mode is used for this visit (the viewer's own choice stays remembered)
    if (s0?.runMode && s0.runMode !== state.runMode) ctx.setRunMode(s0.runMode, false);
    const s = s0 && (({ runMode: _m, ...rest }) => (void _m, rest))(s0);
    const day = s?.day ?? dayFromHash() ?? 'wkd';
    if (s && editsKey(s) !== editsKey()) {
      // the scenario's day is applied with its baseline; until then it runs for the day on show
      set({ scenario: { ...s, day: state.day }, tab: 'scenario' });
      ctx.toast(`Loaded the shared scenario “${s.name}”${day !== 'wkd' ? ` (${DAY_LABEL[day]})` : ''}. Run the model to see its results.`, { label: 'Run now', fn: () => ctx.run() });
      const e = engine.cached({ ...s, runMode: state.runMode });
      if (e) set({ result: e, resultKey: editsKey(s), resultScenario: { ...s, runMode: state.runMode } });
    }
    if (day !== state.day) ctx.setDay(day);
  };
  restore();
  window.addEventListener('hashchange', restore);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    app.classList.toggle('phone', isPhone());
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(relayout, 250);
  });
  app.classList.toggle('phone', isPhone());

  // first render
  app.dataset.sheet = state.sheet;
  showPanels(new Set(['tab', 'period']));
  renderTop(new Set(['period', 'day', 'weekends']));

  const loading = $('loading');
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 400);
  (window as unknown as { __b3: unknown }).__b3 = { engine, m, state, set, ctx, map };
}

const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

// ---------- resizable side panel ----------

const SB_KEY = 'b3.sidebarWidth';
const clampW = (w: number) => Math.round(Math.max(340, Math.min(w, 900, window.innerWidth - 340)));

/** a drag handle on the side panel's edge; the width is remembered in this browser */
function initResizer(app: HTMLElement, onResize: () => void, onDone: () => void) {
  const sb = $('sidebar');
  const h = document.createElement('div');
  h.className = 'sb-resize';
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'vertical');
  h.setAttribute('aria-label', 'Resize side panel');
  h.title = 'Drag to resize · double-click to reset';
  h.tabIndex = 0;
  sb.append(h);
  const apply = (w: number | null) => {
    if (w) app.style.setProperty('--sb-w', `${w}px`);
    else app.style.removeProperty('--sb-w');
  };
  const save = (w: number | null) => {
    try {
      if (w) localStorage.setItem(SB_KEY, String(w));
      else localStorage.removeItem(SB_KEY);
    } catch {
      /* storage unavailable: the width lasts for this visit */
    }
  };
  try {
    const w = Number(localStorage.getItem(SB_KEY));
    if (w > 0) apply(clampW(w));
  } catch {
    /* no stored width */
  }
  let raf = 0;
  const resized = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => ((raf = 0), onResize()));
  };
  let start: { x: number; w: number } | null = null;
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, w: sb.getBoundingClientRect().width };
    try {
      h.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers can't be captured; moves still arrive while over the handle */
    }
    app.classList.add('resizing');
    e.preventDefault();
  });
  h.addEventListener('pointermove', (e) => {
    if (!start) return;
    apply(clampW(start.w + e.clientX - start.x));
    resized();
  });
  const end = () => {
    if (!start) return;
    start = null;
    app.classList.remove('resizing');
    save(clampW(sb.getBoundingClientRect().width));
    onResize();
    onDone();
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => {
    apply(null);
    save(null);
    onResize();
    onDone();
  });
  h.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const w = clampW(sb.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 24 : -24));
    apply(w);
    save(w);
    onResize();
    onDone();
    e.preventDefault();
  });
}
const escText = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
